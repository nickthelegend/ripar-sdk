import type { Server } from "node:http";
import express, { type Express, type Request, type Response } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { HTTPFacilitatorClient, type HTTPRequestContext } from "@x402/core/server";
import { manifest } from "./define.js";
import { resolveFacilitatorNetwork } from "./network.js";
import { idempotencyGuard, rateLimitGuard, validationGuard } from "./guards.js";
import { readReceiptHeader } from "./headers.js";
import { METRICS_CONTENT_TYPE } from "./metrics.js";
import { normalizePrice, resolvePrice, usdOf } from "./pricing.js";
import { Runtime } from "./runtime.js";
import { installShutdown, type ShutdownResult } from "./shutdown.js";
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
type RiparLocals = { startedAt?: number };

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
  });

  const app = express();
  const byPath = new Map(agent.endpoints.map((e) => [`${base}/${e.name}`, e]));

  // What each request was quoted, so the settled-USD counter reports the amount
  // the caller agreed to rather than the receipt's `amount` — facilitators
  // report that in base units on some networks and USD on others, and summing
  // the two together produces a number nobody can interpret.
  const fixedUsd = new Map<string, number>();
  // A dynamic quote only exists inside x402's price callback, whose context
  // carries no request handle. `getBody()` returns the very object express
  // parsed for this request, which gives us a per-request key.
  const dynamicUsd = new WeakMap<object, number>();
  const quoteFor = (req: Request, e: EndpointDef) => {
    if (typeof e.price !== "function") return fixedUsd.get(e.name) ?? 0;
    return isObject(req.body) ? (dynamicUsd.get(req.body) ?? 0) : 0;
  };

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

  app.use(express.json({ limit: "10mb" }));

  /* ── unpaid routes, registered before the gate so they cannot be gated ──── */

  app.get(`${base}/health`, (_req, res) => {
    res.json({ ok: true, agent: agent.handle, endpoints: agent.endpoints.length, network });
  });

  // Free, and deliberately so — discovery has to work before payment can.
  app.get(`${base}/.well-known/ripar.json`, (req, res) => {
    res.json({
      ...manifest(agent, `${publicOrigin(req)}${base}`),
      x402: {
        facilitator: facilitatorUrl,
        network: networkId,
        asset: { id: USDC_ASSET_ID[network], symbol: "USDC", decimals: 6 },
      },
    });
  });

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

  const isEndpoint = (path: string) => byPath.has(path);

  app.use((req, res, next) => {
    const endpoint = byPath.get(req.path);
    if (!endpoint) return next();
    locals(res).startedAt = Date.now();
    runtime.enter();
    const done = () => finishRequest(runtime, res, endpoint, quoteFor(req, endpoint));
    res.on("finish", done);
    // `finish` never fires if the socket dies mid-response; without `close` the
    // in-flight gauge would climb forever and a drain would never complete.
    res.on("close", done);
    next();
  });

  if (runtime.rateLimiter) app.use(rateLimitGuard(runtime.rateLimiter, isEndpoint));
  if (runtime.idempotency) app.use(idempotencyGuard(runtime.idempotency, isEndpoint));
  app.use(validationGuard(byPath));

  /* ── the payment gate, and the handlers behind it ──────────────────────── */

  // Routes are keyed "METHOD /path" — only listed routes are gated, so the
  // unpaid routes above stay free by simply not appearing here.
  const routes: Record<string, unknown> = {};
  for (const e of agent.endpoints) {
    let price: unknown;
    if (typeof e.price === "function") {
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
    routes[`${e.method ?? "POST"} ${base}/${e.name}`] = {
      accepts: { scheme: "exact", network: networkId, payTo, price },
      description: e.description ?? e.name,
    };
  }

  const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitatorClient);
  // Registered for every Algorand network rather than one: the same build then
  // runs against TestNet or MainNet purely from config.
  resourceServer.register("algorand:*", new ExactAvmScheme());

  app.use(paymentMiddleware(routes as never, resourceServer));

  for (const e of agent.endpoints) {
    const path = `${base}/${e.name}`;
    const method = (e.method ?? "POST").toLowerCase() as "get" | "post";
    app[method](path, (req, res) => runHandler(e, req, res));
  }

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "No such endpoint on this agent." } });
  });

  (app as Express & { locals: { ripar?: Runtime } }).locals.ripar = runtime;
  return app;
}

/** The runtime a served app owns — metrics, run history, drain state. Exposed
 *  so an operator can wire their own shutdown or scrape counters in-process. */
export function runtimeOf(app: Express): Runtime | undefined {
  return (app as Express & { locals: { ripar?: Runtime } }).locals.ripar;
}

function finishRequest(runtime: Runtime, res: Response, endpoint: EndpointDef, quotedUsd: number) {
  const l = locals(res);
  if (l.startedAt == null) return; // already finished; `close` after `finish`
  const ms = Date.now() - l.startedAt;
  l.startedAt = undefined;

  // A settlement receipt on the response is the only proof money moved; the
  // middleware writes it after the facilitator confirms.
  const receipt = readPaymentResponse(res);
  runtime.metrics.record(endpoint.name, res.statusCode, ms / 1000);
  if (receipt) runtime.metrics.recordSettlement(quotedUsd);
  runtime.runs.add({ endpoint: endpoint.name, status: res.statusCode, ms, txId: receipt?.txId });
  runtime.leave();
}

/** Runs the handler with a timeout, and maps failures onto x402's contract:
 *  a 5xx means the caller is refunded, so throwing must not be silent. */
async function runHandler(e: EndpointDef, req: Request, res: Response) {
  const logs: { message: string; data?: Record<string, unknown> }[] = [];
  const ctx: HandlerContext = {
    body: req.body ?? {},
    headers: req.headers as Record<string, string | undefined>,
    query: req.query as Record<string, unknown>,
    log: (message, data) => logs.push({ message, data }),
    payment: readPaymentResponse(res),
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
    res.json(result);
  } catch (err) {
    const e2 = err as RiparError;
    const status = e2.status ?? 500;
    // 5xx is the signal that refunds the caller. Never dress a failure as 200.
    res.status(status).json({
      error: {
        code: e2.code ?? "handler_error",
        message: e2.message ?? "The handler threw.",
        logs: logs.slice(-20),
      },
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
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

/** The listening server, plus the drain SIGTERM would trigger — exposed so an
 *  embedder can shut the agent down on their own terms. */
export type RiparServer = Server & {
  shutdown: (reason?: string) => Promise<ShutdownResult>;
  /** Detach the signal handlers, for a process that starts several agents. */
  uninstallSignals: () => void;
};

/** Build the server and listen. Returns the http.Server so tests can close it. */
export async function serve(agent: AgentDef, opts: ServeOptions = {}): Promise<RiparServer> {
  const app = await createServer(agent, opts);
  const port = opts.port ?? Number(process.env.PORT ?? 4021);
  const network: Network = opts.network ?? agent.network ?? "mainnet";
  const server = app.listen(port, () => {
    const routes = agent.endpoints.map(
      (e) => `${e.method ?? "POST"} /${e.name}  ${typeof e.price === "function" ? (e.priceHint ?? "dynamic") : e.price}`
    );
    opts.onReady?.({ port, routes, network });
    if (!opts.onReady) {
      console.log(`ripar · ${agent.handle} on :${port} (${network})`);
      for (const r of routes) console.log(`  ${r}`);
      console.log(`  GET /.well-known/ripar.json`);
      console.log(`  GET /metrics · GET /_ripar/runs · GET /health   (unpaid)`);
    }
  });

  const { shutdown, uninstall } = installShutdown(server, runtimeOf(app)!, {
    timeoutMs: opts.shutdownTimeoutMs,
    // No signals means the drain is still available, just not triggered for you.
    signals: opts.handleSignals === false ? [] : undefined,
    onExit: opts.onShutdown,
  });

  return Object.assign(server, { shutdown, uninstallSignals: uninstall });
}

export { manifest };
