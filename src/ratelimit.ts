import type { RateLimitOptions } from "./types.js";

export type RateVerdict =
  | { allowed: true; remaining: number; resetSeconds: number }
  | { allowed: false; remaining: 0; retryAfterSeconds: number; resetSeconds: number };

/**
 * A sliding window per caller, kept in the process.
 *
 * Fixed windows let a caller send 2× the limit across a window boundary, which
 * for a paid endpoint means 2× the compute you budgeted for. Keeping the
 * timestamps costs a few bytes per caller and removes that burst entirely.
 *
 * In-process means the limit is per instance: two replicas allow two windows.
 * That is honest and stated rather than hidden — a shared limiter needs Redis,
 * which this SDK deliberately does not require you to run.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  readonly perMinute: number;
  readonly per: "payer" | "ip";

  constructor(opts: RateLimitOptions) {
    this.perMinute = Math.max(1, Math.floor(opts.perMinute));
    this.per = opts.per ?? "payer";
  }

  /** Records the hit and says whether it is allowed. */
  take(identity: string, now = Date.now()): RateVerdict {
    const windowStart = now - 60_000;
    const seen = (this.hits.get(identity) ?? []).filter((t) => t > windowStart);

    if (seen.length >= this.perMinute) {
      this.hits.set(identity, seen);
      const oldest = seen[0];
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + 60_000 - now) / 1000));
      return { allowed: false, remaining: 0, retryAfterSeconds, resetSeconds: retryAfterSeconds };
    }

    seen.push(now);
    this.hits.set(identity, seen);
    this.sweep(windowStart);
    return {
      allowed: true,
      remaining: this.perMinute - seen.length,
      resetSeconds: Math.max(1, Math.ceil((seen[0] + 60_000 - now) / 1000)),
    };
  }

  /** Without this the map grows once per caller forever, which is a slow leak
   *  in exactly the deployments that get popular. */
  private sweep(windowStart: number) {
    if (this.hits.size < 1000) return;
    for (const [key, times] of this.hits) {
      if (times.length === 0 || times[times.length - 1] <= windowStart) this.hits.delete(key);
    }
  }

  get trackedCallers() {
    return this.hits.size;
  }
}
