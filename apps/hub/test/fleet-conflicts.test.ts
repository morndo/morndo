// Names in conflict (spec §4; ADR-0012 decision 11): the fleet's lane registry keeps one row per name, and two windows
// claiming one name put it in conflict, whether on one node or two. The hub's roster still lists every window, each with
// its node, and marks the conflicted ones; a send by worker id still goes (the owner picked that pane). What goes by
// name refuses: the manager's answers, while two windows are called "manager", are refused lane_conflict and typed into
// neither. The fleet adapters, the observation and escalation services, and the fake fleet (whose registry is Task
// 12's); no tmux.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId, type Message } from "@morndo/domain";
import { ledgerReader } from "../src/adapters/ledger.ts";
import { Store } from "../src/adapters/store.ts";
import type { Authenticated } from "../src/application/access-service.ts";
import type { ObservationService } from "../src/application/observation-service.ts";
import { localNode, memoryBackend, type MemoryBackend } from "./helpers/fake-fleet.ts";
import { escalationsFor, fleetRig, observationFor, steeringFor, type FleetRig } from "./helpers/hub-mode.ts";

const T0 = Date.UTC(2026, 9, 6, 8);
const BOX = "──────\n❯ ";
const PC1 = "pc.aaaaaaaa.1";
const PC2 = "pc.aaaaaaaa.2";
const auth: Authenticated = {
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: T0, lastSeenAt: T0, verifiedAt: T0, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Mac", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: T0, revokedAt: null },
};

let dir: string;
let store: Store;
let rig: FleetRig | null = null;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-conflicts-")); store = new Store(dir); });
afterEach(async () => { await rig?.close(); rig = null; store.close(); rmSync(dir, { recursive: true, force: true }); });

// The workers as main.ts hands them to the escalations: each with its conflict.
const seen = (obs: ObservationService) => () => obs.snapshot().workers.map(w => ({ id: w.id as string, name: w.name, conflict: obs.conflicted(w.id) }));

describe("two windows of one name on one node", () => {
  it("are both listed, each with its node and marked in conflict; the registry row has no worker; a send by worker id still goes", async () => {
    const pc = memoryBackend({ "%1": { name: "claude", cwd: "/w/a", screen: BOX }, "%2": { name: "claude", cwd: "/w/b", screen: BOX } });
    rig = await fleetRig([localNode("pc", "aaaaaaaa", pc)]);
    const listed = (await rig.ports.tmux.listWorkers()).sort((a, b) => a.id.localeCompare(b.id));
    expect(listed).toEqual([
      { id: PC1, name: "claude", location: "a", node: "pc", offline: false, conflict: true },
      { id: PC2, name: "claude", location: "b", node: "pc", offline: false, conflict: true },
    ]);
    expect(await rig.client.lanes()).toEqual([{ name: "claude", node: "pc", workerId: null, conflict: true }]);
    const obs = observationFor(rig.ports, { quietAfterMs: 60_000 });
    await obs.poll();
    expect(obs.snapshot().workers.map(w => w.id).sort()).toEqual([PC1, PC2]);
    expect([obs.conflicted(PC1), obs.conflicted(PC2)]).toEqual([true, true]);
    const RID = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
    expect(await steeringFor(rig.ports, { store, now: () => T0 }).send(auth, PC2, "to the second", RID, [], "none")).toEqual({ ok: true, at: expect.any(Number) });
    expect(pc.typed.map(t => [t.pane, t.text])).toEqual([["%2", "to the second"]]);
  });
});

describe("two windows called manager, on two nodes", () => {
  let pc: MemoryBackend;
  let box: MemoryBackend;
  let history: Message[];
  beforeEach(() => {
    pc = memoryBackend({ "%1": { name: "manager", cwd: "/w/m", screen: BOX } });
    box = memoryBackend({ "%1": { name: "beta", cwd: "/w/beta", screen: BOX } });
    const ledgerPath = join(dir, "ledger.json");
    writeFileSync(ledgerPath, JSON.stringify({ needsYou: [{ id: "ny-7", kind: "tap", question: "Ship the demo release tonight?", default: "hold" }], needsYouClosed: [] }));
    history = [{ id: "m1", at: T0 - 60_000, author: { kind: "agent", name: "manager" }, kind: "text", text: "Ready.\n\n[buttons ny-7] ship=Ship it | hold=Hold for a day" }];
  });
  const start = async () => {
    rig = await fleetRig([localNode("pc", "aaaaaaaa", pc), localNode("box", "bbbbbbbb", box)]);
    const obs = observationFor(rig.ports, { quietAfterMs: 60_000 });
    const ledger = ledgerReader(join(dir, "ledger.json"), () => T0);
    const escalations = escalationsFor(rig.ports, {
      store, now: () => T0, ledger,
      watch: { workers: seen(obs), history: id => (id === PC1 ? history : []), openQuestions: () => [], screen: id => obs.screen(id) },
    });
    return { obs, escalations };
  };

  it("an answer to the manager is refused lane_conflict and typed into neither; with one manager again, it goes to that one", async () => {
    const { obs, escalations } = await start();
    await obs.poll();
    escalations.poll();                                                // the manager's ask, seen while there is one manager
    box.panes["%1"] = { name: "manager", cwd: "/w/m2", screen: BOX };  // a second window takes the name
    await rig?.fleet.announce("box");
    await obs.poll();
    expect(obs.conflicted(PC1)).toBe(true);
    expect(await escalations.answer(auth, "ny-7", { kind: "option", key: "ship" }, "r1")).toMatchObject({ ok: false, problem: "lane_conflict" });
    expect([...pc.typed, ...box.typed]).toEqual([]);
    box.panes["%1"] = { name: "beta", cwd: "/w/beta", screen: BOX };   // the owner resolves it: one manager again
    await rig?.fleet.announce("box");
    await obs.poll();
    expect(await escalations.answer(auth, "ny-7", { kind: "option", key: "ship" }, "r2")).toMatchObject({ ok: true });
    expect(pc.typed.map(t => [t.pane, t.text])).toEqual([["%1", "[tap ny-7] ship (Ship it)"]]);
    expect(box.typed).toEqual([]);
  });
});
