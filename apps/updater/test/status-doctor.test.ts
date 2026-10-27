// `morndo update --status` and `morndo doctor` (design §8.1): what a principal reads. The status is the protocol's
// own shape — readStatus builds it from the ports and validates it through UpdateStatusSchema, so the hub and the
// web app can rely on every word; formatStatus renders the same words for a terminal. The doctor re-asks the machine
// what it believes: the installed tree against its signed file list, the layout's links, the provenance of the
// current Version, the Key set's expiry (the 30-day horizon of the update_keys_expiring Alert, §12), the Feed's
// freshness, and the free space. The units, lingering and tmux placement checks belong to the apply step, not here.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVersion } from "@morndo/domain";
import { UpdateStatusSchema } from "@morndo/protocol";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CheckService, CHECKOUT_SENTENCE } from "../src/application/check-service.ts";
import { doctor, type DoctorReport } from "../src/application/doctor-service.ts";
import { formatStatus, readStatus } from "../src/application/status-service.ts";
import { SshSigVerifier } from "../src/adapters/verifier-sshsig.ts";
import { openUpdateStore } from "../src/adapters/store-sqlite.ts";
import {
  FakeArtifacts, FakeClock, FakeFeed, FakeFleetView, FakeInstaller, FakeSettings, FakeStateSink, FakeStore, wipe,
} from "./helpers/fakes.ts";
import { feedFixture, keySetDocument, makeKeys, manifestSignature, releaseFixture, signed, type Keys, type ReleaseFixture } from "./helpers/release-fixtures.ts";

const NOW = 1_761_000_000_000;              // 2025-10-21T09:20:00Z, the same moment the check tests stand at
const YEAR = 365 * 24 * 3600_000;
const DAY = 24 * 3600_000;
const OFFERED = "0.2.0";

let scratch = "";
let made = 0;

beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), "morndo-upd-")); });
afterAll(() => { wipe(scratch); });

type World = {
  keys: Keys;
  ks1: ReturnType<typeof keySetDocument>;
  rel: ReleaseFixture;
  installer: FakeInstaller;
  store: FakeStore;
  settings: FakeSettings;
  clock: FakeClock;
  /** Resolved once a `manual` world's hand-staged Version is promoted; the real check needs no waiting. */
  ready: Promise<void>;
  check: () => Promise<unknown>;
  doctor: () => Promise<DoctorReport>;
};

// A machine that just staged an offer — the check run for real, so layout, store and installer agree — bent by each
// case in exactly one way. `manual` stages by hand instead (a store the check would never write, or not write) and
// trusts nothing: `fresh` adds the trust and check row a healthy machine has, so what a case leaves out is exactly
// what its finding should name.
const fresh = (w: World): void => {
  w.store.saveTrust({ keySet: w.ks1.decoded, highestFeedSeq: { stable: 0, latest: 0 } });
  w.store.recordCheck({ at: NOW, channel: "stable", outcome: "staged", detail: "manual", version: OFFERED, feedSeq: 1, feedExpiresAt: NOW + 14 * DAY });
};

const build = (bend: (w: World) => void = () => {}, o: { manual?: boolean } = {}): World => {
  const keys = makeKeys();
  const ks1 = keySetDocument(keys, { version: 1, expiresAt: NOW + YEAR });
  const rel = releaseFixture({ version: OFFERED, now: NOW });
  const feed = feedFixture(keys, [rel], { channel: "stable", now: NOW });
  made += 1;
  const fakeFeed = new FakeFeed();
  fakeFeed.keySets.set(1, signed(ks1.bytes, ks1.sig));
  fakeFeed.channels.set("stable", feed.served);
  fakeFeed.manifests.set(rel.manifestUrl, signed(rel.manifestBytes, manifestSignature(keys, rel)));
  const installer = new FakeInstaller(join(scratch, `releases-${made}`));
  installer.shipped = ks1.bytes;
  const artifacts = new FakeArtifacts(join(scratch, `downloads-${made}`));
  artifacts.serve(rel.name, { bytes: rel.archive });
  const store = new FakeStore();
  const settings = new FakeSettings();
  const clock = new FakeClock(NOW);
  const service = new CheckService({
    feed: fakeFeed, artifacts, verifier: new SshSigVerifier(), installer, store, settings, clock,
    platform: rel.platform, switches: { disableUpdates: false },
    fleet: new FakeFleetView(), state: new FakeStateSink(),
  });
  const world: World = {
    keys, ks1, rel, installer, store, settings, clock, ready: Promise.resolve(),
    check: () => service.check(),
    doctor: () => doctor({ installer, store, clock }),
  };
  if (o.manual === true) {
    const archive = join(scratch, `manual-${made}.tgz`);
    writeFileSync(archive, rel.archive);
    world.ready = (async () => {
      const done = await installer.unpack(archive, OFFERED, { filesSha256: rel.filesSha256, maxBytes: 16 * rel.archive.length });
      if (!done.ok) throw new Error(done.reason);
      installer.promote(OFFERED, { manifestSha256: rel.manifestSha256, filesSha256: rel.filesSha256, at: NOW });
      store.recordStaged({ version: OFFERED, manifestSha256: rel.manifestSha256, filesSha256: rel.filesSha256, at: NOW, manifest: rel.manifestText });
    })();
    installer.layoutState = { method: "updater", current: OFFERED, previous: null, good: null };
    fresh(world);
  }
  bend(world);
  return world;
};

// The files of a promoted Version are read-only (§5); a test that rewrites one gives the write bit back first.
const rewrite = (path: string, text: string): void => {
  chmodSync(path, 0o644);
  writeFileSync(path, text);
  chmodSync(path, 0o444);
};

describe("readStatus (§8.1)", () => {
  it("after a staged check the status is the protocol's own shape, word for word", async () => {
    const w = build();
    await w.check();
    const status = readStatus({ installer: w.installer, store: w.store, settings: w.settings });
    expect(UpdateStatusSchema.parse(status)).toEqual(status);      // it validates, and parse changes nothing
    expect(status).toMatchObject({
      installMethod: "updater", channel: "stable", mode: "apply", pin: null, window: null,
      current: "0.1.0", previous: null, good: null, staged: OFFERED,
      feed: { channel: "stable", seq: 1, expiresAt: new Date(NOW + 14 * DAY).toISOString() },
      keySet: { version: 1, expiresAt: new Date(NOW + YEAR).toISOString() },
      lastCheck: { outcome: "staged", version: OFFERED },
    });
    expect(status.checks).toHaveLength(1);
  });

  it("a machine that has never checked says so: no feed, no key set, no checks, nothing staged", () => {
    const w = build();
    const status = readStatus({ installer: w.installer, store: w.store, settings: w.settings });
    expect(UpdateStatusSchema.parse(status)).toEqual(status);
    expect(status).toMatchObject({ current: "0.1.0", staged: null, feed: null, keySet: null, lastCheck: null });
    expect(status.checks).toEqual([]);
  });

  it("the settings' own words come through: a pin, and a window as local hours", () => {
    const w = build(w => {
      w.settings.value = { ...w.settings.value, pin: parseVersion("0.1.0"), window: { start: 120, end: 360 } };
    });
    const status = readStatus({ installer: w.installer, store: w.store, settings: w.settings });
    expect(status.pin).toBe("0.1.0");
    expect(status.window).toBe("02:00-06:00");                     // §8.3's own example, as minutes of the day
  });

  it("the ten newest checks, newest first, and the feed row from the newest check that has one", () => {
    const w = build();
    for (let n = 1; n <= 12; n++) {
      w.store.recordCheck({ at: NOW + n * 60_000, channel: "stable", outcome: "staged", detail: `check ${n}`, version: OFFERED, feedSeq: n, feedExpiresAt: NOW + 14 * DAY });
    }
    const status = readStatus({ installer: w.installer, store: w.store, settings: w.settings });
    expect(status.checks).toHaveLength(10);
    expect(status.checks[0]!.detail).toBe("check 12");
    expect(status.checks[9]!.detail).toBe("check 3");
    expect(status.lastCheck!.detail).toBe("check 12");
    expect(status.feed!.seq).toBe(12);
  });

  it("a refusal longer than the wire's cap never breaks --status: the detail is clipped to what it can carry", () => {
    const w = build();
    // A row a store older than this code may have written: any length at all (an unpack reason naming a long path).
    w.store.recordCheck({ at: NOW, channel: "stable", outcome: "refused", detail: "u".repeat(2_000), version: null, feedSeq: null, feedExpiresAt: null });
    const status = readStatus({ installer: w.installer, store: w.store, settings: w.settings });
    expect(UpdateStatusSchema.parse(status)).toEqual(status);      // the wire's own shape, whatever the store holds
    expect(status.lastCheck!.detail.length).toBeLessThanOrEqual(500);
    expect(status.checks[0]!.detail).toBe(`${"u".repeat(499)}…`);  // the start kept, the cut marked
  });
});

describe("formatStatus (§8.1)", () => {
  it("renders the words a principal needs on a terminal, one fact per line", async () => {
    const w = build();
    await w.check();
    const text = formatStatus(readStatus({ installer: w.installer, store: w.store, settings: w.settings }));
    for (const word of ["channel: stable", "current: 0.1.0", `staged: ${OFFERED}`, "feed: stable 1", "key set: 1"]) {
      expect(text).toContain(word);
    }
  });
});

describe("doctor (§8.1)", () => {
  it("a clean install has no findings", async () => {
    const w = build(undefined, { manual: true });                  // current 0.2.0, staged and recorded by the updater
    await w.ready;
    w.installer.freeBytesValue = 123_456;
    expect(await w.doctor()).toEqual({ ok: true, findings: [], freeBytes: 123_456 });
  });

  it("an install the updater did not make is one finding, and the doctor stops there", async () => {
    const w = build(w => {
      w.installer.layoutState = { method: "checkout", current: "0.3.0", previous: null, good: null };
    });
    expect(await w.doctor()).toEqual({
      ok: false,
      findings: [{ area: "install", detail: CHECKOUT_SENTENCE }],
      freeBytes: w.installer.freeBytesValue,
    });
  });

  it("a changed file in the current tree is a tree finding naming the file", async () => {
    const w = build(undefined, { manual: true });
    await w.ready;
    rewrite(join(w.installer.dir, OFFERED, "README.md"), "not what was signed\n");
    const report = await w.doctor();
    expect(report.ok).toBe(false);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]!.area).toBe("tree");
    expect(report.findings[0]!.detail).toContain("README.md");
  });

  it("a current Version with no record of its own is a provenance finding", async () => {
    const w = build(undefined, { manual: true });
    await w.ready;
    w.store.versions.clear();               // after the staging: the store forgets, the tree stays
    const report = await w.doctor();
    expect(report.findings).toEqual([{ area: "provenance", detail: expect.stringContaining(OFFERED) }]);
    expect(report.ok).toBe(false);
  });

  // A first install writes install.json with no manifest (`morndo install` verified none itself) and commits the Version;
  // that pair, and only that pair, stands in for the staged record an update leaves.
  const asFirstInstall = (w: World): void => {
    const record = join(w.installer.dir, OFFERED, "install.json");
    rewrite(record, `${JSON.stringify({ method: "updater", installedAt: "2026-10-27T00:00:00Z", manifestSha256: null, filesSha256: "a".repeat(64) })}\n`);
  };

  it("a first install's Version (install.json names no manifest, and the store committed it) is not a provenance finding", async () => {
    const w = build(undefined, { manual: true });
    await w.ready;
    w.store.versions.clear();
    asFirstInstall(w);
    w.store.recordCommitted(OFFERED, NOW, null);
    const report = await w.doctor();
    expect(report.findings.filter(f => f.area === "provenance")).toEqual([]);
  });

  it("a Version an update staged, with its versions rows gone but still committed, is a provenance finding", async () => {
    const w = build(undefined, { manual: true });
    await w.ready;
    w.store.versions.clear();               // install.json still names the manifest the update staged
    w.store.recordCommitted(OFFERED, NOW, null);
    const report = await w.doctor();
    expect(report.findings.filter(f => f.area === "provenance")).toEqual([{ area: "provenance", detail: expect.stringContaining(OFFERED) }]);
  });

  it("a first install's record without the store's commit is a provenance finding", async () => {
    const w = build(undefined, { manual: true });
    await w.ready;
    w.store.versions.clear();
    asFirstInstall(w);
    const report = await w.doctor();
    expect(report.findings.filter(f => f.area === "provenance")).toHaveLength(1);
  });

  it("an expired key set, and one inside the Alert's 30 days, are keys findings", async () => {
    const expired = build(w => {
      w.store.saveTrust({ keySet: keySetDocument(w.keys, { version: 1, expiresAt: NOW - 1 }).decoded, highestFeedSeq: { stable: 1, latest: 0 } });
    }, { manual: true });
    await expired.ready;
    const report = await expired.doctor();
    expect(report.findings.map(f => f.area)).toEqual(["keys"]);    // everything else about this machine is healthy
    expect(report.findings[0]!.detail).toMatch(/expired/);

    const soon = build(w => {
      w.store.saveTrust({ keySet: keySetDocument(w.keys, { version: 1, expiresAt: NOW + 20 * DAY }).decoded, highestFeedSeq: { stable: 1, latest: 0 } });
    }, { manual: true });
    await soon.ready;
    const soonReport = await soon.doctor();
    expect(soonReport.findings.map(f => f.area)).toEqual(["keys"]);
    expect(soonReport.findings[0]!.detail).toMatch(/expire/);
  });

  it("a feed nobody has verified, and one whose word has expired, are feed findings", async () => {
    const never = build(w => { w.store.checkLog.length = 0; }, { manual: true });
    await never.ready;
    const report = await never.doctor();
    expect(report.findings.map(f => f.area)).toEqual(["feed"]);
    expect(report.findings[0]!.detail).toMatch(/never/);

    const stale = build(w => { w.store.checkLog.length = 0; }, { manual: true });
    await stale.ready;
    stale.store.recordCheck({ at: NOW - 20 * DAY, channel: "stable", outcome: "staged", detail: "old", version: OFFERED, feedSeq: 1, feedExpiresAt: NOW - 6 * DAY });
    const staleReport = await stale.doctor();
    expect(staleReport.findings.map(f => f.area)).toEqual(["feed"]);
    expect(staleReport.findings[0]!.detail).toMatch(/expired/);
  });

  it("the feed's word survives twelve refusals in a row: the status shows it and the doctor stays quiet", async () => {
    const w = build(undefined, { manual: true });
    await w.ready;                            // fresh() wrote the one good check: the feed's word, still current
    for (let n = 1; n <= 12; n++) {
      w.store.recordCheck({ at: NOW + n * 60_000, channel: "stable", outcome: "refused", detail: `file_list: refused ${n}`, version: null, feedSeq: null, feedExpiresAt: null });
    }
    const status = readStatus({ installer: w.installer, store: w.store, settings: w.settings });
    expect(status.feed).toEqual({ channel: "stable", seq: 1, expiresAt: new Date(NOW + 14 * DAY).toISOString() });
    const report = await w.doctor();
    expect(report.findings.filter(f => f.area === "feed")).toEqual([]);   // a refusal is not the feed's word going quiet
  });

  it("the feed's word outlives the kept check rows of the real store: the status shows it, the doctor stays quiet", async () => {
    // The real SQLite store, not the fake: a healthy machine's state in it, then a hundred and one refusals without
    // the feed's word — past the hundred rows the store keeps — must not read as a feed nobody ever verified.
    const w = build(undefined, { manual: true });
    await w.ready;
    const state = join(scratch, "state-last-feed");
    const store = openUpdateStore({ db: join(state, "update.db"), lock: join(state, "apply.lock") });
    try {
      store.saveTrust({ keySet: w.ks1.decoded, highestFeedSeq: { stable: 1, latest: 0 } });
      store.recordStaged({ version: OFFERED, manifestSha256: w.rel.manifestSha256, filesSha256: w.rel.filesSha256, at: NOW, manifest: w.rel.manifestText });
      store.recordCheck({ at: NOW, channel: "stable", outcome: "staged", detail: "manual", version: OFFERED, feedSeq: 1, feedExpiresAt: NOW + 14 * DAY });
      for (let n = 1; n <= 101; n++) {
        store.recordCheck({ at: NOW + n * 60_000, channel: "stable", outcome: "refused", detail: `file_list: refused ${n}`, version: null, feedSeq: null, feedExpiresAt: null });
      }
      const status = readStatus({ installer: w.installer, store, settings: w.settings });
      expect(status.feed).toEqual({ channel: "stable", seq: 1, expiresAt: new Date(NOW + 14 * DAY).toISOString() });
      const report = await doctor({ installer: w.installer, store, clock: w.clock });
      expect(report.findings.filter(f => f.area === "feed")).toEqual([]);   // the word is still current, not gone
    } finally {
      store.close();
    }
  });

  it("a previous link to a Version that is not installed is a layout finding", async () => {
    const w = build(w => {
      w.installer.layoutState = { method: "updater", current: OFFERED, previous: "0.1.0", good: null };
    }, { manual: true });
    await w.ready;
    const report = await w.doctor();
    expect(report.findings).toEqual([{ area: "layout", detail: expect.stringContaining("previous 0.1.0") }]);
    expect(report.ok).toBe(false);
  });
});
