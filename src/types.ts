/**
 * The shapes a developer actually touches. Kept in one file so the public
 * surface can be read in a minute, which is the whole pitch of the SDK.
 */

// Re-exported from @x402/avm rather than transcribed. CAIP-2 caps the network
// reference at 32 characters, so the constant is a TRUNCATED genesis hash — it
// does not equal the full hash the facilitator prints under /supported. Copying
// that string by hand produces an id the scheme never matches, and payments
// then fail in a way that looks like a facilitator problem.
export { ALGORAND_MAINNET_CAIP2 as ALGORAND_MAINNET, ALGORAND_TESTNET_CAIP2 as ALGORAND_TESTNET } from "@x402/avm";
import {
  ALGORAND_MAINNET_CAIP2,
  ALGORAND_TESTNET_CAIP2,
  USDC_MAINNET_ASA_ID,
  USDC_TESTNET_ASA_ID,
} from "@x402/avm";

export type Network = "mainnet" | "testnet";

export const CAIP2 = {
  mainnet: ALGORAND_MAINNET_CAIP2,
  testnet: ALGORAND_TESTNET_CAIP2,
} as const satisfies Record<Network, `${string}:${string}`>;

/** USDC as an Algorand ASA, taken from the mechanism package so the two cannot
 *  drift. Different id per network — the wrong one silently never settles. */
export const USDC_ASSET_ID: Record<Network, number> = {
  mainnet: Number(USDC_MAINNET_ASA_ID),
  testnet: Number(USDC_TESTNET_ASA_ID),
};

export const DEFAULT_FACILITATOR = "https://facilitator.goplausible.xyz";

/** A JSON Schema fragment describing the request body. Published to discovery,
 *  which is what lets an agent build a valid call without reading docs. */
export type InputSchema = {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
};

export type HandlerContext<B = unknown> = {
  body: B;
  headers: Record<string, string | undefined>;
  query: Record<string, unknown>;
  /** Written to the execution record for this request. */
  log: (message: string, data?: Record<string, unknown>) => void;
  /** Present once payment has been verified and settled. `amount` is atomic
   *  units of `asset` — `usd` is that converted, when the decimals are known. */
  payment?: { txId?: string; payer?: string; amount: string; usd?: number; asset: string };
};

export type Handler<B = any, R = unknown> = (ctx: HandlerContext<B>) => R | Promise<R>;

/** What a price function is handed. Deliberately narrower than HandlerContext:
 *  pricing must be decidable from the request alone, before anything runs. */
export type PriceContext<B = any> = {
  body: B;
  query: Record<string, unknown>;
  header: (name: string) => string | undefined;
};

/** Quoted per request, so a big job can cost more than a small one. Returns the
 *  same "$0.01" string a fixed price uses. */
export type PriceFn<B = any> = (ctx: PriceContext<B>) => string | Promise<string>;

/**
 * Price is a USD-denominated string ("$0.01") because that is what the x402
 * `accepts` block takes; the facilitator converts to the asset's base units.
 * A function is evaluated per request and quoted in that request's 402.
 */
export type Price<B = any> = string | PriceFn<B>;

export type SubscriptionSpec = {
  /** What the window costs, quoted once. "$5.00". */
  price: string;
  /** How long it lasts: "30d", "24h", "90m", or milliseconds. */
  period: string | number;
};

type EndpointBase<B = any, R = unknown> = {
  /** URL segment and discovery name. Lowercase, slash-separated. */
  name: string;
  /** One line a stranger's agent can use to decide whether this is what it needs. */
  description?: string;
  /** What discovery shows when `price` is a function — a range or a formula, so
   *  a browsing agent still learns roughly what it will pay. */
  priceHint?: string;
  method?: "GET" | "POST";
  input?: InputSchema;
  /** Milliseconds before the call is abandoned. A timeout is a 504, and any
   *  status >= 400 cancels settlement, so an abandoned call is never charged. */
  timeout?: number;
  /** Publish to the discovery index. Private endpoints still take payment. */
  listed?: boolean;
  tags?: string[];
  handler: Handler<B, R>;
};

/**
 * An endpoint charges per call or sells a window, never both — the two answer
 * the same question ("what does this cost?") with different numbers, and a
 * definition carrying both leaves the 402 ambiguous. Expressed as a union so
 * the mistake is a compile error rather than a surprise at runtime.
 */
export type EndpointDef<B = any, R = unknown> = EndpointBase<B, R> &
  (
    | { price: Price<B>; subscription?: undefined }
    | {
        price?: undefined;
        /** One settlement buys a key that opens this endpoint free until it
         *  expires. x402 has no recurring scheme and nothing can pull from a
         *  wallet later, so renewal is another deliberate payment. */
        subscription: SubscriptionSpec;
      }
  );

/** What an agent bids on and executes. An agent is a bundle of endpoints plus
 *  the metadata a marketplace needs to rank and route to it. */
export type AgentDef = {
  name: string;
  handle: string;
  description: string;
  version?: string;
  skills?: string[];
  /** Algorand address that receives settlement. */
  payTo: string;
  network?: Network;
  endpoints: EndpointDef[];
  /** Optional: bid on Orchestrator jobs matching these tags. */
  bidsOn?: string[];
};

/**
 * Caps how often one caller may invoke paid endpoints.
 *
 * `per: "payer"` keys on the Algorand address inside the X-PAYMENT header, so a
 * caller cannot escape the limit by changing IP; requests with no payment header
 * carry no payer and are neither counted nor limited — they cannot reach a
 * handler anyway. `per: "ip"` keys on the socket address and counts every
 * request to a paid route, which is the mode that stops a flood from one host.
 */
export type RateLimitOptions = {
  perMinute: number;
  per?: "payer" | "ip";
};

/** Replay protection for callers that retry. A cached response is returned
 *  without re-entering the payment middleware, so a retry is never charged. */
export type IdempotencyOptions = {
  /** How long a completed response stays replayable. Default 10 minutes. */
  windowMs?: number;
  /** Cap on stored responses; oldest evicted first. Default 500. */
  max?: number;
};

/** One line of the execution record served at GET /_ripar/runs. */
export type RunRecord = {
  id: string;
  endpoint: string;
  status: number;
  ms: number;
  txId?: string;
  at: string;
};

import type { SubscriptionStore } from "./subscriptions.js";

export type ServeOptions = {
  port?: number;
  /** Defaults to the GoPlausible facilitator, which sponsors network fees. */
  facilitatorUrl?: string;
  network?: Network;
  payTo?: string;
  /** Mount prefix for every endpoint. */
  basePath?: string;
  rateLimit?: RateLimitOptions;
  /** Enabled by passing an object; omitted means retries re-run and re-pay. */
  idempotency?: IdempotencyOptions;
  /** Size of the ring buffer behind GET /_ripar/runs. Default 100. */
  runsCapacity?: number;
  /** Milliseconds SIGTERM waits for in-flight work before killing sockets. */
  shutdownTimeoutMs?: number;
  /** Register SIGTERM/SIGINT handlers in `serve()`. Default true. */
  handleSignals?: boolean;
  /** Called once draining finishes. Defaults to exiting the process — override
   *  it when the agent is embedded in something that owns its own lifecycle. */
  onShutdown?: (result: { reason: string; outcome: "drained" | "timeout"; abandoned: number; ms: number }) => void;
  /** Where issued subscription keys live. The default is in-memory, which is
   *  correct for one process and wrong for several — a key minted on replica A
   *  is unknown to B, so the caller is asked to pay twice. Pass a shared store
   *  (Redis, a table, KV) for anything running more than one instance. */
  subscriptions?: { store?: SubscriptionStore };
  /** Called once the server is listening. */
  onReady?: (info: { port: number; routes: string[]; network: Network }) => void;
};

export class RiparError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    readonly detail?: unknown
  ) {
    super(message);
    this.name = "RiparError";
  }
}
