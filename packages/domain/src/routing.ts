// Routing policy (ADR-0018; R7–R15), in the Engines context. A Priority orders Connection names; a Role's chain is
// derived from its Picks. Pure. Availability never reorders a chain. No vendor is named here.
import { MAX_CHAIN, engineText, type Engine } from "./engines.ts";
import type { Kind } from "./connections.ts";
import { err, ok, type Result } from "./shared.ts";

export type Mode = "subscriptions-first" | "keys-first" | "subscriptions-only" | "keys-only" | "custom";
export type Priority = { mode: Mode; order: readonly string[] };
export type Override = "follow" | "own" | "hand";
export type Listed = { name: string; kind: Kind; models: readonly string[]; efforts: readonly string[] | null };

export type RoleRoute = {
  role: string;
  override: Override;
  priority: Priority | null;
  picks: readonly Engine[];
  riskPicks: readonly Engine[] | null;
  written: readonly string[] | null;
  writtenRisk: readonly string[] | null;
  seenChain: readonly string[] | null;
  seenRisk: readonly string[] | null;
};

export type RouteEvent =
  | { type: "PriorityChanged"; at: number; command: string | null }
  | { type: "OverrideChanged"; role: string; at: number; command: string }
  | { type: "PicksChanged"; role: string; at: number; command: string | null }
  | { type: "ChainProjected"; role: string; at: number; chain: readonly string[] }
  | { type: "ChainDrifted"; role: string; at: number }
  | { type: "ChainKept"; role: string; at: number };

export type Policy = { priority: Priority; roles: readonly RoleRoute[]; events: readonly RouteEvent[] };
export const emptyPolicy = (): Policy => ({ priority: { mode: "subscriptions-first", order: [] }, roles: [], events: [] });

export type RouteProblem = "duplicate" | "unknown" | "empty" | "too_long" | "fit" | "principal" | "missing" | "same" | "copied";

const fail = (problem: RouteProblem, role?: string, name?: string): Result<never, { problem: RouteProblem; role?: string; name?: string }> =>
  err({ problem, ...(role ? { role } : {}), ...(name ? { name } : {}) });

export function checkOrder(order: readonly string[], known: readonly string[]): Result<string[], { problem: RouteProblem; name?: string }> {
  const seen = new Set<string>();
  for (const name of order) {
    if (seen.has(name)) return fail("duplicate", undefined, name);
    seen.add(name);
    if (!known.includes(name)) return fail("unknown", undefined, name);
  }
  return ok([...order]);
}

// R8. Unknown names drop out. Kind filters and partitions are stable. `custom` keeps the order it was given.
export function effectiveOrder(priority: Priority, known: readonly Pick<Listed, "name" | "kind">[]): string[] {
  const kindOf = new Map(known.map(k => [k.name, k.kind]));
  const order = priority.order.filter(n => kindOf.has(n));
  if (priority.mode === "custom") return order;
  const subs = order.filter(n => kindOf.get(n) === "subscription");
  const keys = order.filter(n => kindOf.get(n) === "api-key");
  if (priority.mode === "subscriptions-only") return subs;
  if (priority.mode === "keys-only") return keys;
  return priority.mode === "subscriptions-first" ? [...subs, ...keys] : [...keys, ...subs];
}

export function roleOrder(policy: Policy, role: RoleRoute, known: readonly Pick<Listed, "name" | "kind">[]): string[] {
  if (role.override === "hand") return [];
  const priority = role.override === "own" && role.priority ? role.priority : policy.priority;
  return effectiveOrder(priority, known);
}

// R10. Hand keeps Picks. Otherwise keep Picks whose Connection is in the order, stably sorted by that order.
// Two Picks on one Connection keep the Role's own order.
export function deriveChain(picks: readonly Engine[], order: readonly string[], hand: boolean): Engine[] {
  if (hand) return [...picks];
  const rank = new Map(order.map((n, i) => [n, i]));
  return picks.map((p, i) => ({ p, i })).filter(x => rank.has(x.p.provider))
    .sort((a, b) => (rank.get(a.p.provider) ?? 0) - (rank.get(b.p.provider) ?? 0) || a.i - b.i)
    .map(x => x.p);
}

export const chainText = (entries: readonly Engine[]) => entries.map(engineText);

// A connection with no models listed does not fit: the list has not been read yet (R12). This is not the engine
// layer's rule that a provider listing none takes any model.
function fits(e: Engine, listed: readonly Listed[]): boolean {
  const l = listed.find(x => x.name === e.provider);
  if (!l || l.models.length === 0) return false;
  const model = e.model.split("[")[0] ?? e.model;
  if (!l.models.includes(model)) return false;
  return !e.effort || l.efforts === null || l.efforts.includes(e.effort);
}

function times(entries: readonly string[], text: string): number {
  return entries.reduce((n, x) => n + (x === text ? 1 : 0), 0);
}

// R11. A hand role may keep a copy or an unlisted model it already had. It may not add either, nor a connection this
// node does not know. Growing past max(MAX_CHAIN, its current length) is refused.
function handAdditions(entries: readonly Engine[], current: readonly Engine[], listed: readonly Listed[]): RouteProblem | null {
  const had = current.map(engineText);
  const next = entries.map(engineText);
  for (const entry of entries) {
    if (!had.includes(engineText(entry)) && !listed.some(l => l.name === entry.provider)) return "unknown";
  }
  for (const text of next) {
    if (times(next, text) > 1 && times(next, text) > times(had, text)) return "copied";
  }
  for (const entry of entries) {
    if (!had.includes(engineText(entry)) && !fits(entry, listed)) return "fit";
  }
  return null;
}

// R11. A derived chain must hold 1 to MAX_CHAIN entries, and each Pick must fit.
export function checkChain(entries: readonly Engine[], listed: readonly Listed[], hand: boolean, current: readonly Engine[]): RouteProblem | null {
  if (entries.length === 0) return "empty";
  if (entries.length > (hand ? Math.max(MAX_CHAIN, current.length) : MAX_CHAIN)) return "too_long";
  if (hand) return handAdditions(entries, current, listed);
  if (new Set(entries.map(engineText)).size !== entries.length) return "copied";
  if (entries.some(e => !fits(e, listed))) return "fit";
  return null;
}

function principal(command: string | null): Result<string, { problem: RouteProblem }> {
  return command ? ok(command) : fail("principal");
}

// R11. A priority or override change re-checks every chain it derives. A hand role, and a role with no picks yet, is left for setPicks.
function derivedProblem(policy: Policy, row: RoleRoute, listed: readonly Listed[]): Result<never, { problem: RouteProblem; role?: string }> | null {
  if (row.override === "hand" || row.picks.length === 0) return null;
  const known = listed.map(l => ({ name: l.name, kind: l.kind }));
  const order = roleOrder(policy, row, known);
  const chain = deriveChain(row.picks, order, false);
  const problem = checkChain(chain, listed, false, row.picks);
  if (problem) return fail(problem, row.role);
  if (row.riskPicks) {
    const risk = deriveChain(row.riskPicks, order, false);
    const riskProblem = checkChain(risk, listed, false, row.riskPicks);
    if (riskProblem) return fail(riskProblem, row.role);
  }
  return null;
}

export function setPriority(policy: Policy, priority: Priority, listed: readonly Listed[], command: string, at: number): Result<Policy, { problem: RouteProblem; role?: string; name?: string }> {
  const who = principal(command);
  if (!who.ok) return who;
  const order = checkOrder(priority.order, listed.map(l => l.name));
  if (!order.ok) return order;
  const next: Policy = { ...policy, priority: { ...priority, order: order.value }, events: [...policy.events, { type: "PriorityChanged", at, command }] };
  for (const row of next.roles) {
    const usesGlobal = row.override === "follow" || (row.override === "own" && row.priority === null);
    if (!usesGlobal) continue;
    const bad = derivedProblem(next, row, listed);
    if (bad) return bad;
  }
  return ok(next);
}

export function setOverride(policy: Policy, role: string, override: Override, priority: Priority | null, listed: readonly Listed[], command: string, at: number): Result<Policy, { problem: RouteProblem; role?: string; name?: string }> {
  const who = principal(command);
  if (!who.ok) return who;
  const row = policy.roles.find(r => r.role === role);
  if (!row) return fail("missing", role);
  if (override === "own") {
    if (!priority) return fail("empty", role);
    const order = checkOrder(priority.order, listed.map(l => l.name));
    if (!order.ok) return fail(order.error.problem, role, order.error.name);
  }
  const nextRow: RoleRoute = { ...row, override, priority: override === "own" ? priority : null };
  const next: Policy = { ...policy, roles: policy.roles.map(r => r.role === role ? nextRow : r), events: [...policy.events, { type: "OverrideChanged", role, at, command }] };
  const bad = derivedProblem(next, nextRow, listed);
  if (bad) return bad;
  return ok(next);
}

export function setPicks(policy: Policy, role: string, picks: readonly Engine[], riskPicks: readonly Engine[] | null, listed: readonly Listed[], command: string, at: number): Result<Policy, { problem: RouteProblem; role?: string }> {
  const who = principal(command);
  if (!who.ok) return who;
  const row = policy.roles.find(r => r.role === role);
  if (!row) return fail("missing", role);
  const known = listed.map(l => ({ name: l.name, kind: l.kind }));
  const order = roleOrder(policy, row, known);
  const chain = deriveChain(picks, order, row.override === "hand");
  const risk = riskPicks === null ? null : deriveChain(riskPicks, order, row.override === "hand");
  const problem = checkChain(chain, listed, row.override === "hand", row.picks);
  if (problem) return fail(problem, role);
  if (risk) {
    const riskProblem = checkChain(risk, listed, row.override === "hand", row.riskPicks ?? []);
    if (riskProblem) return fail(riskProblem, role);
  }
  const next: RoleRoute = { ...row, picks, riskPicks };
  return ok({ ...policy, roles: policy.roles.map(r => r.role === role ? next : r), events: [...policy.events, { type: "PicksChanged", role, at, command }] });
}

// One save: override, order and picks land together. Only the resulting chain is checked (R11).
export function setRole(
  policy: Policy, role: string, override: Override, priority: Priority | null, picks: readonly Engine[],
  riskPicks: readonly Engine[] | null, listed: readonly Listed[], command: string, at: number,
): Result<Policy, { problem: RouteProblem; role?: string; name?: string }> {
  const who = principal(command);
  if (!who.ok) return who;
  const base = ensureRole(policy, role);
  const row = base.roles.find(item => item.role === role);
  if (!row) return fail("missing", role);
  let own: Priority | null = null;
  if (override === "own") {
    if (!priority) return fail("empty", role);
    const order = checkOrder(priority.order, listed.map(item => item.name));
    if (!order.ok) return fail(order.error.problem, role, order.error.name);
    own = { mode: priority.mode, order: order.value };
  }
  const nextRow: RoleRoute = override === "hand"
    ? { ...row, override, priority: null }
    : { ...row, override, priority: own, picks, riskPicks };
  const events: RouteEvent[] = [...base.events, { type: "OverrideChanged", role, at, command }];
  if (override !== "hand") events.push({ type: "PicksChanged", role, at, command });
  if (override === "hand") {
    return ok({ ...base, roles: base.roles.map(item => item.role === role ? nextRow : item), events });
  }
  const known = listed.map(item => ({ name: item.name, kind: item.kind }));
  const draft: Policy = { ...base, roles: base.roles.map(item => item.role === role ? nextRow : item), events };
  const chain = deriveChain(nextRow.picks, roleOrder(draft, nextRow, known), false);
  const problem = checkChain(chain, listed, false, row.picks);
  if (problem) return fail(problem, role);
  if (nextRow.riskPicks) {
    const risk = deriveChain(nextRow.riskPicks, roleOrder(draft, nextRow, known), false);
    const riskProblem = checkChain(risk, listed, false, row.riskPicks ?? []);
    if (riskProblem) return fail(riskProblem, role, nextRow.riskPicks.map(engineText).join(" "));
  }
  return ok(draft);
}

export function ensureRole(policy: Policy, role: string): Policy {
  if (policy.roles.some(r => r.role === role)) return policy;
  const row: RoleRoute = { role, override: "hand", priority: null, picks: [], riskPicks: null, written: null, writtenRisk: null, seenChain: null, seenRisk: null };
  return { ...policy, roles: [...policy.roles, row] };
}

// R12. A new Connection goes to the end of the global order.
export function placeNew(policy: Policy, name: string, at: number): Policy {
  if (policy.priority.order.includes(name)) return policy;
  return {
    ...policy,
    priority: { ...policy.priority, order: [...policy.priority.order, name] },
    events: [...policy.events, { type: "PriorityChanged", at, command: null }],
  };
}

// R12. Once it can run, every Role that isn't hand gets the preset's default Pick where the model is listed and the
// chain passes checkChain. A Role that already has that Pick is left as it is. Roles skipped are named. This step is
// not a principal Command.
export function grantDefaults(policy: Policy, name: string, defaults: readonly { role: string; pick: Engine }[], listed: readonly Listed[], at: number): { policy: Policy; skipped: readonly string[] } {
  const known = listed.map(l => ({ name: l.name, kind: l.kind }));
  const skipped: string[] = [];
  let roles = policy.roles;
  const events = [...policy.events];
  for (const d of defaults) {
    const row = roles.find(r => r.role === d.role);
    if (!row || row.override === "hand") continue;
    if (d.pick.provider !== name || !fits(d.pick, listed)) { skipped.push(d.role); continue; }
    if (row.picks.some(p => engineText(p) === engineText(d.pick))) continue;
    const picks = [...row.picks, d.pick];
    const chain = deriveChain(picks, roleOrder({ ...policy, roles }, row, known), false);
    if (checkChain(chain, listed, false, row.picks)) { skipped.push(d.role); continue; }
    roles = roles.map(r => r.role === d.role ? { ...r, picks } : r);
    events.push({ type: "PicksChanged", role: d.role, at, command: null });
  }
  return { policy: { ...policy, roles, events }, skipped };
}

export function project(policy: Policy, role: string, known: readonly Pick<Listed, "name" | "kind">[], at: number): Result<Policy, { problem: RouteProblem; role?: string }> {
  const row = policy.roles.find(r => r.role === role);
  if (!row) return fail("missing", role);
  if (row.override === "hand") return fail("same", role);
  const order = roleOrder(policy, row, known);
  const chain = chainText(deriveChain(row.picks, order, false));
  const derivedRisk = row.riskPicks === null ? null : chainText(deriveChain(row.riskPicks, order, false));
  const risk = derivedRisk !== null && derivedRisk.length === 0 && (row.writtenRisk?.length ?? 0) > 0 ? row.writtenRisk : derivedRisk;
  if (chain.length === 0) {
    if (!row.written?.length) return fail("empty", role);
    return ok({ ...policy, events: [...policy.events, { type: "ChainKept", role, at }] });
  }
  const next: RoleRoute = { ...row, written: chain, writtenRisk: risk };
  return ok({
    ...policy,
    roles: policy.roles.map(r => r.role === role ? next : r),
    events: [...policy.events, { type: "ChainProjected", role, at, chain }],
  });
}

// R14. A derived Role whose chain, or its risk chain, differs from the one last written is drifted. A hand Role never is.
export function drifted(row: RoleRoute, outside: readonly string[], outsideRisk: readonly string[] | null): boolean {
  if (row.override === "hand" || row.written === null) return false;
  if (row.written.join(",") !== outside.join(",")) return true;
  if (row.writtenRisk === null) return (outsideRisk?.length ?? 0) > 0;
  return row.writtenRisk.join(",") !== (outsideRisk ?? []).join(",");
}

export function noteDrift(policy: Policy, role: string, at: number): Policy {
  return { ...policy, events: [...policy.events, { type: "ChainDrifted", role, at }] };
}

// A drift alerts once per outside chain. Seeing the written chain again arms the next drift.
export function observeDrift(policy: Policy, role: string, outside: readonly string[], outsideRisk: readonly string[] | null, at: number): { policy: Policy; alert: boolean } {
  const row = policy.roles.find(item => item.role === role);
  if (!row || !drifted(row, outside, outsideRisk)) return { policy: remember(policy, role, outside, outsideRisk), alert: false };
  if (sameSnapshot(row.seenChain, row.seenRisk, outside, outsideRisk)) return { policy, alert: false };
  return { policy: noteDrift(remember(policy, role, outside, outsideRisk), role, at), alert: true };
}

function sameSnapshot(chain: readonly string[] | null, risk: readonly string[] | null, outside: readonly string[], outsideRisk: readonly string[] | null): boolean {
  if (chain === null) return false;
  const riskText = (rows: readonly string[] | null) => rows === null ? null : rows.join(",");
  return chain.join(",") === outside.join(",") && riskText(risk) === riskText(outsideRisk);
}

function remember(policy: Policy, role: string, outside: readonly string[], outsideRisk: readonly string[] | null): Policy {
  const row = policy.roles.find(item => item.role === role);
  if (!row || sameSnapshot(row.seenChain, row.seenRisk, outside, outsideRisk)) return policy;
  const next: RoleRoute = { ...row, seenChain: [...outside], seenRisk: outsideRisk === null ? null : [...outsideRisk] };
  return { ...policy, roles: policy.roles.map(item => item.role === role ? next : item) };
}

// R15. A revoked Connection leaves every order, and its Picks are removed. An emptied derived chain keeps the last
// chain written. A name still in a written chain is still named, so its provider stays until nothing names it.
export function revokeName(policy: Policy, name: string, known: readonly Pick<Listed, "name" | "kind">[], at: number): { policy: Policy; kept: readonly string[] } {
  const drop = (order: readonly string[]) => order.filter(n => n !== name);
  const priority = { ...policy.priority, order: drop(policy.priority.order) };
  const kept: string[] = [];
  const roles = policy.roles.map(row => {
    const picks = row.picks.filter(p => p.provider !== name);
    const riskPicks = row.riskPicks?.filter(p => p.provider !== name) ?? null;
    const next: RoleRoute = { ...row, picks, riskPicks, priority: row.priority ? { ...row.priority, order: drop(row.priority.order) } : null };
    const order = roleOrder({ ...policy, priority, roles: policy.roles }, next, known);
    const chain = deriveChain(picks, order, false);
    const riskChain = next.riskPicks === null ? null : deriveChain(next.riskPicks, order, false);
    const mainGone = row.override !== "hand" && row.picks.length > 0 && chain.length === 0 && (row.written?.length ?? 0) > 0;
    const riskGone = row.override !== "hand" && (row.riskPicks?.length ?? 0) > 0 && (riskChain?.length ?? 0) === 0 && (row.writtenRisk?.length ?? 0) > 0;
    if (mainGone || riskGone) kept.push(row.role);
    return next;
  });
  const events = [
    ...policy.events,
    { type: "PriorityChanged" as const, at, command: null },
    ...kept.map(role => ({ type: "ChainKept" as const, role, at })),
  ];
  return { policy: { ...policy, priority, roles, events }, kept };
}

export type PlannedChain = { role: string; chain: readonly string[]; risk: readonly string[] | null; keep: boolean };

// What a save should write. Drift, a chain already kept, and length are decided here; the service only persists and writes outside.
export function planWrites(
  policy: Policy,
  known: readonly Pick<Listed, "name" | "kind">[],
  outside: readonly { role: string; chain: readonly string[]; risk: readonly string[] | null }[],
): Result<readonly PlannedChain[], { problem: RouteProblem; role?: string }> {
  const planned: PlannedChain[] = [];
  for (const row of policy.roles) {
    if (row.override === "hand") continue;
    const seen = outside.find(chain => chain.role === row.role);
    if (seen && drifted(row, seen.chain, seen.risk)) continue;
    const prepared = prepareWrite(policy, row, known, seen ?? null);
    if (!prepared.ok) return prepared;
    if (!prepared.value) continue;
    planned.push(prepared.value);
  }
  return ok(planned);
}

// outside null means the chain is missing, so a matching written chain is still a write. force skips that comparison.
export function prepareWrite(
  policy: Policy,
  row: RoleRoute,
  known: readonly Pick<Listed, "name" | "kind">[],
  outside: { chain: readonly string[]; risk: readonly string[] | null } | null | "force",
): Result<PlannedChain | null, { problem: RouteProblem; role?: string }> {
  const order = roleOrder(policy, row, known);
  const chain = chainText(deriveChain(row.picks, order, false));
  const risk = row.riskPicks === null ? null : chainText(deriveChain(row.riskPicks, order, false));
  const sameChain = chain.join(",") === (row.written ?? []).join(",");
  const sameRisk = (risk === null ? null : risk.join(",")) === (row.writtenRisk === null ? null : row.writtenRisk.join(","));
  const outsideAgrees = outside !== null && outside !== "force"
    && outside.chain.join(",") === (row.written ?? []).join(",")
    && (outside.risk === null ? null : outside.risk.join(",")) === (row.writtenRisk === null ? null : row.writtenRisk.join(","));
  if (outside !== "force" && sameChain && sameRisk && outsideAgrees) return ok(null);
  if (chain.length > MAX_CHAIN) return fail("too_long", row.role);
  if (risk && (risk.length === 0 || risk.length > MAX_CHAIN)) return fail("fit", row.role);
  if (chain.length === 0 && !row.written?.length) return fail("empty", row.role);
  if (chain.length === 0 && alreadyKept(policy, row.role)) return ok(null);
  return ok({ role: row.role, chain, risk, keep: chain.length === 0 });
}

function alreadyKept(policy: Policy, role: string): boolean {
  for (let i = policy.events.length - 1; i >= 0; i--) {
    const event = policy.events[i];
    if (!event || !("role" in event) || event.role !== role) continue;
    if (event.type === "ChainKept") return true;
    if (event.type === "ChainProjected" || event.type === "PicksChanged") return false;
  }
  return false;
}

export function stillNamed(policy: Policy, name: string): boolean {
  if (policy.priority.order.includes(name)) return true;
  return policy.roles.some(r =>
    r.picks.some(p => p.provider === name) || (r.riskPicks ?? []).some(p => p.provider === name)
    || (r.written ?? []).some(t => t.startsWith(`${name}:`)) || (r.writtenRisk ?? []).some(t => t.startsWith(`${name}:`)));
}
