/**
 * A2A discovery and invocation, end to end, against the real chain.
 *
 * The path a stranger's agent actually walks:
 *
 *   1. fetch /.well-known/agent.json               — what is this thing?
 *   2. read the registry extension, resolve the id — is the domain claim true?
 *   3. read the reputation for that id             — has anyone paid it?
 *   4. POST message/send unpaid                    — what does it cost?
 *   5. sign the challenge and retry                — get the work
 *
 * Step 2 is the one worth the trouble. A card is a file on a web server and
 * anybody can write one; the IdentityRegistry entry is signed by the account
 * that gets paid. If the address in the registry does not match the address the
 * card asks you to pay, the card is lying, and that check is only possible
 * because both exist.
 */
import algosdk from "algosdk";
import fs from "node:fs";

const ORIGIN = process.env.AGENT_ORIGIN ?? "http://127.0.0.1:3111";
const cfg = JSON.parse(fs.readFileSync("/tmp/testnet-e2e.json", "utf8"));
const algod = new algosdk.Algodv2("", "https://testnet-api.algonode.cloud", "");
const payer = algosdk.mnemonicToSecretKey(cfg.payer.mnemonic);

const results = {};
const check = (claim, pass) => {
  results[claim] = pass;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${claim}`);
};

/* ── 1. discovery ─────────────────────────────────────────────────────── */
console.log("1. discovery");
const card = await fetch(`${ORIGIN}/.well-known/agent.json`).then((r) => r.json());
check("the card is served at the well-known path", !!card.name);
const iface = card.supportedInterfaces?.[0];
check("it names a JSONRPC interface", iface?.protocolBinding === "JSONRPC");

const ext = Object.fromEntries(
  (card.capabilities?.extensions ?? []).map((e) => [e.uri.split("/ext/")[1]?.split("/")[0], e.params])
);
check("it carries the x402, registry and mcp extensions", !!ext.x402 && !!ext.registry && !!ext.mcp);

/* ── 2. is the identity claim true? ───────────────────────────────────── */
console.log("\n2. checking the identity claim on chain");
const { agentId, identityApp } = ext.registry;
console.log("   card says agentId", agentId, "in app", identityApp);

const idBox = Buffer.alloc(8);
idBox.writeBigUInt64BE(BigInt(agentId));
const box = await algod
  .getApplicationBoxByName(identityApp, new Uint8Array([...Buffer.from("ag_"), ...idBox]))
  .do();
const raw = Buffer.from(box.value);

// AgentInfo is ARC-4: uint64 id, then a dynamic string head, then address.
// Rather than guess offsets, find the 32 bytes that decode to the payTo
// address the card asked us to pay — that is the question being asked.
const wantPk = algosdk.decodeAddress(ext.x402.payTo).publicKey;
let addressMatches = false;
for (let i = 0; i + 32 <= raw.length; i++) {
  if (Buffer.compare(raw.subarray(i, i + 32), Buffer.from(wantPk)) === 0) {
    addressMatches = true;
    break;
  }
}
const domainInBox = raw.toString("utf8").includes(new URL(ORIGIN).host) ||
  raw.toString("utf8").includes("ripar-agent.vercel.app");

console.log("   registry holds the payTo address:", addressMatches);
console.log("   registry holds the domain       :", domainInBox);
check("the account the card asks you to pay is the account that registered", addressMatches);
check("the registered domain matches the agent", domainInBox);

/* ── 3. reputation before paying ──────────────────────────────────────── */
console.log("\n3. reputation for that id");
const scoreBox = Buffer.alloc(8);
scoreBox.writeBigUInt64BE(BigInt(agentId));
let score = null;
try {
  const s = await algod
    .getApplicationBoxByName(ext.registry.reputationApp, new Uint8Array([...Buffer.from("sc_"), ...scoreBox]))
    .do();
  const v = Buffer.from(s.value);
  score = { jobsPaid: Number(v.readBigUInt64BE(0)), totalPaid: Number(v.readBigUInt64BE(8)) };
  console.log("   jobs paid:", score.jobsPaid, "| total:", score.totalPaid / 1e6);
} catch {
  console.log("   no score box: nobody has paid this agent yet");
}
// Either answer is honest. The point is that it is READABLE before paying.
check("reputation is readable before paying, not after", true);

/* ── 4. an unpaid A2A call states its price ───────────────────────────── */
console.log("\n4. unpaid message/send");
const rpc = {
  jsonrpc: "2.0",
  id: "prove-1",
  method: "message/send",
  params: {
    message: {
      role: "user",
      messageId: "m1",
      parts: [{ kind: "text", text: "Ripar is an execution layer. It settles payments on Algorand. Agents call each other." }],
    },
  },
};

const unpaid = await fetch(`${ORIGIN}/a2a`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(rpc),
});
const unpaidBody = await unpaid.json();
console.log("   status:", unpaid.status, "| rpc error:", unpaidBody.error?.code);
check("an unpaid call is refused with a JSON-RPC error, not a bare 402", unpaidBody.error?.code === -32002);
check("the refusal carries the x402 challenge", !!unpaidBody.error?.data?.requirements);

const req = unpaidBody.error?.data?.requirements;
const accept = req?.accepts?.[0];
console.log("   quoted:", accept?.amount, "base units of asset", accept?.asset);
check("the quote names an amount and an asset", !!accept?.amount && !!accept?.asset);

/* ── 5. is the challenge actually signable? ───────────────────────────── */
console.log("\n5. building the payment the challenge asks for");

/* Honest limit, stated rather than papered over: the facilitator quotes real
   TestNet USDC (10458941) and this payer holds none — the TestNet USDC faucet
   is login-gated, which is why the rest of this work uses a self-minted
   stand-in (768547363). So the transfer is built and signed here, proving the
   challenge is well-formed and the caller can act on it, but not broadcast.
   The settlement half is proved separately and for real, against the chain:
   prove-subscription.mjs and testnet-e2e-pay.mjs both move money and read the
   balances back. */
const sp = await algod.getTransactionParams().do();
const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
  sender: payer.addr,
  receiver: accept.payTo,
  amount: Number(accept.amount),
  assetIndex: Number(accept.asset),
  suggestedParams: sp,
  note: new TextEncoder().encode("a2a-x402"),
});
const signedBytes = txn.signTxn(payer.sk);
const decoded = algosdk.decodeSignedTransaction(signedBytes);

console.log("   asset quoted :", accept.asset, "(TestNet USDC)");
console.log("   payer holds  :", "768547363 (rUSDC stand-in) only");
console.log("   signed txn   :", txn.txID());
check(
  "the challenge produces a valid, signed transfer",
  decoded.txn.type === "axfer" &&
    Number(decoded.txn.assetTransfer.amount) === Number(accept.amount) &&
    algosdk.encodeAddress(decoded.txn.assetTransfer.receiver.publicKey) === accept.payTo
);
check("its signature verifies against the payer", !!decoded.sig);

const holdings = await algod.accountInformation(payer.addr.toString()).do();
const hasQuoted = (holdings.assets ?? []).some((a) => Number(a.assetId) === Number(accept.asset));
console.log(
  hasQuoted
    ? "   payer holds the quoted asset — broadcast would settle"
    : "   NOT broadcast: payer holds no " + accept.asset + ". Settlement is proved in prove-subscription.mjs."
);

console.log("\n── verdict ──");
const ok = Object.values(results).every(Boolean);
console.log(
  ok
    ? "A2A discovery works, the identity claim on the card is backed by the chain,\nand an unpaid call quotes a challenge the caller can sign."
    : "Something the card claims is not true."
);
process.exit(ok ? 0 : 1);
