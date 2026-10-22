// The hub's updates service (updates design §8.1, PR 6c): the owner's one screen over every machine's Version. The
// view reads the fleet (its Rollout, its nodes) and the control plane's own updater; each command — apply, rollback,
// resume — is a Command twice over: mayCommand plus a passkey check from the last 5 minutes (CONTROL_FRESHNESS_MS,
// the control gate's own freshness), each one audited, and the gate comes before any look (round 2, R4). The
// control plane is told through its updater CLI, always UPDATER_ARGS's lists (`update --yes --detach --staged <v>`,
// only once `update --status --json` says that Version stands staged); a node through the fleet's update.apply,
// carrying the hub's signed assertion (§5.4). A node's rollback is refused: it is that machine's own hand
// (`morndo update --rollback` there), never a remote one.
import { createPublicKey, generateKeyPairSync, sign as signEd, verify as verifyEd } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTROL_FRESHNESS_MS, type AccessPolicy, type UpdateCommanded } from "@morndo/domain";
import { PRINCIPAL_SIGN_PREFIX, UPDATER_ARGS, decodePrincipalHeader, type FleetNode, type PrincipalAsk, type RolloutWire } from "@morndo/protocol";
import { productVersion } from "@morndo/service-kit";
import { startInProcessHub } from "./inprocess-hub.ts";
import { UpdatesService } from "../src/application/updates-service.ts";
import type { FleetForUpdates, FleetWriteOutcome } from "../src/application/updates-ports.ts";
import type { Authenticated } from "../src/application/access-service.ts";
import { principalSigner } from "../src/adapters/principal-signer.ts";
import { updaterCli } from "../src/adapters/updater-cli.ts";
import type { HubIdentity } from "../src/adapters/identity.ts";
import type { Store } from "../src/adapters/store.ts";

// The hub's identity for the direct tests: a plain Ed25519 pair in the adapter's own shape.
const pair = generateKeyPairSync("ed25519");
const identity: HubIdentity = {
  publicKeyRaw: Buffer.from((pair.publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url"),
  fingerprint: "SHA256:test",
  sign: data => signEd(null, data, pair.privateKey),
};

// The control plane's updater as the fake runner runs it: one status standing staged, and every argument list it got.
const cliWith = (standStaged: string | null, o: { stateFile?: string } = {}) => {
  const runs: { file: string; args: string[] }[] = [];
  const cli = updaterCli({
    stateFile: o.stateFile ?? join(tmpdir(), "morndo-no-state-file-here", "state.json"),
    run: async (file, args) => {
      runs.push({ file, args });
      return { stdout: JSON.stringify({
        installMethod: "updater", channel: "stable", mode: "apply", pin: null, window: null,
        current: "0.4.2", previous: "0.4.1", good: "0.4.2", staged: standStaged,
        feed: null, keySet: null, lastCheck: null, checks: [],
      }) };
    },
  });
  return { cli, runs };
};

// The fleet as the service needs it: what it was asked, and what it answers.
const fleetWith = (answers: { apply?: FleetWriteOutcome; resume?: FleetWriteOutcome } = {}) => {
  const sent: { op: "update.apply" | "rollout.resume"; node?: string; version: string; principal: string }[] = [];
  const asks = { rollout: 0, nodes: 0 };            // every look, counted: what a refused command must never cost
  const rollout: RolloutWire = { version: "0.5.0", controlPlaneCommittedAt: 1_800_000_000_000, soakMinutes: 30, halted: false, haltedBy: null, haltReason: null, haltedAt: null };
  const nodes: FleetNode[] = [{ name: "pc", status: "online", health: null, agent: "0.4.2", commit: null, proto: [1], update: { state: "staged", version: "0.4.2", target: "0.5.0" } }];
  const fleet: FleetForUpdates = {
    rollout: async () => { asks.rollout += 1; return { ok: true, rollout, aboveControlPlane: [] }; },
    nodes: async () => { asks.nodes += 1; return { ok: true, nodes }; },
    applyUpdate: async (node, version, principal) => { sent.push({ op: "update.apply", node, version, principal }); return answers.apply ?? { ok: true }; },
    resumeRollout: async (version, principal) => { sent.push({ op: "rollout.resume", version, principal }); return answers.resume ?? { ok: true }; },
  };
  return { fleet, sent, asks, rollout, nodes };
};

// An assertion the fleet could check: signed by the identity, over the prefix and the payload's exact bytes, and it
// asks for exactly this command.
const said = (principal: string, ask: PrincipalAsk) => {
  const parts = decodePrincipalHeader(principal);
  expect(parts).not.toBeNull();
  const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(identity.publicKeyRaw).toString("base64url") }, format: "jwk" });
  expect(verifyEd(null, Buffer.concat([Buffer.from(PRINCIPAL_SIGN_PREFIX), Buffer.from(parts!.payload)]), key, Buffer.from(parts!.signature))).toBe(true);
  const a = JSON.parse(new TextDecoder().decode(parts!.payload)) as Record<string, unknown>;
  expect(a).toMatchObject(ask);
  expect(String(a.nonce)).toMatch(/^[A-Za-z0-9_-]{22}$/);
};

// A session paired from the console `verifiedAt` ago, on an endpoint that has been here since.
const who = (verifiedAt: number, now: number): Authenticated => ({
  session: { id: "s-1" as never, endpointId: "e-1" as never, startedAt: now - 3_600_000, lastSeenAt: now, verifiedAt, endedAt: null, endReason: null },
  endpoint: { id: "e-1" as never, name: "phone", credential: { id: "c-1", publicKey: new Uint8Array([1]), counter: 1, transports: [] }, pairedAt: now - 3_600_000, pairedWith: "t-1" as never, lastSeenAt: now, revokedAt: null },
});

const service = (fleet: FleetForUpdates, cli: ReturnType<typeof cliWith>["cli"], now: () => number, events: UpdateCommanded[]) =>
  new UpdatesService({
    fleet, cli, sign: principalSigner(identity), policy: () => ({ stay: "12h", stepUp: "1h" }) as AccessPolicy, now,
    store: { record(es: UpdateCommanded[]) { events.push(...es); } } as never as Store,
    build: () => ({ version: "0.4.2", commit: null }),
  });

describe("the updates service (no HTTP)", () => {
  it("apply to a node: nothing without a fresh passkey check; with one, the fleet op carries the hub's signed assertion", async () => {
    let now = 1_800_000_000_000;
    const { fleet, sent } = fleetWith();
    const events: UpdateCommanded[] = [];
    const svc = service(fleet, cliWith(null).cli, () => now, events);
    const stale = await svc.apply(who(now - CONTROL_FRESHNESS_MS - 1, now), "pc", "0.5.0");
    expect(stale).toEqual({ ok: false, problem: "step_up" });
    expect(sent).toHaveLength(0);
    expect(events).toHaveLength(0);
    const done = await svc.apply(who(now, now), "pc", "0.5.0");
    expect(done).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    said(sent[0]!.principal, { op: "update.apply", version: "0.5.0", node: "pc" });
    expect(events).toEqual([{ type: "UpdateCommanded", command: "update.apply", endpointId: "e-1", machine: "pc", version: "0.5.0", at: now }]);
  });

  it("apply to a node the fleet does not list: unknown_machine, and the only look was the fleet's own node list", async () => {
    let now = 1_800_000_000_000;
    const fresh = who(now, now);
    const { fleet, sent, asks } = fleetWith();
    const svc = service(fleet, cliWith(null).cli, () => now, []);
    expect(await svc.apply(fresh, "stranger", "0.5.0")).toMatchObject({ ok: false, problem: "unknown_machine", message: "stranger is no machine the fleet lists" });
    expect(sent).toHaveLength(0);                     // nothing signed, nothing sent
    expect(asks).toEqual({ rollout: 0, nodes: 1 });   // the gate's one look: nodes(), never the CLI or the Rollout
  });

  it("apply to the control plane: only what stands staged; the CLI runs UPDATER_ARGS, the pressed Version in --staged", async () => {
    let now = 1_800_000_000_000;
    const fresh = who(now, now);
    const empty = fleetWith();
    const events: UpdateCommanded[] = [];
    const notStaged = service(empty.fleet, cliWith(null).cli, () => now, events);
    expect(await notStaged.apply(fresh, "control-plane", "0.5.0")).toMatchObject({ ok: false, problem: "not_staged" });
    const standing = cliWith("0.5.0");
    const svc = service(empty.fleet, standing.cli, () => now, events);
    expect(await svc.apply(fresh, "control-plane", "0.5.0")).toEqual({ ok: true });
    expect(standing.runs.map(r => r.args)).toEqual([UPDATER_ARGS.status, UPDATER_ARGS.apply("0.5.0")]);
    expect(empty.sent).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "UpdateCommanded", command: "update.apply", machine: "control-plane", version: "0.5.0" });
  });

  it("rollback: the control plane's CLI runs update --rollback --yes --detach; a node is not_yet, in the owner's own words", async () => {
    let now = 1_800_000_000_000;
    const fresh = who(now, now);
    const { fleet, sent } = fleetWith();
    const cli = cliWith("0.5.0");
    const events: UpdateCommanded[] = [];
    const svc = service(fleet, cli.cli, () => now, events);
    const node = await svc.rollback(fresh, "pc");
    expect(node).toMatchObject({ ok: false, problem: "not_yet", message: "run morndo update --rollback on pc" });
    expect(await svc.rollback(fresh, "control-plane")).toEqual({ ok: true });
    expect(cli.runs.map(r => r.args)).toEqual([UPDATER_ARGS.rollback]);
    expect(sent).toHaveLength(0);
    expect(events).toEqual([{ type: "UpdateCommanded", command: "update.rollback", endpointId: "e-1", machine: "control-plane", version: null, at: now }]);
  });

  it("resume carries an assertion for the Rollout; the fleet's refusal and unreachability pass through", async () => {
    let now = 1_800_000_000_000;
    const fresh = who(now, now);
    const refused = fleetWith({ resume: { ok: false, problem: "refused", code: "not_halted", message: "the Rollout of 0.5.0 is not halted" } });
    const events: UpdateCommanded[] = [];
    const svc = service(refused.fleet, cliWith(null).cli, () => now, events);
    expect(await svc.resume(fresh, "0.5.0")).toEqual({ ok: false, problem: "refused", code: "not_halted", message: "the Rollout of 0.5.0 is not halted" });
    const gone = fleetWith({ resume: { ok: false, problem: "unavailable", message: "no fleet at the socket" } });
    expect(await service(gone.fleet, cliWith(null).cli, () => now, []).resume(fresh, "0.5.0")).toMatchObject({ ok: false, problem: "unavailable" });
    expect(await svc.apply(fresh, "pc", "0.5.0")).toEqual({ ok: true });        // the fleet answers again
    expect(await svc.resume(fresh, "0.5.0")).toEqual({ ok: false, problem: "refused", code: "not_halted", message: "the Rollout of 0.5.0 is not halted" });
    const ok = fleetWith();
    const svc2 = service(ok.fleet, cliWith(null).cli, () => now, events);
    expect(await svc2.resume(fresh, "0.5.0")).toEqual({ ok: true });
    said(ok.sent[0]!.principal, { op: "rollout.resume", version: "0.5.0" });
    expect(events.at(-1)).toMatchObject({ type: "UpdateCommanded", command: "rollout.resume", machine: "fleet", version: "0.5.0" });
  });

  it("view: the fleet's Rollout and nodes, the CLI's status, the hub's own build", async () => {
    let now = 1_800_000_000_000;
    const { fleet, rollout, nodes } = fleetWith();
    const svc = service(fleet, cliWith("0.5.0").cli, () => now, []);
    expect(await svc.view()).toEqual({
      controlPlane: { version: "0.4.2", commit: null, status: expect.objectContaining({ staged: "0.5.0" }), state: null },
      rollout, aboveControlPlane: [],
      nodes: [{ name: "pc", status: "online", version: "0.4.2", proto: [1], update: nodes[0]!.update }],
    });
  });
});

describe("the updates routes", () => {
  it("the view and the commands over HTTP: 401 without a session, step_up after 5 minutes, 200 with a fresh one, each audited", async () => {
    let now = 1_800_000_000_000;
    const { fleet, sent } = fleetWith();
    const cli = cliWith("0.5.0");
    const hub = await startInProcessHub({ now: () => now, updates: { fleet, cli: cli.cli } });
    const as = (cookie: string) => ({ cookie: `__Host-morndo=${cookie}` });
    const anon = await hub.post("/api/updates/apply", { machine: "pc", version: "0.5.0" });
    expect(anon.status).toBe(401);
    const first = await hub.cookie();
    const applied = await hub.post("/api/updates/apply", { machine: "pc", version: "0.5.0" }, as(first));
    expect(applied.status).toBe(200);
    expect(sent).toHaveLength(1);
    now += 6 * 60_000;
    // The same device, paired before the clock moved: its step-up is now 6 minutes old, past the control gate's
    // five — mayCommand still says yes (within the policy's step-up hour), the freshness window says no.
    const stale = await hub.post("/api/updates/rollback", { machine: "control-plane" }, as(first));
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ error: "step_up" });
    const fresh = await hub.cookie();
    const answer = await hub.post("/api/updates/resume", { version: "0.5.0" }, as(fresh));
    expect(answer.status).toBe(200);
    expect(sent.map(s => s.op)).toEqual(["update.apply", "rollout.resume"]);
    const page = await hub.post("/api/updates/apply", { machine: "control-plane", version: "0.5.0" }, as(fresh));
    expect(page.status).toBe(200);
    // The node apply above cost no look (the route is thin, R4): the control plane's apply is the CLI's only
    // reader — its own staged check, then the pressed Version's command.
    expect(cli.runs.map(r => r.args)).toEqual([UPDATER_ARGS.status, UPDATER_ARGS.apply("0.5.0")]);
    // The store answers newest first: the control plane's apply, the resume, then the node apply from six minutes
    // before — each row naming the endpoint that commanded and the machine it named.
    const commands = hub.store.audit(20).filter(r => r.type === "UpdateCommanded").map(r => r.body as UpdateCommanded);
    expect(commands).toEqual([
      { type: "UpdateCommanded", command: "update.apply", endpointId: commands[0]!.endpointId, machine: "control-plane", version: "0.5.0", at: now },
      { type: "UpdateCommanded", command: "rollout.resume", endpointId: commands[1]!.endpointId, machine: "fleet", version: "0.5.0", at: now },
      { type: "UpdateCommanded", command: "update.apply", endpointId: commands[2]!.endpointId, machine: "pc", version: "0.5.0", at: 1_800_000_000_000 },
    ]);
    await hub.close();
  });

  it("a node's apply asks nothing before the command gate: a stale step-up answers 403 and no look happens (R4)", async () => {
    let now = 1_800_000_000_000;
    const { fleet, sent, asks } = fleetWith();
    const cli = cliWith("0.5.0");
    const hub = await startInProcessHub({ now: () => now, updates: { fleet, cli: cli.cli } });
    const first = await hub.cookie();
    now += 6 * 60_000;                    // past the control gate's freshness; mayCommand still says yes
    const stale = await hub.post("/api/updates/apply", { machine: "pc", version: "0.5.0" }, { cookie: `__Host-morndo=${first}` });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toEqual({ error: "step_up" });
    expect(cli.runs).toEqual([]);                        // no 10 s CLI status, no command
    expect(asks).toEqual({ rollout: 0, nodes: 0 });      // not even the fleet was asked
    expect(sent).toHaveLength(0);
    await hub.close();
  });

  it("GET /api/answers the view; the fleet's refusal is 409 with its words, unreachable 503, off 404; not_yet for a node's rollback", async () => {
    let now = 1_800_000_000_000;
    const refused = fleetWith({ apply: { ok: false, problem: "refused", code: "not_allowed", message: "the Rollout of 0.5.0 is halted; resume it first" } });
    const hub = await startInProcessHub({ now: () => now, updates: { fleet: refused.fleet, cli: cliWith(null).cli } });
    const cookie = await hub.cookie();
    const node = await hub.post("/api/updates/apply", { machine: "pc", version: "0.5.0" }, { cookie: `__Host-morndo=${cookie}` });
    expect(node.status).toBe(409);
    expect(await node.json()).toEqual({ error: "not_allowed", message: "the Rollout of 0.5.0 is halted; resume it first" });
    const rollback = await hub.post("/api/updates/rollback", { machine: "pc" }, { cookie: `__Host-morndo=${cookie}` });
    expect(rollback.status).toBe(409);
    expect(await rollback.json()).toMatchObject({ error: "not_yet", message: "run morndo update --rollback on pc" });
    const notStaged = await hub.post("/api/updates/apply", { machine: "control-plane", version: "0.5.0" }, { cookie: `__Host-morndo=${cookie}` });
    expect(notStaged.status).toBe(409);
    expect(await notStaged.json()).toMatchObject({ error: "not_staged" });
    await hub.close();
    const gone = fleetWith({ apply: { ok: false, problem: "unavailable", message: "no fleet at the socket" }, resume: { ok: false, problem: "unavailable", message: "no fleet at the socket" } });
    const hub2 = await startInProcessHub({ now: () => now, updates: { fleet: gone.fleet, cli: cliWith(null).cli } });
    const unreachable = await hub2.post("/api/updates/apply", { machine: "pc", version: "0.5.0" }, { cookie: `__Host-morndo=${await hub2.cookie()}` });
    expect(unreachable.status).toBe(503);
    const page = await hub2.post("/api/updates/resume", { version: "0.5.0" }, { cookie: `__Host-morndo=${await hub2.cookie()}` });
    expect(page.status).toBe(503);
    const view = await fetch(`${hub2.base}/api/updates`, { headers: { cookie: `__Host-morndo=${await hub2.cookie()}` } });
    expect(view.status).toBe(200);
    expect(await view.json()).toMatchObject({ controlPlane: { version: productVersion(), status: { staged: null } }, nodes: [{ name: "pc" }] });
    await hub2.close();
    const off = await startInProcessHub({ now: () => now });
    const none = await fetch(`${off.base}/api/updates`, { headers: { cookie: `__Host-morndo=${await off.cookie()}` } });
    expect(none.status).toBe(404);
    expect(await none.json()).toEqual({ error: "updates_off" });
    await off.close();
  });
});

// The review of 6c part 2: the control plane's own waiting record, read from its updater's state file.
describe("the control plane's state record in the view", () => {
  it("carries the updater's state.json when it parses, and null when it is missing or not the protocol's shape", async () => {
    const dir = mkdtempSync(join(tmpdir(), "morndo-state-"));
    try {
      const file = join(dir, "state.json");
      const { fleet } = fleetWith();
      const read = async () => (await service(fleet, cliWith("0.5.0", { stateFile: file }).cli, () => 0, []).view()).controlPlane.state;
      expect(await read()).toBeNull();
      const record = { state: "waiting", version: "0.4.2", target: "0.5.0", reason: "skew_blocked: n3", at: 1_800_000_000_000 };
      writeFileSync(file, `${JSON.stringify(record)}\n`);
      expect(await read()).toEqual(record);
      writeFileSync(file, "{ not json");
      expect(await read()).toBeNull();
      writeFileSync(file, JSON.stringify({ ...record, extra: 1 }));
      expect(await read()).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

