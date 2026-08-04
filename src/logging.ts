/**
 * One JSON object per line, on stdout.
 *
 * An agent that takes money should be greppable after the fact: "which calls
 * settled between 14:00 and 15:00, and what did each one cost" has to be
 * answerable from the logs alone, because the run buffer is capped and in
 * memory and the metrics endpoint only carries counters.
 *
 * Two rules, both about not leaking:
 *
 * Request and response BODIES are never logged. A paid endpoint's payload is
 * the customer's data — the thing they paid to have processed — and an agent
 * that quietly writes it to stdout has turned every log shipper into a copy of
 * it. What gets logged is shape: endpoint, status, duration, what settled.
 *
 * The payment header is never logged either, even truncated. It carries a
 * signed transaction, and a signed transaction is submittable by anyone
 * holding it.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogRecord = {
  level: LogLevel;
  msg: string;
  at: string;
  [key: string]: unknown;
};

export type LoggerOptions = {
  /** Below this is dropped. Default "info". */
  level?: LogLevel;
  /** Added to every line — service name, version, region. */
  base?: Record<string, unknown>;
  /** Where a line goes. Default `console.log`. Swap it for a shipper, or for a
   *  collector in tests. */
  write?: (line: string) => void;
  /** Pretty-print instead of one line. For a terminal, never for production:
   *  a multi-line record is one a log aggregator cannot parse. */
  pretty?: boolean;
};

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Header names that must never reach a log line, whatever the caller passes. */
const REDACT = new Set([
  "payment-signature",
  "x-payment",
  "authorization",
  "cookie",
  "x-ripar-subscription",
  "proxy-authorization",
]);

/** Replace the value of anything that looks like a credential, at any depth.
 *  Deliberately by KEY rather than by pattern: a value-shaped heuristic misses
 *  the first credential that does not look like one. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT.has(k.toLowerCase()) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

export class Logger {
  private readonly min: number;
  private readonly base: Record<string, unknown>;
  private readonly write: (line: string) => void;
  private readonly pretty: boolean;
  /** Kept so `child()` can build a real Logger rather than clone this one —
   *  see the note there for why cloning silently loses the child's fields. */
  private readonly opts: LoggerOptions;

  constructor(opts: LoggerOptions = {}) {
    this.opts = opts;
    this.min = ORDER[opts.level ?? "info"];
    this.base = opts.base ?? {};
    this.write = opts.write ?? ((line) => console.log(line));
    this.pretty = opts.pretty ?? false;
  }

  private emit(level: LogLevel, msg: string, fields?: Record<string, unknown>) {
    if (ORDER[level] < this.min) return;
    const record: LogRecord = {
      level,
      msg,
      at: new Date().toISOString(),
      ...this.base,
      ...(redact(fields ?? {}) as Record<string, unknown>),
    };
    this.write(this.pretty ? JSON.stringify(record, null, 2) : JSON.stringify(record));
  }

  debug = (msg: string, fields?: Record<string, unknown>) => this.emit("debug", msg, fields);
  info = (msg: string, fields?: Record<string, unknown>) => this.emit("info", msg, fields);
  warn = (msg: string, fields?: Record<string, unknown>) => this.emit("warn", msg, fields);
  error = (msg: string, fields?: Record<string, unknown>) => this.emit("error", msg, fields);

  /**
   * A child that carries extra fields — one per request, so every line from
   * that request can be pulled out with one grep.
   *
   * Constructs a real Logger rather than cloning this one. The level methods
   * are class fields, so they are arrow functions that captured `this` at
   * construction: copying them onto a new object leaves them bound to the
   * PARENT, and every child field is silently dropped while the call looks
   * like it worked.
   */
  child(fields: Record<string, unknown>): Logger {
    return new Logger({
      ...this.opts,
      base: { ...this.base, ...(redact(fields) as Record<string, unknown>) },
    });
  }
}

/** The line written when a paid request finishes. Deliberately flat: nested
 *  objects are what make a log store refuse to index a field. */
export function requestLine(args: {
  endpoint: string;
  method: string;
  status: number;
  ms: number;
  settled: boolean;
  usd?: number;
  txId?: string;
  payer?: string;
  requestId?: string;
}): Record<string, unknown> {
  return {
    endpoint: args.endpoint,
    method: args.method,
    status: args.status,
    ms: Math.round(args.ms),
    settled: args.settled,
    ...(args.usd != null ? { usd: args.usd } : {}),
    ...(args.txId ? { txId: args.txId } : {}),
    // The payer is a public Algorand address, so it is safe to log and it is
    // the only field that makes per-caller debugging possible.
    ...(args.payer ? { payer: args.payer } : {}),
    ...(args.requestId ? { requestId: args.requestId } : {}),
  };
}
