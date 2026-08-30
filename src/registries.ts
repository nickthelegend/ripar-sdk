/**
 * The deployed registry app ids. One table, for the whole package.
 *
 * There were two. `REGISTRY` in cli-chain.ts, which every CLI chain read went
 * through, and `REPUTATION_APP` in client-extras.ts, which reputation-weighted
 * agent selection went through. They held the same fact and they drifted: the
 * first moved to the audited generation and the second did not, so `pickAgent`
 * ranked agents on a superseded registry while `ripar score` read the live one.
 *
 * Nothing failed. That is the whole difficulty with a stale app id — the old
 * apps are still on chain and still answer, so every read succeeds and returns
 * someone else's history. It is the third time this package has shipped a wrong
 * id, and the previous two were fixed by editing the number rather than by
 * removing the second place it could be wrong.
 *
 * So: this file is the source, and both old names are now views of it. They stay
 * exported because `REPUTATION_APP` is public API and removing it would break
 * callers for a refactor that should be invisible to them.
 *
 * Checked against ripar-contracts/DEPLOYED.json. A redeploy changes these here,
 * once.
 */

import type { Network } from "./types.js";

export type RegistryIds = {
  identity: number;
  reputation: number;
  validation: number;
};

/**
 * Zero means "not deployed on this chain", and is deliberate rather than
 * missing. App ids are network-scoped, so a MainNet guess would not be an
 * approximation of the right contract — it would be a stranger's, answering
 * confidently. Callers check for zero and say "not deployed".
 *
 * LocalNet is zero for the same reason and more so: a LocalNet is recreated
 * from scratch, so any constant here is stale the first time someone resets it.
 * Pass the id you just deployed.
 */
export const REGISTRIES: Record<Network, RegistryIds> = {
  testnet: {
    identity: 770_382_913,
    reputation: 770_382_914,
    validation: 770_382_915,
  },
  mainnet: { identity: 0, reputation: 0, validation: 0 },
  localnet: { identity: 0, reputation: 0, validation: 0 },
};
