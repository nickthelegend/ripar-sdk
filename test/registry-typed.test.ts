/**
 * The typed registry client, against the live TestNet registries.
 *
 * These are real network reads, not fixtures. That is deliberate: the whole
 * point of this module is that it is driven by the ARC-56 specs and the
 * deployed programs, and a mocked algod would prove neither.
 *
 * The assertion that matters most is the last one. A superseded registry stays
 * on chain and keeps answering, so "the read succeeded" is not evidence the
 * client is pointed at the right app — the escrow asset is. The live generation
 * settles in Circle USDC 10458941; the generation before it was bootstrapped to
 * a self-minted token. Checking the asset is how you tell them apart.
 */

import { describe, expect, it } from "vitest";
import { TypedRegistries } from "../src/registry-typed.js";

const IDS = {
  identity: 769_444_119,
  reputation: 769_444_120,
  validation: 769_444_121,
} as const;

const USDC_TESTNET = 10_458_941n;

function client() {
  return new TypedRegistries({ ids: IDS, network: "testnet" });
}

describe("TypedRegistries", () => {
  it("reads the agent count without any account", async () => {
    const total = await client().totalAgents();
    expect(total).toBeGreaterThanOrEqual(2n);
  }, 30_000);

  it("reads the escrow terms the registry was bootstrapped with", async () => {
    const terms = await client().escrowTerms();
    expect(terms.identityApp).toBe(BigInt(IDS.identity));
    expect(terms.reputationApp).toBe(BigInt(IDS.reputation));
    expect(terms.disputeWindow).toBeGreaterThan(0n);
  }, 30_000);

  it("settles in real USDC, not a self-minted token", async () => {
    // The check that distinguishes the live registry from its predecessor.
    const terms = await client().escrowTerms();
    expect(terms.escrowAsset).toBe(USDC_TESTNET);
  }, 30_000);

  it("resolves a domain and an address without any account", async () => {
    // These are box reads. The first cut routed them through simulate with an
    // unfunded sender and all three failed on overspend — a public record
    // should not require a wallet to read.
    const r = client();
    const id = await r.resolveByDomain("ripar-agent.vercel.app");
    expect(id).toBe(1n);
    const agent = await r.getAgent(id);
    expect(agent.domain).toBe("ripar-agent.vercel.app");
    // round-trip: the address on the record resolves back to the same id
    expect(await r.resolveByAddress(agent.address)).toBe(id);
  }, 30_000);

  it("answers zero for a record that does not exist", async () => {
    // A missing box must be distinguishable from an unreachable node: absent
    // returns 0, only a transport failure throws.
    expect(await client().resolveByDomain("nobody-here.example")).toBe(0n);
  }, 30_000);

  it("decodes AgentInfo through the ARC-56 struct, not fixed offsets", async () => {
    // agent_domain is dynamic, so its 2-byte head sits at offset 8 and the
    // address begins at 10. Hand-computed offsets got this wrong by two bytes.
    const agent = await client().getAgent(1);
    expect(agent.address).toMatch(/^[A-Z2-7]{58}$/);
    expect(agent.registeredAt).toBeGreaterThan(0n);
    expect(agent.updatedAt).toBeGreaterThanOrEqual(agent.registeredAt);
  }, 30_000);

  it("dispatches a readonly ABI method through simulate", async () => {
    // Proves the deployed program still routes `total_agents`, which reading
    // global state alone cannot tell you. Needs a funded sender because
    // simulate checks the group's minimum fee is affordable.
    const merchant = "NGVUO43AXJJ2RZGYUCUKWAYAZZA6YPO5HJ6PCM6VJ6CM7KUTRM75HO3OCU";
    const viaAbi = await client().totalAgentsViaAbi(merchant);
    const viaState = await client().totalAgents();
    expect(viaAbi).toBe(viaState);
  }, 30_000);
});
