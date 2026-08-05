/**
 * Every workflow, end to end, against the real chain and the real facilitator.
 *
 * The unit suites cover each piece and the integration test wires them through
 * one createServer, but both stop at the network boundary: the facilitator is
 * doubled and nothing settles. This is the file that spends real money.
 *
 * It settles in Ripar Test USDC (768547363) rather than TestNet USDC, because
 * that is the asset the deployed ReputationRegistry is pinned to —
 * accept_feedback asserts `payment.xfer_asset.id == self.usdc_asset`, and
 * bootstrap is one-shot, so nothing can re-point it. Settling in USDC here
 * would prove the HTTP half and then fail at the contract, which is exactly the
 * seam this run exists to measure.
 *
 * Every step either happens on chain or is reported as not having happened.
 * Nothing is stubbed. Run:  node verify-e2e.mjs
 */
import algosdk from "algosdk";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "./dist/server.js";
import { defineAgent, defineEndpoint } from "./dist/define.js";

const CONFIG = process.env.RIPAR_E2E_CONFIG ?? "/tmp/testnet-e2e.json";
const FACILITATOR = process.env.FACILITATOR_URL ?? "https://facilitator.goplausible.xyz";
const ALGOD = new algosdk.Algodv2("", "https://testnet-api.algonode.cloud", "");

const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
const ASSET = Number(cfg.assetId);
const merchant = algosdk.mnemonicToSecretKey(cfg.merchant.mnemonic);
const payer = algosdk.mnemonicToSecretKey(cfg.payer.mnemonic);

const results = [];
const step = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? "" });
    console.log(`  PASS  ${name}${detail ? `\n          ${detail}` : ""}`);
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
    console.log(`  FAIL  ${name}\n          ${err.message}`);
  }
};

const holdings = async (addr) => {
  const a = await ALGOD.accountInformation(addr).do();
  const h = (a.assets ?? []).find((x) => Number(x.assetId ?? x["asset-id"]) === ASSET);
  return { algo: Number(a.amount), asa: h ? Number(h.amount) : null };
};

console.log(`\n  Ripar end-to-end — TestNet, asset ${ASSET}, facilitator ${FACILITATOR}\n`);

/* ── 0. preflight ───────────────────────────────────────────────────────── */

let before;
await step("both accounts can transact and hold the settlement asset", async () => {
  const m = await holdings(merchant.addr);
  const p = await holdings(payer.addr);
  if (m.asa == null) throw new Error(`merchant is not opted into ${ASSET}`);
  if (p.asa == null) throw new Error(`payer is not opted into ${ASSET}`);
  if (p.algo < 3000) throw new Error(`payer has ${p.algo} microAlgo, not enough for fees`);
  before = { m, p };
  return `merchant ${(m.asa / 1e6).toFixed(2)}, payer ${(p.asa / 1e6).toFixed(2)} units of ${ASSET}`;
});

/* ── 1. a real server, priced in the asset the registries understand ────── */

const PRICE_UNITS = 10_000; // 0.01 at six decimals
let base, close;
await step("createServer boots against the live facilitator", async () => {
  const agent = defineAgent({
    name: "Ripar E2E",
    handle: "ripar-e2e",
    payTo: merchant.addr.toString(),
    network: "testnet",
    endpoints: [
      defineEndpoint({
        name: "summarize",
        description: "Summarise text.",
        price: { asset: String(ASSET), amount: "0.01", decimals: 6, symbol: "rUSDC" },
        input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        handler: ({ body }) => ({ summary: String(body?.text ?? "").slice(0, 40) }),
      }),
    ],
  });
  const app = await createServer(agent, {
    network: "testnet",
    payTo: merchant.addr.toString(),
    facilitatorUrl: FACILITATOR,
    logging: { level: "error", write: () => {} },
  });
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  close = () => new Promise((r) => server.close(() => r()));
  return base;
});

/* ── 2. discovery ───────────────────────────────────────────────────────── */

await step("serves its own manifest, naming the asset and the address", async () => {
  const mf = await (await fetch(`${base}/.well-known/ripar.json`)).json();
  const ep = (mf.endpoints ?? [])[0];
  if (!ep) throw new Error("manifest lists no endpoints");
  if (mf.payTo !== merchant.addr.toString()) throw new Error(`manifest payTo is ${mf.payTo}`);
  return `${mf.endpoints.length} endpoint(s), payTo ${mf.payTo.slice(0, 12)}…`;
});

/* ── 3. the quote ───────────────────────────────────────────────────────── */

let accepted;
await step("answers an unpaid call with a readable 402 quote", async () => {
  const res = await fetch(`${base}/summarize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "the quick brown fox jumps over the lazy dog" }),
  });
  if (res.status !== 402) throw new Error(`expected 402, got ${res.status}`);
  const hdr = res.headers.get("payment-required");
  if (!hdr) throw new Error("no PAYMENT-REQUIRED header");
  accepted = JSON.parse(Buffer.from(hdr, "base64").toString()).accepts[0];
  if (Number(accepted.asset) !== ASSET) throw new Error(`quoted asset ${accepted.asset}, expected ${ASSET}`);
  if (Number(accepted.maxAmountRequired ?? accepted.amount) !== PRICE_UNITS) {
    throw new Error(`quoted ${accepted.maxAmountRequired ?? accepted.amount}, expected ${PRICE_UNITS}`);
  }
  return `asset ${accepted.asset}, ${accepted.maxAmountRequired ?? accepted.amount} units, network ${accepted.network}`;
});

/* ── 4. pay it, for real ────────────────────────────────────────────────── */

let settleTxid, paidBody;
await step("a signed transfer is verified, settled ON CHAIN, and answered", async () => {
  const sp = await ALGOD.getTransactionParams().do();
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: payer.addr,
    receiver: merchant.addr,
    amount: PRICE_UNITS,
    assetIndex: ASSET,
    suggestedParams: sp,
  });
  const signed = Buffer.from(txn.signTxn(payer.sk)).toString("base64");
  const header = Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted,
      scheme: "exact",
      network: accepted.network,
      payload: { paymentGroup: [signed], paymentIndex: 0 },
    })
  ).toString("base64");

  const res = await fetch(`${base}/summarize`, {
    method: "POST",
    headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": header },
    body: JSON.stringify({ text: "the quick brown fox jumps over the lazy dog" }),
  });
  paidBody = await res.text();
  if (res.status !== 200) throw new Error(`paid call answered ${res.status}: ${paidBody.slice(0, 300)}`);
  const receipt = res.headers.get("payment-response");
  if (!receipt) throw new Error("settled with no PAYMENT-RESPONSE receipt");
  const parsed = JSON.parse(Buffer.from(receipt, "base64").toString());
  settleTxid = parsed.transaction;
  if (!settleTxid) throw new Error(`receipt carries no transaction id: ${JSON.stringify(parsed)}`);
  return `200, receipt txid ${settleTxid}`;
});

/* ── 5. the chain agrees ────────────────────────────────────────────────── */

await step("that transaction is really on chain, for the quoted amount", async () => {
  if (!settleTxid) throw new Error("no txid from the previous step");
  let found = null;
  for (let i = 0; i < 10 && !found; i++) {
    const res = await fetch(`https://testnet-idx.algonode.cloud/v2/transactions/${settleTxid}`);
    if (res.ok) found = (await res.json()).transaction;
    else await new Promise((r) => setTimeout(r, 2000));
  }
  if (!found) throw new Error(`indexer never saw ${settleTxid}`);
  const x = found["asset-transfer-transaction"];
  if (!x) throw new Error("that txid is not an asset transfer");
  if (Number(x["asset-id"]) !== ASSET) throw new Error(`settled asset ${x["asset-id"]}`);
  if (Number(x.amount) !== PRICE_UNITS) throw new Error(`settled ${x.amount}, quoted ${PRICE_UNITS}`);
  if (x.receiver !== merchant.addr.toString()) throw new Error(`paid ${x.receiver}, not the merchant`);
  if (found.sender !== payer.addr.toString()) throw new Error(`sent by ${found.sender}, not the payer`);
  return `round ${found["confirmed-round"]}, ${x.amount} units ${found.sender.slice(0, 10)}… → ${x.receiver.slice(0, 10)}…`;
});

/* ── 6. the money actually moved ────────────────────────────────────────── */

await step("the merchant's balance went up by exactly the quoted price", async () => {
  const after = await holdings(merchant.addr);
  const moved = after.asa - before.m.asa;
  if (moved !== PRICE_UNITS) throw new Error(`balance moved ${moved}, quoted ${PRICE_UNITS}`);
  return `${before.m.asa} → ${after.asa} (+${moved})`;
});

/* ── 7. that payment credits reputation ─────────────────────────────────── */

const REG = JSON.parse(
  fs.readFileSync("/Volumes/Extreme SSD/Projects/ripar/ripar-contracts/DEPLOYED.json", "utf8")
).registries;
const IDENTITY = REG.IdentityRegistry.appId;
const REPUTATION = REG.ReputationRegistry.appId;
const VALIDATION = REG.ValidationRegistry.appId;
const SERVER_ID = 1; // merchant
const CLIENT_ID = 2; // payer

const M = (name, args, ret) => new algosdk.ABIMethod({ name, args, returns: { type: ret } });
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};
const box = (app, prefix, raw) => ({ appIndex: app, name: new Uint8Array([...Buffer.from(prefix), ...raw]) });

async function call({ appId, method, args, sender = merchant, boxes = [], fee = 3000, foreignApps = [], assets = [], accounts = [] }) {
  const sp = await ALGOD.getTransactionParams().do();
  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID: appId,
    method,
    methodArgs: args,
    sender: sender.addr,
    signer: algosdk.makeBasicAccountTransactionSigner(sender),
    boxes,
    appForeignApps: foreignApps,
    appForeignAssets: assets,
    appAccounts: accounts,
    suggestedParams: { ...sp, fee, flatFee: true },
  });
  const r = await atc.execute(ALGOD, 6);
  return { value: r.methodResults[0].returnValue, txId: r.txIDs.at(-1) };
}

const readScoreFor = async (agentId) => {
  const r = await call({
    appId: REPUTATION,
    method: M("get_score", [{ type: "uint64" }], "(uint64,uint64,uint64,uint64,uint64,uint64,uint64)"),
    args: [agentId],
    boxes: [box(REPUTATION, "sc_", u64(agentId))],
  });
  // Score is (agent_id, jobs_paid, volume_micro, validated, disputed,
  // first_at, last_at). Reading from index 0 gets agent_id and every later
  // field shifts by one — which reads as a plausible score rather than as an
  // error, so it has to be indexed against the struct, not guessed.
  const v = r.value.map(Number);
  return { agentId: v[0], jobsPaid: v[1], totalPaid: v[2], validated: v[3], disputed: v[4] };
};
const readScore = () => readScoreFor(SERVER_ID);

let scoreBefore;
await step("reputation reads the agent's current score from chain", async () => {
  scoreBefore = await readScore();
  if (scoreBefore.agentId !== SERVER_ID) throw new Error(`score is for agent ${scoreBefore.agentId}, not ${SERVER_ID}`);
  return `agent ${scoreBefore.agentId}: jobs_paid ${scoreBefore.jobsPaid}, volume ${scoreBefore.totalPaid}, validated ${scoreBefore.validated}, disputed ${scoreBefore.disputed}`;
});

await step("a real client-to-server payment credits reputation on chain", async () => {
  const sp = await ALGOD.getTransactionParams().do();
  const t = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: payer.addr,
    receiver: merchant.addr,
    amount: PRICE_UNITS,
    assetIndex: ASSET,
    suggestedParams: sp,
  });
  const r = await call({
    appId: REPUTATION,
    method: M("accept_feedback", [{ type: "axfer" }, { type: "uint64" }, { type: "uint64" }], "uint64"),
    args: [{ txn: t, signer: algosdk.makeBasicAccountTransactionSigner(payer) }, SERVER_ID, CLIENT_ID],
    sender: payer,
    fee: 6000,
    foreignApps: [IDENTITY],
    boxes: [
      box(REPUTATION, "sc_", u64(SERVER_ID)),
      box(IDENTITY, "ag_", u64(SERVER_ID)),
      box(IDENTITY, "ag_", u64(CLIENT_ID)),
    ],
  });
  const after = await readScore();
  if (after.jobsPaid !== scoreBefore.jobsPaid + 1) {
    throw new Error(`jobs_paid went ${scoreBefore.jobsPaid} → ${after.jobsPaid}, expected +1`);
  }
  if (after.totalPaid !== scoreBefore.totalPaid + PRICE_UNITS) {
    throw new Error(`total_paid moved ${after.totalPaid - scoreBefore.totalPaid}, expected ${PRICE_UNITS}`);
  }
  return `jobs_paid ${scoreBefore.jobsPaid} → ${after.jobsPaid}, total_paid +${PRICE_UNITS} (returned ${r.value})`;
});

await step("a payment to a third party CANNOT credit that agent", async () => {
  // The authorisation hole this contract was redeployed to close. It has to
  // stay closed, and the only way to know is to try it.
  const sp = await ALGOD.getTransactionParams().do();
  const t = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: payer.addr,
    receiver: payer.addr.toString(), // paying yourself, then claiming credit
    amount: 1000,
    assetIndex: ASSET,
    suggestedParams: sp,
  });
  try {
    await call({
      appId: REPUTATION,
      method: M("accept_feedback", [{ type: "axfer" }, { type: "uint64" }, { type: "uint64" }], "uint64"),
      args: [{ txn: t, signer: algosdk.makeBasicAccountTransactionSigner(payer) }, SERVER_ID, CLIENT_ID],
      sender: payer,
      fee: 6000,
      foreignApps: [IDENTITY],
      boxes: [
        box(REPUTATION, "sc_", u64(SERVER_ID)),
        box(IDENTITY, "ag_", u64(SERVER_ID)),
        box(IDENTITY, "ag_", u64(CLIENT_ID)),
      ],
    });
  } catch (err) {
    return `rejected: ${String(err.message).match(/assert|opcodes|rejected/i) ? "contract refused it" : err.message.slice(0, 80)}`;
  }
  throw new Error("the contract ACCEPTED a self-payment as credit — the authorisation hole is open");
});

/* ── 8. escrow, with real custody ───────────────────────────────────────── */

await step("the escrow app account can afford another job's box", async () => {
  // Every job writes a box, and a box raises the app account's minimum balance
  // permanently. Nothing tops that account up, so a registry that has been busy
  // stops accepting jobs — and algod reports it as a bare "balance below min"
  // against an address that appears nowhere in the source. Checked here so the
  // failure names itself.
  const appAddr = algosdk.getApplicationAddress(VALIDATION).toString();
  const a = await ALGOD.accountInformation(appAddr).do();
  const headroom = Number(a.amount) - Number(a.minBalance);
  // A job box plus its escrow box costs roughly 0.05 ALGO of MBR.
  if (headroom < 60_000) {
    throw new Error(
      `${appAddr.slice(0, 12)}… has ${(headroom / 1e6).toFixed(4)} ALGO of headroom; a job needs ~0.05. ` +
        `Send ALGO to that address — it is the app account, not the deployer.`
    );
  }
  return `${appAddr.slice(0, 12)}… has ${(headroom / 1e6).toFixed(4)} ALGO of headroom`;
});

let jobId;
await step("a job can be posted on chain", async () => {
  // The box the call writes is named for the id it is about to mint, and a box
  // reference has to be declared before the program runs. So the next id is
  // read first rather than guessed — an undeclared box is a hard failure, not
  // a silent miss.
  const total = await call({
    appId: VALIDATION,
    method: M("total_jobs", [], "uint64"),
    args: [],
    sender: merchant,
  });
  const next = Number(total.value);
  const r = await call({
    appId: VALIDATION,
    method: M("post_job", [{ type: "byte[]" }, { type: "uint64" }, { type: "uint64" }], "uint64"),
    // A commitment, not a label: post_job asserts the spec is exactly a 32-byte
    // sha256 digest, so the spec cannot be swapped after bids come in.
    args: [new Uint8Array(createHash("sha256").update(`ripar e2e job ${next}`).digest()), PRICE_UNITS, 0],
    sender: merchant,
    fee: 3000,
    // next and next+1: which of the two the contract mints depends on whether
    // total_jobs is a count or a high-water mark, and declaring both costs
    // nothing while guessing wrong costs the whole step.
    boxes: [box(VALIDATION, "jb_", u64(next)), box(VALIDATION, "jb_", u64(next + 1))],
  });
  jobId = Number(r.value);
  return `job ${jobId} (total_jobs was ${next})`;
});

await step("escrow takes real custody of the funds", async () => {
  const appAddr = algosdk.getApplicationAddress(VALIDATION).toString();
  const sp = await ALGOD.getTransactionParams().do();
  const t = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: merchant.addr,
    receiver: appAddr,
    amount: PRICE_UNITS,
    assetIndex: ASSET,
    suggestedParams: sp,
  });
  await call({
    appId: VALIDATION,
    method: M("fund_job", [{ type: "axfer" }, { type: "uint64" }], "uint64"),
    args: [{ txn: t, signer: algosdk.makeBasicAccountTransactionSigner(merchant) }, jobId],
    sender: merchant,
    fee: 4000,
    assets: [ASSET],
    // Escrow lives under its own prefix. The job record (jb_) and the custody
    // ledger (es_) are separate boxes, and both are touched here.
    boxes: [box(VALIDATION, "jb_", u64(jobId)), box(VALIDATION, "es_", u64(jobId))],
  });
  const held = await call({
    appId: VALIDATION,
    method: M("get_escrow", [{ type: "uint64" }], "uint64"),
    args: [jobId],
    sender: merchant,
    boxes: [box(VALIDATION, "jb_", u64(jobId)), box(VALIDATION, "es_", u64(jobId))],
  });
  if (Number(held.value) !== PRICE_UNITS) throw new Error(`escrow holds ${held.value}, funded ${PRICE_UNITS}`);
  return `app account ${appAddr.slice(0, 12)}… holds ${held.value} units for job ${jobId}`;
});

/* ── 9. the escrow lifecycle, through to the worker being paid ──────────── */

const jobBoxes = () => [box(VALIDATION, "jb_", u64(jobId)), box(VALIDATION, "es_", u64(jobId))];

await step("the job can be assigned to a registered agent", async () => {
  await call({
    appId: VALIDATION,
    method: M("assign_job", [{ type: "uint64" }, { type: "uint64" }], "bool"),
    args: [jobId, CLIENT_ID],
    sender: merchant,
    fee: 4000,
    foreignApps: [IDENTITY],
    boxes: [...jobBoxes(), box(IDENTITY, "ag_", u64(CLIENT_ID))],
  });
  return `job ${jobId} assigned to agent ${CLIENT_ID}`;
});

await step("only the assigned agent may submit the result", async () => {
  // submit_result used to check nobody at all, with a comment saying the SDK
  // would. A check in the SDK is not a check. This proves the contract's own.
  try {
    await call({
      appId: VALIDATION,
      method: M("submit_result", [{ type: "uint64" }, { type: "byte[]" }], "bool"),
      args: [jobId, new Uint8Array(createHash("sha256").update("forged").digest())],
      sender: merchant, // the client, not the assignee
      fee: 4000,
      foreignApps: [IDENTITY],
      boxes: [...jobBoxes(), box(IDENTITY, "ag_", u64(CLIENT_ID))],
    });
  } catch {
    return "an unassigned sender was refused by the contract";
  }
  throw new Error("the contract ACCEPTED a result from someone who was not assigned");
});

await step("the assigned agent submits its result", async () => {
  await call({
    appId: VALIDATION,
    method: M("submit_result", [{ type: "uint64" }, { type: "byte[]" }], "bool"),
    args: [jobId, new Uint8Array(createHash("sha256").update(`result for job ${jobId}`).digest())],
    sender: payer, // agent 2, the assignee
    fee: 4000,
    foreignApps: [IDENTITY],
    boxes: [...jobBoxes(), box(IDENTITY, "ag_", u64(CLIENT_ID))],
  });
  return "result hash committed on chain";
});

await step("a passing verdict writes through to the reputation score", async () => {
  const before = await readScore();
  const workerBefore = await readScoreFor(CLIENT_ID);
  await call({
    appId: VALIDATION,
    method: M("validation_response", [{ type: "uint64" }, { type: "bool" }], "uint64"),
    args: [jobId, true],
    sender: merchant, // no validator was named, so the client judges
    fee: 8000,
    foreignApps: [IDENTITY, REPUTATION],
    boxes: [...jobBoxes(), box(IDENTITY, "ag_", u64(CLIENT_ID)), box(REPUTATION, "sc_", u64(CLIENT_ID))],
  });
  const after = await readScore();
  // The verdict credits the ASSIGNEE (agent 2), not the poster, so agent 1's
  // score must be untouched — a verdict that moved the wrong score would look
  // like success from the job's side.
  if (after.validated !== before.validated) {
    throw new Error(`agent ${SERVER_ID}.validated moved ${before.validated} → ${after.validated}; the verdict credited the wrong agent`);
  }
  // The write itself. Checking only that agent 1 was untouched would pass just
  // as well if the verdict wrote nothing anywhere, which is the bug this
  // contract was redeployed to fix: validated and disputed sat at zero while
  // jobs read VALIDATED.
  const workerAfter = await readScoreFor(CLIENT_ID);
  if (workerAfter.validated !== workerBefore.validated + 1) {
    throw new Error(`agent ${CLIENT_ID}.validated went ${workerBefore.validated} → ${workerAfter.validated}, expected +1`);
  }
  return `agent ${CLIENT_ID}.validated ${workerBefore.validated} → ${workerAfter.validated}; agent ${SERVER_ID} untouched`;
});

await step("escrow releases to the worker, and cannot be released twice", async () => {
  const beforeAsa = (await holdings(payer.addr)).asa;
  await call({
    appId: VALIDATION,
    method: M("release_escrow", [{ type: "uint64" }], "uint64"),
    args: [jobId],
    sender: merchant,
    fee: 6000,
    assets: [ASSET],
    accounts: [payer.addr.toString()],
    foreignApps: [IDENTITY],
    boxes: [...jobBoxes(), box(IDENTITY, "ag_", u64(CLIENT_ID))],
  });
  const afterAsa = (await holdings(payer.addr)).asa;
  const moved = afterAsa - beforeAsa;
  if (moved !== PRICE_UNITS) throw new Error(`worker received ${moved}, escrow held ${PRICE_UNITS}`);

  // The box is cleared BEFORE the transfer, so a second release has nothing to
  // pay out. That ordering is the whole defence against a double drain.
  try {
    await call({
      appId: VALIDATION,
      method: M("release_escrow", [{ type: "uint64" }], "uint64"),
      args: [jobId],
      sender: merchant,
      fee: 6000,
      assets: [ASSET],
      accounts: [payer.addr.toString()],
      foreignApps: [IDENTITY],
      boxes: [...jobBoxes(), box(IDENTITY, "ag_", u64(CLIENT_ID))],
    });
  } catch {
    return `worker paid ${moved} units; a second release was refused`;
  }
  throw new Error("escrow released TWICE — the custody ledger can be drained");
});

await close?.();

/* ── summary ────────────────────────────────────────────────────────────── */

const failed = results.filter((r) => !r.ok);
console.log(`\n  ${results.length - failed.length}/${results.length} steps passed\n`);
process.exit(failed.length ? 1 : 0);
