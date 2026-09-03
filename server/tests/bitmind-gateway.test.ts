import { describe, expect, test } from "bun:test";
import type { ComputerGateway } from "../src/computer/gateway";
import {
  AG_UI_PROTOCOL_VERSION,
  bitmindGatewayConfig,
} from "../src/bitmind/config";
import { createBitmindGateway } from "../src/bitmind/gateway";
import type { BitmindAttestation } from "../src/bitmind/gateway";

const SERVICE_TOKEN = "service-token-for-tests-0000000000000000";
const AGENT_TOKEN = "managed-agent-token-for-tests-00000000";

/**
 * A computer gateway with every method stubbed to fail loudly, so a test that
 * overrides only the two or three methods it exercises cannot silently pass by
 * calling into a method it never meant to reach — the same
 * `as unknown as ComputerGateway` partial-fake pattern `computer-routes.test.ts`
 * already establishes for this same interface.
 */
function fakeComputerGateway(
  overrides: Partial<ComputerGateway> = {},
): ComputerGateway {
  const unexpected = (name: string) => () => {
    throw new Error(
      `fakeComputerGateway.${name} was not expected to be called`,
    );
  };
  return {
    provider: {
      list: async () => [],
    } as unknown as ComputerGateway["provider"],
    locate: unexpected("locate"),
    status: unexpected("status"),
    screenshot: unexpected("screenshot"),
    takeControl: unexpected("takeControl"),
    releaseControl: unexpected("releaseControl"),
    ...overrides,
  } as unknown as ComputerGateway;
}

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
    // No computer gateway configured: attesting true here would switch BitMind's
    // worker on against isolation that does not exist.
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

  test("isolated_computers is true only while the computer gateway answers", async () => {
    const gateway = createBitmindGateway(
      config(),
      undefined,
      fakeComputerGateway({ provider: { list: async () => [] } as never }),
    );
    const up = await gateway.fetch(
      new Request("http://gateway/bitmind/v1/attestation", {
        headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
      }),
    );
    expect((await up.json<BitmindAttestation>()).isolated_computers).toBe(true);
  });

  test("isolated_computers is false when the computer gateway's own provider fails", async () => {
    const gateway = createBitmindGateway(
      config(),
      undefined,
      fakeComputerGateway({
        provider: {
          list: () => Promise.reject(new Error("supervisor unreachable")),
        } as never,
      }),
    );
    const response = await gateway.fetch(
      new Request("http://gateway/bitmind/v1/attestation", {
        headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
      }),
    );
    expect((await response.json<BitmindAttestation>()).isolated_computers).toBe(
      false,
    );
  });
});

describe("computer", () => {
  function request(
    agentId: string,
    sub: string,
    init: RequestInit = {},
  ): Request {
    return new Request(`http://gateway/bitmind/v1/computer/${agentId}${sub}`, {
      ...init,
      headers: { authorization: `Bearer ${SERVICE_TOKEN}`, ...init.headers },
    });
  }

  test("every route is unavailable when no computer gateway is configured", async () => {
    const gateway = createBitmindGateway(config());
    for (const req of [
      request("agent-1", ""),
      request("agent-1", "/ensure", { method: "POST" }),
      request("agent-1", "/screenshot"),
      request("agent-1", "/control", {
        method: "POST",
        headers: { "x-bitmind-actor-id": "user-1" },
        body: JSON.stringify({ action: "take" }),
      }),
    ]) {
      const response = await gateway.fetch(req);
      expect(response.status).toBe(503);
    }
  });

  test("requires the service token, like every other BitMind route", async () => {
    const gateway = createBitmindGateway(
      config(),
      undefined,
      fakeComputerGateway(),
    );
    const bare = await gateway.fetch(
      new Request("http://gateway/bitmind/v1/computer/agent-1", {
        method: "GET",
      }),
    );
    expect(bare.status).toBe(401);
  });

  test("GET observes status without starting anything", async () => {
    const seen: string[] = [];
    const gateway = createBitmindGateway(
      config(),
      undefined,
      fakeComputerGateway({
        status: async (botId) => {
          seen.push(botId);
          return { botId, state: "absent" };
        },
      }),
    );
    const response = await gateway.fetch(request("agent-1", ""));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      botId: "agent-1",
      state: "absent",
    });
    expect(seen).toEqual(["agent-1"]);
  });

  test("ensure locates (starting if needed) and reports the resulting status", async () => {
    const located: string[] = [];
    const gateway = createBitmindGateway(
      config(),
      undefined,
      fakeComputerGateway({
        locate: async (botId) => {
          located.push(botId);
          return "http://openbot-computer-agent-1:4100";
        },
        status: async (botId) => ({ botId, state: "ready" }),
      }),
    );
    const response = await gateway.fetch(
      request("agent-1", "/ensure", { method: "POST" }),
    );
    expect(response.status).toBe(200);
    // Never the address `locate` resolved — that is an internal container-DNS url,
    // not something BitMind can reach or should see.
    expect(await response.json()).toEqual({ botId: "agent-1", state: "ready" });
    expect(located).toEqual(["agent-1"]);
  });

  test("screenshot passes the gateway's own result through", async () => {
    const gateway = createBitmindGateway(
      config(),
      undefined,
      fakeComputerGateway({
        screenshot: async () => ({
          base64: "aGVsbG8=",
          width: 1280,
          height: 800,
          capturedAt: "2026-09-03T00:00:00.000Z",
          url: "https://example.com",
        }),
      }),
    );
    const response = await gateway.fetch(request("agent-1", "/screenshot"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      base64: "aGVsbG8=",
      width: 1280,
      height: 800,
      capturedAt: "2026-09-03T00:00:00.000Z",
      url: "https://example.com",
    });
  });

  test("control take and release call the matching verb with an actor from the request", async () => {
    const calls: { verb: string; botId: string; actor: unknown }[] = [];
    const gateway = createBitmindGateway(
      config(),
      undefined,
      fakeComputerGateway({
        takeControl: async (botId, actor) => {
          calls.push({ verb: "take", botId, actor });
          return { holder: "human", since: "now", requested: false };
        },
        releaseControl: async (botId, actor) => {
          calls.push({ verb: "release", botId, actor });
          return { holder: "bot", since: "now", requested: false };
        },
      }),
    );
    const take = await gateway.fetch(
      request("agent-1", "/control", {
        method: "POST",
        headers: { "x-bitmind-actor-id": "person-7" },
        body: JSON.stringify({ action: "take" }),
      }),
    );
    expect(take.status).toBe(200);
    expect(await take.json()).toEqual({
      holder: "human",
      since: "now",
      requested: false,
    });

    const release = await gateway.fetch(
      request("agent-1", "/control", {
        method: "POST",
        headers: { "x-bitmind-actor-id": "person-7" },
        body: JSON.stringify({ action: "release" }),
      }),
    );
    expect(release.status).toBe(200);

    expect(calls).toEqual([
      { verb: "take", botId: "agent-1", actor: { id: "bitmind:person-7" } },
      { verb: "release", botId: "agent-1", actor: { id: "bitmind:person-7" } },
    ]);
  });

  test("control without an actor is refused before it reaches the gateway", async () => {
    const gateway = createBitmindGateway(
      config(),
      undefined,
      fakeComputerGateway({
        takeControl: () => {
          throw new Error("must not be called without an actor");
        },
      }),
    );
    const response = await gateway.fetch(
      request("agent-1", "/control", {
        method: "POST",
        body: JSON.stringify({ action: "take" }),
      }),
    );
    expect(response.status).toBe(400);
  });

  test("control with an invalid action is refused", async () => {
    const gateway = createBitmindGateway(
      config(),
      undefined,
      fakeComputerGateway(),
    );
    const response = await gateway.fetch(
      request("agent-1", "/control", {
        method: "POST",
        headers: { "x-bitmind-actor-id": "person-7" },
        body: JSON.stringify({ action: "reboot" }),
      }),
    );
    expect(response.status).toBe(400);
  });

  test("a failure anywhere in the computer seam is a 502, never the underlying message", async () => {
    const gateway = createBitmindGateway(
      config(),
      undefined,
      fakeComputerGateway({
        status: () =>
          Promise.reject(new Error("supervisor said something private")),
      }),
    );
    const response = await gateway.fetch(request("agent-1", ""));
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "The computer backend refused the request.",
    });
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

describe("cancellation and the slot's owner", () => {
  test("a cancelled relay does not release the retry that replaced it", async () => {
    let calls = 0;
    const hanging: typeof fetch = () => {
      calls += 1;
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
              // Never closes: only the consumer or the gateway ends this.
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );
    };
    const gateway = createBitmindGateway(config(), hanging);
    const first = await gateway.fetch(
      runRequest(runInput(), { "idempotency-key": "run-1:1" }),
    );
    expect(first.status).toBe(200);
    expect(gateway.activeRuns()).toBe(1);

    // BitMind hangs up and immediately retries the same attempt. The cancelled
    // relay ends through several paths (abort listener, stream cancel, the pending
    // read resolving); the retry is admitted in the middle of them, and none of
    // those late endings may take the retry's slot with them.
    const cancelling = first.body?.cancel(new Error("BitMind hung up"));
    const retry = await gateway.fetch(
      runRequest(runInput(), { "idempotency-key": "run-1:1" }),
    );
    expect(retry.status).toBe(200);
    expect(gateway.activeRuns()).toBe(1);
    await cancelling;
    expect(gateway.activeRuns()).toBe(1);

    // The retry is streaming, so the idempotency refusal must still hold and the
    // backend must not be asked a third time.
    const third = await gateway.fetch(
      runRequest(runInput(), { "idempotency-key": "run-1:1" }),
    );
    expect(third.status).toBe(409);
    expect(gateway.activeRuns()).toBe(1);
    expect(calls).toBe(2);

    await retry.body?.cancel(new Error("done"));
    expect(gateway.activeRuns()).toBe(0);
  });
});
