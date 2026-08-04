import algosdk from "algosdk";
import { findInBazaar, listBazaar } from "./bazaar.js";
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
  testnet: { identity: 768_572_968, reputation: 768_572_969, validation: 768_572_979 },
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
