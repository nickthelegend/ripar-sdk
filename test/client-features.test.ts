import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import express from "express";
import algosdk from "algosdk";
import { defineAgent, defineEndpoint } from "../src/define.js";
import { RiparClient } from "../src/client.js";
import { createServer } from "../src/server.js";
import { MemorySubscriptionStore } from "../src/subscriptions.js";
import { QuoteCache, quoteKey } from "../src/quotecache.js";
import { Limiter } from "../src/limiter.js";
import { coversPayment, type WalletBalance } from "../src/balance.js";
import { exportReceipts } from "../src/receipts.js";
import { resolveFacilitator } from "../src/network.js";
import { USDC_ASSET_ID } from "../src/types.js";
import { ALGORAND_TESTNET_CAIP2 } from "@x402/avm";

/**
 * The client-side features, exercised against a REAL Ripar server.
 *
 * Same rule as subscription-server.test.ts: the only thing doubled is the
 * facilitator, because it is a remote service on somebody else's chain.
 * Everything else — the @x402/express middleware, the payment gate, the 402
 * handshake, the client's own fetch wrapping — is the code that ships. A cache
 * or a limiter tested against a hand-rolled stub proves the stub works.
 *
 * algod is stubbed where a balance is involved, for the same reason: reading an
 * account is a call to a public node, and the point of the test is what the
 * client does with the answer.
 */

const PAY_TO = "PBXELTAXFHNNP3ZQFBC36WKUGVX732UG4CQQH22CP6NNIY5FFIY5UINYAU";
const PAYER = "B2DGXU2QSRHXNZJMP5FFFU77W5NUMZTZ3X3MSO3PJC4ZQ75CSDL5EKULI4";
/** The FULL 53-character genesis hash a real facilitator publishes, not the
 *  truncated CAIP-2 constant — see subscription-server.test.ts. */
const NETWORK = `${ALGORAND_TESTNET_CAIP2}xi9/cOUJOiI=`;
const USDC = USDC_ASSET_ID.testnet;

type Facilitator = { url: string; close: () => Promise<void>; verifies: number; settles: number };

async function startFacilitator(): Promise<Facilitator> {
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  const state = { verifies: 0, settles: 0 };

  app.get("/supported", (_req, res) => {
    res.json({ kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }] });
  });
  app.post("/verify", (_req, res) => {
    state.verifies++;
    res.json({ isValid: true, payer: PAYER });
  });
  app.post("/settle", (req, res) => {
    state.settles++;
    res.json({
      success: true,
      transaction: "XS5KJ7OV2IS47322EZ3AFX5ZPG3RQTIYUFSSQ2KPMNMFZVI6K4NA",
      network: NETWORK,
      payer: PAYER,
      // What settled is what was required, echoed back in atomic units — that
      // is the `amount` field of x402's SettleResponse, and the only reason a
      // receipt carries a number at all.
      amount: req.body?.paymentRequirements?.amount,
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
  } as Facilitator;
}

/** The paid leg arrives as a Request rather than a URL string, because
 *  @x402/fetch re-sends the original one after signing. Stringifying it yields
 *  "[object Request]", so every wrapper here has to read `.url` and pass the
 *  original object straight through. */
function targetOf(url: string | URL | Request): string {
  if (typeof url === "string") return url;
  if (url instanceof URL) return url.toString();
  return (url as Request).url;
}

/** Counts what actually left the process, which is the only way to prove a
 *  cache served something instead of the network. */
function countingFetch() {
  const seen: string[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push(targetOf(url));
    return globalThis.fetch(url as string, init);
  }) as unknown as typeof fetch;
  return {
    impl,
    seen,
    get count() {
      return seen.length;
    },
  };
}

/** Real network for the agent, a canned account for algod. */
function fetchWithAlgod(account: Record<string, unknown> | null, status = 200) {
  const seen: string[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = targetOf(url);
    if (u.includes("/v2/accounts/")) {
      seen.push(u);
      return new Response(JSON.stringify(account ?? { message: "no such account" }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    return globalThis.fetch(url as string, init);
  }) as unknown as typeof fetch;
  return { impl, seen };
}

/** Fails loudly instead of hanging for the whole test timeout — a deadlock that
 *  looks like a slow test is a deadlock that gets ignored. */
/**
 * A rendezvous for the /slow endpoint.
 *
 * `want` is how many callers this test expects to be in flight at once. Each
 * arrival blocks until that many have arrived, then everyone is released
 * together. `expire` is a safety valve: if the client legitimately serialises
 * (which is what the bounded tests assert), the barrier must not hang the
 * suite — it releases on its own and inFlight simply never climbs.
 */
const slowBarrier = {
  want: 1,
  waiting: [] as (() => void)[],
  timer: undefined as ReturnType<typeof setTimeout> | undefined,
  reset(want: number) {
    this.release();
    this.want = want;
  },
  release() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const w = this.waiting;
    this.waiting = [];
    for (const r of w) r();
  },
  arrive(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiting.push(resolve);
      if (this.waiting.length >= this.want) return this.release();
      if (!this.timer) this.timer = setTimeout(() => this.release(), 750);
    });
  },
};

async function within<T>(ms: number, work: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not settle in ${ms}ms — deadlocked`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ── the shared agent every server-backed test calls ────────────────────── */

let base: string;
let close: () => Promise<void>;
let fac: Facilitator;
let mnemonic: string;
/** Live handler concurrency, so the limiter is measured where the sockets
 *  actually land rather than where the client thinks it sent them. */
let inFlight = 0;
let peakInFlight = 0;

beforeAll(async () => {
  fac = await startFacilitator();
  mnemonic = algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk);

  const agent = defineAgent({
    name: "Feature Agent",
    handle: "feature-agent",
    payTo: PAY_TO,
    network: "testnet",
    endpoints: [
      defineEndpoint({ name: "work", price: "$0.02", handler: () => ({ ok: true }) }),
      defineEndpoint({ name: "once", price: "$0.01", handler: () => ({ ok: true }) }),
      defineEndpoint({
        name: "slow",
        price: "$0.01",
        handler: async () => {
          inFlight++;
          peakInFlight = Math.max(peakInFlight, inFlight);
          // Hold until everyone expected has arrived, rather than sleeping a
          // fixed 60ms and hoping the windows overlap.
          //
          // With a sleep, "did these run concurrently?" was decided by whether
          // the machine happened to deliver the second request before the first
          // finished its nap. On a loaded box call 1 was done before call 2
          // arrived, peakInFlight stayed 1, and the test failed for a reason
          // that had nothing to do with the limiter. A barrier makes the
          // overlap a fact of the harness: nobody leaves until everybody is in,
          // so peakInFlight reaches slowBarrier.want whenever the client really
          // does run them together — and stays 1 when it genuinely serialises,
          // which is the thing under test.
          await slowBarrier.arrive();
          inFlight--;
          return { ok: true };
        },
      }),
      defineEndpoint({
        name: "weigh",
        // Priced by the body, which is the case a cache keyed on the URL alone
        // gets wrong — and gets wrong by paying.
        price: (ctx) => `$${(0.01 * Number((ctx.body as { n?: number })?.n ?? 1)).toFixed(2)}`,
        priceHint: "$0.01 per unit",
        handler: () => ({ ok: true }),
      }),
      defineEndpoint({
        name: "boom",
        price: "$0.01",
        handler: () => {
          throw Object.assign(new Error("nope"), { status: 400, code: "bad_input" });
        },
      }),
      defineEndpoint({
        name: "feed",
        description: "Sells a window rather than a call.",
        subscription: { price: "$5.00", period: "30d" },
        handler: () => ({ items: ["one"] }),
      }),
    ],
  });

  const app = await createServer(agent, {
    network: "testnet",
    payTo: PAY_TO,
    facilitatorUrl: fac.url,
    subscriptions: { store: new MemorySubscriptionStore() },
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

/* ── 1. the quote cache ─────────────────────────────────────────────────── */

describe("quote cache", () => {
  it("is off by default, so every quote is a fresh round trip", async () => {
    const net = countingFetch();
    const client = new RiparClient({ network: "testnet", fetchImpl: net.impl });
    await client.quote(`${base}/work`);
    await client.quote(`${base}/work`);
    expect(net.count).toBe(2);
  });

  it("serves a repeat quote from memory inside the TTL", async () => {
    const net = countingFetch();
    const client = new RiparClient({
      network: "testnet",
      quoteCache: { ttlMs: 60_000 },
      fetchImpl: net.impl,
    });
    const first = await client.quote(`${base}/work`);
    const second = await client.quote(`${base}/work`);

    expect(net.count).toBe(1);
    expect(second).toEqual(first);
    expect(second.paymentRequired).toBe(true);
  });

  it("quotes again once the TTL has passed, because a price can change", async () => {
    const net = countingFetch();
    const client = new RiparClient({
      network: "testnet",
      quoteCache: { ttlMs: 25 },
      fetchImpl: net.impl,
    });
    await client.quote(`${base}/work`);
    await sleep(60);
    await client.quote(`${base}/work`);
    expect(net.count).toBe(2);
  });

  it("keys on the body, so one request's price is never served to another", async () => {
    const net = countingFetch();
    const client = new RiparClient({
      network: "testnet",
      quoteCache: { ttlMs: 60_000 },
      fetchImpl: net.impl,
    });

    const cheap = await client.quote(`${base}/weigh`, { body: JSON.stringify({ n: 1 }) });
    const dear = await client.quote(`${base}/weigh`, { body: JSON.stringify({ n: 5 }) });

    // Same URL, different body, different price. Keyed on the URL alone the
    // second quote would come back as $0.01 and the client would then pay
    // $0.05 having verified $0.01.
    expect(amountOf(cheap)).toBe("10000");
    expect(amountOf(dear)).toBe("50000");
    expect(net.count).toBe(2);
  });

  it("hands call()'s pre-flight the quote estimate() just took", async () => {
    const net = countingFetch();
    const client = new RiparClient({
      mnemonic,
      network: "testnet",
      maxPrice: "$1.00",
      quoteCache: { ttlMs: 60_000 },
      fetchImpl: net.impl,
    });

    await client.estimate([{ url: `${base}/work`, body: { hello: 1 } }]);
    expect(net.count).toBe(1);

    const res = await client.call(`${base}/work`, { hello: 1 });
    expect(res.status).toBe(200);
    // Two legs of the handshake and nothing else: the capped pre-flight quote
    // came out of the cache.
    expect(net.count).toBe(3);
  });

  it("never returns an entry past its TTL, at the boundary or beyond", () => {
    // The rule the cache exists to not break: `call()` pays what the pre-flight
    // quote said, so a quote served one millisecond past its life is an amount
    // nobody verified.
    const cache = new QuoteCache<number>({ ttlMs: 1_000 });
    cache.set("k", 7, 0);
    expect(cache.get("k", 999)).toBe(7);
    expect(cache.get("k", 1_000)).toBeUndefined();
    expect(cache.get("k", 10_000)).toBeUndefined();
  });

  it("evicts the oldest rather than growing without limit", () => {
    const cache = new QuoteCache<number>({ ttlMs: 60_000, max: 2 });
    cache.set("a", 1, 0);
    cache.set("b", 2, 0);
    cache.set("c", 3, 0);
    expect(cache.size).toBe(2);
    expect(cache.get("a", 1)).toBeUndefined();
    expect(cache.get("c", 1)).toBe(3);
  });

  it("declines to key a body it cannot digest without consuming it", () => {
    expect(quoteKey("https://a.test/x", "POST", '{"n":1}')).not.toBeNull();
    expect(quoteKey("https://a.test/x", "POST", '{"n":1}')).not.toBe(
      quoteKey("https://a.test/x", "POST", '{"n":2}')
    );
    // A stream can be read once. Reading it to build a key would empty it
    // before the request went out, so this must decline instead.
    const stream = new ReadableStream();
    expect(quoteKey("https://a.test/x", "POST", stream as unknown as BodyInit)).toBeNull();
  });
});

/* ── 2. the concurrency limiter ─────────────────────────────────────────── */

describe("concurrency limiter", () => {
  it("keeps at most maxConcurrent calls in flight", async () => {
    inFlight = 0;
    peakInFlight = 0;
    const client = new RiparClient({ mnemonic, network: "testnet", maxConcurrent: 2 });

    const results = await Promise.all(
      Array.from({ length: 6 }, () => client.call(`${base}/slow`, {}))
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    // Unbounded, all six handlers overlap. This is measured on the server, so
    // it is the real socket count and not the client's opinion of it.
    expect(peakInFlight).toBeGreaterThan(0);
    expect(peakInFlight).toBeLessThanOrEqual(2);
  });

  it("runs unbounded when maxConcurrent is not set", async () => {
    inFlight = 0;
    peakInFlight = 0;
    slowBarrier.reset(4);
    const client = new RiparClient({ mnemonic, network: "testnet" });
    await Promise.all(Array.from({ length: 4 }, () => client.call(`${base}/slow`, {})));
    slowBarrier.reset(1);
    expect(peakInFlight).toBeGreaterThan(1);
  });

  it("does not deadlock when a call quotes itself under a limit of one", async () => {
    // call() holds the permit and then calls quote(), which asks for one too.
    // Without re-entrancy this never returns.
    const client = new RiparClient({ mnemonic, network: "testnet", maxConcurrent: 1, maxPrice: "$1.00" });
    const res = await within(20_000, client.call(`${base}/work`, {}), "call() with maxConcurrent 1");
    expect(res.status).toBe(200);
  });

  it("does not deadlock when a batch limiter wraps the client's own", async () => {
    const client = new RiparClient({ mnemonic, network: "testnet", maxConcurrent: 1, maxPrice: "$1.00" });
    const out = await within(
      // Two full payment cycles over real local HTTP. This is a deadlock
      // detector, not a latency budget — a true deadlock never returns, so a
      // generous deadline still catches it, while a tight one just fails on a
      // busy machine. Kept under the suite's 30s testTimeout so the failure
      // still reads "deadlocked" rather than a bare timeout.
      20_000,
      client.callMany([`${base}/work`, `${base}/once`], { concurrency: 1 }),
      "callMany under two limiters"
    );
    expect(out.map((r) => r.ok)).toEqual([true, true]);
  });

  it("re-enters rather than queueing behind itself", async () => {
    const limiter = new Limiter(1);
    const out = await within(
      1_000,
      limiter.run(async () => limiter.run(async () => "inner")),
      "nested Limiter.run"
    );
    expect(out).toBe("inner");
  });

  it("queues the surplus instead of dropping it", async () => {
    const limiter = new Limiter(2);
    const order: number[] = [];
    const tasks = [0, 1, 2, 3].map((i) =>
      limiter.run(async () => {
        await sleep(20);
        order.push(i);
      })
    );
    await Promise.all(tasks);
    expect(order).toHaveLength(4);
    expect(limiter.inFlight).toBe(0);
    expect(limiter.queued).toBe(0);
  });

  it("refuses a limit that would stall everything", () => {
    expect(() => new RiparClient({ maxConcurrent: 0 })).toThrow(/at least 1/);
    expect(() => new RiparClient({ maxConcurrent: 1.5 })).toThrow(/whole number/);
  });
});

/* ── 3. wallet balance and the pre-flight ───────────────────────────────── */

const FUNDED = {
  amount: 300_000,
  "min-balance": 100_000,
  assets: [{ "asset-id": USDC, amount: 5_000_000, "is-frozen": false }],
};
const NO_OPT_IN = { amount: 300_000, "min-balance": 100_000, assets: [] };
const NEARLY_EMPTY = {
  amount: 300_000,
  "min-balance": 100_000,
  assets: [{ "asset-id": USDC, amount: 5, "is-frozen": false }],
};

describe("wallet balance", () => {
  it("reads ALGO and the asset holding from algod", async () => {
    const net = fetchWithAlgod(FUNDED);
    const client = new RiparClient({ mnemonic, network: "testnet", fetchImpl: net.impl });
    const bal = await client.balance();

    expect(bal.address).toBe(algosdk.mnemonicToSecretKey(mnemonic).addr.toString());
    expect(bal.microAlgos).toBe(300_000);
    expect(bal.algo).toBeCloseTo(0.3, 9);
    expect(bal.minMicroAlgos).toBe(100_000);
    expect(bal.asset.id).toBe(USDC);
    expect(bal.asset.optedIn).toBe(true);
    expect(bal.asset.amount).toBe("5000000");
    // 5000000 atomic units of a six-decimal asset is $5, not $5000000.
    expect(bal.asset.usd).toBeCloseTo(5, 6);
    expect(net.seen[0]).toContain(`/v2/accounts/${bal.address}`);
  });

  it("separates a wallet that never opted in from one that is merely empty", async () => {
    const client = new RiparClient({
      mnemonic,
      network: "testnet",
      fetchImpl: fetchWithAlgod(NO_OPT_IN).impl,
    });
    const bal = await client.balance();
    expect(bal.asset.optedIn).toBe(false);
    expect(bal.funded).toBe(true); // it holds ALGO; it just cannot hold USDC

    const verdict = coversPayment(bal, "20000");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe("asset_not_opted_in");
    // The actionable half: more money will not fix this one.
    expect(verdict.message).toMatch(/opt in/i);
  });

  it("compares atomic units exactly, not as dollars", () => {
    const bal = {
      address: PAYER,
      network: "testnet",
      funded: true,
      microAlgos: 0,
      algo: 0,
      minMicroAlgos: 0,
      asset: { id: USDC, optedIn: true, amount: "20000", usd: 0.02, frozen: false },
    } satisfies WalletBalance;

    expect(coversPayment(bal, "20000").ok).toBe(true);
    expect(coversPayment(bal, "20001").ok).toBe(false);

    // 2^53 and 2^53 + 1 are the same double and different integers. Compared as
    // numbers the second is "covered" by the first, and the wallet is waved
    // through for one unit more than it holds; an ASA amount is a uint64, so
    // the comparison has to be exact.
    const whale = { ...bal, asset: { ...bal.asset, amount: "9007199254740992" } };
    expect(coversPayment(whale, "9007199254740992").ok).toBe(true);
    expect(coversPayment(whale, "9007199254740993").ok).toBe(false);
  });

  it("needs a signer, because there is no address without one", async () => {
    await expect(new RiparClient({ network: "testnet" }).balance()).rejects.toThrow(/no signer/i);
  });
});

describe("balance pre-flight on call()", () => {
  it("refuses before the round trip when the asset was never opted in", async () => {
    const settlesBefore = fac.settles;
    const verifiesBefore = fac.verifies;
    const client = new RiparClient({
      mnemonic,
      network: "testnet",
      preflightBalance: true,
      fetchImpl: fetchWithAlgod(NO_OPT_IN).impl,
    });

    await expect(client.call(`${base}/work`, {})).rejects.toThrow(/opt in/i);
    // Nothing was signed and nothing reached the facilitator: the whole point
    // is to fail before the payment leg rather than after it.
    expect(fac.settles).toBe(settlesBefore);
    expect(fac.verifies).toBe(verifiesBefore);
  });

  it("refuses when the holding cannot cover the quote, and names both numbers", async () => {
    const settlesBefore = fac.settles;
    const client = new RiparClient({
      mnemonic,
      network: "testnet",
      preflightBalance: true,
      fetchImpl: fetchWithAlgod(NEARLY_EMPTY).impl,
    });

    // $0.02 of USDC is 20000 atomic units; the wallet holds 5.
    await expect(client.call(`${base}/work`, {})).rejects.toThrow(/holds 5 .*asks for 20000/s);
    expect(fac.settles).toBe(settlesBefore);
  });

  it("lets a funded wallet through untouched", async () => {
    const client = new RiparClient({
      mnemonic,
      network: "testnet",
      preflightBalance: true,
      fetchImpl: fetchWithAlgod(FUNDED).impl,
    });
    const res = await client.call(`${base}/work`, { hello: 1 });
    expect(res.status).toBe(200);
    expect(res.payment?.txId).toBeTruthy();
  });

  it("is off by default: an unopted wallet still pays", async () => {
    const client = new RiparClient({
      mnemonic,
      network: "testnet",
      fetchImpl: fetchWithAlgod(NO_OPT_IN).impl,
    });
    // Without the pre-flight the facilitator is the one that decides, which is
    // exactly the current behaviour this must not change.
    const res = await client.call(`${base}/work`, {});
    expect(res.status).toBe(200);
  });
});

/* ── 4. the cost estimator ──────────────────────────────────────────────── */

describe("estimate", () => {
  it("prices a batch and totals it, with no signer and no funds", async () => {
    const client = new RiparClient({ network: "testnet" });
    const est = await client.estimate([`${base}/work`, `${base}/once`]);

    expect(est.lines.map((l) => l.usd)).toEqual([0.02, 0.01]);
    expect(est.totalUsd).toBeCloseTo(0.03, 6);
    expect(est.unreadable).toHaveLength(0);
  });

  it("prices each body separately when the endpoint charges by it", async () => {
    const client = new RiparClient({ network: "testnet" });
    const est = await client.estimate([
      { url: `${base}/weigh`, body: { n: 1 } },
      { url: `${base}/weigh`, body: { n: 4 } },
    ]);
    expect(est.lines.map((l) => l.usd)).toEqual([0.01, 0.04]);
    expect(est.totalUsd).toBeCloseTo(0.05, 6);
  });

  it("reports an unreadable quote instead of counting it as free", async () => {
    const impl = (async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith("/weird")) return quoted402("102000", "999999999");
      if (u.endsWith("/free")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return quoted402("10000", String(USDC));
    }) as unknown as typeof fetch;

    const client = new RiparClient({ network: "testnet", fetchImpl: impl });
    const est = await client.estimate(["https://a.test/priced", "https://a.test/weird", "https://a.test/free"]);

    expect(est.lines[0].usd).toBeCloseTo(0.01, 6);
    // An asset whose decimals are unknown cannot be converted, and guessing six
    // would be a millionfold error in the direction that pays.
    expect(est.lines[1].usd).toBeNull();
    expect(est.lines[1].error).toMatch(/could not read/i);
    // A 200 really is free, so zero belongs in the total.
    expect(est.lines[2].usd).toBe(0);
    expect(est.lines[2].paymentRequired).toBe(false);

    expect(est.unreadable.map((l) => l.url)).toEqual(["https://a.test/weird"]);
    expect(est.totalUsd).toBeCloseTo(0.01, 6);
  });

  it("reports an endpoint it could not reach rather than dropping it", async () => {
    const impl = (async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    }) as unknown as typeof fetch;
    const est = await new RiparClient({ network: "testnet", fetchImpl: impl }).estimate([
      "https://nowhere.test/x",
    ]);
    expect(est.lines[0].usd).toBeNull();
    expect(est.lines[0].error).toMatch(/ECONNREFUSED/);
    expect(est.unreadable).toHaveLength(1);
    expect(est.totalUsd).toBe(0);
  });
});

/* ── 5. receipts ────────────────────────────────────────────────────────── */

describe("receipts", () => {
  it("keeps one receipt per settled call", async () => {
    const client = new RiparClient({ mnemonic, network: "testnet" });
    await client.call(`${base}/work`, {});
    await client.call(`${base}/once`, {});

    expect(client.receipts).toHaveLength(2);
    const [first, second] = client.receipts;
    expect(first.url).toBe(`${base}/work`);
    expect(first.txId).toBeTruthy();
    // Atomic units, straight off the settlement: $0.02 of a six-decimal asset.
    expect(first.amount).toBe("20000");
    expect(second.url).toBe(`${base}/once`);
    expect(second.amount).toBe("10000");
    expect(Date.parse(first.timestamp)).toBeGreaterThan(0);
  });

  it("records nothing for a call a window already paid for", async () => {
    const client = new RiparClient({ mnemonic, network: "testnet" });
    await client.subscribe(`${base}/feed`, {});
    expect(client.receipts).toHaveLength(1);

    await client.call(`${base}/feed`, {});
    await client.call(`${base}/feed`, {});
    // Three calls, one settlement. A ledger that counted responses rather than
    // receipts would report three payments that never happened.
    expect(client.receipts).toHaveLength(1);
  });

  it("exports JSON that round-trips", async () => {
    const client = new RiparClient({ mnemonic, network: "testnet" });
    await client.call(`${base}/work`, {});
    const parsed = JSON.parse(client.exportReceipts("json")) as { url: string; amount: string }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].url).toBe(`${base}/work`);
    expect(parsed[0].amount).toBe("20000");
  });

  it("quotes every CSV field, so a comma in a URL cannot shift a column", () => {
    const csv = exportReceipts(
      [
        {
          timestamp: "2026-08-04T00:00:00.000Z",
          url: 'https://a.test/x?ids=1,2&q="hi"',
          txId: "TX1",
          amount: "10000",
          asset: "10458941",
          usd: 0.01,
        },
        { timestamp: "2026-08-04T00:00:01.000Z", url: "https://a.test/y" },
      ],
      "csv"
    );
    const lines = csv.split("\n");
    expect(lines[0]).toBe('"timestamp","url","txId","amount","asset","usd"');
    expect(lines[1]).toBe(
      '"2026-08-04T00:00:00.000Z","https://a.test/x?ids=1,2&q=""hi""","TX1","10000","10458941","0.01"'
    );
    // A receipt with no txId still has to occupy its column.
    expect(lines[2]).toBe('"2026-08-04T00:00:01.000Z","https://a.test/y","","","",""');
  });

  it("hands out a copy, so a caller cannot empty the ledger by accident", async () => {
    const client = new RiparClient({ mnemonic, network: "testnet" });
    await client.call(`${base}/work`, {});
    client.receipts.length = 0;
    expect(client.receipts).toHaveLength(1);
  });
});

/* ── 6. facilitator failover ────────────────────────────────────────────── */

describe("resolveFacilitator", () => {
  it("skips a dead facilitator, says why, and takes the next live one", async () => {
    const dead = "http://127.0.0.1:1"; // nothing listens on port 1
    const choice = await resolveFacilitator([dead, fac.url], { network: "testnet" });

    expect(choice.ok).toBe(true);
    if (!choice.ok) return;
    expect(choice.url).toBe(fac.url);
    expect(choice.network).toBe(NETWORK);
    expect(choice.tried[0]).toMatchObject({ url: dead, ok: false });
    // A failover that reports only its winner cannot tell a typo from an outage.
    expect(choice.tried[0].reason).toMatch(/unreachable/i);
  });

  it("skips one that is up but speaks no Algorand", async () => {
    const app = express();
    app.get("/supported", (_req, res) => {
      res.json({ kinds: [{ scheme: "exact", network: "eip155:8453" }] });
    });
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const evm = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    try {
      const choice = await resolveFacilitator([evm, fac.url], { network: "testnet" });
      expect(choice.ok).toBe(true);
      if (!choice.ok) return;
      expect(choice.url).toBe(fac.url);
      expect(choice.tried[0].reason).toMatch(/no exact scheme on Algorand/i);
      expect(choice.tried[0].reason).toContain("eip155:8453");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("matches the full genesis hash the facilitator publishes, not the truncated constant", async () => {
    // The trap this SDK keeps hitting: CAIP-2 caps a reference at 32 chars, so
    // the package constant is a PREFIX of what every facilitator advertises. An
    // equality test rejects the very facilitator it is looking for.
    const choice = await resolveFacilitator([fac.url], { network: "testnet" });
    expect(choice.ok).toBe(true);
    if (choice.ok) expect(choice.network.length).toBeGreaterThan(ALGORAND_TESTNET_CAIP2.length);
  });

  it("treats the list as a preference order, not a race", async () => {
    // Both are up and both speak Algorand, so the only thing that can decide is
    // the caller's order. Probing in parallel and taking whichever answered
    // first is how a primary quietly stops being used.
    const second = await startFacilitator();
    try {
      const first = await resolveFacilitator([fac.url, second.url], { network: "testnet" });
      expect(first.ok && first.url).toBe(fac.url);
      const flipped = await resolveFacilitator([second.url, fac.url], { network: "testnet" });
      expect(flipped.ok && flipped.url).toBe(second.url);
      // And it stops at the first answer rather than probing the rest.
      expect(flipped.ok && flipped.tried).toHaveLength(1);
    } finally {
      await second.close();
    }
  });

  it("reports every reason when none of them can be used", async () => {
    const choice = await resolveFacilitator(["http://127.0.0.1:1", "http://127.0.0.1:2"]);
    expect(choice.ok).toBe(false);
    if (choice.ok) return;
    expect(choice.tried).toHaveLength(2);
    expect(choice.error).toContain("127.0.0.1:1");
    expect(choice.error).toContain("127.0.0.1:2");
  });

  it("is reachable from the client with the configured list", async () => {
    const client = new RiparClient({
      network: "testnet",
      facilitatorUrls: ["http://127.0.0.1:1", fac.url],
    });
    const choice = await client.facilitator();
    expect(choice.ok && choice.url).toBe(fac.url);
  });
});

/* ── 7. callMany ────────────────────────────────────────────────────────── */

describe("callMany", () => {
  it("settles every item in input order, and one failure does not abort the rest", async () => {
    const client = new RiparClient({ mnemonic, network: "testnet", retry: false });
    const out = await client.callMany([`${base}/work`, `${base}/boom`, `${base}/once`]);

    expect(out.map((r) => r.ok)).toEqual([true, false, true]);
    expect(out.map((r) => r.url)).toEqual([`${base}/work`, `${base}/boom`, `${base}/once`]);
    expect(out[0].ok && out[0].result.status).toBe(200);
    expect(out[1].ok).toBe(false);
    if (!out[1].ok) expect(out[1].error.status).toBe(400);
    expect(out[2].ok && out[2].result.payment?.txId).toBeTruthy();
  });

  it("keeps the daily cap: the calls past it fail rather than pay", async () => {
    const client = new RiparClient({
      mnemonic,
      network: "testnet",
      maxPerDay: "$0.05",
      // Serial, because a cap is checked against what the ledger has RECORDED
      // and calls in flight together have recorded nothing yet.
      maxConcurrent: 1,
    });
    const settlesBefore = fac.settles;
    const out = await client.callMany(Array.from({ length: 4 }, () => `${base}/work`));

    expect(out.filter((r) => r.ok)).toHaveLength(2); // $0.02 + $0.02 = $0.04
    const failures = out.filter((r) => !r.ok);
    expect(failures).toHaveLength(2);
    for (const f of failures) if (!f.ok) expect(f.error.code).toBe("daily_cap_reached");
    expect(fac.settles).toBe(settlesBefore + 2);
    expect(client.spentToday).toBeCloseTo(0.04, 6);
  });

  it("honours its own concurrency argument", async () => {
    inFlight = 0;
    peakInFlight = 0;
    const client = new RiparClient({ mnemonic, network: "testnet" });
    const out = await client.callMany(Array.from({ length: 5 }, () => `${base}/slow`), {
      concurrency: 2,
    });
    expect(out.every((r) => r.ok)).toBe(true);
    expect(peakInFlight).toBeGreaterThan(0);
    expect(peakInFlight).toBeLessThanOrEqual(2);
  });

  it("never rejects, however badly an item fails", async () => {
    const client = new RiparClient({ mnemonic, network: "testnet", retry: false });
    const out = await client.callMany(["http://127.0.0.1:1/nope", `${base}/once`]);
    expect(out[0].ok).toBe(false);
    expect(out[1].ok).toBe(true);
  });
});

/* ── 8. subscribe-or-not advice ─────────────────────────────────────────── */

describe("shouldSubscribe", () => {
  it("recommends the window, shows the arithmetic, and buys nothing", async () => {
    const settlesBefore = fac.settles;
    const client = new RiparClient({ mnemonic, network: "testnet" });
    const advice = await client.shouldSubscribe(`${base}/feed`, 4);

    expect(advice.window).toMatchObject({ usd: 5, period: "30d" });
    expect(advice.perCallUsd).toBeCloseTo(5, 6);
    expect(advice.payPerCallUsd).toBeCloseTo(20, 6);
    expect(advice.cheaper).toBe("subscribe");
    expect(advice.savingsUsd).toBeCloseTo(15, 6);
    expect(advice.arithmetic).toContain("4 calls");
    expect(advice.arithmetic).toContain("$20.000000");
    expect(advice.arithmetic).toContain("$5.000000");
    expect(advice.arithmetic).toMatch(/saving \$15\.000000/);
    // Advice, not action. Buying on the SDK's own judgement would settle a
    // price the caller never saw.
    expect(fac.settles).toBe(settlesBefore);
    expect(client.activeSubscriptions).toHaveLength(0);
  });

  it("calls a single call a wash, because one window is one settlement", async () => {
    const client = new RiparClient({ network: "testnet" });
    const advice = await client.shouldSubscribe(`${base}/feed`, 1);
    expect(advice.cheaper).toBe("same");
    expect(advice.savingsUsd).toBe(0);
    expect(advice.breakEvenCalls).toBe(1);
  });

  it("says plainly when the endpoint sells no window", async () => {
    const client = new RiparClient({ network: "testnet" });
    const advice = await client.shouldSubscribe(`${base}/once`, 50);

    expect(advice.window).toBeNull();
    expect(advice.perCallUsd).toBeCloseTo(0.01, 6);
    expect(advice.payPerCallUsd).toBeCloseTo(0.5, 6);
    expect(advice.cheaper).toBe("per-call");
    expect(advice.reason).toMatch(/sells no window/i);
    expect(advice.arithmetic).toContain("50 calls");
  });

  it("needs no signer — deciding whether to spend comes before the wallet", async () => {
    const client = new RiparClient({ network: "testnet" });
    await expect(client.shouldSubscribe(`${base}/feed`, 10)).resolves.toMatchObject({
      cheaper: "subscribe",
    });
  });

  it("refuses a nonsense call count instead of dividing by it", async () => {
    const client = new RiparClient({ network: "testnet" });
    await expect(client.shouldSubscribe(`${base}/feed`, 0)).rejects.toThrow(/at least 1/);
  });

  it("reports an endpoint it cannot quote rather than recommending blind", async () => {
    const client = new RiparClient({ network: "testnet" });
    const advice = await client.shouldSubscribe("http://127.0.0.1:1/feed", 10);
    expect(advice.cheaper).toBe("unknown");
    expect(advice.reason).toMatch(/could not be quoted/i);
  });
});

/* ── helpers ────────────────────────────────────────────────────────────── */

/** The atomic amount out of a quote, which is where a body-keyed cache proves
 *  itself: same URL, different number. */
function amountOf(q: { paymentRequired: boolean; requirements?: unknown }): string | undefined {
  const accepts = (q.requirements as { accepts?: { amount?: string }[] } | undefined)?.accepts;
  return accepts?.[0]?.amount != null ? String(accepts[0].amount) : undefined;
}

/** A 402 in the shape an x402 server really sends: base64 JSON in the header,
 *  atomic units in `amount`. */
function quoted402(amount: string, asset: string) {
  const payload = {
    x402Version: 2,
    accepts: [{ scheme: "exact", network: NETWORK, amount, asset, payTo: PAY_TO }],
  };
  return new Response("{}", {
    status: 402,
    headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(payload)).toString("base64") },
  });
}
