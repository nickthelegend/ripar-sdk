import type { NextFunction, Request, RequestHandler, Response } from "express";
import { payerFromPaymentHeader } from "./identity.js";
import { IdempotencyStore } from "./idempotency.js";
import type { RateLimiter } from "./ratelimit.js";
import { validateInput } from "./validate.js";
import type { EndpointDef } from "./types.js";

/**
 * The three checks that run in front of the payment middleware.
 *
 * They are middleware, and exported as middleware, because their position is
 * the feature: a request they reject has not reached x402 and therefore has not
 * been charged. Mounting them anywhere else — after the gate, or inside a
 * handler — makes each one a refund problem instead of a rejection.
 *
 * `serve()` wires all three. They are separate exports for the case where Ripar
 * endpoints live inside a larger Express app that owns its own middleware order.
 */

/** Which paths a guard applies to. Everything else passes straight through. */
export type Applies = (path: string) => boolean;

export function rateLimitGuard(limiter: RateLimiter, applies: Applies): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!applies(req.path)) return next();

    const payer = payerFromPaymentHeader(req.header("X-PAYMENT"));
    // In payer mode an unpaid probe has nobody to charge the hit to, and cannot
    // reach a handler either — counting it would make asking the price cost the
    // same as calling.
    if (limiter.per === "payer" && !payer) return next();
    const identity = limiter.per === "payer" ? payer! : clientIp(req);

    const verdict = limiter.take(identity);
    res.setHeader("X-RateLimit-Limit", String(limiter.perMinute));
    res.setHeader("X-RateLimit-Remaining", String(verdict.remaining));
    res.setHeader("X-RateLimit-Reset", String(verdict.resetSeconds));
    if (verdict.allowed) return next();

    res.setHeader("Retry-After", String(verdict.retryAfterSeconds));
    res.status(429).json({
      error: {
        code: "rate_limited",
        message: `Over ${limiter.perMinute} calls/minute for this ${limiter.per}. Retry in ${verdict.retryAfterSeconds}s.`,
        retryAfter: verdict.retryAfterSeconds,
      },
    });
  };
}

export function idempotencyGuard(store: IdempotencyStore, applies: Applies): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!applies(req.path)) return next();
    const header = req.header("Idempotency-Key");
    if (!header) return next();

    const identity = payerFromPaymentHeader(req.header("X-PAYMENT")) ?? clientIp(req);
    const key = IdempotencyStore.key(`${req.method} ${req.path}`, identity, header);
    const lookup = store.begin(key, IdempotencyStore.hashBody(req.body ?? {}));

    if (lookup.kind === "replay") {
      res.setHeader("Idempotency-Replayed", "true");
      if (lookup.response.txId) res.setHeader("X-Original-Payment-TxId", lookup.response.txId);
      res.status(lookup.response.status).json(lookup.response.body);
      return;
    }
    if (lookup.kind === "in-progress") {
      // 409 rather than queueing behind the original: holding the socket open
      // would make a slow handler look like a hung one to every retry.
      res.setHeader("Retry-After", "1");
      res.status(409).json({
        error: {
          code: "idempotency_in_progress",
          message: "A request with this Idempotency-Key is still running. Retry shortly.",
        },
      });
      return;
    }
    if (lookup.kind === "conflict") {
      res.status(409).json({
        error: {
          code: "idempotency_key_reuse",
          message: "This Idempotency-Key was already used with a different body. Use a new key.",
        },
      });
      return;
    }

    // Capture what this request answers, so the retry can be served from here
    // instead of from the payment middleware.
    let captured: { status: number; body: unknown } | undefined;
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      captured = { status: res.statusCode, body };
      return json(body);
    };

    let settled = false;
    const commit = () => {
      if (settled) return;
      settled = true;
      if (captured) {
        store.finish(key, { status: captured.status, body: captured.body, txId: txIdOf(res) });
      } else {
        // Nothing was ever written — a dropped socket, not an answer. Releasing
        // the claim lets the caller's retry actually run.
        store.release(key);
      }
    };
    res.on("finish", commit);
    res.on("close", commit);

    next();
  };
}

export function validationGuard(byPath: Map<string, EndpointDef>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const endpoint = byPath.get(req.path);
    if (!endpoint?.input) return next();
    // GET carries no body to validate; its schema documents the query instead.
    if ((endpoint.method ?? "POST") === "GET") return next();

    // No body AND no payment is a price probe, not a call — and price discovery
    // has to work before a caller can build a valid body, because the schema
    // they need travels in the 402 they are asking for. Attach a payment and
    // the same request is validated: nothing can be charged unvalidated, which
    // is the invariant that actually matters.
    if (req.body === undefined && !req.header("X-PAYMENT")) return next();

    const failure = validateInput(endpoint.input, req.body ?? {});
    if (!failure) return next();

    res.status(400).json({
      error: {
        code: "invalid_input",
        message: failure.message,
        field: failure.field,
        // The same schema discovery published, echoed back so a caller that got
        // it wrong can fix the call without a second round trip.
        schema: endpoint.input,
      },
    });
  };
}

/** Behind a proxy the socket address is the proxy's, so every caller would share
 *  one rate-limit bucket. Trust the first hop only — the rest is caller-supplied
 *  and would let anyone mint a fresh identity per request. */
export function clientIp(req: Request): string {
  const forwarded = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim();
  return forwarded || req.socket.remoteAddress || "unknown";
}

function txIdOf(res: Response): string | undefined {
  const raw = res.getHeader("X-Payment-Response");
  if (!raw) return undefined;
  try {
    const p = JSON.parse(String(raw));
    return p.txId ?? p.transaction;
  } catch {
    return undefined;
  }
}
