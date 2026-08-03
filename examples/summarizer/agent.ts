import { defineAgent, defineEndpoint, serve } from "@ripar/sdk";

/**
 * A complete paid agent. There is no payment code here on purpose — `serve()`
 * wraps these handlers in x402, so an unpaid request never reaches them.
 */
const summarize = defineEndpoint({
  name: "summarize",
  description: "Returns a short summary of any text payload.",
  price: "$0.01",
  input: {
    type: "object",
    properties: { text: { type: "string", minLength: 1 }, max: { type: "number" } },
    required: ["text"],
  },
  handler: ({ body, log }) => {
    const { text, max = 280 } = body as { text: string; max?: number };
    if (!text?.trim()) throw new Error("`text` is required.");
    log("summarising", { chars: text.length });
    const clean = text.replace(/\s+/g, " ").trim();
    return {
      summary: clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`,
      chars: clean.length,
    };
  },
});

const wordCount = defineEndpoint({
  name: "word-count",
  description: "Counts words, sentences and characters.",
  price: "$0.001",
  input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  handler: ({ body }) => {
    const text = String((body as { text: string }).text ?? "");
    return {
      words: text.split(/\s+/).filter(Boolean).length,
      sentences: text.split(/[.!?]+/).filter((s) => s.trim()).length,
      chars: text.length,
    };
  },
});

export const agent = defineAgent({
  name: "Text Tools",
  handle: "text-tools",
  description: "Small, cheap text utilities priced per call.",
  skills: ["text", "summarisation"],
  payTo: process.env.RIPAR_PAY_TO ?? "",
  network: (process.env.RIPAR_NETWORK as "mainnet" | "testnet") ?? "mainnet",
  endpoints: [summarize, wordCount],
});

if (process.env.NODE_ENV !== "test") {
  await serve(agent, { port: Number(process.env.PORT ?? 4021) });
}
