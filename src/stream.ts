/**
 * Server-sent events for a paid endpoint, and the truth about when a caller
 * actually receives them.
 *
 * MEASURED, not assumed. `@x402/express` replaces `res.write`, `res.end`,
 * `res.writeHead` and `res.flushHeaders` the moment a payment verifies, with
 * functions that push their arguments into an array and return. Nothing reaches
 * the socket until the handler has ended AND the facilitator has settled, at
 * which point the recorded calls are replayed in order. A probe writing three
 * frames 200ms apart measured:
 *
 *   through the paywall   client received all three at +615ms, together
 *   same handler, no gate client received them at +1ms, +204ms, +407ms
 *
 * That buffer is not an oversight to route around. It is what lets the
 * middleware cancel settlement when a handler fails, and settlement headers
 * have to precede the body, so nothing can be flushed before the money is known
 * to have moved. Grabbing the original `res.write` back and writing round the
 * middleware flushes the body first and then throws ERR_HTTP_HEADERS_SENT when
 * the receipt is attached — the caller gets a stream and no proof of payment,
 * which is worse than waiting.
 *
 * So `stream: true` promises the FORMAT, not the timing:
 *
 *   - a paid call receives one flush of well-formed `text/event-stream` once
 *     settlement completes. Every frame is there, in order, correctly encoded —
 *     an EventSource-style parser works unchanged — but they arrive together.
 *   - a call that skipped the gate (a live subscription window, a free-tier
 *     call) streams genuinely incrementally, because nothing patched its
 *     response.
 *
 * Every streamed response says which of the two it was in `x-ripar-stream`, so
 * a client never has to guess and nobody has to take this comment on trust.
 */

/** Set before the first frame. `no-transform` and `x-accel-buffering` are for
 *  the proxies between here and the caller — nginx buffers `text/event-stream`
 *  by default, which would re-introduce the delay we just documented away. */
export const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

/** Whether the frames of a stream reach the caller as they are written. */
export type StreamDelivery = "incremental" | "buffered-until-settlement";

export const STREAM_HEADER = "x-ripar-stream";

export type FrameOptions = {
  /** SSE `event:` — the name a client dispatches on. Defaults to `message`. */
  event?: string;
  /** SSE `id:`, which a reconnecting client sends back as Last-Event-ID. */
  id?: string;
  /** SSE `retry:` in milliseconds. */
  retry?: number;
};

/**
 * One SSE frame.
 *
 * A payload containing a newline has to become several `data:` lines — the
 * blank line is the frame terminator, so a raw `\n\n` inside a payload would
 * split one event into two and the second half would arrive as an event with no
 * name and half a JSON document. Objects are JSON-encoded; strings are sent as
 * written, because a caller streaming tokens does not want them quoted.
 */
export function sseFrame(data: unknown, opts: FrameOptions = {}): string {
  const payload = typeof data === "string" ? data : JSON.stringify(data ?? null);
  const lines: string[] = [];
  if (opts.id != null) lines.push(`id: ${oneLine(String(opts.id))}`);
  if (opts.event) lines.push(`event: ${oneLine(opts.event)}`);
  if (opts.retry != null) lines.push(`retry: ${Math.max(0, Math.floor(opts.retry))}`);
  for (const line of payload.split(/\r\n|\r|\n/)) lines.push(`data: ${line}`);
  return `${lines.join("\n")}\n\n`;
}

/** A comment frame: bytes on the wire that no client dispatches as an event.
 *  The standard keep-alive, and the only way to hold a connection open through
 *  an idle proxy without inventing an event a caller has to learn to ignore. */
export function sseComment(text = ""): string {
  return `: ${oneLine(text)}\n\n`;
}

/** SSE fields are single-line by definition; a newline inside one silently ends
 *  the field and turns the rest into whatever field name follows. */
function oneLine(v: string) {
  return v.replace(/[\r\n]+/g, " ");
}
