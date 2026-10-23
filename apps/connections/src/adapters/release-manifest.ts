// Signed Claude Code releases (T-346). A release publishes manifest.json, with the sha256 of each platform binary, and
// manifest.json.sig, a detached OpenPGP signature of it by Anthropic's release key (https://code.claude.com/docs/en/setup,
// "Binary integrity and code signing", read 2026-10-21; signatures exist from 2.1.89). Verifying the signature on the manifest
// verifies every binary it lists, so a lease can admit any release the key signed without the owner pinning each update.
//   - `verifyManifest`: the signature is good under the compiled-in key (adapters/claude-release-key.ts), the manifest names the
//     version asked for, and it lists checksums;
//   - `releaseAdmits`: what the lease calls. It reads the verified-and-cached manifest and its signature from the connections
//     home, verifies them AGAIN (a file planted in the cache proves nothing) and compares the running binary's sha256. It makes
//     no network call;
//   - `syncReleases`: what the node job runs (no secret): fetches the manifest and signature of installed versions that are not
//     cached yet, verifies them, and writes them to the cache only then. A fetch or signature that fails writes nothing and
//     leaves what the cache holds.
// OpenPGP is checked with the `openpgp` library (6.3.2, LGPL-3.0+, which AGPLv3 may combine with; no advisory known for it on
// OSV, 2026-10-21), in process, not with a gpg found on PATH: the Mac has none, and a subprocess would add a binary to trust.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMessage, enums, readKey, readSignature, verify, type PublicKey } from "openpgp";
import { CLAUDE_RELEASES_URL, CLAUDE_RELEASE_FINGERPRINT, CLAUDE_RELEASE_FIRST_SIGNED, CLAUDE_RELEASE_PUBLIC_KEY } from "./claude-release-key.ts";

// A Claude Code version as the native installer names its files: 2.1.306.
const VERSION = /^\d+\.\d+\.\d+$/;
export const isVersion = (text: string): boolean => VERSION.test(text);
export function compareVersions(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
  return 0;
}

// The hashes a manifest signature may not use: MD5, SHA-1, RIPEMD-160 and SHA-224, so SHA-256 and up remain (every hash the library knows is
// in one group or the other). The library's own defaults reject MD5 and RIPEMD, and (for data signatures, observed on 6.3.2) SHA-1, but
// accept SHA-224; the list is ours, passed in every verify call, so a change of the library's defaults changes nothing here.
const WEAK_HASHES = new Set([enums.hash.md5, enums.hash.sha1, enums.hash.ripemd, enums.hash.sha224]);

export type Trust = { armoredKey: string; fingerprint: string };
export const COMPILED_TRUST: Trust = { armoredKey: CLAUDE_RELEASE_PUBLIC_KEY, fingerprint: CLAUDE_RELEASE_FINGERPRINT };

export type Verified = { ok: true; checksums: readonly string[] } | { ok: false; why: string };
const no = (why: string): { ok: false; why: string } => ({ ok: false, why });

// The key, or null when the bytes are not the key whose fingerprint is trusted.
export async function releaseKey(trust: Trust = COMPILED_TRUST): Promise<PublicKey | null> {
  try {
    const key = await readKey({ armoredKey: trust.armoredKey });
    return key.getFingerprint() === trust.fingerprint.toLowerCase() ? key : null;
  } catch { return null; }
}

// A good signature of `manifest` by the trusted key (at `at`: a key that expired or was revoked then does not count), a
// manifest that names `version`, and the checksums it lists.
export async function verifyManifest(manifest: Uint8Array, signature: Uint8Array, version: string, trust: Trust = COMPILED_TRUST, at: Date = new Date()): Promise<Verified> {
  if (!isVersion(version) || compareVersions(version, CLAUDE_RELEASE_FIRST_SIGNED) < 0) return no("no signed release of that version");
  const key = await releaseKey(trust);
  if (key === null) return no("the release key is not the trusted one");
  try {
    const armored = new TextDecoder().decode(signature.subarray(0, 40)).startsWith("-----BEGIN PGP SIGNATURE");
    const parsed = armored ? await readSignature({ armoredSignature: new TextDecoder().decode(signature) }) : await readSignature({ binarySignature: signature });
    const result = await verify({
      message: await createMessage({ binary: manifest }), signature: parsed, verificationKeys: key, date: at, format: "binary",
      config: { rejectHashAlgorithms: WEAK_HASHES, rejectMessageHashAlgorithms: WEAK_HASHES },
    });
    const first = result.signatures[0];
    if (first === undefined) return no("no signature");
    await first.verified;                                                       // rejects unless the signature is good
  } catch { return no("the manifest signature is not good"); }
  let body: { version?: unknown; platforms?: unknown };
  try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifest)) as typeof body; } catch { return no("the manifest is not JSON"); }
  if (body.version !== version) return no("the manifest is for another version");
  const platforms = typeof body.platforms === "object" && body.platforms !== null ? Object.values(body.platforms as Record<string, { checksum?: unknown }>) : [];
  const checksums = platforms.map(platform => platform?.checksum).filter((sum): sum is string => typeof sum === "string" && /^[0-9a-f]{64}$/.test(sum));
  return checksums.length > 0 ? { ok: true, checksums } : no("the manifest lists no checksum");
}

export const releaseCacheDir = (home: string): string => join(home, "claude-releases");
const read = (path: string): Uint8Array | null => { try { return readFileSync(path); } catch { return null; } };

// What the lease asks: is `sha256` the checksum a signed manifest, as cached for `version`, lists? Offline.
export async function releaseAdmits(home: string, version: string, sha256: string, trust: Trust = COMPILED_TRUST, at: Date = new Date()): Promise<{ ok: true } | { ok: false; why: string }> {
  if (!isVersion(version)) return no("not a version");
  const manifest = read(join(releaseCacheDir(home), version, "manifest.json"));
  const signature = read(join(releaseCacheDir(home), version, "manifest.json.sig"));
  if (manifest === null || signature === null) return no("no cached manifest for that version");
  const verified = await verifyManifest(manifest, signature, version, trust, at);
  if (!verified.ok) return verified;
  return verified.checksums.includes(sha256) ? { ok: true } : no("the binary's sha256 is not in the signed manifest");
}

// The versions in the directory the installer keeps them in (each is a file named by its version), from `floor` up.
export function installedVersions(versionsDir: string, floor: string): string[] {
  try {
    return readdirSync(versionsDir).filter(name => isVersion(name) && compareVersions(name, floor) >= 0).sort(compareVersions);
  } catch { return []; }
}

// One fetch of a URL's bytes. Injectable so the job can be shown without a network.
export type Fetch = (url: string) => Promise<Uint8Array>;
const MAX_BYTES = 1 << 20;
export const fetchBytes: Fetch = async url => {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: "error" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Error("too large");
  return bytes;
};

export type SyncResult = { version: string; status: "cached" | "fetched" | "failed"; why?: string };

// The node job: for each version, keep a verified cache entry. A version already cached (and still verifying) is left alone;
// otherwise its manifest and signature are fetched, verified, and only then written (a temp directory, renamed in).
export async function syncReleases(o: { home: string; versions: readonly string[]; fetch?: Fetch; trust?: Trust; at?: Date }): Promise<SyncResult[]> {
  const get = o.fetch ?? fetchBytes;
  const out: SyncResult[] = [];
  for (const version of o.versions) {
    if (!isVersion(version)) { out.push({ version, status: "failed", why: "not a version" }); continue; }
    const have = read(join(releaseCacheDir(o.home), version, "manifest.json"));
    const haveSig = read(join(releaseCacheDir(o.home), version, "manifest.json.sig"));
    if (have !== null && haveSig !== null && (await verifyManifest(have, haveSig, version, o.trust, o.at)).ok) { out.push({ version, status: "cached" }); continue; }
    try {
      const manifest = await get(`${CLAUDE_RELEASES_URL}/${version}/manifest.json`);
      const signature = await get(`${CLAUDE_RELEASES_URL}/${version}/manifest.json.sig`);
      const verified = await verifyManifest(manifest, signature, version, o.trust, o.at);
      if (!verified.ok) { out.push({ version, status: "failed", why: verified.why }); continue; }
      const root = releaseCacheDir(o.home);
      const staging = join(root, `${version}.new`);
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true, mode: 0o700 });
      writeFileSync(join(staging, "manifest.json"), manifest, { mode: 0o600 });
      writeFileSync(join(staging, "manifest.json.sig"), signature, { mode: 0o600 });
      rmSync(join(root, version), { recursive: true, force: true });
      renameSync(staging, join(root, version));
      out.push({ version, status: "fetched" });
    } catch (error) {
      out.push({ version, status: "failed", why: error instanceof Error && /^(HTTP \d+|too large)$/.test(error.message) ? error.message : "fetch failed" });
    }
  }
  return out;
}

// The owner's pin for signed releases (`morndo-keys pin-claude --signed`): the key's fingerprint (the compiled-in one, shown to
// the owner), the directory releases are installed in, the lowest version the owner accepts, and the API host of each
// connection (as in the binary pin).
export type ReleasePin = { fingerprint: string; versionsDir: string; floor: string; baseUrls: Record<string, string> };

export function parseReleasePin(body: string | null): ReleasePin | null {
  if (body === null) return null;
  let pin: Partial<ReleasePin>;
  try { pin = JSON.parse(body) as Partial<ReleasePin>; } catch { return null; }
  if (typeof pin.fingerprint !== "string" || typeof pin.versionsDir !== "string" || typeof pin.floor !== "string") return null;
  if (!isVersion(pin.floor) || compareVersions(pin.floor, CLAUDE_RELEASE_FIRST_SIGNED) < 0) return null;
  const urls = pin.baseUrls;
  if (typeof urls !== "object" || urls === null || Array.isArray(urls) || Object.values(urls).some(url => typeof url !== "string")) return null;
  return { fingerprint: pin.fingerprint, versionsDir: pin.versionsDir, floor: pin.floor, baseUrls: { ...urls } };
}

// The sha256 of a running binary that a signed manifest listed, kept by the identity of the file it was read from: its path, size,
// mtime, ctime and inode. A lease is a new process each call, and hashing a ~290 MB binary each time is the slow part, so the
// next lease with the same identity takes the hash from here. It is only ever read back on an exact match of all five (a changed
// file has a new ctime, and a swapped one a new inode), and only written after a manifest listed it; the manifest itself is
// still verified on every lease. The file is in the connections home, which an agent's sandbox denies.
export type ExeIdentity = { size: number; mtimeMs: number; ctimeMs: number; ino: number };
export type ShaCache = { get(path: string, id: ExeIdentity): string | null; put(path: string, id: ExeIdentity, sha256: string): void };
const SHA_ENTRIES = 16;

export function fileShaCache(home: string): ShaCache {
  const file = join(releaseCacheDir(home), "verified-binaries.json");
  type Entry = ExeIdentity & { path: string; sha256: string };
  const load = (): Entry[] => {
    try {
      const rows: unknown = JSON.parse(readFileSync(file, "utf8"));
      return Array.isArray(rows) ? rows.filter((row): row is Entry => typeof row === "object" && row !== null && typeof (row as Entry).path === "string" && typeof (row as Entry).sha256 === "string"
        && ["size", "mtimeMs", "ctimeMs", "ino"].every(key => typeof (row as Record<string, unknown>)[key] === "number")) : [];
    } catch { return []; }
  };
  return {
    get: (path, id) => load().find(row => row.path === path && row.size === id.size && row.mtimeMs === id.mtimeMs && row.ctimeMs === id.ctimeMs && row.ino === id.ino && /^[0-9a-f]{64}$/.test(row.sha256))?.sha256 ?? null,
    put: (path, id, sha256) => {
      try {
        const rows = [...load().filter(row => row.path !== path), { path, ...id, sha256 }].slice(-SHA_ENTRIES);
        mkdirSync(releaseCacheDir(home), { recursive: true, mode: 0o700 });
        const staging = `${file}.${process.pid}.new`;
        writeFileSync(staging, JSON.stringify(rows), { mode: 0o600 });
        renameSync(staging, file);
      } catch { /* a cache that can't be written costs a hash, nothing else */ }
    },
  };
}
