// A replay window that meets a subscriber's full backlog (B6 EF3). Each event counted the subscriber's pending rows and
// looked for the oldest pending progress event with a sort of every pending row, all inside the intake's IMMEDIATE
// transaction: 4 to 8 s for one 256-event window at the 50,000 cap, the whole service stopped and fleet.db's write
// lock held throughout. The window is now counted once and searched in outbox order through a partial index of the
// pending rows (https://www.sqlite.org/partialindex.html), each search going on from where the last one stopped. What
// is dropped and what is dead-lettered stays as it was. The cap is 20,000 here, to keep the fill short.
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import type { HookEvent } from "@morndo/protocol";
import { Audit } from "../src/adapters/audit.ts";
import { openFleetDb } from "../src/adapters/db.ts";
import { OutboxStore } from "../src/adapters/outbox-store.ts";
import { HookIntake } from "../src/application/hook-intake.ts";
import { tempDir } from "./helpers/temp.ts";

const CAP = 20_000;
const body = { pad: "x".repeat(600) };
const ev = (seq: number, path: HookEvent["path"]): HookEvent => ({ streamId: "s1", seq, at: 1_700_000_000_000 + seq, path, node: "pc", window: "api", body });

// A subscriber `behind` events behind (the cap by default): one stream, `path` throughout, in the rows the intake writes.
function atCap(path: HookEvent["path"], behind = CAP) {
  const db = openFleetDb(join(tempDir(), "fleet.db"));
  const store = new OutboxStore(db);
  const subscribers = [{ name: "kira", url: "http://127.0.0.1:9/never", paths: ["/sl", "/hook/stop"] as HookEvent["path"][] }];
  const intake = new HookIntake({ store, subscribers, audit: new Audit(db), cap: CAP });
  const insO = db.prepare("INSERT INTO outbox (node, stream_id, seq, path, body, created_at) VALUES ('pc', 's1', ?, ?, ?, 0)");
  const insD = db.prepare("INSERT INTO deliveries (outbox_id, subscriber, state, attempts, next_at, delivered_at) VALUES (?, 'kira', 'pending', 0, 0, NULL)");
  db.transaction(() => {
    for (let seq = 1; seq <= behind; seq++) insD.run(Number(insO.run(seq, path, JSON.stringify(ev(seq, path))).lastInsertRowid));
    db.prepare("INSERT INTO stream_hwm (node, stream_id, seq) VALUES ('pc', 's1', ?)").run(behind);
  })();
  return { db, store, intake };
}

const timed = (f: () => void) => { const t = performance.now(); f(); return performance.now() - t; };

describe("a replay window at a full backlog", () => {
  it("nothing to drop: 256 dead letters, stored in well under a second", () => {
    const { db, store, intake } = atCap("/hook/stop");
    const ms = timed(() => intake.accept("pc", "s1", Array.from({ length: 256 }, (_, i) => ev(CAP + 1 + i, "/hook/stop"))));
    expect(store.states("kira")).toEqual({ pending: CAP, dead: 256 });
    expect(store.deadLetters("kira").map(d => d.reason)).toEqual(Array(256).fill("backlog_full"));
    expect(ms).toBeLessThan(500);                                        // one sort per event took 2-3 s here
    db.close();
  }, 60_000);

  it("progress events give way, oldest first: the 256 oldest dropped, the window kept, in well under a second", () => {
    const { db, store, intake } = atCap("/sl");
    const ms = timed(() => intake.accept("pc", "s1", Array.from({ length: 256 }, (_, i) => ev(CAP + 1 + i, "/hook/stop"))));
    expect(store.states("kira")).toEqual({ pending: CAP, dropped: 256 });
    const dropped = db.prepare("SELECT o.seq FROM deliveries d JOIN outbox o ON o.id = d.outbox_id WHERE d.state = 'dropped' ORDER BY o.seq").all() as { seq: number }[];
    expect(dropped.map(r => r.seq)).toEqual(Array.from({ length: 256 }, (_, i) => i + 1));
    expect(ms).toBeLessThan(500);
    db.close();
  }, 60_000);

  it("a window that fills the backlog: its own progress events, stored below the cap, give way first once it is full", () => {
    const { db, store, intake } = atCap("/hook/stop", CAP - 2);
    intake.accept("pc", "s1", [ev(CAP - 1, "/sl"), ev(CAP, "/sl"), ev(CAP + 1, "/hook/stop"), ev(CAP + 2, "/hook/stop"), ev(CAP + 3, "/hook/stop")]);
    const rows = db.prepare("SELECT o.seq, d.state FROM deliveries d JOIN outbox o ON o.id = d.outbox_id WHERE o.seq >= ? ORDER BY o.seq").all(CAP - 1) as { seq: number; state: string }[];
    expect(rows).toEqual([
      { seq: CAP - 1, state: "dropped" }, { seq: CAP, state: "dropped" },
      { seq: CAP + 1, state: "pending" }, { seq: CAP + 2, state: "pending" }, { seq: CAP + 3, state: "dead" },
    ]);
    expect(store.states("kira")).toEqual({ pending: CAP, dropped: 2, dead: 1 });
    db.close();
  }, 60_000);
});
