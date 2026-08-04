import algosdk from "algosdk";
import fs from "node:fs";
import crypto from "node:crypto";

const reg = JSON.parse(fs.readFileSync("/tmp/registries.json", "utf8"));
const acct = algosdk.mnemonicToSecretKey(
  JSON.parse(fs.readFileSync("/tmp/mainnet-payer.json", "utf8")).mnemonic
);
const algod = new algosdk.Algodv2("", "https://testnet-api.algonode.cloud", "");
const signer = algosdk.makeBasicAccountTransactionSigner(acct);

const spec = (dir, name) =>
  JSON.parse(fs.readFileSync(`/Volumes/Extreme SSD/Projects/ripar/ripar-contracts/artifacts/${dir}/${name}.arc56.json`, "utf8"));

function methodFrom(arc56, name) {
  const m = arc56.methods.find((x) => x.name === name);
  return new algosdk.ABIMethod({
    name: m.name,
    args: m.args.map((a) => ({ type: a.type, name: a.name })),
    returns: { type: m.returns.type },
  });
}

async function call({ appId, arc56, name, args, boxes = [] }) {
  const sp = await algod.getTransactionParams().do();
  sp.fee = 4000; sp.flatFee = true;
  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID: appId, method: methodFrom(arc56, name), methodArgs: args,
    sender: acct.addr.toString(), signer, suggestedParams: sp,
    boxes: boxes.map((n) => ({ appIndex: appId, name: n })),
  });
  const res = await atc.execute(algod, 6);
  return { ret: res.methodResults[0]?.returnValue, txid: res.txIDs[0] };
}

const idArc = spec("identity", "IdentityRegistry");
const repArc = spec("reputation_registry", "ReputationRegistry");
const valArc = spec("validation_registry", "ValidationRegistry");

const enc = new TextEncoder();
const domain = `agent-${Date.now()}.ripar.io`;

console.log("── 1. register an agent (IdentityRegistry) ──");
const r1 = await call({
  appId: reg.IdentityRegistry.appId, arc56: idArc, name: "new_agent",
  args: [domain],
  boxes: [
    new Uint8Array([...enc.encode("dm_"), ...enc.encode(domain)]),
    new Uint8Array([...enc.encode("ad_"), ...acct.addr.publicKey]),
    new Uint8Array([...enc.encode("ag_"), ...algosdk.encodeUint64(1)]),
  ],
});
const agentId = Number(r1.ret);
console.log(`   agentId ${agentId}  domain ${domain}`);
console.log(`   tx ${r1.txid}`);

console.log("── 2. post a job (ValidationRegistry) ──");
const specHash = new Uint8Array(crypto.createHash("sha256").update("enrich 5000 addresses").digest());
const r2 = await call({
  appId: reg.ValidationRegistry.appId, arc56: valArc, name: "post_job",
  args: [specHash, 2_500_000, 0],
  boxes: [new Uint8Array([...enc.encode("jb_"), ...algosdk.encodeUint64(1)])],
});
const jobId = Number(r2.ret);
console.log(`   jobId ${jobId}  budget 2.50 USDC  tx ${r2.txid}`);

console.log("── 3. assign it to the agent ──");
const r3 = await call({
  appId: reg.ValidationRegistry.appId, arc56: valArc, name: "assign_job",
  args: [jobId, agentId],
  boxes: [new Uint8Array([...enc.encode("jb_"), ...algosdk.encodeUint64(jobId)])],
});
console.log(`   assigned  tx ${r3.txid}`);

console.log("── 4. credit reputation from a settled payment ──");
const fakeTxid = new Uint8Array(crypto.randomBytes(32));
const r4 = await call({
  appId: reg.ReputationRegistry.appId, arc56: repArc, name: "accept_feedback",
  args: [agentId, 99, fakeTxid, 10_000],
  boxes: [
    new Uint8Array([...enc.encode("sc_"), ...algosdk.encodeUint64(agentId)]),
    new Uint8Array([...enc.encode("pd_"), ...fakeTxid]),
  ],
});
console.log(`   jobs_paid now ${r4.ret}  tx ${r4.txid}`);

console.log("── 5. the SAME payment must not count twice ──");
try {
  await call({
    appId: reg.ReputationRegistry.appId, arc56: repArc, name: "accept_feedback",
    args: [agentId, 99, fakeTxid, 10_000],
    boxes: [
      new Uint8Array([...enc.encode("sc_"), ...algosdk.encodeUint64(agentId)]),
      new Uint8Array([...enc.encode("pd_"), ...fakeTxid]),
    ],
  });
  console.log("   !! REPLAY SUCCEEDED — the anti-inflation guard is broken");
} catch {
  console.log("   rejected ✓  reputation cannot be inflated by replaying a payment");
}
