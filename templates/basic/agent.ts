import { defineAgent, defineEndpoint, serve } from "@ripar/sdk";

/**
 * The smallest thing that can take money: one endpoint, one price.
 *
 * There is no payment code in this file, and that is the point. `serve()` puts
 * x402 in front, so an unpaid request never reaches `handler`.
 */
const echo = defineEndpoint({
  name: "echo",
  description: "Returns the text it was given, priced per call.",
  price: "$0.001",
  // Published to discovery AND enforced before payment, so a malformed call is
  // rejected with a 400 naming the field and the caller is not charged for it.
  input: {
    type: "object",
    properties: {
      text: { type: "string", minLength: 1, maxLength: 5000 },
      upper: { type: "boolean" },
    },
    required: ["text"],
    additionalProperties: false,
  },
  handler: ({ body, log }) => {
    const { text, upper = false } = body as { text: string; upper?: boolean };
    log("echoing", { chars: text.length });
    return { echoed: upper ? text.toUpperCase() : text, chars: text.length };
  },
});

const agent = defineAgent({
  name: "{{name}}",
  handle: "{{handle}}",
  description: "An agent scaffolded with `ripar init`.",
  skills: ["text"],
  // Settlement lands here directly — no Ripar account holds it on the way.
  payTo: process.env.RIPAR_PAY_TO!,
  network: (process.env.RIPAR_NETWORK as "mainnet" | "testnet") ?? "testnet",
  endpoints: [echo],
});

await serve(agent, {
  port: Number(process.env.PORT ?? 4021),
  // 60 calls a minute per paying address. Remove it and one caller can saturate
  // the process; the money still arrives, but everyone else queues behind them.
  rateLimit: { perMinute: 60, per: "payer" },
  // Honour Idempotency-Key: a caller whose connection dropped after paying gets
  // the stored answer back instead of paying twice.
  idempotency: { windowMs: 10 * 60_000 },
});
