// The event hub (spec 5.6): every subscriber hears every event, in causal order (an event a subscriber emits goes out
// after the one that caused it), and one subscriber that throws never silences the others.
import { describe, expect, it } from "vitest";
import { EventHub, type FleetEvent } from "../src/application/events.ts";

const ev = (t: FleetEvent["t"], node: string): FleetEvent => ({ t, node, body: null });

describe("the event hub", () => {
  it("delivers an event a subscriber emits after the event that caused it, to everyone in the same order", () => {
    const errors: unknown[] = [];
    const hub = new EventHub(e => errors.push(e));
    const first: string[] = [];
    const second: string[] = [];
    hub.subscribe(e => { first.push(`${e.t}:${e.node}`); if (e.t === "inventory") hub.emit(ev("conflict", e.node)); });
    hub.subscribe(e => { second.push(`${e.t}:${e.node}`); });
    hub.emit(ev("inventory", "pc"));
    expect(first).toEqual(["inventory:pc", "conflict:pc"]);
    expect(second).toEqual(["inventory:pc", "conflict:pc"]);
    expect(errors).toEqual([]);
  });

  it("a subscriber that throws is reported and the others still hear the event; unsubscribe stops delivery", () => {
    const errors: unknown[] = [];
    const hub = new EventHub(e => errors.push(e));
    const heard: string[] = [];
    hub.subscribe(() => { throw new Error("boom"); });
    const stop = hub.subscribe(e => heard.push(e.node));
    hub.emit(ev("status", "pc"));
    stop();
    hub.emit(ev("status", "mac"));
    expect(heard).toEqual(["pc"]);
    expect(errors).toHaveLength(2);
  });
});
