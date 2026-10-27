// Takes <path>.lock, says "ok" (or "busy") on stdout, and holds the lock until it is killed. Used to hold a lock from another process,
// from a process that is then SIGKILLed, and from another pid namespace.   node --experimental-strip-types lock-hold.mjs <path>
import { acquireEnvLock } from "../../src/adapters/env-file.ts";

const lock = await acquireEnvLock(process.argv[2], { waitMs: 0 });
process.stdout.write(`${lock.ok ? "ok" : "busy"}\n`);
if (lock.ok) setInterval(() => {}, 1000);
else process.exit(1);
