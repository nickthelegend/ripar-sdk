import { describe, expect, it } from "vitest";
import { x402Client } from "@x402/core/client";
import { ExactAvmScheme } from "@x402/avm/exact/client";
import { toClientAvmSigner } from "@x402/avm";
import algosdk from "algosdk";
import { CAIP2 } from "../src/types.js";

/**
 * The regression that made RiparClient unable to pay ANYTHING.
 *
 * @x402/core resolves a scheme by exact key or glob — there is no prefix
 * fallback. CAIP-2 caps a network reference at 32 characters, so the exported
 * constant is a TRUNCATED genesis hash while every facilitator quotes the full
 * one. Registering the constant therefore never matches, and payment payload
 * creation throws.
 *
 * The old suite could not catch this: every test set maxPrice or maxPerDay, so
 * the affordability guard threw before the payment layer was ever reached. A
 * mutation test proved it — deleting the entire payment layer still passed.
 * These assertions exercise the layer directly.
 */
const key = Buffer.from(algosdk.generateAccount().sk).toString("base64");

/** What a real Ripar server emits, via resolveFacilitatorNetwork: the FULL id. */
const REQUIREMENTS = {
  x402Version: 2 as const,
  accepts: [
    {
      scheme: "exact",
      network: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=",
      amount: "10000",
      asset: "10458941",
      payTo: "PBXELTAXFHNNP3ZQFBC36WKUGVX732UG4CQQH22CP6NNIY5FFIY5UINYAU",
      maxTimeoutSeconds: 300,
    },
  ],
};

describe("the CAIP-2 truncation trap", () => {
  it("the exported constant is SHORTER than what a facilitator quotes", () => {
    // If this ever stops being true the wildcard is no longer load-bearing —
    // but until then, registering the constant is a silent outage.
    const constant = CAIP2.testnet as string;
    const quoted = REQUIREMENTS.accepts[0].network;
    expect(quoted.startsWith(constant)).toBe(true);
    expect(quoted.length).toBeGreaterThan(constant.length);
  });

  it("registering the TRUNCATED constant cannot serve a real quote", async () => {
    const c = new x402Client().register(
      CAIP2.testnet,
      new ExactAvmScheme(toClientAvmSigner(key))
    );
    await expect(
      c.createPaymentPayload(REQUIREMENTS as never)
    ).rejects.toThrow(/No network\/scheme registered|not registered|version/i);
  });

  it("registering the WILDCARD serves it — this is what the client must do", async () => {
    const c = new x402Client().register(
      "algorand:*",
      new ExactAvmScheme(toClientAvmSigner(key))
    );
    // Reaching a signed payload (or failing later, on funds) means the scheme
    // resolved. Only the registration is under test here.
    const built = await c
      .createPaymentPayload(REQUIREMENTS as never)
      .then(() => "resolved")
      .catch((e: Error) =>
        /No network\/scheme registered/i.test(e.message) ? "unresolved" : "resolved"
      );
    expect(built).toBe("resolved");
  });
});
