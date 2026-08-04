import { defineAgent, defineEndpoint, serve } from "@ripar/sdk";
// `.ts`, not `.js`: node runs this file by stripping types, and its resolver
// takes the specifier literally — it does not remap .js to .ts the way a
// bundler or a tsc build does. tsconfig sets allowImportingTsExtensions to
// match, because nothing here is ever emitted.
import { callModel } from "./model.ts";

type CompleteBody = { prompt: string; maxTokens?: number; system?: string };

/**
 * A prompt-shaped endpoint, priced by what the caller asks for.
 *
 * Inference costs scale with output length, so a flat price is either a loss on
 * long generations or a rip-off on short ones. `price` is a function here: it
 * runs before the 402 is written, so the caller signs for the amount their own
 * request implies.
 */
const complete = defineEndpoint<CompleteBody>({
  name: "complete",
  description: "Completes a prompt. Priced per 100 requested output tokens.",

  // Must be cheap and deterministic for a given body: the caller quotes, signs,
  // then sends again, and a price that moved between those two requests would
  // reject a payment they built in good faith.
  price: ({ body }) => {
    const maxTokens = clampTokens(body?.maxTokens);
    return `$${(0.002 + 0.0004 * Math.ceil(maxTokens / 100)).toFixed(4)}`;
  },
  // A function cannot be serialised into discovery, so this is what a browsing
  // agent sees instead — the shape of the bill, not an invented number.
  priceHint: "$0.0024–$0.0100 (by maxTokens)",

  input: {
    type: "object",
    properties: {
      prompt: { type: "string", minLength: 1, maxLength: 100_000 },
      system: { type: "string", maxLength: 10_000 },
      maxTokens: { type: "integer", minimum: 1, maximum: 2000 },
    },
    required: ["prompt"],
    additionalProperties: false,
  },
  timeout: 120_000,

  handler: async ({ body, log }) => {
    const maxTokens = clampTokens(body.maxTokens);
    log("completing", { promptChars: body.prompt.length, maxTokens });

    // A throw here becomes a 5xx, which refunds the caller. Do not catch a
    // provider outage and return 200 with an apology — that bills for nothing.
    const result = await callModel({ prompt: body.prompt, system: body.system, maxTokens });

    return {
      completion: result.text,
      model: result.model,
      stub: result.stub,
      usage: { maxTokens },
    };
  },
});

function clampTokens(v: unknown) {
  const n = Number(v ?? 256);
  if (!Number.isFinite(n)) return 256;
  return Math.min(2000, Math.max(1, Math.floor(n)));
}

const agent = defineAgent({
  name: "{{name}}",
  handle: "{{handle}}",
  description: "Prompt completion, priced per call.",
  skills: ["llm", "text-generation"],
  payTo: process.env.RIPAR_PAY_TO!,
  network: (process.env.RIPAR_NETWORK as "mainnet" | "testnet") ?? "testnet",
  endpoints: [complete],
});

await serve(agent, {
  port: Number(process.env.PORT ?? 4021),
  // Inference is the expensive kind of work, so the limit is tighter than the
  // basic template's and keyed to the paying address.
  rateLimit: { perMinute: 20, per: "payer" },
  // Generations are slow, so a dropped connection after payment is likely.
  // Idempotency-Key turns that retry into a replay instead of a second bill.
  idempotency: { windowMs: 30 * 60_000 },
  shutdownTimeoutMs: 120_000,
});
