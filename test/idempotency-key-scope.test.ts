/**
 * The client half of the idempotency contract, which had no test.
 *
 * `client.ts` states it plainly: one key is minted per `call()`, before the
 * retry loop, and sent on every attempt. Both halves of that matter and they
 * fail in opposite directions:
 *
 *   - minting INSIDE the loop gives every attempt its own claim, so a server
 *     with a store settles each one and the retry is charged;
 *   - hoisting it ABOVE `call()` shares one key between two different calls, so
 *     the second caller is answered with the first one's result.
 *
 * Neither shows up as an error anywhere. The first quietly costs money and the
 * second quietly returns the wrong answer, so both are pinned here.
 *
 * These assertions are about which header leaves the process, so the transport
 * is a counting stub. What the header MEANS on the wire is covered on-chain and
 * by the server-side guard tests in guards.test.ts.
 */
import algosdk from "algosdk";
import { describe, expect, it } from "vitest";
import { RiparClient } from "../src/client.js";

const IDEMPOTENCY_HEADER = "idempotency-key";

function headersOf(url: string | URL | Request, init?: RequestInit): Headers {
  const merged = new Headers(url instanceof Request ? url.headers : undefined);
  new Headers(init?.headers as HeadersInit).forEach((v, k) => merged.set(k, v));
  return merged;
}

/** Records the key on every attempt and fails the first `failures` of them with
 *  a 503 — the one status the client is documented to repeat. */
function flakyFetch(failures: number) {
  const keys: (string | null)[] = [];
  let calls = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    // Read from BOTH: the payment wrapper may hand the transport a `Request`
    // with the headers on it and no `init` at all, and a stub that only looked
    // at `init.headers` would record `null` and pass while the header was in
    // fact being sent correctly.
    keys.push(headersOf(url, init).get(IDEMPOTENCY_HEADER));
    if (calls <= failures) {
      return new Response("upstream is unwell", { status: 503 });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, keys };
}

/** A throwaway signer. `call()` refuses to run without one, but the stub
 *  transport answers 200 directly, so nothing is ever quoted, signed or sent —
 *  the account exists only to get past that check. */
const mnemonic = algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk);

function client(impl: typeof fetch) {
  return new RiparClient({ mnemonic, network: "testnet", fetchImpl: impl });
}

describe("idempotency key scope", () => {
  it("sends ONE key across the retries of a single call", async () => {
    const net = flakyFetch(2);
    await client(net.impl).call("https://example.test/api/work", { text: "x" });

    expect(net.keys).toHaveLength(3);
    expect(net.keys[0]).toBeTruthy();
    // The whole point: three attempts, one claim.
    expect(new Set(net.keys).size).toBe(1);
  });

  it("mints a DIFFERENT key for each call", async () => {
    const net = flakyFetch(0);
    const c = client(net.impl);
    await c.call("https://example.test/api/work", { text: "one" });
    await c.call("https://example.test/api/work", { text: "two" });

    expect(net.keys).toHaveLength(2);
    expect(net.keys[0]).not.toBe(net.keys[1]);
  });

  it("lets a caller's own key win, unchanged across retries", async () => {
    const net = flakyFetch(1);
    await client(net.impl).call(
      "https://example.test/api/work",
      { text: "x" },
      { headers: { [IDEMPOTENCY_HEADER]: "caller-owned-key" } }
    );

    expect(net.keys).toEqual(["caller-owned-key", "caller-owned-key"]);
  });

  it("reports a server-declared replay, which carries no receipt", async () => {
    const impl = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json", "idempotency-replayed": "true" },
      })) as unknown as typeof fetch;

    const out = await client(impl).call("https://example.test/api/work", { text: "x" });
    expect(out.replayed).toBe(true);
    expect(out.payment).toBeFalsy();
  });
});
