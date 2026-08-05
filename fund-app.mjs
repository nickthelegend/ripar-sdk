import algosdk from "algosdk";
import fs from "node:fs";
const algod = new algosdk.Algodv2(
  process.env.ALGOD_TOKEN ?? "",
  process.env.ALGOD_URL ?? "https://testnet-api.algonode.cloud",
  process.env.ALGOD_PORT ?? ""
);
const acct = algosdk.mnemonicToSecretKey(JSON.parse(fs.readFileSync("/tmp/mainnet-payer.json","utf8")).mnemonic);
const { appId } = JSON.parse(fs.readFileSync("/tmp/rep-v2.json","utf8"));
const appAddr = algosdk.getApplicationAddress(appId).toString();
const sp = await algod.getTransactionParams().do();
const t = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
  sender: acct.addr.toString(), receiver: appAddr, amount: 500_000, suggestedParams: sp });
const { txid } = await algod.sendRawTransaction(t.signTxn(acct.sk)).do();
await algosdk.waitForConfirmation(algod, txid, 6);
console.log("  funded app", appId, "->", appAddr.slice(0,12)+"…", "0.5 ALGO (box storage MBR)");
