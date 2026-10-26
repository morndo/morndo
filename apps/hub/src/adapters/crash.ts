// Process-level crash handlers (ADR-0008, A5). An unhandled rejection or an uncaught exception leaves the hub in a state
// nobody planned for, so it is logged through the logger (redacted, with its cause chain) and the process exits 1;
// the service manager restarts it (the unit has Restart=on-failure).
import type { Logger } from "./log.ts";

// `beforeExit(fn)`: something to close first, while the hub starts (a start that fails, say a port that is taken, must remove
// what it made); `beforeExit(null)` once it serves, so a crash then exits at once. It is waited for at most `boundMs`.
export function exitOnCrash(log: Logger, exit: (code: number) => never = code => process.exit(code), boundMs = 10_000) {
  let before: (() => Promise<void>) | null = null;
  let crashing = false;
  const crash = (what: string, reason: unknown) => {
    log.error(what, reason);
    if (crashing || !before) return exit(1);
    crashing = true;
    const bound = new Promise<void>(resolve => setTimeout(resolve, boundMs).unref());
    void Promise.race([before().catch((e: unknown) => log.error("stopping after a crash: a close failed", e)), bound]).finally(() => exit(1));
  };
  process.on("unhandledRejection", reason => crash("unhandled promise rejection; exiting", reason));
  process.on("uncaughtException", error => crash("uncaught exception; exiting", error));
  return { beforeExit(fn: (() => Promise<void>) | null) { before = fn; } };
}
