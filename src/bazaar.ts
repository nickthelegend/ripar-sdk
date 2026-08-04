import { DEFAULT_FACILITATOR } from "./types.js";

/**
 * The x402 Bazaar: the discovery index a caller browses to find paid endpoints.
 *
 * How an agent gets listed is the part worth understanding, because it is not
 * what this file used to claim. There is no registration call. `serve()`
 * attaches a Bazaar discovery extension to every listed route, and the
 * facilitator catalogues the resource while verifying a payment for it. So an
 * endpoint becomes discoverable by being **paid for**, not by announcing
 * itself — the same rule the ReputationRegistry enforces, and the reason the
 * index is worth reading: everything in it has taken real money.
 *
 * This file previously exported `registerWithBazaar()`, which POSTed a
 * manifest to `<facilitator>/bazaar/register`. That endpoint does not exist
 * and returns 404. Because the function swallowed every failure by design, it
 * reported a plausible `{ ok: false }` and nothing ever surfaced — an agent
 * that believed it was listed, forever.
 */

export const DISCOVERY_URL = `${DEFAULT_FACILITATOR}/discovery/resources`;

export type BazaarOptions = {
  /** Override the index. Defaults to the facilitator's. */
  discoveryUrl?: string;
  /** Abandon the round trip after this long. Default 5s. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type BazaarResource = {
  id: string;
  resourceUrl: string;
  method: string;
  description?: string;
  mimeType?: string;
  /** What it costs, in the shape the 402 would quote. */
  accepts?: unknown[];
  /** Everything else the index returned, unmodified. */
  raw: Record<string, unknown>;
};

export type BazaarListing =
  | { ok: true; resources: BazaarResource[]; discoveryUrl: string }
  | { ok: false; status?: number; discoveryUrl: string; error: string };

/**
 * Read the discovery index.
 *
 * Never throws. Discovery is a nice-to-have — being able to browse brings
 * options, failing to browse costs reach and nothing else — so a caller can
 * log the failure and carry on with an endpoint it already knows.
 */
export async function listBazaar(
  opts: BazaarOptions & { limit?: number } = {}
): Promise<BazaarListing> {
  const base = opts.discoveryUrl ?? DISCOVERY_URL;
  const discoveryUrl = opts.limit ? `${base}?limit=${opts.limit}` : base;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;

  try {
    const res = await withTimeout(
      (signal) => doFetch(discoveryUrl, { headers: { accept: "application/json" }, signal }),
      opts.timeoutMs ?? 5_000
    );
    if (!res.ok) {
      return { ok: false, status: res.status, discoveryUrl, error: `index returned ${res.status}` };
    }
    const body = (await res.json()) as { items?: Record<string, unknown>[] };
    const items = Array.isArray(body.items) ? body.items : [];
    return {
      ok: true,
      discoveryUrl,
      resources: items.map((r) => ({
        id: String(r.id ?? ""),
        resourceUrl: String(r.resourceUrl ?? ""),
        method: String(r.method ?? "GET"),
        description: r.description != null ? String(r.description) : undefined,
        mimeType: r.mimeType != null ? String(r.mimeType) : undefined,
        accepts: Array.isArray(r.accepts) ? r.accepts : undefined,
        raw: r,
      })),
    };
  } catch (err) {
    return { ok: false, discoveryUrl, error: (err as Error).message || "could not read the index" };
  }
}

/**
 * Find endpoints whose description or URL matches a term.
 *
 * Filtered here rather than by the facilitator: the index has no search route
 * (`/discovery/search` is a 404), so this reads a page and matches locally.
 * That means it only sees what `limit` fetched — stated because a caller who
 * assumed server-side search would read an empty result as "nothing exists".
 */
export async function findInBazaar(
  term: string,
  opts: BazaarOptions & { limit?: number } = {}
): Promise<BazaarListing> {
  const listing = await listBazaar({ limit: 100, ...opts });
  if (!listing.ok) return listing;
  const q = term.trim().toLowerCase();
  if (!q) return listing;
  return {
    ...listing,
    resources: listing.resources.filter(
      (r) =>
        r.description?.toLowerCase().includes(q) || r.resourceUrl.toLowerCase().includes(q)
    ),
  };
}

/** AbortSignal.timeout would do, but passing our own signal keeps the timeout
 *  testable with an injected fetch that ignores the clock. */
async function withTimeout(run: (signal: AbortSignal) => Promise<Response>, ms: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${ms}ms`)), ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
