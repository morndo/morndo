// A store written by a newer helper is refused with exit 78 (EX_CONFIG, §11.1 and RL8 — the exit the hub's main gives
// the same refusal): the agent CLI that called the helper must stop and be fixed, not retry a crash. A file the helper
// itself refuses to touch keeps 70. The store here is built the way a newer version really leaves it: its schema, its
// migration LATEST+1, and the floor that migration wrote.
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS } from "../src/adapters/store-migrations.ts";
import { SqliteStore } from "../src/adapters/store-sqlite.ts";
import { run } from "../src/cli.ts";

const LATEST = MIGRATIONS.length;

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// A store as the next version leaves it: this version's schema, that version's breaking migration LATEST+1.
function futureStore(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "morndo-future-exit-"));
  dirs.push(dir);
  const file = join(dir, "connections.db");
  const made = new SqliteStore(file);                    // the real open path builds today's schema and floor row
  made.close();
  const raw = new Database(file);
  raw.exec("CREATE TABLE future_addition (x)");          // the next version's migration LATEST+1 …
  raw.prepare("UPDATE _morndo_schema SET floor = ?").run(LATEST + 1);   // … breaking: it raised the floor (§11.1)
  raw.pragma(`user_version = ${LATEST + 1}`);
  raw.close();
  return { ...process.env, MORNDO_CONNECTIONS_HOME: dir, MORNDO_VAULT: "file", PWD: dir };
}

describe("morndo-keys on a store from a newer helper", () => {
  it("the helper exits 78, not 1 or 70", async () => {
    const code = await run(["helper", "--lease", "l"], futureStore(), { stdout: () => {}, stderr: () => {} });
    expect(code).toBe(78);
  });
  it("a command exits 78 and prints the one clear line", async () => {
    let stderr = "";
    const code = await run(["list"], futureStore(), { stdout: () => {}, stderr: text => { stderr += text; } });
    expect(code).toBe(78);
    expect(stderr).toMatch(new RegExp(`version ${LATEST + 1}, but this store knows migrations only up to ${LATEST}`));
  });
});
