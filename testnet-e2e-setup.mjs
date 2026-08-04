/**
 * Set up a genuine end-to-end x402 settlement on Algorand TESTNET, using only
 * funds already in hand.
 *
 * The real TestNet USDC (10458941) can only be obtained from a faucet behind an
 * interactive login, so this mints its own 6-decimal stand-in and says so
 * plainly. Everything else is identical to MainNet: a real public chain, real
 * signatures, real atomic groups, and transactions anyone can look up.
 */
import algosdk from "algosdk";
import fs from "node:fs";

const algod = new algosdk.Algodv2("", "https://testnet-api.algonode.cloud", "");
const funder = algosdk.mnemonicToSecretKey(
  JSON.parse(fs.readFileSync("/tmp/mainnet-payer.json", "utf8")).mnemonic
);

const info = await algod.accountInformation(funder.addr.toString()).do();
console.log("  funder:", funder.addr.toString());
console.log("  balance:", Number(info.amount) / 1e6, "ALGO");

async function send(txn, sk) {
  const s = txn.signTxn(sk);
  const { txid } = await algod.sendRawTransaction(s).do();
  return { txid, conf: await algosdk.waitForConfirmation(algod, txid, 6) };
}

// A payer and a merchant, so the settlement has two genuine sides.
const payer = algosdk.generateAccount();
const merchant = algosdk.generateAccount();

for (const a of [payer, merchant]) {
  const sp = await algod.getTransactionParams().do();
  await send(algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: funder.addr.toString(), receiver: a.addr.toString(),
    amount: 1_000_000, suggestedParams: sp,
  }), funder.sk);
}
console.log("  funded payer + merchant with 1 ALGO each");

// 6 decimals and the USDC unit name so amounts read identically to MainNet.
const sp = await algod.getTransactionParams().do();
const { conf } = await send(algosdk.makeAssetCreateTxnWithSuggestedParamsFromObject({
  sender: funder.addr.toString(), total: 1_000_000_000n, decimals: 6,
  defaultFrozen: false, unitName: "rUSDC", assetName: "Ripar Test USDC",
  manager: funder.addr.toString(), reserve: funder.addr.toString(),
  suggestedParams: sp,
}), funder.sk);
const assetId = Number(conf.assetIndex);
console.log("  minted test asset:", assetId, "(stand-in for USDC, 6 decimals)");

for (const a of [payer, merchant]) {
  const p = await algod.getTransactionParams().do();
  await send(algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: a.addr.toString(), receiver: a.addr.toString(), amount: 0,
    assetIndex: assetId, suggestedParams: p,
  }), a.sk);
}
const p2 = await algod.getTransactionParams().do();
await send(algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
  sender: funder.addr.toString(), receiver: payer.addr.toString(),
  amount: 50_000_000, assetIndex: assetId, suggestedParams: p2,
}), funder.sk);
console.log("  payer holds 50.00 rUSDC");

fs.writeFileSync("/tmp/testnet-e2e.json", JSON.stringify({
  assetId,
  payer: { addr: payer.addr.toString(), mnemonic: algosdk.secretKeyToMnemonic(payer.sk) },
  merchant: { addr: merchant.addr.toString(), mnemonic: algosdk.secretKeyToMnemonic(merchant.sk) },
  funder: funder.addr.toString(),
}, null, 2));
console.log("  wrote /tmp/testnet-e2e.json");
