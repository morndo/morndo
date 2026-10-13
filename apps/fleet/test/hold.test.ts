import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ServiceHealth } from "@morndo/protocol";
import { SCHEMA_VERSION } from "../src/adapters/migrations.ts";
import { startTestFleet } from "./helpers/fleet.ts";
import { client } from "./helpers/socket-client.ts";
import { tempDir } from "./helpers/temp.ts";

const W = "pc.3fa2c1d0.4";

describe("a hold on the fleet", () => {
  it("refuses a send with 503 and executed no, and still answers health, caps, and a revocation", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "hold.json"), JSON.stringify({
      services: ["fleet"], reason: "drain", version: "0.0.0", since: new Date().toISOString(),
    }));
    const fleet = await startTestFleet({ dir });
    const agent = await fleet.online("pc");
    const api = client(fleet.config.socketPath);
    const health = await api.get("/v1/health");
    expect(health?.status).toBe(200);
    expect(ServiceHealth.safeParse(health?.body).success).toBe(true);
    expect(health?.body).toMatchObject({ version: "0.0.0", schema: SCHEMA_VERSION, ready: true });
    expect((await api.get("/v1/caps"))?.status).toBe(200);
    const sent = await api.raw("/v1/op", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workerId: W, op: "pane.send",
        args: { workerId: W, text: "words", expect: { server: "3fa2c1d0", window: "api" } },
        key: "hub:hold",
      }),
    });
    expect(sent.status).toBe(503);
    expect(sent.headers["retry-after"]).toBe("1");
    expect(JSON.parse(sent.body.toString("utf8"))).toMatchObject({
      ok: false, error: { code: "updating", executed: "no" }, store: null, storeSeq: null,
    });
    expect(agent.reqs).toEqual([]);
    expect((await api.post(`/v1/nodes/pc/revoke`))?.status).toBe(200);
  });
  it("does not record a job notice while held", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "hold.json"), JSON.stringify({
      services: ["fleet"], reason: "drain", version: "0.0.0", since: new Date().toISOString(),
    }));
    const fleet = await startTestFleet({ dir });
    const agent = await fleet.online("pc");
    agent.send({
      v: 1, t: "job", id: "job-1", node: "pc", lane: "builder", name: "pack", class: "default",
      state: "exited", outcome: "exited", exit: 0, durationSec: 1, notify: { kind: "lane", name: "builder" },
      task: null, notice: "pending", at: 1_700_000_000_000, ended: null, tail: "done",
      position: null, reason: null, error: null,
    });
    await vi.waitFor(() => expect(fleet.jobs.get("pc", "job-1")?.notice).toBe("pending"));
    const api = client(fleet.config.socketPath);
    const noticed = await api.raw("/v1/op", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ node: "pc", op: "job.noticeResult", args: { id: "job-1", notice: "commented" } }),
    });
    expect(noticed.status).toBe(503);
    expect(JSON.parse(noticed.body.toString("utf8"))).toMatchObject({ ok: false, error: { code: "updating", executed: "no" } });
    expect(fleet.jobs.get("pc", "job-1")?.notice).toBe("pending");
    expect(agent.reqs.filter(req => req.op === "job.noticeResult")).toHaveLength(0);
  });
  it("still narrows, stops a lane and cancels a job while a send is refused", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "hold.json"), JSON.stringify({
      services: ["fleet"], reason: "drain", version: "0.0.0", since: new Date().toISOString(),
    }));
    const fleet = await startTestFleet({ dir });
    const agent = await fleet.online("pc");
    agent.send({
      v: 1, t: "job", id: "job-1", node: "pc", lane: "builder", name: "pack", class: "default",
      state: "running", outcome: null, exit: null, durationSec: null, notify: { kind: "lane", name: "builder" },
      task: null, notice: "none", at: 1_700_000_000_000, ended: null, tail: "",
      position: null, reason: null, error: null,
    });
    await vi.waitFor(() => expect(fleet.jobs.get("pc", "job-1")).not.toBeNull());
    const api = client(fleet.config.socketPath);
    const post = (body: unknown) => api.raw("/v1/op", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const sent = await post({
      workerId: W, op: "pane.send",
      args: { workerId: W, text: "words", expect: { server: "3fa2c1d0", window: "api" } },
      key: "hub:send",
    });
    expect(sent.status).toBe(503);
    const narrow = await post({ node: "pc", op: "connections.narrow", args: { version: 1, name: "work", action: "off" }, key: "hub:narrow" });
    const stopped = await post({ node: "pc", op: "lane.stop", args: { name: "gone" }, key: "hub:stop" });
    const cancelled = await post({ node: "pc", op: "job.cancel", args: { id: "job-1", token: "lane-token" } });
    expect(JSON.parse(narrow.body.toString("utf8"))).toMatchObject({ ok: true });
    expect(JSON.parse(stopped.body.toString("utf8"))).toMatchObject({ ok: true });
    expect(JSON.parse(cancelled.body.toString("utf8"))).toMatchObject({ ok: true });
    expect(agent.reqs.map(req => req.op)).toEqual(["connections.narrow", "lane.stop", "job.cancel"]);
  });
});
