import { RunAgentInputSchema } from "@ag-ui/core";
import { matchesToken } from "../../../shared/agent-authorisation";
import { AG_UI_PROTOCOL_VERSION, type BitmindGatewayConfig } from "./config";

/**
 * The doorway BitMind talks through: one POST per run, answered with the AG-UI event
 * stream, plus the attestation its activation gate reads before it will enable a
 * worker at all.
 *
 * This is deliberately a relay and not a runtime. The downstream agent owns the model
 * conversation; this process owns what an enclave boundary needs owned on its edge —
 * service authentication, input validation against the pinned protocol schemas,
 * admission control, and an honest statement of what is and is not behind the door.
 * Nothing consequential can happen through it yet: the relayed agent is prose-only
 * (BitMind sends no tools and no computer exists here), which is exactly why
 * `isolated_computers` attests false and BitMind's worker stays disabled.
 *
 * Kept as a handler factory rather than a bound server, the way `agent-langgraph`
 * splits its logic from `serve()`, so tests drive it with plain Requests.
 */

/** Attestation for the enclave activation gate. Every field is a statement BitMind
 *  may act on, so nothing here is aspirational: capabilities appear when they exist. */
export interface BitmindAttestation {
  service: "openbot-bitmind-gateway";
  protocol: { ag_ui: string };
  isolated_computers: boolean;
  execution: { backend: "relay"; tools: boolean; interrupts: boolean };
  limits: { max_concurrent_runs: number; run_timeout_ms: number };
  active_runs: number;
}

const JSON_HEADERS = { "content-type": "application/json" };

function unauthorized(): Response {
  return Response.json({ error: "Unauthorized." }, { status: 401 });
}

function bearerToken(request: Request): string {
  const header = request.headers.get("authorization")?.trim() ?? "";
  return header.toLowerCase().startsWith("bearer ")
    ? header.slice("bearer ".length).trim()
    : "";
}

export function createBitmindGateway(
  config: BitmindGatewayConfig,
  fetchImplementation: typeof fetch = fetch,
) {
  /**
   * Runs currently relayed, by idempotency key.
   *
   * The key is BitMind's `idempotency-key` header (`run_id:fencing_token`), so a retry
   * of the same claimed attempt cannot start a second stream while the first is live —
   * it is refused with 409 and BitMind's bounded retry tries again once the first
   * relay has ended. Falls back to the run id so an unkeyed caller still cannot
   * double-start a run.
   */
  const active = new Map<string, AbortController>();

  function attestation(): BitmindAttestation {
    return {
      service: "openbot-bitmind-gateway",
      protocol: { ag_ui: AG_UI_PROTOCOL_VERSION },
      // No agent computers exist behind this gateway yet, so no isolation exists to
      // attest. BitMind's activation gate requires true; false keeps its worker off,
      // which is the correct state until the enclave provides real computers.
      isolated_computers: false,
      execution: { backend: "relay", tools: false, interrupts: false },
      limits: {
        max_concurrent_runs: config.maxConcurrentRuns,
        run_timeout_ms: config.runTimeoutMs,
      },
      active_runs: active.size,
    };
  }

  async function relayRun(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Body must be JSON." }, { status: 400 });
    }
    const input = RunAgentInputSchema.safeParse(body);
    if (!input.success) {
      // Generic on purpose: echoing the parse failure would reflect caller input.
      return Response.json(
        { error: "Body is not a valid RunAgentInput." },
        { status: 400 },
      );
    }

    const key =
      request.headers.get("idempotency-key")?.trim() || input.data.runId;
    if (active.has(key)) {
      return Response.json(
        { error: "A run with this idempotency key is already streaming." },
        { status: 409 },
      );
    }
    if (active.size >= config.maxConcurrentRuns) {
      return Response.json(
        { error: "The gateway is at its concurrency ceiling." },
        { status: 429, headers: { "retry-after": "5" } },
      );
    }

    // The relay ends when BitMind hangs up, when the ceiling passes, or when the
    // stream finishes — whichever comes first releases the slot.
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error("run relay timed out"));
    }, config.runTimeoutMs);
    const release = () => {
      clearTimeout(timeout);
      active.delete(key);
    };
    request.signal.addEventListener("abort", () => {
      controller.abort(request.signal.reason as Error | undefined);
    });
    active.set(key, controller);

    let downstream: Response;
    try {
      downstream = await fetchImplementation(config.agentUrl, {
        method: "POST",
        signal: controller.signal,
        redirect: "error",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          "x-openbot-agent-token": config.agentToken,
        },
        // The validated input, forwarded whole. `forwardedProps` carries BitMind's
        // identity statement (workspace, agent, run, fencing token) untouched.
        body: JSON.stringify(input.data),
      });
    } catch {
      release();
      return Response.json(
        { error: "The execution backend is unreachable." },
        { status: 502, headers: JSON_HEADERS },
      );
    }
    if (!downstream.ok || !downstream.body) {
      release();
      return Response.json(
        { error: "The execution backend refused the run." },
        { status: 502 },
      );
    }

    const relayed = downstream.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        flush() {
          release();
        },
      }),
    );
    controller.signal.addEventListener("abort", release, { once: true });

    return new Response(relayed, {
      headers: {
        "content-type":
          downstream.headers.get("content-type") ?? "text/event-stream",
        "cache-control": "no-cache",
      },
    });
  }

  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      // Liveness for a supervisor. No auth and no information beyond being up.
      if (url.pathname === "/health") {
        return Response.json({ status: "ok" });
      }

      // Everything else is BitMind's surface and authenticates first.
      if (!matchesToken(config.serviceToken, bearerToken(request))) {
        return unauthorized();
      }

      if (
        url.pathname === "/bitmind/v1/attestation" &&
        request.method === "GET"
      ) {
        return Response.json(attestation());
      }
      if (url.pathname === "/bitmind/v1/run" && request.method === "POST") {
        return relayRun(request);
      }
      return Response.json({ error: "Not found." }, { status: 404 });
    },
    /** Exposed for tests: how many relays are live right now. */
    activeRuns(): number {
      return active.size;
    },
  };
}
