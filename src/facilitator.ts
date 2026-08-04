import { AsyncLocalStorage } from "node:async_hooks";
import type { FacilitatorClient } from "@x402/core/server";

/**
 * What a caller is told when the facilitator, not the agent, is what broke.
 *
 * MEASURED against @x402/express 2.20: when the facilitator is unreachable or
 * answers 5xx, the middleware answers **402 with an empty body** — with a fresh
 * PAYMENT-REQUIRED header on the verify path, and a PAYMENT-RESPONSE carrying
 * `success: false` on the settle path. From the caller's side that is
 * indistinguishable from "your payment was rejected, here is the quote again",
 * so a well-behaved client re-signs and retries, and keeps doing it for as long
 * as the outage lasts. The one thing it must not conclude — "the payment layer
 * is down, back off" — is the one thing the response does not say.
 *
 * So facilitator calls are watched, and a request whose payment step failed
 * because of the facilitator is answered 503 with `Retry-After` and a body that
 * says plainly which half is broken. 503 is the status every HTTP client,
 * proxy and retry library already treats as "come back later"; 402 is the one
 * they all treat as "pay again".
 *
 * The watch is an AsyncLocalStorage rather than a flag on the client, because
 * two requests can be inside the middleware at once and a shared flag would
 * fail the wrong one.
 */

export type FacilitatorStage = "verify" | "settle" | "supported";

export type FacilitatorOutage = {
  stage: FacilitatorStage;
  message: string;
  /** The HTTP status the facilitator returned, when it returned one at all. */
  status?: number;
};

const store = new AsyncLocalStorage<{ outage?: FacilitatorOutage }>();

/** Run the payment middleware inside a scope that collects facilitator
 *  failures for THIS request. */
export function watchingFacilitator<T>(fn: () => T): T {
  return store.run({}, fn);
}

/** The outage recorded during this request, if any. */
export function facilitatorOutage(): FacilitatorOutage | undefined {
  return store.getStore()?.outage;
}

/**
 * Wraps the facilitator client so a transport failure or a 5xx is recorded
 * before it is rethrown.
 *
 * Rethrown unchanged, deliberately: x402 has its own handling for every one of
 * these and swallowing them here would change which payments settle. This only
 * watches.
 */
export function watchFacilitator(inner: FacilitatorClient): FacilitatorClient {
  return {
    verify: (payload, requirements) => record("verify", () => inner.verify(payload, requirements)),
    settle: (payload, requirements) => record("settle", () => inner.settle(payload, requirements)),
    getSupported: () => record("supported", () => inner.getSupported()),
  };
}

async function record<T>(stage: FacilitatorStage, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const outage = classify(stage, err);
    if (outage) {
      const box = store.getStore();
      // First failure wins: a settle that fails after a verify that failed is
      // the same outage, and the earlier stage is the one that explains it.
      if (box && !box.outage) box.outage = outage;
    }
    throw err;
  }
}

/**
 * An outage, or a payment the facilitator legitimately refused.
 *
 * The distinction is the whole feature. "isValid: false" means the caller's
 * payment is bad and 402 is the correct, actionable answer; ECONNREFUSED means
 * nobody looked at the payment at all. Answering the first as 503 would tell a
 * caller to retry a payment that will never be accepted, which is the same bug
 * in the other direction.
 */
function classify(stage: FacilitatorStage, err: unknown): FacilitatorOutage | null {
  const e = err as { message?: string; statusCode?: number; status?: number; name?: string; cause?: { code?: string } };
  const message = String(e?.message ?? err);

  // VerifyError and SettleError carry the facilitator's HTTP status. A 4xx is a
  // verdict about this payment; a 5xx is the facilitator failing to reach one.
  const status = typeof e?.statusCode === "number" ? e.statusCode : e?.status;
  if (typeof status === "number") {
    return status >= 500 ? { stage, message, status } : null;
  }

  // The client throws a plain Error naming the status for a non-JSON error body,
  // which is exactly what a load balancer's 502/503 page looks like.
  const fromMessage = /failed \((\d{3})\)/.exec(message);
  if (fromMessage) {
    const code = Number(fromMessage[1]);
    return code >= 500 ? { stage, message, status: code } : null;
  }

  // Transport: nothing answered. undici reports these as "fetch failed" with the
  // real reason on `cause`, which is the only place the operator-useful detail
  // (ECONNREFUSED vs ENOTFOUND vs a timeout) survives.
  const cause = e?.cause?.code;
  if (cause || e?.name === "AbortError" || /fetch failed|network|socket|ECONN|ETIMEDOUT|EAI_AGAIN/i.test(message)) {
    return { stage, message: cause ? `${message} (${cause})` : message };
  }

  // Anything else is a bug in this SDK or in x402, and dressing it as a
  // facilitator outage would send an operator looking in the wrong place.
  return null;
}

/** The body a 503 carries. Separate so a test can assert on the wording that
 *  actually tells an operator which half to go and look at. */
export function outageBody(outage: FacilitatorOutage, facilitatorUrl: string, retryAfter: number) {
  return {
    error: {
      code: "facilitator_unavailable",
      message:
        `This endpoint is working. The payment layer is not: the facilitator at ${facilitatorUrl} ` +
        `could not be reached to ${outage.stage === "settle" ? "settle" : "verify"} your payment ` +
        `(${outage.message}). Retry in ${retryAfter}s.`,
      // The two stages have genuinely different consequences and a caller has to
      // be told which one happened. A failed verify moved nothing. A failed
      // settle happened AFTER the payment was accepted, so the transfer may or
      // may not be on chain, and "just retry" could pay twice.
      stage: outage.stage,
      settlementAttempted: outage.stage === "settle",
      facilitator: facilitatorUrl,
      retryAfter,
      ...(outage.status ? { facilitatorStatus: outage.status } : {}),
    },
  };
}
