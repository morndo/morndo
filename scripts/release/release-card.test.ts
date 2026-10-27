// scripts/release/release-card.sh prints the release card: what changed, between two commits, in the paths that reach
// the signing keys or what a machine installs (.github/workflows/, .github/CODEOWNERS, scripts/release/, trust/,
// install.sh, apps/updater/). The owner reads it before the tap that lets a release run use a key (release plan,
// decision 9). These tests build a small git repository per case and read what the card says about it.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("./release-card.sh", import.meta.url));
const env: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.test",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.test",
};
const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "release-card-"));
  roots.push(dir);
  git(dir, "init", "-q", "-b", "main");
  return dir;
}

function put(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

function commit(dir: string, subject: string, files: Record<string, string | null>): string {
  for (const [path, text] of Object.entries(files)) {
    if (text === null) git(dir, "rm", "-q", path);
    else { put(dir, path, text); git(dir, "add", path); }
  }
  git(dir, "commit", "-q", "--allow-empty", "-m", subject);
  return git(dir, "rev-parse", "HEAD");
}

function scratch(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
}

/** A stand-in for check-release-settings.sh: prints its lines on stdout, its arguments on stderr, exits with `code`. */
function fakeCheck(code: number, lines: string[]): string {
  const p = join(scratch("release-card-check-"), "check.sh");
  writeFileSync(p, [...lines.map(l => `printf '%s\\n' '${l.replaceAll("'", "'\\''")}'`), 'printf \'args: %s\\n\' "$*" >&2', `exit ${code}`, ""].join("\n"));
  return p;
}
const CHECK_OK = [
  "WARN: main's code-owner review can be bypassed by RepositoryRole:5:pull_request (accepted with --allow-main-bypass)",
  "check-release-settings: ok (acme/widgets: the settings hold)",
];
const SETTINGS_ARGS = ["--", "--reviewer-id", "1", "--app-id", "7"];

/** sh release-card.sh <args> in `cwd`, with extra environment. */
function run(cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}, sh = "sh") {
  const r = spawnSync(sh, [SCRIPT, ...args], { cwd, env: { ...env, ...extra }, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** The card as the run book runs it: the two commits, then the settings check's arguments (a passing stand-in). */
function card(dir: string, ...args: string[]) {
  return run(dir, [...args, ...SETTINGS_ARGS], { RELEASE_CARD_SETTINGS_CHECK: fakeCheck(0, CHECK_OK) });
}

/** A bin directory whose git logs each call to `marker` and runs the real git, or fails on one subcommand. */
function wrappedGit(opts: { marker?: string; failOn?: string }): string {
  const bin = scratch("release-card-bin-");
  writeFileSync(join(bin, "git"), [
    "#!/bin/sh",
    opts.marker ? `printf '%s\\n' "$1" >> '${opts.marker}'` : ":",
    opts.failOn ? `[ "$1" = '${opts.failOn}' ] && { echo "fatal: simulated failure" >&2; exit 128; }` : ":",
    'exec /usr/bin/git "$@"',
    "",
  ].join("\n"));
  chmodSync(join(bin, "git"), 0o755);
  return bin;
}

const short = (sha: string) => sha.slice(0, 8);

describe("release-card.sh", () => {
  it("says nothing changed when only other paths changed, and lists none of them", () => {
    const dir = repo();
    const base = commit(dir, "chore: base", { "README.md": "a\n", "install.sh": "echo a\n" });
    const head = commit(dir, "docs: readme", { "README.md": "b\n", "apps/hub/src/main.ts": "x\n" });
    const r = card(dir, base, head);
    expect(r.code).toBe(0);
    expect(r.out.split("\n")[0]).toBe(`release card: ${short(base)}..${short(head)}`);
    expect(r.out).toContain(`release card: no change in the release-critical paths since ${short(base)}\n`);
    expect(r.out).not.toContain("README.md");
    expect(r.out).not.toContain("apps/hub");
    expect(r.out).not.toContain("files:");
    expect(r.out.split("\n")[1]).toBe("paths: .github/workflows/ .github/CODEOWNERS scripts/release/ trust/ install.sh apps/updater/ package.json package-lock.json");
  });

  it("lists added, modified and deleted files sorted by path, and the commits that touched them", () => {
    const dir = repo();
    const base = commit(dir, "chore: base", { "trust/keys.json": "{}\n", "install.sh": "echo a\n", "README.md": "a\n" });
    const c1 = commit(dir, "feat(release): a new workflow", { ".github/workflows/feed.yml": "on: push\n" });
    commit(dir, "docs: readme only", { "README.md": "b\n" });
    const c3 = commit(dir, "fix(install): verify first", { "install.sh": "echo b\n", "trust/keys.json": null });
    const r = card(dir, base, c3);
    expect(r.code).toBe(0);
    expect(r.out).toContain([
      "files:",
      "  A .github/workflows/feed.yml",
      "  M install.sh",
      "  D trust/keys.json",
      "",
    ].join("\n"));
    expect(r.out).toContain([
      "commits:",
      `  ${short(c3)} fix(install): verify first`,
      `  ${short(c1)} feat(release): a new workflow`,
      "",
    ].join("\n"));
    expect(r.out).not.toContain("readme only");
    expect(r.out).toContain(`release card: 3 file(s) changed in the release-critical paths since ${short(base)}\n`);
    expect(r.out.split("\n")[1]).toBe("paths: .github/workflows/ .github/CODEOWNERS scripts/release/ trust/ install.sh apps/updater/ package.json package-lock.json");
  });

  it.each([
    ".github/workflows/release.yml",
    ".github/CODEOWNERS",
    "scripts/release/feed.ts",
    "trust/feed_allowed_signers",
    "install.sh",
    "apps/updater/src/cli.ts",
    "package.json",
    "package-lock.json",
  ])("watches %s", path => {
    const dir = repo();
    const base = commit(dir, "chore: base", { "README.md": "a\n" });
    const head = commit(dir, "chore: touch", { [path]: "x\n" });
    const r = card(dir, base, head);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`  A ${path}\n`);
  });

  it("does not take a path that only begins like a watched one", () => {
    const dir = repo();
    const base = commit(dir, "chore: base", { "README.md": "a\n" });
    const head = commit(dir, "chore: lookalikes", {
      "install.sh.bak": "x\n",
      "scripts/release-notes.md": "x\n",
      "apps/updater-old/a.ts": "x\n",
      "trust.md": "x\n",
      ".github/workflows-old/a.yml": "x\n",
      "apps/web/package.json": "x\n",
      "package.json.orig": "x\n",
    });
    const r = card(dir, base, head);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`release card: no change in the release-critical paths since ${short(base)}\n`);
  });

  it("shows a rename as the old path deleted and the new one added", () => {
    const dir = repo();
    const base = commit(dir, "chore: base", { "scripts/release/old.sh": "echo same\n" });
    git(dir, "mv", "scripts/release/old.sh", "scripts/release/new.sh");
    const head = commit(dir, "refactor: rename", {});
    const r = card(dir, base, head);
    expect(r.out).toContain("  A scripts/release/new.sh\n  D scripts/release/old.sh\n");
  });

  it("removes control characters from a commit subject", () => {
    const dir = repo();
    const base = commit(dir, "chore: base", { "README.md": "a\n" });
    const head = commit(dir, "fix: \u001b[31mred\u001b[0m bell\u0007", { "install.sh": "x\n" });
    const r = card(dir, base, head);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`  ${short(head)} fix: [31mred[0m bell\n`);
    const control: number[] = [];
    for (let i = 0; i < r.out.length; i++) {
      const c = r.out.charCodeAt(i);
      if (c !== 0x0a && (c < 0x20 || c === 0x7f)) control.push(c);
    }
    expect(control).toEqual([]);
  });

  it("lists the commits a merge brought in, not the merge itself", () => {
    const dir = repo();
    const base = commit(dir, "chore: base", { "README.md": "a\n" });
    git(dir, "checkout", "-q", "-b", "feature");
    const work = commit(dir, "feat(release): a new step", { "scripts/release/step.sh": "x\n" });
    git(dir, "checkout", "-q", "main");
    commit(dir, "docs: readme on main", { "README.md": "b\n" });
    git(dir, "merge", "-q", "--no-ff", "-m", "Merge pull request #1 from feature", "feature");
    const head = git(dir, "rev-parse", "HEAD");
    const r = card(dir, base, head);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`commits:\n  ${short(work)} feat(release): a new step\nsettings:`);
    expect(r.out).not.toContain("Merge pull request");
  });

  it("lists a merge that itself changes a watched path", () => {
    const dir = repo();
    const base = commit(dir, "chore: base", { "README.md": "a\n", "install.sh": "a\n" });
    git(dir, "checkout", "-q", "-b", "feature");
    commit(dir, "docs: readme", { "README.md": "b\n" });
    git(dir, "checkout", "-q", "main");
    git(dir, "merge", "-q", "--no-ff", "--no-commit", "feature");
    put(dir, "install.sh", "edited in the merge\n");
    git(dir, "add", "install.sh");
    git(dir, "commit", "-q", "-m", "Merge pull request #2 from feature");
    const head = git(dir, "rev-parse", "HEAD");
    const r = card(dir, base, head);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`commits:\n  ${short(head)} Merge pull request #2 from feature\n`);
    expect(r.out).toContain("  M install.sh\n");
  });

  it("reads the paths from the top of the repository when run from a subdirectory", () => {
    const dir = repo();
    const base = commit(dir, "chore: base", { "README.md": "a\n", "scripts/notes.md": "a\n" });
    const head = commit(dir, "fix(install): verify first", { "install.sh": "x\n" });
    const r = run(join(dir, "scripts"), [base, head, ...SETTINGS_ARGS], { RELEASE_CARD_SETTINGS_CHECK: fakeCheck(0, CHECK_OK) });
    expect(r.code).toBe(0);
    expect(r.out).toContain("  A install.sh\n");
  });

  it("carries the settings check's output, the command it ran, and passes when the check passes", () => {
    const dir = repo();
    const base = commit(dir, "chore: base", { "README.md": "a\n" });
    const head = commit(dir, "fix(install): verify first", { "install.sh": "x\n" });
    const check = fakeCheck(0, CHECK_OK);
    const r = run(dir, [base, head, ...SETTINGS_ARGS], { RELEASE_CARD_SETTINGS_CHECK: check });
    expect(r.code).toBe(0);
    expect(r.out).toContain([
      `settings: sh ${check} --reviewer-id 1 --app-id 7`,
      `  ${CHECK_OK[0]}`,
      `  ${CHECK_OK[1]}`,
      "  args: --reviewer-id 1 --app-id 7",
      "",
    ].join("\n"));
    expect(r.out.trimEnd().split("\n").at(-1)).toBe("release card: settings check ok");
  });

  it("removes control characters from the settings check's output", () => {
    const dir = repo();
    const base = commit(dir, "chore: base", { "README.md": "a\n" });
    const head = commit(dir, "chore: touch", { "install.sh": "x\n" });
    const r = run(dir, [base, head, ...SETTINGS_ARGS], { RELEASE_CARD_SETTINGS_CHECK: fakeCheck(0, ["check-release-settings: \u001b[31mok\u001b[0m\u0007"]) });
    expect(r.code).toBe(0);
    expect(r.out).toContain("  check-release-settings: [31mok[0m\n");
    const control: number[] = [];
    for (let i = 0; i < r.out.length; i++) {
      const c = r.out.charCodeAt(i);
      if (c !== 0x0a && (c < 0x20 || c === 0x7f)) control.push(c);
    }
    expect(control).toEqual([]);
  });

  it("runs the check-release-settings.sh beside it when no other is named", () => {
    const dir = repo();
    const base = commit(dir, "chore: base", { "README.md": "a\n" });
    const head = commit(dir, "chore: touch", { "install.sh": "x\n" });
    const bin = scratch("release-card-gh-");
    writeFileSync(join(bin, "gh"), "#!/bin/sh\necho 'gh: offline in this test' >&2\nexit 1\n");
    chmodSync(join(bin, "gh"), 0o755);
    const r = run(dir, [base, head, ...SETTINGS_ARGS], { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` });
    expect(r.out).toContain(`settings: sh ${join(dirname(SCRIPT), "check-release-settings.sh")} --reviewer-id 1 --app-id 7\n`);
  });

  it("fails loudly when the settings check fails, with its lines on the card", () => {
    const dir = repo();
    const base = commit(dir, "chore: base", { "README.md": "a\n" });
    const head = commit(dir, "chore: touch", { "install.sh": "x\n" });
    const failing = ["FAIL: environment feed lets repository administrators bypass its protection rules (can_admins_bypass is true); turn it off", "check-release-settings: 1 problem(s)"];
    const r = run(dir, [base, head, ...SETTINGS_ARGS], { RELEASE_CARD_SETTINGS_CHECK: fakeCheck(1, failing) });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`  ${failing[0]}\n  ${failing[1]}\n`);
    expect(r.out).toContain("  A install.sh\n");
    expect(r.out.trimEnd().split("\n").at(-1)).toBe("release card: SETTINGS CHECK FAILED (exit 1): do not tap");
  });

  it("says loudly that the settings check did not run without its arguments", () => {
    const dir = repo();
    const base = commit(dir, "chore: base", { "README.md": "a\n" });
    const head = commit(dir, "chore: touch", { "install.sh": "x\n" });
    const r = run(dir, [base, head], { RELEASE_CARD_SETTINGS_CHECK: fakeCheck(0, CHECK_OK) });
    expect(r.code).toBe(3);
    expect(r.out).toContain("  A install.sh\n");
    expect(r.out).not.toContain("check-release-settings: ok");
    expect(r.out.trimEnd().split("\n").at(-1)).toBe(
      "release card: SETTINGS CHECK NOT RUN: no settings arguments (release-card.sh <base> <head> -- --reviewer-id <id> --app-id <id> [...]); this card is incomplete");
  });

  it("says loudly that the settings check did not run when nothing names it and no arguments are given", () => {
    const dir = repo();
    const base = commit(dir, "chore: base", { "README.md": "a\n" });
    const head = commit(dir, "chore: touch", { "install.sh": "x\n" });
    const plain: NodeJS.ProcessEnv = { ...env };
    delete plain.RELEASE_CARD_SETTINGS_CHECK;
    const r = spawnSync("sh", [SCRIPT, base, head], { cwd: dir, env: plain, encoding: "utf8" });
    expect(r.status).toBe(3);
    expect(r.stdout).toContain("settings: not run\n");
    expect(r.stdout.trimEnd().split("\n").at(-1)).toBe(
      "release card: SETTINGS CHECK NOT RUN: no settings arguments (release-card.sh <base> <head> -- --reviewer-id <id> --app-id <id> [...]); this card is incomplete");
  });

  it.each<[string, () => string, string]>([
    ["is not there", () => "/nonexistent/check-release-settings.sh", "/nonexistent/check-release-settings.sh is not there"],
    ["refuses its arguments", () => fakeCheck(2, ["check-release-settings: usage: ..."]), "it exited 2"],
  ])("says loudly that the settings check did not run when it %s", (_what, check, reason) => {
    const dir = repo();
    const base = commit(dir, "chore: base", { "README.md": "a\n" });
    const head = commit(dir, "chore: touch", { "install.sh": "x\n" });
    const r = run(dir, [base, head, ...SETTINGS_ARGS], { RELEASE_CARD_SETTINGS_CHECK: check() });
    expect(r.code).toBe(3);
    expect(r.out.trimEnd().split("\n").at(-1)).toBe(`release card: SETTINGS CHECK NOT RUN: ${reason}; this card is incomplete`);
  });

  it.each(["log", "diff"])("fails when git %s fails, and prints no card", sub => {
    const dir = repo();
    const base = commit(dir, "chore: base", { "README.md": "a\n" });
    const head = commit(dir, "chore: touch", { "install.sh": "x\n" });
    const bin = wrappedGit({ failOn: sub });
    const r = run(dir, [base, head, ...SETTINGS_ARGS], { PATH: `${bin}:/usr/bin:/bin`, RELEASE_CARD_SETTINGS_CHECK: fakeCheck(0, CHECK_OK) });
    expect(r.code).toBe(1);
    expect(r.err).toContain(`release-card: git ${sub} failed`);
    expect(r.out).toBe("");
  });

  it("uses the git on the caller's PATH", () => {
    const dir = repo();
    const base = commit(dir, "chore: base", { "README.md": "a\n" });
    const head = commit(dir, "chore: touch", { "install.sh": "x\n" });
    const marker = join(scratch("release-card-marker-"), "calls");
    const bin = wrappedGit({ marker });
    const r = run(dir, [base, head, ...SETTINGS_ARGS], { PATH: `${bin}:/usr/bin:/bin`, RELEASE_CARD_SETTINGS_CHECK: fakeCheck(0, CHECK_OK) });
    expect(r.code).toBe(0);
    expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").toContain("log\n");
  });

  it("says so when no git is on PATH", () => {
    const dir = repo();
    const base = commit(dir, "chore: base", { "README.md": "a\n" });
    const head = commit(dir, "chore: touch", { "install.sh": "x\n" });
    const bin = scratch("release-card-nogit-bin-");
    for (const name of readdirSync("/usr/bin")) if (!name.startsWith("git")) symlinkSync(join("/usr/bin", name), join(bin, name));
    const r = run(dir, [base, head, ...SETTINGS_ARGS], { PATH: bin, RELEASE_CARD_SETTINGS_CHECK: fakeCheck(0, CHECK_OK) }, "/bin/sh");
    expect(r.code).toBe(1);
    expect(r.err).toContain("release-card: git is not on PATH");
  });

  it("takes tags as base and head, and names the commits they point at", () => {
    const dir = repo();
    const c1 = commit(dir, "chore: base", { "README.md": "a\n" });
    git(dir, "tag", "v0.1.0");
    const c2 = commit(dir, "fix(install): one", { "install.sh": "1\n" });
    git(dir, "tag", "-a", "-m", "release 0.1.1", "v0.1.1");
    const c3 = commit(dir, "fix(release): two", { "scripts/release/a.sh": "2\n" });
    git(dir, "tag", "-a", "-m", "release 0.1.2", "v0.1.2");
    const r = card(dir, "v0.1.0", "v0.1.2");
    expect(r.code).toBe(0);
    expect(r.out.split("\n")[0]).toBe(`release card: ${short(c1)}..${short(c3)}`);
    expect(r.out).toContain(`commits:\n  ${short(c3)} fix(release): two\n  ${short(c2)} fix(install): one\n`);
    expect(r.out).toContain("release card: 2 file(s) changed in the release-critical paths since " + short(c1));
    const one = card(dir, "v0.1.1", "v0.1.2");
    expect(one.out.split("\n")[0]).toBe(`release card: ${short(c2)}..${short(c3)}`);
    expect(one.out).not.toContain("  A install.sh");
    expect(one.out).not.toContain("fix(install): one");
    const back = card(dir, "v0.1.2", "v0.1.0");
    expect(back.code).toBe(1);
    expect(back.err).toContain(`release-card: ${short(c3)} is not an ancestor of ${short(c1)}`);
  });

  it("refuses a base that is not an ancestor of the head", () => {
    const dir = repo();
    const root = commit(dir, "chore: root", { "README.md": "a\n" });
    const a = commit(dir, "chore: a", { "install.sh": "a\n" });
    git(dir, "checkout", "-q", "-b", "side", root);
    const b = commit(dir, "chore: b", { "install.sh": "b\n" });
    const r = card(dir, a, b);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`release-card: ${short(a)} is not an ancestor of ${short(b)}`);
    expect(r.out).toBe("");
  });

  it("refuses a commit that does not resolve", () => {
    const dir = repo();
    const base = commit(dir, "chore: base", { "README.md": "a\n" });
    const r = card(dir, base, "no-such-ref");
    expect(r.code).toBe(1);
    expect(r.err).toContain("release-card: no-such-ref does not resolve to a commit");
  });

  it("is a usage error without exactly two commits", () => {
    const dir = repo();
    const base = commit(dir, "chore: base", { "README.md": "a\n" });
    for (const args of [[], [base], [base, base, base], ["", base]]) {
      const r = card(dir, ...args);
      expect(r.code).toBe(64);
      expect(r.err).toContain("release-card: usage: release-card.sh <base> <head>");
    }
  });

  it("refuses to run outside a git repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "release-card-nogit-"));
    roots.push(dir);
    const r = card(dir, "a", "b");
    expect(r.code).toBe(1);
    expect(r.err).toContain("release-card: not inside a git repository");
  });
});
