import { randomUUID } from "node:crypto";
import algosdk from "algosdk";
import { atomicToUsd } from "./headers.js";
import { DEFAULT_ALGOD, RiparError, type Network } from "./types.js";

/**
 * The client-side pieces that keep an autonomous caller honest with somebody
 * else's server and somebody else's money.
 *
 * Kept out of client.ts because each one is a policy with its own reasoning —
 * when to come back after a refusal, how to make a retry free, whose word to
 * take on an agent's history, when a price has moved, and whether a manifest was
 * really signed by the address it names. client.ts wires them; the arguments for
 * them live here.
 */

/* ── 1. Retry-After ─────────────────────────────────────────────────────── */

/**
 * The longest wait this client will sit through on a server's say-so.
 *
 * A minute, because past that the request has almost certainly outlived whatever
 * the caller wanted it for, and an agent asleep for an hour inside `call()` is
 * indistinguishable from a hung one.
 */
export const DEFAULT_RETRY_AFTER_CAP_MS = 60_000;

export type RetryAfterAdvice =
  /** No header, or one that could not be read. Back off normally. */
  | { kind: "none" }
  | { kind: "wait"; ms: number; raw: string; source: "seconds" | "date" }
  /** Longer than this client is willing to wait. Deliberately NOT clamped to
   *  the cap — see readRetryAfter. */
  | { kind: "too-long"; ms: number; capMs: number; raw: string; source: "seconds" | "date" };

/**
 * What the server said about coming back, and whether we can honour it.
 *
 * The bug this closes is quiet and expensive: a 429 or a 503 carrying
 * `Retry-After: 30` met a client whose own backoff was 250ms, so the agent hit
 * a server that had just asked for half a minute of quiet a hundred and twenty
 * times inside that window. Retrying through a rate limit is how a client
 * becomes the outage it is retrying through, and how its address gets banned.
 *
 * A wait longer than the cap does NOT become a wait of exactly the cap. Clamping
 * would mean coming back before the server said it would be ready, which is the
 * same disrespect with extra arithmetic; the honest answer is to stop retrying
 * and say the number the server asked for and the number we would accept.
 */
export function readRetryAfter(
  get: (name: string) => string | null | undefined,
  opts: { capMs?: number; now?: number } = {}
): RetryAfterAdvice {
  const raw = (get("retry-after") ?? get("Retry-After") ?? "").trim();
  if (!raw) return { kind: "none" };

  const capMs = opts.capMs ?? DEFAULT_RETRY_AFTER_CAP_MS;
  const parsed = parseRetryAfter(raw, opts.now ?? Date.now());
  if (parsed == null) return { kind: "none" };

  const { ms, source } = parsed;
  if (ms > capMs) return { kind: "too-long", ms, capMs, raw, source };
  return { kind: "wait", ms, raw, source };
}

/**
 * `Retry-After` in either of its two RFC 9110 forms.
 *
 * A bare number is DELTA-SECONDS, not milliseconds and not a timestamp — the
 * millisecond reading turns "come back in 30 seconds" into 30ms, which is worse
 * than ignoring the header. Anything else is an HTTP-date, and a date already in
 * the past means "now", not a negative wait.
 */
export function parseRetryAfter(
  raw: string,
  now = Date.now()
): { ms: number; source: "seconds" | "date" } | null {
  const value = raw.trim();
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isFinite(seconds) ? { ms: seconds * 1_000, source: "seconds" } : null;
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return { ms: Math.max(0, at - now), source: "date" };
}

/* ── 2. client-side idempotency ─────────────────────────────────────────── */

/**
 * The header name the server reads, spelled exactly as idempotency.ts and
 * guards.ts expect it.
 *
 * Express matches headers case-insensitively so the casing is cosmetic, but the
 * NAME is not: `X-Idempotency-Key` — the spelling half the internet uses — is a
 * different header, sails past `req.header("Idempotency-Key")`, and the retry it
 * was meant to protect settles a second time in silence.
 */
export const IDEMPOTENCY_HEADER = "Idempotency-Key";

/**
 * One key per logical call.
 *
 * The server scopes it by route and by payer and refuses the same key with a
 * different body (idempotency.ts), so the only thing the client has to get right
 * is the lifetime: identical across every attempt of ONE call, and never shared
 * between two. A key reused across calls with different bodies is a 409; reused
 * with the SAME body it is worse — the second call is answered with the first
 * call's stale result, and the caller pays nothing and learns nothing.
 *
 * Prefixed so a server operator reading their logs can tell an SDK-generated key
 * from one their own caller chose.
 */
export function newIdempotencyKey(): string {
  return `ripar-${randomUUID()}`;
}

/**
 * Read one header out of whatever shape a caller passed.
 *
 * `HeadersInit` is three types, and the record form is the one that carries the
 * caller's own casing. Missing a caller-supplied `idempotency-key` because we
 * only looked for `Idempotency-Key` would mean generating a second key for the
 * same logical call — two claims on the server, and the replay guarantee gone.
 */
export function headerValue(headers: HeadersInit | undefined, name: string): string | undefined {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headerRecord(headers))) {
    if (k.toLowerCase() === want) return v;
  }
  return undefined;
}

/**
 * Any `HeadersInit` as a plain record, so it can be MERGED.
 *
 * Spreading a `Headers` instance into an object literal yields `{}` — its
 * entries are not own enumerable properties — so `{ ...defaults,
 * ...init.headers }` silently drops every header a caller passed that way. The
 * request still goes out, still pays, and arrives without the authorization or
 * idempotency key it was supposed to carry.
 */
export function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    headers.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  const pairs: [string, string][] = Array.isArray(headers)
    ? (headers as [string, string][])
    : (Object.entries(headers as Record<string, string>) as [string, string][]);
  for (const [k, v] of pairs) out[String(k)] = String(v);
  return out;
}

/* ── 3. reputation-weighted selection ───────────────────────────────────── */

/** The deployed ReputationRegistry. Zero on MainNet because nothing is deployed
 *  there — a guessed id would read a stranger's app and rank on their numbers. */
export const REPUTATION_APP: Record<Network, number> = { testnet: 768_572_969, mainnet: 0 };

/** BoxMap(UInt64, Score, key_prefix=b"sc_"). */
export const SCORE_BOX_PREFIX = "sc_";

export type AgentScore = {
  agentId: number;
  /** Settlements this agent has been credited with. Each one required a real
   *  transfer from a registered client address to this agent's. */
  jobsPaid: number;
  /** Base units of the registry's asset (USDC, 6 decimals). */
  volumeMicro: number;
  /** volumeMicro as USD. */
  volumeUsd: number;
  /** Verdicts written by a named validator through the ValidationRegistry. */
  validated: number;
  disputed: number;
  /** ISO 8601, from the chain's own clock. */
  firstAt: string;
  lastAt: string;
};

export type AgentCandidate = number | { agentId: number; url?: string; [k: string]: unknown };

export type RankedAgent = {
  agentId: number;
  url?: string;
  /** Null when the agent has no score box: nobody has ever paid it here. */
  score: AgentScore | null;
  candidate: AgentCandidate;
  /** Why it was rejected, or what qualifies it. */
  reason?: string;
};

export type AgentRanking = {
  /** Best first. Empty when every candidate was rejected. */
  ranked: RankedAgent[];
  rejected: RankedAgent[];
  best: RankedAgent | null;
  /** What the order actually measures, in one sentence, so nobody mistakes it
   *  for a quality score. */
  basis: string;
};

export type PickAgentOptions = {
  /** Minimum settlements. */
  minJobsPaid?: number;
  /** Minimum lifetime volume in USD — dollars, not base units. The registry
   *  stores micro-USDC, and comparing a dollar threshold to that number
   *  straight is the millionfold error that lets anything through. */
  minVolume?: number;
  /** Reject an agent with more than this many disputed verdicts. Off by
   *  default: see `basis`. */
  maxDisputed?: number;
  network?: Network;
  appId?: number;
  algodUrl?: string;
  algodToken?: string;
  fetchImpl?: typeof fetch;
};

/**
 * Rank agents by what the ReputationRegistry says, and say what that is.
 *
 * It ranks MONEY THAT MOVED. `jobs_paid` and `volume_micro` are incremented by
 * `accept_feedback`, which takes the settling transfer as a transaction in its
 * own group and resolves both ends through the IdentityRegistry — so a credit
 * cannot be minted without a real payment from a registered client address to
 * this agent's. That makes the number unforgeable and narrow: nobody looked at
 * the work. A patient, well-funded fraud outranks a careful newcomer here, and
 * an agent's first job is always its worst-ranked.
 *
 * `validated` and `disputed` are verdicts rather than payments, so they are
 * reported and do not move the order. Filter on them with `maxDisputed` if a
 * verdict is what you actually want to select on.
 *
 * Candidates with no score box are not silently dropped: they come back in
 * `rejected` saying nobody has ever paid them, which is a fact about the
 * registry and not a fault in the agent.
 */
export async function pickAgent(
  candidates: AgentCandidate[],
  opts: PickAgentOptions = {}
): Promise<AgentRanking> {
  const network = opts.network ?? "testnet";
  const appId = opts.appId ?? REPUTATION_APP[network];
  const basis =
    "ranked by settled volume, then by number of settlements, then by recency. " +
    "Every credit required a real transfer from a registered client to this agent, so this " +
    "measures money that moved — not quality. Nobody judged the work.";

  if (!appId) {
    throw new RiparError(
      `The ReputationRegistry is not deployed on ${network}, so no candidate can be scored. ` +
        `Pass appId, or use testnet.`,
      "registry_not_deployed"
    );
  }

  const rows = await Promise.all(
    candidates.map(async (candidate): Promise<RankedAgent> => {
      const agentId = typeof candidate === "number" ? candidate : Number(candidate.agentId);
      const url = typeof candidate === "number" ? undefined : candidate.url;
      if (!Number.isInteger(agentId) || agentId <= 0) {
        return {
          agentId,
          url,
          score: null,
          candidate,
          // The registry's own sentinel: ids start at 1 so 0 can mean "no such
          // agent" in the reverse indexes.
          reason: `"${String(agentId)}" is not an agent id. Ids are positive integers minted by the IdentityRegistry.`,
        };
      }
      const score = await readScore(agentId, { network, appId, ...opts });
      if (!score) {
        return {
          agentId,
          url,
          score: null,
          candidate,
          reason: `agent ${agentId} has no score box in app ${appId}: nobody has ever paid it through Ripar.`,
        };
      }
      return { agentId, url, score, candidate };
    })
  );

  const ranked: RankedAgent[] = [];
  const rejected: RankedAgent[] = [];
  for (const row of rows) {
    if (!row.score) {
      rejected.push(row);
      continue;
    }
    const failed = belowThresholds(row.score, opts);
    if (failed) rejected.push({ ...row, reason: failed });
    else ranked.push(row);
  }

  ranked.sort((a, b) => {
    const x = a.score!;
    const y = b.score!;
    return (
      y.volumeMicro - x.volumeMicro ||
      y.jobsPaid - x.jobsPaid ||
      Date.parse(y.lastAt) - Date.parse(x.lastAt) ||
      // Last resort so the order is stable rather than dependent on input order:
      // two agents that tie on everything must rank the same way every run, or a
      // caller comparing two runs sees drift that is not there.
      x.agentId - y.agentId
    );
  });

  return { ranked, rejected, best: ranked[0] ?? null, basis };
}

function belowThresholds(score: AgentScore, opts: PickAgentOptions): string | undefined {
  if (opts.minJobsPaid != null && score.jobsPaid < opts.minJobsPaid) {
    return `paid ${score.jobsPaid} time(s), below the minimum of ${opts.minJobsPaid}.`;
  }
  if (opts.minVolume != null && score.volumeUsd < opts.minVolume) {
    return `settled $${score.volumeUsd.toFixed(6)} in total, below the minimum of $${opts.minVolume.toFixed(6)}.`;
  }
  if (opts.maxDisputed != null && score.disputed > opts.maxDisputed) {
    return `has ${score.disputed} disputed verdict(s), above the maximum of ${opts.maxDisputed}.`;
  }
  return undefined;
}

/** One agent's score box, or null when it has none. */
export async function readScore(
  agentId: number,
  opts: { network?: Network; appId?: number; algodUrl?: string; algodToken?: string; fetchImpl?: typeof fetch } = {}
): Promise<AgentScore | null> {
  const network = opts.network ?? "testnet";
  const appId = opts.appId ?? REPUTATION_APP[network];
  const raw = await readBox(appId, boxName(SCORE_BOX_PREFIX, uint64(agentId)), { network, ...opts });
  return raw ? decodeScore(raw) : null;
}

/**
 * Seven uint64s, big-endian, in declaration order.
 *
 * Fixed-width and in-order because that is what an ARC-4 struct of seven UInt64s
 * is on the wire — there is no length prefix and no field name to check against,
 * so a decoder that reads them in the wrong order returns plausible numbers for
 * the wrong facts. The length check is the only guard available.
 */
export function decodeScore(raw: Uint8Array): AgentScore {
  const b = Buffer.from(raw);
  if (b.length < 56) {
    throw new RiparError(
      `A score box is 56 bytes (seven uint64s); this one is ${b.length}. Refusing to decode it as a score.`,
      "bad_score_box"
    );
  }
  const volumeMicro = Number(b.readBigUInt64BE(16));
  return {
    agentId: Number(b.readBigUInt64BE(0)),
    jobsPaid: Number(b.readBigUInt64BE(8)),
    volumeMicro,
    // Six decimals is the registry asset's own precision. Dividing here rather
    // than at the comparison keeps the dollars-versus-base-units mistake in one
    // place instead of at every call site.
    volumeUsd: volumeMicro / 1e6,
    validated: Number(b.readBigUInt64BE(24)),
    disputed: Number(b.readBigUInt64BE(32)),
    firstAt: isoSeconds(Number(b.readBigUInt64BE(40))),
    lastAt: isoSeconds(Number(b.readBigUInt64BE(48))),
  };
}

/**
 * One box, over plain HTTP rather than through an algod client.
 *
 * Same reason balance.ts reads accounts this way: the caller's `fetchImpl` is
 * the only seam a test can drive, and an Algodv2 built inside the SDK ignores it
 * — so the reputation lookup would be the one thing in the client that cannot be
 * exercised without a node.
 */
async function readBox(
  appId: number,
  name: Uint8Array,
  opts: { network?: Network; algodUrl?: string; algodToken?: string; fetchImpl?: typeof fetch }
): Promise<Uint8Array | null> {
  const network = opts.network ?? "testnet";
  const base = (opts.algodUrl ?? DEFAULT_ALGOD[network]).replace(/\/$/, "");
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const url = `${base}/v2/applications/${appId}/box?name=${encodeURIComponent(
    `b64:${Buffer.from(name).toString("base64")}`
  )}`;

  let res: Response;
  try {
    res = await doFetch(url, {
      headers: { accept: "application/json", ...(opts.algodToken ? { "x-algo-api-token": opts.algodToken } : {}) },
    });
  } catch (err) {
    throw new RiparError(
      `Could not reach algod at ${base} to read box ${Buffer.from(name).toString("hex")} of app ${appId}: ${
        (err as Error).message
      }`,
      "algod_unreachable"
    );
  }
  // A missing box is a fact — this agent has no score — and algod says it with a
  // 404. Treating that as an error would make "never been paid" indistinguishable
  // from "the node is down", and those lead to opposite decisions.
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new RiparError(
      `algod at ${base} rejected a box read for app ${appId} with ${res.status}.`,
      "algod_error",
      res.status
    );
  }
  const body = (await res.json()) as { value?: string };
  if (typeof body.value !== "string") return null;
  return new Uint8Array(Buffer.from(body.value, "base64"));
}

export function uint64(n: number): Uint8Array {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return new Uint8Array(b);
}

export function boxName(prefix: string, raw: Uint8Array): Uint8Array {
  return new Uint8Array([...Buffer.from(prefix), ...raw]);
}

function isoSeconds(seconds: number): string {
  return new Date(seconds * 1_000).toISOString();
}

/* ── 4. price drift ─────────────────────────────────────────────────────── */

export type QuoteObservation = {
  /** Null when the 402 could not be read as a price. Kept anyway: an endpoint
   *  that stops quoting readably has changed, and that is drift too. */
  usd: number | null;
  at: number;
  /** Atomic units and asset, straight off the accepts entry, so a caller can
   *  see a re-denomination that leaves the dollar figure unchanged. */
  amount?: string;
  asset?: string;
};

export type DriftReport = {
  url: string;
  /** The quote just taken. */
  current: number | null;
  /** The first price ever seen for this URL — the baseline drift is measured
   *  against, because a rise applied one percent at a time is invisible against
   *  the previous sample and obvious against the first. */
  baseline: number | null;
  /** The sample before this one. */
  previous: number | null;
  baselineAt?: string;
  /** Observations held for this URL, including the one just taken. */
  samples: number;
  drifted: boolean;
  /** current − baseline, in USD. */
  changeUsd: number | null;
  /** current ÷ baseline. 100 is the hundredfold rise this exists to catch. */
  factor: number | null;
  direction: "up" | "down" | "flat" | "unknown";
  /** The finding in one line, including the case where there is no baseline. */
  summary: string;
};

/**
 * Every price this client has been quoted, per URL.
 *
 * An autonomous caller has no memory between calls unless something keeps one,
 * and without it a price that goes from $0.01 to $1.00 is simply the price. The
 * cap in `maxPrice` catches an absolute number; this catches a MOVE, which is
 * what a supplier quietly repricing an agent looks like from the inside.
 */
export class QuoteHistory {
  private readonly byUrl = new Map<string, QuoteObservation[]>();
  /** Observations kept per URL, oldest dropped. Small: the baseline and the
   *  recent shape are what a decision needs, not a time series. */
  readonly perUrl: number;

  constructor(perUrl = 32) {
    this.perUrl = Math.max(2, Math.floor(perUrl));
  }

  record(url: string, obs: QuoteObservation) {
    const key = canonicalUrl(url);
    const list = this.byUrl.get(key) ?? [];
    list.push(obs);
    // The OLDEST is what a baseline needs, so the drop has to take from the
    // middle: dropping the oldest would slide the baseline forward and make a
    // slow rise disappear one sample at a time, which is the exact failure this
    // is here to catch.
    if (list.length > this.perUrl) list.splice(1, 1);
    this.byUrl.set(key, list);
  }

  observations(url: string): QuoteObservation[] {
    return [...(this.byUrl.get(canonicalUrl(url)) ?? [])];
  }

  clear() {
    this.byUrl.clear();
  }
}

/**
 * Compare a fresh quote with what this client saw before.
 *
 * `current` is passed in rather than fetched here so the comparison is testable
 * without a server, and so the caller decides whether the fresh quote is allowed
 * to come from a cache — it must not, and `RiparClient.drift` bypasses it.
 */
export function driftReport(url: string, before: QuoteObservation[], current: QuoteObservation): DriftReport {
  const baselineObs = before[0];
  const previousObs = before[before.length - 1];
  const samples = before.length + 1;
  const baseline = baselineObs?.usd ?? null;
  const previous = previousObs?.usd ?? null;

  if (!baselineObs) {
    return {
      url,
      current: current.usd,
      baseline: null,
      previous: null,
      samples,
      // Not "no drift". A first sighting has nothing to differ from, and
      // reporting it as unchanged is a claim about a comparison that never
      // happened — the reading an agent would act on exactly once, wrongly.
      drifted: false,
      changeUsd: null,
      factor: null,
      direction: "unknown",
      summary:
        `${url}: first quote seen (${money(current.usd)}). There is no earlier price to compare it with, ` +
        `so nothing is known about drift yet.`,
    };
  }

  if (current.usd == null || baseline == null) {
    return {
      url,
      current: current.usd,
      baseline,
      previous,
      baselineAt: new Date(baselineObs.at).toISOString(),
      samples,
      // An unreadable quote where a readable one used to be IS a change, and the
      // one a price cap can no longer check. Reporting it as "flat" would hide
      // the only case where the guard has stopped working.
      drifted: true,
      changeUsd: null,
      factor: null,
      direction: "unknown",
      summary:
        current.usd == null
          ? `${url}: quoted ${money(baseline)} before, and this quote could not be read as a price at all. ` +
            `A quote nobody can read is a quote maxPrice cannot check.`
          : `${url}: the earlier quote could not be read as a price, so the current ${money(current.usd)} ` +
            `cannot be compared with it.`,
    };
  }

  const changeUsd = round6(current.usd - baseline);
  const factor = baseline > 0 ? round6(current.usd / baseline) : null;
  const drifted = Math.abs(changeUsd) > 1e-9;
  const direction = !drifted ? "flat" : changeUsd > 0 ? "up" : "down";

  return {
    url,
    current: current.usd,
    baseline,
    previous,
    baselineAt: new Date(baselineObs.at).toISOString(),
    samples,
    drifted,
    changeUsd,
    factor,
    direction,
    summary: drifted
      ? `${url}: ${money(baseline)} → ${money(current.usd)} (${changeUsd > 0 ? "+" : ""}${money(changeUsd)}` +
        `${factor != null ? `, ${factor}×` : ""}) since ${new Date(baselineObs.at).toISOString()}, over ${samples} quotes.`
      : `${url}: ${money(current.usd)}, unchanged across ${samples} quotes since ${new Date(
          baselineObs.at
        ).toISOString()}.`,
  };
}

/* ── 5. manifest signatures ─────────────────────────────────────────────── */

export type SignatureVerdict =
  | { ok: true; address: string }
  | { ok: false; code: "bad_address" | "bad_signature" | "not_signed_by_address"; reason: string };

/**
 * Was this manifest signed by the address it names?
 *
 * A manifest is a file on a web server. Anything in it — payTo above all — is
 * whatever whoever controls that host wrote, so a caller reading `payTo` and
 * paying it is trusting DNS and a TLS certificate and nothing else. A signature
 * over the body by the key that owns the address moves the claim from "this
 * host says so" to "the account being paid says so", which is the only version
 * a stranger's agent can check.
 *
 * RETURNS A VERDICT, NOT A BOOLEAN. `if (verifyManifestSignature(...))` is true
 * for a forged signature, because an object is truthy. Read `.ok`.
 *
 * The scheme is algosdk's `signBytes`/`verifyBytes` pair, which prefixes the
 * bytes with "MX" before the ed25519 operation. A raw ed25519 signature over the
 * same bytes will NOT verify here, deliberately: accepting both schemes doubles
 * the surface a forger can aim at, and costs a verifier nothing to refuse. Sign
 * with `algosdk.signBytes(manifestSigningBytes(body), account.sk)`.
 */
export function verifyManifestSignature(
  body: string | Uint8Array | Record<string, unknown>,
  signature: string | Uint8Array,
  address: string
): SignatureVerdict {
  let publicKeyOwner: string;
  try {
    // Decoding validates the checksum, so a transposed character is caught here
    // rather than becoming a verification failure that reads like a forgery.
    algosdk.decodeAddress(address);
    publicKeyOwner = address;
  } catch (err) {
    return {
      ok: false,
      code: "bad_address",
      reason: `"${address}" is not an Algorand address (${(err as Error).message}). Nothing was verified.`,
    };
  }

  let sig: Uint8Array;
  try {
    sig = typeof signature === "string" ? decodeSignature(signature) : signature;
  } catch (err) {
    return { ok: false, code: "bad_signature", reason: (err as Error).message };
  }
  if (sig.length !== 64) {
    return {
      ok: false,
      code: "bad_signature",
      reason: `An ed25519 signature is 64 bytes; this one is ${sig.length}. Nothing was verified.`,
    };
  }

  const bytes = manifestSigningBytes(body);
  // verifyBytes throws on some malformed inputs rather than returning false, and
  // a throw from a verifier is indistinguishable from a crash at the call site —
  // where the caller is deciding whether to send money.
  let valid = false;
  try {
    valid = algosdk.verifyBytes(bytes, sig, publicKeyOwner);
  } catch (err) {
    return {
      ok: false,
      code: "bad_signature",
      reason: `The signature could not be checked: ${(err as Error).message}`,
    };
  }
  if (!valid) {
    return {
      ok: false,
      code: "not_signed_by_address",
      reason:
        `The signature does not verify against ${address}. Either the body changed after it was signed, ` +
        `or it was signed by a different key — and a manifest signed by a different key is a manifest ` +
        `whose payTo nobody has attested to.`,
    };
  }
  return { ok: true, address };
}

/**
 * The exact bytes a manifest signature covers.
 *
 * A string or a buffer is used AS GIVEN, because the only bytes both sides can
 * agree on are the ones actually served — re-serialising a parsed manifest
 * changes whitespace and key order and breaks a perfectly good signature.
 * An object is canonicalised (sorted keys, `undefined` dropped) as a
 * convenience for a signer that has no serialised form yet; both sides must use
 * this same function for that to mean anything.
 */
export function manifestSigningBytes(body: string | Uint8Array | Record<string, unknown>): Uint8Array {
  if (typeof body === "string") return new Uint8Array(Buffer.from(body, "utf8"));
  if (body instanceof Uint8Array) return body;
  return new Uint8Array(Buffer.from(canonicalJson(body), "utf8"));
}

/** Key order must not change the bytes, or two serialisations of one manifest
 *  produce two different signatures and neither side can tell which is wrong. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** base64 or hex — both turn up in headers, and a hex string decoded as base64
 *  silently yields the wrong 48 bytes rather than failing. */
function decodeSignature(raw: string): Uint8Array {
  const value = raw.trim();
  if (/^[0-9a-fA-F]{128}$/.test(value)) return new Uint8Array(Buffer.from(value, "hex"));
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0) throw new Error(`"${value.slice(0, 24)}…" is neither base64 nor hex.`);
  return new Uint8Array(bytes);
}

/* ── shared ─────────────────────────────────────────────────────────────── */

function money(n: number | null): string {
  return n == null ? "an unreadable amount" : `$${n.toFixed(6)}`;
}

function round6(n: number): number {
  return Number(n.toFixed(6));
}

/** Drift is per endpoint, and the query is part of which price was quoted — an
 *  endpoint priced by `?pages=50` is a different price from `?pages=1`, and
 *  merging them into one history would report drift that is just a different
 *  request. Only the fragment goes, because it never reaches the server. */
function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

/** The USD and the raw fields of a quote, in the shape the history stores. */
export function observationOf(
  usd: number | null,
  accept?: Record<string, unknown> | null,
  at = Date.now()
): QuoteObservation {
  return {
    usd,
    at,
    amount: accept?.amount != null ? String(accept.amount) : undefined,
    asset: accept?.asset != null ? String(accept.asset) : undefined,
  };
}

/** USD for an amount in an asset's atomic units, re-exported so a caller ranking
 *  or comparing quotes does not reimplement the six-decimal conversion. */
export { atomicToUsd };
