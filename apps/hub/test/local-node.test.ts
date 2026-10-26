// This machine as the hub's one node, "local" (fleet core §3.1, legacy mode): the ports over node-ops' tmux adapter,
// the session registry and transcript files. A fake pane adapter and a temp Claude config dir; no real tmux.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, workerId } from "@morndo/domain";
import { localTranscriptBytes, sessionRegistry, type SendProblem, type Tmux as PaneTmux } from "@morndo/node-ops";
import { LOCAL_NODE, localFiles, localSessions, localTmux, localTranscripts, localUploads } from "../src/adapters/local-node.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-local-node-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function panes(problem: SendProblem | null = null) {
  const captured: string[] = [];
  const typed: { id: string; text: string; at: number }[] = [];
  const tmux: PaneTmux = {
    listWorkers: async () => [{ id: workerId("%1"), name: "builder", location: "w" }, { id: workerId("%2"), name: "fix: a/b ü.2", location: "x" }],
    capture: async id => { captured.push(id); return id === "%9" ? null : `screen of ${id}`; },
    send: async (id, text) => { typed.push({ id, text, at: Date.now() }); await new Promise(r => setTimeout(r, 30)); return problem; },
    sendKeyNames: async () => false,                                  // the hub's local node never presses keys by name
    captureScreen: async () => null,
    pasteLiteral: async () => {},
  };
  return { tmux, captured, typed };
}

describe("localTmux", () => {
  it("lists every worker on the node \"local\", names untouched, never offline", async () => {
    expect(await localTmux(panes().tmux).listWorkers()).toEqual([
      { id: "%1", name: "builder", location: "w", node: LOCAL_NODE, offline: false },
      { id: "%2", name: "fix: a/b ü.2", location: "x", node: LOCAL_NODE, offline: false },
    ]);
  });
  it("captures many panes in one call: each once, a gone pane as null", async () => {
    const p = panes();
    const got = await localTmux(p.tmux).captureMany(["%1", "%9", "%2"]);
    expect([...got]).toEqual([["%1", "screen of %1"], ["%9", null], ["%2", "screen of %2"]]);
    expect(p.captured).toEqual(["%1", "%9", "%2"]);
  });
  it("send answers the problem and the time the typing started, on this machine's clock", async () => {
    const p = panes();
    const before = Date.now();
    const r = await localTmux(p.tmux).send("%1", "ship it", "ep1:r1");
    expect(r.problem).toBeNull();
    expect(r.typedAt).toBeGreaterThanOrEqual(before);
    expect(r.typedAt).toBeLessThanOrEqual(p.typed[0]?.at ?? 0);             // taken before the paste, not after the check
    expect(p.typed.map(t => [t.id, t.text])).toEqual([["%1", "ship it"]]);
    expect((await localTmux(panes("menu_open").tmux).send("%1", "y", "ep1:r2")).problem).toBe("menu_open");
  });
});

describe("localSessions and localTranscripts", () => {
  beforeEach(() => {
    mkdirSync(join(dir, "sessions"));
    mkdirSync(join(dir, "projects", "-w"), { recursive: true });
    writeFileSync(join(dir, "sessions", "1.json"), JSON.stringify({ pid: process.pid, sessionId: "s1", tmux: "qa:@0.%1", name: "builder", cwd: "/w", version: "2.1.286", updatedAt: 1 }));
    writeFileSync(join(dir, "projects", "-w", "s1.jsonl"), '{"type":"user","uuid":"u1"}\n{"type":"assistant","uuid":"a1"}\n');
  });
  it("byPane: the registry's live sessions by pane, asynchronously", async () => {
    const byPane = await localSessions(sessionRegistry(dir)).byPane();
    expect([...byPane.keys()]).toEqual(["%1"]);
    expect(byPane.get("%1")?.sessionId).toBe("s1");
  });
  it("a session's transcript bytes by its id: size, a read window, and locate, as node-ops reads that file", async () => {
    const t = localTranscripts(sessionRegistry(dir));
    const all = '{"type":"user","uuid":"u1"}\n{"type":"assistant","uuid":"a1"}\n';
    expect(await t.size("s1")).toBe(Buffer.byteLength(all));
    const r = await t.read("s1", 0, 10);
    expect(Buffer.from(r?.bytes ?? []).toString()).toBe(all.slice(0, 10));
    expect(r?.eof).toBe(false);
    const file = join(dir, "projects", "-w", "s1.jsonl");
    expect(await t.locate("s1", '"uuid":"a1"')).toBe(await localTranscriptBytes(file).locate('"uuid":"a1"'));
    expect(await t.locate("s1", '"uuid":"a1"')).not.toBeNull();
  });
  it("an unknown session answers null everywhere (negative control: the known one doesn't)", async () => {
    const t = localTranscripts(sessionRegistry(dir));
    expect([await t.size("nope"), await t.read("nope", 0, 10), await t.locate("nope", "u1")]).toEqual([null, null, null]);
    expect(await t.size("s1")).not.toBeNull();
  });
});

describe("localUploads and localFiles", () => {
  it("an image the principal attached is on this machine already: staged, it is its inbox path", async () => {
    const upload = { id: "u1", endpointId: endpointId("ep1"), path: "/home/me/.cache/morndo/inbox/pasted-1.png", mime: "image/png" as const, size: 4, at: 1 };
    expect(await localUploads().stage(upload, "%1")).toEqual({ ok: true, path: upload.path });
  });
  it("a file a worker names is copied by the hub's own store, by its path", async () => {
    const asked: string[] = [];
    const files = localFiles({ register: async path => { asked.push(path); return { id: "a".repeat(32), size: 3 }; } });
    expect(await files.register("%1", "/w/out.png")).toEqual({ id: "a".repeat(32), size: 3 });
    expect(asked).toEqual(["/w/out.png"]);
  });
});
