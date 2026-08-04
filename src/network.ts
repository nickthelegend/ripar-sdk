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

export type FacilitatorProbe = {
  url: string;
  ok: boolean;
  /** The Algorand kind it advertised, when it advertised one. */
  network?: string;
  /** Why this one was passed over. Present on every entry that was not chosen:
   *  a failover that reports only its winner leaves an operator unable to tell a
   *  typo in a URL from a facilitator that is down, and those have opposite
   *  fixes. */
  reason?: string;
};

export type FacilitatorChoice =
  | { ok: true; url: string; network: string; tried: FacilitatorProbe[] }
  | { ok: false; tried: FacilitatorProbe[]; error: string };

/**
 * Pick the first facilitator in the list that is actually up and speaks
 * Algorand.
 *
 * A facilitator is a single point of failure for every payment on an agent, and
 * `facilitatorUrl` takes exactly one URL — so an outage is a manual edit and a
 * restart. Probing a list turns that into a startup decision.
 *
 * Sequential, in the caller's order, and stopping at the first answer: the list
 * is a preference order, not a race. Probing them all in parallel would pick
 * whichever replied fastest, which is how a primary quietly stops being used.
 *
 * The client does not consult this while paying, because it cannot: under x402
 * the RESOURCE SERVER names the facilitator in its 402 and the payer settles
 * through that one. This is for choosing what to pass to `serve()`, or for a
 * caller who wants to know whether the facilitator behind an endpoint is alive
 * before it starts a batch.
 */
export async function resolveFacilitator(
  urls: string[],
  opts: { network?: Network; fetchImpl?: typeof fetch; timeoutMs?: number } = {}
): Promise<FacilitatorChoice> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const want = opts.network ? (CAIP2[opts.network] as string) : undefined;
  const tried: FacilitatorProbe[] = [];

  if (!urls.length) {
    return { ok: false, tried, error: "No facilitator URLs to try." };
  }

  for (const raw of urls) {
    const url = raw.replace(/\/$/, "");
    const probe = `${url}/supported`;
    let kinds: SupportedKind[];

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      let res: Response;
      try {
        res = await doFetch(probe, { headers: { accept: "application/json" }, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) {
        tried.push({ url, ok: false, reason: `/supported returned ${res.status}` });
        continue;
      }
      const body = (await res.json()) as { kinds?: SupportedKind[] };
      kinds = Array.isArray(body?.kinds) ? body.kinds : [];
    } catch (err) {
      tried.push({ url, ok: false, reason: `unreachable: ${(err as Error).message}` });
      continue;
    }

    const algorand = kinds.filter(
      (k) => k.scheme === "exact" && typeof k.network === "string" && k.network.startsWith("algorand:")
    );
    if (!algorand.length) {
      const seen = kinds.map((k) => `${k.scheme ?? "?"} on ${k.network ?? "?"}`).join(", ") || "nothing";
      tried.push({ url, ok: false, reason: `advertises no exact scheme on Algorand (it advertises ${seen})` });
      continue;
    }

    // Prefix matching in both directions, for the same reason
    // resolveFacilitatorNetwork does it: the package constant is a TRUNCATED
    // genesis hash and facilitators publish the full one, so an equality test
    // rejects the very facilitator it is looking for.
    const match = want
      ? algorand.find((k) => k.network!.startsWith(want) || want.startsWith(k.network!))
      : algorand[0];
    if (!match?.network) {
      const seen = algorand.map((k) => k.network).join(", ");
      tried.push({ url, ok: false, reason: `supports Algorand but not ${opts.network} (it advertises ${seen})` });
      continue;
    }

    tried.push({ url, ok: true, network: match.network });
    return { ok: true, url, network: match.network, tried };
  }

  return {
    ok: false,
    tried,
    error: `None of the ${urls.length} facilitator(s) could be used: ${tried
      .map((t) => `${t.url} — ${t.reason}`)
      .join("; ")}`,
  };
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
