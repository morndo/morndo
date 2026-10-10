// A child process for crash-handlers.test.ts: installs the hub's process-level handlers, then fails the way argv[2] says.
import { homedir } from "node:os";
import { exitOnCrash } from "../src/adapters/crash.ts";
import { log } from "../src/adapters/log.ts";

exitOnCrash(log);
const where = `${homedir()}/somewhere/x.ts`;
if (process.argv[2] === "rejection") void Promise.reject(new Error(`boom in ${where}`, { cause: new Error("root cause") }));
else setTimeout(() => { throw new TypeError(`thrown in ${where}`); }, 10);
setTimeout(() => process.stdout.write("still running\n"), 2000);
