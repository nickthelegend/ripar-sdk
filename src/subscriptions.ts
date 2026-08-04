import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { RiparError } from "./types.js";

/**
 * Period access on top of a per-request protocol.
 *
 * x402 settles one request at a time; there is no recurring scheme in the spec
 * and no way to pull from a caller's wallet later. So a subscription here is a
 * single settlement that buys a window: pay once, receive a key, call free
 * until it expires. Nothing is ever charged without the caller signing for it,
 * which is the property that makes this safe to hand to an autonomous agent.
 *
 * The key is the bearer of the subscription. We store only its SHA-256, so a
 * heap dump, a log line or a leaked store file yields hashes rather than
 * working credentials.
 */

export type SubscriptionSpec = {
  /** What the window costs, quoted once. "$5.00". */
  price: string;
  /** How long it lasts. "30d", "24h", "90m" — or milliseconds. */
  period: string | number;
};

export type SubscriptionRecord = {
  /** SHA-256 of the key, hex. The key itself is never stored. */
  keyHash: string;
  endpoint: string;
  /** Address that settled, when the receipt carried one. */
  payer?: string;
  /** Settlement that bought the window — the audit trail back to the chain. */
  txId?: string;
  usd: number;
  issuedAt: number;
  expiresAt: number;
};

/**
 * Where issued subscriptions live.
 *
 * The default is in-memory, which is correct for one process and wrong for
 * several: behind two replicas a key minted on A is unknown to B, and the
 * caller is asked to pay twice. Anything backed by shared storage — Redis, a
 * table, a KV namespace — fixes that, and this interface is small enough to
 * implement in a dozen lines. `serve({ subscriptions: { store } })`.
 */
export interface SubscriptionStore {
  get(keyHash: string): Promise<SubscriptionRecord | undefined> | SubscriptionRecord | undefined;
  put(record: SubscriptionRecord): Promise<void> | void;
  /** Drop anything already expired. Called opportunistically, never required. */
  sweep?(now: number): Promise<void> | void;
}

export class MemorySubscriptionStore implements SubscriptionStore {
  private readonly byHash = new Map<string, SubscriptionRecord>();

  get(keyHash: string) {
    return this.byHash.get(keyHash);
  }

  put(record: SubscriptionRecord) {
    this.byHash.set(record.keyHash, record);
  }

  sweep(now: number) {
    for (const [hash, r] of this.byHash) if (r.expiresAt <= now) this.byHash.delete(hash);
  }

  /** Test and introspection helper — counts live records only. */
  get size() {
    const now = Date.now();
    let n = 0;
    for (const r of this.byHash.values()) if (r.expiresAt > now) n++;
    return n;
  }
}

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * "30d" → 2592000000.
 *
 * Rejects rather than guessing: a period that silently parsed to 0 would issue
 * keys that are already expired, and one that silently parsed to NaN would
 * issue keys that never expire. Both are worse than a startup error.
 */
export function parsePeriod(period: string | number, endpoint: string): number {
  if (typeof period === "number") {
    if (!Number.isFinite(period) || period <= 0) {
      throw new RiparError(
        `Endpoint "${endpoint}" has subscription.period ${period}, which is not a positive number of milliseconds.`,
        "invalid_period",
        500
      );
    }
    return Math.floor(period);
  }
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/.exec(String(period).trim());
  if (!m) {
    throw new RiparError(
      `Endpoint "${endpoint}" has subscription.period "${period}". Use a number of milliseconds or a string like "30d", "24h", "90m".`,
      "invalid_period",
      500
    );
  }
  const ms = Number(m[1]) * UNITS[m[2]];
  if (!(ms > 0)) {
    throw new RiparError(
      `Endpoint "${endpoint}" has subscription.period "${period}", which works out to zero time.`,
      "invalid_period",
      500
    );
  }
  return Math.floor(ms);
}

/** 32 bytes of CSPRNG, prefixed so it is recognisable in a log or a bug report. */
export function mintKey(): string {
  return `rsk_${randomBytes(32).toString("base64url")}`;
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Pull the key off a request.
 *
 * Both `Authorization: Bearer rsk_…` and `X-Ripar-Subscription: rsk_…` are
 * accepted — the first is what an HTTP client reaches for, the second leaves
 * Authorization free for whatever else the caller is already sending.
 */
export function readKey(headers: Record<string, string | string[] | undefined>): string | undefined {
  const direct = headers["x-ripar-subscription"];
  const fromDirect = Array.isArray(direct) ? direct[0] : direct;
  if (fromDirect) return fromDirect.trim();

  const auth = headers.authorization;
  const value = Array.isArray(auth) ? auth[0] : auth;
  if (!value) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(value.trim());
  return m ? m[1] : undefined;
}

export type SubscriptionCheck =
  | { active: true; record: SubscriptionRecord; remainingMs: number }
  | { active: false; reason: "none" | "unknown" | "expired" | "wrong_endpoint" };

/**
 * Is this request covered by a paid, unexpired window for this endpoint?
 *
 * A key is scoped to the endpoint that sold it. Letting one endpoint's key open
 * every endpoint would mean the cheapest subscription on the agent buys the
 * dearest one, which is a pricing hole rather than a convenience.
 */
export async function checkSubscription(
  store: SubscriptionStore,
  key: string | undefined,
  endpoint: string,
  now = Date.now()
): Promise<SubscriptionCheck> {
  if (!key) return { active: false, reason: "none" };
  const record = await store.get(hashKey(key));
  if (!record) return { active: false, reason: "unknown" };
  if (record.expiresAt <= now) return { active: false, reason: "expired" };

  // The hash lookup already proved the key; this compares the endpoint the key
  // was sold for, in constant time so a caller cannot probe endpoint names by
  // timing the rejection.
  const a = Buffer.from(record.endpoint);
  const b = Buffer.from(endpoint);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { active: false, reason: "wrong_endpoint" };
  }
  return { active: true, record, remainingMs: record.expiresAt - now };
}

/** Record a settled window and hand back the key exactly once — the caller has
 *  this one chance to keep it, because only the hash is retained. */
export async function issue(
  store: SubscriptionStore,
  args: { endpoint: string; periodMs: number; usd: number; payer?: string; txId?: string; now?: number }
): Promise<{ key: string; record: SubscriptionRecord }> {
  const now = args.now ?? Date.now();
  const key = mintKey();
  const record: SubscriptionRecord = {
    keyHash: hashKey(key),
    endpoint: args.endpoint,
    payer: args.payer,
    txId: args.txId,
    usd: args.usd,
    issuedAt: now,
    expiresAt: now + args.periodMs,
  };
  await store.put(record);
  await store.sweep?.(now);
  return { key, record };
}

/** What goes on the response when a window is bought or spent. Kept flat and
 *  header-safe so a caller can read it without parsing a body. */
export function subscriptionHeaders(record: SubscriptionRecord, key?: string) {
  const headers: Record<string, string> = {
    "x-ripar-subscription-expires": new Date(record.expiresAt).toISOString(),
    "x-ripar-subscription-endpoint": record.endpoint,
  };
  if (key) headers["x-ripar-subscription"] = key;
  return headers;
}
