import { x402Client } from "@x402/core/client";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { toClientAvmSigner } from "@x402/avm";
import { wrapFetchWithPayment } from "@x402/fetch";
import algosdk from "algosdk";
import { readPaymentRequired, readReceiptHeader, usdOfAccept } from "./headers.js";
import { DEFAULT_RETRY, backoffDelay, isRetryable, sleep, type RetryOptions } from "./retry.js";
import { SpendLedger } from "./spend.js";
import { CAIP2, RiparError, type Network } from "./types.js";

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

  constructor(opts: ClientOptions = {}) {
    this.network = opts.network ?? "mainnet";
    this.maxPrice = opts.maxPrice != null ? parseUsd(opts.maxPrice, "maxPrice") : undefined;
    this.ledger = opts.maxPerDay != null ? new SpendLedger(parseUsd(opts.maxPerDay, "maxPerDay")) : undefined;
    this.retry = opts.retry ?? DEFAULT_RETRY;
    this.baseFetch = opts.fetchImpl ?? globalThis.fetch;

    // toClientAvmSigner takes a BASE64 64-byte key, not raw bytes — passing a
    // Uint8Array typechecks as `any` in JS and fails at signing time.
    const keyB64 = opts.secretKey
      ? Buffer.from(opts.secretKey).toString("base64")
      : opts.mnemonic
        ? Buffer.from(mnemonicToKey(opts.mnemonic)).toString("base64")
        : undefined;
    if (keyB64) {
      const signer = toClientAvmSigner(keyB64);
      // MUST be the wildcard, not CAIP2[network]. @x402/core matches a
      // registration by exact key or glob and has no prefix fallback, while
      // CAIP-2 caps a reference at 32 chars so the constant is a TRUNCATED
      // genesis hash (41 chars) and every facilitator quotes the full one (53).
      // Registering the constant means no scheme is ever found and the client
      // cannot pay anything — server.ts already uses the wildcard for exactly
      // this reason; the client was missed.
      const client = new x402Client().register("algorand:*", new ExactAvmScheme(signer));
      this.paidFetch = wrapFetchWithPayment(this.baseFetch, client) as typeof fetch;
    }
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
  async quote(url: string, init: RequestInit = {}) {
    // A body with no content-type is a body the server will not parse, and an
    // unparsed body means a dynamic price is quoted from `{}` — the same number
    // for every request, which looks like the feature is simply not working.
    const headers =
      init.body != null ? { "content-type": "application/json", ...(init.headers ?? {}) } : init.headers;
    const res = await this.baseFetch(url, { method: "POST", ...init, headers });
    if (res.status !== 402) {
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
    return { paymentRequired: true as const, status: 402, requirements };
  }

  /** Call a paid endpoint, settling it. Throws if no signer was configured. */
  async call<T = unknown>(url: string, body?: unknown, init: RequestInit = {}): Promise<CallResult<T>> {
    if (!this.paidFetch) {
      throw new RiparError(
        "This client has no signer, so it can read quotes but cannot pay. Construct RiparClient with a mnemonic or secretKey.",
        "no_signer"
      );
    }

    // Check the price BEFORE paying — the wrapped fetch would otherwise settle
    // whatever it is quoted, which is exactly the runaway we want to prevent.
    let quoted: number | null = null;
    if (this.maxPrice != null || this.ledger) {
      const q = await this.quote(url, { ...init, body: body != null ? JSON.stringify(body) : undefined });
      if (q.paymentRequired) {
        quoted = priceOf(q.requirements);
        if (quoted == null) {
          // Fail closed. A cap that cannot read the quote must refuse, not pay
          // an amount it never saw.
          throw new RiparError(
            `${url} asked for payment but the quote could not be read, and this client has a spending limit. Refusing to pay blind.`,
            "unreadable_quote",
            402,
            q.requirements
          );
        }
        this.assertAffordable(quoted, q.requirements);
      }
    }

    const attempts = this.retry === false ? 1 : Math.max(1, this.retry.attempts ?? DEFAULT_RETRY.attempts);
    let lastError: RiparError | undefined;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      let res: Response;
      try {
        res = await this.paidFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(init.headers ?? {}) },
          ...init,
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

      if (res.ok) {
        return { data: (await res.json()) as T, payment, status: res.status, attempts: attempt };
      }

      const detail = await res.text().catch(() => "");
      lastError = new RiparError(`Call failed with ${res.status}.`, "call_failed", res.status, detail);

      // A 4xx is the server saying "this request is wrong". Sending it again
      // changes nothing and may pay again; only 5xx gets another go.
      if (!isRetryable(res.status) || attempt === attempts) throw lastError;

      const wait = backoffDelay(attempt, this.retry === false ? {} : this.retry);
      await sleep(wait);
    }

    throw lastError ?? new RiparError(`Call to ${url} failed.`, "call_failed");
  }

  /** Read an agent's manifest — free, and how discovery starts. */
  async discover(baseUrl: string) {
    const url = `${baseUrl.replace(/\/$/, "")}/.well-known/ripar.json`;
    const res = await this.baseFetch(url);
    if (!res.ok) {
      throw new RiparError(`No Ripar manifest at ${url} (${res.status}).`, "no_manifest", res.status);
    }
    return res.json();
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
  if (!req || typeof req !== "object") return null;
  const anyReq = req as Record<string, any>;
  const accepts = anyReq.accepts ?? anyReq;
  const list = Array.isArray(accepts) ? accepts : [accepts];
  for (const a of list) {
    const usd = usdOfAccept(a);
    if (usd != null) return usd;
  }
  return null;
}

function mnemonicToKey(mnemonic: string): Uint8Array {
  const account = algosdk.mnemonicToSecretKey(mnemonic.trim());
  return account.sk;
}
