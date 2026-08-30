import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Every command the CLI dispatches has to appear in `ripar --help`.
 *
 * Seven did not. `score`, `jobs`, `bazaar`, `keys`, `openapi`, `register` and
 * `watch` all dispatched, all had `--help` text written for them, and all read
 * real data — `ripar score` reads an agent's reputation box, `ripar jobs` reads
 * the board with real escrow figures. None of them appeared in the command list,
 * so the only way to find one was to already know it existed.
 *
 * That is a worse failure than a missing feature: the work is done and shipped,
 * and it is invisible. It happens because adding a command means touching two
 * places — the dispatch switch and the HELP string — and nothing connects them.
 * This test is that connection.
 *
 * Read from source rather than by running the binary, so it fails at test time
 * rather than only after a build.
 */

const src = readFileSync(fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "utf8");

/** The `case "x":` labels in the dispatcher. */
function dispatched(): string[] {
  return [...new Set([...src.matchAll(/case "([a-z][a-z0-9-]*)":/g)].map((m) => m[1]))].sort();
}

/** Command names in the HELP block, which lists them two spaces in. */
function listedInHelp(): string[] {
  const help = src.slice(src.indexOf("const HELP = `"), src.indexOf("const COMMAND_HELP"));
  return [...new Set([...help.matchAll(/^ {2}([a-z][a-z0-9-]*)[ <[]/gm)].map((m) => m[1]))].sort();
}

describe("cli help parity", () => {
  it("lists every dispatchable command in --help", () => {
    const missing = dispatched().filter((c) => !listedInHelp().includes(c));
    expect(missing, `dispatchable but absent from --help: ${missing.join(", ")}`).toEqual([]);
  });

  it("does not advertise a command it cannot run", () => {
    const dispatch = dispatched();
    // `-h`/`-v` are options, not commands, and are matched out by the pattern
    // above requiring a leading letter.
    const phantom = listedInHelp().filter((c) => !dispatch.includes(c));
    expect(phantom, `listed in --help but never dispatched: ${phantom.join(", ")}`).toEqual([]);
  });

  it("gives every dispatchable command its own --help text", () => {
    const documented = new Set(
      [...src.matchAll(/COMMAND_HELP\.([a-z][a-z0-9-]*)/g)].map((m) => m[1])
    );
    // These six are described in the main HELP block and take no subcommand
    // help of their own in the current layout.
    const inlineOnly = new Set(["init", "dev", "call", "quote", "manifest", "doctor"]);
    const undocumented = dispatched().filter((c) => !documented.has(c) && !inlineOnly.has(c));
    expect(undocumented, `no --help text: ${undocumented.join(", ")}`).toEqual([]);
  });
});

/**
 * There is one registry table now — src/registries.ts — and the two names that
 * used to hold their own copies are views of it. These assert the views stay
 * views: if someone reintroduces a literal in either place, this fails.
 *
 * They drifted once. `REPUTATION_APP` stayed on 769444120 after the CLI moved
 * to the audited generation, so reputation-weighted selection ranked agents on
 * a superseded registry while `ripar score` read the live one, and neither
 * errored, because the old apps are still on chain and still answer.
 */
describe("one registry table", () => {
  it("REGISTRY is the shared table", async () => {
    const { REGISTRY } = await import("../src/cli-chain.js");
    const { REGISTRIES } = await import("../src/registries.js");
    expect(REGISTRY.testnet).toEqual(REGISTRIES.testnet);
    expect(REGISTRY.mainnet).toEqual(REGISTRIES.mainnet);
  });

  it("REPUTATION_APP is a view of the same reputation id", async () => {
    const { REGISTRIES } = await import("../src/registries.js");
    const { REPUTATION_APP } = await import("../src/client-extras.js");
    expect(REPUTATION_APP.testnet).toBe(REGISTRIES.testnet.reputation);
    expect(REPUTATION_APP.mainnet).toBe(REGISTRIES.mainnet.reputation);
    expect(REPUTATION_APP.localnet).toBe(REGISTRIES.localnet.reputation);
  });

  it("matches the ids ripar-contracts records as deployed", async () => {
    const { REGISTRIES } = await import("../src/registries.js");
    // Transcribed from ripar-contracts/DEPLOYED.json. If a redeploy moves the
    // registries, this is the line that should make you update both.
    expect(REGISTRIES.testnet).toEqual({
      identity: 770_382_913,
      reputation: 770_382_914,
      validation: 770_382_915,
    });
  });

  it("treats an undeployed chain as zero rather than guessing", async () => {
    const { REGISTRIES } = await import("../src/registries.js");
    expect(REGISTRIES.mainnet).toEqual({ identity: 0, reputation: 0, validation: 0 });
    expect(REGISTRIES.localnet).toEqual({ identity: 0, reputation: 0, validation: 0 });
  });
});
