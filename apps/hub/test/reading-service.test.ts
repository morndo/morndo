// Read marks and mute on the hub (ADR-0008 phase D; O7, O8): one mark per Conversation, forward only and clamped to the
// hub's clock, told to every Endpoint; mute is per Conversation and told the same way. A fake store.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { READ_MARKS_KEPT, Store } from "../src/adapters/store.ts";
import { ReadingService, type ReadingStore } from "../src/application/reading-service.ts";

function fake(): ReadingStore & { marks: Map<string, number>; mutes: Set<string> } {
  const marks = new Map<string, number>(), mutes = new Set<string>();
  let caughtUp: number | null = null;
  return {
    marks, mutes,
    caughtUpAt: () => caughtUp,
    saveCaughtUp: at => { caughtUp = at; },
    readMarks: () => Object.fromEntries(marks),
    saveReadMark: (c, at) => { marks.set(c, at); },
    mutedConversations: () => [...mutes],
    setMuted: (c, m) => { if (m) mutes.add(c); else mutes.delete(c); },
  };
}
const NOW = 1_000_000;

describe("ReadingService", () => {
  it("moves a mark forward only, clamps it to the hub's clock, and tells every listener once per change", () => {
    const store = fake();
    const svc = new ReadingService(store, () => NOW);
    const told: unknown[] = [];
    svc.subscribe(e => told.push(e));
    svc.read("builder", 500);
    svc.read("builder", 400);                                          // older: nothing
    svc.read("builder", NOW + 99_999);                                 // a fast clock: clamped
    expect(told).toEqual([{ t: "read", conversation: "builder", at: 500 }, { t: "read", conversation: "builder", at: NOW }]);
    expect(store.marks.get("builder")).toBe(NOW);
  });
  it("mutes and unmutes, telling only real changes", () => {
    const svc = new ReadingService(fake(), () => NOW);
    const told: unknown[] = [];
    svc.subscribe(e => told.push(e));
    svc.mute("reviewer", true); svc.mute("reviewer", true); svc.mute("reviewer", false);
    expect(told).toEqual([{ t: "mute", conversation: "reviewer", muted: true }, { t: "mute", conversation: "reviewer", muted: false }]);
  });
  it("the state for a new connection: every mark and every muted Conversation", () => {
    const svc = new ReadingService(fake(), () => NOW);
    svc.read("a", 10); svc.mute("b", true);
    expect(svc.state()).toEqual({ t: "reading", reads: { a: 10 }, muted: ["b"] });
  });
  it("ignores a conversation name that isn't one", () => {
    const store = fake();
    const svc = new ReadingService(store, () => NOW);
    svc.read("", 10); svc.mute("", true);
    expect([store.marks.size, store.mutes.size]).toEqual([0, 0]);
  });
});

// Real database files: a busy box's disk syncs have stalled these past 5 s (each takes under a second alone).
describe("the Store keeps reading across restarts", { timeout: 20_000 }, () => {
  it("marks and mutes survive a new Store on the same data", () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-reading-"));
    try {
      const a = new Store(dir);
      const svc = new ReadingService(a, () => NOW);
      svc.read("builder", 700); svc.mute("reviewer", true);
      a.close();
      const b = new Store(dir);
      expect(new ReadingService(b, () => NOW).state()).toEqual({ t: "reading", reads: { builder: 700 }, muted: ["reviewer"] });
      b.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("keeps the latest 500 marks and no row for an unmuted conversation (review L6)", () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-reading-"));
    const store = new Store(dir);
    try {
      store.db.transaction(() => { for (let i = 0; i < READ_MARKS_KEPT + 2; i++) store.saveReadMark(`c${i}`, 1000 + i); })();
      const marks = store.readMarks();
      expect(Object.keys(marks)).toHaveLength(READ_MARKS_KEPT);
      expect([marks.c0, marks.c1, marks.c2]).toEqual([undefined, undefined, 1002]);
      store.setMuted("x", true); store.setMuted("x", false);
      expect((store.db.prepare("SELECT COUNT(*) AS n FROM conversation_prefs").get() as { n: number }).n).toBe(0);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

// ADR-0009 (C7): "last caught up" is one time on the hub, forward only, clamped to its clock, told to every device, and
// kept across a restart. It touches no read mark, mute or Escalation.
describe("last caught up", () => {
  it("moves forward only, is clamped, and is told once per change", () => {
    const store = fake();
    const svc = new ReadingService(store, () => NOW);
    const told: unknown[] = [];
    svc.subscribe(e => told.push(e));
    svc.caughtUp(500);
    svc.caughtUp(400);
    svc.caughtUp(NOW + 99_999);
    expect(told).toEqual([{ t: "caught_up", at: 500 }, { t: "caught_up", at: NOW }]);
    expect(svc.caughtUpAt()).toBe(NOW);
    expect(store.marks.size + store.mutes.size).toBe(0);
  });
  it("survives a new Store on the same data", { timeout: 20_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-caughtup-"));
    try {
      const a = new Store(dir);
      new ReadingService(a, () => NOW).caughtUp(700);
      a.close();
      const b = new Store(dir);
      expect(new ReadingService(b, () => NOW).caughtUpAt()).toBe(700);
      b.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
