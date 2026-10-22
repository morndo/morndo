// `morndo memory` at the console (ADR-0031, docs/design/memory/README.md "Console"): import an agent's own markdown
// notes as {kind: "import", label} (tier 3; facts unless named procedures, which wait for approve), deduplicated by
// title and scope; list, show and invalidate as the principal; approve with the one-time code a step-up session minted
// in the app (M8); sync now through the fleet. The command run in this process with a fake fleet, and once through the
// real main.ts. Temporary directories, synthetic notes.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FleetUnavailable } from "@morndo/fleet-client";
import { MEMORY_LIMITS, endpointId, sessionId } from "@morndo/domain";
import { MemoryStore } from "../src/adapters/memory-store.ts";
import { MemoryService } from "../src/application/memory-service.ts";
import type { Authenticated } from "../src/application/access-service.ts";
import type { MemoryFleet } from "../src/application/memory-sync.ts";
import { MEMORY_EXIT, memoryFile, readCodeLine, runMemory } from "../src/console/memory.ts";

const MAIN = join(import.meta.dirname, "../src/main.ts");
const MTIME = Date.UTC(2026, 8, 1, 9, 30);
let root: string;
let data: string;
let notes: string;
beforeEach(() => {
  asked = 0;
  root = mkdtempSync(join(tmpdir(), "morndo-memory-console-"));
  data = join(root, "data");
  notes = join(root, "agent-notes");
  mkdirSync(notes);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function md(name: string, text: string) {
  const path = join(notes, name);
  writeFileSync(path, text);
  utimesSync(path, MTIME / 1000, MTIME / 1000);
}
type Ran = { code: number; out: string; err: string };
// `stdin`: what the code prompt reads (a line typed or piped); absent, nothing is entered. `asked`: how often it was read.
let asked = 0;
async function run(args: string[], fleet?: MemoryFleet, stdin?: string): Promise<Ran> {
  let out = "", err = "";
  const io = {
    env: { HOME: root }, out: async (t: string) => { out += `${t}\n`; }, err: async (t: string) => { err += `${t}\n`; },
    readCode: async () => { asked++; return stdin ?? ""; },
  };
  const code = await runMemory(args, io, { dataDir: data, now: () => Date.UTC(2026, 9, 20, 12), ...(fleet ? { fleet } : {}) });
  return { code, out, err };
}
const withCode = (args: string[], stdin: string) => run(args, undefined, stdin);
function look<T>(fn: (m: MemoryService, s: MemoryStore) => T): T {
  const store = new MemoryStore(data);
  try { return fn(new MemoryService({ store }), store); } finally { store.close(); }
}
// The principal's signed-in Endpoint under step-up (the service here uses its default policy, so now is fresh enough),
// as the app that mints the console's one-time code would be (M8).
const auth = (): Authenticated => {
  const at = Date.now();
  return {
    session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: at, lastSeenAt: at, verifiedAt: at, endedAt: null, endReason: null },
    endpoint: { id: endpointId("ep1"), name: "Mac", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: at, revokedAt: null },
  };
};
// The one-time code the app minted for the note, as `morndo memory approve` reads it on stdin.
const codeFor = (id: string): string => {
  const r = look(m => m.issueApprovalCode(auth(), id));
  if (!r.ok) throw new Error(r.problem);
  return r.code;
};

describe("morndo memory import", () => {
  beforeEach(() => {
    md("ports.md", "---\nname: Ports of the api\ndescription: \"Which port the api listens on\"\ntype: project\n---\nThe api listens on 8080.\n");
    md("deploy.md", "---\nname: 'Deploy the api'\ndescription: How a release goes out # not part of it\n---\n1. Tag.\n2. Push the tag.\n");
    md("only-description.md", "---\ndescription: Caching headers are set by the edge\n---\nThe edge sets them, not the app.\n");
    md("MEMORY.md", "# Index\n- [Ports](ports.md)\n");
    md("notes.txt", "---\nname: not markdown\n---\nignored\n");
  });

  it("loads facts and named procedures as an agent's (tier 3), each from its file, and skips files without frontmatter", async () => {
    const r = await run(["import", "--dir", notes, "--scope", "repo:shop-api", "--label", "laptop-notes", "--procedure", "deploy.md"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("N-1     added       deploy.md  (a procedure: it waits for approve)");
    expect(r.out).toContain("skipped     MEMORY.md");
    expect(r.out).toContain("imported 3 (0 superseding), 0 the same, 0 refused, 1 skipped");
    const all = look(m => { const l = m.list(); return l.ok ? l.notes : []; });
    expect(all.map(n => [n.title, n.kind, n.tier, n.provenance.by]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual([
      ["Caching headers are set by the edge", "fact", 3, "import:laptop-notes"],
      ["Deploy the api", "procedure", 3, "import:laptop-notes"],
      ["Ports of the api", "fact", 3, "import:laptop-notes"],
    ]);
    const ports = all.find(n => n.title === "Ports of the api");
    expect(ports).toMatchObject({ summary: "Which port the api listens on", body: "The api listens on 8080.", lastConfirmedAt: MTIME });
    expect(all.find(n => n.kind === "procedure")).toMatchObject({ summary: "How a release goes out", body: "1. Tag.\n2. Push the tag.", approvedAt: null });
  });

  it("a procedure waits for approve: no search finds it and no node receives it until the principal approves it with a one-time code", async () => {
    await run(["import", "--dir", notes, "--scope", "repo:shop-api", "--procedure", join(notes, "deploy.md")]);
    const deploy = look(m => { const l = m.list({ pending: true }); return l.ok ? l.notes : []; });
    expect(deploy.map(n => n.title)).toEqual(["Deploy the api"]);
    const id = deploy[0]?.id ?? "";
    const hidden = look(m => ({ found: m.search({ q: "tag" }), files: m.bundle().parts.flat().map(f => f.name) }));
    expect(hidden.found).toEqual({ ok: true, notes: [] });
    expect(hidden.files.some(f => f.includes("deploy"))).toBe(false);
    expect((await run(["list", "--pending"])).out).toMatch(new RegExp(`${id} +procedure .*waits for approve +Deploy the api`));
    const code = codeFor(id);
    const approved = await withCode(["approve", id], code);
    expect(approved.code, approved.err).toBe(0);
    expect(approved.out).toContain(`approved ${id}`);
    const shown = look(m => ({ found: m.search({ q: "tag" }), files: m.bundle().parts.flat().map(f => f.name) }));
    expect(shown.found.ok && shown.found.notes.map(n => n.id)).toEqual([id]);
    expect(shown.files.some(f => f.includes("deploy"))).toBe(true);
    const spent = await withCode(["approve", id], code);                                        // single use (M8)
    expect(spent.code).toBe(MEMORY_EXIT.refused);
    expect(spent.err).toContain("that code is wrong, already used or expired; ask the app for a new one");
    expect((await run(["list", "--pending"])).out).toBe("no notes\n");
  });

  it("dedupes by title and scope: the same body is skipped, another body supersedes the live note", async () => {
    await run(["import", "--dir", notes, "--scope", "repo:shop-api"]);
    const again = await run(["import", "--dir", notes, "--scope", "repo:shop-api"]);
    expect(again.out).toContain("imported 0 (0 superseding), 3 the same, 0 refused, 1 skipped");
    md("ports.md", "---\nname: Ports of the api\ndescription: Which port\n---\nThe api listens on 9090 now.\n");
    const changed = await run(["import", "--dir", notes, "--scope", "repo:shop-api"]);
    expect(changed.code, changed.err).toBe(0);
    expect(changed.out).toMatch(/N-4 +supersedes {2}ports\.md: N-\d/);
    const live = look(m => { const l = m.list(); return l.ok ? l.notes.filter(n => n.title === "Ports of the api") : []; });
    expect(live.map(n => n.body)).toEqual(["The api listens on 9090 now."]);
    // Another scope is another note.
    const other = await run(["import", "--dir", notes, "--scope", "repo:web-app"]);
    expect(other.out).toContain("imported 3 (0 superseding)");
    // A file named a procedure over a live fact of its title is refused, not turned into another kind.
    const mismatch = await run(["import", "--dir", notes, "--scope", "repo:shop-api", "--procedure", "ports.md"]);
    expect(mismatch.code).toBe(1);
    expect(mismatch.out).toContain("refused     ports.md: mismatch");
  });

  it("cuts the title, the summary and the body to Memory's limits", () => {
    const long = memoryFile(`---\nname: ${"t".repeat(300)}\ndescription: ${"d".repeat(900)}\n---\n${"b".repeat(25_000)}`);
    expect(long?.title.length).toBe(MEMORY_LIMITS.title);
    expect(long?.title.endsWith("…")).toBe(true);
    expect(long?.summary.length).toBe(MEMORY_LIMITS.summary);
    expect(long?.body.length).toBe(MEMORY_LIMITS.body);
    expect(memoryFile("no frontmatter")).toBeNull();
    expect(memoryFile("---\ntype: x\n---\nbody")).toBeNull();
    expect(memoryFile("---\r\nname: \"A \\\"quoted\\\" name\"\r\n---\r\nBody\r\nmore")).toEqual({ title: 'A "quoted" name', summary: "", body: "Body\nmore" });
  });

  it("refuses bad usage before writing anything", async () => {
    expect((await run(["import", "--dir", notes])).code).toBe(2);
    expect((await run(["import", "--dir", notes, "--scope", "team"])).code).toBe(2);
    const missing = await run(["import", "--dir", notes, "--scope", "org", "--procedure", "nope.md"]);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("nope.md");
    expect((await run(["import", "--dir", join(root, "absent"), "--scope", "org"])).code).toBe(1);
    expect(look(m => m.list()).ok && look(m => { const l = m.list({ all: true }); return l.ok ? l.notes.length : -1; })).toBe(0);
  });
});

describe("list, show, approve, invalidate", () => {
  it("shows a note with its provenance and events, and invalidates it with a reason", async () => {
    md("ports.md", "---\nname: Ports\n---\n8080.\n");
    await run(["import", "--dir", notes, "--scope", "org", "--label", "box"]);
    const shown = await run(["show", "N-1"]);
    expect(shown.code).toBe(0);
    expect(shown.out).toContain("N-1  fact  org  live");
    expect(shown.out).toContain("tier: 3 (agent), written by import:box");
    expect(shown.out).toMatch(/events:\n {2}2026-10-20T12:00:00\.000Z {2}import:box {2}proposed/);
    expect((await run(["invalidate", "N-1"])).code).toBe(2);
    const gone = await run(["invalidate", "N-1", "--reason", "port moved"]);
    expect(gone.code, gone.err).toBe(0);
    expect((await run(["show", "N-1"])).out).toContain("invalidated 2026-10-20T12:00:00.000Z by principal:console: port moved");
    expect((await run(["list"])).out).toBe("no notes\n");
    expect((await run(["list", "--all"])).out).toMatch(/N-1 +fact +org +3 agent +invalidated +Ports/);
    expect((await run(["invalidate", "N-1", "--reason", "again"])).err).toContain("N-1: invalidated");
    expect((await run(["show", "N-9"])).code).toBe(1);
    expect((await run(["approve", "N-9"])).err).toContain("N-9: not_found");
  });

  it("a console call without the code is refused", async () => {
    md("deploy.md", "---\nname: Deploy the api\n---\n1. Tag.\n2. Push the tag.\n");
    await run(["import", "--dir", notes, "--scope", "org", "--label", "box", "--procedure", "deploy.md"]);
    const id = "N-1";
    const bare = await run(["approve", id]);
    expect(bare.code, bare.err).toBe(MEMORY_EXIT.refused);
    expect(bare.err).toContain("approving at the console needs a one-time code from the app");
    expect((await run(["list", "--pending"])).out).toContain("Deploy the api");   // still waiting
    const wrong = await withCode(["approve", id], "7YYY-7YYY-7YYY");
    expect(wrong.code, wrong.err).toBe(MEMORY_EXIT.refused);
    expect(wrong.err).toContain("that code is wrong, already used or expired; ask the app for a new one");
    expect((await run(["list", "--pending"])).out).toContain("Deploy the api");
    const code = codeFor(id);
    const right = await withCode(["approve", id], code);
    expect(right.code, right.err).toBe(MEMORY_EXIT.ok);
    expect(right.out).toContain(`approved ${id}`);
    const again = await withCode(["approve", id], code);
    expect(again.code).toBe(MEMORY_EXIT.refused);                                // single use (M8)
    expect(again.err).toContain("that code is wrong, already used or expired; ask the app for a new one");
  });

  it("--code is refused: a live code in argv shows in ps, so it is read from stdin and nowhere else", async () => {
    md("deploy.md", "---\nname: Deploy the api\n---\n1. Tag.\n");
    await run(["import", "--dir", notes, "--scope", "org", "--label", "box", "--procedure", "deploy.md"]);
    const code = codeFor("N-1");
    const argv = await run(["approve", "N-1", "--code", code]);
    expect(argv.code).toBe(MEMORY_EXIT.usage);
    expect(argv.err).toContain("process list");                                // the specific refusal, not the generic usage
    expect(argv.err).toContain("stdin");
    expect(argv.err).not.toContain(code);                                       // the refusal never echoes the code back
    expect(asked).toBe(0);                                                      // nothing was read either
    expect((await run(["list", "--pending"])).out).toContain("Deploy the api");
    const piped = await withCode(["approve", "N-1"], code);                     // the same code works on stdin
    expect(piped.code, piped.err).toBe(MEMORY_EXIT.ok);
    expect(asked).toBe(1);
  });

  it("a blank stdin is the missing code, and an unknown note is refused before anything is read", async () => {
    md("deploy.md", "---\nname: Deploy the api\n---\n1. Tag.\n");
    await run(["import", "--dir", notes, "--scope", "org", "--label", "box", "--procedure", "deploy.md"]);
    const blank = await withCode(["approve", "N-1"], "   ");
    expect(blank.code).toBe(MEMORY_EXIT.refused);
    expect(blank.err).toContain("approving at the console needs a one-time code from the app");
    expect(blank.err).toContain("stdin");
    asked = 0;
    const gone = await withCode(["approve", "N-9"], "7YYY-7YYY-7YYY");
    expect(gone.code).toBe(MEMORY_EXIT.refused);
    expect(gone.err).toContain("N-9: not_found");
    expect(asked).toBe(0);
  });

  it("rejecting at the console needs no code: invalidate is the safe direction", async () => {
    md("deploy.md", "---\nname: Deploy the api\n---\n1. Tag.\n");
    await run(["import", "--dir", notes, "--scope", "org", "--label", "box", "--procedure", "deploy.md"]);
    const r = await run(["invalidate", "N-1", "--reason", "not wanted"]);
    expect(r.code, r.err).toBe(MEMORY_EXIT.ok);
    expect(asked).toBe(0);
  });

  it("refuses an unknown command, a stray option or a missing id with the usage", async () => {
    for (const args of [["constructor"], ["toString"], ["frobnicate"], [], ["list", "--reason", "x"], ["show"], ["approve", "N-1", "N-2"], ["list", "--nope"]]) {
      const r = await run(args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.err).toContain("usage: morndo memory");
    }
    expect((await run(["--help"])).code).toBe(0);
  });
});

describe("morndo memory sync", () => {
  it("pushes now to every online node and says what each did; an unreachable fleet is 69", async () => {
    md("ports.md", "---\nname: Ports\n---\n8080.\n");
    await run(["import", "--dir", notes, "--scope", "org"]);
    const sent: string[] = [];
    const fleet: MemoryFleet = {
      nodes: async () => [{ name: "pc", status: "online" }, { name: "laptop", status: "offline" }, { name: "edge", status: "online" }],
      op: async (target, _op, args, opts) => {
        sent.push(`${target.node} ${opts.key}`);
        return target.node === "edge"
          ? { ok: false, error: { code: "denied", executed: "no", message: "denied" } }
          : { ok: true, result: { committed: args.part === args.parts - 1, written: args.files.length, removed: 0, skillDirs: [], conflicts: [] } };
      },
    };
    const r = await run(["sync"], fleet);
    const version = look(m => m.bundle(Date.UTC(2026, 9, 20, 12)).version);
    expect(r.code).toBe(1);                                              // edge refused
    expect(r.out).toContain(`version ${version} in 1 part`);
    expect(r.out).toMatch(/edge +denied\nlaptop +offline\npc +synced/);
    expect(sent.sort()).toEqual([`edge hub:memory:${version}:0`, `pc hub:memory:${version}:0`]);
    expect(look((_m, s) => s.lastSynced("pc"))?.version).toBe(version);
    const down: MemoryFleet = { nodes: async () => { throw new FleetUnavailable("no socket", false); }, op: async () => { throw new Error("unused"); } };
    const unreachable = await run(["sync"], down);
    expect(unreachable.code).toBe(69);
    expect(unreachable.err).toContain("nothing was sent");
  });
});

describe("through main.ts", () => {
  it("morndo memory runs as a console command on the hub's data directory", async () => {
    md("ports.md", "---\nname: Ports\n---\n8080.\n");
    const main = (args: string[]) => new Promise<Ran>((resolve, reject) => {
      const child = spawn(process.execPath, ["--no-warnings", MAIN, "memory", ...args], {
        env: { PATH: process.env.PATH, HOME: root, MORNDO_HOME: data, MORNDO_FLEET_SOCKET: join(root, "no-fleet.sock") }, stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "", err = "";
      child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
      child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
      child.on("error", reject);
      child.on("exit", code => resolve({ code: code ?? -1, out, err }));
    });
    const imported = await main(["import", "--dir", notes, "--scope", "org", "--label", "box"]);
    expect(imported.code, imported.err).toBe(0);
    expect((await main(["list"])).out).toMatch(/N-1 +fact +org +3 agent +live +Ports/);
    const noFleet = await main(["sync"]);
    expect(noFleet.code).toBe(69);
  }, 30_000);
});

describe("readCodeLine: the one-time code, from stdin", () => {
  const fed = (text: string | null) => {
    const input = new PassThrough();
    if (text !== null) input.write(text);
    input.end();
    return input;
  };
  it("a piped line is the code: the first line, trimmed, and no prompt", async () => {
    const shown: string[] = [];
    expect(await readCodeLine(fed("  K7M2-9QPX-4TWB \nsecond line\n"), false, s => shown.push(s))).toBe("K7M2-9QPX-4TWB");
    expect(shown).toEqual([]);
  });
  it("on a terminal the typed code is not echoed: raw mode, nothing written back but the prompt", async () => {
    const code = "K7M2-9QPX-4TWB";
    const modes: boolean[] = [];
    const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: (on: boolean) => { modes.push(on); return input; } });
    const written: string[] = [];
    const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => { written.push(String(chunk)); return true; });
    const errw = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { written.push(String(chunk)); return true; });
    const shown: string[] = [];
    try {
      const p = readCodeLine(input, true, s => shown.push(s));
      for (const ch of `${code}\r`) input.write(ch);                   // typed key by key, as a terminal delivers it
      expect(await p).toBe(code);
    } finally { out.mockRestore(); errw.mockRestore(); }
    expect(modes[0]).toBe(true);                                         // raw: the tty driver echoes nothing
    expect(modes.at(-1)).toBe(false);                                    // and the terminal is given back as it was
    expect(shown).toEqual(["One-time code: "]);                          // the prompt only, never the code
    expect(written.join("").replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "g"), "")).not.toContain("K7M2");   // nothing was echoed to either stream
  });
  it("on a terminal it asks first; no input at all is the empty code", async () => {
    const shown: string[] = [];
    expect(await readCodeLine(fed("K7M2-9QPX-4TWB\n"), true, s => shown.push(s))).toBe("K7M2-9QPX-4TWB");
    expect(shown).toEqual(["One-time code: "]);
    expect(await readCodeLine(fed(null), false, () => {})).toBe("");
  });
});
