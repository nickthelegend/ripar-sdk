import { x402Client } from "@x402/core/client";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { toClientAvmSigner } from "@x402/avm";
import { wrapFetchWithPayment } from "@x402/fetch";
import algosdk from "algosdk";
import { CAIP2, RiparError, type Network } from "./types.js";

export type ClientOptions = {
  /** 25-word Algorand mnemonic, or a raw 64-byte secret key. */
  mnemonic?: string;
  secretKey?: Uint8Array;
  network?: Network;
  /** Refuse any quote above this, in USD. The single most important guard when
   *  something autonomous holds the wallet. */
  maxPrice?: string;
  fetchImpl?: typeof fetch;
};

export type CallResult<T = unknown> = {
  data: T;
  /** Present when the call was actually paid for. */
  payment?: { txId?: string; amount?: string; asset?: string };
  status: number;
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
  private readonly baseFetch: typeof fetch;
  private paidFetch?: typeof fetch;

  constructor(opts: ClientOptions = {}) {
    this.network = opts.network ?? "mainnet";
    this.maxPrice = opts.maxPrice != null ? parseUsd(opts.maxPrice) : undefined;
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
      const client = new x402Client().register(CAIP2[this.network], new ExactAvmScheme(signer));
      this.paidFetch = wrapFetchWithPayment(this.baseFetch, client) as typeof fetch;
    }
  }

  /** Read the price without paying and without a wallet. */
  async quote(url: string, init: RequestInit = {}) {
    const res = await this.baseFetch(url, { method: "POST", ...init });
    if (res.status !== 402) {
      return { paymentRequired: false as const, status: res.status };
    }
    const header = res.headers.get("X-Payment-Required") ?? res.headers.get("x-payment-required");
    let requirements: unknown = null;
    if (header) {
      try {
        requirements = JSON.parse(header);
      } catch {
        /* some servers put the requirements in the body instead */
      }
    }
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
    if (this.maxPrice != null) {
      const q = await this.quote(url, { ...init, body: body ? JSON.stringify(body) : undefined });
      if (q.paymentRequired) {
        const asked = priceOf(q.requirements);
        if (asked != null && asked > this.maxPrice) {
          throw new RiparError(
            `Quoted $${asked.toFixed(6)} but maxPrice is $${this.maxPrice.toFixed(6)}. Refusing to pay.`,
            "price_above_max",
            402,
            q.requirements
          );
        }
      }
    }

    const res = await this.paidFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
      ...init,
      body: body != null ? JSON.stringify(body) : (init.body as BodyInit | undefined),
    });

    const payHeader = res.headers.get("X-Payment-Response") ?? res.headers.get("x-payment-response");
    let payment: CallResult["payment"];
    if (payHeader) {
      try {
        const p = JSON.parse(payHeader);
        payment = { txId: p.txId ?? p.transaction, amount: p.amount, asset: p.asset ?? "USDC" };
      } catch {
        /* the call still succeeded; we just cannot attribute the receipt */
      }
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new RiparError(`Call failed with ${res.status}.`, "call_failed", res.status, detail);
    }

    return { data: (await res.json()) as T, payment, status: res.status };
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
}

function parseUsd(v: string) {
  const n = Number(String(v).replace("$", ""));
  if (!Number.isFinite(n)) throw new RiparError(`maxPrice "${v}" is not a number.`, "invalid_max_price");
  return n;
}

/** Pull a USD amount out of whatever shape the requirements arrived in. */
export function priceOf(req: unknown): number | null {
  if (!req || typeof req !== "object") return null;
  const anyReq = req as Record<string, any>;
  const accepts = anyReq.accepts ?? anyReq;
  const list = Array.isArray(accepts) ? accepts : [accepts];
  for (const a of list) {
    const raw = a?.price ?? a?.maxAmountRequired ?? a?.amount;
    if (raw == null) continue;
    const n = Number(String(raw).replace("$", ""));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function mnemonicToKey(mnemonic: string): Uint8Array {
  const account = algosdk.mnemonicToSecretKey(mnemonic.trim());
  return account.sk;
}
