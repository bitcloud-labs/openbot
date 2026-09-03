import { RunAgentInputSchema } from "@ag-ui/core";
import { z } from "zod";
import { matchesToken } from "../../../shared/agent-authorisation";
import { AG_UI_PROTOCOL_VERSION, type BitmindGatewayConfig } from "./config";

/**
 * BitMind's identity statement, required in full.
 *
 * The generic AG-UI envelope says nothing about who a run belongs to; this gateway
 * refuses an attempt whose identity is missing or self-contradictory rather than
 * relaying it and letting the far side guess. `fencing_token` is what makes a retry
 * of the same claimed attempt recognisable, so it must be a whole number, and the
 * `idempotency-key` header — when sent — must agree with it: a caller-selectable key
 * detached from the run would defeat the double-start protection it exists for.
 */
const BitmindForwardedPropsSchema = z.object({
  workspace_id: z.string().min(1),
  agent_id: z.string().min(1).nullable(),
  run_id: z.string().min(1),
  message_id: z.string().min(1),
  fencing_token: z.number().int().nonnegative(),
});

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

  /**
   * Whether the configured supervisor is actually there, right now.
   *
   * Checked on every attestation rather than cached: a stale "true" is the one this
   * field must never say, because it is what turns BitMind's worker on. A supervisor
   * that was reachable a minute ago and has since died must attest `false` on the
   * very next check, not on the next restart. Health is unauthenticated on the
   * supervisor's own side, so this asks nothing it would need a token for.
   */
  async function supervisorReachable(): Promise<boolean> {
    if (!config.supervisorUrl) return false;
    try {
      const response = await fetchImplementation(
        new URL("/health", config.supervisorUrl),
        { signal: AbortSignal.timeout(3_000) },
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  async function attestation(): Promise<BitmindAttestation> {
    return {
      service: "openbot-bitmind-gateway",
      protocol: { ag_ui: AG_UI_PROTOCOL_VERSION },
      // True only when a supervisor is configured AND answering right now. Anything
      // else is the pre-enclave state: no isolation exists to attest, so BitMind's
      // worker must stay off.
      isolated_computers: await supervisorReachable(),
      execution: { backend: "relay", tools: false, interrupts: false },
      limits: {
        max_concurrent_runs: config.maxConcurrentRuns,
        run_timeout_ms: config.runTimeoutMs,
      },
      active_runs: active.size,
    };
  }

  /**
   * What BitMind is told when it asks for an agent's computer.
   *
   * Deliberately a small, named subset of what the supervisor returns — never the
   * container name, the internal container-DNS url, or the raw identity/error text,
   * none of which BitMind can use and none of which belongs on the wire to a
   * different trust domain. `computer/control` and `computer/frames` (control
   * transfer, live frames) are not implemented yet: `agent-computer` already has
   * both as real features of its own (`/control/take`, `/stream`), but relaying a
   * live CDP frame stream or a control-transfer session through this gateway is its
   * own design question, not an extension of this one route.
   */
  async function ensureComputer(agentId: string): Promise<Response> {
    if (!config.supervisorUrl || !config.supervisorToken) {
      return Response.json(
        { error: "This gateway has no computer supervisor configured." },
        { status: 503 },
      );
    }
    let downstream: Response;
    try {
      downstream = await fetchImplementation(
        new URL(
          `/computers/${encodeURIComponent(agentId)}/ensure`,
          config.supervisorUrl,
        ),
        {
          method: "POST",
          signal: AbortSignal.timeout(config.runTimeoutMs),
          headers: { authorization: `Bearer ${config.supervisorToken}` },
        },
      );
    } catch {
      return Response.json(
        { error: "The computer supervisor is unreachable." },
        { status: 502 },
      );
    }
    if (!downstream.ok) {
      // The supervisor's own status carries real meaning here (400 a bad agent id,
      // 409 a name held elsewhere, 503 Docker itself unavailable) — passed through
      // rather than flattened to one generic code, but never its response body,
      // which is written for an operator, not for BitMind.
      return Response.json(
        { error: "The computer supervisor refused the request." },
        { status: downstream.status },
      );
    }
    const state = (await downstream.json()) as {
      status?: string;
      startedAt?: string;
    };
    return Response.json({
      status: state.status ?? "unknown",
      ...(state.startedAt ? { started_at: state.startedAt } : {}),
    });
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
    const identity = BitmindForwardedPropsSchema.safeParse(
      input.data.forwardedProps,
    );
    if (!identity.success) {
      return Response.json(
        { error: "forwardedProps must carry the BitMind identity statement." },
        { status: 400 },
      );
    }
    if (identity.data.run_id !== input.data.runId) {
      return Response.json(
        { error: "forwardedProps.run_id must match runId." },
        { status: 400 },
      );
    }
    // While the attestation says tools: false and interrupts: false, the gateway
    // holds that boundary itself rather than trusting the far side to. A run
    // carrying tools or resume answers is asking for capabilities nobody attested.
    if (input.data.tools.length > 0) {
      return Response.json(
        { error: "This gateway attests tools: false and relays none." },
        { status: 400 },
      );
    }
    if ((input.data.resume?.length ?? 0) > 0) {
      return Response.json(
        {
          error:
            "This gateway attests interrupts: false and accepts no resume.",
        },
        { status: 400 },
      );
    }

    const expectedKey = `${identity.data.run_id}:${String(identity.data.fencing_token)}`;
    const offeredKey = request.headers.get("idempotency-key")?.trim();
    if (offeredKey && offeredKey !== expectedKey) {
      return Response.json(
        { error: "idempotency-key must be run_id:fencing_token." },
        { status: 400 },
      );
    }
    const key = expectedKey;
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
    /**
     * Give the slot back — but only if this relay still holds it.
     *
     * A cancelled relay ends through several paths at once (the abort listener, the
     * stream's `cancel()`, and the pending `reader.read()` resolving), and a same-key
     * retry can legitimately be admitted between two of them. An unconditional delete
     * would then evict the *new* relay's entry while its stream is live, taking both
     * the concurrency accounting and the 409 double-start refusal with it. Ownership
     * is the guard: whoever is in the map is the only one who can leave it, which also
     * makes every one of those endings safe to run more than once.
     */
    const release = () => {
      clearTimeout(timeout);
      if (active.get(key) === controller) {
        active.delete(key);
      }
    };
    request.signal.addEventListener("abort", () => {
      controller.abort(request.signal.reason as Error | undefined);
    });
    // Abort events are not replayed: a caller that hung up while the body was still
    // being read or validated has already fired its signal, and the listener above
    // heard nothing. Checked AFTER registering, so a signal firing between the check
    // and the listener cannot slip through either way — one of the two catches it.
    if (request.signal.aborted) {
      clearTimeout(timeout);
      return Response.json(
        { error: "The caller aborted before the run was relayed." },
        { status: 400 },
      );
    }
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
      // A refusal can arrive as headers over a body that keeps streaming. The slot
      // must not come back while that request is still live, so the fetch is
      // aborted and the body ended before admission is released.
      controller.abort(new Error("backend refused the run"));
      await downstream.body?.cancel().catch(() => undefined);
      release();
      return Response.json(
        { error: "The execution backend refused the run." },
        { status: 502 },
      );
    }
    // A 2xx with a body is not yet an agent: a proxy login page or a JSON error
    // answers exactly that way. Only the AG-UI stream content type may be reserved
    // and reported to BitMind as a run in progress.
    const contentType = downstream.headers.get("content-type") ?? "";
    // The media type itself, exactly: startsWith would admit text/event-streaming
    // and text/event-stream+json, neither of which is the AG-UI wire. Parameters
    // after the first ";" (charset) are legitimate and preserved when forwarding.
    const mediaType = (contentType.split(";", 1)[0] ?? "").trim().toLowerCase();
    if (mediaType !== "text/event-stream") {
      controller.abort(
        new Error("backend did not answer with an event stream"),
      );
      await downstream.body.cancel().catch(() => undefined);
      release();
      return Response.json(
        { error: "The execution backend did not answer with an event stream." },
        { status: 502 },
      );
    }

    // Pumped by hand rather than piped: the slot must come back on EVERY ending —
    // clean close, source error, consumer cancellation, timeout — and a transform's
    // flush() only runs for the first of those. The reader loop's finally is the one
    // place all four paths pass through.
    const reader = downstream.body.getReader();
    const relayed = new ReadableStream<Uint8Array>({
      async pull(streamController) {
        let result: Awaited<ReturnType<typeof reader.read>>;
        try {
          result = await reader.read();
        } catch (error) {
          release();
          streamController.error(error);
          return;
        }
        if (result.done) {
          release();
          streamController.close();
          return;
        }
        streamController.enqueue(result.value);
      },
      async cancel(reason) {
        // BitMind hung up. The far side is told, not just abandoned: the model must
        // stop working, and the slot comes back only alongside that abort.
        controller.abort(
          reason instanceof Error ? reason : new Error("relay cancelled"),
        );
        await reader.cancel(reason).catch(() => undefined);
        release();
      },
    });
    controller.signal.addEventListener(
      "abort",
      () => {
        void reader.cancel(controller.signal.reason).catch(() => undefined);
        release();
      },
      { once: true },
    );

    return new Response(relayed, {
      headers: {
        "content-type": contentType,
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
        return Response.json(await attestation());
      }
      if (url.pathname === "/bitmind/v1/run" && request.method === "POST") {
        return relayRun(request);
      }
      const computerEnsure = /^\/bitmind\/v1\/computer\/([^/]+)\/ensure$/.exec(
        url.pathname,
      );
      if (computerEnsure && request.method === "POST") {
        return ensureComputer(decodeURIComponent(computerEnsure[1] ?? ""));
      }
      return Response.json({ error: "Not found." }, { status: 404 });
    },
    /** Exposed for tests: how many relays are live right now. */
    activeRuns(): number {
      return active.size;
    },
  };
}
