// job.cancel uses the lane the token belongs to (step 5). A mismatch is not_yours and leaves every cached hash.
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StartBody } from "@morndo/domain";
import { openAgentDb, type AgentDb } from "../src/db/open.ts";
import { DoneKeys } from "../src/ops/done-keys.ts";
import { OpExecutor } from "../src/ops/executor.ts";
import { JobGrants } from "../src/ops/job-grant.ts";
import { jobOps } from "../src/ops/job-ops.ts";
import { JobStore } from "../src/ops/job-store.ts";
import { captureLog, tempHome } from "./helpers.ts";

const HASH = "b".repeat(64);
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const body = (lane: string): StartBody => ({
  id: "job-1", lane, name: "pack", jobClass: "default",
  notify: { kind: "lane", name: lane }, commandHash: HASH, cwdHash: HASH,
});

const open: { adb: AgentDb; cleanup: () => void }[] = [];
afterEach(() => { for (const o of open.splice(0)) { o.adb.close(); o.cleanup(); } });

describe("job.cancel", () => {
  it("cancels only the token's lane, and a mismatch clears nothing", async () => {
    const h = tempHome();
    const adb = openAgentDb(join(h.home, "agent.db"));
    open.push({ adb, cleanup: h.cleanup });
    const grants = new JobGrants(adb.db, () => 1_700_000_000_000);
    grants.remember("builder", hash("tok-builder"));
    grants.remember("reviewer", hash("tok-reviewer"));
    const store = new JobStore(adb.db, join(h.home, "job-logs"), () => 1_700_000_000_000, { home: h.home });
    expect(store.accept(body("builder")).ok).toBe(true);
    const cancelled: string[] = [];
    const executor = new OpExecutor({
      ops: jobOps({
        notice: async () => ({ ok: true, typed: true }),
        laneOf: token => grants.laneOf(token),
        lane: id => store.get(id)?.lane ?? null,
        cancel: async id => { cancelled.push(id); return { ok: true }; },
      }),
      allowed: new Set(["job.cancel"]),
      doneKeys: new DoneKeys(adb.db),
      invVersion: () => 1,
      log: captureLog().log,
    });
    const call = (token: string, id = "job-1") => executor.handle({
      id: `r-${token}`, op: "job.cancel", args: { id, token, command: "rm -rf /", argv: ["rm"] }, timeoutMs: 5000,
    });
    const cached = () => adb.db.prepare("SELECT lane, hash FROM token_cache ORDER BY lane").all();
    const before = cached();
    expect(await call("tok-reviewer")).toMatchObject({ ok: false, error: { code: "denied", executed: "no", message: "not_yours" } });
    expect(await call("tok-unknown")).toMatchObject({ ok: false, error: { code: "denied", message: "not_yours" } });
    expect(await call("tok-builder", "missing")).toMatchObject({ ok: false, error: { code: "denied", message: "missing" } });
    expect(cancelled).toEqual([]);
    expect(cached()).toEqual(before);
    expect(await call("tok-builder")).toMatchObject({ ok: true, result: { ok: true } });
    expect(cancelled).toEqual(["job-1"]);
    expect(cached()).toEqual(before);
    const denied = new OpExecutor({
      ops: jobOps({
        notice: async () => ({ ok: true, typed: true }),
        laneOf: token => grants.laneOf(token),
        lane: id => store.get(id)?.lane ?? null,
        cancel: async id => { cancelled.push(id); return { ok: true }; },
      }),
      allowed: new Set(["inventory.get"]),
      doneKeys: new DoneKeys(adb.db),
      invVersion: () => 1,
      log: captureLog().log,
    });
    expect(await denied.handle({ id: "r-deny", op: "job.cancel", args: { id: "job-1", token: "tok-builder" }, timeoutMs: 5000 }))
      .toMatchObject({ ok: false, error: { code: "denied", executed: "no" } });
    expect(cancelled).toEqual(["job-1"]);
  });

  it("keeps an unavailable cancel retryable and a sent signal as executed", async () => {
    const h = tempHome();
    const adb = openAgentDb(join(h.home, "agent.db"));
    open.push({ adb, cleanup: h.cleanup });
    const grants = new JobGrants(adb.db, () => 1_700_000_000_000);
    grants.remember("builder", hash("tok-builder"));
    const store = new JobStore(adb.db, join(h.home, "job-logs"), () => 1_700_000_000_000, { home: h.home });
    expect(store.accept(body("builder")).ok).toBe(true);
    const run = async (error: string) => {
      const executor = new OpExecutor({
        ops: jobOps({
          notice: async () => ({ ok: true, typed: true }),
          laneOf: token => grants.laneOf(token),
          lane: id => store.get(id)?.lane ?? null,
          cancel: async () => ({ ok: false, error }),
        }),
        allowed: new Set(["job.cancel"]),
        doneKeys: new DoneKeys(adb.db),
        invVersion: () => 1,
        log: captureLog().log,
      });
      return executor.handle({
        id: `r-${error}`, op: "job.cancel", args: { id: "job-1", token: "tok-builder" }, timeoutMs: 5000,
      });
    };
    expect(await run("unavailable")).toMatchObject({ ok: false, error: { code: "busy", executed: "no", message: "unavailable" } });
    expect(await run("signalled")).toMatchObject({ ok: false, error: { code: "uncertain", executed: "maybe", message: "signalled" } });
  });
});
