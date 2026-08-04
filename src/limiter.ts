import { AsyncLocalStorage } from "node:async_hooks";
import { RiparError } from "./types.js";

/**
 * A FIFO gate on how much the client does at once.
 *
 * The reason this is a money feature rather than a politeness feature: an agent
 * that fans out over a list of URLs with `Promise.all` puts every payment in
 * flight simultaneously, so the daily cap — which is checked against what the
 * ledger has *recorded* — sees an empty ledger for all of them and lets every
 * one through. Five hundred sockets is the visible symptom; spending five
 * hundred times the cap before the first receipt lands is the expensive one.
 * Bounding concurrency is what gives the ledger time to observe what was spent.
 *
 * Re-entrancy is the part that is easy to get wrong. `subscribe()` calls
 * `call()`, `call()` calls `quote()` and `balance()`, and `callMany()` calls
 * `call()` once per item. A plain semaphore with a limit of 1 deadlocks the
 * instant one permit holder waits on another. So the permit is kept in an
 * AsyncLocalStorage, which follows the await chain into everything the task
 * calls: a task that already holds one runs straight through instead of
 * queueing behind itself. The limit still bounds how many independent tasks are
 * in flight, which is the number that matters.
 */
export class Limiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly holding = new AsyncLocalStorage<true>();

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RiparError(
        `maxConcurrent must be a whole number of at least 1; got ${limit}.`,
        "invalid_concurrency"
      );
    }
  }

  /** Tasks holding a permit right now. */
  get inFlight() {
    return this.active;
  }

  /** Tasks waiting for one. Exposed so a stalled agent can be diagnosed as
   *  queued rather than hung. */
  get queued() {
    return this.waiting.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.holding.getStore()) return task();
    await this.acquire();
    try {
      return await this.holding.run(true, task);
    } finally {
      this.release();
    }
  }

  private async acquire() {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release() {
    // The permit is handed straight to the next waiter rather than released and
    // re-taken. Dropping `active` first would leave a gap in which a task that
    // arrives later jumps ahead of one already queued, and under a steady
    // arrival rate the earliest waiter starves indefinitely.
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
}
