// Releases and updates (ADR-0019; docs/design/updates/README.md §3–§7, the design this module is the domain of).
// One Version for the whole product, published once as a Release, offered on a Channel through a signed ChannelFeed,
// applied to one Installation at a safe point, and rolled back when a health check fails. This file holds the
// language, RL1–RL14, the Update state machine, the recovery table and the fleet's rollout and skew rules. It is
// pure: no signature is verified here (the Verifier port reports facts: "these bytes verify under this key, under
// that namespace"), no service is stopped, no store is opened, and no clock is read — every function takes `now`.
import { err, ok, type Result } from "./shared.ts";

// ---- Version (SemVer 2.0.0; https://semver.org/#spec-item/11, read 2026-10-11)

export type Version = { major: number; minor: number; patch: number; pre: string[] | null; build: string | null };
const CORE = /^(0|[1-9]\d*)$/;                 // numeric identifiers carry no leading zeros
const IDENT = /^[0-9A-Za-z-]+$/;               // alphanumeric identifiers, hyphens included

const identifiers = (part: string, isPre: boolean): string[] | null => {
  const out: string[] = [];
  for (const id of part.split(".")) {
    if (!IDENT.test(id)) return null;
    if (isPre && /^\d+$/.test(id) && !CORE.test(id)) return null;   // a numeric pre-release identifier: no leading zero
    out.push(id);
  }
  return out;
};

export function parseVersion(s: string): Version | null {
  const plus = s.indexOf("+");
  const build = plus === -1 ? null : s.slice(plus + 1);
  const core = plus === -1 ? s : s.slice(0, plus);
  const dash = core.indexOf("-");
  const pre = dash === -1 ? null : core.slice(dash + 1);
  const triple = (dash === -1 ? core : core.slice(0, dash)).split(".");
  if (triple.length !== 3 || !triple.every(n => CORE.test(n))) return null;
  const preIds = pre === null ? null : identifiers(pre, true);
  const buildIds = build === null ? null : identifiers(build, false);
  if (preIds === null && pre !== null) return null;              // an invalid pre-release (empty parts fail above)
  if (buildIds === null && build !== null) return null;          // an invalid build
  return { major: Number(triple[0]), minor: Number(triple[1]), patch: Number(triple[2]), pre: preIds, build };
}

// Precedence per §11: numeric identifiers numerically and below alphanumeric ones, alphanumeric in ASCII order, a
// longer pre-release above its own prefix, no pre-release above any, and build metadata deciding nothing. The
// answer is -1, 0 or 1 — the sign, never the distance.
export function compareVersions(a: Version, b: Version): number {
  return Math.sign(comparePrecedence(a, b));
}
function comparePrecedence(a: Version, b: Version): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.pre === null && b.pre === null) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined) return -1;                    // a shorter prefix ranks lower
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) { const byNumber = Number(x) - Number(y); if (byNumber !== 0) return byNumber; }
    else if (xn !== yn) return xn ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
export const equalVersions = (a: Version, b: Version): boolean => compareVersions(a, b) === 0;
export const higherOf = (a: Version, b: Version): Version => (compareVersions(a, b) >= 0 ? a : b);
export function formatVersion(v: Version): string {
  const core = `${v.major}.${v.minor}.${v.patch}`;
  return `${v.pre === null ? core : `${core}-${v.pre.join(".")}`}${v.build === null ? "" : `+${v.build}`}`;
}

// ---- Channels and settings (§8.3; the owner's answers Q1 and Q2, 2026-10-11)

export const CHANNELS = ["stable", "latest"] as const;
export type Channel = (typeof CHANNELS)[number];
export const UPDATE_MODES = ["apply", "stage", "off"] as const;
export type UpdateMode = (typeof UPDATE_MODES)[number];
// Q2: stable by default — "a release is 7 days on latest before stable takes it".
export const DEFAULT_CHANNEL: Channel = "stable";
// Q1: apply by default — "at a quiet safe point", not staged and left.
export const DEFAULT_MODE: UpdateMode = "apply";

// A window in minutes of the local day, `end` exclusive; it may wrap past midnight.
export type Window = { start: number; end: number };
export function windowContains(w: Window, localMinutes: number): boolean {
  return w.start < w.end ? localMinutes >= w.start && localMinutes < w.end
    : localMinutes >= w.start || localMinutes < w.end;
}

// ---- Trust (RL3): the Key set and the ChannelFeed

// A key is named by its fingerprint; the domain never sees key bytes. `expiresAt`: ms since epoch. `schema` is the
// document's format number (§9.6: keys.json), carried so a future format is told apart, not guessed at (§6.6).
export type KeySet = { schema: 1; version: number; expiresAt: number; root: string[]; release: string[]; feed: string[] };
// What the Verifier reported about one offered Key set: which keys signed it (facts, not trust).
export type OfferedKeySet = { set: KeySet; signedBy: string[] };

// The walk (§5): one version at a time from the trusted one, each signed by a root of the set before it, and a
// change of root signed by a root of the new set too. An expired set may vouch for the next; the newest must be
// unexpired. Anything else is refused loudly (KeysExpired, or the caller's Alert), never taken on trust anyway.
export function acceptKeySets(have: KeySet | null, offered: OfferedKeySet[], now: number):
  Result<KeySet, "empty" | "gap" | "older" | "unsigned_by_root" | "root_change_one_side" | "expired"> {
  if (offered.length === 0) return err("empty");
  const at = have?.version ?? 0;
  for (let i = 0; i < offered.length; i++) {
    const step = offered[i]!;
    const prevRoots = i === 0 ? (have?.root ?? []) : offered[i - 1]!.set.root;
    if (step.set.version <= at) return err("older");                        // never rolls back, even within a list
    if (step.set.version !== at + i + 1) return err("gap");                 // one version at a time, no jumps
    if (!step.signedBy.some(k => prevRoots.includes(k))) return err("unsigned_by_root");
    const rootsChanged = have !== null || i > 0 ? !sameKeys(prevRoots, step.set.root) : false;
    if (rootsChanged && !step.signedBy.some(k => step.set.root.includes(k))) return err("root_change_one_side");
  }
  const newest = offered[offered.length - 1]!.set;
  if (now >= newest.expiresAt) return err("expired");
  return ok(newest);
}
const sameKeys = (a: string[], b: string[]): boolean => a.length === b.length && a.every(k => b.includes(k));

export type FeedEntry = { version: string; manifest: string; manifestSize: number; manifestSha256: string };
export type ChannelFeed = {
  schema: 1; channel: Channel; seq: number; issuedAt: number; expiresAt: number; keySetVersion: number;
  releases: FeedEntry[]; withdrawn: string[];
};

// The ChannelFeed rules (RL3's forward motion): the channel asked for, a seq at or above the highest ever seen, unexpired,
// and signed by the trusted Key set. The signature itself is the Verifier's fact, a step in the chain below.
export function acceptFeed(feed: ChannelFeed, ask: { channel: Channel; highestSeq: number; keySetVersion: number }, now: number):
  Result<ChannelFeed, "wrong_channel" | "older" | "stale" | "other_key_set"> {
  if (feed.channel !== ask.channel) return err("wrong_channel");
  if (feed.seq < ask.highestSeq) return err("older");                      // FeedRollbackRefused
  if (now >= feed.expiresAt) return err("stale");                          // FeedStale
  if (feed.keySetVersion !== ask.keySetVersion) return err("other_key_set");
  return ok(feed);
}

// ---- The verification chain (RL1): verified before unpacked, in this order, with no flag that skips a check

export const VERIFICATION_STEPS = ["feed_signature", "feed_namespace", "feed_channel", "feed_fresh", "feed_seq",
  "manifest_version", "manifest_digest", "manifest_signature", "manifest_namespace", "artifact_size",
  "artifact_digest", "file_list"] as const;
export type VerificationStep = (typeof VERIFICATION_STEPS)[number];

// `facts` carries the Verifier's and the downloader's outcomes, one boolean per step. The first false — or the
// first missing one, for a step this build doesn't know how to report is a step that didn't run — names the
// failure (VerificationFailed). The digest steps pin the Manifest to the ChannelFeed entry's own values, so `--to`
// cannot route around the ChannelFeed.
export function judgeVerification(facts: Partial<Record<VerificationStep, boolean>>): Result<true, VerificationStep> {
  for (const step of VERIFICATION_STEPS) if (facts[step] !== true) return err(step);
  return ok(true);
}

// ---- The Installation (RL2, RL3, RL14) and admission

export type InstallMethod = "updater" | "checkout" | "package";
export type UpdateSettings = { channel: Channel; mode: UpdateMode; pin: Version | null; window: Window | null };
export type Installation = {
  current: Version; previous: Version | null; staged: Version | null;
  badVersions: Version[]; highestCommitted: Version;
  keySet: KeySet | null; highestFeedSeq: { stable: number; latest: number };
  installMethod: InstallMethod; settings: UpdateSettings;
};
export type EnvSwitches = { disableAutoUpdate: boolean; disableUpdates: boolean };
export type PrincipalAsk =
  | { kind: "auto" }                                                        // a background check and apply
  | { kind: "to"; version: Version; allowDowngrade: boolean }               // morndo update [--to <version>]
  | { kind: "rollback" };                                                   // morndo update --rollback (§8.1)

// UpdateSkipped's reasons (§4.5), `skew` excluded: that refusal comes from skew() itself, with its own naming.
export const SKIP_REASONS = ["not_newer", "pinned", "disabled", "withdrawn", "bad_here", "skew", "halted"] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];
export type AdmissionRefusal = "updates_disabled" | "not_our_install" | "downgrade_refused" | "no_entry";

// May this Version be staged here? The switches first (RL14: they win over everything), then the machine's own
// memory (the bad Versions always; the pin, the withdrawn and the halted Rollout, RL12, only for a Version the
// feed offers or the principal names), then the order (RL2: automatic only above every committed Version; a
// lower one only named by the principal, with --allow-downgrade or --rollback). Every path but `--rollback`
// needs an offered ChannelFeed entry (RL1) — including `--to`: the entry's digests are what gets verified; the
// rollback's target is the Version already on this machine's disk.
export function admit(p: {
  machine: Installation; switches: EnvSwitches; ask: PrincipalAsk;
  offered: { version: Version; feed: ChannelFeed } | null;      // the best verified entry the machine's channel offers
  rolloutHalted: boolean;                                // the Rollout for the offered Version, if one exists
}): Result<Version, SkipReason | AdmissionRefusal> {
  const { machine, switches, ask } = p;
  if (switches.disableUpdates) return err("updates_disabled");               // MORNDO_DISABLE_UPDATES: every path
  if (machine.installMethod !== "updater") return err("not_our_install");    // a checkout or a package is not ours to change
  if (ask.kind === "auto" && (switches.disableAutoUpdate || machine.settings.mode === "off")) return err("disabled");

  const target = ask.kind === "to" ? ask.version : ask.kind === "rollback" ? machine.previous : p.offered?.version ?? null;
  if (target === null) return err(ask.kind === "auto" ? "not_newer" : "no_entry");
  // The machine's memory of what failed here (RL7) holds for every move to a Version, a rollback's included.
  if (machine.badVersions.some(bad => equalVersions(bad, target))) return err("bad_here");
  // The feed's word and the holds — a pin (RL14), a withdrawal, a halt (RL12) — guard moving TO a Version. They
  // never guard moving away from one: the principal's `--rollback` (§8.1) is the escape from exactly a halted,
  // pinned or withdrawn Version, back to the one already on disk, and RL12 halts automatic applies only.
  if (ask.kind !== "rollback") {
    if (machine.settings.pin !== null && !equalVersions(target, machine.settings.pin)) return err("pinned");
    if (p.offered !== null && p.offered.feed.withdrawn.includes(formatVersion(target))) return err("withdrawn");
    if (p.rolloutHalted) return err("halted");
  }

  if (ask.kind === "auto") {
    if (compareVersions(target, machine.highestCommitted) <= 0) return err("not_newer");   // a switch or a lesser feed never moves down
    return ok(target);
  }
  if (ask.kind === "to") {
    if (p.offered === null || !equalVersions(p.offered.version, ask.version)) return err("no_entry");
    if (equalVersions(ask.version, machine.current)) return err("not_newer");              // already there: nothing to do
    if (compareVersions(ask.version, machine.current) < 0 && !ask.allowDowngrade) return err("downgrade_refused");
    return ok(ask.version);
  }
  if (machine.previous === null) return err("no_entry");                                   // nothing to roll back to
  return ok(machine.previous);
}

// What a commit writes back into the Installation: the pair moves, and the highest committed Version only ever
// rises — a rollback doesn't license the auto path to re-take what it left (RL2).
export function commitInstallation(i: Installation, to: Version): Installation {
  return { ...i, current: to, previous: i.current, staged: null, highestCommitted: higherOf(i.highestCommitted, to) };
}
// A rollback marks its target bad on this machine (RL7), so nothing auto-installs it again here.
export function markBadHere(i: Installation, version: Version): Installation {
  return i.badVersions.some(bad => equalVersions(bad, version)) ? i : { ...i, badVersions: [...i.badVersions, version] };
}

// ---- The Migration plan (RL5, RL8)

export const DATABASES = ["hub", "fleet", "node", "connections"] as const;
export type DatabaseName = (typeof DATABASES)[number];
// What a Manifest states for one database (target), or what the SchemaInspector read (what is there).
export type SchemaInfo = { version: number; floor: number };
export type DbState = { schema: number; floor: number };
export type MigrationStep = {
  willMigrate: boolean;        // the target's schema is above what's there
  backupRequired: boolean;     // RL5: a Backup, integrity-checked, before anything swaps
  expectedSchema: number;      // the schema the Backup must check against (what's there now)
  restoreOnRollback: boolean;  // RL8: after migrating, the previous Version can't open it — a rollback must restore
};

// The plan from the Manifest's schemas and what the databases say. `previous` is the running Version's Manifest
// (null on a first update, where what's running reads what's there). A target that cannot open what is there —
// its known schema below the database's floor (§11.1) — is refused, never planned: RL8's "the updater never swaps
// to a Version that would meet that refusal" starts here, before any Backup is taken or anything stops.
export function planMigrations(p: {
  databases: Record<DatabaseName, DbState>; target: Record<DatabaseName, SchemaInfo>;
  previous: Record<DatabaseName, SchemaInfo> | null;
}): Result<Record<DatabaseName, MigrationStep>, { database: DatabaseName; reason: "target_below_floor" }> {
  const out = {} as Record<DatabaseName, MigrationStep>;
  for (const db of DATABASES) {
    const now = p.databases[db], target = p.target[db];
    if (target.version < now.floor) return err({ database: db, reason: "target_below_floor" });
    const willMigrate = target.version > now.schema;
    const previousKnows = p.previous === null ? now.schema : p.previous[db].version;
    out[db] = { willMigrate, backupRequired: willMigrate, expectedSchema: now.schema,
      restoreOnRollback: target.floor > previousKnows };
  }
  return ok(out);
}

export type BackupRecord = { database: DatabaseName; done: boolean; passedCheck: boolean; schema: number | null };

// The gate before the swap (RL5): every database the plan migrates has a Backup, taken, integrity-checked, and at
// the schema it was at. The first one that isn't names itself, and nothing has moved yet.
export function maySwap(plan: Record<DatabaseName, MigrationStep>, backups: BackupRecord[]):
  Result<true, { database: DatabaseName; reason: "backup_missing" | "backup_failed" | "backup_wrong_schema" }> {
  for (const db of DATABASES) {
    if (!plan[db].backupRequired) continue;
    const backup = backups.find(b => b.database === db);
    if (!backup || !backup.done) return err({ database: db, reason: "backup_missing" });
    if (!backup.passedCheck) return err({ database: db, reason: "backup_failed" });
    if (backup.schema !== plan[db].expectedSchema) return err({ database: db, reason: "backup_wrong_schema" });
  }
  return ok(true);
}
export function rollbackRestores(plan: Record<DatabaseName, MigrationStep>): DatabaseName[] {
  return DATABASES.filter(db => plan[db].restoreOnRollback);
}
// A rollback below a raised floor with the Backup gone is refused (RL8): the old Version must not open a database
// above its floor, and there is nothing left to put back.
export function mayRestore(p: { database: DatabaseName; restoreOnRollback: boolean; backupPresent: boolean }):
  Result<true, "not_required" | "backup_gone"> {
  if (!p.restoreOnRollback) return err("not_required");
  if (!p.backupPresent) return err("backup_gone");
  return ok(true);
}

// ---- Probation holds (RL9) and the restore guard (RL10)

export const HOLD_STALE_MS = 10 * 60_000;   // a hold older than this is ignored, with an Alert (§5, hold.json)
export const HELD_WRITE_KINDS = ["command", "decision", "board_write", "pairing", "operation", "hook_ack",
  "keyed_operation", "console_write"] as const;
export type HeldWriteKind = (typeof HELD_WRITE_KINDS)[number];

// From start until commit, when a rollback would restore a database, every write but a revocation is refused
// (RL9). "updating" is the refusal the caller translates: HTTP 503 with Retry-After, `executed: "no"`, exit 75.
export function holdsWrites(plan: Record<DatabaseName, MigrationStep>): boolean {
  return DATABASES.some(db => plan[db].restoreOnRollback);
}
export function writeDuringHold(kind: HeldWriteKind | "revocation", holdSince: number, now: number): "updating" | "allowed" {
  if (kind === "revocation") return "allowed";                              // the one write a hold passes (RL10)
  return now - holdSince > HOLD_STALE_MS ? "allowed" : "updating";           // a dead updater can't hold forever
}

// The revocation journal beside each database (RL10): applied at every start, idempotently, so a restored database
// can't bring back a revoked device, agent token or node, whoever restored it and however old the Backup.
export function applyRevocationJournal(active: readonly string[], journal: readonly string[]): string[] {
  return active.filter(id => !journal.includes(id));
}

// The hub's answer after a restore (RL10, amending S5): a Command this store stamped was typed (a retry of an id
// the hub still holds is a duplicate); a Command stamped with another store is never typed — `uncertain`, whether
// the hub holds its id or not, and the principal's Retry settles it (S7). No clock decides this (FL13).
export function hubAnswerAfterRestore(p: { hubStore: string; stampedStore: string; held: boolean }):
  "typed" | "duplicate" | "uncertain" {
  if (p.stampedStore === p.hubStore) return p.held ? "duplicate" : "typed";
  return "uncertain";
}

// ---- The safe point (RL6)

// A service reports its blockers: work in flight in the running service, never a row a crash left behind (S5 and
// FL7 already answer those `uncertain`, and counting them would block updates for days — §6.3).
export type SafePointReport = { service: string; blockers: string[] };
export type SafeWait = { kind: "in_flight"; service: string; blocker: string } | { kind: "attending" } | { kind: "window" };

// A machine is at a safe point when no service reports a blocker. An automatic update of a machine that runs the
// hub also waits until no one is attending, and for its window. `--now` (`now: true`) lifts only those two waits —
// work in flight is never skipped.
export function safeToApply(p: {
  reports: SafePointReport[]; automatic: boolean; machineRunsHub: boolean; attending: boolean;
  window: Window | null; localMinutes: number; now: boolean;
}): Result<true, SafeWait[]> {
  const waits: SafeWait[] = [];
  for (const report of p.reports) for (const blocker of report.blockers)
    waits.push({ kind: "in_flight", service: report.service, blocker });
  if (p.automatic && p.machineRunsHub && p.attending && !p.now) waits.push({ kind: "attending" });
  if (p.automatic && !p.now && p.window !== null && !windowContains(p.window, p.localMinutes)) waits.push({ kind: "window" });
  return waits.length === 0 ? ok(true) : err(waits);
}

// ---- Health and probation (RL7)

export const HEALTH_DEADLINE_MS = 90_000;   // the services have this long to answer for their health (§6.4)
export const PROBATION_MS = 60_000;         // and this long up, without a restart, before the commit (§6.4)
export type HealthReport = { service: string; version: string; checks: Record<string, boolean> };

// What passed before must pass after; what failed before is not held against the target. A service that doesn't
// answer within the deadline fails as `no_report`. A failure names its service and check (HealthFailed) and means
// rollback. One laptop that went to sleep is the caller's care: its missing report is the fleet's, not this
// machine's — the caller judges only what this machine runs.
export function judgeHealth(p: { baseline: Record<string, string[]>; after: HealthReport[] }):
  Result<true, { service: string; check: string }> {
  const byService = new Map(p.after.map(r => [r.service, r]));
  for (const [service, checks] of Object.entries(p.baseline)) {
    const report = byService.get(service);
    if (!report) return err({ service, check: "no_report" });
    for (const check of checks) if (report.checks[check] !== true) return err({ service, check });
  }
  return ok(true);
}
export function judgeProbation(p: { upMs: number; restarts: number }): Result<true, "not_up" | "restarted"> {
  if (p.upMs < PROBATION_MS) return err("not_up");
  if (p.restarts > 0) return err("restarted");
  return ok(true);
}

// ---- Skew (RL11) and the Rollout (RL12)

export type NodeView = { name: string; version: Version | null; agentProtocol: number | null; joined: boolean; revoked: boolean };
export type SkewRefusal = { reason: "node_ahead" } | { reason: "protocol_dropped"; nodes: string[] };

// May this machine apply this Version, given the control plane and the nodes? A node never applies above its
// control plane. The control plane defers a Release that drops an agent protocol a joined, non-revoked node still
// depends on — the Manifest's protocol range decides, so no knowledge of what changed is needed — and names them.
export function skew(p: {
  machine: "node" | "control_plane"; controlPlane: Version; nodes: NodeView[];
  target: Version; targetProtocol: { agent: [number, number]; clientApi: [number, number] };
}): Result<true, SkewRefusal> {
  if (p.machine === "node" && compareVersions(p.target, p.controlPlane) > 0) return err({ reason: "node_ahead" });
  if (p.machine === "control_plane") {
    const [min, max] = p.targetProtocol.agent;
    const cut = p.nodes.filter(n => n.joined && !n.revoked && n.agentProtocol !== null
      && (n.agentProtocol < min || n.agentProtocol > max)).map(n => n.name);
    if (cut.length > 0) return err({ reason: "protocol_dropped", nodes: cut });
  }
  return ok(true);
}

export const DEFAULT_SOAK_MINUTES = 30;        // the control plane's soak before any node applies (§7)
export const NODE_JITTER_MAX_MS = 15 * 60_000; // and each node's own random delay stays under this (§7)
export type Rollout = {
  version: Version;
  controlPlaneCommittedAt: number | null;
  soakMinutes: number;
  halted: boolean;
  haltedBy: string | null;                     // the machine whose rollback halted it
  nodes: Record<string, { jitterUntil: number | null }>;   // each node's drawn delay; its applied state is its own Installation's
};

// One machine's rollback halts the Version fleet-wide (RL12); the principal's word resumes it. A halt stays until
// then — a newer Release supersedes it simply by being another Version, with a Rollout of its own.
export function haltRollout(r: Rollout, byMachine: string): Rollout {
  return r.halted ? r : { ...r, halted: true, haltedBy: byMachine };
}
export function resumeRollout(r: Rollout): Rollout {
  return { ...r, halted: false, haltedBy: null };
}

// A node applies once its control plane runs the target or newer, the Rollout isn't halted, the soak has passed,
// and its own drawn delay is up.
export function nodeMayApply(p: { rollout: Rollout; node: string; controlPlane: Version; now: number }):
  Result<"apply", "not_committed" | "waiting_control_plane" | "halted" | "waiting_soak" | "waiting_jitter"> {
  const { rollout } = p;
  if (rollout.controlPlaneCommittedAt === null) return err("not_committed");
  if (compareVersions(p.controlPlane, rollout.version) < 0) return err("waiting_control_plane");
  if (rollout.halted) return err("halted");
  if (p.now < rollout.controlPlaneCommittedAt + rollout.soakMinutes * 60_000) return err("waiting_soak");
  const jitter = rollout.nodes[p.node]?.jitterUntil ?? null;
  if (jitter !== null && p.now < jitter) return err("waiting_jitter");
  return ok("apply");
}

// ---- Scope (RL13): Morndo updates only itself, and grants nothing

export const UPDATE_SCOPE_SERVICES = ["hub", "fleet", "node"] as const;
export type UpdateService = (typeof UPDATE_SCOPE_SERVICES)[number];

// An Update stops, swaps and starts only Morndo's own services. Anything else a step names — a lane, tmux, another
// program — is outside the scope and refused, before it runs.
export function updateTouches(services: readonly string[]): Result<UpdateService[], { outside: string }> {
  const out: UpdateService[] = [];
  for (const name of services) {
    if (!(UPDATE_SCOPE_SERVICES as readonly string[]).includes(name)) return err({ outside: name });
    if (!out.includes(name as UpdateService)) out.push(name as UpdateService);
  }
  return ok(out);
}
// Before every stop of the node agent — a rollback's included — the tmux server must not sit inside the agent's
// unit. If it does, that node's stop waits, with a critical Alert; its lanes keep running.
export function mayStopNodeAgent(p: { tmuxInAgentUnit: boolean }): Result<true, "tmux_in_agent_unit"> {
  return p.tmuxInAgentUnit ? err("tmux_in_agent_unit") : ok(true);
}

// ---- The Update state machine (§4.4) and recovery (§6.6)

export const UPDATE_STATES = ["checked", "staged", "draining", "stopping", "backing_up", "swapping", "starting",
  "probation", "committed", "skipped", "abandoned", "rolling_back", "rolled_back", "rollback_failed"] as const;
export type UpdateState = (typeof UPDATE_STATES)[number];
// The marks the step record holds (§6.2): each mutating step is recorded started before it runs, and done after.
export const UPDATE_MARKS = ["draining", "stopping", "backing_up", "swapping", "starting", "committing", "rolling_back"] as const;
export type UpdateMark = (typeof UPDATE_MARKS)[number];
export const TERMINAL_UPDATE_STATES = ["committed", "skipped", "abandoned", "rolled_back", "rollback_failed"] as const;

// The diagram's edges (§4.4). Before `swapping` is done, any failure abandons; from then on, it rolls back. A
// manual `--rollback` after a commit is its own Update, begun at `rolling_back` (§8.1), not a move out of
// `committed`.
const UPDATE_MOVES: Readonly<Record<UpdateState, readonly UpdateState[]>> = {
  checked: ["staged", "skipped"],
  staged: ["draining", "abandoned"],
  draining: ["stopping", "abandoned"],
  stopping: ["backing_up", "abandoned"],
  backing_up: ["swapping", "abandoned"],
  swapping: ["starting", "rolling_back"],
  starting: ["probation", "rolling_back"],
  probation: ["committed", "rolling_back"],
  committed: [], skipped: [], abandoned: [], rolled_back: [], rollback_failed: [],
  rolling_back: ["rolled_back", "rollback_failed"],
};
export const updateCanMove = (from: UpdateState, to: UpdateState): boolean => UPDATE_MOVES[from].includes(to);

export type Update = {
  id: string;
  kind: "update" | "rollback";
  target: Version;
  preUpdate: { current: Version; previous: Version | null };   // the pair a rollback puts back (§6.5)
  state: UpdateState;
  mark: UpdateMark | null;                                     // the last step recorded started
  backups: BackupRecord[];
  migrations: Record<DatabaseName, MigrationStep> | null;
};

// One attempt to move this Installation from one Version to another, already staged (RL4: the caller holds the
// apply lock before it begins; nothing else may act on the machine meanwhile).
export function beginUpdate(p: { id?: string; target: Version; machine: Installation }): Update {
  return { id: p.id ?? "", kind: "update", target: p.target,
    preUpdate: { current: p.machine.current, previous: p.machine.previous },
    state: "staged", mark: null, backups: [], migrations: null };
}
// The principal's rollback of a committed Version (§8.1): its own Update, whose first recorded mark is
// `rolling_back`, written before anything stops.
export function beginRollback(p: { id?: string; machine: Installation }): Update {
  const previous = p.machine.previous ?? p.machine.current;
  return { id: p.id ?? "", kind: "rollback", target: previous,
    preUpdate: { current: p.machine.current, previous: p.machine.previous },
    state: "rolling_back", mark: "rolling_back", backups: [], migrations: null };
}

// The mark each state must stand in before a step may run (the marks are the states of §6.2's steps 3–7; the
// commit is recorded while the Update stands in `probation`, and a rollback may start from the swap onward).
const MARK_NEEDS: Readonly<Record<UpdateMark, readonly UpdateState[]>> = {
  draining: ["staged"], stopping: ["draining"], backing_up: ["stopping"], swapping: ["backing_up"],
  starting: ["swapping"], committing: ["probation"], rolling_back: ["swapping", "starting", "probation"],
};
const MARK_STATE: Readonly<Record<UpdateMark, UpdateState>> = {
  draining: "draining", stopping: "stopping", backing_up: "backing_up", swapping: "swapping",
  starting: "starting", committing: "probation", rolling_back: "rolling_back",
};

// RL4: one Update at a time, each mutating step recorded started-before and done-after. Without the lock nothing
// acts (the operating system drops it when the apply dies); out of order, nothing runs either. With both, the mark
// is on record — written, synced — before the step it names may touch anything.
export function beginStep(u: Update, mark: UpdateMark, o: { lockHeld: boolean }): Result<Update, "apply_lock" | "step_out_of_order"> {
  if (!o.lockHeld) return err("apply_lock");
  if (!MARK_NEEDS[mark].includes(u.state)) return err("step_out_of_order");
  return ok({ ...u, mark, state: MARK_STATE[mark] });
}
// A move the diagram allows (skipped's reason and abandoned's cause are the caller's to record beside it).
export function advance(u: Update, to: UpdateState): Result<Update, "illegal_move"> {
  return updateCanMove(u.state, to) ? ok({ ...u, state: to }) : err("illegal_move");
}

export const RECORD_FORMAT = 1;
export type RecoverDecision =
  | { act: "abandon" }            // nothing swapped: the old Version runs again, the staged copy stays
  | { act: "continue_apply" }     // the swap finished: carry on as `starting`
  | { act: "judge_health" }       // the services are up, or will be: judge against a fresh deadline
  | { act: "continue_rollback" }  // every rollback step can be repeated safely
  | { act: "finish_commit" }
  | { act: "nothing"; unknown: string };   // a record this Version doesn't know: act on nothing, raise a critical Alert

// The recovery table (§6.6). Whatever runs next takes the apply lock first — while an apply holds it, nothing else
// acts — and then reads the record. `committing` or later finishes the commit; a record this Version doesn't know
// (a newer format, an unknown step) acts on nothing and names it, rather than guessing. The recovery runs from
// `good`, the last committed Version: that code has passed its health checks here, and the target's might be what
// is broken.
export function recover(p: {
  format: number; mark: string | null; committed: boolean; current: Version;
  preUpdate: { current: Version }; target: Version; lockHeld: boolean;
}): Result<RecoverDecision, "apply_lock"> {
  if (!p.lockHeld) return err("apply_lock");
  if (p.format !== RECORD_FORMAT) return ok({ act: "nothing", unknown: `record format ${p.format}` });
  if (p.committed) return ok({ act: "finish_commit" });
  switch (p.mark) {
    case null: case "draining": case "stopping": case "backing_up":
      return ok({ act: "abandon" });
    case "swapping":
      if (equalVersions(p.current, p.preUpdate.current)) return ok({ act: "abandon" });
      if (equalVersions(p.current, p.target)) return ok({ act: "continue_apply" });
      return ok({ act: "nothing", unknown: `current ${formatVersion(p.current)} at swapping` });
    case "starting":
      return ok({ act: "judge_health" });
    case "committing":
      return ok({ act: "finish_commit" });
    case "rolling_back":
      return ok({ act: "continue_rollback" });
    default:
      return ok({ act: "nothing", unknown: `step ${String(p.mark)}` });
  }
}

// ---- The Release on the wire, as facts the domain reasons over (§9.6's documents, parsed by the protocol)

export const PLATFORMS = ["linux-x64", "linux-arm64", "darwin-arm64"] as const;
export type Platform = (typeof PLATFORMS)[number];
export type ArtifactRef = { platform: Platform; name: string; size: number; sha256: string; filesSha256: string; node: string };
export type ProtocolRange = { agent: [number, number]; clientApi: [number, number] };
export type Manifest = {
  schema: 1; product: "morndo"; version: string; commit: string; publishedAt: number; notes: string;
  protocol: ProtocolRange; schemas: Record<DatabaseName, SchemaInfo>; artifacts: ArtifactRef[];
};

// ---- Events (§4.5), what the updater raises as it goes

export type ReleaseEvent =
  | { type: "UpdateChecked"; channel: Channel; at: number }
  | { type: "UpdateAvailable"; version: string; at: number }
  | { type: "UpdateSkipped"; reason: SkipReason; at: number }
  | { type: "UpdateStaged"; version: string; at: number }
  | { type: "VerificationFailed"; which: VerificationStep; at: number }
  | { type: "FeedRollbackRefused"; seq: number; at: number }
  | { type: "FeedStale"; expiresAt: number; at: number }
  | { type: "KeySetRotated"; version: number; at: number }
  | { type: "KeysExpired"; version: number; at: number }
  | { type: "DowngradeRefused"; from: string; to: string; at: number }
  | { type: "UpdateDeferred"; blockers: readonly string[]; at: number }
  | { type: "ServicesStopped"; services: readonly UpdateService[]; at: number }
  | { type: "BackupTaken"; database: DatabaseName; at: number }
  | { type: "BackupFailed"; database: DatabaseName; at: number }
  | { type: "VersionSwapped"; from: string; to: string; at: number }
  | { type: "ServicesStarted"; services: readonly UpdateService[]; at: number }
  | { type: "HealthPassed"; at: number }
  | { type: "HealthFailed"; service: string; check: string; at: number }
  | { type: "UpdateCommitted"; version: string; at: number }
  | { type: "RollbackStarted"; target: string; at: number }
  | { type: "BackupRestored"; database: DatabaseName; at: number }
  | { type: "RolledBack"; to: string; at: number }
  | { type: "RollbackFailed"; at: number }
  | { type: "RolloutHalted"; version: string; by: string; at: number }
  | { type: "RolloutResumed"; version: string; at: number }
  | { type: "SkewBlocked"; detail: string; at: number };
