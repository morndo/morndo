// sop-check's entry: the real process around cli.ts. Bundled to the recurring-job skill's scripts/sop-check.mjs, so the
// skill's folder is the one above this file's. It sets the exit code and returns, so piped output drains before exit.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./cli.ts";

const skillDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.exitCode = await run(process.argv.slice(2), {
  skillDir,
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`),
});
