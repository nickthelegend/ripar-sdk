import { describe, expect, it } from "vitest";
import {
  MemorySubscriptionStore,
  checkSubscription,
  hashKey,
  issue,
  mintKey,
  parsePeriod,
  readKey,
  subscriptionHeaders,
} from "../src/subscriptions.js";
import { defineEndpoint, manifest, defineAgent } from "../src/define.js";

const ADDR = "PBXELTAXFHNNP3ZQFBC36WKUGVX732UG4CQQH22CP6NNIY5FFIY5UINYAU";

describe("parsePeriod", () => {
  it("reads the suffixed forms", () => {
    expect(parsePeriod("30d", "x")).toBe(2_592_000_000);
    expect(parsePeriod("24h", "x")).toBe(86_400_000);
    expect(parsePeriod("90m", "x")).toBe(5_400_000);
    expect(parsePeriod("1w", "x")).toBe(604_800_000);
    expect(parsePeriod(5_000, "x")).toBe(5_000);
  });

  it("refuses anything it would have to guess at", () => {
    // Each of these is a plausible thing to type, and each would otherwise
    // become a key that never expires or one already dead on arrival.
    for (const bad of ["30 days", "forever", "", "0d", "-5h", "d", "30", NaN, 0, -1]) {
      expect(() => parsePeriod(bad as never, "summarize"), String(bad)).toThrow(/summarize/);
    }
  });
});

describe("keys", () => {
  it("mints unguessable, distinct keys", () => {
    const keys = new Set(Array.from({ length: 500 }, mintKey));
    expect(keys.size).toBe(500);
    for (const k of keys) expect(k).toMatch(/^rsk_[\w-]{43}$/);
  });

  it("stores only the hash, never the key", async () => {
    const store = new MemorySubscriptionStore();
    const { key, record } = await issue(store, { endpoint: "e", periodMs: 1000, usd: 5 });
    expect(record.keyHash).toBe(hashKey(key));
    // The whole store, serialised, must not contain the credential.
    expect(JSON.stringify(record)).not.toContain(key);
  });

  it("reads a key from either header", () => {
    expect(readKey({ authorization: "Bearer rsk_abc" })).toBe("rsk_abc");
    expect(readKey({ authorization: "bearer rsk_abc" })).toBe("rsk_abc");
    expect(readKey({ "x-ripar-subscription": "rsk_xyz" })).toBe("rsk_xyz");
    // The dedicated header wins, so Authorization stays free for anything else.
    expect(readKey({ authorization: "Bearer rsk_a", "x-ripar-subscription": "rsk_b" })).toBe("rsk_b");
    expect(readKey({})).toBeUndefined();
    expect(readKey({ authorization: "Basic abc" })).toBeUndefined();
  });
});

describe("checkSubscription", () => {
  it("admits a live key and refuses everything else", async () => {
    const store = new MemorySubscriptionStore();
    const { key } = await issue(store, { endpoint: "summarize", periodMs: 60_000, usd: 5 });

    const ok = await checkSubscription(store, key, "summarize");
    expect(ok.active).toBe(true);
    if (ok.active) expect(ok.remainingMs).toBeGreaterThan(0);

    expect((await checkSubscription(store, undefined, "summarize")).active).toBe(false);
    expect((await checkSubscription(store, "rsk_made_up", "summarize")).active).toBe(false);
  });

  it("expires exactly at the boundary, not a tick later", async () => {
    const store = new MemorySubscriptionStore();
    const t0 = 1_000_000;
    const { key } = await issue(store, { endpoint: "e", periodMs: 1000, usd: 1, now: t0 });

    expect((await checkSubscription(store, key, "e", t0 + 999)).active).toBe(true);
    const at = await checkSubscription(store, key, "e", t0 + 1000);
    expect(at.active).toBe(false);
    if (!at.active) expect(at.reason).toBe("expired");
  });

  it("will not let a cheap window open a dear endpoint", async () => {
    // The pricing hole this closes: subscribe to the $1 endpoint, then use the
    // key on the $100 one.
    const store = new MemorySubscriptionStore();
    const { key } = await issue(store, { endpoint: "cheap", periodMs: 60_000, usd: 1 });
    const cross = await checkSubscription(store, key, "expensive");
    expect(cross.active).toBe(false);
    if (!cross.active) expect(cross.reason).toBe("wrong_endpoint");
  });

  it("distinguishes expired from unknown, so a caller can act on it", async () => {
    const store = new MemorySubscriptionStore();
    const { key } = await issue(store, { endpoint: "e", periodMs: 1, usd: 1, now: 1000 });
    const expired = await checkSubscription(store, key, "e", 99_999);
    expect(expired.active).toBe(false);
    if (!expired.active) expect(expired.reason).toBe("expired");

    const unknown = await checkSubscription(store, mintKey(), "e");
    if (!unknown.active) expect(unknown.reason).toBe("unknown");
  });

  it("keeps the settlement that bought the window", async () => {
    const store = new MemorySubscriptionStore();
    const { key } = await issue(store, {
      endpoint: "e",
      periodMs: 60_000,
      usd: 5,
      payer: ADDR,
      txId: "XS5KJ7OV2IS47322EZ3AFX5ZPG3RQTIYUFSSQ2KPMNMFZVI6K4NA",
    });
    const c = await checkSubscription(store, key, "e");
    expect(c.active).toBe(true);
    // Every window traces back to a transaction on chain — the same rule the
    // ReputationRegistry enforces.
    if (c.active) {
      expect(c.record.txId).toMatch(/^[A-Z2-7]{52}$/);
      expect(c.record.payer).toBe(ADDR);
    }
  });
});

describe("MemorySubscriptionStore", () => {
  it("sweeps expired records", async () => {
    const store = new MemorySubscriptionStore();
    await issue(store, { endpoint: "e", periodMs: 1, usd: 1, now: 1000 });
    await issue(store, { endpoint: "e", periodMs: 10_000_000, usd: 1 });
    store.sweep(Date.now());
    expect(store.size).toBe(1);
  });
});

describe("headers", () => {
  it("emits the key exactly once, on issue", async () => {
    const store = new MemorySubscriptionStore();
    const { key, record } = await issue(store, { endpoint: "e", periodMs: 60_000, usd: 5 });
    expect(subscriptionHeaders(record, key)["x-ripar-subscription"]).toBe(key);
    // On a later, already-covered call there is nothing new to hand out.
    expect(subscriptionHeaders(record)["x-ripar-subscription"]).toBeUndefined();
    expect(subscriptionHeaders(record)["x-ripar-subscription-expires"]).toBe(
      new Date(record.expiresAt).toISOString()
    );
  });
});

describe("declaring a subscription endpoint", () => {
  it("validates the period at definition time", () => {
    expect(() =>
      defineEndpoint({
        name: "feed",
        subscription: { price: "$5.00", period: "30 days" },
        handler: () => ({}),
      })
    ).toThrow(/feed/);
  });

  it("validates the window price like any other price", () => {
    expect(() =>
      defineEndpoint({ name: "feed", subscription: { price: "free", period: "30d" }, handler: () => ({}) })
    ).toThrow(/must look like/);
    expect(() =>
      defineEndpoint({ name: "feed", subscription: { price: "$0", period: "30d" }, handler: () => ({}) })
    ).toThrow(/greater than zero/);
  });

  it("publishes the window and its period to discovery", () => {
    const agent = defineAgent({
      name: "A",
      handle: "test-agent",
      payTo: ADDR,
      endpoints: [
        defineEndpoint({ name: "feed", subscription: { price: "$5.00", period: "30d" }, handler: () => ({}) }),
        defineEndpoint({ name: "once", price: "$0.01", handler: () => ({}) }),
      ],
    });
    const m = manifest(agent, "https://a.example");
    const feed = m.endpoints.find((e) => e.name === "feed") as Record<string, unknown>;
    const once = m.endpoints.find((e) => e.name === "once") as Record<string, unknown>;

    // Without `period`, a browsing agent reads $5.00 as an absurd single call.
    expect(feed.pricing).toBe("subscription");
    expect(feed.price).toBe("$5.00");
    expect(feed.period).toBe("30d");
    expect(once.pricing).toBe("fixed");
    expect(once.period).toBeUndefined();
  });
});
