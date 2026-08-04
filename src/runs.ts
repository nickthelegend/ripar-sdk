import { randomUUID } from "node:crypto";
import type { RunRecord } from "./types.js";

/**
 * The last N calls, in memory, oldest evicted first.
 *
 * Deliberately not a log: no bodies, no headers, no payer address. This endpoint
 * is unpaid and therefore world-readable, so it carries only what an operator
 * needs to answer "is it working and did it settle" — anything else would leak
 * a customer's inputs to whoever curls it.
 *
 * In memory means it dies with the process. That is the right trade for a
 * container that scales to zero; durable history belongs in the explorer, which
 * reads the chain.
 */
export class RunRecorder {
  private readonly buf: RunRecord[];
  private next = 0;
  private filled = 0;

  constructor(readonly capacity = 100) {
    this.buf = new Array(Math.max(1, capacity));
  }

  add(run: Omit<RunRecord, "id" | "at"> & { id?: string; at?: string }): RunRecord {
    const record: RunRecord = {
      id: run.id ?? randomUUID().slice(0, 8),
      endpoint: run.endpoint,
      status: run.status,
      ms: run.ms,
      at: run.at ?? new Date().toISOString(),
      ...(run.txId ? { txId: run.txId } : {}),
    };
    this.buf[this.next] = record;
    this.next = (this.next + 1) % this.buf.length;
    this.filled = Math.min(this.filled + 1, this.buf.length);
    return record;
  }

  /** Newest first — the question is almost always "what just happened". */
  list(limit = this.capacity): RunRecord[] {
    const n = Math.min(Math.max(1, limit), this.filled);
    const out: RunRecord[] = [];
    for (let i = 1; i <= n; i++) {
      out.push(this.buf[(this.next - i + this.buf.length) % this.buf.length]);
    }
    return out;
  }

  get size() {
    return this.filled;
  }
}
