import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import express from "express";
import algosdk from "algosdk";
import { defineAgent, defineEndpoint } from "../src/define.js";
import { createServer } from "../src/server.js";

/**
 * Both spellings of the Algorand network id settle.
 *
 * x402 PR #2931 made Algorand CAIP-2 ids canonical: URL-safe base64 of the
 * genesis hash truncated to 32 characters, so
 *
 *   algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe            (41, canonical)
 *   algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI= (53, legacy full hash)
 *
 * @x402/avm's constants already emit the short form. facilitator.goplausible.xyz
 * still publishes the long one, and Ripar quotes whatever /supported says, so
 * production runs on the long form today and settles.
 *
 * The flip is not ours to schedule. When that facilitator upgrades it will
 * start publishing the short form, resolveNetwork() will pick it up on the next
 * cold start, and nothing in our deploy pipeline will have changed — which is
 * exactly the kind of break that shows up as "payments stopped working" with no
 * commit to blame.
 *
 * What keeps both working is `register("algorand:*", ...)` in server.ts and
 * client.ts rather than a literal id. Pinning that glob to the legacy string
 * leaves the legacy case passing and fails only the canonical one, which is the
 * regression this file exists to catch.
 */

const PAY_TO = "PBXELTAXFHNNP3ZQFBC36WKUGVX732UG4CQQH22CP6NNIY5FFIY5UINYAU";
const PAYER = "B2DGXU2QSRHXNZJMP5FFFU77W5NUMZTZ3X3MSO3PJC4ZQ75CSDL5EKULI4";
const TESTNET_GENESIS = "SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";

const LEGACY = `algorand:${TESTNET_GENESIS}`;
const CANONICAL = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe";

const open: Server[] = [];
const listen = (app: express.Express): Promise<Server> =>
  new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
    open.push(s);
  });
const portOf = (s: Server) => (s.address() as { port: number }).port;

afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/** Quote, pay and settle one call against a facilitator that advertises exactly
 *  `network` and nothing else. */
async function roundTrip(network: string) {
  const f = express();
  f.use(express.json());
  let verified = false;
  let settled = false;
  f.get("/supported", (_q, s) => s.json({ kinds: [{ x402Version: 2, scheme: "exact", network }] }));
  f.post("/verify", (_q, s) => {
    verified = true;
    s.json({ isValid: true, payer: PAYER });
  });
  f.post("/settle", (_q, s) => {
    settled = true;
    s.json({
      success: true,
      transaction: "XS5KJ7OV2IS47322EZ3AFX5ZPG3RQTIYUFSSQ2KPMNMFZVI6K4NA",
      network,
      payer: PAYER,
    });
  });
  const facilitator = await listen(f);

  const agent = defineAgent({
    name: "Fwd",
    handle: "fwd",
    payTo: PAY_TO,
    network: "testnet",
    endpoints: [defineEndpoint({ name: "work", price: "$0.02", handler: () => ({ ok: true }) })],
  });

  const app = await createServer(agent, {
    network: "testnet",
    payTo: PAY_TO,
    facilitatorUrl: `http://127.0.0.1:${portOf(facilitator)}`,
    logging: { level: "error", write: () => {} },
  });
  const server = await listen(app);
  const base = `http://127.0.0.1:${portOf(server)}`;

  const quote = await fetch(`${base}/work`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ q: "hi" }),
  });
  const header = quote.headers.get("payment-required");
  // No quote at all is how an unregistered network presents: the gate cannot
  // price a scheme it has no handler for.
  expect(header, `no PAYMENT-REQUIRED for ${network}`).toBeTruthy();
  const accepted = JSON.parse(Buffer.from(header!, "base64").toString()).accepts[0];

  // A real signed transfer — the payer has to be decodable, and a synthetic
  // payload carries no identity.
  const acct = algosdk.generateAccount();
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: acct.addr,
    receiver: PAY_TO,
    amount: 20_000,
    assetIndex: 10_458_941,
    suggestedParams: {
      fee: 1000,
      firstValid: 1,
      lastValid: 1000,
      genesisID: "testnet-v1.0",
      genesisHash: new Uint8Array(Buffer.from(TESTNET_GENESIS, "base64")),
      flatFee: true,
    },
  });
  const payHeader = Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted,
      scheme: "exact",
      network,
      payload: { paymentGroup: [Buffer.from(txn.signTxn(acct.sk)).toString("base64")], paymentIndex: 0 },
    })
  ).toString("base64");

  const paid = await fetch(`${base}/work`, {
    method: "POST",
    headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": payHeader },
    body: JSON.stringify({ q: "hi" }),
  });

  return { quoted: accepted.network as string, status: paid.status, verified, settled, receipt: paid.headers.get("payment-response") };
}

describe("Algorand CAIP-2, both spellings", () => {
  it("settles on the legacy full-hash id the facilitator publishes today", async () => {
    const r = await roundTrip(LEGACY);
    expect(r.quoted).toBe(LEGACY);
    expect(r.quoted).toHaveLength(53);
    expect(r.status).toBe(200);
    expect(r.verified).toBe(true);
    expect(r.settled).toBe(true);
    expect(r.receipt).toBeTruthy();
  });

  it("settles on the canonical truncated id from x402 #2931", async () => {
    const r = await roundTrip(CANONICAL);
    expect(r.quoted).toBe(CANONICAL);
    expect(r.quoted).toHaveLength(41);
    expect(r.status).toBe(200);
    expect(r.verified).toBe(true);
    expect(r.settled).toBe(true);
    expect(r.receipt).toBeTruthy();
  });

  it("quotes back the facilitator's own spelling rather than a constant", async () => {
    // The two ids above differ only past character 41, so a server that quoted
    // a hardcoded constant would still pass one of them. This pins the actual
    // behaviour: whatever /supported advertises is what the 402 names.
    const [legacy, canonical] = await Promise.all([roundTrip(LEGACY), roundTrip(CANONICAL)]);
    expect(legacy.quoted).not.toBe(canonical.quoted);
  });
});
