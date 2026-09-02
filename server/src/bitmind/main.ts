import { serve } from "bun";
import { bitmindGatewayConfig, bitmindGatewayListen } from "./config";
import { createBitmindGateway } from "./gateway";

/**
 * The BitMind gateway as its own process.
 *
 * A separate entry rather than a mount inside `src/index.ts`, because the server
 * refuses to start without the Intelligence contract and the enclave this runs in has
 * none. When the server grows a standalone mode, `createBitmindGateway` mounts there
 * and this file retires; until then the enclave supervises this process directly.
 *
 * Configuration is validated before the port binds: a gateway that cannot
 * authenticate its caller or reach its agent must fail in front of whoever deployed
 * it, not in front of the first run.
 */
const config = bitmindGatewayConfig(process.env);
const listen = bitmindGatewayListen(process.env);
const gateway = createBitmindGateway(config);

serve({
  hostname: listen.host,
  port: listen.port,
  // Idle SSE relays are kept open well past Bun's default while a model thinks.
  idleTimeout: 120,
  fetch: (request) => gateway.fetch(request),
});

console.info(
  `bitmind-gateway listening on http://${listen.host}:${String(listen.port)}/bitmind/v1 (agent: ${config.agentUrl})`,
);
