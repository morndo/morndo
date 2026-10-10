// The phone's agents list order (ADR-0008 phase F): a push's tap lands on it, so who needs him comes first.
import type { RosterEntry, WorkerId } from "@morndo/domain";
import { describe, expect, it } from "vitest";
import { phoneOrder } from "../src/lib/lanes.ts";

const w = (name: string, over: Partial<RosterEntry> = {}): RosterEntry => ({
  id: `%${name}` as WorkerId, name, location: "demo", node: "local", offline: false, title: null, lastMessageAt: null, needsYou: false, waitingOn: null, state: "quiet", changedAt: 0, ...over,
});

describe("the phone's agents list", () => {
  it("who needs him first, then who is working, then the rest, each by name", () => {
    const order = phoneOrder([w("builder"), w("worker-02", { state: "active" }), w("reviewer", { needsYou: true }), w("alpha", { needsYou: true, state: "active" }), w("worker-01", { state: "active" }), w("manager")]);
    expect(order.map(x => x.name)).toEqual(["alpha", "reviewer", "worker-01", "worker-02", "builder", "manager"]);
  });
});
