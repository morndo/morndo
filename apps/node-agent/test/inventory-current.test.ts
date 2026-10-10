// The inventory is read again only when it is older than the caller allows (EF7): pane.captureMany asks every hub poll.
import { describe, expect, it } from "vitest";
import { Inventory } from "../src/ops/inventory.ts";

function inventory() {
  let reads = 0;
  const inv = new Inventory({ node: "n1", session: "qa", socket: `no-such-server-${process.pid}`, sessions: () => { reads++; return new Map(); }, stamp: async () => null });
  return { inv, reads: () => reads };
}
describe("Inventory.current", () => {
  it("reads once, then serves the snapshot while it is young enough", async () => {
    const { inv, reads } = inventory();
    const first = await inv.current(60_000);
    expect(await inv.current(60_000)).toBe(first);
    expect(await inv.current(60_000)).toBe(first);
    expect(reads()).toBe(1);
  });
  it("reads again when the snapshot is older than asked (negative control)", async () => {
    const { inv, reads } = inventory();
    await inv.current(60_000);
    await new Promise(r => setTimeout(r, 5));
    await inv.current(0);
    expect(reads()).toBe(2);
  });
  it("refresh() always reads", async () => {
    const { inv, reads } = inventory();
    await inv.refresh(); await inv.refresh();
    expect(reads()).toBe(2);
  });
});
