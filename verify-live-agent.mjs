/**
 * Pay the DEPLOYED agent, then turn that payment into reputation.
 *
 * verify-e2e.mjs proves the SDK against the chain, but it runs createServer in
 * process. This one touches nothing local: it pays https://api.ripar.io, the
 * same URL a stranger would, and then feeds that settled transfer to the
 * ReputationRegistry.
 *
 * That second half is the point. Settling and being credited are different
 * things, and until the endpoint quoted the registry's asset they could not
 * both happen to the same payment — accept_feedback asserts the settlement
 * asset, so a USDC payment landed correctly and could never reach a score.
 * A run that only checked for HTTP 200 would have called that working.
 *
 *   node verify-live-agent.mjs
 */
import algosdk from "algosdk";
import fs from "node:fs";

const AGENT = process.env.RIPAR_AGENT_URL ?? "https://api.ripar.io";
const ENDPOINT = `${AGENT}/api/summarize`;
const CONFIG = process.env.RIPAR_E2E_CONFIG ?? "/tmp/testnet-e2e.json";

const algod = new algosdk.Algodv2("", "https://testnet-api.algonode.cloud", "");
const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
const payer = algosdk.mnemonicToSecretKey(cfg.payer.mnemonic);
const deployed = JSON.parse(
  fs.readFileSync(new URL("../ripar-contracts/DEPLOYED.json", import.meta.url), "utf8")
);
const IDENTITY = deployed.registries.IdentityRegistry.appId;
const REPUTATION = deployed.registries.ReputationRegistry.appId;
const REGISTRY_ASSET = 768_547_363;
const SERVER_ID = 1;
const CLIENT_ID = 2;

const results = [];
const step = async (name, fn, requires) => {
  if (requires && !results.find((r) => r.name === requires)?.ok) {
    results.push({ name, ok: false });
    console.log(`  SKIP  ${name}\n          needs "${requires}"`);
    return;
  }
  try {
    const d = await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}${d ? `\n          ${d}` : ""}`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name}\n          ${e.message}`);
  }
};

const M = (n, a, r) => new algosdk.ABIMethod({ name: n, args: a, returns: { type: r } });
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};
const box = (app, p, raw) => ({ appIndex: app, name: new Uint8Array([...Buffer.from(p), ...raw]) });

async function call({ appId, method, args, sender = payer, boxes = [], fee = 3000, foreignApps = [], extra }) {
  const sp = await algod.getTransactionParams().do();
  const atc = new algosdk.AtomicTransactionComposer();
  if (extra) atc.addTransaction(extra);
  atc.addMethodCall({
    appID: appId,
    method,
    methodArgs: args,
    sender: sender.addr,
    signer: algosdk.makeBasicAccountTransactionSigner(sender),
    boxes,
    appForeignApps: foreignApps,
    suggestedParams: { ...sp, fee, flatFee: true },
  });
  return (await atc.execute(algod, 6)).methodResults[0].returnValue;
}

const readScore = async (id) => {
  const v = (
    await call({
      appId: REPUTATION,
      method: M("get_score", [{ type: "uint64" }], "(uint64,uint64,uint64,uint64,uint64,uint64,uint64)"),
      args: [id],
      boxes: [box(REPUTATION, "sc_", u64(id))],
    })
  ).map(Number);
  // (agent_id, jobs_paid, volume_micro, validated, disputed, first_at, last_at)
  return { agentId: v[0], jobsPaid: v[1], volume: v[2] };
};

console.log(`\n  Ripar live agent — ${ENDPOINT}\n`);

let quote;
await step("the deployed endpoint offers the registry's asset as a way to pay", async () => {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "the quick brown fox jumps over the lazy dog" }),
  });
  if (res.status !== 402) throw new Error(`expected 402, got ${res.status}`);
  const hdr = res.headers.get("payment-required");
  if (!hdr) throw new Error("no PAYMENT-REQUIRED header");
  const accepts = JSON.parse(Buffer.from(hdr, "base64").toString()).accepts;
  quote = accepts.find((a) => Number(a.asset) === REGISTRY_ASSET);
  if (!quote) {
    throw new Error(
      `offers ${accepts.map((a) => a.asset).join(", ")} — none is ${REGISTRY_ASSET}, so no payment here can be credited`
    );
  }
  return `${accepts.length} option(s); option for asset ${quote.asset} at ${quote.maxAmountRequired ?? quote.amount} units`;
});

let txid, amount;
await step(
  "a real payment to the deployed agent settles on chain",
  async () => {
    amount = Number(quote.maxAmountRequired ?? quote.amount);
    const sp = await algod.getTransactionParams().do();
    const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: payer.addr,
      receiver: quote.payTo,
      amount,
      assetIndex: REGISTRY_ASSET,
      suggestedParams: sp,
    });
    const header = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        accepted: quote,
        scheme: "exact",
        network: quote.network,
        payload: { paymentGroup: [Buffer.from(txn.signTxn(payer.sk)).toString("base64")], paymentIndex: 0 },
      })
    ).toString("base64");

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": header },
      body: JSON.stringify({ text: "the quick brown fox jumps over the lazy dog" }),
    });
    const body = await res.text();
    if (res.status !== 200) throw new Error(`${res.status}: ${body.slice(0, 250)}`);
    const receipt = res.headers.get("payment-response");
    if (!receipt) throw new Error("200 with no PAYMENT-RESPONSE receipt");
    txid = JSON.parse(Buffer.from(receipt, "base64").toString()).transaction;
    if (!txid) throw new Error("receipt names no transaction");
    // The work has to actually come back, or this proved a turnstile.
    const answer = JSON.parse(body);
    if (!answer.summary && !answer.result) throw new Error(`paid, but got no work back: ${body.slice(0, 150)}`);
    return `200 with a summary, settled as ${txid}`;
  },
  "the deployed endpoint offers the registry's asset as a way to pay"
);

await step(
  "the chain confirms that transfer",
  async () => {
    let tx = null;
    for (let i = 0; i < 10 && !tx; i++) {
      const r = await fetch(`https://testnet-idx.algonode.cloud/v2/transactions/${txid}`);
      if (r.ok) tx = (await r.json()).transaction;
      else await new Promise((s) => setTimeout(s, 2000));
    }
    if (!tx) throw new Error(`indexer never saw ${txid}`);
    const x = tx["asset-transfer-transaction"];
    if (Number(x["asset-id"]) !== REGISTRY_ASSET) throw new Error(`settled asset ${x["asset-id"]}`);
    if (Number(x.amount) !== amount) throw new Error(`settled ${x.amount}, quoted ${amount}`);
    if (x.receiver !== quote.payTo) throw new Error(`paid ${x.receiver}, not the quoted payTo`);
    return `round ${tx["confirmed-round"]}, ${x.amount} units → ${x.receiver.slice(0, 12)}…`;
  },
  "a real payment to the deployed agent settles on chain"
);

await step(
  "that payment credits the agent's on-chain reputation",
  async () => {
    const before = await readScore(SERVER_ID);
    const sp = await algod.getTransactionParams().do();
    const transfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: payer.addr,
      receiver: quote.payTo,
      amount,
      assetIndex: REGISTRY_ASSET,
      suggestedParams: sp,
    });
    await call({
      appId: REPUTATION,
      method: M("accept_feedback", [{ type: "axfer" }, { type: "uint64" }, { type: "uint64" }], "uint64"),
      args: [{ txn: transfer, signer: algosdk.makeBasicAccountTransactionSigner(payer) }, SERVER_ID, CLIENT_ID],
      fee: 6000,
      foreignApps: [IDENTITY],
      boxes: [
        box(REPUTATION, "sc_", u64(SERVER_ID)),
        box(IDENTITY, "ag_", u64(SERVER_ID)),
        box(IDENTITY, "ag_", u64(CLIENT_ID)),
      ],
    });
    const after = await readScore(SERVER_ID);
    if (after.jobsPaid !== before.jobsPaid + 1) {
      throw new Error(`jobs_paid ${before.jobsPaid} → ${after.jobsPaid}, expected +1`);
    }
    if (after.volume !== before.volume + amount) {
      throw new Error(`volume moved ${after.volume - before.volume}, paid ${amount}`);
    }
    return `agent ${SERVER_ID}: jobs_paid ${before.jobsPaid} → ${after.jobsPaid}, volume +${amount}`;
  },
  "the chain confirms that transfer"
);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n  ${results.length - failed}/${results.length} steps passed\n`);
process.exit(failed ? 1 : 0);
