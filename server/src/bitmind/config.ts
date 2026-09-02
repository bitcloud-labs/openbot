/**
 * Configuration for the BitMind gateway, read once at startup.
 *
 * Its own module and its own environment surface, deliberately apart from the server's
 * `config.ts`: that file requires the Intelligence contract to resolve at all, and the
 * point of this gateway is to run where Intelligence is not configured. The two grow
 * together again when the server itself learns a standalone mode; until then this reads
 * exactly what the gateway needs and nothing the enclave must not hold.
 */

/** The AG-UI protocol version this deployment is pinned to, as ADR-0002 records it.
 *  A contract test asserts this matches the installed `@ag-ui/core`, so a dependency
 *  bump cannot silently move the protocol underneath either side. */
export const AG_UI_PROTOCOL_VERSION = "0.0.57";

export interface BitmindGatewayConfig {
  /** Bearer token BitMind authenticates with. Never logged, never echoed. */
  serviceToken: string;
  /** The AG-UI agent endpoint runs are relayed to, loopback in the enclave. */
  agentUrl: string;
  /** The managed-agent token the downstream agent requires. */
  agentToken: string;
  /** Admission ceiling: new runs are refused before host pressure builds. */
  maxConcurrentRuns: number;
  /** Whole-run ceiling on the relay, so an abandoned stream cannot hold a slot. */
  runTimeoutMs: number;
}

/** Where the gateway listens. Loopback by default: the enclave boundary requires it. */
export interface BitmindGatewayListen {
  host: string;
  port: number;
}

function integer(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;
  // The whole string or nothing: parseInt's numeric-prefix tolerance turns
  // "2workers" into 2 and "1000ms" into 1000, which is a ceiling somebody believes
  // they set and did not. A limit is a safety number; a malformed one must fail in
  // front of whoever deployed it.
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `${name}=${raw} must be a whole number between ${minimum} and ${maximum}.`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name}=${raw} must be a whole number between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

export function bitmindGatewayConfig(
  environment: NodeJS.ProcessEnv,
): BitmindGatewayConfig {
  const serviceToken = environment.BITMIND_SERVICE_TOKEN?.trim();
  if (!serviceToken) {
    throw new Error(
      "BITMIND_SERVICE_TOKEN is not set. The gateway authenticates every BitMind call and will not start without it. Generate one: openssl rand -hex 32",
    );
  }
  const agentToken = environment.BITMIND_AGENT_TOKEN?.trim();
  if (!agentToken) {
    throw new Error(
      "BITMIND_AGENT_TOKEN is not set. The downstream agent requires its managed-agent token; without it every relayed run would be refused.",
    );
  }
  const agentUrl =
    environment.BITMIND_AGENT_URL?.trim() || "http://localhost:4201/ag-ui";
  const parsed = new URL(agentUrl);
  if (parsed.username || parsed.password) {
    throw new Error("BITMIND_AGENT_URL must not carry credentials.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `BITMIND_AGENT_URL must be http or https, not ${parsed.protocol}`,
    );
  }
  return {
    serviceToken,
    agentToken,
    agentUrl,
    // The enclave note starts staging at two concurrent agent computers; the same
    // ceiling applies to runs until computers exist at all.
    maxConcurrentRuns: integer(
      environment,
      "BITMIND_MAX_CONCURRENT_RUNS",
      2,
      1,
      64,
    ),
    runTimeoutMs: integer(
      environment,
      "BITMIND_RUN_TIMEOUT_MS",
      900_000,
      1_000,
      3_600_000,
    ),
  };
}

export function bitmindGatewayListen(
  environment: NodeJS.ProcessEnv,
): BitmindGatewayListen {
  return {
    // Loopback unless somebody deliberately says otherwise. The enclave exposes this
    // gateway to BitMind over the private path only; a public bind is a mistake.
    host: environment.BITMIND_GATEWAY_HOST?.trim() || "127.0.0.1",
    port: integer(environment, "BITMIND_GATEWAY_PORT", 4310, 1, 65_535),
  };
}
