// A whole release, signed, the way the pipeline publishes it (design §9.4–§9.6): scripts/release is the other half
// of the contract the updater reads, so the fixtures are built with its own writers — listFiles and packTree through
// buildRelease, buildManifest, publishRelease — and signed with Ed25519 keys in the SSHSIG format. Every name, host,
// path, version and id is made up; every key is made at run time and never written out of the scratch directory.
import { createHash } from "node:crypto";
import type { Channel, DatabaseName, FeedEntry, KeySet, Platform, SchemaInfo } from "@morndo/domain";
import { KeySetSchema } from "@morndo/protocol";
import { canonicalJson, isoUtc } from "../../../../scripts/release/json.ts";
import { publishRelease } from "../../../../scripts/release/feed.ts";
import { artifactName, buildManifest } from "../../../../scripts/release/manifest.ts";
import type { TreeFile } from "../../../../scripts/release/archive.ts";
import { FEED_NAMESPACE, KEYS_NAMESPACE, RELEASE_NAMESPACE } from "../../src/application/namespaces.ts";
import type { Signed } from "../../src/application/ports.ts";
import { buildRelease, packWithList } from "./tar-fixtures.ts";
import { makeSigningKey, type SigningKey } from "./sshsig.ts";

export const HOST = "https://feed.example.invalid";
export const sha256hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

// One key per role (§10.1), plus `other` for a key nobody trusts.
export type Keys = { root: SigningKey; release: SigningKey; feed: SigningKey; other: SigningKey };
export const makeKeys = (): Keys => {
  const key = () => makeSigningKey();
  return { root: key(), release: key(), feed: key(), other: key() };
};

const signatures = (bytes: Uint8Array, namespace: string, signers: readonly SigningKey[]): Buffer =>
  Buffer.concat(signers.map(signer => signer.signature(bytes, namespace)));

// A document and its .sig, as the feed host would serve both.
export const signed = (bytes: Uint8Array, sig: Uint8Array): Signed => ({ bytes, signature: sig });
export const signedJson = (doc: unknown, signer: SigningKey, namespace: string): Signed => {
  const bytes = Buffer.from(canonicalJson(doc));
  return signed(bytes, signer.signature(bytes, namespace));
};

// keys.json (§9.6), root's document. `signers` defaults to the root key; a rotation test signs with more or others.
export function keySetDocument(keys: Keys, o: {
  version: number; expiresAt: number; root?: string[]; release?: string[]; feed?: string[];
  signers?: readonly SigningKey[];
}): { text: string; bytes: Buffer; sig: Buffer; decoded: KeySet } {
  const doc = {
    schema: 1 as const,
    version: o.version,
    expiresAt: isoUtc(o.expiresAt),
    root: o.root ?? [keys.root.fingerprint],
    release: o.release ?? [keys.release.fingerprint],
    feed: o.feed ?? [keys.feed.fingerprint],
  };
  const decoded = KeySetSchema.parse(doc);              // the wire's own shape, so a fixture cannot drift
  const bytes = Buffer.from(canonicalJson(doc));
  return { text: canonicalJson(doc), bytes, sig: signatures(bytes, KEYS_NAMESPACE, o.signers ?? [keys.root]), decoded };
}

// A Version's tree, archive, signed-list digest and manifest, all consistent with each other. `tamper` rewrites the
// archive (the file-list cases): the manifest then vouches for the tampered bytes against the untampered list's
// digest, which is exactly the attack the file_list check exists for.
const TREE = (version: string): TreeFile[] => [
  { path: "README.md", mode: "0444", bytes: Buffer.from(`morndo ${version}\n`) },
  { path: "app/run.sh", mode: "0555", bytes: Buffer.from(`#!/bin/sh\necho ${version}\n`) },
  { path: "bin/morndo", mode: "0555", link: "../app/run.sh" },
];

export type ReleaseFixture = {
  version: string;
  platform: Platform;
  name: string;
  tree: TreeFile[];
  filesJson: string;
  archive: Buffer;
  filesSha256: string;
  manifestText: string;
  manifestBytes: Buffer;
  manifestUrl: string;
  manifestSha256: string;
};

export function releaseFixture(o: {
  version: string; platform?: Platform; now: number; name?: string;
  tamper?: (tree: TreeFile[], filesJson: string) => Buffer;
}): ReleaseFixture {
  const platform = o.platform ?? "linux-x64";
  const tree = TREE(o.version);
  const built = buildRelease(tree);
  const archive = o.tamper === undefined ? built.gz : o.tamper(tree, built.filesJson);
  const name = o.name ?? artifactName(o.version, platform);
  const schemas: Record<DatabaseName, SchemaInfo> = {
    hub: { version: 3, floor: 1 }, fleet: { version: 2, floor: 0 }, node: { version: 2, floor: 0 },
    connections: { version: 1, floor: 0 },
  };
  const manifestText = buildManifest({
    version: o.version,
    commit: "0123456789abcdef0123456789abcdef01234567",
    publishedAt: o.now,
    repository: "example/morndo",
    protocol: { agent: [1, 2], clientApi: [1, 1] },
    schemas,
    artifacts: [{ platform, name, size: archive.length, sha256: sha256hex(archive), filesSha256: built.filesSha256, node: "24.21.0" }],
  });
  const manifestBytes = Buffer.from(manifestText);
  return {
    version: o.version, platform, name, tree, filesJson: built.filesJson, archive, filesSha256: built.filesSha256,
    manifestText, manifestBytes, manifestUrl: `${HOST}/releases/v${o.version}/manifest.json`,
    manifestSha256: sha256hex(manifestBytes),
  };
}

// A channel feed listing the releases (§9.5): publishRelease raises the number per release, as the pipeline does.
export function feedFixture(keys: Keys, releases: readonly ReleaseFixture[], o: {
  channel: Channel; now: number; keySetVersion?: number;
}): { text: string; served: Signed } {
  let text: string | null = null;
  for (const release of releases) {
    const entry: FeedEntry = {
      version: release.version, manifest: release.manifestUrl,
      manifestSize: release.manifestBytes.length, manifestSha256: release.manifestSha256,
    };
    text = publishRelease(text, { channel: o.channel, entry, now: o.now, keySetVersion: o.keySetVersion ?? 1 });
  }
  if (text === null) throw new Error("a feed fixture lists no release");
  const bytes = Buffer.from(text);
  return { text, served: signed(bytes, keys.feed.signature(bytes, FEED_NAMESPACE)) };
}

// The manifest's signature, by the release key under its own namespace.
export const manifestSignature = (keys: Keys, release: ReleaseFixture): Buffer =>
  keys.release.signature(release.manifestBytes, RELEASE_NAMESPACE);

// A feed document rewritten field by field and re-signed — the doctored-feed cases, where what the feed says and
// what is served disagree in exactly one place.
export function doctoredFeed(keys: Keys, text: string, patch: (doc: Record<string, unknown>) => void): Signed {
  const doc = JSON.parse(text) as Record<string, unknown>;
  patch(doc);
  return signedJson(doc, keys.feed, FEED_NAMESPACE);
}

export { makeSigningKey, packWithList };
