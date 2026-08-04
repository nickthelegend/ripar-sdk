#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RiparClient, priceOf } from "./client.js";
import {
  cmdAudit,
  cmdBazaar,
  cmdBench,
  cmdEscrow,
  cmdJobs,
  cmdKeys,
  cmdOpenApi,
  cmdRegister,
  cmdRotate,
  cmdScore,
  cmdTest,
  cmdWatch,
} from "./cli-chain.js";
import { facilitatorSponsorsFees, resolveFacilitatorNetwork } from "./network.js";
import { DEFAULT_FACILITATOR, USDC_ASSET_ID, type Network } from "./types.js";

export const TEMPLATES = ["basic", "llm", "oracle"] as const;
export type TemplateName = (typeof TEMPLATES)[number];

/** Injected so tests can drive the CLI without spawning a process or writing to
 *  the real terminal. Everything the commands touch goes through here. */
export type CliIO = {
  out: (line: string) => void;
  err: (line: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  fetchImpl?: typeof fetch;
};

const HELP = `ripar — ship a paid HTTP endpoint on Algorand

Usage: ripar <command> [options]

Commands:
  init <name>       Scaffold a new agent from a template
  dev [entry]       Run an agent locally
  call <url>        Pay for and invoke an endpoint
  quote <url>       Read an endpoint's price — free, no wallet
  manifest <url>    Print an agent's published manifest
  doctor            Check node, facilitator, network and payout address

Checking something that is already deployed:
  test <url>        End-to-end check of a live agent, one line per check
  bench <url>       Measure real quote latency: p50, p95, max, cost per call
  audit <url>       Look for the specific ways a deployed agent breaks
  escrow <jobId>    What is held for a job, and what may legally happen next
  rotate <id> <a>   Move an agent's identity to a new controlling address

Options:
  -h, --help        Show help for a command
  -v, --version     Print the SDK version

Run "ripar <command> --help" for what each one takes.`;

const COMMAND_HELP: Record<string, string> = {
  init: `ripar init <name> — scaffold a new agent

Usage: ripar init <name> [options]

Options:
  --template <t>    ${TEMPLATES.join(" | ")}   (default: basic)
  --dir <path>      Where to create it (default: ./<name>)
  --force           Write into a directory that already has files
  -h, --help        Show this

Templates:
  basic             One echo endpoint. The smallest thing that can take money.
  llm               Prompt completion, priced per requested token budget.
  oracle            Price quotes signed with an Algorand key.`,

  dev: `ripar dev [entry] — run an agent locally

Usage: ripar dev [entry] [options]

Looks for agent.ts, agent.js, src/agent.ts or index.ts when no entry is given.
TypeScript entries run through node's own type stripping, so there is no build
step and no bundler.

Options:
  --port <n>        PORT for the agent (default: 4021)
  -h, --help        Show this`,

  call: `ripar call <url> — pay for and invoke an endpoint

Usage: ripar call <url> [options]

The wallet is read from RIPAR_MNEMONIC or WALLET_MNEMONIC. There is deliberately
no --mnemonic flag: a mnemonic on the command line lands in your shell history
and in the process list.

Options:
  --body <json>     Request body as JSON
  --file <path>     Request body from a file
  --max-price <$>   Refuse a quote above this
  --max-per-day <$> Refuse once this much is spent in a rolling 24h
  --network <n>     mainnet | testnet (default: mainnet)
  --retries <n>     Attempts on 5xx and network errors (default: 3)
  --idempotency-key <k>  Send Idempotency-Key so a retry is not re-charged
  -h, --help        Show this`,

  quote: `ripar quote <url> — read the price without paying

Usage: ripar quote <url> [options]

Needs no wallet and no funds. Send --body when the endpoint prices dynamically,
because the quote depends on what you are asking for.

Options:
  --body <json>     Request body as JSON
  --file <path>     Request body from a file
  -h, --help        Show this`,

  manifest: `ripar manifest <url> — print an agent's published manifest

Usage: ripar manifest <url> [options]

Reads /.well-known/ripar.json — free, and how discovery starts.

Options:
  --json            Print the raw manifest instead of a table
  -h, --help        Show this`,

  doctor: `ripar doctor — check the environment before you advertise a URL

Usage: ripar doctor [options]

Checks node's version, that RIPAR_PAY_TO is a real Algorand address, that the
facilitator is reachable, which network id it publishes, whether it sponsors the
network fee, and which USDC asset settles.

Options:
  --network <n>     mainnet | testnet (default: RIPAR_NETWORK or mainnet)
  --facilitator <u> Facilitator base URL
  --pay-to <addr>   Address to check instead of RIPAR_PAY_TO
  -h, --help        Show this`,
};

COMMAND_HELP.bazaar = "ripar bazaar [query]\n\n  Read the x402 discovery index. Everything in it got there by being PAID\n  for, not by announcing itself.\n\n  --limit <n>   How many to read (default 25, 100 when searching)\n  --json        Raw records\n\n  Search filters ONE page locally: the index has no search route, so an\n  empty result means not-in-what-I-read, never does-not-exist.";
COMMAND_HELP.keys = "ripar keys [--mnemonic <25 words>]\n\n  Generate an Algorand account, or print the address for a mnemonic you\n  already hold.\n\n  --json   address and mnemonic as JSON\n\n  A generated mnemonic is printed to stdout, so it lands in your scrollback\n  and possibly your shell history. Use it for TestNet, or for a payout\n  address you intend to replace.";
COMMAND_HELP.score = "ripar score [agentId] [--address <a>] [--domain <d>]\n\n  Read an agent's on-chain reputation.\n\n  --network <n>  testnet (default) or mainnet\n  --json         Raw record\n\n  Every credit required a real transfer from the client's registered address\n  to the agent's. It counts money, not quality: nobody judged the work.";
COMMAND_HELP.jobs = "ripar jobs\n\n  Work posted to the Validation Registry, with budget AND escrow.\n\n  --limit <n>    How many (default 25)\n  --network <n>  testnet (default) or mainnet\n  --json         Raw records\n\n  A budget is what the client says the work is worth; escrow is what they\n  actually handed over. unfunded means there is nothing to release.";
COMMAND_HELP.watch = "ripar watch [address]\n\n  Tail settlements to an address as they confirm. Defaults to RIPAR_PAY_TO.\n\n  --network <n>  testnet (default) or mainnet\n  --asset <id>   Asset to watch (defaults to USDC for the network)\n  --once         Poll once and exit\n\n  Anchored to the current round. The indexer returns oldest first, so an\n  unanchored query would replay years of history as if it were new.";
COMMAND_HELP.register = "ripar register <domain>\n\n  Bind your address to a domain in the Identity Registry.\n\n  --network <n>  testnet (default)\n  --dry-run      Say what would happen, sign nothing\n\n  Needs RIPAR_MNEMONIC. An environment variable and not a flag on purpose:\n  a flag lands in your shell history and in the process list. Register the\n  account your agent names as payTo, or the registry entry will not match\n  the address callers are asked to pay.";
COMMAND_HELP.openapi = "ripar openapi\n\n  Emit an OpenAPI 3.1 document generated from your endpoint definitions.\n\n  --entry <path>       Built module exporting the agent (default ./dist/agent.js)\n  --base-url <u>       Public URL for the servers block\n  --base-path <p>      Mount prefix, matching serve({ basePath })\n  --include-unlisted   Include endpoints marked listed: false\n\n  This imports and runs your module, so --entry must be compiled output.";

COMMAND_HELP.test = `ripar test <url> — end-to-end check of a live agent

Usage: ripar test <url> [options]

Reads the manifest, probes every endpoint it advertises, and reports one line
per check: a real 402, a quote that decodes, a challenge naming an amount AND an
asset, CORS headers a browser can actually use, and a health route that answers.
Exits non-zero if any check fails.

The probe is a POST with no body, which is what price discovery looks like — an
endpoint with an input schema would answer a probe carrying {} with a 400.

Options:
  --origin <o>      Origin to send on the CORS probe (default a dummy https URL)
  --json            The checks as JSON
  -h, --help        Show this`;

COMMAND_HELP.bench = `ripar bench <url> — measure real quote latency

Usage: ripar bench <url> [options]

Times N quote round trips and reports p50, p95, max and the quoted cost per
call. Quoting is free, so this spends nothing however many times it runs.

A failed request is EXCLUDED and counted, never folded in as a slow one: a
timeout recorded as a latency is how a p95 comes to flatter an endpoint that was
simply down.

Options:
  --n <count>       Round trips (default 10)
  --body <json>     Body to price, when the endpoint charges by it
  --file <path>     Same, from a file
  --json            The measurements as JSON
  -h, --help        Show this`;

COMMAND_HELP.audit = `ripar audit <url> — look for the ways a deployed agent breaks

Usage: ripar audit <url> [options]

Checks a live agent for the specific problems this project has actually hit:
missing CORS headers, a quote that cannot be read out of PAYMENT-REQUIRED, a
manifest payTo the IdentityRegistry has never seen, an endpoint advertised in
the manifest that 404s, and an agent card claiming an agentId that resolves to
nothing or to a different address. Every finding says why it matters.

Exits non-zero when there are findings.

Options:
  --network <n>     testnet (default) or mainnet, for the registry checks
  --json            Findings as JSON
  -h, --help        Show this`;

COMMAND_HELP.escrow = `ripar escrow <jobId> — what is held, and what may happen next

Usage: ripar escrow <jobId> [options]

Reads the job (jb_) and its escrow (es_) from the ValidationRegistry and says
which method is legal next, who may send it, and — where a dispute window is
involved — when.

A budget is what the client says the work is worth; escrow is what they actually
handed over. A validated job with no escrow has nothing to release.

Options:
  --network <n>     testnet (default) or mainnet
  --json            The job, the escrow and the legal moves as JSON
  -h, --help        Show this`;

COMMAND_HELP.rotate = `ripar rotate <agentId> <newAddress> — move an identity to a new address

Usage: ripar rotate <agentId> <newAddress> [options]

Composes IdentityRegistry.rotate_address. Signed by the CURRENT controlling
address, which is the only signature the contract accepts.

rotate_address is NOT on the deployed registry: the contracts in this repo are
ahead of the chain. --dry-run works and describes exactly what would be sent; a
real run is refused with that explanation rather than failing inside the AVM on
an assert nobody can read. The deployed program is checked for the method's own
selector before anything is signed.

The key comes from RIPAR_MNEMONIC. There is no --mnemonic flag: it would land in
your shell history and in the process list.

Options:
  --network <n>     testnet (default) or mainnet
  --dry-run         Say what would happen, sign nothing
  --json            The plan (or the result) as JSON
  -h, --help        Show this`;

export async function run(argv: string[], io: CliIO): Promise<number> {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);

  if (!command || command === "-h" || command === "--help" || command === "help") {
    io.out(HELP);
    return 0;
  }
  if (command === "-v" || command === "--version" || command === "version") {
    io.out(await packageVersion());
    return 0;
  }
  if (!(command in COMMAND_HELP)) {
    io.err(`Unknown command "${command}". Run "ripar --help".`);
    return 1;
  }
  if (flags.help) {
    io.out(COMMAND_HELP[command]);
    return 0;
  }

  try {
    switch (command) {
      case "init":
        return await cmdInit(flags, io);
      case "dev":
        return await cmdDev(flags, io);
      case "call":
        return await cmdCall(flags, io);
      case "quote":
        return await cmdQuote(flags, io);
      case "manifest":
        return await cmdManifest(flags, io);
      case "doctor":
        return await cmdDoctor(flags, io);
      case "bazaar":
        return await cmdBazaar(
          { query: flags.positional[0], limit: num(flags.values.limit), json: "json" in flags.values },
          io
        );
      case "keys":
        return cmdKeys({ mnemonic: flags.values.mnemonic, json: "json" in flags.values }, io);
      case "score":
        return await cmdScore(
          {
            agentId: num(flags.positional[0]),
            address: flags.values.address,
            domain: flags.values.domain,
            network: flags.values.network,
            json: "json" in flags.values,
          },
          io
        );
      case "jobs":
        return await cmdJobs(
          { network: flags.values.network, limit: num(flags.values.limit), json: "json" in flags.values },
          io
        );
      case "watch": {
        const address = flags.positional[0] ?? flags.values["pay-to"] ?? process.env.RIPAR_PAY_TO;
        if (!address) {
          io.err("ripar watch needs an address: ripar watch <address>, or set RIPAR_PAY_TO.");
          return 1;
        }
        return await cmdWatch(
          {
            address,
            network: flags.values.network,
            asset: num(flags.values.asset),
            once: "once" in flags.values,
          },
          io
        );
      }
      case "register":
        return await cmdRegister(
          {
            domain: flags.positional[0],
            network: flags.values.network,
            dryRun: "dry-run" in flags.values,
          },
          io
        );
      case "test":
        return await cmdTest(
          {
            url: flags.positional[0],
            origin: flags.values.origin,
            json: "json" in flags.values,
            fetchImpl: io.fetchImpl,
          },
          io
        );
      case "bench":
        return await cmdBench(
          {
            url: flags.positional[0],
            n: num(flags.values.n),
            body: await readBody(flags, io),
            json: "json" in flags.values,
            fetchImpl: io.fetchImpl,
          },
          io
        );
      case "audit":
        return await cmdAudit(
          {
            url: flags.positional[0],
            network: flags.values.network,
            json: "json" in flags.values,
            fetchImpl: io.fetchImpl,
          },
          io
        );
      case "escrow":
        return await cmdEscrow(
          {
            jobId: num(flags.positional[0]),
            network: flags.values.network,
            json: "json" in flags.values,
          },
          io
        );
      case "rotate":
        return await cmdRotate(
          {
            agentId: num(flags.positional[0]),
            newAddress: flags.positional[1],
            network: flags.values.network,
            dryRun: "dry-run" in flags.values,
            json: "json" in flags.values,
          },
          io
        );
      case "openapi":
        return await cmdOpenApi(
          {
            entry: flags.values.entry,
            baseUrl: flags.values["base-url"],
            basePath: flags.values["base-path"],
            includeUnlisted: "include-unlisted" in flags.values,
          },
          io,
          // Injected so the command is testable without a built agent on disk.
          (path) =>
            import(path.startsWith(".") ? new URL(path, `file://${process.cwd()}/`).href : path)
        );
      default:
        io.err(`Unknown command "${command}".`);
        return 1;
    }
  } catch (err) {
    io.err(`ripar: ${(err as Error).message}`);
    return 1;
  }
}

/* ── init ───────────────────────────────────────────────────────────────── */

async function cmdInit(flags: Flags, io: CliIO): Promise<number> {
  const name = flags.positional[0];
  if (!name) {
    io.err("ripar init needs a name: ripar init my-agent --template basic");
    return 1;
  }

  const template = (flags.values.template ?? "basic") as TemplateName;
  if (!TEMPLATES.includes(template)) {
    io.err(`Unknown template "${template}". Available: ${TEMPLATES.join(", ")}.`);
    return 1;
  }

  const handle = toHandle(name);
  const target = flags.values.dir
    ? absolute(flags.values.dir, io.cwd)
    : join(io.cwd, handle);

  if (existsSync(target) && !flags.force) {
    const entries = await readdir(target);
    if (entries.length > 0) {
      io.err(`${target} already has files. Pass --force to write into it anyway.`);
      return 1;
    }
  }

  const source = templateDir(template);
  if (!existsSync(source)) {
    io.err(`Template "${template}" is missing from this install (looked in ${source}).`);
    return 1;
  }

  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true });

  // npm silently drops a file called .gitignore from a published package, so
  // the template ships it under a plain name and it is restored here.
  const shipped = join(target, "gitignore");
  if (existsSync(shipped)) await rename(shipped, join(target, ".gitignore"));

  const written = await substitute(target, { name, handle });

  io.out(`Created ${target} from the "${template}" template.`);
  io.out("");
  for (const file of written.sort()) io.out(`  ${file}`);
  io.out("");
  io.out("Next:");
  io.out(`  cd ${handle}`);
  io.out("  npm install");
  io.out("  cp .env.example .env      # RIPAR_PAY_TO must be your own address");
  io.out("  npm run dev");
  return 0;
}

/** Placeholders are substituted after copying so the templates stay valid,
 *  readable files rather than a bespoke string format. */
async function substitute(dir: string, vars: Record<string, string>): Promise<string[]> {
  const touched: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath ?? dir, entry.name);
    const before = await readFile(path, "utf8");
    const after = before.replace(/\{\{(\w+)\}\}/g, (match, key: string) => vars[key] ?? match);
    if (after !== before) await writeFile(path, after);
    touched.push(path.slice(dir.length + 1));
  }
  return touched;
}

/* ── dev ────────────────────────────────────────────────────────────────── */

const DEV_ENTRIES = ["agent.ts", "agent.js", "src/agent.ts", "src/agent.js", "index.ts", "index.js"];

/** Where `ripar dev` looks when it was not told. Exported for the test that
 *  pins the order — it decides which file a developer's edits land in. */
export function resolveDevEntry(cwd: string, explicit?: string): string | null {
  if (explicit) {
    const path = absolute(explicit, cwd);
    return existsSync(path) ? path : null;
  }
  for (const candidate of DEV_ENTRIES) {
    const path = join(cwd, candidate);
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * Node runs TypeScript directly from 22.6 onwards, but only opts in by default
 * from 22.18 / 23. Below that the flag is required, and above it the flag is a
 * warning — so the version decides, not a guess.
 */
export function devNodeArgs(entry: string, nodeVersion: string): string[] {
  if (!entry.endsWith(".ts")) return [entry];
  const [major = 0, minor = 0] = nodeVersion.replace(/^v/, "").split(".").map(Number);
  const stripsByDefault = major > 22 || (major === 22 && minor >= 18);
  return stripsByDefault ? [entry] : ["--experimental-strip-types", entry];
}

async function cmdDev(flags: Flags, io: CliIO): Promise<number> {
  const entry = resolveDevEntry(io.cwd, flags.positional[0]);
  if (!entry) {
    io.err(
      flags.positional[0]
        ? `No such entry: ${flags.positional[0]}`
        : `No agent found. Looked for ${DEV_ENTRIES.join(", ")} in ${io.cwd}. Pass one: ripar dev path/to/agent.ts`
    );
    return 1;
  }

  const port = flags.values.port ?? io.env.PORT ?? "4021";
  const args = devNodeArgs(entry, process.version);
  io.out(`ripar dev · node ${args.join(" ")} (PORT=${port})`);

  return await new Promise<number>((done) => {
    const child = spawn(process.execPath, args, {
      cwd: io.cwd,
      stdio: "inherit",
      env: { ...process.env, ...io.env, PORT: String(port) } as NodeJS.ProcessEnv,
    });
    // Forward the signal rather than dying first, so the agent's own drain runs
    // and in-flight paid calls still get their answers.
    const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
    const onTerm = forward("SIGTERM");
    const onInt = forward("SIGINT");
    process.on("SIGTERM", onTerm);
    process.on("SIGINT", onInt);
    child.on("exit", (code) => {
      process.off("SIGTERM", onTerm);
      process.off("SIGINT", onInt);
      done(code ?? 0);
    });
    child.on("error", (err) => {
      io.err(`ripar dev: ${err.message}`);
      done(1);
    });
  });
}

/* ── quote / call / manifest ────────────────────────────────────────────── */

async function cmdQuote(flags: Flags, io: CliIO): Promise<number> {
  const url = flags.positional[0];
  if (!url) {
    io.err("ripar quote needs a URL: ripar quote https://agent.example.com/summarize");
    return 1;
  }

  const body = await readBody(flags, io);
  const client = new RiparClient({ network: networkOf(flags, io), fetchImpl: io.fetchImpl });
  const q = await client.quote(url, { body: body != null ? JSON.stringify(body) : undefined });

  if (!q.paymentRequired) {
    io.out(`${url} answered ${q.status} without asking for payment — it is not a paid endpoint.`);
    return 0;
  }

  const usd = priceOf(q.requirements);
  io.out(`${url}`);
  io.out(`  price     ${usd != null ? `$${usd}` : "402, but the quote was unreadable"}`);
  const accepts = firstAccept(q.requirements);
  if (accepts?.network) io.out(`  network   ${accepts.network}`);
  if (accepts?.payTo) io.out(`  payTo     ${accepts.payTo}`);
  io.out("");
  io.out("Quoting is free and needs no wallet. `ripar call` pays it.");
  return 0;
}

async function cmdCall(flags: Flags, io: CliIO): Promise<number> {
  const url = flags.positional[0];
  if (!url) {
    io.err("ripar call needs a URL: ripar call https://agent.example.com/summarize --body '{}'");
    return 1;
  }

  const mnemonic = io.env.RIPAR_MNEMONIC ?? io.env.WALLET_MNEMONIC;
  if (!mnemonic) {
    io.err(
      "No wallet. Set RIPAR_MNEMONIC (or WALLET_MNEMONIC) in the environment.\n" +
        "There is no --mnemonic flag on purpose: it would land in your shell history and in the process list."
    );
    return 1;
  }

  // Parse the body before touching the key: a malformed --body is the caller's
  // typo, and reporting a mnemonic problem first would hide it.
  const body = await readBody(flags, io);

  const client = new RiparClient({
    mnemonic,
    network: networkOf(flags, io),
    maxPrice: flags.values["max-price"],
    maxPerDay: flags.values["max-per-day"],
    retry: flags.values.retries ? { attempts: Number(flags.values.retries) } : undefined,
    fetchImpl: io.fetchImpl,
  });

  const init = flags.values["idempotency-key"]
    ? { headers: { "Idempotency-Key": flags.values["idempotency-key"] } }
    : {};

  const res = await client.call(url, body, init);
  io.out(JSON.stringify(res.data, null, 2));
  if (res.payment?.txId) io.err(`settled · ${res.payment.txId}`);
  if ((res.attempts ?? 1) > 1) io.err(`took ${res.attempts} attempts`);
  return 0;
}

async function cmdManifest(flags: Flags, io: CliIO): Promise<number> {
  const url = flags.positional[0];
  if (!url) {
    io.err("ripar manifest needs a URL: ripar manifest https://agent.example.com");
    return 1;
  }

  const client = new RiparClient({ network: networkOf(flags, io), fetchImpl: io.fetchImpl });
  const base = url.replace(/\/\.well-known\/ripar\.json$/, "");
  const m = (await client.discover(base)) as ManifestShape;

  if (flags.values.json != null) {
    io.out(JSON.stringify(m, null, 2));
    return 0;
  }

  io.out(`${m.name ?? "(unnamed)"}  @${m.handle ?? "?"}`);
  if (m.description) io.out(`  ${m.description}`);
  io.out("");
  io.out(`  network   ${m.network ?? "?"}`);
  io.out(`  payTo     ${m.payTo ?? "?"}`);
  if (m.x402?.asset) io.out(`  asset     ${m.x402.asset.symbol} (${m.x402.asset.id})`);
  io.out("");

  const rows = (m.endpoints ?? []).map((e) => [
    `${e.method ?? "POST"} /${e.name}`,
    String(e.price ?? "?"),
    e.description ?? "",
  ]);
  if (rows.length === 0) {
    io.out("  No listed endpoints.");
    return 0;
  }
  io.out(table([["ENDPOINT", "PRICE", "DESCRIPTION"], ...rows]));
  return 0;
}

/* ── doctor ─────────────────────────────────────────────────────────────── */

type Check = { name: string; ok: boolean; detail: string };

async function cmdDoctor(flags: Flags, io: CliIO): Promise<number> {
  const network = networkOf(flags, io);
  const facilitator = flags.values.facilitator ?? io.env.RIPAR_FACILITATOR ?? DEFAULT_FACILITATOR;
  const payTo = flags.values["pay-to"] ?? io.env.RIPAR_PAY_TO;
  const checks: Check[] = [];

  const major = Number(process.version.replace(/^v/, "").split(".")[0]);
  checks.push({
    name: "node",
    ok: major >= 20,
    detail: major >= 20 ? process.version : `${process.version} — the SDK needs 20 or newer`,
  });

  checks.push(
    payTo
      ? {
          name: "payTo",
          ok: /^[A-Z2-7]{58}$/.test(payTo),
          detail: /^[A-Z2-7]{58}$/.test(payTo)
            ? `${payTo.slice(0, 8)}…${payTo.slice(-6)}`
            : `"${payTo}" is not an Algorand address (58 base32 characters)`,
        }
      : { name: "payTo", ok: false, detail: "RIPAR_PAY_TO is not set — settlement has nowhere to go" }
  );

  let networkId: string | null = null;
  try {
    networkId = await resolveFacilitatorNetwork(network, facilitator, io.fetchImpl);
    checks.push({ name: "facilitator", ok: true, detail: facilitator });
    checks.push({ name: "network", ok: true, detail: networkId });
  } catch (err) {
    checks.push({ name: "facilitator", ok: false, detail: (err as Error).message });
  }

  if (networkId) {
    const feePayer = await facilitatorSponsorsFees(network, facilitator, io.fetchImpl);
    checks.push({
      name: "fees",
      ok: true,
      // Not a failure when absent: an unsponsored facilitator still settles, it
      // just means callers need ALGO as well as USDC.
      detail: feePayer
        ? `sponsored by ${feePayer.slice(0, 8)}…${feePayer.slice(-6)} — callers need USDC but no ALGO`
        : "not sponsored — callers need ALGO for the network fee",
    });
  }

  checks.push({
    name: "asset",
    ok: true,
    detail: `USDC ${USDC_ASSET_ID[network]} on ${network}`,
  });

  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    io.out(`${c.ok ? "ok  " : "FAIL"}  ${c.name.padEnd(width)}  ${c.detail}`);
  }

  const failed = checks.filter((c) => !c.ok);
  io.out("");
  io.out(failed.length === 0 ? "All checks passed." : `${failed.length} check(s) failed.`);
  return failed.length === 0 ? 0 : 1;
}

/* ── shared helpers ─────────────────────────────────────────────────────── */

/** A numeric flag, or undefined. Never NaN: a NaN limit silently becomes
 *  "show nothing", which reads as an empty registry. */
function num(v: string | undefined): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

type Flags = { positional: string[]; values: Record<string, string>; help: boolean; force: boolean };

/** A hand-rolled parser rather than a dependency: the CLI ships inside the SDK,
 *  and an argument parser is not worth a transitive install for consumers. */
export function parseFlags(argv: string[]): Flags {
  const positional: string[] = [];
  const values: Record<string, string> = {};
  let help = false;
  let force = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      help = true;
    } else if (arg === "--force") {
      force = true;
    } else if (arg.startsWith("--")) {
      const [key, inline] = splitOnce(arg.slice(2), "=");
      if (inline != null) {
        values[key] = inline;
      } else if (argv[i + 1] != null && !argv[i + 1].startsWith("--")) {
        values[key] = argv[++i];
      } else {
        values[key] = "";
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, values, help, force };
}

function splitOnce(s: string, sep: string): [string, string | null] {
  const at = s.indexOf(sep);
  return at === -1 ? [s, null] : [s.slice(0, at), s.slice(at + 1)];
}

async function readBody(flags: Flags, io: CliIO): Promise<unknown> {
  if (flags.values.file) {
    const raw = await readFile(absolute(flags.values.file, io.cwd), "utf8");
    return JSON.parse(raw);
  }
  if (flags.values.body) {
    try {
      return JSON.parse(flags.values.body);
    } catch {
      throw new Error(`--body is not valid JSON: ${flags.values.body}`);
    }
  }
  return undefined;
}

function networkOf(flags: Flags, io: CliIO): Network {
  const raw = flags.values.network ?? io.env.RIPAR_NETWORK ?? "mainnet";
  if (raw !== "mainnet" && raw !== "testnet") {
    throw new Error(`network must be "mainnet" or "testnet"; got "${raw}".`);
  }
  return raw;
}

/** Lowercase, hyphenated, 3–40 characters — the same shape defineAgent takes,
 *  so a scaffolded project starts valid rather than failing on first run. */
export function toHandle(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug.length >= 3 ? slug : `${slug || "agent"}-agent`;
}

/** Resolved from this module rather than from cwd: `ripar init` is run from the
 *  user's project, and the templates live inside the installed package. */
export function templateDir(template: TemplateName): string {
  return fileURLToPath(new URL(`../templates/${template}/`, import.meta.url));
}

function absolute(path: string, cwd: string) {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

type ManifestShape = {
  name?: string;
  handle?: string;
  description?: string;
  network?: string;
  payTo?: string;
  endpoints?: { name: string; method?: string; price?: string; description?: string }[];
  x402?: { asset?: { id: number; symbol: string } };
};

function firstAccept(requirements: unknown): { network?: string; payTo?: string } | null {
  if (!requirements || typeof requirements !== "object") return null;
  const r = requirements as Record<string, any>;
  const accepts = r.accepts ?? r;
  return Array.isArray(accepts) ? (accepts[0] ?? null) : accepts;
}

export function table(rows: string[][]): string {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((r) => (r[col] ?? "").length)));
  return rows
    .map((r) => `  ${r.map((cell, i) => (cell ?? "").padEnd(widths[i])).join("  ").trimEnd()}`)
    .join("\n");
}

async function packageVersion(): Promise<string> {
  try {
    const pkg = fileURLToPath(new URL("../package.json", import.meta.url));
    const { version } = JSON.parse(await readFile(pkg, "utf8"));
    return String(version);
  } catch {
    return "unknown";
  }
}

/* ── entrypoint ─────────────────────────────────────────────────────────── */

/** True only when node was told to execute this file. Tests import it, and an
 *  import must not start parsing their argv. */
function isEntrypoint(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return resolve(invoked) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const io: CliIO = {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    env: process.env,
    cwd: process.cwd(),
  };
  process.exitCode = await run(process.argv.slice(2), io);
}
