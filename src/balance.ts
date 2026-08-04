import { atomicToUsd } from "./headers.js";
import { DEFAULT_ALGOD, RiparError, USDC_ASSET_ID, type Network } from "./types.js";

/**
 * What the wallet actually holds, read straight from algod.
 *
 * This exists so a failure that costs a round trip and reads like an outage
 * becomes a sentence the caller can act on. Without it, a wallet that has not
 * opted in to USDC pays, waits, and is rejected by the facilitator with a
 * generic settlement error — indistinguishable from a facilitator being down,
 * and the actual fix (a zero-amount transfer to yourself) is nowhere in the
 * message.
 */

export type AssetHolding = {
  id: number;
  /**
   * Whether the account holds this ASA at all.
   *
   * Algorand requires an explicit opt-in before an address can receive an
   * asset. That makes "not opted in" a different problem from "empty": the
   * first is fixed with a transaction and no money, the second with money. Any
   * error that conflates them sends the caller to top up a wallet that would
   * still reject the payment.
   */
  optedIn: boolean;
  /** Atomic units of the asset, as algod reported them. */
  amount: string;
  /** The same amount in USD, when the decimals are known — null otherwise, the
   *  same fail-closed rule the header parser follows. */
  usd: number | null;
  frozen: boolean;
};

export type WalletBalance = {
  address: string;
  network: Network;
  /** False when the ledger has never seen this address. Its balances are all
   *  zero, but the distinction matters: an unfunded address is a wallet nobody
   *  has sent anything to, not a wallet that spent everything. */
  funded: boolean;
  microAlgos: number;
  /** microAlgos as ALGO, for reading. */
  algo: number;
  /** What algod says must stay behind. Every asset opted into and every app
   *  raises it, so a wallet can hold ALGO and still be unable to opt in to one
   *  more thing. */
  minMicroAlgos: number;
  asset: AssetHolding;
};

export type BalanceQuery = {
  address: string;
  network: Network;
  /** Which ASA to report. Defaults to USDC for the network — but `call()`
   *  passes the id out of the live quote, because a wallet holding mainnet USDC
   *  cannot pay a quote denominated in some other asset and a preflight that
   *  checked the wrong holding would wave it through. */
  assetId?: number;
  algodUrl?: string;
  algodToken?: string;
  fetchImpl?: typeof fetch;
};

type AlgodAccount = {
  amount?: number;
  "min-balance"?: number;
  assets?: { "asset-id"?: number; amount?: number | string; "is-frozen"?: boolean }[];
};

export async function readBalance(q: BalanceQuery): Promise<WalletBalance> {
  const assetId = q.assetId ?? USDC_ASSET_ID[q.network];
  const base = (q.algodUrl ?? DEFAULT_ALGOD[q.network]).replace(/\/$/, "");
  const doFetch = q.fetchImpl ?? globalThis.fetch;
  const url = `${base}/v2/accounts/${q.address}`;

  let res: Response;
  try {
    res = await doFetch(url, {
      headers: {
        accept: "application/json",
        ...(q.algodToken ? { "x-algo-api-token": q.algodToken } : {}),
      },
    });
  } catch (err) {
    throw new RiparError(
      `Could not reach algod at ${base} to read the balance of ${q.address} (${(err as Error).message}). ` +
        `Set algodUrl, or switch the balance preflight off.`,
      "algod_unreachable"
    );
  }

  // Most nodes answer 200 with zeroes for an address the ledger has never seen,
  // but some proxies answer 404. Both mean "nothing here", which is a fact
  // about the wallet rather than a fault — reporting it as an outage would send
  // the caller to debug their node instead of funding their wallet.
  if (res.status === 404) {
    return empty(q.address, q.network, assetId);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new RiparError(
      `algod at ${base} rejected the balance lookup for ${q.address} with ${res.status}. ${detail.slice(0, 200)}`,
      "algod_error",
      res.status
    );
  }

  const body = (await res.json()) as AlgodAccount;
  const microAlgos = Number(body.amount ?? 0);
  const holding = (body.assets ?? []).find((a) => Number(a["asset-id"]) === assetId);
  const amount = holding ? String(holding.amount ?? 0) : "0";

  return {
    address: q.address,
    network: q.network,
    // An address with no ALGO and no assets has never received anything. algod
    // reports the same zeroes for it as for a wallet that was emptied, so this
    // is the closest honest reading rather than a claim about history.
    funded: microAlgos > 0 || (body.assets ?? []).length > 0,
    microAlgos,
    algo: microAlgos / 1e6,
    minMicroAlgos: Number(body["min-balance"] ?? 0),
    asset: {
      id: assetId,
      optedIn: holding != null,
      amount,
      usd: atomicToUsd(amount, String(assetId)),
      frozen: holding?.["is-frozen"] === true,
    },
  };
}

export type Coverage =
  | { ok: true }
  | { ok: false; code: "asset_not_opted_in" | "asset_frozen" | "insufficient_funds"; message: string };

/**
 * Can this wallet settle a quote of `requiredAtomic` units of the asset it
 * already read?
 *
 * Split out from the fetch so the decision is testable without a node, and so
 * every branch names its own fix — the whole value of checking before paying is
 * that the caller is told what to do, not merely that something went wrong.
 */
export function coversPayment(balance: WalletBalance, requiredAtomic: string): Coverage {
  if (!balance.asset.optedIn) {
    return {
      ok: false,
      code: "asset_not_opted_in",
      message:
        `${balance.address} has not opted in to asset ${balance.asset.id} on ${balance.network}, so it cannot ` +
        `receive or spend it. Opt in first — a zero-amount transfer of that asset to yourself — then retry. ` +
        `Topping the wallet up will not help until it has.`,
    };
  }
  if (balance.asset.frozen) {
    return {
      ok: false,
      code: "asset_frozen",
      message:
        `Asset ${balance.asset.id} is frozen for ${balance.address}, so the payment cannot move however much ` +
        `the wallet holds. The asset's freeze address has to unfreeze it.`,
    };
  }
  if (!atLeast(balance.asset.amount, requiredAtomic)) {
    return {
      ok: false,
      code: "insufficient_funds",
      message:
        `${balance.address} holds ${balance.asset.amount} atomic units of asset ${balance.asset.id} but the ` +
        `quote asks for ${requiredAtomic}. Refusing to send a payment the facilitator would reject.`,
    };
  }
  return { ok: true };
}

/** Exact where it can be: an ASA amount is a uint64, and the top of that range
 *  does not survive a double. Falls back to numbers only when a server quoted
 *  something with a decimal point, which is not an atomic amount at all. */
function atLeast(held: string, required: string): boolean {
  if (/^\d+$/.test(held) && /^\d+$/.test(required)) return BigInt(held) >= BigInt(required);
  const h = Number(held);
  const r = Number(required);
  return Number.isFinite(h) && Number.isFinite(r) && h >= r;
}

function empty(address: string, network: Network, assetId: number): WalletBalance {
  return {
    address,
    network,
    funded: false,
    microAlgos: 0,
    algo: 0,
    minMicroAlgos: 0,
    asset: { id: assetId, optedIn: false, amount: "0", usd: atomicToUsd("0", String(assetId)), frozen: false },
  };
}
