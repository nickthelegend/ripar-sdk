import algosdk from "algosdk";
import { RiparError } from "./types.js";

/**
 * Signing the discovery manifest, so a caller can tell whether what arrived is
 * what the agent published.
 *
 * The manifest is the document a stranger's agent reads to decide what to call
 * and what it will cost, and it travels over plain HTTP through whatever CDN,
 * proxy or gateway sits in between. Any of those can rewrite `payTo` — and a
 * rewritten `payTo` sends every settlement on the endpoint to somebody else's
 * address while the manifest still looks perfectly valid. There is nothing in
 * x402 that would notice: the caller pays exactly what the 402 asked for.
 *
 * So the body is signed with an Algorand key and the signature published in a
 * header. Ed25519 over the exact bytes, verified against the public key inside
 * an Algorand address — the same primitive that signs transactions, which means
 * an operator who can pay can sign, with no new key material to manage.
 *
 * Two things about this that are easy to get wrong, and both make verification
 * fail silently or succeed uselessly:
 *
 * 1. The signature covers the BYTES, not the object. `JSON.stringify` on a
 *    parsed manifest is not guaranteed to reproduce them — key order survives,
 *    but whitespace, number formatting and unicode escaping do not have to.
 *    Verify against the raw response text (`await res.text()`), then parse.
 *
 * 2. Verifying against the address in the header proves NOTHING. Anyone who can
 *    rewrite the body can rewrite the header, sign with their own key and put
 *    their own address next to it. The address has to come from somewhere the
 *    attacker does not control — an on-chain registry entry, a pinned config,
 *    the address you already pay. `verifyManifest` therefore takes the address
 *    as an argument rather than reading it out of the document.
 */

/** base64 ed25519 signature over the exact manifest bytes. */
export const MANIFEST_SIGNATURE_HEADER = "x-ripar-manifest-signature";
/** The address whose key signed. A CONVENIENCE, not a credential — see above. */
export const MANIFEST_SIGNER_HEADER = "x-ripar-manifest-signer";
/** Named so a future curve can be added without a caller guessing. "MX" is
 *  algosdk's domain-separation prefix, which is inside the signed material and
 *  is what stops a signed manifest from ever being replayable as a signed
 *  transaction. */
export const MANIFEST_ALGORITHM_HEADER = "x-ripar-manifest-algorithm";
export const MANIFEST_ALGORITHM = "ed25519-mx";

export type SignManifestOptions = {
  /** The 64-byte algosdk secret key, its base64 form, or a 25-word mnemonic.
   *  The signing address is DERIVED from it rather than configured separately,
   *  so a published signer can never disagree with the key that signed. */
  secretKey: Uint8Array | string;
};

export type ManifestSigner = {
  /** The address a caller verifies against, derived from the key. */
  address: string;
  /** base64 signature over exactly these bytes. */
  sign: (body: string) => string;
};

export function manifestSigner(opts: SignManifestOptions): ManifestSigner {
  const sk = toSecretKey(opts.secretKey);
  // An ed25519 secret key is seed(32) || publicKey(32); the address IS that
  // public key, base32 with a checksum.
  const address = algosdk.encodeAddress(sk.subarray(32));
  return {
    address,
    sign: (body: string) => Buffer.from(algosdk.signBytes(Buffer.from(body, "utf8"), sk)).toString("base64"),
  };
}

/**
 * True when `signature` is a valid signature over `body` by `address`.
 *
 * Never throws. A malformed address, a truncated signature and a body that was
 * altered all have to be one answer — false — because a caller wrapping this in
 * try/catch to make it usable is a caller who will eventually catch too much
 * and treat an unverifiable manifest as a verified one.
 */
export function verifyManifest(body: string, signature: string, address: string): boolean {
  try {
    const sig = Buffer.from(signature, "base64");
    // base64 decoding is lenient enough to turn nonsense into short buffers,
    // and algosdk.verifyBytes THROWS "bad signature size" on anything that is
    // not exactly 64. The catch below would turn that into false anyway, so
    // this line is defence in depth rather than the thing making it correct —
    // it is here so a future refactor that narrows the catch does not turn a
    // malformed signature into an exception escaping to the caller.
    if (sig.length !== 64) return false;
    return algosdk.verifyBytes(Buffer.from(body, "utf8"), new Uint8Array(sig), address);
  } catch {
    return false;
  }
}

function toSecretKey(key: Uint8Array | string): Uint8Array {
  if (typeof key !== "string") {
    if (key.length !== 64) {
      throw new RiparError(
        `signManifest.secretKey is ${key.length} bytes; an Algorand secret key is 64.`,
        "invalid_signing_key"
      );
    }
    return key;
  }
  // A mnemonic is the form an operator actually has written down; anything else
  // is treated as base64, which is how a key arrives in an environment variable.
  if (key.trim().includes(" ")) {
    try {
      return algosdk.mnemonicToSecretKey(key.trim()).sk;
    } catch (err) {
      throw new RiparError(
        `signManifest.secretKey looks like a mnemonic but could not be decoded: ${(err as Error).message}`,
        "invalid_signing_key"
      );
    }
  }
  const raw = Buffer.from(key, "base64");
  if (raw.length !== 64) {
    throw new RiparError(
      "signManifest.secretKey must be a 25-word mnemonic, a base64 64-byte secret key, or the Uint8Array algosdk hands you.",
      "invalid_signing_key"
    );
  }
  return new Uint8Array(raw);
}
