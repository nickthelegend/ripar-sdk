import { RiparError, type AssetPrice, type Price, type PriceContext } from "./types.js";

/** An ASA quote rather than a dollar one. Checked structurally rather than by a
 *  flag, so `price: { amount, asset, decimals }` needs no ceremony to declare. */
export function isAssetPrice(value: unknown): value is AssetPrice {
  return typeof value === "object" && value !== null && "asset" in value && "amount" in value;
}

/** What x402 wants for a non-USD quote: atomic units, an asset id, and enough
 *  in `extra` for a caller to interpret the first from the second. */
export type AssetQuote = {
  asset: string;
  /** Atomic units — `amount` × 10^decimals, computed exactly. */
  amount: string;
  extra: {
    decimals: number;
    /** Always false, and never omitted. See normalizeAssetPrice. */
    usd: false;
    symbol?: string;
  };
};

/**
 * Whole units → atomic units, without touching a float.
 *
 * `1.5 * 10 ** 6` is 1500000.0000000002 on some inputs and the atomic amount in
 * a 402 has to be an integer a facilitator will accept. String arithmetic has
 * no such failure mode, and it also catches the case that matters: more decimal
 * places than the asset has. Rounding "0.0001" down to zero on a two-decimal
 * asset would quote a paid endpoint at nothing, so it is an error instead.
 */
export function toAtomic(amount: string, decimals: number, endpoint: string): string {
  const value = String(amount).trim().replace(/^\$/, "");
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new RiparError(
      `Endpoint "${endpoint}" quoted "${amount}", which is not a positive decimal amount.`,
      "invalid_price",
      500
    );
  }
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) {
    throw new RiparError(
      `Endpoint "${endpoint}" quoted "${amount}" but its asset has ${decimals} decimals — ` +
        `that price cannot be expressed in atomic units without silently rounding it.`,
      "invalid_price",
      500
    );
  }
  const atomic = `${whole}${fraction.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
  if (!/[1-9]/.test(atomic)) {
    throw new RiparError(
      `Endpoint "${endpoint}" quoted "${amount}"; a paid endpoint cannot quote zero.`,
      "invalid_price",
      500
    );
  }
  return atomic;
}

/** Validates an ASA quote and converts it to the shape the 402 carries. */
export function normalizeAssetPrice(raw: AssetPrice, endpoint: string): AssetQuote {
  const asset = String(raw.asset ?? "").trim();
  if (!/^\d+$/.test(asset) || Number(asset) <= 0) {
    throw new RiparError(
      `Endpoint "${endpoint}" priced in asset "${raw.asset}", which is not an Algorand ASA id.`,
      "invalid_price",
      500
    );
  }
  const decimals = Number(raw.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 19) {
    throw new RiparError(
      `Endpoint "${endpoint}" priced in ASA ${asset} without valid decimals. An ASA declares its own ` +
        `decimals and nothing here will guess them — the wrong number misquotes by a power of ten.`,
      "invalid_price",
      500
    );
  }
  return {
    asset,
    amount: toAtomic(raw.amount, decimals, endpoint),
    // `decimals` is published in the 402's `extra` so a caller can turn 1500000
    // back into 1.5. Without it the amount is an unreadable integer and every
    // client has to hardcode a table of assets it has seen before.
    //
    // `usd: false` is published for the opposite reason, and it is the more
    // important of the two. A reader that sees decimals and divides gets 1.5 —
    // and 1.5 of an arbitrary ASA is not $1.50. A client comparing that against
    // a dollar spending cap would wave through a quote worth a hundred times
    // its limit. Saying so in the quote is the only way a caller can tell a
    // dollar-denominated amount from one that merely looks like one; see
    // `decimalsFor` in headers.ts, which refuses to convert when it is here.
    extra: { decimals, usd: false as const, ...(raw.symbol ? { symbol: raw.symbol } : {}) },
  };
}

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

/**
 * Reads a USD number out of a settlement receipt or a quote string.
 *
 * An ASA quote comes back as 0, not as its own amount. "1.5 of ASA 12345" is
 * not 1.5 dollars unless somebody has priced that asset, and summing the two
 * into `ripar_settled_usd_total` would produce a revenue figure nobody can
 * interpret — which is the exact mistake this SDK already avoids by counting
 * the quote rather than the receipt's `amount`.
 */
export function usdOf(value: unknown): number {
  if (isAssetPrice(value)) return 0;
  const n = Number(String(value ?? "").replace("$", ""));
  return Number.isFinite(n) ? n : 0;
}
