// The durable hook stream (spec §5.4, §5.5): coalescing, caps (the relay's copies and the upload inbox included),
// cumulative acks, counters that survive a restart, and a database that can't be written.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAgentDb, type AgentDb } from "../src/db/open.ts";
import { Spool, type SpoolEvent } from "../src/relay/spool.ts";
import { tempHome } from "./helpers.ts";

const open: { adb: AgentDb; cleanup: () => void }[] = [];
afterEach(() => { for (const o of open.splice(0)) { o.adb.close(); o.cleanup(); } });
function db() {
  const h = tempHome();
  const adb = openAgentDb(join(h.home, "agent.db"));
  open.push({ adb, cleanup: h.cleanup });
  return adb;
}
const ev = (path: SpoolEvent["path"], session: string | null, body: unknown): SpoolEvent => ({ path, at: 1000, session, window: null, body });

describe("the spool", () => {
  it("keeps the latest progress event per session and every kept event, with growing seqs", () => {
    const adb = db();
    const s = new Spool(adb.db, adb.streamId);
    expect(s.append(ev("/cc", "a", { n: 1 }))).toEqual({ ok: true, seq: 1 });
    expect(s.append(ev("/notify", "a", { n: 2 }))).toEqual({ ok: true, seq: 2 });
    expect(s.append(ev("/cc", "a", { n: 3 }))).toEqual({ ok: true, seq: 3 });       // replaces seq 1
    expect(s.append(ev("/cc", "b", { n: 4 }))).toEqual({ ok: true, seq: 4 });
    expect(s.append(ev("/sl", "a", { n: 5 }))).toEqual({ ok: true, seq: 5 });       // /sl coalesces apart from /cc
    expect(s.after(0, 10).map(e => [e.seq, e.path, e.body])).toEqual([
      [2, "/notify", { n: 2 }], [3, "/cc", { n: 3 }], [4, "/cc", { n: 4 }], [5, "/sl", { n: 5 }],
    ]);
    expect(s.depth()).toBe(4);
  });
  it("drops progress at the cap, evicts the oldest progress for a kept event, and refuses a kept event only when that isn't enough", () => {
    const adb = db();
    const s = new Spool(adb.db, adb.streamId, { maxEvents: 3 });
    s.append(ev("/cc", "a", 1));
    s.append(ev("/notify", null, 2));
    s.append(ev("/hook/stop", null, 3));
    expect(s.append(ev("/sl", "b", 4))).toEqual({ ok: false, why: "full" });       // progress: dropped
    expect(s.drops).toBe(1);
    expect(s.append(ev("/notify", null, 5))).toMatchObject({ ok: true });         // evicts the /cc
    expect(s.after(0, 10).map(e => e.body)).toEqual([2, 3, 5]);
    expect(s.append(ev("/notify", null, 6))).toEqual({ ok: false, why: "full" }); // nothing left to evict
    expect(s.drops).toBe(2);
    const bytes = new Spool(adb.db, adb.streamId, { maxBytes: 10 });
    expect(bytes.append(ev("/notify", null, "x".repeat(20)))).toEqual({ ok: false, why: "full" });
  });
  it("a refusal changes nothing: a replaced progress row stays when its replacement doesn't fit, and counters match the table", () => {
    const adb = db();
    const s = new Spool(adb.db, adb.streamId, { maxBytes: 30 });
    expect(s.append(ev("/cc", "a", { n: 1 }))).toMatchObject({ ok: true });
    expect(s.append(ev("/cc", "a", "x".repeat(40)))).toEqual({ ok: false, why: "full" });
    expect(s.after(0, 10).map(e => e.body)).toEqual([{ n: 1 }]);
    expect(s.drops).toBe(1);
    const t = adb.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM stream").get() as { n: number; b: number };
    expect([s.depth(), s.bytes()]).toEqual([t.n, t.b]);
  });
  it("a kept event that can't fit even after evicting all progress is refused with the progress rows intact", () => {
    const adb = db();
    const s = new Spool(adb.db, adb.streamId, { maxBytes: 30 });
    s.append(ev("/cc", "a", 1));
    s.append(ev("/sl", "b", 2));
    expect(s.append(ev("/notify", null, "x".repeat(40)))).toEqual({ ok: false, why: "full" });
    expect(s.after(0, 10).map(e => e.body)).toEqual([1, 2]);
    const t = adb.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM stream").get() as { n: number; b: number };
    expect([s.depth(), s.bytes()]).toEqual([t.n, t.b]);
  });
  it("counts what the relay's copies and the upload inbox hold toward its byte budget", () => {
    const adb = db();
    let held = 90;
    const s = new Spool(adb.db, adb.streamId, { maxBytes: 100, held: () => held });
    expect(s.append(ev("/notify", null, "x".repeat(20)))).toEqual({ ok: false, why: "full" });   // 22 bytes + 90 held > 100
    held = 0;
    expect(s.append(ev("/notify", null, "x".repeat(20)))).toMatchObject({ ok: true });            // negative control
  });
  it("deletes up to an acknowledged seq, marks the relay copies those events carried, and recounts after a restart", () => {
    const adb = db();
    const s = new Spool(adb.db, adb.streamId, { now: () => 5000 });
    s.append(ev("/notify", null, 1));
    s.append(ev("/file", null, { ref: "r" }), seq => {
      adb.db.prepare("INSERT INTO relay_files (ref, file, name, size, at, seq) VALUES ('r', '/x', 'n', 1, 1, ?)").run(seq);
    });
    s.append(ev("/notify", null, 3));
    s.ack(2);
    expect(s.after(0, 10).map(e => e.seq)).toEqual([3]);
    expect(adb.db.prepare("SELECT acked_at FROM relay_files WHERE ref = 'r'").get()).toEqual({ acked_at: 5000 });
    const again = new Spool(adb.db, adb.streamId);
    expect(again.depth()).toBe(1);
    expect(again.maxSeq()).toBe(3);
    again.ack(3);
    expect([again.depth(), again.maxSeq(), again.lastSeq()]).toEqual([0, 0, 3]);   // lastSeq: the highest ever issued
  });
  it("counts what it can't write when the database refuses writes (a full disk)", () => {
    const adb = db();
    const s = new Spool(adb.db, adb.streamId);
    adb.db.pragma("query_only = ON");
    expect(s.append(ev("/hook/stop", null, 1))).toEqual({ ok: false, why: "write_failed" });
    expect(s.append(ev("/cc", "a", 2))).toEqual({ ok: false, why: "write_failed" });
    expect(s.drops).toBe(2);
    expect(s.depth()).toBe(0);
    adb.db.pragma("query_only = OFF");
    expect(s.append(ev("/hook/stop", null, 3))).toMatchObject({ ok: true });     // negative control
  });
  it("fails every write the same way when told to (the spoolFail test hook), acks included", () => {
    const adb = db();
    const s = new Spool(adb.db, adb.streamId, { failWrites: true });
    expect(s.append(ev("/hook/stop", null, 1))).toEqual({ ok: false, why: "write_failed" });
    expect(s.append(ev("/cc", "a", 2))).toEqual({ ok: false, why: "write_failed" });
    expect(s.drops).toBe(2);
    expect(() => s.ack(1)).toThrow(/spoolFail/);
    expect(new Spool(adb.db, adb.streamId).depth()).toBe(0);
  });
  it("starts sending under a new stream id after rotate()", () => {
    const adb = db();
    const s = new Spool(adb.db, adb.streamId);
    const next = randomUUID();
    s.rotate(next);
    expect(s.streamId).toBe(next);
  });
});
