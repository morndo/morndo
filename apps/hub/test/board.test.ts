// The board on the hub (ADR-0015): the agents' routes under a bearer token (B1), the principal's as Commands (AC7),
// the rules applied with the board as it is (B2–B5), every change written with its event and recorded (B6), and the
// whole board pushed to every feed after a hello and on every change. Real server on a random port, fake passkeys,
// synthetic data only.
import type { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";
import { frameText } from "./http-crash-fixture.ts";
import { ObservationService } from "../src/application/observation-service.ts";
import type { RunView } from "@morndo/protocol";

let hub: InProcessHub;
let now: number;
let managerToken: string;
let workerToken: string;
let runs: RunView[];                                              // the lanes' runs, as the projector would hold them
const HOUR = 3_600_000;

function frames(ws: WebSocket) {
  const seen: Record<string, unknown>[] = [];
  const waiters: { t: string; resolve: (m: Record<string, unknown>) => void }[] = [];
  ws.on("message", d => {
    const m = JSON.parse(frameText(d)) as Record<string, unknown>;
    seen.push(m);
    const i = waiters.findIndex(w => w.t === m.t);
    if (i !== -1) { waiters[i]?.resolve(m); waiters.splice(i, 1); }
  });
  // next(t, from): the first frame of that type at index `from` or later, already seen or still to come (a change's
  // frame can land before the HTTP answer that caused it).
  const next = (t: string, from = seen.length) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const had = seen.slice(from).find(m => m.t === t);
    if (had) return resolve(had);
    waiters.push({ t, resolve });
    setTimeout(() => reject(new Error(`no ${t} frame; seen ${JSON.stringify(seen.map(m => m.t))}`)), 3000);
  });
  return { seen, next };
}
type Body = Record<string, unknown>;
const agent = (token: string, lane?: string) => ({
  get: (path: string) => fetch(hub.base + path, { headers: { authorization: `Bearer ${token}`, ...(lane ? { "x-morndo-lane": lane } : {}) } }),
  post: (path: string, body: unknown) => fetch(hub.base + path, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(lane ? { "x-morndo-lane": lane } : {}) }, body: JSON.stringify(body),
  }),
});
const json = async (r: Response) => (await r.json()) as Body;

beforeEach(async () => {
  now = Date.now();
  // The roster lists the manager and two lanes, so the board can say which assignees are running.
  const tmux = {
    listWorkers: async () => [{ id: "%1", name: "manager", location: "/w", node: "local", offline: false }, { id: "%2", name: "builder", location: "/w", node: "local", offline: false }],
    capture: async () => null, captureMany: async () => new Map<string, string | null>(), send: async () => ({ problem: null, typedAt: now }),
  };
  const observation = new ObservationService(tmux, 1000, () => now);
  await observation.poll();
  runs = [];
  hub = await startInProcessHub({ now: () => now, observation, runs: () => runs });
  managerToken = hub.agents.issue("manager", "manager").secret;
  workerToken = hub.agents.issue("lanes", "worker").secret;
});
afterEach(async () => { await hub.close(); });

describe("the agents' side (B1)", () => {
  it("a bearer token says who calls: the manager's token is the manager; a worker token is the lane it names, and needs one", async () => {
    expect((await json(await agent(managerToken).get("/api/agent/whoami"))).actor).toMatchObject({ kind: "manager", name: "manager" });
    expect((await json(await agent(workerToken, "builder").get("/api/agent/whoami"))).actor).toMatchObject({ kind: "worker", name: "builder" });
    expect((await agent(workerToken).get("/api/agent/whoami")).status).toBe(400);
    expect((await agent(workerToken, "bad name").get("/api/agent/whoami")).status).toBe(400);
    // A worker token naming the manager's lane is still a worker (it never gains the manager's rights).
    expect((await json(await agent(workerToken, "manager").get("/api/agent/whoami"))).actor).toMatchObject({ kind: "worker" });
  });
  it("a live token without its lane is charged to the token, never to the address's refusals", async () => {
    for (let i = 0; i < 25; i++) expect((await agent(workerToken).get("/api/agent/whoami")).status).toBe(400);   // past the 20 refusals an address gets
    expect(await json(await agent(workerToken).get("/api/agent/whoami"))).toEqual({ error: "lane_needed" });
    expect((await agent(workerToken, "builder").get("/api/agent/whoami")).status).toBe(200);
  });
  it("no token, an unknown one or a revoked one is refused, and the refusals are limited per caller", async () => {
    expect((await fetch(`${hub.base}/api/agent/board`)).status).toBe(401);
    expect((await agent("mat_nope").get("/api/agent/board")).status).toBe(401);
    const { token, secret } = hub.agents.issue("old", "worker");
    expect((await agent(secret, "x").get("/api/agent/board")).status).toBe(200);
    expect(hub.agents.revoke(token.id)).toBe(true);
    expect(hub.agents.revoke(token.id)).toBe(false);
    expect((await agent(secret, "x").get("/api/agent/board")).status).toBe(401);
    expect(hub.store.agentToken(token.id)?.lastUsedAt).toBe(now);
  });
  it("the agents' routes need no cookie, no Origin and no proxy identity; everything else still does", async () => {
    expect((await agent(managerToken).post("/api/agent/board/tasks", { title: "x" })).status).toBe(200);
    expect((await fetch(`${hub.base}/api/board`)).status).toBe(401);
  });
});

describe("the work, as a real org runs it (B2–B5)", () => {
  it("the manager files a task for a lane; the lane takes it up, offers it for review; the manager accepts", async () => {
    const made = await json(await agent(managerToken).post("/api/agent/board/tasks", { title: "Build the login page", description: "Form plus tests", assignee: "builder" }));
    expect(made.task).toMatchObject({ key: "T-1", status: "todo", assignee: "builder", rev: 1 });
    const builder = agent(workerToken, "builder");
    expect((await json(await builder.post("/api/agent/board/tasks/T-1", { action: "move", to: "doing" }))).task).toMatchObject({ status: "doing", rev: 2 });
    expect((await json(await builder.get("/api/agent/board"))).tasks).toHaveLength(1);
    const offered = await json(await builder.post("/api/agent/board/tasks/T-1", { action: "move", to: "review" }));
    expect(offered.task).toMatchObject({ status: "review" });
    // The lane can't mark it done (B3); the manager can.
    expect((await builder.post("/api/agent/board/tasks/T-1", { action: "move", to: "done" })).status).toBe(400);
    expect(await json(await builder.post("/api/agent/board/tasks/T-1", { action: "move", to: "done" }))).toEqual({ error: "bad_transition", from: "review" });
    // The manager's Done names its evidence (B9).
    expect(await json(await agent(managerToken).post("/api/agent/board/tasks/T-1", { action: "move", to: "done" }))).toEqual({ error: "reason_needed" });
    const done = await json(await agent(managerToken).post("/api/agent/board/tasks/T-1", { action: "move", to: "done", reason: "npm test: 14 passed" }));
    expect(done.task).toMatchObject({ status: "done", doneAt: now });
    const record = await json(await agent(managerToken).get("/api/agent/board/tasks/T-1"));
    expect((record.events as Body[]).map(e => (e.change as Body).kind)).toEqual(["created", "moved", "moved", "moved"]);
    expect((record.events as Body[])[1]?.actor).toMatchObject({ kind: "worker", name: "builder" });
    // Audit: who changed what, never the words.
    expect(hub.store.auditOf("BoardChanged", 0).map(e => (e as { change: string }).change)).toEqual(["created", "moved", "moved", "moved"]);
  });
  it("a lane moves only its own tasks, may not assign, and its own filings are proposals in the backlog", async () => {
    await agent(managerToken).post("/api/agent/board/tasks", { title: "For the reviewer", assignee: "reviewer" });
    const builder = agent(workerToken, "builder");
    expect((await builder.post("/api/agent/board/tasks/T-1", { action: "move", to: "doing" })).status).toBe(403);
    expect(await json(await builder.post("/api/agent/board/tasks/T-1", { action: "assign", to: "builder" }))).toEqual({ error: "not_allowed" });
    const filed = await json(await builder.post("/api/agent/board/tasks", { title: "Found a bug", assignee: "builder", status: "doing" }));
    expect(filed.task).toMatchObject({ key: "T-2", status: "backlog", assignee: null });
    // The manager hands it over: it becomes the lane's to do.
    expect((await json(await agent(managerToken).post("/api/agent/board/tasks/T-2", { action: "assign", to: "builder" }))).task).toMatchObject({ status: "todo", assignee: "builder" });
  });
  it("one task in progress per lane (B5): the second is refused naming the first, with 409", async () => {
    const m = agent(managerToken);
    await m.post("/api/agent/board/tasks", { title: "A", assignee: "builder" });
    await m.post("/api/agent/board/tasks", { title: "B", assignee: "builder" });
    const builder = agent(workerToken, "builder");
    expect((await builder.post("/api/agent/board/tasks/T-1", { action: "move", to: "doing" })).status).toBe(200);
    const r = await builder.post("/api/agent/board/tasks/T-2", { action: "move", to: "doing" });
    expect(r.status).toBe(409);
    expect(await json(r)).toEqual({ error: "one_doing", other: "T-1" });
    expect(hub.board.workingOn("builder")?.key).toBe("T-1");
  });
  it("a change that names a stale revision is refused (409 changed), an unknown task is 404, a bad body 400", async () => {
    await agent(managerToken).post("/api/agent/board/tasks", { title: "A", assignee: "builder" });
    const builder = agent(workerToken, "builder");
    expect((await builder.post("/api/agent/board/tasks/T-1", { action: "move", to: "doing", ifRev: 1 })).status).toBe(200);
    const stale = await builder.post("/api/agent/board/tasks/T-1", { action: "move", to: "review", ifRev: 1 });
    expect(stale.status).toBe(409);
    expect(await json(stale)).toEqual({ error: "changed" });
    expect((await builder.post("/api/agent/board/tasks/T-9", { action: "comment", text: "hi" })).status).toBe(404);
    expect((await builder.post("/api/agent/board/tasks/T-1", { action: "move", to: "sideways" })).status).toBe(400);
    expect((await builder.post("/api/agent/board/tasks", { title: "" })).status).toBe(400);
  });
  it("keys are never reused (B7), and a refused filing burns no number", async () => {
    await agent(managerToken).post("/api/agent/board/tasks", { title: "A" });
    await agent(managerToken).post("/api/agent/board/tasks", { title: "B" });
    expect(hub.store.peekTaskNumber()).toBe(3);
    expect((await agent(managerToken).post("/api/agent/board/tasks", { title: "   " })).status).toBe(400);
    expect(hub.store.peekTaskNumber()).toBe(3);
    expect((await json(await agent(managerToken).post("/api/agent/board/tasks", { title: "C" }))).task).toMatchObject({ key: "T-3" });
  });
  it("one in progress per lane holds on filing too (B5): a task filed straight into progress for a busy lane is refused", async () => {
    await agent(managerToken).post("/api/agent/board/tasks", { title: "A", assignee: "builder", status: "doing" });
    const r = await agent(managerToken).post("/api/agent/board/tasks", { title: "B", assignee: "builder", status: "doing" });
    expect(r.status).toBe(409);
    expect(await json(r)).toEqual({ error: "one_doing", other: "T-1" });
  });
  it("a refused move says where the task is", async () => {
    await agent(managerToken).post("/api/agent/board/tasks", { title: "A", assignee: "builder" });
    const r = await agent(workerToken, "builder").post("/api/agent/board/tasks/T-1", { action: "move", to: "done" });
    expect(await json(r)).toEqual({ error: "bad_transition", from: "todo" });
  });
});

describe("the principal's side (AC7) and the feed", () => {
  it("a change from the app is a Command: fresh step-up, or 403 step_up; a look never needs one", async () => {
    const cookie = await hub.cookie();
    const post = (path: string, body: unknown) => hub.post(path, body, { cookie: `__Host-morndo=${cookie}` });
    const made = await post("/api/board/tasks", { title: "From the phone", assignee: "builder", priority: "high" });
    expect(made.status).toBe(200);
    expect((await json(made)).task).toMatchObject({ key: "T-1", status: "todo", createdBy: { kind: "principal" } });
    expect((await json(await post("/api/board/tasks/T-1", { action: "comment", text: "go" }))).task).toMatchObject({ comments: 1 });
    now += 2 * HOUR;                                                // past the default 1 h step-up window
    expect((await post("/api/board/tasks/T-1", { action: "move", to: "doing" })).status).toBe(403);
    expect(await json(await post("/api/board/tasks/T-1", { action: "move", to: "doing" }))).toEqual({ error: "step_up" });
    const look = await fetch(`${hub.base}/api/board/tasks/T-1`, { headers: { cookie: `__Host-morndo=${cookie}` } });
    expect(look.status).toBe(200);
    expect(((await json(look)).events as Body[]).length).toBe(2);
  });
  it("every feed gets the whole board after its hello and on every change, with the lanes running now", async () => {
    const cookie = await hub.cookie();
    const a = await hub.socket("/api/feed", cookie);
    const fa = frames(a);
    a.send(JSON.stringify({ t: "hello" }));
    const first = await fa.next("board");
    expect(first).toMatchObject({ t: "board", tasks: [], lanes: ["builder", "manager"] });
    const mark = fa.seen.length;
    expect((await agent(managerToken).post("/api/agent/board/tasks", { title: "Live", assignee: "builder" })).status).toBe(200);
    const pushed = await fa.next("board", mark);
    expect((pushed.tasks as Body[]).map(t => t.key)).toEqual(["T-1"]);
    const b = await hub.socket("/api/feed", cookie);
    const fb = frames(b);
    b.send(JSON.stringify({ t: "hello" }));
    expect(((await fb.next("board")).tasks as Body[]).length).toBe(1);
    a.close(); b.close();
  });
  it("the board frame carries each lane's run (ADR-0032 §6); a change of runs alone is pushed at most about once a second", async () => {
    const run = (phase: RunView["phase"]): RunView => ({ lane: "builder", node: "pc", phase, deadline: null, overdue: false, since: now, source: "session" });
    const cookie = await hub.cookie();
    const a = await hub.socket("/api/feed", cookie);
    const fa = frames(a);
    a.send(JSON.stringify({ t: "hello" }));
    expect(await fa.next("board")).toMatchObject({ t: "board", runs: [] });
    runs = [run("working")];
    let mark = fa.seen.length;
    hub.board.runsChanged();                                        // nothing pushed for a second: at once
    expect((await fa.next("board", mark)).runs).toEqual([run("working")]);
    const firstAt = performance.now();
    mark = fa.seen.length;
    for (const phase of ["waiting", "ended", "gone"] as const) { runs = [run(phase)]; hub.board.runsChanged(); }
    const trailing = await fa.next("board", mark);
    expect(performance.now() - firstAt).toBeGreaterThan(900);
    expect(trailing.runs).toEqual([run("gone")]);                   // the runs as they are when it goes
    await new Promise(r => setTimeout(r, 300));
    // negative control: told at once on every change, the burst is three frames (b10-runs-throttle).
    expect(fa.seen.slice(mark).filter(m => m.t === "board")).toHaveLength(1);
    // The agents' board answer carries them too.
    expect((await json(await agent(managerToken).get("/api/agent/board"))).runs).toEqual([run("gone")]);
    a.close();
  });
  it("the principal's board writes draw on the commands bucket like a send", async () => {
    const cookie = await hub.cookie();
    for (let i = 0; i < 30; i++) await hub.post("/api/board/tasks", { title: `t${i}` }, { cookie: `__Host-morndo=${cookie}` });
    const r = await hub.post("/api/board/tasks", { title: "one more" }, { cookie: `__Host-morndo=${cookie}` });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toMatch(/^\d+$/);
  });
});
