import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CAIP2, RiparError, type Network } from "./types.js";

/**
 * Check the payee before paying it — opt-in, and never free.
 *
 * A 402 names a `payTo`, and the wrapped fetch signs a transfer to whatever it
 * names. For an endpoint the caller has used before that is fine; for one an
 * agent found five minutes ago, the address is a string nobody has looked at.
 * Ripar's payee-check endpoint answers the questions worth asking first — does
 * the account exist, can it receive USDC at all, has it actually been paid over
 * x402, is it Bazaar-listed — from chain data rather than from a score.
 *
 * It costs $0.01 per check, settled through the same x402 path as any other
 * call, which is why it is OFF unless asked for and why a verdict is cached for
 * 24h per network+address: an agent calling one endpoint a thousand times a day
 * should pay for one check, not a thousand.
 *
 * What it refuses, and why only that: `exists: false` and
 * `canReceiveUsdc: false` are both payments that cannot land — an account that
 * is not there, or one not opted in to the asset — and `requireListed` is the
 * caller's own stricter policy. Everything else in the answer is a FACT for the
 * caller to weigh; turning "has only been paid twice" into a refusal would be a
 * judgement this SDK has no business making on anyone's behalf.
 */

export const DEFAULT_PAYEE_CHECK_URL = "https://api.ripar.io/api/payee-check";
export const PAYEE_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

export type CheckPayeeOptions = {
  /** Refuse a payee that is not listed in the x402 Bazaar. Off by default:
   *  plenty of legitimate endpoints are unlisted. */
  requireListed?: boolean;
  /** What to do when the check itself could not run — network error, 5xx, an
   *  answer that does not parse. Default "abort": the caller asked for the
   *  check, and paying anyway would be doing the opposite quietly. "proceed"
   *  pays, and says so on the result. */
  onCheckError?: "abort" | "proceed";
  /** Defaults to RIPAR_PAYEE_CHECK_URL, then api.ripar.io. */
  url?: string;
  /** Where verdicts are cached. Defaults to RIPAR_PAYEE_CACHE, then
   *  ~/.ripar/payee-cache.json. `false` keeps the cache in memory only. */
  cachePath?: string | false;
  /** How long a verdict is reused. Default 24h. */
  ttlMs?: number;
};

export type PayeeCheckResult = {
  address: string;
  network: string;
  checkedAt?: string;
  exists: boolean;
  canReceiveUsdc: boolean;
  usdcBalance?: unknown;
  firstFunded?: unknown;
  received?: {
    transfers?: number;
    x402?: number;
    usdc?: unknown;
    sampled?: unknown;
    capped?: boolean;
  };
  bazaar?: { resources?: number; urls?: string[] } | null;
  ripar?: { agentId?: number; registry?: unknown } | null;
  facts: string[];
};

/** What `call()` decided about the payee, returned on the result. */
export type PayeeVerdict = {
  address: string;
  network: Network;
  /** True when the call was allowed to pay this address. */
  ok: boolean;
  /** `check` paid for a fresh answer; `cache` reused one; `unchecked` means
   *  the check failed and `onCheckError: "proceed"` paid anyway. */
  source: "check" | "cache" | "unchecked";
  facts: string[];
  /** Why the payee was refused, or why it went unchecked. */
  reason?: string;
  result?: PayeeCheckResult;
};

export type ResolvedPayeeCheck = {
  requireListed: boolean;
  onCheckError: "abort" | "proceed";
  url: string;
  cachePath: string | null;
  ttlMs: number;
};

/** `checkPayee: true` and `checkPayee: {}` mean the same thing; anything falsy
 *  means the feature is off and costs nothing. */
export function resolveCheckPayee(
  opt: boolean | CheckPayeeOptions | undefined,
  env: Record<string, string | undefined> = process.env
): ResolvedPayeeCheck | null {
  if (!opt) return null;
  const o = opt === true ? {} : opt;
  return {
    requireListed: o.requireListed === true,
    onCheckError: o.onCheckError === "proceed" ? "proceed" : "abort",
    url: o.url ?? env.RIPAR_PAYEE_CHECK_URL ?? DEFAULT_PAYEE_CHECK_URL,
    cachePath: o.cachePath === false ? null : (o.cachePath ?? env.RIPAR_PAYEE_CACHE ?? defaultPayeeCachePath()),
    ttlMs: o.ttlMs != null && o.ttlMs > 0 ? o.ttlMs : PAYEE_CACHE_TTL_MS,
  };
}

export function defaultPayeeCachePath(): string {
  return join(homedir(), ".ripar", "payee-cache.json");
}

/**
 * The refusal rule, and nothing else. Kept pure so the decision can be tested
 * without a wallet, a cache or a network.
 */
export function judgePayee(
  result: PayeeCheckResult,
  opts: { requireListed?: boolean } = {}
): { ok: true } | { ok: false; reason: string } {
  if (result.exists === false) {
    return { ok: false, reason: `${result.address} does not exist on ${result.network} — a payment to it cannot land` };
  }
  if (result.canReceiveUsdc === false) {
    return {
      ok: false,
      reason: `${result.address} cannot receive USDC on ${result.network} (not opted in to the asset) — the payment would fail`,
    };
  }
  if (opts.requireListed && !(result.bazaar && (result.bazaar.resources ?? result.bazaar.urls?.length ?? 0) > 0)) {
    return { ok: false, reason: `${result.address} is not listed in the x402 Bazaar, and requireListed is set` };
  }
  return { ok: true };
}

/**
 * Read a payee-check answer, failing loudly on anything that is not one.
 *
 * `exists` and `canReceiveUsdc` must be real booleans. An answer missing them —
 * an HTML error page with a 200, a proxy's JSON — would otherwise pass the
 * `=== false` tests above and approve the payee on the strength of nothing.
 */
export function parsePayeeCheck(data: unknown): PayeeCheckResult {
  const d = data as Partial<PayeeCheckResult> | null;
  if (!d || typeof d !== "object" || typeof d.exists !== "boolean" || typeof d.canReceiveUsdc !== "boolean") {
    throw new RiparError(
      "The payee check answered, but not with a verdict: `exists` and `canReceiveUsdc` were missing.",
      "payee_check_unreadable",
      undefined,
      data
    );
  }
  return { ...d, facts: Array.isArray(d.facts) ? d.facts.map(String) : [] } as PayeeCheckResult;
}

/**
 * Which network an `accepts` entry pays on. The payee is checked on the chain
 * the money will actually move on, not on the one the client was configured
 * with — a mainnet client handed a testnet challenge would otherwise check the
 * wrong account history entirely. Prefix match, because facilitators quote the
 * full genesis hash and CAIP-2 truncates it.
 */
export function networkOfAccept(network: unknown, fallback: Network): Network {
  const id = String(network ?? "");
  for (const n of ["mainnet", "testnet"] as const) {
    if (id.startsWith(CAIP2[n])) return n;
  }
  return fallback;
}

/** Same endpoint, ignoring query, hash and a trailing slash. This is what stops
 *  the check checking its own payee, forever. */
export function isPayeeCheckUrl(url: string, checkUrl: string): boolean {
  return canonicalUrl(url) === canonicalUrl(checkUrl);
}

function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return url;
  }
}

type CacheEntry = { checkedAt: number; result: PayeeCheckResult };

/**
 * Verdicts by network+address, on disk so a new process does not pay again.
 *
 * Every failure here is swallowed on purpose. A cache is an optimisation: a
 * missing file, a corrupt one, or a read-only home directory must cost at most
 * one more $0.01 check, never a failed call. The payee check itself still runs
 * — the only thing lost is the reuse.
 *
 * The raw RESULT is stored, not the verdict, so a cached answer is re-judged
 * under the options of the call that finds it: a payee cached by a call without
 * `requireListed` is still refused by one with it.
 */
export class PayeeCache {
  private readonly memory = new Map<string, CacheEntry>();

  constructor(
    private readonly path: string | null,
    readonly ttlMs = PAYEE_CACHE_TTL_MS
  ) {}

  get(network: Network, address: string, now = Date.now()): CacheEntry | undefined {
    const key = cacheKey(network, address);
    const entry = this.memory.get(key) ?? this.readDisk()[key];
    if (!entry || typeof entry.checkedAt !== "number" || !entry.result) return undefined;
    // Enforced on read, like the quote cache: a verdict past its TTL is one
    // nobody verified today.
    if (now - entry.checkedAt >= this.ttlMs || entry.checkedAt > now) return undefined;
    return entry;
  }

  set(network: Network, address: string, result: PayeeCheckResult, now = Date.now()) {
    const key = cacheKey(network, address);
    const entry = { checkedAt: now, result };
    this.memory.set(key, entry);
    if (!this.path) return;
    try {
      const all = this.readDisk();
      // Expired entries are dropped on write so the file cannot grow forever.
      for (const [k, v] of Object.entries(all)) {
        if (!v || typeof v.checkedAt !== "number" || now - v.checkedAt >= this.ttlMs) delete all[k];
      }
      all[key] = entry;
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      // Write-then-rename, so two processes racing never leave half a file.
      const tmp = `${this.path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch {
      /* unwritable: the in-memory copy still spares this process a second check */
    }
  }

  private readDisk(): Record<string, CacheEntry> {
    if (!this.path) return {};
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
}

function cacheKey(network: Network, address: string) {
  return `${network}:${address}`;
}

/** The facts, as lines a CLI or a log can print. */
export function formatPayeeVerdict(v: PayeeVerdict): string[] {
  const head =
    v.source === "unchecked"
      ? `payee ${v.address} (${v.network}) NOT checked — ${v.reason ?? "the check failed"}; paying anyway (onCheckError: proceed)`
      : `payee ${v.address} (${v.network}) ${v.ok ? "ok" : "REFUSED"} · ${v.source === "cache" ? "cached check" : "checked, $0.01"}`;
  return [head, ...v.facts.map((f) => `  - ${f}`)];
}
