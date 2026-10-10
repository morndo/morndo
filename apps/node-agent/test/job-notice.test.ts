// One notice (ADR-0017, design §4, §12 step 5). Two observations of the same exit make one delivery id.
// A second lane.deliver of that id returns the stored delivery and types nothing again.
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { noticeIdOf, parseTaskKey, type FinishEvent, type StartBody } from "@morndo/domain";
import { openAgentDb, type AgentDb } from "../src/db/open.ts";
import { deliverJobNotice, JobDeliveries } from "../src/ops/job-delivery.ts";
import { JobStore, type NoticeHandoff } from "../src/ops/job-store.ts";
import { tempHome } from "./helpers.ts";

const HASH = "a".repeat(64);
const EXIT = { outcome: "exited", exitCode: 0, durationMs: 1500 } satisfies FinishEvent;
const body = (over: Partial<StartBody> = {}): StartBody => ({
  id: "job-1", lane: "builder", name: "pack", jobClass: "default",
  notify: { kind: "lane", name: "builder" }, commandHash: HASH, cwdHash: HASH, ...over,
});

const open: { adb: AgentDb; cleanup: () => void }[] = [];
afterEach(() => { for (const o of open.splice(0)) { o.adb.close(); o.cleanup(); } });

function rig(notify: StartBody["notify"] = { kind: "lane", name: "builder" }) {
  const h = tempHome();
  const adb = openAgentDb(join(h.home, "agent.db"));
  const typed: string[] = [];
  const deliveries = new JobDeliveries(adb.db, delivery => { typed.push(delivery.id); return true; });
  const notices: NoticeHandoff[] = [];
  let store!: JobStore;
  store = new JobStore(adb.db, join(h.home, "job-logs"), () => 1_700_000_000_000, {
    home: h.home,
    onNotice: notice => {
      notices.push(notice);
      deliverJobNotice(store, deliveries, notice);
    },
  });
  open.push({ adb, cleanup: h.cleanup });
  if (!store.accept(body({ notify })).ok) throw new Error("accept");
  store.applySchedule({ default: 2 }, "off");
  if (!store.started("job-1").ok) throw new Error("started");
  return { store, deliveries, typed, notices, adb };
}

describe("one lane.deliver", () => {
  it("types the notice once and returns the same delivery the second time", () => {
    const { store, deliveries, typed, notices, adb } = rig();
    expect(store.settle("job-1", EXIT).ok).toBe(true);
    expect(store.settle("job-1", EXIT).ok).toBe(true);
    expect(notices).toHaveLength(2);
    expect(typed).toEqual([noticeIdOf("job-1")]);
    const again = deliveries.enqueue(noticeIdOf("job-1"), "builder", notices[0]?.text ?? "");
    if (again instanceof Promise) throw new Error("delivery was async");
    expect(again.ok && again.value.id).toBe(noticeIdOf("job-1"));
    expect(typed).toEqual([noticeIdOf("job-1")]);
    expect(store.get("job-1")?.notice).toBe("typed");
    store.markNotice("job-1", "queued");
    expect(store.get("job-1")?.notice).toBe("typed");
    store.markNotice("job-1", "delivered");
    expect(store.get("job-1")?.notice).toBe("delivered");
    store.markNotice("job-1", "held");
    expect(store.get("job-1")?.notice).toBe("delivered");
    const row = adb.db.prepare("SELECT id, lane, text, typed FROM job_deliveries").get() as { id: string; lane: string; text: string; typed: number };
    expect(row).toMatchObject({ id: noticeIdOf("job-1"), lane: "builder", typed: 1 });
    expect(row.text).toContain("[morndo-job] pack exited");
  });

  it("confirms an uncertain notice and leaves a delivered one where it is", () => {
    const { store } = rig();
    store.settle("job-1", EXIT);
    store.markNotice("job-1", "uncertain");
    expect(store.get("job-1")?.notice).toBe("uncertain");
    store.markNotice("job-1", "delivered");
    expect(store.get("job-1")?.notice).toBe("delivered");
    store.markNotice("job-1", "uncertain");
    store.markNotice("job-1", "given_up");
    expect(store.get("job-1")?.notice).toBe("delivered");
    const held = rig();
    held.store.settle("job-1", EXIT);
    held.store.markNotice("job-1", "held");
    held.store.markNotice("job-1", "typed");
    expect(held.store.get("job-1")?.notice).toBe("typed");
  });

  it("a second delivery with the same id and other text types nothing", () => {
    const { store, deliveries, typed, notices } = rig();
    store.settle("job-1", EXIT);
    const clash = deliveries.enqueue(noticeIdOf("job-1"), "builder", `${notices[0]?.text ?? ""} more`);
    expect(clash).toEqual({ ok: false, error: "id_conflict" });
    expect(typed).toEqual([noticeIdOf("job-1")]);
  });

  it("leaves the notice pending when the lane did not get the text", () => {
    const h = tempHome();
    const adb = openAgentDb(join(h.home, "agent.db"));
    const deliveries = new JobDeliveries(adb.db, () => false);
    let store!: JobStore;
    store = new JobStore(adb.db, join(h.home, "job-logs"), () => 1_700_000_000_000, {
      home: h.home,
      onNotice: notice => { deliverJobNotice(store, deliveries, notice); },
    });
    open.push({ adb, cleanup: h.cleanup });
    if (!store.accept(body()).ok) throw new Error("accept");
    store.applySchedule({ default: 1 }, "off");
    if (!store.started("job-1").ok) throw new Error("started");
    expect(store.settle("job-1", EXIT).ok).toBe(true);
    expect(store.get("job-1")?.notice).toBe("pending");
    expect(adb.db.prepare("SELECT typed FROM job_deliveries").get()).toEqual({ typed: 0 });
  });

  it("a fleet or task target does not type a lane delivery", () => {
    const fleet = rig({ kind: "fleet" });
    fleet.store.settle("job-1", EXIT);
    expect(fleet.typed).toEqual([]);
    const key = parseTaskKey("T-1");
    if (!key) throw new Error("task");
    const task = rig({ kind: "task", key });
    task.store.settle("job-1", EXIT);
    expect(task.typed).toEqual([]);
  });
});
