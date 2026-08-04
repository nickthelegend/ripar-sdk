import { RiparError, type AgentDef, type EndpointDef, type Handler, type InputSchema } from "./types.js";

/**
 * Declare a paid endpoint. This is the entire authoring surface — a handler and
 * a price. Everything payment-shaped is added by `serve()`, so business logic
 * never imports a payment library.
 */
export function defineEndpoint<B = any, R = unknown>(def: EndpointDef<B, R>): EndpointDef<B, R> {
  assertName(def.name);
  assertPrice(def.price);
  if (typeof def.handler !== "function") {
    throw new RiparError(`Endpoint "${def.name}" has no handler.`, "invalid_endpoint");
  }
  if (def.timeout != null && (def.timeout < 1000 || def.timeout > 300_000)) {
    throw new RiparError(
      `Endpoint "${def.name}" timeout must be between 1000ms and 300000ms.`,
      "invalid_timeout"
    );
  }
  return {
    method: "POST",
    listed: true,
    timeout: 30_000,
    tags: [],
    ...def,
  };
}

/** Bundle endpoints into something a marketplace can list, rank and route to. */
export function defineAgent(def: AgentDef): AgentDef {
  if (!def.endpoints?.length) {
    throw new RiparError(`Agent "${def.name}" declares no endpoints.`, "invalid_agent");
  }
  assertHandle(def.handle);
  assertAddress(def.payTo);

  const seen = new Set<string>();
  for (const e of def.endpoints) {
    if (seen.has(e.name)) {
      throw new RiparError(
        `Agent "${def.name}" declares "${e.name}" twice — endpoint names become URLs and must be unique.`,
        "duplicate_endpoint"
      );
    }
    seen.add(e.name);
  }

  return { version: "0.1.0", network: "mainnet", skills: [], bidsOn: [], ...def };
}

/** The record published to discovery. A caller reads this and nothing else. */
export function manifest(agent: AgentDef, baseUrl: string) {
  return {
    name: agent.name,
    handle: agent.handle,
    description: agent.description,
    version: agent.version,
    skills: agent.skills,
    network: agent.network,
    payTo: agent.payTo,
    endpoints: agent.endpoints
      .filter((e) => e.listed)
      .map((e) => ({
        name: e.name,
        description: e.description,
        url: `${baseUrl.replace(/\/$/, "")}/${e.name}`,
        method: e.method,
        // A price function cannot be serialised, so discovery says so plainly
        // and shows the author's hint. Publishing a made-up number here would
        // be worse than publishing none: an agent would budget against it.
        price: typeof e.price === "function" ? (e.priceHint ?? "dynamic") : e.price,
        pricing: typeof e.price === "function" ? "dynamic" : "fixed",
        input: e.input,
        tags: e.tags,
      })),
  };
}

/* ── validation, with messages that say what to do ────────────────────── */

const NAME_RE = /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/;

function assertName(name: string) {
  if (!name || !NAME_RE.test(name)) {
    throw new RiparError(
      `"${name}" is not a valid endpoint name. Use lowercase letters, digits, "-" and "/" — it becomes the URL path.`,
      "invalid_name"
    );
  }
}

function assertHandle(handle: string) {
  if (!handle || !/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(handle)) {
    throw new RiparError(
      `"${handle}" is not a valid agent handle. Use 3–40 lowercase characters, digits or hyphens.`,
      "invalid_handle"
    );
  }
}

/** Algorand addresses are 58 characters of base32 with a checksum. Catching the
 *  shape here is much kinder than a settlement that silently goes nowhere. */
function assertAddress(addr: string) {
  if (!addr || !/^[A-Z2-7]{58}$/.test(addr)) {
    throw new RiparError(
      `payTo "${addr}" is not an Algorand address (58 base32 characters). Payments settle straight to this address, so a wrong one loses the money.`,
      "invalid_address"
    );
  }
}

function assertPrice(price: unknown) {
  // A price function is quoted per request, so there is nothing to check until
  // one arrives — resolvePrice validates whatever it returns, at that point.
  if (typeof price === "function") return;
  if (!/^\$?\d+(\.\d+)?$/.test(String(price))) {
    throw new RiparError(
      `Price "${price}" must look like "$0.01" — a USD amount the facilitator converts to the asset's base units.`,
      "invalid_price"
    );
  }
  const n = Number(String(price).replace("$", ""));
  if (n <= 0) {
    throw new RiparError(`Price must be greater than zero; got "${price}".`, "invalid_price");
  }
}

export const __test = { assertName, assertHandle, assertAddress, assertPrice };

export type { InputSchema, Handler };
