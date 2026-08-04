/** Container entrypoint: serves the bundled example agent. */
import { defineAgent, defineEndpoint } from "./define.js";
import { serve } from "./server.js";

const summarize = defineEndpoint({
  name: "summarize",
  description: "Returns a short summary of any text payload.",
  price: "$0.01",
  input: {
    type: "object",
    properties: { text: { type: "string" }, max: { type: "number" } },
    required: ["text"],
  },
  handler: ({ body, log }) => {
    const { text, max = 280 } = body as { text: string; max?: number };
    if (!text?.trim()) throw new Error("`text` is required.");
    log("summarising", { chars: text.length });
    const clean = text.replace(/\s+/g, " ").trim();
    return { summary: clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`, chars: clean.length };
  },
});

const agent = defineAgent({
  name: "Text Tools",
  handle: "text-tools",
  description: "Small, cheap text utilities priced per call.",
  skills: ["text", "summarisation"],
  // No fallback, deliberately. This file is the Dockerfile CMD and the
  // Railway start command, so a default here means a container deployed from
  // the shipped configs quotes real USDC to an address the operator never
  // chose — and passes /health, so nothing signals it. defineAgent's
  // assertAddress refuses to boot on "" instead, which fails closed.
  payTo: process.env.RIPAR_PAY_TO ?? "",
  // TestNet by default: an accidental deploy should not quote real money.
  network: (process.env.RIPAR_NETWORK as "mainnet" | "testnet") ?? "testnet",
  endpoints: [summarize],
});

await serve(agent, {
  port: Number(process.env.PORT ?? 4021),
  rateLimit: { perMinute: 60, per: "payer" },
  idempotency: { windowMs: 10 * 60_000 },
  // Containers get SIGTERM on every deploy. A paid call killed mid-flight has
  // already settled, so the caller pays and gets a dropped connection.
  shutdownTimeoutMs: 20_000,
});
