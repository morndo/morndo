// models-dev's entry: the real process around cli.ts, as sop-check's main.ts. It hands run the real fetch and the cache directory
// under XDG_CACHE_HOME (or ~/.cache), and sets the exit code and returns, so piped output drains before exit.
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "./cli.ts";

const cacheDir = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "morndo-knowledge", "models-dev");
process.exitCode = await run(process.argv.slice(2), {
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`),
  fetch: url => fetch(url),
  cacheDir,
  today: new Date().toISOString().slice(0, 10),
});
