// The hub's job list (design §7): the fleet mirror, the counts beside a node, and the feed. A local fleet
// and an in-process hub. No live service.
import type { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobViewSchema, type JobView } from "@morndo/protocol";
import { FleetClient } from "../src/adapters/fleet-client.ts";
import { JOB_LIST_MAX, JobsService } from "../src/application/jobs-service.ts";
import { startTestFleet, type TestFleet } from "../../fleet/test/helpers/fleet.ts";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";
import { frameText } from "./http-crash-fixture.ts";

const ev = (over: Record<string, unknown> = {}) => ({
  v: 1, t: "job",
  id: "job-1", node: "pc", lane: "builder", name: "pack", class: "default",
  state: "running", outcome: null, exit: null, durationSec: null,
  notify: { kind: "lane", name: "builder" }, task: null, notice: "none",
  at: Date.now(), ended: null, tail: "secret-tail",
  position: null, reason: null, error: null,
  command: "npm test --secret", argv: ["npm"], cwd: "/tmp/secret",
  ...over,
});

let hub: InProcessHub | undefined;
let fleet: TestFleet | undefined;
afterEach(async () => { await hub?.close(); hub = undefined; });

function frames(ws: WebSocket) {
  const seen: Record<string, unknown>[] = [];
  const waiters: { t: string; resolve: (m: Record<string, unknown>) => void }[] = [];
  ws.on("message", d => {
    const m = JSON.parse(frameText(d)) as Record<string, unknown>;
    seen.push(m);
    const i = waiters.findIndex(w => w.t === m.t);
    if (i !== -1) { waiters[i]?.resolve(m); waiters.splice(i, 1); }
  });
  const next = (t: string, from = seen.length) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const had = seen.slice(from).find(m => m.t === t);
    if (had) return resolve(had);
    waiters.push({ t, resolve });
    setTimeout(() => reject(new Error(`no ${t} frame`)), 3000);
  });
  return { next };
}

describe("the job list", () => {
  it("shows the fleet mirror, with counts, and a replay does not add a row", async () => {
    hub = await startInProcessHub();
    fleet = await startTestFleet();
    const agent = await fleet.online("pc");
    const at = Date.now();
    agent.send(ev({ id: "job-run", at, state: "running" }));
    agent.send(ev({ id: "job-bad", at, ended: at, state: "exited", outcome: "exited", exit: 1, durationSec: 2, notice: "pending" }));
    const client = new FleetClient(fleet.config.socketPath);
    const stop = client.events(e => { if (e.t === "job") hub?.jobs.apply(e.body); });
    await vi.waitFor(async () => {
      const listed = await client.jobs();
      expect(listed.jobs.map(j => j.id).sort()).toEqual(["job-bad", "job-run"]);
    });
    hub.jobs.replace(await client.jobs());
    const cookie = await hub.cookie();
    const look = await fetch(`${hub.base}/api/jobs`, { headers: { cookie: `__Host-morndo=${cookie}` } });
    expect(look.status).toBe(200);
    const body = await look.json() as { jobs: Record<string, unknown>[]; counts: { node: string; running: number; queued: number; failed: number }[] };
    expect(body.jobs.map(j => j.id).sort()).toEqual(["job-bad", "job-run"]);
    const failed = body.jobs.find(j => j.id === "job-bad");
    expect(failed).toMatchObject({ name: "pack", class: "default", state: "exited", lane: "builder", outcome: "exited", exit: 1, durationSec: 2, notice: "pending" });
    expect(body.counts).toEqual([{ node: "pc", running: 1, queued: 0, failed: 1 }]);
    const flat = JSON.stringify(body);
    expect(flat).not.toContain("secret");
    expect(flat).not.toContain("secret-tail");
    expect(flat).not.toContain("npm");
    expect((await fetch(`${hub.base}/api/jobs`)).status).toBe(401);
    const ws = await hub.socket("/api/feed", cookie);
    const feed = frames(ws);
    ws.send(JSON.stringify({ t: "hello" }));
    const frame = await feed.next("jobs");
    expect((frame.jobs as { id: string }[]).map(j => j.id).sort()).toEqual(["job-bad", "job-run"]);
    expect(frame.counts).toEqual([{ node: "pc", running: 1, queued: 0, failed: 1 }]);
    agent.send(ev({ id: "job-bad", at, ended: at, state: "exited", outcome: "exited", exit: 1, durationSec: 2, notice: "pending" }));
    await vi.waitFor(() => expect(hub?.jobs.view().jobs).toHaveLength(2));
    expect(hub?.jobs.view().counts).toEqual([{ node: "pc", running: 1, queued: 0, failed: 1 }]);
    stop();
    ws.close();
    await fleet.close();
  });

  it("posts one board comment for a task notice and does not change the task", async () => {
    hub = await startInProcessHub();
    const made = hub.board.create({ title: "Ship" }, { kind: "manager", name: "manager", token: "m" });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const status = made.task.status;
    const at = Date.now();
    const reported: string[] = [];
    hub.jobs.reportNotice((job, notice) => reported.push(`${job.id}:${notice}`));
    const job = ev({ id: "job-task", at, state: "exited", outcome: "exited", exit: 0, durationSec: 1, notice: "pending", task: "T-1", notify: { kind: "task", key: "T-1" }, tail: "shipped" });
    hub.jobs.apply(job);
    const task = hub.board.task("T-1");
    expect(task?.task).toMatchObject({ status, comments: 1 });
    expect(task?.events.at(-1)?.change).toEqual({ kind: "commented", text: "shipped" });
    expect(task?.events.at(-1)?.actor).toMatchObject({ kind: "worker", name: "builder" });
    hub.jobs.apply(job);
    expect(hub.board.task("T-1")?.task.comments).toBe(1);
    const gone = ev({ id: "job-gone", at, state: "exited", outcome: "exited", exit: 0, durationSec: 1, notice: "pending", task: "T-9", notify: { kind: "task", key: "T-9" }, tail: "missing" });
    hub.jobs.apply(gone);
    hub.jobs.apply(gone);
    expect(hub.board.task("T-9")).toBeNull();
    expect(hub.board.task("T-1")?.task.status).toBe(status);
    const missed = hub.jobs.view().jobs.find(j => j.id === "job-gone");
    expect(missed).toMatchObject({ state: "exited", notice: "given_up", noticeDetail: "task_gone" });
    expect(reported).toEqual(["job-task:commented", "job-gone:given_up"]);
    const again = new JobsService({ store: hub.store, board: hub.board });
    again.apply(job);
    expect(hub.board.task("T-1")?.task.comments).toBe(1);
    expect(again.unackedNotices().sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { node: "pc", id: "job-gone", notice: "given_up" },
      { node: "pc", id: "job-task", notice: "commented" },
    ]);
    again.ackNotice("pc", "job-task");
    const restarted = new JobsService({ store: hub.store, board: hub.board, tickMs: 0 });
    expect(restarted.unackedNotices()).toEqual([{ node: "pc", id: "job-gone", notice: "given_up" }]);
    restarted.ackNotice("pc", "job-gone");
    const settled = new JobsService({ store: hub.store, board: hub.board, tickMs: 0 });
    expect(settled.unackedNotices()).toEqual([]);
    again.close();
    restarted.close();
    settled.close();
  });

  it("keeps two jobs when two nodes use the same id", async () => {
    hub = await startInProcessHub();
    const made = hub.board.create({ title: "Ship" }, { kind: "manager", name: "manager", token: "m" });
    expect(made.ok).toBe(true);
    const at = 1_700_000_000_000;
    const done = { state: "exited", outcome: "exited", exit: 0, durationSec: 1, notice: "pending", task: "T-1", notify: { kind: "task", key: "T-1" } };
    hub.jobs.apply(ev({ id: "build", node: "pc", at, ...done, tail: "from pc" }));
    hub.jobs.apply(ev({ id: "build", node: "mac", at, lane: "review", ...done, tail: "from mac" }));
    expect(hub.jobs.view().jobs.map(j => [j.node, j.id])).toEqual([["mac", "build"], ["pc", "build"]]);
    expect(hub.board.task("T-1")?.task.comments).toBe(2);
  });

  it("does not comment a job with no notice text, and a board refusal is not a missing task", async () => {
    hub = await startInProcessHub();
    const made = hub.board.create({ title: "Ship" }, { kind: "manager", name: "manager", token: "m" });
    expect(made.ok).toBe(true);
    const at = 1_700_000_000_000;
    const task = { task: "T-1", notify: { kind: "task", key: "T-1" }, state: "exited", outcome: "refused", exit: null, durationSec: 0, notice: "pending" };
    hub.jobs.apply(ev({ id: "quiet", at, ...task, tail: "" }));
    expect(hub.board.task("T-1")?.task.comments).toBe(0);
    expect(hub.jobs.view().jobs.find(j => j.id === "quiet")).toMatchObject({ notice: "pending", noticeDetail: null });
    const jobs = new JobsService({
      store: hub.store, board: {
        task: () => ({ task: hub!.board.task("T-1")!.task, events: [] }),
        act: () => ({ ok: false, problem: "bad_text" }),
      },
    });
    jobs.apply(ev({ id: "refused", at, ...task, outcome: "exited", exit: 0, tail: "shipped" }));
    expect(jobs.view().jobs.find(j => j.id === "refused")).toMatchObject({ notice: "given_up", noticeDetail: null });
    expect(hub.board.task("T-1")?.task.comments).toBe(0);
  });

  it("rolls the claim back when the comment throws, and an open claim is finished on the next try", async () => {
    hub = await startInProcessHub();
    const made = hub.board.create({ title: "Ship" }, { kind: "manager", name: "manager", token: "m" });
    expect(made.ok).toBe(true);
    const at = 1_700_000_000_000;
    const task = { task: "T-1", notify: { kind: "task", key: "T-1" }, state: "exited", outcome: "exited", exit: 0, durationSec: 1, notice: "pending", tail: "shipped" };
    let thrown = false;
    const jobs = new JobsService({
      store: hub.store, board: {
        task: () => hub!.board.task("T-1"),
        act: () => { if (!thrown) { thrown = true; throw new Error("busy"); } return hub!.board.act("T-1", { action: "comment", text: "shipped" }, { kind: "worker", name: "builder", token: "job-notice" }); },
      },
    });
    expect(() => jobs.apply(ev({ id: "job-1", at, ...task }))).toThrow(/busy/);
    expect(hub.store.jobNotices()).toEqual([]);
    expect(hub.board.task("T-1")?.task.comments).toBe(0);
    hub.store.claimJobNotice("pc:job-open");
    jobs.apply(ev({ id: "job-open", at, ...task, tail: "again" }));
    expect(hub.board.task("T-1")?.task.comments).toBe(1);
    expect(hub.store.jobNotices().map(row => row.result).sort()).toEqual(["commented"]);
  });
});

describe("a job list read", () => {
  const view = (over: Record<string, unknown>): JobView => JobViewSchema.parse(ev(over));

  it("keeps the newer row when an event arrives while the list is in flight", () => {
    const jobs = new JobsService();
    const running = view({ at: 10, state: "running", outcome: null, exit: null, durationSec: null, notice: "none", tail: "" });
    const exited = view({ at: 20, state: "exited", outcome: "exited", exit: 0, durationSec: 1, notice: "pending", tail: "done" });
    const late = view({ id: "job-2", at: 15, state: "running", outcome: null, exit: null, durationSec: null, notice: "none", tail: "" });
    jobs.apply(running);
    jobs.merge({ jobs: [running], stale: false }, [exited, late, view({ at: 5, state: "queued", outcome: null, exit: null, durationSec: null, notice: "none", tail: "" })]);
    expect(jobs.view().jobs.map(j => [j.id, j.state]).sort()).toEqual([["job-1", "exited"], ["job-2", "running"]]);
    jobs.apply(view({ id: "gone", at: 1, state: "running", outcome: null, exit: null, durationSec: null, notice: "none", tail: "" }));
    jobs.merge({ jobs: [exited], stale: true }, []);
    expect(jobs.view().jobs.map(j => j.id)).toEqual(["job-1"]);
    expect(jobs.view().stale).toBe(true);
    jobs.close();
  });

  it("drops a day-old failure when the clock moves, without another event", () => {
    vi.useFakeTimers();
    const day = 24 * 60 * 60 * 1000;
    let now = 1_700_000_000_000;
    const jobs = new JobsService({ now: () => now, tickMs: 1000 });
    const seen: number[] = [];
    jobs.subscribe(v => { const row = v.counts[0]; if (row) seen.push(row.failed); });
    try {
      jobs.apply(view({ at: 1, ended: now, state: "exited", outcome: "exited", exit: 1, durationSec: 1, notice: "pending", tail: "" }));
      expect(jobs.view().counts).toEqual([{ node: "pc", running: 0, queued: 0, failed: 1 }]);
      now += day + 1;
      expect(seen.at(-1)).toBe(1);
      vi.advanceTimersByTime(1000);
      expect(jobs.view().counts).toEqual([{ node: "pc", running: 0, queued: 0, failed: 0 }]);
      expect(seen.at(-1)).toBe(0);
    } finally {
      jobs.close();
      vi.useRealTimers();
    }
  });

  it("shows open jobs and a bounded recent list, and counts one job at a time", async () => {
    const jobs = new JobsService({ tickMs: 0, now: () => 1_000 });
    jobs.apply(view({ id: "open", at: 1, state: "running", outcome: null, exit: null, durationSec: null, notice: "none", tail: "" }));
    for (let i = 0; i < JOB_LIST_MAX + 10; i++) {
      jobs.apply(view({ id: `j${i}`, at: i + 2, ended: i + 2, state: "exited", outcome: "exited", exit: 0, durationSec: 1, notice: "pending", tail: "" }));
    }
    const shown = jobs.view();
    expect(shown.jobs.filter(j => j.id === "open")).toHaveLength(1);
    expect(shown.jobs.filter(j => j.outcome !== null)).toHaveLength(JOB_LIST_MAX);
    expect(shown.more).toBe(10);
    expect(shown.jobs.map(j => j.id)).toContain(`j${JOB_LIST_MAX + 9}`);
    expect(shown.jobs.map(j => j.id)).not.toContain("j0");
    const headerIds = new Set(shown.jobs.map(j => j.id));
    const first = jobs.page(null);
    expect(first.jobs).toHaveLength(10);
    expect(first.jobs.every(j => !headerIds.has(j.id))).toBe(true);
    expect(first.jobs.map(j => j.id)).toContain("j0");
    expect(first.next).toBeNull();
    const wide = new JobsService({ tickMs: 0, now: () => 1_000 });
    for (let i = 0; i < JOB_LIST_MAX * 2 + 5; i++) {
      wide.apply(view({ id: `w${i}`, at: i + 2, ended: i + 2, state: "exited", outcome: "exited", exit: 0, durationSec: 1, notice: "pending", tail: "" }));
    }
    const page = wide.page(null);
    expect(page.jobs).toHaveLength(JOB_LIST_MAX);
    const rest = wide.page(page.next);
    expect(rest.jobs).toHaveLength(5);
    expect(rest.next).toBeNull();
    expect(new Set([...page.jobs, ...rest.jobs].map(j => j.id)).size).toBe(JOB_LIST_MAX + 5);
    wide.close();
    expect(shown.counts).toEqual([{ node: "pc", running: 1, queued: 0, failed: 0 }]);
    hub = await startInProcessHub();
    for (let i = 0; i < JOB_LIST_MAX + 3; i++) hub.jobs.apply(ev({ id: `h${i}`, at: i + 1, ended: i + 1, state: "exited", outcome: "exited", exit: 0, durationSec: 1, notice: "pending", tail: "" }));
    const cookie = await hub.cookie();
    const headers = { cookie: `__Host-morndo=${cookie}` };
    const head = await (await fetch(`${hub.base}/api/jobs`, { headers })).json() as { more: number; jobs: { id: string }[] };
    expect(head.more).toBe(3);
    const hidden = await (await fetch(`${hub.base}/api/jobs?hidden=1`, { headers })).json() as { jobs: { id: string }[]; next: string | null };
    expect(hidden.jobs.map(j => j.id).sort()).toEqual(["h0", "h1", "h2"]);
    expect(hidden.jobs.every(j => !head.jobs.some(row => row.id === j.id))).toBe(true);
    expect(hidden.next).toBeNull();
    jobs.apply(view({ id: "open", at: 2, state: "exited", outcome: "exited", exit: 1, ended: 1_000, durationSec: 1, notice: "pending", tail: "" }));
    expect(jobs.view().counts).toEqual([{ node: "pc", running: 0, queued: 0, failed: 1 }]);
    const clock = new JobsService({ tickMs: 0, now: () => 1_000 });
    clock.apply(view({ id: "ahead", at: 1_000, ended: 1_000 + 30 * 24 * 60 * 60 * 1000, state: "exited", outcome: "exited", exit: 1, durationSec: 1, notice: "pending", tail: "" }));
    expect(clock.view().counts).toEqual([{ node: "pc", running: 0, queued: 0, failed: 1 }]);
    clock.close();
    jobs.close();
  });
});
