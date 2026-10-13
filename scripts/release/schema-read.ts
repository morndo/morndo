// Starts the schema child. This file loads no app code. The child imports the apps'
// MIGRATIONS and needs the repo's npm ci on this Node (scripts/release/README.md).
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// schema-read.ts lives in scripts/release/, so three parents is the repository root
// (the directory that holds package.json), not scripts/.
export const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// No parent flags are passed. Node 24 strips TypeScript types by default, so the child
// needs none (https://nodejs.org/docs/latest-v24.x/api/typescript.html, read 2026-10-13).
// --watch, --inspect, and --test would hang or clash, and vitest's --require must not leak in.
export function readSchemaJson(script = fileURLToPath(new URL("./schema-child.ts", import.meta.url))): unknown {
  const run = spawnSync(process.execPath, [script], {
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
