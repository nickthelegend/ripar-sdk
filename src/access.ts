import type { NextFunction, Request, RequestHandler, Response } from "express";
import { readPaymentHeader } from "./headers.js";
import { payerFromPaymentHeader } from "./identity.js";

/**
 * Who may call, and who calls free.
 *
 * Both of these sit in front of the payment gate, which is the only position
 * that makes them worth anything: a caller turned away here has not been
 * charged, and a caller waved through here is not asked to pay.
 *
 * A WARNING that applies to both, and to the rate limiter for the same reason.
 * The payer identity comes from `payerFromPaymentHeader`, which decodes the
 * attached transaction WITHOUT verifying its signature — the facilitator does
 * that, later. So the identity is a CLAIM.
 *
 * For a free tier that is merely quota abuse: someone claims to be an address
 * that has calls left, and burns them. Annoying, self-limiting, and it costs
 * nobody money.
 *
 * For an allowlist it is worse, and the asymmetry is the important part. A
 * DENYlist is safe — an attacker claiming to be a denied address only gets
 * themselves refused. An ALLOWlist is not: claiming to be an allowed address
 * gets you past the gate for free. So `allow` refuses to run without an
 * explicit acknowledgement, rather than looking like access control it is not.
 */

export type AccessOptions = {
  /** Addresses that may call at all. Requires `unverifiedAllowlistIsFine`. */
  allow?: string[];
  /** Addresses refused outright. Safe unverified. */
  deny?: string[];
  /**
   * You have read the note above and want a claimed-identity allowlist anyway
   * — usually because the endpoint is behind something that DOES authenticate,
   * and this is a second, cheaper filter rather than the only one.
   */
  unverifiedAllowlistIsFine?: boolean;
};

export function accessGuard(opts: AccessOptions, applies: (path: string) => boolean): RequestHandler {
  if (opts.allow?.length && !opts.unverifiedAllowlistIsFine) {
    throw new Error(
      "access.allow gates on a payer identity read from an UNVERIFIED payment header — anyone can " +
        "claim to be an allowed address and get in free. Use `deny` (safe: a forged identity only " +
        "refuses itself), or pass unverifiedAllowlistIsFine: true if something else already " +
        "authenticates these callers."
    );
  }

  const allow = opts.allow?.length ? new Set(opts.allow) : null;
  const deny = opts.deny?.length ? new Set(opts.deny) : null;

  return (req: Request, res: Response, next: NextFunction) => {
    if (!applies(req.path)) return next();
    const payer = payerFromPaymentHeader(readPaymentHeader((n) => req.header(n)));

    // No payer means an unpaid probe asking the price. Discovery must work for
    // everyone, including someone deciding whether to bother — and a probe
    // cannot reach a handler anyway.
    if (!payer) return next();

    if (deny?.has(payer)) {
      return res.status(403).json({
        error: {
          code: "payer_denied",
          message: "This address is not accepted by this agent.",
        },
      });
    }
    if (allow && !allow.has(payer)) {
      return res.status(403).json({
        error: {
          code: "payer_not_allowed",
          message: "This agent only serves specific addresses.",
        },
      });
    }
    next();
  };
}

export type FreeTierOptions = {
  /** Free calls per payer, ever. Not a rolling window — see below. */
  callsPerPayer: number;
  /** Free calls for a caller with no payment attached at all. Default 0.
   *  Anything above 0 is free to the whole internet, since there is nothing to
   *  key on but an IP. */
  callsPerAnonymous?: number;
};

/**
 * A trial: the first N calls from an address cost nothing.
 *
 * Counted per payer for the lifetime of the process, deliberately not as a
 * rolling window. A window that resets is a permanent free tier for anyone
 * willing to wait, and "free forever if you are patient" is a different product
 * from "free while you evaluate".
 *
 * In memory, so it resets on restart and each replica has its own count. Both
 * are stated rather than hidden: this is a way to let people try an endpoint,
 * not a billing system.
 */
export class FreeTier {
  private readonly used = new Map<string, number>();
  private anonymousUsed = 0;

  constructor(private readonly opts: FreeTierOptions) {}

  /** Would this caller's next call be free? Does not consume anything. */
  peek(payer: string | null): boolean {
    if (!payer) return this.anonymousUsed < (this.opts.callsPerAnonymous ?? 0);
    return (this.used.get(payer) ?? 0) < this.opts.callsPerPayer;
  }

  /** Consume one, if there is one. Returns whether the call is free. */
  take(payer: string | null): boolean {
    if (!this.peek(payer)) return false;
    if (!payer) this.anonymousUsed++;
    else this.used.set(payer, (this.used.get(payer) ?? 0) + 1);
    return true;
  }

  remaining(payer: string | null): number {
    if (!payer) return Math.max(0, (this.opts.callsPerAnonymous ?? 0) - this.anonymousUsed);
    return Math.max(0, this.opts.callsPerPayer - (this.used.get(payer) ?? 0));
  }

  /** Distinct payers who have used any of their allowance. */
  get payers() {
    return this.used.size;
  }
}
