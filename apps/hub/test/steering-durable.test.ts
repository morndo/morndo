// The hub's dedupe of request ids is durable (ADR-0008 phase C; S5): a row is written "started" before typing and
// "done" after. After a restart, a repeat of a done request is "duplicate"; a repeat of one that was still being typed
// when the hub stopped is "uncertain" and is never typed again. A refusal before the paste leaves no row, so a retry may
// type. And a Command is judged on arrival against the needs-you state it saw (S6): "stale" if it changed either way.
// Both configurations (spec §9):
// - the legacy hub types through its local port;
// - the fleet hub types through the fake fleet, whose node keeps the agent's two-phase keys, so a repeat there asks the
//   node (op.status) and gets the same answers.
// Real SQLite in a temp dir, and one fake agent pane per test. A new SteeringService on the same store and the same pane
// stands for the hub restarting.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId } from "@morndo/domain";
import type { SendProblem } from "@morndo/node-ops";
import { Store } from "../src/adapters/store.ts";
import type { SendOutcome, Tmux } from "../src/application/ports.ts";
import type { Authenticated } from "../src/application/access-service.ts";
import { until } from "./helpers/fake-fleet.ts";
import { HUB_MODES, portsFor, steeringFor, type ModePorts } from "./helpers/hub-mode.ts";

const NOW = Date.UTC(2026, 9, 2, 8);
let dir: string;
let store: Store;
let now: number;
const authAs = (endpoint: string): Authenticated => ({
  session: { id: sessionId(`s-${endpoint}`), endpointId: endpointId(endpoint), startedAt: NOW - 1000, lastSeenAt: NOW, verifiedAt: NOW - 1000, endedAt: null, endReason: null },
  endpoint: { id: endpointId(endpoint), name: endpoint, credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: NOW, revokedAt: null },
});
const A = authAs("ep1");
const RID = "6f1b8a52-3c1d-4e6f-9a7b-2c3d4e5f6a7b";

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-steer-durable-")); store = new Store(dir); now = NOW; });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

type Next = SendProblem | null | "hang" | "throw";
const BEFORE: readonly SendProblem[] = ["menu_open", "no_input_box", "draft_present", "no_pane", "busy"];
// One agent pane: what its next send does (then it types normally again), and every text that reached it.
function fakePane() {
  const typed: string[] = [];
  let next: Next = null;
  const tmux: Tmux = {
    listWorkers: async () => [{ id: "%1", name: "alpha", location: "w", node: "local", offline: false }],
    capture: async () => "──────\n❯ ",
    captureMany: async ids => new Map(ids.map(id => [id, "──────\n❯ "])),
    send: async (_id, text): Promise<SendOutcome> => {
      const outcome = next;
      next = null;
      if (outcome !== null && outcome !== "hang" && outcome !== "throw" && BEFORE.includes(outcome)) return { problem: outcome, typedAt: 0 };
      typed.push(text);
      if (outcome === "hang") return new Promise<SendOutcome>(() => {});        // the hub dies while typing
      if (outcome === "throw") throw new Error("tmux: server exited");
      return { problem: outcome, typedAt: now };
    },
  };
  return { tmux, typed, set: (n: Next) => { next = n; } };
}
const rows = () => store.db.prepare("SELECT key, state FROM sends ORDER BY key").all();

describe.each(HUB_MODES)("durable dedupe across a restart (S5), %s hub", mode => {
  let pane: ReturnType<typeof fakePane>;
  let ports: ModePorts;
  beforeEach(async () => { pane = fakePane(); ports = await portsFor(mode, { tmux: pane.tmux }); });
  afterEach(async () => { await ports.close(); });
  const steering = () => steeringFor(ports, { store, now: () => now });
  const W = () => ports.id("%1");

  it("a repeat after the first was typed and recorded done is duplicate, and isn't typed again", async () => {
    expect(await steering().send(A, W(), "ship it", RID, [], "none")).toEqual({ ok: true, at: NOW });
    expect(rows()).toEqual([{ key: `ep1:${RID}`, state: "done" }]);
    now = NOW + 5000;
    // The first typing's time comes back, for matching the echo (review M2; spec §3.1: the node's own typedAt).
    expect(await steering().send(A, W(), "ship it", RID, [], "none")).toEqual({ ok: false, problem: "duplicate", at: NOW });
    expect(pane.typed).toEqual(["ship it"]);
  });
  it("a repeat of a send the hub was still typing when it stopped is uncertain, never typed again", async () => {
    pane.set("hang");
    // In fleet mode this request ends when the fake fleet closes after the test: that rejection is expected.
    void steering().send(A, W(), "ship it", RID, [], "none").catch(() => {});
    await until(() => pane.typed.length === 1);
    expect(rows()).toEqual([{ key: `ep1:${RID}`, state: "started" }]);
    expect(await steering().send(A, W(), "ship it", RID, [], "none")).toEqual({ ok: false, problem: "uncertain" });
    expect(pane.typed).toHaveLength(1);
  });
  it("a refusal before anything was pasted leaves no row: the retry types it", async () => {
    for (const before of BEFORE) {
      pane.set(before);
      expect(await steering().send(A, W(), "y", RID, [], "none")).toEqual({ ok: false, problem: before });
      expect(rows(), before).toEqual([]);
    }
    expect(await steering().send(A, W(), "y", RID, [], "none")).toEqual({ ok: true, at: NOW });
    expect(pane.typed).toEqual(["y"]);
  });
  it("not submitted: the text was pasted, so the row stays and a repeat is uncertain, never typed twice (review H2)", async () => {
    pane.set("not_submitted");
    expect(await steering().send(A, W(), "y", RID, [], "none")).toEqual({ ok: false, problem: "not_submitted" });
    expect(rows()).toEqual([{ key: `ep1:${RID}`, state: "started" }]);
    expect(await steering().send(A, W(), "y", RID, [], "none")).toEqual({ ok: false, problem: "uncertain" });
    expect(pane.typed).toEqual(["y"]);
  });
  it("a throw while typing may have pasted it: the row stays and a repeat is uncertain (review H2)", async () => {
    pane.set("throw");
    // Legacy: the throw is passed on (a 500). Fleet: the node answered "maybe" (SendInDoubt), which the hub answers
    // "uncertain" at once (409, "may have been sent"; final review I1).
    if (mode === "legacy") await expect(steering().send(A, W(), "y", RID, [], "none")).rejects.toThrow(/server exited/);
    else expect(await steering().send(A, W(), "y", RID, [], "none")).toEqual({ ok: false, problem: "uncertain" });
    expect(rows()).toEqual([{ key: `ep1:${RID}`, state: "started" }]);
    expect(await steering().send(A, W(), "y", RID, [], "none")).toEqual({ ok: false, problem: "uncertain" });
    expect(pane.typed).toEqual(["y"]);
  });
  it("request ids are per Endpoint: another device's same id is its own send", async () => {
    await steering().send(A, W(), "y", RID, [], "none");
    expect(await steering().send(authAs("ep2"), W(), "y", RID, [], "none")).toEqual({ ok: true, at: NOW });
    expect(pane.typed).toEqual(["y", "y"]);
  });
  it("records older than 24 hours are pruned", async () => {
    await steering().send(A, W(), "y", RID, [], "none");
    expect(store.pruneSends(now + 24 * 3_600_000 - 1)).toBe(0);
    expect(store.pruneSends(now + 24 * 3_600_000 + 1)).toBe(1);
    expect(rows()).toEqual([]);
  });
});

describe.each(HUB_MODES)("judged on arrival against what it answers (S6), %s hub", mode => {
  let pane: ReturnType<typeof fakePane>;
  let ports: ModePorts;
  beforeEach(async () => { pane = fakePane(); ports = await portsFor(mode, { tmux: pane.tmux }); });
  afterEach(async () => { await ports.close(); });
  const steering = (waitingOn: (w: string) => string) => steeringFor(ports, { store, now: () => now, waitingOn });
  const W = () => ports.id("%1");

  it("composed with no question showing, a question showing now: stale, nothing typed", async () => {
    expect(await steering(() => "q:toolu_1").send(A, W(), "2", RID, [], "none")).toEqual({ ok: false, problem: "stale" });
    expect(pane.typed).toEqual([]);
    expect(rows()).toEqual([]);
  });
  it("composed for one question, another showing now (answered elsewhere, asked again, or changed): stale", async () => {
    expect(await steering(() => "q:toolu_2").send(A, W(), "Keep it", RID, [], "q:toolu_1")).toEqual({ ok: false, problem: "stale" });
    expect(await steering(() => "none").send(A, W(), "Keep it", RID, [], "q:toolu_1")).toEqual({ ok: false, problem: "stale" });
    expect(pane.typed).toEqual([]);
  });
  it("the same state as when it was composed: typed (steering a busy agent keeps working)", async () => {
    expect(await steering(() => "none").send(A, W(), "carry on", RID, [], "none")).toEqual({ ok: true, at: NOW });
    expect(await steering(() => "menu:ab12").send(A, W(), "1", "7f1b8a52-3c1d-4e6f-9a7b-2c3d4e5f6a7b", [], "menu:ab12")).toEqual({ ok: true, at: NOW });
    expect(pane.typed).toHaveLength(2);
  });
});
