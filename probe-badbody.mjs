/**
 * Is a caller charged for a request the handler was always going to reject?
 *
 * @x402/express settles AFTER the handler and cancels settlement on any status
 * >= 400, so a 4xx should leave the payer's balance untouched. This checks that
 * against a real chain rather than trusting the ordering. Run against LocalNet.
 */
import algosdk from "algosdk";
import fs from "node:fs";
import { configPath } from "./config-path.mjs";
import { createServer } from "./dist/server.js";
import { defineAgent, defineEndpoint } from "./dist/define.js";

const cfg = JSON.parse(fs.readFileSync(configPath("localnet-e2e.json"), "utf8"));
const algod = new algosdk.Algodv2("a".repeat(64), "http://localhost", "4001");
const merchant = algosdk.mnemonicToSecretKey(cfg.merchant.mnemonic);
const payer = algosdk.mnemonicToSecretKey(cfg.payer.mnemonic);
const ASSET = Number(cfg.assetId);

const balance = async (addr) => {
  const a = await algod.accountInformation(addr).do();
  const h = (a.assets ?? []).find((x) => Number(x.assetId ?? x["asset-id"]) === ASSET);
  return h ? Number(h.amount) : 0;
};

const app = await createServer(
  defineAgent({
    name: "BadBody", handle: "badbody", payTo: merchant.addr.toString(), network: "localnet",
    endpoints: [defineEndpoint({
      name: "summarize",
      price: { asset: String(ASSET), amount: "0.01", decimals: 6, symbol: "USDC" },
      input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      handler: ({ body }) => ({ summary: String(body?.text ?? "").slice(0, 20) }),
    })],
  }),
  { network: "localnet", payTo: merchant.addr.toString(),
    facilitatorUrl: process.env.FACILITATOR_URL ?? "http://127.0.0.1:4020",
    logging: { level: "error", write: () => {} } }
);
const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;

async function payWith(body) {
  const q = await fetch(`${base}/summarize`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const hdr = q.headers.get("payment-required");
  if (!hdr) return { status: q.status, settled: false, text: (await q.text()).slice(0, 170) };
  const accepted = JSON.parse(Buffer.from(hdr, "base64").toString()).accepts[0];
  const sp = await algod.getTransactionParams().do();
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: payer.addr, receiver: merchant.addr,
    amount: Number(accepted.maxAmountRequired ?? accepted.amount),
    assetIndex: ASSET, suggestedParams: sp,
  });
  const sig = Buffer.from(JSON.stringify({
    x402Version: 2, accepted, scheme: "exact", network: accepted.network,
    payload: { paymentGroup: [Buffer.from(txn.signTxn(payer.sk)).toString("base64")], paymentIndex: 0 },
  })).toString("base64");
  const res = await fetch(`${base}/summarize`, {
    method: "POST", headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": sig },
    body: JSON.stringify(body),
  });
  return { status: res.status, settled: Boolean(res.headers.get("payment-response")), text: (await res.text()).slice(0, 170) };
}

const before = await balance(payer.addr.toString());
const bad = await payWith({ wrong: "field" });
const mid = await balance(payer.addr.toString());
const good = await payWith({ text: "the quick brown fox" });
const after = await balance(payer.addr.toString());

console.log(`  PAID + INVALID -> ${bad.status}  ${bad.text.replace(/\s+/g, " ").slice(0, 90)}`);
console.log(`     payer balance moved: ${before - mid} units  ${before - mid === 0 ? "(NOT charged)" : "(CHARGED)"}`);
console.log(`  PAID + VALID   -> ${good.status} settled=${good.settled}`);
console.log(`     payer balance moved: ${mid - after} units`);

server.close();
const ok = bad.status >= 400 && before - mid === 0 && good.status === 200 && mid - after > 0;
console.log(`\n  ${ok ? "PASS —" : "FAIL —"} a rejected request costs nothing, a served one costs the quoted price\n`);
process.exit(ok ? 0 : 1);
