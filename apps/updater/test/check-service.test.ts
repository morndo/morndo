// The check-and-stage service's contract (design §6.1, §10.2, §13 fault injection): the whole verification chain
// against fake ports and real signatures — the verifier from step 1, the unpacker from step 2 — so every refusal is
// the chain's own word, not a mock's. Each case bends exactly one thing and asserts three: the outcome, that nothing
// is left (no staging directory, no promoted Version, no download), and what the store recorded.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseVersion } from "@morndo/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CheckService } from "../src/application/check-service.ts";
import { FEED_NAMESPACE, RELEASE_NAMESPACE } from "../src/application/namespaces.ts";
import { FetchFailed, type StagedRecord } from "../src/application/ports.ts";
import { SshSigVerifier } from "../src/adapters/verifier-sshsig.ts";
import {
  FakeArtifacts, FakeClock, FakeFeed, FakeFleetView, FakeInstaller, FakeSettings, FakeStateSink, FakeStore, wipe,
} from "./helpers/fakes.ts";
import {
  doctoredFeed, feedFixture, keySetDocument, makeKeys, makeSigningKey, manifestSignature, packWithList,
  releaseFixture, sha256hex, signed, type Keys, type ReleaseFixture,
} from "./helpers/release-fixtures.ts";
import { canonicalJson } from "../../../scripts/release/json.ts";

const NOW = 1_761_000_000_000;              // 2025-10-21T09:20:00Z: a whole second, as the signed documents write
const YEAR = 365 * 24 * 3600_000;
const OFFERED = "0.2.0";                    // the Version every standard world offers over current 0.1.0

let scratch = "";
let made = 0;

beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), "morndo-upd-")); });
afterAll(() => { wipe(scratch); });

type World = {
  keys: Keys;
  ks1: ReturnType<typeof keySetDocument>;   // key set v1, the shipped anchor
  rel: ReleaseFixture;                      // the offered Release: archive, file list and manifest consistent
  feedText: string;                         // the standard feed's text, for the doctored cases
  feed: FakeFeed;
  artifacts: FakeArtifacts;
  installer: FakeInstaller;
  store: FakeStore;
  settings: FakeSettings;
  clock: FakeClock;
  fleet: FakeFleetView;
  state: FakeStateSink;
  service: CheckService;
};

// A standard world — current 0.1.0, a signed key set v1 (the shipped anchor), a stable feed offering 0.2.0, the
// artifact and manifest served and signed by the right keys — bent by each case in exactly one way.
const build = (bend: (w: World) => void = () => {}, o: { disableUpdates?: boolean; makeRelease?: () => ReleaseFixture } = {}): World => {
  const keys = makeKeys();
  const ks1 = keySetDocument(keys, { version: 1, expiresAt: NOW + YEAR });
  const rel = (o.makeRelease ?? (() => releaseFixture({ version: OFFERED, now: NOW })))();
  const feed = feedFixture(keys, [rel], { channel: "stable", now: NOW });
  made += 1;
  const fakeFeed = new FakeFeed();
  fakeFeed.keySets.set(1, signed(ks1.bytes, ks1.sig));
  fakeFeed.channels.set("stable", feed.served);
  fakeFeed.manifests.set(rel.manifestUrl, signed(rel.manifestBytes, manifestSignature(keys, rel)));
  const installer = new FakeInstaller(join(scratch, `releases-${made}`));
  installer.shipped = ks1.bytes;            // trust/keys.json inside current: the anchor when the store is empty
  const artifacts = new FakeArtifacts(join(scratch, `downloads-${made}`));
  artifacts.serve(rel.name, { bytes: rel.archive });
  const store = new FakeStore();
  const settings = new FakeSettings();
  const clock = new FakeClock(NOW);
  const fleet = new FakeFleetView();
  const state = new FakeStateSink();
  const world: World = {
    keys, ks1, rel, feedText: feed.text, feed: fakeFeed, artifacts, installer, store, settings, clock,
    fleet, state,
    service: new CheckService({
      feed: fakeFeed, artifacts, verifier: new SshSigVerifier(), installer, store, settings, clock,
      platform: rel.platform, switches: { disableUpdates: o.disableUpdates ?? false },
      fleet, state,
    }),
  };
  bend(world);
  return world;
};

// Nothing is left (§13: a failed staging leaves nothing): no promoted Version, no .staging-*, no download.
const nothingLeft = (w: World, version = OFFERED): void => {
  expect(w.installer.has(version), "promoted").toBe(false);
  expect(readdirSync(w.installer.dir).filter(name => name.startsWith(".staging-")), "staging").toEqual([]);
  expect(w.artifacts.downloads(), "downloads").toEqual([]);
};

// The newest check row: its outcome, its detail naming the step it refused at, and the Version it was about.
const recorded = (w: World, outcome: string, step: string | null, version: string | null): void => {
  const row = w.store.checks(1)[0];
  expect(row, "a check was recorded").toBeDefined();
  expect(row).toMatchObject({ outcome, version, channel: "stable" });
  if (step !== null) expect(row!.detail, "the detail names the step").toMatch(new RegExp(`^${step}:`));
};

describe("the check service (§6.1, §10.2)", () => {
  it("the fixture signer writes the format ssh-keygen verifies", () => {
    // The fixtures sign with node:crypto; one cross-check against the real tool keeps them honest (§10.1).
    const key = makeSigningKey();
    const message = Buffer.from("fixture signer cross-check\n");
    writeFileSync(join(scratch, "cross.txt"), message);
    writeFileSync(join(scratch, "cross.txt.sig"), key.signature(message, RELEASE_NAMESPACE));
    writeFileSync(join(scratch, "cross-signers"), `signer namespaces="${RELEASE_NAMESPACE}" ${key.publicLine}\n`);
    const done = spawnSync("ssh-keygen", [
      "-Y", "verify", "-f", join(scratch, "cross-signers"), "-I", "signer", "-n", RELEASE_NAMESPACE,
      "-s", join(scratch, "cross.txt.sig"),
    ], { input: message, encoding: "utf8" });
    expect(done.status, done.stderr).toBe(0);
  });

  it("stages a verified release, records it, and raises the feed number; a second check fetches nothing", async () => {
    const w = build();
    const out = await w.service.check();
    expect(out).toEqual({ kind: "staged", version: OFFERED, already: false });
    expect(w.installer.has(OFFERED)).toBe(true);                    // .staging-0.2.0 became 0.2.0/
    expect(w.artifacts.downloads()).toEqual([]);                    // the download went after the promotion
    expect(w.store.versionRecord(OFFERED)).toMatchObject({ filesSha256: w.rel.filesSha256, manifestSha256: w.rel.manifestSha256 });
    expect(w.store.manifestOf(OFFERED)).toBe(w.rel.manifestText);     // the verified Manifest's own text, for the apply
    expect(w.store.trust().highestFeedSeq).toEqual({ stable: 1, latest: 0 });
    expect(w.store.trust().keySet?.version).toBe(1);                // the shipped anchor, now the store's own
    recorded(w, "staged", null, OFFERED);
    expect(w.store.checks(1)[0]!.feedSeq).toBe(1);
    expect(w.store.checks(1)[0]!.feedExpiresAt).toBe(NOW + 14 * 24 * 3600_000);

    const fetchesBefore = w.feed.calls.manifests.length;
    const downloadsBefore = w.artifacts.calls.length;
    const again = await w.service.check();
    expect(again).toEqual({ kind: "staged", version: OFFERED, already: true });
    expect(w.feed.calls.manifests.length).toBe(fetchesBefore);      // nothing fetched: it is already staged
    expect(w.artifacts.calls.length).toBe(downloadsBefore);
  });

  // ---- RL1: a bad signature names its step and stages nothing

  it("a feed signed by an unknown key is refused at feed_signature", async () => {
    const w = build(w => {
      const bytes = Buffer.from(w.feedText);
      w.feed.channels.set("stable", signed(bytes, w.keys.other.signature(bytes, FEED_NAMESPACE)));
    });
    expect(await w.service.check()).toMatchObject({ kind: "refused", step: "feed_signature" });
    nothingLeft(w);
    recorded(w, "refused", "feed_signature", null);
  });

  it("a feed signed by the feed key under the release namespace is refused at feed_namespace", async () => {
    const w = build(w => {
      const bytes = Buffer.from(w.feedText);
      w.feed.channels.set("stable", signed(bytes, w.keys.feed.signature(bytes, RELEASE_NAMESPACE)));
    });
    expect(await w.service.check()).toMatchObject({ kind: "refused", step: "feed_namespace" });
    nothingLeft(w);
    recorded(w, "refused", "feed_namespace", null);
  });

  it("a feed signed by the release key is refused at feed_signature", async () => {
    const w = build(w => {
      const bytes = Buffer.from(w.feedText);
      w.feed.channels.set("stable", signed(bytes, w.keys.release.signature(bytes, FEED_NAMESPACE)));
    });
    expect(await w.service.check()).toMatchObject({ kind: "refused", step: "feed_signature" });
    nothingLeft(w);
  });

  it("a manifest signed by the feed key is refused at manifest_signature", async () => {
    const w = build(w => {
      w.feed.manifests.set(w.rel.manifestUrl,
        signed(w.rel.manifestBytes, w.keys.feed.signature(w.rel.manifestBytes, RELEASE_NAMESPACE)));
    });
    expect(await w.service.check()).toMatchObject({ kind: "refused", step: "manifest_signature" });
    nothingLeft(w);
    recorded(w, "refused", "manifest_signature", OFFERED);
  });

  it("a manifest signed by the release key under the feed namespace is refused at manifest_namespace", async () => {
    const w = build(w => {
      w.feed.manifests.set(w.rel.manifestUrl,
        signed(w.rel.manifestBytes, w.keys.release.signature(w.rel.manifestBytes, FEED_NAMESPACE)));
    });
    expect(await w.service.check()).toMatchObject({ kind: "refused", step: "manifest_namespace" });
    nothingLeft(w);
    recorded(w, "refused", "manifest_namespace", OFFERED);
  });

  // ---- RL1: the downloads are pinned to the feed entry and the manifest

  it("an artifact cut one byte short is refused at artifact_size", async () => {
    const w = build(w => w.artifacts.serve(w.rel.name, { bytes: w.rel.archive, cutAt: w.rel.archive.length - 1 }));
    expect(await w.service.check()).toMatchObject({ kind: "refused", step: "artifact_size" });
    nothingLeft(w);
    recorded(w, "refused", "artifact_size", OFFERED);
  });

  it("an artifact over its size is stopped at the cap and refused at artifact_size", async () => {
    const w = build(w => w.artifacts.serve(w.rel.name, { bytes: w.rel.archive, extra: 1 }));
    expect(await w.service.check()).toMatchObject({ kind: "refused", step: "artifact_size" });
    const fetch = w.artifacts.calls.at(-1)!;
    expect(fetch.maxBytes).toBe(w.rel.archive.length);              // the cap the manifest's size set
    expect(fetch.size).toBe(w.rel.archive.length);                  // and the fake wrote no further than it
    expect(fetch.overLimit).toBe(true);
    nothingLeft(w);
  });

  it("an artifact of the right size and the wrong digest is refused at artifact_digest", async () => {
    const w = build(w => {
      const flipped = Buffer.from(w.rel.archive);                   // same length, one byte different
      flipped[flipped.length - 1]! ^= 1;
      w.artifacts.serve(w.rel.name, { bytes: flipped });
    });
    expect(await w.service.check()).toMatchObject({ kind: "refused", step: "artifact_digest" });
    nothingLeft(w);
    recorded(w, "refused", "artifact_digest", OFFERED);
  });

  it("a release whose artifact name carries '+' (a Version's build metadata) stages", async () => {
    // The wire's own name rule admits '+' (the pipeline folds build metadata into the name); the download
    // directory's rule is the same one, so a validly signed name never dies at the adapter's door.
    const w = build(() => {}, {
      makeRelease: () => releaseFixture({ version: OFFERED, now: NOW, name: "morndo-0.2.0+b7-linux-x64.tar.gz" }),
    });
    const out = await w.service.check();
    expect(out).toEqual({ kind: "staged", version: OFFERED, already: false });
    expect(w.artifacts.calls[0]!.name).toBe("morndo-0.2.0+b7-linux-x64.tar.gz");
    expect(w.installer.has(OFFERED)).toBe(true);
    expect(w.store.versionRecord(OFFERED)).not.toBeNull();
  });

  it("manifest bytes that do not match the feed entry's digest are refused at manifest_digest", async () => {
    const w = build(w => {
      w.feed.channels.set("stable", doctoredFeed(w.keys, w.feedText, doc => {
        (doc.releases as Record<string, unknown>[])[0]!.manifestSha256 = "0".repeat(64);
      }));
    });
    expect(await w.service.check()).toMatchObject({ kind: "refused", step: "manifest_digest" });
    nothingLeft(w);
    recorded(w, "refused", "manifest_digest", OFFERED);
  });

  it("a manifest over the size its entry names is refused at manifest_digest", async () => {
    const w = build(w => {
      w.feed.channels.set("stable", doctoredFeed(w.keys, w.feedText, doc => {
        (doc.releases as Record<string, unknown>[])[0]!.manifestSize = w.rel.manifestBytes.length - 1;
      }));
    });
    expect(await w.service.check()).toMatchObject({ kind: "refused", step: "manifest_digest" });
    nothingLeft(w);
    recorded(w, "refused", "manifest_digest", OFFERED);
  });

  it("a manifest whose Version differs from its entry's is refused at manifest_version", async () => {
    const other = releaseFixture({ version: "0.2.1", now: NOW });
    const w = build(w => {
      // the entry points at 0.2.0's URL but vouches for 0.2.1's bytes, so every earlier step passes
      w.feed.manifests.set(w.rel.manifestUrl, signed(other.manifestBytes, manifestSignature(w.keys, other)));
      w.feed.channels.set("stable", doctoredFeed(w.keys, w.feedText, doc => {
        const entry = (doc.releases as Record<string, unknown>[])[0]!;
        entry.manifestSize = other.manifestBytes.length;
        entry.manifestSha256 = sha256hex(other.manifestBytes);
      }));
    });
    expect(await w.service.check()).toMatchObject({ kind: "refused", step: "manifest_version" });
    nothingLeft(w);
    recorded(w, "refused", "manifest_version", OFFERED);
  });

  // ---- RL1: the file list

  it("an archive holding a file the list never named is refused at file_list", async () => {
    const w = build(() => {}, {
      makeRelease: () => releaseFixture({
        version: OFFERED, now: NOW,
        tamper: (tree, filesJson) => packWithList(
          [...tree, { path: "extra.txt", mode: "0444", bytes: Buffer.from("smuggled\n") }], filesJson),
      }),
    });
    const out = await w.service.check();
    expect(out).toMatchObject({ kind: "refused", step: "file_list" });
    expect(out.kind === "refused" && out.detail).toContain("extra.txt");
    nothingLeft(w);
    recorded(w, "refused", "file_list", OFFERED);
  });

  it("an archive whose file list is not the digest the manifest signed is refused at file_list", async () => {
    // The final judgeVerification gate cannot be made to bite from outside: every false fact returns on its own
    // step, and a fact left unset would mean this wiring forgot one — which is what the gate is the belt for. The
    // nearest real attack is this one, a list that disagrees with the manifest's filesSha256, and the unpacker's
    // refusal (step 2's contract, RL1 file_list) is what the service forwards here.
    const w = build(() => {}, {
      makeRelease: () => releaseFixture({
        version: OFFERED, now: NOW,
        tamper: (tree, filesJson) => {
          const list = JSON.parse(filesJson) as unknown[];
          list.pop();                                   // one entry gone: a digest no manifest signed
          return packWithList(tree, canonicalJson(list));
        },
      }),
    });
    const out = await w.service.check();
    expect(out).toMatchObject({ kind: "refused", step: "file_list" });
    expect(out.kind === "refused" && out.detail).toContain("files.json");
    nothingLeft(w);
  });

  // ---- RL3: the feed's freshness and numbers, and the key set walk

  it("an expired feed is refused at feed_fresh, with nothing fetched after it", async () => {
    const w = build(w => {
      w.feed.channels.set("stable",
        feedFixture(w.keys, [w.rel], { channel: "stable", now: NOW - 15 * 24 * 3600_000 }).served);
    });
    expect(await w.service.check()).toMatchObject({ kind: "refused", step: "feed_fresh" });
    expect(w.feed.calls.manifests).toEqual([]);          // nothing past the feed
    expect(w.artifacts.calls).toEqual([]);
    nothingLeft(w);
    recorded(w, "refused", "feed_fresh", null);
  });

  it("a feed whose number is below the highest ever seen is refused at feed_seq", async () => {
    const w = build(w => w.store.saveTrust({ keySet: w.ks1.decoded, highestFeedSeq: { stable: 5, latest: 0 } }));
    expect(await w.service.check()).toMatchObject({ kind: "refused", step: "feed_seq" });
    nothingLeft(w);
    recorded(w, "refused", "feed_seq", null);
  });

  it("the walk takes v1 to v3 through a root change signed by old and new root, and stages", async () => {
    const newRoot = makeSigningKey();
    const w = build(w => {
      const ks2 = keySetDocument(w.keys, { version: 2, expiresAt: NOW + YEAR });
      const ks3 = keySetDocument(w.keys, {
        version: 3, expiresAt: NOW + YEAR, root: [newRoot.fingerprint],
        signers: [w.keys.root, newRoot],                 // both sides, as TUF's client workflow for root asks
      });
      w.store.saveTrust({ keySet: w.ks1.decoded, highestFeedSeq: { stable: 0, latest: 0 } });
      w.feed.keySets.set(2, signed(ks2.bytes, ks2.sig));
      w.feed.keySets.set(3, signed(ks3.bytes, ks3.sig));
      w.feed.channels.set("stable",
        feedFixture(w.keys, [w.rel], { channel: "stable", now: NOW, keySetVersion: 3 }).served);
    });
    const out = await w.service.check();
    expect(out).toEqual({ kind: "staged", version: OFFERED, already: false });
    expect(w.store.trust().keySet?.version).toBe(3);     // rotated, one step at a time
    // From the trusted version upward, never below it; the probe past the newest (a 404) is the only way the walk
    // learns where the ladder ends.
    expect(w.feed.calls.keySets).toEqual([2, 3, 4]);
  });

  it("a root change signed by the old root alone is refused at key_set as root_change_one_side", async () => {
    const newRoot = makeSigningKey();
    const w = build(w => {
      const ks2 = keySetDocument(w.keys, { version: 2, expiresAt: NOW + YEAR });
      const ks3 = keySetDocument(w.keys, {
        version: 3, expiresAt: NOW + YEAR, root: [newRoot.fingerprint], signers: [w.keys.root],
      });
      w.store.saveTrust({ keySet: w.ks1.decoded, highestFeedSeq: { stable: 0, latest: 0 } });
      w.feed.keySets.set(2, signed(ks2.bytes, ks2.sig));
      w.feed.keySets.set(3, signed(ks3.bytes, ks3.sig));
    });
    expect(await w.service.check()).toMatchObject({ kind: "refused", step: "key_set", detail: "root_change_one_side" });
    nothingLeft(w);
    recorded(w, "refused", "key_set", null);
  });

  it("a root change signed by the new root alone is refused at key_set as unsigned_by_root", async () => {
    // The step sketch mapped "new root only" to root_change_one_side, but the domain checks the previous version's
    // root first (acceptKeySets), so a new-root-only signature never gets that far; the old-root-only case above is
    // the one-sided root change. This test pins the domain's actual word.
    const newRoot = makeSigningKey();
    const w = build(w => {
      const ks2 = keySetDocument(w.keys, { version: 2, expiresAt: NOW + YEAR });
      const ks3 = keySetDocument(w.keys, {
        version: 3, expiresAt: NOW + YEAR, root: [newRoot.fingerprint], signers: [newRoot],
      });
      w.store.saveTrust({ keySet: w.ks1.decoded, highestFeedSeq: { stable: 0, latest: 0 } });
      w.feed.keySets.set(2, signed(ks2.bytes, ks2.sig));
      w.feed.keySets.set(3, signed(ks3.bytes, ks3.sig));
    });
    expect(await w.service.check()).toMatchObject({ kind: "refused", step: "key_set", detail: "unsigned_by_root" });
    nothingLeft(w);
  });

  it("an offered key set signed by a key that is not root is refused at key_set as unsigned_by_root", async () => {
    const w = build(w => {
      const ks2 = keySetDocument(w.keys, { version: 2, expiresAt: NOW + YEAR, signers: [w.keys.other] });
      w.store.saveTrust({ keySet: w.ks1.decoded, highestFeedSeq: { stable: 0, latest: 0 } });
      w.feed.keySets.set(2, signed(ks2.bytes, ks2.sig));
    });
    expect(await w.service.check()).toMatchObject({ kind: "refused", step: "key_set", detail: "unsigned_by_root" });
    nothingLeft(w);
  });

  it("a trusted key set past its expiry, with nothing newer published, is refused at keys_expired", async () => {
    const w = build(w => {
      const expired = keySetDocument(w.keys, { version: 1, expiresAt: NOW - 1 });
      w.store.saveTrust({ keySet: expired.decoded, highestFeedSeq: { stable: 0, latest: 0 } });
    });
    expect(await w.service.check()).toMatchObject({ kind: "refused", step: "keys_expired" });
    nothingLeft(w);
    recorded(w, "refused", "keys_expired", null);
  });

  it("a key set below the trusted version is never even fetched: the walk starts at the next one", async () => {
    const w = build(w => {
      const ks2 = keySetDocument(w.keys, { version: 2, expiresAt: NOW + YEAR });
      w.store.saveTrust({ keySet: ks2.decoded, highestFeedSeq: { stable: 0, latest: 0 } });
      w.feed.keySets.set(1, signed(w.ks1.bytes, w.ks1.sig));   // an old document the host still serves
      w.feed.keySets.set(2, signed(ks2.bytes, ks2.sig));
      w.feed.channels.set("stable",
        feedFixture(w.keys, [w.rel], { channel: "stable", now: NOW, keySetVersion: 2 }).served);
    });
    const out = await w.service.check();
    // keys/3.json is the one 404 that ends the walk; keys/1.json and keys/2.json were never asked for.
    expect(w.feed.calls.keySets).toEqual([3]);
    expect(out).toEqual({ kind: "staged", version: OFFERED, already: false });
  });

  // ---- RL2: what the machine may move to

  it("a feed offering the current Version is up_to_date, and nothing is fetched", async () => {
    const w = build(() => {}, { makeRelease: () => releaseFixture({ version: "0.1.0", now: NOW }) });
    expect(await w.service.check()).toEqual({ kind: "up_to_date", current: "0.1.0" });
    expect(w.artifacts.calls).toEqual([]);
    nothingLeft(w, "0.1.0");
    recorded(w, "up_to_date", null, "0.1.0");
  });

  it("a feed offering a lower Version is up_to_date: never down", async () => {
    const w = build(() => {}, { makeRelease: () => releaseFixture({ version: "0.0.9", now: NOW }) });
    expect(await w.service.check()).toEqual({ kind: "up_to_date", current: "0.1.0" });
    expect(w.artifacts.calls).toEqual([]);
    nothingLeft(w, "0.0.9");
  });

  it("a feed whose only newer Version is withdrawn is up_to_date", async () => {
    const w = build(w => {
      w.feed.channels.set("stable", doctoredFeed(w.keys, w.feedText, doc => { doc.withdrawn = [OFFERED]; }));
    });
    expect(await w.service.check()).toEqual({ kind: "up_to_date", current: "0.1.0" });
    expect(w.artifacts.calls).toEqual([]);
    nothingLeft(w);
  });

  it("a pin holds the machine at its Version: skipped pinned", async () => {
    const w = build(w => { w.settings.value = { ...w.settings.value, pin: parseVersion("0.1.0") }; });
    expect(await w.service.check()).toEqual({ kind: "skipped", reason: "pinned", version: OFFERED });
    expect(w.artifacts.calls).toEqual([]);
    nothingLeft(w);
    recorded(w, "skipped", null, OFFERED);
  });

  it("a pin below the highest release stages the pinned one when the feed offers it", async () => {
    const w = build(w => {
      const rel03 = releaseFixture({ version: "0.3.0", now: NOW });
      w.feed.channels.set("stable", feedFixture(w.keys, [w.rel, rel03], { channel: "stable", now: NOW }).served);
      w.feed.manifests.set(rel03.manifestUrl, signed(rel03.manifestBytes, manifestSignature(w.keys, rel03)));
      w.settings.value = { ...w.settings.value, pin: parseVersion(OFFERED) };
    });
    expect(await w.service.check()).toEqual({ kind: "staged", version: OFFERED, already: false });
    expect(w.installer.has(OFFERED)).toBe(true);                     // the pin the feed offers…
    expect(w.installer.has("0.3.0")).toBe(false);                    // …not the highest entry above it
  });

  it("a pin the feed does not offer is skipped pinned, the highest entry as the named Version", async () => {
    const w = build(w => {
      const rel03 = releaseFixture({ version: "0.3.0", now: NOW });
      w.feed.channels.set("stable", feedFixture(w.keys, [w.rel, rel03], { channel: "stable", now: NOW }).served);
      w.feed.manifests.set(rel03.manifestUrl, signed(rel03.manifestBytes, manifestSignature(w.keys, rel03)));
      w.settings.value = { ...w.settings.value, pin: parseVersion("0.4.0") };
    });
    expect(await w.service.check()).toEqual({ kind: "skipped", reason: "pinned", version: "0.3.0" });
    expect(w.artifacts.calls).toEqual([]);
    nothingLeft(w, "0.3.0");
    nothingLeft(w, OFFERED);
    recorded(w, "skipped", null, "0.3.0");
  });

  it("a pin at the current Version, offered by the feed, answers up_to_date", async () => {
    const w = build(w => {
      const rel01 = releaseFixture({ version: "0.1.0", now: NOW });
      const rel03 = releaseFixture({ version: "0.3.0", now: NOW });
      w.feed.channels.set("stable", feedFixture(w.keys, [rel01, w.rel, rel03], { channel: "stable", now: NOW }).served);
      w.feed.manifests.set(rel03.manifestUrl, signed(rel03.manifestBytes, manifestSignature(w.keys, rel03)));
      w.settings.value = { ...w.settings.value, pin: parseVersion("0.1.0") };
    });
    expect(await w.service.check()).toEqual({ kind: "up_to_date", current: "0.1.0" });
    expect(w.artifacts.calls).toEqual([]);                           // nothing fetched: the machine already sits at its pin
  });

  it("a Version marked bad here is skipped bad_here", async () => {
    const w = build(w => w.store.recordBad(OFFERED, NOW));
    expect(await w.service.check()).toEqual({ kind: "skipped", reason: "bad_here", version: OFFERED });
    expect(w.artifacts.calls).toEqual([]);
    nothingLeft(w);
    recorded(w, "skipped", null, OFFERED);
  });

  // ---- RL14: the switches and the install itself

  it("a checkout is not ours to update, and the lock is never taken", async () => {
    const w = build(w => {
      w.installer.layoutState = { method: "checkout", current: null, previous: null, good: null };
    });
    expect(await w.service.check()).toEqual({ kind: "not_ours", detail: "this Morndo runs from a checkout; update it with git pull" });
    expect(w.store.calls).not.toContain("tryLock");
    expect(w.feed.calls.channels).toEqual([]);
  });

  it("MORNDO_DISABLE_UPDATES refuses every path: not_ours", async () => {
    const w = build(() => {}, { disableUpdates: true });
    expect(await w.service.check()).toEqual({ kind: "not_ours", detail: "updates are disabled (MORNDO_DISABLE_UPDATES)" });
    expect(w.store.calls).not.toContain("tryLock");
    recorded(w, "not_ours", null, null);
  });

  // ---- the lock and the network

  it("another process holding the apply lock answers busy, and nothing is fetched", async () => {
    const w = build(w => { w.store.heldByAnother = true; });
    expect(await w.service.check()).toEqual({ kind: "busy" });
    expect(w.feed.calls.channels).toEqual([]);
    nothingLeft(w);
    recorded(w, "busy", null, null);
  });

  it("an unreachable feed answers unreachable and leaves nothing", async () => {
    const w = build(w => { w.feed.fail = { op: "channel", error: new FetchFailed("network", "connect refused") }; });
    const out = await w.service.check();
    expect(out).toMatchObject({ kind: "unreachable" });
    expect(out.kind === "unreachable" && out.detail).toContain("network");
    nothingLeft(w);
    recorded(w, "unreachable", null, null);
  });

  it("an artifact the host no longer serves answers unreachable, after the manifest was verified", async () => {
    const w = build(w => w.artifacts.unserve(w.rel.name));
    expect(await w.service.check()).toMatchObject({ kind: "unreachable" });
    expect(w.feed.calls.manifests).toEqual([w.rel.manifestUrl]);   // it got as far as the download
    nothingLeft(w);
  });

  // An I/O error is no verdict on the release (review of 2026-10-21): it is a failure to try again later (exit 75),
  // recorded like every outcome, never a refusal of the data (65) and never a crash.
  it("an adapter that throws a plain error mid-stage is a recorded failure to retry, never a crash", async () => {
    const w = build(world => {
      world.artifacts.fetch = async () => { throw new Error("disk full"); };   // as a full disk would
    });
    const out = await w.service.check();
    expect(out).toEqual({ kind: "failed", detail: "disk full" });
    recorded(w, "failed", "error", OFFERED);
    nothingLeft(w);
  });

  it("a full disk while unpacking is a recorded failure to retry (75), not a file_list refusal (65)", async () => {
    const w = build(world => {
      world.installer.unpack = async () => {
        throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
      };
    });
    const out = await w.service.check();
    expect(out).toEqual({ kind: "failed", detail: "ENOSPC: no space left on device, write" });
    recorded(w, "failed", "error", OFFERED);
    nothingLeft(w);
  });

  // ---- the self-test

  it("a failed self-test refuses and leaves nothing", async () => {
    const w = build(w => { w.installer.failSelftest = 'bin/morndo --version printed "0.1.9", not 0.2.0'; });
    expect(await w.service.check()).toMatchObject({ kind: "refused", step: "selftest" });
    nothingLeft(w);
    recorded(w, "refused", "selftest", OFFERED);
  });

  // ---- §13: a crash between the rename and the record

  it("a Version directory promoted before its record was written is verified and adopted, with nothing downloaded", async () => {
    const w = build(world => {
      const real = world.store.recordStaged.bind(world.store);
      let died = false;
      world.store.recordStaged = (r: StagedRecord) => {            // the process dies between rename and record
        if (!died) { died = true; throw new Error("record failed: update.db could not be written"); }
        real(r);
      };
    });
    await w.service.check().catch(() => undefined);                // a crash or a refusal: either way, no staging
    expect(w.store.versionRecord(OFFERED)).toBeNull();             // the row never made it…
    expect(w.installer.has(OFFERED)).toBe(true);                   // …but the promoted directory did

    const fetches = w.artifacts.calls.length;
    const out = await w.service.check();
    expect(out).toEqual({ kind: "staged", version: OFFERED, already: true });
    expect(w.artifacts.calls.length).toBe(fetches);                // adopted: nothing downloaded
    expect(w.store.versionRecord(OFFERED)).toMatchObject({ filesSha256: w.rel.filesSha256, manifestSha256: w.rel.manifestSha256 });
    expect(w.store.manifestOf(OFFERED)).toBe(w.rel.manifestText);     // the adopted path records it too
    recorded(w, "staged", null, OFFERED);
    expect(w.store.checks(1)[0]!.detail).toBe("adopted a verified directory left without its record");
  });

  it("a leftover Version directory that fails verification is removed and staged again", async () => {
    const w = build();
    expect(await w.service.check()).toEqual({ kind: "staged", version: OFFERED, already: false });
    w.store.versions.delete(OFFERED);                              // the record lost, the directory left
    const vdir = join(w.installer.dir, OFFERED);
    chmodSync(vdir, 0o755);                                        // one listed file now differs from the signed list
    chmodSync(join(vdir, "README.md"), 0o644);
    writeFileSync(join(vdir, "README.md"), "morndo 0.9.9\n");
    chmodSync(join(vdir, "README.md"), 0o444);
    chmodSync(vdir, 0o555);

    const fetches = w.artifacts.calls.length;
    const out = await w.service.check();
    expect(out).toEqual({ kind: "staged", version: OFFERED, already: false });   // staged afresh, over the removed leftover
    expect(w.artifacts.calls.length).toBe(fetches + 1);            // downloaded again
    expect(w.store.versionRecord(OFFERED)).not.toBeNull();
    recorded(w, "staged", null, OFFERED);
  });
});
