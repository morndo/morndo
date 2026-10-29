// The relay's one question per turn (reliable lanes §3.1): which Stop bodies are asked for a status line, and, over real
// HTTP, that an asked Stop is answered {"decision":"block","reason"} and kept marked statusAsked (its answer still reaches
// subscribers), while the Stop that follows (Claude Code's stop_hook_active) is kept as the turn's end. And W1 (ADR-0032):
// which WAITING Stops are asked for a waker instead, with the node's real job store behind the job check over HTTP.
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StatusContract } from "../src/config.ts";
import { openAgentDb, type AgentDb } from "../src/db/open.ts";
import { JobStore } from "../src/ops/job-store.ts";
import { nodeOpener } from "../src/ops/node-files.ts";
import { agentPaths } from "../src/paths.ts";
import { RelayFiles } from "../src/relay/relay-files.ts";
import { startRelay, type Relay } from "../src/relay/server.ts";
import { Spool } from "../src/relay/spool.ts";
import { STATUS_ASK, statusAsk, wakerAsk, type JobsOf } from "../src/relay/status-ask.ts";
import { captureLog, tempHome } from "./helpers.ts";

const ASK: StatusContract = { mode: "ask", exempt: ["manager"] };
const stop = (over: Record<string, unknown> = {}) => ({
  session_id: "s1", hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "I pushed the branch.", background_tasks: [], session_crons: [], ...over,
});

describe("which Stops are asked", () => {
  it("a lane's Claude Code Stop whose answer states no status, with nothing running or scheduled", () => {
    expect(statusAsk(stop(), "api", ASK)).toBe(STATUS_ASK);
    expect(STATUS_ASK).toContain("STATUS: WAITING <on what> for <N> min");
  });

  it("never: a status line, stop_hook_active, background work, a wake-up, an exempt or unplaced window, mode off, another body", () => {
    expect(statusAsk(stop({ last_assistant_message: "STATUS: DONE\nMerged." }), "api", ASK)).toBeNull();
    expect(statusAsk(stop({ last_assistant_message: "**Status: waiting** on CI for 10 min" }), "api", ASK)).toBeNull();
    expect(statusAsk(stop({ stop_hook_active: true }), "api", ASK)).toBeNull();          // once per turn
    expect(statusAsk(stop({ background_tasks: [{ id: "b1", status: "running" }] }), "api", ASK)).toBeNull();
    expect(statusAsk(stop({ session_crons: [{ id: "c1" }] }), "api", ASK)).toBeNull();
    expect(statusAsk(stop(), "manager", ASK)).toBeNull();
    expect(statusAsk(stop(), null, ASK)).toBeNull();
    expect(statusAsk(stop(), "api", { mode: "off", exempt: [] })).toBeNull();
    expect(statusAsk(stop({ hook_event_name: "SubagentStop" }), "api", ASK)).toBeNull();
    expect(statusAsk({ window: "api", text: "no status", background: 0 }, "api", ASK)).toBeNull();   // the owner's script's body
    expect(statusAsk(stop({ last_assistant_message: undefined }), "api", ASK)).toBeNull();
    expect(statusAsk("text", "api", ASK)).toBeNull();
  });
});

describe("W1: which WAITING Stops are asked for a waker", () => {
  const WAIT = "STATUS: WAITING on CI for 10 min\nI pushed the branch; CI runs now.";
  const none: JobsOf = () => 0;
  const waiting = (over: Record<string, unknown> = {}) => stop({ last_assistant_message: WAIT, ...over });

  it("a WAITING answer with no background task, no wake-up and no job of the lane, once", () => {
    const reason = statusAsk(waiting(), "builder", ASK, none);
    expect(reason).toBe(wakerAsk("builder", "CI"));
    expect(reason).toContain("This lane says it waits on CI, but nothing will wake it");
    expect(reason).toContain("ScheduleWakeup or CronCreate");
    expect(reason).toContain("morndo job start --notify lane:builder -- <command>");
    expect(reason).toContain("STATUS: DONE, STATUS: BLOCKED or STATUS: NEEDS DECISION");
    expect(reason).toContain("Then end the turn with your status line again.");
    expect(reason).not.toContain("\n");                                     // one short paragraph
    expect(statusAsk(waiting({ stop_hook_active: true }), "builder", ASK, none)).toBeNull();   // the Stop after it: once per turn
    expect(statusAsk(stop({ last_assistant_message: "STATUS: WAITING for 5 min" }), "builder", ASK, none)).toBe(wakerAsk("builder"));
    expect(wakerAsk("builder")).toContain("This lane says it waits, but nothing will wake it");
  });

  it("never when a background task or a wake-up is pending, or a job of the lane is open; a job of another lane doesn't count", () => {
    expect(statusAsk(waiting({ background_tasks: [{ id: "b1", type: "shell", status: "running", description: "CI" }] }), "builder", ASK, none)).toBeNull();
    expect(statusAsk(waiting({ session_crons: [{ id: "c1", schedule: "7 12 * * *", recurring: false }] }), "builder", ASK, none)).toBeNull();
    const lanes: string[] = [];
    const jobs = (open: Record<string, number>): JobsOf => lane => { lanes.push(lane); return open[lane] ?? 0; };
    expect(statusAsk(waiting(), "builder", ASK, jobs({ builder: 1 }))).toBeNull();          // negative control: w1-jobs
    expect(statusAsk(waiting(), "builder", ASK, jobs({ alpha: 2 }))).toBe(wakerAsk("builder", "CI"));
    expect(lanes).toEqual(["builder", "builder"]);                             // asked by the Stop's own window
    expect(statusAsk(waiting(), "builder", ASK, () => null)).toBeNull();      // the node can't tell
    expect(statusAsk(waiting(), "builder", ASK)).toBeNull();                  // no job check wired
  });

  it("never the exempt orchestrator, after a Stop-hook continuation, with mode off, or for another hook", () => {
    expect(statusAsk(waiting(), "manager", ASK, none)).toBeNull();            // negative control: w1-exempt
    expect(statusAsk(waiting({ stop_hook_active: true }), "builder", ASK, none)).toBeNull();
    expect(statusAsk(waiting(), "builder", { mode: "off", exempt: [] }, none)).toBeNull();
    expect(statusAsk(waiting(), null, ASK, none)).toBeNull();
    expect(statusAsk(waiting({ hook_event_name: "SubagentStop" }), "builder", ASK, none)).toBeNull();
  });

  it("never when the task registry wasn't read: background_tasks or session_crons missing or not an array", () => {
    const { background_tasks: _b, ...noTasks } = waiting();
    const { session_crons: _c, ...noCrons } = waiting();
    expect(statusAsk(noTasks, "builder", ASK, none)).toBeNull();              // negative control: w1-empty-arrays
    expect(statusAsk(noCrons, "builder", ASK, none)).toBeNull();
    expect(statusAsk(waiting({ background_tasks: null }), "builder", ASK, none)).toBeNull();
    expect(statusAsk(waiting({ background_tasks: {} }), "builder", ASK, none)).toBeNull();
    expect(statusAsk(waiting({ session_crons: "none" }), "builder", ASK, none)).toBeNull();
  });

  it("never for a settled status; and the status ask is as it was, whatever the jobs (it keeps priority)", () => {
    for (const line of ["STATUS: DONE\nMerged.", "STATUS: BLOCKED on the key", "STATUS: NEEDS DECISION: which base?"]) {
      expect(statusAsk(stop({ last_assistant_message: line }), "builder", ASK, none)).toBeNull();
    }
    const { background_tasks: _b, ...noTasks } = stop();
    for (const jobsOf of [none, () => 1, () => null]) {
      expect(statusAsk(stop(), "builder", ASK, jobsOf)).toBe(STATUS_ASK);     // no status line at all: the status ask
      expect(statusAsk(noTasks, "builder", ASK, jobsOf)).toBe(STATUS_ASK);    // a missing registry never stopped it
      expect(statusAsk(stop({ background_tasks: [{ id: "b1" }] }), "builder", ASK, jobsOf)).toBeNull();
      expect(statusAsk(stop(), "manager", ASK, jobsOf)).toBeNull();
    }
  });
});

describe("the relay asks over HTTP", () => {
  let home: { home: string; cleanup: () => void };
  let adb: AgentDb;
  let spool: Spool;
  let relay: Relay;
  let jobs: JobStore;
  let window = "api";
  beforeEach(async () => {
    home = tempHome();
    const paths = agentPaths(home.home);
    adb = openAgentDb(paths.dbPath);
    spool = new Spool(adb.db, adb.streamId, { now: () => 1_000 });
    const files = new RelayFiles({ dir: paths.relayFilesDir, db: adb.db, open: nodeOpener({ home: home.home, stateDir: paths.stateDir, configDir: paths.configDir }), now: () => 1_000 });
    jobs = new JobStore(adb.db, join(paths.stateDir, "job-logs"), () => 1_000, { home: home.home });
    window = "api";
    relay = await startRelay({
      port: 0, spool, files, log: captureLog().log, onAppended: () => {}, now: () => 1_000,
      windowOf: () => window, ask: (body, w) => statusAsk(body, w, ASK, lane => jobs.openFor(lane)),
    });
  });
  afterEach(async () => { await relay.close(); adb.close(); home.cleanup(); });
  const post = (body: unknown) => fetch(`http://127.0.0.1:${relay.port}/hook/stop`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("blocks the first Stop and keeps it marked statusAsked; the one Claude Code sends after is kept as it is (negative control: a status line is not asked)", async () => {
    const asked = await post(stop());
    expect(asked.status).toBe(200);
    expect(asked.headers.get("content-type")).toBe("application/json");
    expect(await asked.json()).toEqual({ decision: "block", reason: STATUS_ASK });
    expect(spool.after(0, 10).map(e => e.body)).toEqual([{ ...stop(), statusAsked: true }]);
    const after = await post(stop({ stop_hook_active: true, last_assistant_message: "STATUS: DONE\nPushed." }));
    expect(await after.json()).toEqual({ ok: true, queued: true });
    const plain = await post(stop({ last_assistant_message: "STATUS: BLOCKED on the key" }));
    expect(await plain.json()).toEqual({ ok: true, queued: true });
    expect(spool.after(0, 10).map(e => (e.body as { statusAsked?: boolean }).statusAsked ?? false)).toEqual([true, false, false]);
  });

  const start = (id: string, lane: string, notify = lane) => {
    const r = jobs.accept({ id, lane, name: "ci", jobClass: "default", notify: { kind: "lane", name: notify }, commandHash: "a".repeat(64), cwdHash: "a".repeat(64) });
    if (!r.ok) throw new Error(r.error);
  };

  it("W1: blocks a WAITING Stop with nothing to wake it, keeps it marked statusAsked, and keeps the Stop after it as the turn end", async () => {
    window = "builder";
    const wait = stop({ last_assistant_message: "STATUS: WAITING on CI for 10 min" });
    const asked = await post(wait);
    expect(asked.status).toBe(200);
    expect(asked.headers.get("content-type")).toBe("application/json");
    expect(await asked.json()).toEqual({ decision: "block", reason: wakerAsk("builder", "CI") });
    expect(spool.after(0, 10).map(e => e.body)).toEqual([{ ...wait, statusAsked: true }]);
    const after = await post(stop({ stop_hook_active: true, last_assistant_message: "STATUS: WAITING on CI for 10 min" }));
    expect(await after.json()).toEqual({ ok: true, queued: true });
    expect(spool.after(0, 10).map(e => (e.body as { statusAsked?: boolean }).statusAsked ?? false)).toEqual([true, false]);
  });

  it("W1 reads the node's job store: a queued, starting or running job of the lane (started by it or notifying it) means no ask, another lane's does not", async () => {
    window = "builder";
    const wait = stop({ last_assistant_message: "STATUS: WAITING on the build" });
    start("other", "alpha");
    expect(await (await post(wait)).json()).toEqual({ decision: "block", reason: wakerAsk("builder", "the build") });
    start("pack", "builder");                                                  // queued
    expect(await (await post(wait)).json()).toEqual({ ok: true, queued: true });
    await jobs.applySchedule({ default: 4 }, "off");                           // starting
    expect(jobs.get("pack")?.state).toBe("starting");
    expect(await (await post(wait)).json()).toEqual({ ok: true, queued: true });
    expect(jobs.started("pack").ok).toBe(true);                                // running
    expect(await (await post(wait)).json()).toEqual({ ok: true, queued: true });
    expect((await jobs.settle("pack", { outcome: "exited", exitCode: 0, durationMs: 10 })).ok).toBe(true);
    expect(await (await post(wait)).json()).toEqual({ decision: "block", reason: wakerAsk("builder", "the build") });
    start("for-builder", "alpha", "builder");                                  // another lane's job whose notice comes here
    expect(await (await post(wait)).json()).toEqual({ ok: true, queued: true });
    expect(spool.after(0, 10).map(e => (e.body as { statusAsked?: boolean }).statusAsked ?? false)).toEqual([true, false, false, false, true, false]);
  });
});
