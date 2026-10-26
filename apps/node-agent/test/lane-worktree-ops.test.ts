// lane.start, lane.stop, worktree.list and worktree.add (spec §4 "Lane names", §5.3, §8) on an isolated tmux server
// with a stand-in `claude` and `claude-as` on the server's PATH, and a throwaway git repository under repoRoots.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Launch } from "../src/config.ts";
import { branchNameOk } from "../src/ops/worktree-ops.ts";
import { isolatedTmux, tempHome, until, wait, type TestTmux } from "./helpers.ts";
import { opsHarness, type Harness } from "./ops-harness.ts";

const SID = "3f0c1d2e-1111-4222-8333-444455556666";
// The stand-in `claude` as the pane's own program (spec §5, launch.via "direct"), and no wait for a trust dialog that a
// stand-in never shows (lane-ops.ts).
const DIRECT: Launch = { command: ["claude"], via: "direct" };
const QUICK = { trustMs: 0 };
let home: { home: string; cleanup: () => void };
let t: TestTmux;
let h: Harness;
let bin = "";
let argvDir = "";
let work = "";
const savedPath = process.env.PATH;
const savedArgvDir = process.env.MORNDO_TEST_ARGV;

beforeEach(() => {
  home = tempHome();
  bin = join(home.home, "bin");
  argvDir = join(home.home, "argv");
  work = join(home.home, "work");
  for (const d of [bin, argvDir, work]) mkdirSync(d, { recursive: true });
  // Each stand-in records its own name and arguments, then stays running like a lane would.
  for (const name of ["claude", "claude-as"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$(basename "$0")" "$@" > "$MORNDO_TEST_ARGV/$(basename "$0").argv"\nexec sleep 600\n`);
    chmodSync(join(bin, name), 0o755);
  }
  // A tmux server started here (by a test or by lane.start) takes the stand-ins' PATH from this environment. The
  // isolated server's commands copy the environment when it is made, so it is made after this.
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
  process.env.MORNDO_TEST_ARGV = argvDir;
  t = isolatedTmux();
  h = opsHarness({ home: home.home, socket: t.socket, policy: { repoRoots: [join(home.home, "code")], launch: DIRECT }, laneWaits: QUICK });
});
afterEach(async () => {
  h.close();
  await t.kill();
  process.env.PATH = savedPath;
  if (savedArgvDir === undefined) delete process.env.MORNDO_TEST_ARGV; else process.env.MORNDO_TEST_ARGV = savedArgvDir;
  home.cleanup();
});

const argv = (name: string) => (existsSync(join(argvDir, `${name}.argv`)) ? readFileSync(join(argvDir, `${name}.argv`), "utf8").trim().split("\n") : null);

describe("lane.start", () => {
  it("starts claude-as with the typed account and resume id in a new window, and the answer's invVersion lists it", async () => {
    t.tmux("new-session", "-d", "-s", "main", "-n", "base", "sleep 600");
    // The owner's launcher (spec §5): claude-as, with the op's account in place of {account}.
    const owner = opsHarness({ home: home.home, socket: t.socket, policy: { launch: { command: ["claude-as", "{account}"], via: "direct" } }, laneWaits: QUICK });
    try {
      const name = "fix: a/b ü.2 #S";                              // "#S" would become the session name unescaped
      const r = await owner.call("lane.start", { name, cwd: work, account: "acct", resume: SID }, { key: "hub:ls1" });
      if (!r.ok) throw new Error(r.error.message);
      const workerId = (r.result as { workerId: string }).workerId;
      expect(workerId).toMatch(/^pc\.[0-9a-f]{8}\.\d+$/);
      expect(owner.inventory.last().invVersion).toBe(r.invVersion);
      expect(owner.inventory.last().panes.find(p => p.workerId === workerId)).toMatchObject({ window: name, cwd: work });
      expect(await until(() => argv("claude-as") !== null)).toBe(true);
      expect(argv("claude-as")).toEqual(["claude-as", "acct", "--resume", SID]);
    } finally {
      owner.close();
    }
  });
  it("starts plain claude without an account, and claude --resume with only a resume id", async () => {
    t.tmux("new-session", "-d", "-s", "main", "-n", "base", "sleep 600");
    expect(await h.call("lane.start", { name: "plain", cwd: work }, { key: "hub:ls2" })).toMatchObject({ ok: true });
    expect(await until(() => argv("claude") !== null)).toBe(true);
    expect(argv("claude")).toEqual(["claude"]);
    expect(await h.call("lane.start", { name: "resumed", cwd: work, resume: SID }, { key: "hub:ls3" })).toMatchObject({ ok: true });
    expect(await until(() => argv("claude")?.length === 3)).toBe(true);
    expect(argv("claude")).toEqual(["claude", "--resume", SID]);
  });
  it("refuses a name already taken on this node (not executed, key freed), a bad cwd and free-form flags", async () => {
    t.tmux("new-session", "-d", "-s", "main", "-n", "api", "sleep 600");
    expect(await h.call("lane.start", { name: "api", cwd: work }, { key: "hub:ls4" })).toMatchObject({ ok: false, error: { code: "name_taken", executed: "no" } });
    expect(h.doneKeys.status("hub:ls4")).toEqual({ state: "unknown" });
    expect(await h.call("lane.start", { name: "x", cwd: join(work, "missing") }, { key: "hub:ls5" })).toMatchObject({ ok: false, error: { code: "bad_args" } });
    mkdirSync(join(home.home, ".ssh"), { recursive: true });
    expect(await h.call("lane.start", { name: "x", cwd: join(home.home, ".ssh") }, { key: "hub:ls6" })).toMatchObject({ ok: false, error: { code: "denied" } });
    for (const args of [
      { name: "x", cwd: work, account: "--dangerously-skip-permissions" },
      { name: "x", cwd: work, account: "acct_2" },
      { name: "x", cwd: work, resume: "abc; rm -rf ~" },
      { name: "x", cwd: work, resume: "--fork-session" },
      { name: "bad\nname", cwd: work },
    ]) {
      expect(await h.call("lane.start", args, { key: "hub:ls7" })).toMatchObject({ ok: false, error: { code: "bad_args" } });
    }
    // Free-form flags are no field of lane.start: OP_ARGS drops them, as the fleet does, and claude never sees them.
    expect(await h.call("lane.start", { name: "flagged", cwd: work, flags: ["--model", "opus"] }, { key: "hub:ls7b" })).toMatchObject({ ok: true });
    expect(await until(() => argv("claude") !== null)).toBe(true);
    expect(argv("claude")).toEqual(["claude"]);
  });
  it("refuses a deny root when HOME is a symbolic link: the resolved cwd is judged against resolved deny roots (final review M10)", async () => {
    t.tmux("new-session", "-d", "-s", "main", "-n", "base", "sleep 600");
    const linked = `${home.home}-link`;
    symlinkSync(home.home, linked);
    const viaLink = opsHarness({ home: linked, socket: t.socket, policy: { launch: DIRECT }, laneWaits: QUICK });
    try {
      mkdirSync(join(home.home, ".ssh"), { recursive: true });
      mkdirSync(join(home.home, ".config", "morndo-fleet"), { recursive: true });
      for (const cwd of [join(linked, ".ssh"), join(linked, ".config", "morndo-fleet"), viaLink.paths.stateDir, join(home.home, ".ssh")]) {
        mkdirSync(cwd, { recursive: true });
        expect(await viaLink.call("lane.start", { name: "x", cwd }, { key: "hub:lk1" }), cwd).toMatchObject({ ok: false, error: { code: "denied", executed: "no" } });
      }
      expect(await viaLink.call("lane.start", { name: "x", cwd: join(linked, "work") }, { key: "hub:lk2" })).toMatchObject({ ok: true });   // negative control
    } finally { viaLink.close(); unlinkSync(linked); }
  });
  it("starts the tmux server and the policy's session when none runs", async () => {
    expect(await h.call("lane.start", { name: "first", cwd: work }, { key: "hub:ls8" })).toMatchObject({ ok: true });
    expect(t.tmux("list-windows", "-t", "=main", "-F", "#{window_name}").trim()).toBe("first");
  });
  it("starts in exactly the directory asked for, whatever tmux formats it holds: never expanded, never run", async () => {
    // tmux expands formats in -c as in -n (seen on tmux 3.6a: a directory a#{session_name}b started the pane in amainb),
    // and #(…) is a format that runs a shell command; tmuxLiteral doubles every #. A #(…) job runs in the working
    // directory of the tmux client whose command expanded it — not the server's, not HOME (seen on tmux 3.4) — and
    // lane.start's client is this process. Run from the throwaway HOME, so a job, had one escaped wrongly, lands
    // there: this test never looks at the directory the suite runs in, whatever stray files sit in it.
    const back = process.cwd();
    process.chdir(home.home);
    try {
      t.tmux("new-session", "-d", "-s", "main", "-n", "base", "sleep 600");
      const dirs = ["#{session_name}", "#(touch m)", "a#Sb ##x"].map(n => { const d = join(work, n); mkdirSync(d); return d; });
      for (const [i, cwd] of dirs.entries()) {
        const name = `odd dir ${i} #(touch n)`;
        const r = await h.call("lane.start", { name, cwd }, { key: `hub:dir${i}` });
        if (!r.ok) throw new Error(r.error.message);
        const pane = `%${(r.result as { workerId: string }).workerId.replace(/^.*\./, "")}`;
        expect(t.tmux("display-message", "-p", "-t", pane, "#{pane_start_path}").replace(/\n$/, ""), cwd).toBe(realpathSync(cwd));
        expect(t.tmux("display-message", "-p", "-t", pane, "#{window_name}").replace(/\n$/, "")).toBe(name);
        expect(h.inventory.last().panes.find(p => p.window === name)).toMatchObject({ cwd: realpathSync(cwd) });
      }
      await wait(500);                                                        // time for a #(…) job, had one started
      for (const where of [work, ...dirs, home.home]) {
        expect(readdirSync(where).filter(f => f === "m" || f === "n"), where).toEqual([]);
      }
    } finally { process.chdir(back); }
  });
});

describe("lane.stop", () => {
  it("closes the lane's window with mode kill; a name it doesn't have is no_pane", async () => {
    t.tmux("new-session", "-d", "-s", "main", "-n", "base", "sleep 600");
    t.tmux("new-window", "-d", "-t", "=main:", "-n", "done lane", "sleep 600");
    expect(await h.call("lane.stop", { name: "done lane", mode: "kill" }, { key: "hub:st1" })).toMatchObject({ ok: true, result: { ok: true } });
    expect(t.tmux("list-windows", "-t", "=main", "-F", "#{window_name}").trim()).toBe("base");
    expect(await h.call("lane.stop", { name: "done lane", mode: "kill" }, { key: "hub:st2" })).toMatchObject({ ok: false, error: { code: "no_pane", executed: "no" } });
  });
});

describe("worktrees", () => {
  function repo(path: string) {
    mkdirSync(path, { recursive: true });
    const git = (...a: string[]) => execFileSync("git", ["-C", path, "-c", "user.name=test", "-c", "user.email=test@example.invalid", ...a], { stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "init");
    return path;
  }
  it("lists and adds worktrees of a repository under repoRoots, beside it; a branch name may hold slashes", async () => {
    const app = repo(join(home.home, "code", "app"));
    expect(await h.call("worktree.list", { repo: app })).toMatchObject({ ok: true, result: { worktrees: [{ path: app, branch: "main" }] } });
    const r = await h.call("worktree.add", { repo: app, name: "feat-x", base: "main" }, { key: "hub:wt1" });
    expect(r).toMatchObject({ ok: true, result: { path: join(home.home, "code", "app-worktrees", "feat-x") } });
    expect(existsSync(join(home.home, "code", "app-worktrees", "feat-x", ".git"))).toBe(true);
    expect(await h.call("worktree.add", { repo: app, name: "fix/login", base: "main" }, { key: "hub:wt1b" }))
      .toMatchObject({ ok: true, result: { path: join(home.home, "code", "app-worktrees", "fix", "login") } });
    const list = await h.call("worktree.list", { repo: app });
    expect(list.ok && (list.result as { worktrees: { branch: string | null }[] }).worktrees.map(w => w.branch)).toEqual(["main", "feat-x", "fix/login"]);
    expect(await h.call("worktree.add", { repo: app, name: "feat-x", base: "main" }, { key: "hub:wt2" })).toMatchObject({ ok: false, error: { code: "name_taken" } });
    expect(await h.call("worktree.add", { repo: app, name: "feat-y", base: "no-such-branch" }, { key: "hub:wt3" })).toMatchObject({ ok: false, error: { code: "bad_args" } });
  });
  it("refuses repositories outside repoRoots, a new worktree that would land outside them, and names that could be options or paths", async () => {
    const outside = repo(join(home.home, "elsewhere", "app"));
    expect(await h.call("worktree.list", { repo: outside })).toMatchObject({ ok: false, error: { code: "denied" } });
    const app = repo(join(home.home, "code", "app2"));
    // Each is refused by OP_ARGS' branch rules, as the fleet refuses it; git agrees (branchNameOk, below).
    for (const name of ["-b", "../escape", ".hidden", "a//b", "a/", "x/.y", "a.lock", "HEAD"]) {
      expect(await h.call("worktree.add", { repo: app, name, base: "main" }, { key: "hub:wt4" }), name).toMatchObject({ ok: false, error: { code: "bad_args", executed: "no" } });
    }
    expect(execFileSync("git", ["-C", app, "branch", "--list"], { encoding: "utf8" }).trim()).toBe("* main");   // nothing was made
    // The node's own last word, behind OP_ARGS: git itself (git check-ref-format --branch).
    for (const name of ["HEAD", "-b", "a..b", "a.lock", ""]) expect(await branchNameOk(name), name).toBe(false);
    for (const name of ["feat-x", "fix/login", "a.b/c_d"]) expect(await branchNameOk(name), name).toBe(true);
    // A root that is itself the repository: listed, but a worktree beside it would be outside every root.
    const rooted = opsHarness({ home: home.home, socket: t.socket, policy: { repoRoots: [app] } });
    try {
      expect(await rooted.call("worktree.list", { repo: app })).toMatchObject({ ok: true, result: { worktrees: [{ path: app }] } });
      expect(await rooted.call("worktree.add", { repo: app, name: "feat-z", base: "main" }, { key: "hub:wt5" })).toMatchObject({ ok: false, error: { code: "denied" } });
    } finally {
      rooted.close();
    }
  });
  it("refuses a repository kept under a deny root, and a worktree that would land in one, even when repoRoots covers it", async () => {
    const kube = repo(join(home.home, ".kube"));
    writeFileSync(join(kube, "config"), "token: KUBE-PLAINTEXT-TOKEN\n");
    const wide = opsHarness({ home: home.home, socket: t.socket, policy: { repoRoots: [home.home] } });
    try {
      expect(await wide.call("worktree.list", { repo: kube })).toMatchObject({ ok: false, error: { code: "denied", executed: "no" } });
      expect(await wide.call("worktree.add", { repo: kube, name: "y", base: "main" }, { key: "hub:wt-deny" })).toMatchObject({ ok: false, error: { code: "denied", executed: "no" } });
      expect(existsSync(`${kube}-worktrees`)).toBe(false);
      expect(execFileSync("git", ["-C", kube, "branch", "--list"], { encoding: "utf8" }).trim()).toBe("* main");
      const app = repo(join(home.home, "code", "app3"));
      expect(await wide.call("worktree.add", { repo: app, name: "ok-x", base: "main" }, { key: "hub:wt-ok" })).toMatchObject({ ok: true });   // control
    } finally { wide.close(); }
  });
});
