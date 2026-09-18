/**
 * The opt-in payee check: the refusal rule, the cache, and the order of events
 * inside `call()`.
 *
 * The order is the part worth defending hardest. A check that runs AFTER the
 * signature is a receipt for a mistake, not a guard against one — so every
 * client test here asserts on which requests carried a payment header, not on
 * what `call()` returned.
 *
 * Nothing here spends. The transport is a stub that answers 402s itself, the
 * signer is a throwaway account generated per run, and algod's suggested-params
 * route is answered locally, because building the transfer is the only thing
 * the signing path needs a node for and the test is not about the node.
 */
import algosdk from "algosdk";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RiparClient } from "../src/client.js";
import { run, type CliIO } from "../src/cli.js";
import {
  DEFAULT_PAYEE_CHECK_URL,
  PayeeCache,
  isPayeeCheckUrl,
  judgePayee,
  networkOfAccept,
  parsePayeeCheck,
  resolveCheckPayee,
  type PayeeCheckResult,
} from "../src/payee.js";
import { RiparError } from "../src/types.js";

const SELLER = "PBXELTAXFHNNP3ZQFBC36WKUGVX732UG4CQQH22CP6NNIY5FFIY5UINYAU";
const SWAPPED = "B2DGXU2QSRHXNZJMP5FFFU77W5NUMZTZ3X3MSO3PJC4ZQ75CSDL5EKULI4";
const RIPAR = "3QAJXJVG2Z4IPEKC53SYVHL7P5ILE3CT2T3BW6VPJ5WCOY7M7QDJHELWNY";
/** The FULL genesis hash, as a real facilitator quotes it. */
const TESTNET = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
const ENDPOINT = "https://seller.test/api/work";
const CHECK = "https://check.test/api/payee-check";

const mnemonic = algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk);

function verdict(over: Partial<PayeeCheckResult> = {}): PayeeCheckResult {
  return {
    address: SELLER,
    network: "testnet",
    checkedAt: "2026-09-18T00:00:00.000Z",
    exists: true,
    canReceiveUsdc: true,
    usdcBalance: "1.5",
    received: { transfers: 12, x402: 9 },
    bazaar: { resources: 1, urls: [ENDPOINT] },
    ripar: null,
    facts: ["Account exists.", "Opted in to USDC.", "Paid 9 times over x402."],
    ...over,
  };
}

/* ── the transport ──────────────────────────────────────────────────────── */

function challenge(payTo: string) {
  const body = {
    x402Version: 2,
    error: "Payment required",
    accepts: [
      { scheme: "exact", network: TESTNET, amount: "10000", asset: "10458941", payTo, maxTimeoutSeconds: 60, extra: {} },
    ],
  };
  return new Response("{}", {
    status: 402,
    headers: {
      "content-type": "application/json",
      "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(body)).toString("base64"),
    },
  });
}

type Seen = { url: string; paid: boolean; body: string };

/**
 * A seller and a payee-check service, both x402. `sellerPayTo` answers the Nth
 * UNPAID request to the seller, so a test can make the quote and the second 402
 * disagree about who gets paid.
 */
function world(opts: { check?: () => Response; sellerPayTo?: (n: number) => string } = {}) {
  const seen: Seen[] = [];
  let sellerUnpaid = 0;
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const paid = req.headers.has("PAYMENT-SIGNATURE") || req.headers.has("X-PAYMENT");
    const body = await req.clone().text();
    seen.push({ url: req.url, paid, body });
    const isCheck = req.url.startsWith(CHECK);
    if (!paid) return challenge(isCheck ? RIPAR : (opts.sellerPayTo?.(sellerUnpaid++) ?? SELLER));
    if (isCheck) return opts.check?.() ?? Response.json(verdict());
    return Response.json({ ok: true });
  }) as unknown as typeof fetch;
  return {
    impl,
    seen,
    paidTo: (prefix: string) => seen.filter((s) => s.paid && s.url.startsWith(prefix)).length,
    requestsTo: (prefix: string) => seen.filter((s) => s.url.startsWith(prefix)).length,
  };
}

// Building the transfer asks algod for suggested params. Answered here so the
// suite neither needs a network nor depends on AlgoNode being up.
const realFetch = globalThis.fetch;
beforeAll(() => {
  vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/v2/transactions/params")) {
      return Response.json({
        "consensus-version": "https://github.com/algorandfoundation/specs/tree/future",
        fee: 0,
        "genesis-hash": "SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
        "genesis-id": "testnet-v1.0",
        "last-round": 1000,
        "min-fee": 1000,
      });
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch);
});
afterAll(() => {
  vi.unstubAllGlobals();
});

const temps: string[] = [];
async function cacheFile() {
  const dir = await mkdtemp(join(tmpdir(), "ripar-payee-"));
  temps.push(dir);
  return join(dir, "nested", "payee-cache.json");
}
afterEach(async () => {
  while (temps.length) await rm(temps.pop()!, { recursive: true, force: true });
});

function client(impl: typeof fetch, checkPayee: ConstructorParameters<typeof RiparClient>[0]["checkPayee"]) {
  return new RiparClient({ mnemonic, network: "testnet", retry: false, fetchImpl: impl, checkPayee });
}

async function refusal(p: Promise<unknown>): Promise<RiparError> {
  const err = await p.then(
    () => null,
    (e) => e
  );
  expect(err).toBeInstanceOf(RiparError);
  return err as RiparError;
}

/* ── the decision ───────────────────────────────────────────────────────── */

describe("judgePayee", () => {
  it("passes an account that exists and can receive USDC", () => {
    expect(judgePayee(verdict())).toEqual({ ok: true });
  });

  it("refuses an account that does not exist", () => {
    const j = judgePayee(verdict({ exists: false, canReceiveUsdc: false }));
    expect(j.ok).toBe(false);
    expect(!j.ok && j.reason).toMatch(/does not exist/);
  });

  it("refuses an account that cannot receive USDC", () => {
    const j = judgePayee(verdict({ canReceiveUsdc: false }));
    expect(!j.ok && j.reason).toMatch(/cannot receive USDC/);
  });

  it("only cares about the Bazaar when requireListed is set", () => {
    const unlisted = verdict({ bazaar: null });
    expect(judgePayee(unlisted).ok).toBe(true);
    expect(judgePayee(unlisted, { requireListed: true }).ok).toBe(false);
    expect(judgePayee(verdict({ bazaar: { resources: 0, urls: [] } }), { requireListed: true }).ok).toBe(false);
    expect(judgePayee(verdict(), { requireListed: true }).ok).toBe(true);
  });

  it("does not turn a thin history into a refusal — that is the caller's call", () => {
    expect(judgePayee(verdict({ received: { transfers: 0, x402: 0 }, facts: ["Never paid."] })).ok).toBe(true);
  });
});

describe("parsePayeeCheck", () => {
  it("refuses an answer with no booleans rather than reading it as a pass", () => {
    expect(() => parsePayeeCheck({ address: SELLER })).toThrow(/not with a verdict/);
    expect(() => parsePayeeCheck({ exists: "true", canReceiveUsdc: true })).toThrow();
    expect(() => parsePayeeCheck("<html>")).toThrow();
    expect(() => parsePayeeCheck(null)).toThrow();
  });

  it("defaults missing facts to an empty list", () => {
    expect(parsePayeeCheck({ address: SELLER, exists: true, canReceiveUsdc: true }).facts).toEqual([]);
  });
});

describe("resolveCheckPayee", () => {
  it("is off unless asked for", () => {
    expect(resolveCheckPayee(undefined, {})).toBeNull();
    expect(resolveCheckPayee(false, {})).toBeNull();
  });

  it("defaults to api.ripar.io, abort-on-error, and a 24h cache", () => {
    const r = resolveCheckPayee(true, {})!;
    expect(r.url).toBe(DEFAULT_PAYEE_CHECK_URL);
    expect(r.url).toBe("https://api.ripar.io/api/payee-check");
    expect(r.onCheckError).toBe("abort");
    expect(r.requireListed).toBe(false);
    expect(r.ttlMs).toBe(24 * 60 * 60 * 1000);
    expect(r.cachePath).toMatch(/\.ripar[/\\]payee-cache\.json$/);
  });

  it("takes the URL and cache path from the environment, and an option over both", () => {
    const env = { RIPAR_PAYEE_CHECK_URL: CHECK, RIPAR_PAYEE_CACHE: "/x/cache.json" };
    expect(resolveCheckPayee(true, env)!.url).toBe(CHECK);
    expect(resolveCheckPayee(true, env)!.cachePath).toBe("/x/cache.json");
    expect(resolveCheckPayee({ url: "https://o.test/c" }, env)!.url).toBe("https://o.test/c");
    expect(resolveCheckPayee({ cachePath: false }, env)!.cachePath).toBeNull();
  });
});

describe("helpers", () => {
  it("recognises the check endpoint however the URL is dressed", () => {
    expect(isPayeeCheckUrl(`${CHECK}/`, CHECK)).toBe(true);
    expect(isPayeeCheckUrl(`${CHECK}?x=1`, CHECK)).toBe(true);
    expect(isPayeeCheckUrl(ENDPOINT, CHECK)).toBe(false);
  });

  it("checks the payee on the chain the accept pays on", () => {
    expect(networkOfAccept(TESTNET, "mainnet")).toBe("testnet");
    expect(networkOfAccept("algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=", "testnet")).toBe("mainnet");
    expect(networkOfAccept("eip155:8453", "testnet")).toBe("testnet");
  });
});

/* ── the cache ──────────────────────────────────────────────────────────── */

describe("PayeeCache", () => {
  it("survives a new instance, and keys by network AND address", async () => {
    const path = await cacheFile();
    new PayeeCache(path).set("testnet", SELLER, verdict(), 1_000);
    const again = new PayeeCache(path);
    expect(again.get("testnet", SELLER, 2_000)?.result.address).toBe(SELLER);
    expect(again.get("mainnet", SELLER, 2_000)).toBeUndefined();
  });

  it("expires on read after the TTL", async () => {
    const cache = new PayeeCache(await cacheFile(), 100);
    cache.set("testnet", SELLER, verdict(), 1_000);
    expect(cache.get("testnet", SELLER, 1_099)).toBeDefined();
    expect(cache.get("testnet", SELLER, 1_100)).toBeUndefined();
  });

  it("treats a corrupt file as empty, and overwrites it on the next write", async () => {
    const path = await cacheFile();
    await new PayeeCache(path).set("testnet", SWAPPED, verdict(), 1);
    await writeFile(path, "{not json");
    const cache = new PayeeCache(path);
    expect(cache.get("testnet", SWAPPED, 2)).toBeUndefined();
    cache.set("testnet", SELLER, verdict(), 2);
    expect(JSON.parse(await readFile(path, "utf8"))[`testnet:${SELLER}`]).toBeTruthy();
  });

  it("keeps working in memory when the path cannot be written", async () => {
    const blocker = await cacheFile();
    await new PayeeCache(blocker).set("testnet", SELLER, verdict(), 1);
    // A path UNDER a regular file can never be created.
    const cache = new PayeeCache(join(blocker, "sub", "cache.json"));
    expect(() => cache.set("testnet", SELLER, verdict(), 5)).not.toThrow();
    expect(cache.get("testnet", SELLER, 6)).toBeDefined();
  });
});

/* ── the order of events inside call() ─────────────────────────────────── */

describe("RiparClient checkPayee", () => {
  it("does nothing, and costs nothing, when it is off", async () => {
    const w = world();
    const out = await client(w.impl, undefined).call(ENDPOINT, { q: 1 });
    expect(out.data).toEqual({ ok: true });
    expect(out.payee).toBeUndefined();
    expect(w.requestsTo(CHECK)).toBe(0);
    expect(w.paidTo(ENDPOINT)).toBe(1);
  });

  it("pays for a check of the quoted payTo BEFORE paying the endpoint, then reuses it", async () => {
    const w = world();
    const cachePath = await cacheFile();
    const out = await client(w.impl, { url: CHECK, cachePath }).call(ENDPOINT, { q: 1 });

    expect(out.data).toEqual({ ok: true });
    expect(out.payee).toMatchObject({ address: SELLER, network: "testnet", ok: true, source: "check" });
    expect(out.payee!.facts).toContain("Opted in to USDC.");
    // The check was paid, with the payee in the body, and it happened first.
    const firstPaidCheck = w.seen.findIndex((s) => s.paid && s.url === CHECK);
    const firstPaidWork = w.seen.findIndex((s) => s.paid && s.url === ENDPOINT);
    expect(firstPaidCheck).toBeGreaterThanOrEqual(0);
    expect(firstPaidCheck).toBeLessThan(firstPaidWork);
    expect(JSON.parse(w.seen[firstPaidCheck].body)).toEqual({ address: SELLER, network: "testnet" });

    // A second process, same cache file: no second $0.01.
    const w2 = world();
    const again = await client(w2.impl, { url: CHECK, cachePath }).call(ENDPOINT, { q: 2 });
    expect(again.payee!.source).toBe("cache");
    expect(w2.requestsTo(CHECK)).toBe(0);
    expect(w2.paidTo(ENDPOINT)).toBe(1);
  });

  it("refuses a payee that does not exist, with the facts, and never pays the endpoint", async () => {
    const w = world({
      check: () => Response.json(verdict({ exists: false, canReceiveUsdc: false, facts: ["No such account."] })),
    });
    const err = await refusal(client(w.impl, { url: CHECK, cachePath: await cacheFile() }).call(ENDPOINT, {}));
    expect(err.code).toBe("payee_refused");
    expect(err.message).toMatch(/does not exist/);
    expect(err.message).toContain("No such account.");
    expect(w.paidTo(ENDPOINT)).toBe(0);
  });

  it("refuses a payee that cannot receive USDC", async () => {
    const w = world({ check: () => Response.json(verdict({ canReceiveUsdc: false })) });
    const err = await refusal(client(w.impl, { url: CHECK, cachePath: await cacheFile() }).call(ENDPOINT, {}));
    expect(err.code).toBe("payee_refused");
    expect(w.paidTo(ENDPOINT)).toBe(0);
  });

  it("re-judges a cached answer under the caller's own requireListed", async () => {
    const cachePath = await cacheFile();
    const w = world({ check: () => Response.json(verdict({ bazaar: null })) });
    await client(w.impl, { url: CHECK, cachePath }).call(ENDPOINT, {});
    expect(w.paidTo(ENDPOINT)).toBe(1);

    const strict = world();
    const err = await refusal(
      client(strict.impl, { url: CHECK, cachePath, requireListed: true }).call(ENDPOINT, {})
    );
    expect(err.message).toMatch(/not listed in the x402 Bazaar/);
    expect(strict.requestsTo(CHECK)).toBe(0); // the cached answer was enough to refuse
    expect(strict.paidTo(ENDPOINT)).toBe(0);
  });

  it("aborts — loudly, and without paying — when the check itself fails", async () => {
    const w = world({ check: () => new Response("upstream down", { status: 503 }) });
    const err = await refusal(client(w.impl, { url: CHECK, cachePath: await cacheFile() }).call(ENDPOINT, {}));
    expect(err.code).toBe("payee_check_failed");
    expect(err.message).toMatch(/Could not check payee/);
    expect(err.message).toMatch(/NOT paid/);
    expect(w.paidTo(ENDPOINT)).toBe(0);
  });

  it("treats an answer that is not a verdict as a failed check, not a pass", async () => {
    const w = world({ check: () => Response.json({ hello: "proxy" }) });
    const err = await refusal(client(w.impl, { url: CHECK, cachePath: await cacheFile() }).call(ENDPOINT, {}));
    expect(err.code).toBe("payee_check_failed");
    expect(w.paidTo(ENDPOINT)).toBe(0);
  });

  it("pays anyway with onCheckError: proceed, and says the payee went unchecked", async () => {
    const cachePath = await cacheFile();
    const w = world({ check: () => new Response("down", { status: 503 }) });
    const out = await client(w.impl, { url: CHECK, cachePath, onCheckError: "proceed" }).call(ENDPOINT, {});
    expect(out.payee).toMatchObject({ source: "unchecked", ok: true });
    expect(out.payee!.reason).toMatch(/could not run/);
    expect(w.paidTo(ENDPOINT)).toBe(1);
    // A failed check is not a verdict, so nothing was cached.
    expect(new PayeeCache(cachePath).get("testnet", SELLER)).toBeUndefined();
  });

  it("never checks the payee-check endpoint's own payee", async () => {
    const w = world();
    const out = await client(w.impl, { url: CHECK, cachePath: await cacheFile() }).call(CHECK, {
      address: SELLER,
      network: "testnet",
    });
    expect(out.payee).toBeUndefined();
    // One unpaid 402 and one paid retry — no nested check of RIPAR.
    expect(w.requestsTo(CHECK)).toBe(2);
    expect(w.paidTo(CHECK)).toBe(1);
  });

  it("refuses to sign when the second 402 names a different payTo than the one checked", async () => {
    // Quote → SELLER (checked, fine). The 402 the payment is signed against →
    // SWAPPED, which nobody checked.
    const w = world({ sellerPayTo: (n) => (n === 0 ? SELLER : SWAPPED) });
    const err = await refusal(client(w.impl, { url: CHECK, cachePath: await cacheFile() }).call(ENDPOINT, {}));
    expect(err.code).toBe("payee_unchecked");
    expect(err.message).toContain(SWAPPED);
    expect(w.paidTo(ENDPOINT)).toBe(0);
  });

  it("does not spend on a check for a call the price cap would refuse anyway", async () => {
    const w = world();
    const c = new RiparClient({
      mnemonic,
      network: "testnet",
      retry: false,
      fetchImpl: w.impl,
      maxPrice: "$0.001",
      checkPayee: { url: CHECK, cachePath: await cacheFile() },
    });
    const err = await refusal(c.call(ENDPOINT, {}));
    expect(err.code).toBe("price_above_max");
    expect(w.requestsTo(CHECK)).toBe(0);
  });
});

/* ── the CLI ────────────────────────────────────────────────────────────── */

function cli(env: Record<string, string>, impl: typeof fetch) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIO = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: { RIPAR_MNEMONIC: mnemonic, ...env },
    cwd: process.cwd(),
    fetchImpl: impl,
  };
  return { io, stdout: () => out.join("\n"), stderr: () => err.join("\n") };
}

describe("ripar call --check-payee", () => {
  it("prints the facts on stderr and keeps stdout the endpoint's JSON", async () => {
    const w = world();
    const c = cli({ RIPAR_PAYEE_CHECK_URL: CHECK, RIPAR_PAYEE_CACHE: await cacheFile() }, w.impl);
    // Flag BEFORE the URL: a switch must not swallow the next word as its value.
    const code = await run(["call", "--check-payee", ENDPOINT, "--network", "testnet", "--body", "{}", "--retries", "1"], c.io);
    expect(code).toBe(0);
    expect(JSON.parse(c.stdout())).toEqual({ ok: true });
    expect(c.stderr()).toContain(`payee ${SELLER} (testnet) ok`);
    expect(c.stderr()).toContain("Paid 9 times over x402.");
  });

  it("exits non-zero with the facts when the payee is refused", async () => {
    const w = world({ check: () => Response.json(verdict({ bazaar: null, facts: ["Unlisted."] })) });
    const c = cli({ RIPAR_PAYEE_CHECK_URL: CHECK, RIPAR_PAYEE_CACHE: await cacheFile() }, w.impl);
    const code = await run(
      ["call", ENDPOINT, "--network", "testnet", "--check-payee", "--require-listed", "--retries", "1"],
      c.io
    );
    expect(code).toBe(1);
    expect(c.stderr()).toMatch(/Refusing to pay .*not listed in the x402 Bazaar/);
    expect(c.stderr()).toContain("Unlisted.");
    expect(w.paidTo(ENDPOINT)).toBe(0);
  });

  it("will not take --require-listed without --check-payee", async () => {
    const w = world();
    const c = cli({}, w.impl);
    expect(await run(["call", ENDPOINT, "--require-listed"], c.io)).toBe(1);
    expect(c.stderr()).toMatch(/only apply with --check-payee/);
    expect(w.seen).toHaveLength(0);
  });

  it("documents the flag and its price in --help", async () => {
    const c = cli({}, world().impl);
    await run(["call", "--help"], c.io);
    expect(c.stdout()).toContain("--check-payee");
    expect(c.stdout()).toContain("$0.01");
  });
});
