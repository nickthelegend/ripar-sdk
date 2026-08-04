import algosdk from "algosdk";

export type Observation = { price: string; decimals: number; source: string };
export type QuotePayload = {
  pair: string;
  price: string;
  decimals: number;
  source: string;
  issuedAt: string;
  expiresAt: string;
};

/**
 * THIS IS SAMPLE DATA. Replace `readPrice` with a real feed.
 *
 * The numbers below are fixed constants, and every response says
 * `"source": "sample"` so nobody downstream can mistake them for market data.
 * An oracle that ships with plausible-looking prices is an oracle somebody
 * settles a contract against.
 */
const SAMPLE: Record<string, Observation> = {
  "ALGO/USD": { price: "0.180000", decimals: 6, source: "sample" },
  "BTC/USD": { price: "60000.000000", decimals: 6, source: "sample" },
  "ETH/USD": { price: "3000.000000", decimals: 6, source: "sample" },
};

export function readPrice(pair: string): Observation {
  const observed = SAMPLE[pair.toUpperCase()];
  if (!observed) {
    // A throw becomes a 5xx, which refunds the caller. Returning a zero price
    // would be worse than useless — it would be a signed zero.
    throw new Error(`No feed for ${pair}. Supported: ${Object.keys(SAMPLE).join(", ")}.`);
  }
  return observed;
}

/**
 * Canonical JSON: sorted keys, no whitespace.
 *
 * Signer and verifier must produce byte-identical input or every signature
 * fails. `JSON.stringify` preserves insertion order, which changes the moment
 * someone reorders a field in the handler — so the order is fixed here instead.
 */
export function canonical(payload: QuotePayload): Uint8Array {
  const sorted = Object.fromEntries(Object.entries(payload).sort(([a], [b]) => (a < b ? -1 : 1)));
  return new TextEncoder().encode(JSON.stringify(sorted));
}

export function signQuote(payload: QuotePayload): string {
  const { sk } = account();
  return Buffer.from(algosdk.signBytes(canonical(payload), sk)).toString("base64");
}

export function signerAddress(): string {
  return String(account().addr);
}

/** Verify a quote against the address it claims to come from. Exported so the
 *  README's example — and your consumers' code — can use the same path. */
export function verifyQuote(payload: QuotePayload, signatureB64: string, signer: string): boolean {
  return algosdk.verifyBytes(canonical(payload), Buffer.from(signatureB64, "base64"), signer);
}

let cached: algosdk.Account | undefined;

/** The signing key is NOT the payout address, and should not be. The payout
 *  address only receives; this one signs on every call, so it lives hotter and
 *  is worth rotating independently. */
function account(): algosdk.Account {
  if (cached) return cached;
  const mnemonic = process.env.ORACLE_MNEMONIC;
  if (!mnemonic) {
    throw new Error("ORACLE_MNEMONIC is not set, so quotes cannot be signed. See .env.example.");
  }
  cached = algosdk.mnemonicToSecretKey(mnemonic.trim());
  return cached;
}
