import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import express from "express";
import algosdk from "algosdk";
import { RiparClient } from "../src/client.js";
import {
  DEFAULT_RETRY_AFTER_CAP_MS,
  QuoteHistory,
  canonicalJson,
  decodeScore,
  driftReport,
  headerValue,
  manifestSigningBytes,
  newIdempotencyKey,
  observationOf,
  parseRetryAfter,
  pickAgent,
  readRetryAfter,
  readScore,
  verifyManifestSignature,
} from "../src/client-extras.js";
import {
  cmdAudit,
  cmdBench,
  cmdEscrow,
  cmdRotate,
  cmdTest,
  decodeAgent,
  decodeJob,
  methodSelector,
  type ChainReader,
} from "../src/cli-chain.js";
import { run, type CliIO } from "../src/cli.js";
import { createServer } from "../src/server.js";
import { defineAgent, defineEndpoint } from "../src/define.js";
import { ALGORAND_TESTNET_CAIP2 } from "@x402/avm";

/**
 * The second round of client features, and the five commands that check
 * something already deployed.
 *
 * Same rule as client-features.test.ts: what can be exercised against a real
 * Ripar server is, because a cache or a guard tested against a hand-rolled stub
 * proves the stub works. algod and the facilitator are doubled — one is a public
 * node and the other is somebody else's chain — and the box bytes those doubles
 * return are REAL, captured from the deployed registries on TestNet, so a
 * decoder that drifts from the contract's ARC-4 layout fails here rather than in
 * production.
 */

const PAY_TO = "PBXELTAXFHNNP3ZQFBC36WKUGVX732UG4CQQH22CP6NNIY5FFIY5UINYAU";
const PAYER = "B2DGXU2QSRHXNZJMP5FFFU77W5NUMZTZ3X3MSO3PJC4ZQ75CSDL5EKULI4";
/** The live agent's payout address, and the one registry agent 1 is bound to. */
const LIVE_PAY_TO = "KBDRZK3BV2YFJJAVV3S5XQYDWU4RDDI6EDXXKMG3O4AEVPEDCETDKEISKQ";
const NETWORK = `${ALGORAND_TESTNET_CAIP2}xi9/cOUJOiI=`;
const MNEMONIC = algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk);

/* ── canned chain bytes, captured from TestNet ──────────────────────────── */

/** ReputationRegistry 768633999, box sc_ + uint64(1): the live agent's score.
 *  Seven uint64s — id 1, paid once, 10000 micro, 2 validated, 0 disputed. */
const REAL_SCORE_BOX = "AAAAAAAAAAEAAAAAAAAAAQAAAAAAACcQAAAAAAAAAAIAAAAAAAAAAAAAAABqchdhAAAAAGpyF5I=";

/** ValidationRegistry 768634000, box jb_ + uint64(1). A VALIDATED job: the two
 *  DynamicBytes fields put a 2-byte offset in the head each, which is why the
 *  status sits at byte 68. */
const REAL_JOB_BOX =
  "000000000000000150471cab61aeb054a415aee5dbc303b539118d1e20ef7530db77004abc8311260000000000000001" +
  "000000000000000200000000000f4240005c007e0000000000000003000000006a721766000000006a7217770020" +
  "07070707070707070707070707070707070707070707070707070707070707070020" +
  "0909090909090909090909090909090909090909090909090909090909090909";

/** IdentityRegistry 768633998, box ag_ + uint64(1). */
const REAL_AGENT_BOX =
  "0000000000000001003a50471cab61aeb054a415aee5dbc303b539118d1e20ef7530db77004abc831126" +
  "000000006a721756000000006a721756001672697061722d6167656e742e76657263656c2e617070";

/* ── helpers ────────────────────────────────────────────────────────────── */

function quoted(usd: number, asset = "10458941") {
  const payload = {
    x402Version: 2,
    accepts: [{ scheme: "exact", network: NETWORK, amount: String(Math.round(usd * 1e6)), asset, payTo: PAY_TO }],
  };
  return new Response("{}", {
    status: 402,
    headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(payload)).toString("base64") },
  });
}

function settled(usd: number, body: unknown = { ok: true }, extra: Record<string, string> = {}) {
  const receipt = {
    success: true,
    transaction: `TX-${Math.random().toString(16).slice(2)}`,
    amount: String(Math.round(usd * 1e6)),
    asset: "10458941",
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "X-PAYMENT-RESPONSE": Buffer.from(JSON.stringify(receipt)).toString("base64"),
      ...extra,
    },
  });
}

function targetOf(url: string | URL | Request): string {
  if (typeof url === "string") return url;
  if (url instanceof URL) return url.toString();
  return (url as Request).url;
}

/** Records every request the client actually made, headers included — the only
 *  way to prove one key was sent twice rather than two keys once each. */
function recordingFetch(steps: (() => Response | Promise<Response>)[], { cycle = false } = {}) {
  const calls: { url: string; init?: RequestInit; headers: Record<string, string> }[] = [];
  let i = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    // @x402/fetch re-sends a Request object on the paid leg, so the headers of
    // the leg that matters are on the Request, not on init.
    if (typeof url === "object" && "headers" in url) {
      (url as Request).headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    }
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[String(k).toLowerCase()] = String(v);
    }
    calls.push({ url: targetOf(url), init, headers });
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
    keys: () => calls.map((c) => c.headers["idempotency-key"]).filter(Boolean),
  };
}

/** algod's box endpoint, doubled. Returns the canned value for a known box and
 *  404 for anything else, which is what a node does for a box that is not
 *  there — and "no score" has to be distinguishable from "node down". */
function algodBoxes(boxes: Record<string, string>) {
  const seen: string[] = [];
  const impl = (async (url: string | URL | Request) => {
    const u = targetOf(url);
    seen.push(u);
    const match = /box\?name=(.+)$/.exec(u);
    const name = match ? decodeURIComponent(match[1]) : "";
    const value = boxes[name];
    if (!value) return new Response(JSON.stringify({ message: "box not found" }), { status: 404 });
    return new Response(JSON.stringify({ name, round: 1, value }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

function boxKey(prefix: string, id: number) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(id));
  return `b64:${Buffer.concat([Buffer.from(prefix), b]).toString("base64")}`;
}

/** A score box built to order, in the layout the contract writes. */
function scoreBox(v: {
  agentId: number;
  jobsPaid: number;
  volumeMicro: number;
  validated?: number;
  disputed?: number;
  firstAt?: number;
  lastAt?: number;
}) {
  const b = Buffer.alloc(56);
  const fields = [
    v.agentId,
    v.jobsPaid,
    v.volumeMicro,
    v.validated ?? 0,
    v.disputed ?? 0,
    v.firstAt ?? 1_700_000_000,
    v.lastAt ?? 1_700_000_100,
  ];
  fields.forEach((n, i) => b.writeBigUInt64BE(BigInt(n), i * 8));
  return b.toString("base64");
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
    io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
    cliIo: (fetchImpl?: typeof fetch) =>
      ({
        out: (l: string) => out.push(l),
        err: (l: string) => err.push(l),
        env: {},
        cwd: process.cwd(),
        fetchImpl,
      }) as CliIO,
  };
}

/* ── 1. Retry-After ─────────────────────────────────────────────────────── */

describe("Retry-After", () => {
  it("reads delta-seconds as SECONDS, which is the whole point", () => {
    // Read as milliseconds, "come back in 30 seconds" becomes 30ms — worse than
    // ignoring the header, because it looks like it is being honoured.
    expect(parseRetryAfter("30")).toEqual({ ms: 30_000, source: "seconds" });
    expect(parseRetryAfter("0")).toEqual({ ms: 0, source: "seconds" });
  });

  it("reads the HTTP-date form, and never returns a negative wait", () => {
    const now = Date.UTC(2026, 7, 4, 12, 0, 0);
    const later = new Date(now + 45_000).toUTCString();
    expect(parseRetryAfter(later, now)?.ms).toBeGreaterThanOrEqual(44_000);
    expect(parseRetryAfter(later, now)?.source).toBe("date");
    // A date already past means "now", not a wait that runs backwards.
    expect(parseRetryAfter(new Date(now - 60_000).toUTCString(), now)?.ms).toBe(0);
  });

  it("declines to guess at a header it cannot read", () => {
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(readRetryAfter(() => "later")).toEqual({ kind: "none" });
    expect(readRetryAfter(() => null)).toEqual({ kind: "none" });
  });

  it("refuses a wait past the cap rather than clamping it", () => {
    // Clamping would mean coming back before the server said it would be
    // ready — the same hammering, one step politer.
    const advice = readRetryAfter(() => "300", { capMs: 60_000 });
    expect(advice.kind).toBe("too-long");
    if (advice.kind !== "too-long") return;
    expect(advice.ms).toBe(300_000);
    expect(advice.capMs).toBe(60_000);
    expect(DEFAULT_RETRY_AFTER_CAP_MS).toBe(60_000);
  });

  it("finds the header whatever case it arrives in", () => {
    expect(readRetryAfter((n) => (n === "retry-after" ? "2" : null))).toMatchObject({ ms: 2_000 });
    expect(readRetryAfter((n) => (n === "Retry-After" ? "2" : null))).toMatchObject({ ms: 2_000 });
  });
});

describe("RiparClient honouring Retry-After", () => {
  it("waits as long as the server asked instead of its own backoff", async () => {
    const stub = recordingFetch([
      () => new Response("busy", { status: 503, headers: { "Retry-After": "1" } }),
      () => settled(0.01),
    ]);
    const client = new RiparClient({
      mnemonic: MNEMONIC,
      network: "testnet",
      // A backoff of 1ms: without the header this retry is instant, so the
      // elapsed time is entirely the server's number.
      retry: { attempts: 2, baseMs: 1 },
      fetchImpl: stub.impl,
    });

    const started = Date.now();
    const res = await client.call(`https://a.test/work`, {});
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    expect(res.attempts).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(900);
  });

  it("stops rather than coming back early when the wait is past the cap", async () => {
    const stub = recordingFetch([() => new Response("busy", { status: 503, headers: { "Retry-After": "300" } })], {
      cycle: true,
    });
    const client = new RiparClient({
      mnemonic: MNEMONIC,
      network: "testnet",
      retry: { attempts: 3, baseMs: 1 },
      retryAfterMaxMs: 5_000,
      fetchImpl: stub.impl,
    });

    await expect(client.call("https://a.test/work", {})).rejects.toMatchObject({
      code: "retry_after_too_long",
    });
    // One attempt, and it named both numbers rather than retrying at 1ms.
    expect(stub.count).toBe(1);
    await client.call("https://a.test/work", {}).catch((err: Error) => {
      expect(err.message).toContain("300s");
      expect(err.message).toContain("5s");
    });
  });

  it("retries a 429 that names a Retry-After, which it never used to", async () => {
    const stub = recordingFetch([
      () => new Response("slow down", { status: 429, headers: { "Retry-After": "0" } }),
      () => settled(0.01),
    ]);
    const client = new RiparClient({
      mnemonic: MNEMONIC,
      network: "testnet",
      retry: { attempts: 2, baseMs: 1 },
      fetchImpl: stub.impl,
    });
    const res = await client.call("https://a.test/work", {});
    expect(res.status).toBe(200);
    expect(res.attempts).toBe(2);
  });

  it("still refuses to repeat a 429 that named nothing", async () => {
    // Without a Retry-After there is no number to honour, and guessing one is
    // how a client gets its address banned.
    const stub = recordingFetch([() => new Response("slow down", { status: 429 })], { cycle: true });
    const client = new RiparClient({
      mnemonic: MNEMONIC,
      network: "testnet",
      retry: { attempts: 3, baseMs: 1 },
      fetchImpl: stub.impl,
    });
    await expect(client.call("https://a.test/work", {})).rejects.toMatchObject({ status: 429 });
    expect(stub.count).toBe(1);
  });

  it("will not repeat a 429 that already charged", async () => {
    // A foreign server may settle and then refuse. Repeating that pays twice,
    // whatever its Retry-After says.
    const charged = () => {
      const res = settled(0.01, { error: "rate limited" }, { "Retry-After": "0" });
      return new Response(res.body, { status: 429, headers: res.headers });
    };
    const stub = recordingFetch([charged], { cycle: true });
    const client = new RiparClient({
      mnemonic: MNEMONIC,
      network: "testnet",
      retry: { attempts: 3, baseMs: 1 },
      fetchImpl: stub.impl,
    });
    await expect(client.call("https://a.test/work", {})).rejects.toMatchObject({ status: 429 });
    expect(stub.count).toBe(1);
  });

  it("says what the server asked for in the error it gives up with", async () => {
    const stub = recordingFetch([() => new Response("busy", { status: 503, headers: { "Retry-After": "2" } })], {
      cycle: true,
    });
    const client = new RiparClient({
      mnemonic: MNEMONIC,
      network: "testnet",
      retry: false,
      fetchImpl: stub.impl,
    });
    await expect(client.call("https://a.test/work", {})).rejects.toThrow(/asked for 2s/);
  });
});

/* ── 2. client-side idempotency ─────────────────────────────────────────── */

describe("idempotency keys", () => {
  it("sends the SAME key on every attempt of one call", async () => {
    const stub = recordingFetch([
      () => new Response("boom", { status: 503 }),
      () => new Response("boom", { status: 503 }),
      () => settled(0.01),
    ]);
    const client = new RiparClient({
      mnemonic: MNEMONIC,
      network: "testnet",
      retry: { attempts: 3, baseMs: 1 },
      fetchImpl: stub.impl,
    });
    await client.call("https://a.test/work", { n: 1 });

    const keys = stub.keys();
    expect(keys.length).toBeGreaterThanOrEqual(3);
    // One distinct key. A fresh key per attempt would make every retry a new
    // claim, and the server would settle each one.
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^ripar-[0-9a-f-]{36}$/);
  });

  it("sends a DIFFERENT key for a different call", async () => {
    const stub = recordingFetch([() => settled(0.01)], { cycle: true });
    const client = new RiparClient({ mnemonic: MNEMONIC, network: "testnet", fetchImpl: stub.impl });
    await client.call("https://a.test/work", { n: 1 });
    await client.call("https://a.test/work", { n: 1 });
    // Same URL and same body. Sharing a key here would answer the second call
    // with the first one's result and never run it.
    expect(new Set(stub.keys()).size).toBe(2);
  });

  it("leaves a caller's own key alone, in whatever case they wrote it", async () => {
    // A caller who set the header owns the key — they may be coordinating
    // retries across processes, where a key invented per call is exactly wrong.
    const stub = recordingFetch([() => new Response("boom", { status: 503 }), () => settled(0.01)]);
    const client = new RiparClient({
      mnemonic: MNEMONIC,
      network: "testnet",
      retry: { attempts: 2, baseMs: 1 },
      fetchImpl: stub.impl,
    });
    await client.call("https://a.test/work", {}, { headers: { "idempotency-key": "mine-1" } });
    expect(stub.keys()).toEqual(["mine-1", "mine-1"]);
    expect(stub.keys().some((k) => k?.startsWith("ripar-"))).toBe(false);
  });

  it("sends none when switched off", async () => {
    const stub = recordingFetch([() => settled(0.01)], { cycle: true });
    const client = new RiparClient({
      mnemonic: MNEMONIC,
      network: "testnet",
      idempotency: false,
      fetchImpl: stub.impl,
    });
    await client.call("https://a.test/work", {});
    expect(stub.keys()).toEqual([]);
  });

  it("generates keys that do not repeat", () => {
    const keys = new Set(Array.from({ length: 200 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(200);
  });

  it("keeps a caller's headers when they arrive as a Headers instance", async () => {
    // Spreading a Headers into an object literal yields {} — the request goes
    // out, still pays, and arrives without the header it was meant to carry.
    const stub = recordingFetch([() => settled(0.01)], { cycle: true });
    const client = new RiparClient({ mnemonic: MNEMONIC, network: "testnet", fetchImpl: stub.impl });
    await client.call(
      "https://a.test/work",
      {},
      { headers: new Headers({ "idempotency-key": "mine-2", "x-trace": "t1" }) }
    );
    expect(stub.keys()).toEqual(["mine-2"]);
    expect(stub.calls[0].headers["x-trace"]).toBe("t1");
  });

  it("reads a header out of every shape HeadersInit takes", () => {
    expect(headerValue({ "Idempotency-Key": "a" }, "idempotency-key")).toBe("a");
    expect(headerValue([["idempotency-key", "b"]], "Idempotency-Key")).toBe("b");
    expect(headerValue(new Headers({ "idempotency-key": "c" }), "Idempotency-Key")).toBe("c");
    expect(headerValue(undefined, "Idempotency-Key")).toBeUndefined();
    expect(headerValue({ other: "x" }, "Idempotency-Key")).toBeUndefined();
  });
});

/* ── 3. reputation-weighted selection ───────────────────────────────────── */

describe("pickAgent", () => {
  const boxes = {
    [boxKey("sc_", 1)]: scoreBox({ agentId: 1, jobsPaid: 2, volumeMicro: 10_000, lastAt: 1_785_000_000 }),
    [boxKey("sc_", 2)]: scoreBox({ agentId: 2, jobsPaid: 40, volumeMicro: 5_000_000, disputed: 3 }),
    [boxKey("sc_", 3)]: scoreBox({ agentId: 3, jobsPaid: 2, volumeMicro: 10_000, lastAt: 1_786_000_000 }),
  };

  it("ranks by settled volume, then count, then recency", async () => {
    const algod = algodBoxes(boxes);
    const out = await pickAgent([1, 2, 3, 9], { network: "testnet", fetchImpl: algod.impl });

    expect(out.ranked.map((r) => r.agentId)).toEqual([2, 3, 1]);
    // 3 and 1 tie on volume AND on count; 3 was paid more recently.
    expect(out.best?.agentId).toBe(2);
    expect(out.best?.score?.volumeUsd).toBeCloseTo(5, 6);
    // Agent 9 has no box: reported, not silently dropped.
    expect(out.rejected.map((r) => r.agentId)).toEqual([9]);
    expect(out.rejected[0].reason).toMatch(/nobody has ever paid it/i);
  });

  it("says what it is actually measuring", async () => {
    const out = await pickAgent([1], { network: "testnet", fetchImpl: algodBoxes(boxes).impl });
    expect(out.basis).toMatch(/money that moved/i);
    expect(out.basis).toMatch(/not quality/i);
    expect(out.basis).toMatch(/nobody judged the work/i);
  });

  it("compares minVolume in DOLLARS, not in base units", async () => {
    // 10000 micro-USDC is one cent. Compared straight against a dollar
    // threshold it looks like ten thousand dollars and passes everything.
    const algod = algodBoxes(boxes);
    const strict = await pickAgent([1], { network: "testnet", minVolume: 0.5, fetchImpl: algod.impl });
    expect(strict.ranked).toHaveLength(0);
    expect(strict.rejected[0].reason).toMatch(/\$0\.010000.*below the minimum of \$0\.500000/);

    const loose = await pickAgent([1], { network: "testnet", minVolume: 0.005, fetchImpl: algod.impl });
    expect(loose.ranked.map((r) => r.agentId)).toEqual([1]);
  });

  it("applies minJobsPaid and maxDisputed, and names the number that failed", async () => {
    const algod = algodBoxes(boxes);
    const out = await pickAgent([1, 2], { network: "testnet", minJobsPaid: 10, fetchImpl: algod.impl });
    expect(out.ranked.map((r) => r.agentId)).toEqual([2]);
    expect(out.rejected[0].reason).toContain("paid 2 time(s), below the minimum of 10");

    const clean = await pickAgent([1, 2], { network: "testnet", maxDisputed: 0, fetchImpl: algod.impl });
    expect(clean.ranked.map((r) => r.agentId)).toEqual([1]);
    expect(clean.rejected[0].reason).toContain("3 disputed verdict(s)");
  });

  it("keeps the caller's own record alongside the score", async () => {
    const algod = algodBoxes(boxes);
    const out = await pickAgent([{ agentId: 2, url: "https://two.test/x" }, { agentId: 1 }], {
      network: "testnet",
      fetchImpl: algod.impl,
    });
    expect(out.best?.url).toBe("https://two.test/x");
    expect(out.best?.candidate).toMatchObject({ agentId: 2 });
  });

  it("reads the box the contract actually writes", async () => {
    const algod = algodBoxes({ [boxKey("sc_", 1)]: REAL_SCORE_BOX });
    const score = await readScore(1, { network: "testnet", fetchImpl: algod.impl });

    // Straight off TestNet: agent 1, paid once, one cent, two passing verdicts.
    expect(score).toMatchObject({ agentId: 1, jobsPaid: 1, volumeMicro: 10_000, validated: 2, disputed: 0 });
    expect(score?.volumeUsd).toBeCloseTo(0.01, 9);
    expect(score?.lastAt).toBe(new Date(1_785_862_034_000).toISOString());
    expect(algod.seen[0]).toContain("/v2/applications/768633999/box?name=");
  });

  it("refuses to decode a box that is not a score", async () => {
    expect(() => decodeScore(new Uint8Array(24))).toThrow(/56 bytes/);
  });

  it("refuses to rank against a registry that is not deployed", async () => {
    await expect(pickAgent([1], { network: "mainnet" })).rejects.toThrow(/not deployed on mainnet/i);
  });

  it("is reachable from the client, on the client's own network", async () => {
    const algod = algodBoxes(boxes);
    const client = new RiparClient({ network: "testnet", fetchImpl: algod.impl });
    const out = await client.pickAgent([1, 2]);
    expect(out.best?.agentId).toBe(2);
  });
});

/* ── 4. price drift ─────────────────────────────────────────────────────── */

describe("price drift", () => {
  it("says there is no baseline rather than reporting no drift", async () => {
    const stub = recordingFetch([() => quoted(0.01)], { cycle: true });
    const client = new RiparClient({ network: "testnet", fetchImpl: stub.impl });
    const report = await client.drift("https://a.test/work");

    expect(report.drifted).toBe(false);
    expect(report.direction).toBe("unknown");
    expect(report.baseline).toBeNull();
    // "unchanged" here would be a claim about a comparison that never happened.
    expect(report.summary).toMatch(/first quote seen/i);
    expect(report.summary).not.toMatch(/unchanged/i);
  });

  it("catches a hundredfold rise and says by how much", async () => {
    let usd = 0.01;
    const stub = recordingFetch([() => quoted(usd)], { cycle: true });
    const client = new RiparClient({ network: "testnet", fetchImpl: stub.impl });

    await client.quote("https://a.test/work");
    usd = 1;
    const report = await client.drift("https://a.test/work");

    expect(report.drifted).toBe(true);
    expect(report.direction).toBe("up");
    expect(report.baseline).toBeCloseTo(0.01, 6);
    expect(report.current).toBeCloseTo(1, 6);
    expect(report.changeUsd).toBeCloseTo(0.99, 6);
    expect(report.factor).toBeCloseTo(100, 6);
    expect(report.summary).toContain("100×");
  });

  it("measures against the FIRST price, not the last one", async () => {
    // A rise applied a little at a time is invisible against the previous
    // sample and obvious against the baseline.
    let usd = 0.01;
    const stub = recordingFetch([() => quoted(usd)], { cycle: true });
    const client = new RiparClient({ network: "testnet", fetchImpl: stub.impl });

    await client.quote("https://a.test/work");
    usd = 0.02;
    await client.quote("https://a.test/work");
    usd = 0.03;
    const report = await client.drift("https://a.test/work");

    expect(report.baseline).toBeCloseTo(0.01, 6);
    expect(report.previous).toBeCloseTo(0.02, 6);
    expect(report.factor).toBeCloseTo(3, 6);
    expect(report.samples).toBe(3);
  });

  it("is not fooled by the quote cache", async () => {
    let usd = 0.01;
    const stub = recordingFetch([() => quoted(usd)], { cycle: true });
    const client = new RiparClient({
      network: "testnet",
      quoteCache: { ttlMs: 60_000 },
      fetchImpl: stub.impl,
    });

    await client.quote("https://a.test/work");
    usd = 0.5;
    const report = await client.drift("https://a.test/work");
    // A cached quote compared with itself reports "unchanged" for a price that
    // has moved fiftyfold.
    expect(report.drifted).toBe(true);
    expect(report.current).toBeCloseTo(0.5, 6);
  });

  it("treats a quote that stopped being readable as drift", async () => {
    let asset = "10458941";
    const stub = recordingFetch([() => quoted(0.01, asset)], { cycle: true });
    const client = new RiparClient({ network: "testnet", fetchImpl: stub.impl });

    await client.quote("https://a.test/work");
    asset = "999999999"; // decimals unknown, so no USD can be derived
    const report = await client.drift("https://a.test/work");

    expect(report.drifted).toBe(true);
    expect(report.current).toBeNull();
    expect(report.summary).toMatch(/maxPrice cannot check/i);
  });

  it("records a free endpoint as zero and a failure as nothing", async () => {
    const client = new RiparClient({
      network: "testnet",
      fetchImpl: recordingFetch([
        () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
        () => new Response("nope", { status: 500 }),
      ]).impl,
    });
    await client.quote("https://a.test/free");
    expect(client.quoteHistoryFor("https://a.test/free")).toEqual([expect.objectContaining({ usd: 0 })]);

    await client.quote("https://a.test/broken");
    // A 500 quoted nothing. Recording it as free would put a price in the
    // history nobody was ever offered.
    expect(client.quoteHistoryFor("https://a.test/broken")).toEqual([]);
  });

  it("keeps the baseline when the history fills up", () => {
    const history = new QuoteHistory(3);
    history.record("https://a.test/x", observationOf(0.01, null, 1));
    history.record("https://a.test/x", observationOf(0.02, null, 2));
    history.record("https://a.test/x", observationOf(0.03, null, 3));
    history.record("https://a.test/x", observationOf(0.04, null, 4));

    const kept = history.observations("https://a.test/x");
    expect(kept).toHaveLength(3);
    // Dropping the oldest would slide the baseline forward and erase a slow
    // rise one sample at a time.
    expect(kept[0].usd).toBe(0.01);
    expect(kept.at(-1)?.usd).toBe(0.04);
  });

  it("keeps a history per endpoint and per query, not per host", () => {
    const history = new QuoteHistory();
    history.record("https://a.test/x?pages=1", observationOf(0.01));
    expect(driftReport("https://a.test/x?pages=50", history.observations("https://a.test/x?pages=50"), observationOf(0.5)).baseline).toBeNull();
    // The fragment never reaches the server, so it cannot split a history.
    expect(history.observations("https://a.test/x?pages=1#top")).toHaveLength(1);
  });
});

/* ── 5. manifest signatures ─────────────────────────────────────────────── */

describe("verifyManifestSignature", () => {
  const account = algosdk.generateAccount();
  /** Whitespace and unsorted keys, like a manifest actually served. Re-
   *  serialising this to verify it produces different bytes and breaks a
   *  perfectly good signature. */
  const body = `{\n  "payTo": "${PAY_TO}",\n  "name": "Agent"\n}`;
  const signature = Buffer.from(algosdk.signBytes(Buffer.from(body, "utf8"), account.sk)).toString("base64");

  it("verifies a signature made the way an agent makes one", () => {
    const verdict = verifyManifestSignature(body, signature, account.addr.toString());
    expect(verdict.ok).toBe(true);
  });

  it("refuses a body that changed by one character", () => {
    // The attack: a proxy rewrites payTo, and every settlement on the endpoint
    // goes to somebody else while the manifest still looks valid.
    const tampered = body.replace(PAY_TO, PAYER);
    const verdict = verifyManifestSignature(tampered, signature, account.addr.toString());
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe("not_signed_by_address");
    expect(verdict.reason).toMatch(/nobody has attested to/i);
  });

  it("refuses a signature by a different key", () => {
    const other = algosdk.generateAccount();
    const forged = Buffer.from(algosdk.signBytes(Buffer.from(body, "utf8"), other.sk)).toString("base64");
    const verdict = verifyManifestSignature(body, forged, account.addr.toString());
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe("not_signed_by_address");
  });

  it("verifies nothing against an address it cannot decode", () => {
    const verdict = verifyManifestSignature(body, signature, "NOT-AN-ADDRESS");
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe("bad_address");
    expect(verdict.reason).toMatch(/nothing was verified/i);
  });

  it("refuses a signature that is not 64 bytes, and says so in those words", () => {
    const short = Buffer.from(Buffer.from(signature, "base64").subarray(0, 32)).toString("base64");
    const verdict = verifyManifestSignature(body, short, account.addr.toString());
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.code).toBe("bad_signature");
    // The length is checked here rather than left to the ed25519 library, whose
    // own message ("bad signature size") says nothing about which side is wrong.
    expect(verdict.reason).toMatch(/64 bytes; this one is 32/);
  });

  it("takes hex as well as base64", () => {
    const hex = Buffer.from(signature, "base64").toString("hex");
    expect(verifyManifestSignature(body, hex, account.addr.toString()).ok).toBe(true);
  });

  it("signs the bytes as served, and canonicalises only an object", () => {
    expect(Buffer.from(manifestSigningBytes(body)).toString("utf8")).toBe(body);
    // Key order must not change the bytes, or one manifest has two signatures
    // and neither side can tell which is wrong.
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    const objectSig = Buffer.from(
      algosdk.signBytes(manifestSigningBytes({ b: 1, a: 2 }), account.sk)
    ).toString("base64");
    expect(verifyManifestSignature({ a: 2, b: 1 }, objectSig, account.addr.toString()).ok).toBe(true);
  });

  it("rejects a raw ed25519 signature over the same bytes", () => {
    // algosdk prefixes "MX" before signing, and that prefix is what stops a
    // signed manifest from ever being replayable as a signed transaction.
    // Accepting both schemes would double the surface a forger can aim at.
    const raw = algosdk.signBytes(Buffer.from(`SOMETHING-ELSE${body}`, "utf8"), account.sk);
    expect(verifyManifestSignature(body, raw, account.addr.toString()).ok).toBe(false);
  });
});

/* ── 6. the box decoders, against real bytes ────────────────────────────── */

describe("decoding what the registries actually store", () => {
  it("reads a job's status from byte 68, past the two dynamic offsets", () => {
    const job = decodeJob(new Uint8Array(Buffer.from(REAL_JOB_BOX, "hex")));
    expect(job).toMatchObject({
      jobId: 1,
      client: LIVE_PAY_TO,
      serverAgentId: 1,
      validatorAgentId: 2,
      budgetMicro: 1_000_000,
      // Read at 64 this is 92 — the spec_hash offset — which decodes as a
      // plausible status and makes every job look open.
      status: 3,
    });
    expect(new Date(job.updatedAt * 1000).toISOString()).toBe("2026-08-04T16:46:47.000Z");
  });

  it("reads an agent's address past the domain offset that sits in front of it", () => {
    const agent = decodeAgent(new Uint8Array(Buffer.from(REAL_AGENT_BOX, "hex")));
    expect(agent).toMatchObject({
      agentId: 1,
      address: LIVE_PAY_TO,
      domain: "ripar-agent.vercel.app",
    });
  });

  it("computes an ARC-4 selector with SHA-512/256, not SHA-256", () => {
    // The deployed IdentityRegistry's own selectors, checked against the
    // program on TestNet.
    expect(Buffer.from(methodSelector("new_agent(string)uint64")).toString("hex")).toBe("9cce6889");
    expect(Buffer.from(methodSelector("rotate_address(uint64,address)bool")).toString("hex")).toBe("ac76b795");
  });
});

/* ── 7. ripar test / bench / audit ──────────────────────────────────────── */

type AgentStubOptions = {
  cors?: boolean;
  exposeQuote?: boolean;
  quote?: boolean;
  asset?: string;
  health?: string | null;
  endpointStatus?: number;
  payTo?: string;
  agentId?: number | null;
  latencyMs?: number;
  /** The nth endpoint probe sleeps n × this, so latencies are distinguishable
   *  and a percentile computed over an unsorted list cannot pass by luck. */
  rampMs?: number;
  failEvery?: number;
};

/** A whole agent — manifest, card, endpoint, health — behind one fetch, so each
 *  command can be pointed at a deployment that is broken in exactly one way. */
function agentStub(opts: AgentStubOptions = {}) {
  const base = "https://agent.test";
  const requests: { url: string; init?: RequestInit }[] = [];
  let n = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = targetOf(url);
    requests.push({ url: u, init });
    const path = new URL(u).pathname;

    if (path === "/.well-known/ripar.json") {
      return Response.json({
        name: "Stub",
        handle: "stub",
        network: "testnet",
        payTo: opts.payTo ?? LIVE_PAY_TO,
        endpoints: [{ name: "work", url: `${base}/api/work`, method: "POST", price: "$0.01" }],
      });
    }
    if (path === "/.well-known/agent.json") {
      return Response.json({
        name: "Stub",
        capabilities: {
          extensions:
            opts.agentId === null
              ? []
              : [
                  {
                    uri: "https://ripar.io/a2a/ext/registry/v1",
                    params: { agentId: opts.agentId ?? 1, identityApp: 768_633_998 },
                  },
                ],
        },
      });
    }
    if (path.endsWith("/health")) {
      if (opts.health === null || (opts.health && path !== opts.health)) {
        return new Response("not found", { status: 404 });
      }
      return Response.json({ ok: true });
    }
    if (path === "/api/work") {
      n++;
      if (opts.latencyMs) await new Promise((r) => setTimeout(r, opts.latencyMs));
      // Descending, so a percentile taken off the arrival order rather than the
      // sorted one reads the wrong end.
      if (opts.rampMs) await new Promise((r) => setTimeout(r, (6 - Math.min(n, 5)) * opts.rampMs!));
      if (opts.failEvery && n % opts.failEvery === 0) throw new TypeError("fetch failed: ECONNRESET");
      if (opts.endpointStatus) return new Response("gone", { status: opts.endpointStatus });
      const headers = new Headers();
      if (opts.cors !== false) headers.set("access-control-allow-origin", "*");
      if (opts.cors !== false && opts.exposeQuote !== false) {
        headers.set("access-control-expose-headers", "payment-required, payment-response");
      }
      if (opts.quote !== false) {
        const q = quoted(0.01, opts.asset ?? "10458941");
        headers.set("payment-required", q.headers.get("payment-required")!);
      }
      return new Response("{}", { status: 402, headers });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { base, impl, requests };
}

describe("ripar test", () => {
  it("passes a healthy agent and reports every check", async () => {
    const stub = agentStub({ health: "/health" });
    const c = capture();
    expect(await cmdTest({ url: stub.base, fetchImpl: stub.impl }, c.io)).toBe(0);

    const out = c.stdout();
    expect(out).toContain("ok    manifest");
    expect(out).toContain("ok    402 /api/work");
    expect(out).toContain("ok    quote /api/work");
    expect(out).toContain("ok    challenge /api/work");
    expect(out).toContain("ok    cors /api/work");
    expect(out).toContain("ok    health");
    expect(out).toMatch(/All \d+ checks passed/);
  });

  it("probes with NO body, or an endpoint with an input schema answers 400", async () => {
    const stub = agentStub({ health: "/health" });
    await cmdTest({ url: stub.base, fetchImpl: stub.impl }, capture().io);
    const probe = stub.requests.find((r) => r.url.endsWith("/api/work"))!;
    expect(probe.init?.body).toBeUndefined();
    expect((probe.init?.headers as Record<string, string>)["content-type"]).toBeUndefined();
  });

  it("fails, and exits non-zero, when a browser cannot read the price", async () => {
    const stub = agentStub({ health: "/health", exposeQuote: false });
    const c = capture();
    expect(await cmdTest({ url: stub.base, fetchImpl: stub.impl }, c.io)).toBe(1);
    expect(c.stdout()).toContain("FAIL  cors /api/work");
    expect(c.stdout()).toContain("not in access-control-expose-headers");
  });

  it("finds a health route mounted under the same prefix as the endpoints", async () => {
    // serve({ basePath: "/api" }) puts health at /api/health, and checking only
    // /health reports a healthy agent as broken.
    const stub = agentStub({ health: "/api/health" });
    const c = capture();
    expect(await cmdTest({ url: stub.base, fetchImpl: stub.impl }, c.io)).toBe(0);
    expect(c.stdout()).toContain("/api/health");
  });

  it("says a 402 with no readable quote is not a quote", async () => {
    const stub = agentStub({ health: "/health", quote: false });
    const c = capture();
    expect(await cmdTest({ url: stub.base, fetchImpl: stub.impl }, c.io)).toBe(1);
    expect(c.stdout()).toContain("FAIL  quote /api/work");
    expect(c.stdout()).toContain("base64 JSON, not JSON");
  });

  it("emits the checks as JSON, with the same exit code", async () => {
    const stub = agentStub({ health: null });
    const c = capture();
    expect(await cmdTest({ url: stub.base, json: true, fetchImpl: stub.impl }, c.io)).toBe(1);
    const body = JSON.parse(c.stdout()) as { ok: boolean; failed: number; checks: { name: string }[] };
    expect(body.ok).toBe(false);
    expect(body.failed).toBe(1);
    expect(body.checks.map((c2) => c2.name)).toContain("health");
  });

  it("needs a URL", async () => {
    const c = capture();
    expect(await cmdTest({}, c.io)).toBe(1);
    expect(c.stderr()).toMatch(/needs a URL/);
  });
});

describe("ripar bench", () => {
  it("measures what happened and reports the quoted cost", async () => {
    // Five requests taking roughly 100, 80, 60, 40 and 20ms — descending, so
    // percentiles read off the arrival order land at the wrong end.
    const stub = agentStub({ rampMs: 20 });
    const c = capture();
    expect(await cmdBench({ url: `${stub.base}/api/work`, n: 5, json: true, fetchImpl: stub.impl }, c.io)).toBe(0);

    const stats = JSON.parse(c.stdout()) as Record<string, any>;
    expect(stats.measured).toBe(5);
    expect(stats.excluded).toBe(0);
    expect(stats.min).toBeLessThan(40);
    expect(stats.p50).toBeGreaterThanOrEqual(50);
    expect(stats.p50).toBeLessThan(80);
    expect(stats.p95).toBeGreaterThanOrEqual(95);
    expect(stats.max).toBeGreaterThanOrEqual(stats.p95);
    expect(stats.quotedUsd).toBeCloseTo(0.01, 6);
  });

  it("excludes a failed request instead of counting it as a slow one", async () => {
    // A timeout folded in as a latency is how a p95 comes to flatter an
    // endpoint that was simply down.
    const stub = agentStub({ failEvery: 2 });
    const c = capture();
    expect(await cmdBench({ url: `${stub.base}/api/work`, n: 4, fetchImpl: stub.impl }, c.io)).toBe(0);
    expect(c.stdout()).toContain("2 measured of 4 requested");
    expect(c.stdout()).toContain("excluded  2 request(s)");
    expect(c.stdout()).toContain("ECONNRESET");
  });

  it("reports nothing rather than zeroes when every request failed", async () => {
    const stub = agentStub({ failEvery: 1 });
    const c = capture();
    expect(await cmdBench({ url: `${stub.base}/api/work`, n: 3, fetchImpl: stub.impl }, c.io)).toBe(1);
    expect(c.stderr()).toMatch(/No request succeeded/);
  });

  it("says an endpoint that never quoted is excluded, not fast", async () => {
    const stub = agentStub({ endpointStatus: 500 });
    const c = capture();
    expect(await cmdBench({ url: `${stub.base}/api/work`, n: 2, json: true, fetchImpl: stub.impl }, c.io)).toBe(1);
    const stats = JSON.parse(c.stdout()) as Record<string, any>;
    expect(stats.measured).toBe(0);
    expect(stats.exclusions[0].reason).toContain("answered 500");
  });
});

/** A registry that answers from canned boxes. */
function readerStub(
  boxes: Record<string, string>,
  globals: Record<string, number> = {},
  program = "",
  /** Assets payTo is opted into. Defaults to the one these fixtures quote, so
   *  the opt-in check stays quiet in tests that are about something else. */
  optedIn: number[] | null = [10_458_941]
): ChainReader {
  return {
    box: async (appId, name) => {
      const key = `${appId}:${Buffer.from(name).toString("hex")}`;
      const hex = boxes[key];
      return hex ? new Uint8Array(Buffer.from(hex, "hex")) : null;
    },
    app: async () => ({ globals, approvalProgram: new Uint8Array(Buffer.from(program, "hex")) }),
    assets: async () => optedIn,
  };
}

function boxRef(appId: number, prefix: string, id: number | Uint8Array) {
  const raw = typeof id === "number" ? (() => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(id));
    return b;
  })() : Buffer.from(id);
  return `${appId}:${Buffer.concat([Buffer.from(prefix), raw]).toString("hex")}`;
}

const IDENTITY = 768_633_998;
const VALIDATION = 768_634_000;

describe("ripar audit", () => {
  const registered = readerStub({
    [boxRef(IDENTITY, "ad_", algosdk.decodeAddress(LIVE_PAY_TO).publicKey)]: "0000000000000001",
    [boxRef(IDENTITY, "ag_", 1)]: REAL_AGENT_BOX,
  });

  it("finds nothing wrong with a correctly deployed agent", async () => {
    const stub = agentStub({ health: "/health" });
    const c = capture();
    expect(await cmdAudit({ url: stub.base, fetchImpl: stub.impl, reader: registered }, c.io)).toBe(0);
    expect(c.stdout()).toContain("No findings");
    expect(c.stdout()).toContain("payTo is agent 1");
    expect(c.stdout()).toContain('domain "ripar-agent.vercel.app"');
  });

  /** The same registered agent, but payTo holds something other than what it
   *  quotes — which is the shape api.ripar.io actually shipped. */
  const boxes = {
    [boxRef(IDENTITY, "ad_", algosdk.decodeAddress(LIVE_PAY_TO).publicKey)]: "0000000000000001",
    [boxRef(IDENTITY, "ag_", 1)]: REAL_AGENT_BOX,
  };

  it("reports a payTo that cannot receive the asset it quotes", async () => {
    // Quotes 10458941 (TestNet USDC); opted into 31566704 (MAINNET USDC) only.
    // That is the realistic shape of this mistake — the same token on the wrong
    // network, so every name and symbol matches and only the id does not. An
    // ASA transfer to a non-opted-in account is rejected at consensus, so the
    // caller signs a payment the network then refuses.
    const wrongAsset = readerStub(boxes, {}, "", [31_566_704]);
    const stub = agentStub({ health: "/health" });
    const c = capture();
    expect(await cmdAudit({ url: stub.base, json: true, fetchImpl: stub.impl, reader: wrongAsset }, c.io)).toBe(1);
    const body = JSON.parse(c.stdout()) as { findings: { code: string; title: string; why: string }[] };
    const finding = body.findings.find((f) => f.code === "payto_not_optedin")!;
    expect(finding, "the opt-in mismatch was not reported").toBeTruthy();
    expect(finding.title).toContain("10458941");
    expect(finding.why).toMatch(/rejected at consensus|fails at consensus/i);
  });

  it("says so when payTo is opted into what it quotes", async () => {
    const stub = agentStub({ health: "/health" });
    const c = capture();
    expect(await cmdAudit({ url: stub.base, fetchImpl: stub.impl, reader: registered }, c.io)).toBe(0);
    expect(c.stdout()).toContain("opted into asset 10458941");
  });

  it("reports a payTo the network has never seen", async () => {
    const missing = readerStub(boxes, {}, "", null);
    const stub = agentStub({ health: "/health" });
    const c = capture();
    expect(await cmdAudit({ url: stub.base, json: true, fetchImpl: stub.impl, reader: missing }, c.io)).toBe(1);
    const body = JSON.parse(c.stdout()) as { findings: { code: string }[] };
    expect(body.findings.some((f) => f.code === "payto_nonexistent")).toBe(true);
  });

  it("reports missing CORS, and says what it costs", async () => {
    const stub = agentStub({ cors: false });
    const c = capture();
    expect(await cmdAudit({ url: stub.base, fetchImpl: stub.impl, reader: registered }, c.io)).toBe(1);
    expect(c.stdout()).toContain("sends no access-control-allow-origin");
    expect(c.stdout()).toMatch(/why.*browser dashboard/is);
  });

  it("reports a quote the header does not carry", async () => {
    const stub = agentStub({ quote: false });
    const c = capture();
    expect(await cmdAudit({ url: stub.base, json: true, fetchImpl: stub.impl, reader: registered }, c.io)).toBe(1);
    const body = JSON.parse(c.stdout()) as { findings: { code: string; why: string }[] };
    const finding = body.findings.find((f) => f.code === "quote_unreadable")!;
    expect(finding.why).toMatch(/no cap can check/i);
  });

  it("reports an amount in an asset nobody can convert", async () => {
    const stub = agentStub({ asset: "999999999" });
    const c = capture();
    await cmdAudit({ url: stub.base, json: true, fetchImpl: stub.impl, reader: registered }, c.io);
    const body = JSON.parse(c.stdout()) as { findings: { code: string; why: string }[] };
    expect(body.findings.map((f) => f.code)).toContain("quote_unpriceable");
    expect(body.findings.find((f) => f.code === "quote_unpriceable")!.why).toMatch(/millionfold/i);
  });

  it("reports an endpoint the manifest advertises and the server does not route", async () => {
    const stub = agentStub({ endpointStatus: 404 });
    const c = capture();
    expect(await cmdAudit({ url: stub.base, json: true, fetchImpl: stub.impl, reader: registered }, c.io)).toBe(1);
    const body = JSON.parse(c.stdout()) as { findings: { code: string; why: string }[] };
    expect(body.findings.map((f) => f.code)).toEqual(["endpoint_missing"]);
    expect(body.findings[0].why).toMatch(/hands this URL to strangers/i);
  });

  it("reports a payTo the registry has never seen", async () => {
    const stub = agentStub({ payTo: PAYER });
    const c = capture();
    expect(await cmdAudit({ url: stub.base, json: true, fetchImpl: stub.impl, reader: registered }, c.io)).toBe(1);
    const body = JSON.parse(c.stdout()) as { findings: { code: string; why: string }[] };
    const finding = body.findings.find((f) => f.code === "payto_unregistered")!;
    expect(finding.why).toMatch(/file on a web server/i);
  });

  it("reports an agentId that resolves to nothing", async () => {
    const stub = agentStub({ agentId: 77 });
    const c = capture();
    expect(await cmdAudit({ url: stub.base, json: true, fetchImpl: stub.impl, reader: registered }, c.io)).toBe(1);
    const body = JSON.parse(c.stdout()) as { findings: { code: string }[] };
    expect(body.findings.map((f) => f.code)).toContain("agentid_unresolvable");
  });

  it("reports an agentId that resolves to a different address than payTo", async () => {
    // What a repointed identity looks like: the reputation belongs to one
    // account and the money goes to another.
    const stub = agentStub({ payTo: PAY_TO });
    const reader = readerStub({
      [boxRef(IDENTITY, "ad_", algosdk.decodeAddress(PAY_TO).publicKey)]: "0000000000000005",
      [boxRef(IDENTITY, "ag_", 1)]: REAL_AGENT_BOX,
    });
    const c = capture();
    expect(await cmdAudit({ url: stub.base, json: true, fetchImpl: stub.impl, reader }, c.io)).toBe(1);
    const body = JSON.parse(c.stdout()) as { findings: { code: string }[] };
    expect(body.findings.map((f) => f.code)).toContain("agentid_wrong_address");
  });

  it("gives up honestly when there is no manifest to audit against", async () => {
    const impl = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    const c = capture();
    expect(await cmdAudit({ url: "https://nothing.test", fetchImpl: impl, reader: registered }, c.io)).toBe(1);
    expect(c.stderr()).toMatch(/nothing to audit/i);
  });
});

/* ── 8. ripar escrow ────────────────────────────────────────────────────── */

/** A job box in the layout the contract writes, so a test can pose a state the
 *  live chain does not currently hold. */
function jobBox(v: {
  jobId: number;
  client: string;
  serverAgentId?: number;
  validatorAgentId?: number;
  budgetMicro?: number;
  status: number;
  updatedAt?: number;
}) {
  const head = Buffer.alloc(92);
  head.writeBigUInt64BE(BigInt(v.jobId), 0);
  Buffer.from(algosdk.decodeAddress(v.client).publicKey).copy(head, 8);
  head.writeBigUInt64BE(BigInt(v.serverAgentId ?? 0), 40);
  head.writeBigUInt64BE(BigInt(v.validatorAgentId ?? 0), 48);
  head.writeBigUInt64BE(BigInt(v.budgetMicro ?? 1_000_000), 56);
  head.writeUInt16BE(92, 64);
  head.writeUInt16BE(126, 66);
  head.writeBigUInt64BE(BigInt(v.status), 68);
  head.writeBigUInt64BE(BigInt(v.updatedAt ?? 1_785_862_007), 76);
  head.writeBigUInt64BE(BigInt(v.updatedAt ?? 1_785_862_007), 84);
  return Buffer.concat([head, Buffer.alloc(34), Buffer.alloc(34)]).toString("hex");
}

function escrowBox(micro: number) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(micro));
  return b.toString("hex");
}

describe("ripar escrow", () => {
  const globals = { dispute_window: 20, job_count: 2 };

  it("names the method, who may send it, and when — for a funded validated job", async () => {
    const reader = readerStub(
      {
        [boxRef(VALIDATION, "jb_", 1)]: jobBox({ jobId: 1, client: LIVE_PAY_TO, serverAgentId: 1, validatorAgentId: 2, status: 3 }),
        [boxRef(VALIDATION, "es_", 1)]: escrowBox(1_000_000),
        [boxRef(IDENTITY, "ag_", 1)]: REAL_AGENT_BOX,
      },
      globals
    );
    const c = capture();
    // A moment before the dispute window closes.
    expect(await cmdEscrow({ jobId: 1, reader, now: 1_785_862_010_000 }, c.io)).toBe(0);

    const out = c.stdout();
    expect(out).toContain("job 1  validated");
    expect(out).toContain("escrow     1.000000  FUNDED");
    expect(out).toContain("release_escrow");
    expect(out).toContain("the client (KBDRZK3B");
    expect(out).toContain("ANYONE after the dispute window");
    expect(out).toContain("not before 2026-08-04T16:47:07.000Z");
    // A partial release is the client's alone: the after-the-window path exists
    // so the worker can rescue their money, not so a stranger can dribble it out.
    expect(out).toMatch(/release_partial\n\s+who\s+the client only, KBDRZK3B/);
  });

  it("says the window is open once it has passed", async () => {
    const reader = readerStub(
      {
        [boxRef(VALIDATION, "jb_", 1)]: jobBox({ jobId: 1, client: LIVE_PAY_TO, serverAgentId: 1, status: 3 }),
        [boxRef(VALIDATION, "es_", 1)]: escrowBox(500_000),
      },
      globals
    );
    const c = capture();
    await cmdEscrow({ jobId: 1, reader, now: 1_785_999_999_000 }, c.io);
    expect(c.stdout()).toMatch(/window closed at .*so this is open now/);
  });

  it("says plainly that an unfunded job has nothing to release", async () => {
    // The real state of job 1 on TestNet: validated, escrow already paid out.
    const reader = readerStub(
      { [boxRef(VALIDATION, "jb_", 1)]: REAL_JOB_BOX, [boxRef(IDENTITY, "ag_", 1)]: REAL_AGENT_BOX },
      globals
    );
    const c = capture();
    expect(await cmdEscrow({ jobId: 1, reader, now: 1_785_999_999_000 }, c.io)).toBe(0);
    expect(c.stdout()).toContain("unfunded");
    expect(c.stdout()).toMatch(/would fail its own assert/);
    expect(c.stdout()).toMatch(/stated intention/);
  });

  it("names the validator on a submitted job, and the client when there is none", async () => {
    const withValidator = readerStub(
      {
        [boxRef(VALIDATION, "jb_", 1)]: jobBox({ jobId: 1, client: PAYER, serverAgentId: 1, validatorAgentId: 1, status: 2 }),
        [boxRef(IDENTITY, "ag_", 1)]: REAL_AGENT_BOX,
      },
      globals
    );
    const a = capture();
    await cmdEscrow({ jobId: 1, reader: withValidator, json: true }, a.io);
    const first = JSON.parse(a.stdout()) as { next: { method: string; who: string }[] };
    expect(first.next[0].method).toBe("validation_response");
    expect(first.next[0].who).toContain(LIVE_PAY_TO);

    const without = readerStub(
      { [boxRef(VALIDATION, "jb_", 2)]: jobBox({ jobId: 2, client: PAYER, serverAgentId: 1, status: 2 }) },
      globals
    );
    const b = capture();
    await cmdEscrow({ jobId: 2, reader: without }, b.io);
    expect(b.stdout()).toMatch(/no validator was named/);
  });

  it("offers expire_job on an assignment nobody delivered", async () => {
    const reader = readerStub(
      { [boxRef(VALIDATION, "jb_", 3)]: jobBox({ jobId: 3, client: PAYER, serverAgentId: 1, status: 1 }) },
      globals
    );
    const c = capture();
    await cmdEscrow({ jobId: 3, reader, now: 1_785_999_999_000 }, c.io);
    expect(c.stdout()).toContain("submit_result");
    expect(c.stdout()).toContain("expire_job");
  });

  it("says who a refund pays on a disputed job — the client, not the caller", async () => {
    const reader = readerStub(
      {
        [boxRef(VALIDATION, "jb_", 4)]: jobBox({ jobId: 4, client: PAYER, serverAgentId: 1, status: 4 }),
        [boxRef(VALIDATION, "es_", 4)]: escrowBox(250_000),
      },
      globals
    );
    const c = capture();
    await cmdEscrow({ jobId: 4, reader }, c.io);
    expect(c.stdout()).toContain("refund_escrow");
    expect(c.stdout()).toContain("cannot redirect one");
  });

  it("reports a job that was never posted", async () => {
    const c = capture();
    expect(await cmdEscrow({ jobId: 99, reader: readerStub({}, globals) }, c.io)).toBe(1);
    expect(c.stderr()).toMatch(/No job 99/);
  });

  it("needs a job id", async () => {
    const c = capture();
    expect(await cmdEscrow({ reader: readerStub({}, globals) }, c.io)).toBe(1);
    expect(c.stderr()).toMatch(/needs a job id/);
  });
});

/* ── 9. ripar rotate ────────────────────────────────────────────────────── */

describe("ripar rotate", () => {
  const NEW_ADDRESS = PAYER;
  const withoutMethod = () =>
    readerStub(
      { [boxRef(IDENTITY, "ag_", 1)]: REAL_AGENT_BOX },
      {},
      // The deployed program, minus the selector: what TestNet actually runs.
      "deadbeef"
    );
  const withMethod = () =>
    readerStub(
      { [boxRef(IDENTITY, "ag_", 1)]: REAL_AGENT_BOX },
      {},
      `dead${Buffer.from(methodSelector("rotate_address(uint64,address)bool")).toString("hex")}beef`
    );

  it("dry-runs against a registry that does not have the method, and signs nothing", async () => {
    const c = capture();
    expect(
      await cmdRotate({ agentId: 1, newAddress: NEW_ADDRESS, dryRun: true, reader: withoutMethod() }, c.io)
    ).toBe(0);

    const out = c.stdout();
    expect(out).toContain("would rotate agent 1");
    expect(out).toContain(`from       ${LIVE_PAY_TO}`);
    expect(out).toContain(`to         ${NEW_ADDRESS}`);
    expect(out).toContain("signed by  KBDRZK3B");
    expect(out).toContain("does NOT contain this method's selector");
    expect(out).toContain("Nothing was signed and nothing was sent.");
    expect(c.stderr()).toBe("");
  });

  it("refuses a real run with a sentence, not an opaque assert", async () => {
    const c = capture();
    expect(await cmdRotate({ agentId: 1, newAddress: NEW_ADDRESS, reader: withoutMethod() }, c.io)).toBe(1);
    expect(c.stderr()).toContain("rotate_address is not on the deployed registry yet");
    expect(c.stderr()).toContain("ac76b795");
    expect(c.stderr()).toContain("--dry-run");
    // The workaround, and its cost: a new id leaves the old id's history behind.
    expect(c.stderr()).toContain("mints a new id");
  });

  it("says the method IS there when the program carries its selector", async () => {
    const c = capture();
    expect(
      await cmdRotate({ agentId: 1, newAddress: NEW_ADDRESS, dryRun: true, json: true, reader: withMethod() }, c.io)
    ).toBe(0);
    const plan = JSON.parse(c.stdout()) as Record<string, any>;
    expect(plan).toMatchObject({
      dryRun: true,
      deployed: true,
      agentId: 1,
      from: LIVE_PAY_TO,
      to: NEW_ADDRESS,
      mustBeSignedBy: LIVE_PAY_TO,
      selector: "0xac76b795",
    });
  });

  it("refuses an address with a bad checksum before anything else", async () => {
    const c = capture();
    expect(await cmdRotate({ agentId: 1, newAddress: `${PAYER.slice(0, 57)}A`, reader: withoutMethod() }, c.io)).toBe(1);
    expect(c.stderr()).toMatch(/not an Algorand address/);
    expect(c.stderr()).toMatch(/a key nobody holds/);
  });

  it("refuses a rotation the contract would refuse anyway", async () => {
    const same = capture();
    expect(await cmdRotate({ agentId: 1, newAddress: LIVE_PAY_TO, reader: withoutMethod() }, same.io)).toBe(1);
    expect(same.stderr()).toMatch(/already the controlling address/);

    const taken = readerStub({
      [boxRef(IDENTITY, "ag_", 1)]: REAL_AGENT_BOX,
      [boxRef(IDENTITY, "ad_", algosdk.decodeAddress(PAYER).publicKey)]: "0000000000000002",
    });
    const c = capture();
    expect(await cmdRotate({ agentId: 1, newAddress: PAYER, reader: taken }, c.io)).toBe(1);
    expect(c.stderr()).toMatch(/already controls agent 2/);
  });

  it("refuses an agent that does not exist", async () => {
    const c = capture();
    expect(await cmdRotate({ agentId: 42, newAddress: PAYER, reader: readerStub({}) }, c.io)).toBe(1);
    expect(c.stderr()).toMatch(/Agent 42 does not exist/);
  });

  it("refuses a key that is not the current controlling address", async () => {
    const c = capture();
    const code = await cmdRotate(
      {
        agentId: 1,
        newAddress: PAYER,
        reader: withMethod(),
        mnemonic: algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk),
      },
      c.io
    );
    expect(code).toBe(1);
    expect(c.stderr()).toMatch(/Only the current address may rotate/i);
  });
});

/* ── 10. the dispatch ───────────────────────────────────────────────────── */

describe("the new commands are reachable", () => {
  it.each(["test", "bench", "audit", "escrow", "rotate"])(
    "gives %s a COMMAND_HELP entry with a usage line and --json",
    async (command) => {
      const c = capture();
      // Without an entry the dispatch answers "Unknown command" before the
      // switch is ever reached.
      expect(await run([command, "--help"], c.cliIo())).toBe(0);
      expect(c.stdout()).toContain(`Usage: ripar ${command}`);
      expect(c.stdout()).toContain("--json");
      expect(c.stderr()).toBe("");
    }
  );

  it("routes `ripar test` through the dispatch with the injected fetch", async () => {
    const stub = agentStub({ health: "/health" });
    const c = capture();
    expect(await run(["test", stub.base, "--json"], c.cliIo(stub.impl))).toBe(0);
    expect(JSON.parse(c.stdout()).ok).toBe(true);
  });

  it("routes `ripar bench --n`", async () => {
    const stub = agentStub();
    const c = capture();
    expect(await run(["bench", `${stub.base}/api/work`, "--n", "3", "--json"], c.cliIo(stub.impl))).toBe(0);
    expect(JSON.parse(c.stdout()).measured).toBe(3);
  });

  it("lists the new commands in the top-level help", async () => {
    const c = capture();
    await run(["--help"], c.cliIo());
    for (const command of ["test", "bench", "audit", "escrow", "rotate"]) {
      expect(c.stdout()).toContain(command);
    }
  });
});

/* ── 11. idempotency against a real server ──────────────────────────────── */

describe("a retry after a dropped connection", () => {
  let base: string;
  let close: () => Promise<void>;
  let facilitator: { url: string; close: () => Promise<void>; settles: number };
  let mnemonic: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    const state = { settles: 0 };
    app.get("/supported", (_req, res) => {
      res.json({ kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }] });
    });
    app.post("/verify", (_req, res) => res.json({ isValid: true, payer: PAYER }));
    app.post("/settle", (req, res) => {
      state.settles++;
      res.json({
        success: true,
        transaction: "XS5KJ7OV2IS47322EZ3AFX5ZPG3RQTIYUFSSQ2KPMNMFZVI6K4NA",
        network: NETWORK,
        payer: PAYER,
        amount: req.body?.paymentRequirements?.amount,
      });
    });
    const facServer: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    facilitator = {
      url: `http://127.0.0.1:${(facServer.address() as { port: number }).port}`,
      close: () => new Promise<void>((r) => facServer.close(() => r())),
      get settles() {
        return state.settles;
      },
    } as typeof facilitator;

    mnemonic = algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk);
    let ran = 0;
    const agent = defineAgent({
      name: "Idempotent",
      handle: "idempotent",
      description: "Charges once for one piece of work.",
      payTo: PAY_TO,
      network: "testnet",
      endpoints: [
        defineEndpoint({
          name: "work",
          price: "$0.02",
          handler: () => ({ ran: ++ran }),
        }),
      ],
    });
    const server = await createServer(agent, {
      network: "testnet",
      payTo: PAY_TO,
      facilitatorUrl: facilitator.url,
      // The store the client's key is answered from. Without it, the header is
      // ignored and the retry pays again.
      idempotency: {},
    });
    const httpServer: Server = await new Promise((resolve) => {
      const s = server.listen(0, () => resolve(s));
    });
    base = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
    close = () => new Promise<void>((r) => httpServer.close(() => r()));
  });

  afterAll(async () => {
    await close();
    await facilitator.close();
  });

  it("replays the answer it already paid for instead of settling twice", async () => {
    const settlesBefore = facilitator.settles;
    let dropped = 0;

    // The failure this exists for: the server ran the handler and settled, and
    // the answer never reached the caller. Everything the caller can see says
    // the call failed.
    const flaky = (async (url: string | URL | Request, init?: RequestInit) => {
      const res = await globalThis.fetch(url as string, init);
      if (res.status === 200 && dropped === 0) {
        dropped++;
        throw new TypeError("socket hang up");
      }
      return res;
    }) as unknown as typeof fetch;

    const client = new RiparClient({
      mnemonic,
      network: "testnet",
      retry: { attempts: 2, baseMs: 1 },
      fetchImpl: flaky,
    });

    const res = await client.call<{ ran: number }>(`${base}/work`, { job: "a" });

    expect(res.status).toBe(200);
    expect(res.attempts).toBe(2);
    expect(res.replayed).toBe(true);
    // One settlement for one piece of work, and the handler ran once — the
    // second attempt was answered in front of the payment middleware.
    expect(facilitator.settles).toBe(settlesBefore + 1);
    expect(res.data.ran).toBe(1);
  });

  it("charges a genuinely new call, and marks it as not replayed", async () => {
    const settlesBefore = facilitator.settles;
    const client = new RiparClient({ mnemonic, network: "testnet" });
    const res = await client.call(`${base}/work`, { job: "b" });
    expect(res.replayed).toBeUndefined();
    expect(facilitator.settles).toBe(settlesBefore + 1);
  });
});
