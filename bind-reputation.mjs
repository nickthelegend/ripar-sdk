/**
 * Feed the REAL settlement txid into the ReputationRegistry.
 *
 * This is the point of the whole design: the agent's score goes up because a
 * payment moved on a public chain, and the registry refuses the same txid twice.
 */
import algosdk from "algosdk";
import fs from "node:fs";

const reg = JSON.parse(fs.readFileSync("/tmp/registries.json", "utf8"));
const settle = JSON.parse(fs.readFileSync("/tmp/last-settlement.json", "utf8"));
const acct = algosdk.mnemonicToSecretKey(
  JSON.parse(fs.readFileSync("/tmp/mainnet-payer.json", "utf8")).mnemonic
);
const algod = new algosdk.Algodv2("", "https://testnet-api.algonode.cloud", "");
const signer = algosdk.makeBasicAccountTransactionSigner(acct);
const enc = new TextEncoder();

const arc = JSON.parse(fs.readFileSync(
  "/Volumes/Extreme SSD/Projects/ripar/ripar-contracts/artifacts/reputation_registry/ReputationRegistry.arc56.json", "utf8"));
const m = (name) => {
  const x = arc.methods.find((y) => y.name === name);
  return new algosdk.ABIMethod({
    name: x.name,
    args: x.args.map((a) => ({ type: a.type, name: a.name })),
    returns: { type: x.returns.type },
  });
};

// A transaction id is base32 in the explorer but 32 raw bytes onchain.
const txidBytes = new Uint8Array(algosdk.decodeAddress(
  algosdk.encodeAddress(Buffer.from(settle.txid, "base64url").length === 32
    ? Buffer.from(settle.txid, "base64url")
    : new Uint8Array(32))
).publicKey);
const raw = algosdk.base32DecodeNoPadding
  ? algosdk.base32DecodeNoPadding(settle.txid)
  : txidBytes;

const AGENT_ID = 1;
const sp = await algod.getTransactionParams().do();
sp.fee = 4000; sp.flatFee = true;
const atc = new algosdk.AtomicTransactionComposer();
atc.addMethodCall({
  appID: reg.ReputationRegistry.appId,
  method: m("accept_feedback"),
  methodArgs: [AGENT_ID, 99, raw, 10_000],
  sender: acct.addr.toString(), signer, suggestedParams: sp,
  boxes: [
    { appIndex: reg.ReputationRegistry.appId, name: new Uint8Array([...enc.encode("sc_"), ...algosdk.encodeUint64(AGENT_ID)]) },
    { appIndex: reg.ReputationRegistry.appId, name: new Uint8Array([...enc.encode("pd_"), ...raw]) },
  ],
});
const res = await atc.execute(algod, 6);
console.log("  credited from the REAL settlement", settle.txid.slice(0, 16) + "…");
console.log("  jobs_paid now:", res.methodResults[0].returnValue?.toString());
console.log("  reputation tx:", res.txIDs[0]);
