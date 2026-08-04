import { isAssetPrice, normalizeAssetPrice } from "./pricing.js";
import { parsePeriod } from "./subscriptions.js";
import { RiparError, type AgentDef, type EndpointDef, type Handler, type InputSchema } from "./types.js";

/**
 * Declare a paid endpoint. This is the entire authoring surface — a handler and
 * a price. Everything payment-shaped is added by `serve()`, so business logic
 * never imports a payment library.
 */
export function defineEndpoint<B = any, R = unknown>(def: EndpointDef<B, R>): EndpointDef<B, R> {
  assertName(def.name);
  if (def.subscription) {
    // parsePeriod throws with a message naming the endpoint and the accepted
    // forms, so a bad period fails here rather than issuing keys that never
    // expire.
    assertPrice(def.subscription.price);
    parsePeriod(def.subscription.period, def.name);
  } else {
    assertPrice(def.price);
  }
  if (typeof def.handler !== "function") {
    throw new RiparError(`Endpoint "${def.name}" has no handler.`, "invalid_endpoint");
  }
  if (def.timeout != null && (def.timeout < 1000 || def.timeout > 300_000)) {
    throw new RiparError(
      `Endpoint "${def.name}" timeout must be between 1000ms and 300000ms.`,
      "invalid_timeout"
    );
  }
  if (def.maxBodyBytes != null && (!Number.isInteger(def.maxBodyBytes) || def.maxBodyBytes < 1)) {
    throw new RiparError(
      `Endpoint "${def.name}" maxBodyBytes must be a positive whole number of bytes.`,
      "invalid_body_limit"
    );
  }
  if (def.rateLimit != null && !(def.rateLimit.perMinute >= 1)) {
    throw new RiparError(
      `Endpoint "${def.name}" rateLimit.perMinute must be at least 1.`,
      "invalid_rate_limit"
    );
  }
  // A sunset date that does not parse is worse than none: it becomes an
  // `Invalid Date` in a header, and a client that was going to warn its operator
  // silently stops.
  if (def.sunset != null) assertDate(def.sunset, `Endpoint "${def.name}" sunset`);
  if (typeof def.deprecated === "string" || def.deprecated instanceof Date) {
    assertDate(def.deprecated, `Endpoint "${def.name}" deprecated`);
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
        price: e.subscription
          ? e.subscription.price
          : typeof e.price === "function"
            ? (e.priceHint ?? "dynamic")
            : isAssetPrice(e.price)
              ? `${e.price.amount} ${e.price.symbol ?? `ASA ${e.price.asset}`}`
              : e.price,
        pricing: e.subscription
          ? "subscription"
          : typeof e.price === "function"
            ? "dynamic"
            : isAssetPrice(e.price)
              ? "asset"
              : "fixed",
        // A browsing agent needs to know the quote buys a window, not a call —
        // otherwise $5.00 looks like an extremely expensive single request.
        ...(e.subscription ? { period: String(e.subscription.period) } : {}),
        // The machine-readable half of an ASA quote. A caller that holds this
        // asset needs the id and the decimals, not the pretty string above.
        ...(isAssetPrice(e.price)
          ? { asset: { id: Number(e.price.asset), decimals: e.price.decimals, symbol: e.price.symbol } }
          : {}),
        // Stated in discovery rather than only in a header, so a caller can
        // decide whether to route to this endpoint before spending anything on
        // it. The wording is the honest one — see stream.ts.
        ...(e.stream
          ? { stream: { contentType: "text/event-stream", delivery: "buffered-until-settlement" } }
          : {}),
        ...(e.deprecated ? { deprecated: true } : {}),
        ...(e.sunset ? { sunset: isoDate(e.sunset) } : {}),
        ...(e.maxBodyBytes ? { maxBodyBytes: e.maxBodyBytes } : {}),
        input: e.input,
        tags: e.tags,
      })),
  };
}

/** An ISO instant, from either form the author may have written. */
export function isoDate(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
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

function assertDate(value: string | Date, what: string) {
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) {
    throw new RiparError(
      `${what} "${String(value)}" is not a date. Use an ISO date like "2026-12-01".`,
      "invalid_date"
    );
  }
}

function assertPrice(price: unknown) {
  // A price function is quoted per request, so there is nothing to check until
  // one arrives — resolvePrice validates whatever it returns, at that point.
  if (typeof price === "function") return;
  // An ASA quote validates its own asset id, decimals and amount, and throws
  // with the same messages the 402 path would — so a bad one is a boot failure
  // rather than a 500 on the first caller.
  if (isAssetPrice(price)) {
    normalizeAssetPrice(price, "this endpoint");
    return;
  }
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
