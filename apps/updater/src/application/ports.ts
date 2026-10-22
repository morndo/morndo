// The updater's ports (design §4.6). The application decides; these touch the network, the disk and the clock.
import type { Channel, InstallMethod, KeySet, UpdateSettings } from "@morndo/domain";

// A signed document as fetched: its bytes and the bytes of the signature file beside it (`<url>.sig`), both unparsed.
export type Signed = { bytes: Uint8Array; signature: Uint8Array };
// Why a fetch failed: the network or TLS, an HTTP status other than 200, a body over its cap, or the timeout.
export class FetchFailed extends Error {
  readonly reason: "network" | "status" | "too_large" | "timeout";
  constructor(reason: "network" | "status" | "too_large" | "timeout", message: string) {
    super(message); this.name = "FetchFailed"; this.reason = reason;
  }
}

// The feed host (§9.5, §9.6): keys/<n>.json, <channel>.json and each Release's manifest.json, each with its .sig.
export interface ReleaseFeed {
  /** keys/<version>.json and its .sig; null when that version is not published (HTTP 404). Capped at 64 KiB. */
  keySet(version: number): Promise<Signed | null>;
  /** <channel>.json and its .sig. Capped at 64 KiB. */
  channel(name: Channel): Promise<Signed>;
  /** The Manifest at `url` and `${url}.sig`; the Manifest is capped at `maxBytes` (its Feed entry's manifestSize). */
  manifest(url: string, maxBytes: number): Promise<Signed>;
}

// One Artifact download into the downloads directory. The body is written up to maxBytes and no further.
export type Download = { path: string; size: number; overLimit: boolean; cut: boolean };
export interface ArtifactStore {
  /** overLimit: the server had more than maxBytes; cut: the connection ended before the body did.
   *  deadlineMs: the download's one wall, idle gaps and slow dribbles included. */
  fetch(url: string, o: { name: string; maxBytes: number; timeoutMs: number; deadlineMs: number }): Promise<Download>;
  /** Removes the download named `name`, if any. */
  discard(name: string): void;
}

// What the verifier found for one SSH signature block (PROTOCOL.sshsig): `valid` is true only for an ssh-ed25519 key,
// the sha512 hash and a signature that verifies over the message under the namespace the block itself states.
export type SignatureFact = { valid: boolean; fingerprint: string; namespace: string; reason: string };
export interface Verifier {
  /** One fact per armored block in `signatures` (a .sig file may hold several, one per signer). Never throws. */
  signatures(message: Uint8Array, signatures: Uint8Array): SignatureFact[];
  sha256(bytes: Uint8Array): string;
  sha256File(path: string): Promise<string>;
}

export type Layout = { method: InstallMethod; current: string | null; previous: string | null; good: string | null };
export type TreeFinding = { path: string; problem: "list_digest" | "missing" | "changed" | "mode" | "extra" | "unreadable" };
export interface Installer {
  /** How this machine runs Morndo: "updater" when ~/.local/share/morndo-releases/current is a link to a Version. */
  layout(): Layout;
  /** trust/keys.json shipped inside the current Version, or null. */
  shippedKeySet(): Uint8Array | null;
  /** Removes leftover .staging-* directories (call only while holding the lock). */
  sweep(): void;
  /** Whether <version>/ is installed (promoted). */
  has(version: string): boolean;
  /** Unpacks the archive into .staging-<version>/ and checks it against its signed file list (RL1 file_list).
   *  ok false: the staging directory is already removed, `reason` says what was refused. */
  unpack(archive: string, version: string, o: { filesSha256: string; maxBytes: number }): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Runs .staging-<version>/bin/morndo --version; ok when it prints exactly `version`. */
  selftest(version: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Writes install.json, makes the tree read-only, renames .staging-<version> to <version>. */
  promote(version: string, record: { manifestSha256: string; filesSha256: string; at: number }): void;
  /** Removes .staging-<version>/ if present. */
  discard(version: string): void;
  /** Removes an installed <version>/ tree; refuses (throws) while current, previous or good points at it. */
  removeVersion(version: string): void;
  /** Re-checks an installed Version against its files.json (and that list against `filesSha256` when known). */
  verifyTree(version: string, filesSha256: string | null): Promise<TreeFinding[]>;
  /** Free bytes on the file system holding the releases directory. */
  freeBytes(): number;
}

export type TrustState = { keySet: KeySet | null; highestFeedSeq: { stable: number; latest: number } };
export type StagedRecord = { version: string; manifestSha256: string; filesSha256: string; at: number };
export type CheckRecord = {
  at: number; channel: Channel; outcome: string; detail: string; version: string | null;
  feedSeq: number | null; feedExpiresAt: number | null;
};
export interface UpdateStore {
  /** The apply lock (RL4, §5 apply.lock): held until release() or the process dies; null when another holds it. */
  tryLock(): { release(): void } | null;
  trust(): TrustState;
  /** Saves the trust state; never lowers a Key set version or a Feed number (RL3), whatever it is given. */
  saveTrust(t: TrustState): void;
  highestCommitted(): string | null;
  badVersions(): string[];
  recordStaged(r: StagedRecord): void;
  /** The newest staged record whose Version is above every committed one, or null. */
  staged(): StagedRecord | null;
  versionRecord(version: string): StagedRecord | null;
  recordCheck(r: CheckRecord): void;
  /** Newest first. */
  checks(limit: number): CheckRecord[];
  /** The newest check that carries the feed's word, however far back among the kept rows, or null. A later
   *  refusal leaves the last good word standing (§4.5): ten failed checks in a row must not hide it. */
  lastFeedCheck(): CheckRecord | null;
}

export interface SettingsSource { read(): UpdateSettings }
export interface Clock { now(): number }
