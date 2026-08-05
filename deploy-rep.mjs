import algosdk from "algosdk";
import fs from "node:fs";
const algod = new algosdk.Algodv2(
  process.env.ALGOD_TOKEN ?? "",
  process.env.ALGOD_URL ?? "https://testnet-api.algonode.cloud",
  process.env.ALGOD_PORT ?? ""
);
const acct = algosdk.mnemonicToSecretKey(JSON.parse(fs.readFileSync("/tmp/mainnet-payer.json","utf8")).mnemonic);
const spec = JSON.parse(fs.readFileSync("/Volumes/Extreme SSD/Projects/ripar/ripar-contracts/artifacts/reputation_registry/ReputationRegistry.arc56.json","utf8"));
const approval = new Uint8Array(Buffer.from((await algod.compile(Buffer.from(fs.readFileSync("/Volumes/Extreme SSD/Projects/ripar/ripar-contracts/artifacts/reputation_registry/ReputationRegistry.approval.teal"))).do()).result,"base64"));
const clear = new Uint8Array(Buffer.from((await algod.compile(Buffer.from(fs.readFileSync("/Volumes/Extreme SSD/Projects/ripar/ripar-contracts/artifacts/reputation_registry/ReputationRegistry.clear.teal"))).do()).result,"base64"));
const sp = await algod.getTransactionParams().do();
const txn = algosdk.makeApplicationCreateTxnFromObject({
  sender: acct.addr.toString(), suggestedParams: sp,
  onComplete: algosdk.OnApplicationComplete.NoOpOC,
  approvalProgram: approval, clearProgram: clear,
  numGlobalInts: 4, numGlobalByteSlices: 0, numLocalInts: 0, numLocalByteSlices: 0,
});
const { txid } = await algod.sendRawTransaction(txn.signTxn(acct.sk)).do();
const conf = await algosdk.waitForConfirmation(algod, txid, 6);
const appId = Number(conf.applicationIndex);
console.log("  ReputationRegistry v2 appId:", appId);
fs.writeFileSync("/tmp/rep-v2.json", JSON.stringify({appId, deployTx: txid}, null, 2));
