// `morndo update` and the units' own commands (design §6.1, §6.7, §8.1, §8.3, §8.4): what the composition root
// answers when a person, a timer or a boot asks. The world is a real install over a throwaway HOME — the real
// installer, the real store, the real databases — with the machine's services and probes faked and injected
// through runUpdater's deps override (a test-only door; production detects systemd or launchd and probes the
// machine's own doors). The feed is faked the same way with the fixtures' own signed documents, so the tick's
// check stages from a feed the test signed, and the apply that follows is the real walk on the real machine
// files with nothing of the machine itself running.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { writeFloor } from "@morndo/service-kit";
import { parseVersion, type UpdateService } from "@morndo/domain";
import { UpdateStatusSchema } from "@morndo/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ApplyTiming } from "../src/application/apply-steps.ts";
import { DirsInstaller } from "../src/adapters/installer-dirs.ts";
import { databasePaths, updaterPaths } from "../src/adapters/paths.ts";
import { openUpdateStore, SqliteUpdateStore } from "../src/adapters/store-sqlite.ts";
import { runUpdater } from "../src/cli.ts";
import {
  Die, FakeProbe, FakeServices, NOW, A, B, SCHEMAS_A, versionFixture,
} from "./helpers/apply-fakes.ts";
import { FakeArtifacts, FakeFeed, wipe } from "./helpers/fakes.ts";
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
  keys: Keys;
  b: ReleaseFixture;
  /** Also installs and stages B, as a check that already ran would have left the machine. */
  stageB(): Promise<void>;
  /** Writes the settings file (its directory with it), as a principal or the install would. */
  writeConfig(doc: unknown): void;
  current(): string | null;
  run(argv: string[], env?: Record<string, string | undefined>, o?: { timing?: Partial<ApplyTiming> }): Promise<{ code: number; out: string; err: string }>;
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
  const writeConfig = (doc: unknown): void => {
    mkdirSync(dirname(paths.config), { recursive: true, mode: 0o700 });
    writeFileSync(paths.config, `${JSON.stringify(doc)}\n`);
  };
  const w: World = {
    home, paths, store, services, probe, feed, artifacts, keys, b,
    stageB: async () => {
      await install(b);
      store.recordStaged({ version: b.version, manifestSha256: b.manifestSha256, filesSha256: b.filesSha256, at: NOW - 1000, manifest: b.manifestText });
    },
    current: () => installer.layout().current,
    run: async (argv, env = {}, opts = {}) => {
      const out: string[] = [], err: string[] = [];
      const code = await runUpdater(argv, { HOME: home, PATH: process.env.PATH, ...env }, {
        out: s => out.push(s), err: s => err.push(s),
      }, {
        services, probe, feed, artifacts,
        ...(opts.timing ? { timing: opts.timing } : {}),
      });
      return { code, out: out.join(""), err: err.join("") };
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
          format: 1, startedAt: Date.now(), doneMarks: [], judgeBaseline: null, backupOf: null,
        });
        unit.finishUpdate("upd-unit", state, Date.now());
        unit.close();
      };
      const r = await w.run(["update", "--yes"]);
      expect(r.code, `${state}: ${r.err}`).toBe(code);
      expect(w.services.calls.some(c => c.op === "runApply" && c.version === B), state).toBe(true);
      expect(applyNowFile, state).toBe(false);             // no --now: the file is never written
    }
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

  it("`update apply` refuses a version that is not the one staged, and applies nothing", async () => {
    const w = await world({ preStageB: true });
    const r = await w.run(["update", "apply", "--version", "9.9.9"]);
    expect(r.code, r.err).toBe(75);
    expect(r.err).toMatch(/staged version changed/);
    expect(w.services.tape).toEqual([]);
    expect(w.current()).toBe(A);
  });
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

describe("`morndo update --rollback` — the principal's rollback (§8.1, §6.5)", () => {
  it("with a previous Version it goes back, records the left one bad here, and exits 1", async () => {
    const w = await world({ preStageB: true });
    // Roll back the running A to an installed earlier Version, as a machine with a history would.
    const stale = versionFixture({ version: "0.0.9", schemas: SCHEMAS_A });
    const archive = join(w.home, "stale.tar.gz");
    writeFileSync(archive, stale.archive);
    const installer = new DirsInstaller({ releases: w.paths.releases });
    const unpacked = await installer.unpack(archive, stale.version, { filesSha256: stale.filesSha256, maxBytes: 1 << 20 });
    expect(unpacked.ok).toBe(true);
    installer.promote(stale.version, { manifestSha256: stale.manifestSha256, filesSha256: stale.filesSha256, at: NOW });
    installer.swap({ current: A, previous: stale.version });
    const r = await w.run(["update", "--rollback"]);
    expect(r.code, r.err).toBe(1);
    expect(w.current()).toBe(stale.version);
    expect(w.store.badVersions()).toContain(A);            // RL7: the Version left behind is never auto-installed here again
    expect(w.store.openUpdate()).toBeNull();
    expect(r.out + r.err).toMatch(new RegExp(stale.version));
  });

  it("with no previous Version there is nothing to go back to: exit 78", async () => {
    const w = await world({ preStageB: true });
    const r = await w.run(["update", "--rollback"]);
    expect(r.code, r.err).toBe(78);
    expect(r.err).toMatch(/no previous|nothing to roll back/i);
    expect(w.current()).toBe(A);
  });
});

describe("`morndo update --status` — the last updates (§8.1)", () => {
  it("lists the last ten updates with their states and times", async () => {
    const w = await world();
    const store = openUpdateStore({ db: w.paths.db, lock: w.paths.lock });
    store.saveUpdate({
      id: "upd-1", kind: "update", target: parseVersion(B)!, preUpdate: { current: parseVersion(A)!, previous: null },
      state: "probation", mark: "starting", backups: [], migrations: null,
      format: 1, startedAt: NOW, doneMarks: ["swapping"], judgeBaseline: null, backupOf: null,
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
