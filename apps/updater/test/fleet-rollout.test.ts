// PR 6b, round 2: the Rollout carried by the state file alone (updates §4.5, §6.7, §7, RL11, RL12). The control
// plane's updater never writes the fleet — its commit and its halts ride state.json, which the fleet itself reads —
// so a commit's record carries the attempt it minted at `applying`, and the fleet's write routes stay closed. It
// never POSTs the fleet a commit or a halt: the record is the word, and the tick says nothing again — the fleet
// reads the file itself, once a second, so a word it never took is a word it still owes itself. The check refuses a
// Version whose Rollout is halted, in the fleet's own word or in this machine's halt record (RL12 holds even while
// the fleet is down). The node's gates — the tick's and the apply unit's — follow the fleet view the agent wrote,
// offer included: a node applies only the Version it was offered, under the offer's attempt id, and the control
// plane's own applies are held while any joined node's protocol falls outside the target's range (RL11). state.json
// says what the updater last did at every outcome, in the protocol's own shape, every record of one Update carrying
// the same attempt id. The tick asks the feed at most every six hours; between asks it still follows the Rollout.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { writeFloor } from "@morndo/service-kit";
import { DEFAULT_SOAK_MINUTES, NODE_JITTER_MAX_MS, parseVersion, type ProtocolRange } from "@morndo/domain";
import { UpdateStateFileSchema, type RolloutWire, type UpdateStateFile } from "@morndo/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runUpdater } from "../src/cli.ts";
import { CheckService } from "../src/application/check-service.ts";
import { FRESH_VIEW_MS, applyUnitGate, deferSentence, nodeGate } from "../src/application/fleet-follow.ts";
import type { ApplyTiming } from "../src/application/apply-steps.ts";
import type { FleetWord } from "../src/application/ports.ts";
import { DirsInstaller } from "../src/adapters/installer-dirs.ts";
import { databasePaths, updaterPaths } from "../src/adapters/paths.ts";
import { openUpdateStore, type SqliteUpdateStore } from "../src/adapters/store-sqlite.ts";
import { SshSigVerifier } from "../src/adapters/verifier-sshsig.ts";
import { A, B, NOW, buildApplyWorld } from "./helpers/apply-fakes.ts";
import { FakeArtifacts, FakeClock, FakeFeed, FakeFleetView, FakeInstaller, FakeSettings, FakeStateSink, FakeStore, wipe } from "./helpers/fakes.ts";
import { feedFixture, keySetDocument, makeKeys, manifestSignature, releaseFixture, signed, type Keys, type ReleaseFixture } from "./helpers/release-fixtures.ts";

const DAY = 24 * 3600_000;
const MIN = 60_000;
let scratch = "";
beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), "morndo-upd-")); });
afterAll(() => { wipe(scratch); }, 60_000);   // every world of the file, removed at once

// An attempt id as both sides make them (§5.4): 16 random bytes, base64url.
const ATTEMPT = /^[A-Za-z0-9_-]{22,64}$/;

// The fleet's word as a test stands it: a Rollout of B by default, committed and unhalted, offered to this node,
// heard now.
const roll = (o: Partial<RolloutWire> = {}): RolloutWire => ({
  version: B, controlPlaneCommittedAt: NOW - 2 * HOUR, soakMinutes: DEFAULT_SOAK_MINUTES,
  halted: false, haltedBy: null, haltReason: null, haltedAt: null, ...o,
});
const HOUR = 3600_000;
const OFFER = { version: B, attempt: "offered-to-this-node-00000000" };
const word = (o: {
  observedAt?: number; controlPlane?: { version: string; commit: string | null } | null;
  rollout?: RolloutWire | null; offer?: { version: string; attempt: string } | null;
} = {}): FleetWord => ({
  observedAt: o.observedAt ?? Date.now(),
  controlPlane: o.controlPlane === undefined ? { version: B, commit: null } : o.controlPlane,
  rollout: o.rollout === undefined ? roll({ controlPlaneCommittedAt: Date.now() - 2 * HOUR }) : o.rollout,
  offer: o.offer === undefined ? OFFER : o.offer,
});

// state.json as the updater wrote it, through the protocol's own shape.
const stateFile = (path: string): UpdateStateFile => UpdateStateFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));

// The target's Manifest protocol, as the gate asks for it (RL11's floor check): the fixtures' own range.
const PROTOCOL: ProtocolRange = { agent: [1, 2], clientApi: [1, 1] };

// The walls a full-walk test may shorten — except probation: the domain judges sixty seconds up (§6.4), so the walk
// really sleeps the minute and a full-walk test really takes it.
const SMALL_WALLS: Partial<ApplyTiming> = { drainMs: 400, pollMs: 5, healthMs: 500, holdAckMs: 200 };

describe("the control plane's only word out is the state file (§4.3, §4.5, §5.4)", () => {
  // What state.json said while the walk ran, sampled where the world always pauses: the hold's acknowledgement.
  const applyingOf = (w: Awaited<ReturnType<typeof buildApplyWorld>>): UpdateStateFile[] => {
    const seen: UpdateStateFile[] = [];
    const inner = w.probe.seesHoldScript;
    w.probe.seesHoldScript = (s, call) => {
      if (existsSync(w.statePath)) { try { seen.push(stateFile(w.statePath)); } catch { /* mid-write: the next call has it */ } }
      return inner(s, call);
    };
    return seen;
  };

  it("a commit writes current with the attempt it minted at applying, and the soak; no fleet write is made", async () => {
    const w = await buildApplyWorld(scratch);
    const during = applyingOf(w);
    expect(await w.apply().apply({ now: false })).toEqual({ kind: "committed", version: B });
    const applying = during.filter(s => s.state === "applying");
    expect(applying.length).toBeGreaterThan(0);
    expect(applying[0]).toMatchObject({ state: "applying", version: A, target: B, attempt: expect.stringMatching(ATTEMPT) });
    expect(stateFile(w.statePath)).toEqual({
      state: "current", version: B, attempt: applying[0]!.attempt,
      soakMinutes: DEFAULT_SOAK_MINUTES, at: expect.any(Number),
    });
    // The apply has no fleet door at all: nothing was asked, not even a read (§4.5 — the file is the word).
    expect(w.fleet.calls).toEqual([]);
  });

  it("the attempt is minted at random — two applies differ — and every ending of one Update carries the same one", async () => {
    const one = await buildApplyWorld(scratch);
    const seenOne = applyingOf(one);
    expect(await one.apply().apply({ now: false })).toMatchObject({ kind: "committed" });

    // A rollback: B's fleet never answers at the health check, so the walk rolls back to A — under the same attempt
    // its applying record announced, which is the id the fleet will hold its halt against (§5.4).
    const two = await buildApplyWorld(scratch);
    const seenTwo = applyingOf(two);
    two.probe.healthScript = s =>
      s === "fleet" && two.current() === B ? null : { service: s, version: two.current() ?? A, checks: { ready: true, database: true } };
    expect(await two.apply().apply({ now: false })).toMatchObject({ kind: "rolled_back", version: A });
    const first = seenOne.filter(s => s.state === "applying")[0]!;
    const second = seenTwo.filter(s => s.state === "applying")[0]!;
    expect(first.attempt).toMatch(ATTEMPT);
    expect(second.attempt).toMatch(ATTEMPT);
    expect(first.attempt).not.toBe(second.attempt);              // random, not a clock or a counter
    expect(stateFile(two.statePath)).toMatchObject({ state: "rolled_back", version: A, target: B, attempt: second.attempt });

    // A rollback that cannot put the machine back says rollback_failed — the same attempt again (§4.4: the record
    // and the alert, never a loop).
    const three = await buildApplyWorld(scratch);
    const seenThree = applyingOf(three);
    let seenB = false;
    three.probe.healthScript = s => {
      const at = three.current();
      if (at === B) {
        seenB = true;
        return s === "hub" ? { service: s, version: A, checks: { ready: true, database: true } }   // roll it back
          : { service: s, version: B, checks: { ready: true, database: true } };
      }
      if (seenB && at === A) return { service: s, version: A, checks: { ready: false, database: true } };  // A is sick too
      return { service: s, version: at ?? A, checks: { ready: true, database: true } };
    };
    expect(await three.apply().apply({ now: false })).toMatchObject({ kind: "rollback_failed" });
    expect(stateFile(three.statePath)).toMatchObject({ state: "rollback_failed", attempt: seenThree.filter(s => s.state === "applying")[0]!.attempt });
  }, 60_000);   // three whole apply walks (22.9 s beside one other test file on this box; 10 s alone)
});

// The check's own world, as status-doctor builds it: keys, a signed feed offering B, and the fakes — bent by each
// case in exactly one way around what the fleet says.
type CheckWorld = { fleet: FakeFleetView; store: FakeStore; state: FakeStateSink; check: () => Promise<unknown> };
let made = 0;
const checkWorld = (bend: (w: CheckWorld) => void = () => {}): CheckWorld => {
  const keys: Keys = makeKeys();
  const ks = keySetDocument(keys, { version: 1, expiresAt: NOW + 365 * DAY });
  const rel: ReleaseFixture = releaseFixture({ version: B, now: NOW });
  const feed = feedFixture(keys, [rel], { channel: "stable", now: NOW });
  const fakeFeed = new FakeFeed();
  fakeFeed.keySets.set(1, signed(ks.bytes, ks.sig));
  fakeFeed.channels.set("stable", feed.served);
  fakeFeed.manifests.set(rel.manifestUrl, signed(rel.manifestBytes, manifestSignature(keys, rel)));
  const installer = new FakeInstaller(join(scratch, `rel-${made += 1}`));
  installer.shipped = ks.bytes;
  const artifacts = new FakeArtifacts(join(scratch, `dl-${made}`));
  artifacts.serve(rel.name, { bytes: rel.archive });
  const fleet = new FakeFleetView();
  const store = new FakeStore();
  const state = new FakeStateSink();
  const service = new CheckService({
    feed: fakeFeed, artifacts, verifier: new SshSigVerifier(), installer, store,
    settings: new FakeSettings(), clock: new FakeClock(NOW), platform: rel.platform,
    switches: { disableUpdates: false }, fleet, state,
  });
  const world: CheckWorld = { fleet, store, state, check: () => service.check() };
  bend(world);
  return world;
};

describe("the check under a halted Rollout (RL12)", () => {
  it("refuses what the fleet's Rollout halted, and what this machine's own halt record holds", async () => {
    const fromFleet = checkWorld(w => {
      w.fleet.word = { observedAt: NOW, controlPlane: { version: B, commit: null }, rollout: roll({ halted: true, haltedBy: "office-2", haltReason: "nodes:node-b", haltedAt: NOW - HOUR }), offer: null };
    });
    expect(await fromFleet.check()).toEqual({ kind: "skipped", reason: "halted", version: B });

    // The fleet cannot be asked at all: the local halt record of this Version refuses it just the same.
    const local = checkWorld(w => {
      w.fleet.throwView = true;
      w.store.recordHalt(B, "nodes:node-b", NOW - HOUR);
    });
    expect(await local.check()).toEqual({ kind: "skipped", reason: "halted", version: B });

    // A halt of another Version halts nothing: B stages as it would.
    const otherHalt = checkWorld(w => {
      w.store.recordHalt("0.3.0", "nodes:node-b", NOW - HOUR);
    });
    expect(await otherHalt.check()).toMatchObject({ kind: "staged", version: B });
  });
});

describe("the node's gate before an apply (§6.7, §7, RL11, RL12)", () => {
  const target = parseVersion(B)!;
  // One standing per refusal, bent in exactly one way from a word that would allow the apply.
  const standing = (bend: (w: { word: FleetWord; store: FakeStore; random: () => number }) => void) => {
    const store = new FakeStore();
    const w: { word: FleetWord; store: FakeStore; random: () => number } = { word: word(), store, random: () => 0.5 };
    bend(w);
    return nodeGate({ word: w.word, now: Date.now(), node: "office-1", target, targetProtocol: PROTOCOL, store, random: w.random });
  };

  it("no view at all, or one past its ten minutes, is no word from the control plane", () => {
    const nothing = nodeGate({ word: null, now: Date.now(), node: "office-1", target, targetProtocol: PROTOCOL, store: new FakeStore(), random: () => 0.5 });
    expect(nothing).toEqual({ ok: false, error: { reason: "no_view" } });
    expect(standing(w => { w.word.controlPlane = null; })).toEqual({ ok: false, error: { reason: "no_view" } });
    expect(standing(w => { w.word.observedAt = Date.now() - FRESH_VIEW_MS - MIN; })).toEqual({ ok: false, error: { reason: "no_view" } });
    expect(deferSentence("no_view")).toContain("no fresh word");
  });

  it("a Rollout that is not of this Version: not committed; and above the control plane it is RL11, node_ahead", () => {
    expect(standing(w => { w.word.rollout = null; }))
      .toEqual({ ok: false, error: { reason: "not_committed" } });
    // The control plane runs A while B is staged: the target sits above it — never apply (RL11).
    expect(standing(w => { w.word.controlPlane = { version: A, commit: null }; w.word.rollout = null; }))
      .toEqual({ ok: false, error: { reason: "node_ahead" } });
  });

  it("the offer decides the attempt: a Rollout without one, or one of another Version, is not_committed (§5.4, §7)", () => {
    // The Rollout is of this Version, committed, unhalted — but the fleet offered this node nothing: a node never
    // applies a Version it holds no attempt id for, because its rollback would halt nothing.
    expect(standing(w => { w.word.offer = null; }))
      .toEqual({ ok: false, error: { reason: "not_committed" } });
    // An offer of another Version is no offer of this one.
    expect(standing(w => { w.word.offer = { version: "0.3.0", attempt: "another-version-offer-0000000" }; }))
      .toEqual({ ok: false, error: { reason: "not_committed" } });
    expect(deferSentence("not_committed")).toContain("not committed the target");
  });

  it("a Rollout of this Version that the control plane sits below: waiting_control_plane", () => {
    // The control plane committed B's Rollout and then found itself back at A: a node holds until the plane returns.
    expect(standing(w => { w.word.controlPlane = { version: A, commit: null }; }))
      .toEqual({ ok: false, error: { reason: "waiting_control_plane" } });
  });

  it("an uncommitted Rollout of this Version is not_committed; a halted one is halted (RL12)", () => {
    expect(standing(w => { (w.word.rollout as RolloutWire).controlPlaneCommittedAt = null; }))
      .toEqual({ ok: false, error: { reason: "not_committed" } });
    expect(standing(w => { w.word.rollout = roll({ halted: true, haltedBy: "office-2", haltReason: "nodes:node-b", haltedAt: Date.now() - HOUR }); }))
      .toEqual({ ok: false, error: { reason: "halted" } });
    // As the fleet sends a halted Rollout (6d's two-machine run): it offers the halted Version to no node, and the
    // node still says halted — not "not committed", which the Updates page would show as a Rollout never committed.
    expect(standing(w => { w.word.rollout = roll({ halted: true, haltedBy: "e2e-node", haltReason: "node: no_report", haltedAt: Date.now() - HOUR }); w.word.offer = null; }))
      .toEqual({ ok: false, error: { reason: "halted" } });
  });

  it("inside the soak it waits; past the soak and inside its own drawn delay it waits on the same draw", () => {
    // The control plane committed ten minutes ago: the thirty-minute soak is still running.
    expect(standing(w => { w.word.rollout = roll({ controlPlaneCommittedAt: Date.now() - 10 * MIN }); }))
      .toEqual({ ok: false, error: { reason: "waiting_soak" } });
    // Past the soak (thirty-five minutes ago, five past its end), the draw is nine tenths of the maximum: still
    // waiting, and the draw is kept. A commit older than the soak plus the maximum draw could never still wait.
    const store = new FakeStore();
    const committed = Date.now() - 35 * MIN;
    const first = nodeGate({ word: word({ rollout: roll({ controlPlaneCommittedAt: committed }) }), now: Date.now(), node: "office-1", target, targetProtocol: PROTOCOL, store, random: () => 0.9 });
    expect(first).toEqual({ ok: false, error: { reason: "waiting_jitter" } });
    const drawn = store.jitterOf(B);
    expect(drawn).toBe(committed + DEFAULT_SOAK_MINUTES * MIN + Math.floor(0.9 * NODE_JITTER_MAX_MS));
    // The next tick, with every other draw saying sooner, waits on the same one: drawn once per Version.
    const again = nodeGate({ word: word({ rollout: roll({ controlPlaneCommittedAt: committed }) }), now: Date.now(), node: "office-1", target, targetProtocol: PROTOCOL, store, random: () => 0 });
    expect(again).toEqual({ ok: false, error: { reason: "waiting_jitter" } });
    expect(store.jitterOf(B)).toBe(drawn);
  });

  it("everything allowed, the gate says apply and hands the offer's attempt to the walk", () => {
    expect(standing(() => {})).toEqual({ ok: true, attempt: OFFER.attempt });
  });
});

describe("the apply unit's gate on a node (§8.3)", () => {
  const target = parseVersion(B)!;

  it("refuses a halted Version however hard the principal asks, and one above the control plane; it never waits on the soak", () => {
    // Halted in the fleet's own word.
    expect(applyUnitGate({
      word: word({ rollout: roll({ halted: true, haltedBy: "office-2", haltReason: "nodes:node-b", haltedAt: Date.now() - HOUR }) }),
      now: Date.now(), target, targetProtocol: PROTOCOL, localHalts: [],
    })).toEqual({ ok: false, error: { reason: "halted" } });
    // Halted only in this machine's own record (RL12 while the fleet is down).
    expect(applyUnitGate({
      word: word(), now: Date.now(), target, targetProtocol: PROTOCOL, localHalts: [{ version: B, at: Date.now() - HOUR }],
    })).toEqual({ ok: false, error: { reason: "halted" } });
    // Above the control plane: RL11 holds for the principal's own hand too.
    expect(applyUnitGate({
      word: word({ controlPlane: { version: A, commit: null } }), now: Date.now(), target, targetProtocol: PROTOCOL, localHalts: [],
    })).toEqual({ ok: false, error: { reason: "node_ahead" } });
    // No fresh view: the apply unit does not run blind either.
    expect(applyUnitGate({ word: null, now: Date.now(), target, targetProtocol: PROTOCOL, localHalts: [] }))
      .toEqual({ ok: false, error: { reason: "no_view" } });
  });

  it("skips the soak and the jitter: a committed Rollout inside its soak still applies", () => {
    // Committed ten minutes ago, inside the thirty-minute soak, no jitter drawn anywhere: the gate says yes.
    expect(applyUnitGate({
      word: word({ rollout: roll({ controlPlaneCommittedAt: Date.now() - 10 * MIN }) }),
      now: Date.now(), target, targetProtocol: PROTOCOL, localHalts: [],
    })).toEqual({ ok: true });
  });
});

describe("state.json at every outcome (§6.3)", () => {
  it("says staged at the check, applying while the walk runs, and current once committed — all in the protocol's shape", async () => {
    const staged = checkWorld();
    await staged.check();
    expect(lastWritten(staged)).toMatchObject({ state: "staged", version: A, target: B });

    const w = await buildApplyWorld(scratch);
    // The drain runs under the hold: what state.json says there is what it says while the walk runs.
    const during: UpdateStateFile[] = [];
    w.probe.seesHoldScript = () => {
      if (existsSync(w.statePath)) during.push(stateFile(w.statePath));
      return true;   // the ack itself is not what is tested here; the world's own answer waits a second of its timeline
    };
    expect(await w.apply().apply({ now: false })).toEqual({ kind: "committed", version: B });
    expect(during.length).toBeGreaterThan(0);
    expect(during.some(s => s.state === "applying" && s.version === A && s.target === B)).toBe(true);
    expect(stateFile(w.statePath)).toEqual({
      state: "current", version: B, attempt: expect.stringMatching(ATTEMPT),
      soakMinutes: DEFAULT_SOAK_MINUTES, at: expect.any(Number),
    });
  });

  it("says waiting with the reason at a deferral, before anything ran", async () => {
    const w = await buildApplyWorld(scratch);
    w.services.tmuxIn = true;                                  // the walk defers before the hold, before the drain
    const out = await w.apply().apply({ now: false });
    expect(out).toMatchObject({ kind: "deferred", reason: "tmux_in_agent_unit" });
    expect(stateFile(w.statePath)).toMatchObject({ state: "waiting", version: A, reason: "tmux_in_agent_unit" });
  });

  it("says rolled_back with the target, the reason and the failed check; rollback_failed when the way back fails", async () => {
    const r = await buildApplyWorld(scratch);
    r.probe.healthScript = s =>
      s === "fleet" && r.current() === B ? null : { service: s, version: r.current() ?? A, checks: { ready: true, database: true } };
    expect(await r.apply().apply({ now: false })).toMatchObject({ kind: "rolled_back", version: A });
    expect(stateFile(r.statePath)).toMatchObject({ state: "rolled_back", version: A, target: B, reason: expect.stringContaining("fleet"), attempt: expect.stringMatching(ATTEMPT) });
    expect(["no_report", "wrong_version", "ready", "database"]).toContain(stateFile(r.statePath).failedCheck);

    const f = await buildApplyWorld(scratch);
    let seenB = false;
    f.probe.healthScript = s => {
      const at = f.current();
      if (at === B) {
        seenB = true;
        return s === "hub" ? { service: s, version: A, checks: { ready: true, database: true } } : { service: s, version: B, checks: { ready: true, database: true } };
      }
      if (seenB && at === A) return { service: s, version: A, checks: { ready: false, database: true } };
      return { service: s, version: at ?? A, checks: { ready: true, database: true } };
    };
    expect(await f.apply().apply({ now: false })).toMatchObject({ kind: "rollback_failed" });
    expect(stateFile(f.statePath)).toMatchObject({ state: "rollback_failed", version: B, reason: expect.any(String), attempt: expect.stringMatching(ATTEMPT) });
  });
});

// The check world's own sink, written by the check itself (§6.3): the last write, through the protocol's shape.
const lastWritten = (w: CheckWorld): UpdateStateFile => UpdateStateFileSchema.parse(w.state.written.at(-1));

// A node's whole machine for the tick, as cli-apply builds one: the real installer, store and databases over a
// throwaway HOME, the services and probes faked, the feed signed by the test's own keys, and the fleet's word and
// the jitter's draw injected through the deps door. The node runs only the node agent.
import { SCHEMAS_A, Die, FakeProbe, FakeServices } from "./helpers/apply-fakes.ts";

const YEAR = 365 * DAY;
type TickWorld = {
  home: string; statePath: string; store: SqliteUpdateStore; feed: FakeFeed;
  services: FakeServices; fleet: FakeFleetView; current: () => string | null;
  run(argv: string[], o?: { random?: () => number; timing?: Partial<ApplyTiming> }): Promise<{ code: number; out: string; err: string }>;
};
let ticks = 0;
async function tickWorld(o: {
  fleet?: FakeFleetView;
  /** This machine runs the hub and the fleet too (the control plane's own tick: the skew gate, §7 RL11). */
  controlPlane?: boolean;
  /** B's Manifest's agent protocol range (the skew gate's cases). */
  protocol?: { agent: [number, number]; clientApi: [number, number] };
} = {}): Promise<TickWorld> {
  const home = join(scratch, `tick-${(ticks += 1)}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const paths = updaterPaths(home);
  const dbPaths = databasePaths(home, {});
  const keys = makeKeys();
  const keySet = keySetDocument(keys, { version: 1, expiresAt: NOW + 20 * YEAR });
  const a = releaseFixture({ version: A, now: NOW - 2 * DAY });
  const b = releaseFixture({ version: B, now: NOW - DAY, ...(o.protocol === undefined ? {} : { protocol: o.protocol }) });
  const installer = new DirsInstaller({ releases: paths.releases });
  const install = async (fixture: ReturnType<typeof releaseFixture>): Promise<void> => {
    const archive = join(home, `${fixture.version}.tar.gz`);
    writeFileSync(archive, fixture.archive);
    const unpacked = await installer.unpack(archive, fixture.version, { filesSha256: fixture.filesSha256, maxBytes: 1 << 20 });
    if (!unpacked.ok) throw new Error(`${fixture.version} did not unpack`);
    installer.promote(fixture.version, { manifestSha256: fixture.manifestSha256, filesSha256: fixture.filesSha256, at: NOW });
    rmSync(archive, { force: true });
  };
  await install(a);
  await install(b);                                           // staged, as a check that already ran would leave it
  installer.swap({ current: A, previous: null });
  installer.setGood(A);
  for (const db of ["hub", "fleet", "node", "connections"] as const) {
    const path = dbPaths[db];
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const file = new Database(path);
    file.exec("CREATE TABLE lanes (id TEXT NOT NULL)");
    file.prepare("INSERT INTO lanes (id) VALUES (?)").run(db);
    file.pragma(`user_version = ${SCHEMAS_A[db].version}`);
    writeFloor(file, SCHEMAS_A[db].floor);
    file.close();
  }
  const store = openUpdateStore({ db: paths.db, lock: paths.lock });
  store.saveTrust({ keySet: keySet.decoded, highestFeedSeq: { stable: 0, latest: 0 } });
  store.recordStaged({ version: b.version, manifestSha256: b.manifestSha256, filesSha256: b.filesSha256, at: NOW - 1000, manifest: b.manifestText });
  const tape: string[] = [];
  const die = new Die();
  const current = () => installer.layout().current;
  const services = new FakeServices({ tape, die, currentOf: current, running: o.controlPlane === true ? ["hub", "node", "fleet"] : ["node"] });
  const probe = new FakeProbe({ tape, die, currentOf: current });
  const feed = new FakeFeed();
  feed.keySets.set(1, signed(keySet.bytes, keySet.sig));
  const served = feedFixture(keys, [b], { channel: "stable", now: Date.now() });
  feed.channels.set("stable", served.served);
  feed.manifests.set(b.manifestUrl, { bytes: b.manifestBytes, signature: manifestSignature(keys, b) });
  const fleet = o.fleet ?? new FakeFleetView();
  return {
    home, statePath: join(paths.state, "state.json"), store, feed, services, fleet, current,
    run: async (argv, opts = {}) => {
      const out: string[] = [], err: string[] = [];
      const code = await runUpdater(argv, { HOME: home, PATH: process.env.PATH }, {
        out: s => out.push(s), err: s => err.push(s),
      }, {
        services, probe, feed, artifacts: new FakeArtifacts(paths.downloads), fleet,
        ...(opts.random ? { random: opts.random } : {}),
        ...(opts.timing ? { timing: opts.timing } : {}),
      });
      return { code, out: out.join(""), err: err.join("") };
    },
  };
}

describe("`morndo update tick` on a node — it follows the control plane (§6.7, §7)", () => {
  it("with no view, or one gone stale, it defers with 75 and records waiting: no_view", async () => {
    const blind = await tickWorld();
    const r = await blind.run(["update", "tick"]);
    expect(r.code, r.err).toBe(75);
    expect(r.err).toContain(deferSentence("no_view"));
    expect(stateFile(blind.statePath)).toMatchObject({ state: "waiting", version: A, reason: "no_view" });
    expect(blind.services.tape.filter(t => t.startsWith("stop:"))).toEqual([]);   // nothing ran
    expect(blind.current()).toBe(A);

    const stale = await tickWorld();
    stale.fleet.word = word({ observedAt: Date.now() - FRESH_VIEW_MS - MIN });
    const again = await stale.run(["update", "tick"]);
    expect(again.code, again.err).toBe(75);
    expect(stateFile(stale.statePath)).toMatchObject({ reason: "no_view" });
  }, 90_000);   // 2 worlds, each two signed releases unpacked (about 10 s apiece on a loaded box)

  it("a Rollout that is not of the target defers not_committed; a target above the control plane defers node_ahead", async () => {
    const none = await tickWorld();
    none.fleet.word = word({ controlPlane: { version: B, commit: null }, rollout: null });
    const r = await none.run(["update", "tick"]);
    expect(r.code, r.err).toBe(75);
    expect(stateFile(none.statePath)).toMatchObject({ state: "waiting", reason: "not_committed" });

    const ahead = await tickWorld();
    ahead.fleet.word = word({ controlPlane: { version: A, commit: null }, rollout: null });
    const out = await ahead.run(["update", "tick"]);
    expect(out.code, out.err).toBe(75);
    expect(stateFile(ahead.statePath)).toMatchObject({ state: "waiting", reason: "node_ahead" });
  }, 90_000);   // 2 worlds, each two signed releases unpacked (about 10 s apiece on a loaded box)

  it("a committed Rollout the control plane sits below defers waiting_control_plane; a halted one defers halted", async () => {
    const behind = await tickWorld();
    behind.fleet.word = word({ controlPlane: { version: A, commit: null } });   // rollout of B, committed, plane back at A
    const r = await behind.run(["update", "tick"]);
    expect(r.code, r.err).toBe(75);
    expect(stateFile(behind.statePath)).toMatchObject({ state: "waiting", reason: "waiting_control_plane" });

    const halted = await tickWorld();
    halted.fleet.word = word({ rollout: roll({ halted: true, haltedBy: "office-2", haltReason: "nodes:node-b", haltedAt: Date.now() - HOUR }) });
    const out = await halted.run(["update", "tick"]);
    expect(out.code, out.err).toBe(75);
    expect(stateFile(halted.statePath)).toMatchObject({ state: "waiting", reason: "halted" });
  }, 90_000);   // 2 worlds, each two signed releases unpacked (about 10 s apiece on a loaded box)

  it("inside the soak it defers waiting_soak; past it, inside its drawn delay, waiting_jitter on the same draw", async () => {
    const soak = await tickWorld();
    soak.fleet.word = word({ rollout: roll({ controlPlaneCommittedAt: Date.now() - 10 * MIN }) });
    const r = await soak.run(["update", "tick"]);
    expect(r.code, r.err).toBe(75);
    expect(stateFile(soak.statePath)).toMatchObject({ state: "waiting", reason: "waiting_soak" });

    // Past the soak, the draw (nine tenths of the maximum) still has minutes to run.
    const jitter = await tickWorld();
    jitter.fleet.word = word({ rollout: roll({ controlPlaneCommittedAt: Date.now() - 40 * MIN }) });
    const first = await jitter.run(["update", "tick"], { random: () => 0.9 });
    expect(first.code, first.err).toBe(75);
    expect(stateFile(jitter.statePath)).toMatchObject({ reason: "waiting_jitter" });
    const drawn = jitter.store.jitterOf(B);
    expect(drawn).not.toBeNull();
    // The next tick draws again and still waits on the first draw: once per Version, kept in update.db.
    const second = await jitter.run(["update", "tick"], { random: () => 0 });
    expect(second.code, second.err).toBe(75);
    expect(stateFile(jitter.statePath)).toMatchObject({ reason: "waiting_jitter" });
    expect(jitter.store.jitterOf(B)).toBe(drawn);
  }, 90_000);   // 2 worlds, each two signed releases unpacked (about 10 s apiece on a loaded box)

  it("everything allowed, the tick applies under the offer's attempt: the walk runs, the machine runs B, and every record of it carries that attempt", async () => {
    const w = await tickWorld();
    w.fleet.word = word();                                     // B committed two hours ago, offered to this node
    const r = await w.run(["update", "tick"], { random: () => 0, timing: SMALL_WALLS });
    expect(r.code, r.err).toBe(0);
    expect(w.current()).toBe(B);
    expect(w.services.tape).toContain("stop:node");
    expect(w.services.tape).toContain("start:node");
    expect(stateFile(w.statePath)).toEqual({
      state: "current", version: B, attempt: OFFER.attempt, soakMinutes: DEFAULT_SOAK_MINUTES, at: expect.any(Number),
    });
    // The Update's own record carries the offer's attempt too (§5.4): the fleet's id, kept in update.db.
    const last = w.store.recentUpdates(1)[0]!;
    expect(last.state).toBe("committed");
    expect(last.attempt).toBe(OFFER.attempt);
  }, 120_000);   // the walk really sleeps §6.4's sixty-second probation; the walls cannot shorten it

  it("a Rollout the node was not offered defers: not_committed, nothing stopped (§5.4)", async () => {
    const w = await tickWorld();
    w.fleet.word = word({ offer: null });                      // the fleet offered this node nothing
    const r = await w.run(["update", "tick"]);
    expect(r.code, r.err).toBe(75);
    expect(stateFile(w.statePath)).toMatchObject({ state: "waiting", reason: "not_committed" });
    expect(w.services.tape.filter(t => t.startsWith("stop:"))).toEqual([]);
    expect(w.current()).toBe(A);
  });

  it("asks the feed at most every six hours; between asks it still follows the Rollout", async () => {
    const w = await tickWorld();
    const first = await w.run(["update", "tick"]);
    expect(first.code).toBe(75);                               // no view: waiting, but the check ran
    expect(w.feed.calls.channels).toEqual(["stable"]);
    const second = await w.run(["update", "tick"]);            // a quarter hour later, in the tick's own time
    expect(second.code).toBe(75);
    expect(w.feed.calls.channels).toEqual(["stable"]);         // nothing fetched: the last check is younger than six hours

    // A check whose word is seven hours old is asked again.
    const aged = await tickWorld();
    aged.store.recordCheck({ at: Date.now() - 7 * HOUR, channel: "stable", outcome: "staged", detail: "seed", version: B, feedSeq: 1, feedExpiresAt: Date.now() + 14 * DAY });
    await aged.run(["update", "tick"]);
    expect(aged.feed.calls.channels).toEqual(["stable"]);

    // A refusal is not the feed's word: a recent check that says nothing fetches again.
    const refused = await tickWorld();
    refused.store.recordCheck({ at: Date.now() - MIN, channel: "stable", outcome: "refused", detail: "seed", version: null, feedSeq: null, feedExpiresAt: null });
    await refused.run(["update", "tick"]);
    expect(refused.feed.calls.channels).toEqual(["stable"]);
  }, 60_000);   // three whole worlds, each a signed feed and two unpacked releases (22 s alone on this box)
});

describe("`morndo update apply --version <v> --attempt <id>` on a node (§8.3, §5.4)", () => {
  it("carries the fleet's attempt into the Update; a node asked without one — or with one of no shape — refuses before anything runs", async () => {
    // The walk begins and defers before any service stops (tmux inside the agent's unit): the records, fast.
    const id = "applied-by-the-principal-00000";
    const w = await tickWorld();
    w.fleet.word = word();
    w.services.tmuxIn = true;
    const r = await w.run(["update", "apply", "--version", B, "--attempt", id]);
    expect(r.code, r.err).toBe(75);                             // the deferral itself is the walk's own word
    const record = w.store.recentUpdates(1)[0]!;
    expect(record.state).toBe("abandoned");
    expect(record.attempt).toBe(id);                            // the Update carries the id it was given (§5.4)

    // Without an attempt the node refuses outright (64): a rollback of an apply nobody issued would halt nothing.
    const bare = await tickWorld();
    bare.fleet.word = word();
    bare.services.tmuxIn = true;
    const out = await bare.run(["update", "apply", "--version", B]);
    expect(out.code, out.err).toBe(64);
    expect(bare.store.recentUpdates(1)).toEqual([]);
    expect(bare.services.tape.filter(t => t.startsWith("stop:"))).toEqual([]);

    // An id that is not the fleet's shape is a usage error, before the unit's own gate.
    const bad = await tickWorld();
    bad.fleet.word = word();
    const wrong = await bad.run(["update", "apply", "--version", B, "--attempt", "short"]);
    expect(wrong.code, wrong.err).toBe(64);
    expect(bad.store.recentUpdates(1)).toEqual([]);
  }, 90_000);   // 3 worlds, each two signed releases unpacked (about 10 s apiece on a loaded box)
});

describe("the control plane's own gate before an apply (§7, RL11)", () => {
  const NODES = (() => {
    const f = new FakeFleetView();
    f.nodesWord = [{ name: "n2", agentProtocol: 1, joined: true, revoked: false }];
    return f;
  })();

  it("holds the control plane while a joined node's protocol falls outside the target's range, and names the node", async () => {
    // n2 is joined and speaks agent protocol 1; B's Manifest says agent [2, 2]: the target would drop it.
    const blocked = await tickWorld({
      controlPlane: true, protocol: { agent: [2, 2], clientApi: [1, 1] }, fleet: NODES,
    });
    const r = await blocked.run(["update", "tick"]);
    expect(r.code, r.err).toBe(75);
    expect(stateFile(blocked.statePath)).toMatchObject({ state: "waiting", version: A, target: B, reason: "skew_blocked: n2" });
    expect(blocked.fleet.calls).toContain("nodes");             // the fleet's own nodes, asked through the socket door
    expect(blocked.services.tape.filter(t => t.startsWith("stop:"))).toEqual([]);
    expect(blocked.current()).toBe(A);

    // A fleet that cannot be asked holds the control plane too — never an apply on no word at all.
    const blind = await tickWorld({ controlPlane: true, fleet: (() => { const f = new FakeFleetView(); f.throwNodes = true; return f; })() });
    const out = await blind.run(["update", "tick"]);
    expect(out.code, out.err).toBe(75);
    expect(blind.current()).toBe(A);
  }, 90_000);   // 2 worlds, each two signed releases unpacked (about 10 s apiece on a loaded box)

  it("a target that still accepts the node's protocol applies: the gate opens, the walk runs", async () => {
    const open = await tickWorld({ controlPlane: true, fleet: NODES });   // B's Manifest says agent [1, 2]
    const r = await open.run(["update", "tick"], { random: () => 0, timing: SMALL_WALLS });
    expect(r.code, r.err).toBe(0);
    expect(open.current()).toBe(B);
    expect(stateFile(open.statePath)).toMatchObject({ state: "current", version: B });
  }, 120_000);   // the walk really sleeps §6.4's sixty-second probation; the walls cannot shorten it
});

// The review of #111 at 8a79723 (four findings).
describe("6b review: the attempt in the unit, the boot apply, offline nodes, a rollback that leaves nodes ahead", () => {
  const NODES1 = (): FakeFleetView => { const f = new FakeFleetView(); f.nodesWord = [{ name: "n2", agentProtocol: 1, joined: true, revoked: false }]; return f; };
  const applyEnv = (w: TickWorld) => join(w.home, ".local", "state", "morndo-update", "apply.env");

  it("the unit's attempt is one word: --attempt= (systemd's expansion of an unset value) refuses with a clear error", async () => {
    const w = await tickWorld();
    w.fleet.word = word();
    const out = await w.run(["update", "apply", "--version", B, "--attempt="]);
    expect(out.code, out.err).toBe(64);
    expect(out.err).toContain("apply.env");                       // says what is missing, not a usage dump
    expect(w.store.recentUpdates(1)).toEqual([]);
  });

  it("the rollback instance's own command line (--version rollback --attempt=) reaches the rollback, not the usage", async () => {
    const w = await tickWorld();
    const out = await w.run(["update", "apply", "--version", "rollback", "--attempt="]);
    expect(out.err).not.toContain("usage:");                     // parsed: the rollback's own gate answers
    expect(w.store.recentUpdates(1)).toEqual([]);                // unconfirmed: nothing ran
  });

  it("--attempt=<id> carries the id, and the unit consumes apply.env so a later start cannot reuse it", async () => {
    const id = "applied-by-the-principal-00000";
    const w = await tickWorld();
    w.fleet.word = word();
    w.services.tmuxIn = true;
    mkdirSync(dirname(applyEnv(w)), { recursive: true });
    writeFileSync(applyEnv(w), `MORNDO_ATTEMPT=${id}\n`);
    const r = await w.run(["update", "apply", "--version", B, `--attempt=${id}`]);
    expect(r.code, r.err).toBe(75);
    expect(w.store.recentUpdates(1)[0]?.attempt).toBe(id);
    expect(existsSync(applyEnv(w))).toBe(false);
  });

  it("the control plane's update --yes writes apply.env with a fresh attempt before it starts the unit", async () => {
    const w = await tickWorld({ controlPlane: true, fleet: NODES1() });
    await w.run(["update", "--yes"]);
    expect(w.services.tape.some(t => t.startsWith("runApply:"))).toBe(true);
    const env = readFileSync(applyEnv(w), "utf8");
    expect(env).toMatch(/^MORNDO_ATTEMPT=[A-Za-z0-9_-]{22,64}\n$/);
  });

  it("on a node, update --yes runs under the fleet's offered attempt, and refuses a Version it was not offered", async () => {
    const w = await tickWorld();
    w.fleet.word = word();                                          // offered B under OFFER.attempt
    await w.run(["update", "--yes"]);
    expect(readFileSync(applyEnv(w), "utf8")).toBe(`MORNDO_ATTEMPT=${OFFER.attempt}\n`);

    const none = await tickWorld();
    none.fleet.word = word({ offer: null });
    const out = await none.run(["update", "--yes"]);
    expect(out.code, out.err).toBe(75);
    expect(out.err).toContain("offered");
    expect(existsSync(applyEnv(none))).toBe(false);
    expect(none.services.tape.some(t => t.startsWith("runApply:"))).toBe(false);
  }, 90_000);   // 2 worlds, each two signed releases unpacked (about 10 s apiece on a loaded box)

  it("the boot apply, before the fleet runs, decides on the node list the last tick saw", async () => {
    // a tick with the fleet up sees n2 at protocol 1 and keeps that list; its own walk defers (tmux)
    const w = await tickWorld({ controlPlane: true, fleet: NODES1() });
    w.services.tmuxIn = true;
    expect((await w.run(["update", "tick"], { random: () => 0, timing: SMALL_WALLS })).code).toBe(75);
    w.services.tmuxIn = false;
    w.fleet.throwNodes = true;                                     // boot: the fleet starts after this unit
    const r = await w.run(["update", "boot"], { random: () => 0, timing: SMALL_WALLS });
    expect(r.code, r.err).toBe(0);
    expect(w.current()).toBe(B);
  }, 120_000);

  it("the boot apply with no list seen yet does not apply, says so, and leaves it to the tick", async () => {
    const w = await tickWorld({ controlPlane: true, fleet: NODES1() });
    w.fleet.throwNodes = true;
    const r = await w.run(["update", "boot"]);
    expect(r.code, r.err).toBe(0);
    expect(w.current()).toBe(A);
    expect(r.out + r.err).toContain("the tick");
  });

  it("the boot apply does not use a kept list older than ten minutes: it applies nothing and leaves it to the tick", async () => {
    const w = await tickWorld({ controlPlane: true, fleet: NODES1() });
    w.services.tmuxIn = true;
    expect((await w.run(["update", "tick"])).code).toBe(75);       // a live read: the list is kept
    const kept = join(w.home, ".local", "state", "morndo-update", "fleet-nodes.json");
    const doc = JSON.parse(readFileSync(kept, "utf8")) as { at: number; nodes: unknown };
    writeFileSync(kept, `${JSON.stringify({ ...doc, at: Date.now() - FRESH_VIEW_MS - MIN })}\n`);
    w.services.tmuxIn = false;
    w.fleet.throwNodes = true;
    const r = await w.run(["update", "boot"]);
    expect(r.code, r.err).toBe(0);
    expect(w.current()).toBe(A);
    expect(r.out + r.err).toContain("the tick");
  }, 90_000);   // 1 world, three runs

  it("a joined node that never said its protocol holds the control plane, named as unknown", async () => {
    const f = new FakeFleetView();
    f.nodesWord = [{ name: "n3", agentProtocol: null, joined: true, revoked: false }];
    const w = await tickWorld({ controlPlane: true, fleet: f });
    const r = await w.run(["update", "tick"]);
    expect(r.code, r.err).toBe(75);
    expect(stateFile(w.statePath)).toMatchObject({ state: "waiting", reason: "skew_blocked: n3" });
    expect(r.err).toContain("unknown");
    expect(w.current()).toBe(A);
  });

  it("the boot apply holds on the kept list too: a node it would cut off blocks it", async () => {
    const w = await tickWorld({ controlPlane: true, fleet: NODES1(), protocol: { agent: [2, 2], clientApi: [1, 1] } });
    expect((await w.run(["update", "tick"])).code).toBe(75);       // skew_blocked: n2, and the list kept
    w.fleet.throwNodes = true;
    const r = await w.run(["update", "boot"]);
    expect(r.code, r.err).toBe(75);
    expect(stateFile(w.statePath)).toMatchObject({ state: "waiting", reason: "skew_blocked: n2" });
    expect(w.current()).toBe(A);
  });

  it("the principal's rollback announces its attempt (applying) before it reports the rollback under it", async () => {
    const sink = new FakeStateSink();
    const world = await buildApplyWorld(join(scratch, "rb-announce"), { stateSink: sink, preUpdatePrevious: A });
    expect((await world.apply().apply({ now: true })).kind).toBe("committed");
    const before = sink.written.length;
    const out = await world.apply().rollback();
    expect(out.kind).toBe("rolled_back");
    const after = sink.written.slice(before);
    const announced = after.findIndex(s => s.state === "applying");
    const reported = after.findIndex(s => s.state === "rolled_back");
    expect(announced).toBeGreaterThanOrEqual(0);
    expect(reported).toBeGreaterThan(announced);
    expect(after[announced]).toMatchObject({ target: B, attempt: expect.stringMatching(ATTEMPT) });
    expect(after[reported]).toMatchObject({ version: A, target: B, attempt: after[announced]!.attempt });
  }, 120_000);
});

// RL7 after a resume (found by 6d's design): the fleet offers the Version again, the node had rolled it back.
describe("a Version this node rolled back, offered again after a resume", () => {
  it("the tick never applies it: waiting bad_here, the node stays where it is", async () => {
    const w = await tickWorld();
    w.fleet.word = word();                                          // B committed, unhalted, offered (the resume)
    w.store.recordBad(B, Date.now() - HOUR);                        // B rolled back here an hour ago
    const r = await w.run(["update", "tick"], { random: () => 0, timing: SMALL_WALLS });
    expect(r.code, r.err).toBe(75);
    expect(w.current()).toBe(A);
    expect(stateFile(w.statePath)).toMatchObject({ state: "waiting", version: A, target: B, reason: "bad_here" });
    expect(w.services.tape.filter(t => t.startsWith("stop:"))).toEqual([]);
  }, 90_000);
});

// Found by 6d's two-machine run: the control plane's own node agent moves with the control plane, in the same
// install, so the skew gate (RL11) never counts it — or no Release that drops a protocol could ever apply there.
describe("the control plane's skew gate and its own node", () => {
  const ownNode = (w: TickWorld, name: string): void => {
    const file = join(w.home, ".local", "state", "morndo-node", "status.json");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ node: name })}\n`);
  };
  const fleetOf = (nodes: { name: string; agentProtocol: number }[]): FakeFleetView => {
    const f = new FakeFleetView();
    f.nodesWord = nodes.map(n => ({ ...n, joined: true, revoked: false }));
    return f;
  };

  it("leaves out the node this machine's own agent is: the target goes on to the walk", async () => {
    const w = await tickWorld({ controlPlane: true, fleet: fleetOf([{ name: "cp-node", agentProtocol: 1 }]), protocol: { agent: [2, 2], clientApi: [1, 1] } });
    ownNode(w, "cp-node");
    w.services.tmuxIn = true;                                       // the walk defers right after the gate: fast
    const r = await w.run(["update", "tick"]);
    expect(r.code, r.err).toBe(75);
    expect(stateFile(w.statePath).reason).not.toMatch(/^skew_blocked/);
    expect(w.store.recentUpdates(1)[0]?.state).toBe("abandoned");   // the walk began: the gate let it through
  }, 90_000);

  it("still names every other node it would cut off", async () => {
    const w = await tickWorld({ controlPlane: true, fleet: fleetOf([{ name: "cp-node", agentProtocol: 1 }, { name: "n2", agentProtocol: 1 }]), protocol: { agent: [2, 2], clientApi: [1, 1] } });
    ownNode(w, "cp-node");
    const r = await w.run(["update", "tick"]);
    expect(r.code, r.err).toBe(75);
    expect(stateFile(w.statePath)).toMatchObject({ state: "waiting", reason: "skew_blocked: n2" });
  }, 90_000);
});

