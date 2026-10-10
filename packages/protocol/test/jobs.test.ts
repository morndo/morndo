// The job event and GET /v1/jobs (ADR-0017). A command line is not part of the decoded value.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { acceptJob, finish, fleetRecord, NOTICE_MAX } from "@morndo/domain";
import { AgentFrames, EvJob, JobsListSchema, JobsQuerySchema, LIMITS, OP_ARGS, decode, parseBody } from "../src/index.ts";

const HASH = "a".repeat(64);
const AT = 1_700_000_000_000;

const view = () => {
  const started = acceptJob(null, {
    id: "job-1", lane: "builder", name: "pack", jobClass: "default",
    notify: { kind: "lane", name: "builder" }, commandHash: HASH, cwdHash: HASH,
  }, AT);
  if (!started.ok) throw new Error(started.error);
  const done = finish({ ...started.value, state: "running" }, { outcome: "exited", exitCode: 0, durationMs: 1000 });
  if (!done.ok) throw new Error(done.error);
  return fleetRecord(done.value, { node: "box", at: AT + 1000, tail: "all good" });
};

describe("ev.job and GET /v1/jobs", () => {
  it("decodes a finished job and drops a command line", () => {
    const event = EvJob.parse({ ...view(), command: "echo secret-argv", argv: ["echo", "secret-argv"], cwd: "/tmp/secret" });
    expect(event).toMatchObject({ v: 1, t: "job", id: "job-1", node: "box", state: "exited", exit: 0, tail: "all good", task: null });
    expect(event).not.toHaveProperty("command");
    expect(event).not.toHaveProperty("argv");
    expect(event).not.toHaveProperty("cwd");
    expect(JSON.stringify(event)).not.toContain("secret-argv");
    expect(JSON.stringify(event)).toContain("all good");
  });
  it("is an agent frame, and job.cancel carries an id and a token, never a command", () => {
    const raw = { ...view(), command: "echo secret-argv", argv: ["echo"], cwd: "/tmp" };
    const decoded = decode(AgentFrames, JSON.stringify(raw));
    expect(decoded.kind).toBe("ok");
    if (decoded.kind !== "ok") return;
    expect(decoded.frame).not.toHaveProperty("command");
    expect(decoded.frame).not.toHaveProperty("argv");
    expect(JSON.stringify(decoded.frame)).not.toContain("secret-argv");
    const cancel = parseBody(OP_ARGS["job.cancel"], { id: "job-1", token: "lane-token", command: "rm -rf /", argv: ["rm"] });
    expect(cancel).toEqual({ id: "job-1", token: "lane-token" });
    expect(JSON.stringify(cancel)).not.toContain("rm");
  });
  it("refuses a tail over the delivery cap, and lists jobs with a query", () => {
    expect(NOTICE_MAX).toBe(LIMITS.maxSendText);
    expect(EvJob.safeParse({ ...view(), tail: "x".repeat(NOTICE_MAX + 1) }).success).toBe(false);
    const row = view();
    const { v, t, ...item } = row;
    const list = JobsListSchema.parse({ jobs: [item], stale: true });
    expect(list.stale).toBe(true);
    expect(list.jobs[0]?.id).toBe("job-1");
    expect(JobsQuerySchema.parse({ node: "box", state: "lost" })).toEqual({ node: "box", state: "lost" });
    expect(JobsQuerySchema.safeParse({ state: "nope" }).success).toBe(false);
    const waiting = { ...view(), state: "queued" as const, outcome: null, exit: null, durationSec: null, position: 1, reason: "load" as const, error: null };
    expect(EvJob.parse(waiting)).toMatchObject({ position: 1, reason: "load", error: null, state: "queued" });
    const { v: eventVersion, t: eventType, ...waitingItem } = waiting;
    expect([eventVersion, eventType]).toEqual([1, "job"]);
    expect(JobsListSchema.parse({ jobs: [waitingItem], stale: false }).jobs[0]).toMatchObject({ position: 1, reason: "load" });
    expect(v).toBe(1);
    expect(t).toBe("job");
  });
  it("accepts a previous agent's frame with no ended, and fills it in", () => {
    const finished = view();
    const { ended, ...old } = finished;
    expect(ended).toBeNull();
    const parsed = EvJob.parse(old);
    expect(parsed.ended).toBe(finished.at);
    expect(parsed).toMatchObject({ state: "exited", outcome: "exited", id: "job-1" });
    const decoded = decode(AgentFrames, JSON.stringify(old));
    expect(decoded.kind).toBe("ok");
    if (decoded.kind === "ok") expect(decoded.frame).toMatchObject({ t: "job", ended: finished.at });
    const open = { ...old, state: "queued" as const, outcome: null, exit: null, durationSec: null, notice: "none" as const, position: 1, reason: "load" as const };
    expect(EvJob.parse(open).ended).toBeNull();
    expect(EvJob.parse({ ...finished, ended: finished.at + 5 }).ended).toBe(finished.at + 5);
    expect(EvJob.parse({ ...finished, ended: null }).ended).toBeNull();
  });
  it("uses the domain job id and class, and the board's task key", () => {
    const src = readFileSync(new URL("../src/jobs.ts", import.meta.url), "utf8");
    expect(src).toContain("JOB_ID");
    expect(src).toContain("JOB_CLASS");
    expect(src).toContain('from "./board.ts"');
    expect(src).not.toContain("parseTaskKey");
    expect(src).not.toContain("A-Za-z0-9:_-");
    expect(src).not.toContain("[a-z0-9-]{1,32}");
  });
});
