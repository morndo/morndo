// The Knowledge context's outer boundaries (ADR-0026), as walks over the repository: nothing outside the knowledge modules
// names them or their functions (K9), nothing outside knowledge-facts names the model snapshot (K13), no shipped file is a
// user's preferences.yaml (K12), each small rule has one copy, the domain's index exports the module, and docs/domain.md keeps
// the terms. Each matcher is proven by a planted line it must flag, so a passing walk means something; the walks are proven on a
// made-up repository to read what it ships and nothing else.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as domain from "../src/index.ts";
import * as guards from "../src/knowledge-guards.ts";

const ROOT = join(import.meta.dirname, "../../..");
// The one hook that reads the repository gets a minute of its own, so a loaded machine slows it without failing it; the
// tests then only match text already read.
const READ_TIMEOUT_MS = 60_000;

export type Walked = { path: string; text: string };
// git in root, without any GIT_* variable a hook may have set, so it works on root's own repository.
const git = (root: string, args: readonly string[]): string =>
  execFileSync("git", args, { cwd: root, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), encoding: "utf8", maxBuffer: 64 << 20 });
// The files root's repository would ship, by root-relative path: tracked, or new and not ignored, and on disk, sorted. One
// list from git, so a run reads the same files whatever else lies in the folder (.gitignore leaves out build output and the
// lanes' worktrees under .worktrees/).
export const shippedFiles = (root: string): string[] => {
  const listed = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  return [...new Set(listed.split("\0"))].filter(p => p !== "" && existsSync(join(root, p))).sort();
};
const SOURCE = /^(?:packages|apps)\/[^/]+\/src\/.+\.ts$/;
// Every .ts file under packages/*/src or apps/*/src that root ships, read at once.
export const packageSources = async (root: string): Promise<Walked[]> =>
  Promise.all(shippedFiles(root).filter(p => SOURCE.test(p)).map(async path => ({ path, text: await readFile(join(root, path), "utf8") })));
let sources: Walked[] = [];
beforeAll(async () => {
  sources = await packageSources(ROOT);
}, READ_TIMEOUT_MS);
// The files, other than the allowed ones, whose text holds any of the banned strings: their paths.
export const offenders = (files: readonly Walked[], banned: readonly string[], allowed: readonly string[]): string[] =>
  files.filter(f => !allowed.includes(f.path) && banned.some(b => f.text.includes(b))).map(f => f.path);

describe("knowledge never routes (K9)", () => {
  const banned = ["knowledge.ts", "knowledge-facts.ts", "knowledge-guards", "checkSop", "scorecardFor", "parsePreferences"];
  const allowed = ["packages/domain/src/knowledge.ts", "packages/domain/src/knowledge-facts.ts", "packages/domain/src/knowledge-guards.ts", "packages/domain/src/index.ts"];
  it("no other source under packages/*/src or apps/*/src names the knowledge modules or their functions", () => {
    // The walk read the knowledge modules themselves, so an empty list can't pass for a clean one.
    expect(allowed.filter(p => !sources.some(f => f.path === p))).toEqual([]);
    expect(offenders(sources, banned, allowed)).toEqual([]);
  });
  it("the same matcher flags a planted import", () => {
    const planted = [{ path: "apps/hub/src/adapters/planted.ts", text: 'import { scorecardFor } from "@morndo/domain";' }];
    expect(offenders(planted, banned, allowed)).toEqual(["apps/hub/src/adapters/planted.ts"]);
  });
});

describe("the snapshot never feeds a gate (K13)", () => {
  const banned = ["models.dev", "models-dev", "trimModelsDev", "readSnapshot"];
  // knowledge.ts names the citation form models.dev@<date>; it reads no snapshot.
  const allowed = ["packages/domain/src/knowledge-facts.ts", "packages/domain/src/knowledge.ts", "packages/domain/src/index.ts"];
  it("no source outside knowledge-facts names the snapshot's source or its reader", () => {
    expect(offenders(sources, banned, allowed)).toEqual([]);
  });
  it("the same matcher flags a planted read", () => {
    const planted = [{ path: "apps/hub/src/adapters/planted.ts", text: "const snapshot = readSnapshot(doc);" }];
    expect(offenders(planted, banned, allowed)).toEqual(["apps/hub/src/adapters/planted.ts"]);
  });
});

// Every preferences.yaml or .yml root ships, by its root-relative path.
export const preferencesFiles = (root: string): string[] => shippedFiles(root).filter(p => ["preferences.yaml", "preferences.yml"].includes(basename(p)));

describe("shipped knowledge holds no user's preferences (K12)", () => {
  it("no file in the repository is a preferences.yaml", () => {
    expect(preferencesFiles(ROOT)).toEqual([]);
  });
});

// A made-up repository: two sources git ships, one in a folder .gitignore leaves out, and a lane's worktree under
// .worktrees/ (ignored, as in this repository) holding a source and a preferences.yaml of its own.
describe("the walks read what the repository ships, the same files on every run", () => {
  const repo = mkdtempSync(join(tmpdir(), "knowledge-walk-"));
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  git(repo, ["init", "--quiet"]);
  put(".gitignore", ".worktrees/\nbuild/\n");
  put("packages/one/src/b.ts", "export const b = 1;\n");
  put("packages/one/src/a/z.ts", "export const z = 1;\n");
  put("packages/one/src/build/generated.ts", "export const generated = 1;\n");
  put(".worktrees/lane/packages/one/src/other.ts", "export const other = 1;\n");
  put(".worktrees/lane/preferences.yaml", "preferences: []\n");
  it("sources under packages/*/src and apps/*/src: what git would ship, sorted", async () => {
    expect((await packageSources(repo)).map(f => f.path)).toEqual(["packages/one/src/a/z.ts", "packages/one/src/b.ts"]);
  });
  it("a preferences file only where the repository would ship it, never in another lane's worktree", () => {
    expect(preferencesFiles(repo)).toEqual([]);
  });
});

describe("one copy of each small rule", () => {
  // Each of these, declared in the file: the copies review point 10 of PR 42 found.
  const declares = (path: string, names: readonly string[]) => {
    const src = readFileSync(join(ROOT, path), "utf8");
    return names.filter(n => new RegExp(`^(?:export )?(?:const|function) ${n}\\b`, "m").test(src));
  };
  it("the Knowledge modules take isRec, text, shown, the date rule and the preference id from one module", () => {
    expect(declares("packages/domain/src/knowledge.ts", ["isRec", "text", "shown", "PREF", "PREFERENCE_ID"])).toEqual([]);
    expect(declares("packages/domain/src/knowledge-facts.ts", ["isRec", "text", "shown", "PREF_ID", "PREFERENCE_ID", "isDate", "utcMs"])).toEqual([]);
  });
  it("the two commands take firstLine from one module", () => {
    expect([...declares("knowledge/tools/models-dev/cli.ts", ["firstLine"]), ...declares("knowledge/tools/sop-check/cli.ts", ["firstLine"])]).toEqual([]);
  });
});

describe("the domain's index", () => {
  it("exports the knowledge-facts module", () => {
    const exported = domain as unknown as Record<string, unknown>;
    expect([typeof exported.trimModelsDev, typeof exported.parsePreferences, typeof exported.scorecardFor]).toEqual(["function", "function", "function"]);
  });
  it("exports nothing of the shared guards, which stay internal to the Knowledge modules", () => {
    expect(Object.keys(guards).filter(k => k in domain)).toEqual([]);
  });
});

describe("the ubiquitous language", () => {
  it("docs/domain.md's Knowledge section names the preference rule and the snapshot's terms", () => {
    const section = readFileSync(join(ROOT, "docs/domain.md"), "utf8").split(/^## /m).find(s => s.startsWith("Knowledge")) ?? "";
    expect([section.includes("preference-in-template"), /^\| Model snapshot \|/m.test(section), /^\| Scorecard cell \|/m.test(section)]).toEqual([true, true, true]);
  });
});
