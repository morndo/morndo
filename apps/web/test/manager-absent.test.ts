// The manager always on the list (the owner, 2026-10-12), in the app's own logic: its chat follows it across a restart
// (by name, to the not-running row and back), its row says it isn't running, and what was written while it had no window
// is ended by the echo in its next window's conversation.
import { describe, expect, it } from "vitest";
import { Outbox } from "../src/lib/outbox/outbox.ts";
import { memoryStore } from "../src/lib/outbox/store.ts";
import { keptChat } from "../src/lib/phone/chat/history.ts";
import { chatRows } from "../src/lib/phone/chat/rows.ts";
import { ABSENT_MANAGER, absentManager, sentTo } from "../src/lib/manager.ts";

const lane = (id: string, name: string) => ({ ...absentManager(), id: id as never, name });

describe("the manager's chat across a restart", () => {
  it("follows it by name: its window gone, to the not-running row; back, to the new window; another lane's just closes", () => {
    const gone = [absentManager(), lane("%1", "alpha")];
    expect(keptChat("%0", gone, true, "manager")).toBe(ABSENT_MANAGER);
    expect(keptChat(ABSENT_MANAGER, [lane("%7", "manager"), lane("%1", "alpha")], true, "manager")).toBe("%7");
    expect(keptChat("%3", gone, true, "beta")).toBeNull();
    expect(keptChat("%1", gone, true, "alpha")).toBe("%1");
  });
});

describe("its row", () => {
  it("is pinned first and says it isn't running", () => {
    const rows = chatRows({ workers: [lane("%1", "alpha"), absentManager()], chats: {}, decisions: [], muted: [], now: 1 });
    expect(rows.map(r => r.name)).toEqual(["manager", "alpha"]);
    expect(rows[0]).toMatchObject({ worker: ABSENT_MANAGER, preview: "Not running: a message waits for it", status: { label: "Not running" } });
  });
});

describe("what was written while it had no window", () => {
  it("belongs to the manager's conversation only, and its echo in the next window's conversation ends it", async () => {
    expect(sentTo({ worker: ABSENT_MANAGER }, { id: "%7", name: "manager" })).toBe(true);
    expect(sentTo({ worker: ABSENT_MANAGER }, { id: "%1", name: "alpha" })).toBe(false);      // negative control
    const o = new Outbox({
      store: memoryStore(), post: async () => ({ kind: "typed" }),
      timers: { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>) },
      connected: () => true, onChange: () => {},
    });
    await o.start();
    o.activate();
    const r = await o.enqueue({ worker: ABSENT_MANAGER, workerName: "manager", text: "while it restarts", uploads: [], seen: "none" });
    await expect.poll(() => o.records.find(x => x.id === r.id)?.state).toBe("sent");
    await o.echoes("%1", [{ id: "m1", at: Date.now() + 1, text: "while it restarts" }], "alpha");
    expect(o.records.some(x => x.id === r.id)).toBe(true);                                      // another lane's echo: kept
    await o.echoes("%7", [{ id: "m2", at: Date.now() + 1, text: "while it restarts" }], "manager");
    expect(o.records.some(x => x.id === r.id)).toBe(false);
    o.stop();
  });
});
