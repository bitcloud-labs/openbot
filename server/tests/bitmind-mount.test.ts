import { describe, expect, test } from "bun:test";
import { bitmindGatewayFrom } from "../src/bitmind/mount";

const COMPLETE = {
  BITMIND_SERVICE_TOKEN: "service-token-for-tests-0000000000000000",
  BITMIND_AGENT_TOKEN: "managed-agent-token-for-tests-00000000",
};

describe("mounting the gateway", () => {
  test("an ordinary deployment mounts nothing", () => {
    expect(bitmindGatewayFrom({})).toBeUndefined();
    // Unrelated variables do not summon a gateway either.
    expect(
      bitmindGatewayFrom({ PORT: "3000", MANAGED_AGENT_TOKEN: "token" }),
    ).toBeUndefined();
  });

  test.each([
    ["BITMIND_SERVICE_TOKEN", { BITMIND_SERVICE_TOKEN: "token" }],
    ["BITMIND_AGENT_TOKEN", { BITMIND_AGENT_TOKEN: "token" }],
    ["BITMIND_GATEWAY_PORT", { BITMIND_GATEWAY_PORT: "4310" }],
    ["BITMIND_AGENT_URL", { BITMIND_AGENT_URL: "http://localhost:4201/ag-ui" }],
    ["BITMIND_MAX_CONCURRENT_RUNS", { BITMIND_MAX_CONCURRENT_RUNS: "2" }],
  ] as const)(
    "%s alone is a boot failure, not a quiet half-gateway",
    (_name, environment) => {
      // Whichever half is present, the missing token is what the operator is told
      // about — a server that boots and then refuses every BitMind call would look
      // like BitMind's fault.
      expect(() => bitmindGatewayFrom(environment)).toThrow(
        /BITMIND_\w+_TOKEN/,
      );
    },
  );

  test("a configured environment yields a loopback gateway", () => {
    const mount = bitmindGatewayFrom(COMPLETE);
    expect(mount).toBeDefined();
    expect(mount?.listen).toEqual({ host: "127.0.0.1", port: 4310 });
    expect(mount?.config.agentUrl).toBe("http://localhost:4201/ag-ui");
    expect(mount?.gateway.activeRuns()).toBe(0);
  });

  test("the listener stays where it is put", () => {
    const mount = bitmindGatewayFrom({
      ...COMPLETE,
      BITMIND_GATEWAY_HOST: "10.1.2.3",
      BITMIND_GATEWAY_PORT: "4999",
    });
    expect(mount?.listen).toEqual({ host: "10.1.2.3", port: 4999 });
  });

  test("a malformed limit fails the boot rather than being coerced", () => {
    expect(() =>
      bitmindGatewayFrom({ ...COMPLETE, BITMIND_GATEWAY_PORT: "4310ish" }),
    ).toThrow(/whole number/);
  });

  test("the mounted gateway is the real one, and still refuses without the token", async () => {
    const mount = bitmindGatewayFrom(COMPLETE);
    expect(mount).toBeDefined();
    const anonymous = await mount?.gateway.fetch(
      new Request("http://gateway/bitmind/v1/attestation"),
    );
    expect(anonymous?.status).toBe(401);
    const authenticated = await mount?.gateway.fetch(
      new Request("http://gateway/bitmind/v1/attestation", {
        headers: { authorization: `Bearer ${COMPLETE.BITMIND_SERVICE_TOKEN}` },
      }),
    );
    expect(authenticated?.status).toBe(200);
    expect(await authenticated?.json()).toMatchObject({
      isolated_computers: false,
    });
  });
});
