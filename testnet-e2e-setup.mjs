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

/**
 * Circulating TestNet USDC, not a mint of our own.
 *
 * This script used to create an ASA with six decimals and the unit name
 * "USDC", as a stand-in, because the TestNet USDC faucet is login-gated. That
 * stand-in was the problem: every amount it produced was a near-homonym of a
 * real one, the registries got bootstrapped to it — and `bootstrap` is
 * one-shot — so correcting it later cost a full redeploy. Naming a token USDC
 * does not make it USDC.
 *
 * Both accounts are opted in here; the balance has to come from the faucet,
 * which is a human step and stays one.
 */
const ASSET_ID = 10_458_941;

for (const a of [payer, merchant]) {
  const info = await algod.accountInformation(a.addr.toString()).do();
  const holds = (info.assets ?? []).some((x) => Number(x.assetId ?? x["asset-id"]) === ASSET_ID);
  if (holds) continue;
  const p = await algod.getTransactionParams().do();
  await send(algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: a.addr.toString(), receiver: a.addr.toString(), amount: 0,
    assetIndex: ASSET_ID, suggestedParams: p,
  }), a.sk);
}
const assetId = ASSET_ID;
console.log(`  both accounts opted in to USDC (${ASSET_ID})`);

const payerInfo = await algod.accountInformation(payer.addr.toString()).do();
const held = (payerInfo.assets ?? []).find((x) => Number(x.assetId ?? x["asset-id"]) === ASSET_ID);
const balance = held ? Number(held.amount) / 1e6 : 0;
console.log(`  payer holds ${balance.toFixed(2)} USDC`);
if (balance <= 0) {
  console.log("");
  console.log("  NOTE: the payer holds no USDC, so nothing here can settle yet.");
  console.log("  Fund it from https://faucet.circle.com (Algorand TestNet):");
  console.log(`    ${payer.addr.toString()}`);
}

fs.writeFileSync("/tmp/testnet-e2e.json", JSON.stringify({
  assetId,
  payer: { addr: payer.addr.toString(), mnemonic: algosdk.secretKeyToMnemonic(payer.sk) },
  merchant: { addr: merchant.addr.toString(), mnemonic: algosdk.secretKeyToMnemonic(merchant.sk) },
  funder: funder.addr.toString(),
}, null, 2));
console.log("  wrote /tmp/testnet-e2e.json");
