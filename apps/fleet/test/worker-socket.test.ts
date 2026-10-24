// The worker-scoped client socket (T-440): a second Unix socket beside the owner's, for callers that reach the control
// plane's fleet through a forward. It serves the same routes, but refuses what only the owner (or a client on the control
// plane) may do: place a lane or a worktree on a node outside `startNodes`, type or deliver into a protected lane, stop one,
// revoke a node, move a Rollout, change a connection's policy, push memory. The owner socket keeps everything, and the
// negative controls here show the same calls still work on it, so a refusal is the scope's and not a broken fixture.
import { statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { startTestFleet, type TestFleet } from "./helpers/fleet.ts";
import type { FakeAgent } from "./helpers/fake-agent.ts";
import { nodeQueue } from "./helpers/node-queue.ts";
import { client } from "./helpers/socket-client.ts";
import { tempDir } from "./helpers/temp.ts";
import type { FleetOptions } from "../src/serve.ts";

const ALLOW_ALL = { updater: () => true, principal: () => true };

type World = { fleet: TestFleet; ctl: FakeAgent; pc: FakeAgent; srv: FakeAgent; owner: ReturnType<typeof client>; worker: ReturnType<typeof client>; workerPath: string };

// ctl runs the manager (protected) and an ordinary lane; pc and edge each run one lane.
async function world(o: FleetOptions = {}): Promise<World> {
  const dir = tempDir();
  const workerPath = join(dir, "s", "w.sock");
  const fleet = await startTestFleet({
    dir, rolloutAuthority: ALLOW_ALL, ...o,
    config: { workerSocket: { path: workerPath, protectedLanes: ["manager"], startNodes: ["pc", "edge"] } },
  });
  const ctl = await fleet.online("ctl");
  const pc = await fleet.online("pc");
  const srv = await fleet.online("edge");
  for (const a of [ctl, pc, srv]) nodeQueue(a);
  ctl.inventory([{ workerId: "ctl.3fa2c1d0.0", window: "manager", cwd: "/work", status: "idle", pid: 100 }, { workerId: "ctl.3fa2c1d0.1", window: "worker-a", cwd: "/work", status: "idle", pid: 100 }]);
  pc.inventory([{ workerId: "pc.3fa2c1d0.0", window: "pc-lane", cwd: "/work", status: "idle", pid: 100 }]);
  srv.inventory([{ workerId: "edge.3fa2c1d0.0", window: "srv-lane", cwd: "/work", status: "idle", pid: 100 }]);
  await vi.waitFor(() => expect(fleet.lanes.list()).toHaveLength(4));
  return { fleet, ctl, pc, srv, owner: client(fleet.config.socketPath, { "x-morndo-client": "lanes" }), worker: client(workerPath, { "x-morndo-client": "lanes" }), workerPath };
}

const sent = (a: FakeAgent, ...ops: string[]) => a.reqs.filter(r => ops.includes(r.op));
const refused = (r: { status: number; body: unknown } | null) => {
  expect(r?.status).toBe(200);
  expect(r?.body).toMatchObject({ ok: false, error: { code: "not_allowed", executed: "no", message: expect.stringContaining("worker socket") }, store: null, storeSeq: null });
};
const op = (target: Record<string, string>, name: string, args: Record<string, unknown> = {}, key?: string) => ({ ...target, op: name, args, ...(key ? { key } : {}) });
const audit = (w: World) => w.fleet.audit.recent(500);

describe("worker socket: what a forwarded caller is refused", () => {
  it("worker socket: lane.start on a node outside startNodes is refused and never sent", async () => {
    const w = await world();
    for (const node of ["ctl", "mac"]) {
      refused(await w.worker.post("/v1/op", op({ node }, "lane.start", { name: "intruder", cwd: "/work" }, "lanes:s1")));
    }
    refused(await w.worker.post("/v1/op", op({ lane: "worker-a" }, "lane.start", { name: "intruder", cwd: "/work" }, "lanes:s2")));
    refused(await w.worker.post("/v1/op", op({ workerId: "ctl.3fa2c1d0.1" }, "lane.start", { name: "intruder", cwd: "/work" }, "lanes:s3")));
    expect(sent(w.ctl, "lane.start")).toHaveLength(0);
  });

  it("worker socket: lane.start of a protected lane name is refused", async () => {
    const w = await world();
    refused(await w.worker.post("/v1/op", op({ node: "pc" }, "lane.start", { name: "manager", cwd: "/work" }, "lanes:s4")));
    expect(sent(w.pc, "lane.start")).toHaveLength(0);
  });

  it("worker socket: worktree.add and file.put outside startNodes are refused", async () => {
    const w = await world();
    refused(await w.worker.post("/v1/op", op({ node: "ctl" }, "worktree.add", { repo: "/work/r", name: "x", base: "main" }, "lanes:w1")));
    refused(await w.worker.post("/v1/op", op({ node: "ctl" }, "file.put", { upload: "u1", offset: 0, bytes: "AA==", final: true, name: "a.txt" }, "lanes:w2")));
    expect(sent(w.ctl, "worktree.add", "file.put")).toHaveLength(0);
  });

  it("worker socket: pane.keys and pane.send into a protected lane are refused by lane, worker ID, args.workerId and expect.window", async () => {
    const w = await world();
    const manager = "ctl.3fa2c1d0.0";
    for (const name of ["pane.keys", "pane.send"] as const) {
      const body = name === "pane.keys" ? { data: "x" } : { text: "x" };
      const key = name === "pane.send" ? "lanes:k1" : undefined;
      refused(await w.worker.post("/v1/op", op({ lane: "manager" }, name, body, key)));
      refused(await w.worker.post("/v1/op", op({ workerId: manager }, name, body, key)));
      refused(await w.worker.post("/v1/op", op({ node: "ctl" }, name, { ...body, workerId: manager }, key)));
      refused(await w.worker.post("/v1/op", op({ node: "ctl" }, name, { ...body, workerId: "ctl.3fa2c1d0.1", expect: { server: "3fa2c1d0", window: "manager" } }, key)));
    }
    expect(sent(w.ctl, "pane.keys", "pane.send")).toHaveLength(0);
  });

  it("worker socket: pane.keys into a pane no inventory lists is refused", async () => {
    const w = await world();
    refused(await w.worker.post("/v1/op", op({ workerId: "ctl.3fa2c1d0.9" }, "pane.keys", { data: "x" })));
    expect(sent(w.ctl, "pane.keys")).toHaveLength(0);
  });

  it("worker socket: two windows named manager are both protected, by their worker IDs too", async () => {
    const w = await world();
    w.ctl.inventory([{ workerId: "ctl.3fa2c1d0.0", window: "manager", cwd: "/a", status: "idle", pid: 100 }, { workerId: "ctl.3fa2c1d0.5", window: "manager", cwd: "/b", status: "idle", pid: 100 }, { workerId: "ctl.3fa2c1d0.1", window: "worker-a", cwd: "/work", status: "idle", pid: 100 }]);
    await vi.waitFor(() => expect(w.fleet.lanes.get("manager")?.conflict).toBe(true));
    refused(await w.worker.post("/v1/op", op({ workerId: "ctl.3fa2c1d0.5" }, "pane.keys", { data: "x" })));
    expect(sent(w.ctl, "pane.keys")).toHaveLength(0);
  });

  it("worker socket: a delivery to a protected lane is refused, by lane and by worker ID; cancelling one is refused", async () => {
    const w = await world();
    for (const target of [{ lane: "manager" }, { workerId: "ctl.3fa2c1d0.0" }]) {
      const r = await w.worker.post("/v1/deliveries", { id: `lanes:d-${Object.keys(target)[0]}`, text: "hi", ...target });
      expect(r?.status).toBe(200);
      expect(r?.body).toMatchObject({ ok: false, error: { code: "not_allowed", executed: "no" } });
    }
    expect(sent(w.ctl, "lane.deliver")).toHaveLength(0);
    // a delivery the owner socket made to the manager: the worker socket cannot cancel it, the owner socket can
    const made = await w.owner.post("/v1/deliveries", { id: "lanes:d-owner", lane: "manager", text: "hi" });
    expect(made?.body).toMatchObject({ ok: true });
    const cancelled = await w.worker.post("/v1/deliveries/lanes%3Ad-owner/cancel");
    expect(cancelled?.body).toMatchObject({ ok: false, error: { code: "not_allowed" } });
    expect(sent(w.ctl, "delivery.cancel")).toHaveLength(0);
  });

  it("worker socket: lane.stop of a protected lane is refused", async () => {
    const w = await world();
    refused(await w.worker.post("/v1/op", op({ node: "ctl" }, "lane.stop", { name: "manager" }, "lanes:t1")));
    expect(sent(w.ctl, "lane.stop")).toHaveLength(0);
  });

  it("worker socket: node revoke is refused and the node stays", async () => {
    const w = await world();
    const r = await w.worker.post("/v1/nodes/edge/revoke");
    expect(r?.status).toBe(403);
    expect(r?.body).toMatchObject({ error: "not_allowed", message: expect.stringContaining("worker socket") });
    expect(w.fleet.nodes.list().find(n => n.name === "edge")?.revokedAt).toBeNull();
  });

  it("worker socket: rollout committed, halt and resume and update.apply are refused even when the authority would say yes", async () => {
    const w = await world();
    for (const [path, body] of [["committed", { version: "1.2.3" }], ["halt", { version: "1.2.3", machine: "pc", reason: "x" }], ["resume", { version: "1.2.3" }]] as const) {
      const r = await w.worker.post(`/v1/rollout/${path}`, body);
      expect(r?.status, path).toBe(403);
      expect(r?.body, path).toMatchObject({ error: "not_allowed", message: expect.stringContaining("worker socket") });
    }
    expect(w.fleet.rollouts.latest()).toBeNull();
    refused(await w.worker.post("/v1/op", op({ node: "pc" }, "update.apply", { version: "1.2.3" }, "hub:u1")));
    expect(sent(w.pc, "update.apply")).toHaveLength(0);
  });

  it("worker socket: connections.*, memory.sync are refused", async () => {
    const w = await world();
    for (const name of ["connections.priority", "connections.role", "connections.revoke", "connections.narrow", "memory.sync"]) {
      refused(await w.worker.post("/v1/op", op({ node: "pc" }, name, {}, "hub:c1")));
    }
    expect(sent(w.pc, "connections.priority", "connections.role", "connections.revoke", "connections.narrow", "memory.sync")).toHaveLength(0);
  });

  it("worker socket: every refusal is audited as actor worker, without text or args", async () => {
    const w = await world();
    await w.worker.post("/v1/op", op({ lane: "manager" }, "pane.send", { text: "SECRET-TEXT" }, "lanes:a1"));
    await w.worker.post("/v1/op", op({ node: "ctl" }, "lane.start", { name: "intruder", cwd: "/secret/cwd" }, "lanes:a2"));
    await w.worker.post("/v1/nodes/edge/revoke");
    await w.worker.post("/v1/rollout/halt", { version: "1.2.3", machine: "pc", reason: "SECRET-REASON" });
    const rows = audit(w).filter(r => r.actor === "worker" && r.action === "refused");
    expect(rows.map(r => r.detail.what).sort()).toEqual(["node.revoke", "op.lane.start", "op.pane.send", "rollout.halt"]);
    for (const r of rows) expect(r.detail).toMatchObject({ client: "lanes", reason: expect.any(String) });
    const all = JSON.stringify(audit(w));
    expect(all).not.toContain("SECRET-TEXT");
    expect(all).not.toContain("SECRET-REASON");
    expect(all).not.toContain("/secret/cwd");
  });
});

describe("worker socket: what a forwarded caller still does", () => {
  it("worker socket: reads, peeks of a protected pane and the events stream work", async () => {
    const w = await world();
    expect((await w.worker.get("/v1/caps"))?.status).toBe(200);
    expect(((await w.worker.get("/v1/lanes"))?.body as unknown[]).length).toBe(4);
    expect((await w.worker.get("/v1/nodes"))?.status).toBe(200);
    expect((await w.worker.get("/v1/alerts"))?.status).toBe(200);
    expect((await w.worker.get("/v1/jobs"))?.status).toBe(200);
    expect((await w.worker.get("/v1/rollout"))?.status).toBe(200);
    expect((await w.worker.post("/v1/op", op({ node: "ctl" }, "inventory.get")))?.body).toMatchObject({ ok: true });
    expect((await w.worker.post("/v1/op", op({ lane: "manager" }, "pane.frame")))?.body).toMatchObject({ ok: true });
    expect((await w.worker.post("/v1/op", op({ lane: "manager" }, "pane.capture", { lines: 20 })))?.body).toMatchObject({ ok: true });
    expect(sent(w.ctl, "pane.frame", "pane.capture")).toHaveLength(2);
    const events = await w.worker.events();
    await events.when(() => events.received.some(e => e.t === "status"));
    events.close();
  });

  it("worker socket: lane.start, worktree.add on a startNodes node work and are audited as actor worker", async () => {
    const w = await world();
    expect((await w.worker.post("/v1/op", op({ node: "pc" }, "lane.start", { name: "new-pc", cwd: "/work" }, "lanes:o1")))?.body).toMatchObject({ ok: true });
    expect((await w.worker.post("/v1/op", op({ node: "edge" }, "lane.start", { name: "new-srv", cwd: "/work" }, "lanes:o2")))?.body).toMatchObject({ ok: true });
    expect((await w.worker.post("/v1/op", op({ node: "pc" }, "worktree.add", { repo: "/work/r", name: "wt", base: "main" }, "lanes:o3")))?.body).toMatchObject({ ok: true });
    expect(sent(w.pc, "lane.start", "worktree.add")).toHaveLength(2);
    expect(sent(w.srv, "lane.start")).toHaveLength(1);
    const rows = audit(w).filter(r => r.action === "op.lane.start" || r.action === "op.worktree.add");
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.actor).toBe("worker");
  });

  it("worker socket: pane.send, pane.keys and a delivery to a lane that is not protected work, on the control plane too", async () => {
    const w = await world();
    expect((await w.worker.post("/v1/op", op({ lane: "worker-a" }, "pane.send", { text: "hi" }, "lanes:p1")))?.body).toMatchObject({ ok: true });
    expect((await w.worker.post("/v1/op", op({ lane: "worker-a" }, "pane.keys", { data: "x" })))?.body).toMatchObject({ ok: true });
    expect((await w.worker.post("/v1/op", op({ workerId: "pc.3fa2c1d0.0" }, "pane.send", { text: "hi" }, "lanes:p2")))?.body).toMatchObject({ ok: true });
    expect((await w.worker.post("/v1/deliveries", { id: "lanes:dd1", lane: "worker-a", text: "hi" }))?.body).toMatchObject({ ok: true });
    expect((await w.worker.post("/v1/deliveries", { id: "lanes:dd2", workerId: "pc.3fa2c1d0.0", text: "hi" }))?.body).toMatchObject({ ok: true });
    expect(sent(w.ctl, "pane.send", "pane.keys", "lane.deliver")).toHaveLength(3);
    expect(sent(w.pc, "pane.send", "lane.deliver")).toHaveLength(2);
    const cancelled = await w.worker.post("/v1/deliveries/lanes%3Add1/cancel");
    expect(cancelled?.status).toBe(200);
    expect(cancelled?.body).not.toMatchObject({ error: { code: "not_allowed" } });
  });

  it("worker socket: lane.stop of an ordinary lane and job.cancel work", async () => {
    const w = await world();
    expect((await w.worker.post("/v1/op", op({ node: "pc" }, "lane.stop", { name: "pc-lane" }, "lanes:t2")))?.body).toMatchObject({ ok: true });
    expect((await w.worker.post("/v1/op", op({ node: "ctl" }, "lane.stop", { name: "worker-a" }, "lanes:t3")))?.body).toMatchObject({ ok: true });
    // a job the fleet doesn't know: the answer is the job mirror's own denial, not the scope's
    expect((await w.worker.post("/v1/op", op({ node: "pc" }, "job.cancel", { id: "nope", token: "t" })))?.body).toMatchObject({ ok: false, error: { code: "denied" } });
  });
});

describe("owner socket: nothing is taken away", () => {
  it("owner socket: the ops the worker socket refuses still work", async () => {
    const w = await world();
    expect((await w.owner.post("/v1/op", op({ node: "ctl" }, "lane.start", { name: "on-cp", cwd: "/work" }, "lanes:c1")))?.body).toMatchObject({ ok: true });
    expect((await w.owner.post("/v1/op", op({ lane: "manager" }, "pane.keys", { data: "x" })))?.body).toMatchObject({ ok: true });
    expect((await w.owner.post("/v1/op", op({ lane: "manager" }, "pane.send", { text: "x" }, "lanes:c2")))?.body).toMatchObject({ ok: true });
    expect((await w.owner.post("/v1/op", op({ node: "ctl" }, "lane.stop", { name: "worker-a" }, "lanes:c3")))?.body).toMatchObject({ ok: true });
    expect((await w.owner.post("/v1/deliveries", { id: "lanes:c4", lane: "manager", text: "hi" }))?.body).toMatchObject({ ok: true });
    expect((await w.owner.post("/v1/rollout/halt", { version: "1.2.3", machine: "pc", reason: "x" }))?.status).toBe(200);
    const apply = await w.owner.post("/v1/op", op({ node: "pc" }, "update.apply", { version: "1.2.3" }, "hub:u2"));
    expect(JSON.stringify(apply?.body)).not.toContain("worker socket");
    expect((await w.owner.post("/v1/nodes/edge/revoke"))?.body).toMatchObject({ ok: true, revoked: true });
  });

  it("owner socket: audit actor stays client", async () => {
    const w = await world();
    await w.owner.post("/v1/op", op({ node: "ctl" }, "lane.start", { name: "on-cp", cwd: "/work" }, "lanes:c5"));
    const row = audit(w).find(r => r.action === "op.lane.start");
    expect(row?.actor).toBe("client");
    expect(audit(w).some(r => r.actor === "worker")).toBe(false);
  });
});

describe("worker socket: the socket itself", () => {
  it("worker socket: mode 0600 beside the owner socket, removed on close; the owner path is unchanged", async () => {
    const w = await world();
    expect(statSync(w.workerPath).mode & 0o777).toBe(0o600);
    expect(statSync(w.workerPath).isSocket()).toBe(true);
    expect(w.fleet.config.socketPath).toBe(join(w.fleet.dir, "s", "f.sock"));
    expect(existsSync(w.fleet.config.socketPath)).toBe(true);
    await w.fleet.close();
    expect(existsSync(w.workerPath)).toBe(false);
    expect(existsSync(w.fleet.config.socketPath)).toBe(false);
  });

  it("worker socket: without a workerSocket setting the socket sits beside the owner's, and everything starts closed", async () => {
    const fleet = await startTestFleet();
    const path = join(fleet.dir, "s", "fleet-worker.sock");
    expect(existsSync(path)).toBe(true);
    await fleet.online("pc");
    refused(await client(path).post("/v1/op", op({ node: "pc" }, "lane.start", { name: "x", cwd: "/work" }, "lanes:z1")));
    expect((await client(path).get("/v1/caps"))?.status).toBe(200);
  });
});
