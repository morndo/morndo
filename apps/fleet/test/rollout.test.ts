// The Rollout the fleet carries (updates design §4.2 RL11/RL12, §4.3, §4.5, §7; ADR-0019 §7): the control plane commits
// only the Version it runs itself, one node's rollback halts the Rollout everywhere with one alert of each kind however
// often the health repeats, a halt outlives a fleet restart, welcome carries the control plane's build and the Rollout,
// the `rollout` message reaches only agents that announced CAP_ROLLOUT, update.apply is gated by CAP_UPDATE, by RL11
// (a node never runs a Version newer than its control plane) and by RL12 (never while the Rollout is halted), and
// GET /v1/nodes shows each node's protocol versions and its last update state, null before any.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CAP_ROLLOUT, CAP_UPDATE, type RolloutWire } from "@morndo/protocol";
import { productVersion } from "@morndo/service-kit";
import { startTestFleet } from "./helpers/fleet.ts";
import { health } from "./helpers/fake-agent.ts";
import { client } from "./helpers/socket-client.ts";
import { tempDir } from "./helpers/temp.ts";

const V = productVersion();                              // the Version this tree runs: the control plane's own
type Body = Record<string, any>;
// The body of an answer, undefined when nothing answered (the client answers null then).
const bodyOf = async (answer: Promise<{ body: unknown } | null>): Promise<Body | undefined> => (await answer)?.body as Body | undefined;

describe("the Rollout the fleet carries (updates §4.2, §7)", () => {
  it("a node's health that says rolled_back halts the Rollout, with one alert of each kind over three identical healths", async () => {
    const fleet = await startTestFleet();
    const api = client(fleet.config.socketPath);
    expect((await bodyOf(api.post("/v1/rollout/committed", { version: V })))?.ok).toBe(true);
    const b = await fleet.online("n2");
    for (let i = 0; i < 3; i++)
      b.health(health({ update: { state: "rolled_back", version: "0.3.9", target: V, reason: "a check failed after the swap" } }));
    await vi.waitFor(async () => expect((await bodyOf(api.get("/v1/rollout")))?.rollout?.halted).toBe(true));
    const rollout = (await bodyOf(api.get("/v1/rollout")))?.rollout;
    expect(rollout).toMatchObject({ haltedBy: "n2", haltReason: "a check failed after the swap" });
    const alerts = ((await api.get("/v1/alerts"))?.body as Body[]);
    expect(alerts.filter(a => a.kind === "rollout_halted")).toHaveLength(1);
    expect(alerts.filter(a => a.kind === "update_rolled_back")).toHaveLength(1);
    expect(alerts.find(a => a.kind === "rollout_halted")?.detail).toEqual({ version: V, machine: "n2", reason: "a check failed after the swap" });
  });

  it("commits only its own running Version: another Version is a 4xx not_allowed and nothing is stored; a bad body is 400", async () => {
    const fleet = await startTestFleet();
    const api = client(fleet.config.socketPath);
    const own = await api.post("/v1/rollout/committed", { version: V, soakMinutes: 45 });
    expect(own?.status).toBe(200);
    const ownBody = own?.body as Body;
    expect(ownBody.rollout).toMatchObject({ version: V, soakMinutes: 45, halted: false });
    const other = await api.post("/v1/rollout/committed", { version: "9.9.9" });
    expect(other?.status).toBeGreaterThanOrEqual(400);
    expect(other?.status).toBeLessThan(500);
    const otherBody = other?.body as Body;
    expect(otherBody.error).toBe("not_allowed");
    expect(otherBody.message).toContain(`the control plane runs ${V}`);
    expect(await api.post("/v1/rollout/committed", { version: "not a version" })).toMatchObject({ status: 400 });
    // the refused commit stored nothing: the highest Version the fleet knows is still its own
    expect((await bodyOf(api.get("/v1/rollout")))?.rollout?.version).toBe(V);
  });

  it("resume clears the halt and writes an audit row; a resume of a Rollout that is not halted is 409 not_halted", async () => {
    const fleet = await startTestFleet();
    const api = client(fleet.config.socketPath);
    await api.post("/v1/rollout/committed", { version: V });
    expect(await api.post("/v1/rollout/resume", { version: V })).toMatchObject({ status: 409, body: { error: "not_halted" } });
    expect(await api.post("/v1/rollout/halt", { version: V, machine: "n1", reason: "waiting for the owner" })).toMatchObject({ status: 200 });
    expect((await bodyOf(api.get("/v1/rollout")))?.rollout?.halted).toBe(true);
    const resumed = await api.post("/v1/rollout/resume", { version: V });
    expect(resumed).toMatchObject({ status: 200 });
    const resumedBody = resumed?.body as Body;
    expect(resumedBody.rollout).toMatchObject({ version: V, halted: false, haltedBy: null, haltReason: null, haltedAt: null });
    expect(fleet.audit.of("rollout.resumed")).toHaveLength(1);
    expect(fleet.audit.of("rollout.resumed")[0]?.detail).toEqual({ version: V, client: "unknown" });
  });

  it("a rollback on the control plane before its commit halts that Version: halted, never committed (review focus 2)", async () => {
    const fleet = await startTestFleet();
    const api = client(fleet.config.socketPath);
    // the control plane's updater rolled back from 9.9.9 (its target) before committing it: no Rollout existed yet
    expect(await api.post("/v1/rollout/halt", { version: "9.9.9", machine: "cp", reason: "fleet health failed" })).toMatchObject({ status: 200 });
    const r = (await bodyOf(api.get("/v1/rollout")))?.rollout;
    expect(r).toMatchObject({ version: "9.9.9", halted: true, haltedBy: "cp", haltReason: "fleet health failed", controlPlaneCommittedAt: null });
    const alerts = (await bodyOf(api.get("/v1/alerts"))) as Body[] | undefined;
    expect(alerts?.filter(a => a.kind === "rollout_halted")).toHaveLength(1);
  });

  it("a halt stays through a later commit of the same Version: only the principal's resume lifts it (RL12)", async () => {
    const fleet = await startTestFleet();
    const api = client(fleet.config.socketPath);
    await api.post("/v1/rollout/halt", { version: V, machine: "n2", reason: "n2 rolled back" });
    const committed = await api.post("/v1/rollout/committed", { version: V });
    expect(committed).toMatchObject({ status: 200 });
    const after = committed === null ? undefined : (committed.body as Body).rollout;
    expect(after).toMatchObject({ version: V, halted: true, haltedBy: "n2", controlPlaneCommittedAt: expect.any(Number) });
    expect((await bodyOf(api.get("/v1/rollout")))?.rollout?.halted).toBe(true);
  });

  it("GET /v1/rollout answers while the fleet is held; the writes are refused with 503", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "hold.json"), JSON.stringify({ services: ["fleet"], reason: "drain", version: V, since: new Date().toISOString() }));
    const fleet = await startTestFleet({ dir });
    const api = client(fleet.config.socketPath);
    expect(await api.get("/v1/rollout")).toMatchObject({ status: 200, body: { controlPlane: { version: V }, rollout: null } });
    expect(await api.post("/v1/rollout/committed", { version: V })).toMatchObject({ status: 503, body: { error: "updating" } });
  });

  it("a halt outlives a fleet restart (fleet.db)", async () => {
    const fleet = await startTestFleet();
    const api = client(fleet.config.socketPath);
    await api.post("/v1/rollout/committed", { version: V, soakMinutes: 10 });
    await api.post("/v1/rollout/halt", { version: V, machine: "n1", reason: "a node rolled back" });
    await fleet.close();
    const again = await startTestFleet({ dir: fleet.dir });
    // The first request after the restart can ride a kept-alive socket the closed fleet owned (node's global http
    // agent; the fleet client opens a connection of its own per request for this reason), so ask until this one answers.
    const rollout = await vi.waitFor(async () => {
      const answer = await client(again.config.socketPath).get("/v1/rollout");
      expect(answer?.body).toHaveProperty("rollout");
      const body = answer?.body as Body;
      return body.rollout as RolloutWire;
    });
    expect(rollout).toMatchObject({ version: V, soakMinutes: 10, halted: true, haltedBy: "n1", haltReason: "a node rolled back" });
  });

  it("the rollout message reaches an agent with CAP_ROLLOUT; one without it gets none and stays connected", async () => {
    const fleet = await startTestFleet();
    const api = client(fleet.config.socketPath);
    const withCap = await fleet.online("n1", { caps: [CAP_ROLLOUT] });
    const without = await fleet.online("n2");
    await api.post("/v1/rollout/committed", { version: V });
    await api.post("/v1/rollout/halt", { version: V, machine: "n1", reason: "test" });
    const committed = await withCap.next(m => (m.t === "rollout" && !m.rollout.halted ? m.rollout : undefined));
    expect(committed).toMatchObject({ version: V, soakMinutes: 30, halted: false });
    const halted = await withCap.next(m => (m.t === "rollout" && m.rollout.halted ? m.rollout : undefined));
    expect(halted).toMatchObject({ version: V, halted: true, haltedBy: "n1" });
    expect(await without.next(m => (m.t === "rollout" ? m : undefined), 400)).toBeNull();
    expect(without.open).toBe(true);
  });

  it("welcome carries the control plane's build and the Rollout", async () => {
    const fleet = await startTestFleet();
    const api = client(fleet.config.socketPath);
    const before = await fleet.online("n1");
    expect(before.welcome?.controlPlane).toMatchObject({ version: V });
    expect(before.welcome?.rollout).toBeNull();
    await api.post("/v1/rollout/committed", { version: V });
    const after = await fleet.online("n2", { instanceId: "00000000-0000-4000-8000-000000000002", streamId: "00000000-0000-4000-8000-000000000003" });
    expect(after.welcome?.controlPlane).toMatchObject({ version: V });
    expect(after.welcome?.rollout).toEqual({
      version: V, controlPlaneCommittedAt: expect.any(Number), soakMinutes: 30, halted: false, haltedBy: null, haltReason: null, haltedAt: null,
    });
  });

  it("update.apply: refused without CAP_UPDATE, above the control plane (RL11) and on a halted Rollout (RL12); forwarded once allowed", async () => {
    const fleet = await startTestFleet();
    const api = client(fleet.config.socketPath);
    const older = await fleet.online("n1");                        // an agent from before updates: no CAP_UPDATE
    const fresh = await fleet.online("n2", { caps: [CAP_UPDATE] });
    const apply = (node: string, version: string, key: string) => api.post("/v1/op", { node, op: "update.apply", args: { version }, key });
    const noCap = await apply("n1", V, "hub:u-cap");
    expect(noCap?.body).toMatchObject({ ok: false, error: { code: "unknown_op", executed: "no" }, store: null, storeSeq: null });
    const noCapBody = noCap?.body as Body;
    expect(noCapBody.error.message).toContain("update Morndo on it");
    const skew = await apply("n2", "999.0.0", "hub:u-skew");
    expect(skew?.body).toMatchObject({ ok: false, error: { code: "not_allowed", executed: "no" }, store: null, storeSeq: null });
    const skewBody = skew?.body as Body;
    expect(skewBody.error.message).toContain("RL11");
    await api.post("/v1/rollout/committed", { version: V });
    await api.post("/v1/rollout/halt", { version: V, machine: "n1", reason: "halting for the test" });
    const halted = await apply("n2", V, "hub:u-halted");
    expect(halted?.body).toMatchObject({ ok: false, error: { code: "not_allowed", executed: "no" }, store: null, storeSeq: null });
    const haltedBody = halted?.body as Body;
    expect(haltedBody.error.message).toContain("resume it first");
    await api.post("/v1/rollout/resume", { version: V });
    const forward = await apply("n2", V, "hub:u-go");
    expect(forward?.body).toMatchObject({ ok: true, result: { accepted: true } });
    expect(fresh.reqs.at(-1)).toMatchObject({ op: "update.apply", args: { version: V } });
    expect(older.reqs.filter(r => r.op === "update.apply")).toHaveLength(0);
  });

  it("GET /v1/nodes shows each node's protocol versions and its last update state, null before any", async () => {
    const fleet = await startTestFleet();
    const api = client(fleet.config.socketPath);
    await fleet.joined("mac");                                      // offline: no live connection, no health
    const a = await fleet.online("pc");
    const first = ((await api.get("/v1/nodes"))?.body as Body[]);
    expect(first.find(n => n.name === "pc")).toMatchObject({ proto: [1], update: null });
    expect(first.find(n => n.name === "mac")).toMatchObject({ proto: null, update: null });
    a.health(health({ update: { state: "staged", version: V, target: V } }));
    await vi.waitFor(async () => {
      const nodes = (await bodyOf(api.get("/v1/nodes"))) as Body[] | undefined;
      expect(nodes?.find(n => n.name === "pc")?.update).toEqual({ state: "staged", version: V, target: V });
    });
  });
});
