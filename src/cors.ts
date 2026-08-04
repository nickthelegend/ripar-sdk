import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Cross-origin access, with the x402 headers actually exposed.
 *
 * This exists because of a real failure: app.ripar.io fetched a deployed
 * agent's manifest from the browser, the agent sent no CORS header, and the
 * Endpoints view was permanently empty in production while working perfectly
 * on localhost — where same-origin hides the problem. A payment protocol whose
 * discovery step cannot be read by a browser is a protocol nobody can build a
 * dashboard on.
 *
 * Two details matter more than the allowed origin:
 *
 * `exposedHeaders` is the one everybody forgets. A browser lets a page read
 * only a handful of response headers by default, and PAYMENT-REQUIRED and
 * PAYMENT-RESPONSE are not among them. Without exposing them, `fetch` sees a
 * 402 with no quote and a 200 with no receipt — the request "works" and the
 * information is silently gone.
 *
 * `allowedHeaders` has to include PAYMENT-SIGNATURE, or the preflight refuses
 * the retry that carries the payment.
 */

export type CorsOptions = {
  /** Origins allowed. `"*"` for any, an array for a fixed set, or a predicate.
   *  Default `"*"` — an agent's endpoints are public by definition, and the
   *  payment gate is what protects them, not the origin header. */
  origin?: "*" | string[] | ((origin: string) => boolean);
  methods?: string[];
  /** Added to the x402 headers, never replacing them. */
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  /** Seconds a browser may cache the preflight. Default 1 day. */
  maxAge?: number;
  /** Send Access-Control-Allow-Credentials. Requires a concrete origin — the
   *  spec forbids pairing it with `*`, and browsers silently drop the response
   *  rather than telling you. */
  credentials?: boolean;
};

/** The headers a caller must be able to SEND for the x402 handshake to work. */
const REQUEST_HEADERS = [
  "content-type",
  "payment-signature",
  "x-payment",
  "idempotency-key",
  "x-ripar-subscription",
  "authorization",
];

/** The headers a caller must be able to READ, or the handshake is invisible. */
const RESPONSE_HEADERS = [
  "payment-required",
  "payment-response",
  "x-payment-required",
  "x-payment-response",
  "x-ripar-subscription",
  "x-ripar-subscription-expires",
  "x-ripar-subscription-endpoint",
  "x-ripar-subscription-remaining-ms",
  "x-ripar-subscription-status",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "retry-after",
];

function allows(origin: string, rule: CorsOptions["origin"]): boolean {
  if (rule === undefined || rule === "*") return true;
  if (typeof rule === "function") return rule(origin);
  return rule.includes(origin);
}

export function corsGuard(opts: CorsOptions = {}): RequestHandler {
  const methods = opts.methods ?? ["GET", "POST", "OPTIONS"];
  const allowed = [...new Set([...REQUEST_HEADERS, ...(opts.allowedHeaders ?? [])])];
  const exposed = [...new Set([...RESPONSE_HEADERS, ...(opts.exposedHeaders ?? [])])];
  const maxAge = String(opts.maxAge ?? 86_400);

  if (opts.credentials && (opts.origin === undefined || opts.origin === "*")) {
    throw new Error(
      "cors.credentials needs a concrete origin: the spec forbids credentials with `*`, and a browser " +
        "will drop the response rather than report it. Pass an array of origins or a predicate."
    );
  }

  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;

    // No Origin means it is not a browser, so there is nothing to negotiate.
    if (!origin) return next();

    if (!allows(origin, opts.origin)) {
      // Answer without the allow header. The request still runs — refusing it
      // here would break non-browser callers that happen to send an Origin —
      // but the browser will not hand the response to the page.
      return next();
    }

    res.setHeader("Access-Control-Allow-Origin", opts.origin === undefined || opts.origin === "*" ? "*" : origin);
    // Any concrete origin means the answer depends on who asked, so caches
    // must key on it. Without this a CDN can serve one origin's response to
    // another and the failure looks intermittent.
    if (opts.origin !== undefined && opts.origin !== "*") res.setHeader("Vary", "Origin");
    if (opts.credentials) res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Expose-Headers", exposed.join(", "));

    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", methods.join(", "));
      res.setHeader("Access-Control-Allow-Headers", allowed.join(", "));
      res.setHeader("Access-Control-Max-Age", maxAge);
      // 204 and nothing else. A preflight that reaches the payment gate would
      // be quoted a price for a request the browser has not made yet.
      res.status(204).end();
      return;
    }

    next();
  };
}
