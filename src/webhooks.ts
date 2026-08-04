import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Tell somebody else when money moves.
 *
 * An agent's operator usually wants settlement in their own systems — a ledger,
 * a Slack channel, an invoice run — and polling `/metrics` for a counter that
 * went up tells you a payment happened but not which one.
 *
 * Two properties this has to have, and both are about not making things worse:
 *
 * It never blocks the response. A webhook receiver that hangs would otherwise
 * hold the caller's connection open past the point where they have already paid
 * and are waiting for work they have bought. Delivery is fired after the
 * response is flushed, and a failure is reported through `onError` rather than
 * thrown into a request that already succeeded.
 *
 * It is signed. An unsigned webhook is an open endpoint on the receiver's side
 * that anyone who guesses the URL can post fabricated settlements to — which,
 * for something wired into a ledger, is worse than no webhook at all.
 */

export type SettlementEvent = {
  type: "settlement";
  endpoint: string;
  txId?: string;
  payer?: string;
  /** Atomic units, as the facilitator reported them. */
  amount?: string;
  asset?: string;
  /** The QUOTE in USD — what the caller agreed to, not the receipt's `amount`,
   *  which facilitators report in different units on different networks. */
  usd: number;
  status: number;
  ms: number;
  at: string;
};

export type WebhookOptions = {
  url: string;
  /** Shared secret. Without one, `X-Ripar-Signature` is absent and a receiver
   *  has no way to tell a real event from a forged one. */
  secret?: string;
  /** Abandon a delivery after this long. Default 5s. */
  timeoutMs?: number;
  /** Attempts per event, with backoff. Default 3. */
  attempts?: number;
  /** Called when every attempt failed. Delivery is best-effort by design, so
   *  this is the only place a caller learns an event was lost. */
  onError?: (err: Error, event: SettlementEvent) => void;
  fetchImpl?: typeof fetch;
};

/**
 * `sha256=<hex>` over `<timestamp>.<body>`.
 *
 * The timestamp is inside the signed material, not merely alongside it — a
 * signature over the body alone can be replayed forever, and a receiver has no
 * way to notice. This is the same construction Stripe and GitHub use, for the
 * same reason.
 */
export function signPayload(body: string, secret: string, timestamp: number): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/**
 * Verify a delivery. Exported because the receiving half is the half people
 * get wrong, and shipping it means nobody has to reimplement HMAC comparison.
 *
 * `toleranceSecs` bounds replay: a signature stays valid forever otherwise.
 */
export function verifySignature(
  body: string,
  signature: string,
  secret: string,
  timestamp: number,
  toleranceSecs = 300,
  now = Math.floor(Date.now() / 1000)
): boolean {
  if (Math.abs(now - timestamp) > toleranceSecs) return false;
  const expected = signPayload(body, secret, timestamp);
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  // Length must match before timingSafeEqual, which throws on a mismatch —
  // and comparing with === would leak the answer one byte at a time.
  return a.length === b.length && timingSafeEqual(a, b);
}

export class WebhookSender {
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private readonly doFetch: typeof fetch;
  /** Deliveries still in flight, so a shutdown can wait for them. */
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly opts: WebhookOptions) {
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.attempts = Math.max(1, opts.attempts ?? 3);
    this.doFetch = opts.fetchImpl ?? globalThis.fetch;
  }

  /** Fire and forget. Returns immediately; never throws into the request. */
  send(event: SettlementEvent): void {
    const p = this.deliver(event)
      .catch((err) => this.opts.onError?.(err as Error, event))
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  /** Wait for in-flight deliveries. Called by the drain, so a SIGTERM does not
   *  drop an event about money that already moved. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }

  get inFlight() {
    return this.pending.size;
  }

  private async deliver(event: SettlementEvent): Promise<void> {
    const body = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-ripar-event": event.type,
      "x-ripar-timestamp": String(timestamp),
    };
    if (this.opts.secret) headers["x-ripar-signature"] = signPayload(body, this.opts.secret, timestamp);

    let last: Error | undefined;
    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
      try {
        const res = await this.doFetch(this.opts.url, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });
        if (res.ok) return;
        // A 4xx means the receiver rejected this event and will reject it
        // again — retrying is just noise. Only 5xx and transport failures get
        // another go.
        if (res.status < 500) throw new Error(`receiver returned ${res.status}`);
        last = new Error(`receiver returned ${res.status}`);
      } catch (err) {
        last = err as Error;
        if (String(last.message).includes("returned 4")) break;
      } finally {
        clearTimeout(timer);
      }
      if (attempt < this.attempts) {
        await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)));
      }
    }
    throw last ?? new Error("delivery failed");
  }
}
