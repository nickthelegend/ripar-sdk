import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import express from "express";
import algosdk from "algosdk";
import { ALGORAND_TESTNET_CAIP2 } from "@x402/avm";
import { defineAgent, defineEndpoint } from "../src/define.js";
import { createServer, serve } from "../src/server.js";
import { atomicToUsd, usdOfAccept } from "../src/headers.js";
import { Metrics } from "../src/metrics.js";
import { normalizeAssetPrice, toAtomic } from "../src/pricing.js";
import { sseFrame, sseComment } from "../src/stream.js";
import { parseTraceparent, traceContext } from "../src/trace.js";
import { manifestSigner, verifyManifest } from "../src/sign.js";
import type { StreamHandlerContext } from "../src/types.js";

/**
 * The second round of server features, through real Express servers.
 *
 * Same rule as server-integration.test.ts: only the facilitator is doubled, and
 * it is a real HTTP server rather than a stub, so what is under test is the
 * genuine middleware order — which is the thing that keeps being wrong.
 *
 * Two of these tests assert something uncomfortable rather than something
 * flattering. "a paid stream is not incremental" and "a free stream is" exist
 * because the SDK now advertises `stream: true`, and an SDK that advertises
 * streaming it does not do is worse than one that has no streaming at all.
 */

const PAY_TO = "PBXELTAXFHNNP3ZQFBC36WKUGVX732UG4CQQH22CP6NNIY5FFIY5UINYAU";
const PAYER = "B2DGXU2QSRHXNZJMP5FFFU77W5NUMZTZ3X3MSO3PJC4ZQ75CSDL5EKULI4";
/** The full 53-char id a real facilitator publishes — see subscription-server.test.ts. */
const NETWORK = `${ALGORAND_TESTNET_CAIP2}xi9/cOUJOiI=`;
const TX_ID = "XS5KJ7OV2IS47322EZ3AFX5ZPG3RQTIYUFSSQ2KPMNMFZVI6K4NA";

const listen = (app: express.Express): Promise<Server> =>
  new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
const portOf = (s: Server) => (s.address() as { port: number }).port;
const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));

/** How the doubled facilitator behaves. Switched per test, so an outage is a
 *  real HTTP failure at the real moment rather than a mocked method. */
type FacMode =
  | "ok"
  | "verify-down"
  | "verify-5xx-json"
  | "settle-down"
  | "verify-refuses"
  | "verify-hangup";
let facMode: FacMode = "ok";
/** Every /verify the facilitator saw, so a test can prove a request never
 *  reached the payment layer at all. */
let verifies = 0;

function facilitatorApp() {
  const f = express();
  f.use(express.json({ limit: "50mb" }));
  f.get("/supported", (_q, s) =>
    s.json({ kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }] })
  );
  f.post("/verify", (q, s) => {
    verifies++;
    if (facMode === "verify-down") return s.status(503).send("upstream down");
    // A 5xx whose body still parses as a verify response. @x402/core turns this
    // one into a VerifyError carrying the status, which is a different branch
    // from the plain-text 503 above — and the one a facilitator with a real
    // framework in front of it actually produces.
    if (facMode === "verify-5xx-json") return s.status(500).json({ isValid: false, invalidReason: "internal" });
    // No status at all — the socket just goes away, which is what a caller sees
    // when the facilitator's load balancer drops the connection.
    if (facMode === "verify-hangup") return q.socket.destroy();
    if (facMode === "verify-refuses") {
      return s.status(402).json({ isValid: false, invalidReason: "insufficient_funds", payer: PAYER });
    }
    s.json({ isValid: true, payer: PAYER });
  });
  f.post("/settle", (_q, s) => {
    if (facMode === "settle-down") return s.status(503).send("upstream down");
    s.json({ success: true, transaction: TX_ID, network: NETWORK, payer: PAYER });
  });
  return f;
}

/** A signed asset transfer matching whatever the 402 quoted. The facilitator
 *  double accepts anything, but building the real shape keeps the payload the
 *  same one a live facilitator would be handed. */
function signedTransfer(accepted: { amount?: string; asset?: string }) {
  const acct = algosdk.generateAccount();
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: acct.addr,
    receiver: PAY_TO,
    amount: Number(accepted.amount ?? 1),
    assetIndex: Number(accepted.asset ?? 10_458_941),
    suggestedParams: {
      fee: 1000,
      firstValid: 1,
      lastValid: 1000,
      genesisID: "testnet-v1.0",
      genesisHash: new Uint8Array(Buffer.from("SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=", "base64")),
      flatFee: true,
    },
  });
  return Buffer.from(txn.signTxn(acct.sk)).toString("base64");
}

/** Quote an endpoint, then build the header that pays for exactly that quote. */
async function payHeaderFor(base: string, path: string, body: unknown = {}) {
  const quote = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const required = quote.headers.get("payment-required");
  if (!required) throw new Error(`no quote on ${path}: ${quote.status} ${await quote.text()}`);
  const accepted = JSON.parse(Buffer.from(required, "base64").toString()).accepts[0];
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted,
      scheme: "exact",
      network: NETWORK,
      payload: { paymentGroup: [signedTransfer(accepted)], paymentIndex: 0 },
    })
  ).toString("base64");
}

/** Read an SSE body chunk by chunk, recording when each arrived. The timing IS
 *  the assertion for the streaming tests. */
async function readStream(res: Response) {
  const t0 = Date.now();
  const chunks: { at: number; text: string }[] = [];
  const reader = res.body!.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push({ at: Date.now() - t0, text: Buffer.from(value).toString() });
  }
  return { chunks, text: chunks.map((c) => c.text).join(""), closedAt: Date.now() - t0 };
}

/* ── unit: the pieces, before they are wired up ─────────────────────────── */

describe("sseFrame", () => {
  it("splits a multi-line payload into one data: line each", () => {
    // The blank line is the frame terminator, so a raw newline inside a payload
    // would end the event early and deliver the rest as a nameless second one.
    expect(sseFrame("a\nb")).toBe("data: a\ndata: b\n\n");
    expect(sseFrame({ a: 1 })).toBe('data: {"a":1}\n\n');
  });

  it("carries event, id and retry, and never lets one of them span a line", () => {
    expect(sseFrame("x", { event: "tick", id: "7", retry: 250 })).toBe(
      "id: 7\nevent: tick\nretry: 250\ndata: x\n\n"
    );
    // A newline smuggled into an event name would terminate the field and turn
    // whatever followed into a field of its own.
    expect(sseFrame("x", { event: "a\nb" })).toBe("event: a b\ndata: x\n\n");
  });

  it("writes a comment that no client dispatches as an event", () => {
    expect(sseComment("keep-alive")).toBe(": keep-alive\n\n");
  });
});

describe("traceparent", () => {
  const GOOD = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

  it("parses a well-formed header", () => {
    expect(parseTraceparent(GOOD)).toEqual({
      version: "00",
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      parentId: "00f067aa0ba902b7",
      flags: "01",
    });
  });

  it("drops anything malformed instead of repairing it", () => {
    // A salvaged half-id joins a trace to the wrong parent, which is worse than
    // starting a fresh one.
    expect(parseTraceparent("garbage")).toBeNull();
    expect(parseTraceparent("00-4bf92f35-00f067aa0ba902b7-01")).toBeNull();
    expect(parseTraceparent("00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01")).toBeNull();
    expect(parseTraceparent(`ff-${"a".repeat(32)}-${"b".repeat(16)}-01`)).toBeNull();
    expect(parseTraceparent(`00-${"0".repeat(32)}-${"b".repeat(16)}-01`)).toBeNull();
    expect(parseTraceparent(`00-${"a".repeat(32)}-${"0".repeat(16)}-01`)).toBeNull();
    expect(parseTraceparent(undefined)).toBeNull();
  });

  it("continues an inbound trace with a NEW span, not the caller's", () => {
    const ctx = traceContext(GOOD);
    expect(ctx.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(ctx.parentSpanId).toBe("00f067aa0ba902b7");
    // Echoing the caller's span id back would tell their tracer that our work
    // and theirs were the same span, and one duration would overwrite the other.
    expect(ctx.spanId).not.toBe("00f067aa0ba902b7");
    expect(ctx.inbound).toBe(true);
    expect(ctx.traceparent).toBe(`00-4bf92f3577b34da6a3ce929d0e0e4736-${ctx.spanId}-01`);
  });

  it("starts a trace when none arrives", () => {
    const ctx = traceContext(undefined);
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx.inbound).toBe(false);
    expect(ctx.sampled).toBe(true);
  });
});

describe("asset pricing", () => {
  it("converts whole units to atomic units without touching a float", () => {
    // 1.5 * 10 ** 6 is not always 1500000 in IEEE 754, and the 402 has to carry
    // an integer a facilitator will accept.
    expect(toAtomic("1.5", 6, "e")).toBe("1500000");
    expect(toAtomic("0.000001", 6, "e")).toBe("1");
    expect(toAtomic("12", 0, "e")).toBe("12");
  });

  it("refuses a price with more precision than the asset has", () => {
    // Rounding it away would quote a paid endpoint at less than it asked for,
    // or at nothing.
    expect(() => toAtomic("0.0001", 2, "e")).toThrow(/cannot be expressed/);
    expect(() => toAtomic("0", 6, "e")).toThrow(/cannot quote zero/);
  });

  it("refuses an ASA id or decimals it cannot trust", () => {
    expect(() => normalizeAssetPrice({ amount: "1", asset: "gold", decimals: 6 }, "e")).toThrow(/ASA id/);
    // An assumed six decimals for an asset that has two overcharges ten
    // thousandfold, so it is an error rather than a default.
    expect(() => normalizeAssetPrice({ amount: "1", asset: 1, decimals: 1.5 }, "e")).toThrow(/decimals/);
  });

  it("marks the quote as not dollar-denominated", () => {
    const q = normalizeAssetPrice({ amount: "1.5", asset: 12345, decimals: 6, symbol: "GOLD" }, "e");
    expect(q).toEqual({ asset: "12345", amount: "1500000", extra: { decimals: 6, usd: false, symbol: "GOLD" } });
  });
});

describe("atomicToUsd keeps refusing what it cannot price", () => {
  it("returns null for an unknown asset", () => {
    // The property the multi-asset work must not break: guessing six decimals
    // here turns a real quote into a wrong number in the direction that pays.
    expect(atomicToUsd("1500000", "12345")).toBeNull();
    expect(usdOfAccept({ amount: "1500000", asset: "12345" })).toBeNull();
  });

  it("returns null for an asset quote even though it publishes its decimals", () => {
    const extra = { decimals: 6, usd: false, symbol: "GOLD" };
    // 1500000 at six decimals is 1.5 — of GOLD, not of dollars. A client
    // comparing that against a USD cap would wave through a quote worth a
    // hundred times its limit, so the conversion has to refuse.
    expect(atomicToUsd("1500000", "12345", extra)).toBeNull();
    expect(usdOfAccept({ amount: "1500000", asset: "12345", extra })).toBeNull();
    // Still converts when the decimals are declared and dollars are not denied,
    // which is the behaviour non-Ripar servers rely on.
    expect(atomicToUsd("1500000", "12345", { decimals: 6 })).toBeCloseTo(1.5, 6);
  });
});

describe("Metrics", () => {
  it("exposes a real histogram: cumulative buckets, +Inf, sum and count", () => {
    const m = new Metrics([0.1, 1]);
    m.record("work", 200, 0.05);
    m.record("work", 200, 0.5);
    m.record("work", 500, 30);
    const out = m.render();

    // Cumulative, not exclusive: le="1" counts everything at or below 1s, so it
    // must include the 0.05 already counted by le="0.1". Counting exclusively
    // produces decreasing _bucket series and quietly wrong quantiles.
    expect(out).toContain('ripar_request_duration_seconds_bucket{endpoint="work",le="0.1"} 1');
    expect(out).toContain('ripar_request_duration_seconds_bucket{endpoint="work",le="1"} 2');
    expect(out).toContain('ripar_request_duration_seconds_bucket{endpoint="work",le="+Inf"} 3');
    expect(out).toContain('ripar_request_duration_seconds_sum{endpoint="work"} 30.55');
    expect(out).toContain('ripar_request_duration_seconds_count{endpoint="work"} 3');
    expect(out).toContain("# TYPE ripar_request_duration_seconds histogram");
  });

  it("keeps the counters the histogram sits alongside", () => {
    const m = new Metrics();
    m.record("work", 200, 0.01);
    m.recordSettlement(0.02);
    const out = m.render();
    expect(out).toContain('ripar_requests_total{endpoint="work",status="200"} 1');
    expect(out).toContain("ripar_settled_total 1");
    expect(out).toContain("ripar_settled_usd_total 0.02");
    expect(out).toContain("ripar_requests_in_flight 0");
  });

  it("takes custom buckets, because the defaults stop at 10 seconds", () => {
    // An agent that spends 30s calling a model puts every real request in +Inf,
    // and histogram_quantile over that returns the top bound for everything
    // above the median — a dashboard that looks fine and measures nothing.
    const m = new Metrics([30, 5, 60, 5]);
    m.record("slow", 200, 25);
    expect(m.buckets).toEqual([5, 30, 60]);
    expect(m.render()).toContain('ripar_request_duration_seconds_bucket{endpoint="slow",le="5"} 0');
    expect(m.render()).toContain('ripar_request_duration_seconds_bucket{endpoint="slow",le="30"} 1');
  });
});

describe("manifest signing", () => {
  const account = algosdk.generateAccount();
  const signer = manifestSigner({ secretKey: account.sk });

  it("derives the signing address from the key, so the two cannot disagree", () => {
    expect(signer.address).toBe(account.addr.toString());
  });

  it("verifies the exact bytes, and rejects a body that was altered in transit", () => {
    const body = JSON.stringify({ payTo: PAY_TO });
    const sig = signer.sign(body);
    expect(verifyManifest(body, sig, signer.address)).toBe(true);
    // The attack this exists for: a proxy rewriting payTo so every settlement
    // on the endpoint goes somewhere else, while the manifest still parses.
    expect(verifyManifest(JSON.stringify({ payTo: PAYER }), sig, signer.address)).toBe(false);
    expect(verifyManifest(body, sig, PAYER)).toBe(false);
  });

  it("answers false rather than throwing on anything malformed", () => {
    // A caller who has to wrap this in try/catch to make it usable will
    // eventually catch too much and treat an unverifiable manifest as verified.
    const body = "{}";
    expect(verifyManifest(body, "not-base64!!", signer.address)).toBe(false);
    expect(verifyManifest(body, signer.sign(body), "NOT-AN-ADDRESS")).toBe(false);
    expect(verifyManifest(body, "", signer.address)).toBe(false);
  });

  it("accepts the mnemonic an operator actually has written down", () => {
    const fromWords = manifestSigner({ secretKey: algosdk.secretKeyToMnemonic(account.sk) });
    expect(fromWords.address).toBe(signer.address);
  });
});

/* ── through a real server ──────────────────────────────────────────────── */

describe("the second round of server features, end to end", () => {
  let base: string;
  let stop: () => Promise<void>;
  let facilitator: Server;
  const lines: Record<string, unknown>[] = [];

  beforeAll(async () => {
    facMode = "ok";
    facilitator = await listen(facilitatorApp());

    const agent = defineAgent({
      name: "Second Round",
      handle: "second-round",
      description: "Every feature from the second round, on one agent.",
      payTo: PAY_TO,
      network: "testnet",
      endpoints: [
        defineEndpoint({
          name: "work",
          price: "$0.02",
          handler: () => ({ ok: true }),
        }),
        defineEndpoint({
          name: "gold",
          description: "Priced in an ASA rather than dollars.",
          price: { amount: "1.5", asset: 12_345, decimals: 6, symbol: "GOLD" },
          handler: () => ({ ok: true }),
        }),
        defineEndpoint({
          name: "small",
          price: "$0.01",
          maxBodyBytes: 64,
          handler: () => ({ ok: true }),
        }),
        defineEndpoint({
          name: "scarce",
          price: "$0.01",
          rateLimit: { perMinute: 2, per: "ip" },
          handler: () => ({ ok: true }),
        }),
        defineEndpoint({
          name: "old",
          price: "$0.01",
          sunset: "2026-12-01",
          deprecated: true,
          sunsetLink: "https://ripar.io/docs/migrate",
          handler: () => ({ ok: true }),
        }),
        defineEndpoint({
          name: "traced",
          price: "$0.01",
          handler: (ctx) => ({ sawTrace: ctx.traceId }),
        }),
      ],
    });

    const app = await createServer(agent, {
      network: "testnet",
      payTo: PAY_TO,
      facilitatorUrl: `http://127.0.0.1:${portOf(facilitator)}`,
      // A limit every endpoint inherits, so "scarce" can be shown overriding it.
      rateLimit: { perMinute: 1000, per: "ip" },
      signManifest: { secretKey: algosdk.generateAccount().sk },
      openapi: true,
      logging: { level: "info", write: (l) => lines.push(JSON.parse(l)) },
    });

    const server = await listen(app);
    base = `http://127.0.0.1:${portOf(server)}`;
    stop = () => close(server);
  });

  afterAll(async () => {
    await stop();
    await close(facilitator);
  });

  const post = (path: string, init: { headers?: Record<string, string>; body?: unknown } = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...init.headers },
      body: JSON.stringify(init.body ?? {}),
    });

  /* ── multi-asset pricing ─────────────────────────────────────────────── */

  it("quotes an ASA endpoint in that ASA, in its own atomic units", async () => {
    const res = await post("/gold");
    expect(res.status).toBe(402);
    const accepts = JSON.parse(
      Buffer.from(res.headers.get("payment-required")!, "base64").toString()
    ).accepts[0];

    // Naming USDC here — which is what a dollar price would have produced —
    // would ask the caller to sign a transfer of an asset the endpoint never
    // wanted, and the transfer would settle.
    expect(accepts.asset).toBe("12345");
    expect(accepts.amount).toBe("1500000");
    expect(accepts.extra).toMatchObject({ decimals: 6, symbol: "GOLD", usd: false });
  });

  it("still quotes a dollar endpoint in USDC", async () => {
    const accepts = JSON.parse(
      Buffer.from((await post("/work")).headers.get("payment-required")!, "base64").toString()
    ).accepts[0];
    expect(accepts.asset).toBe("10458941");
    expect(accepts.amount).toBe("20000");
  });

  it("publishes the ASA in discovery so a caller can decide before paying", async () => {
    const doc = (await (await fetch(`${base}/.well-known/ripar.json`)).json()) as any;
    const gold = doc.endpoints.find((e: any) => e.name === "gold");
    expect(gold.pricing).toBe("asset");
    expect(gold.price).toBe("1.5 GOLD");
    expect(gold.asset).toEqual({ id: 12345, decimals: 6, symbol: "GOLD" });
  });

  it("serves an ASA-priced call once it is paid for", async () => {
    const header = await payHeaderFor(base, "/gold");
    const res = await post("/gold", { headers: { "PAYMENT-SIGNATURE": header } });
    expect(res.status).toBe(200);
    expect(res.headers.get("payment-response")).toBeTruthy();
  });

  /* ── per-endpoint body limits ────────────────────────────────────────── */

  it("refuses an oversized body before the payment gate, so it costs nothing", async () => {
    const before = verifies;
    const res = await post("/small", {
      headers: { "PAYMENT-SIGNATURE": await payHeaderFor(base, "/small") },
      body: { blob: "x".repeat(500) },
    });
    const body = (await res.json()) as any;

    expect(res.status).toBe(413);
    expect(body.error.code).toBe("body_too_large");
    expect(body.error.limit).toBe(64);
    // The whole point of the position: the facilitator never saw this request,
    // so nothing was verified and nothing settled.
    expect(verifies, "an oversized request reached the payment layer").toBe(before);
  });

  it("catches an oversized body that declared no length at all", async () => {
    // Content-Length is caller-supplied, and a streamed request omits it
    // entirely — undici sends this chunked. The header check alone is avoidable
    // by any client that wants to, so the cap is measured on what arrived.
    const res = await fetch(`${base}/small`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(JSON.stringify({ blob: "y".repeat(500) })));
          c.close();
        },
      }),
      // @ts-expect-error undici needs this to send a streaming body
      duplex: "half",
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as any).error.code).toBe("body_too_large");
  });

  it("refuses an oversized body that express.json would never have looked at", async () => {
    // The Content-Length check earns its place here: `express.json` parses only
    // what claims to be JSON, so its verify hook never sees a blob posted as
    // text/plain. Without the check in front, this reaches the payment gate.
    const res = await fetch(`${base}/small`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "x".repeat(500),
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as any).error.code).toBe("body_too_large");
  });

  it("lets a body inside the limit through to the quote", async () => {
    expect((await post("/small", { body: { q: "hi" } })).status).toBe(402);
  });

  it("leaves an endpoint without a limit alone", async () => {
    expect((await post("/work", { body: { blob: "z".repeat(5000) } })).status).toBe(402);
  });

  /* ── per-endpoint rate limits ────────────────────────────────────────── */

  it("applies an endpoint's own rate limit instead of the server-wide one", async () => {
    // The server-wide limit is 1000/minute; this endpoint declares 2.
    expect((await post("/scarce")).status).toBe(402);
    expect((await post("/scarce")).status).toBe(402);
    const third = await post("/scarce");
    expect(third.status).toBe(429);
    expect(third.headers.get("x-ratelimit-limit")).toBe("2");
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("counts each endpoint separately, so one route cannot exhaust another", async () => {
    // A shared bucket would make the point of overriding a limit disappear:
    // traffic to a cheap endpoint would spend the expensive one's allowance.
    expect((await post("/work")).status).toBe(402);
    expect((await post("/scarce")).status).toBe(429);
  });

  /* ── sunset and deprecation ──────────────────────────────────────────── */

  it("emits RFC-shaped Sunset, Deprecation and Link headers", async () => {
    const res = await post("/old", {
      headers: { "PAYMENT-SIGNATURE": await payHeaderFor(base, "/old") },
    });
    expect(res.status).toBe(200);
    // An HTTP-date, not an ISO string: a conforming client drops
    // `2026-12-01T00:00:00.000Z` and the warning never happens.
    expect(res.headers.get("sunset")).toBe("Tue, 01 Dec 2026 00:00:00 GMT");
    expect(res.headers.get("deprecation")).toBe("true");
    expect(res.headers.get("link")).toBe('<https://ripar.io/docs/migrate>; rel="sunset"');
  });

  it("puts them on the 402 too, not only on a successful call", async () => {
    // A client that only learns from its successful calls learns a week late.
    const res = await post("/old");
    expect(res.status).toBe(402);
    expect(res.headers.get("sunset")).toBe("Tue, 01 Dec 2026 00:00:00 GMT");
    expect(res.headers.get("deprecation")).toBe("true");
  });

  it("says nothing about endpoints that are not going anywhere", async () => {
    const res = await post("/work");
    expect(res.headers.get("sunset")).toBeNull();
    expect(res.headers.get("deprecation")).toBeNull();
  });

  it("marks the operation deprecated in the OpenAPI document", async () => {
    const doc = (await (await fetch(`${base}/openapi.json`)).json()) as any;
    expect(doc.paths["/old"].post.deprecated).toBe(true);
    expect(doc.paths["/old"].post["x-ripar-sunset"]).toBe("2026-12-01T00:00:00.000Z");
    expect(doc.paths["/work"].post.deprecated).toBeUndefined();
  });

  /* ── traceparent ─────────────────────────────────────────────────────── */

  it("continues an inbound trace, echoes it, and logs it", async () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    // Quoted first: the quote is a request of its own and logs a line of its
    // own, under its own trace.
    const header = await payHeaderFor(base, "/traced");
    await new Promise((r) => setTimeout(r, 50));
    const before = lines.length;
    const res = await post("/traced", {
      headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01`, "PAYMENT-SIGNATURE": header },
    });

    expect(res.status).toBe(200);
    const echoed = res.headers.get("traceparent")!;
    expect(echoed.startsWith(`00-${traceId}-`)).toBe(true);
    // Our own span, not the caller's — otherwise their tracer records our work
    // and theirs as one span and one duration overwrites the other.
    expect(echoed).not.toContain("00f067aa0ba902b7");
    // The handler saw it, so anything it calls onward can carry it.
    expect(((await res.json()) as any).sawTrace).toBe(traceId);

    await new Promise((r) => setTimeout(r, 50));
    const line = lines.slice(before).find((l) => l.endpoint === "traced");
    // Without this the paid call cannot be joined to the caller's own logs,
    // which is the entire reason to accept the header.
    expect(line?.traceId).toBe(traceId);
  });

  it("starts a trace for a caller who sent none", async () => {
    const res = await post("/work");
    expect(res.headers.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
  });

  it("starts a fresh trace rather than continuing a malformed one", async () => {
    const res = await post("/work", { headers: { traceparent: "00-not-a-trace-01" } });
    expect(res.headers.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(res.headers.get("traceparent")).not.toContain("not-a-trace");
  });

  /* ── signed manifest ─────────────────────────────────────────────────── */

  it("signs the manifest bytes it actually sent", async () => {
    const res = await fetch(`${base}/.well-known/ripar.json`);
    const body = await res.text();
    const signature = res.headers.get("x-ripar-manifest-signature")!;
    const signer = res.headers.get("x-ripar-manifest-signer")!;

    expect(res.headers.get("x-ripar-manifest-algorithm")).toBe("ed25519-mx");
    // Over the raw text, which is what a caller has. Verifying a re-serialised
    // parse is the mistake that makes every verification fail for no visible
    // reason.
    expect(verifyManifest(body, signature, signer)).toBe(true);
    expect(JSON.parse(body).signedBy).toBe(signer);
  });

  it("fails verification once a single byte of the manifest changes", async () => {
    const res = await fetch(`${base}/.well-known/ripar.json`);
    const body = await res.text();
    const signature = res.headers.get("x-ripar-manifest-signature")!;
    const signer = res.headers.get("x-ripar-manifest-signer")!;
    // The attack: a proxy rewrites payTo, and every settlement on this agent
    // goes to somebody else while the document still looks perfectly valid.
    const tampered = body.replace(PAY_TO, PAYER);
    expect(tampered).not.toBe(body);
    expect(verifyManifest(tampered, signature, signer)).toBe(false);
  });
});

/* ── SSE, which is the feature with something uncomfortable to report ───── */

describe("streaming", () => {
  /** Everything goes through the payment gate. */
  let base: string;
  /** Identical, plus a free tier — which is the only way to reach a streaming
   *  handler WITHOUT the payment middleware having patched res.write. Two
   *  servers rather than one so neither test depends on the other's ordering
   *  or on which payer has an allowance left. */
  let freeBase: string;
  let facilitator: Server;
  const servers: Server[] = [];

  beforeAll(async () => {
    facMode = "ok";
    facilitator = await listen(facilitatorApp());

    /** Writes three frames 120ms apart, so the arrival times say plainly
     *  whether anything was buffered. */
    const ticker = (ctx: StreamHandlerContext) =>
      (async () => {
        for (let i = 1; i <= 3; i++) {
          ctx.write(`frame ${i}`, { event: "tick", id: String(i) });
          await new Promise((r) => setTimeout(r, 120));
        }
      })();

    const agent = defineAgent({
      name: "Streamer",
      handle: "streamer",
      description: "SSE behind and beside the paywall.",
      payTo: PAY_TO,
      network: "testnet",
      endpoints: [
        defineEndpoint({ name: "ticks", price: "$0.01", stream: true, handler: ticker as never }),
        defineEndpoint({
          name: "breaks-late",
          price: "$0.01",
          stream: true,
          handler: (ctx) => {
            ctx.write!("partial");
            throw new Error("model died halfway");
          },
        }),
        defineEndpoint({
          name: "breaks-early",
          price: "$0.01",
          stream: true,
          handler: () => {
            throw new Error("nothing to stream");
          },
        }),
        defineEndpoint({
          name: "returns",
          price: "$0.01",
          stream: true,
          handler: (ctx) => {
            ctx.write!("chunk");
            return { total: 2 };
          },
        }),
      ],
    });

    const common = {
      network: "testnet" as const,
      payTo: PAY_TO,
      facilitatorUrl: `http://127.0.0.1:${portOf(facilitator)}`,
    };
    const paid = await listen(await createServer(agent, common));
    const free = await listen(await createServer(agent, { ...common, freeTier: { callsPerPayer: 1 } }));
    servers.push(paid, free);
    base = `http://127.0.0.1:${portOf(paid)}`;
    freeBase = `http://127.0.0.1:${portOf(free)}`;
  });

  afterAll(async () => {
    for (const s of servers) await close(s);
    await close(facilitator);
  });

  it("serves well-formed event-stream frames from a paid call", async () => {
    // Everything about the FORMAT holds: content type, event names, ids, and
    // the blank-line framing an EventSource parser needs.
    const header = await payHeaderFor(base, "/ticks");
    const res = await fetch(`${base}/ticks`, {
      method: "POST",
      headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": header },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const { text } = await readStream(res as unknown as Response);
    expect(text).toBe(
      "id: 1\nevent: tick\ndata: frame 1\n\nid: 2\nevent: tick\ndata: frame 2\n\nid: 3\nevent: tick\ndata: frame 3\n\n"
    );
  });

  it("admits that a PAID stream is not incremental, and says so in a header", async () => {
    // THE uncomfortable test. @x402/express replaces res.write with a buffer
    // the moment a payment verifies, and replays it only after settlement — so
    // a frame written at +0ms does not leave the process until +360ms. Measured
    // here rather than asserted from the docs: every frame arrives after the
    // handler's last write.
    const header = await payHeaderFor(base, "/ticks");
    const res = await fetch(`${base}/ticks`, {
      method: "POST",
      headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": header },
      body: "{}",
    });
    expect(res.headers.get("x-ripar-stream")).toBe("buffered-until-settlement");

    const { chunks } = await readStream(res as unknown as Response);
    // The handler wrote its first frame immediately and its last at +240ms. If
    // anything were streaming, the first bytes would be here long before that.
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].at, "a paid stream delivered a frame early — re-read stream.ts").toBeLessThan(80);
    // Everything in one flush: the whole body arrives together.
    const spread = chunks[chunks.length - 1].at - chunks[0].at;
    expect(spread, "a paid stream spread its frames out over time").toBeLessThan(80);
  });

  it("streams genuinely incrementally when the call skipped the gate", async () => {
    // The free tier waves the request past the payment middleware, so nothing
    // patched res.write and the frames leave as they are written. This is what
    // makes the header above meaningful rather than decorative.
    const header = await payHeaderFor(freeBase, "/ticks");
    const res = await fetch(`${freeBase}/ticks`, {
      method: "POST",
      headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": header },
      body: "{}",
    });
    expect(res.headers.get("x-ripar-free-remaining")).toBe("0");
    expect(res.headers.get("x-ripar-stream")).toBe("incremental");

    const { chunks } = await readStream(res as unknown as Response);
    // Three writes 120ms apart really do arrive 120ms apart.
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0].at).toBeLessThan(80);
    expect(chunks[chunks.length - 1].at).toBeGreaterThan(200);
  });

  it("reports a failure that arrives after the first frame as an error event", async () => {
    // The status line is chosen before the first byte. Once a frame is out
    // there is no 5xx left to send, so the failure travels as an event and the
    // call IS charged — the caller received part of what they paid for.
    const header = await payHeaderFor(base, "/breaks-late");
    const res = await fetch(`${base}/breaks-late`, {
      method: "POST",
      headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": header },
      body: "{}",
    });
    expect(res.status).toBe(200);
    const { text } = await readStream(res as unknown as Response);
    expect(text).toContain("data: partial");
    expect(text).toContain("event: error");
    expect(text).toContain("model died halfway");
    // Charged, and honest about it: a receipt is present.
    expect(res.headers.get("payment-response")).toBeTruthy();
  });

  it("turns a value the handler returned into a final frame", async () => {
    // Otherwise `return { total }` at the end of a streaming handler is
    // silently discarded, which reads as the last frame having gone missing.
    const header = await payHeaderFor(base, "/returns");
    const res = await fetch(`${base}/returns`, {
      method: "POST",
      headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": header },
      body: "{}",
    });
    const { text } = await readStream(res as unknown as Response);
    expect(text).toBe('data: chunk\n\nevent: result\ndata: {"total":2}\n\n');
  });

  it("still answers a 5xx when the handler fails before its first frame", async () => {
    // Nothing was committed, so the ordinary contract applies: any status >= 400
    // cancels settlement and the caller is not charged.
    const header = await payHeaderFor(base, "/breaks-early");
    const res = await fetch(`${base}/breaks-early`, {
      method: "POST",
      headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": header },
      body: "{}",
    });
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("payment-response"), "a failed stream settled anyway").toBeNull();
  });
});

/* ── facilitator degradation ────────────────────────────────────────────── */

describe("a facilitator that is down", () => {
  let base: string;
  let stop: () => Promise<void>;
  let facilitator: Server;
  let payHeader: string;

  beforeAll(async () => {
    facMode = "ok";
    facilitator = await listen(facilitatorApp());
    const agent = defineAgent({
      name: "Degrades",
      handle: "degrades",
      description: "What a caller is told when the payment layer breaks.",
      payTo: PAY_TO,
      network: "testnet",
      endpoints: [defineEndpoint({ name: "work", price: "$0.01", handler: () => ({ ok: true }) })],
    });
    const app = await createServer(agent, {
      network: "testnet",
      payTo: PAY_TO,
      facilitatorUrl: `http://127.0.0.1:${portOf(facilitator)}`,
      facilitatorRetryAfter: 7,
    });
    const server = await listen(app);
    base = `http://127.0.0.1:${portOf(server)}`;
    stop = () => close(server);
    payHeader = await payHeaderFor(base, "/work");
  });

  afterAll(async () => {
    facMode = "ok";
    await stop();
    await close(facilitator);
  });

  const call = () =>
    fetch(`${base}/work`, {
      method: "POST",
      headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": payHeader },
      body: "{}",
    });

  it("answers 503 with Retry-After when verify cannot be reached", async () => {
    facMode = "verify-down";
    const res = await call();
    const body = (await res.json()) as any;
    facMode = "ok";

    // Untreated, @x402/express answers 402 with an empty body here — which a
    // caller reads as "your payment was rejected", so it re-signs and retries
    // for as long as the outage lasts.
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("7");
    expect(body.error.code).toBe("facilitator_unavailable");
    expect(body.error.stage).toBe("verify");
    // The sentence an operator needs: which half is broken.
    expect(body.error.message).toMatch(/endpoint is working/i);
    expect(body.error.message).toMatch(/payment layer is not/i);
    expect(body.error.settlementAttempted).toBe(false);
  });

  it("treats a 5xx that still parses as a verify response as an outage", async () => {
    // The status is the whole signal here: the body says `isValid: false`,
    // which on a 4xx would be a verdict about this payment and must stay a 402.
    // On a 500 it is the facilitator failing to reach a verdict at all.
    facMode = "verify-5xx-json";
    const res = await call();
    const body = (await res.json()) as any;
    facMode = "ok";

    expect(res.status).toBe(503);
    expect(body.error.facilitatorStatus).toBe(500);
    expect(body.error.stage).toBe("verify");
  });

  it("says settlement was attempted when it is the settle call that failed", async () => {
    facMode = "settle-down";
    const res = await call();
    const body = (await res.json()) as any;
    facMode = "ok";

    expect(res.status).toBe(503);
    // The two stages have different consequences and the caller has to be told
    // which: a failed verify moved nothing, a failed settle happened after the
    // payment was accepted, so a blind retry can pay twice.
    expect(body.error.stage).toBe("settle");
    expect(body.error.settlementAttempted).toBe(true);
  });

  it("answers 503 when the connection dies rather than returning a status", async () => {
    // The other shape of an outage, and the one a load balancer produces: the
    // socket is closed with nothing on it, so there is no HTTP status to
    // classify — only a transport error. Same answer, and the Retry-After
    // default applies since this agent did not set one.
    const plain = await createServer(
      defineAgent({
        name: "Default Retry",
        handle: "default-retry",
        description: "Uses the default Retry-After.",
        payTo: PAY_TO,
        network: "testnet",
        endpoints: [defineEndpoint({ name: "work", price: "$0.01", handler: () => ({ ok: true }) })],
      }),
      { network: "testnet", payTo: PAY_TO, facilitatorUrl: `http://127.0.0.1:${portOf(facilitator)}` }
    );
    const server = await listen(plain);
    const plainBase = `http://127.0.0.1:${portOf(server)}`;
    const header = await payHeaderFor(plainBase, "/work");

    facMode = "verify-hangup";
    const res = await fetch(`${plainBase}/work`, {
      method: "POST",
      headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": header },
      body: "{}",
    });
    const body = (await res.json()) as any;
    facMode = "ok";

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(body.error.code).toBe("facilitator_unavailable");
    await close(server);
  });

  it("leaves a payment the facilitator legitimately refused as a 402", async () => {
    // The other direction of the same bug. Answering "isValid: false" as 503
    // tells a caller to retry a payment that will never be accepted.
    facMode = "verify-refuses";
    const res = await call();
    facMode = "ok";
    expect(res.status).toBe(402);
    expect(res.headers.get("retry-after")).toBeNull();
  });

  it("does not touch an ordinary quote", async () => {
    const res = await fetch(`${base}/work`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(402);
    expect(res.headers.get("payment-required")).toBeTruthy();
  });
});

/* ── the programmatic handle ────────────────────────────────────────────── */

describe("serve() returns a usable handle", () => {
  let facilitator: Server;

  beforeAll(async () => {
    facMode = "ok";
    facilitator = await listen(facilitatorApp());
  });
  afterAll(async () => {
    await close(facilitator);
  });

  const agentFor = () =>
    defineAgent({
      name: "Handled",
      handle: "handled",
      description: "Started programmatically.",
      payTo: PAY_TO,
      network: "testnet",
      endpoints: [defineEndpoint({ name: "work", price: "$0.01", handler: () => ({ ok: true }) })],
    });

  it("hands back url, port, address, metrics, runs and close", async () => {
    const listening = await serve(agentFor(), {
      port: 0,
      network: "testnet",
      payTo: PAY_TO,
      facilitatorUrl: `http://127.0.0.1:${portOf(facilitator)}`,
      handleSignals: false,
      onReady: () => {},
      onShutdown: () => {},
    });
    const { url, port, address, metrics, runs } = listening.handle;

    // The real port, not the 0 that was asked for — which is the whole reason
    // an embedder had to call address() before.
    expect(port).toBeGreaterThan(0);
    expect(url).toBe(`http://127.0.0.1:${port}`);
    expect(address).toBe(PAY_TO);

    expect((await fetch(`${url}/health`)).status).toBe(200);
    await fetch(`${url}/work`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    // The counters are written by the response's `finish` hook, which the
    // client does not wait for.
    await new Promise((r) => setTimeout(r, 50));
    // The very objects /metrics and /_ripar/runs read from, in process — which
    // is what an embedder wants when it is already inside the same process and
    // scraping itself over HTTP would be absurd.
    expect(metrics.render()).toContain('ripar_requests_total{endpoint="work",status="402"} 1');
    expect(runs.list(1)[0]).toMatchObject({ endpoint: "work", status: 402 });

    const result = await listening.handle.close("test");
    expect(result.outcome).toBe("drained");
    await expect(fetch(`${url}/health`)).rejects.toThrow();
    listening.uninstallSignals();
  });

  it("keeps everything an existing caller already used", async () => {
    const listening = await serve(agentFor(), {
      port: 0,
      network: "testnet",
      payTo: PAY_TO,
      facilitatorUrl: `http://127.0.0.1:${portOf(facilitator)}`,
      handleSignals: false,
      onReady: () => {},
      onShutdown: () => {},
    });
    // Serve one request before shutting down. @x402/express kicks off its
    // facilitator handshake when the middleware is built and only awaits it on
    // the first gated request; closing the facilitator with that still in
    // flight leaves an unhandled rejection with nothing to attribute it to.
    await fetch(`${listening.url}/work`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    // Still an http.Server: address() is a METHOD, and shadowing it with the
    // agent's Algorand address would have broken every caller reading the bound
    // port this way — including this repo's own shutdown test.
    expect(typeof listening.address).toBe("function");
    expect((listening.address() as { port: number }).port).toBe(listening.port);
    expect(typeof listening.shutdown).toBe("function");
    expect(typeof listening.on).toBe("function");

    await listening.shutdown("test");
    listening.uninstallSignals();
  });
});
