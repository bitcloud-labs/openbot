import { describe, expect, test } from "bun:test";
import { callDeploymentTool } from "../src/tools";

const settings = {
  url: "http://localhost:3001/api/agent-tools/call",
  token: "tool-token",
};

describe("a governed tool call", () => {
  test("carries the run's signal into the request itself", async () => {
    let seenSignal: AbortSignal | undefined;
    const fakeFetch: typeof fetch = (_url, init) => {
      seenSignal = init?.signal ?? undefined;
      return Promise.resolve(Response.json({ text: "done" }));
    };
    const controller = new AbortController();
    const text = await callDeploymentTool(
      settings,
      "signed-run",
      "browse",
      { url: "https://example.com" },
      controller.signal,
      fakeFetch,
    );
    expect(text).toBe("done");
    expect(seenSignal).toBe(controller.signal);
  });

  test("cancellation mid-request stops the call instead of waiting out the action", async () => {
    // The case the model-stream tests cannot cover: the run is cancelled while the
    // tool's HTTP request is in flight. The fetch must abort — a governed action
    // continuing after its run was cancelled is work nobody is entitled to any more.
    const hangingFetch: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(
            init.signal?.reason instanceof Error
              ? init.signal.reason
              : new Error("aborted"),
          );
        });
        // Never resolves on its own: only the abort ends it.
      });
    const controller = new AbortController();
    const call = callDeploymentTool(
      settings,
      "signed-run",
      "browse",
      {},
      controller.signal,
      hangingFetch,
    );
    setTimeout(() => {
      controller.abort(new Error("run cancelled"));
    }, 20);
    const started = Date.now();
    const text = await call;
    // Promptly, and as a spoken result for the transcript rather than a throw.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(text).toContain("could not be called");
    expect(text).toContain("run cancelled");
  });

  test("refusals still answer without touching the network", async () => {
    const untouched: typeof fetch = () => {
      throw new Error("must not fetch");
    };
    expect(
      await callDeploymentTool(
        { ...settings, token: "" },
        "run",
        "browse",
        {},
        undefined,
        untouched,
      ),
    ).toContain("no credential");
    expect(
      await callDeploymentTool(
        settings,
        "",
        "browse",
        {},
        undefined,
        untouched,
      ),
    ).toContain("no signed statement");
  });
});
