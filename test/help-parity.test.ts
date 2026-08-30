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
