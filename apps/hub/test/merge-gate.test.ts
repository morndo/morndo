// The merge gate over a real git checkout (B11): NodeBuilds fed by a fake fleet listing, MergeLiveness reading
// `git merge-base --is-ancestor` from a real repository — out of band, so a board action never waits for git — and a
// BoardService on a real store. Done is refused naming the node that keeps a merge from being live, accepted once
// every node's build carries it, and held again by a node that names no build. Synthetic commits only; the checkout is
// only read.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "@morndo/domain";
import { gitAncestry } from "../src/adapters/git-ancestry.ts";
import { Store } from "../src/adapters/store.ts";
import { BoardService } from "../src/application/board-service.ts";
import { MergeLiveness } from "../src/application/merge-liveness.ts";
import { NodeBuilds } from "../src/application/node-builds.ts";

let dirs: string[] = [];
let stores: Store[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); for (const s of stores.splice(0)) s.close(); });

// A hermetic git: no global or system config, a made-up author (the same as git-ancestry.test.ts).
const git = (dir: string, args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", ...args],
    { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
// A repository of one commit after another; their shas, oldest first.
const commits = (dir: string, n: number): string[] => {
  git(dir, ["init", "--quiet"]);
  const shas: string[] = [];
  for (let i = 1; i <= n; i++) {
    writeFileSync(join(dir, `chapter-${i}.txt`), `chapter ${i}\n`);
    git(dir, ["add", "."]);
    git(dir, ["commit", "--quiet", "-m", `chapter ${i}`]);
    shas.push(git(dir, ["rev-parse", "HEAD"]));
  }
  return shas;
};

describe("the merge gate over a real git checkout (B11)", () => {
  it("done waits for the merge on every node, and a node that names no build holds it", async () => {
    const now = 1_800_000_000_000;
    const repo = mkdtempSync(join(tmpdir(), "morndo-merge-gate-"));
    dirs.push(repo);
    const [old = "", merged = "", head = ""] = commits(repo, 3);    // the merge, and one commit more on top of it
    // The fleet's listing, as the test moves it: pc always on the newest build, srv01 behind, then gone for a node that
    // names no build.
    let listing: { name: string; commit?: string | null; status?: string }[] = [
      { name: "pc", commit: head, status: "online" },
      { name: "srv01", commit: old, status: "online" },
    ];
    const builds = new NodeBuilds({ source: async () => listing });
    const store = new Store(mkdtempSync(join(tmpdir(), "morndo-merge-gate-store-")));
    stores.push(store);
    const liveness = new MergeLiveness({ builds: () => builds.list(), ancestry: gitAncestry(repo) });
    const board = new BoardService({ store, now: () => now, policy: () => DEFAULT_POLICY, liveness: sha => liveness.of(sha) });
    const manager = { kind: "manager" as const, name: "manager", token: "mat-test" };
    const builder = { kind: "worker" as const, name: "builder", token: "wat-test" };
    await builds.refresh();
    // The liveness cache fills out of band: a board look asks, and settle waits for git's answers to land.
    const warm = async () => { board.view(); await liveness.settle(); };
    // A task through to review, its PR merged, and Done refused naming the node that keeps the merge from being live.
    const made = board.create({ title: "Ship it", assignee: "builder" }, manager);
    expect(made.ok).toBe(true);
    expect(board.act("T-1", { action: "move", to: "doing" }, builder)).toMatchObject({ ok: true });
    expect(board.act("T-1", { action: "move", to: "review" }, builder)).toMatchObject({ ok: true });
    expect(board.act("T-1", { action: "merged", sha: merged }, manager)).toMatchObject({ ok: true });
    await warm();
    const refused = board.act("T-1", { action: "move", to: "done", reason: "npm test: 14 passed" }, manager);
    expect(refused).toEqual({ ok: false, problem: "not_live", detail: `merged, not live: srv01 on ${old.slice(0, 7)}` });
    // srv01's build moves to the merge (and past it): Done passes, with no override needed.
    listing = [{ name: "pc", commit: head, status: "online" }, { name: "srv01", commit: head, status: "online" }];
    await builds.refresh();
    await warm();                                                     // srv01's new build is a new pair: asked, settled
    const done = board.act("T-1", { action: "move", to: "done", reason: "npm test: 14 passed" }, manager);
    expect(done).toMatchObject({ ok: true, task: { status: "done" } });
    // A node that names no build holds the next task's merge: unknown, never guessed at.
    listing = [{ name: "pc", commit: head, status: "online" }, { name: "srv02", commit: null, status: "online" }];
    await builds.refresh();
    board.create({ title: "Ship it too", assignee: "builder" }, manager);
    expect(board.act("T-2", { action: "move", to: "doing" }, builder)).toMatchObject({ ok: true });
    expect(board.act("T-2", { action: "move", to: "review" }, builder)).toMatchObject({ ok: true });
    expect(board.act("T-2", { action: "merged", sha: merged }, manager)).toMatchObject({ ok: true });
    expect(board.act("T-2", { action: "move", to: "done", reason: "npm test: 14 passed" }, manager))
      .toEqual({ ok: false, problem: "not_live", detail: "merged, not live: srv02 unknown" });
    // T-1 went through live: its merge carries no override.
    expect(board.task("T-1")).toMatchObject({ merged: { merges: [{ repo: "morndo/morndo", sha: merged, override: null }] } });
  });

  it("a cold cache holds done once: the first is refused with unknown, the next passes once the checks land", async () => {
    const now = 1_800_000_000_000;
    const repo = mkdtempSync(join(tmpdir(), "morndo-merge-gate-"));
    dirs.push(repo);
    const [, merged = "", head = ""] = commits(repo, 3);
    const builds = new NodeBuilds({ source: async () => [{ name: "pc", commit: head, status: "online" }] });
    const store = new Store(mkdtempSync(join(tmpdir(), "morndo-merge-gate-store-")));
    stores.push(store);
    const liveness = new MergeLiveness({ builds: () => builds.list(), ancestry: gitAncestry(repo) });
    const board = new BoardService({ store, now: () => now, policy: () => DEFAULT_POLICY, liveness: sha => liveness.of(sha) });
    const manager = { kind: "manager" as const, name: "manager", token: "mat-test" };
    const builder = { kind: "worker" as const, name: "builder", token: "wat-test" };
    await builds.refresh();
    board.create({ title: "Ship it", assignee: "builder" }, manager);
    board.act("T-1", { action: "move", to: "doing" }, builder);
    board.act("T-1", { action: "move", to: "review" }, builder);
    board.act("T-1", { action: "merged", sha: merged }, manager);
    // The first Done is answered from a cold cache — no waiting for git here — and the checks are queued behind it.
    const cold = board.act("T-1", { action: "move", to: "done", reason: "npm test: 14 passed" }, manager);
    expect(cold).toEqual({ ok: false, problem: "not_live", detail: "merged, not live: pc unknown" });
    // A board refresh asks again; settle waits for git's answer; the same Done then passes.
    board.view();
    await liveness.settle();
    const done = board.act("T-1", { action: "move", to: "done", reason: "npm test: 14 passed" }, manager);
    expect(done).toMatchObject({ ok: true, task: { status: "done" } });
  });
});
