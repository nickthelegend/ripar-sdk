import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { defineAgent, defineEndpoint } from "../src/define.js";
import { createServer } from "../src/server.js";
import { RiparClient, priceOf } from "../src/client.js";
import { CAIP2, RiparError, USDC_ASSET_ID } from "../src/types.js";

// A real, checksum-valid Algorand address. The first fixture I wrote was
// invalid and defineAgent rejected it, which is the validator working.
const PAY_TO = "PBXELTAXFHNNP3ZQFBC36WKUGVX732UG4CQQH22CP6NNIY5FFIY5UINYAU";

const echo = defineEndpoint({
  name: "echo",
  description: "Returns what it was given.",
  price: "$0.01",
  input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  handler: ({ body }) => ({ echoed: (body as { text: string }).text }),
});

const agent = defineAgent({
  name: "Test Agent",
  handle: "test-agent",
  description: "Fixture for the SDK test suite.",
  payTo: PAY_TO,
  network: "testnet",
  endpoints: [echo],
});

/* ── unit: validation refuses the mistakes that cost money ─────────────── */

describe("defineEndpoint", () => {
  it("accepts a well-formed endpoint and fills defaults", () => {
    const e = defineEndpoint({ name: "sum", price: "$0.05", handler: () => 1 });
    expect(e.method).toBe("POST");
    expect(e.listed).toBe(true);
    expect(e.timeout).toBe(30_000);
  });

  it.each([
    ["Uppercase", "Sum"],
    ["spaces", "my endpoint"],
    ["trailing slash", "sum/"],
    ["empty", ""],
  ])("rejects an invalid name (%s)", (_why, name) => {
    expect(() => defineEndpoint({ name, price: "$0.01", handler: () => 1 })).toThrow(RiparError);
  });

  it.each(["free", "$0", "-1", "0", "abc"])("rejects price %s", (price) => {
    expect(() => defineEndpoint({ name: "x", price, handler: () => 1 })).toThrow(/price/i);
  });

  it("rejects a timeout outside the platform limits", () => {
    expect(() => defineEndpoint({ name: "x", price: "$0.01", timeout: 500, handler: () => 1 })).toThrow(
      /timeout/i
    );
    expect(() =>
      defineEndpoint({ name: "x", price: "$0.01", timeout: 400_000, handler: () => 1 })
    ).toThrow(/timeout/i);
  });
});

describe("defineAgent", () => {
  it("rejects a payTo that is not an Algorand address", () => {
    // This is the check that matters most: a malformed address means settlement
    // goes nowhere and the money is simply gone.
    expect(() =>
      defineAgent({ ...agent, payTo: "0xdeadbeef", endpoints: [echo] })
    ).toThrow(/Algorand address/);
  });

  it("rejects duplicate endpoint names, which would collide as URLs", () => {
    expect(() => defineAgent({ ...agent, endpoints: [echo, echo] })).toThrow(/twice/);
  });

  it("rejects an agent with no endpoints", () => {
    expect(() => defineAgent({ ...agent, endpoints: [] })).toThrow(/no endpoints/);
  });
});

describe("constants", () => {
  it("uses CAIP-2 ids from the mechanism package, not hand-copied hashes", () => {
    // CAIP-2 caps the reference at 32 chars, so these are TRUNCATED genesis
    // hashes and must not equal the full hash a facilitator prints.
    expect(CAIP2.mainnet.startsWith("algorand:")).toBe(true);
    expect(CAIP2.mainnet.split(":")[1].length).toBeLessThanOrEqual(32);
    expect(CAIP2.mainnet).not.toBe(CAIP2.testnet);
  });

  it("carries the right USDC asset per network", () => {
    expect(USDC_ASSET_ID.mainnet).toBe(31_566_704);
    expect(USDC_ASSET_ID.testnet).toBe(10_458_941);
  });
});

describe("priceOf", () => {
  it("reads a price out of the shapes requirements actually arrive in", () => {
    expect(priceOf({ accepts: [{ price: "$0.02" }] })).toBe(0.02);
    expect(priceOf({ accepts: { maxAmountRequired: "0.5" } })).toBe(0.5);
    expect(priceOf({ price: "$1.25" })).toBe(1.25);
    expect(priceOf(null)).toBeNull();
    expect(priceOf({ accepts: [{}] })).toBeNull();
  });
});

/* ── integration: a live server that really gates on payment ───────────── */

describe("a served agent", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = await createServer(agent, { network: "testnet", payTo: PAY_TO });
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("serves health without payment", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()).agent).toBe("test-agent");
  });

  it("publishes a manifest a stranger can build a call from", async () => {
    const res = await fetch(`${base}/.well-known/ripar.json`);
    expect(res.status).toBe(200);
    const m = await res.json();
    expect(m.handle).toBe("test-agent");
    expect(m.endpoints).toHaveLength(1);
    // The schema is what lets an agent construct a valid request unaided.
    expect(m.endpoints[0].input.required).toEqual(["text"]);
    expect(m.endpoints[0].price).toBe("$0.01");
    expect(m.x402.asset.id).toBe(USDC_ASSET_ID.testnet);
  });

  it("REFUSES an unpaid call with 402 — the whole point of the SDK", async () => {
    const res = await fetch(`${base}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(402);
  });

  it("does not run the handler when payment is missing", async () => {
    let ran = false;
    const spy = defineEndpoint({
      name: "spy",
      price: "$0.01",
      handler: () => {
        ran = true;
        return { ok: true };
      },
    });
    const spyAgent = defineAgent({ ...agent, endpoints: [spy] });
    const app = await createServer(spyAgent, { network: "testnet", payTo: PAY_TO });
    const s = await new Promise<Server>((resolve) => {
      const sv = app.listen(0, () => resolve(sv));
    });
    const addr = s.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const res = await fetch(`http://127.0.0.1:${port}/spy`, { method: "POST" });
    expect(res.status).toBe(402);
    expect(ran).toBe(false); // billing cannot be bypassed by reaching the handler

    await new Promise<void>((resolve) => s.close(() => resolve()));
  });

  it("404s an endpoint the agent does not declare", async () => {
    const res = await fetch(`${base}/nope`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

/* ── client behaviour that protects the wallet ─────────────────────────── */

describe("RiparClient", () => {
  it("reads a quote without a wallet and without funds", async () => {
    const app = await createServer(agent, { network: "testnet", payTo: PAY_TO });
    const s = await new Promise<Server>((resolve) => {
      const sv = app.listen(0, () => resolve(sv));
    });
    const addr = s.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const client = new RiparClient(); // deliberately no signer
    const q = await client.quote(`http://127.0.0.1:${port}/echo`);
    expect(q.paymentRequired).toBe(true);
    expect(q.status).toBe(402);

    await new Promise<void>((resolve) => s.close(() => resolve()));
  });

  it("refuses to pay without a signer instead of failing obscurely", async () => {
    const client = new RiparClient();
    await expect(client.call("http://127.0.0.1:1/echo")).rejects.toThrow(/no signer/i);
  });

  it("rejects a nonsense maxPrice at construction", () => {
    expect(() => new RiparClient({ maxPrice: "cheap" })).toThrow(/not a number/);
  });
});
