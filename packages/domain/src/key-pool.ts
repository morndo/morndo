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
  nextCheck: number | null; organization: string | null;
};
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
  | { type: "PoolEmpty"; backAt: number | null; at: number }
  | { type: "PoolBlocked"; member: string; reason: FailingReason; at: number }
  | { type: "PoolRefilled"; at: number }
  | { type: "GrantOpened"; grant: string; member: string; at: number }
  | { type: "GrantMoved"; grant: string; from: string; to: string; why: GrantMoveWhy; at: number }
  | { type: "GrantClosed"; grant: string; at: number };
export type KeyPool = {
  name: string; runtime: string; vendor: string; policy: RotationPolicy; members: readonly KeyMember[];
  grants: readonly Grant[];
  lastPick: string | null; terms: TermsAck | null; ownedOrgs: readonly string[]; standing: Standing;
  events: readonly KeyPoolEvent[]; seq: number;
};
export type PickRefusal =
  | { problem: "pool_blocked"; member: string; reason: FailingReason }
  | { problem: "pool_empty"; backAt: number | null }
  | { problem: "none_left" };
export type CreateKeyPool = { name: string; runtime: string; vendor: string; policy?: RotationPolicy };

const EVENT_LIMIT = 500;

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
  const members = p.members.map(m => m.credential === credential ? { ...m, health, since: at, lastChange: at, nextCheck } : m);
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
    members: [], grants: [], lastPick: null, terms: null, ownedOrgs: [], standing: "ok", events: [], seq: 0,
  };
  return ok(settleKeyPool(withEvents(created, [{ type: "KeyPoolCreated", pool: input.name, at: now, command: who.value }]), now));
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
    nextCheck: null, organization,
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

function applyOutcome(p: KeyPool, member: KeyMember, outcome: Outcome, observedAt: number, now: number, via: "probe" | "report"): KeyPool | null {
  switch (outcome.kind) {
    case "unknown":
      return null;
    case "limited":
      return withEvents(p, [{
        type: "KeyLimited", member: member.credential,
        retryAfterSeconds: outcome.retryAfterMs === null ? null : outcome.retryAfterMs / 1000, at: now,
      }]);
    case "ok":
      if (member.health.state !== "exhausted" || outcome.evidence !== "messages") return null;
      return withEvents(withMember(p, member.credential, { state: "active" }, observedAt, null), [{ type: "KeyRecovered", member: member.credential, how: via, at: now }]);
    case "exhausted": {
      if (member.health.state !== "active") return null;
      const resumeAt = cappedResume(outcome.resumeAt, now);
      return withEvents(
        withMember(p, member.credential, { state: "exhausted", reason: outcome.reason, resumeAt }, observedAt, resumeAt ?? observedAt + p.policy.recheckEveryMs),
        [{ type: "KeyExhausted", member: member.credential, reason: outcome.reason, resumeAt, at: now }],
      );
    }
    case "failing":
      if (member.health.state === "failing") return null;
      return withEvents(withMember(p, member.credential, { state: "failing", reason: outcome.reason }, observedAt, null), [{ type: "KeyFailed", member: member.credential, reason: outcome.reason, at: now }]);
    default:
      return unreachable(outcome);
  }
}

export function reportKeyOutcome(
  p: KeyPool, credential: string, outcome: Outcome, observedAt: number, now: number, via: "probe" | "report" = "report",
): Result<KeyPool, "missing"> {
  const member = p.members.find(m => m.credential === credential);
  if (!member) return err("missing");
  if (observedAt < member.lastChange) return ok(p);
  const changed = applyOutcome(p, member, outcome, observedAt, now, via);
  if (!changed) return ok(p);
  return ok(settleKeyPool(changed, now));
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

// A session the grant has served is that session's member, and the window is left as it is. Otherwise a report inside the
// hand-off window still belongs to the member that gave the run up. Past it, the current member owns it.
export function attributeToGrant(p: KeyPool, id: string, at: number, ttlMs: number, session?: string | null): Result<{ pool: KeyPool; member: string }, "missing"> {
  const grant = p.grants.find(g => g.id === id);
  if (!grant) return err("missing");
  const known = session ? grant.seen.find(row => row.session === session) : undefined;
  if (known) return ok({ pool: p, member: known.member });
  const earlier = grant.previous;
  if (earlier && at < earlier.movedAt + ttlMs) return ok({ pool: p, member: earlier.member });
  if (!earlier) return ok({ pool: p, member: grant.member });
  return ok({ pool: { ...p, grants: p.grants.map(g => g.id === id ? { ...g, previous: null } : g) }, member: grant.member });
}

export function keyRotated(p: KeyPool, credential: string, now: number): KeyPool {
  const member = p.members.find(m => m.credential === credential);
  if (!member || member.health.state !== "failing") return p;
  // The recovery is the last event of this step. A standing change, when one happens, is recorded first.
  const settled = settleKeyPool(withMember(p, credential, { state: "active" }, now, null), now);
  return withEvents(settled, [{ type: "KeyRecovered", member: credential, how: "rotation", at: now }]);
}
