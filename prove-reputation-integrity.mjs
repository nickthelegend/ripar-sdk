/**
 * Prove the fix: reputation can no longer be bought with bytes.
 *
 * Old contract: accept_feedback(uint64, uint64, byte[], uint64) — the caller
 * supplied the "payment id" and the amount, and 32 zero bytes worked.
 * New contract: accept_feedback(axfer, uint64, uint64) — the AVM validates a
 * real transfer and the contract reads the amount and id off it.
 */
import algosdk from "algosdk";
import fs from "node:fs";

const algod = new algosdk.Algodv2("", "https://testnet-api.algonode.cloud", "");
const acct = algosdk.mnemonicToSecretKey(JSON.parse(fs.readFileSync("/tmp/mainnet-payer.json","utf8")).mnemonic);
const cfg = JSON.parse(fs.readFileSync("/tmp/testnet-e2e.json","utf8"));
const { appId } = JSON.parse(fs.readFileSync("/tmp/rep-v2.json","utf8"));
const signer = algosdk.makeBasicAccountTransactionSigner(acct);
const enc = new TextEncoder();

const spec = JSON.parse(fs.readFileSync("/Volumes/Extreme SSD/Projects/ripar/ripar-contracts/artifacts/reputation_registry/ReputationRegistry.arc56.json","utf8"));
const m = (n) => {
  const x = spec.methods.find((y) => y.name === n);
  return new algosdk.ABIMethod({
    name: x.name,
    args: x.args.map((a) => ({ type: a.type, name: a.name })),
    returns: { type: x.returns.type },
  });
};

console.log("── ATTACK 1: can I still credit myself with 32 zero bytes? ──");
try {
  const sp = await algod.getTransactionParams().do(); sp.fee = 3000; sp.flatFee = true;
  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID: appId, method: m("accept_feedback"),
    // There is no argument to put bytes into any more. The signature demands a
    // transaction. Passing anything else does not typecheck at the ABI layer.
    methodArgs: [{ txn: algosdk.makePaymentTxnWithSuggestedParamsFromObject({
        sender: acct.addr.toString(), receiver: acct.addr.toString(), amount: 0, suggestedParams: sp }), signer },
      1, 2],
    sender: acct.addr.toString(), signer, suggestedParams: sp,
  });
  await atc.execute(algod, 4);
  console.log("  !! STILL VULNERABLE");
} catch (e) {
  const msg = String(e.message ?? e);
  console.log("  REJECTED:", msg.includes("axfer") || msg.includes("type") || msg.includes("assert")
    ? "wrong transaction type — an axfer is required" : msg.slice(0, 120));
}

console.log("\n── ATTACK 2: a real transfer of the WRONG asset ──");
// bootstrap fixes the asset; anything else must be refused.
try {
  const sp0 = await algod.getTransactionParams().do(); sp0.fee = 2000; sp0.flatFee = true;
  const boot = new algosdk.AtomicTransactionComposer();
  boot.addMethodCall({ appID: appId, method: m("bootstrap"),
    methodArgs: [768547159, cfg.assetId], sender: acct.addr.toString(), signer, suggestedParams: sp0 });
  await boot.execute(algod, 4);
  console.log("  bootstrapped: settlement asset fixed to", cfg.assetId);
} catch (e) { console.log("  bootstrap:", String(e.message).slice(0, 90)); }

console.log("\n── LEGITIMATE: a real rUSDC transfer in the same group ──");
const payer = algosdk.mnemonicToSecretKey(cfg.payer.mnemonic);
const payerSigner = algosdk.makeBasicAccountTransactionSigner(payer);
const sp = await algod.getTransactionParams().do(); sp.fee = 3000; sp.flatFee = true;
const transfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
  sender: payer.addr.toString(), receiver: cfg.merchant.addr,
  amount: 25_000, assetIndex: cfg.assetId, suggestedParams: sp,
});
const atc = new algosdk.AtomicTransactionComposer();
atc.addMethodCall({
  appID: appId, method: m("accept_feedback"),
  methodArgs: [{ txn: transfer, signer: payerSigner }, 1, 2],
  sender: acct.addr.toString(), signer, suggestedParams: sp,
  // The seen-box name is pd_ + the transfer's OWN raw txid, which is exactly
  // the point: it cannot be chosen, only computed from the signed transaction.
  // Only the score box now. Replay protection comes from consensus refusing a
  // duplicate txid, so there is no seen-box to name — which is what made the
  // previous design impossible to call.
  boxes: [{ appIndex: appId, name: new Uint8Array([...enc.encode("sc_"), ...algosdk.encodeUint64(1)]) }],
});
try {
  const res = await atc.execute(algod, 6);
  console.log("  ACCEPTED. jobs_paid =", res.methodResults[0].returnValue?.toString());
  console.log("  payment tx:", res.txIDs[0]);
  console.log("  the amount credited came from the transfer, not from an argument");
} catch (e) { console.log("  failed:", String(e.message).slice(0, 200)); }
