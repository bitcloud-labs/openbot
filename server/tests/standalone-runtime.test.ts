import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { ThreadIdentity } from "../src/routing/thread-identity";
import { testEnvironment } from "./support/environment";

/**
 * The standalone runtime: what a deployment without the Intelligence contract serves,
 * and — just as deliberately — what it does not.
 *
 * The rule under test comes from the enclave work (bit-mind #20): admin surfaces work,
 * the chat runtime, threads and routines are unmounted so those paths 404 by design,
 * and nothing is mounted that would refuse every call. A door that does not exist is
 * the honest shape for a capability the deployment cannot have.
 */

function standaloneEnvironment() {
  const environment = testEnvironment({
    OPENBOT_SINGLE_USER: "true",
    OPENBOT_RUNTIME_MODE: "standalone",
  });
  delete environment.INTELLIGENCE_API_URL;
  delete environment.INTELLIGENCE_GATEWAY_WS_URL;
  delete environment.INTELLIGENCE_API_KEY;
  delete environment.COPILOTKIT_LICENSE_TOKEN;
  // Standalone needs no sign-in provider either: the enclave has no browser users.
  // The auth secrets go with the provider — set without one, they are refused as a
  // half-configuration, the same rule the Intelligence contract follows.
  delete environment.GOOGLE_OAUTH_CLIENT_ID;
  delete environment.GOOGLE_OAUTH_CLIENT_SECRET;
  delete environment.INITIAL_ADMIN_EMAILS;
  delete environment.BETTER_AUTH_SECRET;
  delete environment.BETTER_AUTH_URL;
  return environment;
}

/** A thread namespace, present on purpose: the test proves the routes still stay off. */
const threadIdentity: ThreadIdentity = {
  mint: () => "thread-1",
  owns: () => true,
};

describe("a standalone deployment", () => {
  const config = loadConfig(standaloneEnvironment());

  test("states its mode instead of pretending to a platform it has not got", async () => {
    const app = createApp(config);
    const response = await app.request("/api/capabilities");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      mode: string;
      durableHistory: boolean;
    };
    expect(body.mode).toBe("standalone");
    expect(body.durableHistory).toBe(false);
  });

  test("health answers, because the process is genuinely up", async () => {
    const app = createApp(config);
    const response = await app.request("/health");
    expect(response.status).toBe(200);
  });

  test("the chat runtime is 404 by design, not mounted-and-refusing", async () => {
    const app = createApp(config);
    for (const path of ["/api/copilotkit/info", "/api/copilotkit"]) {
      const response = await app.request(path);
      expect(response.status).toBe(404);
    }
  });

  test("threads stay unmounted even when a thread namespace exists", async () => {
    const args: Parameters<typeof createApp> = [config];
    args[16] = threadIdentity;
    const app = createApp(...args);
    const response = await app.request("/api/threads/thread-1/status");
    // There is no Intelligence to ask about a thread, so there is no door to ask at.
    expect(response.status).toBe(404);
  });

  test("routines stay unmounted: a schedule that can never run must not be enableable", async () => {
    // index.ts withholds the routine store in standalone; this proves the shape that
    // wiring produces. A mounted management surface would let somebody enable an
    // existing schedule the worker then dispatches into a 404, forever.
    const app = createApp(config);
    const response = await app.request("/api/routines");
    expect(response.status).toBe(404);
  });

  test("mounting the chat runtime anyway is refused loudly", async () => {
    // The guard config.ts's old single-mode comment promised: if wiring ever tries to
    // mount the runtime without the contract, it must fail in front of the deployer.
    // Imported dynamically, the way index.ts loads it: a static import here would
    // couple this very suite to the runtime graph standalone exists to avoid.
    const { mountCopilotRuntime } = await import("../src/copilot");
    expect(() =>
      mountCopilotRuntime(
        config,
        { provider: "openai", model: "gpt-5.5" },
        () => Promise.resolve([]),
        () => undefined,
        () => Promise.resolve(null),
        () => Promise.resolve({ id: "", role: "user" }),
        { stallTimeoutMs: 0 },
      ),
    ).toThrow("standalone");
  });
});
