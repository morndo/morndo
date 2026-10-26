// Takes <path>.lock once, with no waiting, and says "ok" or "busy"; an owner then holds the lock for `hold` ms before it lets go. Used to race
// several processes for one lock.   node --experimental-strip-types lock-try.mjs <path> <hold ms>
import { acquireEnvLock } from "../../src/adapters/env-file.ts";

const [path, hold] = [process.argv[2], Number(process.argv[3] ?? "1500")];
const lock = await acquireEnvLock(path, { waitMs: 0 });
process.stdout.write(`${lock.ok ? "ok" : "busy"}\n`);
if (lock.ok) {
  await new Promise(resolve => setTimeout(resolve, hold));
  lock.release();
}
