import algosdk from "algosdk";
import fs from "node:fs";

const algod = new algosdk.Algodv2("a".repeat(64), "http://localhost", 4001);
const kmd = new algosdk.Kmd("a".repeat(64), "http://localhost", 4002);

// LocalNet ships a default wallet holding pre-funded genesis accounts.
const { wallets } = await kmd.listWallets();
const w = wallets.find((x) => x.name === "unencrypted-default-wallet");
const { wallet_handle_token: h } = await kmd.initWalletHandle(w.id, "");
const { addresses } = await kmd.listKeys(h);
const funder = addresses[0];
const { private_key } = await kmd.exportKey(h, "", funder);
const funderSk = private_key;
console.log("  funder:", funder);

const info = await algod.accountInformation(funder).do();
console.log("  funder balance:", Number(info.amount) / 1e6, "ALGO");

// Two fresh accounts: the payer (a caller) and the merchant (the endpoint).
const payer = algosdk.generateAccount();
const merchant = algosdk.generateAccount();
const facilitator = algosdk.generateAccount();

async function pay(from, fromSk, to, amt) {
  const sp = await algod.getTransactionParams().do();
  const t = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: from, receiver: to, amount: amt, suggestedParams: sp,
  });
  const s = t.signTxn(fromSk);
  const { txid } = await algod.sendRawTransaction(s).do();
  await algosdk.waitForConfirmation(algod, txid, 4);
  return txid;
}

for (const a of [payer, merchant, facilitator]) {
  await pay(funder, funderSk, a.addr.toString(), 10_000_000);
}
console.log("  funded payer / merchant / facilitator with 10 ALGO each");

// A stand-in for USDC: same 6 decimals, same unit name.
const sp = await algod.getTransactionParams().do();
const create = algosdk.makeAssetCreateTxnWithSuggestedParamsFromObject({
  sender: funder, total: 1_000_000_000_000n, decimals: 6, defaultFrozen: false,
  unitName: "USDC", assetName: "USD Coin (LocalNet)", manager: funder,
  reserve: funder, suggestedParams: sp,
});
const cs = create.signTxn(funderSk);
const { txid: ctx } = await algod.sendRawTransaction(cs).do();
const cres = await algosdk.waitForConfirmation(algod, ctx, 4);
const assetId = Number(cres.assetIndex);
console.log("  created USDC-equivalent ASA:", assetId);

// Both sides must opt in before they can hold it.
for (const a of [payer, merchant]) {
  const p = await algod.getTransactionParams().do();
  const t = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: a.addr.toString(), receiver: a.addr.toString(), amount: 0,
    assetIndex: assetId, suggestedParams: p,
  });
  const s = t.signTxn(a.sk);
  const { txid } = await algod.sendRawTransaction(s).do();
  await algosdk.waitForConfirmation(algod, txid, 4);
}

// Give the payer 100 USDC to spend.
const p2 = await algod.getTransactionParams().do();
const fund = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
  sender: funder, receiver: payer.addr.toString(), amount: 100_000_000,
  assetIndex: assetId, suggestedParams: p2,
});
const fs2 = fund.signTxn(funderSk);
const { txid: ftx } = await algod.sendRawTransaction(fs2).do();
await algosdk.waitForConfirmation(algod, ftx, 4);
console.log("  payer funded with 100 USDC");

fs.writeFileSync("/tmp/localnet.json", JSON.stringify({
  assetId,
  payer: { addr: payer.addr.toString(), mnemonic: algosdk.secretKeyToMnemonic(payer.sk) },
  merchant: { addr: merchant.addr.toString(), mnemonic: algosdk.secretKeyToMnemonic(merchant.sk) },
  facilitator: { addr: facilitator.addr.toString(), mnemonic: algosdk.secretKeyToMnemonic(facilitator.sk) },
}, null, 2));
console.log("  wrote /tmp/localnet.json");
