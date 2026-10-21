// The updater's ports (design §4.6). The application decides; these touch the network, the disk and the clock.
import type {
  Channel, DatabaseName, DbState, HealthReport, InstallMethod, KeySet, SafePointReport, Update, UpdateService,
  UpdateSettings,
} from "@morndo/domain";

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
  /** §6.2 step 6: `previous` first, then `current` — each a new link beside the old, renamed over it, the
   *  releases directory synced after each. A crash between the two leaves both links on the old Version.
   *  `previous: null` removes the previous link (a first install has none to keep). */
  swap(pair: { current: string; previous: string | null }): void;
  /** §6.5 step 2: the recorded pre-update pair goes back, `current` first, then `previous`, each the same
   *  atomic relink as swap's. A crash between the two leaves both links on the pre-update Version.
   *  `previous: null` removes the previous link (there was none before the update). */
  swapBack(pair: { current: string; previous: string | null }): void;
  /** Points `good` at the last committed Version (§5), the same atomic way. */
  setGood(version: string): void;
  /** Removes every installed <version>/ not named — never the ones current, previous or good point at (§6.2 step 10). */
  prune(keep: readonly string[]): void;
  /** Re-checks an installed Version against its files.json (and that list against `filesSha256` when known). */
  verifyTree(version: string, filesSha256: string | null): Promise<TreeFinding[]>;
  /** Free bytes on the file system holding the releases directory. */
  freeBytes(): number;
}

export type TrustState = { keySet: KeySet | null; highestFeedSeq: { stable: number; latest: number } };
export type StagedRecord = { version: string; manifestSha256: string; filesSha256: string; at: number; manifest: string };
export type CheckRecord = {
  at: number; channel: Channel; outcome: string; detail: string; version: string | null;
  feedSeq: number | null; feedExpiresAt: number | null;
};
// The step record (RL4, §6.2): the Update as it stands in update.db — the domain's own fields plus the format
// its steps were written in, when the attempt began, and the marks recorded done so far.
export type StoredUpdate = Update & { format: number; startedAt: number; doneMarks: string[] };
// A step record that has ended (recentUpdates, for --status): when it ended, or null while it runs.
export type UpdateHistory = StoredUpdate & { finishedAt: number | null };
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
  /** Writes the step record: one transaction, synced, before the step it stands for runs (RL4). */
  saveUpdate(u: StoredUpdate): void;
  /** The newest update not in a terminal state, or null: what a recovery picks up (§6.6). */
  openUpdate(): StoredUpdate | null;
  /** Ends an attempt; `state` names how (§4.4's terminal states a finish may write). Unknown id: throws. */
  finishUpdate(id: string, state: "committed" | "abandoned" | "rolled_back" | "rollback_failed", at: number): void;
  /** The commit's own memory (RL2): highestCommitted only ever rises. */
  recordCommitted(version: string, at: number): void;
  /** A Version that failed here is never auto-installed again (RL7). */
  recordBad(version: string, at: number): void;
  /** The Manifest text recorded when the Version was staged, or null (staged before it was kept). */
  manifestOf(version: string): string | null;
  /** The last attempts, newest first (§8.1 --status). */
  recentUpdates(limit: number): UpdateHistory[];
  /** RL12: a rollback here halts that Version's Rollout; the fleet acts on the record (PR 6). */
  recordHalt(version: string, reason: string, at: number): void;
  /** Every halt recorded here, newest first. */
  halts(): { version: string; reason: string; at: number }[];
}

export interface SettingsSource { read(): UpdateSettings }
export interface Clock { now(): number }

// ---- the apply's own ports (§4.6); the adapters for the machine come with the apply's PR, tests fake them

// The machine's services (§4.6 ServiceManager). Adapters for systemd and launchd come in the next PR; tests fake it.
export interface ServiceManager {
  /** The Morndo services this machine runs, of hub, fleet, node. */
  services(): UpdateService[];
  stop(s: UpdateService): Promise<void>;
  start(s: UpdateService): Promise<void>;
  /** How many times the service manager restarted it since `since` (systemd NRestarts). */
  restarts(s: UpdateService): Promise<number>;
  /** Render the units of `version` and reload the manager (§6.2 step 6). */
  renderUnits(version: string): Promise<void>;
  /** RL13: true when the tmux server sits inside the node agent's unit. */
  tmuxInAgentUnit(): Promise<boolean>;
}
export interface RoleProbe {
  safePoint(s: UpdateService): Promise<SafePointReport | null>;
  health(s: UpdateService): Promise<HealthReport | null>;
}
export interface SchemaInspector {
  read(db: DatabaseName): DbState | null;
}
export type BackupResult = { ok: true; schema: number } | { ok: false; reason: string };
export interface Backup {
  take(updateId: string, db: DatabaseName): Promise<BackupResult>;
  has(updateId: string, db: DatabaseName): boolean;
  restore(updateId: string, db: DatabaseName): void;
  prune(keep: readonly string[]): void;
}
export interface HoldWriter {
  write(h: { services: UpdateService[]; reason: "drain" | "probation"; version: string; since: number }): void;
  clear(): void;
}
// §5's `applying` mark: present from the drain until the Update ends in a terminal state — committed, abandoned,
// rolled back, rollback_failed — and the only thing the recovery unit runs for. What keeps the mark is what keeps
// the record open: a rollback waiting on tmux, and an attempt a dead process left mid-step.
export interface ApplyingMarker {
  set(updateId: string): void;
  clear(): void;
  present(): boolean;
}
export interface Sleeper { sleep(ms: number): Promise<void> }
export type AlertKind =
  | "update_rolled_back" | "update_rollback_failed" | "update_rollback_waiting" | "update_deferred"
  | "update_unknown_record";
export interface AlertSink { raise(kind: AlertKind, detail: string): void }

// RL10, before the journals arrive (PR 5c): a restore must not undo a revocation. During a probation that may restore,
// the services still take revocations (RL9), and those rows live only in the database the restore would replace.
export interface Revocations {
  /** The ids revoked in the live database that are not revoked in this update's Backup of it: what a restore would
   *  bring back. Empty for a database that holds no revocations, or when there is no Backup to compare. */
  droppedBy(updateId: string, db: DatabaseName): string[];
}
