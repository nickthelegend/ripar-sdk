/**
 * The A2A workflow against the deployed agent, paid for real.
 *
 * ripar-agent has no test runner, so /a2a is the one surface with no unit
 * coverage at all. It is also the surface a peer agent actually uses: an A2A
 * client never touches /api/summarize, it speaks JSON-RPC here.
 *
 * The interesting part is how payment is carried. There is no 402 status code
 * in JSON-RPC, so the challenge rides inside an error object — and a client
 * that only knows HTTP status codes sees a 200 with an error and concludes the
 * agent is broken rather than unpaid.
 *
 *   node verify-a2a-live.mjs
 */
import algosdk from "algosdk";
import fs from "node:fs";

const A2A = `${process.env.RIPAR_AGENT_URL ?? "https://api.ripar.io"}/a2a`;
const CONFIG = process.env.RIPAR_E2E_CONFIG ?? "/tmp/testnet-e2e.json";
const REGISTRY_ASSET = 10_458_941;

const algod = new algosdk.Algodv2(
  process.env.ALGOD_TOKEN ?? "",
  process.env.ALGOD_URL ?? "https://testnet-api.algonode.cloud",
  process.env.ALGOD_PORT ?? ""
);
const payer = algosdk.mnemonicToSecretKey(JSON.parse(fs.readFileSync(CONFIG, "utf8")).payer.mnemonic);

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

const rpc = (params, headers = {}) =>
  fetch(A2A, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params }),
  });

const MESSAGE = {
  message: {
    role: "user",
    parts: [{ kind: "text", text: "Summarise: the quick brown fox jumps over the lazy dog. It did so twice." }],
    messageId: "verify-a2a-1",
  },
};

console.log(`\n  Ripar A2A — ${A2A}\n`);

await step("the agent card advertises this JSON-RPC endpoint", async () => {
  const card = await (await fetch(A2A.replace(/\/a2a$/, "/.well-known/agent.json"))).json();
  const iface = (card.supportedInterfaces ?? []).find((i) => i.protocolBinding === "JSONRPC");
  if (!iface) throw new Error("the card names no JSONRPC interface");
  if (!iface.url.endsWith("/a2a")) throw new Error(`card points at ${iface.url}`);
  if (card.capabilities?.streaming !== true) throw new Error("card does not claim streaming");
  return `${iface.url} (A2A ${iface.protocolVersion}), streaming claimed`;
});

let accepted;
await step("an unpaid call is refused with the x402 challenge INSIDE the error", async () => {
  const res = await rpc(MESSAGE);
  // BOTH channels carry the refusal, and that is the point.
  //
  // HTTP 402 is what an x402-aware client, proxy or paywall keys off — it
  // never parses the JSON-RPC envelope. The JSON-RPC error is what an A2A
  // client sees; it never looks at the status line. Answering on only one
  // leaves the other believing the agent is simply broken.
  if (res.status !== 402) throw new Error(`expected HTTP 402 on the envelope, got ${res.status}`);
  const body = await res.json();
  if (!body.error) throw new Error("unpaid call was ANSWERED — the A2A route is not gated");
  const reqs = body.error.data?.requirements;
  if (!reqs?.accepts?.length) throw new Error(`error carries no payment requirements: ${JSON.stringify(body.error).slice(0, 200)}`);
  // An A2A client that cannot read the challenge is told nothing useful, so the
  // message has to name the mechanism rather than say "unauthorized".
  if (!/x402|payment/i.test(String(body.error.message))) {
    throw new Error(`error message does not say it is about payment: ${body.error.message}`);
  }
  accepted = reqs.accepts.find((a) => Number(a.asset) === REGISTRY_ASSET) ?? reqs.accepts[0];
  return `HTTP 402 + JSON-RPC ${body.error.code}, ${reqs.accepts.length} accept(s), using asset ${accepted.asset}`;
});

await step(
  "a paid A2A call returns a real artifact",
  async () => {
    const sp = await algod.getTransactionParams().do();
    const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: payer.addr,
      receiver: accepted.payTo,
      amount: Number(accepted.maxAmountRequired ?? accepted.amount),
      assetIndex: Number(accepted.asset),
      suggestedParams: sp,
    });
    const header = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        accepted,
        scheme: "exact",
        network: accepted.network,
        payload: { paymentGroup: [Buffer.from(txn.signTxn(payer.sk)).toString("base64")], paymentIndex: 0 },
      })
    ).toString("base64");

    const res = await rpc(MESSAGE, { "PAYMENT-SIGNATURE": header });
    const body = await res.json();
    if (body.error) throw new Error(`paid call still refused: ${JSON.stringify(body.error).slice(0, 250)}`);

    const task = body.result;
    if (!task) throw new Error("no result in the JSON-RPC envelope");
    // A Task that says completed but carries nothing is a turnstile.
    const artifacts = task.artifacts ?? [];
    const text = artifacts
      .flatMap((a) => a.parts ?? [])
      .map((p) => p.text ?? "")
      .join("")
      .trim();
    if (!text) throw new Error(`task ${task.status?.state} carried no artifact text`);
    return `task ${task.status?.state}, ${artifacts.length} artifact(s): "${text.slice(0, 70)}…"`;
  },
  "an unpaid call is refused with the x402 challenge INSIDE the error"
);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n  ${results.length - failed}/${results.length} steps passed\n`);
process.exit(failed ? 1 : 0);
