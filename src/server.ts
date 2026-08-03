import express, { type Express, type Request, type Response } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { manifest } from "./define.js";
import { resolveFacilitatorNetwork } from "./network.js";
import {
  CAIP2,
  DEFAULT_FACILITATOR,
  RiparError,
  USDC_ASSET_ID,
  type AgentDef,
  type EndpointDef,
  type HandlerContext,
  type Network,
  type ServeOptions,
} from "./types.js";

/**
 * Turns declared endpoints into a running, payment-gated HTTP server.
 *
 * The x402 middleware sits in front: an unpaid request never reaches the
 * handler, it gets a 402 carrying the price. Once the facilitator verifies and
 * settles, the same request is replayed into the handler. That ordering is why
 * business logic in `handler` never has to know payments exist.
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

  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // Routes are keyed "METHOD /path" — only listed routes are gated, so health
  // and manifest below stay free by simply not appearing here.
  const routes: Record<string, unknown> = {};
  for (const e of agent.endpoints) {
    routes[`${e.method ?? "POST"} ${base}/${e.name}`] = {
      accepts: {
        scheme: "exact",
        network: networkId,
        payTo,
        price: e.price.startsWith("$") ? e.price : `$${e.price}`,
      },
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

  app.get(`${base}/health`, (_req, res) => {
    res.json({ ok: true, agent: agent.handle, endpoints: agent.endpoints.length, network });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "No such endpoint on this agent." } });
  });

  return app;
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
 *  settled; surfacing them lets a handler record what paid for it. */
function readPaymentResponse(res: Response): HandlerContext["payment"] {
  const raw = res.getHeader("X-Payment-Response");
  if (!raw) return undefined;
  try {
    const p = JSON.parse(String(raw));
    return { txId: p.txId ?? p.transaction, payer: p.payer, amount: String(p.amount ?? ""), asset: p.asset ?? "USDC" };
  } catch {
    return undefined;
  }
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

/** Build the server and listen. Returns the http.Server so tests can close it. */
export async function serve(agent: AgentDef, opts: ServeOptions = {}) {
  const app = await createServer(agent, opts);
  const port = opts.port ?? Number(process.env.PORT ?? 4021);
  const network: Network = opts.network ?? agent.network ?? "mainnet";
  const server = app.listen(port, () => {
    const routes = agent.endpoints.map((e) => `${e.method ?? "POST"} /${e.name}  ${e.price}`);
    opts.onReady?.({ port, routes, network });
    if (!opts.onReady) {
      console.log(`ripar · ${agent.handle} on :${port} (${network})`);
      for (const r of routes) console.log(`  ${r}`);
      console.log(`  GET /.well-known/ripar.json`);
    }
  });
  return server;
}

export { manifest };
