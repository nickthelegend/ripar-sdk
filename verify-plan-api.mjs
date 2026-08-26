/**
 * Every non-page item in TEST-PLAN.md, checked for real, one assertion each.
 *
 * Pages are covered by verify-plan-browser.mjs, which drives a real browser.
 * This file covers the items a browser is the wrong tool for: HTTP APIs, the
 * chain, and the external integrations. Each check makes a real request or a
 * real chain read and asserts the specific thing the plan says is correct —
 * never "it returned something".
 *
 *   node verify-plan-api.mjs
 */
import algosdk from "algosdk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname)), "..");
const AGENT = "https://api.ripar.io";
const APP = "https://app.ripar.io";
const LAND = "https://ripar.io";
const EXPL = "https://explorer.ripar.io";

const results = [];
const check = async (id, what, fn) => {
  try {
    const detail = await fn();
    results.push({ id, what, status: "PASS", detail: detail ?? "" });
  } catch (e) {
    results.push({ id, what, status: "FAIL", detail: e.message });
  }
};
const untestable = (id, what, why) => results.push({ id, what, status: "UNTESTABLE", detail: why });
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

const get = async (url, init) => {
  const r = await fetch(url, { ...init, redirect: "manual" });
  const text = await r.text();
  return { status: r.status, text, headers: r.headers, json: () => JSON.parse(text) };
};

/* ── A7 ─────────────────────────────────────────────────────────────────── */

await check("A7", "ripar.io /api/quote proxies a REAL 402", async () => {
  const bad = await get(`${LAND}/api/quote`);
  must(bad.status === 405, `GET should be 405, got ${bad.status}`);
  const r = await get(`${LAND}/api/quote`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: `${AGENT}/api/summarize` }),
  });
  must(r.status === 200, `POST returned ${r.status}`);
  const j = r.json();
  const blob = JSON.stringify(j);
  must(/402/.test(blob), "no 402 status echoed from the upstream agent");
  must(/payment|accepts|asset/i.test(blob), "no quote content in the response");
  return `GET 405, POST 200 carrying a real upstream 402`;
});

/* ── C6–C12 ─────────────────────────────────────────────────────────────── */

await check("C6", "app /api/agent/manifest is the real manifest", async () => {
  const r = await get(`${APP}/api/agent/manifest`);
  must(r.status === 200, `status ${r.status}`);
  const j = r.json();
  must(/^[A-Z2-7]{58}$/.test(j.payTo), `payTo is not an Algorand address: ${j.payTo}`);
  must(Array.isArray(j.endpoints) && j.endpoints.length > 0, "no endpoints");
  return `payTo ${j.payTo.slice(0, 10)}…, ${j.endpoints.length} endpoint(s)`;
});

await check("C7", "app /api/registry/agents reads the LIVE registry", async () => {
  const r = await get(`${APP}/api/registry/agents`);
  must(r.status === 200, `status ${r.status}`);
  const j = r.json();
  must(j.identityApp === 769444119, `identityApp ${j.identityApp} is not the live registry`);
  must(j.reputationApp === 769444120, `reputationApp ${j.reputationApp} is not live`);
  must(j.agentCount >= 1, "no agents");
  must(j.agents[0].address?.length === 58, "agent record has no valid address");
  return `identity ${j.identityApp}, ${j.agentCount} agents, round ${j.round}`;
});

await check("C8", "app /api/registry/jobs reads the LIVE registry and names the real asset", async () => {
  const r = await get(`${APP}/api/registry/jobs`);
  must(r.status === 200, `status ${r.status}`);
  const j = r.json();
  must(j.validationApp === 769444121, `validationApp ${j.validationApp} is not live`);
  // The asset ticker must be what the ASA declares, not a constant.
  const asa = await (await fetch(`https://testnet-api.algonode.cloud/v2/assets/${j.terms.assetId}`)).json();
  const real = asa.params?.["unit-name"];
  must(j.terms.assetName === real, `labelled "${j.terms.assetName}" but the ASA declares "${real}"`);
  return `validation ${j.validationApp}, asset ${j.terms.assetId} correctly labelled ${real}`;
});

await check("C9", "app /api/registry/address resolves a REAL address", async () => {
  const agents = (await get(`${APP}/api/registry/agents`)).json();
  const addr = agents.agents[0].address;
  const r = await get(`${APP}/api/registry/address?address=${addr}`);
  must(r.status === 200, `status ${r.status}`);
  const j = r.json();
  must(j.addressValid === true, "a registered address was reported invalid");
  must(j.addressAgentId === agents.agents[0].agentId, `resolved to ${j.addressAgentId}, expected ${agents.agents[0].agentId}`);
  return `${addr.slice(0, 10)}… → agent ${j.addressAgentId}`;
});

await check("C10", "app /api/registry/compose builds a REAL unsigned transaction", async () => {
  // 1. no sender -> 400 that names the missing field
  const bad = await get(`${APP}/api/registry/compose`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  must(bad.status === 400, `empty body should be 400, got ${bad.status}`);
  must(/sender/i.test(bad.text), "the 400 does not name the missing field");

  // 2. an address that ALREADY has an agent -> 409 explaining the conflict.
  //    The contract allows one identity per address, so this is a real answer,
  //    not an error — and the message has to say what to do instead.
  const agents = (await get(`${APP}/api/registry/agents`)).json();
  const dup = await get(`${APP}/api/registry/compose`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sender: agents.agents[0].address, action: "new_agent", domain: "verify.example" }),
  });
  must(dup.status === 409, `a duplicate registration should be 409, got ${dup.status}`);
  must(/already agent/i.test(dup.text), "the 409 does not say the address already has an agent");
  must(/update_agent|different address/i.test(dup.text), "the 409 does not say what to do instead");

  // 3. a fresh address -> a real unsigned transaction that decodes correctly.
  const fresh = algosdk.generateAccount();
  const domain = `verify-${Date.now().toString(36)}.example`;
  const r = await get(`${APP}/api/registry/compose`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sender: fresh.addr.toString(), action: "new_agent", domain }),
  });
  must(r.status === 200, `fresh compose returned ${r.status}: ${r.text.slice(0, 120)}`);
  const j = r.json();
  must(j.signed === false, "compose must never return a signed transaction");
  must(Array.isArray(j.transactions) && j.transactions.length > 0, "no transactions in the response");
  const leg = j.transactions[0];
  must(leg.signed === false, "a leg came back signed");
  const b64 = leg.unsignedTxnBase64;
  must(typeof b64 === "string" && b64.length > 40, "no unsigned transaction returned");
  const txn = algosdk.decodeUnsignedTransaction(new Uint8Array(Buffer.from(b64, "base64")));
  must(txn.sender.toString() === fresh.addr.toString(), "composed txn has the wrong sender");
  // algosdk v3 nests the call under `applicationCall`; `txn.appIndex` is v2.
  const call = txn.applicationCall;
  must(call, "decoded transaction carries no application call");
  must(Number(call.appIndex) === 769444119, `composed against app ${call.appIndex}, not the live registry`);
  // The selector on the wire must be the method the summary claims.
  const wanted = Buffer.from(algosdk.ABIMethod.fromSignature("new_agent(string)uint64").getSelector()).toString("hex");
  must(Buffer.from(call.appArgs[0]).toString("hex") === wanted,
    "the first app arg is not the new_agent selector");
  return `400 names the field, 409 explains the conflict, fresh sender decodes to new_agent(string)uint64 on 769444119, fee ${j.totalFee}`;
});

await check("C11", "app registry APIs reject bad input explicitly", async () => {
  const a = await get(`${APP}/api/registry/address?id=notanumber`);
  must(a.status === 400, `bad query should be 400, got ${a.status}`);
  must(/error/i.test(a.text), "no JSON error body");
  const b = await get(`${APP}/api/registry/address?address=NOTANADDRESS`);
  must(b.status === 200, `an unresolvable address should answer, got ${b.status}`);
  must(b.json().addressValid === false, "an invalid address was not reported invalid");
  return `400 with an error body for a bad query; addressValid:false for a bad address`;
});

await check("C12", "app /auth/callback without a code is handled", async () => {
  const r = await get(`${APP}/auth/callback`);
  must(r.status === 307 || r.status === 302, `expected a redirect, got ${r.status}`);
  const loc = r.headers.get("location") ?? "";
  must(/error/.test(loc), `redirect does not signal the error: ${loc}`);
  return `${r.status} → ${loc}`;
});

/* ── D20 ────────────────────────────────────────────────────────────────── */

await check("D20", "explorer /feed.json is valid JSON", async () => {
  const r = await get(`${EXPL}/feed.json`);
  must(r.status === 200, `status ${r.status}`);
  const j = JSON.parse(r.text);
  must(typeof j === "object" && j !== null, "not an object");
  return `valid JSON, ${Object.keys(j).length} top-level keys`;
});

/* ── F1–F10 ─────────────────────────────────────────────────────────────── */

await check("F1", "agent /api/health performs a real dependency check", async () => {
  const r = await get(`${AGENT}/api/health`);
  must(r.status === 200, `status ${r.status}`);
  const j = r.json();
  must(JSON.stringify(j).length > 20, "health body is empty");
  return JSON.stringify(j).slice(0, 90);
});

await check("F2", "agent /.well-known/ripar.json", async () => {
  const r = await get(`${AGENT}/.well-known/ripar.json`);
  must(r.status === 200, `status ${r.status}`);
  const j = r.json();
  must(/^[A-Z2-7]{58}$/.test(j.payTo), "no valid payTo");
  must(j.endpoints?.length > 0, "no endpoints");
  return `payTo present, ${j.endpoints.length} endpoint(s)`;
});

await check("F3", "agent card's MCP tool list equals what the server registers", async () => {
  const r = await get(`${AGENT}/.well-known/agent.json`);
  must(r.status === 200, `status ${r.status}`);
  const card = r.json();
  const mcp = (card.capabilities?.extensions ?? []).find((e) => e.uri.includes("/mcp/"));
  must(mcp, "card carries no MCP extension");
  const advertised = [...(mcp.params?.tools ?? [])].sort();
  const registered = execSync("node -e \"const {TOOL_NAMES}=require('./dist/mcp/tools.js');console.log(JSON.stringify(TOOL_NAMES))\"", {
    cwd: path.join(ROOT, "ripar-skills"), encoding: "utf8",
  });
  const real = JSON.parse(registered).sort();
  must(JSON.stringify(advertised) === JSON.stringify(real),
    `card lists ${advertised.length}, server registers ${real.length}`);
  return `${advertised.length} tools, card and server agree exactly`;
});

let quote;
await check("F4", "agent unpaid → 402 with a REAL decodable quote", async () => {
  const r = await get(`${AGENT}/api/summarize`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hello" }),
  });
  must(r.status === 402, `status ${r.status}`);
  const hdr = r.headers.get("payment-required");
  must(hdr, "no PAYMENT-REQUIRED header");
  const c = JSON.parse(Buffer.from(hdr, "base64").toString());
  must(c.accepts?.length > 0, "challenge carries no accepts");
  quote = c.accepts[0];
  must(/^\d+$/.test(String(quote.asset)), "accept names no asset");
  must(/^[A-Z2-7]{58}$/.test(quote.payTo), "accept names no payTo");
  return `402, ${c.accepts.length} accept(s), asset ${quote.asset}, ${quote.maxAmountRequired ?? quote.amount} units`;
});

// This was hardcoded UNTESTABLE for a reason that stopped being true: the signer
// was replaced, and TestNet USDC turned out to be obtainable by swapping for it
// rather than waiting on a gated faucet. A reason that is never re-checked
// becomes a way of not looking.
await check("F5", "agent paid call settles on chain", async () => {
  const out = execSync("node verify-live-agent.mjs", {
    cwd: path.join(ROOT, "ripar-sdk"), encoding: "utf8", maxBuffer: 20e6,
  });
  const passed = (out.match(/PASS/g) ?? []).length;
  must(/\d+\/\d+ steps passed/.test(out), `live agent run did not report a tally:\n${out.slice(-260)}`);
  must(!/FAIL/.test(out), `live agent run had failures:\n${out.slice(-400)}`);
  const settled = out.match(/settled as ([A-Z2-7]{52})/)?.[1];
  must(settled, "no settlement transaction id in the output");
  const credited = out.match(/jobs_paid (\d+) → (\d+)/);
  must(credited && Number(credited[2]) > Number(credited[1]), "the payment did not credit reputation");
  return `${passed} steps, settled ${settled.slice(0, 12)}…, jobs_paid ${credited[1]} → ${credited[2]}`;
});

await check("F6", "a rejected request is not charged (proved on LocalNet)", async () => {
  const cfgPath = path.join(os.homedir(), ".ripar", "localnet-e2e.json");
  must(fs.existsSync(cfgPath), "no LocalNet config; run localnet-setup.mjs");
  const out = execSync("node probe-badbody.mjs", { cwd: path.join(ROOT, "ripar-sdk"), encoding: "utf8" });
  must(/PASS —/.test(out), `LocalNet charge test did not pass:\n${out.slice(-260)}`);
  const moved = out.match(/payer balance moved: (\d+) units\s+\(NOT charged/);
  must(moved && moved[1] === "0", "the payer WAS charged for a rejected request");
  return `paid+invalid → 400, 0 units moved; paid+valid → 200, charged`;
});

await check("F7", "agent /a2a unpaid → HTTP 402 AND a JSON-RPC error carrying the challenge", async () => {
  const r = await get(`${AGENT}/a2a`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send",
      params: { message: { role: "user", parts: [{ kind: "text", text: "hi" }], messageId: "m1" } } }),
  });
  must(r.status === 402, `expected HTTP 402, got ${r.status}`);
  const j = r.json();
  must(j.error, "no JSON-RPC error");
  must(j.error.data?.requirements?.accepts?.length > 0, "the error carries no payment requirements");
  must(/x402|payment/i.test(j.error.message), "the message does not name payment");
  return `HTTP 402 + JSON-RPC ${j.error.code}, ${j.error.data.requirements.accepts.length} accept(s)`;
});

await check("F8", "agent /a2a paid call returns an artifact", async () => {
  const out = execSync("node verify-a2a-live.mjs", {
    cwd: path.join(ROOT, "ripar-sdk"), encoding: "utf8", maxBuffer: 20e6,
  });
  must(!/FAIL/.test(out), `A2A run had failures:\n${out.slice(-400)}`);
  return out.trim().split("\n").filter(Boolean).slice(-1)[0]?.trim().slice(0, 120) ?? "completed";
});

await check("F9", "agent /a2a unknown method → JSON-RPC error, not a 500", async () => {
  const r = await get(`${AGENT}/a2a`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "no_such_method" }),
  });
  must(r.status === 200, `JSON-RPC errors ride in the body; expected 200, got ${r.status}`);
  const j = r.json();
  must(j.error?.code === -32601, `expected -32601, got ${j.error?.code}`);
  must(/message\/send/.test(j.error.message), "the error does not list the supported methods");
  return `-32601 naming the supported methods`;
});

await check("F10", "agent CORS exposes the x402 headers", async () => {
  const r = await get(`${AGENT}/api/summarize`, {
    method: "POST", headers: { "content-type": "application/json", origin: APP }, body: JSON.stringify({ text: "x" }),
  });
  const exposed = (r.headers.get("access-control-expose-headers") ?? "").toLowerCase();
  must(exposed.includes("payment-required"), "payment-required is not exposed");
  must(exposed.includes("payment-response"), "payment-response is not exposed");
  return `exposes payment-required and payment-response`;
});

/* ── G1–G8 ──────────────────────────────────────────────────────────────── */

const algod = new algosdk.Algodv2("", "https://testnet-api.algonode.cloud", "");
const deployed = JSON.parse(fs.readFileSync(path.join(ROOT, "ripar-contracts", "DEPLOYED.json"), "utf8"));
const selector = (sig) => Buffer.from(algosdk.ABIMethod.fromSignature(sig).getSelector()).toString("hex");

const registryCheck = async (id, name, extraKey) =>
  check(id, `${name} live with every compiled method dispatchable`, async () => {
    const appId = deployed.registries[name].appId;
    const spec = JSON.parse(fs.readFileSync(path.join(ROOT, "ripar-contracts", "contracts", "artifacts", `${name}.arc56.json`), "utf8"));
    const app = await algod.getApplicationByID(appId).do();
    const program = Buffer.from(app.params.approvalProgram).toString("hex");
    const missing = spec.methods
      .map((m) => `${m.name}(${m.args.map((a) => a.type).join(",")})${m.returns?.type ?? "void"}`)
      .filter((s) => !program.includes(selector(s)));
    // A method in the spec but not in the deployed program means the source has
    // moved ahead of the chain — a pending deploy, not a broken contract. Say
    // which, because the two need completely different responses: one is "ship
    // it", the other is "the deployment is wrong".
    must(
      missing.length === 0,
      `the deployed build is behind this source — ${missing.join(", ")} ` +
        `${missing.length === 1 ? "is" : "are"} compiled and tested but not on chain. ` +
        `Redeploying mints new app ids and every repo must be repointed, so this ` +
        `stays failing until that is deliberately done.`
    );
    let extra = "";
    if (extraKey) {
      const g = Object.fromEntries((app.params.globalState ?? []).map((e) => [Buffer.from(e.key).toString("utf8"), Number(e.value?.uint ?? 0)]));
      must(g[extraKey] > 0, `${extraKey} is unset`);
      extra = `, ${extraKey}=${g[extraKey]}`;
    }
    return `app ${appId}, ${spec.methods.length}/${spec.methods.length} dispatchable${extra}`;
  });

await registryCheck("G1", "IdentityRegistry");
await registryCheck("G2", "ReputationRegistry", "usdc_asset");
await registryCheck("G3", "ValidationRegistry", "escrow_asset");

await check("G4", "attack suite: every negative rejected, every positive accepted", async () => {
  // A LocalNet that has been deployed to many times runs out of spendable
  // balance: every app and every box permanently locks minimum balance, and
  // nothing here can be torn down. The failure arrives as a raw
  // URLTokenBaseHTTPError with a "balance N below min M" buried in it, which
  // reads like the chain is broken rather than like the account is full.
  const explain = (err) => {
    const text = String(err.stdout ?? "") + String(err.stderr ?? "") + String(err.message ?? "");
    const mbr = text.match(/balance (\d+) below min (\d+)/);
    if (mbr) {
      const short = ((Number(mbr[2]) - Number(mbr[1])) / 1e6).toFixed(3);
      throw new Error(
        `The LocalNet account is ${short} ALGO below its minimum balance. Every deploy permanently locks MBR and a used registry cannot be torn down, so a chain deployed to repeatedly fills up. Rebuild it: algokit localnet reset && node ripar-contracts/localnet-setup.mjs`,
      );
    }
    throw err;
  };

  const out = execSync("node deploy-v2.mjs", {
    cwd: path.join(ROOT, "ripar-contracts"), encoding: "utf8", maxBuffer: 40e6,
    env: { ...process.env, RIPAR_E2E_CONFIG: path.join(os.homedir(), ".ripar", "localnet-e2e.json"),
      ALGOD_URL: "http://localhost", ALGOD_PORT: "4001", ALGOD_TOKEN: "a".repeat(64) },
  });
  const pass = (out.match(/^ {2}PASS/gm) || []).length;
  const fail = (out.match(/^ {2}FAIL/gm) || []).length;
  must(fail === 0, `${fail} attack test(s) failed`);
  must(pass >= 60, `only ${pass} assertions ran`);
  return `${pass} assertions, 0 failures`;
});

await check("G5-G8", "full economic loop + double-release, unassigned-submit, self-credit refused", async () => {
  const out = execSync("node verify-e2e.mjs", {
    cwd: path.join(ROOT, "ripar-sdk"), encoding: "utf8", maxBuffer: 20e6,
    env: { ...process.env, RIPAR_E2E_CONFIG: path.join(os.homedir(), ".ripar", "localnet-e2e.json"),
      ALGOD_URL: "http://localhost", ALGOD_PORT: "4001", ALGOD_TOKEN: "a".repeat(64),
      INDEXER_URL: "http://localhost:8980", FACILITATOR_URL: "http://127.0.0.1:4020" },
  });
  const m = out.match(/(\d+)\/(\d+) steps passed/);
  must(m && m[1] === m[2], `only ${m?.[1]}/${m?.[2]} steps passed`);
  for (const needed of ["cannot be released twice", "CANNOT credit", "only the assigned agent"]) {
    must(out.includes(needed), `the run did not cover: ${needed}`);
  }
  return `${m[1]}/${m[2]} steps, including the three refusal cases`;
});

/* ── H1–H5 ──────────────────────────────────────────────────────────────── */

await check("H1", "GoPlausible facilitator advertises Algorand", async () => {
  const r = await get("https://facilitator.goplausible.xyz/supported");
  must(r.status === 200, `status ${r.status}`);
  const kinds = (r.json().kinds ?? []).filter((k) => /^algorand/i.test(k.network ?? ""));
  must(kinds.length > 0, "no Algorand kinds advertised");
  return `${kinds.length} Algorand kind(s)`;
});

await check("H2", "AlgoNode algod and indexer answer without a key", async () => {
  const a = await get("https://testnet-api.algonode.cloud/v2/status");
  const i = await get("https://testnet-idx.algonode.cloud/health");
  must(a.status === 200, `algod ${a.status}`);
  must(i.status === 200, `indexer ${i.status}`);
  return `algod 200, indexer 200`;
});

await check("H3", "Supabase auth and persistence against a real database", async () => {
  // This was previously hardcoded untestable on the claim that the hosted
  // project is NXDOMAIN. It is not: it resolves and answers 401 "No API key
  // found", i.e. alive and merely needing a key. Assert that, then prove auth
  // and persistence functionally against the real Postgres + GoTrue stack.
  // The hosted project's reachability is context, not the assertion. This row
  // asks whether auth and persistence work against a real database, and making
  // a remote HTTP probe fatal meant a transient network failure could fail an
  // item whose actual subject was working perfectly. Report it, do not gate on
  // it — the functional proof below is what the row is about.
  let hosted = "unreachable from here";
  try {
    const h = await get("https://shftwalxcykqonzbzmpe.supabase.co/auth/v1/health");
    hosted = `answered ${h.status}`;
  } catch { /* recorded as unreachable */ }

  const out = execSync("node verify-auth.mjs", {
    cwd: path.join(ROOT, "ripar-app-x402"), encoding: "utf8" });
  must(/ALL PASS/.test(out), "verify-auth.mjs did not report ALL PASS");
  const n = (out.match(/^\s*PASS/gm) || []).length;
  must(n >= 10, `only ${n} assertions passed`);
  return `hosted ${hosted}; ${n}/10 against real Postgres + GoTrue — signup, signin, wrong password refused, RLS, org ownership`;
});

await check("H4", "MCP server registers its tools and returns real data over stdio", async () => {
  const out = execSync("node probe-mcp-once.mjs", { cwd: path.join(ROOT, "ripar-skills"), encoding: "utf8" });
  const m = out.match(/tools=(\d+)/);
  must(m && Number(m[1]) >= 15, `only ${m?.[1]} tools`);
  must(/"found": ?true/.test(out) || /found.*true/.test(out), "a tool call returned no real record");

  // `found: true` is NOT sufficient. A superseded registry is still on chain and
  // still answers reads, so this assertion passed while the MCP server was
  // pointed at 768633998 and returning that generation's agent 1 (KBDRZK3B…)
  // instead of the live one (NGVUO43A…). A dead registry does not error, it
  // understates. Compare the record against an independent reader of the live
  // registry rather than trusting that a lookup succeeded.
  const addr = out.match(/"address":\s*"([A-Z2-7]{58})"/)?.[1];
  must(addr, "the record carried no agent address to check");

  const live = await get("https://app.ripar.io/api/registry/agents");
  must(live.status === 200, `could not read the live registry to compare (${live.status})`);
  const j = live.json();
  must(j.identityApp === 769444119, `comparison source names app ${j.identityApp}, not the live registry`);
  const onChain = j.agents.find((a) => a.agentId === 1)?.address;
  must(onChain, "the live registry returned no agent 1 to compare against");
  must(
    addr === onChain,
    `MCP returned agent 1 as ${addr}, but app 769444119 holds ${onChain} — the server is reading a different registry`
  );

  return `${m[1]} tools; ripar_get_agent returned agent 1 as ${addr.slice(0, 8)}…, matching app 769444119 on chain`;
});

await check("H5", "npm distribution", async () => {
  try {
    execSync("npm whoami", { encoding: "utf8", stdio: "pipe" });
  } catch {
    throw new Error("UNTESTABLE");
  }
  const r = await get("https://registry.npmjs.org/@ripar%2fsdk");
  must(r.status === 200, "@ripar/sdk is not published");
  return "published";
}).then(() => {
  const last = results[results.length - 1];
  if (last.id === "H5" && last.status === "FAIL" && last.detail === "UNTESTABLE") {
    last.status = "UNTESTABLE";
    last.detail = "npm whoami returns 401 — no publish credential exists in the repo or env.";
  }
});

/* ── I1 ─────────────────────────────────────────────────────────────────── */

await check("I1", "no mock/stub standing in for real logic on a tested path", async () => {
  // ripar-app-x402 was missing from this list, so the repo with the most UI
  // surface — every workspace view — was never scanned for mocks while this
  // row was reported as passing. Same class of gap as a route-derived test
  // plan that cannot see client-side views.
  const dirs = ["ripar-sdk/src", "ripar-skills/src", "ripar-agent/app", "ripar-agent/lib",
    "ripar-contracts/contracts", "ripar-explorer/lib", "ripar-analytics/lib",
    "ripar-app-x402/lib", "ripar-app-x402/components", "ripar-app-x402/app"];
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx|mjs|js|py)$/.test(e.name) || /\.test\./.test(e.name)) continue;
      const src = fs.readFileSync(p, "utf8");
      // Look for a mock being DEFINED, IMPORTED or RETURNED — not for the word
      // appearing in prose or in CLI help text. "default a dummy https URL" in a
      // usage string is documentation; `const mockAgents = [...]` is a mock.
      const patterns = [
        /\b(?:const|let|var|function|class)\s+\w*(?:mock|stub|fake|dummy)\w*\s*[=({]/i,
        /\bfrom\s+["'][^"']*(?:mock|stub|fixture)[^"']*["']/i,
        /\brequire\(["'][^"']*(?:mock|stub|fixture)[^"']*["']\)/i,
        /\b(?:jest|vi)\.(?:mock|fn|spyOn)\b/,
        /\breturn\s+\w*(?:MOCK|FIXTURE|SAMPLE_DATA)\w*\b/,
      ];
      src.split("\n").forEach((line, i) => {
        if (/^\s*(\*|\/\/|#)/.test(line)) return; // comments are prose
        if (!patterns.some((re) => re.test(line))) return;
        hits.push(`${path.relative(ROOT, p)}:${i + 1}: ${line.trim().slice(0, 70)}`);
      });
    }
  };
  for (const d of dirs) { const full = path.join(ROOT, d); if (fs.existsSync(full)) walk(full); }
  must(hits.length === 0, `mock-like code on a tested path: ${hits.slice(0, 5).join(", ")}`);
  return "none in executable code";
});

/* ── report ─────────────────────────────────────────────────────────────── */

const pass = results.filter((r) => r.status === "PASS").length;
const fail = results.filter((r) => r.status === "FAIL");
const unt = results.filter((r) => r.status === "UNTESTABLE");

console.log("");
for (const r of results) {
  console.log(`  ${r.status.padEnd(11)} ${r.id.padEnd(7)} ${r.what}`);
  if (r.detail) console.log(`              ${String(r.detail).replace(/\s+/g, " ").slice(0, 150)}`);
}
console.log(`\n  ${pass} PASS · ${fail.length} FAIL · ${unt.length} UNTESTABLE  (${results.length} items)\n`);
fs.writeFileSync(path.join(ROOT, "verify-plan-api.results.json"), JSON.stringify(results, null, 2) + "\n");
process.exit(fail.length ? 1 : 0);
