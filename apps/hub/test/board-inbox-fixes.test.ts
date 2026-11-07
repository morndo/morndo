// Review fixes for the decision inbox and the stale sweep (T-805, part A): the fleet refuses a delivery id that is not
// `<client>:<rest>` with a lowercase client of at most 16 letters (so `board-inbox:1` was never delivered); a retry may
// reuse an id only for the same text (the same id with other text is the fleet's id_conflict); and a decision that was
// answered but whose task stays blocked belongs to the stale sweep again. Synthetic times only.
import { describe, expect, it } from "vitest";
import { DECISION_DUE_MS, createTask, watchedKeys, type BoardActor, type Task } from "@morndo/domain";
import { LIMITS } from "@morndo/protocol";
import { BoardInbox, StaleSweep, fleetDeliverText } from "../src/application/board-inbox.ts";

const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const manager: BoardActor = { kind: "manager", name: "manager", token: "tok-m" };
const FLEET_ID = /^[a-z]{1,16}:[^\p{Cc}]+$/u;

const make = (n: number, o: Partial<Task> = {}): Task => {
  const r = createTask({ title: `Task ${n}`, assignee: "builder" }, manager, n, T0 - 100 * HOUR);
  if (!r.ok) throw new Error(r.error.problem);
  return { ...r.value.task, ...o };
};
const asked = (n: number, at: number): Task =>
  make(n, { status: "blocked", blockedReason: "STATUS: NEEDS DECISION checkpoint: plan", stateChangedAt: at, updatedAt: at, decisionDue: at + DECISION_DUE_MS });
const idle = (n: number, at: number): Task => make(n, { status: "blocked", blockedReason: "waits on the Mac", stateChangedAt: at, updatedAt: at });

describe("the id the fleet is given", () => {
  const rig = (answer: { ok: boolean }) => {
    const seen: { id: string; lane: string; text: string; ttlMs?: number }[] = [];
    const deliver = fleetDeliverText({ deliver: async d => { seen.push(d); return answer.ok ? { ok: true as const, delivery: {} as never } : { ok: false as const, inDoubt: true as const }; } });
    return { seen, deliver };
  };
  it("is `hub:` plus the watcher's own id, a shape the fleet accepts, whatever the clock says", async () => {
    const { seen, deliver } = rig({ ok: true });
    for (const id of [`board-inbox:${T0}`, `board-stale:${T0 + 12 * HOUR}`]) {
      expect(await deliver({ id, lane: "manager", text: "x", ttlMs: 5000 })).toBe(true);
    }
    expect(seen.map(s => s.id)).toEqual([`hub:board-inbox:${T0}`, `hub:board-stale:${T0 + 12 * HOUR}`]);
    for (const s of seen) { expect(FLEET_ID.test(s.id)).toBe(true); expect(s.id.length).toBeLessThanOrEqual(LIMITS.maxDeliveryId); }
    expect(seen[0]).toMatchObject({ lane: "manager", text: "x", ttlMs: 5000 });
    expect(FLEET_ID.test(`board-inbox:${T0}`)).toBe(false);          // what the locked tests' ids look like on their own: refused
  });
  it("answers false when the fleet did not take it", async () => {
    expect(await rig({ ok: false }).deliver({ id: "board-stale:1", lane: "manager", text: "x" })).toBe(false);
  });
});

describe("a retry under the same id carries the same text, else it gets a new id", () => {
  it("the inbox: same text, same id; the list changed meanwhile, a new id", async () => {
    const sent: { id: string; text: string }[] = [];
    let ok = false;
    let tasks = [asked(1, T0 - HOUR)];
    let now = T0;
    const inbox = new BoardInbox({ tasks: () => tasks, deliver: async d => { if (!ok) { sent.push({ id: d.id, text: d.text }); return false; } sent.push({ id: d.id, text: d.text }); return true; }, lane: "manager", now: () => now, legacySince: T0 });
    await inbox.tick();                                // fails: id A, text A
    await inbox.tick();                                // fails again, nothing changed
    expect(sent[1]?.id).toBe(sent[0]?.id);
    now = T0 + 5 * 60_000;
    tasks = [asked(1, T0 - HOUR), asked(2, T0 - HOUR)]; // the text is another now
    ok = true;
    await inbox.tick();
    expect(sent[2]?.text).not.toBe(sent[0]?.text);
    expect(sent[2]?.id).not.toBe(sent[0]?.id);
  });
  it("the sweep: the same", async () => {
    const sent: { id: string; text: string }[] = [];
    let ok = false;
    let tasks = [idle(1, T0 - 72 * HOUR)];
    let now = T0;
    const sweep = new StaleSweep({ tasks: () => tasks, watched: () => new Set(), deliver: async d => { sent.push({ id: d.id, text: d.text }); return ok; }, lane: "manager", now: () => now });
    await sweep.tick();
    now = T0 + 60_000;
    await sweep.tick();
    expect(sent[1]?.id).toBe(sent[0]?.id);
    now = T0 + 2 * HOUR;                               // the hours in the text changed, the list did not
    ok = true;
    await sweep.tick();
    expect(sent[2]?.text).not.toBe(sent[0]?.text);
    expect(sent[2]?.id).not.toBe(sent[0]?.id);
    tasks = [];
  });
});

describe("an answered decision that stays blocked is not lost", () => {
  it("the sweep lists it once the inbox has let it go, and its key is not watched", async () => {
    const answered = (k: string) => k === "T-1";
    const t = asked(1, T0 - 60 * HOUR);
    const sent: string[] = [];
    const sweep = new StaleSweep({
      tasks: () => [t], watched: () => watchedKeys({ tasks: [t], merged: [] }, T0, T0, answered), answered,
      deliver: async d => { sent.push(d.text); return true; }, lane: "manager", now: () => T0,
    });
    expect(await sweep.tick()).toEqual({ sent: true, items: 1 });
    expect(sent[0]).toContain("- T-1 blocked 60 h (builder): Task 1");
    expect(watchedKeys({ tasks: [t], merged: [] }, T0, T0, answered).has("T-1")).toBe(false);
    expect(watchedKeys({ tasks: [t], merged: [] }, T0, T0).has("T-1")).toBe(true);         // unanswered: the inbox watches it
  });
  it("the sweep asks the rule once per decision in a pass, for the watched set and the list together", async () => {
    const t = asked(1, T0 - 60 * HOUR);
    const seen: string[] = [];
    const answered = (k: string, since: number) => { seen.push(`${k}@${since}`); return true; };
    const sweep = new StaleSweep({
      tasks: () => [t], watched: a => watchedKeys({ tasks: [t], merged: [] }, T0, T0, a), answered,
      deliver: async () => true, lane: "manager", now: () => T0,
    });
    expect(await sweep.tick()).toEqual({ sent: true, items: 1 });
    expect(seen).toEqual([`T-1@${T0 - 60 * HOUR}`]);
  });
  it("an unanswered decision stays out of the sweep, as before", async () => {
    const t = asked(1, T0 - 60 * HOUR);
    const sweep = new StaleSweep({ tasks: () => [t], watched: () => new Set(), answered: () => false, deliver: async () => true, lane: "manager", now: () => T0 });
    expect(await sweep.tick()).toEqual({ sent: false, items: 0 });
  });
});
