import { Metrics } from "./metrics.js";
import { RunRecorder } from "./runs.js";
import { IdempotencyStore } from "./idempotency.js";
import { RateLimiter } from "./ratelimit.js";
import type { IdempotencyOptions, RateLimitOptions } from "./types.js";

/**
 * The mutable state one served agent owns: what it is doing right now, what it
 * has done, and whether it is on its way out.
 *
 * It is a single object rather than module globals so two agents in one process
 * — a test suite, or an orchestrator hosting several — cannot read each other's
 * counters or drain each other's requests.
 */
export class Runtime {
  readonly metrics = new Metrics();
  readonly runs: RunRecorder;
  readonly rateLimiter?: RateLimiter;
  readonly idempotency?: IdempotencyStore;

  private inflight = 0;
  private drainingSince: number | null = null;
  private idleWaiters: (() => void)[] = [];

  constructor(opts: {
    runsCapacity?: number;
    rateLimit?: RateLimitOptions;
    idempotency?: IdempotencyOptions;
  } = {}) {
    this.runs = new RunRecorder(opts.runsCapacity ?? 100);
    if (opts.rateLimit) this.rateLimiter = new RateLimiter(opts.rateLimit);
    if (opts.idempotency) this.idempotency = new IdempotencyStore(opts.idempotency);
  }

  enter() {
    this.inflight++;
    this.metrics.enter();
  }

  leave() {
    this.inflight = Math.max(0, this.inflight - 1);
    this.metrics.leave();
    if (this.inflight === 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    }
  }

  get inFlight() {
    return this.inflight;
  }

  get draining() {
    return this.drainingSince != null;
  }

  beginDrain(now = Date.now()) {
    this.drainingSince ??= now;
  }

  /** Resolves the moment nothing is in flight. Resolves immediately if idle. */
  whenIdle(): Promise<void> {
    if (this.inflight === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
}
