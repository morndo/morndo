// Sends carry keys and come back with the node's time (fleet core §3.1): the key is the request's own
// (<endpoint>:<request>), a refusal before the paste (a node that isn't online among them) still lets the retry type,
// the time the app matches the echo by is the node's typedAt (a node clock 10 s behind the hub's here), and an attached
// image that can't be put on the worker's machine refuses the send before anything is typed. A fake node that keeps
// keys as the agent does: a key it typed answers its stored outcome; a refusal before the paste keeps nothing (spec
// §5.3). Both configurations (spec §9): in fleet mode the node sits behind the fake fleet (which keeps the agent's keys
// too) and gets the key under the hub's namespace ("hub:"). Real SQLite in a temp dir.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId, type Upload } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { localUploads } from "../src/adapters/local-node.ts";
import type { SendOutcome, Tmux, UploadSink } from "../src/application/ports.ts";
import type { Authenticated } from "../src/application/access-service.ts";
import { HUB_MODES, portsFor, steeringFor, type ModePorts } from "./helpers/hub-mode.ts";

const HUB_NOW = Date.UTC(2026, 9, 6, 9);
const NODE_BEHIND_MS = 10_000;                                         // the node's clock, 10 s behind the hub's
const A: Authenticated = {
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: HUB_NOW - 1000, lastSeenAt: HUB_NOW, verifiedAt: HUB_NOW - 1000, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Mac", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: HUB_NOW, revokedAt: null },
};
const RID = "0f1b8a52-3c1d-4e6f-9a7b-2c3d4e5f6a7b";
let dir: string;
let store: Store;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-steer-keys-")); store = new Store(dir); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

// The node's pane %1: answers the next scripted problems first (then types), keeps the outcome of what it typed by key.
function node(script: SendOutcome["problem"][] = []) {
  const typed: { text: string; key: string }[] = [];
  const keys: string[] = [];
  const done = new Map<string, SendOutcome>();
  const tmux: Tmux = {
    listWorkers: async () => [{ id: "%1", name: "alpha", location: "w", node: "local", offline: false }],
    capture: async () => "❯ ", captureMany: async ids => new Map(ids.map(id => [id, "❯ "])),
    send: async (_id, text, key) => {
      keys.push(key);
      const stored = done.get(key);
      if (stored) return stored;
      const problem = script.shift() ?? null;
      if (problem) return { problem, typedAt: HUB_NOW - NODE_BEHIND_MS };   // refused before the paste: nothing kept
      typed.push({ text, key });
      const outcome = { problem: null, typedAt: HUB_NOW - NODE_BEHIND_MS };
      done.set(key, outcome);
      return outcome;
    },
  };
  return { tmux, typed, keys };
}

describe.each(HUB_MODES)("keys, %s hub", mode => {
  let ports: ModePorts | null = null;
  afterEach(async () => { await ports?.close(); ports = null; });
  // The key as the node gets it: the request's own, under the hub's namespace once it goes through a fleet.
  const atNode = (key: string) => (mode === "fleet" ? `hub:${key}` : key);
  const steering = async (n: ReturnType<typeof node>, o: { inbox?: { get(id: string): Upload | undefined }; uploads?: UploadSink } = {}) => {
    ports ??= await portsFor(mode, { tmux: n.tmux });
    return steeringFor({ ...ports, uploads: o.uploads ?? localUploads() }, { store, now: () => HUB_NOW, inbox: o.inbox ?? null });
  };
  const W = () => ports?.id("%1") ?? "";

  it("the node gets the request's own key, <endpoint>:<request>", async () => {
    const n = node();
    const s = await steering(n);
    expect(await s.send(A, W(), "ship it", RID)).toMatchObject({ ok: true });
    expect(n.keys).toEqual([atNode(`ep1:${RID}`)]);
  });
  it("draft_present, then the retry with the same request: typed, once, with the same key", async () => {
    const n = node(["draft_present"]);
    const s = await steering(n);
    expect(await s.send(A, W(), "ship it", RID)).toEqual({ ok: false, problem: "draft_present" });
    expect(await s.send(A, W(), "ship it", RID)).toMatchObject({ ok: true });
    expect(n.typed).toEqual([{ text: "ship it", key: atNode(`ep1:${RID}`) }]);
    expect(n.keys).toEqual([atNode(`ep1:${RID}`), atNode(`ep1:${RID}`)]);
  });
  it("a node that isn't online refuses before the paste: no row is kept, and the retry types, once", async () => {
    const n = node(["node_offline"]);
    const s = await steering(n);
    expect(await s.send(A, W(), "ship it", RID)).toEqual({ ok: false, problem: "node_offline" });
    expect(store.send(`ep1:${RID}`)).toBeNull();
    expect(await s.send(A, W(), "ship it", RID)).toMatchObject({ ok: true });
    expect(n.typed).toEqual([{ text: "ship it", key: atNode(`ep1:${RID}`) }]);
  });

  it("a send answers the node's typedAt, 10 s behind the hub, and a repeat after a restart answers the same", async () => {
    const n = node();
    expect(await (await steering(n)).send(A, W(), "ship it", RID)).toEqual({ ok: true, at: HUB_NOW - NODE_BEHIND_MS });
    const restarted = await steering(n);                               // a new service on the same database
    expect(await restarted.send(A, W(), "ship it", RID)).toEqual({ ok: false, problem: "duplicate", at: HUB_NOW - NODE_BEHIND_MS });
  });

  describe("attached images are staged on the worker's machine first", () => {
    const upload: Upload = { id: "u1", endpointId: endpointId("ep1"), path: "/hub/inbox/pasted-1.png", mime: "image/png", size: 4, at: HUB_NOW - 1000 };
    const inbox = { get: (id: string) => (id === "u1" ? upload : undefined) };
    it("a stage that fails refuses the send before anything is typed, writes no row, and the retry types", async () => {
      const n = node();
      let offline = true;
      const staged: string[] = [];
      const uploads: UploadSink = {
        stage: async (u, workerId) => { staged.push(`${u.id}@${workerId}`); return offline ? { ok: false, problem: "node_offline" } : { ok: true, path: "/node/inbox/pasted-1.png" }; },
      };
      const s = await steering(n, { inbox, uploads });
      expect(await s.send(A, W(), "look", RID, ["u1"])).toEqual({ ok: false, problem: "node_offline" });
      expect(n.keys).toEqual([]);
      expect(store.send(`ep1:${RID}`)).toBeNull();
      offline = false;
      expect(await s.send(A, W(), "look", RID, ["u1"])).toMatchObject({ ok: true });
      expect(n.typed.map(t => t.text)).toEqual(["look\n\n[The owner attached a file: /node/inbox/pasted-1.png]"]);   // the path there
      expect(staged).toEqual([`u1@${W()}`, `u1@${W()}`]);
    });
    it("on this machine (the local sink) the note names the inbox path", async () => {
      const n = node();
      expect(await (await steering(n, { inbox })).send(A, W(), "look", RID, ["u1"])).toMatchObject({ ok: true });
      expect(n.typed.map(t => t.text)).toEqual(["look\n\n[The owner attached a file: /hub/inbox/pasted-1.png]"]);
    });
    it("a repeat that comes while the first is still staging waits for it: typed once", async () => {
      const n = node();
      let release: () => void = () => {};
      const gate = new Promise<void>(r => { release = r; });
      const uploads: UploadSink = { stage: async u => { await gate; return { ok: true, path: u.path }; } };
      const s = await steering(n, { inbox, uploads });
      const first = s.send(A, W(), "look", RID, ["u1"]);
      const repeat = s.send(A, W(), "look", RID, ["u1"]);
      release();
      expect({ first: await first, repeat: await repeat }).toEqual({
        first: { ok: true, at: HUB_NOW - NODE_BEHIND_MS }, repeat: { ok: false, problem: "duplicate", at: HUB_NOW - NODE_BEHIND_MS },
      });
      expect(n.typed).toHaveLength(1);
    });
  });
});
