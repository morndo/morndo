// The fleet mirror (design §4, §7, ADR-0012, ADR-0014): one row per job id. A replay of the same ev.job
// does not fork a second row, and an older observation does not rewind a newer one. The row and the GET
// body have state, class, lane, timings, outcome and notice. They never have the command line.
import { join } from "node:path";
import { EvJob } from "@morndo/protocol";
import { describe, expect, it, vi } from "vitest";
import { openFleetDb } from "../src/adapters/db.ts";
import { fleetNoticeId, JOB_KEEP_MS, JOB_SNAPSHOT_MAX, JobsStore } from "../src/adapters/jobs-store.ts";
import { EventHub } from "../src/application/events.ts";
import { JobMirror, nextNoticeDelay, NOTICE_RETRY_MAX_MS, NOTICE_RETRY_MS } from "../src/application/job-mirror.ts";
import { tempDir } from "./helpers/temp.ts";
import { startTestFleet } from "./helpers/fleet.ts";
import { validResult, type FakeAgent } from "./helpers/fake-agent.ts";
import { client } from "./helpers/socket-client.ts";
import { whenTrue } from "./helpers/when-true.ts";

const AT = 1_700_000_000_000;

const when = whenTrue;

const ev = (over: Record<string, unknown> = {}) => ({
  v: 1, t: "job",
  id: "job-1", node: "pc", lane: "builder", name: "pack", class: "default",
  state: "exited", outcome: "exited", exit: 0, durationSec: 1.5,
  notify: { kind: "lane", name: "builder" }, task: null, notice: "pending",
  at: AT, ended: null, tail: "all good",
  position: null, reason: null, error: null,
  command: "npm test --secret", argv: ["npm", "test"], cwd: "/tmp/secret", env: { TOKEN: "nope" },
  ...over,
});

describe("GET /v1/jobs", () => {
  it("keeps one row for a replayed ev.job and never stores the command line", async () => {
    const fleet = await startTestFleet();
    const agent = await fleet.online("pc");
    agent.send(ev());
    agent.send(ev());
    agent.send(ev({ at: AT - 1, state: "queued", outcome: null, exit: null, durationSec: null, notice: "none", position: 2, reason: "load" }));
    const api = client(fleet.config.socketPath);
    await vi.waitFor(async () => {
      const listed = await api.get("/v1/jobs?node=pc");
      expect(listed?.status).toBe(200);
      expect(listed?.body).toMatchObject({ stale: false, jobs: [expect.objectContaining({ id: "job-1", state: "exited" })] });
    });
    const listed = await api.get("/v1/jobs?node=pc&lane=builder&state=exited");
    const body = listed?.body as { jobs: Record<string, unknown>[]; stale: boolean };
    expect(body.jobs).toHaveLength(1);
    const job = body.jobs[0] ?? {};
    expect(job).toMatchObject({
      id: "job-1", node: "pc", lane: "builder", class: "default", state: "exited",
      outcome: "exited", exit: 0, durationSec: 1.5, notice: "pending", at: AT, tail: "all good",
    });
    expect(job).not.toHaveProperty("command");
    expect(job).not.toHaveProperty("argv");
    expect(job).not.toHaveProperty("cwd");
    expect(job).not.toHaveProperty("env");
    expect(JSON.stringify(body)).not.toContain("secret");
    expect(JSON.stringify(body)).not.toContain("npm test");
    const one = await api.get("/v1/jobs/pc/job-1");
    expect(one?.status).toBe(200);
    expect(one?.body).toMatchObject({ stale: false, job: { id: "job-1", state: "exited", notice: "pending" } });
    expect(JSON.stringify(one?.body)).not.toContain("argv");
    const columns = (fleet.db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map(c => c.name);
    for (const banned of ["argv", "command", "cwd", "env", "token", "command_hash"]) expect(columns, columns.join(",")).not.toContain(banned);
    expect(fleet.db.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 1 });
    expect((await api.get("/v1/jobs/pc/missing"))?.status).toBe(404);
    const seen: string[] = [];
    fleet.events.subscribe(e => { if (e.t === "job") seen.push((e.body as { id: string }).id); });
    agent.send(ev({ at: AT + 5 }));
    agent.send(ev({ id: "other", at: AT }));
    await vi.waitFor(() => expect(fleet.jobs.get("pc", "other")).not.toBeNull());
    expect(fleet.jobs.get("pc", "job-1")?.at).toBe(AT + 5);
    expect(seen.filter(id => id === "job-1")).toEqual([]);
    agent.send(ev({ at: AT + 3, state: "running", outcome: null, exit: null, durationSec: null, notice: "none" }));
    agent.send(ev({ id: "later", at: AT }));
    await vi.waitFor(() => expect(fleet.jobs.get("pc", "later")).not.toBeNull());
    expect(fleet.jobs.get("pc", "job-1")).toMatchObject({ state: "exited", at: AT + 5 });
    agent.send(ev({ notice: "typed", at: AT + 6 }));
    await vi.waitFor(() => expect(fleet.jobs.get("pc", "job-1")).toMatchObject({ notice: "typed", at: AT + 6 }));
    expect(seen.filter(id => id === "job-1")).toEqual(["job-1"]);
    agent.send(ev({ id: "jump", notice: "pending", at: AT }));
    await vi.waitFor(() => expect(fleet.jobs.get("pc", "jump")).toMatchObject({ notice: "pending" }));
    agent.send(ev({ id: "jump", notice: "delivered", at: AT + 8 }));
    await vi.waitFor(() => expect(fleet.jobs.get("pc", "jump")).toMatchObject({ notice: "delivered", at: AT + 8 }));
    agent.send(ev({ id: "jump", notice: "uncertain", at: AT + 9 }));
    agent.send(ev({ id: "later-notice", at: AT }));
    await vi.waitFor(() => expect(fleet.jobs.get("pc", "later-notice")).not.toBeNull());
    expect(fleet.jobs.get("pc", "jump")).toMatchObject({ notice: "delivered" });
    await agent.close();
    await vi.waitFor(async () => {
      expect((await api.get("/v1/jobs/pc/job-1"))?.body).toMatchObject({ stale: true, job: { id: "job-1" } });
    });
  });

  it("routes a notice to a lane on another node once, under the one notice id", async () => {
    const fleet = await startTestFleet();
    const owner = await fleet.online("pc");
    const other = await fleet.online("mac");
    other.inventory([{ workerId: "mac.3fa2c1d0.0", window: "review", cwd: "/work" }]);
    await when(() => fleet.lanes.get("review")?.node === "mac", fn => fleet.events.subscribe(fn));
    const notices = (agent: FakeAgent) => agent.reqs.filter(req => req.op === "job.notice");
    const jobCount = () => (fleet.db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n;
    owner.send(ev({ notify: { kind: "lane", name: "review" }, tail: "built" }));
    await other.when(() => notices(other).length === 1);
    await when(() => fleet.jobs.taken >= 1, fn => fleet.jobs.watch(fn));
    const seen = fleet.jobs.taken;
    owner.send(ev({ notify: { kind: "lane", name: "review" }, tail: "built" }));
    await when(() => fleet.jobs.taken > seen, fn => fleet.jobs.watch(fn));
    expect(notices(other)).toHaveLength(1);
    expect(notices(owner)).toHaveLength(0);
    expect(notices(other)[0]?.args).toEqual({ id: fleetNoticeId("pc", "job-1"), lane: "review", text: "built" });
    expect(notices(other)[0]?.key).toBe(fleetNoticeId("pc", "job-1"));
    const routes = fleet.db.prepare("PRAGMA table_info(job_routes)").all() as { name: string }[];
    const names = routes.map(column => column.name);
    expect(names).toContain("notice_id");
    for (const banned of ["text", "argv", "command", "cwd", "tail"]) expect(names).not.toContain(banned);
    expect(fleet.db.prepare("SELECT notice_id, node, dest_node FROM job_routes").all()).toEqual([{ notice_id: fleetNoticeId("pc", "job-1"), node: "pc", dest_node: "mac" }]);
    owner.send(ev({ id: "job-2", notify: { kind: "lane", name: "builder" }, tail: "local" }));
    await when(() => jobCount() === 2, fn => fleet.events.subscribe(fn));
    expect(notices(other)).toHaveLength(1);
    expect(notices(owner)).toHaveLength(0);
  });

  it("sends job.cancel to the node that owns the job, with the token and without the command", async () => {
    const fleet = await startTestFleet();
    const owner = await fleet.online("pc");
    const other = await fleet.online("mac");
    owner.send(ev({ id: "job-9", state: "running", outcome: null, exit: null, durationSec: null, notice: "none" }));
    const api = client(fleet.config.socketPath);
    await vi.waitFor(async () => expect((await api.get("/v1/jobs/pc/job-9"))?.status).toBe(200));
    const missing = await api.post("/v1/op", { node: "pc", op: "job.cancel", args: { id: "nope", token: "lane-token" } });
    expect(missing?.body).toMatchObject({ ok: false, error: { code: "denied", executed: "no", message: "missing" } });
    expect(owner.reqs.filter(req => req.op === "job.cancel")).toHaveLength(0);
    expect(other.reqs.filter(req => req.op === "job.cancel")).toHaveLength(0);
    const cancelled = await api.post("/v1/op", {
      node: "pc", op: "job.cancel", args: { id: "job-9", token: "lane-token", command: "npm test", argv: ["npm"] },
    });
    expect(cancelled?.body).toMatchObject({ ok: true });
    expect(other.reqs.filter(req => req.op === "job.cancel")).toHaveLength(0);
    const sent = owner.reqs.filter(req => req.op === "job.cancel");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.args).toEqual({ id: "job-9", token: "lane-token" });
    const byLane = await api.post("/v1/op", { lane: "builder", op: "job.cancel", args: { id: "job-9", token: "lane-token" } });
    expect(byLane?.body).toMatchObject({ ok: true });
    const byWorker = await api.post("/v1/op", { workerId: "mac.3fa2c1d0.0", op: "job.cancel", args: { id: "job-9", token: "lane-token" } });
    expect(byWorker?.body).toMatchObject({ ok: true });
    expect(owner.reqs.filter(req => req.op === "job.cancel")).toHaveLength(3);
    expect(other.reqs.filter(req => req.op === "job.cancel")).toHaveLength(0);
    const details = (fleet.db.prepare("SELECT detail FROM audit").all() as { detail: string }[]).map(row => row.detail).join("\n");
    expect(details).not.toContain("lane-token");
    expect(details).not.toContain("npm");
  });

  it("keeps two jobs when two nodes use the same id", async () => {
    const fleet = await startTestFleet();
    const pc = await fleet.online("pc");
    const mac = await fleet.online("mac");
    mac.inventory([{ workerId: "mac.3fa2c1d0.0", window: "review", cwd: "/work" }]);
    pc.inventory([{ workerId: "pc.3fa2c1d0.1", window: "builder", cwd: "/work" }]);
    await when(
      () => fleet.lanes.get("review")?.node === "mac" && fleet.lanes.get("builder")?.node === "pc",
      fn => fleet.events.subscribe(fn),
    );
    pc.send(ev({ id: "build", node: "pc", notify: { kind: "lane", name: "review" }, tail: "from-pc" }));
    mac.send(ev({ id: "build", node: "mac", at: AT + 1, notify: { kind: "lane", name: "builder" }, tail: "from-mac" }));
    const api = client(fleet.config.socketPath);
    await when(() => {
      const nodes = (fleet.db.prepare("SELECT node FROM jobs WHERE id = 'build'").all() as { node: string }[]).map(row => row.node).sort();
      return nodes.join() === "mac,pc";
    }, fn => fleet.events.subscribe(fn));
    const listed = await api.get("/v1/jobs");
    if (!listed?.body) throw new Error("no jobs body");
    const jobs = (listed.body as { jobs: { id: string; node: string }[] }).jobs.filter(job => job.id === "build");
    expect(jobs.map(job => job.node).sort()).toEqual(["mac", "pc"]);
    expect((await api.get("/v1/jobs/pc/build"))?.body).toMatchObject({ job: { id: "build", node: "pc", tail: "from-pc" } });
    expect((await api.get("/v1/jobs/mac/build"))?.body).toMatchObject({ job: { id: "build", node: "mac", tail: "from-mac" } });
    await mac.when(() => mac.reqs.filter(req => req.op === "job.notice").length === 1);
    await pc.when(() => pc.reqs.filter(req => req.op === "job.notice").length === 1);
    const ids = [...mac.reqs, ...pc.reqs].filter(req => req.op === "job.notice").map(req => (req.args as { id: string }).id);
    expect(new Set(ids).size).toBe(2);
    const cancelled = await api.post("/v1/op", { node: "pc", op: "job.cancel", args: { id: "build", token: "lane-token" } });
    expect(cancelled?.body).toMatchObject({ ok: true });
    expect(pc.reqs.filter(req => req.op === "job.cancel")).toHaveLength(1);
    expect(mac.reqs.filter(req => req.op === "job.cancel")).toHaveLength(0);
  });

  it("retries a notice when the destination node comes back, without a new job event", async () => {
    const fleet = await startTestFleet({ now: () => AT + 5_000 });
    const pc = await fleet.online("pc");
    const mac = await fleet.online("mac");
    mac.inventory([{ workerId: "mac.3fa2c1d0.0", window: "review", cwd: "/work" }]);
    await vi.waitFor(() => expect(fleet.lanes.get("review")?.node).toBe("mac"));
    await mac.close();
    await vi.waitFor(() => expect(fleet.connections.status("mac")).toBe("offline"));
    pc.send(ev({ notify: { kind: "lane", name: "review" }, tail: "built" }));
    await vi.waitFor(() => expect(fleet.db.prepare("SELECT COUNT(*) AS n FROM job_routes").get()).toEqual({ n: 0 }));
    expect(mac.reqs.filter((r) => r.op === "job.notice")).toHaveLength(0);
    expect((await mac.connect()).ok).toBe(true);
    await vi.waitFor(() => expect(mac.reqs.filter((r) => r.op === "job.notice")).toHaveLength(1));
    const req = mac.reqs.find((r) => r.op === "job.notice");
    if (!req) throw new Error("no notice");
    expect((req.args as { text: string }).text).toBe("built");
  });

  it("backs off a missed notice, audits a state once, and stops after 7 days", async () => {
    expect(nextNoticeDelay(null)).toBe(NOTICE_RETRY_MS);
    expect(nextNoticeDelay(NOTICE_RETRY_MS)).toBe(NOTICE_RETRY_MS * 2);
    expect(nextNoticeDelay(NOTICE_RETRY_MAX_MS)).toBe(NOTICE_RETRY_MAX_MS);
    let now = AT;
    const fleet = await startTestFleet({ now: () => now });
    const pc = await fleet.online("pc");
    const mac = await fleet.online("mac");
    const busy = { ok: false as const, error: { code: "busy" as const, executed: "no" as const, message: "not_typed" } };
    mac.answer = req => req.op === "job.notice" ? busy : { ok: true, result: validResult(req.op, mac.node) };
    mac.inventory([{ workerId: "mac.3fa2c1d0.0", window: "review", cwd: "/work" }]);
    await vi.waitFor(() => expect(fleet.lanes.get("review")?.node).toBe("mac"));
    pc.send(ev({ notify: { kind: "lane", name: "review" }, tail: "built" }));
    const notices = () => mac.reqs.filter(req => req.op === "job.notice").length;
    const audits = () => (fleet.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'op.job.notice'").get() as { n: number }).n;
    const released = () => (fleet.db.prepare("SELECT COUNT(*) AS n FROM job_routes").get() as { n: number }).n;
    await vi.waitFor(() => expect(notices()).toBe(1));
    await vi.waitFor(() => expect(released()).toBe(0));
    await vi.waitFor(() => expect(audits()).toBe(1));
    fleet.jobs.retry();
    expect(notices()).toBe(1);
    now += NOTICE_RETRY_MS;
    fleet.jobs.retry();
    await vi.waitFor(() => expect(notices()).toBe(2));
    await vi.waitFor(() => expect(released()).toBe(0));
    expect(audits()).toBe(1);
    now += NOTICE_RETRY_MS;
    fleet.jobs.retry();
    expect(notices()).toBe(2);
    now += NOTICE_RETRY_MS;
    fleet.jobs.retry();
    await vi.waitFor(() => expect(notices()).toBe(3));
    await vi.waitFor(() => expect(released()).toBe(0));
    expect(audits()).toBe(1);
    mac.answer = req => req.op === "job.notice"
      ? { ok: false, error: { code: "no_pane", executed: "no", message: "gone" } }
      : { ok: true, result: validResult(req.op, mac.node) };
    now += NOTICE_RETRY_MS * 4;
    fleet.jobs.retry();
    await vi.waitFor(() => expect(notices()).toBe(4));
    await vi.waitFor(() => expect(released()).toBe(0));
    expect(audits()).toBe(2);
    now = AT + JOB_KEEP_MS;
    fleet.jobs.retry();
    expect(notices()).toBe(4);
  });

  it("retries only a lane notice that has no route yet", async () => {
    const fleet = await startTestFleet({ now: () => AT });
    const pc = await fleet.online("pc");
    pc.send(ev({ id: "task", notify: { kind: "task", key: "T-1" }, task: "T-1" }));
    pc.send(ev({ id: "quiet", notify: { kind: "fleet" } }));
    pc.send(ev({ id: "held", notify: { kind: "lane", name: "missing" } }));
    await vi.waitFor(() => expect(fleet.jobs.get("pc", "held")).not.toBeNull());
    const pending = new JobsStore(fleet.db).pendingNotices().map(job => job.id);
    expect(pending).toEqual([]);
    expect(new JobsStore(fleet.db).noticeDest("pc", "held")).toBe("");
    expect(fleet.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'job_routes'").all()).toContainEqual({ name: "job_routes_job" });
  });

  it("does not send a notice whose lane was local or unknown when the job finished", async () => {
    let now = AT;
    const fleet = await startTestFleet({ now: () => now });
    const pc = await fleet.online("pc");
    const mac = await fleet.online("mac");
    pc.inventory([{ workerId: "pc.3fa2c1d0.1", window: "builder", cwd: "/work" }]);
    await vi.waitFor(() => expect(fleet.lanes.get("builder")?.node).toBe("pc"));
    pc.send(ev({ id: "local", notify: { kind: "lane", name: "builder" }, tail: "here" }));
    pc.send(ev({ id: "lost", notify: { kind: "lane", name: "nobody" }, tail: "nowhere" }));
    await vi.waitFor(() => expect(fleet.jobs.get("pc", "lost")).not.toBeNull());
    expect(new JobsStore(fleet.db).noticeDest("pc", "local")).toBe("");
    expect(new JobsStore(fleet.db).noticeDest("pc", "lost")).toBe("");
    pc.inventory([]);
    mac.inventory([{ workerId: "mac.3fa2c1d0.0", window: "builder", cwd: "/work" }, { workerId: "mac.3fa2c1d0.1", window: "nobody", cwd: "/work" }]);
    await vi.waitFor(() => expect(fleet.lanes.get("nobody")?.node).toBe("mac"));
    now += NOTICE_RETRY_MS;
    fleet.jobs.retry();
    fleet.jobs.retry("mac");
    expect(mac.reqs.filter(req => req.op === "job.notice")).toHaveLength(0);
    expect(pc.reqs.filter(req => req.op === "job.notice")).toHaveLength(0);
  });

  it("keeps sending a notice to the node chosen when the job finished", async () => {
    let now = AT;
    const fleet = await startTestFleet({ now: () => now });
    const pc = await fleet.online("pc");
    const mac = await fleet.online("mac");
    const linux = await fleet.online("linux");
    mac.answer = req => req.op === "job.notice"
      ? { ok: false, error: { code: "busy", executed: "no", message: "not_typed" } }
      : { ok: true, result: validResult(req.op, mac.node) };
    mac.inventory([{ workerId: "mac.3fa2c1d0.0", window: "review", cwd: "/work" }]);
    await vi.waitFor(() => expect(fleet.lanes.get("review")?.node).toBe("mac"));
    pc.send(ev({ notify: { kind: "lane", name: "review" }, tail: "built" }));
    await vi.waitFor(() => expect(mac.reqs.filter(req => req.op === "job.notice")).toHaveLength(1));
    await vi.waitFor(() => expect((fleet.db.prepare("SELECT COUNT(*) AS n FROM job_routes").get() as { n: number }).n).toBe(0));
    expect(new JobsStore(fleet.db).noticeDest("pc", "job-1")).toBe("mac");
    mac.inventory([]);
    linux.inventory([{ workerId: "linux.3fa2c1d0.0", window: "review", cwd: "/work" }]);
    await vi.waitFor(() => expect(fleet.lanes.get("review")?.node).toBe("linux"));
    now += NOTICE_RETRY_MS;
    fleet.jobs.retry();
    await vi.waitFor(() => expect(mac.reqs.filter(req => req.op === "job.notice")).toHaveLength(2));
    expect(linux.reqs.filter(req => req.op === "job.notice")).toHaveLength(0);
  });

  it("drops a finished job and its route after 7 days, and keeps one that is still open", async () => {
    const first = await startTestFleet({ now: () => AT });
    const dir = first.dir;
    const pc = await first.online("pc");
    pc.send(ev({ id: "old", at: AT - JOB_KEEP_MS - 1 }));
    pc.send(ev({ id: "keep", at: AT }));
    pc.send(ev({ id: "open", state: "running", outcome: null, exit: null, durationSec: null, notice: "none", at: AT - JOB_KEEP_MS - 1 }));
    await vi.waitFor(() => expect(first.db.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 3 }));
    first.db.prepare("INSERT INTO job_routes (notice_id, node, job_id, dest_node) VALUES (?, ?, ?, ?)").run(fleetNoticeId("pc", "old"), "pc", "old", "mac");
    first.db.prepare("INSERT INTO job_routes (notice_id, node, job_id, dest_node) VALUES (?, ?, ?, ?)").run(fleetNoticeId("pc", "keep"), "pc", "keep", "mac");
    await first.close();
    const second = await startTestFleet({ dir, now: () => AT });
    expect(second.jobs.get("pc", "old")).toBeNull();
    expect(second.jobs.get("pc", "keep")).toMatchObject({ id: "keep" });
    expect(second.jobs.get("pc", "open")).toMatchObject({ id: "open", outcome: null });
    const routes = second.db.prepare("SELECT job_id FROM job_routes ORDER BY job_id").all() as { job_id: string }[];
    expect(routes.map(row => row.job_id)).toEqual(["keep"]);
  });

  it("sends a new events client the open jobs and a bounded recent window, not the whole history", async () => {
    const fleet = await startTestFleet();
    const pc = await fleet.online("pc");
    pc.send(ev({ id: "open", state: "running", outcome: null, exit: null, durationSec: null, notice: "none", at: AT }));
    for (let i = 0; i < JOB_SNAPSHOT_MAX + 20; i++) pc.send(ev({ id: `j${i}`, at: AT + i + 1 }));
    await when(
      () => (fleet.db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n === JOB_SNAPSHOT_MAX + 21,
      fn => fleet.events.subscribe(fn),
    );
    const evs = await client(fleet.config.socketPath).events();
    await evs.when(() => evs.received.filter(e => e.t === "job").length === JOB_SNAPSHOT_MAX + 1);
    const ids = evs.received.filter(e => e.t === "job").map(e => (e.body as { id: string }).id);
    expect(ids).toContain("open");
    expect(ids).toContain(`j${JOB_SNAPSHOT_MAX + 19}`);
    expect(ids).not.toContain("j0");
    evs.close();
  });

  it("refuses job.notice from a client", async () => {
    const fleet = await startTestFleet();
    const api = client(fleet.config.socketPath);
    const posted = await api.post("/v1/op", {
      node: "pc", op: "job.notice", args: { id: "node:job:pc:build:done", lane: "review", text: "x" }, key: "hub:notice",
    });
    expect(posted?.body).toMatchObject({ ok: false, error: { code: "bad_args" } });
    expect(JSON.stringify(posted?.body)).toContain("unknown op");
  });
});

describe("job_failed", () => {
  it("raises one alert for a failed job and none for success, a cancel, or a replay", async () => {
    const fleet = await startTestFleet();
    const agent = await fleet.online("pc");
    const ended = Date.now();
    const failed = ev({ id: "job-bad", outcome: "exited", exit: 1, state: "exited", ended, tail: "secret-tail", command: "do not store" });
    agent.send(failed);
    agent.send(failed);
    agent.send(ev({ id: "job-ok", outcome: "exited", exit: 0, state: "exited", ended }));
    agent.send(ev({ id: "job-stop", outcome: "cancelled", state: "cancelled", exit: null, ended }));
    agent.send(ev({ id: "job-time", outcome: "timed_out", state: "timed_out", exit: null, ended }));
    agent.send(ev({ id: "job-gone", outcome: "lost", state: "lost", exit: null, ended }));
    await vi.waitFor(() => expect(fleet.audit.of("alert.job_failed")).toHaveLength(3));
    const alerts = fleet.audit.of("alert.job_failed").map(a => a.detail);
    expect(alerts).toEqual([
      { id: "job-bad", name: "pack", class: "default", outcome: "exited" },
      { id: "job-time", name: "pack", class: "default", outcome: "timed_out" },
      { id: "job-gone", name: "pack", class: "default", outcome: "lost" },
    ]);
    const flat = JSON.stringify(alerts);
    expect(flat).not.toContain("command");
    expect(flat).not.toContain("tail");
    expect(flat).not.toContain("secret");
    agent.send(failed);
    expect(fleet.audit.of("alert.job_failed")).toHaveLength(3);
  });

  it("accepts a previous agent's frame that has no ended", async () => {
    const fleet = await startTestFleet();
    const agent = await fleet.online("pc");
    const at = Date.now();
    const raw = ev({ id: "job-old", at, state: "exited", outcome: "exited", exit: 1, notice: "pending" });
    delete (raw as { ended?: unknown }).ended;
    agent.send(raw);
    await vi.waitFor(() => expect(fleet.jobs.get("pc", "job-old")).toMatchObject({ ended: at, state: "exited" }));
    expect(fleet.audit.of("alert.job_failed").map(a => (a.detail as { id: string }).id)).toEqual(["job-old"]);
    const open = ev({ id: "job-open", at, state: "running", outcome: null, exit: null, durationSec: null, notice: "none" });
    delete (open as { ended?: unknown }).ended;
    agent.send(open);
    await vi.waitFor(() => expect(fleet.jobs.get("pc", "job-open")).toMatchObject({ ended: null, state: "running" }));
    expect(fleet.audit.of("alert.job_failed")).toHaveLength(1);
  });

  it("clamps an ended time far ahead to when the fleet received it", async () => {
    const fleet = await startTestFleet();
    const agent = await fleet.online("pc");
    const before = Date.now();
    const month = 30 * 24 * 60 * 60 * 1000;
    agent.send(ev({ id: "ahead", at: before, ended: before + month, state: "exited", outcome: "exited", exit: 1, notice: "pending" }));
    agent.send(ev({ id: "soon", at: before, ended: before + 2 * 60 * 1000, state: "exited", outcome: "exited", exit: 1, notice: "pending" }));
    await vi.waitFor(() => expect(fleet.jobs.get("pc", "ahead")?.ended).toBeGreaterThanOrEqual(before));
    const ahead = fleet.jobs.get("pc", "ahead");
    expect(ahead?.ended).toBeLessThanOrEqual(Date.now());
    expect(ahead?.ended).not.toBe(before + month);
    expect(fleet.jobs.get("pc", "soon")?.ended).toBe(before + 2 * 60 * 1000);
    expect(fleet.audit.of("alert.job_failed").map(a => (a.detail as { id: string }).id).sort()).toEqual(["ahead", "soon"]);
  });

  it("reads when alerting started once, not on every job", () => {
    const db = openFleetDb(join(tempDir(), "fleet.db"));
    const store = new JobsStore(db);
    let reads = 0;
    const since = store.alertSince.bind(store);
    store.alertSince = () => { reads += 1; return since(); };
    const jobs = new JobMirror({
      store, events: new EventHub(), online: () => true, laneOf: () => null, now: () => Date.now(),
      deliver: async () => ({ ok: true, state: "ok" }),
    });
    expect(reads).toBe(1);
    jobs.accept(EvJob.parse(ev({ id: "a", outcome: "exited", exit: 1, state: "exited", ended: Date.now() })));
    jobs.accept(EvJob.parse(ev({ id: "b", outcome: "exited", exit: 1, state: "exited", ended: Date.now() })));
    expect(reads).toBe(1);
    db.close();
  });

  it("does not alert a failure that ended before this fleet started alerting", async () => {
    const fleet = await startTestFleet();
    const agent = await fleet.online("pc");
    const day = 24 * 60 * 60 * 1000;
    agent.send(ev({ id: "old", outcome: "exited", exit: 1, state: "exited", ended: Date.now() - 8 * day }));
    agent.send(ev({ id: "fresh", outcome: "exited", exit: 1, state: "exited", ended: Date.now() }));
    await vi.waitFor(() => expect(fleet.audit.of("alert.job_failed")).toHaveLength(1));
    expect(fleet.audit.of("alert.job_failed").map(a => (a.detail as { id: string }).id)).toEqual(["fresh"]);
    agent.send(ev({ id: "old", outcome: "exited", exit: 1, state: "exited", ended: Date.now() - 8 * day, at: Date.now() }));
    expect(fleet.audit.of("alert.job_failed")).toHaveLength(1);
  });
});

describe("a notice result", () => {
  it("stores commented and given_up, raises job_unnoticed once, and does not rewind", async () => {
    const fleet = await startTestFleet();
    const agent = await fleet.online("pc");
    const ended = Date.now();
    const done = { outcome: "exited", exit: 0, state: "exited", notice: "pending", ended, tail: "shipped" };
    agent.send(ev({ id: "job-1", ...done }));
    agent.send(ev({ id: "job-2", ...done }));
    const api = client(fleet.config.socketPath);
    await vi.waitFor(async () => {
      const listed = await api.get("/v1/jobs/pc/job-1");
      expect(listed?.body).toMatchObject({ job: { notice: "pending" } });
    });
    const given = await api.post("/v1/op", { node: "pc", op: "job.noticeResult", args: { id: "job-1", notice: "given_up" } });
    expect(given?.body).toMatchObject({ ok: true });
    const commented = await api.post("/v1/op", { node: "pc", op: "job.noticeResult", args: { id: "job-2", notice: "commented" } });
    expect(commented?.body).toMatchObject({ ok: true });
    expect((await api.get("/v1/jobs/pc/job-1"))?.body).toMatchObject({ job: { notice: "given_up" } });
    expect((await api.get("/v1/jobs/pc/job-2"))?.body).toMatchObject({ job: { notice: "commented" } });
    await vi.waitFor(() => expect(fleet.audit.of("alert.job_unnoticed")).toHaveLength(1));
    const detail = fleet.audit.of("alert.job_unnoticed")[0]?.detail;
    expect(detail).toMatchObject({ id: "job-1", name: "pack", class: "default", outcome: "exited" });
    expect(JSON.stringify(detail)).not.toContain("shipped");
    expect(JSON.stringify(detail)).not.toContain("tail");
    await api.post("/v1/op", { node: "pc", op: "job.noticeResult", args: { id: "job-1", notice: "given_up" } });
    expect(fleet.audit.of("alert.job_unnoticed")).toHaveLength(1);
    agent.send(ev({ id: "job-1", ...done, notice: "pending", at: Date.now() }));
    await vi.waitFor(async () => {
      expect((await api.get("/v1/jobs/pc/job-1"))?.body).toMatchObject({ job: { notice: "given_up" } });
    });
    expect(agent.reqs.filter(req => req.op === "job.noticeResult").map(req => (req.args as { notice: string }).notice).sort()).toEqual(["commented", "given_up", "given_up"]);
    await fleet.close();
  });

  it("tells a node only the notice results it has not confirmed", async () => {
    const fleet = await startTestFleet();
    const agent = await fleet.online("pc");
    const ended = Date.now();
    const done = { outcome: "exited", exit: 0, state: "exited", ended, tail: "shipped" };
    agent.send(ev({ id: "known", ...done, notice: "commented" }));
    agent.send(ev({ id: "held", ...done, notice: "pending" }));
    const api = client(fleet.config.socketPath);
    await vi.waitFor(() => expect(fleet.jobs.get("pc", "known")).toMatchObject({ notice: "commented" }));
    agent.answer = () => "never";
    const pending = api.post("/v1/op", { node: "pc", op: "job.noticeResult", args: { id: "held", notice: "given_up" } });
    await vi.waitFor(() => expect(agent.reqs.filter(req => req.op === "job.noticeResult")).toHaveLength(1));
    agent.terminate();
    await vi.waitFor(() => expect(fleet.connections.status("pc")).toBe("offline"));
    const again = fleet.agent({ node: "pc", key: agent.key });
    expect((await again.connect()).ok).toBe(true);
    await vi.waitFor(() => expect(again.reqs.filter(req => req.op === "job.noticeResult").map(req => (req.args as { id: string }).id)).toEqual(["held"]));
    again.send({ v: 1, t: "res", id: again.reqs[0]?.id, invVersion: 1, store: again.store, ok: true, result: { ok: true } });
    await vi.waitFor(() => expect(fleet.db.prepare("SELECT node_notice FROM jobs WHERE id = 'held'").get()).toEqual({ node_notice: "given_up" }));
    expect(fleet.db.prepare("SELECT node_notice FROM jobs WHERE id = 'known'").get()).toEqual({ node_notice: "commented" });
    again.terminate();
    await vi.waitFor(() => expect(fleet.connections.status("pc")).toBe("offline"));
    const third = fleet.agent({ node: "pc", key: agent.key });
    expect((await third.connect()).ok).toBe(true);
    expect(third.reqs.filter(req => req.op === "job.noticeResult")).toEqual([]);
    await pending;
    await fleet.close();
  });
});
