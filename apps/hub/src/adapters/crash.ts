// Process-level crash handlers (ADR-0008, A5). An unhandled rejection or an uncaught exception leaves the hub in a state
// nobody planned for, so it is logged through the logger (redacted, with its cause chain) and the process exits 1;
// the service manager restarts it (the unit has Restart=on-failure).
import type { Logger } from "./log.ts";

export function exitOnCrash(log: Logger, exit: (code: number) => never = code => process.exit(code)) {
  process.on("unhandledRejection", reason => { log.error("unhandled promise rejection; exiting", reason); exit(1); });
  process.on("uncaughtException", error => { log.error("uncaught exception; exiting", error); exit(1); });
}
