import { describe, expect, it } from "vitest";
import { Feed, Roster, workerId, type FeedBody } from "../src/index.ts";

const gone = (id: string): FeedBody => ({ type: "WorkerGone", workerId: workerId(id) });

describe("O1: sequence numbers rise by one per event", () => {
  it("numbers events 1, 2, 3 within the epoch", () => {
    const f = new Feed("e1", 10);
    expect([f.append(gone("a"), 1), f.append(gone("b"), 2), f.append(gone("c"), 3)].map(e => e.seq)).toEqual([1, 2, 3]);
    expect(f.head).toBe(3);
  });
});

describe("O2: resume gets exactly the missed events, or resync", () => {
  const feed = () => {
    const f = new Feed("e1", 3);
    for (let i = 1; i <= 5; i++) f.append(gone(`w${i}`), i);   // keeps seq 3, 4, 5
    return f;
  };
  it("returns exactly the events after a cursor inside the window", () => {
    expect(feed().since("e1", 2)).toEqual({ kind: "events", events: expect.any(Array) });
    const r = feed().since("e1", 3);
    expect(r.kind === "events" && r.events.map(e => e.seq)).toEqual([4, 5]);
  });
  it("returns nothing new at the head", () => {
    expect(feed().since("e1", 5)).toEqual({ kind: "events", events: [] });
  });
  it("returns resync when the gap fell out of the window (negative control)", () => {
    expect(feed().since("e1", 1)).toEqual({ kind: "resync" });
  });
  it("returns resync for another epoch, a future cursor, or garbage", () => {
    expect(feed().since("e0", 4)).toEqual({ kind: "resync" });
    expect(feed().since("e1", 9)).toEqual({ kind: "resync" });
    expect(feed().since("e1", -1)).toEqual({ kind: "resync" });
    expect(feed().since("e1", 2.5)).toEqual({ kind: "resync" });
  });
  it("serves a cursor of 0 from an empty feed and after the first events", () => {
    const f = new Feed("e1", 5);
    expect(f.since("e1", 0)).toEqual({ kind: "events", events: [] });
    f.append(gone("a"), 1);
    const r = f.since("e1", 0);
    expect(r.kind === "events" && r.events.map(e => e.seq)).toEqual([1]);
  });
});

describe("O3: latest screen only; activity is reported as state flips", () => {
  const w = (id: string, name = id) => ({ id: workerId(id), name, location: "/tmp", node: "local", offline: false });
  it("reports appear, rename and gone from listings", () => {
    const r = new Roster(10_000);
    expect(r.observeListing([w("a"), w("b")], 0).map(e => e.type)).toEqual(["WorkerAppeared", "WorkerAppeared"]);
    expect(r.observeListing([w("a", "alpha"), w("b")], 1).map(e => e.type)).toEqual(["WorkerRenamed"]);
    expect(r.observeListing([w("a", "alpha")], 2)).toEqual([gone("b")]);
  });
  it("the first screen isn't activity; a changed screen is; an unchanged one is nothing", () => {
    const r = new Roster(10_000);
    r.observeListing([w("a")], 0);
    expect(r.observeScreen(workerId("a"), "one", 1)).toEqual({ changed: true, events: [] });
    expect(r.observeScreen(workerId("a"), "one", 2)).toEqual({ changed: false, events: [] });
    expect(r.observeScreen(workerId("a"), "two", 3).events.map(e => e.type)).toEqual(["WorkerBecameActive"]);
    expect(r.observeScreen(workerId("a"), "three", 4)).toEqual({ changed: true, events: [] });   // already active: no feed event
    expect(r.screen(workerId("a"))).toBe("three");
  });
  it("goes quiet after the screen stood still long enough, and active again on change", () => {
    const r = new Roster(10_000);
    r.observeListing([w("a")], 0);
    r.observeScreen(workerId("a"), "x", 0);
    r.observeScreen(workerId("a"), "y", 1_000);
    expect(r.tick(10_999)).toEqual([]);
    expect(r.tick(11_000).map(e => e.type)).toEqual(["WorkerBecameQuiet"]);
    expect(r.tick(20_000)).toEqual([]);
    expect(r.observeScreen(workerId("a"), "z", 21_000).events.map(e => e.type)).toEqual(["WorkerBecameActive"]);
  });
  it("ignores screens of unknown workers", () => {
    expect(new Roster(1).observeScreen(workerId("ghost"), "x", 0)).toEqual({ changed: false, events: [] });
  });
});

// Fleet core §7: a node that stops answering keeps its workers listed, marked offline, never gone (spec "offline marker").
describe("a worker whose machine doesn't answer", () => {
  const w = (id: string, offline: boolean) => ({ id: workerId(id), name: id, location: "/tmp", node: "pc", offline });
  const changed = (id: string, offline: boolean): FeedBody => ({ type: "WorkerOfflineChanged", workerId: workerId(id), offline });
  it("stays listed and is marked offline, then online again: one event each way, none while it stays", () => {
    const r = new Roster(10_000);
    r.observeListing([w("a", false)], 0);
    expect(r.observeListing([w("a", true)], 1)).toEqual([changed("a", true)]);
    expect(r.observeListing([w("a", true)], 2)).toEqual([]);
    expect(r.entries().map(e => [e.id, e.offline])).toEqual([["a", true]]);
    expect(r.observeListing([w("a", false)], 3)).toEqual([changed("a", false)]);
    expect(r.entries()[0]?.offline).toBe(false);
  });
  it("one first seen offline appears offline", () => {
    const r = new Roster(10_000);
    expect(r.observeListing([w("b", true)], 0)).toEqual([
      { type: "WorkerAppeared", worker: { id: workerId("b"), name: "b", location: "/tmp", node: "pc" }, state: "quiet", changedAt: 0, offline: true },
    ]);
    expect(r.entries()[0]?.offline).toBe(true);
  });
});

// A worker first listed without its folder (its node offline at the hub's start, listed from the lane registry's row)
// gets it when the node reports it, as an event, so every app shows it without a reload (fleet core §3.1, §7).
describe("a worker's folder that changes", () => {
  const w = (location: string) => ({ id: workerId("a"), name: "a", location, node: "pc", offline: false });
  it("is updated once, with one WorkerMoved, and only when it differs", () => {
    const r = new Roster(10_000);
    r.observeListing([w("")], 0);
    expect(r.observeListing([w("proj")], 1)).toEqual([{ type: "WorkerMoved", workerId: workerId("a"), location: "proj" }]);
    expect(r.observeListing([w("proj")], 2)).toEqual([]);
    expect(r.entries()[0]?.location).toBe("proj");
  });
});
