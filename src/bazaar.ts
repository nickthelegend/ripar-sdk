import { DEFAULT_FACILITATOR } from "./types.js";

export const DEFAULT_BAZAAR_URL = `${DEFAULT_FACILITATOR}/bazaar/register`;

export type BazaarOptions = {
  /** Where to POST. Defaults to the facilitator's bazaar index. */
  bazaarUrl?: string;
  /** Abandon the round trip after this long. Default 5s. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type BazaarResult =
  | { ok: true; status: number; bazaarUrl: string }
  | { ok: false; status?: number; bazaarUrl: string; error: string };

/**
 * Announces an agent to a discovery index.
 *
 * Never throws, and that is the entire design. Discovery is a nice-to-have:
 * being listed brings callers, not being listed costs nothing but reach. An
 * agent that crashed on boot because a registry was down would take a working,
 * paid endpoint offline over a directory entry — so every failure here comes
 * back as a value the caller can log and ignore.
 *
 * It fetches the manifest from its public URL rather than accepting an object,
 * which proves the URL it is registering actually resolves before advertising
 * it to strangers.
 */
export async function registerWithBazaar(
  manifestUrl: string,
  opts: BazaarOptions = {}
): Promise<BazaarResult> {
  const bazaarUrl = opts.bazaarUrl ?? DEFAULT_BAZAAR_URL;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;

  try {
    const manifest = await withTimeout(
      (signal) => doFetch(manifestUrl, { headers: { accept: "application/json" }, signal }),
      timeoutMs
    );
    if (!manifest.ok) {
      return {
        ok: false,
        status: manifest.status,
        bazaarUrl,
        error: `manifest at ${manifestUrl} returned ${manifest.status}`,
      };
    }
    const body = await manifest.json();

    const res = await withTimeout(
      (signal) =>
        doFetch(bazaarUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ manifestUrl, manifest: body }),
          signal,
        }),
      timeoutMs
    );

    if (!res.ok) {
      return { ok: false, status: res.status, bazaarUrl, error: `bazaar returned ${res.status}` };
    }
    return { ok: true, status: res.status, bazaarUrl };
  } catch (err) {
    return { ok: false, bazaarUrl, error: (err as Error).message || "registration failed" };
  }
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
