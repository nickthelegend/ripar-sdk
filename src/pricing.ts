import { RiparError, type Price, type PriceContext } from "./types.js";

/** "$0.01" — the form the x402 `accepts` block takes. */
export function normalizePrice(raw: unknown, endpoint: string): string {
  const value = String(raw ?? "").trim();
  if (!/^\$?\d+(\.\d+)?$/.test(value)) {
    throw new RiparError(
      `Endpoint "${endpoint}" priced this request at "${value}", which is not a USD amount like "$0.01".`,
      "invalid_price",
      500
    );
  }
  const n = Number(value.replace("$", ""));
  if (!(n > 0)) {
    throw new RiparError(
      `Endpoint "${endpoint}" priced this request at "${value}"; a paid endpoint cannot quote zero.`,
      "invalid_price",
      500
    );
  }
  return value.startsWith("$") ? value : `$${value}`;
}

/**
 * Resolves a price for one request.
 *
 * A price function runs before the 402 is written, so whatever it returns is the
 * number the caller is asked to sign for. Two consequences worth stating:
 * it must be cheap — every unpaid probe pays its cost — and it must be
 * deterministic for a given body, because the caller quotes, signs, and sends
 * again, and a price that moved between those two requests rejects a payment
 * the caller built in good faith.
 *
 * A throw becomes a 500 rather than a free call: failing open would hand out
 * the endpoint for nothing.
 */
export async function resolvePrice<B>(
  price: Price<B>,
  endpoint: string,
  ctx: PriceContext<B>
): Promise<string> {
  if (typeof price !== "function") return normalizePrice(price, endpoint);
  const quoted = await price(ctx);
  return normalizePrice(quoted, endpoint);
}

/** Reads a USD number out of a settlement receipt or a quote string. */
export function usdOf(value: unknown): number {
  const n = Number(String(value ?? "").replace("$", ""));
  return Number.isFinite(n) ? n : 0;
}
