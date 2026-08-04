import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { HTTPFacilitatorClient, type HTTPRequestContext } from "@x402/core/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { accessGuard, FreeTier } from "./access.js";
import { corsGuard } from "./cors.js";
import { Logger, requestLine } from "./logging.js";
import { openApiDocument } from "./openapi.js";
import { WebhookSender } from "./webhooks.js";
import { isoDate, manifest } from "./define.js";
import { facilitatorOutage, outageBody, watchFacilitator, watchingFacilitator } from "./facilitator.js";
import { resolveFacilitatorNetwork } from "./network.js";
import {
  bodyLimitGuard,
  bodyLimitVerify,
  idempotencyGuard,
  normalizePath,
  rateLimitGuard,
  tooLarge,
  validationGuard,
} from "./guards.js";
import { readPaymentHeader, readReceiptHeader } from "./headers.js";
import { payerFromPaymentHeader } from "./identity.js";
import type { Metrics } from "./metrics.js";
import { METRICS_CONTENT_TYPE } from "./metrics.js";
import { isAssetPrice, normalizeAssetPrice, normalizePrice, resolvePrice, usdOf, type AssetQuote } from "./pricing.js";
import { RateLimiter } from "./ratelimit.js";
import type { RunRecorder } from "./runs.js";
import { Runtime } from "./runtime.js";
import {
  MANIFEST_ALGORITHM,
  MANIFEST_ALGORITHM_HEADER,
  MANIFEST_SIGNATURE_HEADER,
  MANIFEST_SIGNER_HEADER,
  manifestSigner,
} from "./sign.js";
import { installShutdown, type ShutdownResult } from "./shutdown.js";
import { SSE_HEADERS, STREAM_HEADER, sseFrame, type StreamDelivery } from "./stream.js";
import { traceContext, type TraceContext } from "./trace.js";
import {
  MemorySubscriptionStore,
  checkSubscription,
  issue,
  type SubscriptionRecord,
  parsePeriod,
  readKey,
  subscriptionHeaders,
  type SubscriptionStore,
} from "./subscriptions.js";
import {
  DEFAULT_FACILITATOR,
  RiparError,
  USDC_ASSET_ID,
  type AgentDef,
  type EndpointDef,
  type HandlerContext,
  type Network,
  type ServeOptions,
} from "./types.js";

/** Everything a request accumulates on its way through the middleware stack.
 *  Express's `res.locals` is untyped, so this is where the shape is written. */
type RiparLocals = {
  startedAt?: number;
  /** Set when a valid subscription key let this request past the payment gate,
   *  so the finish hook knows nothing settled and none was expected. */
  coveredBySubscription?: boolean;
  /** The window minted for this request, pending confirmation that the payment
   *  actually settled. Reconciled in finishRequest. */
  issued?: SubscriptionRecord;
  /** Set when the free tier waved this request past the gate. The allowance is
   *  spent in finishRequest rather than here, so a failure does not consume it. */
  freeFor?: string;
  /** The W3C trace this request belongs to, resolved once so the response
   *  header, the log line and the handler all name the same id. */
  trace?: TraceContext;
  /** The ASA a non-USD endpoint quoted, kept so the settlement event can say
   *  what was actually charged instead of reporting a dollar figure nobody
   *  computed. */
  assetQuote?: AssetQuote;
};

function locals(res: Response): RiparLocals {
  return (res.locals.ripar ??= {} as RiparLocals);
}

/**
 * Turns declared endpoints into a running, payment-gated HTTP server.
 *
 * The x402 middleware sits in front: an unpaid request never reaches the
 * handler, it gets a 402 carrying the price. Once the facilitator verifies and
 * settles, the same request is replayed into the handler. That ordering is why
 * business logic in `handler` never has to know payments exist.
 *
 * Three guards sit in front of *that*, and their position is the point — a
 * request rejected by any of them has not been charged:
 *
 *   rate limit → idempotency → input validation → payment → handler
 *
 * A 429, a replayed answer or a 400 for a missing field all cost the caller
 * nothing, because the payment middleware was never reached.
 */
export async function createServer(agent: AgentDef, opts: ServeOptions = {}): Promise<Express> {
  const network: Network = opts.network ?? agent.network ?? "mainnet";
  const payTo = opts.payTo ?? agent.payTo;
  const base = normalizeBase(opts.basePath ?? "");
  const facilitatorUrl = opts.facilitatorUrl ?? DEFAULT_FACILITATOR;

  if (!payTo) {
    throw new RiparError(
      "No payTo address. Settlement goes straight to your own Algorand address, so the server refuses to start without one.",
      "missing_pay_to"
    );
  }

  // Ask the facilitator which id it publishes for this chain instead of
  // trusting a constant — see network.ts for why the two disagree.
  const networkId = await resolveFacilitatorNetwork(network, facilitatorUrl);

  const runtime = new Runtime({
    runsCapacity: opts.runsCapacity,
    rateLimit: opts.rateLimit,
    idempotency: opts.idempotency,
    metricsBuckets: opts.metricsBuckets,
  });

  const app = express();
  const byPath = new Map(agent.endpoints.map((e) => [normalizePath(`${base}/${e.name}`), e]));
  const endpointAt = (path: string) => byPath.get(normalizePath(path));

  // Per-endpoint caps, resolved once at startup. A limiter per endpoint rather
  // than one shared bucket: the point of overriding the limit for a route is
  // that its traffic is counted separately from everything else's.
  const routeLimiters = new Map<string, RateLimiter>();
  for (const e of agent.endpoints) {
    if (e.rateLimit) routeLimiters.set(normalizePath(`${base}/${e.name}`), new RateLimiter(e.rateLimit));
  }
  const limiterFor = (path: string) => routeLimiters.get(normalizePath(path)) ?? runtime.rateLimiter;
  const bodyLimitFor = (path: string) => endpointAt(path)?.maxBodyBytes;

  // What each request was quoted, so the settled-USD counter reports the amount
  // the caller agreed to rather than the receipt's `amount` — facilitators
  // report that in base units on some networks and USD on others, and summing
  // the two together produces a number nobody can interpret.
  const fixedUsd = new Map<string, number>();
  /** The ASA quote for an endpoint priced in something other than dollars. */
  const assetQuotes = new Map<string, AssetQuote>();
  // A dynamic quote only exists inside x402's price callback, whose context
  // carries no request handle. `getBody()` returns the very object express
  // parsed for this request, which gives us a per-request key.
  const dynamicUsd = new WeakMap<object, number>();
  const quoteFor = (req: Request, e: EndpointDef) => {
    if (typeof e.price !== "function") return fixedUsd.get(e.name) ?? 0;
    return isObject(req.body) ? (dynamicUsd.get(req.body) ?? 0) : 0;
  };

  // First of everything, including the drain gate: a 503 that cannot be tied
  // back to the call that triggered it is exactly the response an operator most
  // needs to trace. Every response leaves with a traceparent, whether or not
  // one arrived.
  app.use((req, res, next) => {
    const trace = traceContext(req.headers["traceparent"]);
    locals(res).trace = trace;
    res.setHeader("traceparent", trace.traceparent);
    next();
  });

  // Refuse new work the moment SIGTERM lands. Answering 503 beats accepting a
  // request the process will not be alive long enough to finish — and a caller
  // who is told to come back has lost nothing, where a dropped paid call has.
  app.use((_req, res, next) => {
    if (!runtime.draining) return next();
    res.setHeader("Connection", "close");
    res.setHeader("Retry-After", "5");
    res.status(503).json({
      error: { code: "shutting_down", message: "This agent is shutting down. Retry in a few seconds." },
    });
  });

  // Before everything, including the drain gate: a browser preflight carries
  // no payment and asks for no work, so answering it while shutting down is
  // both harmless and necessary — a 503 here shows up as an opaque CORS error.
  if (opts.cors) app.use(corsGuard(opts.cors));

  // Before the body is read, and therefore before anything can be charged for
  // it. The verify hook measures what actually arrived, because Content-Length
  // is caller-supplied and a chunked request omits it entirely.
  app.use(bodyLimitGuard(bodyLimitFor));
  app.use(express.json({ limit: "10mb", verify: bodyLimitVerify(bodyLimitFor) }));

  // Registered immediately after the parser so nothing else can shadow it: a
  // body that is too large, or is not JSON at all, otherwise reaches Express's
  // default handler and comes back as an HTML stack trace with no error code a
  // caller can branch on.
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    const e = err as { status?: number; statusCode?: number; type?: string; message?: string; ripar?: { limit: number; size: number } };
    if (!e || res.headersSent) return next(err);
    const status = e.status ?? e.statusCode;
    if (e.type === "entity.too.large" || status === 413) {
      const limit = e.ripar?.limit ?? bodyLimitFor(req.path) ?? 0;
      return tooLarge(res, e.ripar?.size ?? (Number(req.headers["content-length"]) || 0), limit);
    }
    if (status === 400 || e.type === "entity.parse.failed") {
      return res.status(400).json({
        error: { code: "invalid_json", message: `The request body is not valid JSON: ${e.message ?? "parse failed"}` },
      });
    }
    return next(err);
  });

  const log = opts.logging
    ? opts.logging instanceof Logger
      ? opts.logging
      : new Logger({ base: { agent: agent.handle }, ...opts.logging })
    : null;

  const webhook = opts.webhook ? new WebhookSender(opts.webhook) : null;
  const freeTier = opts.freeTier ? new FreeTier(opts.freeTier) : null;

  /* ── unpaid routes, registered before the gate so they cannot be gated ──── */

  app.get(`${base}/health`, async (_req, res) => {
    const base_ = { agent: agent.handle, endpoints: agent.endpoints.length, network };
    const probes = opts.healthChecks;
    if (!probes) return res.json({ ok: true, ...base_ });

    // A probe that throws is a failed probe, not a failed health check — the
    // whole point is to answer even when a dependency is down, because "ok:
    // true regardless" is what makes a load balancer route into a broken pod.
    const names = Object.keys(probes);
    const settled = await Promise.all(
      names.map(async (n) => {
        try {
          return { name: n, ok: (await probes[n]()) !== false };
        } catch (err) {
          return { name: n, ok: false, error: (err as Error).message };
        }
      })
    );
    const ok = settled.every((c) => c.ok);
    res
      .status(ok ? 200 : 503)
      .json({ ok, ...base_, checks: Object.fromEntries(settled.map((c) => [c.name, c])) });
  });

  // Built once at startup so a bad key fails the boot rather than the first
  // caller who tries to verify a manifest.
  const signer = opts.signManifest ? manifestSigner(opts.signManifest) : null;

  // Free, and deliberately so — discovery has to work before payment can.
  app.get(`${base}/.well-known/ripar.json`, (req, res) => {
    const doc = {
      ...manifest(agent, `${publicOrigin(req)}${base}`),
      x402: {
        facilitator: facilitatorUrl,
        network: networkId,
        asset: { id: USDC_ASSET_ID[network], symbol: "USDC", decimals: 6 },
      },
      ...(signer ? { signedBy: signer.address } : {}),
    };
    if (!signer) return res.json(doc);

    // Serialised ONCE and sent verbatim. `res.json(doc)` would serialise a
    // second time, and a signature over a different serialisation of the same
    // object is a signature that fails verification for reasons nobody can see
    // by reading the document.
    const body = JSON.stringify(doc);
    res.setHeader(MANIFEST_SIGNATURE_HEADER, signer.sign(body));
    res.setHeader(MANIFEST_SIGNER_HEADER, signer.address);
    res.setHeader(MANIFEST_ALGORITHM_HEADER, MANIFEST_ALGORITHM);
    res.type("application/json").send(body);
  });

  if (opts.openapi) {
    const oa = typeof opts.openapi === "object" ? opts.openapi : {};
    app.get(`${base}/openapi.json`, (req, res) => {
      // baseUrl derived from the request unless pinned, so a spec fetched
      // through a proxy names the host the caller actually reached.
      res.json(openApiDocument(agent, { basePath: opts.basePath, baseUrl: publicOrigin(req), ...oa }));
    });
  }

  // Unpaid for the same reason /health is: an agent nobody can scrape is an
  // agent nobody can alert on, and a paid scrape target breaks every collector.
  app.get(`${base}/metrics`, (_req, res) => {
    res.setHeader("content-type", METRICS_CONTENT_TYPE);
    // `res.end` rather than `res.send`: send re-serialises the content type
    // (moving `version=0.0.4` after the charset) and computes an ETag for a
    // body that is different on every scrape by definition.
    res.end(runtime.metrics.render());
  });

  // Capped, unpaid, and free of request bodies — see runs.ts for what is
  // deliberately absent.
  app.get(`${base}/_ripar/runs`, (req, res) => {
    const { capacity } = runtime.runs;
    const asked = Number(req.query.limit ?? capacity);
    const limit = Number.isFinite(asked) ? Math.min(Math.max(1, asked), capacity) : capacity;
    res.json({ runs: runtime.runs.list(limit), capacity, recorded: runtime.runs.size });
  });

  /* ── instrumentation and the guards that must precede payment ──────────── */

  const isEndpoint = (path: string) => byPath.has(normalizePath(path));

  app.use((req, res, next) => {
    const endpoint = byPath.get(normalizePath(req.path));
    if (!endpoint) return next();
    locals(res).startedAt = Date.now();
    // On every response for this endpoint, not only the 200: a client that
    // learns an endpoint is going away from its successful calls learns it a
    // week later than one that also sees it on a 402 or a 429.
    sunsetHeaders(res, endpoint);
    runtime.enter();
    const done = () =>
      finishRequest(runtime, res, endpoint, quoteFor(req, endpoint), subStore, {
        freeTier,
        webhook,
        log,
        method: req.method,
      });
    res.on("finish", done);
    // `finish` never fires if the socket dies mid-response; without `close` the
    // in-flight gauge would climb forever and a drain would never complete.
    res.on("close", done);
    next();
  });

  if (opts.access) app.use(accessGuard(opts.access, isEndpoint));
  // Installed when EITHER a server-wide limit or any per-endpoint one exists;
  // `limiterFor` then decides per path, and returns nothing for a route with
  // neither.
  if (runtime.rateLimiter || routeLimiters.size) app.use(rateLimitGuard(limiterFor, isEndpoint));
  if (runtime.idempotency) app.use(idempotencyGuard(runtime.idempotency, isEndpoint));
  app.use(validationGuard(byPath));

  /* ── the payment gate, and the handlers behind it ──────────────────────── */

  // Routes are keyed "METHOD /path" — only listed routes are gated, so the
  // unpaid routes above stay free by simply not appearing here.
  // Endpoints that sell a window rather than a call. Periods are parsed here,
  // at startup, so a malformed "30 days" is a boot failure rather than a key
  // that silently never expires.
  const subStore: SubscriptionStore = opts.subscriptions?.store ?? new MemorySubscriptionStore();
  const subPeriods = new Map<string, number>();
  for (const e of agent.endpoints) {
    if (e.subscription) subPeriods.set(e.name, parsePeriod(e.subscription.period, e.name));
  }

  const routes: Record<string, unknown> = {};
  for (const e of agent.endpoints) {
    let price: unknown;
    if (e.subscription) {
      // The 402 quotes the window, not the request. Everything downstream —
      // the settled-USD counter, the receipt — then refers to the same number.
      const fixed = normalizePrice(e.subscription.price, e.name);
      fixedUsd.set(e.name, usdOf(fixed));
      price = fixed;
    } else if (isAssetPrice(e.price)) {
      // An ASA quote is handed to x402 already converted, because that is the
      // one shape ExactAvmScheme.parsePrice passes through untouched — a dollar
      // string would be run through its USDC conversion instead, and the 402
      // would name USDC no matter which asset was configured.
      const quote = normalizeAssetPrice(e.price, e.name);
      assetQuotes.set(e.name, quote);
      // Deliberately not a USD figure. Nothing here knows what this asset is
      // worth, and inventing a number would put fiction in the revenue counter.
      fixedUsd.set(e.name, 0);
      price = quote;
    } else if (typeof e.price === "function") {
      price = async (ctx: HTTPRequestContext) => {
        const pctx = priceContext(ctx);
        const quoted = await resolvePrice(e.price, e.name, pctx);
        if (isObject(pctx.body)) dynamicUsd.set(pctx.body, usdOf(quoted));
        return quoted;
      };
    } else {
      const fixed = normalizePrice(e.price, e.name);
      fixedUsd.set(e.name, usdOf(fixed));
      price = fixed;
    }
    // Bazaar discovery, declared on the route where the facilitator actually
    // reads it. registerWithBazaar() used to POST a manifest to
    // <facilitator>/bazaar/register, which returns 404 — there is no such
    // endpoint. The real mechanism is this extension: @x402/express loads
    // bazaarResourceServerExtension when a route declares one, and the
    // facilitator catalogues the resource while verifying a payment. So an
    // endpoint becomes discoverable by being PAID FOR, not by announcing
    // itself, which is the same rule the ReputationRegistry follows.
    const discovery = e.listed
      ? declareDiscoveryExtension({
          input: exampleFor(e.input),
          inputSchema: e.input
            ? { properties: e.input.properties ?? {}, required: e.input.required ?? [] }
            : undefined,
          bodyType: "json",
          output: { example: {} },
        } as never)
      : undefined;

    routes[`${e.method ?? "POST"} ${base}/${e.name}`] = {
      accepts: { scheme: "exact", network: networkId, payTo, price },
      description: e.description ?? e.name,
      ...(discovery ? { extensions: discovery } : {}),
    };
  }

  // Wrapped so a transport failure or a 5xx from the facilitator is recorded
  // before x402 turns it into an answer the caller cannot act on. It only
  // watches — every error is rethrown unchanged, so which payments settle is
  // decided by exactly the same code as before.
  const facilitatorClient = watchFacilitator(new HTTPFacilitatorClient({ url: facilitatorUrl }));
  const resourceServer = new x402ResourceServer(facilitatorClient);
  // Registered for every Algorand network rather than one: the same build then
  // runs against TestNet or MainNet purely from config.
  resourceServer.register("algorand:*", new ExactAvmScheme());

  const rawGate = paymentMiddleware(routes as never, resourceServer);
  const retryAfter = Math.max(1, Math.floor(opts.facilitatorRetryAfter ?? 5));

  /**
   * The payment gate, with a facilitator outage answered as one.
   *
   * `res.json` is intercepted for the life of the request rather than only
   * until the handler runs, because the settle call happens AFTER the handler
   * has written its body — the middleware discards what the handler buffered
   * and writes its own 402, and that is the moment a caller most needs to be
   * told the difference between "rejected" and "unreachable".
   *
   * The interception converts nothing unless a facilitator failure was actually
   * recorded during this request, so an ordinary 402 quote passes through
   * untouched.
   */
  const gate = (req: Request, res: Response, next: NextFunction) =>
    watchingFacilitator(() => {
      const json = res.json.bind(res);
      const status = res.status.bind(res);
      res.json = (body: unknown) => {
        const outage = facilitatorOutage();
        if (!outage || res.headersSent) return json(body);
        res.json = json;
        res.setHeader("Retry-After", String(retryAfter));
        status(503);
        log?.warn("facilitator unavailable", {
          endpoint: endpointAt(req.path)?.name,
          stage: outage.stage,
          facilitator: facilitatorUrl,
          detail: outage.message,
          traceId: locals(res).trace?.traceId,
        });
        return json(outageBody(outage, facilitatorUrl, retryAfter));
      };
      return rawGate(req, res, (err?: unknown) => {
        // x402 hands a transport failure to Express's error handler, which
        // renders a 500 HTML stack trace. Same outage, same answer.
        const outage = facilitatorOutage();
        if (err && outage && !res.headersSent) {
          res.setHeader("Retry-After", String(retryAfter));
          return status(503).json(outageBody(outage, facilitatorUrl, retryAfter));
        }
        return next(err as never);
      });
    });

  // A live subscription key skips the gate entirely. Placed here rather than
  // inside the gate because the point of a window is that the second call
  // costs nothing — it must not reach the facilitator at all.
  app.use(async (req, res, next) => {
    const endpoint = byPath.get(normalizePath(req.path));

    // A free call must not reach the facilitator at all, or "free" costs a
    // round trip and a quote the caller then has to be told to ignore.
    // Consumed only once the response succeeds — see finishRequest — because
    // charging an allowance for a 500 spends the trial on a failure.
    if (freeTier && endpoint) {
      const payer = payerFromPaymentHeader(readPaymentHeader((n) => req.header(n)));
      if (freeTier.peek(payer)) {
        locals(res).freeFor = payer ?? "";
        res.setHeader("x-ripar-free-remaining", String(freeTier.remaining(payer) - 1));
        return next();
      }
    }

    if (!endpoint?.subscription) return gate(req, res, next);

    let check;
    try {
      check = await checkSubscription(subStore, readKey(req.headers), endpoint.name);
    } catch (err) {
      // A store that is down must not hand out free calls. Fail closed: quote
      // the window and let the caller pay again rather than serve for nothing.
      check = { active: false, reason: "unknown" } as const;
      res.setHeader("x-ripar-subscription-error", "store unavailable");
    }

    if (check.active) {
      locals(res).coveredBySubscription = true;
      for (const [k, v] of Object.entries(subscriptionHeaders(check.record))) res.setHeader(k, v);
      res.setHeader("x-ripar-subscription-remaining-ms", String(check.remainingMs));
      return next();
    }

    // Tell the caller why it is being asked to pay. "expired" and "unknown"
    // look identical from the outside otherwise, and the first is something
    // the caller can act on.
    if (check.reason !== "none") res.setHeader("x-ripar-subscription-status", check.reason);
    return gate(req, res, next);
  });

  for (const e of agent.endpoints) {
    const path = `${base}/${e.name}`;
    const method = (e.method ?? "POST").toLowerCase() as "get" | "post";
    app[method](path, async (req, res) => {
      // Reaching a gated handler at all means x402 returned `payment-verified`
      // — that is the ONLY signal available here. The settlement receipt is
      // not: @x402/express buffers the body, runs the handler, and only then
      // calls processSettlement and writes PAYMENT-RESPONSE. Reading the
      // receipt at this point always yields undefined, so minting on it minted
      // nothing and the caller paid for a window it never received.
      //
      // So mint on verification and correct it afterwards: `finish` fires once
      // settlement has been attempted, and revokes the window if the payment
      // did not actually land.
      if (e.subscription && !locals(res).coveredBySubscription) {
        try {
          const { key, record } = await issue(subStore, {
            endpoint: e.name,
            periodMs: subPeriods.get(e.name)!,
            usd: fixedUsd.get(e.name) ?? 0,
          });
          // Set here, before the handler writes anything, so the key is on the
          // response whatever the handler does with the body.
          for (const [k, v] of Object.entries(subscriptionHeaders(record, key))) res.setHeader(k, v);
          locals(res).issued = record;
        } catch {
          // Better to serve the call than to take payment and refuse it. Say
          // plainly that the window was lost rather than implying one exists.
          res.setHeader("x-ripar-subscription-error", "could not persist the subscription");
        }
      }
      if (assetQuotes.has(e.name)) locals(res).assetQuote = assetQuotes.get(e.name);
      return runHandler(e, req, res);
    });
  }

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "No such endpoint on this agent." } });
  });

  // Last, so it catches anything thrown by a middleware registered above it —
  // including the payment gate handing Express a facilitator failure. Without
  // it the caller gets Express's HTML stack trace, which is both unparseable
  // and a small information leak.
  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    log?.error("unhandled", {
      endpoint: endpointAt(req.path)?.name,
      detail: (err as Error)?.message,
      traceId: locals(res).trace?.traceId,
    });
    res.status(500).json({
      error: { code: "internal_error", message: (err as Error)?.message ?? "The request failed." },
    });
  });

  (app as Express & { locals: { ripar?: Runtime } }).locals.ripar = runtime;
  return app;
}

/**
 * RFC 8594 `Sunset` and RFC 9745 `Deprecation`, so a caller's client can warn
 * before the endpoint disappears.
 *
 * Both are HTTP-dates, not ISO strings — a `Sunset: 2026-12-01T00:00:00.000Z`
 * is malformed and every conforming client drops it, which turns the whole
 * feature into a header nobody reads. `Deprecation: true` is the draft form
 * that is actually deployed and is all a boolean can honestly say; given a date
 * we send RFC 9745's `@<unix-seconds>` instead, which says when.
 */
function sunsetHeaders(res: Response, e: EndpointDef) {
  if (e.sunset) res.setHeader("Sunset", new Date(isoDate(e.sunset)).toUTCString());
  if (e.deprecated === true) res.setHeader("Deprecation", "true");
  else if (e.deprecated) {
    res.setHeader("Deprecation", `@${Math.floor(new Date(isoDate(e.deprecated)).getTime() / 1000)}`);
  }
  // The half of RFC 8594 that says what to do instead of merely when to panic.
  if (e.sunsetLink) res.setHeader("Link", `<${e.sunsetLink}>; rel="sunset"`);
}

/** The runtime a served app owns — metrics, run history, drain state. Exposed
 *  so an operator can wire their own shutdown or scrape counters in-process. */
export function runtimeOf(app: Express): Runtime | undefined {
  return (app as Express & { locals: { ripar?: Runtime } }).locals.ripar;
}

function finishRequest(
  runtime: Runtime,
  res: Response,
  endpoint: EndpointDef,
  quotedUsd: number,
  subStore?: SubscriptionStore,
  extras?: {
    freeTier?: FreeTier | null;
    webhook?: WebhookSender | null;
    log?: Logger | null;
    method?: string;
  }
) {
  const l = locals(res);
  if (l.startedAt == null) return; // already finished; `close` after `finish`
  const ms = Date.now() - l.startedAt;
  l.startedAt = undefined;

  // A settlement receipt on the response is the only proof money moved. By
  // `finish` the middleware has written it — during the handler it had not,
  // which is why this reconciliation happens here and not there.
  const receipt = readPaymentResponse(res);
  runtime.metrics.record(endpoint.name, res.statusCode, ms / 1000);
  if (receipt) runtime.metrics.recordSettlement(quotedUsd);
  runtime.runs.add({ endpoint: endpoint.name, status: res.statusCode, ms, txId: receipt?.txId });

  // A window was minted on verification alone. If nothing settled, revoke it —
  // otherwise a payment that failed at the last step still buys 30 days.
  // If it did settle, bind the record to the transaction that paid for it, so
  // every window traces back to money that moved, like a reputation score.
  const issued = l.issued;
  if (issued && subStore) {
    l.issued = undefined;
    if (!receipt || res.statusCode >= 400) {
      void Promise.resolve(subStore.delete?.(issued.keyHash)).catch(() => {
        /* nothing further to try; the window expires on its own */
      });
    } else if (receipt.txId) {
      void Promise.resolve(subStore.put({ ...issued, txId: receipt.txId, payer: receipt.payer })).catch(
        () => {
          /* the window still works; only its audit trail is thinner */
        }
      );
    }
  }

  // The free allowance is spent HERE, not at the gate: a call that 500s used
  // none of the value the trial exists to demonstrate, and burning it on a
  // failure is the fastest way to make a trial feel broken.
  const free = l.freeFor;
  if (free !== undefined && extras?.freeTier && res.statusCode < 400) {
    extras.freeTier.take(free === "" ? null : free);
  }

  extras?.log?.info(receipt ? "settled" : "call", {
    ...requestLine({
      endpoint: endpoint.name,
      method: extras.method ?? "POST",
      status: res.statusCode,
      ms,
      settled: Boolean(receipt),
      usd: receipt ? quotedUsd : undefined,
      txId: receipt?.txId,
      payer: receipt?.payer,
      // The field that makes this line joinable with the caller's own logs, and
      // with the logs of whatever this handler called in turn.
      traceId: l.trace?.traceId,
    }),
    ...(free !== undefined ? { free: true } : {}),
  });

  // Only real settlements. A free call and a subscription-covered call both
  // moved no money, and a ledger fed by this must not record them as revenue.
  if (receipt && extras?.webhook) {
    extras.webhook.send({
      type: "settlement",
      endpoint: endpoint.name,
      txId: receipt.txId,
      payer: receipt.payer,
      amount: receipt.amount,
      asset: receipt.asset,
      usd: quotedUsd,
      // An ASA quote is reported as itself. `usd: 0` alone would read as a free
      // call to anything summing these, and there is no exchange rate here to
      // turn 1.5 of an arbitrary ASA into dollars with.
      ...(l.assetQuote
        ? {
            quote: {
              amount: l.assetQuote.amount,
              asset: Number(l.assetQuote.asset),
              decimals: l.assetQuote.extra.decimals,
              ...(l.assetQuote.extra.symbol ? { symbol: l.assetQuote.extra.symbol } : {}),
            },
          }
        : {}),
      status: res.statusCode,
      ms,
      at: new Date().toISOString(),
    });
  }

  runtime.leave();
}

/** Runs the handler with a timeout, and maps failures onto x402's contract:
 *  any status >= 400 CANCELS settlement, so throwing must not be silent. */
async function runHandler(e: EndpointDef, req: Request, res: Response) {
  const logs: { message: string; data?: Record<string, unknown> }[] = [];
  const stream = e.stream ? openStream(res) : null;
  const ctx: HandlerContext = {
    body: req.body ?? {},
    headers: req.headers as Record<string, string | undefined>,
    query: req.query as Record<string, unknown>,
    log: (message, data) => logs.push({ message, data }),
    payment: readPaymentResponse(res),
    traceId: locals(res).trace?.traceId,
    ...(stream ? { write: stream.write } : {}),
  };

  const timeout = e.timeout ?? 30_000;
  let timer: NodeJS.Timeout | undefined;

  try {
    const result = await Promise.race([
      Promise.resolve(e.handler(ctx)),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new RiparError(`Handler exceeded ${timeout}ms.`, "handler_timeout", 504)),
          timeout
        );
      }),
    ]);
    if (stream) {
      // A returned value still becomes a frame, so `return { done: true }` at
      // the end of a streaming handler does the obvious thing instead of being
      // silently dropped.
      if (result !== undefined) stream.write(result, { event: "result" });
      stream.end();
    } else {
      res.json(result);
    }
  } catch (err) {
    const e2 = err as RiparError;
    const status = e2.status ?? 500;
    const body = {
      error: {
        code: e2.code ?? "handler_error",
        message: e2.message ?? "The handler threw.",
        logs: logs.slice(-20),
      },
    };
    // A stream that has already emitted a frame cannot go back and become a
    // 4xx: the status line is chosen before the first byte, and on the ungated
    // path those bytes are already with the caller. So the failure travels as
    // an `error` event and the call is CHARGED — the caller received part of
    // what they paid for, and pretending otherwise would mean either lying
    // about the status or refusing to deliver what did succeed. A handler that
    // fails before its first frame still gets the ordinary 5xx, and settlement
    // is still cancelled.
    if (stream?.started) {
      stream.write(body.error, { event: "error" });
      stream.end();
    } else {
      // Any status >= 400 cancels settlement — @x402/express buffers the
      // response and only settles on success, so a failed call is never charged
      // rather than charged and refunded. Nothing is taken, which is a stronger
      // promise than a refund and depends entirely on not dressing a failure as
      // a 200.
      res.status(status).json(body);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The SSE writer handed to a `stream: true` handler.
 *
 * `delivery` is decided by whether this request went through the payment gate,
 * which is the only thing that determines it: the gate replaces `res.write`
 * with a buffer, and a request the gate waved past (a live subscription window,
 * a free-tier call) still has the real one. Published in `x-ripar-stream` so a
 * client can tell what it is holding rather than infer it from timing.
 */
function openStream(res: Response) {
  const l = locals(res);
  const delivery: StreamDelivery =
    l.coveredBySubscription || l.freeFor !== undefined ? "incremental" : "buffered-until-settlement";
  let started = false;

  const begin = () => {
    if (started) return;
    started = true;
    for (const [k, v] of Object.entries(SSE_HEADERS)) res.setHeader(k, v);
    res.setHeader(STREAM_HEADER, delivery);
    // Sends the header block now on the incremental path, so a client's
    // connection callback fires before the first frame rather than with it.
    // Buffered, this is recorded alongside the writes and replayed with them.
    res.flushHeaders();
  };

  return {
    get started() {
      return started;
    },
    delivery,
    write: (data: unknown, opts?: { event?: string; id?: string; retry?: number }) => {
      begin();
      res.write(sseFrame(data, opts));
    },
    end: () => {
      begin();
      res.end();
    },
  };
}

/** The middleware writes settlement details to a response header once it has
 *  settled; surfacing them lets a handler record what paid for it. The header is
 *  base64 JSON — parsing it as plain JSON silently yields nothing. */
function readPaymentResponse(res: Response): HandlerContext["payment"] {
  const receipt = readReceiptHeader((name) => {
    const raw = res.getHeader(name);
    return raw == null ? null : String(raw);
  });
  if (!receipt) return undefined;
  return {
    txId: receipt.txId,
    payer: receipt.payer,
    amount: receipt.amount ?? "",
    usd: receipt.usd,
    asset: receipt.asset ?? "USDC",
  };
}

/** The narrow view a price function gets, built from x402's transport-agnostic
 *  request context rather than from Express. Body and query are optional on that
 *  interface — a transport that cannot supply them prices from the headers. */
function priceContext(ctx: HTTPRequestContext) {
  return {
    body: ctx.adapter.getBody?.() ?? {},
    query: (ctx.adapter.getQueryParams?.() ?? {}) as Record<string, unknown>,
    header: (name: string) => ctx.adapter.getHeader(name),
  };
}

function isObject(v: unknown): v is object {
  return typeof v === "object" && v !== null;
}

function normalizeBase(base: string) {
  if (!base) return "";
  const b = base.startsWith("/") ? base : `/${base}`;
  return b.endsWith("/") ? b.slice(0, -1) : b;
}

/** Honours proxy headers so the manifest advertises the URL callers actually
 *  reach — behind Railway/Render/Fly the socket address is not it. */
function publicOrigin(req: Request) {
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0] ?? req.protocol ?? "https";
  const host = (req.headers["x-forwarded-host"] as string) ?? req.headers.host ?? "localhost";
  return `${proto}://${host}`;
}

/**
 * Everything an embedder needs about a running agent, without reaching into
 * Express or Node's Server.
 *
 * `address` is the Algorand address settlement goes to — in an agent SDK that
 * is what the word means, and it is the field a supervisor needs to check that
 * the process it just started is paying the account it expected. It lives HERE,
 * on a nested handle, rather than flat on the returned server, for a reason
 * that is not stylistic: `Server.address()` is a method, and shadowing it with
 * a string would break every existing caller that reads the bound port that way
 * — including this repo's own shutdown test. `port` and `url` give you what
 * `address()` was being used for anyway.
 */
export type RiparHandle = {
  /** Origin the agent actually answers on, with the real port when 0 was asked
   *  for. */
  url: string;
  port: number;
  /** The Algorand address settlement goes to. */
  address: string;
  metrics: Metrics;
  runs: RunRecorder;
  /** Stop listening, drain what is in flight, and resolve with the outcome. */
  close: (reason?: string) => Promise<ShutdownResult>;
};

/** The listening server, plus the drain SIGTERM would trigger — exposed so an
 *  embedder can shut the agent down on their own terms. */
export type RiparServer = Server & {
  shutdown: (reason?: string) => Promise<ShutdownResult>;
  /** Detach the signal handlers, for a process that starts several agents. */
  uninstallSignals: () => void;
  /** The typed handle. Also spread flat below, minus `address` — see the note
   *  on RiparHandle for why that one cannot be flat. */
  handle: RiparHandle;
  url: string;
  port: number;
  metrics: Metrics;
  runs: RunRecorder;
};

/** Build the server and listen. Returns the http.Server so tests can close it. */
export async function serve(agent: AgentDef, opts: ServeOptions = {}): Promise<RiparServer> {
  const app = await createServer(agent, opts);
  const wanted = opts.port ?? Number(process.env.PORT ?? 4021);
  const network: Network = opts.network ?? agent.network ?? "mainnet";
  const runtime = runtimeOf(app)!;

  const server = app.listen(wanted);
  // Awaited rather than assumed. `listen` binds before it emits, so reading the
  // port synchronously usually works — but a port already in use emits `error`
  // instead, and without this that surfaces as an uncaught exception long after
  // `serve()` resolved, with nothing tying it to the call that caused it.
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const port = (server.address() as AddressInfo | null)?.port ?? wanted;
  // A wildcard bind is not a hostname anything can connect to; the loopback
  // address is, and is what a health check or a test needs.
  const host = hostOf(server.address());
  const url = `http://${host}:${port}`;

  const routes = agent.endpoints.map(
    (e) => `${e.method ?? "POST"} /${e.name}  ${priceSummary(e)}`
  );
  opts.onReady?.({ port, routes, network });
  if (!opts.onReady) {
    console.log(`ripar · ${agent.handle} on :${port} (${network})`);
    for (const r of routes) console.log(`  ${r}`);
    console.log(`  GET /.well-known/ripar.json`);
    console.log(`  GET /metrics · GET /_ripar/runs · GET /health   (unpaid)`);
  }

  const { shutdown, uninstall } = installShutdown(server, runtime, {
    timeoutMs: opts.shutdownTimeoutMs,
    // No signals means the drain is still available, just not triggered for you.
    signals: opts.handleSignals === false ? [] : undefined,
    onExit: opts.onShutdown,
  });

  const handle: RiparHandle = {
    url,
    port,
    address: opts.payTo ?? agent.payTo,
    metrics: runtime.metrics,
    runs: runtime.runs,
    close: (reason = "close") => shutdown(reason),
  };

  return Object.assign(server, {
    shutdown,
    uninstallSignals: uninstall,
    handle,
    url,
    port,
    metrics: runtime.metrics,
    runs: runtime.runs,
  });
}

function hostOf(address: ReturnType<Server["address"]>): string {
  if (!address || typeof address === "string") return "127.0.0.1";
  if (address.address === "::" || address.address === "0.0.0.0" || !address.address) return "127.0.0.1";
  return address.family === "IPv6" ? `[${address.address}]` : address.address;
}

/** What the startup banner shows for one endpoint. */
function priceSummary(e: EndpointDef): string {
  if (e.subscription) return `${e.subscription.price} / ${String(e.subscription.period)}`;
  if (typeof e.price === "function") return e.priceHint ?? "dynamic";
  if (isAssetPrice(e.price)) return `${e.price.amount} ${e.price.symbol ?? `ASA ${e.price.asset}`}`;
  return String(e.price);
}

export { manifest };

/**
 * A minimal example body from an input schema, for Bazaar discovery.
 *
 * The catalogue shows callers what a request looks like. Deriving it from the
 * schema the endpoint already declares means the example cannot drift from
 * what validation will actually accept — a hand-written example is a second
 * source of truth that goes stale silently.
 */
function exampleFor(input: EndpointDef["input"]): Record<string, unknown> {
  if (!input?.properties) return {};
  const out: Record<string, unknown> = {};
  for (const name of input.required ?? Object.keys(input.properties)) {
    const spec = (input.properties as Record<string, { type?: string; enum?: unknown[] }>)[name];
    if (!spec) continue;
    if (spec.enum?.length) out[name] = spec.enum[0];
    else if (spec.type === "number" || spec.type === "integer") out[name] = 1;
    else if (spec.type === "boolean") out[name] = true;
    else if (spec.type === "array") out[name] = [];
    else if (spec.type === "object") out[name] = {};
    else out[name] = "example";
  }
  return out;
}
