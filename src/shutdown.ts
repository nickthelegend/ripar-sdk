import type { Runtime } from "./runtime.js";

/** The subset of http.Server this needs. Typed structurally so a test can pass
 *  a stand-in and assert the ordering without opening a socket. */
export type ClosableServer = {
  close(cb?: (err?: Error) => void): unknown;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
};

export type ShutdownOptions = {
  /** How long in-flight work gets before sockets are cut. Default 15s. */
  timeoutMs?: number;
  /** Signals to listen for. Pass [] to wire nothing and drive it yourself. */
  signals?: NodeJS.Signals[];
  /** Called with the outcome once draining finishes. Default: process.exit. */
  onExit?: (result: ShutdownResult) => void;
  log?: (message: string) => void;
};

export type ShutdownResult = {
  reason: string;
  outcome: "drained" | "timeout";
  /** Requests still running when the hard timeout fired. */
  abandoned: number;
  ms: number;
};

/**
 * Drains before exiting, because the alternative charges people for nothing.
 *
 * A paid call that is killed mid-flight has already settled: the caller's USDC
 * moved, and they get a dropped connection instead of an answer. Every deploy
 * would do that to whoever was unlucky. So SIGTERM stops accepting new work,
 * lets what is running finish, and only then exits.
 *
 * The hard timeout is not optional. Orchestrators send SIGKILL after their own
 * grace period (30s on Kubernetes, 30s on Fly), and a process still waiting on
 * one stuck handler when that lands dies with no log and no exit code anyone can
 * read. Better to give up on our own terms, and say how many we abandoned.
 */
export function installShutdown(server: ClosableServer, runtime: Runtime, opts: ShutdownOptions = {}) {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const signals = opts.signals ?? (["SIGTERM", "SIGINT"] as NodeJS.Signals[]);
  const log = opts.log ?? ((m: string) => console.log(m));
  const onExit = opts.onExit ?? ((r: ShutdownResult) => process.exit(r.outcome === "drained" ? 0 : 1));

  let running: Promise<ShutdownResult> | null = null;

  async function shutdown(reason = "manual"): Promise<ShutdownResult> {
    // A second SIGTERM must not start a second drain — it would double-count
    // in-flight work and cut the first drain's timeout short.
    if (running) return running;
    running = (async () => {
      const started = Date.now();
      runtime.beginDrain(started);
      log(`ripar · ${reason}: draining ${runtime.inFlight} in-flight request(s), ${timeoutMs}ms limit`);

      server.close();
      // Keep-alive sockets survive close(); an idle one holds the process open
      // for its full timeout while serving nobody.
      server.closeIdleConnections?.();

      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
        timer.unref?.();
      });
      const outcome = await Promise.race([runtime.whenIdle().then(() => "drained" as const), timedOut]);
      if (timer) clearTimeout(timer);

      const abandoned = outcome === "timeout" ? runtime.inFlight : 0;
      if (outcome === "timeout") server.closeAllConnections?.();

      const result: ShutdownResult = { reason, outcome, abandoned, ms: Date.now() - started };
      log(
        outcome === "drained"
          ? `ripar · drained cleanly in ${result.ms}ms`
          : `ripar · hard timeout after ${result.ms}ms, abandoning ${abandoned} request(s)`
      );
      onExit(result);
      return result;
    })();
    return running;
  }

  const handlers: [NodeJS.Signals, () => void][] = signals.map((sig) => [sig, () => void shutdown(sig)]);
  for (const [sig, fn] of handlers) process.on(sig, fn);

  /** Detach the signal handlers — a long-lived test process would otherwise
   *  accumulate one set per server it started. */
  function uninstall() {
    for (const [sig, fn] of handlers) process.off(sig, fn);
  }

  return { shutdown, uninstall };
}
