import { randomBytes } from "node:crypto";

/**
 * W3C Trace Context, which is what makes a paid call traceable across an
 * agent-to-agent chain.
 *
 * One agent calling three others produces four sets of logs on four machines
 * owned by four people, and the only thing that can join them is an id the
 * caller chose and everyone propagated. Without it, "the call cost $0.40 and
 * took 9 seconds — where did the time go" is unanswerable, because nothing in
 * agent C's logs can be matched to the request in agent A's.
 *
 * `traceparent` is the standard every tracing vendor already reads, so an agent
 * that honours it lands in an existing Jaeger or Honeycomb view for free. The
 * format is fixed-width and unforgiving:
 *
 *   00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
 *   ^  ^                                ^                ^
 *   |  trace-id (16 bytes)              parent-id (8)    flags
 *   version
 *
 * A malformed header is DROPPED rather than repaired: the spec says so, and a
 * salvaged half-id joins a trace to the wrong parent, which is worse than
 * starting a fresh one. An absent header gets a new trace id, so a call that
 * arrives untraced still leaves this agent traceable.
 */

export type TraceContext = {
  /** 32 lowercase hex characters, shared by every span in the trace. */
  traceId: string;
  /** This agent's span. New on every request, even when the trace continues. */
  spanId: string;
  /** The caller's span, when they sent a usable traceparent. */
  parentSpanId?: string;
  /** The sampled flag, propagated verbatim — a chain where each hop decides
   *  separately produces traces with holes in them. */
  sampled: boolean;
  /** True when the caller supplied the trace, false when we started it. Worth
   *  knowing: a chain where every hop reports `false` is a chain that is not
   *  propagating, and that looks identical to a chain nobody is calling. */
  inbound: boolean;
  /** The header to send onward, and to echo back. */
  traceparent: string;
};

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;
const NULL_TRACE = "0".repeat(32);
const NULL_SPAN = "0".repeat(16);

/** The inbound header, or null when there is nothing safe to continue. */
export function parseTraceparent(
  raw: string | string[] | undefined | null
): { version: string; traceId: string; parentId: string; flags: string } | null {
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!value) return null;

  const m = TRACEPARENT_RE.exec(value);
  if (!m) return null;
  const [, version, traceId, parentId, flags, extra] = m;

  // Version ff is reserved and invalid. A version above 00 may carry extra
  // hyphen-separated fields, which this ignores rather than rejects — that is
  // exactly the forward compatibility the spec asks for.
  if (version === "ff") return null;
  if (version === "00" && extra) return null;
  // All-zero ids are the spec's way of spelling "no trace"; continuing one
  // produces a trace nothing can be correlated against.
  if (traceId === NULL_TRACE || parentId === NULL_SPAN) return null;

  return { version, traceId, parentId, flags };
}

export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

export function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * The trace this request belongs to: the caller's if they sent a usable one, a
 * fresh one otherwise.
 *
 * A new span id every time, even when continuing an inbound trace. Echoing the
 * caller's parent-id back would tell their tracer that our work and theirs were
 * the same span, and the duration of one would overwrite the other.
 */
export function traceContext(raw?: string | string[] | null): TraceContext {
  const parsed = parseTraceparent(raw);
  const traceId = parsed?.traceId ?? newTraceId();
  const spanId = newSpanId();
  // Default to sampled when we start the trace: an agent that samples nothing
  // by default produces no traces at all, and this is the one hop that knows
  // money changed hands.
  const flags = parsed?.flags ?? "01";
  return {
    traceId,
    spanId,
    parentSpanId: parsed?.parentId,
    sampled: (parseInt(flags, 16) & 1) === 1,
    inbound: parsed != null,
    traceparent: `00-${traceId}-${spanId}-${flags}`,
  };
}
