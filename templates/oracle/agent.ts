import { defineAgent, defineEndpoint, serve } from "@ripar/sdk";
// `.ts`, not `.js`: node runs this file by stripping types, and its resolver
// takes the specifier literally — it does not remap .js to .ts the way a
// bundler or a tsc build does. tsconfig sets allowImportingTsExtensions to
// match, because nothing here is ever emitted.
import { readPrice, signQuote, signerAddress } from "./oracle.ts";

type QuoteBody = { pair: string; ttlSeconds?: number };

/**
 * A signed price quote.
 *
 * The signature is the product. Anyone can serve a number over HTTPS; what a
 * consumer — especially a smart contract — needs is a number they can prove
 * this oracle said, at that time, without trusting the transport or a proxy in
 * between. So the response carries an ed25519 signature over the canonical
 * quote, verifiable against the oracle's Algorand address.
 */
const quote = defineEndpoint<QuoteBody>({
  name: "quote",
  description: "A price quote signed by this oracle's Algorand key.",
  price: "$0.005",

  input: {
    type: "object",
    properties: {
      pair: { type: "string", pattern: "^[A-Z0-9]{2,10}/[A-Z0-9]{2,10}$" },
      ttlSeconds: { type: "integer", minimum: 5, maximum: 3600 },
    },
    required: ["pair"],
    additionalProperties: false,
  },

  handler: ({ body, log }) => {
    const ttlSeconds = body.ttlSeconds ?? 60;
    const observed = readPrice(body.pair);
    log("quoting", { pair: body.pair, source: observed.source });

    const issuedAt = new Date();
    const payload = {
      pair: body.pair,
      price: observed.price,
      decimals: observed.decimals,
      source: observed.source,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + ttlSeconds * 1000).toISOString(),
    };

    // Sign the payload, then return the payload alongside its signature. A
    // consumer must re-serialise the payload the same way to verify — see
    // `canonical()` in oracle.ts, which is why that function is exported.
    return {
      quote: payload,
      signature: signQuote(payload),
      signer: signerAddress(),
      algorithm: "ed25519",
    };
  },
});

const agent = defineAgent({
  name: "{{name}}",
  handle: "{{handle}}",
  description: "Signed price quotes, priced per call.",
  skills: ["oracle", "price-feed"],
  payTo: process.env.RIPAR_PAY_TO!,
  network: (process.env.RIPAR_NETWORK as "mainnet" | "testnet") ?? "testnet",
  endpoints: [quote],
});

await serve(agent, {
  port: Number(process.env.PORT ?? 4021),
  rateLimit: { perMinute: 120, per: "payer" },
  // A quote is only valid for its TTL, so replaying one for longer than that
  // would hand back a stale price. Keep the window under the shortest TTL.
  idempotency: { windowMs: 5_000 },
});
