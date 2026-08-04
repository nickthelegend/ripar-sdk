import { describe, expect, it } from "vitest";
import algosdk from "algosdk";
import { RiparClient } from "../src/client.js";
import { DEFAULT_RETRY, backoffDelay, isRetryable } from "../src/retry.js";
import { SpendLedger } from "../src/spend.js";
import { registerWithBazaar, DEFAULT_BAZAAR_URL } from "../src/bazaar.js";
import { RiparError } from "../src/types.js";

/** A throwaway wallet. It never signs anything real — these tests stop at the
 *  point money would move, which is exactly where the guards live. */
const MNEMONIC = algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk);

/** A 402 shaped exactly like the one an x402 server sends: base64 JSON in the
 *  PAYMENT-REQUIRED header, atomic units in `amount`. */
function quoted(usd: number) {
  const payload = {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "algorand:SGO1GKSzyE7IEPItTxCByw9x8Fmn",
        amount: String(Math.round(usd * 1e6)),
        asset: "10458941",
        payTo: "PBXELTAXFHNNP3ZQFBC36WKUGVX732UG4CQQH22CP6NNIY5FFIY5UINYAU",
      },
    ],
  };
  return new Response("{}", {
    status: 402,
    headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(payload)).toString("base64") },
  });
}

function settled(usd: number, body: unknown = { ok: true }) {
  const receipt = {
    success: true,
    transaction: "TX-" + Math.random().toString(16).slice(2),
    amount: String(Math.round(usd * 1e6)),
    asset: "10458941",
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "X-PAYMENT-RESPONSE": Buffer.from(JSON.stringify(receipt)).toString("base64"),
    },
  });
}

/**
 * A fetch that answers the 402 probe and then the paid call.
 *
 * The client's paid fetch is wrapped by @x402/fetch, which re-sends after
 * signing — so a stub that returns 200 on the second call reproduces the real
 * two-leg handshake without a funded wallet.
 */
function stubFetch(
  steps: (() => Response | Promise<Response>)[],
  { cycle = false }: { cycle?: boolean } = {}
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let i = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const step = cycle ? steps[i % steps.length] : steps[Math.min(i, steps.length - 1)];
    i++;
    return step();
  }) as unknown as typeof fetch;
  return {
    impl,
    calls,
    get count() {
      return i;
    },
  };
}

/* ── 9. retry with backoff and jitter ───────────────────────────────────── */

describe("retry policy", () => {
  it("retries 5xx and transport failures, never 4xx", () => {
    expect(isRetryable(500)).toBe(true);
    expect(isRetryable(502)).toBe(true);
    expect(isRetryable(null)).toBe(true); // no response at all

    // 402 is the payment handshake; 400 will be wrong again; 409 is a key clash;
    // 429 already told us how long to wait. Repeating any of them costs money or
    // goodwill and buys nothing.
    for (const status of [400, 401, 402, 404, 409, 422, 429]) {
      expect(isRetryable(status)).toBe(false);
    }
  });

  it("backs off exponentially and caps the window", () => {
    const full = () => 1; // draw the top of the jitter window
    expect(backoffDelay(1, { baseMs: 100, maxMs: 10_000 }, full)).toBe(100);
    expect(backoffDelay(2, { baseMs: 100, maxMs: 10_000 }, full)).toBe(200);
    expect(backoffDelay(3, { baseMs: 100, maxMs: 10_000 }, full)).toBe(400);
    expect(backoffDelay(9, { baseMs: 100, maxMs: 1_000 }, full)).toBe(1_000);
  });

  it("jitters over the whole window, so a herd does not resynchronise", () => {
    // Full jitter: uniform over [0, window]. Equal-jitter or none would put
    // every client that failed together back on the same tick.
    expect(backoffDelay(3, { baseMs: 100 }, () => 0)).toBe(0);
    expect(backoffDelay(3, { baseMs: 100 }, () => 0.5)).toBe(200);
    expect(backoffDelay(3, { baseMs: 100 }, () => 1)).toBe(400);

    const draws = new Set(Array.from({ length: 50 }, () => backoffDelay(4, { baseMs: 100 })));
    expect(draws.size).toBeGreaterThan(10);
  });

  it("ships sane defaults", () => {
    expect(DEFAULT_RETRY).toEqual({ attempts: 3, baseMs: 250, maxMs: 8_000 });
  });
});

describe("RiparClient retrying", () => {
  it("repeats a 5xx and succeeds on a later attempt", async () => {
    const stub = stubFetch([
      () => new Response("boom", { status: 503 }),
      () => new Response("boom", { status: 503 }),
      () => settled(0.01, { data: "ok" }),
    ]);
    const client = new RiparClient({
      mnemonic: MNEMONIC,
      network: "testnet",
      retry: { attempts: 3, baseMs: 1 },
      fetchImpl: stub.impl,
    });

    const res = await client.call("https://agent.test/echo", { text: "hi" });
    expect(res.data).toEqual({ data: "ok" });
    expect(res.attempts).toBe(3);
  });

  it("gives up after the configured attempts", async () => {
    const stub = stubFetch([() => new Response("boom", { status: 500 })]);
    const client = new RiparClient({
      mnemonic: MNEMONIC,
      network: "testnet",
      retry: { attempts: 2, baseMs: 1 },
      fetchImpl: stub.impl,
    });

    await expect(client.call("https://agent.test/echo")).rejects.toThrow(/failed with 500/);
    expect(stub.count).toBe(2);
  });

  it("does NOT retry a 4xx — repeating it can pay twice for the same mistake", async () => {
    const stub = stubFetch([
      () => new Response(JSON.stringify({ error: { field: "text" } }), { status: 400 }),
    ]);
    const client = new RiparClient({
      mnemonic: MNEMONIC,
      network: "testnet",
      retry: { attempts: 5, baseMs: 1 },
      fetchImpl: stub.impl,
    });

    await expect(client.call("https://agent.test/echo", {})).rejects.toThrow(/failed with 400/);
    expect(stub.count).toBe(1);
  });

  it("retries a transport failure, where nothing settled", async () => {
    let calls = 0;
    const impl = (async () => {
      calls++;
      if (calls < 3) throw new TypeError("fetch failed: ECONNRESET");
      return settled(0.01, { data: "ok" });
    }) as unknown as typeof fetch;

    const client = new RiparClient({
      mnemonic: MNEMONIC,
      network: "testnet",
      retry: { attempts: 4, baseMs: 1 },
      fetchImpl: impl,
    });

    expect((await client.call("https://agent.test/echo")).attempts).toBe(3);
  });

  it("surfaces a transport failure as a RiparError once it is out of attempts", async () => {
    const impl = (async () => {
      throw new TypeError("fetch failed: ENOTFOUND");
    }) as unknown as typeof fetch;
    const client = new RiparClient({
      mnemonic: MNEMONIC,
      network: "testnet",
      retry: { attempts: 2, baseMs: 1 },
      fetchImpl: impl,
    });

    await expect(client.call("https://nowhere.test/echo")).rejects.toThrow(/failed to reach the server/);
  });

  it("does not retry at all when retrying is switched off", async () => {
    const stub = stubFetch([() => new Response("boom", { status: 500 })]);
    const client = new RiparClient({
      mnemonic: MNEMONIC,
      network: "testnet",
      retry: false,
      fetchImpl: stub.impl,
    });

    await expect(client.call("https://agent.test/echo")).rejects.toThrow(/500/);
    expect(stub.count).toBe(1);
  });
});

/* ── 10. spend caps ─────────────────────────────────────────────────────── */

describe("SpendLedger", () => {
  it("accumulates and reports what is left", () => {
    const ledger = new SpendLedger(1);
    ledger.record(0.4);
    ledger.record(0.35);
    expect(ledger.spent()).toBeCloseTo(0.75, 6);
    expect(ledger.remaining()).toBeCloseTo(0.25, 6);
    expect(ledger.wouldFit(0.25)).toBe(true);
    expect(ledger.wouldFit(0.26)).toBe(false);
  });

  it("rolls, so midnight is not a way to spend twice the budget", () => {
    const ledger = new SpendLedger(1);
    const t0 = 1_000_000_000;
    ledger.record(0.9, t0);
    expect(ledger.wouldFit(0.2, t0 + 23 * 3_600_000)).toBe(false);
    // 24h and a minute after the charge, it has aged out of the window.
    expect(ledger.wouldFit(0.2, t0 + 24 * 3_600_000 + 60_000)).toBe(true);
  });

  it("keeps sub-cent sums honest", () => {
    const ledger = new SpendLedger(1);
    for (let i = 0; i < 10; i++) ledger.record(0.1);
    expect(ledger.spent()).toBe(1);
    expect(ledger.wouldFit(0.000001)).toBe(false);
  });

  it("ignores a nonsense charge instead of poisoning the total", () => {
    const ledger = new SpendLedger(1);
    ledger.record(Number.NaN);
    ledger.record(-5);
    expect(ledger.spent()).toBe(0);
  });
});

describe("RiparClient spend caps", () => {
  it("refuses a quote above maxPrice, before signing anything", async () => {
    const stub = stubFetch([() => quoted(0.5)]);
    const client = new RiparClient({
      mnemonic: MNEMONIC,
      network: "testnet",
      maxPrice: "$0.05",
      fetchImpl: stub.impl,
    });

    await expect(client.call("https://agent.test/echo", { text: "hi" })).rejects.toThrow(/Refusing to pay/);
    // One request: the free quote. Nothing was ever signed or sent.
    expect(stub.count).toBe(1);
  });

  it("throws BEFORE it pays once the daily cap is reached", async () => {
    // A capped client makes two requests per call: the free quote, then the
    // paid leg. Alternating keeps that pairing across repeated calls.
    const stub = stubFetch([() => quoted(0.02), () => settled(0.02)], { cycle: true });
    const client = new RiparClient({
      mnemonic: MNEMONIC,
      network: "testnet",
      maxPerDay: "$0.05",
      fetchImpl: stub.impl,
    });

    await client.call("https://agent.test/echo", { text: "a" });
    await client.call("https://agent.test/echo", { text: "b" });
    expect(client.spentToday).toBeCloseTo(0.04, 6);
    expect(client.remainingToday).toBeCloseTo(0.01, 6);

    const before = stub.count;
    await expect(client.call("https://agent.test/echo", { text: "c" })).rejects.toThrow(
      /daily cap|Refusing to pay/
    );
    // Only the free quote went out. The cap fired before the payment leg.
    expect(stub.count).toBe(before + 1);
  });

  it("reads the quote as USD, not as atomic units", async () => {
    // 20000 atomic USDC is $0.02. Read as dollars it is $20000, and a $1 cap
    // would refuse a two-cent call — or, in the other direction, let one
    // through. This is the assertion that pins the conversion.
    const stub = stubFetch([() => quoted(0.02), () => settled(0.02)]);
    const client = new RiparClient({
      mnemonic: MNEMONIC,
      network: "testnet",
      maxPrice: "$1",
      fetchImpl: stub.impl,
    });

    await expect(client.call("https://agent.test/echo", { text: "hi" })).resolves.toMatchObject({
      status: 200,
    });
  });

  it("refuses to pay a quote it cannot read, rather than paying blind", async () => {
    const unreadable = () =>
      new Response("{}", {
        status: 402,
        headers: {
          "PAYMENT-REQUIRED": Buffer.from(
            JSON.stringify({ accepts: [{ amount: "102000", asset: "999999999" }] })
          ).toString("base64"),
        },
      });
    const client = new RiparClient({
      mnemonic: MNEMONIC,
      network: "testnet",
      maxPrice: "$1",
      fetchImpl: stubFetch([unreadable]).impl,
    });

    await expect(client.call("https://agent.test/echo")).rejects.toThrow(/Refusing to pay blind/);
  });

  it("reports the receipt in both atomic units and USD", async () => {
    const client = new RiparClient({
      mnemonic: MNEMONIC,
      network: "testnet",
      fetchImpl: stubFetch([() => settled(0.102)]).impl,
    });

    const res = await client.call("https://agent.test/echo");
    expect(res.payment?.amount).toBe("102000");
    expect(res.payment?.usd).toBeCloseTo(0.102, 6);
    expect(res.payment?.txId).toMatch(/^TX-/);
  });

  it("rejects a nonsense cap at construction, not on the first call", () => {
    expect(() => new RiparClient({ maxPerDay: "lots" })).toThrow(RiparError);
    expect(() => new RiparClient({ maxPerDay: "$0" })).toThrow(/greater than zero/);
    expect(() => new RiparClient({ maxPrice: "-1" })).toThrow(/greater than zero/);
  });

  it("is uncapped by default, and says so", () => {
    const client = new RiparClient();
    expect(client.remainingToday).toBe(Infinity);
    expect(client.spentToday).toBe(0);
  });
});

/* ── 11. bazaar registration ────────────────────────────────────────────── */

describe("registerWithBazaar", () => {
  const manifest = { name: "Test Agent", handle: "test-agent", endpoints: [] };

  it("posts the manifest it fetched", async () => {
    const posted: { url: string; body: unknown }[] = [];
    const impl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "POST") {
        posted.push({ url: u, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      }
      return new Response(JSON.stringify(manifest), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await registerWithBazaar("https://agent.test/.well-known/ripar.json", {
      bazaarUrl: "https://bazaar.test/register",
      fetchImpl: impl,
    });

    expect(result).toEqual({ ok: true, status: 201, bazaarUrl: "https://bazaar.test/register" });
    expect(posted).toHaveLength(1);
    expect(posted[0].body).toEqual({
      manifestUrl: "https://agent.test/.well-known/ripar.json",
      manifest,
    });
  });

  it("NEVER throws when the registry is down — discovery is not worth an outage", async () => {
    const impl = (async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await registerWithBazaar("https://agent.test/.well-known/ripar.json", {
      bazaarUrl: "https://bazaar.test/register",
      fetchImpl: impl,
    });

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: expect.stringContaining("ECONNREFUSED") });
  });

  it("reports a rejecting registry rather than crashing the agent", async () => {
    const impl = (async (_url: string | URL, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response("nope", { status: 503 })
        : new Response(JSON.stringify(manifest), { status: 200 })) as unknown as typeof fetch;

    const result = await registerWithBazaar("https://agent.test/.well-known/ripar.json", {
      bazaarUrl: "https://bazaar.test/register",
      fetchImpl: impl,
    });
    expect(result).toMatchObject({ ok: false, status: 503, error: "bazaar returned 503" });
  });

  it("will not advertise a manifest URL that does not resolve", async () => {
    let posts = 0;
    const impl = (async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === "POST") posts++;
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const result = await registerWithBazaar("https://agent.test/.well-known/ripar.json", {
      bazaarUrl: "https://bazaar.test/register",
      fetchImpl: impl,
    });

    expect(result.ok).toBe(false);
    expect(posts).toBe(0);
  });

  it("gives up on a hanging registry instead of holding boot open", async () => {
    const impl = ((_url: string | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;

    const result = await registerWithBazaar("https://agent.test/.well-known/ripar.json", {
      bazaarUrl: "https://bazaar.test/register",
      timeoutMs: 30,
      fetchImpl: impl,
    });
    expect(result.ok).toBe(false);
  });

  it("defaults to the facilitator's index", () => {
    expect(DEFAULT_BAZAAR_URL).toMatch(/^https:\/\/.+\/bazaar\/register$/);
  });
});
