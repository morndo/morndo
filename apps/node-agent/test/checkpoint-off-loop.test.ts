// T-532: SQLite's automatic checkpoint runs inside the commit that crosses the WAL's limit, on the connection that
// commits, and syncs the WAL and the database file there, even under synchronous=NORMAL. On the agent that connection
// is the event loop's. So the agent's connection never checkpoints (wal_autocheckpoint = 0), and a worker thread with
// a connection of its own does, off the loop.
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("a worker that dies calls onFail: the agent checkpoints on its own connection again (review round 2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "checkpoint-"));
    dirs.push(dir);
    let failed = 0;
    const checkpointer = startCheckpointer(join(dir, "no-such.db"), { everyMs: 60_000, onFail: () => { failed += 1; } });
    closers.push(() => checkpointer.stop());
    await vi.waitFor(() => { expect(failed).toBe(1); }, { timeout: 10_000 });   // the worker could not open the file
    await expect(checkpointer.now()).rejects.toThrow(/stopped/);
  });

  it("a worker that is alive but stuck calls onFail once its progress deadline passes, and stop() returns anyway", async () => {
    const dir = mkdtempSync(join(tmpdir(), "checkpoint-"));
    dirs.push(dir);
    const path = join(dir, "agent.db");
    const adb = openAgentDb(path);
    closers.push(() => adb.close());
    let failed = 0;
    // stallMs: the worker blocks inside its first checkpoint, as one stuck in the disk would.
    const checkpointer = startCheckpointer(path, { everyMs: 100, stuckMs: 1000, stopWaitMs: 500, onFail: () => { failed += 1; }, test: { stallMs: 30_000 } });
    await vi.waitFor(() => { expect(failed).toBe(1); }, { timeout: 10_000 });
    const t0 = Date.now();
    await checkpointer.stop();
    expect(Date.now() - t0).toBeLessThan(3000);                    // bounded: the stuck worker is left to the process's exit
    expect(failed).toBe(1);                                          // once
  });
});

// T-571 (rev-198's recheck of #198): a worker that hands back is stopped, so it never checkpoints beside the agent's
// own connection, and after a cool-down a new worker takes the checkpoints back.
describe("a hand-back is stopped, and taken back after a cool-down (T-571)", () => {
  // A database whose WAL holds every page written: the agent's connection never checkpoints (db/open.ts).
  function filled(): { path: string; adb: ReturnType<typeof openAgentDb> } {
    const dir = mkdtempSync(join(tmpdir(), "checkpoint-"));
    dirs.push(dir);
    const path = join(dir, "agent.db");
    const adb = openAgentDb(path);
    closers.push(() => adb.close());
    adb.db.exec("CREATE TABLE IF NOT EXISTS t (x TEXT)");
    const insert = adb.db.prepare("INSERT INTO t VALUES (?)");
    for (let i = 0; i < 1500; i++) insert.run("x".repeat(4000));
    return { path, adb };
  }
  const logOf = (warns: string[]) => ({ warn: (m: string) => { warns.push(m); } });

  it("stops a stuck worker as it hands back: once the stall is over it copies nothing", async () => {
    const { path } = filled();
    const before = statSync(path).size;
    let failed = 0;
    // The first checkpoint blocks 2 s, past the 500 ms deadline; a worker left running copies the WAL once it returns.
    const checkpointer = startCheckpointer(path, { everyMs: 100, stuckMs: 500, restartMs: 60_000, onFail: () => { failed += 1; }, test: { stallMs: 2000 } });
    closers.unshift(() => checkpointer.stop());
    await vi.waitFor(() => { expect(failed).toBe(1); }, { timeout: 10_000 });
    await new Promise(resolve => setTimeout(resolve, 3000));
    expect(statSync(path).size).toBe(before);                      // no checkpoint ran beside the agent's own
    expect(failed).toBe(1);
  });

  it("starts a new worker after the cool-down, which takes the checkpoints back once it makes progress", async () => {
    const { path } = filled();
    let failed = 0;
    let resumed = 0;
    // Only the first worker stalls (30 s); the one started after the 300 ms cool-down checkpoints at once.
    const checkpointer = startCheckpointer(path, {
      everyMs: 100, stuckMs: 500, restartMs: 300, onFail: () => { failed += 1; }, onResume: () => { resumed += 1; }, test: { stallMs: 30_000 },
    });
    closers.unshift(() => checkpointer.stop());
    await vi.waitFor(() => { expect(resumed).toBe(1); }, { timeout: 10_000 });
    expect(failed).toBe(1);
    expect(statSync(path).size).toBeGreaterThan(1500 * 4000);      // the new worker copied the WAL
    const done = await checkpointer.now();
    expect(done.checkpointed).toBe(done.log);
  });

  it("a new worker that fails before it makes progress hands back nothing more: the agent keeps checkpointing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "checkpoint-"));
    dirs.push(dir);
    let failed = 0;
    let resumed = 0;
    const warns: string[] = [];
    const checkpointer = startCheckpointer(join(dir, "no-such.db"), {
      everyMs: 60_000, restartMs: 100, log: logOf(warns), onFail: () => { failed += 1; }, onResume: () => { resumed += 1; },
    });
    closers.push(() => checkpointer.stop());
    await vi.waitFor(() => { expect(warns.length).toBeGreaterThanOrEqual(3); }, { timeout: 10_000 });   // it tried again
    expect(failed).toBe(1);
    expect(resumed).toBe(0);
  });

  it("stop() ends a cool-down: no worker starts after it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "checkpoint-"));
    dirs.push(dir);
    let failed = 0;
    const warns: string[] = [];
    const checkpointer = startCheckpointer(join(dir, "no-such.db"), { everyMs: 60_000, restartMs: 300, log: logOf(warns), onFail: () => { failed += 1; } });
    await vi.waitFor(() => { expect(failed).toBe(1); }, { timeout: 10_000 });
    await checkpointer.stop();
    const tried = warns.length;
    await new Promise(resolve => setTimeout(resolve, 1000));
    expect(warns.length).toBe(tried);
    await expect(checkpointer.now()).rejects.toThrow(/stopped/);
  });
});

// T-581 (rev-200's review of #200): a start that throws is tried again, later each time; the progress deadline never
// outlives its worker; and only a checkpoint that ran counts as progress.
describe("restarts that fail, the deadline's end, and what counts as progress (T-581)", () => {
  function filled(): string {
    const dir = mkdtempSync(join(tmpdir(), "checkpoint-"));
    dirs.push(dir);
    const path = join(dir, "agent.db");
    const adb = openAgentDb(path);
    closers.push(() => adb.close());
    adb.db.exec("CREATE TABLE IF NOT EXISTS t (x TEXT)");
    adb.db.prepare("INSERT INTO t VALUES (?)").run("x");
    return path;
  }

  it("tries a start that throws again, each cool-down twice the last, until a worker makes progress", async () => {
    const path = filled();
    let resumed = 0;
    const tries: number[] = [];
    // The first worker stalls past its deadline; then three starts throw before one comes up.
    const checkpointer = startCheckpointer(path, {
      everyMs: 100, stuckMs: 500, restartMs: 200, onResume: () => { resumed += 1; }, test: { stallMs: 30_000, failStarts: 3 },
      log: { warn: (m: string) => { if (m.includes("could start")) tries.push(Date.now()); } },
    });
    closers.unshift(() => checkpointer.stop());
    await vi.waitFor(() => { expect(resumed).toBe(1); }, { timeout: 20_000 });
    expect(tries).toHaveLength(3);
    expect((tries[1] ?? 0) - (tries[0] ?? 0)).toBeGreaterThanOrEqual(390);      // 200 ms, then 400, then 800
    expect((tries[2] ?? 0) - (tries[1] ?? 0)).toBeGreaterThanOrEqual(790);
  }, 30_000);

  it("stop() ends the progress deadline of the worker in use", async () => {
    const path = filled();
    const set = vi.spyOn(globalThis, "setInterval");
    const clear = vi.spyOn(globalThis, "clearInterval");
    try {
      const from = set.mock.results.length;
      const checkpointer = startCheckpointer(path, { everyMs: 60_000 });
      const deadlines = set.mock.results.slice(from).map(r => r.value as unknown);
      expect(deadlines).toHaveLength(1);
      await checkpointer.now();
      await checkpointer.stop();
      expect(clear.mock.calls.map(c => c[0] as unknown)).toContain(deadlines[0]);
    } finally {
      set.mockRestore();
      clear.mockRestore();
    }
  });

  it("an error reply is no progress: a new worker whose checkpoints fail never takes the checkpoints back", async () => {
    const path = filled();
    let failed = 0;
    let resumed = 0;
    // Every checkpoint of every worker throws, as on a disk that answers I/O errors.
    const checkpointer = startCheckpointer(path, {
      everyMs: 100, stuckMs: 500, restartMs: 100, onFail: () => { failed += 1; }, onResume: () => { resumed += 1; }, test: { failCheckpoints: true },
    });
    closers.unshift(() => checkpointer.stop());
    await vi.waitFor(() => { expect(failed).toBe(1); }, { timeout: 10_000 });     // no checkpoint ran: past the deadline
    await vi.waitFor(async () => { await expect(checkpointer.now()).rejects.toThrow(/I\/O error \(test\)/); }, { timeout: 10_000 });
    expect(resumed).toBe(0);
  });
});
