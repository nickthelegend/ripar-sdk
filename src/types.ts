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
  /** Present once payment has been verified and settled. */
  payment?: { txId?: string; payer?: string; amount: string; asset: string };
};

export type Handler<B = any, R = unknown> = (ctx: HandlerContext<B>) => R | Promise<R>;

/**
 * Price is a USD-denominated string ("$0.01") because that is what the x402
 * `accepts` block takes; the facilitator converts to the asset's base units.
 */
export type Price = string;

export type EndpointDef<B = any, R = unknown> = {
  /** URL segment and discovery name. Lowercase, slash-separated. */
  name: string;
  /** One line a stranger's agent can use to decide whether this is what it needs. */
  description?: string;
  price: Price;
  method?: "GET" | "POST";
  input?: InputSchema;
  /** Milliseconds before the call is abandoned and the caller refunded. */
  timeout?: number;
  /** Publish to the discovery index. Private endpoints still take payment. */
  listed?: boolean;
  tags?: string[];
  handler: Handler<B, R>;
};

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

export type ServeOptions = {
  port?: number;
  /** Defaults to the GoPlausible facilitator, which sponsors network fees. */
  facilitatorUrl?: string;
  network?: Network;
  payTo?: string;
  /** Mount prefix for every endpoint. */
  basePath?: string;
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
