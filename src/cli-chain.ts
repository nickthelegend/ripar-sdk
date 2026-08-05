import { createHash } from "node:crypto";
import algosdk from "algosdk";
import { findInBazaar, listBazaar } from "./bazaar.js";
import { pickAccept } from "./client.js";
import { readPaymentRequired } from "./headers.js";
import { openApiDocument } from "./openapi.js";
import type { AgentDef } from "./types.js";

/**
 * The commands that read or write the chain, kept out of cli.ts so that file
 * stays about argument parsing.
 *
 * Every one of these answers a question an operator actually asks while an
 * agent is running — what is out there, am I registered, has anyone paid me,
 * what work is open — and answers it from the chain rather than from anything
 * this process remembers.
 *
 * None of them holds a key except `register`, which needs one to sign, and
 * `keys`, whose whole job is generating one. Both say where the key came from.
 */

export type CliIO = { out: (s: string) => void; err: (s: string) => void };

/** TestNet is the default everywhere here: it is where the registries are, and
 *  defaulting to MainNet would have every read come back empty with no hint. */
const ALGOD: Record<string, string> = {
  testnet: "https://testnet-api.algonode.cloud",
  mainnet: "https://mainnet-api.algonode.cloud",
};

/** The deployed registries. Overridable, because a fork or a redeploy makes
 *  hardcoded ids wrong and an id nobody can override is one nobody can fix. */
export const REGISTRY: Record<string, { identity: number; reputation: number; validation: number }> = {
  testnet: { identity: 768_633_998, reputation: 768_633_999, validation: 768_634_000 },
  // Nothing is deployed on MainNet yet. Zero rather than a guess, so a caller
  // gets "not deployed" instead of reading a stranger's app.
  mainnet: { identity: 0, reputation: 0, validation: 0 },
};

const u64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};
const boxName = (prefix: string, raw: Uint8Array | Buffer) =>
  new Uint8Array([...Buffer.from(prefix), ...raw]);

function client(network: string) {
  return new algosdk.Algodv2("", ALGOD[network] ?? ALGOD.testnet, "");
}

async function readBox(
  algod: algosdk.Algodv2,
  appId: number,
  name: Uint8Array
): Promise<Uint8Array | null> {
  try {
    const v = await algod.getApplicationBoxByName(appId, name).do();
    return new Uint8Array(Buffer.from(v.value));
  } catch {
    // A missing box and a failed read are different, but algod answers 404 for
    // the first and the caller only ever wants "is it there".
    return null;
  }
}

/* ── ripar bazaar ───────────────────────────────────────────────────────── */

export async function cmdBazaar(args: { query?: string; limit?: number; json?: boolean }, io: CliIO) {
  const res = args.query
    ? await findInBazaar(args.query, { limit: args.limit ?? 100 })
    : await listBazaar({ limit: args.limit ?? 25 });

  if (!res.ok) {
    io.err(`Could not read the discovery index: ${res.error}`);
    return 1;
  }
  if (args.json) {
    io.out(JSON.stringify(res.resources, null, 2));
    return 0;
  }
  if (!res.resources.length) {
    // Said explicitly, because filtering happens locally over one page — an
    // empty result means "not in what I read", not "does not exist".
    io.out(
      args.query
        ? `Nothing matching "${args.query}" in the page read from ${res.discoveryUrl}.\n` +
            `The index has no search route, so this filters one page locally — try --limit.`
        : `The index returned nothing.`
    );
    return 0;
  }

  for (const r of res.resources) {
    const price = r.accepts?.[0] as { amount?: string; asset?: string } | undefined;
    io.out(`${r.method.padEnd(5)} ${r.resourceUrl}`);
    if (r.description) io.out(`      ${r.description.slice(0, 96)}`);
    if (price?.amount) io.out(`      ${price.amount} base units of asset ${price.asset ?? "?"}`);
  }
  io.out(`\n${res.resources.length} resource(s). Listed by having been PAID for, not by announcing.`);
  return 0;
}

/* ── ripar keys ─────────────────────────────────────────────────────────── */

export function cmdKeys(args: { mnemonic?: string; json?: boolean }, io: CliIO) {
  if (args.mnemonic) {
    let acct: algosdk.Account;
    try {
      acct = algosdk.mnemonicToSecretKey(args.mnemonic.trim());
    } catch (err) {
      io.err(`That is not a valid 25-word Algorand mnemonic: ${(err as Error).message}`);
      return 1;
    }
    // Address only. Echoing the mnemonic back would put it in the terminal
    // scrollback and the shell history of whoever ran this.
    io.out(acct.addr.toString());
    return 0;
  }

  const acct = algosdk.generateAccount();
  const mnemonic = algosdk.secretKeyToMnemonic(acct.sk);
  if (args.json) {
    io.out(JSON.stringify({ address: acct.addr.toString(), mnemonic }, null, 2));
    return 0;
  }
  io.out(`address:  ${acct.addr.toString()}`);
  io.out(`mnemonic: ${mnemonic}`);
  io.out(
    `\nThis is the only time the mnemonic is shown. It is printed to stdout, so it is now in\n` +
      `your scrollback and possibly your shell history — treat it as compromised for anything\n` +
      `holding real value, and use it for TestNet or as a payout address you will replace.`
  );
  return 0;
}

/* ── ripar score ────────────────────────────────────────────────────────── */

export async function cmdScore(
  args: { agentId?: number; address?: string; domain?: string; network?: string; json?: boolean },
  io: CliIO
) {
  const network = args.network ?? "testnet";
  const apps = REGISTRY[network];
  if (!apps?.identity) {
    io.err(`The registries are not deployed on ${network}. Try --network testnet.`);
    return 1;
  }
  const algod = client(network);

  let agentId = args.agentId ?? 0;
  if (!agentId && args.domain) {
    const box = await readBox(algod, apps.identity, boxName("dm_", Buffer.from(args.domain)));
    agentId = box ? Number(Buffer.from(box).readBigUInt64BE(0)) : 0;
  }
  if (!agentId && args.address) {
    const box = await readBox(
      algod,
      apps.identity,
      boxName("ad_", algosdk.decodeAddress(args.address).publicKey)
    );
    agentId = box ? Number(Buffer.from(box).readBigUInt64BE(0)) : 0;
  }
  if (!agentId) {
    // The contract's own sentinel. Saying so beats an empty record.
    io.err("Not registered. The registry returned 0, which is its value for 'no such agent'.");
    return 1;
  }

  const scoreBox = await readBox(algod, apps.reputation, boxName("sc_", u64(agentId)));
  if (!scoreBox) {
    io.out(`agent ${agentId} has no score box, so nobody has ever paid it through Ripar.`);
    return 0;
  }
  const b = Buffer.from(scoreBox);
  const score = {
    agentId: Number(b.readBigUInt64BE(0)),
    jobsPaid: Number(b.readBigUInt64BE(8)),
    volumeMicro: Number(b.readBigUInt64BE(16)),
    validated: Number(b.readBigUInt64BE(24)),
    disputed: Number(b.readBigUInt64BE(32)),
    firstAt: Number(b.readBigUInt64BE(40)),
    lastAt: Number(b.readBigUInt64BE(48)),
  };

  if (args.json) {
    io.out(JSON.stringify(score, null, 2));
    return 0;
  }
  io.out(`agent ${score.agentId}`);
  io.out(`  paid          ${score.jobsPaid} time(s)`);
  io.out(`  volume        ${(score.volumeMicro / 1e6).toFixed(6)}`);
  io.out(`  validated     ${score.validated}   disputed ${score.disputed}`);
  io.out(`  first / last  ${new Date(score.firstAt * 1000).toISOString()} / ${new Date(score.lastAt * 1000).toISOString()}`);
  io.out(
    `\nEvery credit required a real transfer from the client's registered address to this\n` +
      `agent's. It counts money, not quality — nobody judged the work.`
  );
  return 0;
}

/* ── ripar jobs ─────────────────────────────────────────────────────────── */

const STATUS = ["open", "assigned", "submitted", "validated", "disputed", "cancelled"];

export async function cmdJobs(args: { network?: string; limit?: number; json?: boolean }, io: CliIO) {
  const network = args.network ?? "testnet";
  const apps = REGISTRY[network];
  if (!apps?.validation) {
    io.err(`The registries are not deployed on ${network}. Try --network testnet.`);
    return 1;
  }
  const algod = client(network);

  const app = await algod.getApplicationByID(apps.validation).do();
  // algosdk hands back the key as raw bytes, not base64 — decoding it as
  // base64 finds nothing and the count silently reads 0, which looks exactly
  // like "no jobs posted".
  const countEntry = (app.params?.globalState ?? []).find(
    (e) => Buffer.from(e.key).toString("utf8") === "job_count"
  );
  const total = Number(countEntry?.value?.uint ?? 0);
  if (!total) {
    io.out("No jobs posted yet.");
    return 0;
  }

  const limit = Math.min(args.limit ?? 25, total);
  const rows: Record<string, unknown>[] = [];
  for (let id = total; id > total - limit && id >= 1; id--) {
    const raw = await readBox(algod, apps.validation, boxName("jb_", u64(id)));
    if (!raw) continue;
    const b = Buffer.from(raw);
    const client_ = algosdk.encodeAddress(b.subarray(8, 40));
    const serverAgentId = Number(b.readBigUInt64BE(40));
    const validatorAgentId = Number(b.readBigUInt64BE(48));
    const budgetMicro = Number(b.readBigUInt64BE(56));

    // The escrow lives in its own box: a budget is what the client SAYS the
    // work is worth, escrow is what they actually handed over. A job with a
    // budget and no escrow is unfunded, which is the single most useful thing
    // a bidding agent can know.
    const esc = await readBox(algod, apps.validation, boxName("es_", u64(id)));
    const escrowMicro = esc ? Number(Buffer.from(esc).readBigUInt64BE(0)) : 0;

    rows.push({ jobId: id, client: client_, serverAgentId, validatorAgentId, budgetMicro, escrowMicro });
  }

  if (args.json) {
    io.out(JSON.stringify(rows, null, 2));
    return 0;
  }
  for (const r of rows) {
    const funded = (r.escrowMicro as number) > 0;
    io.out(
      `job ${String(r.jobId).padEnd(4)} budget ${((r.budgetMicro as number) / 1e6).toFixed(2).padStart(8)}` +
        `  escrow ${((r.escrowMicro as number) / 1e6).toFixed(2).padStart(8)}` +
        `  ${funded ? "FUNDED" : "unfunded"}`
    );
    io.out(`         client ${String(r.client).slice(0, 12)}…  agent ${r.serverAgentId}  validator ${r.validatorAgentId}`);
  }
  io.out(
    `\n${rows.length} of ${total} job(s). "unfunded" means the budget is a stated intention:\n` +
      `the client has not moved the money into escrow, so there is nothing to release.`
  );
  return 0;
}

/* ── ripar watch ────────────────────────────────────────────────────────── */

export async function cmdWatch(
  args: { address: string; network?: string; asset?: number; intervalMs?: number; once?: boolean },
  io: CliIO,
  shouldStop?: () => boolean
) {
  const network = args.network ?? "testnet";
  const indexer =
    network === "mainnet" ? "https://mainnet-idx.algonode.cloud" : "https://testnet-idx.algonode.cloud";
  const asset = args.asset ?? (network === "mainnet" ? 31_566_704 : 10_458_941);
  const every = args.intervalMs ?? 5_000;

  io.out(`watching ${args.address.slice(0, 12)}… for asset ${asset} on ${network}`);

  // Anchored to the CURRENT round, not round 0. The indexer returns oldest
  // first, so an unanchored query hands back transfers from years ago and
  // reports them as new — which is exactly how this feature looks broken.
  let since = 0;
  try {
    const status = await client(network).status().do();
    since = Number(status.lastRound);
  } catch (err) {
    io.err(`Could not read the current round: ${(err as Error).message}`);
    return 1;
  }

  do {
    try {
      const url =
        `${indexer}/v2/accounts/${args.address}/transactions` +
        `?asset-id=${asset}&tx-type=axfer&min-round=${since + 1}&limit=50`;
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (res.ok) {
        const body = (await res.json()) as { transactions?: Record<string, any>[] };
        for (const t of (body.transactions ?? []).reverse()) {
          const x = t["asset-transfer-transaction"];
          const inbound = x?.receiver === args.address;
          io.out(
            `${new Date((t["round-time"] ?? 0) * 1000).toISOString()}  ` +
              `${inbound ? "in " : "out"} ${(Number(x?.amount ?? 0) / 1e6).toFixed(6)}  ` +
              `${inbound ? t.sender : x?.receiver}`.slice(0, 100)
          );
          since = Math.max(since, Number(t["confirmed-round"] ?? since));
        }
      }
    } catch (err) {
      // A dropped poll is not a reason to exit: this is meant to be left
      // running, and the next round trip usually works.
      io.err(`poll failed: ${(err as Error).message}`);
    }
    if (args.once || shouldStop?.()) break;
    await new Promise((r) => setTimeout(r, every));
  } while (!shouldStop?.());

  return 0;
}

/* ── ripar openapi ──────────────────────────────────────────────────────── */

export async function cmdOpenApi(
  args: { entry?: string; baseUrl?: string; basePath?: string; includeUnlisted?: boolean },
  io: CliIO,
  load: (path: string) => Promise<unknown>
) {
  const entry = args.entry ?? "./dist/agent.js";
  let mod: Record<string, unknown>;
  try {
    mod = (await load(entry)) as Record<string, unknown>;
  } catch (err) {
    io.err(
      `Could not import ${entry}: ${(err as Error).message}\n` +
        `Point --entry at a BUILT module that exports your agent — this runs your code, ` +
        `so it has to be the compiled output rather than the TypeScript source.`
    );
    return 1;
  }

  // Accept the shapes people actually write: a default export, a named
  // `agent`, or the module itself if it looks like one.
  const candidate = (mod.default ?? mod.agent ?? mod) as AgentDef;
  if (!candidate?.endpoints?.length) {
    io.err(
      `${entry} does not export an agent. Export it as \`default\` or as \`agent\`, ` +
        `built with defineAgent({ ... }).`
    );
    return 1;
  }

  io.out(
    JSON.stringify(
      openApiDocument(candidate, {
        baseUrl: args.baseUrl,
        basePath: args.basePath,
        includeUnlisted: args.includeUnlisted,
      }),
      null,
      2
    )
  );
  return 0;
}

/* ── ripar register ─────────────────────────────────────────────────────── */

/**
 * Bind an address to a domain in the IdentityRegistry.
 *
 * This is the only command here that signs, and the only one that needs a key.
 * The key is read from RIPAR_MNEMONIC rather than a flag, because an argument
 * ends up in shell history and in the process list of every other user on the
 * machine.
 *
 * `new_agent` takes the owner from Txn.sender, so the address that signs IS the
 * identity. That is what makes an agent card checkable: a card is a file on a
 * web server and anyone can write one, but the registry entry is signed by the
 * account being paid.
 */
export async function cmdRegister(
  args: { domain?: string; network?: string; mnemonic?: string; dryRun?: boolean },
  io: CliIO
) {
  const network = args.network ?? "testnet";
  const apps = REGISTRY[network];
  if (!apps?.identity) {
    io.err(`The registries are not deployed on ${network}. Try --network testnet.`);
    return 1;
  }
  const domain = args.domain;
  if (!domain) {
    io.err("ripar register needs a domain: ripar register agent.example.com");
    return 1;
  }
  // The domain has to be one that actually serves the card, because that is
  // the claim being registered. A scheme or a path here means the reverse
  // index will never match what a resolver looks up.
  if (/^https?:\/\//.test(domain) || domain.includes("/")) {
    io.err(`Register the HOST only — "${domain.replace(/^https?:\/\//, "").split("/")[0]}", not a URL.`);
    return 1;
  }

  const mnemonic = args.mnemonic ?? process.env.RIPAR_MNEMONIC;
  if (!mnemonic) {
    io.err(
      "No key. Set RIPAR_MNEMONIC to the 25-word mnemonic of the account that should own this\n" +
        "identity — the same account your agent names as payTo, or the registry entry will not\n" +
        "match the address callers are asked to pay.\n\n" +
        "Deliberately an environment variable and not a flag: a flag ends up in your shell\n" +
        "history and in the process list."
    );
    return 1;
  }

  let acct: algosdk.Account;
  try {
    acct = algosdk.mnemonicToSecretKey(mnemonic.trim());
  } catch (err) {
    io.err(`RIPAR_MNEMONIC is not a valid 25-word mnemonic: ${(err as Error).message}`);
    return 1;
  }
  const algod = client(network);
  const addr = acct.addr.toString();

  // Registered already? new_agent asserts one identity per address, so a second
  // attempt fails on chain with an assert nobody can read. Checking first turns
  // that into a sentence.
  const existing = await readBox(algod, apps.identity, boxName("ad_", algosdk.decodeAddress(addr).publicKey));
  if (existing) {
    io.out(`${addr.slice(0, 12)}… is already agent ${Number(Buffer.from(existing).readBigUInt64BE(0))}.`);
    io.out(`Use "ripar score --address ${addr}" to read it, or update_agent to change the domain.`);
    return 0;
  }
  const taken = await readBox(algod, apps.identity, boxName("dm_", Buffer.from(domain)));
  if (taken) {
    io.err(`"${domain}" is already registered to agent ${Number(Buffer.from(taken).readBigUInt64BE(0))}.`);
    return 1;
  }

  // The record box is keyed by the id the contract is ABOUT to mint. Declaring
  // the wrong one fails with "invalid Box reference", which says nothing about
  // the cause.
  const app = await algod.getApplicationByID(apps.identity).do();
  const countEntry = (app.params?.globalState ?? []).find(
    (e) => Buffer.from(e.key).toString("utf8") === "agent_count"
  );
  const nextId = Number(countEntry?.value?.uint ?? 0) + 1;

  if (args.dryRun) {
    io.out(`would register "${domain}" to ${addr} as agent ${nextId} on ${network}`);
    return 0;
  }

  const method = new algosdk.ABIMethod({
    name: "new_agent",
    args: [{ type: "string", name: "agent_domain" }],
    returns: { type: "uint64" },
  });
  const sp = await algod.getTransactionParams().do();
  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID: apps.identity,
    method,
    methodArgs: [domain],
    sender: acct.addr,
    signer: algosdk.makeBasicAccountTransactionSigner(acct),
    boxes: [
      { appIndex: apps.identity, name: boxName("ad_", algosdk.decodeAddress(addr).publicKey) },
      { appIndex: apps.identity, name: boxName("dm_", Buffer.from(domain)) },
      { appIndex: apps.identity, name: boxName("ag_", u64(nextId)) },
    ],
    // Three boxes plus the call. A short fee fails with a pooling error that
    // reads like a network problem.
    suggestedParams: { ...sp, fee: 3000, flatFee: true },
  });

  try {
    const result = await atc.execute(algod, 6);
    const agentId = Number(result.methodResults[0].returnValue);
    io.out(`registered "${domain}" as agent ${agentId}`);
    io.out(`  address  ${addr}`);
    io.out(`  txid     ${result.txIDs.at(-1)}`);
    io.out(`  explorer https://lora.algokit.io/${network}/transaction/${result.txIDs.at(-1)}`);
    io.out(
      `\nPublish the same id in your agent card's registry extension. A caller resolves the\n` +
        `domain, checks the address matches the one it is being asked to pay, and only then decides.`
    );
    return 0;
  } catch (err) {
    io.err(`Registration failed: ${(err as Error).message.slice(0, 300)}`);
    return 1;
  }
}

/* ── the chain reads, behind one seam ───────────────────────────────────── */

export type AppSnapshot = { globals: Record<string, number>; approvalProgram: Uint8Array };

/**
 * The two chain reads the commands below need.
 *
 * An interface rather than an Algodv2 for the same reason cmdOpenApi takes its
 * loader: a command that builds its own node client is a command whose branches
 * can only be exercised against a live network, and "what does this print for a
 * disputed job" is not a question worth waiting on a testnet to answer.
 */
export type ChainReader = {
  box(appId: number, name: Uint8Array): Promise<Uint8Array | null>;
  app(appId: number): Promise<AppSnapshot>;
  /** Asset ids an account has opted into, or null if the account does not exist. */
  assets(address: string): Promise<number[] | null>;
};

export function algodReader(network: string): ChainReader {
  const algod = client(network);
  return {
    box: (appId, name) => readBox(algod, appId, name),
    app: async (appId) => {
      const app = await algod.getApplicationByID(appId).do();
      const globals: Record<string, number> = {};
      for (const entry of app.params?.globalState ?? []) {
        // algosdk hands the key back as raw bytes, not base64 — the same trap
        // cmdJobs documents. Decoded once, here, so no caller repeats it.
        globals[Buffer.from(entry.key).toString("utf8")] = Number(entry.value?.uint ?? 0);
      }
      return { globals, approvalProgram: new Uint8Array(app.params?.approvalProgram ?? []) };
    },
    assets: async (address) => {
      try {
        const acct = await algod.accountInformation(address).do();
        // algosdk has spelled this both ways across majors, and reading the
        // wrong one yields NaN — which looks like "opted into nothing" rather
        // than like an error, so it would silently invert the check below.
        return (acct.assets ?? []).map((a) => {
          const raw = a as unknown as Record<string, unknown>;
          return Number(raw.assetId ?? raw["asset-id"]);
        });
      } catch {
        // A never-funded address 404s. That is a real answer — it holds nothing.
        return null;
      }
    },
  };
}

/* ── ripar test ─────────────────────────────────────────────────────────── */

export type Check = { name: string; ok: boolean; detail: string };

/**
 * Everything that has to be true before somebody says an agent is live.
 *
 * Each check is one thing that has actually broken a deployment of this project:
 * a manifest served from the wrong path, a 402 with no readable quote, a
 * challenge missing its asset, a browser dashboard that cannot see the price
 * because the header is not exposed, a health route that answers 404 while the
 * agent is fine.
 *
 * The probe is a POST with NO body and NO content-type, which matters: an
 * endpoint declaring an input schema validates a request that HAS a body, so a
 * probe sending `{}` gets a 400 for a missing field and this would report a
 * perfectly good endpoint as broken. A bodyless probe is what price discovery
 * looks like, and it is what the payment gate answers with a quote.
 */
export async function cmdTest(
  args: { url?: string; json?: boolean; origin?: string; fetchImpl?: typeof fetch },
  io: CliIO
) {
  const base = (args.url ?? "").replace(/\/$/, "");
  if (!base) {
    io.err("ripar test needs a URL: ripar test https://api.ripar.io");
    return 1;
  }
  const doFetch = args.fetchImpl ?? globalThis.fetch;
  const origin = args.origin ?? "https://dashboard.example.com";
  const checks: Check[] = [];

  const manifestUrl = `${base.replace(/\/\.well-known\/ripar\.json$/, "")}/.well-known/ripar.json`;
  let mf: ManifestShape | null = null;
  try {
    const res = await doFetch(manifestUrl, { headers: { accept: "application/json" } });
    mf = res.ok ? ((await res.json()) as ManifestShape) : null;
    checks.push({
      name: "manifest",
      ok: res.ok && Array.isArray(mf?.endpoints) && mf.endpoints.length > 0,
      detail: !res.ok
        ? `${manifestUrl} answered ${res.status}`
        : Array.isArray(mf?.endpoints) && mf.endpoints.length
          ? `${mf.endpoints.length} endpoint(s) as ${mf?.handle ?? "?"} on ${mf?.network ?? "?"}`
          : `${manifestUrl} parsed but lists no endpoints`,
    });
  } catch (err) {
    checks.push({ name: "manifest", ok: false, detail: `${manifestUrl}: ${(err as Error).message}` });
  }

  const endpoints = mf?.endpoints ?? [];
  for (const e of endpoints) {
    const url = e.url ?? `${base}/${e.name}`;
    const label = pathOf(url);
    const probe = await probe402(url, origin, doFetch);

    checks.push({
      name: `402 ${label}`,
      ok: probe.status === 402,
      detail:
        probe.error ??
        (probe.status === 402
          ? "402 Payment Required"
          : `answered ${probe.status} — an endpoint that does not ask for payment is not a paid endpoint`),
    });
    if (probe.status !== 402) continue;

    checks.push({
      name: `quote ${label}`,
      ok: probe.requirements != null,
      detail:
        probe.requirements != null
          ? `PAYMENT-REQUIRED decoded${probe.headerName ? ` from ${probe.headerName}` : ""}`
          : "402 carried no readable PAYMENT-REQUIRED header — the header is base64 JSON, not JSON",
    });

    const accept = probe.accept;
    const named = accept?.amount != null || accept?.maxAmountRequired != null;
    checks.push({
      name: `challenge ${label}`,
      ok: named && accept?.asset != null,
      detail: named
        ? accept?.asset != null
          ? `${accept.amount ?? accept.maxAmountRequired} of asset ${accept.asset}` +
            (probe.usd != null ? ` ($${probe.usd})` : " (decimals unknown, so no USD)")
          : "names an amount but no asset, so nobody can tell what it is denominated in"
        : "names no amount, so there is nothing to pay",
    });

    const allowOrigin = probe.headers?.["access-control-allow-origin"];
    const exposed = (probe.headers?.["access-control-expose-headers"] ?? "").toLowerCase();
    checks.push({
      name: `cors ${label}`,
      ok: Boolean(allowOrigin) && exposed.includes("payment-required"),
      detail: !allowOrigin
        ? "no access-control-allow-origin: a browser cannot call this at all"
        : exposed.includes("payment-required")
          ? `${allowOrigin}, exposing payment-required`
          : `${allowOrigin} but payment-required is not in access-control-expose-headers — ` +
            `the browser gets a 402 it cannot read the price out of`,
    });
  }

  const health = await probeHealth(base, endpoints, doFetch);
  checks.push({ name: "health", ok: health.ok, detail: health.detail });

  const failed = checks.filter((c) => !c.ok);
  if (args.json) {
    io.out(JSON.stringify({ url: base, ok: failed.length === 0, failed: failed.length, checks }, null, 2));
    return failed.length === 0 ? 0 : 1;
  }

  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) io.out(`${c.ok ? "ok  " : "FAIL"}  ${c.name.padEnd(width)}  ${c.detail}`);
  io.out("");
  io.out(
    failed.length === 0
      ? `All ${checks.length} checks passed. ${base} is answering, quoting and readable from a browser.`
      : `${failed.length} of ${checks.length} check(s) failed.`
  );
  return failed.length === 0 ? 0 : 1;
}

/* ── ripar bench ────────────────────────────────────────────────────────── */

/**
 * How long the quote leg actually takes, measured rather than assumed.
 *
 * Only the quote is timed, and deliberately: quoting is free, so this can be run
 * against somebody else's agent as many times as the caller likes without
 * spending anything. It is also the leg every call pays for — a caller that
 * cannot get a price in reasonable time cannot pay in reasonable time either.
 *
 * A failed request is EXCLUDED and counted, never folded in as a slow one. A
 * timeout recorded as a latency is the single easiest way to publish a p95 that
 * flatters an endpoint which was simply down.
 */
export async function cmdBench(
  args: { url?: string; n?: number; json?: boolean; body?: unknown; fetchImpl?: typeof fetch },
  io: CliIO
) {
  const url = args.url;
  if (!url) {
    io.err("ripar bench needs a URL: ripar bench https://api.ripar.io/api/summarize");
    return 1;
  }
  const n = Math.max(1, Math.floor(args.n ?? 10));
  const doFetch = args.fetchImpl ?? globalThis.fetch;

  const samples: number[] = [];
  const excluded: { attempt: number; reason: string }[] = [];
  let usd: number | null = null;
  let priceMoved = false;

  for (let i = 1; i <= n; i++) {
    const started = Date.now();
    const probe = await probe402(url, undefined, doFetch, args.body);
    const ms = Date.now() - started;
    if (probe.error) {
      excluded.push({ attempt: i, reason: probe.error });
      continue;
    }
    if (probe.status !== 402) {
      excluded.push({ attempt: i, reason: `answered ${probe.status} rather than 402` });
      continue;
    }
    samples.push(ms);
    // A price that changes mid-run makes "the quoted cost per call" a lie by
    // omission, so it is reported rather than averaged away.
    if (usd != null && probe.usd != null && Math.abs(probe.usd - usd) > 1e-9) priceMoved = true;
    if (probe.usd != null) usd = probe.usd;
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const stats = {
    url,
    requested: n,
    measured: samples.length,
    excluded: excluded.length,
    p50: sorted.length ? percentile(sorted, 50) : null,
    p95: sorted.length ? percentile(sorted, 95) : null,
    max: sorted.length ? sorted[sorted.length - 1] : null,
    min: sorted.length ? sorted[0] : null,
    quotedUsd: usd,
    priceMoved,
    exclusions: excluded,
  };

  if (args.json) {
    io.out(JSON.stringify(stats, null, 2));
    return samples.length ? 0 : 1;
  }

  io.out(url);
  if (!samples.length) {
    io.err(`No request succeeded, so there is nothing to report. ${excluded.length} excluded:`);
    for (const x of excluded.slice(0, 5)) io.err(`  #${x.attempt}  ${x.reason}`);
    return 1;
  }
  io.out(`  quotes    ${samples.length} measured of ${n} requested`);
  io.out(`  p50       ${stats.p50}ms`);
  io.out(`  p95       ${stats.p95}ms`);
  io.out(`  max       ${stats.max}ms   (min ${stats.min}ms)`);
  io.out(`  cost      ${usd != null ? `$${usd} per call` : "quoted, but the amount could not be read"}`);
  if (priceMoved) io.out(`  note      the quote CHANGED during the run; the figure above is the last one`);
  if (excluded.length) {
    io.out(`  excluded  ${excluded.length} request(s), not counted as latency:`);
    for (const x of excluded.slice(0, 5)) io.out(`              #${x.attempt}  ${x.reason}`);
  }
  io.out("");
  io.out(
    `Quote round trips only — free, and the leg every paid call waits on. ` +
      (samples.length < 20
        ? `With ${samples.length} samples p95 is the ${percentileRank(samples.length, 95)}${ordinal(
            percentileRank(samples.length, 95)
          )} slowest, which is arithmetic rather than a measurement of the tail.`
        : `Percentiles are nearest-rank over ${samples.length} samples.`)
  );
  return 0;
}

/* ── ripar audit ────────────────────────────────────────────────────────── */

export type Finding = { code: string; title: string; detail: string; why: string };

/**
 * The specific ways a deployed Ripar agent has actually been broken.
 *
 * Not a generic linter. Every finding here is something this project shipped and
 * had to diagnose from the outside, which is why each one carries a `why`: a
 * finding without a consequence is a style note, and gets ignored.
 */
export async function cmdAudit(
  args: { url?: string; network?: string; json?: boolean; fetchImpl?: typeof fetch; reader?: ChainReader },
  io: CliIO
) {
  const base = (args.url ?? "").replace(/\/$/, "").replace(/\/\.well-known\/ripar\.json$/, "");
  if (!base) {
    io.err("ripar audit needs a URL: ripar audit https://api.ripar.io");
    return 1;
  }
  const network = args.network ?? "testnet";
  const doFetch = args.fetchImpl ?? globalThis.fetch;
  const findings: Finding[] = [];
  const passed: string[] = [];

  let mf: ManifestShape;
  try {
    const res = await doFetch(`${base}/.well-known/ripar.json`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`answered ${res.status}`);
    mf = (await res.json()) as ManifestShape;
  } catch (err) {
    io.err(
      `No readable manifest at ${base}/.well-known/ripar.json (${(err as Error).message}). ` +
        `Everything else here is checked against it, so there is nothing to audit.`
    );
    return 1;
  }

  const endpoints = mf.endpoints ?? [];
  /** Every ASA this agent asks to be paid in, and which endpoints ask for it. */
  const quotedAssets = new Map<number, string[]>();
  for (const e of endpoints) {
    const url = e.url ?? `${base}/${e.name}`;
    const label = pathOf(url);
    const probe = await probe402(url, "https://dashboard.example.com", doFetch);

    // 1. advertised but not there.
    if (probe.status === 404 || probe.status === 405) {
      findings.push({
        code: "endpoint_missing",
        title: `${label} is advertised in the manifest and answers ${probe.status}`,
        detail: `The manifest lists ${url}, and it is not routed.`,
        why:
          `Discovery hands this URL to strangers' agents. Every one of them will fail on it, and the ` +
          `failure looks like their bug — an unroutable advertised endpoint is worse than an undocumented one.`,
      });
      continue;
    }
    if (probe.error) {
      findings.push({
        code: "endpoint_unreachable",
        title: `${label} could not be reached`,
        detail: probe.error,
        why: `An endpoint that cannot be probed cannot be bought. Callers see a transport error and move on.`,
      });
      continue;
    }

    // 2. quote unreadable from the PAYMENT-REQUIRED header.
    if (probe.status === 402 && probe.requirements == null) {
      findings.push({
        code: "quote_unreadable",
        title: `${label} answers 402 with no readable PAYMENT-REQUIRED header`,
        detail: `The header is missing or is not base64-encoded JSON, and the body carried no requirements either.`,
        why:
          `A price nobody can parse is a price no cap can check. This SDK fails closed and refuses to pay ` +
          `blind, so the endpoint is unreachable to any caller with maxPrice set — which is every careful one.`,
      });
    } else if (probe.status === 402 && probe.usd == null) {
      findings.push({
        code: "quote_unpriceable",
        title: `${label} quotes an amount that cannot be converted to USD`,
        detail: `accepts names asset ${probe.accept?.asset ?? "?"}, whose decimals are not known to this SDK.`,
        why:
          `Atomic units are not dollars. A client that guessed six decimals here would be wrong by a ` +
          `millionfold in the direction that pays, so this SDK refuses the quote instead.`,
      });
    }

    const asset = Number(probe.accept?.asset ?? 0);
    // 0 is ALGO, which needs no opt-in. Everything else does.
    if (asset > 0) quotedAssets.set(asset, [...(quotedAssets.get(asset) ?? []), label]);

    // 3. CORS.
    const allowOrigin = probe.headers?.["access-control-allow-origin"];
    const exposed = (probe.headers?.["access-control-expose-headers"] ?? "").toLowerCase();
    if (!allowOrigin) {
      findings.push({
        code: "cors_missing",
        title: `${label} sends no access-control-allow-origin`,
        detail: `A cross-origin request from a browser gets nothing back.`,
        why:
          `Every browser dashboard, playground and hosted client is cross-origin. Without this header the ` +
          `agent is callable only from a server — and the failure surfaces in the caller's console, not here.`,
      });
    } else if (!exposed.includes("payment-required")) {
      findings.push({
        code: "cors_hides_quote",
        title: `${label} allows the origin but does not expose payment-required`,
        detail: `access-control-expose-headers is "${probe.headers?.["access-control-expose-headers"] ?? ""}".`,
        why:
          `The browser makes the request, gets the 402, and hides the header the price is in. The call ` +
          `"works" and the quote is silently gone — app.ripar.io hit exactly this in production.`,
      });
    }
  }

  // 4. payTo must be able to RECEIVE what it asks for.
  //
  // On Algorand an ASA transfer to an account that has not opted in is rejected
  // at consensus. An agent quoting an asset its payTo does not hold is asking
  // for a payment that cannot land: the caller signs, submits, and the network
  // refuses it. Nothing on the HTTP side reports this — the 402 is well-formed,
  // the facilitator accepts the quote, and the failure happens after the money
  // leaves. api.ripar.io shipped exactly this, quoting real TestNet USDC into
  // an address opted into only its own test asset, and it went unnoticed
  // because zero payments succeeding looks identical to zero payments tried.
  const reader = args.reader ?? algodReader(network);
  const apps = REGISTRY[network];
  const payTo = mf.payTo;

  if (payTo && /^[A-Z2-7]{58}$/.test(payTo) && quotedAssets.size > 0) {
    const held = await reader.assets(payTo);
    if (held == null) {
      findings.push({
        code: "payto_nonexistent",
        title: `payTo ${payTo.slice(0, 10)}… does not exist on ${network}`,
        detail: `The account has never been funded, so it holds nothing and is opted into nothing.`,
        why:
          `Every quote this agent sends names an address the network does not know. No payment to it can ` +
          `settle, on any asset.`,
      });
    } else {
      for (const [asset, labels] of quotedAssets) {
        if (held.includes(asset)) {
          passed.push(`settlement: payTo is opted into asset ${asset}, so a payment can land`);
          continue;
        }
        findings.push({
          code: "payto_not_optedin",
          title: `payTo is not opted into asset ${asset}, which it quotes on ${labels.join(", ")}`,
          detail:
            `${payTo.slice(0, 10)}… holds ${held.length ? `asset(s) ${held.join(", ")}` : "no assets"}, ` +
            `and asset ${asset} is not among them.`,
          why:
            `An ASA transfer to a non-opted-in account fails at consensus. The 402 is well-formed and the ` +
            `facilitator will accept it, so the caller signs a payment the network then rejects — and the ` +
            `agent never learns, because a payment that cannot land never arrives to be counted.`,
        });
      }
    }
  }

  let registeredId = 0;
  if (!apps?.identity) {
    passed.push(`identity: the registries are not deployed on ${network}, so payTo could not be checked`);
  } else if (!payTo || !/^[A-Z2-7]{58}$/.test(payTo)) {
    findings.push({
      code: "payto_invalid",
      title: `The manifest's payTo is not an Algorand address`,
      detail: `payTo is ${payTo ? `"${payTo}"` : "absent"}.`,
      why: `Settlement has nowhere to go. Every 402 this agent sends quotes an address nobody can pay.`,
    });
  } else {
    const box = await reader.box(apps.identity, boxName("ad_", algosdk.decodeAddress(payTo).publicKey));
    registeredId = box ? Number(Buffer.from(box).readBigUInt64BE(0)) : 0;
    if (!registeredId) {
      findings.push({
        code: "payto_unregistered",
        title: `payTo is not registered in IdentityRegistry ${apps.identity}`,
        detail: `${payTo.slice(0, 10)}… has no ad_ entry, so the registry has never seen this address.`,
        why:
          `The manifest is a file on a web server: anyone who controls the host can put any address in it. ` +
          `The registry entry is signed by the account being paid, and it is the only part of this a ` +
          `stranger's agent can verify before sending money.`,
      });
    } else {
      passed.push(`identity: payTo is agent ${registeredId} in registry ${apps.identity}`);
    }
  }

  // 5. an agent card claiming an id that does not resolve.
  const card = await readAgentCard(base, doFetch);
  if (card.claimed != null && apps?.identity) {
    const agentBox = await reader.box(apps.identity, boxName("ag_", u64(card.claimed)));
    const agent = agentBox ? decodeAgent(agentBox) : null;
    if (!agent) {
      findings.push({
        code: "agentid_unresolvable",
        title: `The agent card claims agentId ${card.claimed}, which does not exist in registry ${apps.identity}`,
        detail: `No ag_ box for ${card.claimed}. The registry's own answer for an unknown id is nothing at all.`,
        why:
          `The claim is the whole point of the registry extension: a caller is meant to resolve the id and ` +
          `check the address before paying. An id that resolves to nothing turns a checkable claim back into ` +
          `an assertion, and a caller that trusts it is trusting the card again.`,
      });
    } else if (payTo && agent.address !== payTo) {
      findings.push({
        code: "agentid_wrong_address",
        title: `agentId ${card.claimed} resolves to a different address than payTo`,
        detail: `registry says ${agent.address.slice(0, 10)}…, the manifest asks callers to pay ${payTo.slice(0, 10)}….`,
        why:
          `This is what an identity claim looks like once it has been repointed: the reputation belongs to ` +
          `one account and the money goes to another. A caller checking the id would approve a payment to ` +
          `an address the registry never attested to.`,
      });
    } else {
      passed.push(`card: agentId ${card.claimed} resolves to payTo, domain "${agent.domain}"`);
    }
  } else if (card.claimed == null) {
    passed.push(
      card.found
        ? `card: /.well-known/agent.json carries no registry extension, so it claims no agentId`
        : `card: no /.well-known/agent.json served, so there is no id claim to check`
    );
  }

  if (args.json) {
    io.out(JSON.stringify({ url: base, findings, passed }, null, 2));
    return findings.length === 0 ? 0 : 1;
  }

  for (const f of findings) {
    io.out(`FINDING  ${f.title}`);
    io.out(`         ${f.detail}`);
    io.out(`   why   ${f.why}`);
    io.out("");
  }
  for (const p of passed) io.out(`ok       ${p}`);
  io.out("");
  io.out(
    findings.length === 0
      ? `No findings against ${base}.`
      : `${findings.length} finding(s) against ${base}.`
  );
  return findings.length === 0 ? 0 : 1;
}

/* ── ripar escrow ───────────────────────────────────────────────────────── */

const JOB_STATUS = ["open", "assigned", "submitted", "validated", "disputed", "cancelled"];

/**
 * What is held for a job, and what may legally happen to it next.
 *
 * The lifecycle is enforced by asserts in the contract, and an assert reads as
 * "transaction rejected" with no clue which rule was broken. This says the rule
 * first: which method, who may send it, and — where a window is involved — when.
 *
 * The escrow is read from its own `es_` box rather than from the job, because a
 * budget is what the client SAYS the work is worth and escrow is what they
 * actually handed over. A validated job with no escrow has nothing to release,
 * and `release_escrow` on it fails an assert that names none of that.
 */
export async function cmdEscrow(
  args: { jobId?: number; network?: string; json?: boolean; reader?: ChainReader; now?: number },
  io: CliIO
) {
  const network = args.network ?? "testnet";
  const apps = REGISTRY[network];
  if (!apps?.validation) {
    io.err(`The registries are not deployed on ${network}. Try --network testnet.`);
    return 1;
  }
  const jobId = args.jobId;
  if (!jobId || !Number.isInteger(jobId) || jobId < 1) {
    io.err("ripar escrow needs a job id: ripar escrow 1");
    return 1;
  }

  const reader = args.reader ?? algodReader(network);
  const raw = await reader.box(apps.validation, boxName("jb_", u64(jobId)));
  if (!raw) {
    io.err(
      `No job ${jobId} in ValidationRegistry ${apps.validation}. Ids start at 1 and only ever climb, so ` +
        `this is either unposted or on another network.`
    );
    return 1;
  }

  const job = decodeJob(raw);
  const escrowBox = await reader.box(apps.validation, boxName("es_", u64(jobId)));
  const escrowMicro = escrowBox ? Number(Buffer.from(escrowBox).readBigUInt64BE(0)) : 0;
  const globals = await reader.app(apps.validation).then((a) => a.globals);
  const disputeWindow = Number(globals.dispute_window ?? 0);

  // Resolved through the IdentityRegistry, because that is the only place an
  // agent id is bound to an address — naming an id and leaving the reader to
  // guess who that is defeats the point of saying who may act.
  const assignee = await addressOfAgent(reader, apps.identity, job.serverAgentId);
  const validator = await addressOfAgent(reader, apps.identity, job.validatorAgentId);

  const now = args.now ?? Date.now();
  const windowOpensAt = (job.updatedAt + disputeWindow) * 1_000;
  const next = legalNext(job, escrowMicro, { assignee, validator, disputeWindow, windowOpensAt, now });

  if (args.json) {
    io.out(
      JSON.stringify(
        {
          jobId: job.jobId,
          status: JOB_STATUS[job.status] ?? String(job.status),
          client: job.client,
          serverAgentId: job.serverAgentId,
          assignee,
          validatorAgentId: job.validatorAgentId,
          validator,
          budgetMicro: job.budgetMicro,
          escrowMicro,
          funded: escrowMicro > 0,
          disputeWindowSecs: disputeWindow,
          updatedAt: new Date(job.updatedAt * 1_000).toISOString(),
          next,
        },
        null,
        2
      )
    );
    return 0;
  }

  io.out(`job ${job.jobId}  ${JOB_STATUS[job.status] ?? `status ${job.status}`}`);
  io.out(`  client     ${job.client}`);
  io.out(`  agent      ${job.serverAgentId || "unassigned"}${assignee ? `  ${assignee}` : ""}`);
  io.out(
    `  validator  ${job.validatorAgentId || "none — the client judges it"}${validator ? `  ${validator}` : ""}`
  );
  io.out(`  budget     ${(job.budgetMicro / 1e6).toFixed(6)}`);
  io.out(`  escrow     ${(escrowMicro / 1e6).toFixed(6)}  ${escrowMicro > 0 ? "FUNDED" : "unfunded"}`);
  io.out(`  updated    ${new Date(job.updatedAt * 1_000).toISOString()}`);
  io.out("");
  io.out("legal next:");
  for (const n of next) {
    io.out(`  ${n.method}`);
    io.out(`      who   ${n.who}`);
    if (n.when) io.out(`      when  ${n.when}`);
    io.out(`      what  ${n.what}`);
  }
  if (escrowMicro === 0 && job.budgetMicro > 0) {
    io.out("");
    io.out(
      `The budget is a stated intention: ${(job.budgetMicro / 1e6).toFixed(6)} was named and nothing was ` +
        `moved into escrow, so there is nothing to release and nothing to refund.`
    );
  }
  return 0;
}

type NextAction = { method: string; who: string; when?: string; what: string };

function legalNext(
  job: DecodedJob,
  escrowMicro: number,
  ctx: { assignee: string | null; validator: string | null; disputeWindow: number; windowOpensAt: number; now: number }
): NextAction[] {
  const client_ = job.client;
  const held = `${(escrowMicro / 1e6).toFixed(6)} held`;
  const windowState =
    ctx.now >= ctx.windowOpensAt
      ? `the ${ctx.disputeWindow}s window closed at ${new Date(ctx.windowOpensAt).toISOString()}, so this is open now`
      : `not before ${new Date(ctx.windowOpensAt).toISOString()} (${ctx.disputeWindow}s after the last update; ` +
        `the contract compares against the block timestamp, which can trail your clock by a few seconds)`;

  switch (job.status) {
    case 0:
      return [
        { method: "fund_job", who: `the client, ${client_}`, what: `move the budget into escrow. Currently ${held}.` },
        {
          method: "assign_job / accept_bid",
          who: `the client, ${client_}`,
          what: `give the work to an agent. accept_bid overwrites the budget with the bid price.`,
        },
        {
          method: "place_bid",
          who: `any registered agent except the client`,
          what: `offer to do it. The bidder is resolved through the IdentityRegistry, so nobody can bid as somebody else.`,
        },
        { method: "set_validator / cancel_job", who: `the client, ${client_}`, what: `while it is still open.` },
      ];
    case 1:
      return [
        {
          method: "submit_result",
          who: ctx.assignee ? `agent ${job.serverAgentId}, ${ctx.assignee}` : `agent ${job.serverAgentId}`,
          what: `commit the result hash. Only the assigned agent may — it is checked against the registry.`,
        },
        { method: "fund_job", who: `the client, ${client_}`, what: `still allowed while assigned. Currently ${held}.` },
        {
          method: "expire_job",
          who: `anyone`,
          when: windowState,
          what: `cancel an assignment nobody delivered on, so the client can reclaim the escrow.`,
        },
      ];
    case 2:
      return [
        {
          method: "validation_response",
          who: job.validatorAgentId
            ? `validator agent ${job.validatorAgentId}${ctx.validator ? `, ${ctx.validator}` : ""}`
            : `the client, ${client_} — no validator was named`,
          what: `pass or fail the submitted result. The verdict is written through to the agent's score.`,
        },
      ];
    case 3: {
      const actions: NextAction[] = [
        {
          method: "release_escrow",
          who: `the client (${client_}) now; ANYONE after the dispute window`,
          when: windowState,
          what:
            escrowMicro > 0
              ? `pay ${held} to agent ${job.serverAgentId}${ctx.assignee ? ` (${ctx.assignee})` : ""}. ` +
                `The anyone-after-the-window path exists so an absent validator cannot freeze the worker's money.`
              : `nothing is escrowed, so this would fail its own assert ("nothing is escrowed for this job").`,
        },
      ];
      if (escrowMicro > 0) {
        actions.push({
          method: "release_partial",
          who: `the client only, ${client_}`,
          what: `pay part of the ${held}. Deliberately NOT open to anyone after the window — that path is for the worker to rescue their money, not for a stranger to dribble it out.`,
        });
      }
      return actions;
    }
    case 4:
    case 5:
      return [
        {
          method: "refund_escrow",
          who: `anyone may call it; it pays the client, ${client_}`,
          what:
            escrowMicro > 0
              ? `return ${held} to the client. The destination is read off the job, not the sender, so triggering a refund cannot redirect one.`
              : `nothing is escrowed, so this would fail its own assert.`,
        },
      ];
    default:
      return [{ method: "—", who: "—", what: `status ${job.status} is not one this CLI knows about.` }];
  }
}

/* ── ripar rotate ───────────────────────────────────────────────────────── */

const ROTATE_SIGNATURE = "rotate_address(uint64,address)bool";

/**
 * Move an agent's identity to a new controlling address.
 *
 * The contracts are ahead of the chain: `rotate_address` exists in
 * identity_registry.py and is NOT in the deployed approval program, so composing
 * the call and sending it would fail inside the AVM's method router with a bare
 * assert — the error every operator reads as "my transaction is malformed".
 *
 * So the deployed program is checked first, by looking for the method's own
 * 4-byte selector in the bytes the chain is actually running. The useful
 * direction of that check is absence: a selector that is not in the program
 * cannot be routed to, whatever the source says.
 */
export async function cmdRotate(
  args: {
    agentId?: number;
    newAddress?: string;
    network?: string;
    dryRun?: boolean;
    json?: boolean;
    mnemonic?: string;
    reader?: ChainReader;
  },
  io: CliIO
) {
  const network = args.network ?? "testnet";
  const apps = REGISTRY[network];
  if (!apps?.identity) {
    io.err(`The registries are not deployed on ${network}. Try --network testnet.`);
    return 1;
  }
  const agentId = args.agentId;
  if (!agentId || !Number.isInteger(agentId) || agentId < 1) {
    io.err("ripar rotate needs an agent id and an address: ripar rotate 1 <NEW_ADDRESS> --dry-run");
    return 1;
  }
  const newAddress = (args.newAddress ?? "").trim();
  try {
    algosdk.decodeAddress(newAddress);
  } catch {
    io.err(
      `"${newAddress || "(missing)"}" is not an Algorand address. Rotating to an address with a bad checksum ` +
        `would hand the identity to a key nobody holds, and the contract cannot check that for you.`
    );
    return 1;
  }

  const reader = args.reader ?? algodReader(network);
  const agentBox = await reader.box(apps.identity, boxName("ag_", u64(agentId)));
  if (!agentBox) {
    io.err(`Agent ${agentId} does not exist in IdentityRegistry ${apps.identity} on ${network}.`);
    return 1;
  }
  const agent = decodeAgent(agentBox);

  if (agent.address === newAddress) {
    io.err(
      `${newAddress.slice(0, 10)}… is already the controlling address of agent ${agentId}. The contract ` +
        `refuses this ("that is already the controlling address") rather than charging a fee for nothing.`
    );
    return 1;
  }
  const taken = await reader.box(apps.identity, boxName("ad_", algosdk.decodeAddress(newAddress).publicKey));
  if (taken) {
    io.err(
      `${newAddress.slice(0, 10)}… already controls agent ${Number(Buffer.from(taken).readBigUInt64BE(0))}. ` +
        `One identity per address is asserted on chain, so this rotation cannot succeed.`
    );
    return 1;
  }

  const { approvalProgram } = await reader.app(apps.identity);
  const selector = methodSelector(ROTATE_SIGNATURE);
  const deployed = Buffer.from(approvalProgram).includes(Buffer.from(selector));

  const plan = {
    network,
    app: apps.identity,
    method: ROTATE_SIGNATURE,
    agentId,
    domain: agent.domain,
    from: agent.address,
    to: newAddress,
    mustBeSignedBy: agent.address,
    boxes: [`ag_${agentId}`, `ad_(old)`, `ad_(new)`],
    deployed,
    selector: `0x${Buffer.from(selector).toString("hex")}`,
  };

  if (args.dryRun) {
    if (args.json) {
      io.out(JSON.stringify({ dryRun: true, ...plan }, null, 2));
      return 0;
    }
    io.out(`would rotate agent ${agentId} ("${agent.domain}") on ${network}`);
    io.out(`  app        ${apps.identity}`);
    io.out(`  method     ${ROTATE_SIGNATURE}  ${plan.selector}`);
    io.out(`  from       ${agent.address}`);
    io.out(`  to         ${newAddress}`);
    io.out(`  signed by  ${agent.address} — the CURRENT address, which is what the contract checks`);
    io.out(`  boxes      ag_${agentId} (the record), ad_ for both addresses (the reverse index moves with it)`);
    io.out("");
    io.out(
      deployed
        ? `The deployed program routes this method, so a real run would send it.`
        : `The deployed program does NOT contain this method's selector, so a real run would be refused here ` +
            `rather than failing inside the AVM. The contracts are ahead of the chain: rotate_address exists in ` +
            `identity_registry.py and app ${apps.identity} was deployed before it. Redeploy the registry, or ` +
            `deregister_agent and register again from the new address — which mints a NEW id and leaves the ` +
            `old id's reputation behind.`
    );
    io.out("");
    io.out(`Nothing was signed and nothing was sent.`);
    return 0;
  }

  if (!deployed) {
    io.err(
      `rotate_address is not on the deployed registry yet.\n\n` +
        `App ${apps.identity} on ${network} does not contain the selector for ${ROTATE_SIGNATURE} ` +
        `(${plan.selector}), so the call would reach the method router, match nothing, and fail with a bare ` +
        `assert. The contracts in this repo are ahead of the chain.\n\n` +
        `Until the registry is redeployed:\n` +
        `  · "ripar rotate ${agentId} ${newAddress.slice(0, 10)}… --dry-run" shows exactly what would be sent;\n` +
        `  · deregister_agent from ${agent.address.slice(0, 10)}… and new_agent from the new address works ` +
        `today, but mints a new id — the old id's score and job history stay with the old id.`
    );
    return 1;
  }

  const mnemonic = args.mnemonic ?? process.env.RIPAR_MNEMONIC;
  if (!mnemonic) {
    io.err(
      `No key. Set RIPAR_MNEMONIC to the mnemonic of ${agent.address} — the CURRENT controlling address, ` +
        `because that is the only signature the contract accepts for a rotation.\n\n` +
        `An environment variable and not a flag: a flag ends up in your shell history and in the process list.`
    );
    return 1;
  }

  let acct: algosdk.Account;
  try {
    acct = algosdk.mnemonicToSecretKey(mnemonic.trim());
  } catch (err) {
    io.err(`RIPAR_MNEMONIC is not a valid 25-word mnemonic: ${(err as Error).message}`);
    return 1;
  }
  if (acct.addr.toString() !== agent.address) {
    io.err(
      `RIPAR_MNEMONIC is ${acct.addr.toString().slice(0, 10)}…, and agent ${agentId} is controlled by ` +
        `${agent.address.slice(0, 10)}…. Only the current address may rotate, so this would be rejected on chain.`
    );
    return 1;
  }

  const algod = client(network);
  const method = new algosdk.ABIMethod({
    name: "rotate_address",
    args: [
      { type: "uint64", name: "agent_id" },
      { type: "address", name: "new_address" },
    ],
    returns: { type: "bool" },
  });
  const sp = await algod.getTransactionParams().do();
  const atc = new algosdk.AtomicTransactionComposer();
  atc.addMethodCall({
    appID: apps.identity,
    method,
    methodArgs: [agentId, newAddress],
    sender: acct.addr,
    signer: algosdk.makeBasicAccountTransactionSigner(acct),
    // Three boxes: the record, and BOTH ends of the reverse index — the old
    // entry is deleted and the new one written, and an undeclared box reference
    // fails with "invalid Box reference", which says nothing about the cause.
    boxes: [
      { appIndex: apps.identity, name: boxName("ag_", u64(agentId)) },
      { appIndex: apps.identity, name: boxName("ad_", algosdk.decodeAddress(agent.address).publicKey) },
      { appIndex: apps.identity, name: boxName("ad_", algosdk.decodeAddress(newAddress).publicKey) },
    ],
    suggestedParams: { ...sp, fee: 3000, flatFee: true },
  });

  try {
    const result = await atc.execute(algod, 6);
    if (args.json) {
      io.out(JSON.stringify({ ...plan, dryRun: false, txId: result.txIDs.at(-1) }, null, 2));
      return 0;
    }
    io.out(`rotated agent ${agentId} to ${newAddress}`);
    io.out(`  txid     ${result.txIDs.at(-1)}`);
    io.out(`  explorer https://lora.algokit.io/${network}/transaction/${result.txIDs.at(-1)}`);
    return 0;
  } catch (err) {
    io.err(`Rotation failed: ${(err as Error).message.slice(0, 300)}`);
    return 1;
  }
}

/* ── decoding and probing ───────────────────────────────────────────────── */

export type DecodedJob = {
  jobId: number;
  client: string;
  serverAgentId: number;
  validatorAgentId: number;
  budgetMicro: number;
  status: number;
  createdAt: number;
  updatedAt: number;
};

/**
 * The `jb_` box, as ARC-4 lays a struct out.
 *
 * Fixed fields in declaration order, and the two DynamicBytes fields contribute
 * a 2-byte offset each to the head rather than their contents — which is why
 * `status` is at 68 and not at 64. Reading it at 64 yields the spec_hash offset,
 * a small number that decodes as a perfectly plausible status, and every job
 * reads as "open".
 */
export function decodeJob(raw: Uint8Array): DecodedJob {
  const b = Buffer.from(raw);
  if (b.length < 92) {
    throw new Error(`A job box head is 92 bytes; this one is ${b.length}. Refusing to decode it as a job.`);
  }
  return {
    jobId: Number(b.readBigUInt64BE(0)),
    client: algosdk.encodeAddress(b.subarray(8, 40)),
    serverAgentId: Number(b.readBigUInt64BE(40)),
    validatorAgentId: Number(b.readBigUInt64BE(48)),
    budgetMicro: Number(b.readBigUInt64BE(56)),
    status: Number(b.readBigUInt64BE(68)),
    createdAt: Number(b.readBigUInt64BE(76)),
    updatedAt: Number(b.readBigUInt64BE(84)),
  };
}

export type DecodedAgent = { agentId: number; address: string; domain: string; registeredAt: number; updatedAt: number };

/** The `ag_` box: id, a 2-byte offset where the domain lives, the address, and
 *  two timestamps. The domain is dynamic, so it is the OFFSET that sits in the
 *  head — decoding the address at byte 8 reads two bytes of offset and thirty of
 *  address, and produces a valid-looking address that is nobody's. */
export function decodeAgent(raw: Uint8Array): DecodedAgent {
  const b = Buffer.from(raw);
  if (b.length < 58) {
    throw new Error(`An agent box head is 58 bytes; this one is ${b.length}.`);
  }
  const domainAt = b.readUInt16BE(8);
  const length = domainAt + 2 <= b.length ? b.readUInt16BE(domainAt) : 0;
  return {
    agentId: Number(b.readBigUInt64BE(0)),
    address: algosdk.encodeAddress(b.subarray(10, 42)),
    domain: b.subarray(domainAt + 2, domainAt + 2 + length).toString("utf8"),
    registeredAt: Number(b.readBigUInt64BE(42)),
    updatedAt: Number(b.readBigUInt64BE(50)),
  };
}

async function addressOfAgent(reader: ChainReader, identityApp: number, agentId: number): Promise<string | null> {
  if (!agentId || !identityApp) return null;
  const box = await reader.box(identityApp, boxName("ag_", u64(agentId)));
  return box ? decodeAgent(box).address : null;
}

type ManifestShape = {
  handle?: string;
  network?: string;
  payTo?: string;
  endpoints?: { name: string; url?: string; method?: string; price?: string }[];
};

type Probe = {
  status: number;
  headers?: Record<string, string>;
  requirements?: unknown;
  accept?: Record<string, any> | null;
  usd?: number | null;
  headerName?: string;
  error?: string;
};

/**
 * One bodyless POST, and everything readable off the answer.
 *
 * Bodyless on purpose — see cmdTest. One request rather than several because
 * the status, the quote and the CORS headers all come off the same response, and
 * probing three times would be three chances for the endpoint to answer
 * differently.
 */
async function probe402(
  url: string,
  origin: string | undefined,
  doFetch: typeof fetch,
  body?: unknown
): Promise<Probe> {
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: {
        ...(origin ? { origin } : {}),
        ...(body != null ? { "content-type": "application/json" } : {}),
      },
      ...(body != null ? { body: JSON.stringify(body) } : {}),
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    if (res.status !== 402) return { status: res.status, headers };

    const requirements = readPaymentRequired(res.headers) ?? undefined;
    const picked = pickAccept(requirements);
    return {
      status: 402,
      headers,
      requirements,
      accept: picked?.accept ?? firstAcceptOf(requirements),
      usd: picked?.usd ?? null,
      headerName: headers["payment-required"] ? "PAYMENT-REQUIRED" : undefined,
    };
  } catch (err) {
    return { status: 0, error: (err as Error).message };
  }
}

/** The first accepts entry even when its price could not be read — a challenge
 *  naming an amount in an unknown asset is a different finding from one naming
 *  no amount at all, and pickAccept returns null for both. */
function firstAcceptOf(requirements: unknown): Record<string, any> | null {
  if (!requirements || typeof requirements !== "object") return null;
  const r = requirements as Record<string, any>;
  const accepts = r.accepts ?? r;
  const list = Array.isArray(accepts) ? accepts : [accepts];
  return (list[0] as Record<string, any>) ?? null;
}

/**
 * /health, looked for where the agent actually mounts it.
 *
 * `serve({ basePath })` puts every route behind a prefix, and an agent hosted
 * under /api has its health route at /api/health while /health is a 404 from the
 * host's own router. Checking only the bare path reports a healthy agent as
 * broken, which is a check nobody trusts twice.
 */
async function probeHealth(
  base: string,
  endpoints: { url?: string; name: string }[],
  doFetch: typeof fetch
): Promise<{ ok: boolean; detail: string }> {
  const origin = originOf(base);
  const prefixes = new Set<string>([""]);
  for (const e of endpoints) {
    const path = pathOf(e.url ?? `${base}/${e.name}`);
    const prefix = path.split("/").slice(0, -1).join("/");
    if (prefix) prefixes.add(prefix);
  }

  const tried: string[] = [];
  for (const prefix of prefixes) {
    const url = `${origin}${prefix}/health`;
    tried.push(url);
    try {
      const res = await doFetch(url, { headers: { accept: "application/json" } });
      if (res.ok) return { ok: true, detail: `${url} → ${res.status}` };
      // A 503 from a health route is the route WORKING: it is a dependency
      // probe reporting a dependency down, which is exactly what a load
      // balancer needs to see and is not the same as no health route at all.
      if (res.status === 503) {
        return { ok: false, detail: `${url} → 503, so a dependency probe is failing (the route itself is up)` };
      }
    } catch {
      /* try the next prefix */
    }
  }
  return {
    ok: false,
    detail: `no health route answered (tried ${tried.join(", ")}) — a load balancer has nothing to check`,
  };
}

/** The A2A card and the agentId it claims, if it serves one. */
async function readAgentCard(
  base: string,
  doFetch: typeof fetch
): Promise<{ found: boolean; claimed: number | null; identityApp: number | null }> {
  try {
    const res = await doFetch(`${base}/.well-known/agent.json`, { headers: { accept: "application/json" } });
    if (!res.ok) return { found: false, claimed: null, identityApp: null };
    const card = (await res.json()) as {
      capabilities?: { extensions?: { uri?: string; params?: Record<string, unknown> }[] };
    };
    const ext = (card.capabilities?.extensions ?? []).find((x) => String(x.uri ?? "").includes("/registry/"));
    const claimed = Number(ext?.params?.agentId ?? 0);
    return {
      found: true,
      claimed: Number.isInteger(claimed) && claimed > 0 ? claimed : null,
      identityApp: Number(ext?.params?.identityApp ?? 0) || null,
    };
  } catch {
    return { found: false, claimed: null, identityApp: null };
  }
}

/** The ARC-4 method selector: the first four bytes of SHA-512/256 over the
 *  signature. Not SHA-256 — a different hash gives four bytes that route to
 *  nothing, and the mistake looks exactly like a missing method. */
export function methodSelector(signature: string): Uint8Array {
  return new Uint8Array(createHash("sha512-256").update(signature).digest().subarray(0, 4));
}

/** Nearest-rank, over what was actually measured. */
function percentile(sorted: number[], p: number): number {
  return sorted[percentileRank(sorted.length, p) - 1];
}

function percentileRank(count: number, p: number): number {
  return Math.min(count, Math.max(1, Math.ceil((p / 100) * count)));
}

function ordinal(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return "th";
  return ["th", "st", "nd", "rd"][n % 10] ?? "th";
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/\/$/, "") || "/";
  } catch {
    return url;
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url.replace(/\/$/, "");
  }
}
