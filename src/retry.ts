export type RetryOptions = {
  /** Total attempts including the first. 1 disables retrying. Default 3. */
  attempts?: number;
  /** First backoff, doubled each attempt. Default 250ms. */
  baseMs?: number;
  /** Ceiling for a single wait. Default 8s. */
  maxMs?: number;
};

export const DEFAULT_RETRY: Required<RetryOptions> = { attempts: 3, baseMs: 250, maxMs: 8_000 };

/**
 * Whether a failed call is worth repeating.
 *
 * The 4xx exclusion is a money rule, not a style rule. A 402 is the payment
 * handshake and the wrapped fetch already answered it; a 400 means the body is
 * wrong and will be wrong again; a 409 means the idempotency key clashed.
 * Retrying any of them burns another quote at best and pays twice at worst.
 * 5xx and transport failures are the only cases where the same request might
 * genuinely succeed — and under x402 a 5xx refunded the caller, so the retry
 * costs them nothing extra.
 *
 * 429 is excluded too: the server named a Retry-After, and hammering through it
 * is how a client gets itself banned.
 */
export function isRetryable(status: number | null): boolean {
  if (status == null) return true; // no response at all: DNS, reset, timeout
  return status >= 500 && status <= 599;
}

/**
 * Exponential backoff with full jitter.
 *
 * Equal-jitter and no-jitter schedules re-synchronise every client that failed
 * at the same moment, so a recovering agent gets hit by the whole herd on the
 * same tick. Full jitter — a uniform draw over the whole window — spreads them
 * out, and costs one multiplication.
 */
export function backoffDelay(
  attempt: number,
  opts: RetryOptions = {},
  random: () => number = Math.random
): number {
  const { baseMs, maxMs } = { ...DEFAULT_RETRY, ...opts };
  const window = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(random() * window);
}

export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
