import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import express from "express";
import algosdk from "algosdk";
import { ALGORAND_TESTNET_CAIP2 } from "@x402/avm";
import { defineAgent, defineEndpoint } from "../src/define.js";
import { createServer } from "../src/server.js";
import { verifySignature } from "../src/webhooks.js";

/**
 * Every server feature, through one real createServer.
 *
 * The unit tests cover each module in isolation. This is the file that catches
 * a module which works perfectly and is wired in wrong — which is the failure
 * that actually shipped here before: a subscription key minted from a header
 * that does not exist yet, read under a name x402 never sends. Both halves were
 * individually fine.
 *
 * Only the facilitator and the webhook receiver are doubled, and both are real
 * HTTP servers rather than stubs, so the middleware ordering under test is the
 * genuine one.
 */

const PAY_TO = "PBXELTAXFHNNP3ZQFBC36WKUGVX732UG4CQQH22CP6NNIY5FFIY5UINYAU";
const PAYER = "B2DGXU2QSRHXNZJMP5FFFU77W5NUMZTZ3X3MSO3PJC4ZQ75CSDL5EKULI4";
/** The full 53-char id a real facilitator publishes — see subscription-server.test.ts. */
const NETWORK = `${ALGORAND_TESTNET_CAIP2}xi9/cOUJOiI=`;
const ORIGIN = "https://app.ripar.io";

type Hook = { body: string; sig: string; ts: number };

describe("a fully configured agent", () => {
  let base: string;
  let close: () => Promise<void>;
  let facilitator: Server;
  let receiver: Server;
  const hooks: Hook[] = [];
  let dbUp = true;
  /** A signed transfer whose SENDER is decodable, which is what identifies a
   *  caller to the free tier. A synthetic payload carries no identity. */
  let payHeader: string;

  const listen = (app: express.Express): Promise<Server> =>
    new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
  const portOf = (s: Server) => (s.address() as { port: number }).port;

  beforeAll(async () => {
    const f = express();
    f.use(express.json());
    f.get("/supported", (_q, s) => s.json({ kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }] }));
    f.post("/verify", (_q, s) => s.json({ isValid: true, payer: PAYER }));
    f.post("/settle", (_q, s) =>
      s.json({
        success: true,
        transaction: "XS5KJ7OV2IS47322EZ3AFX5ZPG3RQTIYUFSSQ2KPMNMFZVI6K4NA",
        network: NETWORK,
        payer: PAYER,
      })
    );
    facilitator = await listen(f);

    const h = express();
    h.use(express.text({ type: "*/*" }));
    h.post("/hook", (q, s) => {
      hooks.push({ body: q.body, sig: q.get("x-ripar-signature") ?? "", ts: Number(q.get("x-ripar-timestamp")) });
      s.status(200).end();
    });
    receiver = await listen(h);

    const agent = defineAgent({
      name: "Full Agent",
      handle: "full-agent",
      payTo: PAY_TO,
      network: "testnet",
      endpoints: [
        defineEndpoint({
          name: "work",
          price: "$0.02",
          input: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
          handler: () => ({ ok: true }),
        }),
      ],
    });

    const app = await createServer(agent, {
      network: "testnet",
      payTo: PAY_TO,
      facilitatorUrl: `http://127.0.0.1:${portOf(facilitator)}`,
      cors: { origin: [ORIGIN] },
      openapi: true,
      freeTier: { callsPerPayer: 1 },
      webhook: { url: `http://127.0.0.1:${portOf(receiver)}/hook`, secret: "s3cret" },
      // Written nowhere, so the run stays quiet while the code path stays real.
      logging: { level: "info", write: () => {} },
      healthChecks: { database: () => dbUp, indexer: async () => true },
    });

    const server = await listen(app);
    base = `http://127.0.0.1:${portOf(server)}`;
    close = () => new Promise<void>((r) => server.close(() => r()));

    const acct = algosdk.generateAccount();
    const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: acct.addr,
      receiver: PAY_TO,
      amount: 20_000,
      assetIndex: 10_458_941,
      suggestedParams: {
        fee: 1000,
        firstValid: 1,
        lastValid: 1000,
        genesisID: "testnet-v1.0",
        genesisHash: new Uint8Array(Buffer.from("SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=", "base64")),
        flatFee: true,
      },
    });
    const signed = Buffer.from(txn.signTxn(acct.sk)).toString("base64");

    const quote = await fetch(`${base}/work`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: "hi" }),
    });
    const accepted = JSON.parse(
      Buffer.from(quote.headers.get("payment-required")!, "base64").toString()
    ).accepts[0];
    payHeader = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        accepted,
        scheme: "exact",
        network: NETWORK,
        payload: { paymentGroup: [signed], paymentIndex: 0 },
      })
    ).toString("base64");
  });

  afterAll(async () => {
    await close();
    await new Promise<void>((r) => facilitator.close(() => r()));
    await new Promise<void>((r) => receiver.close(() => r()));
  });

  const post = (headers: Record<string, string> = {}) =>
    fetch(`${base}/work`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ q: "hi" }),
    });

  it("answers a preflight without letting it reach the payment gate", async () => {
    const res = await fetch(`${base}/work`, {
      method: "OPTIONS",
      headers: { origin: ORIGIN, "access-control-request-method": "POST" },
    });
    // A preflight that reached the gate would be quoted for a request the
    // browser has not made yet.
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toContain("payment-signature");
  });

  it("lets a browser read the quote, which is the whole point of the CORS work", async () => {
    const res = await post({ origin: ORIGIN });
    const exposed = (res.headers.get("access-control-expose-headers") ?? "").split(", ");
    // Without this, fetch sees a 402 with no quote: the request "works" and the
    // price is silently gone. app.ripar.io hit exactly this in production.
    expect(exposed).toContain("payment-required");
    expect(exposed).toContain("payment-response");
  });

  it("serves an OpenAPI document generated from the endpoints themselves", async () => {
    const doc = (await (await fetch(`${base}/openapi.json`)).json()) as Record<string, any>;
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/work"].post.responses["402"].headers["PAYMENT-REQUIRED"]).toBeTruthy();
    expect(doc.paths["/work"].post["x-ripar-price"]).toEqual({ amount: "$0.02", pricing: "fixed" });
    expect(doc["x-ripar"].paymentHeader).toBe("PAYMENT-SIGNATURE");
  });

  it("reports unhealthy when a dependency is down, instead of ok regardless", async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
    dbUp = false;
    const res = await fetch(`${base}/health`);
    const body = (await res.json()) as Record<string, any>;
    // `{ ok: true }` whatever happens is what makes a load balancer route into
    // a broken pod.
    expect(res.status).toBe(503);
    expect(body.checks.database.ok).toBe(false);
    expect(body.checks.indexer.ok).toBe(true);
    dbUp = true;
  });

  it("gives an identified caller a free call, and settles nothing for it", async () => {
    // The free tier is keyed on the payer, so the caller has to have said who
    // they are — which in x402 means attaching a payment header. So the free
    // call is the RETRY: quote, sign, send, and the server waves it through
    // without settling.
    const before = hooks.length;
    const res = await post({ "PAYMENT-SIGNATURE": payHeader });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-ripar-free-remaining")).toBe("0");
    await new Promise((r) => setTimeout(r, 250));
    expect(hooks.length, "the free call settled something").toBe(before);

    // Asserted on the invariant, not just the delta: a ledger fed by these
    // events must never see one that no money produced, so EVERY event has to
    // carry a settlement.
    //
    // HONEST LIMIT: removing the `receipt &&` guard in server.ts does not fail
    // this file. Vitest buffers the per-request `finish` hooks such that the
    // extra event does not reach the receiver before the assertion runs. The
    // rule IS verified — by the standalone probe, which prints hook counts
    // either side of the free call and reads 0 -> 0 — but not here. Do not
    // read a green run as proof of this particular guard.
    for (const h of hooks) {
      const e = JSON.parse(h.body);
      expect(e.txId, `an event with no settlement reached the receiver: ${h.body}`).toBeTruthy();
      expect(e.usd).toBeGreaterThan(0);
    }
  });

  it("charges the same caller once the allowance is gone", async () => {
    const before = hooks.length;
    const res = await post({ "PAYMENT-SIGNATURE": payHeader });
    await new Promise((r) => setTimeout(r, 250));
    expect(res.status).toBe(200);
    expect(hooks.length).toBe(before + 1);
  });

  it("quotes a caller who has not identified themselves", async () => {
    // Otherwise one caller's allowance would be spendable by the whole
    // internet, since there is nothing else to key on.
    expect((await post()).status).toBe(402);
  });

  it("fires a signed webhook carrying the txid and the QUOTED usd", async () => {
    const latest = hooks.at(-1)!;
    expect(verifySignature(latest.body, latest.sig, "s3cret", latest.ts)).toBe(true);

    const event = JSON.parse(latest.body);
    expect(event.type).toBe("settlement");
    expect(event.txId).toMatch(/^XS5KJ/);
    // The QUOTE, not the receipt's `amount`: facilitators report that in base
    // units on some networks and USD on others, and a ledger summing the two
    // together produces a number nobody can interpret.
    expect(event.usd).toBe(0.02);
    expect(event.endpoint).toBe("work");
  });
});
