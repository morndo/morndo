// Lane events from hooks (fleet clients spec §6, §7): both body forms (Claude Code's and the owner's scripts'), kira's
// STATUS rule, first line, error and question rules, verbatim; none without a window, for the manager's own lane or an
// ignored one; today's JSON line shape, key order included; a batch split at 8000 characters (Review Focus 4). S3: the
// limit tap (plan 4.5 item 4), read before the manager and ignore filters, so a limit failure of the manager's own
// window or an ignored one is a tap even though it makes no lane event.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HookEvent, LaneEvent } from "@morndo/protocol";
import { LaneEvents, firstLineOf, globMatcher, laneEventOf, lineOf, partsOf, rulesOf, statusOf } from "../src/application/lane-events.ts";
import { EventHub } from "../src/application/events.ts";
import { openFleetDb } from "../src/adapters/db.ts";
import { LaneEventsStore } from "../src/adapters/lane-events-store.ts";
import { quiet } from "./helpers/fleet.ts";
import { tempDir } from "./helpers/temp.ts";

const AT = Date.parse("2026-10-08T17:17:06.086Z");
const SID = "45460920-67e6-4bea-8c1d-2f3a4b5c6d7e";
const hook = (path: HookEvent["path"], body: unknown, window: string | null = "studio"): HookEvent =>
  ({ streamId: "3f0c1d2e-1111-4222-8333-444455556666", seq: 1, at: AT, path, node: "pc", window, body });
const RULES = rulesOf({ deliverTo: "manager", header: "h", ignore: ["pooltest*", "pool-probe*"], batchMs: 3000 });
const base = { v: 1, t: "lane", node: "pc", window: "studio", lane: "studio", at: AT, sessionId: SID };
const KEY = `sk-ant-api03-${"a".repeat(24)}`;                                          // synthetic key shapes
const TOKEN = `ghp_${"b".repeat(36)}`;

describe("lane events from hooks", () => {
  it("finished from Claude Code's Stop body: the first line, its status, background tasks and crons counted", () => {
    const body = { session_id: SID, hook_event_name: "Stop", last_assistant_message: "\n  \n  STATUS: DONE — the parser ships\nmore", background_tasks: [{}, {}], session_crons: [{}] };
    // A task with neither type nor description is a "task"; a cron with no schedule is no wake-up (pendingOf).
    expect(laneEventOf(hook("/hook/stop", body), RULES)).toEqual({
      ...base, event: "finished", status: "done", firstLine: "STATUS: DONE — the parser ships", bg: 2, crons: 1, tasks: [{ type: "task", label: "task" }, { type: "task", label: "task" }],
    });
  });

  it("finished keeps what the turn left pending (ADR-0032, R6): a task's type and redacted description, a wake-up's schedule; never a command or a prompt", () => {
    const body = {
      session_id: SID, hook_event_name: "Stop", last_assistant_message: "STATUS: WAITING on CI for 20 min",
      background_tasks: [
        { id: "task-1", type: "shell", status: "running", description: `Watch the CI run with ${KEY}`, command: `gh run watch --token ${TOKEN}` },
        { id: "task-2", type: "subagent", status: "running", description: `Review ${"x".repeat(200)}`, agent_type: "reviewer" },
      ],
      session_crons: [{ id: "cron-1", schedule: "*/15 * * * *", recurring: true, prompt: "check the deploy with the staging key" }],
    };
    const d = laneEventOf(hook("/hook/stop", body), RULES);
    expect(d).toMatchObject({ event: "finished", status: "waiting", bg: 2, crons: 1, wakes: [{ schedule: "*/15 * * * *", recurring: true }] });
    expect(d?.tasks?.[0]).toEqual({ type: "shell", label: "Watch the CI run with [redacted]" });
    expect(d?.tasks?.[1]?.label).toHaveLength(80);
    const wire = JSON.stringify(d);
    expect(wire).not.toContain("gh run watch");                                       // negative control: a task kept whole keeps its command
    expect(wire).not.toContain("ghp_");
    expect(wire).not.toContain(KEY);
    expect(wire).not.toContain("staging key");
    // Nothing pending: neither list.
    expect(laneEventOf(hook("/hook/stop", { session_id: SID, last_assistant_message: "Done.", background_tasks: [], session_crons: [] }), RULES)).not.toHaveProperty("tasks");
    expect(laneEventOf(hook("/hook/stop", { session_id: SID, last_assistant_message: "Done.", background_tasks: [], session_crons: [] }), RULES)).not.toHaveProperty("wakes");
  });

  it("finished from the owner's Stop script body: text, background and crons as numbers", () => {
    const body = { window: "studio", cwd: "/w", session_id: SID, branch: "main", changed: 1, ahead: 0, text: "Plain answer.", background: 1, crons: 0 };
    // A count is one placeholder each (pendingOf).
    expect(laneEventOf(hook("/hook/stop", body), RULES)).toEqual({ ...base, event: "finished", status: null, firstLine: "Plain answer.", bg: 1, crons: 0, tasks: [{ type: "task", label: "background work" }] });
    expect(laneEventOf(hook("/hook/stop", { session_id: SID }), RULES)).toEqual({ ...base, event: "finished", status: null, firstLine: "", bg: 0, crons: 0 });
  });

  it("kira's STATUS rule, verbatim, on the first line", () => {
    const cases: [string, string | null][] = [
      ["STATUS: DONE", "done"], ["status: done.", "done"], ["**STATUS: BLOCKED** on review", "blocked"], ["> STATUS - NEEDS DECISION", "needs_decision"],
      ["_STATUS_:needs decision", "needs_decision"], ["STATUS:DONE", "done"], ["STATUS: DONEish", null], ["The STATUS: DONE", null],
      ["STATUS: NEEDS  DECISION", null], ["STATUS: blocked, waiting", "blocked"], ["", null],
    ];
    for (const [line, status] of cases) expect(statusOf(line), line).toBe(status);
    expect(firstLineOf("\n\n   first  \nsecond")).toBe("first");
    expect(firstLineOf(`${"x".repeat(250)}\nsecond`)).toHaveLength(200);
  });

  it("a WAITING line: what it waits on, and until when: its own `for`, else laneWatch.waitingMin (reliable lanes §3.1)", () => {
    const waiting = (text: string) => laneEventOf(hook("/hook/stop", { session_id: SID, hook_event_name: "Stop", last_assistant_message: text }), RULES);
    expect(waiting("STATUS: WAITING on CI for 20 min")).toEqual({ ...base, event: "finished", status: "waiting", firstLine: "STATUS: WAITING on CI for 20 min", bg: 0, crons: 0, waitingOn: "CI", until: AT + 20 * 60_000 });
    expect(waiting("STATUS: WAITING")).toMatchObject({ status: "waiting", until: AT + 30 * 60_000 });
    expect(waiting("STATUS: WAITING")?.waitingOn).toBeUndefined();
    expect(statusOf("STATUS: WAITING on review")).toBe("waiting");
  });

  it("none for a Stop the relay asked to go on for its status line: the turn didn't end there", () => {
    expect(laneEventOf(hook("/hook/stop", { session_id: SID, hook_event_name: "Stop", last_assistant_message: "Pushed.", statusAsked: true }), RULES)).toBeNull();
    expect(laneEventOf(hook("/hook/stop", { session_id: SID, hook_event_name: "Stop", last_assistant_message: "Pushed.", statusAsked: false }), RULES)).toMatchObject({ event: "finished" });
  });

  it("stop_failure from either form: error_type, else error, else unknown, at most 60 characters", () => {
    expect(laneEventOf(hook("/hook/failure", { session_id: SID, hook_event_name: "StopFailure", error_type: "rate_limit" }), RULES)).toEqual({ ...base, event: "stop_failure", error: "rate_limit" });
    expect(laneEventOf(hook("/hook/failure", { window: "studio", session_id: SID, error: "overloaded" }), RULES)).toMatchObject({ error: "overloaded" });
    expect(laneEventOf(hook("/hook/failure", { session_id: SID }), RULES)).toMatchObject({ error: "unknown" });
    expect(laneEventOf(hook("/hook/failure", { error: "e".repeat(90) }), RULES)).toMatchObject({ error: "e".repeat(60) });
  });

  it("needs_input and answered from a node's /lane event; the question at most 200 characters; another event name makes none", () => {
    expect(laneEventOf(hook("/lane", { event: "needs_input", sessionId: SID, question: "Which branch?" }), RULES)).toEqual({ ...base, event: "needs_input", question: "Which branch?" });
    expect(laneEventOf(hook("/lane", { event: "needs_input", sessionId: null, question: "q".repeat(300) }), RULES)).toEqual({ v: 1, t: "lane", node: "pc", window: "studio", lane: "studio", at: AT, event: "needs_input", question: "q".repeat(200) });
    expect(laneEventOf(hook("/lane", { event: "answered", sessionId: SID }), RULES)).toEqual({ ...base, event: "answered" });
    expect(laneEventOf(hook("/lane", { event: "exploded", sessionId: SID }), RULES)).toBeNull();
  });

  it("none for a hook without a window, the manager's own lane, an ignored lane, or another path", () => {
    expect(laneEventOf(hook("/hook/stop", { text: "x" }, null), RULES)).toBeNull();
    expect(laneEventOf(hook("/hook/stop", { text: "x" }, "manager"), RULES)).toBeNull();
    expect(laneEventOf(hook("/hook/stop", { text: "x" }, "pooltest-3"), RULES)).toBeNull();
    expect(laneEventOf(hook("/hook/stop", { text: "x" }, "pool-probe"), RULES)).toBeNull();
    expect(laneEventOf(hook("/hook/stop", { text: "x" }, "pool"), RULES)).not.toBeNull();
    expect(laneEventOf(hook("/cc", { session_id: SID }), RULES)).toBeNull();
    expect(laneEventOf(hook("/notify", "words"), RULES)).toBeNull();
    expect(laneEventOf(hook("/hook/stop", { text: "x" }, "manager"), rulesOf({ deliverTo: null, header: "h", ignore: [], batchMs: 3000 }))).not.toBeNull();
  });

  it("globs: * any run, ? one character, everything else literal", () => {
    expect(["pooltest", "pooltest-1", "x"].map(n => globMatcher("pooltest*").test(n))).toEqual([true, true, false]);
    expect(["a.b", "axb"].map(n => globMatcher("a.b").test(n))).toEqual([true, false]);
    expect(["lane-1", "lane-12"].map(n => globMatcher("lane-?").test(n))).toEqual([true, false]);
  });
});

describe("the manager's message", () => {
  const ev = (seq: number, over: Partial<LaneEvent> = {}): LaneEvent =>
    ({ v: 1, t: "lane", seq, node: "pc", window: "studio", lane: "studio", sessionId: SID, at: AT, event: "finished", status: "done", firstLine: "STATUS: DONE", bg: 0, crons: 0, ...over });

  it("one JSON line per event in today's shape, key order included", () => {
    expect(lineOf(ev(1))).toBe(`{"ts":"2026-10-08T17:17:06.086Z","lane":"studio","sessionId":"${SID}","event":"finished","status":"done","firstLine":"STATUS: DONE","bg":0,"crons":0}`);
    expect(lineOf(ev(2, { event: "needs_input", question: "Which?", status: undefined as never }))).toBe(`{"ts":"2026-10-08T17:17:06.086Z","lane":"studio","sessionId":"${SID}","event":"needs_input","question":"Which?"}`);
    const { sessionId: _, ...noSession } = ev(3, { event: "stop_failure", error: "rate_limit" });
    expect(lineOf(noSession)).toBe('{"ts":"2026-10-08T17:17:06.086Z","lane":"studio","event":"stop_failure","error":"rate_limit"}');
    expect(lineOf(ev(3, { status: "waiting", firstLine: "STATUS: WAITING on CI", waitingOn: "CI", until: AT + 60_000 }))).toBe(
      `{"ts":"2026-10-08T17:17:06.086Z","lane":"studio","sessionId":"${SID}","event":"finished","status":"waiting","firstLine":"STATUS: WAITING on CI","bg":0,"crons":0,"waitingOn":"CI","until":"2026-10-08T17:18:06.086Z"}`);
    expect(lineOf(ev(4, { event: "stale", status: undefined as never, firstLine: undefined as never, bg: undefined as never, crons: undefined as never, reason: "no_status", since: AT - 60_000, stalls: 2 }))).toBe(
      `{"ts":"2026-10-08T17:17:06.086Z","lane":"studio","sessionId":"${SID}","event":"stale","reason":"no_status","since":"2026-10-08T17:16:06.086Z","stalls":2}`);
  });

  it("splits a batch over 8000 characters into parts of at most 8000, each with the header, in order (Review Focus 4)", () => {
    const header = "[lane-event] Lane events (handle them as your instructions say):";
    const events = Array.from({ length: 60 }, (_, i) => ev(i + 1, { firstLine: `${i} ${"w".repeat(195)}` }));
    const parts = partsOf(events, header);
    expect(parts.length).toBeGreaterThan(1);                                          // negative control: one part of ~20,000
    for (const p of parts) {
      expect(p.text.length).toBeLessThanOrEqual(8000);
      expect(p.text.split("\n")[0]).toBe(header);
      expect(p.text.split("\n").slice(1)).toEqual(p.events.map(lineOf));
    }
    expect(parts.flatMap(p => p.events.map(e => e.seq))).toEqual(events.map(e => e.seq));
    expect(partsOf(events.slice(0, 3), header)).toHaveLength(1);
  });
});

// The usage tap (S3, plan 4.5 item 4): read inside the intake's transaction before any lane-event filter, so a limit
// failure is a tap even where it makes no lane event — the manager's own window, an ignored one — while a failure that
// is no limit at all and a stop are no tap.
describe("the usage tap", () => {
  const takeWith = (window: string | null, body: unknown, path: HookEvent["path"] = "/hook/failure") => {
    const db = openFleetDb(join(tempDir(), "fleet.db"));
    const lanes = new LaneEvents({ store: new LaneEventsStore(db), events: new EventHub(), config: { deliverTo: "manager", header: "h", ignore: ["pooltest*"], batchMs: 3000 }, log: quiet });
    const r = lanes.take(hook(path, body, window));
    const rows = db.prepare("SELECT seq FROM lane_events").all();
    db.close();
    return { r, rows };
  };

  it("the manager's failure reaches the limit tap but makes no lane event", () => {
    for (const window of ["manager", "pooltest-3"]) {
      const { r, rows } = takeWith(window, { session_id: SID, error_type: "rate_limit" });
      expect(r, window).toEqual({ event: null, own: false, limit: { kind: "failure", lane: window, window, sessionId: SID, error: "rate_limit", account: null, at: AT } });
      expect(rows, window).toEqual([]);
    }
  });

  it("a failure that is no limit, and a stop, make no tap; a body without a readable account taps with none", () => {
    expect(takeWith("studio", { session_id: SID, error_type: "overloaded" }).r.limit).toBeNull();
    expect(takeWith("studio", { session_id: SID, text: "x" }, "/hook/stop").r.limit).toBeNull();
    expect(takeWith("api", { session_id: SID, error_type: "rate_limit", account: 42 }).r.limit).toEqual({ kind: "failure", lane: "api", window: "api", sessionId: SID, error: "rate_limit", account: null, at: AT });
  });
});
