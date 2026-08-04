import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { defineAgent, defineEndpoint } from "../src/define.js";
import { createServer, runtimeOf, serve } from "../src/server.js";
import { Metrics, METRICS_CONTENT_TYPE } from "../src/metrics.js";
import { RunRecorder } from "../src/runs.js";
import { Runtime } from "../src/runtime.js";
import { installShutdown, type ClosableServer } from "../src/shutdown.js";
import { atomicToUsd, decodeX402Header, readReceiptHeader, usdOfAccept } from "../src/headers.js";

const PAY_TO = "PBXELTAXFHNNP3ZQFBC36WKUGVX732UG4CQQH22CP6NNIY5FFIY5UINYAU";

/* ── the header bug that makes everything else measurable ──────────────── */

describe("x402 headers", () => {
  it("decodes the base64 JSON the protocol actually sends", () => {
    const payload = { accepts: [{ amount: "102000", asset: "10458941" }] };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
    expect(decodeX402Header(encoded)).toEqual(payload);
    // Bare JSON still works, because servers in the wild send both.
    expect(decodeX402Header(JSON.stringify(payload))).toEqual(payload);
    expect(decodeX402Header(null)).toBeNull();
    expect(decodeX402Header("not base64 or json !!")).toBeNull();
  });

  it("reads an accepts amount as atomic units, not dollars", () => {
    // 102000 base units of USDC is $0.102. Read as dollars it is a millionfold
    // over, and every price cap silently passes.
    expect(usdOfAccept({ amount: "102000", asset: "10458941" })).toBeCloseTo(0.102, 6);
    expect(usdOfAccept({ amount: "10000", asset: "31566704" })).toBeCloseTo(0.01, 6);
  });

  it("still reads a plain USD price or amount when no asset is named", () => {
    expect(usdOfAccept({ price: "$0.02" })).toBe(0.02);
    expect(usdOfAccept({ maxAmountRequired: "0.5" })).toBe(0.5);
  });

  it("returns null for an asset whose decimals it does not know", () => {
    // Guessing six decimals here would convert a real quote into a wrong number,
    // and every wrong number is a payment the caller did not intend.
    expect(usdOfAccept({ amount: "102000", asset: "999999999" })).toBeNull();
    expect(atomicToUsd("102000", "999999999")).toBeNull();
    // Unless the requirements state the decimals themselves.
    expect(atomicToUsd("102000", "999999999", { decimals: 6 })).toBeCloseTo(0.102, 6);
  });

  it("reads a settlement receipt out of the base64 response header", () => {
    const receipt = Buffer.from(
      JSON.stringify({ success: true, transaction: "TXID123", payer: "ADDR", amount: "10000", asset: "10458941" })
    ).toString("base64");

    // The getter answers only for the name x402 really sends. It used to
    // ignore its argument and return the receipt for anything asked, which
    // made the test pass no matter which names the implementation probed —
    // and the implementation was probing the wrong one, so no settlement was
    // ever read in production while this stayed green.
    const only = (name: string) => (n: string) => (n === name ? receipt : null);

    expect(readReceiptHeader(only("PAYMENT-RESPONSE"))).toMatchObject({
      txId: "TXID123",
      payer: "ADDR",
      amount: "10000",
      usd: 0.01,
    });
    // The older spelling still works, for facilitators that send it.
    expect(readReceiptHeader(only("X-PAYMENT-RESPONSE"))?.txId).toBe("TXID123");
    // And a name nobody sends must not produce a receipt.
    expect(readReceiptHeader(only("SOME-OTHER-HEADER"))).toBeUndefined();
    expect(readReceiptHeader(() => null)).toBeUndefined();
  });
});

/* ── 7. Prometheus metrics ──────────────────────────────────────────────── */

describe("Metrics", () => {
  it("counts by endpoint and status", () => {
    const m = new Metrics();
    m.record("echo", 200, 0.01);
    m.record("echo", 200, 0.02);
    m.record("echo", 402, 0.001);
    m.record("summarize", 500, 1.5);

    const text = m.render();
    expect(text).toContain('ripar_requests_total{endpoint="echo",status="200"} 2');
    expect(text).toContain('ripar_requests_total{endpoint="echo",status="402"} 1');
    expect(text).toContain('ripar_requests_total{endpoint="summarize",status="500"} 1');
  });

  it("tracks in-flight as a gauge that comes back down", () => {
    const m = new Metrics();
    expect(m.render()).toContain("ripar_requests_in_flight 0");
    m.enter();
    m.enter();
    expect(m.render()).toContain("ripar_requests_in_flight 2");
    m.leave();
    expect(m.render()).toContain("ripar_requests_in_flight 1");
  });

  it("never lets the gauge go negative on a double-fired response event", () => {
    const m = new Metrics();
    m.leave();
    m.leave();
    expect(m.render()).toContain("ripar_requests_in_flight 0");
  });

  it("buckets durations cumulatively, as Prometheus histograms require", () => {
    const m = new Metrics();
    m.record("echo", 200, 0.02); // falls in le=0.025 and every bucket above
    m.record("echo", 200, 3); // falls in le=5 and le=10
    const text = m.render();

    expect(text).toContain('ripar_request_duration_seconds_bucket{endpoint="echo",le="0.01"} 0');
    expect(text).toContain('ripar_request_duration_seconds_bucket{endpoint="echo",le="0.025"} 1');
    expect(text).toContain('ripar_request_duration_seconds_bucket{endpoint="echo",le="1"} 1');
    expect(text).toContain('ripar_request_duration_seconds_bucket{endpoint="echo",le="5"} 2');
    expect(text).toContain('ripar_request_duration_seconds_bucket{endpoint="echo",le="+Inf"} 2');
    expect(text).toContain('ripar_request_duration_seconds_sum{endpoint="echo"} 3.02');
    expect(text).toContain('ripar_request_duration_seconds_count{endpoint="echo"} 2');
  });

  it("totals what actually settled", () => {
    const m = new Metrics();
    m.recordSettlement(0.01);
    m.recordSettlement(0.102);
    const text = m.render();
    expect(text).toContain("ripar_settled_total 2");
    expect(text).toContain("ripar_settled_usd_total 0.112");
  });

  it("declares HELP and TYPE for every series, or a scrape rejects it", () => {
    const m = new Metrics();
    m.record("echo", 200, 0.1);
    const text = m.render();
    for (const name of [
      "ripar_requests_total",
      "ripar_requests_in_flight",
      "ripar_request_duration_seconds",
      "ripar_settled_total",
      "ripar_settled_usd_total",
    ]) {
      expect(text).toContain(`# HELP ${name} `);
      expect(text).toContain(`# TYPE ${name} `);
    }
    expect(text.endsWith("\n")).toBe(true);
  });

  it("escapes a label value that would otherwise break the exposition format", () => {
    const m = new Metrics();
    m.record('we"ird\\name', 200, 0.1);
    expect(m.render()).toContain('ripar_requests_total{endpoint="we\\"ird\\\\name",status="200"} 1');
  });
});

/* ── 8. execution record ────────────────────────────────────────────────── */

describe("RunRecorder", () => {
  it("returns the newest first, because that is the question being asked", () => {
    const runs = new RunRecorder(10);
    runs.add({ endpoint: "a", status: 200, ms: 1 });
    runs.add({ endpoint: "b", status: 402, ms: 2 });
    expect(runs.list().map((r) => r.endpoint)).toEqual(["b", "a"]);
  });

  it("keeps only the last N — a ring buffer, not a log", () => {
    const runs = new RunRecorder(3);
    for (let i = 0; i < 10; i++) runs.add({ endpoint: `e${i}`, status: 200, ms: i });
    expect(runs.size).toBe(3);
    expect(runs.list().map((r) => r.endpoint)).toEqual(["e9", "e8", "e7"]);
  });

  it("gives each run an id and a timestamp", () => {
    const runs = new RunRecorder();
    const a = runs.add({ endpoint: "e", status: 200, ms: 1 });
    const b = runs.add({ endpoint: "e", status: 200, ms: 1 });
    expect(a.id).not.toBe(b.id);
    expect(Number.isNaN(Date.parse(a.at))).toBe(false);
  });

  it("omits txId entirely when nothing settled, rather than storing a null", () => {
    const runs = new RunRecorder();
    expect(runs.add({ endpoint: "e", status: 402, ms: 1 })).not.toHaveProperty("txId");
    expect(runs.add({ endpoint: "e", status: 200, ms: 1, txId: "TX" }).txId).toBe("TX");
  });

  it("clamps a limit to what it holds", () => {
    const runs = new RunRecorder(5);
    runs.add({ endpoint: "e", status: 200, ms: 1 });
    expect(runs.list(999)).toHaveLength(1);
    expect(runs.list(0)).toHaveLength(1);
  });
});

/* ── 12. graceful shutdown ──────────────────────────────────────────────── */

describe("Runtime draining", () => {
  it("resolves whenIdle once the last request leaves", async () => {
    const runtime = new Runtime();
    runtime.enter();
    runtime.enter();

    let idle = false;
    const waiting = runtime.whenIdle().then(() => (idle = true));

    runtime.leave();
    await Promise.resolve();
    expect(idle).toBe(false);

    runtime.leave();
    await waiting;
    expect(idle).toBe(true);
  });

  it("resolves immediately when nothing is in flight", async () => {
    await expect(new Runtime().whenIdle()).resolves.toBeUndefined();
  });
});

describe("installShutdown", () => {
  /** A stand-in for http.Server so the ordering can be asserted without a socket. */
  function fakeServer() {
    const calls: string[] = [];
    const server: ClosableServer = {
      close: (cb) => {
        calls.push("close");
        cb?.();
      },
      closeIdleConnections: () => calls.push("closeIdleConnections"),
      closeAllConnections: () => calls.push("closeAllConnections"),
    };
    return { server, calls };
  }

  it("waits for in-flight work, then exits cleanly", async () => {
    const runtime = new Runtime();
    const { server, calls } = fakeServer();
    const exits: string[] = [];
    const { shutdown, uninstall } = installShutdown(server, runtime, {
      timeoutMs: 5_000,
      signals: [],
      log: () => {},
      onExit: (r) => exits.push(r.outcome),
    });

    runtime.enter();
    const draining = shutdown("SIGTERM");
    // The paid call that is mid-flight has already settled; killing it now would
    // charge the caller for a dropped connection.
    await new Promise((r) => setTimeout(r, 20));
    expect(exits).toEqual([]);

    runtime.leave();
    const result = await draining;

    expect(result.outcome).toBe("drained");
    expect(result.abandoned).toBe(0);
    expect(exits).toEqual(["drained"]);
    // Idle keep-alive sockets are closed on the way down; live ones are not.
    expect(calls).toContain("close");
    expect(calls).toContain("closeIdleConnections");
    expect(calls).not.toContain("closeAllConnections");
    uninstall();
  });

  it("gives up on its own terms rather than being SIGKILLed mid-write", async () => {
    const runtime = new Runtime();
    const { server, calls } = fakeServer();
    const { shutdown, uninstall } = installShutdown(server, runtime, {
      timeoutMs: 40,
      signals: [],
      log: () => {},
      onExit: () => {},
    });

    runtime.enter(); // never leaves
    const result = await shutdown("SIGTERM");

    expect(result.outcome).toBe("timeout");
    expect(result.abandoned).toBe(1);
    expect(calls).toContain("closeAllConnections");
    uninstall();
  });

  it("treats a second signal as the same drain, not a new one", async () => {
    const runtime = new Runtime();
    const { server } = fakeServer();
    let exits = 0;
    const { shutdown, uninstall } = installShutdown(server, runtime, {
      timeoutMs: 1_000,
      signals: [],
      log: () => {},
      onExit: () => exits++,
    });

    const [a, b] = await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);
    expect(a).toBe(b);
    expect(exits).toBe(1);
    uninstall();
  });

  it("removes its signal handlers when uninstalled", () => {
    const runtime = new Runtime();
    const { server } = fakeServer();
    const before = process.listenerCount("SIGTERM");
    const { uninstall } = installShutdown(server, runtime, { log: () => {}, onExit: () => {} });
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    uninstall();
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});

/* ── all three, on a real server ────────────────────────────────────────── */

describe("a served agent's unpaid observability routes", () => {
  let server: Server;
  let base: string;

  const echo = defineEndpoint({
    name: "echo",
    description: "Returns what it was given.",
    price: "$0.01",
    input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    handler: ({ body }) => ({ echoed: (body as { text: string }).text }),
  });

  beforeAll(async () => {
    const app = await createServer(
      defineAgent({
        name: "Observed Agent",
        handle: "observed-agent",
        description: "Fixture for metrics, runs and drain.",
        payTo: PAY_TO,
        network: "testnet",
        endpoints: [echo],
      }),
      { network: "testnet", payTo: PAY_TO, runsCapacity: 5 }
    );
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => new Promise<void>((resolve) => server.close(() => resolve())));

  it("serves /metrics without payment, in the format Prometheus scrapes", async () => {
    await fetch(`${base}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });

    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(METRICS_CONTENT_TYPE);

    const text = await res.text();
    expect(text).toContain('ripar_requests_total{endpoint="echo",status="402"} 1');
    expect(text).toContain("ripar_requests_in_flight 0");
    expect(text).toContain('ripar_request_duration_seconds_count{endpoint="echo"} 1');
    expect(text).toContain("ripar_settled_usd_total 0");
  });

  it("does not meter its own free routes — that is not the signal", async () => {
    await fetch(`${base}/health`);
    const text = await (await fetch(`${base}/metrics`)).text();
    expect(text).not.toContain('endpoint="health"');
    expect(text).not.toContain('endpoint="metrics"');
  });

  it("serves the execution record without payment, capped", async () => {
    for (let i = 0; i < 8; i++) {
      await fetch(`${base}/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `call-${i}` }),
      });
    }

    const res = await fetch(`${base}/_ripar/runs`);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.capacity).toBe(5);
    expect(body.runs).toHaveLength(5); // the cap holds, not the 9 calls made
    expect(body.runs[0]).toMatchObject({ endpoint: "echo", status: 402 });
    expect(typeof body.runs[0].ms).toBe("number");
    expect(typeof body.runs[0].id).toBe("string");

    // Unpaid and therefore world-readable: it must not carry what callers sent.
    expect(JSON.stringify(body)).not.toContain("call-7");
  });

  it("honours ?limit but will not exceed the buffer", async () => {
    expect((await (await fetch(`${base}/_ripar/runs?limit=2`)).json()).runs).toHaveLength(2);
    expect((await (await fetch(`${base}/_ripar/runs?limit=500`)).json()).runs).toHaveLength(5);
    expect((await (await fetch(`${base}/_ripar/runs?limit=abc`)).json()).runs).toHaveLength(5);
  });

  it("drains on shutdown and stops listening, the way SIGTERM would", async () => {
    const results: string[] = [];
    const listening = await serve(
      defineAgent({
        name: "Served Agent",
        handle: "served-agent",
        description: "Fixture for serve()'s own shutdown wiring.",
        payTo: PAY_TO,
        network: "testnet",
        endpoints: [echo],
      }),
      {
        port: 0,
        network: "testnet",
        payTo: PAY_TO,
        // Signals off and process.exit replaced: the drain is the same code
        // path SIGTERM takes, minus killing the test runner.
        handleSignals: false,
        onReady: () => {},
        onShutdown: (r) => results.push(r.outcome),
      }
    );
    const url = `http://127.0.0.1:${(listening.address() as { port: number }).port}`;
    expect((await fetch(`${url}/health`)).status).toBe(200);

    const result = await listening.shutdown("test");
    expect(result.outcome).toBe("drained");
    expect(results).toEqual(["drained"]);

    // The socket really is gone, not merely marked as draining.
    await expect(fetch(`${url}/health`)).rejects.toThrow();
    listening.uninstallSignals();
  });

  it("lets an in-flight request finish before the drain completes", async () => {
    // A slow price function makes the 402 itself slow, which is the only way to
    // hold a real request open on a gated route without paying for one.
    const slow = defineEndpoint({
      name: "slow",
      price: async () => {
        await new Promise((r) => setTimeout(r, 250));
        return "$0.01";
      },
      priceHint: "$0.01",
      handler: () => ({ ok: true }),
    });
    const app = await createServer(
      defineAgent({
        name: "Slow Agent",
        handle: "slow-agent",
        description: "Fixture for draining real in-flight work.",
        payTo: PAY_TO,
        network: "testnet",
        endpoints: [slow],
      }),
      { network: "testnet", payTo: PAY_TO }
    );
    const s: Server = await new Promise((resolve) => {
      const sv = app.listen(0, () => resolve(sv));
    });
    const url = `http://127.0.0.1:${(s.address() as { port: number }).port}/slow`;
    const runtime = runtimeOf(app)!;

    const inFlight = fetch(url, { method: "POST" });
    await new Promise((r) => setTimeout(r, 60));
    expect(runtime.inFlight).toBe(1);

    let drained = false;
    const { shutdown, uninstall } = installShutdown(s, runtime, {
      timeoutMs: 5_000,
      signals: [],
      log: () => {},
      onExit: () => (drained = true),
    });
    const draining = shutdown("SIGTERM");

    // The request that was already running gets its answer; the drain does not
    // finish until it has.
    const res = await inFlight;
    expect(res.status).toBe(402);

    const result = await draining;
    expect(result.outcome).toBe("drained");
    expect(result.abandoned).toBe(0);
    expect(drained).toBe(true);
    uninstall();
  });

  it("503s new work while draining instead of accepting what it cannot finish", async () => {
    const app = await createServer(
      defineAgent({
        name: "Draining Agent",
        handle: "draining-agent",
        description: "Fixture for the drain gate.",
        payTo: PAY_TO,
        network: "testnet",
        endpoints: [echo],
      }),
      { network: "testnet", payTo: PAY_TO }
    );
    const s: Server = await new Promise((resolve) => {
      const sv = app.listen(0, () => resolve(sv));
    });
    const url = `http://127.0.0.1:${(s.address() as { port: number }).port}`;

    expect((await fetch(`${url}/health`)).status).toBe(200);

    runtimeOf(app)!.beginDrain();

    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect((await res.json()).error.code).toBe("shutting_down");

    await new Promise<void>((resolve) => s.close(() => resolve()));
  });
});
