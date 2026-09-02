import { describe, expect, test } from "bun:test";
import {
  AG_UI_PROTOCOL_VERSION,
  bitmindGatewayConfig,
} from "../src/bitmind/config";
import { createBitmindGateway } from "../src/bitmind/gateway";
import type { BitmindAttestation } from "../src/bitmind/gateway";

const SERVICE_TOKEN = "service-token-for-tests-0000000000000000";
const AGENT_TOKEN = "managed-agent-token-for-tests-00000000";

function config(
  overrides: Partial<Parameters<typeof createBitmindGateway>[0]> = {},
) {
  return {
    serviceToken: SERVICE_TOKEN,
    agentUrl: "http://localhost:4201/ag-ui",
    agentToken: AGENT_TOKEN,
    maxConcurrentRuns: 2,
    runTimeoutMs: 30_000,
    ...overrides,
  };
}

function runInput(runId = "run-1") {
  return {
    threadId: "conversation-1",
    runId,
    messages: [{ id: "m1", role: "user", content: "Find me sources" }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {
      workspace_id: "workspace-1",
      agent_id: "agent-1",
      run_id: runId,
      fencing_token: 1,
    },
  };
}

function runRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://gateway/bitmind/v1/run", {
    method: "POST",
    headers: {
      authorization: `Bearer ${SERVICE_TOKEN}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function sseEvents(events: object[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

/** A downstream agent that answers with a canned stream and remembers the request. */
function fakeAgent(events: object[]) {
  const seen: { url?: string; init?: RequestInit } = {};
  const agentFetch: typeof fetch = (url, init) => {
    seen.url = String(url);
    seen.init = init;
    return Promise.resolve(
      new Response(sseEvents(events), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
  };
  return { seen, agentFetch };
}

describe("authentication", () => {
  test("everything but /health requires the service token", async () => {
    const gateway = createBitmindGateway(config());
    const health = await gateway.fetch(new Request("http://gateway/health"));
    expect(health.status).toBe(200);

    for (const [path, method] of [
      ["/bitmind/v1/attestation", "GET"],
      ["/bitmind/v1/run", "POST"],
    ] as const) {
      const bare = await gateway.fetch(
        new Request(`http://gateway${path}`, { method }),
      );
      expect(bare.status).toBe(401);
      const wrong = await gateway.fetch(
        new Request(`http://gateway${path}`, {
          method,
          headers: { authorization: "Bearer not-the-token" },
        }),
      );
      expect(wrong.status).toBe(401);
    }
  });
});

describe("attestation", () => {
  test("states the pin, the honest capability set, and the ceilings", async () => {
    const gateway = createBitmindGateway(config());
    const response = await gateway.fetch(
      new Request("http://gateway/bitmind/v1/attestation", {
        headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as BitmindAttestation;
    expect(body.protocol.ag_ui).toBe(AG_UI_PROTOCOL_VERSION);
    // No enclave computers exist behind this gateway yet: attesting true here would
    // switch BitMind's worker on against isolation that does not exist.
    expect(body.isolated_computers).toBe(false);
    expect(body.execution).toEqual({
      backend: "relay",
      tools: false,
      interrupts: false,
    });
    expect(body.limits.max_concurrent_runs).toBe(2);
    expect(body.active_runs).toBe(0);
  });

  test("the declared protocol version is the installed one", async () => {
    // The drift fence: a dependency bump that moves @ag-ui/core must be a deliberate
    // pin move, not a lockfile accident this attestation then lies about.
    const manifest = (await import("@ag-ui/core/package.json")) as {
      version: string;
    };
    expect(manifest.version).toBe(AG_UI_PROTOCOL_VERSION);
  });
});

describe("run relay", () => {
  test("a valid run is forwarded whole with the managed-agent token", async () => {
    const { seen, agentFetch } = fakeAgent([
      { type: "RUN_STARTED", threadId: "conversation-1", runId: "run-1" },
      { type: "RUN_FINISHED", threadId: "conversation-1", runId: "run-1" },
    ]);
    const gateway = createBitmindGateway(config(), agentFetch);
    const response = await gateway.fetch(
      runRequest(runInput(), { "idempotency-key": "run-1:1" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const text = await response.text();
    expect(text).toContain('"RUN_STARTED"');
    expect(text).toContain('"RUN_FINISHED"');

    expect(seen.url).toBe("http://localhost:4201/ag-ui");
    const headers = new Headers(seen.init?.headers);
    expect(headers.get("x-openbot-agent-token")).toBe(AGENT_TOKEN);
    // The service token authenticates BitMind to this gateway and goes no further.
    expect(headers.get("authorization")).toBeNull();
    const forwarded = JSON.parse(String(seen.init?.body)) as {
      forwardedProps: Record<string, unknown>;
    };
    expect(forwarded.forwardedProps).toEqual(runInput().forwardedProps);
    // The stream ended, so the slot is free again.
    expect(gateway.activeRuns()).toBe(0);
  });

  test("a body that is not a RunAgentInput is refused without echoing it", async () => {
    const gateway = createBitmindGateway(config(), () => {
      throw new Error("must not reach the agent");
    });
    const invalid = await gateway.fetch(
      runRequest({ runId: "run-1", messages: "<script>alert(1)</script>" }),
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).not.toContain("script");

    const notJson = await gateway.fetch(
      new Request("http://gateway/bitmind/v1/run", {
        method: "POST",
        headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
        body: "not json",
      }),
    );
    expect(notJson.status).toBe(400);
  });

  test("the same idempotency key cannot stream twice at once", async () => {
    // A downstream that never finishes, so the first relay stays live.
    let releaseFirst = () => {};
    const hanging: typeof fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
              releaseFirst = () => {
                controller.close();
              };
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );
    const gateway = createBitmindGateway(config(), hanging);
    const first = await gateway.fetch(
      runRequest(runInput(), { "idempotency-key": "run-1:1" }),
    );
    expect(first.status).toBe(200);
    expect(gateway.activeRuns()).toBe(1);

    const replay = await gateway.fetch(
      runRequest(runInput(), { "idempotency-key": "run-1:1" }),
    );
    expect(replay.status).toBe(409);

    releaseFirst();
    await first.text();
    expect(gateway.activeRuns()).toBe(0);
  });

  test("runs past the ceiling are refused with retry-after", async () => {
    const holds: (() => void)[] = [];
    const hanging: typeof fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              holds.push(() => {
                controller.close();
              });
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );
    const gateway = createBitmindGateway(
      config({ maxConcurrentRuns: 2 }),
      hanging,
    );
    const responses = [
      await gateway.fetch(
        runRequest(runInput("run-1"), { "idempotency-key": "a" }),
      ),
      await gateway.fetch(
        runRequest(runInput("run-2"), { "idempotency-key": "b" }),
      ),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 200]);

    const refused = await gateway.fetch(
      runRequest(runInput("run-3"), { "idempotency-key": "c" }),
    );
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("5");

    for (const release of holds) release();
    await Promise.all(responses.map((r) => r.text()));
    expect(gateway.activeRuns()).toBe(0);
  });

  test("an unreachable or refusing backend is a 502, never a hung slot", async () => {
    const unreachable = createBitmindGateway(config(), () =>
      Promise.reject(new Error("connect ECONNREFUSED")),
    );
    const down = await unreachable.fetch(runRequest(runInput()));
    expect(down.status).toBe(502);
    expect(unreachable.activeRuns()).toBe(0);

    const refusing = createBitmindGateway(config(), () =>
      Promise.resolve(
        Response.json({ error: "Unauthorized." }, { status: 401 }),
      ),
    );
    const refused = await refusing.fetch(runRequest(runInput()));
    expect(refused.status).toBe(502);
    expect(refusing.activeRuns()).toBe(0);
  });
});

describe("configuration", () => {
  test("refuses to start without its tokens, and never invents them", () => {
    expect(() => bitmindGatewayConfig({})).toThrow(/BITMIND_SERVICE_TOKEN/);
    expect(() =>
      bitmindGatewayConfig({ BITMIND_SERVICE_TOKEN: "token" }),
    ).toThrow(/BITMIND_AGENT_TOKEN/);
  });

  test("refuses an agent URL that carries credentials or an odd scheme", () => {
    const base = {
      BITMIND_SERVICE_TOKEN: "token",
      BITMIND_AGENT_TOKEN: "token",
    };
    expect(() =>
      bitmindGatewayConfig({
        ...base,
        BITMIND_AGENT_URL: "http://user:pw@host/ag-ui",
      }),
    ).toThrow(/credentials/);
    expect(() =>
      bitmindGatewayConfig({
        ...base,
        BITMIND_AGENT_URL: "file:///etc/passwd",
      }),
    ).toThrow(/http or https/);
  });
});
