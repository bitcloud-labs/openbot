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
      message_id: "message-1",
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
      await gateway.fetch(runRequest(runInput("run-1"))),
      await gateway.fetch(runRequest(runInput("run-2"))),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 200]);

    const refused = await gateway.fetch(runRequest(runInput("run-3")));
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

describe("identity enforcement", () => {
  test("an attempt without its full identity statement is refused", async () => {
    const gateway = createBitmindGateway(config(), () => {
      throw new Error("must not reach the agent");
    });
    const input = runInput() as { forwardedProps: Record<string, unknown> };
    delete input.forwardedProps.message_id;
    const response = await gateway.fetch(runRequest(input));
    expect(response.status).toBe(400);
  });

  test("a run whose envelope and identity disagree is refused", async () => {
    const gateway = createBitmindGateway(config(), () => {
      throw new Error("must not reach the agent");
    });
    const input = runInput("run-1") as { forwardedProps: { run_id: string } };
    input.forwardedProps.run_id = "run-somebody-else";
    const response = await gateway.fetch(runRequest(input));
    expect(response.status).toBe(400);
  });

  test("the idempotency key is bound to the attempt, never caller-selectable", async () => {
    const gateway = createBitmindGateway(config(), () => {
      throw new Error("must not reach the agent");
    });
    const response = await gateway.fetch(
      runRequest(runInput(), { "idempotency-key": "whatever-i-like" }),
    );
    expect(response.status).toBe(400);
  });
});

describe("capability enforcement", () => {
  test("tools are refused while the attestation says tools: false", async () => {
    let reached = false;
    const gateway = createBitmindGateway(config(), () => {
      reached = true;
      throw new Error("must not reach the agent");
    });
    const input = runInput() as { tools: unknown[] };
    input.tools = [
      { name: "browser_navigate", description: "go", parameters: {} },
    ];
    const response = await gateway.fetch(runRequest(input));
    expect(response.status).toBe(400);
    expect(reached).toBe(false);
  });

  test("resume answers are refused while the attestation says interrupts: false", async () => {
    let reached = false;
    const gateway = createBitmindGateway(config(), () => {
      reached = true;
      throw new Error("must not reach the agent");
    });
    const input = runInput() as { resume?: unknown[] };
    input.resume = [{ interruptId: "int-1", status: "resolved" }];
    const response = await gateway.fetch(runRequest(input));
    expect(response.status).toBe(400);
    expect(reached).toBe(false);
  });
});

describe("stream lifecycle", () => {
  test("a backend that answers JSON is a 502, not a relayed run", async () => {
    const gateway = createBitmindGateway(config(), () =>
      Promise.resolve(
        Response.json({ error: "please sign in" }, { status: 200 }),
      ),
    );
    const response = await gateway.fetch(runRequest(runInput()));
    expect(response.status).toBe(502);
    expect(gateway.activeRuns()).toBe(0);
  });

  test("a source error mid-stream releases the slot", async () => {
    const failing: typeof fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
              controller.error(new Error("backend fell over"));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );
    const gateway = createBitmindGateway(config(), failing);
    const response = await gateway.fetch(runRequest(runInput()));
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toThrow();
    expect(gateway.activeRuns()).toBe(0);
  });

  test("a consumer that hangs up releases the slot and stops the backend", async () => {
    let downstreamAborted = false;
    const hanging: typeof fetch = (_url, init) => {
      init?.signal?.addEventListener("abort", () => {
        downstreamAborted = true;
      });
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
              // Never closes: the consumer is the one who ends this.
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );
    };
    const gateway = createBitmindGateway(config(), hanging);
    const response = await gateway.fetch(runRequest(runInput()));
    expect(response.status).toBe(200);
    expect(gateway.activeRuns()).toBe(1);
    await response.body?.cancel(new Error("BitMind hung up"));
    expect(gateway.activeRuns()).toBe(0);
    expect(downstreamAborted).toBe(true);
  });
});

describe("strict limits", () => {
  test.each(["2workers", "2.5", "1000ms", "-1", "1e3"])(
    "a malformed ceiling like %s is refused, never coerced",
    (value) => {
      expect(() =>
        bitmindGatewayConfig({
          BITMIND_SERVICE_TOKEN: "token",
          BITMIND_AGENT_TOKEN: "token",
          BITMIND_MAX_CONCURRENT_RUNS: value,
        }),
      ).toThrow(/whole number/);
    },
  );
});

describe("follow-up findings", () => {
  test("a refusal over a still-streaming body ends the request before admitting more", async () => {
    let downstreamAborted = false;
    let bodyCancelled = false;
    const refusing: typeof fetch = (_url, init) => {
      init?.signal?.addEventListener("abort", () => {
        downstreamAborted = true;
      });
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("still talking\n"));
              // Never closes on its own.
            },
            cancel() {
              bodyCancelled = true;
            },
          }),
          { status: 503, headers: { "content-type": "text/event-stream" } },
        ),
      );
    };
    const gateway = createBitmindGateway(config(), refusing);
    const response = await gateway.fetch(runRequest(runInput()));
    expect(response.status).toBe(502);
    expect(gateway.activeRuns()).toBe(0);
    expect(downstreamAborted).toBe(true);
    expect(bodyCancelled).toBe(true);
  });

  test.each(["text/event-streaming", "text/event-stream+json"])(
    "a media type like %s is not the AG-UI wire",
    async (contentType) => {
      const gateway = createBitmindGateway(config(), () =>
        Promise.resolve(
          new Response("data: {}\n\n", {
            status: 200,
            headers: { "content-type": contentType },
          }),
        ),
      );
      const response = await gateway.fetch(runRequest(runInput()));
      expect(response.status).toBe(502);
      expect(gateway.activeRuns()).toBe(0);
    },
  );

  test("parameters on the real media type survive the check and the forward", async () => {
    const gateway = createBitmindGateway(config(), () =>
      Promise.resolve(
        new Response("data: {}\n\n", {
          status: 200,
          headers: { "content-type": "text/event-stream; charset=utf-8" },
        }),
      ),
    );
    const response = await gateway.fetch(runRequest(runInput()));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/event-stream; charset=utf-8",
    );
    await response.text();
    expect(gateway.activeRuns()).toBe(0);
  });

  test("a caller that already hung up never reserves a slot or reaches the agent", async () => {
    let reached = false;
    const gateway = createBitmindGateway(config(), () => {
      reached = true;
      throw new Error("must not reach the agent");
    });
    // Abort events are not replayed: this signal fired before the gateway could
    // listen, which is exactly the case a listener alone misses.
    const controller = new AbortController();
    const request = new Request("http://gateway/bitmind/v1/run", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(runInput()),
      signal: controller.signal,
    });
    controller.abort(new Error("caller gone"));
    const response = await gateway.fetch(request);
    expect(response.status).toBe(400);
    expect(reached).toBe(false);
    expect(gateway.activeRuns()).toBe(0);
  });
});
