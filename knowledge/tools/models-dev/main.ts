// models-dev's entry: the real process around cli.ts, as sop-check's main.ts. It hands run the real fetch, with the signal that
// holds each request to its deadline, the cache directory under XDG_CACHE_HOME (or ~/.cache) and today's date, and sets the exit
// code and returns, so piped output drains before exit.
import { homedir } from "node:os";
import { cacheDirOf, run } from "./cli.ts";

const cacheDir = cacheDirOf(process.env, homedir());
process.exitCode = await run(process.argv.slice(2), {
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`),
  fetch: (url, signal) => fetch(url, { signal }),
  cacheDir,
  today: new Date().toISOString().slice(0, 10),
});
