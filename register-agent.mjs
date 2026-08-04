/**
 * Bind the deployed agent to an on-chain identity.
 *
 * The A2A card published at /.well-known/agent.json carries a registry
 * extension, and ripar-skills' own parser warns when that extension names an
 * agentId of 0 — "nothing on chain backs it". This is what stops that being
 * true: the account that receives payment registers itself under the domain it
 * actually serves from, so a caller can resolve the domain, get an id, read the
 * reputation attached to that id, and only then decide to pay.
 *
 * new_agent takes the address from Txn.sender rather than an argument, so the
 * key that signs here IS the identity. That is why the registering account and
 * the payout account have to be the same one.
 */
import algosdk from "algosdk";
import fs from "node:fs";

const cfg = JSON.parse(fs.readFileSync("/tmp/testnet-e2e.json", "utf8"));
const IDENTITY_APP = 768_547_159;
const DOMAIN = "ripar-agent.vercel.app";

const algod = new algosdk.Algodv2("", "https://testnet-api.algonode.cloud", "");
const acct = algosdk.mnemonicToSecretKey(cfg.merchant.mnemonic);
const addr = acct.addr.toString();

console.log("── registering ──");
console.log("  address:", addr);
console.log("  domain :", DOMAIN);

const info = await algod.accountInformation(addr).do();
console.log("  balance:", Number(info.amount) / 1e6, "ALGO");

/* Already registered? new_agent asserts one identity per address, so a second
   run would fail on chain rather than quietly duplicating. Check first. */
const boxName = (prefix, addrStr) =>
  new Uint8Array([...Buffer.from(prefix), ...algosdk.decodeAddress(addrStr).publicKey]);

let existing = null;
try {
  const box = await algod.getApplicationBoxByName(IDENTITY_APP, boxName("ad_", addr)).do();
  existing = Number(Buffer.from(box.value).readBigUInt64BE(0));
} catch {
  /* no box means not registered, which is the expected path */
}

if (existing) {
  console.log("\n  already registered as agent", existing);
  process.exit(0);
}

/* The record box is keyed by the id the contract is ABOUT to mint, which is
   agent_count + 1. Declaring `ag_` + zeros instead fails with "invalid Box
   reference" — the reference has to name the exact box the program touches. */
const app = await algod.getApplicationByID(IDENTITY_APP).do();
const countState = (app.params.globalState ?? []).find(
  (s) => Buffer.from(s.key, "base64").toString("utf8") === "agent_count"
);
const nextId = Number(countState?.value?.uint ?? 0) + 1;
console.log("  next id:", nextId);

const idBox = Buffer.alloc(8);
idBox.writeBigUInt64BE(BigInt(nextId));

const sp = await algod.getTransactionParams().do();
const atc = new algosdk.AtomicTransactionComposer();
const signer = algosdk.makeBasicAccountTransactionSigner(acct);

const method = new algosdk.ABIMethod({
  name: "new_agent",
  args: [{ type: "string", name: "agent_domain" }],
  returns: { type: "uint64" },
});

atc.addMethodCall({
  appID: IDENTITY_APP,
  method,
  methodArgs: [DOMAIN],
  sender: acct.addr,
  signer,
  // Two boxes are written: the record keyed by id, and the two reverse indexes.
  // Under-declaring here is the "box not available" failure, not a fee problem.
  boxes: [
    { appIndex: IDENTITY_APP, name: boxName("ad_", addr) },
    { appIndex: IDENTITY_APP, name: new Uint8Array([...Buffer.from("dm_"), ...Buffer.from(DOMAIN)]) },
    { appIndex: IDENTITY_APP, name: new Uint8Array([...Buffer.from("ag_"), ...idBox]) },
  ],
  suggestedParams: { ...sp, fee: 3000, flatFee: true },
});

const result = await atc.execute(algod, 6);
const agentId = Number(result.methodResults[0].returnValue);

console.log("\n  registered as agent id:", agentId);
console.log("  txid   :", result.txIDs[0]);
console.log("  explorer: https://lora.algokit.io/testnet/transaction/" + result.txIDs[0]);

/* Read it straight back off the chain rather than trusting the return value. */
const check = await algod
  .getApplicationBoxByName(IDENTITY_APP, boxName("ad_", addr))
  .do()
  .then((b) => Number(Buffer.from(b.value).readBigUInt64BE(0)));

console.log("\n── read back from chain ──");
console.log("  resolve_by_address ->", check);
console.log(check === agentId ? "  matches" : "  MISMATCH");
process.exit(check === agentId ? 0 : 1);
