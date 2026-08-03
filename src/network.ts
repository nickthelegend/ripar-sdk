import { CAIP2, DEFAULT_FACILITATOR, RiparError, type Network } from "./types.js";

type SupportedKind = { x402Version?: number; scheme?: string; network?: string; extra?: Record<string, unknown> };

/**
 * Resolves the network id to put in a route's `accepts` block by asking the
 * facilitator what it actually supports.
 *
 * This exists because of a real incompatibility: CAIP-2 caps a network
 * reference at 32 characters, so `@x402/avm` exports a TRUNCATED genesis hash
 * (`algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe`), while the GoPlausible
 * facilitator advertises the FULL hash
 * (`algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=`). Registering a
 * route with the package constant fails at startup with "Facilitator does not
 * support scheme exact on network …", which reads like an outage rather than a
 * string mismatch.
 *
 * The truncated id is a prefix of the full one, so prefix matching resolves
 * whichever form this particular facilitator publishes — and a facilitator that
 * later switches forms keeps working without an SDK release.
 */
export async function resolveFacilitatorNetwork(
  network: Network,
  facilitatorUrl: string = DEFAULT_FACILITATOR,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<string> {
  const want = CAIP2[network] as string;
  const url = `${facilitatorUrl.replace(/\/$/, "")}/supported`;

  let kinds: SupportedKind[];
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const body = (await res.json()) as { kinds?: SupportedKind[] };
    kinds = body.kinds ?? [];
  } catch (err) {
    throw new RiparError(
      `Could not reach the facilitator at ${url} to find out which networks it supports (${(err as Error).message}). ` +
        `Set facilitatorUrl, or run your own facilitator.`,
      "facilitator_unreachable"
    );
  }

  const exactAvm = kinds.filter(
    (k) => k.scheme === "exact" && typeof k.network === "string" && k.network.startsWith("algorand:")
  );

  // Prefer the id whose reference the package constant is a prefix of; that is
  // the same chain expressed at full length.
  const match =
    exactAvm.find((k) => k.network!.startsWith(want) || want.startsWith(k.network!)) ?? undefined;

  if (!match?.network) {
    const seen = exactAvm.map((k) => k.network).join(", ") || "none";
    throw new RiparError(
      `Facilitator ${facilitatorUrl} does not support Algorand ${network}. It advertises: ${seen}.`,
      "network_unsupported"
    );
  }

  return match.network;
}

/** True when the facilitator sponsors the network fee, meaning a caller needs
 *  USDC but no ALGO. Worth surfacing — it removes a whole onboarding step. */
export async function facilitatorSponsorsFees(
  network: Network,
  facilitatorUrl: string = DEFAULT_FACILITATOR,
  fetchImpl: typeof fetch = globalThis.fetch
): Promise<string | null> {
  try {
    const res = await fetchImpl(`${facilitatorUrl.replace(/\/$/, "")}/supported`);
    const body = (await res.json()) as { kinds?: SupportedKind[] };
    const want = CAIP2[network] as string;
    const k = (body.kinds ?? []).find(
      (x) =>
        x.scheme === "exact" &&
        typeof x.network === "string" &&
        (x.network.startsWith(want) || want.startsWith(x.network))
    );
    const feePayer = k?.extra?.["feePayer"];
    return typeof feePayer === "string" ? feePayer : null;
  } catch {
    return null;
  }
}
