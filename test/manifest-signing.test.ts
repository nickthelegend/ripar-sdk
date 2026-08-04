import { describe, expect, it } from "vitest";
import algosdk from "algosdk";
import { manifestSigner, verifyManifest } from "../src/sign.js";
import { manifestSigningBytes, verifyManifestSignature } from "../src/client-extras.js";

/**
 * The server signs a manifest and the client verifies it. Those are two
 * implementations, written independently, and they only work if they agree on
 * exactly which bytes get signed.
 *
 * They agree today — this file is here so they still do tomorrow. The failure
 * if they drift is the worst kind: every manifest verifies as INVALID, which
 * reads as tampering rather than as a bug, and the honest reaction to "your
 * manifest is being altered in transit" is to stop trusting the network rather
 * than to suspect the verifier.
 *
 * Nothing else pins this. `sign.ts` tests the server half against itself and
 * `client-extras.ts` tests the client half against itself; both would stay
 * green through a change that made them incompatible.
 */
describe("the two manifest signing implementations agree", () => {
  const acct = algosdk.generateAccount();
  const address = acct.addr.toString();
  // Deliberately padded. A body with no leading or trailing whitespace makes
  // `trim()` a no-op, so one side quietly normalising and the other not would
  // stay invisible — and that asymmetry is precisely how two implementations
  // drift into signing different bytes.
  const body = `\n  ${JSON.stringify({ name: "Agent", handle: "a", endpoints: [], network: "testnet" })}  \n`;

  it("a signature the SERVER produced verifies in the CLIENT", () => {
    const signed = manifestSigner({ secretKey: acct.sk }).sign(body);
    const verdict = verifyManifestSignature(body, signed, address);
    expect(verdict.ok, `client rejected a server signature: ${JSON.stringify(verdict)}`).toBe(true);
  });

  it("and one the CLIENT scheme produced verifies in the SERVER", () => {
    const signed = Buffer.from(algosdk.signBytes(manifestSigningBytes(body), acct.sk)).toString("base64");
    expect(verifyManifest(body, signed, address)).toBe(true);
  });

  it("both refuse a body that changed by one character", () => {
    const signed = manifestSigner({ secretKey: acct.sk }).sign(body);
    const altered = body.replace('"testnet"', '"mainnet"');
    // The whole point of signing a manifest: this substitution redirects a
    // caller to a different chain, and it must not survive verification.
    expect(verifyManifest(altered, signed, address)).toBe(false);
    expect(verifyManifestSignature(altered, signed, address).ok).toBe(false);
  });

  it("both refuse a signature by a different key", () => {
    const other = algosdk.generateAccount();
    const signed = manifestSigner({ secretKey: other.sk }).sign(body);
    expect(verifyManifest(body, signed, address)).toBe(false);
    expect(verifyManifestSignature(body, signed, address).ok).toBe(false);
  });

  it("refuses a signature that is not 64 bytes, rather than letting nacl throw", () => {
    // base64 decoding is lenient enough to turn nonsense into a short buffer,
    // and ed25519 signatures are exactly 64 bytes. Without the length check the
    // library throws, and a caller who wrapped this in try/catch to make it
    // usable would end up treating an unverifiable manifest as a verified one.
    for (const junk of ["", "aGk=", "not-base64-at-all!!", "A".repeat(200)]) {
      expect(verifyManifest(body, junk, address), junk.slice(0, 12)).toBe(false);
      expect(verifyManifestSignature(body, junk, address).ok, junk.slice(0, 12)).toBe(false);
    }
  });

  it("both sign the body EXACTLY as served, whitespace included", () => {
    // If either side normalised, a manifest served with different formatting
    // than it was signed with would fail — and the two sides would disagree
    // about which body was authentic.
    const signed = manifestSigner({ secretKey: acct.sk }).sign(body);
    expect(verifyManifest(body.trim(), signed, address)).toBe(false);
    expect(verifyManifestSignature(body.trim(), signed, address).ok).toBe(false);
  });

  it("the signer reports the address the key actually belongs to", () => {
    // An ed25519 secret key is seed(32) || publicKey(32), and the address IS
    // that public key. A signer reporting the wrong one would have every
    // verification fail against an address nobody signed with.
    expect(manifestSigner({ secretKey: acct.sk }).address).toBe(address);
  });
});
