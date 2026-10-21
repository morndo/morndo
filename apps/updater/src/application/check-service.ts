// The check-and-stage service (design §4.6, §6.1, §8.1, §10.2; RL1–RL3, RL14): what `morndo update --check` runs.
// This layer decides; the ports fetch, hash, unpack and record. The order is §10.2's and never skips a check: the
// trusted key set walked forward one version at a time, the channel feed verified, the offer admitted, the manifest
// and the artifact pinned to the feed entry's own size and digest, the archive unpacked against its signed file
// list, the self-test, the promotion. Every exit but a staging leaves nothing behind (§13), and every outcome is a
// row in the store.
import {
  acceptFeed, acceptKeySets, admit, compareVersions, equalVersions, higherOf, judgeVerification, parseVersion,
  type FeedEntry, type Installation, type KeySet, type OfferedKeySet, type Platform, type VerificationStep,
  type Version,
} from "@morndo/domain";
import { ChannelFeedSchema, KeySetSchema, ManifestSchema } from "@morndo/protocol";
import { FEED_NAMESPACE, KEYS_NAMESPACE, RELEASE_NAMESPACE } from "./namespaces.ts";
import {
  FetchFailed, type ArtifactStore, type Clock, type Installer, type ReleaseFeed, type SettingsSource,
  type Signed, type UpdateStore, type Verifier,
} from "./ports.ts";

// §8.1's sentence for an install that is not the updater's to change (RL14). The doctor says the same thing.
export const CHECKOUT_SENTENCE = "this Morndo runs from a checkout; update it with git pull";
const DISABLED_SENTENCE = "updates are disabled (MORNDO_DISABLE_UPDATES)";
const ARTIFACT_TIMEOUT_MS = 60_000;
// An artifact's whole download gets one wall: ten minutes of slack plus its size at 32 KiB/s, so a 50 MB archive
// gets about 36 minutes and a host that dribbles one byte inside every idle window cannot hold the apply lock (RL4)
// past it. Slower than 32 KiB/s is a refusal, not a wait.
export const MIN_RATE_BYTES_PER_S = 32 * 1024;
export const artifactDeadlineMs = (size: number): number => 10 * 60_000 + Math.ceil(size / MIN_RATE_BYTES_PER_S) * 1000;
// A ladder of key sets this long is a broken host, not a rotation; the walk stops and says what it saw (§10.2 step 2).
const KEY_WALK_LIMIT = 32;

export type CheckOutcome =
  | { kind: "up_to_date"; current: string }
  | { kind: "staged"; version: string; already: boolean }
  | { kind: "skipped"; reason: string; version: string | null }        // admit's refusal: pinned, withdrawn, bad_here, …
  | { kind: "refused"; step: string; detail: string }                  // RL1/RL3: the chain's own word for what failed
  | { kind: "not_ours"; detail: string }                               // RL14: a checkout, a package, or updates disabled
  | { kind: "busy" }                                                   // another process holds the apply lock
  | { kind: "unreachable"; detail: string };                           // FetchFailed: network, status, timeout

const decodeText = new TextDecoder();

// A document read through its wire schema: anything the schema refuses is null, never a guess.
type Decoder<T> = { safeParse(value: unknown): { success: true; data: T } | { success: false } };
const decode = <T>(schema: Decoder<T>, bytes: Uint8Array): T | null => {
  try {
    const parsed = schema.safeParse(JSON.parse(decodeText.decode(bytes)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

// The fingerprints of the valid signatures under a namespace: facts, not trust — the domain decides what they mean.
const signersOf = (verifier: Verifier, signed: Signed, namespace: string): string[] =>
  verifier.signatures(signed.bytes, signed.signature)
    .filter(fact => fact.valid && fact.namespace === namespace)
    .map(fact => fact.fingerprint);

export class CheckService {
  readonly #p: {
    feed: ReleaseFeed; artifacts: ArtifactStore; verifier: Verifier; installer: Installer;
    store: UpdateStore; settings: SettingsSource; clock: Clock; platform: Platform;
    switches: { disableUpdates: boolean };
  };

  constructor(p: {
    feed: ReleaseFeed; artifacts: ArtifactStore; verifier: Verifier; installer: Installer;
    store: UpdateStore; settings: SettingsSource; clock: Clock; platform: Platform;
    switches: { disableUpdates: boolean };
  }) {
    this.#p = p;
  }

  async check(): Promise<CheckOutcome> {
    const { feed, artifacts, verifier, installer, store, settings: settingsSource, clock, platform, switches } = this.#p;
    const settings = settingsSource.read();
    // What the store learns on the way (§4.5): the feed's word once accepted, the Version once offered.
    let feedSeq: number | null = null;
    let feedExpiresAt: number | null = null;
    let offered: string | null = null;
    // From the manifest step on, a download or a staging directory may exist; every exit but a staging removes both
    // (§13: a failed staging leaves nothing). Before it, both are null and this does nothing.
    let artifactName: string | null = null;
    let stageVersion: string | null = null;
    const cleanup = (): void => {
      if (artifactName !== null) artifacts.discard(artifactName);
      if (stageVersion !== null) installer.discard(stageVersion);
    };
    const finish = (outcome: CheckOutcome, detail: string, version: string | null = offered): CheckOutcome => {
      cleanup();
      store.recordCheck({ at: clock.now(), channel: settings.channel, outcome: outcome.kind, detail, version, feedSeq, feedExpiresAt });
      return outcome;
    };
    const refused = (step: string, detail: string): CheckOutcome => finish({ kind: "refused", step, detail }, `${step}: ${detail}`);

    // RL14 first, before anything is fetched or locked: the switches win over everything, and only an install this
    // updater made is ours to change.
    if (switches.disableUpdates) return finish({ kind: "not_ours", detail: DISABLED_SENTENCE }, DISABLED_SENTENCE, null);
    const layout = installer.layout();
    if (layout.method !== "updater" || layout.current === null || parseVersion(layout.current) === null) {
      return finish({ kind: "not_ours", detail: CHECKOUT_SENTENCE }, CHECKOUT_SENTENCE, null);
    }
    const current = parseVersion(layout.current)!;

    const lock = store.tryLock();          // RL4: one check at a time, and the sweep only under the lock
    if (lock === null) return finish({ kind: "busy" }, "another process holds the apply lock", null);
    try {
      installer.sweep();

      // §10.2 step 2: the trusted key set, then the walk to the newest one (RL3). A machine with none of its own
      // anchors on the one shipped inside the current Version (§10.1: root signs the key set, once at the start).
      const trust = store.trust();
      let keySet: KeySet | null = trust.keySet;
      if (keySet === null) {
        const shipped = installer.shippedKeySet();
        const anchor = shipped === null ? null : decode(KeySetSchema, shipped);
        if (anchor === null) return refused("key_set", "no trusted key set");
        keySet = anchor;
      }
      const offeredSets: OfferedKeySet[] = [];
      for (let n = keySet.version + 1; offeredSets.length < KEY_WALK_LIMIT; n++) {
        const signed = await feed.keySet(n);
        if (signed === null) break;                        // that version was never published: the walk ends
        const set = decode(KeySetSchema, signed.bytes);
        if (set === null) return refused("key_set", `malformed key set ${n}`);
        offeredSets.push({ set, signedBy: signersOf(verifier, signed, KEYS_NAMESPACE) });
      }
      const walked = acceptKeySets(keySet, offeredSets, clock.now());
      if (walked.ok) {
        keySet = walked.value;                             // KeySetRotated
        store.saveTrust({ keySet, highestFeedSeq: trust.highestFeedSeq });
      } else if (walked.error === "empty") {
        // Nothing newer: the trusted set itself must still be live, or updates are visibly stuck (KeysExpired).
        if (clock.now() >= keySet.expiresAt) return refused("keys_expired", "expired");
      } else if (walked.error === "expired") {
        return refused("keys_expired", "expired");         // an expired set may vouch for the next; the newest may not be
      } else {
        return refused("key_set", walked.error);
      }

      // §10.2 step 3: the channel feed — signature, namespace, channel, freshness, number (RL3). A feed key signing
      // under another namespace fails here; any other key fails at feed_signature.
      const signedFeed = await feed.channel(settings.channel);
      const facts: Partial<Record<VerificationStep, boolean>> = {};
      const feedFact = verifier.signatures(signedFeed.bytes, signedFeed.signature)
        .find(fact => fact.valid && keySet.feed.includes(fact.fingerprint));
      facts.feed_signature = feedFact !== undefined;
      facts.feed_namespace = feedFact !== undefined && feedFact.namespace === FEED_NAMESPACE;
      if (facts.feed_signature !== true) return refused("feed_signature", "no valid signature by a trusted feed key");
      if (facts.feed_namespace !== true) return refused("feed_namespace", `signed under the namespace ${JSON.stringify(feedFact!.namespace)}`);
      const feedDoc = decode(ChannelFeedSchema, signedFeed.bytes);
      if (feedDoc === null) return refused("feed_decode", "the feed is not the wire's shape");
      const accepted = acceptFeed(feedDoc, {
        channel: settings.channel,
        highestSeq: trust.highestFeedSeq[settings.channel],
        keySetVersion: keySet.version,
      }, clock.now());
      if (!accepted.ok) {
        const stepOf = { wrong_channel: "feed_channel", stale: "feed_fresh", older: "feed_seq", other_key_set: "feed_key_set" } as const;
        return refused(stepOf[accepted.error], accepted.error);
      }
      const channelFeed = accepted.value;
      facts.feed_channel = true;
      facts.feed_fresh = true;
      facts.feed_seq = true;
      feedSeq = channelFeed.seq;
      feedExpiresAt = channelFeed.expiresAt;
      store.saveTrust({ keySet, highestFeedSeq: { ...trust.highestFeedSeq, [settings.channel]: channelFeed.seq } });

      // The offer: the highest Version the feed lists that is not withdrawn (RL2, RL12). An unparsable entry is
      // skipped, never guessed at.
      const withdrawn = channelFeed.withdrawn
        .map(parseVersion).filter((v): v is Version => v !== null);
      const offers: { text: string; version: Version; entry: FeedEntry }[] = [];
      for (const entry of channelFeed.releases) {
        const version = parseVersion(entry.version);
        if (version === null) continue;
        if (withdrawn.some(w => equalVersions(w, version))) continue;
        offers.push({ text: entry.version, version, entry });
      }
      const best = offers.reduce<{ text: string; version: Version; entry: FeedEntry } | null>(
        (best, offer) => best === null || compareVersions(offer.version, best.version) > 0 ? offer : best, null);
      if (best === null) {
        return finish({ kind: "up_to_date", current: layout.current }, `no version offered on ${settings.channel}`, layout.current);
      }
      offered = best.text;

      // RL2, RL12, RL14 and the machine's own memory, in the domain's one place. A principal's `--check` is not a
      // background check (§8.3): mode off and MORNDO_DISABLE_AUTOUPDATE stop the tick, not this.
      const stagedRecord = store.staged();
      const committed = store.highestCommitted();
      const machine: Installation = {
        current,
        previous: layout.previous === null ? null : parseVersion(layout.previous),
        staged: stagedRecord === null ? null : parseVersion(stagedRecord.version),
        badVersions: store.badVersions().map(parseVersion).filter((v): v is Version => v !== null),
        highestCommitted: higherOf(current, committed === null ? current : parseVersion(committed) ?? current),
        keySet,
        highestFeedSeq: { ...trust.highestFeedSeq, [settings.channel]: channelFeed.seq },
        installMethod: "updater",
        settings: { ...settings, mode: "apply" },
      };
      const admitted = admit({
        machine,
        switches: { disableAutoUpdate: false, disableUpdates: false },
        ask: { kind: "auto" },
        offered: { version: best.version, feed: channelFeed },
        rolloutHalted: false,                              // the Rollout is PR 6's
      });
      if (!admitted.ok) {
        if (admitted.error === "not_newer") {
          return finish({ kind: "up_to_date", current: layout.current }, `${layout.current} is the newest on ${settings.channel}`, layout.current);
        }
        return finish({ kind: "skipped", reason: admitted.error, version: best.text }, admitted.error, best.text);
      }

      // Already staged and installed: nothing is fetched (§6.1's step 1 decides before step 2 downloads).
      if (store.versionRecord(best.text) !== null && installer.has(best.text)) {
        return finish({ kind: "staged", version: best.text, already: true }, "already staged", best.text);
      }
      stageVersion = best.text;

      // §10.2 step 4: the manifest, pinned to its feed entry's own size and digest (RL1). A body over that size is
      // refused outright by the feed, which is this check's answer.
      let signedManifest: Signed;
      try {
        signedManifest = await feed.manifest(best.entry.manifest, best.entry.manifestSize);
      } catch (error) {
        if (error instanceof FetchFailed && error.reason === "too_large") {
          return refused("manifest_digest", `the manifest is over the ${best.entry.manifestSize} bytes its feed entry names`);
        }
        throw error;                                       // network, status, timeout: unreachable, cleaned up outside
      }
      facts.manifest_digest = signedManifest.bytes.length === best.entry.manifestSize
        && verifier.sha256(signedManifest.bytes) === best.entry.manifestSha256;
      if (facts.manifest_digest !== true) {
        return refused("manifest_digest", "the manifest's bytes are not the digest its feed entry names");
      }
      const manifestFact = verifier.signatures(signedManifest.bytes, signedManifest.signature)
        .find(fact => fact.valid && keySet.release.includes(fact.fingerprint));
      facts.manifest_signature = manifestFact !== undefined;
      facts.manifest_namespace = manifestFact !== undefined && manifestFact.namespace === RELEASE_NAMESPACE;
      if (facts.manifest_signature !== true) return refused("manifest_signature", "no valid signature by a trusted release key");
      if (facts.manifest_namespace !== true) return refused("manifest_namespace", `signed under the namespace ${JSON.stringify(manifestFact!.namespace)}`);
      const manifest = decode(ManifestSchema, signedManifest.bytes);
      if (manifest === null) return refused("manifest_decode", "the manifest is not the wire's shape");
      const manifestVersion = parseVersion(manifest.version);
      facts.manifest_version = manifestVersion !== null && equalVersions(manifestVersion, best.version);
      if (facts.manifest_version !== true) {
        return refused("manifest_version", `the manifest is for ${manifest.version}, the feed entry for ${best.text}`);
      }
      const manifestSha256 = verifier.sha256(signedManifest.bytes);

      // §10.2 step 5: this platform's artifact, downloaded no further than the manifest's size (RL1).
      const artifact = manifest.artifacts.find(a => a.platform === platform);
      if (artifact === undefined) {
        return finish({ kind: "skipped", reason: "no_artifact", version: best.text }, "no_artifact", best.text);
      }

      // A crash after the rename and before the record (§13) leaves a Version directory without its row, and
      // promote refuses to overwrite it — so every later check would die at the same place. The signed
      // filesSha256 is in hand here: a leftover tree that still checks out against it is adopted as staged, and
      // one that does not is removed and staged afresh.
      if (installer.has(best.text) && store.versionRecord(best.text) === null) {
        const findings = await installer.verifyTree(best.text, artifact.filesSha256);
        if (findings.length === 0) {
          store.recordStaged({ version: best.text, manifestSha256, filesSha256: artifact.filesSha256, at: clock.now() });
          return finish({ kind: "staged", version: best.text, already: true },
            "adopted a verified directory left without its record", best.text);
        }
        installer.removeVersion(best.text);
      }
      const slash = best.entry.manifest.lastIndexOf("/");
      const url = `${best.entry.manifest.slice(0, slash + 1)}${artifact.name}`;   // the entry's directory, the manifest's name
      artifactName = artifact.name;
      const download = await artifacts.fetch(url, { name: artifact.name, maxBytes: artifact.size, timeoutMs: ARTIFACT_TIMEOUT_MS, deadlineMs: artifactDeadlineMs(artifact.size) });
      facts.artifact_size = !download.overLimit && !download.cut && download.size === artifact.size;
      if (facts.artifact_size !== true) {
        return refused("artifact_size",
          `the download is ${download.size} bytes${download.overLimit ? ", over its cap" : download.cut ? ", cut short" : ""}; the manifest names ${artifact.size}`);
      }
      const digest = await verifier.sha256File(download.path);
      facts.artifact_digest = digest === artifact.sha256;
      if (facts.artifact_digest !== true) {
        return refused("artifact_digest", `the artifact's SHA-256 is ${digest}, the manifest names ${artifact.sha256}`);
      }

      // §6.1 step 4: unpack into staging against the signed file list (RL1 file_list). A refusal has already
      // removed the staging directory; its reason is the answer.
      const unpacked = await installer.unpack(download.path, best.text, { filesSha256: artifact.filesSha256, maxBytes: 16 * artifact.size });
      facts.file_list = unpacked.ok;
      if (!unpacked.ok) return refused("file_list", unpacked.reason);

      // The gate (RL1): all twelve or nothing — a partial chain promotes nothing, and a step this wiring forgot to
      // establish is a failure, not a pass.
      const judged = judgeVerification(facts);
      if (!judged.ok) return refused(judged.error, `the verification chain never established ${judged.error}`);

      // §6.1 step 5: the staged Version says its own name.
      const tested = await installer.selftest(best.text);
      if (!tested.ok) return refused("selftest", tested.reason);

      // §6.1 step 6: promote, remember, and let the download go.
      installer.promote(best.text, { manifestSha256, filesSha256: artifact.filesSha256, at: clock.now() });
      store.recordStaged({ version: best.text, manifestSha256, filesSha256: artifact.filesSha256, at: clock.now() });
      return finish({ kind: "staged", version: best.text, already: false }, "verified and staged");
    } catch (error) {
      if (error instanceof FetchFailed) {
        const detail = `${error.reason}: ${error.message}`;
        return finish({ kind: "unreachable", detail }, detail);
      }
      // Anything else is still an answer, never a crash out of the program (§8.1): a recorded refusal at its own
      // step, the error's message as the detail, exit 65 from the CLI — and finish's cleanup leaves nothing
      // behind (§13), whatever the failure was.
      const message = error instanceof Error ? error.message : String(error);
      return refused("error", message);
    } finally {
      lock.release();
    }
  }
}
