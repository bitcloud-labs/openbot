import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import { type RunStreamEvent, streamRun } from "./stream";

/**
 * One run, answered as an AG-UI SSE response — with a way to make it stop.
 *
 * Its own module for the reason `stream.ts` is: `index.ts` calls `serve()` at module
 * scope, so the response lifecycle — and above all its cancellation — has to live
 * where a test can reach it without binding a port.
 *
 * Cancellation has two doors and both lead to the same abort. The caller's signal
 * (the HTTP request's own) fires when the client disconnects; the stream's `cancel()`
 * fires when the consumer lets go of the body. Either way the model invocation is
 * aborted through the signal handed to `makeEvents`, because a consumer that hung up
 * does not stop the model on its own — the tokens keep costing money and the process
 * keeps holding capacity for a reply nobody will read.
 */
export function respondWithRun(
  input: RunAgentInput,
  makeEvents: (signal: AbortSignal) => Promise<AsyncIterable<RunStreamEvent>>,
  clientSignal?: AbortSignal,
): Response {
  const encoder = new EventEncoder();
  const halt = new AbortController();
  if (clientSignal?.aborted) halt.abort(clientSignal.reason);
  clientSignal?.addEventListener(
    "abort",
    () => {
      halt.abort(clientSignal.reason);
    },
    { once: true },
  );

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const utf8 = new TextEncoder();
      const send = (event: BaseEvent) => {
        try {
          controller.enqueue(utf8.encode(encoder.encodeSSE(event)));
        } catch {
          // The consumer is gone; there is nowhere to say anything. The abort below
          // is what stops the work itself.
        }
      };

      send({
        type: "RUN_STARTED",
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);

      await streamRun(() => makeEvents(halt.signal), input, send, halt.signal);

      try {
        controller.close();
      } catch {
        // Already cancelled by the consumer.
      }
    },
    cancel(reason) {
      halt.abort(
        reason instanceof Error
          ? reason
          : new Error("run cancelled by its consumer"),
      );
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": encoder.getContentType(),
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
