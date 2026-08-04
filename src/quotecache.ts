import { createHash } from "node:crypto";

export type QuoteCacheOptions = {
  /** How long a quote may be reused. Default 5s. */
  ttlMs?: number;
  /** Entries kept before the oldest is dropped. Default 500. */
  max?: number;
};

export const DEFAULT_QUOTE_TTL_MS = 5_000;
export const DEFAULT_QUOTE_MAX = 500;

/**
 * A TTL cache for quotes. Off unless the caller asks for it, and short-lived
 * when they do.
 *
 * Quoting is a round trip per call, and an agent that estimates a batch and
 * then executes it asks the same endpoints the same questions twice inside a
 * second. Caching that is free. Caching it for long is not: a price can change
 * between requests — an endpoint may be priced by load, by time of day, or by
 * the size of the body — and `call()` pays what its pre-flight quote said. A
 * quote served past its TTL is therefore an amount nobody verified, which is
 * the one failure this SDK exists to prevent. Hence the default of seconds
 * rather than minutes, and hence the expiry being enforced on READ.
 */
export class QuoteCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();
  readonly ttlMs: number;
  readonly max: number;

  constructor(opts: QuoteCacheOptions = {}) {
    this.ttlMs = opts.ttlMs != null && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_QUOTE_TTL_MS;
    this.max = opts.max != null && opts.max > 0 ? Math.floor(opts.max) : DEFAULT_QUOTE_MAX;
  }

  get(key: string, now = Date.now()): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    // Checked here rather than swept on a timer. A sweep that has not run yet
    // would hand back a stale price, and there is no later checkpoint: the
    // affordability check and the payment both trust this value.
    if (hit.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V, now = Date.now()) {
    // Delete-then-set moves the key to the end of the Map's insertion order,
    // which is what makes the eviction below oldest-first.
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Stored entries, including any that have expired but not yet been read. */
  get size() {
    return this.entries.size;
  }

  clear() {
    this.entries.clear();
  }
}

/**
 * The cache key: method, URL including its query, and a digest of the body.
 *
 * The body is in the key because a dynamic price is a function OF THE BODY —
 * priced by token count, by page count, by how much work was asked for. A cache
 * keyed on the URL alone serves the cheap request's price to the expensive one,
 * and the client then pays an amount it never quoted. The query string stays in
 * the key for the same reason, which is the opposite of the rule subscription
 * keys follow: there, `?page=2` is the same endpoint and must not buy a second
 * window; here it can be a different price.
 *
 * Returns null for a body that cannot be digested without consuming it — a
 * stream can be read once, and reading it here would empty it before the
 * request is sent. Not caching is always safe; guessing is not.
 */
export function quoteKey(
  url: string,
  method: string,
  body: BodyInit | null | undefined
): string | null {
  const digest = bodyDigest(body);
  if (digest == null) return null;
  return `${method.toUpperCase()} ${normalizeUrl(url)} ${digest}`;
}

function bodyDigest(body: BodyInit | null | undefined): string | null {
  if (body == null) return "-";
  if (typeof body === "string") return sha(body);
  if (body instanceof URLSearchParams) return sha(body.toString());
  if (body instanceof ArrayBuffer) return sha(Buffer.from(body));
  if (ArrayBuffer.isView(body)) {
    return sha(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
  }
  return null;
}

function sha(data: string | Buffer) {
  return createHash("sha256").update(data).digest("hex").slice(0, 32);
}

/** Only the fragment is dropped: it is never sent to a server, so two URLs that
 *  differ by it are the same request. */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}
