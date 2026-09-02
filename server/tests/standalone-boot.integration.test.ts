import { expect, test } from "bun:test";

/**
 * The invariant the focused suite cannot prove: `src/index.ts` itself — the real
 * module graph, not a route table — boots in standalone mode. The runtime's import
 * chain has crashed Bun at import time before (see the dynamic-import note in
 * index.ts), and only an actual subprocess boot exercises the graph a deployment
 * loads. Spawned with `cwd: server/` so the repository's own `.env` cannot leak
 * Intelligence values into what is meant to be a bare environment.
 */
const databaseUrl = process.env.DATABASE_URL;

// skipIf, not a `skip` string: Bun treats a reason string as falsy configuration and
// runs the test anyway — reproduced as a child process crashing on an empty
// DATABASE_URL where a skip was intended.
test.skipIf(!databaseUrl)(
  "src/index.ts boots standalone as a real process",
  { timeout: 60_000 },
  async () => {
    const port = 40_000 + Math.floor(Math.random() * 20_000);
    const child = Bun.spawn(["bun", "src/index.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        DATABASE_URL: databaseUrl ?? "",
        KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        OPENBOT_SINGLE_USER: "true",
        OPENBOT_RUNTIME_MODE: "standalone",
        MANAGED_AGENT_AG_UI_URL: "http://localhost:4201/ag-ui",
        MANAGED_AGENT_TOKEN: "standalone-boot-test-token",
        PORT: String(port),
        NODE_ENV: "development",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const deadline = Date.now() + 45_000;
      let up = false;
      while (Date.now() < deadline) {
        if (child.killed) break;
        try {
          const health = await fetch(`http://127.0.0.1:${String(port)}/health`);
          if (health.ok) {
            up = true;
            break;
          }
        } catch {
          // Not listening yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!up) {
        const stderr = await new Response(child.stderr).text();
        throw new Error(`the server never came up:\n${stderr.slice(-2_000)}`);
      }

      const capabilities = (await (
        await fetch(`http://127.0.0.1:${String(port)}/api/capabilities`)
      ).json()) as { mode: string; durableHistory: boolean };
      expect(capabilities.mode).toBe("standalone");
      expect(capabilities.durableHistory).toBe(false);

      const chat = await fetch(
        `http://127.0.0.1:${String(port)}/api/copilotkit/info`,
      );
      expect(chat.status).toBe(404);

      // The two wiring fixes, proven against the REAL index.ts collaborators: the
      // focused route tests build createApp without a thread reader or routine store
      // themselves, so they would still pass if index.ts accidentally supplied either.
      const threads = await fetch(
        `http://127.0.0.1:${String(port)}/api/threads/thread-1/status`,
      );
      expect(threads.status).toBe(404);
      const routines = await fetch(
        `http://127.0.0.1:${String(port)}/api/routines`,
      );
      expect(routines.status).toBe(404);
    } finally {
      child.kill();
      await child.exited;
    }
  },
);

/**
 * The gateway, mounted in the real server process.
 *
 * Two claims only this boot can settle. That `src/index.ts` actually serves BitMind
 * when the environment configures it — the focused tests build the gateway by hand and
 * would pass with the wiring removed. And that mounting it did NOT put a
 * service-token surface on the server's own port, which is the mistake this design
 * exists to avoid: the server port is what an operator publishes, the gateway port is
 * loopback by choice.
 */
test.skipIf(!databaseUrl)(
  "the BitMind gateway is served on its own port, and only there",
  { timeout: 60_000 },
  async () => {
    const port = 40_000 + Math.floor(Math.random() * 10_000);
    const gatewayPort = port + 1;
    const serviceToken = "bitmind-service-token-for-the-boot-test";
    const child = Bun.spawn(["bun", "src/index.ts"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        DATABASE_URL: databaseUrl ?? "",
        KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        OPENBOT_SINGLE_USER: "true",
        OPENBOT_RUNTIME_MODE: "standalone",
        MANAGED_AGENT_AG_UI_URL: "http://localhost:4201/ag-ui",
        MANAGED_AGENT_TOKEN: "standalone-boot-test-token",
        PORT: String(port),
        NODE_ENV: "development",
        BITMIND_SERVICE_TOKEN: serviceToken,
        BITMIND_AGENT_TOKEN: "bitmind-agent-token-for-the-boot-test",
        BITMIND_GATEWAY_PORT: String(gatewayPort),
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const deadline = Date.now() + 45_000;
      let up = false;
      while (Date.now() < deadline) {
        if (child.killed) break;
        try {
          const health = await fetch(
            `http://127.0.0.1:${String(gatewayPort)}/health`,
          );
          if (health.ok) {
            up = true;
            break;
          }
        } catch {
          // Not listening yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (!up) {
        const stderr = await new Response(child.stderr).text();
        throw new Error(`the gateway never came up:\n${stderr.slice(-2_000)}`);
      }

      const anonymous = await fetch(
        `http://127.0.0.1:${String(gatewayPort)}/bitmind/v1/attestation`,
      );
      expect(anonymous.status).toBe(401);

      const attested = await fetch(
        `http://127.0.0.1:${String(gatewayPort)}/bitmind/v1/attestation`,
        { headers: { authorization: `Bearer ${serviceToken}` } },
      );
      expect(attested.status).toBe(200);
      expect(await attested.json()).toMatchObject({
        service: "openbot-bitmind-gateway",
        isolated_computers: false,
      });

      // The server's own port serves the app and nothing of BitMind's — with the
      // right service token in hand, which is the only way this assertion means
      // anything.
      const onServerPort = await fetch(
        `http://127.0.0.1:${String(port)}/bitmind/v1/attestation`,
        { headers: { authorization: `Bearer ${serviceToken}` } },
      );
      expect(onServerPort.status).toBe(404);
      const stillTheApp = await fetch(
        `http://127.0.0.1:${String(port)}/api/capabilities`,
      );
      expect(stillTheApp.status).toBe(200);
    } finally {
      child.kill();
      await child.exited;
    }
  },
);
