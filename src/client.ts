import { x402Client } from "@x402/core/client";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { toClientAvmSigner } from "@x402/avm";
import { wrapFetchWithPayment } from "@x402/fetch";
import algosdk from "algosdk";
import { coversPayment, readBalance, type WalletBalance } from "./balance.js";
import {
  IDEMPOTENCY_HEADER,
  QuoteHistory,
  driftReport,
  headerRecord,
  headerValue,
  newIdempotencyKey,
  observationOf,
  pickAgent,
  readRetryAfter,
  type AgentCandidate,
  type AgentRanking,
  type DriftReport,
  type PickAgentOptions,
} from "./client-extras.js";
import { readPaymentRequired, readReceiptHeader, usdOfAccept } from "./headers.js";
import { Limiter } from "./limiter.js";
import { resolveFacilitator, type FacilitatorChoice } from "./network.js";
import { QuoteCache, quoteKey, type QuoteCacheOptions } from "./quotecache.js";
import { ReceiptLedger, exportReceipts, type ReceiptRecord } from "./receipts.js";
import { DEFAULT_RETRY, backoffDelay, isRetryable, sleep, type RetryOptions } from "./retry.js";
import { SpendLedger } from "./spend.js";
import { CAIP2, RiparError, USDC_ASSET_ID, type Network } from "./types.js";

export type ClientOptions = {
  /** 25-word Algorand mnemonic, or a raw 64-byte secret key. */
  mnemonic?: string;
  secretKey?: Uint8Array;
  network?: Network;
  /** Refuse any quote above this, in USD. The single most important guard when
   *  something autonomous holds the wallet. */
  maxPrice?: string;
  /** Refuse once this much has been spent in a rolling 24h, in USD. */
  maxPerDay?: string;
  /** Repeat 5xx and transport failures. Never 4xx. Default 3 attempts. */
  retry?: RetryOptions | false;
  /** Longest wait this client will sit through because a server's `Retry-After`
   *  asked for it. Default 60s. Past it the call fails saying so rather than
   *  coming back early — see client-extras.ts. */
  retryAfterMaxMs?: number;
  /** Send a generated `Idempotency-Key` on every call, so a retry after a
   *  dropped connection replays the stored answer instead of paying again.
   *  ON by default, unlike the other options here: it costs no round trip, a
   *  server that does not implement it ignores an unknown header, and the
   *  failure it prevents is paying twice for one piece of work. */
  idempotency?: boolean;
  /** Reuse a quote for the same URL and body for a few seconds. Off unless
   *  set, because a quote is a price and a stale price is one nobody agreed to
   *  — see quotecache.ts. */
  quoteCache?: QuoteCacheOptions;
  /** Most independent calls in flight at once. Unlimited unless set. */
  maxConcurrent?: number;
  /** Read the wallet before paying, and refuse a quote it cannot cover. Off
   *  unless set: it adds an algod round trip per call, and it is the caller who
   *  knows whether that is worth trading for a clearer failure. */
  preflightBalance?: boolean;
  /** Where `balance()` reads from. Defaults to public algod for the network. */
  algodUrl?: string;
  algodToken?: string;
  /** Facilitators to fail over between, most preferred first. Read by
   *  `facilitator()`; never used to pay, because the resource server picks the
   *  facilitator for its own endpoints. */
  facilitatorUrls?: string[];
  /** How many receipts to keep in memory. Default 1000, oldest dropped. */
  receiptsLimit?: number;
  fetchImpl?: typeof fetch;
};

export type CallResult<T = unknown> = {
  data: T;
  /** Present when the call was actually paid for. `amount` is atomic units of
   *  `asset`; `usd` is that converted, when the asset's decimals are known. */
  payment?: { txId?: string; amount?: string; usd?: number; asset?: string };
  status: number;
  /** How many attempts it took. 1 unless something was retried. */
  attempts?: number;
  /** Present only when the server answered from its idempotency store rather
   *  than running the handler again. Proof the retry was free: there is no
   *  second receipt because there was no second settlement. */
  replayed?: boolean;
};

export type QuoteResult =
  | { paymentRequired: false; status: number }
  | { paymentRequired: true; status: 402; requirements: unknown };

/** One item of work for `callMany` / `estimate`. A bare string is the URL with
 *  no body, which is the common case. */
export type CallItem = { url: string; body?: unknown; init?: RequestInit };

/**
 * One result of a batch, settled rather than thrown.
 *
 * A batch of paid calls is the wrong place for fail-fast: `Promise.all` rejects
 * on the first failure while the rest keep running and keep paying, and the
 * caller is left holding one error and no idea which of the others settled.
 */
export type SettledCall<T = unknown> =
  | { ok: true; url: string; result: CallResult<T> }
  | { ok: false; url: string; error: RiparError };

export type EstimateLine = {
  url: string;
  /** Null when the price could not be read. Never zero for an unknown price —
   *  a quote nobody could parse is the one most worth budgeting for. */
  usd: number | null;
  status?: number;
  paymentRequired?: boolean;
  /** Why `usd` is null. */
  error?: string;
};

export type Estimate = {
  lines: EstimateLine[];
  /** Sum of the lines whose price WAS readable. */
  totalUsd: number;
  /** The lines missing from that sum. A caller budgeting off `totalUsd` has to
   *  look here first, or it will plan against a number that silently excludes
   *  the endpoints it understands least. */
  unreadable: EstimateLine[];
};

export type SubscribeAdvice = {
  url: string;
  expectedCalls: number;
  /** What one unkeyed call settles today, from the live 402. */
  perCallUsd: number | null;
  /** The window this endpoint sells, from its manifest entry. Null when it
   *  sells none, which is most endpoints. */
  window: { usd: number; period?: string } | null;
  /** expectedCalls × perCallUsd. */
  payPerCallUsd: number | null;
  cheaper: "subscribe" | "per-call" | "same" | "unknown";
  savingsUsd: number | null;
  /** Calls at which the window has paid for itself. */
  breakEvenCalls: number | null;
  /** The comparison written out, so whoever reviews an agent's decision can
   *  check the arithmetic instead of trusting it. */
  arithmetic: string;
  /** Why no recommendation could be made, or what qualifies the one given. */
  reason?: string;
};

/**
 * Calls paid endpoints, performing the whole 402 handshake: send, read the
 * quote, check it against maxPrice, sign, retry.
 *
 * Without a signer it still works for reading quotes — `quote()` needs no key
 * and no funds, which makes price discovery free.
 */
export class RiparClient {
  private readonly network: Network;
  private readonly maxPrice?: number;
  private readonly ledger?: SpendLedger;
  private readonly retry: RetryOptions | false;
  private readonly baseFetch: typeof fetch;
  private paidFetch?: typeof fetch;
  /** The signer's Algorand address, when there is a signer. This is what
   *  `balance()` reads and what settlement debits. */
  private readonly address?: string;
  private readonly limiter?: Limiter;
  private readonly quotes?: QuoteCache<QuoteResult>;
  private readonly preflightBalance: boolean;
  private readonly algodUrl?: string;
  private readonly algodToken?: string;
  private readonly facilitatorUrls: string[];
  private readonly receiptLedger: ReceiptLedger;
  private readonly retryAfterMaxMs?: number;
  private readonly idempotency: boolean;
  /** Every fresh quote this client has taken, per URL. Cache hits are NOT
   *  recorded: a cached price compared with itself is a sample that proves the
   *  cache works and says nothing about the seller. */
  private readonly quoteHistory = new QuoteHistory();
  /** Subscription keys, by endpoint URL. Held in memory only — a key is bearer
   *  credentials for a window the caller already paid for, so writing it to disk
   *  is the caller's decision, not ours. `activeSubscriptions` exposes them. */
  private readonly subscriptions = new Map<string, StoredKey>();

  constructor(opts: ClientOptions = {}) {
    this.network = opts.network ?? "mainnet";
    this.maxPrice = opts.maxPrice != null ? parseUsd(opts.maxPrice, "maxPrice") : undefined;
    this.ledger = opts.maxPerDay != null ? new SpendLedger(parseUsd(opts.maxPerDay, "maxPerDay")) : undefined;
    this.retry = opts.retry ?? DEFAULT_RETRY;
    this.baseFetch = opts.fetchImpl ?? globalThis.fetch;
    this.limiter = opts.maxConcurrent != null ? new Limiter(opts.maxConcurrent) : undefined;
    this.quotes = opts.quoteCache ? new QuoteCache<QuoteResult>(opts.quoteCache) : undefined;
    this.preflightBalance = opts.preflightBalance === true;
    this.algodUrl = opts.algodUrl;
    this.algodToken = opts.algodToken;
    this.facilitatorUrls = opts.facilitatorUrls ?? [];
    this.receiptLedger = new ReceiptLedger(opts.receiptsLimit);
    this.retryAfterMaxMs = opts.retryAfterMaxMs;
    this.idempotency = opts.idempotency !== false;

    // toClientAvmSigner takes a BASE64 64-byte key, not raw bytes — passing a
    // Uint8Array typechecks as `any` in JS and fails at signing time.
    const key = opts.secretKey ?? (opts.mnemonic ? mnemonicToKey(opts.mnemonic) : undefined);
    const keyB64 = key ? Buffer.from(key).toString("base64") : undefined;
    if (key && keyB64) {
      // An Algorand ed25519 secret key is seed(32) ‖ public(32), so the address
      // is derivable here and never has to be passed in alongside the key —
      // two sources for one identity is how a client ends up reading the
      // balance of a wallet it is not spending from.
      this.address = algosdk.encodeAddress(key.subarray(32));
      const signer = toClientAvmSigner(keyB64);
      // MUST be the wildcard, not CAIP2[network]. @x402/core matches a
      // registration by exact key or glob and has no prefix fallback, while
      // CAIP-2 caps a reference at 32 chars so the constant is a TRUNCATED
      // genesis hash (41 chars) and every facilitator quotes the full one (53).
      // Registering the constant means no scheme is ever found and the client
      // cannot pay anything — server.ts already uses the wildcard for exactly
      // this reason; the client was missed.
      // `spendControls: false` because this client already enforces its own.
      //
      // @x402/core 2.23 added a spend-control layer that defaults to a $1
      // per-payment cap and to allowing only the assets `findDefaultAsset`
      // recognizes. Both defaults are silent, and both are wrong here: the cap
      // this SDK is asked to honour is the one the caller configured
      // (`maxUsdPerCall` / `maxUsdPerDay`, checked in callOnce and re-checked
      // on every retry), and the asset is whatever the registry was
      // bootstrapped with. Leaving the upstream layer on means a caller who
      // sets a $5 cap gets a $1 one, and a deployment settling in an asset the
      // upstream list has never heard of cannot pay at all — each failing at
      // payment time with an error about a control the caller never set.
      //
      // Turning it off is not removing a safety net; it is declining a second,
      // undocumented one that overrides the first.
      const client = x402Client.fromConfig({
        schemes: [{ network: "algorand:*", client: new ExactAvmScheme(signer) }],
        spendControls: false,
      });
      this.paidFetch = wrapFetchWithPayment(this.baseFetch, client) as typeof fetch;
    }
  }

  /** Keep a key the server just issued, and note when a held one expires. */
  private captureSubscription(url: string, res: Response) {
    const issued = res.headers.get("x-ripar-subscription");
    const expiresAt = res.headers.get("x-ripar-subscription-expires") ?? undefined;
    const endpoint = res.headers.get("x-ripar-subscription-endpoint") ?? undefined;
    if (issued) {
      this.subscriptions.set(canonical(url), { value: issued, expiresAt, endpoint });
      return;
    }
    // The server reports a held key as expired or unknown by asking for payment
    // again. Dropping it stops every later call carrying a dead credential.
    const status = res.headers.get("x-ripar-subscription-status");
    if (status === "expired" || status === "unknown") this.subscriptions.delete(canonical(url));
  }

  /** USD spent in the rolling 24h window, when maxPerDay is set. */
  get spentToday() {
    return this.ledger?.spent() ?? 0;
  }

  /** USD still available under maxPerDay. Infinity when uncapped. */
  get remainingToday() {
    return this.ledger?.remaining() ?? Infinity;
  }

  /** Read the price without paying and without a wallet. */
  async quote(url: string, init: RequestInit = {}): Promise<QuoteResult> {
    const key = this.quotes ? quoteKey(url, String(init.method ?? "POST"), init.body) : null;
    if (key && this.quotes) {
      const hit = this.quotes.get(key);
      if (hit) return hit;
    }
    const fresh = await this.gate(() => this.quoteOnce(url, init));
    if (key && this.quotes) this.quotes.set(key, fresh);
    return fresh;
  }

  private async quoteOnce(url: string, init: RequestInit): Promise<QuoteResult> {
    // A body with no content-type is a body the server will not parse, and an
    // unparsed body means a dynamic price is quoted from `{}` — the same number
    // for every request, which looks like the feature is simply not working.
    const headers =
      init.body != null ? { "content-type": "application/json", ...headerRecord(init.headers) } : init.headers;
    const res = await this.baseFetch(url, { method: "POST", ...init, headers });
    if (res.status !== 402) {
      // A 2xx really did quote: it answered without asking for payment, so the
      // price is zero and free-to-paid is drift worth catching. A 4xx or 5xx
      // quoted nothing at all, and recording it as free would put a price in the
      // history that nobody was ever offered.
      if (res.status < 400) this.quoteHistory.record(url, observationOf(0));
      return { paymentRequired: false as const, status: res.status };
    }
    // The requirements travel base64-encoded in PAYMENT-REQUIRED; the body of a
    // 402 is usually `{}`. Parsing the header as plain JSON is the mistake that
    // makes every quote unreadable — and an unreadable quote is one a price cap
    // cannot check. See headers.ts.
    let requirements = readPaymentRequired(res.headers);
    if (!requirements) {
      try {
        requirements = await res.clone().json();
      } catch {
        /* leave null; the caller still learns payment is required */
      }
    }
    const picked = pickAccept(requirements);
    this.quoteHistory.record(url, observationOf(picked?.usd ?? null, picked?.accept));
    return { paymentRequired: true as const, status: 402, requirements };
  }

  /**
   * Has this endpoint's price moved since this client first saw it?
   *
   * Every quote taken through this client is remembered per URL, and this takes
   * a fresh one and compares it with the FIRST — not the previous. A supplier
   * raising a price five percent per call is invisible against the last sample
   * and unmistakable against the baseline, and an autonomous caller that
   * silently absorbs a hundredfold rise is the failure this exists to prevent.
   *
   * Deliberately bypasses the quote cache: a cached quote compared with itself
   * reports "unchanged" for a price that has doubled.
   *
   * It reports; it does not refuse. Refusing on drift belongs to `maxPrice`,
   * which is a number the caller chose — a client that started declining
   * legitimate price changes on its own judgement would be an outage nobody
   * configured.
   */
  async drift(url: string, init: RequestInit = {}): Promise<DriftReport> {
    // Read the history BEFORE quoting, or the fresh sample becomes its own
    // baseline and every endpoint reports no drift, forever.
    const before = this.quoteHistory.observations(url);
    const fresh = await this.gate(() => this.quoteOnce(url, init));
    const picked = fresh.paymentRequired ? pickAccept(fresh.requirements) : null;
    const current = observationOf(fresh.paymentRequired ? (picked?.usd ?? null) : 0, picked?.accept);
    return driftReport(url, before, current);
  }

  /** Every price this client has been quoted for a URL, oldest first. */
  quoteHistoryFor(url: string) {
    return this.quoteHistory.observations(url);
  }

  /**
   * Rank candidate agents by their on-chain reputation.
   *
   * The client's network and algod settings are filled in, because a score read
   * from the wrong network is a score for a different agent with the same id.
   * Everything else — what it measures, and what it does not — is in
   * client-extras.ts, and comes back on the ranking as `basis`.
   */
  async pickAgent(candidates: AgentCandidate[], opts: PickAgentOptions = {}): Promise<AgentRanking> {
    return this.gate(() =>
      pickAgent(candidates, {
        network: this.network,
        algodUrl: this.algodUrl,
        algodToken: this.algodToken,
        fetchImpl: this.baseFetch,
        ...opts,
      })
    );
  }

  /**
   * Run something that opens a socket under the concurrency limit, when one is
   * set. Re-entrant, so `call()` → `quote()` → `balance()` takes ONE permit
   * between them rather than deadlocking on itself at `maxConcurrent: 1`.
   */
  private gate<T>(task: () => Promise<T>): Promise<T> {
    return this.limiter ? this.limiter.run(task) : task();
  }

  /** Call a paid endpoint, settling it. Throws if no signer was configured. */
  async call<T = unknown>(url: string, body?: unknown, init: RequestInit = {}): Promise<CallResult<T>> {
    return this.gate(() => this.callOnce<T>(url, body, init));
  }

  private async callOnce<T>(url: string, body?: unknown, init: RequestInit = {}): Promise<CallResult<T>> {
    if (!this.paidFetch) {
      throw new RiparError(
        "This client has no signer, so it can read quotes but cannot pay. Construct RiparClient with a mnemonic or secretKey.",
        "no_signer"
      );
    }

    // Check the price BEFORE paying — the wrapped fetch would otherwise settle
    // whatever it is quoted, which is exactly the runaway we want to prevent.
    // A held key means this call settles nothing, so the caps have nothing to
    // check. Quoting anyway would fetch the WINDOW's price — and a $5.00 window
    // against a $0.01 maxPrice would refuse a call that is in fact free.
    //
    // But only a key we believe is still LIVE. A key we know has expired buys
    // nothing, so skipping the caps on the strength of it would let the retry
    // below settle the full window price with neither limit consulted — the
    // exact runaway maxPrice exists to prevent. When the expiry is unknown
    // (a key restored with useSubscription and no date) treat it as live and
    // let the server be the judge; it will say `expired` and the key is
    // dropped, so at worst one call is quoted without a cap check.
    const key = this.subscriptions.get(canonical(url));
    const covered = key != null && !isExpired(key);
    if (key && !covered) this.subscriptions.delete(canonical(url));

    let quoted: number | null = null;
    if (!covered && (this.maxPrice != null || this.ledger || this.preflightBalance)) {
      const q = await this.quote(url, { ...init, body: body != null ? JSON.stringify(body) : undefined });
      if (q.paymentRequired) {
        const picked = pickAccept(q.requirements);
        quoted = picked?.usd ?? null;
        if (quoted == null || !picked) {
          // Fail closed. A guard that cannot read the quote must refuse, not pay
          // an amount it never saw.
          throw new RiparError(
            `${url} asked for payment but the quote could not be read, and this client has ${
              this.maxPrice != null || this.ledger ? "a spending limit" : "a balance preflight"
            }. Refusing to pay blind.`,
            "unreadable_quote",
            402,
            q.requirements
          );
        }
        this.assertAffordable(quoted, q.requirements);
        if (this.preflightBalance) await this.assertWalletCovers(picked.accept, q.requirements);
      }
    }

    const attempts = this.retry === false ? 1 : Math.max(1, this.retry.attempts ?? DEFAULT_RETRY.attempts);
    let lastError: RiparError | undefined;

    // ONE key for the whole call, minted before the loop and sent on every
    // attempt. That is the entire contract: the same key across the retries of
    // one call is what makes the retry a replay, and a different key per call is
    // what stops the second call being answered with the first one's result.
    // Minting it inside the loop would give every attempt its own claim and
    // settle every one of them; hoisting it out of `call()` would share one key
    // between two different calls.
    //
    // A caller who set the header themselves owns the key — they may be
    // coordinating retries across processes, where a key this client invented
    // per call is exactly wrong.
    const idempotencyKey =
      this.idempotency && headerValue(init.headers, IDEMPOTENCY_HEADER) == null
        ? newIdempotencyKey()
        : undefined;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      let res: Response;
      // A held key turns this into a free call — the server checks it before
      // the payment gate, so the facilitator is never involved.
      const held = this.subscriptions.get(canonical(url));

      // Re-check the cap on every attempt, not once before the loop. A retry
      // re-signs and settles AGAIN. A 5xx cancels settlement rather than
      // refunding, so the failed attempt cost nothing and paying on the retry
      // is correct — but three attempts at $2 against a $5 daily cap must stop
      // at two. Checking once let the total run past the limit the caller set.
      if (attempt > 1 && quoted != null && !held) this.assertAffordable(quoted, undefined);

      try {
        // `...init` FIRST. Spreading it after `headers` replaced the whole
        // composed object with `init.headers`, dropping content-type and the
        // subscription key — so passing any header at all made the call unpaid
        // and the body unparsed.
        res = await this.paidFetch(url, {
          method: "POST",
          ...init,
          headers: {
            "content-type": "application/json",
            ...(idempotencyKey ? { [IDEMPOTENCY_HEADER]: idempotencyKey } : {}),
            ...(held ? { "x-ripar-subscription": held.value } : {}),
            // LAST, so a caller's own header always wins — including the
            // Idempotency-Key above, which they may be coordinating elsewhere.
            // Normalised rather than spread: a `Headers` instance spreads to
            // nothing and the caller's headers vanish without a word.
            ...headerRecord(init.headers),
          },
          body: body != null ? JSON.stringify(body) : (init.body as BodyInit | undefined),
        });
      } catch (err) {
        // No response at all — DNS, reset, TLS, abort. Nothing settled, so
        // repeating is safe as well as sensible.
        lastError = new RiparError(
          `Call to ${url} failed to reach the server: ${(err as Error).message}`,
          "network_error",
          undefined,
          err
        );
        if (attempt < attempts && isRetryable(null)) {
          await sleep(backoffDelay(attempt, this.retry === false ? {} : this.retry));
          continue;
        }
        throw lastError;
      }

      // The ledger records the QUOTE, not the receipt's `amount` — a receipt
      // reports base units on some facilitators and USD on others, and charging
      // 10000 against a $5 cap would trip it on the first call.
      const payment = readReceipt(res);
      if (payment && quoted != null) this.ledger?.record(quoted);
      // Recorded on the receipt rather than on a 200, because the receipt is
      // what proves money moved: a call that ends 4xx after settling still
      // spent, and one covered by a window returns 200 having spent nothing.
      if (payment) {
        this.receiptLedger.record({ ...payment, url, timestamp: new Date().toISOString() });
      }
      this.captureSubscription(url, res);

      if (res.ok) {
        // The server answered out of its idempotency store: the handler did not
        // run again and nothing settled again, which is the whole point of
        // sending the key. Surfaced because "this cost nothing" is not visible
        // anywhere else — a replay carries no receipt.
        const replayed = res.headers.get("idempotency-replayed") === "true";
        return {
          data: (await res.json()) as T,
          payment,
          status: res.status,
          attempts: attempt,
          ...(replayed ? { replayed: true } : {}),
        };
      }

      const detail = await res.text().catch(() => "");
      // What the SERVER said about coming back, before deciding anything.
      const advice = readRetryAfter((name) => res.headers.get(name), { capMs: this.retryAfterMaxMs });
      lastError = new RiparError(
        `Call failed with ${res.status}.` +
          (advice.kind === "none" ? "" : ` The server asked for ${(advice.ms / 1_000).toFixed(0)}s before a retry.`),
        "call_failed",
        res.status,
        detail
      );

      // A 4xx is the server saying "this request is wrong". Sending it again
      // changes nothing and may pay again; only 5xx gets another go.
      //
      // 429 is the exception, and only when the server named a Retry-After.
      // `isRetryable` keeps it out — correctly, as a general rule, because a
      // client that ignores a rate limit must not repeat the request — but
      // waiting exactly as long as the server asked is the opposite of ignoring
      // it. The receipt check is what keeps that safe against a stranger's
      // server: this SDK's own limiter runs in front of the payment gate so its
      // 429 settled nothing, but a foreign server may charge and then refuse,
      // and repeating that pays twice.
      const repeatable =
        isRetryable(res.status) || (res.status === 429 && advice.kind !== "none" && !payment);
      if (!repeatable || attempt === attempts) throw lastError;

      if (advice.kind === "too-long") {
        // Not clamped to the cap and retried anyway: coming back before the
        // server said it would be ready is the same hammering, one step
        // politer. Stopping and naming both numbers lets the caller decide.
        throw new RiparError(
          `${url} answered ${res.status} and asked for ${(advice.ms / 1_000).toFixed(0)}s before a retry ` +
            `(Retry-After: ${advice.raw}), which is past the ${(advice.capMs / 1_000).toFixed(0)}s this client ` +
            `will wait. Not retrying — coming back sooner would ignore the header the server sent. ` +
            `Raise retryAfterMaxMs to wait it out.`,
          "retry_after_too_long",
          res.status,
          detail
        );
      }

      // The server's number wins when it gave one. Its own backoff is a guess
      // about a server it cannot see; Retry-After is that server saying it.
      const wait = advice.kind === "wait" ? advice.ms : backoffDelay(attempt, this.retry === false ? {} : this.retry);
      await sleep(wait);
    }

    throw lastError ?? new RiparError(`Call to ${url} failed.`, "call_failed");
  }

  /**
   * Subscribe to an endpoint: settle the window once, keep the key.
   *
   * After this, `call()` on the same URL sends the key and costs nothing until
   * it expires. Nothing renews on its own — x402 cannot pull from a wallet, so
   * a lapsed window simply quotes again and the caller decides.
   */
  async subscribe(url: string, body?: unknown, init: RequestInit = {}): Promise<Subscription> {
    const res = await this.call(url, body, init);
    const key = this.subscriptions.get(canonical(url));
    if (!key) {
      throw new RiparError(
        `${url} took a payment but returned no subscription key, so it is priced per call rather than per window. Use call() instead.`,
        "not_a_subscription",
        res.status
      );
    }
    return { key, expiresAt: key.expiresAt, endpoint: key.endpoint, payment: res.payment };
  }

  /** Load a key kept from an earlier process, so a restart does not re-pay. */
  useSubscription(url: string, key: string, expiresAt?: string | number) {
    this.subscriptions.set(canonical(url), {
      value: key,
      expiresAt: expiresAt != null ? new Date(expiresAt).toISOString() : undefined,
      endpoint: undefined,
    } as StoredKey);
  }

  /** Keys this client holds, so a caller can persist them itself. */
  get activeSubscriptions() {
    return [...this.subscriptions].map(([url, k]) => ({ url, key: k.value, expiresAt: k.expiresAt }));
  }

  /** Read an agent's manifest — free, and how discovery starts. */
  async discover(baseUrl: string) {
    const url = `${baseUrl.replace(/\/$/, "")}/.well-known/ripar.json`;
    const res = await this.gate(() => this.baseFetch(url));
    if (!res.ok) {
      throw new RiparError(`No Ripar manifest at ${url} (${res.status}).`, "no_manifest", res.status);
    }
    return res.json();
  }

  /**
   * What the signer's wallet holds, read from algod.
   *
   * `assetId` defaults to USDC for the network, which is what this SDK settles
   * in. `call()` passes the id out of the live quote instead, because checking
   * a holding the quote is not denominated in would approve a payment the
   * wallet cannot make.
   */
  async balance(assetId?: number): Promise<WalletBalance> {
    if (!this.address) {
      throw new RiparError(
        "This client has no signer, so there is no wallet to read. Construct RiparClient with a mnemonic or secretKey.",
        "no_signer"
      );
    }
    return this.gate(() =>
      readBalance({
        address: this.address!,
        network: this.network,
        assetId: assetId ?? USDC_ASSET_ID[this.network],
        algodUrl: this.algodUrl,
        algodToken: this.algodToken,
        fetchImpl: this.baseFetch,
      })
    );
  }

  /**
   * Price a batch before committing to it. Free, and needs no signer — the
   * whole point is to decide whether to spend before a wallet is involved.
   */
  async estimate(items: (string | CallItem)[]): Promise<Estimate> {
    const lines = await Promise.all(
      items.map(async (raw): Promise<EstimateLine> => {
        const item = toItem(raw);
        try {
          const q = await this.quote(item.url, {
            ...item.init,
            body: item.body != null ? JSON.stringify(item.body) : item.init?.body,
          });
          if (!q.paymentRequired) {
            // Answered without asking for payment, so it really is free and
            // zero belongs in the total — which is exactly what an unreadable
            // quote is not.
            return { url: item.url, usd: 0, status: q.status, paymentRequired: false };
          }
          const price = priceOf(q.requirements);
          if (price == null) {
            return {
              url: item.url,
              usd: null,
              status: 402,
              paymentRequired: true,
              error: "asked for payment in an amount this client could not read",
            };
          }
          return { url: item.url, usd: price, status: 402, paymentRequired: true };
        } catch (err) {
          return { url: item.url, usd: null, error: (err as Error).message };
        }
      })
    );

    return {
      lines,
      // Only the readable lines are summed, and the rest are listed separately
      // rather than counted as zero. A total that quietly swallows the prices it
      // failed to parse is worse than no total: it is a budget that looks
      // complete and is not.
      totalUsd: round6(lines.reduce((sum, l) => sum + (l.usd ?? 0), 0)),
      unreadable: lines.filter((l) => l.usd == null),
    };
  }

  /**
   * Call several endpoints, returning one settled result per input, in order.
   *
   * Every guard still applies per call: a price above maxPrice, a wallet that
   * cannot cover the quote, or a daily cap with no room fails that item and
   * only that item. Note that with concurrency above 1 the daily cap is checked
   * against what the ledger has RECORDED, and calls in flight together have not
   * recorded anything yet — `maxConcurrent: 1` is what makes the cap exact.
   */
  async callMany<T = unknown>(
    items: (string | CallItem)[],
    opts: { concurrency?: number } = {}
  ): Promise<SettledCall<T>[]> {
    // A batch limiter is separate from the client's, and is always acquired
    // first, so the two can only ever be taken in one order — which is what
    // keeps a tighter client limit from deadlocking against a wider batch one.
    const batch = opts.concurrency != null ? new Limiter(opts.concurrency) : undefined;

    return Promise.all(
      items.map((raw) => {
        const item = toItem(raw);
        const run = async (): Promise<SettledCall<T>> => {
          try {
            return { ok: true, url: item.url, result: await this.call<T>(item.url, item.body, item.init) };
          } catch (err) {
            return { ok: false, url: item.url, error: asRiparError(err, item.url) };
          }
        };
        return batch ? batch.run(run) : run();
      })
    );
  }

  /**
   * Advice on whether a window beats paying per call, with the arithmetic shown.
   *
   * It buys nothing. An SDK that subscribed on its own judgement would settle a
   * window price the caller never saw — the exact move maxPrice exists to stop —
   * so this returns a recommendation and leaves `subscribe()` to the caller.
   */
  async shouldSubscribe(url: string, expectedCalls: number): Promise<SubscribeAdvice> {
    if (!Number.isFinite(expectedCalls) || expectedCalls < 1) {
      throw new RiparError(
        `expectedCalls must be at least 1; got ${expectedCalls}. There is nothing to compare for zero calls.`,
        "invalid_expected_calls"
      );
    }
    const calls = Math.ceil(expectedCalls);
    const blank: SubscribeAdvice = {
      url,
      expectedCalls: calls,
      perCallUsd: null,
      window: null,
      payPerCallUsd: null,
      cheaper: "unknown",
      savingsUsd: null,
      breakEvenCalls: null,
      arithmetic: "",
    };

    // The manifest is the endpoint's published price list; the 402 is what it
    // will actually charge right now. Both are needed: the manifest is the only
    // place a window's PERIOD appears, and the quote is the only number that is
    // certainly current.
    const [q, mf] = await Promise.all([
      this.quote(url).catch((err: Error) => err),
      this.discover(originOf(url)).catch(() => null),
    ]);

    if (q instanceof Error) {
      return {
        ...blank,
        arithmetic: "no comparison: the endpoint could not be quoted",
        reason: `${url} could not be quoted: ${q.message}`,
      };
    }
    if (!q.paymentRequired) {
      return {
        ...blank,
        perCallUsd: 0,
        payPerCallUsd: 0,
        cheaper: "per-call",
        savingsUsd: 0,
        arithmetic: `${calls} calls × $0.000000 = $0.000000`,
        reason: `${url} answered ${q.status} without asking for payment, so there is no window to buy.`,
      };
    }

    const perCallUsd = priceOf(q.requirements);
    const entry = manifestEntryFor(mf, url);
    const sellsWindow = entry?.pricing === "subscription";
    const published = sellsWindow ? softUsd(entry?.price) : null;
    const period = sellsWindow && entry?.period != null ? String(entry.period) : undefined;

    if (!sellsWindow || published == null) {
      const total = perCallUsd == null ? null : round6(perCallUsd * calls);
      return {
        ...blank,
        perCallUsd,
        payPerCallUsd: total,
        cheaper: perCallUsd == null ? "unknown" : "per-call",
        savingsUsd: null,
        arithmetic:
          total == null
            ? "no comparison: the per-call price could not be read"
            : `${calls} calls × ${money(perCallUsd!)} = ${money(total)}, and no window is on offer`,
        reason: entry
          ? `${url} is priced per call and sells no window, so paying per call is the only option.`
          : `${originOf(url)} publishes no Ripar manifest entry for this URL, so no window could be found. ` +
            `Only the live per-call quote is known.`,
      };
    }

    // An endpoint that sells a window has no cheaper single-call price: one
    // settlement buys the window, so a caller that pays and then discards the
    // key pays the window price again on the next call. That is what makes the
    // comparison real rather than circular — the alternative to subscribing is
    // not "a small per-call fee", it is paying the window price every time.
    const windowUsd = perCallUsd ?? published;
    const payPerCallUsd = perCallUsd == null ? null : round6(perCallUsd * calls);
    const drifted = perCallUsd != null && Math.abs(perCallUsd - published) > 1e-9;
    const note =
      (drifted
        ? `The manifest publishes ${money(published)} for this window but the live quote is ${money(perCallUsd!)}; ` +
          `the live quote is what settles. `
        : "") +
      `${url} sells a ${period ?? "fixed"} window rather than single calls, and every call made without the key ` +
      `it issues settles the full window price again — so keep the key (activeSubscriptions / useSubscription).`;

    if (payPerCallUsd == null) {
      return {
        ...blank,
        window: { usd: windowUsd, period },
        arithmetic: "no comparison: the live quote could not be read",
        reason: note,
      };
    }

    const savingsUsd = round6(payPerCallUsd - windowUsd);
    return {
      url,
      expectedCalls: calls,
      perCallUsd,
      window: { usd: windowUsd, period },
      payPerCallUsd,
      cheaper: savingsUsd > 0 ? "subscribe" : savingsUsd < 0 ? "per-call" : "same",
      savingsUsd,
      breakEvenCalls: perCallUsd! > 0 ? Math.ceil(windowUsd / perCallUsd!) : null,
      arithmetic:
        `${calls} calls × ${money(perCallUsd!)} = ${money(payPerCallUsd)} unkeyed, ` +
        `vs one ${period ?? "fixed"} window at ${money(windowUsd)} → ` +
        (savingsUsd > 0
          ? `subscribe, saving ${money(savingsUsd)}`
          : savingsUsd < 0
            ? `pay per call, saving ${money(-savingsUsd)}`
            : "either; they cost the same"),
      reason: note,
    };
  }

  /**
   * Pick the first configured facilitator that is up and speaks Algorand.
   *
   * The client never pays through it — the resource server names the
   * facilitator in its own 402 — so this is for choosing what to hand `serve()`,
   * or for checking a facilitator is alive before starting a batch that depends
   * on it. See network.ts.
   */
  async facilitator(urls: string[] = this.facilitatorUrls): Promise<FacilitatorChoice> {
    return this.gate(() =>
      resolveFacilitator(urls, { network: this.network, fetchImpl: this.baseFetch })
    );
  }

  /** Every settlement this client has seen, oldest first. */
  get receipts(): ReceiptRecord[] {
    return this.receiptLedger.list();
  }

  /** USD across those receipts whose amount could be read. */
  get spentTotal(): number {
    return this.receiptLedger.totalUsd();
  }

  /** The receipts as a file: JSON, or RFC 4180 CSV with every field quoted. */
  exportReceipts(format: "json" | "csv" = "json"): string {
    return exportReceipts(this.receiptLedger.list(), format);
  }

  /**
   * Refuse a quote the wallet cannot settle, before the round trip.
   *
   * The facilitator would reject it anyway, one network hop later, with an
   * error that does not distinguish "you hold no USDC" from "you never opted
   * in to USDC" — and only one of those is fixed with money.
   */
  private async assertWalletCovers(accept: Record<string, unknown>, requirements: unknown) {
    const assetId = Number(accept.asset);
    // No asset id means the price is plain USD with no ASA behind it, so there
    // is no holding to check. Refusing here would block a payment that may be
    // perfectly good, which is worse than the round trip this saves.
    if (!Number.isInteger(assetId)) return;

    const required = String(accept.maxAmountRequired ?? accept.amount ?? "");
    if (!required) return;

    const balance = await this.balance(assetId);
    const coverage = coversPayment(balance, required);
    if (!coverage.ok) {
      // ALGO is deliberately not checked: the default facilitator sponsors the
      // network fee, so a wallet with zero ALGO and enough USDC pays perfectly
      // well, and refusing on it would break the common setup.
      throw new RiparError(coverage.message, coverage.code, 402, requirements);
    }
  }

  /** Both wallet guards, applied to a quote before anything is signed. */
  private assertAffordable(asked: number, requirements: unknown) {
    if (this.maxPrice != null && asked > this.maxPrice) {
      throw new RiparError(
        `Quoted $${asked.toFixed(6)} but maxPrice is $${this.maxPrice.toFixed(6)}. Refusing to pay.`,
        "price_above_max",
        402,
        requirements
      );
    }
    if (this.ledger && !this.ledger.wouldFit(asked)) {
      throw new RiparError(
        `Quoted $${asked.toFixed(6)} but only $${this.ledger.remaining().toFixed(6)} of the $${this.ledger.limitUsd.toFixed(
          6
        )} daily cap is left. Refusing to pay.`,
        "daily_cap_reached",
        402,
        requirements
      );
    }
  }
}

function parseUsd(v: string, field: string) {
  const n = Number(String(v).replace("$", ""));
  if (!Number.isFinite(n)) throw new RiparError(`${field} "${v}" is not a number.`, "invalid_max_price");
  if (n <= 0) throw new RiparError(`${field} "${v}" must be greater than zero.`, "invalid_max_price");
  return n;
}

function readReceipt(res: Response): CallResult["payment"] {
  const receipt = readReceiptHeader((name) => res.headers.get(name));
  if (!receipt) return undefined;
  return { txId: receipt.txId, amount: receipt.amount, usd: receipt.usd, asset: receipt.asset };
}

/**
 * Pull a USD amount out of whatever shape the requirements arrived in.
 *
 * An `accepts` entry carrying an `asset` states its `amount` in that asset's
 * atomic units — 102000 means $0.102 of USDC, not $102000. Reading it as USD is
 * the difference between a cap that works and one that never fires.
 */
export function priceOf(req: unknown): number | null {
  return pickAccept(req)?.usd ?? null;
}

/**
 * The entry the price came from, alongside the price.
 *
 * The balance preflight needs the asset id and the atomic amount, and they have
 * to come from the SAME entry the cap approved — an `accepts` list can offer
 * several assets, and checking the holding of one while paying in another is a
 * check that passes for the wrong reason.
 */
export function pickAccept(req: unknown): { accept: Record<string, any>; usd: number } | null {
  if (!req || typeof req !== "object") return null;
  const anyReq = req as Record<string, any>;
  const accepts = anyReq.accepts ?? anyReq;
  const list = Array.isArray(accepts) ? accepts : [accepts];
  for (const a of list) {
    const usd = usdOfAccept(a);
    if (usd != null && a && typeof a === "object") return { accept: a as Record<string, any>, usd };
  }
  return null;
}

/** A bare URL is the common case: no body, no init. */
function toItem(raw: string | CallItem): CallItem {
  return typeof raw === "string" ? { url: raw } : raw;
}

/** Batch results carry an error object, not a rejection, so anything thrown has
 *  to arrive as one — including the SyntaxError a malformed JSON body throws
 *  well outside this SDK's own error paths. */
function asRiparError(err: unknown, url: string): RiparError {
  if (err instanceof RiparError) return err;
  return new RiparError(`Call to ${url} failed: ${(err as Error)?.message ?? String(err)}`, "call_failed", undefined, err);
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

type ManifestEndpoint = { url?: string; price?: unknown; pricing?: string; period?: unknown };

/**
 * The manifest line describing this URL.
 *
 * Matched on the full origin+path first and on the path alone second: a
 * manifest advertises the URL callers reach it on, which behind a proxy is not
 * the host the caller happens to be using. Falling back to the path keeps the
 * lookup working there, and an agent serves its own endpoints so the path
 * cannot collide with a different agent's.
 */
function manifestEntryFor(mf: unknown, url: string): ManifestEndpoint | undefined {
  const endpoints = (mf as { endpoints?: ManifestEndpoint[] } | null)?.endpoints;
  if (!Array.isArray(endpoints)) return undefined;
  const want = canonical(url);
  const wantPath = pathOf(url);
  return (
    endpoints.find((e) => e.url && canonical(String(e.url)) === want) ??
    endpoints.find((e) => e.url && pathOf(String(e.url)) === wantPath)
  );
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/\/$/, "");
  } catch {
    return url;
  }
}

/** A published price that may not be a number at all: a manifest prints
 *  "dynamic" where the price is a function, and budgeting off that string as if
 *  it were zero is how a plan comes out free. */
function softUsd(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(String(v).replace("$", "").trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function money(n: number) {
  return `$${n.toFixed(6)}`;
}

/** Six decimals is USDC's own precision, so rounding there cannot lose a real
 *  payment while it does remove the float dust that makes a total look wrong. */
function round6(n: number) {
  return Number(n.toFixed(6));
}

function mnemonicToKey(mnemonic: string): Uint8Array {
  const account = algosdk.mnemonicToSecretKey(mnemonic.trim());
  return account.sk;
}

type StoredKey = { value: string; expiresAt?: string; endpoint?: string };

export type Subscription = {
  key: StoredKey;
  /** ISO 8601, from the server. Undefined only if the server omitted it. */
  expiresAt?: string;
  endpoint?: string;
  payment?: CallResult["payment"];
};

/** A key with a known expiry in the past. Unknown expiry counts as live —
 *  see the note at the call site for why that is the safe direction. */
function isExpired(k: StoredKey, now = Date.now()): boolean {
  if (!k.expiresAt) return false;
  const t = Date.parse(k.expiresAt);
  return Number.isFinite(t) && t <= now;
}

/** Keys are scoped per endpoint URL. Query and hash do not change which
 *  endpoint is being called, so they must not split the cache and cause a
 *  second window to be bought for the same thing. */
function canonical(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return url;
  }
}
