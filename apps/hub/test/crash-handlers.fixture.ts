// A child process for crash-handlers.test.ts: installs the hub's process-level handlers, then fails the way argv[2] says.
import { homedir } from "node:os";
import { exitOnCrash } from "../src/adapters/crash.ts";
import { log } from "../src/adapters/log.ts";

// "cleanup": something to close before the exit; "hang": a close that never ends, which must not keep the hub alive.
const crash = exitOnCrash(log, undefined, 300);
if (process.argv[3] === "cleanup") crash.beforeExit(async () => { await new Promise(r => setTimeout(r, 20)); process.stdout.write("cleaned\n"); });
if (process.argv[3] === "hang") crash.beforeExit(() => new Promise<void>(() => {}));
if (process.argv[3] === "done") { crash.beforeExit(async () => { process.stdout.write("cleaned\n"); }); crash.beforeExit(null); }
const where = `${homedir()}/somewhere/x.ts`;
if (process.argv[2] === "rejection") void Promise.reject(new Error(`boom in ${where}`, { cause: new Error("root cause") }));
else setTimeout(() => { throw new TypeError(`thrown in ${where}`); }, 10);
setTimeout(() => process.stdout.write("still running\n"), 2000);
