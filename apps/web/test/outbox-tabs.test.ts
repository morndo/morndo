// Two tabs share one store (IndexedDB) and tell each other of every change (review M5). Found in the rage QA (two tabs
// writing at once): a tab that wrote a message while a refresh read the store lost it from its own list until the next
// refresh, and told no other tab, so a message could wait unsent. A refresh now keeps what the tab wrote meanwhile, and
// marks its own change as one, which the device doesn't pass on (only this tab's own changes go to the others).
import { describe, expect, it } from "vitest";
import { Outbox } from "../src/lib/outbox/outbox.ts";
import { memoryStore, type OutboxStore } from "../src/lib/outbox/store.ts";
import type { OutboxRecord } from "../src/lib/outbox/state.ts";

// A store whose reads see what it held when they began, and answer only when let go: IndexedDB's readonly snapshot.
function slowReads(base: OutboxStore) {
  let release: () => void = () => {};
  let held = false;
  const store: OutboxStore = {
    ...base,
    all: async () => {
      const snapshot = await base.all();
      if (held) await new Promise<void>(r => (release = r));
      return snapshot;
    },
  };
  return { store, hold: () => { held = true; }, letGo: () => { held = false; release(); } };
}
const timers = { now: () => Date.now(), setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>) };
const cmd = (text: string) => ({ worker: "%1", workerName: "alpha", text, uploads: [], seen: "none" });

describe("two tabs, one store", () => {
  it("a message written while a refresh reads the store stays in this tab's list, and goes", async () => {
    const s = slowReads(memoryStore());
    const sent: string[] = [];
    const o = new Outbox({ store: s.store, post: async r => { sent.push(r.text); return { kind: "typed" }; }, timers, connected: () => true, onChange: () => {} });
    await o.start();
    o.activate();
    s.hold();
    const refreshing = o.refresh();                               // another tab told of a change: this tab reads the store
    const r = await o.enqueue(cmd("written mid-refresh"));
    s.letGo();
    await refreshing;
    expect(o.records.some(x => x.id === r.id)).toBe(true);
    await expect.poll(() => sent).toEqual(["written mid-refresh"]);
    o.stop();
  });

  it("its own changes are this tab's; a refresh's are not, so the device tells the others of the first only", async () => {
    const changes: { texts: string[]; fromRefresh: boolean }[] = [];
    const o = new Outbox({ store: memoryStore(), post: () => new Promise(() => {}), timers, connected: () => false,
      onChange: (rs: OutboxRecord[], fromRefresh: boolean) => { changes.push({ texts: rs.map(x => x.text), fromRefresh }); } });
    await o.start();
    changes.length = 0;
    await o.enqueue(cmd("mine"));
    await o.refresh();
    expect(changes.at(0)).toEqual({ texts: ["mine"], fromRefresh: false });
    expect(changes.at(-1)).toEqual({ texts: ["mine"], fromRefresh: true });
    o.stop();
  });
});
