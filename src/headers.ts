import { USDC_ASSET_ID } from "./types.js";

/**
 * The x402 headers, decoded.
 *
 * Two details bite, and both are silent:
 *
 * 1. `PAYMENT-REQUIRED` and `X-PAYMENT-RESPONSE` carry **base64** JSON, not
 *    JSON. `JSON.parse` on the raw value throws, and code that swallows the
 *    throw reads every quote as "unknown" — which is how a price cap ends up
 *    never firing while looking like it is on.
 * 2. The `amount` inside an `accepts` entry is in the **asset's atomic units**
 *    (102000 for $0.102 of USDC), not USD. Comparing it to a dollar cap is off
 *    by a millionfold in the direction that pays.
 *
 * Everything here fails closed: an amount we cannot interpret comes back as
 * null, and the client refuses to pay rather than guessing.
 */

/** Accepts base64 JSON or bare JSON — servers in the wild send both. */
export function decodeX402Header(raw: string | null | undefined): unknown {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;
  if (value.startsWith("{") || value.startsWith("[")) {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  try {
    return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

const HEADER_NAMES = {
  required: ["PAYMENT-REQUIRED", "payment-required", "X-Payment-Required", "x-payment-required"],
  // PAYMENT-RESPONSE first, because that is what @x402/core actually emits
  // (createSettlementHeaders returns { "PAYMENT-RESPONSE": … }). The X- forms
  // are an older spelling some facilitators still send. These are DIFFERENT
  // header names, not casings of one — Node's case-insensitive lookup does not
  // bridge them, so omitting the un-prefixed form means no receipt is ever
  // read: no settled-USD counter, no txId on a run, no ctx.payment.
  response: [
    "PAYMENT-RESPONSE",
    "payment-response",
    "Payment-Response",
    "X-PAYMENT-RESPONSE",
    "x-payment-response",
    "X-Payment-Response",
  ],
} as const;

/** The 402's requirements, from a fetch Response. */
export function readPaymentRequired(headers: { get(name: string): string | null }): unknown {
  for (const name of HEADER_NAMES.required) {
    const decoded = decodeX402Header(headers.get(name));
    if (decoded) return decoded;
  }
  return null;
}

export type Receipt = {
  txId?: string;
  payer?: string;
  /** Atomic units of `asset`, exactly as the facilitator reported it. */
  amount?: string;
  asset?: string;
  /** The same amount in USD, when the asset's decimals are known. */
  usd?: number;
  success?: boolean;
};

/** The settlement receipt, from a fetch Response or an Express response. */
export function readReceiptHeader(get: (name: string) => string | null | undefined): Receipt | undefined {
  for (const name of HEADER_NAMES.response) {
    const decoded = decodeX402Header(get(name) ?? null) as Record<string, any> | null;
    if (!decoded) continue;
    const asset = decoded.asset != null ? String(decoded.asset) : undefined;
    const amount = decoded.amount != null ? String(decoded.amount) : undefined;
    return {
      txId: decoded.txId ?? decoded.transaction,
      payer: decoded.payer,
      amount,
      asset,
      usd: amount != null ? (atomicToUsd(amount, asset) ?? undefined) : undefined,
      success: decoded.success,
    };
  }
  return undefined;
}

/** USD for one `accepts` entry, or null when it cannot be read safely. */
export function usdOfAccept(accept: unknown): number | null {
  if (!accept || typeof accept !== "object") return null;
  const a = accept as Record<string, any>;

  // A `price` is USD by definition — that is the field the route was configured
  // with, before any asset conversion.
  if (a.price != null) {
    const n = Number(String(a.price).replace("$", ""));
    return Number.isFinite(n) ? n : null;
  }

  const raw = a.maxAmountRequired ?? a.amount;
  if (raw == null) return null;

  // No asset means nobody converted it: it is still USD.
  if (a.asset == null) {
    const n = Number(String(raw).replace("$", ""));
    return Number.isFinite(n) ? n : null;
  }
  return atomicToUsd(String(raw), String(a.asset), a.extra);
}

/**
 * Atomic units → USD, only for assets whose decimals we actually know.
 *
 * Returning null for an unknown asset is deliberate. Assuming six decimals
 * would silently divide by the wrong number, and every wrong answer here is a
 * payment the caller did not intend.
 */
export function atomicToUsd(
  amount: string,
  asset?: string,
  extra?: Record<string, unknown>
): number | null {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;

  const decimals = decimalsFor(asset, extra);
  if (decimals == null) return null;
  return Number((n / 10 ** decimals).toFixed(decimals));
}

function decimalsFor(asset?: string, extra?: Record<string, unknown>): number | null {
  const declared = Number(extra?.["decimals"]);
  if (Number.isInteger(declared) && declared >= 0 && declared <= 18) return declared;
  if (!asset) return null;
  const id = Number(asset);
  // USDC is the only asset this SDK settles in, and its decimals are fixed at 6
  // on both networks.
  if (id === USDC_ASSET_ID.mainnet || id === USDC_ASSET_ID.testnet) return 6;
  return null;
}
