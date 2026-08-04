/**
 * Every settlement the client has seen, kept so it can be exported.
 *
 * The client already reads the receipt off each paid response — it has to, in
 * order to know a call was charged — and then threw it away with the return
 * value. That is the one record of what an autonomous agent spent that ties an
 * amount to the URL that took it and the transaction that carries it, and
 * reconstructing it afterwards from an explorer means matching timestamps to
 * transactions by hand.
 *
 * In memory, and deliberately: a receipt is a fact about money that has already
 * moved, so nothing here is load-bearing for correctness, and choosing where it
 * is persisted is the caller's decision rather than a directory this SDK
 * creates in their project.
 */

export type ReceiptRecord = {
  /** The settlement transaction, when the facilitator reported one. */
  txId?: string;
  url: string;
  /** Atomic units of `asset`, exactly as the facilitator reported them. */
  amount?: string;
  asset?: string;
  /** The same amount in USD, when the asset's decimals are known. */
  usd?: number;
  /** ISO 8601, from this process's clock. The receipt header carries no block
   *  time, so this is when the client saw the payment, not when it committed. */
  timestamp: string;
};

export const DEFAULT_RECEIPTS_LIMIT = 1_000;

export class ReceiptLedger {
  private readonly rows: ReceiptRecord[] = [];

  /** A long-lived agent settles continuously, so this has to be a ring rather
   *  than a list — an unbounded one grows for the life of the process and the
   *  oldest entries are the least useful. */
  constructor(readonly limit = DEFAULT_RECEIPTS_LIMIT) {}

  record(entry: ReceiptRecord) {
    this.rows.push(entry);
    if (this.rows.length > this.limit) this.rows.splice(0, this.rows.length - this.limit);
  }

  /** A copy: a caller holding the live array could empty the ledger by
   *  accident, and it is the only record of what was spent. */
  list(): ReceiptRecord[] {
    return [...this.rows];
  }

  get size() {
    return this.rows.length;
  }

  /** Total USD across the receipts that reported an amount we could read. */
  totalUsd(): number {
    return Number(this.rows.reduce((sum, r) => sum + (r.usd ?? 0), 0).toFixed(6));
  }
}

const COLUMNS = ["timestamp", "url", "txId", "amount", "asset", "usd"] as const;

export function exportReceipts(rows: ReceiptRecord[], format: "json" | "csv"): string {
  if (format === "json") return JSON.stringify(rows, null, 2);
  return [COLUMNS.map(csvField).join(","), ...rows.map((r) => COLUMNS.map((c) => csvField(r[c])).join(","))].join(
    "\n"
  );
}

/**
 * RFC 4180 quoting, applied to every field rather than only the ones that
 * appear to need it.
 *
 * Conditional quoting is where CSV writers go wrong, because the conditions are
 * easy to under-count: a URL routinely carries commas (`?ids=1,2`) and quotes,
 * and an unquoted field containing either shifts every later column by one —
 * silently, in a file somebody is reconciling against a bank statement. Quoting
 * unconditionally has no such edge, and a doubled quote is the escape the
 * format defines.
 */
function csvField(value: unknown): string {
  if (value == null) return '""';
  return `"${String(value).replace(/"/g, '""')}"`;
}
