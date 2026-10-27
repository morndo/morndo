// In-memory fakes of the updater's ports (design §4.6) for the application's tests: they keep their state in memory,
// record every call, and delegate the unpack/promote/verify parts to the real DirsInstaller over a temporary
// releases directory — so "nothing is left" is a statement about a real file system, not about a mock's bookkeeping.
// The store mirrors the real one's ratchet (RL3); the artifacts mirror the real adapter's cap semantics.
import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  compareVersions, DEFAULT_CHANNEL, DEFAULT_MODE, parseVersion, TERMINAL_UPDATE_STATES,
  type Channel,
} from "@morndo/domain";
import { ARTIFACT_NAME } from "@morndo/protocol";
import { DirsInstaller } from "../../src/adapters/installer-dirs.ts";
import {
  FetchFailed, type ArtifactStore, type CheckRecord, type Clock, type Download, type FleetNode, type FleetView,
  type FleetWord,
  type Installer, type Layout, type MachineSettings, type ReleaseFeed, type SettingsSource, type Signed,
  type StagedRecord, type StoredUpdate, type TreeFinding, type TrustState, type UpdateHistory, type UpdateStateSink,
  type UpdateStore,
} from "../../src/application/ports.ts";
import type { UpdateStateFile } from "@morndo/protocol";

// Removes a directory tree however it is left: a promoted Version is read-only (files 0444, directories 0555, §5),
// and deleting needs the write bit back on every directory first.
export function wipe(path: string): void {
  const soften = (dir: string): void => {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, dirent.name);
      if (dirent.isDirectory()) { soften(full); chmodSync(full, 0o755); }
      else if (dirent.isFile()) chmodSync(full, 0o644);
    }
    chmodSync(dir, 0o755);
  };
  try { soften(path); } catch { /* not there */ }
  rmSync(path, { recursive: true, force: true });
}

// ---- the feed: documents served from memory, with the real adapter's caps

export class FakeFeed implements ReleaseFeed {
  /** version -> the document and its signature, or null for "not published" (HTTP 404). */
  readonly keySets = new Map<number, Signed | null>();
  readonly channels = new Map<Channel, Signed>();
  readonly manifests = new Map<string, Signed>();
  /** Make one operation throw this, as a dead or lying host would. */
  fail: { op: "keySet" | "channel" | "manifest"; error: FetchFailed } | null = null;
  readonly calls = { keySets: [] as number[], channels: [] as Channel[], manifests: [] as string[] };

  async keySet(version: number): Promise<Signed | null> {
    this.calls.keySets.push(version);
    if (this.fail?.op === "keySet") throw this.fail.error;
    return this.keySets.get(version) ?? null;
  }

  async channel(name: Channel): Promise<Signed> {
    this.calls.channels.push(name);
    if (this.fail?.op === "channel") throw this.fail.error;
    const signed = this.channels.get(name);
    if (signed === undefined) throw new FetchFailed("status", `HTTP 404 from https://feed.example.invalid/${name}.json`);
    if (signed.bytes.length > 64 * 1024) throw new FetchFailed("too_large", `${name}.json: over its 64 KiB cap`);
    return signed;
  }

  async manifest(url: string, maxBytes: number): Promise<Signed> {
    this.calls.manifests.push(url);
    if (this.fail?.op === "manifest") throw this.fail.error;
    const signed = this.manifests.get(url);
    if (signed === undefined) throw new FetchFailed("status", `HTTP 404 from ${url}`);
    // the real feed refuses a body over its cap outright (feed-https.ts): half a signed document is nothing
    if (signed.bytes.length > maxBytes) throw new FetchFailed("too_large", `${url}: over its ${maxBytes}-byte cap`);
    return signed;
  }
}

// ---- the artifacts: bytes served from memory into real files, capped like the real download

export type ServedArtifact = { bytes: Uint8Array; cutAt?: number; extra?: number };
export type FetchCall = { url: string; name: string; maxBytes: number; deadlineMs: number; size: number; overLimit: boolean; cut: boolean };

export class FakeArtifacts implements ArtifactStore {
  private readonly served = new Map<string, ServedArtifact>();
  readonly calls: FetchCall[] = [];
  readonly discards: string[] = [];
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /** `extra` is body the server has past the cap; `cutAt` ends the transfer early (never fetched whole). */
  serve(name: string, o: ServedArtifact): void { this.served.set(name, o); }

  /** Stops serving `name`, as a host that no longer has the asset would. */
  unserve(name: string): void { this.served.delete(name); }

  async fetch(url: string, o: { name: string; maxBytes: number; timeoutMs: number; deadlineMs: number }): Promise<Download> {
    if (!ARTIFACT_NAME.test(o.name)) throw new Error(`not a plain file name: ${o.name}`);   // the real adapter's rule
    const served = this.served.get(o.name);
    if (served === undefined) throw new FetchFailed("status", `HTTP 404 from ${url}`);
    const total = served.bytes.length + (served.extra ?? 0);
    const cut = served.cutAt !== undefined && served.cutAt < total;
    const size = cut ? Math.min(served.cutAt!, served.bytes.length)
      : Math.min(total, o.maxBytes, served.bytes.length);
    const path = join(this.dir, `${o.name}.part`);
    writeFileSync(path, served.bytes.subarray(0, size), { mode: 0o600 });
    const call = { url, name: o.name, maxBytes: o.maxBytes, deadlineMs: o.deadlineMs, size, overLimit: total > o.maxBytes, cut };
    this.calls.push(call);
    return { path, ...call };
  }

  discard(name: string): void {
    this.discards.push(name);
    rmSync(join(this.dir, `${name}.part`), { force: true });
  }

  /** The downloads still on disk — the "a failed staging leaves nothing" assertion. */
  downloads(): string[] { return readdirSync(this.dir).sort(); }
}

// ---- the installer: layout, shipped trust and self-test faked; unpack, promote and verify real

export class FakeInstaller implements Installer {
  layoutState: Layout = { method: "updater", current: "0.1.0", previous: null, good: null };
  /** trust/keys.json inside current, or null: the anchor when the store holds no key set. */
  shipped: Uint8Array | null = null;
  /** Set to a reason and self-test fails with it. */
  failSelftest: string | null = null;
  freeBytesValue = 1 << 40;
  readonly calls: { op: string; version?: string }[] = [];
  readonly dir: string;
  private readonly real: DirsInstaller;
  private readonly standing = new Set<string>();   // versions unpacked ok and not yet promoted or discarded

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.real = new DirsInstaller({ releases: dir });
  }

  layout(): Layout { this.calls.push({ op: "layout" }); return this.layoutState; }
  shippedKeySet(): Uint8Array | null { return this.shipped; }
  sweep(): void { this.calls.push({ op: "sweep" }); this.real.sweep(); }
  has(version: string): boolean { return this.real.has(version); }

  async unpack(archive: string, version: string, o: { filesSha256: string; maxBytes: number }):
    Promise<{ ok: true } | { ok: false; reason: string }> {
    this.calls.push({ op: "unpack", version });
    const done = await this.real.unpack(archive, version, o);
    if (done.ok) this.standing.add(version);
    return done;
  }

  async selftest(version: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    this.calls.push({ op: "selftest", version });
    if (this.failSelftest !== null) return { ok: false, reason: this.failSelftest };
    return this.standing.has(version) ? { ok: true } : { ok: false, reason: `${version}: nothing staged` };
  }

  promote(version: string, record: { manifestSha256: string; filesSha256: string; at: number }): void {
    this.calls.push({ op: "promote", version });
    this.standing.delete(version);
    this.real.promote(version, record);
  }

  discard(version: string): void {
    this.calls.push({ op: "discard", version });
    this.standing.delete(version);
    this.real.discard(version);
  }

  removeVersion(version: string): void {
    this.calls.push({ op: "removeVersion", version });
    this.real.removeVersion(version);
  }

  swap(pair: { current: string; previous: string | null }): void {
    this.calls.push({ op: "swap", version: pair.current });
    this.real.swap(pair);
  }

  swapBack(pair: { current: string; previous: string | null }): void {
    this.calls.push({ op: "swapBack", version: pair.current });
    this.real.swapBack(pair);
  }

  setGood(version: string): void {
    this.calls.push({ op: "setGood", version });
    this.real.setGood(version);
  }

  prune(keep: readonly string[]): void {
    this.calls.push({ op: "prune" });
    this.real.prune(keep);
  }

  verifyTree(version: string, filesSha256: string | null): Promise<TreeFinding[]> {
    return this.real.verifyTree(version, filesSha256);
  }

  installRecord(version: string): { manifestSha256: string | null } | null { return this.real.installRecord(version); }

  freeBytes(): number { return this.freeBytesValue; }
}

// ---- the store: the real one's ratchet and queries, none of its SQL

export class FakeStore implements UpdateStore {
  private trustState: TrustState = { keySet: null, highestFeedSeq: { stable: 0, latest: 0 } };
  /** A case may empty these to stand a machine the real check never leaves (no record, no checks at all). */
  readonly versions = new Map<string, StagedRecord>();
  readonly checkLog: CheckRecord[] = [];
  private readonly committedList: string[] = [];
  private readonly committedBaselines: (Record<string, string[]> | null)[] = [];
  private readonly badList: string[] = [];
  private held: { release(): void } | null = null;
  /** Flip to true and tryLock answers null, as another process holding the lock would. */
  heldByAnother = false;
  /** Every call, in order, for assertions about what was saved and when. */
  readonly calls: string[] = [];

  tryLock(): { release(): void } | null {
    this.calls.push("tryLock");
    if (this.heldByAnother || this.held !== null) return null;
    this.held = { release: () => { this.held = null; this.calls.push("release"); } };
    return this.held;
  }

  trust(): TrustState {
    return { keySet: this.trustState.keySet, highestFeedSeq: { ...this.trustState.highestFeedSeq } };
  }

  // RL3, as the SQLite store ratchets: a key set version and a feed number never move backwards, whatever this is
  // given — an older set, an empty one, a lower number.
  saveTrust(t: TrustState): void {
    const stored = this.trustState;
    const keySet = stored.keySet !== null && (t.keySet === null || t.keySet.version < stored.keySet.version)
      ? stored.keySet
      : t.keySet;
    this.trustState = {
      keySet,
      highestFeedSeq: {
        stable: Math.max(stored.highestFeedSeq.stable, t.highestFeedSeq.stable),
        latest: Math.max(stored.highestFeedSeq.latest, t.highestFeedSeq.latest),
      },
    };
    this.calls.push(`saveTrust(key set ${keySet === null ? "none" : keySet.version}, stable ${this.trustState.highestFeedSeq.stable})`);
  }

  /** What the apply writes; the check service only reads it. */
  recordCommitted(version: string, _at: number, baseline: Record<string, string[]> | null = null): void {
    this.committedList.push(version);
    this.committedBaselines.push(baseline);
    this.calls.push(`recordCommitted(${version})`);
  }

  /** §6.7: the last commit's recorded baseline, as the SQLite store answers it. */
  commitBaseline(): Record<string, string[]> | null {
    return this.committedBaselines.at(-1) ?? null;
  }

  recordBad(version: string, _at: number): void {
    this.badList.push(version);
    this.calls.push(`recordBad(${version})`);
  }

  // The step record (RL4), mirrored: save before the step runs, finish ends the attempt.
  readonly updates: UpdateHistory[] = [];

  saveUpdate(u: StoredUpdate): void {
    const at = this.updates.findIndex(row => row.id === u.id);
    if (at === -1) this.updates.push({ ...u, finishedAt: null });
    else this.updates[at] = { ...u, finishedAt: this.updates[at]!.finishedAt };
    this.calls.push(`saveUpdate(${u.id} ${u.state})`);
  }

  openUpdate(): StoredUpdate | null {
    const live = this.updates.filter(row => !(TERMINAL_UPDATE_STATES as readonly string[]).includes(row.state));
    if (live.length === 0) return null;
    const newest = live.reduce((best, row) => (row.startedAt >= best.startedAt ? row : best));
    const { finishedAt: _ended, ...open } = newest;   // the end is null by definition while it runs
    return open;
  }

  finishUpdate(id: string, state: UpdateHistory["state"], at: number): void {
    const row = this.updates.find(r => r.id === id);
    if (row === undefined) throw new Error(`${id}: no update to finish`);
    row.state = state;
    row.finishedAt = at;
    this.calls.push(`finishUpdate(${id} ${state})`);
  }

  readonly haltRows: { version: string; reason: string; at: number }[] = [];
  recordHalt(version: string, reason: string, at: number): void { this.haltRows.unshift({ version, reason, at }); }
  halts(): { version: string; reason: string; at: number }[] { return [...this.haltRows]; }

  // §7's drawn delay, as the SQLite store keeps it: drawn once per Version, kept whatever later draws say.
  readonly jitterRows = new Map<string, number>();
  jitterOf(version: string): number | null { return this.jitterRows.get(version) ?? null; }
  recordJitter(version: string, until: number): void {
    if (!this.jitterRows.has(version)) this.jitterRows.set(version, until);
  }
  readonly alertsSent = new Set<string>();
  firstAlert(updateId: string, kind: string): boolean {
    const key = `${updateId} ${kind}`;
    if (this.alertsSent.has(key)) return false;
    this.alertsSent.add(key);
    return true;
  }

  recentUpdates(limit: number): UpdateHistory[] {
    return [...this.updates].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
  }

  highestCommitted(): string | null {
    return this.committedList.reduce<string | null>((best, version) => {
      const v = parseVersion(version);
      if (v === null) return best;
      return best !== null && compareVersions(v, parseVersion(best)!) <= 0 ? best : version;
    }, null);
  }

  badVersions(): string[] { return [...this.badList]; }

  recordStaged(r: StagedRecord): void {
    this.versions.set(r.version, r);
    this.calls.push(`recordStaged(${r.version})`);
  }

  staged(): StagedRecord | null {
    const committed = this.highestCommitted();
    const ceiling = committed === null ? null : parseVersion(committed);
    let best: StagedRecord | null = null;
    for (const record of this.versions.values()) {
      const v = parseVersion(record.version);
      if (v === null) continue;
      if (ceiling !== null && compareVersions(v, ceiling) <= 0) continue;
      if (best !== null && compareVersions(v, parseVersion(best.version)!) <= 0) continue;
      best = record;
    }
    return best;
  }

  // A named `--to` is the staged Version. Drop only a record above both it and the highest committed Version;
  // one at or below the highest this machine has run stays, the same as the SQLite store.
  retireStagedAbove(version: string): void {
    const keep = parseVersion(version);
    if (keep === null) return;
    const committed = this.highestCommitted();
    const ceiling = committed === null ? null : parseVersion(committed);
    const floor = ceiling !== null && compareVersions(ceiling, keep) > 0 ? ceiling : keep;
    for (const staged of [...this.versions.keys()]) {
      const v = parseVersion(staged);
      if (v !== null && compareVersions(v, floor) > 0) this.versions.delete(staged);
    }
  }

  versionRecord(version: string): StagedRecord | null { return this.versions.get(version) ?? null; }

  manifestOf(version: string): string | null { return this.versions.get(version)?.manifest ?? null; }

  recordCheck(r: CheckRecord): void {
    this.checkLog.push(r);
    this.calls.push(`recordCheck(${r.outcome})`);
  }

  checks(limit: number): CheckRecord[] { return [...this.checkLog].reverse().slice(0, limit); }

  // The newest row with the feed's word, any age: the real store's own query, mirrored.
  lastFeedCheck(): CheckRecord | null {
    return [...this.checkLog].reverse().find(row => row.feedSeq !== null && row.feedExpiresAt !== null) ?? null;
  }
}

// ---- settings, clock, and the fleet's word

export const DEFAULT_SETTINGS: MachineSettings = {
  channel: DEFAULT_CHANNEL, mode: DEFAULT_MODE, pin: null, window: null, soakMinutes: null,
};

export class FakeSettings implements SettingsSource {
  value: MachineSettings;
  constructor(value: MachineSettings = DEFAULT_SETTINGS) { this.value = value; }
  read(): MachineSettings { return this.value; }
}

export class FakeClock implements Clock {
  nowMs: number;
  constructor(nowMs: number) { this.nowMs = nowMs; }
  now(): number { return this.nowMs; }
}

// The fleet's word (§7), as a test stands it: what view() says, what nodes() answers (the control plane's skew gate,
// RL11), and the log of every read — the fleet has no write door for the updater anymore (the state file is its only
// word out), so `calls` is how a test proves nothing else was asked. thrown flips either read into the unreachable
// fleet a deferral must outlast.
export class FakeFleetView implements FleetView {
  word: FleetWord | null = null;
  nodesWord: FleetNode[] | null = null;
  throwView = false;
  throwNodes = false;
  /** Every fleet read, in order: "view" and "nodes". A write would have nowhere to land. */
  readonly calls: string[] = [];

  async view(): Promise<FleetWord | null> {
    this.calls.push("view");
    if (this.throwView) throw new Error("the fleet cannot be asked");
    return this.word;
  }
  async nodes(): Promise<FleetNode[] | null> {
    this.calls.push("nodes");
    if (this.throwNodes) throw new Error("the fleet cannot be asked");
    return this.nodesWord;
  }
}

// The state file's sink (§6.3), recording what was written instead of writing it.
export class FakeStateSink implements UpdateStateSink {
  readonly written: UpdateStateFile[] = [];
  write(s: UpdateStateFile): void { this.written.push(s); }
}
