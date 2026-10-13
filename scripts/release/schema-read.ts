// Starts the schema child. This file loads no app code. The child imports the apps'
// MIGRATIONS and needs the repo's npm ci on this Node (scripts/release/README.md).
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// spawn has no execArgv option (that option is on fork). The parent's node flags are
// passed on the child command, which is what the child reports as process.execArgv.
export function readSchemaJson(script = fileURLToPath(new URL("./schema-child.ts", import.meta.url))): unknown {
  const run = spawnSync(process.execPath, [...process.execArgv, script], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (run.error) throw new Error(`schema read failed: ${run.error.message}`);
  if (run.status !== 0) {
    const detail = (run.stderr || run.stdout || "the schema child exited without a message").trim();
    throw new Error(`schema read failed: ${detail}`);
  }
  try {
    return JSON.parse(run.stdout);
  } catch {
    throw new Error("schema read failed: the schema child did not print JSON");
  }
}
