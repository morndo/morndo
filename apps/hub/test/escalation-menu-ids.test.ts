// Menu escalation ids (spec §4): "menu-" and the worker id with "." as "_", from one definition (packages/protocol
// worker-id.ts, menuEscalationId).
// - Two nodes' panes with the same %N are two asks with two ids, each fit for the answer route.
// - A legacy pane keeps its old id ("%4" → "menu-4"), so a Decision the legacy hub stored for it still applies.
// - Old menu-N rows are provenance, never pruned (retention.ts), as spec §4 and §15 (item 7) say; a fleet hub simply
//   never sights them again, and they stop being loaded after 7 days (Store.decisions).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WORKER_ASK_GRACE_MS, endpointId, sessionId, type Decision } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import type { Tmux } from "../src/application/ports.ts";
import { escalationsFor, portsFor, type ModePorts } from "./helpers/hub-mode.ts";

const T0 = Date.UTC(2026, 9, 6, 10);
const MENU = "work…\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel\n\n";
const NO_TMUX: Tmux = {
  listWorkers: async () => [], capture: async () => null, captureMany: async ids => new Map(ids.map(id => [id, null])),
  send: async () => ({ problem: "no_pane", typedAt: 0 }),
};
const DECIDED: Decision = { choice: { kind: "words" }, at: T0 - 60_000, via: "here", endpointId: endpointId("ep1"), sessionId: sessionId("s1") };

let dir: string;
let store: Store;
let ports: ModePorts;
beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), "morndo-menu-ids-")); store = new Store(dir); ports = await portsFor("legacy", { tmux: NO_TMUX }); });
afterEach(async () => { await ports.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

// The board after one look at these workers, each showing a menu on its screen. A worker's menu waits
// WORKER_ASK_GRACE_MS first (N2), so the look is two polls: the first sights it, the second, past the grace, boards it.
function board(workers: { id: string; name: string }[]) {
  let now = T0;
  const s = escalationsFor(ports, {
    store, now: () => now,
    watch: { workers: () => workers, history: () => [], openQuestions: () => [], screen: id => (workers.some(w => w.id === id) ? MENU : undefined) },
  });
  s.poll();
  now += WORKER_ASK_GRACE_MS;
  s.poll();
  return s.board().items;
}

describe("menu escalation ids", () => {
  it("the same %N on two nodes is two asks with two ids, each fit for the answer route", () => {
    const ids = board([{ id: "pc.aaaaaaaa.1", name: "alpha" }, { id: "box.bbbbbbbb.1", name: "beta" }]).map(i => i.id).sort();
    expect(ids).toEqual(["menu-box_bbbbbbbb_1", "menu-pc_aaaaaaaa_1"]);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,80}$/);           // http.ts: /api/escalations/<id>/answer
  });
  it("a legacy pane keeps its id, so a Decision stored for it before a restart still applies", () => {
    store.saveDecision("menu-4", DECIDED);
    expect(board([{ id: "%4", name: "reviewer" }]).find(i => i.id === "menu-4")?.decision).toMatchObject({ choice: { kind: "words" }, via: "here" });
  });
  it("an old menu-N row never attaches to a fleet worker's menu", () => {
    store.saveDecision("menu-1", DECIDED);
    expect(board([{ id: "pc.aaaaaaaa.1", name: "alpha" }]).map(i => [i.id, i.decision])).toEqual([["menu-pc_aaaaaaaa_1", null]]);
  });
});
