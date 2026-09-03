import { serve } from "bun";
import {
  bitmindGatewayConfig,
  bitmindGatewayListen,
  type BitmindGatewayConfig,
  type BitmindGatewayListen,
} from "./config";
import { createBitmindGateway } from "./gateway";

/**
 * Every variable that configures the gateway.
 *
 * Presence of ANY of them is what says "this deployment means to serve BitMind".
 * Configuration is then validated in full, so a half-set environment — a service
 * token with no agent token, a port with no tokens at all — fails in front of whoever
 * deployed it rather than booting a server that quietly serves nobody.
 */
const GATEWAY_VARIABLES = [
  "BITMIND_SERVICE_TOKEN",
  "BITMIND_AGENT_TOKEN",
  "BITMIND_AGENT_URL",
  "BITMIND_GATEWAY_HOST",
  "BITMIND_GATEWAY_PORT",
  "BITMIND_MAX_CONCURRENT_RUNS",
  "BITMIND_RUN_TIMEOUT_MS",
] as const;

export interface BitmindGatewayMount {
  config: BitmindGatewayConfig;
  listen: BitmindGatewayListen;
  gateway: ReturnType<typeof createBitmindGateway>;
}

/**
 * The gateway this environment asks for, or nothing.
 *
 * Returns undefined only when the environment says nothing about BitMind at all: an
 * ordinary OpenBot deployment mounts no gateway and needs no opinion about one.
 */
export function bitmindGatewayFrom(
  environment: NodeJS.ProcessEnv,
): BitmindGatewayMount | undefined {
  const mentioned = GATEWAY_VARIABLES.some((name) =>
    Boolean(environment[name]?.trim()),
  );
  if (!mentioned) return undefined;
  const config = bitmindGatewayConfig(environment);
  return {
    config,
    listen: bitmindGatewayListen(environment),
    gateway: createBitmindGateway(config),
  };
}

/**
 * Serves the gateway on a listener of its own, in this process.
 *
 * A second listener rather than a path on the server's own port, deliberately. The
 * enclave boundary is stated in terms of exposure: the server port is what an operator
 * publishes — an ingress, a compose port mapping — and adding `/bitmind/v1` to it would
 * put a service-token-authenticated relay wherever that port goes, by accident and
 * without anybody choosing it. Its own host and port keep the loopback default that
 * bit-mind's `openbot-single-host-enclave.md` requires, while the process, its
 * supervision, and its shutdown are the server's.
 */
export function serveBitmindGateway(mount: BitmindGatewayMount) {
  return serve({
    hostname: mount.listen.host,
    port: mount.listen.port,
    // Idle SSE relays are kept open well past Bun's default while a model thinks.
    idleTimeout: 120,
    fetch: (request) => mount.gateway.fetch(request),
  });
}
