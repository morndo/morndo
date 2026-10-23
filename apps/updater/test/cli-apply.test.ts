// `morndo update` and the units' own commands (design §6.1, §6.7, §8.1, §8.3, §8.4): what the composition root
// answers when a person, a timer or a boot asks. The world is a real install over a throwaway HOME — the real
// installer, the real store, the real databases — with the machine's services and probes faked and injected
// through runUpdater's deps override (a test-only door; production detects systemd or launchd and probes the
// machine's own doors). The feed is faked the same way with the fixtures' own signed documents, so the tick's
// check stages from a feed the test signed, and the apply that follows is the real walk on the real machine
// files with nothing of the machine itself running.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { writeFloor } from "@morndo/service-kit";
import { parseVersion, type DatabaseName, type MigrationStep, type UpdateService } from "@morndo/domain";
import { RollbackPreviewSchema, UpdateStatusSchema, UPDATER_ARGS } from "@morndo/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApplyTiming } from "../src/application/apply-steps.ts";
import { DirsInstaller } from "../src/adapters/installer-dirs.ts";
import { databasePaths, updaterPaths } from "../src/adapters/paths.ts";
import { openUpdateStore, SqliteUpdateStore } from "../src/adapters/store-sqlite.ts";
import { runUpdater } from "../src/cli.ts";
import {
  Die, FakeProbe, FakeServices, NOW, A, B, SCHEMAS_A, versionFixture,
} from "./helpers/apply-fakes.ts";
import { FakeArtifacts, FakeFeed, FakeFleetView, wipe } from "./helpers/fakes.ts";
import { feedFixture, keySetDocument, makeKeys, manifestSignature, releaseFixture, type Keys, type ReleaseFixture } from "./helpers/release-fixtures.ts";

const DAY = 24 * 3600_000;
const YEAR = 365 * DAY;

let scratch = "";
beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), "morndo-upd-")); });
afterAll(() => { wipe(scratch); });

// One machine: version A installed, current and good, its trust anchored on the test's own key set; the channel
// feed offers B (signed, as the fixtures sign), and nothing of the machine runs but the fakes.
type World = {
  home: string;
  paths: ReturnType<typeof updaterPaths>;
  store: SqliteUpdateStore;
  services: FakeServices;
  probe: FakeProbe;
  feed: FakeFeed;
  /** The artifacts door: a test that wants the check to truly stage B serves its archive here. */
  artifacts: FakeArtifacts;
  /** The fleet as the control plane asks it (§7): no Rollout word, and no nodes at all — the skew gate's open word. */
  fleet: FakeFleetView;
  keys: Keys;
  b: ReleaseFixture;
  /** Also installs and stages B, as a check that already ran would have left the machine. */
  stageB(): Promise<void>;
  /** Writes the settings file (its directory with it), as a principal or the install would. */
  writeConfig(doc: unknown): void;
  current(): string | null;
  run(argv: string[], env?: Record<string, string | undefined>, o?: {
    timing?: Partial<ApplyTiming>;
    /** A terminal is there, and its ask answers `answer` (the prompts are taped for assertions). */
    tty?: boolean;
    answer?: string;
  }): Promise<{ code: number; out: string; err: string; prompts: string[] }>;
};

const feedOf = (keys: Keys, releases: readonly ReleaseFixture[]) => {
  const feed = new FakeFeed();
  // The feed's own freshness is judged against the real clock (§9.5), so the channel is published now, not at
  // the fixtures' made-up NOW.
  const served = feedFixture(keys, releases, { channel: "stable", now: Date.now() });
  feed.channels.set("stable", served.served);
  for (const release of releases)
    feed.manifests.set(release.manifestUrl, { bytes: release.manifestBytes, signature: manifestSignature(keys, release) });
  return feed;
};

let worldCount = 0;
async function world(o: { running?: UpdateService[]; preStageB?: boolean; offerB?: boolean } = {}): Promise<World> {
  const home = join(scratch, `home-${(worldCount += 1)}`);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const paths = updaterPaths(home);
  const dbPaths = databasePaths(home, {});
  const keys = makeKeys();
  // The CLI runs on the real clock, so the key set must outlive it: the fixtures' own NOW is a made-up past.
  const keySet = keySetDocument(keys, { version: 1, expiresAt: NOW + 20 * YEAR });
  const a = releaseFixture({ version: A, now: NOW - 2 * DAY });
  const b = releaseFixture({ version: B, now: NOW - DAY });
  const installer = new DirsInstaller({ releases: paths.releases });
  const install = async (fixture: ReleaseFixture): Promise<void> => {
    const archive = join(home, `${fixture.version}.tar.gz`);
    writeFileSync(archive, fixture.archive);
    const unpacked = await installer.unpack(archive, fixture.version, { filesSha256: fixture.filesSha256, maxBytes: 1 << 20 });
    if (!unpacked.ok) throw new Error(`${fixture.version} did not unpack: ${unpacked.reason}`);
    installer.promote(fixture.version, { manifestSha256: fixture.manifestSha256, filesSha256: fixture.filesSha256, at: NOW });
    rmSync(archive, { force: true });
  };
  await install(a);
  installer.swap({ current: A, previous: null });
  installer.setGood(A);
  // The databases at A's schemas, as buildApplyWorld makes them: the apply's plan reads real schemas, and its
  // backups move real rows.
  for (const db of ["hub", "fleet", "node", "connections"] as const) {
    const path = dbPaths[db];
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db_ = new Database(path);
    db_.exec("CREATE TABLE lanes (id TEXT NOT NULL)");
    db_.prepare("INSERT INTO lanes (id) VALUES (?)").run(`written-at-${db}`);
    db_.pragma(`user_version = ${SCHEMAS_A[db].version}`);
    writeFloor(db_, SCHEMAS_A[db].floor);
    db_.close();
  }
  const store = openUpdateStore({ db: paths.db, lock: paths.lock });
  store.saveTrust({ keySet: keySet.decoded, highestFeedSeq: { stable: 0, latest: 0 } });
  const tape: string[] = [];
  const die = new Die();
  const services = new FakeServices({ tape, die, currentOf: () => installer.layout().current, running: o.running });
  const probe = new FakeProbe({ tape, die, currentOf: () => installer.layout().current });
  // The feed offers B unless a test asks for a machine that is already up to date (only A on the channel).
  const feed = feedOf(keys, o.offerB === false ? [a] : [b]);
  const artifacts = new FakeArtifacts(paths.downloads);
  const fleet = new FakeFleetView();
  fleet.nodesWord = [];                       // a control plane's apply asks the fleet's nodes (RL11): none is no hold
  const writeConfig = (doc: unknown): void => {
    mkdirSync(dirname(paths.config), { recursive: true, mode: 0o700 });
    writeFileSync(paths.config, `${JSON.stringify(doc)}\n`);
  };
  const w: World = {
    home, paths, store, services, probe, feed, artifacts, fleet, keys, b,
    stageB: async () => {
      await install(b);
      store.recordStaged({ version: b.version, manifestSha256: b.manifestSha256, filesSha256: b.filesSha256, at: NOW - 1000, manifest: b.manifestText });
    },
    current: () => installer.layout().current,
    run: async (argv, env = {}, opts = {}) => {
      const out: string[] = [], err: string[] = [], prompts: string[] = [];
      const code = await runUpdater(argv, { HOME: home, PATH: process.env.PATH, ...env }, {
        out: s => out.push(s), err: s => err.push(s),
        ...(opts.tty === true ? { tty: true, ask: async (prompt: string) => { prompts.push(prompt); return opts.answer ?? ""; } } : {}),
      }, {
        services, probe, feed, artifacts, fleet,
        ...(opts.timing ? { timing: opts.timing } : {}),
      });
      return { code, out: out.join(""), err: err.join(""), prompts };
    },
    writeConfig,
  };
  if (o.preStageB) await w.stageB();
  return w;
}

describe("`morndo update` — check, then apply what stands staged (§8.1)", () => {
  it("with nothing staged prints and exits as the check did: up to date, exit 0", async () => {
    const w = await world({ offerB: false });              // the channel offers nothing newer than A
    const r = await w.run(["update"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(new RegExp(`Up to date: ${A}`));
    expect(w.services.tape).toEqual([]);                  // nothing was started, stopped or asked to apply
  });

  it("with a staged release and --yes it starts the apply unit and exits by the record it left", async () => {
    for (const [state, code] of [["committed", 0], ["rolled_back", 1], ["rollback_failed", 70], ["abandoned", 75]] as const) {
      const w = await world({ preStageB: true });
      let applyNowFile = false;
      w.services.runApplyScript = async () => {
        // The unit's own work, as the fake's stand-in: one attempt, ended in the state under test.
        applyNowFile = existsSync(join(w.paths.state, "apply-now"));
        const unit = openUpdateStore({ db: w.paths.db, lock: w.paths.lock });
        unit.saveUpdate({
          id: "upd-unit", kind: "update", target: parseVersion(B)!, preUpdate: { current: parseVersion(A)!, previous: null },
          state: "staged", mark: null, backups: [], migrations: null,
          format: 1, startedAt: Date.now(), doneMarks: [], judgeBaseline: null, backupOf: null, attempt: null,
        });
        unit.finishUpdate("upd-unit", state, Date.now());
        unit.close();
      };
      const r = await w.run(["update", "--yes"]);
      expect(r.code, `${state}: ${r.err}`).toBe(code);
      expect(w.services.calls.some(c => c.op === "runApply" && c.version === B), state).toBe(true);
      expect(applyNowFile, state).toBe(false);             // no --now: the file is never written
    }
  }, 120_000);   // four worlds, each a signed feed and two unpacked releases (68 s alone on this box)

  it("an apply that ends with no record answers in the unit's own words, never with an older record's", async () => {
    // The real unit command runs as the unit would; another process holds the apply lock, so it ends busy (75) and
    // records nothing. An attempt from a day before stands on record: it is not this run's answer.
    const w = await world({ preStageB: true });
    w.store.saveUpdate({
      id: "upd-yesterday", kind: "update", target: parseVersion(B)!, preUpdate: { current: parseVersion(A)!, previous: null },
      state: "staged", mark: null, backups: [], migrations: null,
      format: 1, startedAt: Date.now() - DAY, doneMarks: [], judgeBaseline: null, backupOf: null, attempt: null,
    });
    w.store.finishUpdate("upd-yesterday", "committed", Date.now() - DAY);
    let unit: { code: number; err: string } | null = null;
    w.services.runApplyScript = async version => {
      const held = w.store.tryLock();                        // taken while the unit runs, not before the command
      try { unit = await w.run(["update", "apply", "--version", version]); } finally { held?.release(); }
    };
    const r = await w.run(["update", "--yes"]);
    expect(unit, "the unit ran").toMatchObject({ code: 75, err: expect.stringMatching(/Busy/) });
    expect(r.code, r.err).toBe(75);
    expect(r.err).toMatch(/Busy: another process holds the apply lock/);
    expect(r.err + r.out).not.toMatch(/Committed|did not run/);
  });

  it("a unit that crashed before it answered is a unit that did not run", async () => {
    const w = await world({ preStageB: true });
    w.services.runApplyScript = async () => { throw new Error("Job for morndo-update-apply@0.2.0.service failed"); };
    const r = await w.run(["update", "--yes"]);
    expect(r.code).toBe(75);
    expect(r.err).toMatch(/the apply unit did not run: Job for/);
  });

  it("--now writes the apply-now file before the unit starts, and the unit's apply consumes it", async () => {
    const w = await world({ preStageB: true });
    w.services.runApplyScript = async () => {
      expect(existsSync(join(w.paths.state, "apply-now"))).toBe(true);
    };
    const r = await w.run(["update", "--yes", "--now"]);
    expect(r.code, r.err).toBe(75);                        // the scripted unit recorded nothing: deferred
    expect(existsSync(join(w.paths.state, "apply-now"))).toBe(false);
  });

  it("no terminal and no --yes is a usage error, with one sentence, and nothing starts", async () => {
    const w = await world({ preStageB: true });
    const r = await w.run(["update"]);                     // the test runs without a TTY, as a script would
    expect(r.code).toBe(64);
    expect(r.err).toMatch(/--yes|terminal|apply/i);
    expect(w.services.tape).toEqual([]);
  });

  // PR 6c: the hub starts updates this way — one command, no waiting, the exit is the start's, not the walk's.
  it("--detach starts the apply unit and answers at once: the unit, not this process, walks the steps", async () => {
    const w = await world({ preStageB: true });
    const r = await w.run(["update", "--yes", "--detach"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/[Ss]tarted/);
    expect(w.services.calls.find(c => c.op === "runApply")).toMatchObject({ version: B, wait: false });
    expect(w.services.tape.filter(t => t !== `runApply:${B}`)).toEqual([]);   // nothing else ran here
    expect(w.store.openUpdate()).toBeNull();                                  // no record: the unit writes its own
  });

  it("--detach without --yes is the same usage error; with nothing staged it answers as the check did", async () => {
    const w = await world({ preStageB: true });
    const refused = await w.run(["update", "--detach"]);
    expect(refused.code).toBe(64);
    expect(refused.err).toMatch(/--yes|terminal|apply/i);
    expect(w.services.tape).toEqual([]);
    const upToDate = await world({ offerB: false });
    const r = await upToDate.run(["update", "--yes", "--detach"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(new RegExp(`Up to date: ${A}`));
    expect(upToDate.services.calls.filter(c => c.op === "runApply")).toEqual([]);
  });

  it("`update apply` refuses a version that is not the one staged, and applies nothing", async () => {
    const w = await world({ preStageB: true });
    const r = await w.run(["update", "apply", "--version", "9.9.9"]);
    expect(r.code, r.err).toBe(75);
    expect(r.err).toMatch(/staged version changed/);
    expect(w.services.tape).toEqual([]);
    expect(w.current()).toBe(A);
  });

  // PR 6c round 2, R3: the hub presses a Version on the Updates screen and commands `--staged <v>`; that, and only
  // that, is what this run applies. The check above may have staged a newer Release between the screen's look and
  // the press — a press of the older name never starts the newer one.
  it("--staged applies only the pressed Version: equal applies; unequal is 75 with nothing started; without --yes a usage error", async () => {
    // equal: the apply starts as --yes --detach does, and apply.env (§5.4's attempt) stays written for the unit
    {
      const w = await world({ preStageB: true });
      const r = await w.run(["update", "--yes", "--detach", "--staged", B]);
      expect(r.code, r.err).toBe(0);
      expect(w.services.calls.find(c => c.op === "runApply")).toMatchObject({ version: B, wait: false });
      expect(readFileSync(join(w.paths.state, "apply.env"), "utf8")).toMatch(/^MORNDO_ATTEMPT=[A-Za-z0-9_-]{22}\n$/);
    }
    // unequal: one sentence naming both, exit 75, nothing started — not even the attempt's apply.env
    {
      const w = await world({ preStageB: true });
      const r = await w.run(["update", "--yes", "--detach", "--staged", "9.9.9"]);
      expect(r.code, r.err).toBe(75);
      expect(r.err).toMatch(/what stands staged is 0\.2\.0, not 9\.9\.9: nothing was started/);
      expect(w.services.tape).toEqual([]);
      expect(existsSync(join(w.paths.state, "apply.env"))).toBe(false);
    }
    // --staged rides --yes: it names the pressed Version for a command whose ask is already answered
    {
      const w = await world({ preStageB: true });
      const r = await w.run(["update", "--staged", B]);
      expect(r.code).toBe(64);
      expect(r.err).toMatch(/usage:/);
      expect(w.services.tape).toEqual([]);
    }
  }, 90_000);   // three worlds, each a signed feed and unpacked releases
});

// The hub runs the control plane's updater through packages/protocol's UPDATER_ARGS and nothing else (PR 6c R1):
// this is the contract between the two. A list the updater answers with its usage text (exit 64) is a hub that can
// neither read its own machine's status nor move it — round 1's hub sent `--status --json` without the `update`
// command, and every control-plane apply answered unavailable.
describe("the hub's argument lists (UPDATER_ARGS, PR 6c R1): the updater reads every one", () => {
  it("status answers the schema; apply and rollback start their units — none is the usage text", async () => {
    // status and apply share one machine: reading status changes nothing
    const w = await world({ preStageB: true });
    const read = await w.run(UPDATER_ARGS.status);
    expect(read.code, read.err).toBe(0);
    expect(read.err).not.toMatch(/usage:/);
    expect(UpdateStatusSchema.parse(JSON.parse(read.out)).staged).toBe(B);
    const applied = await w.run(UPDATER_ARGS.apply(B));
    expect(applied.code, applied.err).toBe(0);
    expect(applied.err).not.toMatch(/usage:/);
    expect(w.services.calls.find(c => c.op === "runApply")).toMatchObject({ version: B, wait: false });
    // rollback needs a machine with somewhere to go back to; the preview is read-only, and — with a restore —
    // the hub's word rides --typed (§11.4, review round 1), exactly as UPDATER_ARGS spells it
    const back = await world();
    await withPrevious(back);
    const seen = await back.run(UPDATER_ARGS.rollbackPreview);
    expect(seen.code, seen.err).toBe(0);
    expect(seen.err).not.toMatch(/usage:/);
    expect(RollbackPreviewSchema.parse(JSON.parse(seen.out))).toEqual({ from: A, to: "0.0.9", restores: [] });
    expect(back.services.calls.filter(c => c.op === "runApply")).toEqual([]);        // a preview starts nothing
    const rolled = await back.run(UPDATER_ARGS.rollback());
    expect(rolled.code, rolled.err).toBe(0);
    expect(rolled.err).not.toMatch(/usage:/);
    expect(back.services.calls.find(c => c.op === "runApply")).toMatchObject({ version: "rollback", wait: false });
    const restoring = await world();
    const backupAt = await withPrevious(restoring, { restoreFleet: true });
    const asked = await restoring.run(UPDATER_ARGS.rollbackPreview);
    expect(asked.code, asked.err).toBe(0);
    expect(RollbackPreviewSchema.parse(JSON.parse(asked.out))).toEqual({
      from: A, to: "0.0.9", restores: [{ db: "fleet", at: new Date(backupAt!).toISOString() }],
    });
    const withWord = await restoring.run(UPDATER_ARGS.rollback("rollback"));
    expect(withWord.code, withWord.err).toBe(0);
    expect(withWord.err).not.toMatch(/usage:/);
    expect(restoring.services.calls.filter(c => c.op === "runApply")).toMatchObject([{ version: "rollback", wait: false }]);
  }, 150_000);   // four worlds, each a signed feed and unpacked releases
});

describe("`morndo update tick` — the timer's own command (§6.1, §8.3)", () => {
  it("exits 0 and checks nothing when updates are disabled by switch or by mode", async () => {
    for (const env of [{ MORNDO_DISABLE_AUTOUPDATE: "1" }, { MORNDO_DISABLE_UPDATES: "1" }]) {
      const w = await world({ preStageB: true });
      const r = await w.run(["update", "tick"], env);
      expect(r.code, r.err).toBe(0);
      expect(w.feed.calls.channels, JSON.stringify(env)).toEqual([]);
    }
    const w = await world({ preStageB: true });
    w.writeConfig({ mode: "off" });
    const r = await w.run(["update", "tick"]);
    expect(r.code, r.err).toBe(0);
    expect(w.feed.calls.channels).toEqual([]);
  });

  it("in mode stage it checks and stages, and applies nothing", async () => {
    const w = await world();
    w.writeConfig({ mode: "stage" });
    w.artifacts.serve(w.b.name, { bytes: w.b.archive });
    const r = await w.run(["update", "tick"]);
    expect(r.code, r.err).toBe(0);
    expect(w.store.staged()?.version).toBe(B);
    expect(w.current()).toBe(A);                           // staged, not applied
    expect(w.services.tape).toEqual([]);
  });

  it("in mode apply it applies what stands staged, as the automatic walk: outside the window it defers with 75", async () => {
    const w = await world({ preStageB: true });
    // A window that excludes now and the minutes around it (start ten minutes ahead, four hours wide), so the
    // real clock cannot cross into it while the test runs. The walls are small because this CLI sleeps real
    // seconds: the poll that watches the window out is what ends the attempt.
    const minutes = new Date().getHours() * 60 + new Date().getMinutes();
    const hhmm = (n: number) => `${String(Math.floor((n % 1440) / 60)).padStart(2, "0")}:${String((n % 1440) % 60).padStart(2, "0")}`;
    w.writeConfig({ mode: "apply", window: `${hhmm(minutes + 10)}-${hhmm(minutes + 250)}` });
    const r = await w.run(["update", "tick"], {}, { timing: { drainMs: 400, pollMs: 5, healthMs: 500, probationMs: 5, holdAckMs: 200 } });
    expect(r.code, r.err).toBe(75);
    expect(r.err).toMatch(/window/);
    expect(w.current()).toBe(A);                           // deferred: nothing swapped, nothing stopped
    expect(w.services.tape.filter(t => t.startsWith("stop:"))).toEqual([]);
    expect(w.store.openUpdate()).toBeNull();               // the attempt ended, abandoned
  });
});

describe("`morndo update boot` — the boot apply (§6.7)", () => {
  it("skips, exit 0, when nothing stands staged", async () => {
    const w = await world({ offerB: false });              // the feed offers only what is current: up to date
    const r = await w.run(["update", "boot"]);
    expect(r.code, r.err).toBe(0);
    expect(w.current()).toBe(A);
  });

  it("skips on a machine that is not its own control plane, without asking the feed", async () => {
    const w = await world({ running: ["node"], preStageB: true });
    const r = await w.run(["update", "boot"]);
    expect(r.code, r.err).toBe(0);
    expect(w.feed.calls.channels).toEqual([]);
    expect(w.current()).toBe(A);
  });

  it("skips under a pin", async () => {
    const w = await world({ preStageB: true });
    w.writeConfig({ pin: A });
    const r = await w.run(["update", "boot"]);
    expect(r.code, r.err).toBe(0);
    expect(w.current()).toBe(A);
  });

  it("on the control plane it swaps while nothing runs, records `starting`, and leaves the judging to the recovery unit", async () => {
    const w = await world({ preStageB: true });
    const r = await w.run(["update", "boot"]);
    expect(r.code, r.err).toBe(0);
    expect(w.current()).toBe(B);                           // swapped
    const open = w.store.openUpdate();
    expect(open?.state).toBe("starting");                  // the record the recovery unit picks up (§6.6)
    expect(open?.mark).toBe("starting");
    expect(existsSync(join(w.paths.state, "applying"))).toBe(true);
    expect(w.services.tape.filter(t => t.startsWith("stop:"))).toEqual([]);   // nothing runs yet: nothing stops
    expect(w.services.tape.filter(t => t.startsWith("start:"))).toEqual([]);  // and nothing starts: the manager does that
  });
});

// The plan of the commit that put A here, in the case that matters to a rollback: it migrated the fleet
// database across a raised floor (RL8), so going back restores the Backup and drops the writes since.
const RESTORES_FLEET: Record<DatabaseName, MigrationStep> = {
  hub: { willMigrate: false, backupRequired: false, expectedSchema: SCHEMAS_A.hub.version, restoreOnRollback: false },
  fleet: { willMigrate: true, backupRequired: true, expectedSchema: SCHEMAS_A.fleet.version, restoreOnRollback: true },
  node: { willMigrate: false, backupRequired: false, expectedSchema: SCHEMAS_A.node.version, restoreOnRollback: false },
  connections: { willMigrate: false, backupRequired: false, expectedSchema: SCHEMAS_A.connections.version, restoreOnRollback: false },
};

// A machine with somewhere to go back to: 0.0.9 installed and linked as previous. With `restoreFleet`, the
// commit that put A here is on record with the plan above, and its fleet Backup sits on disk three hours old —
// the span §11.4's ask names. Answers the Backup's own moment, the `at` a preview must repeat.
const withPrevious = async (w: World, o: { restoreFleet?: boolean } = {}): Promise<number | null> => {
  const stale = versionFixture({ version: "0.0.9", schemas: SCHEMAS_A });
  const archive = join(w.home, "stale.tar.gz");
  writeFileSync(archive, stale.archive);
  const installer = new DirsInstaller({ releases: w.paths.releases });
  const unpacked = await installer.unpack(archive, stale.version, { filesSha256: stale.filesSha256, maxBytes: 1 << 20 });
  if (!unpacked.ok) throw new Error(`0.0.9 did not unpack: ${unpacked.reason}`);
  installer.promote(stale.version, { manifestSha256: stale.manifestSha256, filesSha256: stale.filesSha256, at: NOW });
  installer.swap({ current: A, previous: stale.version });
  if (o.restoreFleet !== true) return null;
  const backupAt = Date.now() - 3 * 3600_000;
  w.store.saveUpdate({
    id: "upd-commit", kind: "update", target: parseVersion(A)!, preUpdate: { current: parseVersion(stale.version)!, previous: null },
    state: "committed", mark: null, backups: [], migrations: RESTORES_FLEET,
    format: 1, startedAt: backupAt, doneMarks: [], judgeBaseline: null, backupOf: null, attempt: null,
  });
  const file = join(w.paths.state, "backups", "upd-commit", "fleet.db");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, "the fleet database as it was at the backup", { mode: 0o600 });
  utimesSync(file, new Date(backupAt), new Date(backupAt));
  return backupAt;
};

// The apply unit's whole work as a script, as `update`'s test scripts it: one rollback-kind record, ended.
const unitRollsBack = (w: World): void => {
    w.services.runApplyScript = async () => {
      const unit = openUpdateStore({ db: w.paths.db, lock: w.paths.lock });
      unit.saveUpdate({
        id: "upd-back", kind: "rollback", target: parseVersion("0.0.9")!, preUpdate: { current: parseVersion(A)!, previous: null },
        state: "rolled_back", mark: "rolling_back", backups: [], migrations: null,
        format: 1, startedAt: Date.now(), doneMarks: ["rolling_back"], judgeBaseline: null, backupOf: "upd-commit",
        attempt: null,
      });
      unit.close();
    };
  };

describe("`morndo update --rollback` — asks first on a preview, then its own unit (§8.1, §6.5, §11.4, §5)", () => {
  it("--rollback with a restore lists what it drops and needs the typed word", async () => {
    // no terminal and no --yes: a usage error, one sentence, and nothing started
    {
      const w = await world();
      await withPrevious(w, { restoreFleet: true });
      const r = await w.run(["update", "--rollback"]);
      expect(r.code, r.err).toBe(64);
      expect(r.err).toMatch(/--yes|terminal/i);
      expect(w.services.tape).toEqual([]);
    }
    // a terminal answering anything but the word: not rolled back, exit 0, no unit started — but the preview
    // said what a go-on would drop (§11.4: the span, per database)
    {
      const w = await world();
      await withPrevious(w, { restoreFleet: true });
      const r = await w.run(["update", "--rollback"], {}, { tty: true, answer: "y" });
      expect(r.out).toMatch(/Not rolled back\./);                // first: a "y" that went on would fail here
      expect(r.code, r.err).toBe(0);
      expect(r.out).toMatch(/Back to 0\.0\.9 from 0\.1\.0\./);
      expect(r.out).toMatch(/The fleet database goes back to its backup from \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(3 hours of writes since are dropped\)\./);
      expect(r.prompts.join("")).toMatch(/Type rollback to go on:/);
      expect(w.services.tape).toEqual([]);
    }
    // the word itself: the rollback runs in its own unit (§5), and the record it leaves is the answer
    {
      const w = await world();
      await withPrevious(w, { restoreFleet: true });
      unitRollsBack(w);
      const r = await w.run(["update", "--rollback"], {}, { tty: true, answer: "rollback" });
      expect(r.code, r.err).toBe(1);                        // the record's state decides the exit (§8.4)
      expect(w.services.calls.some(c => c.op === "runApply" && c.version === "rollback")).toBe(true);
      expect(r.out).toMatch(/Rolled back to 0\.0\.9/);
    }
  });

  it("--rollback without a restore asks the plain question, and --yes starts the unit at once", async () => {
    // nothing is restored (no commit on record owns a Backup): the ask is update's own [y/N], not the typed word
    {
      const w = await world();
      await withPrevious(w);
      unitRollsBack(w);
      const r = await w.run(["update", "--rollback"], {}, { tty: true, answer: "y" });
      expect(r.out).toMatch(/Back to 0\.0\.9 from 0\.1\.0; no database is restored\./);
      expect(r.prompts.join("")).toMatch(/\[y\/N\]/);
      expect(r.prompts.join("")).not.toMatch(/Type rollback/);
      expect(r.code, r.err).toBe(1);
      expect(w.services.calls.some(c => c.op === "runApply" && c.version === "rollback")).toBe(true);
    }
    // --yes is the whole ask: no terminal needed, the unit starts at once
    {
      const w = await world();
      await withPrevious(w);
      unitRollsBack(w);
      const r = await w.run(["update", "--rollback", "--yes"]);
      expect(r.code, r.err).toBe(1);
      expect(r.prompts).toEqual([]);
      expect(w.services.calls.some(c => c.op === "runApply" && c.version === "rollback")).toBe(true);
    }
  });

  it("--rollback --yes --detach starts the rollback unit and answers at once (PR 6c)", async () => {
    const w = await world();
    await withPrevious(w);
    const r = await w.run(["update", "--rollback", "--yes", "--detach"]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/[Ss]tarted/);
    expect(w.services.calls.find(c => c.op === "runApply")).toMatchObject({ version: "rollback", wait: false });
    expect(w.current()).toBe(A);                           // the unit, not this process, walks it back
    expect(w.services.tape.filter(t => t !== "runApply:rollback")).toEqual([]);
  });

  // The hub's read-only look (review round 1): what a rollback would drop, as one JSON object the hub parses, at
  // the same moment the human text prints — and nothing written, nothing started, whatever it says.
  it("--rollback --preview --json answers what a rollback would drop, and starts nothing", async () => {
    // with a restore: from, to, and each Backup's own moment as ISO text
    {
      const w = await world();
      const backupAt = await withPrevious(w, { restoreFleet: true });
      const r = await w.run(["update", "--rollback", "--preview", "--json"]);
      expect(r.code, r.err).toBe(0);
      expect(RollbackPreviewSchema.parse(JSON.parse(r.out))).toEqual({
        from: A, to: "0.0.9", restores: [{ db: "fleet", at: new Date(backupAt!).toISOString() }],
      });
      expect(w.services.tape).toEqual([]);
      expect(existsSync(join(w.paths.state, "rollback-confirmed"))).toBe(false);
    }
    // without a restore: the same object, no restores
    {
      const w = await world();
      await withPrevious(w);
      const r = await w.run(["update", "--rollback", "--preview", "--json"]);
      expect(r.code, r.err).toBe(0);
      expect(RollbackPreviewSchema.parse(JSON.parse(r.out))).toEqual({ from: A, to: "0.0.9", restores: [] });
      expect(w.services.tape).toEqual([]);
    }
    // the refusals are --rollback's own: with no previous Version there is nothing to preview either
    {
      const w = await world();
      const r = await w.run(["update", "--rollback", "--preview", "--json"]);
      expect(r.code, r.err).toBe(78);
      expect(r.err).toMatch(/no previous|nothing to roll back/i);
      expect(w.services.tape).toEqual([]);
    }
  }, 120_000);   // three worlds, each a signed feed and unpacked releases

  // §11.4's word, carried for the hub (review round 1): --yes answers the [y/N], never the typed word, so a
  // restore that drops writes refuses --yes alone and goes on only under the word itself.
  it("with a restore, --yes alone is refused and names what would be dropped; --typed rollback goes on", async () => {
    // --yes alone: 64, one sentence naming the drop and the way on, and nothing started
    {
      const w = await world();
      await withPrevious(w, { restoreFleet: true });
      const r = await w.run(["update", "--rollback", "--yes"]);
      expect(r.code, r.err).toBe(64);
      expect(r.err).toMatch(/fleet database.*backup.*dropped|backup from .* writes .*dropped/);
      expect(r.err).toMatch(/--typed rollback/);
      expect(w.services.tape).toEqual([]);
      expect(existsSync(join(w.paths.state, "rollback-confirmed"))).toBe(false);
    }
    // the word itself, under --yes: the hub's command goes on and starts the unit (PR 6c's --detach)
    {
      const w = await world();
      await withPrevious(w, { restoreFleet: true });
      const r = await w.run(["update", "--rollback", "--yes", "--detach", "--typed", "rollback"]);
      expect(r.code, r.err).toBe(0);
      expect(r.out).toMatch(/[Ss]tarted/);
      expect(w.services.calls.find(c => c.op === "runApply")).toMatchObject({ version: "rollback", wait: false });
    }
    // any other word is refused with its own sentence, not the usage text
    {
      const w = await world();
      await withPrevious(w, { restoreFleet: true });
      const r = await w.run(["update", "--rollback", "--yes", "--typed", "nope"]);
      expect(r.code, r.err).toBe(64);
      expect(r.err).not.toMatch(/usage:/);
      expect(r.err).toMatch(/--typed/);
      expect(w.services.tape).toEqual([]);
    }
    // --typed never rides without --yes: the ask it answers is not there
    {
      const w = await world();
      await withPrevious(w, { restoreFleet: true });
      const r = await w.run(["update", "--rollback", "--typed", "rollback"]);
      expect(r.code, r.err).toBe(64);
      expect(r.err).toMatch(/usage:/);
      expect(w.services.tape).toEqual([]);
    }
  }, 150_000);   // four worlds, each a signed feed and unpacked releases


  // The apply unit's own command is a command line anyone can type: the rollback it runs must be one --rollback asked
  // for and the principal confirmed (§11.4), never a way around that ask (review of 2026-10-22, HIGH).
  it("the apply unit refuses a rollback that --rollback did not confirm, and any Version not above the current one", async () => {
    const w = await world();
    await withPrevious(w);
    const direct = await w.run(["update", "apply", "--version", "rollback"]);
    expect(direct.code, direct.err).toBe(64);
    expect(direct.err).toMatch(/morndo update --rollback/);
    const older = await w.run(["update", "apply", "--version", "0.0.9"]);
    expect(older.code, older.err).toBe(64);
    expect(older.err).toMatch(/morndo update --rollback/);
    const same = await w.run(["update", "apply", "--version", A]);       // the running one is not above itself
    expect(same.code, same.err).toBe(64);
    expect(w.current()).toBe(A);
    expect(w.services.tape.filter(t => t.startsWith("stop:"))).toEqual([]);
  });

  it("the apply unit runs a rollback for the instance named rollback once --rollback confirmed it", async () => {
    const w = await world();
    await withPrevious(w);
    w.services.runApplyScript = async () => {};             // the unit is run by hand below, as systemd would
    expect((await w.run(["update", "--rollback", "--yes"])).prompts).toEqual([]);
    const r = await w.run(["update", "apply", "--version", "rollback"]);
    expect(r.code, r.err).toBe(1);
    expect(w.current()).toBe("0.0.9");
    expect(w.store.badVersions()).toContain(A);            // RL7: the Version left behind is never auto-installed here again
    expect(w.store.openUpdate()).toBeNull();
    expect(w.services.tape.filter(t => t.startsWith("stop:")).length).toBeGreaterThan(0);   // the real walk ran
  });

  it("a rollback unit that fails to start leaves no confirmation behind for a later start", async () => {
    const w = await world();
    await withPrevious(w);
    w.services.runApplyScript = async () => { throw new Error("Job for morndo-update-apply@rollback.service failed"); };
    const r = await w.run(["update", "--rollback", "--yes"]);
    expect(r.code, r.err).toBe(75);
    expect(existsSync(join(w.paths.state, "rollback-confirmed"))).toBe(false);
    const later = await w.run(["update", "apply", "--version", "rollback"]);
    expect(later.code, later.err).toBe(64);                 // no one confirmed this one
    expect(w.current()).toBe(A);
  });

  it("with no previous Version there is nothing to go back to: exit 78, nothing started", async () => {
    const w = await world({ preStageB: true });
    const r = await w.run(["update", "--rollback"]);
    expect(r.code, r.err).toBe(78);
    expect(r.err).toMatch(/no previous|nothing to roll back/i);
    expect(w.current()).toBe(A);
    expect(w.services.tape).toEqual([]);
  });
});

describe("`morndo update --status` — the last updates (§8.1)", () => {
  it("lists the last ten updates with their states and times", async () => {
    const w = await world();
    const store = openUpdateStore({ db: w.paths.db, lock: w.paths.lock });
    store.saveUpdate({
      id: "upd-1", kind: "update", target: parseVersion(B)!, preUpdate: { current: parseVersion(A)!, previous: null },
      state: "probation", mark: "starting", backups: [], migrations: null,
      format: 1, startedAt: NOW, doneMarks: ["swapping"], judgeBaseline: null, backupOf: null, attempt: null,
    });
    store.close();
    const r = await w.run(["update", "--status", "--json"]);
    expect(r.code, r.err).toBe(0);
    const status = UpdateStatusSchema.parse(JSON.parse(r.out));
    expect(status.updates?.[0]).toMatchObject({ id: "upd-1", target: B, state: "probation" });
    const text = await w.run(["update", "--status"]);
    expect(text.out).toMatch(/probation/);
  });
});
