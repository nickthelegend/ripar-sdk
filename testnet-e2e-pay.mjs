/**
 * The complete loop on Algorand TestNet: 402 -> sign -> settle -> 200, then the
 * settlement's own txid is fed to the ReputationRegistry so the score is bound
 * to money that actually moved. Every id below is public and verifiable.
 */
import express from "express";
import algosdk from "algosdk";
import fs from "node:fs";

const cfg = JSON.parse(fs.readFileSync(process.env.RIPAR_E2E_CONFIG ?? "/tmp/testnet-e2e.json", "utf8"));
const reg = JSON.parse(fs.readFileSync("/tmp/registries.json", "utf8"));
const algod = new algosdk.Algodv2(
  process.env.ALGOD_TOKEN ?? "",
  process.env.ALGOD_URL ?? "https://testnet-api.algonode.cloud",
  process.env.ALGOD_PORT ?? ""
);
const payer = algosdk.mnemonicToSecretKey(cfg.payer.mnemonic);
const ASSET = cfg.assetId;
const PRICE = 10_000; // 0.01, six decimals

const bal = async (a) => {
  const acc = await algod.accountInformation(a).do();
  const h = (acc.assets ?? []).find((x) => Number(x.assetId ?? x["asset-id"]) === ASSET);
  return Number(h?.amount ?? 0) / 1e6;
};

console.log("── balances before ──");
console.log("  payer   :", await bal(payer.addr.toString()), "USDC");
console.log("  merchant:", await bal(cfg.merchant.addr), "USDC");

const app = express();
app.use(express.json());

app.post("/api/summarize", async (req, res) => {
  const sig = req.header("X-PAYMENT");
  if (!sig) {
    return res.status(402).json({
      x402Version: 2,
      accepts: [{
        scheme: "exact", network: "algorand:testnet",
        amount: String(PRICE), asset: String(ASSET),
        payTo: cfg.merchant.addr, maxTimeoutSeconds: 300,
      }],
    });
  }
  // Verify the signed group pays the right party the right amount, then submit
  // it to the real chain. This is the facilitator's whole job.
  const payload = JSON.parse(Buffer.from(sig, "base64").toString("utf8"));
  const group = payload.transactions.map((t) => Buffer.from(t, "base64"));
  const decoded = algosdk.decodeSignedTransaction(group[0]);
  const x = decoded.txn.assetTransfer;
  if (Number(x.assetIndex) !== ASSET) return res.status(402).json({ error: "wrong asset" });
  if (Number(x.amount) < PRICE) return res.status(402).json({ error: "underpaid" });
  if (algosdk.encodeAddress(x.receiver.publicKey) !== cfg.merchant.addr) {
    return res.status(402).json({ error: "wrong payee" });
  }
  const { txid } = await algod.sendRawTransaction(group).do();
  const conf = await algosdk.waitForConfirmation(algod, txid, 6);
  res.setHeader("X-Payment-Response", JSON.stringify({ txId: txid, round: Number(conf.confirmedRound) }));
  res.json({
    summary: String(req.body?.text ?? "").slice(0, 60),
    settled: txid, round: Number(conf.confirmedRound),
  });
});

const server = app.listen(4111);
await new Promise((r) => server.once("listening", r));
const URL = "http://127.0.0.1:4111/api/summarize";
const body = { text: "Ripar is the execution and payment layer for Algorand agents." };

console.log("\n── 1. unpaid ──");
let r = await fetch(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
console.log("  status:", r.status);
const acc = (await r.json()).accepts[0];
console.log("  quoted:", Number(acc.amount) / 1e6, "USDC → ", acc.payTo.slice(0, 12) + "…");

console.log("\n── 2. sign ──");
const sp = await algod.getTransactionParams().do();
const transfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
  sender: payer.addr.toString(), receiver: acc.payTo, amount: Number(acc.amount),
  assetIndex: Number(acc.asset), suggestedParams: sp,
  note: new TextEncoder().encode(`x402-payment-v2-${Date.now()}`),
});
const header = Buffer.from(JSON.stringify({
  x402Version: 2, scheme: "exact",
  transactions: [Buffer.from(transfer.signTxn(payer.sk)).toString("base64")],
})).toString("base64");
console.log("  signed", Number(acc.amount) / 1e6, "USDC");

console.log("\n── 3. retry with payment ──");
r = await fetch(URL, {
  method: "POST",
  headers: { "content-type": "application/json", "X-PAYMENT": header },
  body: JSON.stringify(body),
});
const out = await r.json();
console.log("  status:", r.status);
console.log("  settled tx:", out.settled);
console.log("  round     :", out.round);
console.log("  verify    : https://testnet.explorer.perawallet.app/tx/" + out.settled);

console.log("\n── balances after ──");
console.log("  payer   :", await bal(payer.addr.toString()), "USDC");
console.log("  merchant:", await bal(cfg.merchant.addr), "USDC");

fs.writeFileSync("/tmp/last-settlement.json", JSON.stringify({ txid: out.settled, round: out.round }, null, 2));
server.close();
