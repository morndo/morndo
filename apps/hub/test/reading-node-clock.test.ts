// The service asks where the Conversation's newest message is (V15): a node's clock ahead of the hub's doesn't clamp a
// mark that reads it.
import { describe, expect, it } from "vitest";
import { ReadingService, type ReadingStore } from "../src/application/reading-service.ts";

const NOW = 1_000_000;
function fake(): ReadingStore & { marks: Map<string, number> } {
  const marks = new Map<string, number>();
  return { marks, caughtUpAt: () => null, saveCaughtUp: () => {}, readMarks: () => Object.fromEntries(marks), saveReadMark: (c, at) => { marks.set(c, at); }, mutedConversations: () => [], setMuted: () => {} };
}
describe("ReadingService with a node ahead", () => {
  it("reading the newest message keeps its time as the mark, and a fast device is still clamped", () => {
    const store = fake();
    const svc = new ReadingService(store, () => NOW, c => (c === "fast" ? NOW + 10_000 : null));
    const told: unknown[] = [];
    svc.subscribe(e => told.push(e));
    svc.read("fast", NOW + 10_000);
    expect(store.marks.get("fast")).toBe(NOW + 10_000);
    svc.read("fast", NOW + 99_999);
    expect(store.marks.get("fast")).toBe(NOW + 10_000);                  // not past the newest message
    svc.read("even", NOW + 99_999);
    expect(store.marks.get("even")).toBe(NOW);                           // no newer message than the hub's clock: as before
    expect(told).toHaveLength(2);
  });
});
