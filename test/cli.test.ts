import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { defineAgent, defineEndpoint } from "../src/define.js";
import { createServer } from "../src/server.js";
import {
  TEMPLATES,
  devNodeArgs,
  parseFlags,
  resolveDevEntry,
  run,
  table,
  templateDir,
  toHandle,
  type CliIO,
} from "../src/cli.js";

const PAY_TO = "PBXELTAXFHNNP3ZQFBC36WKUGVX732UG4CQQH22CP6NNIY5FFIY5UINYAU";

/** Captures what the CLI writes so a command can be asserted on without
 *  spawning a process or touching the real terminal. */
function io(overrides: Partial<CliIO> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: () => out.join("\n"),
    stderr: () => err.join("\n"),
    io: {
      out: (l: string) => out.push(l),
      err: (l: string) => err.push(l),
      env: {},
      cwd: process.cwd(),
      ...overrides,
    } as CliIO,
  };
}

const temps: string[] = [];
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "ripar-cli-"));
  temps.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

/* ── argument parsing ───────────────────────────────────────────────────── */

describe("parseFlags", () => {
  it("reads positionals, --key value and --key=value alike", () => {
    const f = parseFlags(["my-agent", "--template", "llm", "--dir=/tmp/x", "--force"]);
    expect(f.positional).toEqual(["my-agent"]);
    expect(f.values.template).toBe("llm");
    expect(f.values.dir).toBe("/tmp/x");
    expect(f.force).toBe(true);
  });

  it("treats a trailing flag with no value as present-but-empty", () => {
    expect(parseFlags(["--json"]).values.json).toBe("");
    expect(parseFlags(["--a", "--b", "2"]).values).toEqual({ a: "", b: "2" });
  });

  it("recognises both spellings of help", () => {
    expect(parseFlags(["-h"]).help).toBe(true);
    expect(parseFlags(["--help"]).help).toBe(true);
  });
});

describe("toHandle", () => {
  it("produces the handle shape defineAgent accepts, so a scaffold starts valid", () => {
    expect(toHandle("My Agent")).toBe("my-agent");
    expect(toHandle("Summarizer_v2!")).toBe("summarizer-v2");
    expect(toHandle("  spaced  out  ")).toBe("spaced-out");
    // Under three characters would be rejected by defineAgent, so it is padded.
    expect(toHandle("ai")).toBe("ai-agent");
    expect(toHandle("!!!")).toBe("agent-agent");
    expect(toHandle("x".repeat(80))).toHaveLength(40);
  });
});

describe("table", () => {
  it("aligns columns without trailing whitespace", () => {
    const rendered = table([
      ["ENDPOINT", "PRICE"],
      ["POST /echo", "$0.01"],
      ["POST /summarize-a-long-name", "$1"],
    ]);
    const lines = rendered.split("\n");
    expect(lines[0]).toMatch(/^ {2}ENDPOINT {19} {2}PRICE$/);
    for (const line of lines) expect(line).toBe(line.trimEnd());
  });
});

/* ── 1. the commands ────────────────────────────────────────────────────── */

describe("ripar --help", () => {
  it("lists every command", async () => {
    const c = io();
    expect(await run(["--help"], c.io)).toBe(0);
    for (const command of ["init", "dev", "call", "quote", "manifest", "doctor"]) {
      expect(c.stdout()).toContain(command);
    }
  });

  it("is what a bare `ripar` prints, rather than an error", async () => {
    const c = io();
    expect(await run([], c.io)).toBe(0);
    expect(c.stdout()).toContain("Usage: ripar");
  });

  it.each(["init", "dev", "call", "quote", "manifest", "doctor"])(
    "gives %s its own --help with a usage line",
    async (command) => {
      const c = io();
      expect(await run([command, "--help"], c.io)).toBe(0);
      expect(c.stdout()).toContain(`Usage: ripar ${command}`);
      expect(c.stderr()).toBe("");
    }
  );

  it("prints the package version", async () => {
    const c = io();
    expect(await run(["--version"], c.io)).toBe(0);
    expect(c.stdout()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("exits non-zero on a command it does not have", async () => {
    const c = io();
    expect(await run(["deploy"], c.io)).toBe(1);
    expect(c.stderr()).toContain('Unknown command "deploy"');
  });
});

/* ── 2. init and the templates ──────────────────────────────────────────── */

describe("ripar init", () => {
  it.each(TEMPLATES)("scaffolds a working %s project", async (template) => {
    const dir = await tempDir();
    const c = io({ cwd: dir });

    expect(await run(["init", "My Agent", "--template", template], c.io)).toBe(0);

    const project = join(dir, "my-agent");
    const pkg = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
    const agent = await readFile(join(project, "agent.ts"), "utf8");

    expect(pkg.name).toBe("my-agent");
    expect(pkg.dependencies["@ripar/sdk"]).toBeTruthy();
    // Every placeholder must be substituted; a stray {{name}} would ship into
    // the developer's repo and only fail at runtime.
    expect(agent).toContain('name: "My Agent"');
    expect(agent).toContain('handle: "my-agent"');
    for (const file of ["agent.ts", "package.json", "README.md", ".env.example", "tsconfig.json"]) {
      expect(await readFile(join(project, file), "utf8")).not.toMatch(/\{\{\w+\}\}/);
    }

    // npm strips a file literally named .gitignore from a published package, so
    // the template ships it as `gitignore` and init restores the real name.
    expect(existsSync(join(project, ".gitignore"))).toBe(true);
    expect(existsSync(join(project, "gitignore"))).toBe(false);
  });

  it("scaffolds basic when no template is named", async () => {
    const dir = await tempDir();
    const c = io({ cwd: dir });
    expect(await run(["init", "plain"], c.io)).toBe(0);
    expect(await readFile(join(dir, "plain", "agent.ts"), "utf8")).toContain('name: "echo"');
  });

  it("refuses a template it does not ship", async () => {
    const c = io({ cwd: await tempDir() });
    expect(await run(["init", "x", "--template", "quantum"], c.io)).toBe(1);
    expect(c.stderr()).toContain("Available: basic, llm, oracle");
  });

  it("needs a name", async () => {
    const c = io({ cwd: await tempDir() });
    expect(await run(["init"], c.io)).toBe(1);
    expect(c.stderr()).toContain("needs a name");
  });

  it("will not overwrite a directory that has files unless forced", async () => {
    const dir = await tempDir();
    await run(["init", "twice"], io({ cwd: dir }).io);

    const second = io({ cwd: dir });
    expect(await run(["init", "twice"], second.io)).toBe(1);
    expect(second.stderr()).toContain("--force");

    expect(await run(["init", "twice", "--force"], io({ cwd: dir }).io)).toBe(0);
  });

  it("honours --dir", async () => {
    const dir = await tempDir();
    const target = join(dir, "nested", "here");
    expect(await run(["init", "elsewhere", "--dir", target], io({ cwd: dir }).io)).toBe(0);
    expect(existsSync(join(target, "agent.ts"))).toBe(true);
  });
});

describe("the shipped templates themselves", () => {
  it.each(TEMPLATES)("%s exists in the package, not just in the tests", (template) => {
    expect(existsSync(templateDir(template))).toBe(true);
    expect(existsSync(join(templateDir(template), "agent.ts"))).toBe(true);
  });

  it("prices the llm template dynamically, which is the feature it demonstrates", async () => {
    const source = await readFile(join(templateDir("llm"), "agent.ts"), "utf8");
    expect(source).toMatch(/price:\s*\(\{\s*body\s*\}\)/);
    expect(source).toContain("priceHint");
  });

  it("signs the oracle template's quotes for real", async () => {
    const source = await readFile(join(templateDir("oracle"), "oracle.ts"), "utf8");
    expect(source).toContain("algosdk.signBytes");
    expect(source).toContain("algosdk.verifyBytes");
    // Sample data must read as sample data, at the call site and in the output.
    expect(source).toContain('source: "sample"');
  });

  it("labels the llm template's placeholder model as a stub", async () => {
    const source = await readFile(join(templateDir("llm"), "model.ts"), "utf8");
    expect(source).toContain("SAMPLE OUTPUT");
    expect(source).toContain("stub: true");
  });

  it.each(TEMPLATES)("%s imports files that exist under node's own resolver", async (template) => {
    // Node runs these by stripping types, and its resolver takes the specifier
    // literally — it does NOT remap "./model.js" to model.ts the way tsc and
    // bundlers do. A .js specifier here is a template that dies on first run.
    const dir = templateDir(template);
    for (const file of await readdir(dir)) {
      if (!file.endsWith(".ts")) continue;
      const source = await readFile(join(dir, file), "utf8");
      for (const [, specifier] of source.matchAll(/from\s+"(\.[^"]+)"/g)) {
        expect(specifier.endsWith(".ts"), `${template}/${file} imports "${specifier}"`).toBe(true);
        expect(existsSync(join(dir, specifier)), `${template}/${specifier} is missing`).toBe(true);
      }
    }
  });
});

/** The oracle template's signing is the product, so it is tested rather than
 *  assumed. Imported dynamically because the file lives outside `src`. */
describe("the oracle template's signature", () => {
  it("round-trips a quote through sign and verify", async () => {
    const algosdk = (await import("algosdk")).default;
    const account = algosdk.generateAccount();
    process.env.ORACLE_MNEMONIC = algosdk.secretKeyToMnemonic(account.sk);

    const oracle = await import(join(templateDir("oracle"), "oracle.ts"));
    const payload = {
      pair: "ALGO/USD",
      price: "0.180000",
      decimals: 6,
      source: "sample",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };

    const signature = oracle.signQuote(payload);
    expect(oracle.signerAddress()).toBe(String(account.addr));
    expect(oracle.verifyQuote(payload, signature, oracle.signerAddress())).toBe(true);

    // A tampered price must not verify — that is the entire point of signing it.
    expect(oracle.verifyQuote({ ...payload, price: "9.999999" }, signature, oracle.signerAddress())).toBe(
      false
    );

    // Key order must not matter, or a consumer that reserialises sees a forgery.
    const reordered = Object.fromEntries(Object.entries(payload).reverse());
    expect(oracle.verifyQuote(reordered as typeof payload, signature, oracle.signerAddress())).toBe(true);

    delete process.env.ORACLE_MNEMONIC;
  });

  it("throws rather than signing a zero for a pair it has no feed for", async () => {
    const oracle = await import(join(templateDir("oracle"), "oracle.ts"));
    expect(() => oracle.readPrice("DOGE/USD")).toThrow(/No feed/);
  });
});

/* ── dev entry resolution ───────────────────────────────────────────────── */

describe("ripar dev", () => {
  it("prefers agent.ts, then falls back in a fixed order", async () => {
    const dir = await tempDir();
    await run(["init", "devtest", "--dir", dir], io({ cwd: dir }).io);
    expect(resolveDevEntry(dir)).toBe(join(dir, "agent.ts"));
    expect(resolveDevEntry(dir, "agent.ts")).toBe(join(dir, "agent.ts"));
    expect(resolveDevEntry(dir, "missing.ts")).toBeNull();
  });

  it("finds nothing in an empty directory rather than guessing", async () => {
    expect(resolveDevEntry(await tempDir())).toBeNull();
  });

  it("says what it looked for when there is no agent", async () => {
    const c = io({ cwd: await tempDir() });
    expect(await run(["dev"], c.io)).toBe(1);
    expect(c.stderr()).toContain("agent.ts");
  });

  it("passes --experimental-strip-types only on the versions that need it", () => {
    // Node runs TypeScript unflagged from 22.18 / 23. Below that the flag is
    // required; above it, passing it prints a warning on every start.
    expect(devNodeArgs("agent.ts", "v22.6.0")).toEqual(["--experimental-strip-types", "agent.ts"]);
    expect(devNodeArgs("agent.ts", "v22.18.0")).toEqual(["agent.ts"]);
    expect(devNodeArgs("agent.ts", "v24.0.0")).toEqual(["agent.ts"]);
    expect(devNodeArgs("agent.js", "v20.0.0")).toEqual(["agent.js"]);
  });
});

/* ── doctor ─────────────────────────────────────────────────────────────── */

describe("ripar doctor", () => {
  /** The facilitator's /supported, as it really answers. */
  const supported = (network: string) =>
    (async () =>
      new Response(
        JSON.stringify({
          kinds: [
            {
              x402Version: 2,
              scheme: "exact",
              network,
              extra: { feePayer: PAY_TO },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )) as unknown as typeof fetch;

  it("passes when the environment is actually ready", async () => {
    const c = io({
      env: { RIPAR_PAY_TO: PAY_TO, RIPAR_NETWORK: "testnet" },
      fetchImpl: supported("algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI="),
    });

    expect(await run(["doctor"], c.io)).toBe(0);
    const printed = c.stdout();
    expect(printed).toContain("All checks passed.");
    expect(printed).toContain("algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=");
    expect(printed).toContain("USDC 10458941 on testnet");
    expect(printed).toContain("callers need USDC but no ALGO");
    expect(printed).not.toContain("FAIL");
  });

  it("fails, and exits non-zero, when there is nowhere to settle", async () => {
    const c = io({
      env: { RIPAR_NETWORK: "testnet" },
      fetchImpl: supported("algorand:SGO1GKSzyE7IEPItTxCByw9x8Fmn"),
    });

    expect(await run(["doctor"], c.io)).toBe(1);
    expect(c.stdout()).toContain("FAIL  payTo");
    expect(c.stdout()).toContain("RIPAR_PAY_TO is not set");
  });

  it("catches an address that is not an Algorand address at all", async () => {
    const c = io({
      env: { RIPAR_PAY_TO: "0xdeadbeef", RIPAR_NETWORK: "testnet" },
      fetchImpl: supported("algorand:SGO1GKSzyE7IEPItTxCByw9x8Fmn"),
    });
    expect(await run(["doctor"], c.io)).toBe(1);
    expect(c.stdout()).toContain("is not an Algorand address");
  });

  it("reports an unreachable facilitator as a failure, not a crash", async () => {
    const c = io({
      env: { RIPAR_PAY_TO: PAY_TO },
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });

    expect(await run(["doctor"], c.io)).toBe(1);
    expect(c.stdout()).toContain("FAIL  facilitator");
  });

  it("rejects a network that is not one of the two", async () => {
    const c = io({ env: { RIPAR_PAY_TO: PAY_TO } });
    expect(await run(["doctor", "--network", "devnet"], c.io)).toBe(1);
    expect(c.stderr()).toContain('must be "mainnet" or "testnet"');
  });
});

/* ── quote / manifest / call, against a real server ─────────────────────── */

describe("the CLI against a live agent", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = await createServer(
      defineAgent({
        name: "CLI Fixture",
        handle: "cli-fixture",
        description: "Serves the CLI integration tests.",
        payTo: PAY_TO,
        network: "testnet",
        endpoints: [
          defineEndpoint({
            name: "echo",
            description: "Returns what it was given.",
            price: "$0.01",
            handler: ({ body }) => body,
          }),
        ],
      }),
      { network: "testnet", payTo: PAY_TO }
    );
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => new Promise<void>((resolve) => server.close(() => resolve())));

  it("prints a real price for `ripar quote`, with no wallet configured", async () => {
    const c = io({ env: { RIPAR_NETWORK: "testnet" } });
    expect(await run(["quote", `${base}/echo`], c.io)).toBe(0);
    expect(c.stdout()).toContain("price     $0.01");
    expect(c.stdout()).toContain(PAY_TO);
  });

  it("quotes a dynamic price from --body, not from an empty request", async () => {
    // The body has to reach the server *parsed*, or a price function sees `{}`
    // and every request is quoted the same — which reads as the feature being
    // broken rather than as a missing content-type.
    const app = await createServer(
      defineAgent({
        name: "Metered",
        handle: "metered-fixture",
        description: "Prices by the size of the ask.",
        payTo: PAY_TO,
        network: "testnet",
        endpoints: [
          defineEndpoint<{ tokens?: number }>({
            name: "work",
            price: ({ body }) => `$${(0.001 * (body?.tokens ?? 1)).toFixed(4)}`,
            priceHint: "$0.001/token",
            handler: () => ({ ok: true }),
          }),
        ],
      }),
      { network: "testnet", payTo: PAY_TO }
    );
    const s = await new Promise<Server>((resolve) => {
      const sv = app.listen(0, () => resolve(sv));
    });
    const url = `http://127.0.0.1:${(s.address() as { port: number }).port}/work`;

    const cheap = io({ env: { RIPAR_NETWORK: "testnet" } });
    const dear = io({ env: { RIPAR_NETWORK: "testnet" } });
    await run(["quote", url, "--body", '{"tokens":2}'], cheap.io);
    await run(["quote", url, "--body", '{"tokens":50}'], dear.io);

    expect(cheap.stdout()).toContain("price     $0.002");
    expect(dear.stdout()).toContain("price     $0.05");

    await new Promise<void>((resolve) => s.close(() => resolve()));
  });

  it("prints the manifest as a table", async () => {
    const c = io({ env: { RIPAR_NETWORK: "testnet" } });
    expect(await run(["manifest", base], c.io)).toBe(0);
    const printed = c.stdout();
    expect(printed).toContain("CLI Fixture  @cli-fixture");
    expect(printed).toContain("ENDPOINT");
    expect(printed).toContain("POST /echo");
    expect(printed).toContain("$0.01");
    expect(printed).toContain("USDC (10458941)");
  });

  it("prints raw JSON with --json", async () => {
    const c = io({ env: { RIPAR_NETWORK: "testnet" } });
    expect(await run(["manifest", base, "--json"], c.io)).toBe(0);
    expect(JSON.parse(c.stdout()).handle).toBe("cli-fixture");
  });

  it("accepts the well-known path as well as the origin", async () => {
    const c = io({ env: { RIPAR_NETWORK: "testnet" } });
    expect(await run(["manifest", `${base}/.well-known/ripar.json`], c.io)).toBe(0);
    expect(c.stdout()).toContain("@cli-fixture");
  });

  it("refuses to take a mnemonic on the command line", async () => {
    const c = io({ env: { RIPAR_NETWORK: "testnet" } });
    expect(await run(["call", `${base}/echo`, "--body", "{}"], c.io)).toBe(1);
    // A mnemonic passed as an argument lands in shell history and in `ps`.
    expect(c.stderr()).toContain("RIPAR_MNEMONIC");
    expect(c.stderr()).toContain("no --mnemonic flag");
  });

  it("rejects a --body that is not JSON before sending anything", async () => {
    const c = io({ env: { RIPAR_NETWORK: "testnet", RIPAR_MNEMONIC: "x" } });
    expect(await run(["call", `${base}/echo`, "--body", "{oops"], c.io)).toBe(1);
    expect(c.stderr()).toContain("not valid JSON");
  });

  it("needs a URL for the commands that take one", async () => {
    for (const command of ["quote", "call", "manifest"]) {
      const c = io();
      expect(await run([command], c.io)).toBe(1);
      expect(c.stderr()).toContain("needs a URL");
    }
  });
});

afterEach(() => {
  delete process.env.ORACLE_MNEMONIC;
});

/* ── the built artifact, which is the thing users actually execute ──────── */

/**
 * Everything above imports from `src/` and calls `run()` in-process, so none of
 * it would notice a broken shebang, a `bin` pointing at a file that is not
 * emitted, or an ESM specifier that resolves under vitest but not under plain
 * node. That is the gap this closes: spawn the real binary the way npm would.
 *
 * Skipped rather than failed when dist/ is absent, because dist/ is gitignored
 * and a fresh checkout has not built yet. CI runs `npm run build` first, so
 * there it always executes.
 */
describe("the built CLI at dist/cli.js", () => {
  const dist = join(import.meta.dirname, "..", "dist", "cli.js");
  const built = existsSync(dist);
  const maybe = built ? it : it.skip;

  const exec = (args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [dist, ...args], {
        env: { ...process.env, RIPAR_PAY_TO: "" },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });

  maybe("starts under plain node and prints usage", async () => {
    const { code, stdout } = await exec(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Usage: ripar <command>");
    // Every advertised command, so dropping one from the built output is caught.
    for (const c of ["init", "dev", "call", "quote", "manifest", "doctor"]) {
      expect(stdout).toContain(c);
    }
  }, 30_000);

  maybe("prints a version", async () => {
    const { code, stdout } = await exec(["--version"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 30_000);

  maybe("exits non-zero on an unknown command", async () => {
    const { code } = await exec(["nonsense-command"]);
    expect(code).not.toBe(0);
  }, 30_000);

  maybe("keeps the shebang, so the npm bin symlink is executable", async () => {
    const source = await readFile(dist, "utf8");
    expect(source.startsWith("#!/usr/bin/env node")).toBe(true);
  }, 30_000);
});
