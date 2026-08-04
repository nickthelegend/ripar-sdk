import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import express from "express";
import algosdk from "algosdk";
import { defineAgent, defineEndpoint } from "../src/define.js";
import { RiparClient } from "../src/client.js";
import { createServer } from "../src/server.js";
import { MemorySubscriptionStore } from "../src/subscriptions.js";
import { readPaymentRequired } from "../src/headers.js";
import { ALGORAND_TESTNET_CAIP2 } from "@x402/avm";

/**
 * Subscriptions through the REAL server, not around it.
 *
 * The first version of prove-subscription.mjs hand-rolled its own Express app
 * and called `issue()` itself, so it went green while `createServer` minted
 * nothing at all — deleting the entire feature from server.ts would not have
 * failed it. This exercises `createServer` with the genuine @x402/express
 * middleware, so the ordering that broke it is actually in play: the middleware
 * buffers the body, runs the handler, and only THEN settles and writes
 * PAYMENT-RESPONSE.
 *
 * The only thing replaced is the facilitator, which is a remote service on
 * somebody else's chain — swapping it for a local HTTP server keeps every line
 * of our own code and the whole middleware stack real.
 */

const PAY_TO = "PBXELTAXFHNNP3ZQFBC36WKUGVX732UG4CQQH22CP6NNIY5FFIY5UINYAU";
const PAYER = "B2DGXU2QSRHXNZJMP5FFFU77W5NUMZTZ3X3MSO3PJC4ZQ75CSDL5EKULI4";
/**
 * What a REAL facilitator publishes: the full 53-character genesis hash.
 *
 *   GoPlausible /supported : algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=   (53)
 *   @x402/avm constant     : algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe               (41)
 *
 * CAIP-2 caps a reference at 32 characters, so the exported constant is a
 * TRUNCATION of what every facilitator actually quotes. That is the whole
 * reason the client must register the glob "algorand:*" rather than the
 * constant — @x402/core matches a registration by exact key or glob and has no
 * prefix fallback, so registering the constant finds no scheme and the client
 * cannot pay anything.
 *
 * Publishing the truncated constant here would make the test agree with a
 * broken client, which is exactly what it must not do.
 */
const NETWORK = `${ALGORAND_TESTNET_CAIP2}xi9/cOUJOiI=`;

/** Counts what the server asked of it, so a test can assert how many times
 *  money actually moved rather than how many requests were made. */
type Facilitator = {
  url: string;
  close: () => Promise<void>;
  verifies: number;
  settles: number;
  /** Force settlement to fail, to check a verified-but-unsettled payment does
   *  not leave the caller holding a window they never paid for. */
  failSettle: boolean;
};

async function startFacilitator(): Promise<Facilitator> {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  const state = { verifies: 0, settles: 0, failSettle: false };

  app.get("/supported", (_req, res) => {
    res.json({ kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }] });
  });

  app.post("/verify", (_req, res) => {
    state.verifies++;
    res.json({ isValid: true, payer: PAYER });
  });

  app.post("/settle", (_req, res) => {
    state.settles++;
    if (state.failSettle) {
      return res.json({ success: false, errorReason: "insufficient_funds", payer: PAYER });
    }
    res.json({
      success: true,
      transaction: "XS5KJ7OV2IS47322EZ3AFX5ZPG3RQTIYUFSSQ2KPMNMFZVI6K4NA",
      network: NETWORK,
      payer: PAYER,
    });
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    get verifies() {
      return state.verifies;
    },
    get settles() {
      return state.settles;
    },
    get failSettle() {
      return state.failSettle;
    },
    set failSettle(v: boolean) {
      state.failSettle = v;
    },
  } as Facilitator;
}

/**
 * What a paying caller sends.
 *
 * Two details that are easy to get wrong and silently produce a second 402
 * rather than an error: the header is PAYMENT-SIGNATURE (x402 v2 — core's
 * extractPayment reads only that name), and the payload must carry `accepted`,
 * the exact requirements entry being paid. findMatchingRequirements compares
 * that against the server's accepts list, so a payload without it matches
 * nothing and never reaches the facilitator at all.
 *
 * The signed transaction is a placeholder: validating a signature is the
 * facilitator's job, and the facilitator is the one thing this file replaces.
 */
function paymentHeader(accepted: unknown) {
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted,
      scheme: "exact",
      network: NETWORK,
      payload: { transaction: "dGVzdA==" },
    })
  ).toString("base64");
}

/** Read the live challenge so the payment quotes back exactly what was asked. */
async function challengeFor(base: string, path: string) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const req = readPaymentRequired(res.headers) as { accepts?: unknown[] };
  return req?.accepts?.[0];
}

describe("subscriptions through createServer", () => {
  let base: string;
  let close: () => Promise<void>;
  let fac: Facilitator;
  let store: MemorySubscriptionStore;
  let handlerRuns = 0;

  beforeAll(async () => {
    fac = await startFacilitator();
    store = new MemorySubscriptionStore();

    const feed = defineEndpoint({
      name: "feed",
      description: "Sells a window rather than a call.",
      subscription: { price: "$5.00", period: "2s" },
      handler: () => {
        handlerRuns++;
        return { items: ["one", "two"] };
      },
    });

    const once = defineEndpoint({
      name: "once",
      price: "$0.01",
      handler: () => ({ ok: true }),
    });

    const agent = defineAgent({
      name: "Window Agent",
      handle: "window-agent",
      payTo: PAY_TO,
      network: "testnet",
      endpoints: [feed, once],
    });

    const app = await createServer(agent, {
      network: "testnet",
      payTo: PAY_TO,
      facilitatorUrl: fac.url,
      subscriptions: { store },
    });

    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const port = (server.address() as { port: number }).port;
    base = `http://127.0.0.1:${port}`;
    close = () => new Promise<void>((r) => server.close(() => r()));
  });

  afterAll(async () => {
    await close();
    await fac.close();
  });

  it("quotes the window, not the call, on an unpaid request", async () => {
    const res = await fetch(`${base}/feed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(402);

    const req = readPaymentRequired(res.headers) as { accepts?: { amount?: string }[] };
    const amount = req?.accepts?.[0]?.amount;
    // $5.00 at six decimals. If this said 10000 the window would be priced like
    // a single call.
    expect(String(amount)).toBe("5000000");
  });

  it("issues a key when the payment settles", async () => {
    const before = fac.settles;
    const accepted = await challengeFor(base, "/feed");
    const res = await fetch(`${base}/feed`, {
      method: "POST",
      headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": paymentHeader(accepted) },
      body: "{}",
    });

    expect(res.status).toBe(200);
    const key = res.headers.get("x-ripar-subscription");
    // The regression that prompted this file: the key was minted from a
    // settlement header that does not exist yet, so this was always null.
    expect(key, "no key on the response — the caller paid for nothing").toMatch(/^rsk_/);
    expect(res.headers.get("x-ripar-subscription-expires")).toBeTruthy();
    expect(fac.settles).toBe(before + 1);

    // And it is really in the store, not merely on the wire.
    expect(store.size).toBeGreaterThan(0);

    (globalThis as Record<string, unknown>).__key = key;
  });

  it("lets the key through free, without touching the facilitator", async () => {
    const key = (globalThis as Record<string, unknown>).__key as string;
    const settlesBefore = fac.settles;
    const verifiesBefore = fac.verifies;
    const runsBefore = handlerRuns;

    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${base}/feed`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ripar-subscription": key },
        body: "{}",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ items: ["one", "two"] });
    }

    // The whole point of a window: three calls, no money, no facilitator.
    expect(fac.settles).toBe(settlesBefore);
    expect(fac.verifies).toBe(verifiesBefore);
    expect(handlerRuns).toBe(runsBefore + 3);
  });

  it("reports how much of the window is left", async () => {
    const key = (globalThis as Record<string, unknown>).__key as string;
    const res = await fetch(`${base}/feed`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ripar-subscription": key },
      body: "{}",
    });
    const remaining = Number(res.headers.get("x-ripar-subscription-remaining-ms"));
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(2000);
  });

  it("quotes again once the window closes", async () => {
    const key = (globalThis as Record<string, unknown>).__key as string;
    await new Promise((r) => setTimeout(r, 2100));

    const res = await fetch(`${base}/feed`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ripar-subscription": key },
      body: "{}",
    });
    expect(res.status).toBe(402);
    // "expired" and "unknown" are different problems; only the first is one the
    // caller can do something about.
    expect(res.headers.get("x-ripar-subscription-status")).toBe("expired");
  });

  it("refuses a key sold by a different endpoint", async () => {
    // Buy a window on `feed`, then present it to `once`.
    const accepted = await challengeFor(base, "/feed");
    const bought = await fetch(`${base}/feed`, {
      method: "POST",
      headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": paymentHeader(accepted) },
      body: "{}",
    });
    const key = bought.headers.get("x-ripar-subscription")!;
    expect(key).toMatch(/^rsk_/);

    const res = await fetch(`${base}/once`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ripar-subscription": key },
      body: "{}",
    });
    // `once` is priced per call and sells no window, so the key means nothing
    // there and the gate quotes normally.
    expect(res.status).toBe(402);
  });

  it("revokes the window when the payment verifies but fails to settle", async () => {
    fac.failSettle = true;
    try {
      const accepted = await challengeFor(base, "/feed");
      const res = await fetch(`${base}/feed`, {
        method: "POST",
        headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": paymentHeader(accepted) },
        body: "{}",
      });
      const key = res.headers.get("x-ripar-subscription");

      // A key may have been handed out — it is minted on verification, which is
      // the only signal available before the handler runs. What must NOT happen
      // is that it keeps working after the payment failed.
      if (key) {
        // The revoke is fired from the `finish` hook, so give the event loop a
        // turn before asking.
        await new Promise((r) => setTimeout(r, 50));
        const retry = await fetch(`${base}/feed`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-ripar-subscription": key },
          body: "{}",
        });
        expect(retry.status, "a failed settlement still bought a window").toBe(402);
      }
    } finally {
      fac.failSettle = false;
    }
  });
});

/**
 * Settlement observability, which the header-name bug silently disabled.
 *
 * readPaymentResponse looked for X-PAYMENT-RESPONSE while @x402/core emits
 * PAYMENT-RESPONSE, so no receipt was ever found: ripar_settled_total and
 * ripar_settled_usd_total sat at zero however much money moved, and no run
 * recorded the transaction that paid for it. An operator watching those
 * counters would have concluded the agent had never been paid.
 */
describe("settlement is actually observed", () => {
  let base: string;
  let close: () => Promise<void>;
  let fac: Facilitator;

  beforeAll(async () => {
    fac = await startFacilitator();
    const work = defineEndpoint({ name: "work", price: "$0.25", handler: () => ({ ok: true }) });
    const agent = defineAgent({
      name: "Metrics Agent",
      handle: "metrics-agent",
      payTo: PAY_TO,
      network: "testnet",
      endpoints: [work],
    });
    const app = await createServer(agent, {
      network: "testnet",
      payTo: PAY_TO,
      facilitatorUrl: fac.url,
    });
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    close = () => new Promise<void>((r) => server.close(() => r()));
  });

  afterAll(async () => {
    await close();
    await fac.close();
  });

  it("counts settled calls and USD, and records the txId on the run", async () => {
    const accepted = await challengeFor(base, "/work");
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${base}/work`, {
        method: "POST",
        headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": paymentHeader(accepted) },
        body: "{}",
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("payment-response"), "no receipt on the response").toBeTruthy();
    }
    // `finish` fires after the response is flushed; give the loop a turn.
    await new Promise((r) => setTimeout(r, 80));

    const metrics = await (await fetch(`${base}/metrics`)).text();
    const value = (name: string) =>
      Number(metrics.split("\n").find((l) => l.startsWith(name + " "))?.split(" ")[1]);

    expect(value("ripar_settled_total"), "settlement counter never moved").toBe(3);
    // The QUOTE is what is summed, not the receipt's amount — facilitators
    // report base units on some networks and USD on others.
    expect(value("ripar_settled_usd_total")).toBeCloseTo(0.75, 6);

    const runs = (await (await fetch(`${base}/_ripar/runs`)).json()) as {
      runs: { txId?: string }[];
    };
    expect(runs.runs.filter((r) => r.txId).length).toBe(3);
  });
});

/**
 * RiparClient paying a real Ripar server, all the way through.
 *
 * payment-layer.test.ts reconstructed the scheme registration by hand — it
 * imported x402Client and ExactAvmScheme directly and never touched
 * RiparClient. So it tested @x402/core's behaviour, not ours: reverting
 * client.ts to register CAIP2[network] instead of "algorand:*" left it green
 * while the client could not pay anything at all.
 *
 * This constructs the actual client and makes it pay the actual server. The
 * facilitator is still the only double, and the wallet is a throwaway keypair
 * with no funds — signing needs no balance, and the facilitator decides
 * whether a payment is good.
 */
describe("RiparClient against a Ripar server", () => {
  let base: string;
  let close: () => Promise<void>;
  let fac: Facilitator;
  let mnemonic: string;

  beforeAll(async () => {
    fac = await startFacilitator();
    const acct = algosdk.generateAccount();
    mnemonic = algosdk.secretKeyToMnemonic(acct.sk);

    const agent = defineAgent({
      name: "Client Agent",
      handle: "client-agent",
      payTo: PAY_TO,
      network: "testnet",
      endpoints: [defineEndpoint({ name: "work", price: "$0.02", handler: () => ({ ok: true }) })],
    });
    const app = await createServer(agent, {
      network: "testnet",
      payTo: PAY_TO,
      facilitatorUrl: fac.url,
    });
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    close = () => new Promise<void>((r) => server.close(() => r()));
  });

  afterAll(async () => {
    await close();
    await fac.close();
  });

  it("completes the 402 handshake and returns the handler's answer", async () => {
    const client = new RiparClient({ mnemonic, network: "testnet", maxPrice: "$1.00" });
    const res = await client.call(`${base}/work`, { hello: 1 });

    expect(res.status).toBe(200);
    expect(res.data).toEqual({ ok: true });
    // A receipt means the middleware settled and the client read it back.
    expect(res.payment?.txId).toBeTruthy();
  });

  it("refuses a quote above maxPrice without settling", async () => {
    const before = fac.settles;
    const client = new RiparClient({ mnemonic, network: "testnet", maxPrice: "$0.001" });
    await expect(client.call(`${base}/work`, { hello: 1 })).rejects.toThrow(/maxPrice/);
    // The cap has to stop the payment, not report it afterwards.
    expect(fac.settles).toBe(before);
  });

  it("stops once the daily cap is spent", async () => {
    const client = new RiparClient({ mnemonic, network: "testnet", maxPerDay: "$0.05" });
    await client.call(`${base}/work`, {});
    await client.call(`${base}/work`, {});
    expect(client.spentToday).toBeCloseTo(0.04, 6);
    // A third call would take it to $0.06, past the cap.
    await expect(client.call(`${base}/work`, {})).rejects.toThrow(/daily cap/);
  });

  it("keeps composed headers when the caller passes their own", async () => {
    // `...init` used to be spread AFTER the headers object, so any init.headers
    // replaced the whole thing — dropping content-type, which left the body
    // unparsed on the server.
    const client = new RiparClient({ mnemonic, network: "testnet" });
    const res = await client.call(`${base}/work`, { hello: 1 }, { headers: { "x-trace": "abc" } });
    expect(res.status).toBe(200);
    expect(res.payment?.txId).toBeTruthy();
  });
});
