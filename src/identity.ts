import { decodeTransaction, getSenderFromTransaction, isExactAvmPayload } from "@x402/avm";

/**
 * Who is paying, read from the X-PAYMENT header before the facilitator has
 * verified anything.
 *
 * Nothing here checks a signature, so treat the result as a *claim*, not proof.
 * It is good enough to bucket rate limits for honest callers and it cannot buy a
 * call — the payment middleware still has to verify and settle. It is not an
 * authorisation decision, and must never become one.
 *
 * KNOWN GAP: the plain-field branch below returns an attacker-controlled string
 * verbatim. Anyone can send `{"payload":{"payer":"<your customer>"}}` — no
 * signature, no funds — and consume that customer's per-minute budget until they
 * are locked out with a 429. Algorand addresses are public, so the input is not
 * a secret. Closing this needs the identity verified before the limiter counts
 * it, which means either doing the signature check here or moving the limiter
 * behind the payment middleware (where a rejected request no longer costs the
 * attacker nothing). Both are design changes, not tweaks.
 *
 * Returns null for a request with no payment attached; a caller who is only
 * asking the price has no payer yet.
 */
export function payerFromPaymentHeader(header: string | undefined | null): string | null {
  const envelope = decodeEnvelope(header);
  if (!envelope) return null;

  const payload = (envelope as { payload?: unknown }).payload ?? envelope;

  if (isExactAvmPayload(payload)) {
    const encoded = payload.paymentGroup[payload.paymentIndex];
    if (typeof encoded === "string") {
      const sender = senderOf(encoded);
      if (sender) return sender;
    }
  }

  // Non-AVM schemes put the payer in a plain field. Reading it keeps the limiter
  // working if this server ever registers a second scheme — but it is also the
  // spoofable branch described above, and today `serve()` registers only
  // ExactAvmScheme, so it is currently pure attack surface.
  for (const key of ["payer", "from", "sender"] as const) {
    const v = (payload as Record<string, unknown>)?.[key];
    if (typeof v === "string" && v.length > 0) return v;
  }

  return null;
}

/** The header is base64 JSON, but some clients send the JSON unencoded. Trying
 *  both is cheaper than being wrong about which one arrived. */
function decodeEnvelope(header: string | undefined | null): unknown {
  if (!header) return null;
  const raw = header.trim();
  if (!raw) return null;

  if (raw.startsWith("{")) {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  try {
    return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function senderOf(encodedTxn: string): string | null {
  const bytes = (() => {
    try {
      return decodeTransaction(encodedTxn);
    } catch {
      return null;
    }
  })();
  if (!bytes) return null;

  // The payment transaction is signed by the caller, but the fee-payer slot in
  // the same group is not — so fall back rather than give up on an unsigned one.
  for (const signed of [true, false]) {
    try {
      const addr = getSenderFromTransaction(bytes, signed);
      if (addr) return addr;
    } catch {
      /* try the other encoding */
    }
  }
  return null;
}
