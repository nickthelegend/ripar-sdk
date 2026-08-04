/**
 * The x402 loop against a live Algorand LocalNet:
 *   request → 402 with a quote → sign a payment → settle → 200
 * then the transaction is looked up on chain.
 *
 * SCOPE, stated because this file used to overstate it. It imports NOTHING
 * from this SDK — the server below is hand-rolled express, and the payment is
 * assembled with algosdk directly. So it demonstrates that the PROTOCOL works
 * on Algorand. It proves nothing about ripar-sdk: every line of src/ could be
 * deleted and this would still print the same output.
 *
 * The SDK's own end-to-end coverage is test/subscription-server.test.ts, which
 * drives the real createServer and the real RiparClient through the genuine
 * @x402/express middleware.
 *
 * It also used to assert nothing at all and always exit 0, so a broken run
 * looked identical to a working one in CI. There is a verdict at the bottom
 * now.
 *
 * Needs LocalNet: algokit localnet start, and /tmp/localnet.json.
 */
import express from "express";
import algosdk from "algosdk";
import fs from "node:fs";

const cfg = JSON.parse(fs.readFileSync("/tmp/localnet.json", "utf8"));
const algod = new algosdk.Algodv2("a".repeat(64), "http://localhost", 4001);
const payer = algosdk.mnemonicToSecretKey(cfg.payer.mnemonic);
const merchant = cfg.merchant.addr;
const ASSET = cfg.assetId;
const PRICE = 10_000; // 0.01 USDC at 6 decimals

const bal = async (addr) => {
  const a = await algod.accountInformation(addr).do();
  const h = (a.assets ?? []).find((x) => Number(x.assetId ?? x["asset-id"]) === ASSET);
  return Number(h?.amount ?? 0) / 1e6;
};

console.log("── before ──");
// Captured, not just printed: the verdict compares these against the balances
// after, so "settled" means the chain agrees rather than the server saying so.
const payerBefore = await bal(payer.addr.toString());
const merchantBefore = await bal(merchant);
console.log("  payer   :", payerBefore, "USDC");
console.log("  merchant:", merchantBefore, "USDC");

/* ── the paid endpoint ── */
const app = express();
app.use(express.json());

app.post("/api/summarize", async (req, res) => {
  const sig = req.header("X-PAYMENT");

  if (!sig) {
    // 1. Refuse, and quote.
    return res.status(402).json({
      x402Version: 2,
      accepts: [{
        scheme: "exact", network: "algorand:localnet-x402-demo",
        amount: String(PRICE), asset: String(ASSET), payTo: merchant,
        maxTimeoutSeconds: 300,
      }],
    });
  }

  // 3. Hand the signed group to the facilitator to verify and settle.
  const payload = JSON.parse(Buffer.from(sig, "base64").toString("utf8"));
  const v = await (await fetch("http://127.0.0.1:4020/verify", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ paymentPayload: payload }),
  })).json();
  if (!v.isValid) return res.status(402).json({ error: v.invalidReason });

  const s = await (await fetch("http://127.0.0.1:4020/settle", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ paymentPayload: payload }),
  })).json();
  if (!s.success) return res.status(402).json({ error: s.errorReason });

  // 4. Only now does the work run.
  const text = String(req.body?.text ?? "");
  res.setHeader("X-Payment-Response", JSON.stringify({ txId: s.transaction, round: s.round }));
  res.json({ summary: text.slice(0, 60), chars: text.length, settled: s.transaction });
});

const server = app.listen(4099);
await new Promise((r) => server.once("listening", r));

/* ── the caller ── */
const URL = "http://127.0.0.1:4099/api/summarize";
const body = { text: "Ripar is the execution and payment layer for autonomous agents on Algorand." };

console.log("\n── 1. unpaid request ──");
let r = await fetch(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
console.log("  status:", r.status);
const gotChallenge = r.status === 402;
const quote = await r.json();
const acc = quote.accepts[0];
console.log("  quoted:", Number(acc.amount) / 1e6, "USDC → ", acc.payTo.slice(0, 12) + "…");

console.log("\n── 2. sign the payment ──");
const sp = await algod.getTransactionParams().do();
const transfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
  sender: payer.addr.toString(), receiver: acc.payTo, amount: Number(acc.amount),
  assetIndex: Number(acc.asset), suggestedParams: sp,
  note: new TextEncoder().encode(`x402-payment-v2-${Date.now()}`),
});
const signed = transfer.signTxn(payer.sk);
const header = Buffer.from(JSON.stringify({
  x402Version: 2, scheme: "exact",
  transactions: [Buffer.from(signed).toString("base64")],
})).toString("base64");
console.log("  signed a", Number(acc.amount) / 1e6, "USDC transfer");

console.log("\n── 3. retry with payment ──");
r = await fetch(URL, {
  method: "POST",
  headers: { "content-type": "application/json", "X-PAYMENT": header },
  body: JSON.stringify(body),
});
console.log("  status:", r.status);
const out = await r.json();
console.log("  response:", JSON.stringify(out).slice(0, 160));

console.log("\n── 4. verify on chain ──");
if (out.settled) {
  const info = await algod.pendingTransactionInformation(out.settled).do().catch(() => null);
  console.log("  tx id:", out.settled);
  console.log("  confirmed round:", info?.confirmedRound ?? "(already committed)");
}
console.log("\n── after ──");
const payerAfter = await bal(payer.addr.toString());
const merchantAfter = await bal(merchant);
console.log("  payer   :", payerAfter, "USDC");
console.log("  merchant:", merchantAfter, "USDC");

server.close();

/* The verdict. Reading the balances back off the chain is the only claim here
   worth making: that the quoted amount actually moved between two accounts. */
const moved = Number((payerBefore - payerAfter).toFixed(6));
const received = Number((merchantAfter - merchantBefore).toFixed(6));
const expected = PRICE / 1e6;

const results = {
  "the unpaid request was refused with a 402": gotChallenge,
  "the paid retry was served": r.status === 200,
  "the settlement is on chain": !!out.settled,
  [`the payer really lost ${expected} USDC`]: moved === expected,
  [`the merchant really received ${expected} USDC`]: received === expected,
};

console.log("\n── verdict ──");
let ok = true;
for (const [claim, pass] of Object.entries(results)) {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${claim}`);
  if (!pass) ok = false;
}
console.log(
  ok
    ? "\nx402 settles on Algorand. This says nothing about ripar-sdk — see test/subscription-server.test.ts."
    : "\nThe loop did not complete."
);
process.exit(ok ? 0 : 1);
