import { describe, expect, test } from "bun:test";
import type { RunAgentInput } from "@ag-ui/core";
import { respondWithRun } from "../src/respond";
import type { RunStreamEvent } from "../src/stream";

const input = {
  threadId: "thread-1",
  runId: "run-1",
  messages: [],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
} as unknown as RunAgentInput;

/** A model stream that keeps talking until its signal says stop. */
function endlessEvents(observed: { aborted: boolean; yielded: number }) {
  return async (
    signal: AbortSignal,
  ): Promise<AsyncIterable<RunStreamEvent>> => {
    signal.addEventListener("abort", () => {
      observed.aborted = true;
    });
    return (async function* stream() {
      while (!signal.aborted) {
        observed.yielded += 1;
        yield {
          event: "on_chat_model_stream",
          data: { chunk: { content: "word " } },
        } satisfies RunStreamEvent;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    })();
  };
}

describe("a run that is cancelled", () => {
  test("a consumer letting go of the body aborts the model work", async () => {
    const observed = { aborted: false, yielded: 0 };
    const response = respondWithRun(input, endlessEvents(observed));
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await reader?.read();
    await reader?.cancel(new Error("consumer hung up"));

    // The abort must reach the signal handed to the model stream — a consumer that
    // hung up does not stop the model on its own.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(observed.aborted).toBe(true);
    const yieldedAtCancel = observed.yielded;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(observed.yielded).toBe(yieldedAtCancel);
  });

  test("the request's own signal aborts the model work on disconnect", async () => {
    const observed = { aborted: false, yielded: 0 };
    const client = new AbortController();
    const response = respondWithRun(
      input,
      endlessEvents(observed),
      client.signal,
    );

    const reader = response.body?.getReader();
    await reader?.read();
    client.abort(new Error("client disconnected"));

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(observed.aborted).toBe(true);
  });

  test("a signal already aborted before the run starts never yields at all", async () => {
    const observed = { aborted: false, yielded: 0 };
    const client = new AbortController();
    client.abort(new Error("gone before it began"));
    const response = respondWithRun(
      input,
      endlessEvents(observed),
      client.signal,
    );
    await response.text();
    expect(observed.yielded).toBe(0);
  });
});

describe("a run that completes", () => {
  test("streams RUN_STARTED first and ends the stream", async () => {
    const events: RunStreamEvent[] = [
      { event: "on_chat_model_stream", data: { chunk: { content: "Hello." } } },
    ];
    const response = respondWithRun(input, () =>
      Promise.resolve(
        (async function* stream() {
          for (const event of events) yield event;
        })(),
      ),
    );
    const text = await response.text();
    expect(text.indexOf('"RUN_STARTED"')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('"RUN_STARTED"')).toBeLessThan(
      text.indexOf('"TEXT_MESSAGE_CONTENT"'),
    );
    expect(text).toContain('"RUN_FINISHED"');
  });
});
