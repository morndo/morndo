// Pool (ADR-0029; PL1–PL14): which member account a session's next turn runs on, and the rules around it. One Pool per
// runtime. The domain holds no vendor name, no file, no process and no clock of its own: callers pass `now` (ms since
// epoch), and whether a holder is still alive arrives as a function. Readings arrive from adapters already translated.
import type { Holder } from "./connections.ts";
import { err, ok, type Result } from "./shared.ts";

export type PoolMode = "pinned" | "rotate";
export type MoveBy = "resume" | "handoff";
export type PoolOrder = "weighted" | "soonest-reset";
export type PoolSettings = {
  mode: PoolMode; moveBy: MoveBy; order: PoolOrder; defaultMember: string | null;
  shortMinLeft: number; longMinLeft: number; pickMarginShort: number; pickMarginLong: number; nightReserveLong: number;
  turnsPerMember: number; activeMinutes: number; defaultMarkMinutes: number; maxMarkHours: number;
  resetAdviceWaitHours: number; creditAdviceHours: number;
};
export const POOL_DEFAULTS: PoolSettings = {
  mode: "pinned", moveBy: "resume", order: "weighted", defaultMember: null,
  shortMinLeft: 3, longMinLeft: 1, pickMarginShort: 10, pickMarginLong: 3, nightReserveLong: 25,
  turnsPerMember: 1, activeMinutes: 30, defaultMarkMinutes: 60, maxMarkHours: 168,
  resetAdviceWaitHours: 4, creditAdviceHours: 72,
};
export type MemberSettings = { keep: boolean; expires: number | null; onlyFor: readonly string[] };   // expires in ms
export type Member = { name: string; settings: MemberSettings; retired: string | null };
export type QuotaWindow = { usedPercent: number; minutes: number | null; resetsAt: number | null };    // resetsAt in ms
export type Reading = {
  member: string; at: number; signedIn: boolean; identity: string | null; plan: string | null; paid: boolean | null;
  windows: readonly QuotaWindow[]; allowed: boolean | null; credits: { available: number; expiresAt: number | null } | null;
};
export type Mark = { until: number; at: number; reason: string };
export type Placement = { session: string; member: string; pinned: boolean; at: number; lastTurnAt: number };
// Not named Claim: packages/domain/src/verification.ts already exports a Claim, and index.ts re-exports both files.
export type PoolClaim = { id: string; session: string | null; member: string; pinned: boolean; holder: Holder; at: number };
export type PoolEvent =
  | { type: "MemberAdded" | "MemberRemoved" | "MemberSettingsChanged" | "MemberActivated"; member: string; at: number }
  | { type: "MemberRetired"; member: string; why: string; at: number }
  | { type: "MemberMarkedOut"; member: string; model: string | null; until: number; reason: string; at: number }
  | { type: "MarkCleared"; member: string; model: string | null; at: number }
  | { type: "SessionPlaced"; session: string; member: string; pinned: boolean; at: number }
  | { type: "SessionMoved"; session: string; from: string; to: string; why: string; at: number }
  | { type: "ClaimGranted" | "ClaimReleased" | "ClaimLost"; claim: string; member: string; session: string | null; at: number }
  | { type: "TurnRefused"; session: string | null; problem: string; at: number }
  | { type: "ModeChanged"; mode: PoolMode; by: string | null; at: number }
  | { type: "SettingsChanged"; keys: readonly string[]; by: string | null; at: number }
  | { type: "MoveByChanged"; moveBy: MoveBy; by: string; reason: string; at: number }
  | { type: "ResetAdvised"; member: string; reason: Advice["reason"]; at: number }
  | { type: "ResetSpent"; member: string; by: string; outcome: string; at: number };
export type Pool = {
  runtime: string; settings: PoolSettings; members: readonly Member[];
  readings: Readonly<Record<string, Reading>>;
  marks: Readonly<Record<string, Mark>>;          // key "<member>", or "<member> <model>" for one model's limit
  placements: readonly Placement[]; claims: readonly PoolClaim[]; events: readonly PoolEvent[];   // events: the last 500
};
export type SeatState = "logged-out" | "retired" | "out" | "low" | "ok";
export type Seat = {
  member: string; state: SeatState; sameAs: string | null;
  shortLeft: number | null; shortResets: number | null; longLeft: number | null; longResets: number | null;
  urgency: number; active: number; busy: number; credits: number; backAt: number | null;
};
export type PlaceAsk = { session: string | null; pin: string | null; dir: string | null; night: boolean; model: string | null };
export type PlaceAnswer =
  | { ok: true; member: string; moved: { from: string; why: SeatState } | null }
  | { ok: false; problem: "no-seat"; leastBad: string | null; backAt: number | null }
  | { ok: false; problem: "member-unavailable"; member: string; state: SeatState; backAt: number | null }
  | { ok: false; problem: "no-default" | "unknown-member" };
export type ClaimAsk = { id: string; session: string | null; member: string; holder: Holder; pinned?: boolean };   // pinned: false when left out
export type ClaimRefusal = { problem: "session-busy"; holder: Holder } | { problem: "member-busy"; member: string };
export type Advice = { member: string; reason: "all-blocked" | "credit-expiring"; backAt: number | null; creditExpiresAt: number | null; longLeft: number | null };

const HOUR = 3_600_000;
const MINUTE = 60_000;
const EVENT_LIMIT = 500;
const UNKNOWN_HOURS = 168;

export function emptyPool(runtime: string): Pool {
  return { runtime, settings: POOL_DEFAULTS, members: [], readings: {}, marks: {}, placements: [], claims: [], events: [] };
}

// A pool with one more event, only the last 500 kept.
function noted(p: Pool, ...events: PoolEvent[]): Pool {
  return { ...p, events: [...p.events, ...events].slice(-EVENT_LIMIT) };
}

const without = <T>(rec: Readonly<Record<string, T>>, drop: (key: string) => boolean): Record<string, T> =>
  Object.fromEntries(Object.entries(rec).filter(([key]) => !drop(key)));

// The mark keys of one member: its own name, or its name and a model after a space.
const isMarkOf = (member: string) => (key: string): boolean => key === member || key.startsWith(`${member} `);

const hasMember = (p: Pool, name: string): boolean => p.members.some(m => m.name === name);

// ---- members

export function addMember(p: Pool, name: string, settings: MemberSettings, now: number): Result<Pool, "exists"> {
  if (hasMember(p, name)) return err("exists");
  const members = [...p.members, { name, settings, retired: null }].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return ok(noted({ ...p, members }, { type: "MemberAdded", member: name, at: now }));
}

// PL1: removing a member ends its placements, and takes its reading and marks with it.
export function removeMember(p: Pool, name: string, now: number): Result<Pool, "missing"> {
  if (!hasMember(p, name)) return err("missing");
  const next: Pool = {
    ...p,
    settings: p.settings.defaultMember === name ? { ...p.settings, defaultMember: null } : p.settings,
    members: p.members.filter(m => m.name !== name),
    readings: without(p.readings, key => key === name),
    marks: without(p.marks, isMarkOf(name)),
    placements: p.placements.filter(x => x.member !== name),
  };
  return ok(noted(next, { type: "MemberRemoved", member: name, at: now }));
}

export function setMemberSettings(p: Pool, name: string, settings: MemberSettings, now: number): Result<Pool, "missing"> {
  if (!hasMember(p, name)) return err("missing");
  const members = p.members.map(m => (m.name === name ? { ...m, settings } : m));
  return ok(noted({ ...p, members }, { type: "MemberSettingsChanged", member: name, at: now }));
}

export function retireMember(p: Pool, name: string, why: string, now: number): Result<Pool, "missing"> {
  if (!hasMember(p, name)) return err("missing");
  const members = p.members.map(m => (m.name === name ? { ...m, retired: why } : m));
  return ok(noted({ ...p, members }, { type: "MemberRetired", member: name, why, at: now }));
}

export function activateMember(p: Pool, name: string, now: number): Result<Pool, "missing"> {
  if (!hasMember(p, name)) return err("missing");
  const members = p.members.map(m => (m.name === name ? { ...m, retired: null } : m));
  return ok(noted({ ...p, members }, { type: "MemberActivated", member: name, at: now }));
}

// ---- settings

// PL11: rotation is the principal's: it names who decided it. Anyone may turn it back to pinned.
export function setMode(p: Pool, mode: PoolMode, by: string | null, now: number): Result<Pool, "rotate-needs-principal"> {
  if (mode === "rotate" && (by === null || by.trim() === "")) return err("rotate-needs-principal");
  return ok(noted({ ...p, settings: { ...p.settings, mode } }, { type: "ModeChanged", mode, by, at: now }));
}

const NUMERIC: readonly (keyof PoolSettings)[] = [
  "shortMinLeft", "longMinLeft", "pickMarginShort", "pickMarginLong", "nightReserveLong",
  "turnsPerMember", "activeMinutes", "defaultMarkMinutes", "maxMarkHours", "resetAdviceWaitHours", "creditAdviceHours",
];

// PL13, PL14: `moveBy: "resume"` and more than one turn per member need `by`. `defaultMember` must name a member.
export function setSettings(
  p: Pool, change: Partial<Omit<PoolSettings, "mode">>, by: string | null, now: number,
): Result<Pool, "needs-principal" | "unknown-member" | "bad-value"> {
  const keys = Object.keys(change) as (keyof typeof change)[];
  for (const key of keys) {
    const value = change[key];
    if (NUMERIC.includes(key)) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return err("bad-value");
      if (key === "turnsPerMember" && (!Number.isInteger(value) || value < 1)) return err("bad-value");
    } else if (key === "order" && value !== "weighted" && value !== "soonest-reset") return err("bad-value");
    else if (key === "moveBy" && value !== "resume" && value !== "handoff") return err("bad-value");
    else if (key === "defaultMember" && value !== null && typeof value !== "string") return err("bad-value");
  }
  const principal = by !== null && by.trim() !== "";
  if (!principal && (change.moveBy === "resume" || (change.turnsPerMember ?? 1) > 1)) return err("needs-principal");
  if (change.defaultMember !== undefined && change.defaultMember !== null && !hasMember(p, change.defaultMember)) return err("unknown-member");
  return ok(noted({ ...p, settings: { ...p.settings, ...change } }, { type: "SettingsChanged", keys: keys.map(String), by, at: now }));
}

// ---- readings and marks

// PL3, PL9: a reading replaces the member's when it is not older. Another identity starts the member fresh. A plan that is
// not paid retires it. A later reading that says ordinary use is allowed ends the marks made before it.
export function recordReading(p: Pool, r: Reading, now: number): Pool {
  const member = p.members.find(m => m.name === r.member);
  if (!member) return p;
  const held = p.readings[r.member];
  if (held && r.at < held.at) return p;
  let next: Pool = { ...p, readings: { ...p.readings, [r.member]: r } };
  const events: PoolEvent[] = [];
  const dropMark = (key: string): void => {
    const model = key === r.member ? null : key.slice(r.member.length + 1);
    events.push({ type: "MarkCleared", member: r.member, model, at: now });
  };
  if (held?.identity != null && r.identity != null && held.identity !== r.identity) {
    const dropped = Object.keys(next.marks).filter(isMarkOf(r.member));
    dropped.forEach(dropMark);
    next = { ...next, marks: without(next.marks, isMarkOf(r.member)) };
  }
  if (r.paid === false && member.retired === null) {
    next = { ...next, members: next.members.map(m => (m.name === r.member ? { ...m, retired: "plan is not a paid plan" } : m)) };
    events.push({ type: "MemberRetired", member: r.member, why: "plan is not a paid plan", at: now });
  }
  if (r.allowed === true) {
    const cleared = Object.entries(next.marks).filter(([key, mark]) => isMarkOf(r.member)(key) && mark.at < r.at).map(([key]) => key);
    cleared.forEach(dropMark);
    next = { ...next, marks: without(next.marks, key => cleared.includes(key)) };
  }
  return noted(next, ...events);
}

// PL8: out until the reset the failure names, else an hour, and never more than a week. When the limit names one model,
// only that model is marked on the member.
export function markOut(p: Pool, member: string, resetAt: number | null, reason: string, now: number, model: string | null = null): Pool {
  if (!hasMember(p, member)) return p;
  const wanted = resetAt ?? now + p.settings.defaultMarkMinutes * MINUTE;
  const until = Math.min(Math.max(wanted, now + MINUTE), now + p.settings.maxMarkHours * HOUR);
  const key = model === null ? member : `${member} ${model}`;
  return noted({ ...p, marks: { ...p.marks, [key]: { until, at: now, reason } } }, { type: "MemberMarkedOut", member, model, until, reason, at: now });
}

// ---- seats

type Left = { left: number | null; resets: number | null };

// A window's headroom: 100 once its reset has passed; the short window is the one with the fewest minutes, the long
// one the most, and a single window is the long one.
function headroom(w: QuotaWindow | undefined, now: number): Left {
  if (!w) return { left: null, resets: null };
  if (w.resetsAt !== null && w.resetsAt <= now) return { left: 100, resets: null };
  return { left: Math.min(100, Math.max(0, 100 - w.usedPercent)), resets: w.resetsAt };
}

function splitWindows(windows: readonly QuotaWindow[]): { short: QuotaWindow | undefined; long: QuotaWindow | undefined } {
  const sorted = [...windows].sort((a, b) => (a.minutes ?? Infinity) - (b.minutes ?? Infinity));
  if (sorted.length === 0) return { short: undefined, long: undefined };
  return { short: sorted.length > 1 ? sorted[0] : undefined, long: sorted[sorted.length - 1] };
}

// Members with one identity are one account (PL2): the first by name is the seat and the others copy it.
export type Groups = { seatOf: Readonly<Record<string, string>>; members: Readonly<Record<string, readonly string[]>> };

export function groupsOf(p: Pool): Groups {
  const byIdentity = new Map<string, string[]>();
  const seatOf: Record<string, string> = {};
  const members: Record<string, string[]> = {};
  for (const m of p.members) {
    const id = p.readings[m.name]?.identity ?? null;
    const first = id === null ? undefined : byIdentity.get(id)?.[0];
    if (id !== null) byIdentity.set(id, [...(byIdentity.get(id) ?? []), m.name]);
    const seat = first ?? m.name;
    seatOf[m.name] = seat;
    members[seat] = [...(members[seat] ?? []), m.name];
  }
  return { seatOf, members };
}

// PL5: the long window's headroom per hour until it resets or the member ends, whichever comes first.
function urgencyOf(longLeft: number | null, longResets: number | null, expires: number | null, now: number): number {
  const ends = [longResets, expires].filter((t): t is number => t !== null);
  const hours = ends.length === 0 ? UNKNOWN_HOURS : Math.max((Math.min(...ends) - now) / HOUR, 1);
  return Math.max(longLeft ?? 100, 0.5) / hours;
}

// PL3: logged out, retired, out, low, ok, checked in that order. Counts (active, busy) are the placement and claim rules' (P3, P4).
export function seats(p: Pool, now: number, model: string | null = null): Seat[] {
  const groups = groupsOf(p);
  return p.members.map(m => {
    const seatName = groups.seatOf[m.name] ?? m.name;
    const group = groups.members[seatName] ?? [m.name];
    const reading = group.map(name => p.readings[name]).filter((r): r is Reading => r !== undefined).sort((a, b) => b.at - a.at)[0];
    const { short, long } = splitWindows(reading?.windows ?? []);
    const s = headroom(short, now);
    const l = headroom(long, now);
    const live = group.flatMap(name => Object.entries(p.marks).filter(([key]) => key === name || (model !== null && key === `${name} ${model}`)))
      .map(([, mark]) => mark).filter(mark => mark.until > now);
    const shortLow = s.left !== null && s.left <= p.settings.shortMinLeft;
    const longLow = l.left !== null && l.left <= p.settings.longMinLeft;
    const expired = m.settings.expires !== null && m.settings.expires <= now;
    let state: SeatState;
    if (reading !== undefined && !reading.signedIn) state = "logged-out";
    else if (m.retired !== null || expired) state = "retired";
    else if (live.length > 0) state = "out";
    else if (shortLow || longLow) state = "low";
    else state = "ok";
    let backAt: number | null = null;
    if (state === "out") backAt = Math.max(...live.map(mark => mark.until));
    if (state === "low") {
      const resets = [shortLow ? s.resets : null, longLow ? l.resets : null].filter((t): t is number => t !== null);
      backAt = resets.length > 0 ? Math.max(...resets) : null;
    }
    return {
      member: m.name, state, sameAs: seatName === m.name ? null : seatName,
      shortLeft: s.left, shortResets: s.resets, longLeft: l.left, longResets: l.resets,
      urgency: urgencyOf(l.left, l.resets, m.settings.expires, now), active: 0, busy: 0,
      credits: reading?.credits?.available ?? 0, backAt,
    };
  });
}
