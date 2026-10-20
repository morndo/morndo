// memory.sync on a node (ADR-0031; docs/design/memory/README.md, "The node's memory.sync"), driven through the executor as
// the fleet would drive it, on a temporary HOME: parts staged until the last one arrives, the skills written into the
// managed folder and every skill directory with the node's marker, Memory's own folders that a version no longer has
// removed, and everything that is not the node's (a folder without the marker, a symbolic link) left as it is. The policy
// side: memory.skillDirs, its "~/" and its refusals, and a policy that leaves memory.sync out. No tmux is started.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ALL_OPS, ConfigError, DEFAULT_POLICY, loadPolicy, parsePolicy, type Policy } from "../src/config.ts";
import { MEMORY_MARKER } from "../src/ops/memory-ops.ts";
import { tempHome } from "./helpers.ts";
import { opsHarness, type Harness } from "./ops-harness.ts";

const V1 = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";
const V2 = "f9e8d7c6b5a4938271605f4e3d2c1b0a";
const V3 = "1234567890abcdef1234567890abcdef";
const FACTS = "morndo-mem-repo-shop-api-facts";
const DEPLOY = "morndo-mem-repo-shop-api-deploy-n-3";
const LOGIN = "morndo-mem-repo-shop-api-login-n-7";
const skill = (name: string, text = `What the lanes learned (${name}).`) =>
  ({ name, content: `---\nname: ${name}\ndescription: "${text}"\n---\n\n${text}\n` });
const part = (version: string, n: number, parts: number, files: { name: string; content: string }[]) => ({ version, part: n, parts, files });

const open: { h: Harness; cleanup: () => void }[] = [];
afterEach(() => { for (const o of open.splice(0)) { o.h.close(); o.cleanup(); } });

function node(policy: Partial<Policy> = {}) {
  const t = tempHome();
  const h = opsHarness({ home: t.home, socket: "morndo-memory-test", policy });
  open.push({ h, cleanup: t.cleanup });
  const sync = (args: unknown, key = `hub:memory:${(args as { version: string }).version}:${(args as { part: number }).part}`) => h.call("memory.sync", args, { key });
  return { h, home: t.home, sync, claude: join(t.home, ".claude", "skills"), agents: join(t.home, ".agents", "skills"), managed: join(h.paths.memoryDir, "skills") };
}
const text = (dir: string, name: string, file = "SKILL.md") => readFileSync(join(dir, name, file), "utf8");
const okResult = (r: { ok: boolean; result?: unknown; error?: { message: string } }) => {
  if (!r.ok) throw new Error(r.error?.message);
  return r.result as { committed: boolean; written: number; removed: number; skillDirs: string[]; conflicts: string[] };
};

describe("memory.sync: staging and committing", () => {
  it("commits a version of one part: each skill in the managed folder and in both default skill directories, marked with the version", async () => {
    const n = node();
    expect(existsSync(n.claude) || existsSync(n.agents)).toBe(false);
    const r = okResult(await n.sync(part(V1, 0, 1, [skill(FACTS), skill(DEPLOY)])));
    expect(r).toEqual({ committed: true, written: 4, removed: 0, skillDirs: [n.claude, n.agents], conflicts: [] });
    for (const dir of [n.managed, n.claude, n.agents]) {
      for (const name of [FACTS, DEPLOY]) {
        expect(text(dir, name)).toBe(skill(name).content);
        expect(text(dir, name, MEMORY_MARKER)).toBe(V1);
      }
      expect(readdirSync(dir).sort()).toEqual([DEPLOY, FACTS]);
    }
    expect(readdirSync(join(n.h.paths.memoryDir, "staging"))).toEqual([V1]);
  });

  it("commits a version of two parts only when the second arrives, whichever comes first", async () => {
    const n = node();
    const first = okResult(await n.sync(part(V1, 0, 2, [skill(FACTS)])));
    expect(first).toEqual({ committed: false, written: 0, removed: 0, skillDirs: [n.claude, n.agents], conflicts: [] });
    expect(existsSync(join(n.claude, FACTS)) || existsSync(join(n.managed, FACTS))).toBe(false);
    expect(readdirSync(join(n.h.paths.memoryDir, "staging", V1))).toEqual(["part-0.json"]);
    const second = okResult(await n.sync(part(V1, 1, 2, [skill(DEPLOY)])));
    expect(second).toMatchObject({ committed: true, written: 4, removed: 0, conflicts: [] });
    for (const dir of [n.managed, n.claude, n.agents]) expect(readdirSync(dir).sort()).toEqual([DEPLOY, FACTS]);

    const m = node();
    expect(okResult(await m.sync(part(V1, 1, 2, [skill(DEPLOY)])))).toMatchObject({ committed: false });
    expect(existsSync(m.claude)).toBe(false);
    expect(okResult(await m.sync(part(V1, 0, 2, [skill(FACTS)])))).toMatchObject({ committed: true, written: 4 });
  });

  it("is idempotent: a repeat under the same key answers the stored outcome, a new key commits the same version again and writes nothing", async () => {
    const n = node();
    const args = part(V1, 0, 1, [skill(FACTS), skill(DEPLOY)]);
    const first = okResult(await n.sync(args));
    const mtime = statSync(join(n.claude, FACTS, "SKILL.md")).mtimeMs;
    expect(okResult(await n.sync(args))).toEqual(first);
    expect(okResult(await n.sync(args, "hub:memory:again"))).toEqual({ committed: true, written: 0, removed: 0, skillDirs: [n.claude, n.agents], conflicts: [] });
    expect(statSync(join(n.claude, FACTS, "SKILL.md")).mtimeMs).toBe(mtime);
    for (const dir of [n.managed, n.claude, n.agents]) expect(readdirSync(dir).sort()).toEqual([DEPLOY, FACTS]);
  });

  it("rewrites a changed skill and the marker of every kept one, and removes the marked folders the new version no longer has", async () => {
    const n = node();
    okResult(await n.sync(part(V1, 0, 1, [skill(FACTS), skill(DEPLOY), skill(LOGIN)])));
    // A stale folder of the node's holding a link out: removed, and the link's target kept.
    const outside = join(n.home, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "not Memory's");
    symlinkSync(outside, join(n.claude, LOGIN, "link"));
    const r = okResult(await n.sync(part(V2, 0, 1, [skill(FACTS, "Changed.")])));
    expect(r).toEqual({ committed: true, written: 2, removed: 4, skillDirs: [n.claude, n.agents], conflicts: [] });
    for (const dir of [n.managed, n.claude, n.agents]) {
      expect(readdirSync(dir)).toEqual([FACTS]);
      expect(text(dir, FACTS)).toBe(skill(FACTS, "Changed.").content);
      expect(text(dir, FACTS, MEMORY_MARKER)).toBe(V2);
    }
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("not Memory's");
    // Only the committed version's staging is kept.
    expect(readdirSync(join(n.h.paths.memoryDir, "staging"))).toEqual([V2]);
  });

  it("leaves a morndo-mem-* folder without the marker, even one the version no longer has", async () => {
    const n = node();
    const theirs = join(n.claude, "morndo-mem-handwritten");
    mkdirSync(theirs, { recursive: true });
    writeFileSync(join(theirs, "SKILL.md"), "the owner's own");
    okResult(await n.sync(part(V1, 0, 1, [skill(FACTS)])));
    const r = okResult(await n.sync(part(V2, 0, 1, [skill(DEPLOY)])));
    expect(r).toMatchObject({ committed: true, removed: 2, conflicts: [] });
    expect(readFileSync(join(theirs, "SKILL.md"), "utf8")).toBe("the owner's own");
    expect(readdirSync(n.claude).sort()).toEqual(["morndo-mem-handwritten", DEPLOY]);
  });

  it("keeps a version still missing parts until its done keys may be gone, and drops an older one", async () => {
    const n = node();
    const staging = join(n.h.paths.memoryDir, "staging");
    okResult(await n.sync(part(V2, 0, 2, [skill(LOGIN)])));
    okResult(await n.sync(part(V3, 0, 2, [skill(LOGIN)])));
    const old = (Date.now() - 9 * 86_400_000) / 1000;
    utimesSync(join(staging, V3), old, old);
    okResult(await n.sync(part(V1, 0, 1, [skill(FACTS)])));
    expect(readdirSync(staging).sort()).toEqual([V1, V2].sort());
    // The partial version's last part still commits it: its first part was kept.
    expect(okResult(await n.sync(part(V2, 1, 2, [skill(DEPLOY)])))).toMatchObject({ committed: true });
    expect(readdirSync(n.claude).sort()).toEqual([DEPLOY, LOGIN]);
    expect(readdirSync(staging)).toEqual([V2]);
  });
});

describe("memory.sync: what is not the node's", () => {
  it("leaves a same-named folder without the marker untouched and reports it; takes an empty one", async () => {
    const n = node();
    const theirs = join(n.claude, FACTS);
    mkdirSync(theirs, { recursive: true });
    writeFileSync(join(theirs, "SKILL.md"), "the owner's own");
    mkdirSync(join(n.agents, DEPLOY), { recursive: true });
    const r = okResult(await n.sync(part(V1, 0, 1, [skill(FACTS), skill(DEPLOY)])));
    expect(r).toEqual({ committed: true, written: 3, removed: 0, skillDirs: [n.claude, n.agents], conflicts: [theirs] });
    expect(readdirSync(theirs)).toEqual(["SKILL.md"]);
    expect(readFileSync(join(theirs, "SKILL.md"), "utf8")).toBe("the owner's own");
    expect(text(n.agents, FACTS)).toBe(skill(FACTS).content);
    expect(text(n.agents, DEPLOY, MEMORY_MARKER)).toBe(V1);
    // Still someone else's on the next version: never removed, still reported.
    expect(okResult(await n.sync(part(V2, 0, 1, [skill(FACTS)])))).toMatchObject({ removed: 2, conflicts: [theirs] });
    expect(readFileSync(join(theirs, "SKILL.md"), "utf8")).toBe("the owner's own");
  });

  it("refuses a symbolic link where a skill folder would be, and never removes through one, even to a marked folder", async () => {
    const n = node();
    const outside = join(n.home, "elsewhere");
    mkdirSync(outside);
    mkdirSync(n.claude, { recursive: true });
    symlinkSync(outside, join(n.claude, FACTS));
    // A link under a name the version doesn't have, to a folder that looks like the node's.
    const marked = join(n.home, "marked");
    mkdirSync(marked);
    writeFileSync(join(marked, MEMORY_MARKER), V1);
    writeFileSync(join(marked, "SKILL.md"), "kept");
    symlinkSync(marked, join(n.claude, LOGIN));
    const r = okResult(await n.sync(part(V1, 0, 1, [skill(FACTS)])));
    expect(r).toEqual({ committed: true, written: 1, removed: 0, skillDirs: [n.claude, n.agents], conflicts: [join(n.claude, FACTS)] });
    expect(lstatSync(join(n.claude, FACTS)).isSymbolicLink()).toBe(true);
    expect(readdirSync(outside)).toEqual([]);
    expect(lstatSync(join(n.claude, LOGIN)).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(marked, "SKILL.md"), "utf8")).toBe("kept");
    expect(text(n.agents, FACTS)).toBe(skill(FACTS).content);
  });

  it("replaces a link at a marked folder's SKILL.md instead of writing through it", async () => {
    const n = node();
    okResult(await n.sync(part(V1, 0, 1, [skill(FACTS)])));
    const target = join(n.home, "target.md");
    writeFileSync(target, "not Memory's");
    const file = join(n.claude, FACTS, "SKILL.md");
    rmSync(file);
    symlinkSync(target, file);
    expect(okResult(await n.sync(part(V2, 0, 1, [skill(FACTS, "New.")])))).toMatchObject({ committed: true, conflicts: [] });
    expect(lstatSync(file).isFile()).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(skill(FACTS, "New.").content);
    expect(readFileSync(target, "utf8")).toBe("not Memory's");
  });
});

describe("memory.sync: refusals", () => {
  it("refuses a name that is not one of Memory's skills, before anything is written (OP_ARGS, MEMORY_SKILL_NAME)", async () => {
    const n = node();
    for (const name of ["shop-api-facts", "morndo-mem-../x", "morndo-mem-x/y", "morndo-mem-Facts", "morndo-mem--x", "morndo-mem-x-", "morndo-mem-"]) {
      expect(await n.sync(part(V1, 0, 1, [skill(FACTS), { name, content: "x" }])), name).toMatchObject({ ok: false, error: { code: "bad_args", executed: "no" } });
    }
    expect(await n.sync(part(V1, 0, 1, [skill(FACTS), skill(FACTS)]))).toMatchObject({ ok: false, error: { code: "bad_args", executed: "no" } });
    expect(await n.sync(part(V1, 1, 1, [skill(FACTS)]))).toMatchObject({ ok: false, error: { code: "bad_args" } });
    expect(await n.sync(part("not-a-version", 0, 1, [skill(FACTS)]))).toMatchObject({ ok: false, error: { code: "bad_args" } });
    expect(existsSync(n.h.paths.memoryDir) || existsSync(n.claude) || existsSync(n.agents)).toBe(false);
  });

  it("refuses a part whose count of parts differs from the parts staged of its version, and one naming a skill another part has", async () => {
    const n = node();
    expect(okResult(await n.sync(part(V1, 0, 2, [skill(FACTS)])))).toMatchObject({ committed: false });
    expect(await n.sync(part(V1, 1, 3, [skill(DEPLOY)]))).toMatchObject({ ok: false, error: { code: "bad_args", executed: "no" } });
    expect(await n.sync(part(V1, 1, 2, [skill(FACTS)]), "hub:memory:dup")).toMatchObject({ ok: false, error: { code: "bad_args", executed: "no" } });
    expect(existsSync(n.claude)).toBe(false);
    expect(readdirSync(join(n.h.paths.memoryDir, "staging", V1))).toEqual(["part-0.json"]);
    // Refused with executed "no", so the same key may come again with the right count.
    expect(okResult(await n.sync(part(V1, 1, 2, [skill(DEPLOY)])))).toMatchObject({ committed: true, written: 4 });
  });

  it("is denied, nothing written, on a node whose policy leaves memory.sync out", async () => {
    const n = node({ ops: ALL_OPS.filter(op => op !== "memory.sync") });
    expect(await n.sync(part(V1, 0, 1, [skill(FACTS)]))).toMatchObject({ ok: false, error: { code: "denied", executed: "no" } });
    expect(existsSync(n.h.paths.memoryDir) || existsSync(n.claude) || existsSync(n.agents)).toBe(false);
    expect(n.h.doneKeys.status(`hub:memory:${V1}:0`)).toEqual({ state: "unknown" });
  });
});

describe("memory.sync: the policy's skill directories", () => {
  it("writes into custom directories, \"~/\" as the node user's home and a directory named twice once, and names each absolute", async () => {
    const t = tempHome("morndo-skills-");
    try {
      const n = node({ memory: { skillDirs: ["~/work/skills", t.home, "~/work/skills/", "~//srv/skills"] } });
      const work = join(n.home, "work", "skills");
      const r = okResult(await n.sync(part(V1, 0, 1, [skill(FACTS)])));
      expect(r).toEqual({ committed: true, written: 3, removed: 0, skillDirs: [work, t.home, join(n.home, "srv", "skills")], conflicts: [] });
      expect(text(work, FACTS)).toBe(skill(FACTS).content);
      expect(text(t.home, FACTS, MEMORY_MARKER)).toBe(V1);
      expect(existsSync(n.claude) || existsSync(n.agents)).toBe(false);
    } finally { t.cleanup(); }
  });

  it("names a skill directory that is a file as a conflict, and still writes the others", async () => {
    const n = node({ memory: { skillDirs: ["~/not-a-dir", "~/skills"] } });
    writeFileSync(join(n.home, "not-a-dir"), "a file");
    const r = okResult(await n.sync(part(V1, 0, 1, [skill(FACTS)])));
    expect(r).toEqual({ committed: true, written: 1, removed: 0, skillDirs: [join(n.home, "not-a-dir"), join(n.home, "skills")], conflicts: [join(n.home, "not-a-dir")] });
    expect(readFileSync(join(n.home, "not-a-dir"), "utf8")).toBe("a file");
  });

  it("defaults to the two engines' folders, keeps them when memory sets no skillDirs, and refuses an entry that could name another place", () => {
    expect(DEFAULT_POLICY.memory).toEqual({ skillDirs: ["~/.claude/skills", "~/.agents/skills"] });
    expect(parsePolicy({}, "policy.json").memory).toEqual(DEFAULT_POLICY.memory);
    expect(parsePolicy({ memory: {} }, "policy.json").memory).toEqual(DEFAULT_POLICY.memory);
    expect(parsePolicy({ memory: { skillDirs: [] } }, "policy.json").memory).toEqual({ skillDirs: [] });
    expect(parsePolicy({ memory: { skillDirs: ["/srv/skills", "~/skills", "/srv/skills"] } }, "policy.json").memory).toEqual({ skillDirs: ["/srv/skills", "~/skills"] });
    const nine = Array.from({ length: 9 }, (_, i) => `/srv/skills-${i}`);
    for (const [memory, message] of [
      [{ skillDirs: nine }, /memory\.skillDirs must be at most 8/],
      [{ skillDirs: ["skills"] }, /memory\.skillDirs/],
      [{ skillDirs: ["~"] }, /memory\.skillDirs/],
      [{ skillDirs: ["~/"] }, /memory\.skillDirs/],
      [{ skillDirs: ["~owner/skills"] }, /memory\.skillDirs/],
      [{ skillDirs: ["/srv/../etc"] }, /memory\.skillDirs/],
      [{ skillDirs: ["~/skills/.."] }, /memory\.skillDirs/],
      [{ skillDirs: ["/srv/a\0b"] }, /memory\.skillDirs/],
      [{ skillDirs: "~/skills" }, /memory\.skillDirs/],
      [{ skillDirs: [7] }, /memory\.skillDirs/],
      [{ dirs: [] }, /memory has an unknown field dirs/],
      [[], /memory must be an object/],
    ] as const) {
      expect(() => parsePolicy({ memory }, "policy.json"), JSON.stringify(memory)).toThrow(ConfigError);
      expect(() => parsePolicy({ memory }, "policy.json"), JSON.stringify(memory)).toThrow(message);
    }
    const h = tempHome();
    try {
      const p = join(h.home, "policy.json");
      writeFileSync(p, JSON.stringify({ memory: { skillDirs: ["~/skills"] } }));
      expect(loadPolicy(p).memory).toEqual({ skillDirs: ["~/skills"] });
    } finally { h.cleanup(); }
  });
});
