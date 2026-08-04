import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { Express } from "express";
import { defineAgent, defineEndpoint } from "../src/define.js";
import { createServer } from "../src/server.js";
import { readPaymentHeader, readReceiptHeader } from "../src/headers.js";
import { payerFromPaymentHeader } from "../src/identity.js";

/**
 * The header names, which is where several silent failures lived.
 *
 * x402 v2 sends PAYMENT-SIGNATURE and answers with PAYMENT-RESPONSE. The SDK
 * looked for X-PAYMENT and X-PAYMENT-RESPONSE — the v1 spellings. Those are
 * different header names, not different casings, so Node's case-insensitive
 * lookup does not bridge them and every read came back empty.
 *
 * Nothing threw. The rate limiter counted nobody, validation was skipped on
 * paid requests, the settled-USD metric stayed at zero, no run recorded a
 * txId, and no subscription key was ever issued. A test on the constants is
 * cheap insurance against a regression that is invisible at runtime.
 */

const PAY_TO = "PBXELTAXFHNNP3ZQFBC36WKUGVX732UG4CQQH22CP6NNIY5FFIY5UINYAU";

describe("readPaymentHeader", () => {
  it("reads the v2 name, which is the one that actually arrives", () => {
    const h: Record<string, string> = { "payment-signature": "abc" };
    expect(readPaymentHeader((n) => h[n.toLowerCase()])).toBe("abc");
  });

  it("still reads the v1 name, because @x402/next falls back to it", () => {
    const h: Record<string, string> = { "x-payment": "def" };
    expect(readPaymentHeader((n) => h[n.toLowerCase()])).toBe("def");
  });

  it("prefers v2 when both are present", () => {
    const h: Record<string, string> = { "payment-signature": "v2", "x-payment": "v1" };
    expect(readPaymentHeader((n) => h[n.toLowerCase()])).toBe("v2");
  });

  it("is undefined when neither is sent", () => {
    expect(readPaymentHeader(() => undefined)).toBeUndefined();
  });
});

describe("readReceiptHeader", () => {
  const receipt = Buffer.from(
    JSON.stringify({
      transaction: "XS5KJ7OV2IS47322EZ3AFX5ZPG3RQTIYUFSSQ2KPMNMFZVI6K4NA",
      payer: PAY_TO,
      amount: "10000",
      asset: "10458941",
      success: true,
    })
  ).toString("base64");

  it("reads PAYMENT-RESPONSE, the name @x402/core emits", () => {
    // createSettlementHeaders returns { "PAYMENT-RESPONSE": … }. This is THE
    // regression: reading only the X- form meant no settlement was ever seen.
    const got = readReceiptHeader((n) => (n === "PAYMENT-RESPONSE" ? receipt : null));
    expect(got?.txId).toBe("XS5KJ7OV2IS47322EZ3AFX5ZPG3RQTIYUFSSQ2KPMNMFZVI6K4NA");
    expect(got?.usd).toBe(0.01);
  });

  it("still reads the X- form some facilitators send", () => {
    expect(readReceiptHeader((n) => (n === "X-PAYMENT-RESPONSE" ? receipt : null))?.payer).toBe(PAY_TO);
  });

  it("returns undefined rather than a half-built receipt when absent", () => {
    expect(readReceiptHeader(() => null)).toBeUndefined();
  });
});

describe("payerFromPaymentHeader", () => {
  it("is null for a request with no payment, so an unpaid probe has no identity", () => {
    expect(payerFromPaymentHeader(undefined)).toBeNull();
    expect(payerFromPaymentHeader(null)).toBeNull();
    expect(payerFromPaymentHeader("")).toBeNull();
  });

  it("is null for junk rather than throwing into the middleware", () => {
    expect(payerFromPaymentHeader("not-base64-at-all!!")).toBeNull();
  });
});

/**
 * The guards, over real HTTP. The unit tests above prove the constants; these
 * prove the constants are actually wired into the request path.
 */
describe("guards see a paid request", () => {
  let base: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const echo = defineEndpoint({
      name: "echo",
      price: "$0.01",
      input: {
        type: "object",
        properties: { text: { type: "string", minLength: 1 } },
        required: ["text"],
      },
      handler: ({ body }) => ({ echoed: (body as { text: string }).text }),
    });

    const agent = defineAgent({
      name: "Header Agent",
      handle: "header-agent",
      payTo: PAY_TO,
      network: "testnet",
      endpoints: [echo],
    });

    const app: Express = await createServer(agent, { network: "testnet", payTo: PAY_TO });
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const port = (server.address() as { port: number }).port;
    base = `http://127.0.0.1:${port}`;
    close = () => new Promise<void>((r) => server.close(() => r()));
  });

  afterAll(async () => close());

  it("validates a paid request whose body express could not parse", async () => {
    // THE case the header bug opened, and the only one that exposes it.
    //
    // express.json() leaves req.body undefined for any content-type it does not
    // handle. The guard treats "no body AND no payment" as a price probe and
    // waves it through — correctly, because discovery must work unpaid. But
    // looking for the v1 header name meant it never saw a payment, so a PAID
    // request with an unparsed body was also waved through: straight to the
    // gate, charged, and into the handler with input nothing had validated.
    //
    // A request with a JSON content-type cannot show this: express parses it,
    // req.body is defined, and the guard validates regardless of the header.
    const res = await fetch(`${base}/echo`, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify({ x402Version: 2 })).toString("base64"),
      },
      body: "text=hello",
    });

    // 400, not 402: rejected before the payment gate, so nothing was charged.
    expect(res.status, "an unparseable body reached the payment gate").toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_input");
    expect(body.error.field).toBe("text");
  });

  it("validates a parsed body too", async () => {
    const res = await fetch(`${base}/echo`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify({ x402Version: 2 })).toString("base64"),
      },
      body: JSON.stringify({ wrong: "field" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.field).toBe("text");
  });

  it("guards every spelling of the path the router accepts", async () => {
    // Express is case-insensitive, ignores a trailing slash and collapses
    // duplicate slashes. The guards looked the path up in an exact-match Map,
    // so /echo/, /ECHO and //echo missed, skipped validation, and went on to
    // the payment gate — which does its own regex matching and charged them.
    // The caller paid for a request no guard had checked.
    for (const path of ["/echo", "/echo/", "/ECHO", "//echo", "/./echo"]) {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wrong: "field" }),
      });
      // 400 everywhere. A 402 would mean this spelling reached the gate with
      // an invalid body and would have been charged for it.
      expect(res.status, `${path} was not validated`).toBe(400);
      expect((await res.json()).error.field).toBe("text");
    }
  });

  it("still lets an unpaid, bodyless probe through to the 402", async () => {
    // Price discovery has to work before a caller can build a valid body: the
    // schema they need travels in the 402 they are asking for.
    const res = await fetch(`${base}/echo`, { method: "POST" });
    expect(res.status).toBe(402);
  });
});
