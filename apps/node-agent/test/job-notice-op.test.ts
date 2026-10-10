// job.notice stores the text on this node under the id the fleet named. A second delivery of that id is the same row.
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { noticeIdOf } from "@morndo/domain";
import { openAgentDb, type AgentDb } from "../src/db/open.ts";
import { DoneKeys } from "../src/ops/done-keys.ts";
import { OpExecutor } from "../src/ops/executor.ts";
import { JobDeliveries, noticeLanded, typeJobNotice } from "../src/ops/job-delivery.ts";
import { jobOps } from "../src/ops/job-ops.ts";
import { captureLog, tempHome } from "./helpers.ts";

const open: { adb: AgentDb; cleanup: () => void }[] = [];
afterEach(() => { for (const o of open.splice(0)) { o.adb.close(); o.cleanup(); } });

describe("job.notice", () => {
  it("keeps one delivery id when the same notice arrives twice", async () => {
    const h = tempHome();
    const adb = openAgentDb(join(h.home, "agent.db"));
    open.push({ adb, cleanup: h.cleanup });
    const typed: string[] = [];
    const deliveries = new JobDeliveries(adb.db, delivery => { typed.push(delivery.id); return true; });
    const executor = new OpExecutor({
      ops: jobOps({
        notice: async (id, lane, text) => {
          const decided = await Promise.resolve(deliveries.enqueue(id, lane, text));
          if (!decided.ok) return { ok: false as const, error: "id_conflict" as const };
          return { ok: true as const, typed: decided.value.typed };
        },
        laneOf: () => null,
        lane: () => null,
        cancel: async () => ({ ok: false, error: "missing" }),
      }),
      allowed: new Set(["job.notice"]),
      doneKeys: new DoneKeys(adb.db),
      invVersion: () => 1,
      log: captureLog().log,
    });
    const id = noticeIdOf("job-1");
    const args = { id, lane: "review", text: "built" };
    expect(await executor.handle({ id: "r1", op: "job.notice", args, timeoutMs: 5000, key: id })).toMatchObject({ ok: true, result: { ok: true } });
    expect(await executor.handle({ id: "r2", op: "job.notice", args, timeoutMs: 5000, key: id })).toMatchObject({ ok: true, result: { ok: true } });
    expect(adb.db.prepare("SELECT id, lane, text FROM job_deliveries").all()).toEqual([{ id, lane: "review", text: "built" }]);
    expect(typed).toEqual([id]);
  });

  it("answers not ok until the lane has the text, and a later try can type it", async () => {
    const h = tempHome();
    const adb = openAgentDb(join(h.home, "agent.db"));
    open.push({ adb, cleanup: h.cleanup });
    let typed = false;
    const deliveries = new JobDeliveries(adb.db, () => typed);
    const executor = new OpExecutor({
      ops: jobOps({
        notice: async (id, lane, text) => {
          const decided = await Promise.resolve(deliveries.enqueue(id, lane, text));
          if (!decided.ok) return { ok: false as const, error: "id_conflict" as const };
          return { ok: true as const, typed: decided.value.typed };
        },
        laneOf: () => null, lane: () => null, cancel: async () => ({ ok: false, error: "missing" }),
      }),
      allowed: new Set(["job.notice"]),
      doneKeys: new DoneKeys(adb.db),
      invVersion: () => 1,
      log: captureLog().log,
    });
    const id = noticeIdOf("job-2");
    const args = { id, lane: "review", text: "built" };
    const call = (n: string) => executor.handle({ id: n, op: "job.notice", args, timeoutMs: 5000, key: id });
    expect(await call("r1")).toMatchObject({ ok: false, error: { executed: "no", message: "not_typed" } });
    typed = true;
    expect(await call("r2")).toMatchObject({ ok: true, result: { ok: true } });
    expect(adb.db.prepare("SELECT typed FROM job_deliveries WHERE id = ?").get(id)).toEqual({ typed: 1 });
  });

  it("treats a paste that was not submitted as delivered, and pastes that id only once", async () => {
    const h = tempHome();
    const adb = openAgentDb(join(h.home, "agent.db"));
    open.push({ adb, cleanup: h.cleanup });
    const sent: string[] = [];
    const deliveries = new JobDeliveries(adb.db, delivery => typeJobNotice(
      async () => "%7",
      async (_pane, text) => { sent.push(text); return "not_submitted"; },
      delivery,
    ));
    const id = noticeIdOf("job-3");
    const first = await Promise.resolve(deliveries.enqueue(id, "review", "built"));
    const second = await Promise.resolve(deliveries.enqueue(id, "review", "built"));
    expect(noticeLanded("not_submitted")).toBe(true);
    expect(noticeLanded(null)).toBe(true);
    expect(noticeLanded("menu_open")).toBe(false);
    if (!first.ok || !second.ok) throw new Error("id_conflict");
    expect(first.value.typed).toBe(true);
    expect(second.value.typed).toBe(true);
    expect(sent).toEqual(["built"]);
  });

  it("does not paste a notice again when the paste throws", async () => {
    const h = tempHome();
    const adb = openAgentDb(join(h.home, "agent.db"));
    open.push({ adb, cleanup: h.cleanup });
    let calls = 0;
    const deliveries = new JobDeliveries(adb.db, delivery => typeJobNotice(
      async () => "%7",
      async () => { calls += 1; throw new Error("tmux"); },
      delivery,
    ));
    const id = noticeIdOf("job-4");
    const first = await Promise.resolve(deliveries.enqueue(id, "review", "built"));
    const again = await Promise.resolve(deliveries.enqueue(id, "review", "built"));
    if (!first.ok || !again.ok) throw new Error("id_conflict");
    expect(first.value.typed).toBe(true);
    expect(again.value.typed).toBe(true);
    expect(calls).toBe(1);
  });
});
