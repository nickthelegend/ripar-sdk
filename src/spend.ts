export type SpendEntry = { usd: number; at: number };

/**
 * A rolling 24-hour spend ledger, checked before paying.
 *
 * Rolling rather than calendar-day on purpose: a calendar cap resets at
 * midnight, so an agent stuck in a retry loop drains twice the budget across the
 * boundary and the operator sees two "normal" days. A rolling window has no
 * boundary to exploit.
 *
 * It lives in the client process, so it is a guard rather than a guarantee:
 * restart the agent and the window restarts with it. It is still the difference
 * between a bug that costs a few cents and one that empties a wallet overnight,
 * and it needs no infrastructure to work.
 */
export class SpendLedger {
  private entries: SpendEntry[] = [];

  constructor(readonly limitUsd: number, readonly windowMs = 24 * 60 * 60_000) {}

  /** What has been spent inside the window ending now. */
  spent(now = Date.now()): number {
    this.expire(now);
    return round(this.entries.reduce((sum, e) => sum + e.usd, 0));
  }

  remaining(now = Date.now()): number {
    return round(Math.max(0, this.limitUsd - this.spent(now)));
  }

  /** True when `usd` still fits under the cap. */
  wouldFit(usd: number, now = Date.now()): boolean {
    return this.spent(now) + usd <= this.limitUsd + 1e-9;
  }

  record(usd: number, now = Date.now()) {
    if (!Number.isFinite(usd) || usd <= 0) return;
    this.expire(now);
    this.entries.push({ usd, at: now });
  }

  private expire(now: number) {
    const cutoff = now - this.windowMs;
    if (this.entries.length && this.entries[0].at <= cutoff) {
      this.entries = this.entries.filter((e) => e.at > cutoff);
    }
  }
}

/** Sub-cent amounts accumulate float error fast; six decimals is USDC's own
 *  precision, so rounding there cannot lose a real payment. */
function round(n: number) {
  return Number(n.toFixed(6));
}
