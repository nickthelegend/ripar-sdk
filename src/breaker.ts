/**
 * A circuit breaker for whatever a handler depends on.
 *
 * The failure this prevents is specific to paid work. When an upstream — a
 * model API, a database, a scraper target — starts failing, every request still
 * runs the full x402 handshake before the handler discovers it. The caller's
 * payment verifies, the handler throws, the 5xx cancels settlement, and nobody
 * is charged. That last part sounds fine, and it is what makes this easy to
 * miss: from the ledger's point of view nothing is wrong. What is actually
 * happening is that the agent is burning facilitator round trips and the
 * caller's latency budget to produce failures, at whatever rate traffic arrives.
 *
 * Opening the circuit converts that into an immediate, cheap 503 with a
 * Retry-After — which costs the caller nothing and tells them when to come back.
 *
 * Half-open is deliberately a single probe. Letting the full flood back in the
 * moment the timer expires is how a recovering upstream gets knocked over
 * again, and the pattern repeats until someone notices.
 */

export type BreakerState = "closed" | "open" | "half-open";

export type BreakerOptions = {
  /** Consecutive failures before opening. Default 5. */
  threshold?: number;
  /** How long to stay open before trying one probe. Default 30s. */
  resetMs?: number;
  /** Treat a call slower than this as a failure. Off unless set — a dependency
   *  that answers eventually can be worse than one that fails fast. */
  timeoutMs?: number;
  /** Which errors count. Default: all of them. Use this to ignore a 404 from
   *  an upstream, which says the request was wrong, not that the dependency is. */
  isFailure?: (err: unknown) => boolean;
  onStateChange?: (from: BreakerState, to: BreakerState, name: string) => void;
};

export class CircuitOpenError extends Error {
  readonly code = "circuit_open";
  constructor(
    readonly name_: string,
    readonly retryAfterMs: number
  ) {
    super(
      `"${name_}" is failing, so this call was refused without running it. ` +
        `Retry in ${Math.ceil(retryAfterMs / 1000)}s.`
    );
    this.name = "CircuitOpenError";
  }
}

export class CircuitBreaker {
  private state: BreakerState = "closed";
  private failures = 0;
  private openedAt = 0;
  /** True while the half-open probe is in flight, so only one gets through. */
  private probing = false;

  private readonly threshold: number;
  private readonly resetMs: number;

  constructor(
    readonly name: string,
    private readonly opts: BreakerOptions = {}
  ) {
    this.threshold = Math.max(1, opts.threshold ?? 5);
    this.resetMs = opts.resetMs ?? 30_000;
  }

  get status(): { state: BreakerState; failures: number; retryAfterMs: number } {
    return {
      state: this.current(),
      failures: this.failures,
      retryAfterMs: this.state === "open" ? Math.max(0, this.resetMs - (Date.now() - this.openedAt)) : 0,
    };
  }

  /** Recomputed rather than stored, so an open circuit becomes half-open on the
   *  next read instead of needing a timer that has to be cleaned up. */
  private current(): BreakerState {
    if (this.state === "open" && Date.now() - this.openedAt >= this.resetMs) return "half-open";
    return this.state;
  }

  private to(next: BreakerState) {
    if (this.state === next) return;
    const from = this.state;
    this.state = next;
    if (next === "open") this.openedAt = Date.now();
    this.opts.onStateChange?.(from, next, this.name);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.current();

    if (state === "open") {
      throw new CircuitOpenError(this.name, this.status.retryAfterMs);
    }
    if (state === "half-open") {
      // One probe at a time. Everything else keeps getting refused until it
      // returns, so a recovering dependency is not immediately re-flooded.
      if (this.probing) throw new CircuitOpenError(this.name, 1_000);
      this.probing = true;
      this.to("half-open");
    }

    try {
      const result = this.opts.timeoutMs ? await withTimeout(fn(), this.opts.timeoutMs, this.name) : await fn();
      this.failures = 0;
      this.to("closed");
      return result;
    } catch (err) {
      if (this.opts.isFailure && !this.opts.isFailure(err)) {
        // Not the dependency's fault. Rethrow without counting it, or a burst
        // of bad requests would open a circuit on a healthy upstream.
        throw err;
      }
      this.failures++;
      // A failed probe re-opens immediately: half-open exists to test one
      // request, and it just failed.
      if (this.state === "half-open" || this.failures >= this.threshold) this.to("open");
      throw err;
    } finally {
      this.probing = false;
    }
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`"${name}" exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
