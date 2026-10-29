// T-532: SQLite's automatic checkpoint runs inside the commit that crosses the WAL's limit, on the connection that
// commits, and syncs the WAL and the database file there, even under synchronous=NORMAL. On the agent that connection
// is the event loop's. So the agent's connection never checkpoints (wal_autocheckpoint = 0), and a worker thread with
// a connection of its own does, off the loop.
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startCheckpointer } from "../src/db/checkpointer.ts";
import { openAgentDb } from "../src/db/open.ts";

const dirs: string[] = [];
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("checkpoints off the event loop (T-532)", () => {
  it("the agent's connection never checkpoints, and the worker's checkpoint takes the whole WAL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "checkpoint-"));
    dirs.push(dir);
    const path = join(dir, "agent.db");
    const adb = openAgentDb(path);
    closers.push(() => adb.close());
    expect(adb.db.pragma("wal_autocheckpoint", { simple: true })).toBe(0);
    adb.db.exec("CREATE TABLE IF NOT EXISTS t (x TEXT)");
    const insert = adb.db.prepare("INSERT INTO t VALUES (?)");
    for (let i = 0; i < 1500; i++) insert.run("x".repeat(4000));    // well past the 1000 pages that would checkpoint
    // No checkpoint ran on this connection: the WAL holds every page written (a checkpoint would have restarted it).
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(1500 * 4096);
    const checkpointer = startCheckpointer(path, { everyMs: 60_000 });
    closers.unshift(() => checkpointer.stop());
    const done = await checkpointer.now();
    expect(done.busy).toBe(0);
    expect(done.log).toBeGreaterThan(1500);
    expect(done.checkpointed).toBe(done.log);                         // the whole WAL is in the database file
    insert.run("after");                                              // and the writer goes on as before
    expect((adb.db.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n).toBe(1501);
  });

  it("stops: no worker is left behind, and a now() after stop is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "checkpoint-"));
    dirs.push(dir);
    const path = join(dir, "agent.db");
    const adb = openAgentDb(path);
    closers.push(() => adb.close());
    const checkpointer = startCheckpointer(path, { everyMs: 60_000 });
    await checkpointer.now();
    await checkpointer.stop();
    await expect(checkpointer.now()).rejects.toThrow(/stopped/);
  });
});
