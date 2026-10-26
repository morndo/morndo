// Key pool: which key Connection serves the next request. Pure. Callers pass `now` (ms since epoch). A member holds a
// Connection's name only; events hold names, reason words, times and command ids.
import { CONNECTION_NAME, isKey, type Actor, type Connection, type HelperWindow, type Holder, type TermsAck } from "./connections.ts";
import { err, ok, unreachable, type Result } from "./shared.ts";

export type RotationMode = "round-robin" | "drain";
export type RotationPolicy = { mode: RotationMode; recheckEveryMs: number };
export const KEY_POOL_RECHECK_MIN_MS = 3_600_000;
export const KEY_POOL_RECHECK_MAX_MS = 7 * 86_400_000;
export const KEY_POOL_RECHECK_DEFAULT_MS = 86_400_000;
export const KEY_POOL_RESUME_MAX_MS = 365 * 86_400_000;
export const KEY_PROBE_CLAIM_MS = 30_000;
// The recorded estimate of one probe, about 10 input and 1 output token on the probe model, a margin over the Haiku
// prices read 2026-10-25, which also covers the older dearer Haiku 4.5.
export const KEY_PROBE_COST_USD = 0.00002;

export type ExhaustedReason = "credit" | "spend-limit";
export type FailingReason = "rejected" | "denied" | "held" | "cap";
export type KeyHealth =
  | { state: "active" }
  | { state: "exhausted"; reason: ExhaustedReason; resumeAt: number | null }
  | { state: "failing"; reason: FailingReason };
export type Outcome =
  | { kind: "ok"; evidence: "messages" | "other" }
  | { kind: "exhausted"; reason: ExhaustedReason; resumeAt: number | null }
  | { kind: "failing"; reason: FailingReason }
  | { kind: "limited"; retryAfterMs: number | null }
  | { kind: "unknown" };
export type KeyMember = {
  credential: string; joined: number; health: KeyHealth; since: number; lastChange: number;
  nextCheck: number | null; probingUntil: number | null; failedProbes: number; lastProbe: number | null;
  // A mark of the last detail alerted for each kind of probe alert (`unclassified`, `probe-config`). A hash, not the detail:
  // the detail holds a status code and the provider's error type, which the pool never keeps (KP12).
  alerted: Readonly<Record<string, string>>;
  organization: string | null;
};
export type ProbeWhy = "due" | "manual" | "suspect";
export type Names = { connections: readonly string[]; pools: readonly string[]; deleted: readonly string[] };
export type Standing = "ok" | "empty" | "blocked";
export type RecoverHow = "probe" | "report" | "revive" | "rotation";
export type GrantRequest = { role: string; entry: string; workspacePath: string; limit: number; reserve: number; margin: number };
export type GrantMoveWhy = "exhausted" | "refused" | "adopted" | "reopened" | "left";
export type Grant = {
  id: string; member: string; lease: string; holder: Holder; request: GrantRequest;
  window: HelperWindow; previous: { member: string; movedAt: number } | null;
  seen: readonly { session: string; member: string }[];
  lent: readonly string[];
  filter: string | null;
};
export type KeyPoolEvent =
  | { type: "KeyPoolCreated"; pool: string; at: number; command: string }
  | { type: "MemberJoined"; member: string; at: number; command: string }
  | { type: "MemberLeft"; member: string; why: "left" | "revoked"; at: number }
  | { type: "MemberMoved"; member: string; to: number; at: number; command: string }
  | { type: "PolicyChanged"; mode: RotationMode; recheckEveryMs: number; by: string | null; at: number }
  | { type: "TermsAcknowledged"; revision: string; by: string; at: number; command: string }
  | { type: "OwnerConfirmed"; member: string; at: number; command: string }
  | { type: "MemberPicked"; member: string; declined: readonly { member: string; word: string }[]; at: number }
  | { type: "KeyExhausted"; member: string; reason: ExhaustedReason; resumeAt: number | null; at: number }
  | { type: "KeyFailed"; member: string; reason: FailingReason; at: number }
  | { type: "KeyLimited"; member: string; retryAfterSeconds: number | null; at: number }
  | { type: "KeyRecovered"; member: string; how: RecoverHow; at: number }
  | { type: "ProbeClaimed"; member: string; why: ProbeWhy; at: number }
  | { type: "ProbeReleased"; member: string; at: number }
  | { type: "PoolEmpty"; backAt: number | null; at: number }
  | { type: "PoolBlocked"; member: string; reason: FailingReason; at: number }
  | { type: "PoolRefilled"; at: number }
  | { type: "GrantOpened"; grant: string; member: string; at: number }
  | { type: "GrantMoved"; grant: string; from: string; to: string; why: GrantMoveWhy; at: number }
  | { type: "GrantClosed"; grant: string; at: number }
  | { type: "SinkAdded"; sinks: number; at: number; command: string }
  | { type: "SinkRemoved"; sinks: number; at: number; command: string };
export type KeyPool = {
  name: string; runtime: string; vendor: string; policy: RotationPolicy; members: readonly KeyMember[];
  grants: readonly Grant[];
  sinks: readonly string[];
  // Sinks that were removed but may still hold a key in their file, newest last, at most KEY_POOL_RETIRED_MAX (never dropped for room), with when
  // each live sink was registered (T-459): a run that began before that time was denied the file.
  retired: readonly string[];
  sinkSince: Readonly<Record<string, number>>;
  lastPick: string | null; terms: TermsAck | null; ownedOrgs: readonly string[]; standing: Standing;
  events: readonly KeyPoolEvent[]; seq: number;
};
export type PickRefusal =
  | { problem: "pool_blocked"; member: string; reason: FailingReason }
  | { problem: "pool_empty"; backAt: number | null }
  | { problem: "none_left" };
export type CreateKeyPool = { name: string; runtime: string; vendor: string; policy?: RotationPolicy };

const EVENT_LIMIT = 500;
export const KEY_POOL_SINKS_MAX = 16;
export const KEY_POOL_RETIRED_MAX = 64;
const SINK_MAX_LENGTH = 4096;
const SINK_SEGMENT = /^[A-Za-z0-9._@+=,:-]+$/;
const SIDECAR = ".member";
// The suffixes a sink itself never has: the sidecar, and the two files a write passes through (T-459).
const RESERVED = [SIDECAR, ".tmp", ".lock"];

// A sink is the file `write-env` writes a pool's key to (KP20): absolute, normalised, safe characters only (no space, glob, quote or control
// character, so it is one literal in a deny rule), and never one of the reserved files beside it (the sidecar `<sink>.member`,
// the temp file `<sink>.tmp`, the lock `<sink>.lock`).
export function isSinkPath(path: string): boolean {
  if (path.length < 2 || path.length > SINK_MAX_LENGTH || !path.startsWith("/") || RESERVED.some(end => path.endsWith(end))) return false;
  return path.slice(1).split("/").every(segment => SINK_SEGMENT.test(segment) && segment !== "." && segment !== "..");
}

// The file beside a sink that names the member whose key was last written there.
export const sinkSidecar = (path: string): string => `${path}${SIDECAR}`;

// Every file a write of a sink can leave a key in: the sink, its sidecar and its temp file.
export const sinkFiles = (path: string): string[] => [path, sinkSidecar(path), `${path}.tmp`];

function commandOf(actor: Actor): Result<string, "principal"> {
  return actor.kind === "principal" && actor.command.trim() !== "" ? ok(actor.command) : err("principal");
}

function modeOk(mode: string): mode is RotationMode {
  return mode === "round-robin" || mode === "drain";
}

function recheckOk(ms: number): boolean {
  return Number.isFinite(ms) && ms >= KEY_POOL_RECHECK_MIN_MS && ms <= KEY_POOL_RECHECK_MAX_MS;
}

function checkedPolicy(policy: RotationPolicy | undefined): Result<RotationPolicy, "bad_policy"> {
  const mode = policy?.mode ?? "round-robin";
  const recheckEveryMs = policy?.recheckEveryMs ?? KEY_POOL_RECHECK_DEFAULT_MS;
  if (!modeOk(mode) || !recheckOk(recheckEveryMs)) return err("bad_policy");
  return ok({ mode, recheckEveryMs });
}

function withEvents(p: KeyPool, events: readonly KeyPoolEvent[]): KeyPool {
  if (events.length === 0) return p;
  return { ...p, events: [...p.events, ...events].slice(-EVENT_LIMIT), seq: p.seq + events.length };
}

function withMember(p: KeyPool, credential: string, health: KeyHealth, at: number, nextCheck: number | null): KeyPool {
  const members = p.members.map(m => m.credential === credential
    ? { ...m, health, since: at, lastChange: at, nextCheck, probingUntil: null, failedProbes: 0 }
    : m);
  return { ...p, members };
}

const failingMember = (p: KeyPool): (KeyMember & { health: { state: "failing"; reason: FailingReason } }) | undefined =>
  p.members.find((m): m is KeyMember & { health: { state: "failing"; reason: FailingReason } } => m.health.state === "failing");

export function keyPoolBackAt(p: KeyPool): number | null {
  let best: number | null = null;
  for (const m of p.members) {
    if (m.health.state !== "exhausted" || m.nextCheck === null) continue;
    if (best === null || m.nextCheck < best) best = m.nextCheck;
  }
  return best;
}

export function keyPoolStanding(p: KeyPool): Standing {
  if (p.members.some(m => m.health.state === "failing")) return "blocked";
  if (p.members.length > 0 && p.members.every(m => m.health.state !== "active")) return "empty";
  return "ok";
}

export function settleKeyPool(p: KeyPool, now: number): KeyPool {
  const standing = keyPoolStanding(p);
  if (standing === p.standing) return p;
  if (standing === "blocked") {
    const hit = failingMember(p);
    if (!hit) return p;
    return withEvents({ ...p, standing }, [{ type: "PoolBlocked", member: hit.credential, reason: hit.health.reason, at: now }]);
  }
  if (standing === "empty") return withEvents({ ...p, standing }, [{ type: "PoolEmpty", backAt: keyPoolBackAt(p), at: now }]);
  return withEvents({ ...p, standing }, [{ type: "PoolRefilled", at: now }]);
}

export function newKeyPoolEvents(before: KeyPool, after: KeyPool): readonly KeyPoolEvent[] {
  const added = after.seq - before.seq;
  if (added <= 0) return [];
  return after.events.slice(-added);
}

export function createKeyPool(
  input: CreateKeyPool, names: Names, actor: Actor, now: number,
): Result<KeyPool, "principal" | "bad_name" | "bad_policy" | "taken"> {
  const who = commandOf(actor);
  if (!who.ok) return who;
  if (!CONNECTION_NAME.test(input.name)) return err("bad_name");
  const policy = checkedPolicy(input.policy);
  if (!policy.ok) return policy;
  if (names.connections.includes(input.name) || names.pools.includes(input.name) || names.deleted.includes(input.name)) return err("taken");
  const created: KeyPool = {
    name: input.name, runtime: input.runtime, vendor: input.vendor, policy: policy.value,
    members: [], grants: [], sinks: [], retired: [], sinkSince: {}, lastPick: null, terms: null, ownedOrgs: [], standing: "ok", events: [], seq: 0,
  };
  return ok(settleKeyPool(withEvents(created, [{ type: "KeyPoolCreated", pool: input.name, at: now, command: who.value }]), now));
}

// A sink remembers when it was registered, and one added back leaves the retired list, where a removed sink stays until
// its file is gone: the file may still hold a key. The events carry the count of live sinks only.
export function addKeySink(p: KeyPool, path: string, actor: Actor, now: number): Result<KeyPool, "principal" | "bad_path" | "exists" | "too_many"> {
  const who = commandOf(actor);
  if (!who.ok) return who;
  if (!isSinkPath(path)) return err("bad_path");
  if (p.sinks.includes(path)) return err("exists");
  if (p.sinks.length >= KEY_POOL_SINKS_MAX) return err("too_many");
  const sinks = [...p.sinks, path];
  const retired = p.retired.filter(row => row !== path);
  const sinkSince = { ...p.sinkSince, [path]: now };
  return ok(withEvents({ ...p, sinks, retired, sinkSince }, [{ type: "SinkAdded", sinks: sinks.length, at: now, command: who.value }]));
}

export function removeKeySink(p: KeyPool, path: string, actor: Actor, now: number): Result<KeyPool, "principal" | "missing" | "retired_full"> {
  const who = commandOf(actor);
  if (!who.ok) return who;
  if (!p.sinks.includes(path)) return err("missing");
  // A retired sink may still hold a key and stays on the list until its files are gone (`forgetRetired`), never to make room: past the cap a removal is refused.
  if (!p.retired.includes(path) && p.retired.length >= KEY_POOL_RETIRED_MAX) return err("retired_full");
  const sinks = p.sinks.filter(row => row !== path);
  const retired = [...p.retired.filter(row => row !== path), path];
  const sinkSince = { ...p.sinkSince };
  delete sinkSince[path];
  return ok(withEvents({ ...p, sinks, retired, sinkSince }, [{ type: "SinkRemoved", sinks: sinks.length, at: now, command: who.value }]));
}

// The retired sinks whose files are gone protect nothing: forgotten, without an event. The same pool when nothing is forgotten.
export function forgetRetired(p: KeyPool, paths: readonly string[]): KeyPool {
  const retired = p.retired.filter(row => !paths.includes(row));
  return retired.length === p.retired.length ? p : { ...p, retired };
}

export function acknowledgeKeyPoolTerms(p: KeyPool, revision: string, by: string, actor: Actor, now: number): Result<KeyPool, "principal" | "ack_needed"> {
  const who = commandOf(actor);
  if (!who.ok) return who;
  const name = by.trim();
  if (name === "") return err("ack_needed");
  const next = withEvents({ ...p, terms: { by: name, at: now, revision } }, [{ type: "TermsAcknowledged", revision, by: name, at: now, command: who.value }]);
  return ok(settleKeyPool(next, now));
}

export function joinKeyPool(
  p: KeyPool, connection: Connection, ctx: { elsewhere: readonly string[] }, organization: string | null,
  confirmOwn: boolean, actor: Actor, now: number,
): Result<KeyPool, "principal" | "not_a_key" | "revoked" | "other_vendor" | "other_runtime" | "exists" | "in_pool" | "foreign_organization"> {
  const who = commandOf(actor);
  if (!who.ok) return who;
  if (!isKey(connection)) return err("not_a_key");
  if (connection.status === "revoked") return err("revoked");
  if (connection.vendor !== p.vendor) return err("other_vendor");
  if (connection.runtime !== p.runtime) return err("other_runtime");
  if (p.members.some(m => m.credential === connection.name)) return err("exists");
  if (ctx.elsewhere.includes(connection.name)) return err("in_pool");
  const known = organization !== null && p.ownedOrgs.includes(organization);
  if (!known && !confirmOwn) return err("foreign_organization");
  const events: KeyPoolEvent[] = [];
  let ownedOrgs = p.ownedOrgs;
  if (!known) {
    if (organization !== null) ownedOrgs = [...ownedOrgs, organization];
    events.push({ type: "OwnerConfirmed", member: connection.name, at: now, command: who.value });
  }
  const member: KeyMember = {
    credential: connection.name, joined: now, health: { state: "active" }, since: now, lastChange: now,
    nextCheck: null, probingUntil: null, failedProbes: 0, lastProbe: null, alerted: {}, organization,
  };
  events.push({ type: "MemberJoined", member: connection.name, at: now, command: who.value });
  return ok(settleKeyPool(withEvents({ ...p, members: [...p.members, member], ownedOrgs }, events), now));
}

// The member's health leaves with them. A grant that named them stays, still naming them, so the run's next call can hand it off.
// The members that grant has lent stay listed on it.
export function leaveKeyPool(p: KeyPool, credential: string, now: number, why: "left" | "revoked" = "left"): Result<KeyPool, "missing"> {
  const index = p.members.findIndex(m => m.credential === credential);
  if (index < 0) return err("missing");
  const members = p.members.filter(m => m.credential !== credential);
  const previous = members[index - 1];
  const lastPick = p.lastPick !== credential ? p.lastPick : index === 0 || previous === undefined ? null : previous.credential;
  return ok(settleKeyPool(withEvents({ ...p, members, lastPick }, [{ type: "MemberLeft", member: credential, why, at: now }]), now));
}

export function moveKeyMember(
  p: KeyPool, credential: string, to: number, actor: Actor, now: number,
): Result<KeyPool, "principal" | "missing" | "bad_index"> {
  const who = commandOf(actor);
  if (!who.ok) return who;
  const from = p.members.findIndex(m => m.credential === credential);
  if (from < 0) return err("missing");
  if (!Number.isInteger(to) || to < 0 || to >= p.members.length) return err("bad_index");
  const members = [...p.members];
  const moved = members[from];
  if (moved === undefined) return err("missing");
  members.splice(from, 1);
  members.splice(to, 0, moved);
  return ok(settleKeyPool(withEvents({ ...p, members }, [{ type: "MemberMoved", member: credential, to, at: now, command: who.value }]), now));
}

export function setKeyPoolPolicy(p: KeyPool, change: Partial<RotationPolicy>, by: string | null, now: number): Result<KeyPool, "bad_policy"> {
  if (change.mode !== undefined && !modeOk(change.mode)) return err("bad_policy");
  if (change.recheckEveryMs !== undefined && !recheckOk(change.recheckEveryMs)) return err("bad_policy");
  const policy: RotationPolicy = {
    mode: change.mode ?? p.policy.mode,
    recheckEveryMs: change.recheckEveryMs ?? p.policy.recheckEveryMs,
  };
  const next = withEvents({ ...p, policy }, [{ type: "PolicyChanged", mode: policy.mode, recheckEveryMs: policy.recheckEveryMs, by, at: now }]);
  return ok(settleKeyPool(next, now));
}

function servable(m: KeyMember): boolean {
  return m.health.state === "active";
}

// Who `chooseKey` tries, in that order, when nothing is skipped. A failing member yields none: the pool is blocked first.
export function servableOrder(p: KeyPool): readonly string[] {
  if (failingMember(p)) return [];
  const n = p.members.length;
  if (n === 0) return [];
  const lastAt = p.lastPick === null ? -1 : p.members.findIndex(m => m.credential === p.lastPick);
  const start = p.policy.mode === "drain" && lastAt >= 0 ? lastAt : lastAt < 0 ? 0 : (lastAt + 1) % n;
  const names: string[] = [];
  for (let step = 0; step < n; step++) {
    const member = p.members[(start + step) % n];
    if (member && servable(member)) names.push(member.credential);
  }
  return names;
}

export function chooseKey(p: KeyPool, skip: readonly string[] = []): Result<{ pool: KeyPool; member: string }, PickRefusal> {
  const blocked = failingMember(p);
  if (blocked) return err({ problem: "pool_blocked", member: blocked.credential, reason: blocked.health.reason });
  if (!p.members.some(servable)) return err({ problem: "pool_empty", backAt: keyPoolBackAt(p) });
  const chosen = servableOrder(p).find(name => !skip.includes(name));
  if (!chosen) return err({ problem: "none_left" });
  if (p.lastPick === chosen) return ok({ pool: p, member: chosen });
  return ok({ pool: { ...p, lastPick: chosen }, member: chosen });
}

export function releaseKey(p: KeyPool, member: string, previous: string | null): KeyPool {
  if (p.lastPick !== member) return p;
  return { ...p, lastPick: previous };
}

export function keyPicked(p: KeyPool, member: string, declined: readonly { member: string; word: string }[], now: number): KeyPool {
  const lastPick = p.policy.mode === "drain" && declined.length > 0 ? p.lastPick : member;
  return settleKeyPool(withEvents({ ...p, lastPick }, [{ type: "MemberPicked", member, declined, at: now }]), now);
}

function cappedResume(resumeAt: number | null, now: number): number | null {
  if (resumeAt !== null && resumeAt > now + KEY_POOL_RESUME_MAX_MS) return now + KEY_POOL_RESUME_MAX_MS;
  return resumeAt;
}

// A probe's answer that names a date that is not in the future names no date: the member waits the interval, not
// "due again at once". One that is in the future is held to a year. (The first refusal keeps a past date: the member is
// due at once, once, and the claim then moves its next check.)
function futureResume(resumeAt: number | null, now: number): number | null {
  if (resumeAt === null || resumeAt <= now) return null;
  return cappedResume(resumeAt, now);
}

// How long until the next probe. Each time a probe finds the member still dry, the wait doubles, up to a week.
function probeInterval(failedProbes: number, policy: RotationPolicy): number {
  return Math.min(policy.recheckEveryMs * 2 ** failedProbes, KEY_POOL_RECHECK_MAX_MS);
}

function applyOutcome(
  p: KeyPool, member: KeyMember, outcome: Outcome, observedAt: number, now: number, via: "probe" | "report", why?: ProbeWhy,
): KeyPool | null {
  switch (outcome.kind) {
    case "unknown":
      return null;
    case "limited":
      return withEvents(p, [{
        type: "KeyLimited", member: member.credential,
        retryAfterSeconds: outcome.retryAfterMs === null ? null : outcome.retryAfterMs / 1000, at: now,
      }]);
    case "ok":
      if (outcome.evidence !== "messages") return null;
      if (member.health.state === "exhausted") {
        return withEvents(withMember(p, member.credential, { state: "active" }, observedAt, null), [{ type: "KeyRecovered", member: member.credential, how: via, at: now }]);
      }
      // An active member that answers a probe stays as it is, claim included. The claim lapses by itself.
      return null;
    case "exhausted": {
      if (member.health.state === "active") {
        const resumeAt = cappedResume(outcome.resumeAt, now);
        return withEvents(
          withMember(p, member.credential, { state: "exhausted", reason: outcome.reason, resumeAt }, observedAt, resumeAt ?? observedAt + p.policy.recheckEveryMs),
          [{ type: "KeyExhausted", member: member.credential, reason: outcome.reason, resumeAt, at: now }],
        );
      }
      // Still dry. Only a due probe counts: it is not a new transition (KP11), so since and lastChange stay, and so does
      // the claim, which lapses by itself. A manual probe, and a report of the same refusal, change nothing.
      if (member.health.state === "exhausted" && via === "probe") {
        if (why !== "due") return null;
        const failedProbes = member.failedProbes + 1;
        const resumeAt = futureResume(outcome.resumeAt, now);
        const nextCheck = resumeAt === null ? now + probeInterval(failedProbes, p.policy) : resumeAt;
        const health: KeyHealth = { state: "exhausted", reason: outcome.reason, resumeAt };
        return {
          ...p,
          members: p.members.map(m => m.credential === member.credential ? { ...m, failedProbes, health, nextCheck } : m),
        };
      }
      return null;
    }
    case "failing":
      if (member.health.state === "failing") return null;
      return withEvents(withMember(p, member.credential, { state: "failing", reason: outcome.reason }, observedAt, null), [{ type: "KeyFailed", member: member.credential, reason: outcome.reason, at: now }]);
    default:
      return unreachable(outcome);
  }
}

export function reportKeyOutcome(
  p: KeyPool, credential: string, outcome: Outcome, observedAt: number, now: number, via: "probe" | "report" = "report", why?: ProbeWhy,
): Result<KeyPool, "missing"> {
  const member = p.members.find(m => m.credential === credential);
  if (!member) return err("missing");
  if (observedAt < member.lastChange) return ok(p);
  const changed = applyOutcome(p, member, outcome, observedAt, now, via, via === "probe" ? why ?? "due" : why);
  if (!changed) return ok(p);
  return ok(settleKeyPool(changed, now));
}

// A probe is claimed before it is made. A due claim moves the next check in the same write; a manual claim and a suspect
// claim leave it. Every claim records when it was made. A claim still in the future is refused. A due or suspect claim inside
// one recheck interval of the last probe, of whatever kind, is not due (a manual claim is the principal's, held by the claim alone). A claim is not a health change, so since and lastChange stay.
export function claimProbe(
  p: KeyPool, credential: string, now: number, why: ProbeWhy,
): Result<KeyPool, "missing" | "claimed" | "not_due" | "state"> {
  const member = p.members.find(m => m.credential === credential);
  if (!member) return err("missing");
  switch (why) {
    case "due":
    case "manual":
      if (member.health.state !== "exhausted") return err("state");
      break;
    case "suspect":
      if (member.health.state !== "active") return err("state");
      break;
    default:
      return unreachable(why);
  }
  if (member.probingUntil !== null && member.probingUntil > now) return err("claimed");
  if (why === "due" && (member.nextCheck === null || member.nextCheck > now)) return err("not_due");
  if (why !== "manual" && member.lastProbe !== null && now - member.lastProbe < p.policy.recheckEveryMs) return err("not_due");
  const nextCheck = why === "due" ? now + probeInterval(member.failedProbes, p.policy) : member.nextCheck;
  const members = p.members.map(m => m.credential === credential
    ? { ...m, probingUntil: now + KEY_PROBE_CLAIM_MS, nextCheck, lastProbe: now }
    : m);
  return ok(withEvents({ ...p, members }, [{ type: "ProbeClaimed", member: credential, why, at: now }]));
}

// A claim whose probe never started is given back: only that claim, matched by the instant it was taken. Another
// prober's claim, a missing member, or a member with no claim, is left as the same pool.
export function releaseClaim(
  p: KeyPool, credential: string, claimedAt: number, before: { nextCheck: number | null; lastProbe: number | null }, now: number,
): KeyPool {
  const member = p.members.find(m => m.credential === credential);
  if (!member || member.probingUntil !== claimedAt + KEY_PROBE_CLAIM_MS) return p;
  const members = p.members.map(m => m.credential === credential
    ? { ...m, probingUntil: null, nextCheck: before.nextCheck, lastProbe: before.lastProbe }
    : m);
  return withEvents({ ...p, members }, [{ type: "ProbeReleased", member: credential, at: now }]);
}

// A short mark of a detail, to compare two without keeping the text (FNV-1a over the UTF-16 units, with the length).
function detailMark(detail: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < detail.length; i++) hash = Math.imul(hash ^ detail.charCodeAt(i), 0x01000193) >>> 0;
  return `${detail.length}-${hash.toString(16)}`;
}

// Whether a probe alert of this kind and detail is news for the member: the first one, or one that differs from the last
// alerted. The mark of the detail is kept with the member, so it neither repeats after other alerts push it out of view
// nor stays silent after a fix (clearAlerted).
export function alertOnce(p: KeyPool, credential: string, kind: string, detail: string): { pool: KeyPool; raise: boolean } {
  const member = p.members.find(m => m.credential === credential);
  const mark = detailMark(detail);
  if (!member || member.alerted[kind] === mark) return { pool: p, raise: false };
  const members = p.members.map(m => m.credential === credential ? { ...m, alerted: { ...m.alerted, [kind]: mark } } : m);
  return { pool: { ...p, members }, raise: true };
}

// A good answer, or one of another kind, is the fix: the same detail is news again afterwards.
export function clearAlerted(p: KeyPool, credential: string, kind: string): KeyPool {
  const member = p.members.find(m => m.credential === credential);
  if (!member || !(kind in member.alerted)) return p;
  const rest = Object.fromEntries(Object.entries(member.alerted).filter(([name]) => name !== kind));
  return { ...p, members: p.members.map(m => m.credential === credential ? { ...m, alerted: rest } : m) };
}

// Exhausted members whose next check has arrived and that nobody is probing now, in ring order.
export function dueMembers(p: KeyPool, now: number): string[] {
  const names: string[] = [];
  for (const member of p.members) {
    if (member.health.state !== "exhausted" || member.nextCheck === null || member.nextCheck > now) continue;
    if (member.probingUntil !== null && member.probingUntil > now) continue;
    // A claim would refuse a member probed less than one interval ago, so it is not listed.
    if (member.lastProbe !== null && now - member.lastProbe < p.policy.recheckEveryMs) continue;
    names.push(member.credential);
  }
  return names;
}

function recover(p: KeyPool, credential: string, how: "revive" | "rotation", now: number): KeyPool {
  return settleKeyPool(withEvents(withMember(p, credential, { state: "active" }, now, null), [{ type: "KeyRecovered", member: credential, how, at: now }]), now);
}

export function reviveKey(p: KeyPool, credential: string, actor: Actor, now: number): Result<KeyPool, "principal" | "missing" | "active"> {
  const who = commandOf(actor);
  if (!who.ok) return who;
  const member = p.members.find(m => m.credential === credential);
  if (!member) return err("missing");
  if (member.health.state === "active") return err("active");
  return ok(recover(p, credential, "revive", now));
}

function sameWindow(a: HelperWindow, b: HelperWindow): boolean {
  return a.calls === b.calls && a.windowStart === b.windowStart;
}

export function openGrant(p: KeyPool, grant: Grant, now: number): Result<KeyPool, "missing" | "exists"> {
  if (!p.members.some(m => m.credential === grant.member)) return err("missing");
  if (p.grants.some(g => g.id === grant.id)) return err("exists");
  return ok(withEvents({ ...p, grants: [...p.grants, grant] }, [{ type: "GrantOpened", grant: grant.id, member: grant.member, at: now }]));
}

// The run's own filter socket, recorded once. No event: a later caller cannot point the grant somewhere else.
export function bindFilter(p: KeyPool, id: string, path: string): Result<KeyPool, "missing" | "bound" | "path"> {
  const grant = p.grants.find(g => g.id === id);
  if (!grant) return err("missing");
  if (path === "" || !path.startsWith("/")) return err("path");
  if (grant.filter !== null) return err("bound");
  return ok({ ...p, grants: p.grants.map(g => g.id === id ? { ...g, filter: path } : g) });
}

export function moveGrant(
  p: KeyPool, id: string, to: { member: string; lease: string; window: HelperWindow; movedAt: number }, why: GrantMoveWhy, now: number,
): Result<KeyPool, "missing" | "no_member"> {
  const grant = p.grants.find(g => g.id === id);
  if (!grant) return err("missing");
  if (!p.members.some(m => m.credential === to.member)) return err("no_member");
  if (to.lease === grant.lease) return ok(p);
  const previous = to.member === grant.member ? grant.previous : { member: grant.member, movedAt: to.movedAt };
  const next: Grant = { ...grant, member: to.member, lease: to.lease, window: to.window, previous };
  return ok(withEvents(
    { ...p, grants: p.grants.map(g => g.id === id ? next : g) },
    [{ type: "GrantMoved", grant: id, from: grant.member, to: to.member, why, at: now }],
  ));
}

export function touchGrant(p: KeyPool, id: string, window: HelperWindow): KeyPool {
  const grant = p.grants.find(g => g.id === id);
  if (!grant || sameWindow(grant.window, window)) return p;
  return { ...p, grants: p.grants.map(g => g.id === id ? { ...g, window } : g) };
}

const SEEN_KEEP = 16;
const LENT_KEEP = 32;

// One row per session: the member it was last served. A new session, or one whose member changed, is written last.
// The grant keeps the last sixteen. Nothing is written when the grant is gone or the row is already so.
export function noteSeen(p: KeyPool, id: string, session: string, member: string): KeyPool {
  const grant = p.grants.find(g => g.id === id);
  if (!grant) return p;
  const at = grant.seen.findIndex(row => row.session === session);
  if (at >= 0 && grant.seen[at]?.member === member) return p;
  const seen = [...grant.seen.filter(row => row.session !== session), { session, member }].slice(-SEEN_KEEP);
  return { ...p, grants: p.grants.map(g => g.id === id ? { ...g, seen } : g) };
}

// Every member the run was handed, once, in the order it was handed. The grant keeps the last thirty-two.
// Nothing is written when the grant is gone or the member is already there.
export function noteLent(p: KeyPool, id: string, member: string): KeyPool {
  const grant = p.grants.find(g => g.id === id);
  if (!grant || grant.lent.includes(member)) return p;
  const lent = [...grant.lent, member].slice(-LENT_KEEP);
  return { ...p, grants: p.grants.map(g => g.id === id ? { ...g, lent } : g) };
}

export function closeGrant(p: KeyPool, id: string, now: number): KeyPool {
  if (!p.grants.some(g => g.id === id)) return p;
  return withEvents({ ...p, grants: p.grants.filter(g => g.id !== id) }, [{ type: "GrantClosed", grant: id, at: now }]);
}

// A session the grant has served is that session's member, and nothing is suspected. A session it has not seen, inside
// the hand-off window, still belongs to the member that gave the run up, and the current member is suspected when the
// two differ. Past the window, or with no earlier member, the current member owns the report and nothing is suspected.
export function attributeToGrant(p: KeyPool, id: string, at: number, ttlMs: number, session?: string | null): Result<{ pool: KeyPool; member: string; suspect: string | null }, "missing"> {
  const grant = p.grants.find(g => g.id === id);
  if (!grant) return err("missing");
  const known = session ? grant.seen.find(row => row.session === session) : undefined;
  if (known) return ok({ pool: p, member: known.member, suspect: null });
  const earlier = grant.previous;
  if (earlier && at < earlier.movedAt + ttlMs) {
    return ok({ pool: p, member: earlier.member, suspect: earlier.member === grant.member ? null : grant.member });
  }
  if (!earlier) return ok({ pool: p, member: grant.member, suspect: null });
  return ok({ pool: { ...p, grants: p.grants.map(g => g.id === id ? { ...g, previous: null } : g) }, member: grant.member, suspect: null });
}

export function keyRotated(p: KeyPool, credential: string, now: number): KeyPool {
  const member = p.members.find(m => m.credential === credential);
  if (!member || member.health.state !== "failing") return p;
  // The recovery is the last event of this step. A standing change, when one happens, is recorded first.
  const settled = settleKeyPool(withMember(p, credential, { state: "active" }, now, null), now);
  return withEvents(settled, [{ type: "KeyRecovered", member: credential, how: "rotation", at: now }]);
}
