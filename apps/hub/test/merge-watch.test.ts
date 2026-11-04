// The hub reads the pull requests the open tasks' briefs name and flags one that merged while its task did not hear of it
// (T-805, B23): a real Store, the BoardService and ProofService over it, and a forge and a clock the test holds. It
// reads only where the hub reads, asks as little as it can (a merged answer is final, an open one is asked again every
// quarter hour, the hour has a budget), and moves or records nothing. Synthetic tasks, repositories and shas only.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY, type BoardActor, type PrFacts } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { BoardService } from "../src/application/board-service.ts";
import { MergeWatch, mergedPass } from "../src/application/merge-watch.ts";
import { ProofService } from "../src/application/proof-service.ts";
import type { ForgeAnswer, ForgeChecks } from "../src/application/ports.ts";

const dirs: string[] = [];
const tempDir = () => { const d = mkdtempSync(join(tmpdir(), "morndo-merge-watch-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const manager: BoardActor = { kind: "manager", name: "manager", token: "tok-manager" };
const lane: BoardActor = { kind: "worker", name: "builder", token: "tok-builder" };
const NOW = 1_800_000_000_000;
const MIN = 60_000;
const SHA = "3e9d1a7c5b2f4a8e9d0c1b2a3f4e5d6c7b8a9f01";

class Forge implements ForgeChecks {
  prs = new Map<string, ForgeAnswer<PrFacts>>();
  asks: string[] = [];
  set(repo: string, n: number, state: "open" | "merged" | "fail", mergeSha: string | null = null) {
    this.prs.set(`${repo}#${n}`, state === "fail" ? { ok: false, failure: { reason: "timeout", detail: "timeout" } }
      : { ok: true, value: { state: state === "open" ? "open" : "closed", merged: state === "merged", headSha: "a".repeat(40), mergeSha: state === "merged" ? mergeSha : null, baseRef: "main" } });
  }
  async pullRequest(repo: string, n: number): Promise<ForgeAnswer<PrFacts>> {
    this.asks.push(`${repo}#${n}`);
    return this.prs.get(`${repo}#${n}`) ?? { ok: false, failure: { reason: "not_found", detail: "not found" } };
  }
  async checkRuns(): Promise<never> { throw new Error("not asked for a merge flag"); }
  async requiredChecks(): Promise<never> { throw new Error("not asked for a merge flag"); }
}

const made = (o: { repos?: () => readonly string[]; noForge?: boolean; prReadsPerHour?: number; everyMs?: number } = {}) => {
  const clock = { now: NOW };
  const store = new Store(tempDir());
  const repos = o.repos ?? (() => ["morndo/morndo", "acme/widgets"]);
  const board = new BoardService({ store, policy: () => DEFAULT_POLICY, now: () => clock.now, repos });
  // The proof service may be allowed more than the watch reads: a brief names what the proof allows, the watch asks only what the hub reads.
  const proof = new ProofService({ store, board, now: () => clock.now, allowedRepos: ["morndo/morndo", "acme/widgets", "acme/elsewhere"] });
  const forge = new Forge();
  const watch = new MergeWatch({ board, proof, forge: o.noForge ? null : forge, repos, now: () => clock.now,
    ...(o.prReadsPerHour !== undefined ? { prReadsPerHour: o.prReadsPerHour } : {}), ...(o.everyMs !== undefined ? { everyMs: o.everyMs } : {}) });
  board.attachMerged(watch);
  return { clock, store, board, proof, forge, watch };
};
type Rig = ReturnType<typeof made>;

// The next task, assigned to builder and in review with a brief naming `refs`.
async function inReview(rig: Rig, refs: string[]): Promise<string> {
  const t = rig.board.create({ title: "Ship the totals row", assignee: "builder" }, manager);
  if (!t.ok) throw new Error(t.problem);
  for (const to of ["doing", "review"] as const) { const m = rig.board.act(t.task.key, { action: "move", to }, lane); if (!m.ok) throw new Error(m.problem); }
  const f = await rig.proof.file(t.task.key, { summary: "Totals row rounds to cents", leftOut: "nothing", limits: "none known", refs }, lane);
  if (!f.ok) throw new Error(`${f.problem} ${f.detail ?? ""}`);
  return t.task.key;
}
const W = (n: number) => `acme/widgets#${n}@3e9d1a7`;

describe("flags, as the last pass saw them", () => {
  it("flags a merged pull request a task in review names, with the commit it merged as, and reads the forge once", async () => {
    const rig = made();
    const key = await inReview(rig, [W(42)]);
    rig.forge.set("acme/widgets", 42, "merged", SHA);
    expect(rig.watch.flags()).toEqual([]);                                      // before the first pass
    expect(await rig.watch.tick()).toEqual({ read: 1, flagged: 1 });
    expect(rig.watch.flags()).toEqual([{ key, status: "review", prs: [{ repo: "acme/widgets", n: 42, mergeSha: SHA }] }]);
    rig.store.close();
  });

  it("flags nothing for a pull request still open; the view carries no mergedPrs until something is flagged, then says which", async () => {
    const rig = made();
    const key = await inReview(rig, [W(42)]);
    rig.forge.set("acme/widgets", 42, "open");
    expect(await rig.watch.tick()).toEqual({ read: 1, flagged: 0 });
    expect("mergedPrs" in rig.board.view()).toBe(false);
    rig.clock.now += 20 * MIN;
    rig.forge.set("acme/widgets", 42, "merged", SHA);
    expect(await rig.watch.tick()).toEqual({ read: 1, flagged: 1 });
    expect(rig.board.view().mergedPrs).toEqual([{ key, prs: ["acme/widgets#42 merged 3e9d1a7"] }]);
    rig.store.close();
  });

  it("moves nothing and records nothing: the task stays in review with no merge record", async () => {
    const rig = made();
    const key = await inReview(rig, [W(42)]);
    rig.forge.set("acme/widgets", 42, "merged", SHA);
    const before = rig.store.taskEvents(key).length;
    await rig.watch.tick();
    expect(rig.store.task(key)?.status).toBe("review");
    expect(rig.store.mergesOf(key)).toEqual([]);
    expect(rig.store.taskEvents(key)).toHaveLength(before);
    rig.store.close();
  });

  it("is quiet once the task records that merge, however the manager records it", async () => {
    const rig = made();
    const key = await inReview(rig, [W(42)]);
    rig.forge.set("acme/widgets", 42, "merged", SHA);
    await rig.watch.tick();
    expect(rig.watch.flags()).toHaveLength(1);
    expect(rig.board.act(key, { action: "merged", sha: SHA.slice(0, 7), repo: "Acme/Widgets" }, manager).ok).toBe(true);
    expect(rig.watch.flags()).toEqual([]);                                      // at once, with no pass: the facts are the last pass's, the board is now
    expect("mergedPrs" in rig.board.view()).toBe(false);
    await rig.watch.tick();
    expect(rig.watch.flags()).toEqual([]);
    expect("mergedPrs" in rig.board.view()).toBe(false);
    rig.store.close();
  });

  it("drops a task that is done: nothing is asked for it and it is no longer flagged", async () => {
    const rig = made();
    const key = await inReview(rig, [W(42)]);
    rig.forge.set("acme/widgets", 42, "merged", SHA);
    await rig.watch.tick();
    expect(rig.board.act(key, { action: "move", to: "done", reason: "checked, shipped" }, manager).ok).toBe(true);
    expect(rig.watch.flags()).toEqual([]);                                      // at once, with no pass
    expect(await rig.watch.tick()).toEqual({ read: 0, flagged: 0 });
    expect(rig.watch.flags()).toEqual([]);
    rig.store.close();
  });

  it("shows the task's status as it is now, not as it was at the pass", async () => {
    const rig = made();
    const key = await inReview(rig, [W(42)]);
    rig.forge.set("acme/widgets", 42, "merged", SHA);
    await rig.watch.tick();
    expect(rig.watch.flags().map(f => f.status)).toEqual(["review"]);
    expect(rig.board.act(key, { action: "move", to: "doing" }, lane).ok).toBe(true);
    expect(rig.watch.flags().map(f => f.status)).toEqual(["doing"]);
    rig.store.close();
  });

  it("reads a pull request two tasks name once, and flags both", async () => {
    const rig = made();
    const a = await inReview(rig, [W(42)]);
    const b = await inReview(rig, [W(42)]);
    rig.forge.set("acme/widgets", 42, "merged", SHA);
    expect(await rig.watch.tick()).toEqual({ read: 1, flagged: 2 });
    expect(rig.watch.flags().map(f => f.key)).toEqual([a, b]);
    rig.store.close();
  });
});

describe("what it asks of the forge", () => {
  it("never asks about a repository the hub does not read, whatever a brief names; and matches the list without regard to case", async () => {
    const rig = made();
    await inReview(rig, ["acme/elsewhere#5@3e9d1a7"]);
    rig.forge.set("acme/elsewhere", 5, "merged", SHA);
    expect(await rig.watch.tick()).toEqual({ read: 0, flagged: 0 });
    expect(rig.forge.asks).toEqual([]);
    const upper = made({ repos: () => ["ACME/Widgets"] });
    await inReview(upper, [W(42)]);
    upper.forge.set("acme/widgets", 42, "merged", SHA);
    expect(await upper.watch.tick()).toEqual({ read: 1, flagged: 1 });
    rig.store.close(); upper.store.close();
  });

  it("with no forge there is nothing to read and nothing flagged", async () => {
    const rig = made({ noForge: true });
    await inReview(rig, [W(42)]);
    expect(await rig.watch.tick()).toEqual({ read: 0, flagged: 0 });
    expect(rig.watch.flags()).toEqual([]);
    rig.store.close();
  });

  it("asks about an open pull request again only after a quarter of an hour, and a merged one never again", async () => {
    const rig = made();
    await inReview(rig, [W(42)]);
    rig.forge.set("acme/widgets", 42, "open");
    expect((await rig.watch.tick()).read).toBe(1);
    rig.clock.now += 14 * MIN;
    expect((await rig.watch.tick()).read).toBe(0);
    rig.clock.now += 2 * MIN;
    rig.forge.set("acme/widgets", 42, "merged", SHA);
    expect(await rig.watch.tick()).toEqual({ read: 1, flagged: 1 });
    rig.clock.now += 3 * 60 * MIN;
    expect(await rig.watch.tick()).toEqual({ read: 0, flagged: 1 });          // final: kept, still flagged
    expect(rig.forge.asks).toHaveLength(2);
    rig.store.close();
  });

  it("does not ask again at every pass for a read that failed: the same quarter of an hour", async () => {
    const rig = made();
    await inReview(rig, [W(42)]);
    rig.forge.set("acme/widgets", 42, "fail");
    expect(await rig.watch.tick()).toEqual({ read: 1, flagged: 0 });
    rig.clock.now += 5 * MIN;
    expect((await rig.watch.tick()).read).toBe(0);
    rig.clock.now += 11 * MIN;
    expect((await rig.watch.tick()).read).toBe(1);
    rig.store.close();
  });

  it("spends at most its hourly budget, asks the ones never read first, and keeps a pull request's last word when the budget is out", async () => {
    const rig = made({ prReadsPerHour: 2 });
    for (const n of [41, 42, 43]) { await inReview(rig, [W(n)]); rig.forge.set("acme/widgets", n, "open"); }
    expect((await rig.watch.tick()).read).toBe(2);
    const unread = [41, 42, 43].find(n => !rig.forge.asks.includes(`acme/widgets#${n}`));
    expect(unread).toBeDefined();
    expect((await rig.watch.tick()).read).toBe(0);                             // nothing due, and no budget
    rig.clock.now += 31 * MIN;                                                 // the bucket has refilled by one
    expect((await rig.watch.tick()).read).toBe(1);
    expect(rig.forge.asks.at(-1)).toBe(`acme/widgets#${unread}`);              // the one never read, not a re-read of an open one
    rig.store.close();
  });
});

describe("mergedPass: the sweep follows the watch's pass, never goes before it", () => {
  it("runs the watch, then the sweep once the watch has finished, and returns both answers", async () => {
    const order: string[] = [];
    const watch = { tick: async () => { order.push("watch start"); await new Promise(r => setTimeout(r, 5)); order.push("watch end"); return { read: 1, flagged: 2 }; } };
    const sweep = { tick: async () => { order.push("sweep"); return { sent: true, items: 2 }; } };
    expect(await mergedPass(watch, sweep)).toEqual({ read: 1, flagged: 2, sent: true });
    expect(order).toEqual(["watch start", "watch end", "sweep"]);
  });
  it("with no sweep (a hub with no fleet) only the watch runs", async () => {
    expect(await mergedPass({ tick: async () => ({ read: 3, flagged: 0 }) }, null)).toEqual({ read: 3, flagged: 0, sent: false });
  });
  it("a watch pass that fails is not followed by a sweep, and the failure reaches the caller", async () => {
    let swept = false;
    const sweep = { tick: async () => { swept = true; return { sent: false, items: 0 }; } };
    await expect(mergedPass({ tick: async () => { throw new Error("the forge is down"); } }, sweep)).rejects.toThrow("the forge is down");
    expect(swept).toBe(false);
  });
});
