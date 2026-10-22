// The apply's world (design §6.2–§6.6): the real installer, the real store, the real schema reader and backup over
// real SQLite files in a throwaway HOME, and scripted fakes for the machine's services and the role probes — the
// parts a unit test cannot run. Everything the services drive is taped in order, and every fake can die at a named
// call (ApplyInterrupted) to stand a process killed after a mark was saved (§13's power-loss table), which is how
// the recovery tests reach each recorded step.
import type { UpdateStateSink } from "../../src/application/ports.ts";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import {
  DEFAULT_SOAK_MINUTES, PROBATION_MS,
  type DatabaseName, type HealthReport, type SafePointReport, type SchemaInfo, type UpdateService,
} from "@morndo/domain";
import { holdFile, writeFloor } from "@morndo/service-kit";
import { artifactName, buildManifest } from "../../../../scripts/release/manifest.ts";
import type { TreeFile } from "../../../../scripts/release/archive.ts";
import { ApplyInterrupted } from "../../src/application/apply-steps.ts";
import { ApplyService } from "../../src/application/apply-service.ts";
import { RecoveryService } from "../../src/application/recovery-service.ts";
import type {
  AlertKind, AlertSink, ApplyingMarker, Backup, Clock, HoldWriter, Installer, Layout, RoleProbe, ServiceManager,
  Sleeper,
} from "../../src/application/ports.ts";
import { ApplyingFileMarker } from "../../src/adapters/applying-file.ts";
import { SqliteBackup } from "../../src/adapters/backup-sqlite.ts";
import { HoldFileWriter } from "../../src/adapters/hold-file.ts";
import { DirsInstaller } from "../../src/adapters/installer-dirs.ts";
import { SqliteRevocations } from "../../src/adapters/revocations-sqlite.ts";
import { SqliteSchemas } from "../../src/adapters/schema-sqlite.ts";
import { StateFileWriter } from "../../src/adapters/state-file.ts";
import { openUpdateStore, SqliteUpdateStore } from "../../src/adapters/store-sqlite.ts";
import { databasePaths, updaterPaths, type DatabasePaths } from "../../src/adapters/paths.ts";
import { SshSigVerifier } from "../../src/adapters/verifier-sshsig.ts";
import { FakeFleetView } from "./fakes.ts";
import { buildRelease } from "./tar-fixtures.ts";
import { sha256hex } from "./release-fixtures.ts";

export const NOW = 1_761_000_000_000;           // 2025-10-21T09:20:00Z, a whole second as the documents write
export const A = "0.1.0";                        // the running Version
export const B = "0.2.0";                        // the staged Version
export const STALE = "0.0.9";                    // an old install only prune removes
// Small walls where the domain lets them be small; the clock is fake, so a 60 s probation costs nothing. The
// probation wall itself stays PROBATION_MS: judgeProbation's own bar is the domain's, not a knob.
const TIMING = { drainMs: 500, pollMs: 5, healthMs: 400, probationMs: PROBATION_MS };

// Version A's own Manifest: what its databases say today. B's are the world's to bend (a raised fleet floor is the
// migration case). Floor 0 is an all-additive history (packages/protocol releases.ts).
export const SCHEMAS_A: Record<DatabaseName, SchemaInfo> = {
  hub: { version: 3, floor: 1 }, fleet: { version: 2, floor: 0 }, node: { version: 2, floor: 0 },
  connections: { version: 1, floor: 0 },
};
// B migrates the fleet database and raises its floor above A's fleet version: after migrating, A cannot open it, so
// the plan marks restoreOnRollback (RL8) and a rollback must restore the backup.
export const SCHEMAS_B_FLEET_FLOOR: Record<DatabaseName, SchemaInfo> = {
  ...SCHEMAS_A, fleet: { version: 3, floor: 3 },
};

// One Version as the pipeline would ship it: a tree, its signed list, and a Manifest consistent with both.
export type VersionFixture = {
  version: string; filesSha256: string; manifestText: string; manifestSha256: string; archive: Buffer;
};

export function versionFixture(o: {
  version: string; schemas: Record<DatabaseName, SchemaInfo>; protocol?: { agent: [number, number]; clientApi: [number, number] };
}): VersionFixture {
  const tree: TreeFile[] = [
    { path: "README.md", mode: "0444", bytes: Buffer.from(`morndo ${o.version}\n`) },
    { path: "app/run.sh", mode: "0555", bytes: Buffer.from(`#!/bin/sh\necho ${o.version}\n`) },
    { path: "bin/morndo", mode: "0555", link: "../app/run.sh" },
  ];
  const built = buildRelease(tree);
  const name = artifactName(o.version, "linux-x64");
  const manifestText = buildManifest({
    version: o.version,
    commit: "0123456789abcdef0123456789abcdef01234567",
    publishedAt: NOW - 86_400_000,
    repository: "example/morndo",
    protocol: o.protocol ?? { agent: [1, 2], clientApi: [1, 1] },
    schemas: o.schemas,
    artifacts: [{ platform: "linux-x64", name, size: built.gz.length, sha256: sha256hex(built.gz), filesSha256: built.filesSha256, node: "24.21.0" }],
  });
  return { version: o.version, filesSha256: built.filesSha256, manifestText, manifestSha256: sha256hex(Buffer.from(manifestText)), archive: built.gz };
}

// ---- the kill switch: one Die shared by every fake, so a test kills one named call wherever it lands

export type DieAt = { op: string; call?: number } | null;

export class Die {
  on: DieAt = null;
  /** A death *after* the named call really ran (the swap landed, say): killed between the rename and the next mark. */
  after: DieAt = null;
  readonly counts = new Map<string, number>();
  #fires(at: DieAt, op: string): boolean {
    if (at === null || at.op !== op) return false;
    const seen = (this.counts.get(op) ?? 0) + 1;
    this.counts.set(op, seen);
    return at.call === undefined || at.call === seen;
  }
  /** Throws ApplyInterrupted at the chosen call, before the fake records or acts: a dying process never runs the step. */
  check(op: string): void { if (this.#fires(this.on, op)) throw new ApplyInterrupted(op); }
  checkAfter(op: string): void { if (this.#fires(this.after, op)) throw new ApplyInterrupted(op); }
}

// The installer stays real; only the swap carries die points, for §13's hardest windows: a death before the two
// renames (nothing swapped) and one after they landed but before the next mark was saved (current is the target).
export class TapedInstaller implements Installer {
  readonly real: DirsInstaller;
  readonly die: Die;

  constructor(o: { real: DirsInstaller; die: Die }) { this.real = o.real; this.die = o.die; }

  layout(): Layout { return this.real.layout(); }
  shippedKeySet(): Uint8Array | null { return this.real.shippedKeySet(); }
  sweep(): void { this.real.sweep(); }
  has(version: string): boolean { return this.real.has(version); }
  async unpack(archive: string, version: string, o: { filesSha256: string; maxBytes: number }) { return this.real.unpack(archive, version, o); }
  async selftest(version: string) { return this.real.selftest(version); }
  promote(version: string, record: { manifestSha256: string; filesSha256: string; at: number }): void { this.real.promote(version, record); }
  discard(version: string): void { this.real.discard(version); }
  removeVersion(version: string): void { this.real.removeVersion(version); }
  swap(pair: { current: string; previous: string | null }): void {
    this.die.check("swap");
    this.real.swap(pair);
    this.die.checkAfter("swap");
  }
  swapBack(pair: { current: string; previous: string | null }): void {
    this.die.check("swapBack");
    this.real.swapBack(pair);
    this.die.checkAfter("swapBack");
  }
  setGood(version: string): void { this.real.setGood(version); }
  prune(keep: readonly string[]): void { this.real.prune(keep); }
  async verifyTree(version: string, filesSha256: string | null) { return this.real.verifyTree(version, filesSha256); }
  freeBytes(): number { return this.real.freeBytes(); }
}

// ---- the machine's services: every call taped, restarts scripted, a start may "run the version's own code"

export class FakeServices implements ServiceManager {
  /** The Morndo services this machine runs (§6.2 stops and starts only these, in a fixed order). */
  running: UpdateService[];
  tmuxIn = false;
  /** Unit files a render would replace that are not Morndo's: what foreignUnits answers. */
  foreign: string[] = [];
  /** Per-service restart counts the manager would report since the start (probation, RL7). */
  restartCounts: Partial<Record<UpdateService, number>> = {};
  /** Runs when a service starts, told the Version that is current: a test's stand-in for the service's own startup
   *  code — B's fleet migration, a crash on start. */
  onStart: ((s: UpdateService, current: string | null) => void) | null = null;
  /** Runs as a stop lands: what a service still did in its last moment (a revocation that came in, say). */
  onStop: ((s: UpdateService, current: string | null) => void) | null = null;
  /** Runs in place of the apply unit's whole run (§6.2): a test's stand-in for what the unit does to the store. */
  runApplyScript: ((version: string) => Promise<void>) | null = null;
  /** What lingerEnabled answers (§10.3's install refuses without it). */
  linger = true;
  /** Every enable call's unit list, in order (§10.3). */
  readonly enables: string[][] = [];
  readonly calls: { op: string; service?: UpdateService; version?: string }[] = [];
  readonly tape: string[];
  readonly die: Die;
  readonly #currentOf: () => string | null;

  constructor(o: { tape: string[]; die: Die; currentOf: () => string | null; running?: UpdateService[] | undefined }) {
    this.tape = o.tape;
    this.die = o.die;
    this.#currentOf = o.currentOf;
    this.running = [...(o.running ?? ["hub", "node", "fleet"])];
  }

  services(): UpdateService[] { return [...this.running]; }

  async stop(s: UpdateService): Promise<void> {
    this.die.check("stop");
    this.calls.push({ op: "stop", service: s });
    this.tape.push(`stop:${s}`);
    this.onStop?.(s, this.#currentOf());
  }

  async start(s: UpdateService): Promise<void> {
    this.die.check("start");
    this.calls.push({ op: "start", service: s });
    this.tape.push(`start:${s}`);
    this.onStart?.(s, this.#currentOf());
  }

  async restarts(s: UpdateService): Promise<number> {
    this.calls.push({ op: "restarts", service: s });
    return this.restartCounts[s] ?? 0;
  }

  async renderUnits(version: string, role?: { services: readonly UpdateService[] }, o?: { replaceForeign?: boolean }): Promise<string[]> {
    this.die.check("renderUnits");
    this.calls.push({ op: "renderUnits", version });
    this.tape.push(`renderUnits:${version}${role === undefined ? "" : ` (${role.services.join(",")})`}${o?.replaceForeign === true ? " replacing foreign" : ""}`);
    return o?.replaceForeign === true ? this.foreign.map(p => `${p}.before-morndo`) : [];
  }

  async foreignUnits(): Promise<string[]> {
    return [...this.foreign];
  }

  async tmuxInAgentUnit(): Promise<boolean> {
    this.calls.push({ op: "tmuxInAgentUnit" });
    this.tape.push(`tmux:${this.tmuxIn}`);
    return this.tmuxIn;
  }

  async runApply(version: string): Promise<void> {
    this.calls.push({ op: "runApply", version });
    this.tape.push(`runApply:${version}`);
    if (this.runApplyScript !== null) await this.runApplyScript(version);
  }

  async enable(units: readonly string[]): Promise<void> {
    this.calls.push({ op: "enable" });
    this.enables.push([...units]);
    this.tape.push(`enable:${units.join(",")}`);
  }

  async lingerEnabled(): Promise<boolean> {
    this.calls.push({ op: "lingerEnabled" });
    return this.linger;
  }
}

// ---- the probes: each test scripts the answers, per service and per call; null is "no answer"

export class FakeProbe implements RoleProbe {
  /** §6.3: what each service reports in flight. Default: nothing — a lane that is busy but has nothing in flight
   *  blocks nothing. */
  safePointScript: (s: UpdateService, call: number) => SafePointReport | null = s => ({ service: s, blockers: [] });
  /** §6.4: each service's health. Default: the running Version, every check passing. */
  healthScript: (s: UpdateService, call: number) => HealthReport | null =
    s => ({ service: s, version: this.currentOf() ?? "0.0.0", checks: { ready: true, database: true } });
  readonly safePointCalls: { service: UpdateService; call: number }[] = [];
  /** Whether the service has read the hold (its health's `held`). The world sets a realistic default: a service sees
   *  the hold one re-read interval (1 s of the timeline) after it was written. */
  seesHoldScript: (s: UpdateService, call: number) => boolean | null = () => true;
  readonly seesHoldCalls: { service: UpdateService; call: number }[] = [];
  readonly healthCalls: { service: UpdateService; call: number }[] = [];
  readonly tape: string[];
  readonly die: Die;
  readonly currentOf: () => string | null;

  constructor(o: { tape: string[]; die: Die; currentOf: () => string | null }) {
    this.tape = o.tape;
    this.die = o.die;
    this.currentOf = o.currentOf;
  }

  async seesHold(s: UpdateService): Promise<boolean | null> {
    const call = this.seesHoldCalls.filter(c => c.service === s).length + 1;
    this.seesHoldCalls.push({ service: s, call });
    const answer = this.seesHoldScript(s, call);
    this.tape.push(`ack:${s}:${String(answer)}`);
    return answer;
  }

  async safePoint(s: UpdateService): Promise<SafePointReport | null> {
    this.die.check("safePoint");
    const call = this.safePointCalls.filter(c => c.service === s).length + 1;
    this.safePointCalls.push({ service: s, call });
    const answer = this.safePointScript(s, call);
    this.tape.push(`safe:${s}:${answer === null ? "no_answer" : answer.blockers.length}`);
    return answer;
  }

  async health(s: UpdateService): Promise<HealthReport | null> {
    this.die.check("health");
    const call = this.healthCalls.filter(c => c.service === s).length + 1;
    this.healthCalls.push({ service: s, call });
    const answer = this.healthScript(s, call);
    this.tape.push(`health:${s}:${answer === null ? "none" : answer.version}`);
    return answer;
  }
}

// ---- the hold and the backup: the real adapters, taped and killable

export class TapedHold implements HoldWriter {
  readonly tape: string[];
  readonly die: Die;
  readonly real: HoldFileWriter;

  constructor(o: { tape: string[]; die: Die; real: HoldFileWriter }) {
    this.tape = o.tape;
    this.die = o.die;
    this.real = o.real;
  }

  write(h: { services: UpdateService[]; reason: "drain" | "probation"; version: string; since: number }): void {
    this.die.check("write");
    this.real.write(h);
    this.tape.push(`hold:${h.reason}`);
  }

  clear(): void {
    this.die.check("clear");
    this.real.clear();
    this.tape.push("hold:clear");
  }
}

export class TapedBackup implements Backup {
  readonly tape: string[];
  readonly die: Die;
  readonly real: SqliteBackup;

  constructor(o: { tape: string[]; die: Die; real: SqliteBackup }) {
    this.tape = o.tape;
    this.die = o.die;
    this.real = o.real;
  }

  async take(updateId: string, db: DatabaseName) {
    this.die.check("take");
    const done = await this.real.take(updateId, db);
    this.tape.push(`backup:take:${db}:${done.ok ? "ok" : "failed"}`);
    return done;
  }

  has(updateId: string, db: DatabaseName): boolean { return this.real.has(updateId, db); }

  restore(updateId: string, db: DatabaseName): void {
    this.die.check("restore");
    this.real.restore(updateId, db);
    this.tape.push(`backup:restore:${db}`);
  }

  prune(keep: readonly string[]): void {
    this.die.check("prune");
    this.real.prune(keep);
    this.tape.push("backup:prune");
  }
}

// ---- the clock and the sleeper: sleeping is the only thing that moves time

export class FakeTimeline implements Clock, Sleeper {
  nowMs: number;
  readonly slept: number[] = [];

  constructor(nowMs: number) { this.nowMs = nowMs; }

  now(): number { return this.nowMs; }

  async sleep(ms: number): Promise<void> {
    this.slept.push(ms);
    this.nowMs += ms;
  }
}

export class AlertRecorder implements AlertSink {
  readonly raised: { kind: AlertKind; detail: string }[] = [];
  raise(kind: AlertKind, detail: string): void { this.raised.push({ kind, detail }); }
}

// ---- the world

export type ApplyWorld = {
  home: string;
  releases: string;
  holdPath: string;
  updateDb: string;
  dbPaths: DatabasePaths;
  backupsDir: string;
  tape: string[];
  die: Die;
  store: SqliteUpdateStore;
  installer: TapedInstaller;
  services: FakeServices;
  probe: FakeProbe;
  schemas: SqliteSchemas;
  backup: TapedBackup;
  revocations: SqliteRevocations;
  hold: TapedHold;
  /** The `applying` mark (§5), real like the hold: the recovery unit runs only while it exists. */
  applying: ApplyingMarker;
  applyingPath: string;
  timeline: FakeTimeline;
  alerts: AlertRecorder;
  verifier: SshSigVerifier;
  /** The fleet's word (§7) and the state file's path, the two things PR 6b's outcomes reach outside the walk. */
  fleet: FakeFleetView;
  statePath: string;
  a: VersionFixture;
  b: VersionFixture;
  /** A fresh apply service over the world as it stands, on the tests' small walls. */
  apply(): ApplyService;
  /** A fresh recovery service, as the recovery unit would run one (§6.6). */
  recover(): RecoveryService;
  /** The same recovery, but its lock answers held: another process got there first. */
  recoverWithLockHeld(): RecoveryService;
  /** A second, independent connection to the same update.db: what a next process opens. */
  reopenStore(): SqliteUpdateStore;
  current(): string | null;
};

export type WorldOptions = {
  /** A sink for state.json writes in place of the real file (to read their order). */
  stateSink?: UpdateStateSink;
  /** B's Manifest's schemas (the migration cases). */
  bSchemas?: Record<DatabaseName, SchemaInfo>;
  /** What the previous link points at before the update (default: nothing, a first update) — the pair a rollback
   *  must put back whole (§6.5 step 2). */
  preUpdatePrevious?: string;
  /** The machine's services (default: all three, a control plane). */
  running?: UpdateService[];
  /** Floors higher than A's own Manifest says, as a newer service's leftovers would be (a target below one is refused). */
  dbFloors?: Partial<Record<DatabaseName, number>>;
  /** The lock answers held before anything runs: another process's apply (the cross-process part is store-sqlite's test). */
  lockHeldByAnother?: boolean;
  /** The fleet's word (§7); default: none, a fleet nobody has asked. The world keeps it for the tests; the apply
   *  itself has no fleet door anymore — its only word out is the state file. */
  fleet?: FakeFleetView;
  /** The soak this machine's settings name (§4.5); default: the domain's own. */
  soakMinutes?: number;
  /** The attempt id the apply mints when its caller brings none (§5.4); default: the real random one. */
  mintAttempt?: () => string;
};

// The real store with its lock answering held: tryLock is where the store's own cross-process rule lives.
class LockHeldStore extends SqliteUpdateStore {
  override tryLock(): null { return null; }
}

let worldCount = 0;

export async function buildApplyWorld(scratch: string, o: WorldOptions = {}): Promise<ApplyWorld> {
  const home = join(scratch, `home-${(worldCount += 1)}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const paths = updaterPaths(home);
  const dbPaths = databasePaths(home, {});
  const realInstaller = new DirsInstaller({ releases: paths.releases });
  const a = versionFixture({ version: A, schemas: SCHEMAS_A });
  const b = versionFixture({ version: B, schemas: o.bSchemas ?? SCHEMAS_A });
  const stale = versionFixture({ version: STALE, schemas: SCHEMAS_A });

  // A is current and good; B and a stale 0.0.9 sit installed beside it, promoted the way a check would.
  for (const fixture of [a, b, stale]) {
    const archive = join(home, `${fixture.version}.tar.gz`);
    writeFileSync(archive, fixture.archive);
    const unpacked = await realInstaller.unpack(archive, fixture.version, { filesSha256: fixture.filesSha256, maxBytes: 1 << 20 });
    if (!unpacked.ok) throw new Error(`fixture ${fixture.version} did not unpack: ${unpacked.reason}`);
    realInstaller.promote(fixture.version, { manifestSha256: fixture.manifestSha256, filesSha256: fixture.filesSha256, at: NOW });
    rmSync(archive, { force: true });
  }
  realInstaller.swap({ current: A, previous: o.preUpdatePrevious ?? null });
  realInstaller.setGood(A);

  // The databases at A's schemas, each with a row a backup and a restore can be seen to move (§11.3).
  const makeDb = (path: string, version: number, floor: number): void => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = new Database(path);
    db.exec("CREATE TABLE lanes (id TEXT NOT NULL)");
    db.prepare("INSERT INTO lanes (id) VALUES (?)").run(`written-at-${version}`);
    db.pragma(`user_version = ${version}`);
    writeFloor(db, floor);
    db.close();
  };
  for (const db of ["hub", "fleet", "node", "connections"] as const) {
    makeDb(dbPaths[db], SCHEMAS_A[db].version, o.dbFloors?.[db] ?? SCHEMAS_A[db].floor);
  }

  const store = o.lockHeldByAnother
    ? new LockHeldStore({ db: paths.db, lock: paths.lock })
    : openUpdateStore({ db: paths.db, lock: paths.lock });
  // Both Manifests recorded as the check would have: A's is the plan's `previous`, B's is the target's.
  store.recordStaged({ version: a.version, manifestSha256: a.manifestSha256, filesSha256: a.filesSha256, at: NOW - 2_000, manifest: a.manifestText });
  store.recordStaged({ version: b.version, manifestSha256: b.manifestSha256, filesSha256: b.filesSha256, at: NOW - 1_000, manifest: b.manifestText });

  const tape: string[] = [];
  const die = new Die();
  const installer = new TapedInstaller({ real: realInstaller, die });
  const current = (): string | null => installer.layout().current;
  const services = new FakeServices({ tape, die, currentOf: current, running: o.running });
  const probe = new FakeProbe({ tape, die, currentOf: current });
  const holdPathOf = holdFile(home, {});
  const realHold = new HoldFileWriter({ home, env: {} });
  const hold = new TapedHold({ tape, die, real: realHold });
  const applying = new ApplyingFileMarker({ state: paths.state });
  const backup = new TapedBackup({ tape, die, real: new SqliteBackup({ paths: dbPaths, backups: join(paths.state, "backups") }) });
  const schemas = new SqliteSchemas({ paths: dbPaths });
  const revocations = new SqliteRevocations({ paths: dbPaths, backups: join(paths.state, "backups") });
  const timeline = new FakeTimeline(NOW);                   // ms since the epoch, as Clock.now answers
  probe.seesHoldScript = () => {                            // HoldWatch re-reads hold.json every second
    const text = holdText(holdPathOf);
    return text !== null && timeline.now() - Date.parse((JSON.parse(text) as { since: string }).since) >= 1_000;
  };
  const alerts = new AlertRecorder();
  const verifier = new SshSigVerifier();

  // PR 6b's additions, shared by every service the world builds: the state sink every outcome writes, the soak a
  // commit's record carries, and the mint behind every attempt the updater itself owns (§5.4). The fleet stays in the
  // world for the tests to read; no service below is given it.
  const fleet = o.fleet ?? new FakeFleetView();
  const stateSink: UpdateStateSink = o.stateSink ?? new StateFileWriter({ path: join(paths.state, "state.json") });
  const soakMinutes = o.soakMinutes ?? DEFAULT_SOAK_MINUTES;
  const mintAttempt = o.mintAttempt ?? ((): string => randomBytes(16).toString("base64url"));
  return {
    home, releases: paths.releases, holdPath: holdFile(home, {}), updateDb: paths.db, dbPaths,
    backupsDir: join(paths.state, "backups"), tape, die, store, installer, services, probe, schemas, backup, revocations, hold,
    applying, applyingPath: join(paths.state, "applying"),
    timeline, alerts, verifier, fleet, statePath: join(paths.state, "state.json"), a, b,
    apply: () => new ApplyService({
      services, probe, schemas, backup, revocations, hold, applying, installer, store, clock: timeline, sleeper: timeline,
      alerts, verifier, timing: TIMING,
      state: stateSink, soakMinutes, mintAttempt,
    }),
    recover: () => new RecoveryService({
      services, probe, backup, revocations, hold, applying, installer, store, clock: timeline, sleeper: timeline, alerts,
      timing: TIMING,
      state: stateSink, soakMinutes,
    }),
    recoverWithLockHeld: () => new RecoveryService({
      services, probe, backup, revocations, hold, applying, installer,
      store: new LockHeldStore({ db: paths.db, lock: paths.lock }),
      clock: timeline, sleeper: timeline, alerts, timing: TIMING,
      state: stateSink, soakMinutes,
    }),
    reopenStore: () => openUpdateStore({ db: paths.db, lock: paths.lock }),
    current,
  };
}

// ---- small shared helpers

/** The hold.json text, or null when there is none. */
export const holdText = (path: string): string | null => {
  try { return readFileSync(path, "utf8"); } catch { return null; }
};

/** What a backup-and-restore must give back: not the same bytes (SQLite's backup API writes its own pages) but
 *  the same database — the same rows, the same schema version, opening clean. */
export const dbFingerprint = (path: string): { version: number; lanes: string[] } => {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return {
      version: db.pragma("user_version", { simple: true }) as number,
      lanes: (db.prepare("SELECT id FROM lanes ORDER BY id").all() as { id: string }[]).map(row => row.id),
    };
  } finally { db.close(); }
};

/** Makes the backups directory unwritable, so the next backup fails as a full disk would (§13). */
export function breakBackups(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });   // created lazily at the first take; it may not exist yet
  chmodSync(dir, 0o500);
}
