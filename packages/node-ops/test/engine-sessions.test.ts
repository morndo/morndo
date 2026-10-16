// The engine layer's lane registry (ADR-0030) on files shaped like test/fixtures/engine-lane: which live engine lane is the
// foreground job of which pane, under which stable id, and where its transcript is (only inside the engine layer's own
// transcript directory).
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { combineSessions, engineSessionRegistry, sessionRegistry } from "../src/index.ts";

const recorded = JSON.parse(readFileSync(join(import.meta.dirname, "../../../test/fixtures/engine-lane/session-file.json"), "utf8")) as Record<string, unknown>;
const BOOT = recorded.bootId as string;

let dir: string;      // the registry
let tr: string;       // the engine layer's transcript directory
let outside: string;  // a directory the engine layer does not own
beforeEach(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "morndo-engines-")));
  dir = join(root, "sessions"); tr = join(root, "transcripts"); outside = join(root, "elsewhere");
  for (const d of [dir, tr, outside]) mkdirSync(d);
});
afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

const transcript = (name = "demo-lane-aaaaaaaa-0000-4000-8000-000000000001.jsonl") => join(tr, name);
const put = (file: string, over: Record<string, unknown> = {}) => writeFileSync(join(dir, file), JSON.stringify({ ...recorded, transcript: transcript(), ...over }));
// The lane is process 4242 in group 4242 under a launcher (4100) under the pane's shell (4000, group 4000); a pane's terminal has
// one foreground group: tpgid.
type Groups = { pgrp: number; tpgid: number };
const world = (o: { foreground?: number; lanePgrp?: number } = {}) => new Map<number, Groups>([
  [4242, { pgrp: o.lanePgrp ?? 4242, tpgid: o.foreground ?? 4242 }], [4300, { pgrp: 4300, tpgid: o.foreground ?? 4242 }],
  [4000, { pgrp: 4000, tpgid: o.foreground ?? 4242 }], [9000, { pgrp: 9000, tpgid: 9000 }],
]);
const io = (o: { alive?: (pid: number) => boolean; ticks?: (pid: number) => { ticks: number; bootId: string } | null; groups?: Map<number, Groups> } = {}) => ({
  transcripts: tr,
  alive: o.alive ?? (() => true),
  identity: o.ticks ?? ((pid: number) => (pid === 4242 ? { ticks: 5500, bootId: BOOT } : null)),
  groups: (pid: number) => (o.groups ?? world()).get(pid) ?? null,
});
const PANES = new Map([["%3", 4000], ["%9", 9000]]);

describe("engine session registry", () => {
  it("finds a live lane that is the foreground job of a pane, from a recorded session file", () => {
    put("4242.json");
    expect(engineSessionRegistry(dir, io()).byPane(PANES).get("%3")).toEqual({
      sessionId: "engine-4242-5500", name: "demo-lane", pane: "%3", cwd: "/work/demo", version: null, pid: 4242, status: "idle", engine: "codex", aliases: ["0b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8"],
    });
  });

  it("keeps one id for the lane while its file's sessionId changes under it (the engine names a session, /clear), and every id the file had as an alias", () => {
    const reg = engineSessionRegistry(dir, io());
    const got = ["0b1c2d3e-0000-4000-8000-000000000001", "9f8e7d6c-0000-4000-8000-000000000002", "0b1c2d3e-0000-4000-8000-000000000001"].map(sessionId => {
      put("4242.json", { sessionId });
      return reg.byPane(PANES).get("%3");
    });
    expect(new Set(got.map(g => g?.sessionId))).toEqual(new Set(["engine-4242-5500"]));
    expect(new Set(got.at(-1)?.aliases)).toEqual(new Set(["0b1c2d3e-0000-4000-8000-000000000001", "9f8e7d6c-0000-4000-8000-000000000002"]));
  });

  it("is no engine lane in the pane once the shell has the foreground: stopped with Ctrl-Z, or started with & (negative control)", () => {
    put("4242.json");
    expect(engineSessionRegistry(dir, io()).byPane(PANES).has("%3")).toBe(true);
    expect(engineSessionRegistry(dir, io({ groups: world({ foreground: 4000 }) })).byPane(PANES).size).toBe(0);   // the shell's group
    expect(engineSessionRegistry(dir, io({ groups: world({ lanePgrp: 4243 }) })).byPane(PANES).size).toBe(0);     // the lane in a group of its own, not foreground
  });

  it("ignores a lane in no known pane, a dead process, and a pid another process took after a reboot (negative control)", () => {
    put("4242.json");
    expect(engineSessionRegistry(dir, io()).byPane(new Map([["%9", 9000]])).size).toBe(0);
    expect(engineSessionRegistry(dir, io({ alive: () => false })).byPane(PANES).size).toBe(0);
    expect(engineSessionRegistry(dir, io({ ticks: () => ({ ticks: 77, bootId: BOOT }) })).byPane(PANES).size).toBe(0);
    expect(engineSessionRegistry(dir, io({ ticks: () => ({ ticks: 5500, bootId: "another-boot" }) })).byPane(PANES).size).toBe(0);
    expect(engineSessionRegistry(dir, io()).byPane(PANES).size).toBe(1);
  });

  it("needs the file's start ticks and boot id, and a process whose identity can be read (a file anyone can write is not a lane)", () => {
    put("4242.json", { pidStartTicks: undefined });
    expect(engineSessionRegistry(dir, io()).byPane(PANES).size).toBe(0);
    put("4242.json", { bootId: undefined });
    expect(engineSessionRegistry(dir, io()).byPane(PANES).size).toBe(0);
    put("4242.json", { pidStartTicks: "5500" });
    expect(engineSessionRegistry(dir, io()).byPane(PANES).size).toBe(0);
    put("4242.json");
    expect(engineSessionRegistry(dir, io({ ticks: () => null })).byPane(PANES).size).toBe(0);
    expect(engineSessionRegistry(dir, io()).byPane(PANES).size).toBe(1);
  });

  it("reads busy and idle; any other status, or none, is null", () => {
    for (const [status, kept] of [["busy", "busy"], ["idle", "idle"], ["thinking", null], [7, null], [undefined, null]] as const) {
      put("4242.json", { status });
      expect(engineSessionRegistry(dir, io()).byPane(PANES).get("%3")?.status, String(status)).toBe(kept);
    }
  });

  it("takes the newest of two lanes in one pane, and survives files that are not lanes", () => {
    put("4242.json", { updatedAt: 10 });
    put("4300.json", { pid: 4300, updatedAt: 20, name: "newer", pidStartTicks: 6000 });
    writeFileSync(join(dir, "junk.json"), "not json");
    writeFileSync(join(dir, "null.json"), "null");
    writeFileSync(join(dir, "notes.txt"), "x");
    const both = engineSessionRegistry(dir, { ...io(), identity: pid => ({ ticks: pid === 4242 ? 5500 : 6000, bootId: BOOT }), groups: pid => (pid === 4000 ? { pgrp: 4000, tpgid: 4242 } : pid === 9000 ? { pgrp: 9000, tpgid: 9000 } : { pgrp: 4242, tpgid: 4242 }) });
    expect(both.byPane(PANES).get("%3")?.name).toBe("newer");
  });

  it("serves the transcript of a lane inside the engine layer's transcript directory, by the lane's id", () => {
    put("4242.json");
    writeFileSync(transcript(), "");
    const reg = engineSessionRegistry(dir, io());
    expect(reg.transcriptPath("engine-4242-5500")).toBe(transcript());
    expect(reg.transcriptPath("engine-1-1")).toBeNull();
    expect(reg.transcriptPath("0b1c2d3e-4f50-4a61-8b72-93a4b5c6d7e8")).toBeNull();
  });

  it("serves no file outside that directory: a path to a file that does not exist, a .. path, a link out, a file that is not a transcript (negative control)", () => {
    const key = join(outside, "secret.jsonl");                       // named like a transcript, so only where it is can refuse it
    writeFileSync(key, "outside");
    writeFileSync(join(outside, "secret"), "outside");
    writeFileSync(transcript("ok.jsonl"), "");
    symlinkSync(key, transcript("linked.jsonl"));
    const cases: [string, string][] = [
      ["a path elsewhere", key],
      ["a file that does not exist", join(dir, "..", "nobody", "hidden", "secret")],
      ["a .. path", join(tr, "..", "elsewhere", "secret.jsonl")],
      ["a file with no transcript name", join(outside, "secret")],
      ["a link inside the directory that points out", transcript("linked.jsonl")],
      ["a sibling directory with the same prefix", `${tr}-other/x.jsonl`],
      ["a file that is not a transcript", join(tr, "notes.txt")],
      ["the directory itself", tr],
    ];
    writeFileSync(join(tr, "notes.txt"), "x");
    for (const [what, path] of cases) {
      put("4242.json", { transcript: path });
      const reg = engineSessionRegistry(dir, io());
      reg.byPane(PANES);
      expect(reg.transcriptPath("engine-4242-5500"), what).toBeNull();
    }
    put("4242.json", { transcript: transcript("ok.jsonl") });
    expect(engineSessionRegistry(dir, io()).transcriptPath("engine-4242-5500")).toBe(transcript("ok.jsonl"));
  });

  it("serves no transcript once the link is swapped for one that points out after the lane was read", () => {
    const key = join(outside, "secret.jsonl");
    writeFileSync(key, "outside");
    writeFileSync(transcript(), "");
    put("4242.json");
    const reg = engineSessionRegistry(dir, io());
    expect(reg.byPane(PANES).size).toBe(1);
    rmSync(transcript());
    symlinkSync(key, transcript());
    expect(reg.transcriptPath("engine-4242-5500")).toBeNull();
  });

  it("has nothing for a directory that is missing", () => {
    const reg = engineSessionRegistry(join(dir, "absent"), io());
    expect(reg.byPane(PANES).size).toBe(0);
    expect(reg.transcriptPath("engine-4242-5500")).toBeNull();
  });
});

describe("combined sessions", () => {
  it("adds the engine lanes to the first registry's sessions; a pane that registry holds stays its own", () => {
    mkdirSync(join(dir, "..", "claude", "sessions"), { recursive: true });
    writeFileSync(join(dir, "..", "claude", "sessions", "1.json"), JSON.stringify({ pid: process.pid, sessionId: "s-claude", tmux: "qa:@0.%9", cwd: "/tmp/demo", updatedAt: 1 }));
    put("4242.json");
    writeFileSync(transcript(), "");
    const both = combineSessions(sessionRegistry(join(dir, "..", "claude")), engineSessionRegistry(dir, io()), () => PANES);
    expect([...both.byPane().keys()].sort()).toEqual(["%3", "%9"]);
    expect(both.byPane().get("%9")?.sessionId).toBe("s-claude");
    expect(both.byPane().get("%3")?.engine).toBe("codex");
    expect(both.transcriptPath("engine-4242-5500")).toBe(transcript());
    expect(both.transcriptPath("nope")).toBeNull();
  });

  it("a pane the first registry holds is not an engine lane even when a lane's process is in it", () => {
    mkdirSync(join(dir, "..", "claude", "sessions"), { recursive: true });
    writeFileSync(join(dir, "..", "claude", "sessions", "1.json"), JSON.stringify({ pid: process.pid, sessionId: "s-claude", tmux: "qa:@0.%3", cwd: "/tmp/demo", updatedAt: 1 }));
    put("4242.json");
    const both = combineSessions(sessionRegistry(join(dir, "..", "claude")), engineSessionRegistry(dir, io()), () => PANES);
    expect(both.byPane().get("%3")?.sessionId).toBe("s-claude");
  });
});
