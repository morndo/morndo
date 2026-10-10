// Files in a conversation are copied in the background (fleet core §3.1): a message shows its attachment as pending
// until the copy lands, then whoever watches that worker gets the message's attachments again. Synthetic transcript.
// Both configurations (spec §9): the legacy hub's copier (a fake whose copies land when the test says), and the fleet
// hub's, which reads the file on the worker's node through the fake fleet and hands it to the hub's own store (a fake
// store whose copies land when the test says).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LocalFileStore } from "../src/adapters/fleet-adapters.ts";
import type { Listener } from "../src/application/observation-service.ts";
import type { RemoteFiles, Tmux } from "../src/application/ports.ts";
import { HUB_MODES, claudeDirPorts, observationFor, portsFor, type HubMode, type ModePorts } from "./helpers/hub-mode.ts";

let dir: string;
let ports: ModePorts | null = null;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-attach-")); });
afterEach(async () => { await ports?.close(); ports = null; rmSync(dir, { recursive: true, force: true }); });

const T = "2026-10-06T08:00:00.000Z";
const ID = "a".repeat(32);
const said = (uuid: string, text: string) => JSON.stringify({ type: "user", uuid, timestamp: T, origin: { kind: "human" }, message: { role: "user", content: text } });
const TMUX: Tmux = {
  listWorkers: async () => [{ id: "%1", name: "builder", location: "w", node: "local", offline: false }],
  capture: async () => "❯ ", captureMany: async ids => new Map(ids.map(id => [id, "❯ "])), send: async () => ({ problem: null, typedAt: 0 }),
};

// A copier whose copies land when release() is called (the slow ones only, when `slow` says which), as the legacy hub's
// RemoteFiles and as the fleet hub's own store; `asked`: the file names it was asked to copy.
function slowFiles(result: { id: string | null; size: number | null } | Error, slow: (name: string) => boolean = () => true) {
  const asked: string[] = [];
  let release: () => void = () => {};
  const landed = new Promise<void>(r => { release = r; });
  const copy = async (path: string) => {
    asked.push(basename(path));
    if (slow(basename(path))) await landed;
    if (result instanceof Error) throw result;
    return result;
  };
  const files: RemoteFiles = { register: (_workerId, path) => copy(path) };
  const store: LocalFileStore = { register: path => copy(path) };
  return { files, store, asked, release };
}

// A worker %1 whose transcript holds `lines`; its files are copied by `f`.
async function setup(mode: HubMode, lines: string[], f: ReturnType<typeof slowFiles>) {
  mkdirSync(join(dir, "sessions"));
  mkdirSync(join(dir, "projects", "-w"), { recursive: true });
  writeFileSync(join(dir, "sessions", "1.json"), JSON.stringify({ pid: process.pid, sessionId: "s1", tmux: "qa:@0.%1", name: "builder", cwd: "/w", version: "2.1.286", updatedAt: 1 }));
  writeFileSync(join(dir, "projects", "-w", "s1.jsonl"), lines.join("\n") + "\n");
  ports = await portsFor(mode, {
    tmux: TMUX, ...claudeDirPorts(dir), files: f.files, fileStore: f.store,
    readFile: async path => (path.startsWith("/inbox/") ? { bytes: Buffer.from(`bytes of ${path}`), mtime: 1 } : null),
  });
  const p = ports;
  const svc = observationFor(p, { quietAfterMs: 60_000 });
  // What the watcher was sent, as it was at that moment (the messages are the service's own objects, changed later).
  const sent: { t: string; body: unknown }[] = [];
  const keep = (t: string, body: unknown) => sent.push({ t, body: JSON.parse(JSON.stringify(body)) as unknown });
  const listener: Listener = {
    events: () => {}, screen: () => {}, watching: () => p.id("%1"),
    history: (_w, ms) => keep("history", ms.map(m => m.attachments ?? [])),
    messages: (_w, ms) => keep("messages", ms.map(m => m.attachments ?? [])),
    attachments: (w, message, attachments) => keep("attachments", { w, message, attachments }),
  };
  svc.subscribe(listener);
  return { svc, sent, id: p.id };
}
const settle = (ms = 20) => new Promise(r => setTimeout(r, ms));
const photo = { name: "pasted-1.png", mime: "image/png", kind: "image", caption: null };

describe.each(HUB_MODES)("a file in a message is copied in the background, %s hub", mode => {
  it("pending until the copy lands, then the watcher gets the message's attachments with the copy's id", async () => {
    const f = slowFiles({ id: ID, size: 9 });
    const { svc, sent, id } = await setup(mode, [said("u1", "Look\n\n[The owner attached a file: /inbox/pasted-1.png]")], f);
    await svc.poll();
    expect(sent).toEqual([{ t: "history", body: [[{ ...photo, id: null, size: null, pending: true }]] }]);
    await settle(200);
    expect(f.asked).toEqual(["pasted-1.png"]);
    f.release();
    await settle(200);
    expect(sent.at(-1)).toEqual({ t: "attachments", body: { w: id("%1"), message: "u1", attachments: [{ ...photo, id: ID, size: 9 }] } });
    expect(svc.history(id("%1"))[0]?.attachments).toEqual([{ ...photo, id: ID, size: 9 }]);   // and the conversation has it
  });
  it("a copy that fails ends pending as not available (id null), and the watcher is told so", async () => {
    const f = slowFiles(new Error("fleet: node_offline"));
    const { svc, sent, id } = await setup(mode, [said("u1", "Look\n\n[The owner attached a file: /inbox/pasted-1.png]")], f);
    await svc.poll();
    f.release();
    await settle(200);
    expect(sent.at(-1)).toEqual({ t: "attachments", body: { w: id("%1"), message: "u1", attachments: [{ ...photo, id: null, size: null }] } });
  });
  it("an older page waits for copies that land at once; one still copying after 1 s goes out pending, and its frame follows", async () => {
    const f = slowFiles({ id: ID, size: 9 }, name => name === "slow.png");
    const { svc, sent, id } = await setup(mode, [
      said("u0", "first\n\n[The owner attached a file: /inbox/p0.png]"), said("u1", "second\n\n[The owner attached a file: /inbox/slow.png]"), said("u2", "latest"),
    ], f);
    await svc.poll();
    await settle(200);
    sent.length = 0;
    const page = await svc.older(id("%1"), "u2");
    expect(page.messages.map(m => [m.id, m.attachments?.[0]?.id ?? null, m.attachments?.[0]?.pending ?? false])).toEqual([["u0", ID, false], ["u1", null, true]]);
    expect(sent).toEqual([]);
    f.release();
    await settle(200);
    const frames = sent.filter(x => x.t === "attachments").map(x => x.body as { message: string; attachments: { id: string | null }[] });
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every(x => x.message === "u1" && x.attachments[0]?.id === ID)).toBe(true);
  });
});
