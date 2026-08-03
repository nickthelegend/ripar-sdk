import { describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { defineAgent, defineEndpoint } from "../src/define.js";
import { createServer } from "../src/server.js";
import { RiparClient } from "../src/client.js";
import { facilitatorSponsorsFees, resolveFacilitatorNetwork } from "../src/network.js";

const PAY_TO = "PBXELTAXFHNNP3ZQFBC36WKUGVX732UG4CQQH22CP6NNIY5FFIY5UINYAU";

// Hits the real GoPlausible facilitator. No funds move — these prove the
// negotiation is correct, which is everything up to signing.
describe("against MainNet + the live facilitator", () => {
  it("resolves the network id the facilitator really publishes", async () => {
    const id = await resolveFacilitatorNetwork("mainnet");
    expect(id.startsWith("algorand:")).toBe(true);
    // The full published id is longer than the CAIP-2-truncated constant.
    expect(id.length).toBeGreaterThan("algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k".length);
  });

  it("reports the fee payer, so callers need USDC but not ALGO", async () => {
    const feePayer = await facilitatorSponsorsFees("mainnet");
    expect(feePayer).toMatch(/^[A-Z2-7]{58}$/);
  });

  it("serves a MainNet 402 carrying a real quote", async () => {
    const agent = defineAgent({
      name: "MainNet Probe",
      handle: "mainnet-probe",
      description: "Proves the 402 negotiation works against MainNet.",
      payTo: PAY_TO,
      network: "mainnet",
      endpoints: [
        defineEndpoint({
          name: "ping",
          price: "$0.01",
          handler: () => ({ pong: true }),
        }),
      ],
    });

    const app = await createServer(agent, { network: "mainnet" });
    const s: Server = await new Promise((resolve) => {
      const sv = app.listen(0, () => resolve(sv));
    });
    const port = (s.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/ping`;

    const client = new RiparClient({ network: "mainnet" }); // no wallet needed to quote
    const q = await client.quote(url);
    expect(q.paymentRequired).toBe(true);
    expect(q.status).toBe(402);

    const manifest = await client.discover(`http://127.0.0.1:${port}`);
    expect(manifest.x402.asset.id).toBe(31_566_704); // USDC on MainNet
    expect(manifest.network).toBe("mainnet");

    await new Promise<void>((resolve) => s.close(() => resolve()));
  });
});
