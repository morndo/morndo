// commit-traces admits exactly one bot besides dependabot[bot]: the release App that Release Please commits as
// (board T-411: its release PR failed `traces` with "names an assistant or a bot other than dependabot[bot]"). The
// identity is matched as a whole, name and address together, for the author, and for the committer when it is that bot
// too; any other bot, a lookalike of it, and every assistant name still fail. Real commits in a throwaway repo, the real
// script; made-up identities except the App's own, which is public.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CHECKER = join(import.meta.dirname, "commit-traces");
const BOT = { name: "morndo-release[bot]", mail: "345868531+morndo-release[bot]@users.noreply.github.com" };
const ADA = { name: "Ada", mail: "ada@users.noreply.github.com" };
const WEB = { name: "GitHub", mail: "noreply@github.com" };
type Who = { name: string; mail: string };

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "traces-"));
  git(["init", "-q"]);
  commit(ADA, ADA, "chore: base");
});
afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

function git(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...env } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
function commit(author: Who, committer: Who, message: string) {
  git(["commit", "-q", "--allow-empty", "-m", message], {
    GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.mail, GIT_COMMITTER_NAME: committer.name, GIT_COMMITTER_EMAIL: committer.mail,
  });
  return git(["rev-parse", "HEAD"]);
}
// The new commit alone, judged by range and by mails, as CI and the pre-push hook do.
function check(author: Who, committer: Who, message = "chore(main): release 0.1.0") {
  const base = git(["rev-parse", "HEAD"]);
  commit(author, committer, message);
  const run = (mode: "range" | "mails") => spawnSync("sh", [CHECKER, mode, `${base}..HEAD`], { cwd: repo, encoding: "utf8" });
  return { range: run("range"), mails: run("mails") };
}
const passes = (author: Who, committer: Who, message?: string) => {
  const r = check(author, committer, message);
  return [r.range.status, r.mails.status, r.range.stderr];
};
const refused = (author: Who, committer: Who, message?: string) => {
  const r = check(author, committer, message);
  expect(r.range.status, r.range.stderr).toBe(1);
  return r.range.stderr;
};

describe("commit-traces and the release App", () => {
  it("passes the release App as author with GitHub's web committer, exactly as #99's commit is", () => {
    expect(passes(BOT, WEB)).toEqual([0, 0, ""]);
  });

  it("passes the release App as both author and committer", () => {
    expect(passes(BOT, BOT)).toEqual([0, 0, ""]);
  });

  it("still passes dependabot[bot], and still refuses it nowhere it passed before", () => {
    expect(passes({ name: "dependabot[bot]", mail: "49699333+dependabot[bot]@users.noreply.github.com" }, WEB)).toEqual([0, 0, ""]);
  });

  it("refuses another bot, with the same shape of address", () => {
    expect(refused({ name: "review[bot]", mail: "11111111+review[bot]@users.noreply.github.com" }, WEB)).toContain("other than dependabot[bot]");
    expect(refused({ name: "renovate[bot]", mail: "29139614+renovate[bot]@users.noreply.github.com" }, WEB)).toContain("other than dependabot[bot]");
  });

  it("refuses lookalikes of the App: the name with another address, the address with another name, a suffix or prefix", () => {
    refused({ name: BOT.name, mail: "11111111+morndo-release[bot]@users.noreply.github.com" }, WEB);   // another id
    refused({ name: BOT.name, mail: ADA.mail }, WEB);
    refused({ name: "Ada", mail: BOT.mail }, WEB);
    // (a trailing space is not a lookalike: git trims it from the name it records, so it is the App's name)
    refused({ name: "x morndo-release[bot]", mail: BOT.mail }, WEB);
    refused({ name: "morndo-release[bot]", mail: `x${BOT.mail}` }, WEB);
    refused({ name: "Morndo-Release[bot]", mail: BOT.mail }, WEB);
    refused({ name: "morndo-release[bot]-two", mail: BOT.mail }, WEB);
  });

  it("refuses the App's identity as the committer when the author is not it, and any other bot as committer", () => {
    refused(ADA, BOT);
    refused(BOT, { name: "review[bot]", mail: "11111111+review[bot]@users.noreply.github.com" });
    refused(ADA, { name: "review[bot]", mail: "11111111+review[bot]@users.noreply.github.com" });
  });

  it("refuses every assistant name, as author or committer, even beside the App", () => {
    for (const name of ["Claude", "claude[bot]", "Anthropic", "Cursor Agent", "Codex", "Copilot", "copilot-swe-agent", "GPT", "Gemini", "GLM"]) {
      refused({ name, mail: ADA.mail }, WEB);
      refused(ADA, { name, mail: ADA.mail });
      refused(BOT, { name, mail: ADA.mail });
    }
  });

  it("still judges the App's message: an assistant trailer or a generated-with line fails", () => {
    refused(BOT, WEB, "chore(main): release 0.1.0\n\nCo-authored-by: Claude <a@example.invalid>");
    refused(BOT, WEB, "chore(main): release 0.1.0\n\nGenerated with Example");
    refused(BOT, WEB, "chore(main): release 0.1.0\n\nCo-authored-by: review[bot] <b@example.invalid>");
  });

  it("still refuses the App's identity with an address that is not a noreply address", () => {
    const r = check({ name: BOT.name, mail: "bot@example.invalid" }, WEB);
    expect(r.range.status).toBe(1);
    expect(r.mails.status).toBe(1);
  });

  it("judges the App's commit among others: a bad commit next to it is still named", () => {
    const base = git(["rev-parse", "HEAD"]);
    commit(BOT, WEB, "chore(main): release 0.1.0");
    const bad = commit({ name: "review[bot]", mail: "11111111+review[bot]@users.noreply.github.com" }, WEB, "fix: note");
    const r = spawnSync("sh", [CHECKER, "range", `${base}..HEAD`], { cwd: repo, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(bad);
  });
});
