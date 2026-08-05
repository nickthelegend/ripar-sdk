import algosdk from "algosdk";
import fs from "node:fs";

const cfg = JSON.parse(fs.readFileSync("/tmp/ripar-testnet-2.json", "utf8"));
const payer = JSON.parse(fs.readFileSync("/tmp/mainnet-payer.json", "utf8"));
const deployer = algosdk.mnemonicToSecretKey(payer.mnemonic);
const algod = new algosdk.Algodv2(
  process.env.ALGOD_TOKEN ?? "",
  process.env.ALGOD_URL ?? "https://testnet-api.algonode.cloud",
  process.env.ALGOD_PORT ?? ""
);

const info = await algod.accountInformation(deployer.addr.toString()).do();
console.log("  deployer:", deployer.addr.toString());
console.log("  balance :", Number(info.amount) / 1e6, "ALGO");

const ART = "/Volumes/Extreme SSD/Projects/ripar/ripar-contracts/artifacts";
const targets = [
  ["IdentityRegistry", `${ART}/identity`],
  ["ReputationRegistry", `${ART}/reputation_registry`],
  ["ValidationRegistry", `${ART}/validation_registry`],
];

const out = {};
for (const [name, dir] of targets) {
  const approval = fs.readFileSync(`${dir}/${name}.approval.teal`, "utf8");
  const clear = fs.readFileSync(`${dir}/${name}.clear.teal`, "utf8");
  const ap = await algod.compile(approval).do();
  const cl = await algod.compile(clear).do();

  const sp = await algod.getTransactionParams().do();
  const txn = algosdk.makeApplicationCreateTxnFromObject({
    sender: deployer.addr.toString(),
    suggestedParams: sp,
    onComplete: algosdk.OnApplicationComplete.NoOpOC,
    approvalProgram: new Uint8Array(Buffer.from(ap.result, "base64")),
    clearProgram: new Uint8Array(Buffer.from(cl.result, "base64")),
    numGlobalInts: 4, numGlobalByteSlices: 4,
    numLocalInts: 0, numLocalByteSlices: 0,
    // Boxes need the app account to hold MBR; funded separately below.
    extraPages: 1,
  });
  const signed = txn.signTxn(deployer.sk);
  const { txid } = await algod.sendRawTransaction(signed).do();
  const res = await algosdk.waitForConfirmation(algod, txid, 6);
  const appId = Number(res.applicationIndex);
  const appAddr = algosdk.getApplicationAddress(appId).toString();
  out[name] = { appId, appAddr, txid };
  console.log(`  ${name.padEnd(20)} appId ${appId}  ${appAddr.slice(0,10)}…`);

  // Fund the app account so it can pay box MBR when agents register.
  const sp2 = await algod.getTransactionParams().do();
  const fund = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: deployer.addr.toString(), receiver: appAddr,
    amount: 500_000, suggestedParams: sp2,
  });
  const fs2 = fund.signTxn(deployer.sk);
  const { txid: ft } = await algod.sendRawTransaction(fs2).do();
  await algosdk.waitForConfirmation(algod, ft, 6);
}
fs.writeFileSync("/tmp/registries.json", JSON.stringify(out, null, 2));
console.log("  wrote /tmp/registries.json");
