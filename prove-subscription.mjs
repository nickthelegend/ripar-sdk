/**
 * Subscriptions, against real money on Algorand TestNet.
 *
 * SCOPE, stated because an earlier version of this file overstated it: this
 * exercises the subscription LEDGER — checkSubscription, issue, expiry, endpoint
 * scoping — against settlements that really happen on chain. It does NOT
 * exercise createServer. It mounts those functions on its own Express app,
 * which is why it stayed green while createServer minted no keys at all.
 *
 * The server wiring is covered by test/subscription-server.test.ts, which runs
 * the real createServer with the genuine @x402/express middleware and fails
 * 5 of 7 if the minting logic regresses.
 *
 * The two are complementary and neither is sufficient alone: this one proves
 * the money moves, that one proves the server does the right thing with it.
 *
 * The claim under test is the one the landing page and the docs make: pay once,
 * call free until the window closes. Three things have to be true for that to
 * be worth saying, and each is checked here against the chain rather than
 * against a fixture:
 *
 *   1. the first call really is gated, and really moves money
 *   2. the second call really is free — the payer's balance does not change
 *   3. an expired window really does close again
 *
 * Balances are read from TestNet before and after, so "free" means the chain
 * agrees, not that a variable in this process says so.
 */
import algosdk from "algosdk";
import fs from "node:fs";
import { configPath } from "./config-path.mjs";
import express from "express";
import { MemorySubscriptionStore, checkSubscription, issue, readKey } from "./dist/subscriptions.js";

const cfg = JSON.parse(fs.readFileSync(configPath("testnet-e2e.json"), "utf8"));
const algod = new algosdk.Algodv2(
  process.env.ALGOD_TOKEN ?? "",
  process.env.ALGOD_URL ?? "https://testnet-api.algonode.cloud",
  process.env.ALGOD_PORT ?? ""
);
const payer = algosdk.mnemonicToSecretKey(cfg.payer.mnemonic);
const MERCHANT = cfg.merchant.addr;
const ASSET = cfg.assetId;
const PRICE = 5_000_000; // $5.00 for a window, six decimals
const PERIOD_MS = 4_000; // short, so expiry is observable in one run

const bal = async (a) => {
  const acc = await algod.accountInformation(a).do();
  const h = (acc.assets ?? []).find((x) => Number(x.assetId ?? x["asset-id"]) === ASSET);
  return Number(h?.amount ?? 0) / 1e6;
};

const store = new MemorySubscriptionStore();
let handlerRuns = 0;
let settlements = 0;

/* The server: the subscription gate in front, the paid path behind it. This is
   the same ordering server.ts uses — gate, then payment, then handler. */
const app = express();
app.use(express.json());

app.post("/api/feed", async (req, res) => {
  const check = await checkSubscription(store, readKey(req.headers), "feed");

  if (check.active) {
    handlerRuns++;
    return res
      .set("x-ripar-subscription-expires", new Date(check.record.expiresAt).toISOString())
      .set("x-ripar-subscription-remaining-ms", String(check.remainingMs))
      .json({ items: ["free call, covered by the window"], covered: true });
  }

  const proof = req.get("x-payment");
  if (!proof) {
    return res
      .status(402)
      .set("payment-required", Buffer.from(JSON.stringify({
        accepts: [{ scheme: "exact", network: "algorand:testnet", payTo: MERCHANT, asset: String(ASSET), amount: String(PRICE) }],
      })).toString("base64"))
      .set("x-ripar-subscription-status", check.reason === "none" ? "none" : check.reason)
      .json({});
  }

  // Settle: submit the signed transfer the caller attached, then confirm it on
  // chain before issuing anything. A key minted from an unconfirmed payment is
  // exactly the hole the ReputationRegistry rewrite closed.
  const signed = Buffer.from(proof, "base64");
  const { txid } = await algod.sendRawTransaction(signed).do();
  await algosdk.waitForConfirmation(algod, txid, 6);
  settlements++;

  const { key, record } = await issue(store, {
    endpoint: "feed",
    periodMs: PERIOD_MS,
    usd: PRICE / 1e6,
    payer: payer.addr.toString(),
    txId: txid,
  });
  handlerRuns++;
  res
    .set("x-ripar-subscription", key)
    .set("x-ripar-subscription-expires", new Date(record.expiresAt).toISOString())
    .json({ items: ["first call, window opened"], txId: txid });
});

const server = app.listen(0);
const port = server.address().port;
const URL = `http://127.0.0.1:${port}/api/feed`;

/* The client half: quote, sign, retry — what RiparClient does. */
async function payAndCall() {
  const probe = await fetch(URL, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (probe.status !== 402) throw new Error(`expected a 402, got ${probe.status}`);
  const req = JSON.parse(Buffer.from(probe.headers.get("payment-required"), "base64").toString());
  const accept = req.accepts[0];

  const sp = await algod.getTransactionParams().do();
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: payer.addr,
    receiver: accept.payTo,
    amount: Number(accept.amount),
    assetIndex: Number(accept.asset),
    suggestedParams: sp,
    note: new TextEncoder().encode("ripar-subscription-window"),
  });
  const signedTxn = Buffer.from(txn.signTxn(payer.sk)).toString("base64");

  return fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-payment": signedTxn },
    body: "{}",
  });
}

const before = await bal(payer.addr.toString());
console.log("── TestNet, asset", ASSET, "──");
console.log("  payer balance before:", before, "USDC");

/* 1. First call: gated, and it costs money. */
const first = await payAndCall();
const firstBody = await first.json();
const key = first.headers.get("x-ripar-subscription");
const afterPaid = await bal(payer.addr.toString());
console.log("\n1. first call  →", first.status, "| settled", firstBody.txId);
console.log("   balance now:", afterPaid, `(−${(before - afterPaid).toFixed(2)})`);
console.log("   key issued :", key?.slice(0, 12) + "…");

/* 2. Second and third calls: free. The chain must not move. */
const reused = [];
for (let i = 0; i < 2; i++) {
  const r = await fetch(URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ripar-subscription": key },
    body: "{}",
  });
  reused.push({ status: r.status, covered: (await r.json()).covered, remaining: r.headers.get("x-ripar-subscription-remaining-ms") });
}
const afterFree = await bal(payer.addr.toString());
console.log("\n2. two more calls with the key:", reused.map((r) => r.status).join(", "));
console.log("   covered:", reused.every((r) => r.covered));
console.log("   balance now:", afterFree, afterFree === afterPaid ? "(unchanged — the calls were free)" : "(MOVED — not free)");

/* 3. Expiry: the window really does close. */
await new Promise((r) => setTimeout(r, PERIOD_MS + 250));
const afterExpiry = await fetch(URL, {
  method: "POST",
  headers: { "content-type": "application/json", "x-ripar-subscription": key },
  body: "{}",
});
console.log("\n3. after the window closes →", afterExpiry.status, "|", afterExpiry.headers.get("x-ripar-subscription-status"));

/* 4. A key for another endpoint must not open this one. */
const { key: otherKey } = await issue(store, { endpoint: "some-other-endpoint", periodMs: 60_000, usd: 1 });
const cross = await fetch(URL, {
  method: "POST",
  headers: { "content-type": "application/json", "x-ripar-subscription": otherKey },
  body: "{}",
});
console.log("4. another endpoint's key →", cross.status, "|", cross.headers.get("x-ripar-subscription-status"));

server.close();

const paidExactlyOnce = settlements === 1;
const spent = Number((before - afterPaid).toFixed(6));
const results = {
  "first call was gated and settled": paidExactlyOnce && !!firstBody.txId,
  "the payer really paid $5.00": spent === PRICE / 1e6,
  "the next two calls returned 200": reused.every((r) => r.status === 200 && r.covered),
  "and cost nothing on chain": afterFree === afterPaid,
  "handler ran for all three calls": handlerRuns === 3,
  "only one settlement in total": paidExactlyOnce,
  "an expired window asks for payment again": afterExpiry.status === 402,
  "expiry is reported as expired, not unknown": afterExpiry.headers.get("x-ripar-subscription-status") === "expired",
  "another endpoint's key is refused": cross.status === 402,
};

console.log("\n── verdict ──");
let ok = true;
for (const [claim, pass] of Object.entries(results)) {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${claim}`);
  if (!pass) ok = false;
}
console.log(
  ok
    ? "\nThe subscription ledger holds up against real settlements on TestNet.\n" +
      "Server wiring is proved separately: npx vitest run test/subscription-server.test.ts"
    : "\nSubscription claim is NOT supported."
);
process.exit(ok ? 0 : 1);
