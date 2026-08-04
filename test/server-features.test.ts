import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { corsGuard } from "../src/cors.js";
import { openApiDocument } from "../src/openapi.js";
import { CircuitBreaker, CircuitOpenError } from "../src/breaker.js";
import { Logger, redact, requestLine } from "../src/logging.js";
import { FreeTier, accessGuard } from "../src/access.js";
import { WebhookSender, signPayload, verifySignature } from "../src/webhooks.js";
import { defineAgent, defineEndpoint } from "../src/define.js";

const PAY_TO = "PBXELTAXFHNNP3ZQFBC36WKUGVX732UG4CQQH22CP6NNIY5FFIY5UINYAU";

/** A stand-in for express's req/res, enough for a middleware under test. */
function fake(reqInit: Partial<Request> = {}) {
  const headers: Record<string, string> = {};
  let status = 200;
  let body: unknown;
  let ended = false;
  const res = {
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    getHeader: (k: string) => headers[k],
    status: (s: number) => {
      status = s;
      return res;
    },
    json: (b: unknown) => {
      body = b;
      ended = true;
      return res;
    },
    end: () => {
      ended = true;
      return res;
    },
  } as unknown as Response;
  const req = { method: "POST", path: "/work", headers: {}, header: (n: string) => (reqInit.headers as never)?.[n.toLowerCase()], ...reqInit } as unknown as Request;
  return {
    req,
    res,
    headers,
    get status() {
      return status;
    },
    get body() {
      return body;
    },
    get ended() {
      return ended;
    },
  };
}

/* ── CORS ───────────────────────────────────────────────────────────────── */

describe("corsGuard", () => {
  it("exposes the x402 headers, which is the whole reason this exists", () => {
    // A browser can read only a handful of response headers by default, and
    // PAYMENT-REQUIRED is not one. Without exposing it, fetch sees a 402 with
    // no quote — the request "works" and the price is silently gone.
    const f = fake({ headers: { origin: "https://app.example" } as never });
    const next = vi.fn();
    corsGuard()(f.req, f.res, next);

    // Split and compare exactly. `expect(str).toContain("payment-required")`
    // is substring matching, so it passes on "x-payment-required" alone —
    // which is the v1 spelling nothing sends. Deleting both v2 names from the
    // list left that assertion green.
    const exposed = f.headers["Access-Control-Expose-Headers"].split(", ");
    expect(exposed).toContain("payment-required");
    expect(exposed).toContain("payment-response");
    expect(exposed).toContain("x-ripar-subscription");
    expect(next).toHaveBeenCalled();
  });

  it("allows the payment header on the preflight, or the paid retry never happens", () => {
    const f = fake({ method: "OPTIONS", headers: { origin: "https://app.example" } as never });
    corsGuard()(f.req, f.res, vi.fn());
    expect(f.headers["Access-Control-Allow-Headers"]).toContain("payment-signature");
    // 204 and stop. A preflight that reached the payment gate would be quoted
    // for a request the browser has not made yet.
    expect(f.status).toBe(204);
    expect(f.ended).toBe(true);
  });

  it("does nothing when there is no Origin, because that is not a browser", () => {
    const f = fake();
    const next = vi.fn();
    corsGuard()(f.req, f.res, next);
    expect(f.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it("varies on Origin whenever the answer depends on who asked", () => {
    // Without Vary, a CDN can hand one origin's response to another and the
    // failure looks intermittent.
    const f = fake({ headers: { origin: "https://a.example" } as never });
    corsGuard({ origin: ["https://a.example"] })(f.req, f.res, vi.fn());
    expect(f.headers["Vary"]).toBe("Origin");
    expect(f.headers["Access-Control-Allow-Origin"]).toBe("https://a.example");
  });

  it("withholds the allow header from an origin that is not permitted", () => {
    const f = fake({ headers: { origin: "https://evil.example" } as never });
    const next = vi.fn();
    corsGuard({ origin: ["https://a.example"] })(f.req, f.res, next);
    expect(f.headers["Access-Control-Allow-Origin"]).toBeUndefined();
    // The request still runs — refusing here would break non-browser callers
    // that happen to send an Origin.
    expect(next).toHaveBeenCalled();
  });

  it("refuses credentials with a wildcard rather than failing silently in a browser", () => {
    expect(() => corsGuard({ credentials: true })).toThrow(/concrete origin/);
  });
});

/* ── OpenAPI ────────────────────────────────────────────────────────────── */

describe("openApiDocument", () => {
  const agent = defineAgent({
    name: "Text Tools",
    handle: "text-tools",
    payTo: PAY_TO,
    network: "testnet",
    endpoints: [
      defineEndpoint({
        name: "summarize",
        description: "Summarise text.",
        price: "$0.01",
        input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        handler: () => ({}),
      }),
      defineEndpoint({ name: "feed", subscription: { price: "$5.00", period: "30d" }, handler: () => ({}) }),
      defineEndpoint({ name: "secret", price: "$1.00", listed: false, handler: () => ({}) }),
    ],
  });

  it("documents the 402 as a real response with the quote in a HEADER", () => {
    const doc = openApiDocument(agent, { baseUrl: "https://api.example" }) as any;
    const op = doc.paths["/summarize"].post;
    expect(op.responses["402"]).toBeTruthy();
    // The quote travels base64 in PAYMENT-REQUIRED; the body is usually {}.
    // A generated client that looked in the body would find nothing.
    expect(op.responses["402"].headers["PAYMENT-REQUIRED"]).toBeTruthy();
  });

  it("carries the price as an extension, keeping the document valid", () => {
    const doc = openApiDocument(agent) as any;
    expect(doc.paths["/summarize"].post["x-ripar-price"]).toEqual({ amount: "$0.01", pricing: "fixed" });
    expect(doc.paths["/feed"].post["x-ripar-price"]).toEqual({
      amount: "$5.00",
      pricing: "subscription",
      period: "30d",
    });
  });

  it("names PAYMENT-SIGNATURE, not the v1 spelling", () => {
    // A reader told to send X-PAYMENT would fail against any @x402/express
    // server, which is every agent built with this SDK.
    const doc = openApiDocument(agent) as any;
    expect(doc["x-ripar"].paymentHeader).toBe("PAYMENT-SIGNATURE");
  });

  it("leaves unlisted endpoints out unless asked", () => {
    const doc = openApiDocument(agent) as any;
    expect(doc.paths["/secret"]).toBeUndefined();
    const all = openApiDocument(agent, { includeUnlisted: true }) as any;
    expect(all.paths["/secret"]).toBeTruthy();
  });

  it("reuses the endpoint's own input schema, so the two cannot drift", () => {
    const doc = openApiDocument(agent) as any;
    const schema = doc.paths["/summarize"].post.requestBody.content["application/json"].schema;
    expect(schema.required).toEqual(["text"]);
    expect(schema.properties.text).toEqual({ type: "string" });
  });

  it("honours basePath so the paths match what is actually served", () => {
    const doc = openApiDocument(agent, { basePath: "v1" }) as any;
    expect(doc.paths["/v1/summarize"]).toBeTruthy();
  });
});

/* ── circuit breaker ────────────────────────────────────────────────────── */

describe("CircuitBreaker", () => {
  const boom = () => Promise.reject(new Error("upstream down"));

  it("opens after the threshold and then refuses without running the call", async () => {
    let ran = 0;
    const b = new CircuitBreaker("model-api", { threshold: 3 });
    for (let i = 0; i < 3; i++) await b.run(boom).catch(() => {});
    expect(b.status.state).toBe("open");

    await expect(b.run(async () => { ran++; return 1; })).rejects.toBeInstanceOf(CircuitOpenError);
    // The point: the dependency was not touched. Otherwise the agent burns
    // facilitator round trips producing failures at whatever rate traffic
    // arrives.
    expect(ran).toBe(0);
  });

  it("tells the caller when to come back", async () => {
    const b = new CircuitBreaker("db", { threshold: 1, resetMs: 30_000 });
    await b.run(boom).catch(() => {});
    await expect(b.run(async () => 1)).rejects.toThrow(/Retry in \d+s/);
  });

  it("lets exactly one probe through when half-open", async () => {
    const b = new CircuitBreaker("api", { threshold: 1, resetMs: 10 });
    await b.run(boom).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(b.status.state).toBe("half-open");

    let started = 0;
    const slow = () => {
      started++;
      return new Promise<number>((r) => setTimeout(() => r(1), 40));
    };
    const first = b.run(slow);
    // Flooding a recovering dependency the instant the timer expires is how it
    // gets knocked over again.
    await expect(b.run(slow)).rejects.toBeInstanceOf(CircuitOpenError);
    await first;
    expect(started).toBe(1);
    expect(b.status.state).toBe("closed");
  });

  it("re-opens on a failed probe rather than waiting for the threshold again", async () => {
    const b = new CircuitBreaker("api", { threshold: 1, resetMs: 10 });
    await b.run(boom).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    await b.run(boom).catch(() => {});
    expect(b.status.state).toBe("open");
  });

  it("ignores errors the caller says are not the dependency's fault", async () => {
    // A burst of bad requests must not open a circuit on a healthy upstream.
    const b = new CircuitBreaker("api", {
      threshold: 2,
      isFailure: (e) => !String((e as Error).message).includes("404"),
    });
    for (let i = 0; i < 5; i++) await b.run(() => Promise.reject(new Error("404 not found"))).catch(() => {});
    expect(b.status.state).toBe("closed");
  });

  it("counts a call slower than timeoutMs as a failure", async () => {
    const b = new CircuitBreaker("slow", { threshold: 1, timeoutMs: 10 });
    await expect(b.run(() => new Promise((r) => setTimeout(r, 50)))).rejects.toThrow(/exceeded 10ms/);
    expect(b.status.state).toBe("open");
  });
});

/* ── logging ────────────────────────────────────────────────────────────── */

describe("Logger", () => {
  it("never lets a signed payment reach a log line", () => {
    // A payment header carries a signed transaction, and a signed transaction
    // is submittable by anyone holding it.
    const lines: string[] = [];
    const log = new Logger({ write: (l) => lines.push(l) });
    log.info("call", {
      headers: { "payment-signature": "eyJzaWduZWQiOnRydWV9", authorization: "Bearer secret" },
    });
    expect(lines[0]).not.toContain("eyJzaWduZWQiOnRydWV9");
    expect(lines[0]).not.toContain("Bearer secret");
    expect(lines[0]).toContain("[redacted]");
  });

  it("redacts at depth, not just at the top level", () => {
    const out = redact({ a: { b: { "x-payment": "abc", ok: 1 } } }) as any;
    expect(out.a.b["x-payment"]).toBe("[redacted]");
    expect(out.a.b.ok).toBe(1);
  });

  it("emits one parseable object per line", () => {
    const lines: string[] = [];
    new Logger({ write: (l) => lines.push(l) }).info("hello", { n: 1 });
    expect(lines[0].includes("\n")).toBe(false);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toMatchObject({ level: "info", msg: "hello", n: 1 });
    expect(typeof parsed.at).toBe("string");
  });

  it("drops anything below the configured level", () => {
    const lines: string[] = [];
    const log = new Logger({ level: "warn", write: (l) => lines.push(l) });
    log.info("quiet");
    log.error("loud");
    expect(lines).toHaveLength(1);
  });

  it("carries child fields onto every line", () => {
    const lines: string[] = [];
    new Logger({ write: (l) => lines.push(l) }).child({ requestId: "r1" }).info("x");
    expect(JSON.parse(lines[0]).requestId).toBe("r1");
  });

  it("keeps the request line flat, so a log store can index it", () => {
    const line = requestLine({
      endpoint: "summarize", method: "POST", status: 200, ms: 12.7,
      settled: true, usd: 0.01, txId: "TX", payer: PAY_TO,
    });
    expect(Object.values(line).every((v) => typeof v !== "object")).toBe(true);
    expect(line.ms).toBe(13);
  });
});

/* ── access ─────────────────────────────────────────────────────────────── */

describe("accessGuard", () => {
  const applies = () => true;

  it("refuses an allowlist built on an unverified identity", () => {
    // The asymmetry is the point: a forged identity against a DENYlist only
    // refuses itself, but against an ALLOWlist it gets you in free.
    expect(() => accessGuard({ allow: [PAY_TO] }, applies)).toThrow(/UNVERIFIED/);
    expect(() => accessGuard({ allow: [PAY_TO], unverifiedAllowlistIsFine: true }, applies)).not.toThrow();
  });

  it("accepts a denylist without ceremony, because forging one refuses yourself", () => {
    expect(() => accessGuard({ deny: [PAY_TO] }, applies)).not.toThrow();
  });

  it("lets an unpaid probe through, so discovery works for everyone", () => {
    const f = fake();
    const next = vi.fn();
    accessGuard({ deny: [PAY_TO] }, applies)(f.req, f.res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe("FreeTier", () => {
  it("gives each payer N calls and then stops", () => {
    const t = new FreeTier({ callsPerPayer: 2 });
    expect(t.take("A")).toBe(true);
    expect(t.take("A")).toBe(true);
    expect(t.take("A")).toBe(false);
    // Per payer, not global.
    expect(t.take("B")).toBe(true);
    expect(t.remaining("A")).toBe(0);
    expect(t.remaining("B")).toBe(1);
  });

  it("gives an anonymous caller nothing unless asked", () => {
    // Anything above zero here is free to the whole internet: there is nothing
    // to key on but an IP.
    expect(new FreeTier({ callsPerPayer: 5 }).take(null)).toBe(false);
    expect(new FreeTier({ callsPerPayer: 5, callsPerAnonymous: 1 }).take(null)).toBe(true);
  });

  it("peek does not consume, so a gate can look before it decides", () => {
    const t = new FreeTier({ callsPerPayer: 1 });
    expect(t.peek("A")).toBe(true);
    expect(t.peek("A")).toBe(true);
    expect(t.remaining("A")).toBe(1);
  });
});

/* ── webhooks ───────────────────────────────────────────────────────────── */

describe("webhooks", () => {
  const event = {
    type: "settlement" as const,
    endpoint: "summarize",
    txId: "TX",
    usd: 0.01,
    status: 200,
    ms: 12,
    at: new Date(0).toISOString(),
  };

  it("signs over the timestamp AND the body, so a delivery cannot be replayed", () => {
    const body = JSON.stringify(event);
    const sig = signPayload(body, "s3cret", 1000);
    expect(verifySignature(body, sig, "s3cret", 1000, 300, 1000)).toBe(true);

    // A stale delivery is refused by the tolerance window.
    expect(verifySignature(body, sig, "s3cret", 1000, 300, 99_999)).toBe(false);

    // THE replay a signature has to stop, and the only case that proves the
    // timestamp is inside the signed material. An attacker who captured this
    // body and signature presents them with a FRESH timestamp, so the
    // tolerance check passes — and it must still fail, because the signature
    // covers the moment it was made. Signing the body alone leaves this green.
    expect(verifySignature(body, sig, "s3cret", 1200, 300, 1200)).toBe(false);
  });

  it("rejects a tampered body and a wrong secret", () => {
    const sig = signPayload("a", "s3cret", 1000);
    expect(verifySignature("b", sig, "s3cret", 1000, 300, 1000)).toBe(false);
    expect(verifySignature("a", sig, "other", 1000, 300, 1000)).toBe(false);
  });

  it("delivers with a signature header", async () => {
    const seen: { headers: Record<string, string>; body: string }[] = [];
    const sender = new WebhookSender({
      url: "https://hook.test",
      secret: "s3cret",
      fetchImpl: (async (_u: string, init: RequestInit) => {
        seen.push({ headers: init.headers as Record<string, string>, body: String(init.body) });
        return new Response("", { status: 200 });
      }) as unknown as typeof fetch,
    });
    sender.send(event);
    await sender.drain();

    expect(seen).toHaveLength(1);
    const ts = Number(seen[0].headers["x-ripar-timestamp"]);
    expect(verifySignature(seen[0].body, seen[0].headers["x-ripar-signature"], "s3cret", ts)).toBe(true);
  });

  it("never throws into the request that triggered it", async () => {
    const errors: Error[] = [];
    const sender = new WebhookSender({
      url: "https://hook.test",
      attempts: 1,
      onError: (e) => errors.push(e),
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    // A receiver being down must not fail a call the caller has already paid for.
    expect(() => sender.send(event)).not.toThrow();
    await sender.drain();
    expect(errors[0].message).toMatch(/ECONNREFUSED/);
  });

  it("retries a 5xx but not a 4xx", async () => {
    let calls = 0;
    const five = new WebhookSender({
      url: "https://hook.test", attempts: 3,
      fetchImpl: (async () => { calls++; return new Response("", { status: 503 }); }) as unknown as typeof fetch,
    });
    five.send(event);
    await five.drain();
    expect(calls).toBe(3);

    calls = 0;
    const four = new WebhookSender({
      url: "https://hook.test", attempts: 3, onError: () => {},
      // A 4xx means the receiver rejected this event and will reject it again.
      fetchImpl: (async () => { calls++; return new Response("", { status: 400 }); }) as unknown as typeof fetch,
    });
    four.send(event);
    await four.drain();
    expect(calls).toBe(1);
  });

  it("drain waits, so a SIGTERM does not drop an event about money", async () => {
    let done = false;
    const sender = new WebhookSender({
      url: "https://hook.test",
      fetchImpl: (async () => {
        await new Promise((r) => setTimeout(r, 30));
        done = true;
        return new Response("", { status: 200 });
      }) as unknown as typeof fetch,
    });
    sender.send(event);
    expect(sender.inFlight).toBe(1);
    await sender.drain();
    expect(done).toBe(true);
  });
});
