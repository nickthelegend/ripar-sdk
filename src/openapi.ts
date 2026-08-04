import { isAssetPrice, normalizePrice } from "./pricing.js";
import type { AgentDef, EndpointDef, InputSchema } from "./types.js";

/**
 * An OpenAPI 3.1 document, generated from the endpoints themselves.
 *
 * Written from the same `defineEndpoint` calls that serve the traffic, so it
 * cannot drift: a hand-maintained spec is a second source of truth that goes
 * stale the first time somebody changes a price and forgets, and a spec that
 * disagrees with the server is worse than none — a client generated from it
 * fails in ways that look like the server is broken.
 *
 * The interesting part is describing payment at all. OpenAPI has no concept of
 * it, so the 402 is documented as a real response with the challenge in its
 * headers, and each priced operation carries `x-ripar-price`. Generators
 * ignore extensions they do not know, so the document stays valid while a
 * reader who does care can find the number.
 */

export type OpenApiOptions = {
  /** Public base URL, e.g. https://api.example.com. Used for `servers`. */
  baseUrl?: string;
  /** Mount prefix, matching `serve({ basePath })`. */
  basePath?: string;
  /** Include endpoints marked `listed: false`. Default false, because an
   *  unlisted endpoint is one the operator chose not to advertise. */
  includeUnlisted?: boolean;
};

/** JSON Schema is already what `input` holds, so this is mostly a pass-through
 *  — but OpenAPI 3.1 wants `type: object` present even when it was implied. */
function bodySchema(input?: InputSchema): Record<string, unknown> {
  if (!input) return { type: "object", additionalProperties: true };
  return { type: "object", ...(input as unknown as Record<string, unknown>) };
}

function priceOf(e: EndpointDef): { price: string; kind: string; period?: string } {
  if (e.subscription) {
    return {
      price: normalizePrice(e.subscription.price, e.name),
      kind: "subscription",
      period: String(e.subscription.period),
    };
  }
  if (typeof e.price === "function") {
    // A price function cannot be serialised. Publishing the author's hint, or
    // saying "dynamic", beats publishing a number nobody would honour.
    return { price: e.priceHint ?? "dynamic", kind: "dynamic" };
  }
  if (isAssetPrice(e.price)) {
    // Never dressed with a "$": the amount is that many units of one specific
    // ASA, and a dollar sign in front of it is a number a reader will budget
    // against and a rate nobody quoted.
    return { price: `${e.price.amount} ${e.price.symbol ?? `ASA ${e.price.asset}`}`, kind: "asset" };
  }
  return { price: normalizePrice(e.price, e.name), kind: "fixed" };
}

export function openApiDocument(agent: AgentDef, opts: OpenApiOptions = {}): Record<string, unknown> {
  const base = opts.basePath ? `/${opts.basePath.replace(/^\/|\/$/g, "")}` : "";
  const endpoints = agent.endpoints.filter((e) => opts.includeUnlisted || e.listed !== false);

  const paths: Record<string, unknown> = {};
  for (const e of endpoints) {
    const method = (e.method ?? "POST").toLowerCase();
    const { price, kind, period } = priceOf(e);

    const operation: Record<string, unknown> = {
      operationId: e.name.replace(/[^a-zA-Z0-9]+/g, "_"),
      summary: e.description ?? e.name,
      tags: e.tags?.length ? e.tags : undefined,
      // OpenAPI's own field, so every generator already marks the method
      // obsolete without knowing anything about x-ripar extensions.
      ...(e.deprecated ? { deprecated: true } : {}),
      "x-ripar-price": {
        amount: price,
        pricing: kind,
        ...(period ? { period } : {}),
        ...(isAssetPrice(e.price)
          ? { asset: { id: Number(e.price.asset), decimals: e.price.decimals, symbol: e.price.symbol } }
          : {}),
      },
      ...(e.sunset ? { "x-ripar-sunset": new Date(e.sunset).toISOString() } : {}),
      responses: {
        "200": e.stream
          ? {
              description:
                "The work, once payment settled — as text/event-stream. Behind the payment gate the " +
                "frames are produced together and flushed after settlement, because @x402/express " +
                "buffers the response body to decide whether to settle at all. `x-ripar-stream` says " +
                "which of the two this response was.",
              headers: {
                "x-ripar-stream": {
                  description: "`incremental` or `buffered-until-settlement`.",
                  schema: { type: "string", enum: ["incremental", "buffered-until-settlement"] },
                },
              },
              content: { "text/event-stream": { schema: { type: "string" } } },
            }
          : {
              description: "The work, once payment settled.",
              content: { "application/json": { schema: { type: "object" } } },
            },
        ...(e.maxBodyBytes
          ? {
              "413": {
                description: `The request body exceeded ${e.maxBodyBytes} bytes. Checked before the payment gate, so nothing was charged.`,
              },
            }
          : {}),
        "503": {
          description:
            "The payment layer could not be reached — the endpoint itself is fine. Retry-After says when to come back.",
          headers: { "Retry-After": { schema: { type: "integer" } } },
        },
        "400": {
          description:
            "The request failed validation. Checked BEFORE the payment gate, so nothing was charged.",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
        "402": {
          description:
            "Payment required. The quote travels base64-encoded in PAYMENT-REQUIRED, not in the body — " +
            "the body is usually `{}`, and parsing it instead of the header is why a price cap silently " +
            "never fires.",
          headers: {
            "PAYMENT-REQUIRED": {
              description: "base64 JSON: the accepts block naming amount, asset, network and payTo.",
              schema: { type: "string" },
            },
          },
        },
        "429": {
          description: "Rate limited. Also before the gate, so also uncharged.",
          headers: { "Retry-After": { schema: { type: "integer" } } },
        },
        "504": { description: "The handler exceeded its timeout. A 5xx cancels settlement." },
      },
    };

    if (method !== "get") {
      operation.requestBody = {
        required: Boolean(e.input?.required?.length),
        content: { "application/json": { schema: bodySchema(e.input) } },
      };
    }

    paths[`${base}/${e.name}`] = { [method]: operation };
  }

  // The unpaid routes, because a reader needs to know what is free.
  paths[`${base}/health`] = {
    get: {
      operationId: "health",
      summary: "Liveness. Never gated.",
      responses: { "200": { description: "The agent is up." } },
    },
  };
  paths[`${base}/.well-known/ripar.json`] = {
    get: {
      operationId: "manifest",
      summary: "The discovery manifest. Free, deliberately — discovery has to work before payment can.",
      responses: { "200": { description: "The agent's manifest." } },
    },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: agent.name,
      version: agent.version ?? "0.1.0",
      description:
        (agent.description ? `${agent.description}\n\n` : "") +
        "Endpoints are paid per call over x402 on Algorand. An unpaid request returns 402 with a " +
        "quote; sign the transfer it names and retry with a PAYMENT-SIGNATURE header. Settlement " +
        "goes straight to the operator's own address — this API never holds a balance.",
    },
    servers: opts.baseUrl ? [{ url: opts.baseUrl }] : undefined,
    "x-ripar": {
      handle: agent.handle,
      network: agent.network,
      payTo: agent.payTo,
      // Named so a reader knows which header carries the payment. X-PAYMENT is
      // the v1 spelling and @x402/express does not read it.
      paymentHeader: "PAYMENT-SIGNATURE",
      receiptHeader: "PAYMENT-RESPONSE",
    },
    paths,
    components: {
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                code: { type: "string" },
                message: { type: "string" },
                field: { type: "string" },
              },
              required: ["code", "message"],
            },
          },
        },
      },
    },
  };
}
