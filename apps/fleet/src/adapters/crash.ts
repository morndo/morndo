// Process-level crash handlers, as in the hub (apps/hub/src/adapters/crash.ts, ADR-0008 A5): an unhandled rejection or
// an uncaught exception is logged (redacted, with its causes) and the process exits 1, for the service manager to
// restart it. Agents reconnect with backoff and spool their hooks meanwhile (spec section 7).
import type { Logger } from "./log.ts";

export function exitOnCrash(log: Logger, exit: (code: number) => never = code => process.exit(code)) {
  process.on("unhandledRejection", reason => { log.error("unhandled promise rejection; exiting", reason); exit(1); });
  process.on("uncaughtException", error => { log.error("uncaught exception; exiting", error); exit(1); });
}
