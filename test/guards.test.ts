import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import express from "express";
import algosdk from "algosdk";
import { defineAgent, defineEndpoint } from "../src/define.js";
import { createServer } from "../src/server.js";
import { idempotencyGuard, rateLimitGuard } from "../src/guards.js";
import { IdempotencyStore } from "../src/idempotency.js";
import { RateLimiter } from "../src/ratelimit.js";
import { payerFromPaymentHeader } from "../src/identity.js";
import { readPaymentRequired } from "../src/headers.js";
import { priceOf } from "../src/client.js";
import { validateInput } from "../src/validate.js";
import { normalizePrice, resolvePrice } from "../src/pricing.js";
import { RiparError } from "../src/types.js";

const PAY_TO = "PBXELTAXFHNNP3ZQFBC36WKUGVX732UG4CQQH22CP6NNIY5FFIY5UINYAU";

async function listen(app: express.Express): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

/* ── 3. input validation, before the caller can be charged ─────────────── */

describe("validateInput", () => {
  const schema = {
    type: "object" as const,
    properties: {
      text: { type: "string", minLength: 1, maxLength: 10 },
      depth: { type: "integer", minimum: 1, maximum: 5 },
      mode: { enum: ["fast", "slow"] },
      tags: { type: "array", items: { type: "string" }, maxItems: 2 },
      opts: { type: "object", properties: { retries: { type: "number" } } },
    },
    required: ["text"],
    additionalProperties: false,
  };

  it("passes a body that satisfies the schema", () => {
    expect(validateInput(schema, { text: "hi", depth: 3, mode: "fast", tags: ["a"] })).toBeNull();
  });

  it("names the missing field, because a caller must be told what to fix", () => {
    expect(validateInput(schema, {})).toEqual({ field: "text", message: "text is required." });
  });

  it.each([
    [{ text: 42 }, "text"],
    [{ text: "" }, "text"],
    [{ text: "0123456789x" }, "text"],
    [{ text: "hi", depth: 2.5 }, "depth"],
    [{ text: "hi", depth: 9 }, "depth"],
    [{ text: "hi", mode: "medium" }, "mode"],
    [{ text: "hi", tags: ["a", "b", "c"] }, "tags"],
    [{ text: "hi", tags: [1] }, "tags[0]"],
    [{ text: "hi", opts: { retries: "many" } }, "opts.retries"],
    [{ text: "hi", extra: true }, "extra"],
  ])("rejects %j at %s", (body, field) => {
    expect(validateInput(schema, body)).toMatchObject({ field });
  });

  it("ignores keywords it does not implement rather than inventing a 400", () => {
    // A schema this validator only half-understands must never reject a body a
    // real JSON Schema engine would accept.
    expect(validateInput({ type: "object", allOf: [{ minProperties: 9 }] } as never, { a: 1 })).toBeNull();
    expect(validateInput({ type: "object", properties: { a: { type: "geo" } } } as never, { a: 1 })).toBeNull();
  });

  it("treats an unparsable pattern as the author's bug, not the caller's", () => {
    const bad = { type: "object" as const, properties: { s: { type: "string", pattern: "[" } } };
    expect(validateInput(bad, { s: "anything" })).toBeNull();
  });

  it("is a no-op when the endpoint declares no schema", () => {
    expect(validateInput(undefined, { whatever: true })).toBeNull();
  });
});

/* ── 4. dynamic pricing ─────────────────────────────────────────────────── */

describe("resolvePrice", () => {
  it("quotes per request from the body", async () => {
    const price = ({ body }: { body: { tokens?: number } }) => `$${(0.001 * (body.tokens ?? 1)).toFixed(4)}`;
    const ctx = (tokens: number) => ({ body: { tokens }, query: {}, header: () => undefined });

    expect(await resolvePrice(price, "complete", ctx(1))).toBe("$0.0010");
    expect(await resolvePrice(price, "complete", ctx(10))).toBe("$0.0100");
  });

  it("awaits an async price function", async () => {
    const price = async () => "0.25";
    expect(await resolvePrice(price, "x", { body: {}, query: {}, header: () => undefined })).toBe("$0.25");
  });

  it("refuses a quote that is not money, instead of giving the endpoint away", async () => {
    for (const bad of ["free", "-1", "$0", "", "NaN"]) {
      await expect(
        resolvePrice(() => bad, "x", { body: {}, query: {}, header: () => undefined })
      ).rejects.toThrow(RiparError);
    }
  });

  it("normalises a bare number to the $ form x402 expects", () => {
    expect(normalizePrice("0.01", "x")).toBe("$0.01");
    expect(normalizePrice("$0.01", "x")).toBe("$0.01");
  });
});

/* ── 5. rate limiting ───────────────────────────────────────────────────── */

describe("RateLimiter", () => {
  it("allows up to the limit, then refuses with a usable Retry-After", () => {
    const limiter = new RateLimiter({ perMinute: 2, per: "payer" });
    const t0 = 1_000_000;

    expect(limiter.take("A", t0).allowed).toBe(true);
    expect(limiter.take("A", t0 + 100).allowed).toBe(true);

    const blocked = limiter.take("A", t0 + 200);
    expect(blocked.allowed).toBe(false);
    if (blocked.allowed) throw new Error("unreachable");
    expect(blocked.retryAfterSeconds).toBe(60);
  });

  it("keys per caller, so one payer cannot exhaust another's budget", () => {
    const limiter = new RateLimiter({ perMinute: 1, per: "payer" });
    expect(limiter.take("A").allowed).toBe(true);
    expect(limiter.take("B").allowed).toBe(true);
    expect(limiter.take("A").allowed).toBe(false);
  });

  it("slides rather than resetting, so a window boundary cannot be used to burst", () => {
    const limiter = new RateLimiter({ perMinute: 2 });
    const t0 = 1_000_000;
    limiter.take("A", t0);
    limiter.take("A", t0 + 59_000);
    expect(limiter.take("A", t0 + 59_500).allowed).toBe(false);
    // The first hit ages out; the second has not.
    expect(limiter.take("A", t0 + 60_100).allowed).toBe(true);
    expect(limiter.take("A", t0 + 60_200).allowed).toBe(false);
  });

  it("counts a floor of one per minute even when handed nonsense", () => {
    expect(new RateLimiter({ perMinute: 0 }).perMinute).toBe(1);
  });
});

describe("rateLimitGuard over HTTP", () => {
  it("429s the caller over the limit and names the wait", async () => {
    const app = express();
    app.use(express.json());
    app.use(rateLimitGuard(new RateLimiter({ perMinute: 2, per: "ip" }), (p) => p === "/paid"));
    app.post("/paid", (_req, res) => void res.json({ ok: true }));
    const { base, close } = await listen(app);

    const first = await fetch(`${base}/paid`, json({}));
    expect(first.status).toBe(200);
    expect(first.headers.get("X-RateLimit-Remaining")).toBe("1");

    expect((await fetch(`${base}/paid`, json({}))).status).toBe(200);

    const third = await fetch(`${base}/paid`, json({}));
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await third.json()).error.code).toBe("rate_limited");

    await close();
  });

  it("leaves unlimited paths alone", async () => {
    const app = express();
    app.use(rateLimitGuard(new RateLimiter({ perMinute: 1, per: "ip" }), (p) => p === "/paid"));
    app.get("/free", (_req, res) => void res.json({ ok: true }));
    const { base, close } = await listen(app);

    for (let i = 0; i < 5; i++) expect((await fetch(`${base}/free`)).status).toBe(200);
    await close();
  });
});

describe("payerFromPaymentHeader", () => {
  it("reads the payer out of a real signed AVM payment payload", () => {
    const account = algosdk.generateAccount();
    const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: account.addr,
      receiver: account.addr,
      amount: 10_000,
      assetIndex: 10_458_941,
      suggestedParams: {
        fee: 1000,
        minFee: 1000,
        flatFee: true,
        firstValid: 1,
        lastValid: 1001,
        genesisID: "testnet-v1.0",
        genesisHash: new Uint8Array(32),
      },
    });
    const signed = Buffer.from(txn.signTxn(account.sk)).toString("base64");
    const header = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        scheme: "exact",
        network: "algorand:SGO1GKSzyE7IEPItTxCByw9x8Fmn",
        payload: { paymentGroup: [signed], paymentIndex: 0 },
      })
    ).toString("base64");

    // The address is read out of the transaction the caller built. Note this
    // asserts parsing, NOT authenticity — nothing here verifies the signature.
    expect(payerFromPaymentHeader(header)).toBe(String(account.addr));
  });

  it("returns null for a caller who has not attached payment", () => {
    expect(payerFromPaymentHeader(undefined)).toBeNull();
    expect(payerFromPaymentHeader("")).toBeNull();
    expect(payerFromPaymentHeader("not-base64-json")).toBeNull();
    expect(payerFromPaymentHeader(Buffer.from("{}").toString("base64"))).toBeNull();
  });

  it("reads a plain payer field, so a second scheme still gets limited", () => {
    const header = Buffer.from(JSON.stringify({ payload: { payer: "ADDR" } })).toString("base64");
    expect(payerFromPaymentHeader(header)).toBe("ADDR");
  });

  // KNOWN GAP, pinned so it is not mistaken for a guarantee: this branch takes
  // an arbitrary string with no signature check, so the value it returns is
  // whatever the caller typed. Sending a real customer's address here consumes
  // that customer's rate-limit budget and locks them out with a 429 — verified
  // end-to-end against createServer. Whoever closes it should delete this test.
  it("KNOWN GAP: the plain-field branch trusts an unsigned, attacker-set payer", () => {
    const victim = "PBXELTAXFHNNP3ZQFBC36WKUGVX732UG4CQQH22CP6NNIY5FFIY5UINYAU";
    const forged = Buffer.from(JSON.stringify({ payload: { payer: victim } })).toString("base64");
    // No signature, no funds, no transaction — and it still resolves to them.
    expect(payerFromPaymentHeader(forged)).toBe(victim);
  });

  // Unsigned AVM payloads do NOT resolve to the named sender — the decoder reads
  // an unsigned txn as a signed one and yields the zero address. That blocks
  // targeted spoofing through this branch, but it also collapses every malformed
  // payload into one shared bucket, so they rate-limit each other.
  it("an unsigned AVM payload collapses to a single shared identity", () => {
    const account = algosdk.generateAccount();
    const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: account.addr,
      receiver: account.addr,
      amount: 10_000,
      assetIndex: 31_566_704,
      suggestedParams: {
        fee: 1000,
        minFee: 1000,
        flatFee: true,
        firstValid: 1,
        lastValid: 1001,
        genesisID: "mainnet-v1.0",
        genesisHash: new Uint8Array(32),
      },
    });
    const header = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        scheme: "exact",
        network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
        payload: { paymentGroup: [Buffer.from(txn.toByte()).toString("base64")], paymentIndex: 0 },
      })
    ).toString("base64");

    const got = payerFromPaymentHeader(header);
    expect(got).not.toBe(String(account.addr));
    expect(got).toBe(algosdk.encodeAddress(new Uint8Array(32)));
  });
});

/* ── 6. idempotency ─────────────────────────────────────────────────────── */

describe("IdempotencyStore", () => {
  const key = IdempotencyStore.key("POST /echo", "PAYER", "k1");
  const hash = IdempotencyStore.hashBody({ text: "hi" });

  it("claims, then replays the stored 2xx", () => {
    const store = new IdempotencyStore();
    expect(store.begin(key, hash)).toEqual({ kind: "miss" });
    expect(store.begin(key, hash)).toEqual({ kind: "in-progress" });

    store.finish(key, { status: 200, body: { echoed: "hi" }, txId: "TX1" });
    expect(store.begin(key, hash)).toEqual({
      kind: "replay",
      response: { status: 200, body: { echoed: "hi" }, txId: "TX1" },
    });
  });

  it("never caches a 402 — the paid retry must not be answered with the quote", () => {
    const store = new IdempotencyStore();
    store.begin(key, hash);
    store.finish(key, { status: 402, body: { accepts: [] } });
    expect(store.begin(key, hash)).toEqual({ kind: "miss" });
  });

  it("never caches a 5xx, because that response refunded the caller", () => {
    const store = new IdempotencyStore();
    store.begin(key, hash);
    store.finish(key, { status: 500, body: { error: {} } });
    expect(store.begin(key, hash)).toEqual({ kind: "miss" });
  });

  it("calls the same key with a different body a conflict, not a replay", () => {
    const store = new IdempotencyStore();
    store.begin(key, hash);
    store.finish(key, { status: 200, body: { echoed: "hi" } });
    expect(store.begin(key, IdempotencyStore.hashBody({ text: "different" }))).toEqual({ kind: "conflict" });
  });

  it("hashes by value, so a reserialised body is still the same request", () => {
    expect(IdempotencyStore.hashBody({ a: 1, b: [2, { c: 3 }] })).toBe(
      IdempotencyStore.hashBody({ b: [2, { c: 3 }], a: 1 })
    );
    expect(IdempotencyStore.hashBody({ a: 1 })).not.toBe(IdempotencyStore.hashBody({ a: 2 }));
  });

  it("scopes the key to the caller, so nobody can fish out another's answer", () => {
    expect(IdempotencyStore.key("POST /echo", "ALICE", "k1")).not.toBe(
      IdempotencyStore.key("POST /echo", "MALLORY", "k1")
    );
  });

  it("forgets a response once the window closes", () => {
    const store = new IdempotencyStore({ windowMs: 1000 });
    const t0 = 5_000_000;
    store.begin(key, hash, t0);
    store.finish(key, { status: 200, body: { ok: true } }, t0);
    expect(store.begin(key, hash, t0 + 500).kind).toBe("replay");
    expect(store.begin(key, hash, t0 + 1500).kind).toBe("miss");
  });

  it("releases a claim that produced nothing, so the retry really runs", () => {
    const store = new IdempotencyStore();
    store.begin(key, hash);
    store.release(key);
    expect(store.begin(key, hash)).toEqual({ kind: "miss" });
  });

  it("evicts oldest first rather than growing without bound", () => {
    const store = new IdempotencyStore({ max: 3 });
    for (let i = 0; i < 10; i++) store.begin(`k${i}`, hash);
    expect(store.size).toBe(3);
  });
});

describe("idempotencyGuard over HTTP", () => {
  it("returns the stored result instead of re-running the handler", async () => {
    let runs = 0;
    const app = express();
    app.use(express.json());
    app.use(idempotencyGuard(new IdempotencyStore(), (p) => p === "/paid"));
    app.post("/paid", (_req, res) => {
      runs++;
      res.json({ runs, nonce: Math.random() });
    });
    const { base, close } = await listen(app);

    const headers = { "Idempotency-Key": "abc-123" };
    const first = await fetch(`${base}/paid`, json({ text: "hi" }, headers));
    const firstBody = await first.json();
    const second = await fetch(`${base}/paid`, json({ text: "hi" }, headers));
    const secondBody = await second.json();

    // This is the whole promise of the feature: one execution, one charge.
    expect(runs).toBe(1);
    expect(second.headers.get("Idempotency-Replayed")).toBe("true");
    expect(secondBody).toEqual(firstBody);
    expect(first.headers.get("Idempotency-Replayed")).toBeNull();

    await close();
  });

  it("409s the same key sent with a different body", async () => {
    const app = express();
    app.use(express.json());
    app.use(idempotencyGuard(new IdempotencyStore(), () => true));
    app.post("/paid", (_req, res) => void res.json({ ok: true }));
    const { base, close } = await listen(app);

    await fetch(`${base}/paid`, json({ text: "hi" }, { "Idempotency-Key": "k" }));
    const conflict = await fetch(`${base}/paid`, json({ text: "other" }, { "Idempotency-Key": "k" }));

    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe("idempotency_key_reuse");
    await close();
  });

  it("does not cache a failure, so the retry gets a real attempt", async () => {
    let runs = 0;
    const app = express();
    app.use(express.json());
    app.use(idempotencyGuard(new IdempotencyStore(), () => true));
    app.post("/paid", (_req, res) => {
      runs++;
      res.status(500).json({ error: { code: "boom" } });
    });
    const { base, close } = await listen(app);

    const headers = { "Idempotency-Key": "k" };
    await fetch(`${base}/paid`, json({}, headers));
    await fetch(`${base}/paid`, json({}, headers));

    expect(runs).toBe(2);
    await close();
  });

  it("ignores requests that carry no key at all", async () => {
    let runs = 0;
    const app = express();
    app.use(express.json());
    app.use(idempotencyGuard(new IdempotencyStore(), () => true));
    app.post("/paid", (_req, res) => {
      runs++;
      res.json({ runs });
    });
    const { base, close } = await listen(app);

    await fetch(`${base}/paid`, json({}));
    await fetch(`${base}/paid`, json({}));
    expect(runs).toBe(2);
    await close();
  });
});

/* ── the guards in place on a real, payment-gated agent ─────────────────── */

describe("a served agent with every guard on", () => {
  let close: () => Promise<void>;
  let base: string;

  const echo = defineEndpoint({
    name: "echo",
    description: "Returns what it was given.",
    price: "$0.01",
    input: {
      type: "object",
      properties: { text: { type: "string", minLength: 1 }, loud: { type: "boolean" } },
      required: ["text"],
      additionalProperties: false,
    },
    handler: ({ body }) => ({ echoed: (body as { text: string }).text }),
  });

  const priced = defineEndpoint<{ tokens?: number }>({
    name: "priced",
    description: "Costs more the more you ask for.",
    price: ({ body }) => `$${(0.002 + 0.001 * (body?.tokens ?? 0)).toFixed(4)}`,
    priceHint: "$0.002 + $0.001/token",
    handler: () => ({ ok: true }),
  });

  beforeAll(async () => {
    const agent = defineAgent({
      name: "Guarded Agent",
      handle: "guarded-agent",
      description: "Fixture with validation, rate limiting and idempotency on.",
      payTo: PAY_TO,
      network: "testnet",
      endpoints: [echo, priced],
    });
    const app = await createServer(agent, {
      network: "testnet",
      payTo: PAY_TO,
      // Generous on purpose: every test in this block shares one IP, and a
      // tight limit here would make them fail in whatever order they ran.
      rateLimit: { perMinute: 200, per: "ip" },
      idempotency: { windowMs: 60_000 },
    });
    ({ base, close } = await listen(app));
  });

  afterAll(async () => close());

  it("400s a malformed body BEFORE the payment gate, so nothing is charged", async () => {
    const res = await fetch(`${base}/echo`, json({ loud: true }));
    // Not 402: the payment middleware was never reached, so no quote was issued
    // and no settlement could have happened.
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_input");
    expect(body.error.field).toBe("text");
    expect(body.error.schema.required).toEqual(["text"]);
  });

  it("400s a field of the wrong type, naming it", async () => {
    const res = await fetch(`${base}/echo`, json({ text: 7 }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.field).toBe("text");
  });

  it("still gates a well-formed call on payment", async () => {
    const res = await fetch(`${base}/echo`, json({ text: "hello" }));
    expect(res.status).toBe(402);
  });

  it("lets a bodiless probe read the price, because discovery precedes payment", async () => {
    const res = await fetch(`${base}/echo`, { method: "POST" });
    expect(res.status).toBe(402);
  });

  it("quotes a dynamic price from the body, per request", async () => {
    const cheap = await fetch(`${base}/priced`, json({ tokens: 1 }));
    const dear = await fetch(`${base}/priced`, json({ tokens: 100 }));
    expect(cheap.status).toBe(402);
    expect(dear.status).toBe(402);

    // The whole point: one route, two different quotes, decided by the body.
    // $0.002 + $0.001 × tokens.
    expect(priceOf(readPaymentRequired(cheap.headers))).toBeCloseTo(0.003, 6);
    expect(priceOf(readPaymentRequired(dear.headers))).toBeCloseTo(0.102, 6);
  });

  it("quotes the fixed price unchanged whatever the body says", async () => {
    const a = await fetch(`${base}/echo`, json({ text: "short" }));
    const b = await fetch(`${base}/echo`, json({ text: "a much longer body" }));
    expect(priceOf(readPaymentRequired(a.headers))).toBe(0.01);
    expect(priceOf(readPaymentRequired(b.headers))).toBe(0.01);
  });

  it("publishes the hint for a dynamic price rather than inventing a number", async () => {
    const m = await (await fetch(`${base}/.well-known/ripar.json`)).json();
    const listed = m.endpoints.find((e: { name: string }) => e.name === "priced");
    expect(listed.price).toBe("$0.002 + $0.001/token");
    expect(listed.pricing).toBe("dynamic");
    expect(m.endpoints.find((e: { name: string }) => e.name === "echo").pricing).toBe("fixed");
  });

  it("429s a caller over the limit before the payment gate, not after", async () => {
    const app = await createServer(
      defineAgent({
        name: "Limited Agent",
        handle: "limited-agent",
        description: "Fixture with a limit tight enough to trip.",
        payTo: PAY_TO,
        network: "testnet",
        endpoints: [echo],
      }),
      { network: "testnet", payTo: PAY_TO, rateLimit: { perMinute: 2, per: "ip" } }
    );
    const server = await listen(app);

    const call = () => fetch(`${server.base}/echo`, json({ text: "hello" }));
    expect((await call()).status).toBe(402);
    expect((await call()).status).toBe(402);

    const limited = await call();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await limited.json()).error.code).toBe("rate_limited");

    await server.close();
  });

  it("does not cache a 402 against an Idempotency-Key", async () => {
    const app = await createServer(
      defineAgent({
        name: "Idempotent Agent",
        handle: "idempotent-agent",
        description: "Fixture for the 402-is-never-cached rule.",
        payTo: PAY_TO,
        network: "testnet",
        endpoints: [echo],
      }),
      { network: "testnet", payTo: PAY_TO, idempotency: { windowMs: 60_000 } }
    );
    const server = await listen(app);
    const headers = { "Idempotency-Key": "quote-me" };

    // A cached 402 would answer the caller's *paid* retry with the quote it was
    // replying to, and the call could never complete.
    const first = await fetch(`${server.base}/echo`, json({ text: "hello" }, headers));
    const second = await fetch(`${server.base}/echo`, json({ text: "hello" }, headers));
    expect(first.status).toBe(402);
    expect(second.status).toBe(402);
    expect(second.headers.get("Idempotency-Replayed")).toBeNull();

    await server.close();
  });

  // The 402-is-never-cached test above passes whether or not the guard is
  // mounted, so on its own it proves nothing about `createServer`'s wiring.
  // These two do: they need a live claim, which only exists if the guard ran.
  // A slow dynamic price keeps the first request inside the payment middleware
  // — claim held, no response written — while the second one arrives.
  it("mounts the idempotency guard: a second call on a live claim is rejected", async () => {
    const slow = defineEndpoint<{ text?: string }>({
      name: "slow",
      description: "Prices slowly on purpose, to hold a claim open.",
      price: async () => {
        await new Promise((r) => setTimeout(r, 500));
        return "$0.01";
      },
      priceHint: "$0.01",
      handler: () => ({ ok: true }),
    });

    const app = await createServer(
      defineAgent({
        name: "Claimed Agent",
        handle: "claimed-agent",
        description: "Fixture proving the guard is wired into createServer.",
        payTo: PAY_TO,
        network: "testnet",
        endpoints: [slow],
      }),
      { network: "testnet", payTo: PAY_TO, idempotency: { windowMs: 60_000 } }
    );
    const server = await listen(app);

    // Same key, different body → conflict. Without the guard both are 402.
    const inFlight = fetch(`${server.base}/slow`, json({ text: "a" }, { "Idempotency-Key": "held" }));
    await new Promise((r) => setTimeout(r, 150));
    const clashing = await fetch(`${server.base}/slow`, json({ text: "b" }, { "Idempotency-Key": "held" }));

    expect(clashing.status).toBe(409);
    expect((await clashing.json()).error.code).toBe("idempotency_key_reuse");

    // Same key, same body, still running → in-progress, also a 409.
    const queued = await fetch(`${server.base}/slow`, json({ text: "a" }, { "Idempotency-Key": "held" }));
    expect(queued.status).toBe(409);
    expect((await queued.json()).error.code).toBe("idempotency_in_progress");

    expect((await inFlight).status).toBe(402);
    await server.close();
  });

  // The guarantee is narrower than "a dropped connection cannot be charged
  // twice": the store only replays a *completed* 2xx. A request that settled and
  // then lost its socket before writing anything releases the claim, and the
  // retry settles again. Pinned here so the limit is not rediscovered in prod.
  it("releases the claim when a request dies before writing a response", async () => {
    const store = new IdempotencyStore();
    const k = IdempotencyStore.key("POST /echo", "PAYER", "dropped");
    const h = IdempotencyStore.hashBody({ text: "hi" });

    expect(store.begin(k, h)).toEqual({ kind: "miss" });
    store.release(k); // what guards.ts does on `close` with nothing captured

    // A miss means the retry goes through the payment middleware — and pays.
    expect(store.begin(k, h)).toEqual({ kind: "miss" });
  });
});
