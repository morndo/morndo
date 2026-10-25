// Connections (ADR-0018; CN1–CN15): what the user registered that can run agent work, and the lease gate.
// Pure. The clock is the `now` argument (ms). No secret bytes: a key holds a ref and a fingerprint, computed outside.
import { err, ok, type Result } from "./shared.ts";

export const CONNECTION_NAME = /^[a-z][a-z0-9-]*$/;
export const FINGERPRINT = /^[0-9a-f]{12}$/;
export const LEASE_REFUSED = 75;
export const BUDGET_FRACTIONS = [0.5, 0.8, 0.95] as const;
export const EXPIRY_LEADS_MS = [7, 2, 1].map(d => d * 86_400_000);

export type Kind = "subscription" | "api-key";
export type Custody = "morndo" | "engine-layer";
export type Billing = "metered" | "prepaid";
export type Status = "on" | "off" | "revoked";
export type Isolation = "none" | "rules" | "os";
export type SpendSource = "estimate" | "provider" | "manual" | "balance";
export type Actor = { kind: "principal"; command: string } | { kind: "operator" };
export type Budget = { kind: "capped"; amount: number } | { kind: "unlimited" };
export type TermsAck = { by: string; at: number; revision: string };
export type RepoRule = { allow: readonly string[]; deny: readonly string[] };
export type Spend = { at: number; amount: number; source: SpendSource };
export type Workspace = { path: string; remotes: readonly string[] };
export type Holder = { node: string; pid: number; startedAt: number; bootId: string; lane: string | null };
export type Lease = {
  id: string; connection: string; holder: Holder; role: string; entry: string; runtime: string;
  workspace: string; isolation: Isolation; start: number; reservation: number; probe: boolean;
  calls: number; windowStart: number; authority: "live" | "ended";
};

type Common = {
  name: string; vendor: string; runtime: string; status: Status; terms: TermsAck | null;
  repo: RepoRule | null; isolation: Isolation;
};
export type SubscriptionConnection = Common & {
  custody: "morndo"; kind: "subscription"; configDir: string | null; leases: readonly Lease[];
};
export type KeyConnection = Common & {
  custody: "morndo"; kind: "api-key"; ref: string; fingerprint: string; billing: Billing; budget: Budget;
  expiry: number | null; spend: readonly Spend[]; leases: readonly Lease[]; warned: readonly string[];
};
export type LayerConnection = Common & { custody: "engine-layer"; kind: Kind };
export type Connection = SubscriptionConnection | KeyConnection | LayerConnection;

// Who a served key went to (T-340): the helper's pid and its parent's, and the isolation it was served under, with how that
// is known: `verified` (the parent was read, check 2) or `claimed` (the caller said so; the gate only guards a mistake).
// `lane` and `workspace` are always the caller's claims.
export type KeyCaller = { pid: number; ppid: number | null; lane: string | null; workspace: string; isolation: Isolation; proof: "verified" | "claimed" };

export type ConnEvent =
  | { type: "ConnectionAdded"; name: string; at: number; command: string }
  | { type: "ConnectionRotated"; name: string; at: number; command: string; fingerprint: string }
  | { type: "ConnectionRevoked"; name: string; at: number; command: string }
  | { type: "ConnectionTurnedOn"; name: string; at: number; command: string }
  | { type: "ConnectionTurnedOff"; name: string; at: number }
  | { type: "TermsAcknowledged"; name: string; at: number; command: string; revision: string }
  | { type: "TermsChanged"; name: string; at: number; revision: string }
  | { type: "RepoListChanged"; name: string; at: number; command: string | null }
  | { type: "IsolationChanged"; name: string; at: number; command: string | null }
  | { type: "BudgetChanged"; name: string; at: number; command: string | null }
  | { type: "ExpiryChanged"; name: string; at: number; command: string | null }
  | { type: "LeaseGranted"; name: string; lease: string; at: number }
  | { type: "LeaseRefused"; name: string; at: number; reason: GateReason }
  | { type: "LeaseRefreshed"; name: string; lease: string; at: number }
  | { type: "LeaseRefreshRefused"; name: string; lease: string; at: number; reason: GateReason }
  | { type: "LeaseClosed"; name: string; lease: string; at: number; outcome: string; amount: number; source: SpendSource; duration: number | null }
  | { type: "LeaseLost"; name: string; lease: string; at: number }
  | { type: "AuthorityEnded"; name: string; lease: string; at: number; reason: "helper_limit" }
  | { type: "KeyServed"; name: string; lease: string; at: number; caller: KeyCaller }
  | { type: "SpendRecorded"; name: string; at: number; amount: number; source: "estimate" }
  | { type: "SpendReconciled"; name: string; at: number; amount: number; source: "provider" | "manual" | "balance" }
  | { type: "ThresholdCrossed"; name: string; at: number; threshold: string };

export type Directory = { connections: readonly Connection[]; events: readonly ConnEvent[]; seq: number };
export const emptyDirectory = (): Directory => ({ connections: [], events: [], seq: 1 });

export type Refusal = { problem: Problem; directory?: Directory };
export type Problem = "bad_name" | "taken" | "fingerprint" | "bad_fingerprint" | "bad_ref" | "expiry" | "floor"
  | "principal" | "same" | "revoked" | "missing" | "custody" | "closed" | "held" | "helper" | "kind" | GateReason;
export type GateReason = "off" | "terms" | "expired" | "repo" | "isolation" | "dialect" | "leases" | "budget";

const RANK: Record<Isolation, number> = { none: 0, rules: 1, os: 2 };
const refuse = (problem: Problem): Result<never, Refusal> => err({ problem });
export const isKey = (c: Connection): c is KeyConnection => c.custody === "morndo" && c.kind === "api-key";
export const isMorndo = (c: Connection): c is SubscriptionConnection | KeyConnection => c.custody === "morndo";
export const findConnection = (dir: Directory, name: string) => dir.connections.find(c => c.name === name) ?? null;

function named(name: string): Result<string, Refusal> {
  return CONNECTION_NAME.test(name) ? ok(name) : refuse("bad_name");
}
function principal(actor: Actor): Result<string, Refusal> {
  return actor.kind === "principal" && actor.command ? ok(actor.command) : refuse("principal");
}
function replace(dir: Directory, next: Connection, event: ConnEvent): Directory {
  return {
    connections: dir.connections.map(c => c.name === next.name ? next : c),
    events: [...dir.events, event], seq: dir.seq,
  };
}
function taken(dir: Directory, name: string): boolean {
  return dir.connections.some(c => c.name === name);
}
function fingerprintTaken(dir: Directory, fingerprint: string, except?: string): boolean {
  return dir.connections.some(c => c.name !== except && isKey(c) && c.fingerprint === fingerprint);
}

export type AddCommon = { name: string; vendor: string; runtime: string; isolation: Isolation; floor: Isolation };
export type AddSubscription = AddCommon & { configDir: string | null };
export type AddKey = AddCommon & { ref: string; fingerprint: string; billing: Billing; budget: Budget; expiry: number | null };
export type AddLayer = AddCommon & { kind: Kind };

function base(a: AddCommon): Result<Common, Refusal> {
  const name = named(a.name);
  if (!name.ok) return name;
  if (!a.vendor || !a.runtime) return refuse("bad_name");
  if (RANK[a.isolation] < RANK[a.floor]) return refuse("floor");
  return ok({ name: name.value, vendor: a.vendor, runtime: a.runtime, status: "on", terms: null, repo: null, isolation: a.isolation });
}

function added(dir: Directory, c: Connection, command: string, at: number): Directory {
  return { connections: [...dir.connections, c], events: [...dir.events, { type: "ConnectionAdded", name: c.name, at, command }], seq: dir.seq };
}

export function addSubscription(dir: Directory, a: AddSubscription, actor: Actor, at: number): Result<Directory, Refusal> {
  const who = principal(actor);
  if (!who.ok) return who;
  if (taken(dir, a.name)) return refuse("taken");
  const b = base(a);
  if (!b.ok) return b;
  const c: SubscriptionConnection = { ...b.value, custody: "morndo", kind: "subscription", configDir: a.configDir, leases: [] };
  return ok(added(dir, c, who.value, at));
}

export function addKey(dir: Directory, a: AddKey, actor: Actor, at: number): Result<Directory, Refusal> {
  const who = principal(actor);
  if (!who.ok) return who;
  if (taken(dir, a.name)) return refuse("taken");
  if (!a.ref || /\s/.test(a.ref)) return refuse("bad_ref");
  if (!FINGERPRINT.test(a.fingerprint)) return refuse("bad_fingerprint");
  if (fingerprintTaken(dir, a.fingerprint)) return refuse("fingerprint");
  if (a.billing === "prepaid" && a.expiry === null) return refuse("expiry");
  if (a.expiry !== null && !Number.isFinite(a.expiry)) return refuse("expiry");
  if (a.budget.kind === "capped" && (!Number.isFinite(a.budget.amount) || a.budget.amount <= 0)) return refuse("budget");
  const b = base(a);
  if (!b.ok) return b;
  const c: KeyConnection = {
    ...b.value, custody: "morndo", kind: "api-key", ref: a.ref, fingerprint: a.fingerprint, billing: a.billing,
    budget: a.budget, expiry: a.expiry, spend: [], leases: [], warned: [],
  };
  return ok(added(dir, c, who.value, at));
}

export function addLayer(dir: Directory, a: AddLayer, actor: Actor, at: number): Result<Directory, Refusal> {
  const who = principal(actor);
  if (!who.ok) return who;
  if (taken(dir, a.name)) return refuse("taken");
  const b = base(a);
  if (!b.ok) return b;
  const c: LayerConnection = { ...b.value, custody: "engine-layer", kind: a.kind };
  return ok(added(dir, c, who.value, at));
}

export function rotate(dir: Directory, name: string, ref: string, fingerprint: string, actor: Actor, at: number): Result<Directory, Refusal> {
  const who = principal(actor);
  if (!who.ok) return who;
  const c = findConnection(dir, name);
  if (!c) return refuse("missing");
  if (!isKey(c) || c.status === "revoked") return refuse(c?.status === "revoked" ? "revoked" : "kind");
  if (!ref || /\s/.test(ref)) return refuse("bad_ref");
  if (!FINGERPRINT.test(fingerprint)) return refuse("bad_fingerprint");
  if (fingerprint === c.fingerprint || fingerprintTaken(dir, fingerprint, name)) return refuse("fingerprint");
  const next: KeyConnection = { ...c, ref, fingerprint };
  return ok(replace(dir, next, { type: "ConnectionRotated", name, at, command: who.value, fingerprint }));
}

export function acknowledge(dir: Directory, name: string, revision: string, by: string, actor: Actor, at: number): Result<Directory, Refusal> {
  const who = principal(actor);
  if (!who.ok) return who;
  const c = findConnection(dir, name);
  if (!c) return refuse("missing");
  if (c.status === "revoked") return refuse("revoked");
  if (!revision || revision === "unknown" || !by) return refuse("terms");
  if (c.terms?.revision === revision) return refuse("same");
  return ok(replace(dir, { ...c, terms: { by, at, revision } }, { type: "TermsAcknowledged", name, at, command: who.value, revision }));
}

export function reviseTerms(dir: Directory, name: string, revision: string, at: number): Result<Directory, Refusal> {
  const c = findConnection(dir, name);
  if (!c) return refuse("missing");
  if (c.terms?.revision === revision) return refuse("same");
  return ok(replace(dir, c, { type: "TermsChanged", name, at, revision }));
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(x => b.includes(x));
const sameRepo = (a: RepoRule | null, b: RepoRule | null) =>
  a === b || (a !== null && b !== null && sameSet(a.allow, b.allow) && sameSet(a.deny, b.deny));

export function repoWidens(before: RepoRule | null, after: RepoRule | null): boolean {
  if (sameRepo(before, after)) return false;
  if (before !== null && after === null) return true;
  if (before === null || after === null) return false;
  if (before.deny.some(d => !after.deny.includes(d))) return true;
  if (before.allow.length > 0 && after.allow.length === 0) return true;
  if (before.allow.length > 0 && after.allow.some(a => !before.allow.includes(a))) return true;
  return false;
}

export function setRepo(dir: Directory, name: string, repo: RepoRule | null, floor: Isolation, actor: Actor, at: number): Result<Directory, Refusal> {
  const c = findConnection(dir, name);
  if (!c || !isMorndo(c)) return refuse(c ? "custody" : "missing");
  if (c.status === "revoked") return refuse("revoked");
  if (sameRepo(c.repo, repo)) return refuse("same");
  const widen = repoWidens(c.repo, repo);
  const who = widen ? principal(actor) : ok(actor.kind === "principal" ? actor.command : "");
  if (!who.ok) return who;
  let isolation = c.isolation;
  if (repo !== null && RANK[isolation] < RANK["os"]) isolation = "os";
  if (RANK[isolation] < RANK[floor]) return refuse("floor");
  const command = widen ? who.value : actor.kind === "principal" ? actor.command : null;
  return ok(replace(dir, { ...c, repo, isolation }, { type: "RepoListChanged", name, at, command }));
}

export function setIsolation(dir: Directory, name: string, isolation: Isolation, floor: Isolation, actor: Actor, at: number): Result<Directory, Refusal> {
  const c = findConnection(dir, name);
  if (!c || !isMorndo(c)) return refuse(c ? "custody" : "missing");
  if (c.status === "revoked") return refuse("revoked");
  if (c.isolation === isolation) return refuse("same");
  const need = c.repo ? "os" : floor;
  if (RANK[isolation] < RANK[need]) return refuse("floor");
  const widen = RANK[isolation] < RANK[c.isolation];
  const who = widen ? principal(actor) : ok("");
  if (!who.ok) return who;
  return ok(replace(dir, { ...c, isolation }, { type: "IsolationChanged", name, at, command: widen ? who.value : actor.kind === "principal" ? actor.command : null }));
}

export function turnOff(dir: Directory, name: string, at: number): Result<Directory, Refusal> {
  const c = findConnection(dir, name);
  if (!c) return refuse("missing");
  if (c.status === "revoked") return refuse("revoked");
  if (c.status === "off") return refuse("same");
  return ok(replace(dir, { ...c, status: "off" }, { type: "ConnectionTurnedOff", name, at }));
}

export function turnOn(dir: Directory, name: string, actor: Actor, at: number): Result<Directory, Refusal> {
  const who = principal(actor);
  if (!who.ok) return who;
  const c = findConnection(dir, name);
  if (!c) return refuse("missing");
  if (c.status === "revoked") return refuse("revoked");
  if (c.status === "on") return refuse("same");
  return ok(replace(dir, { ...c, status: "on" }, { type: "ConnectionTurnedOn", name, at, command: who.value }));
}

export function revoke(dir: Directory, name: string, actor: Actor, at: number): Result<Directory, Refusal> {
  const who = principal(actor);
  if (!who.ok) return who;
  const c = findConnection(dir, name);
  if (!c) return refuse("missing");
  if (c.status === "revoked") return refuse("revoked");
  const next = isMorndo(c)
    ? { ...c, status: "revoked" as const, leases: c.leases.map(l => ({ ...l, authority: "ended" as const })) }
    : { ...c, status: "revoked" as const };
  return ok(replace(dir, next, { type: "ConnectionRevoked", name, at, command: who.value }));
}

export function setBudget(dir: Directory, name: string, budget: Budget, actor: Actor, at: number): Result<Directory, Refusal> {
  const c = findConnection(dir, name);
  if (!c || !isKey(c)) return refuse(c ? "kind" : "missing");
  if (c.status === "revoked") return refuse("revoked");
  if (budget.kind === "capped" && (!Number.isFinite(budget.amount) || budget.amount <= 0)) return refuse("budget");
  const same = c.budget.kind === budget.kind && (budget.kind === "unlimited" || c.budget.kind === "capped" && c.budget.amount === budget.amount);
  if (same) return refuse("same");
  const widen = c.budget.kind === "capped" && (budget.kind === "unlimited" || budget.amount > c.budget.amount);
  const who = widen ? principal(actor) : ok("");
  if (!who.ok) return who;
  const next: KeyConnection = { ...c, budget };
  return ok(replace(dir, { ...next, warned: openWarnings(next) }, { type: "BudgetChanged", name, at, command: widen ? who.value : actor.kind === "principal" ? actor.command : null }));
}

export function setExpiry(dir: Directory, name: string, expiry: number | null, actor: Actor, at: number): Result<Directory, Refusal> {
  const c = findConnection(dir, name);
  if (!c || !isKey(c)) return refuse(c ? "kind" : "missing");
  if (c.status === "revoked") return refuse("revoked");
  if (c.billing === "prepaid" && expiry === null) return refuse("expiry");
  if (expiry !== null && !Number.isFinite(expiry)) return refuse("expiry");
  if (c.expiry === expiry) return refuse("same");
  const widen = c.expiry !== null && (expiry === null || expiry > c.expiry);
  const who = widen ? principal(actor) : ok("");
  if (!who.ok) return who;
  const warned = widen ? c.warned.filter(k => !k.startsWith(`${c.name}:expiry:`)) : c.warned;
  return ok(replace(dir, { ...c, expiry, warned }, { type: "ExpiryChanged", name, at, command: widen ? who.value : actor.kind === "principal" ? actor.command : null }));
}

export function spentOf(entries: readonly Spend[]): number {
  let at = -1;
  let amount = 0;
  entries.forEach((e, i) => { if (e.source === "balance") { at = i; amount = e.amount; } });
  const rest = entries.slice(at + 1).reduce((s, e) => s + (e.source === "balance" ? 0 : e.amount), 0);
  return at < 0 ? entries.reduce((s, e) => s + e.amount, 0) : amount + rest;
}

function pattern(p: string, value: string): boolean {
  if (p.includes("*")) {
    const body = p.split("*").map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    return new RegExp(`^${body}$`).test(value);
  }
  return value === p || value.startsWith(p.endsWith("/") ? p : `${p}/`);
}
export function repoAdmits(rule: RepoRule | null, workspace: Workspace): boolean {
  if (!rule) return true;
  const targets = [workspace.path, ...workspace.remotes];
  if (targets.some(t => rule.deny.some(d => pattern(d, t)))) return false;
  if (rule.allow.length === 0) return true;
  return targets.some(t => rule.allow.some(a => pattern(a, t)));
}

export function effectiveIsolation(c: Connection, floor: Isolation): Isolation {
  const ranked = [c.isolation, floor, c.repo ? "os" as const : "none" as const];
  return ranked.reduce((a, b) => RANK[a] >= RANK[b] ? a : b);
}

export function providerArmed(c: Connection, revision: string): boolean {
  if (c.custody !== "engine-layer") return true;
  return c.terms?.revision === revision;
}

export type GateQuery = {
  now: number; revision: string; workspace: Workspace; dialect: string;
  runtime: { isolation: Isolation; dialects: readonly string[] };
  floor: Isolation; limit: number; reserve: number; margin: number; probe: boolean;
};

export function gate(c: SubscriptionConnection | KeyConnection, q: GateQuery): Result<{ reservation: number }, { problem: GateReason }> {
  if (c.status !== "on") return err({ problem: "off" });
  if (c.terms?.revision !== q.revision) return err({ problem: "terms" });
  if (isKey(c) && c.expiry !== null && q.now >= c.expiry) return err({ problem: "expired" });
  if (!repoAdmits(c.repo, q.workspace)) return err({ problem: "repo" });
  const need = effectiveIsolation(c, q.floor);
  if (RANK[q.runtime.isolation] < RANK[need]) return err({ problem: "isolation" });
  if (!q.runtime.dialects.includes(q.dialect)) return err({ problem: "dialect" });
  const live = c.leases.filter(l => l.authority === "live");
  if (live.length >= q.limit) return err({ problem: "leases" });
  if (!isKey(c)) return ok({ reservation: 0 });
  if (!Number.isFinite(q.reserve) || !Number.isFinite(q.margin)) return err({ problem: "budget" });
  if (c.budget.kind === "unlimited") return ok({ reservation: q.probe ? 0 : q.reserve });
  const reserved = live.reduce((s, l) => s + l.reservation, 0);
  const spent = spentOf(c.spend);
  if (!Number.isFinite(c.budget.amount) || !Number.isFinite(spent) || !Number.isFinite(reserved)) return err({ problem: "budget" });
  const room = c.budget.amount - spent - reserved - q.margin;
  if (!(room > 0)) return err({ problem: "budget" });
  if (q.probe) return ok({ reservation: 0 });
  const reservation = Math.min(q.reserve, room);
  if (!(reservation > 0)) return err({ problem: "budget" });
  return ok({ reservation });
}

export type LeaseAsk = GateQuery & { holder: Holder; role: string; entry: string; runtimeName: string };

export function lease(dir: Directory, name: string, ask: LeaseAsk): Result<Directory, Refusal> {
  const c = findConnection(dir, name);
  if (!c) return refuse("missing");
  if (c.custody === "engine-layer") return refuse("custody");
  const g = gate(c, ask);
  if (!g.ok) return err({ problem: g.error.problem, directory: replace(dir, c, { type: "LeaseRefused", name, at: ask.now, reason: g.error.problem }) });
  const id = `l${dir.seq}`;
  const row: Lease = {
    id, connection: name, holder: ask.holder, role: ask.role, entry: ask.entry, runtime: ask.runtimeName,
    workspace: ask.workspace.path, isolation: effectiveIsolation(c, ask.floor), start: ask.now,
    reservation: g.value.reservation, probe: ask.probe, calls: 0, windowStart: ask.now, authority: "live",
  };
  const next = { ...c, leases: [...c.leases, row] };
  const granted: Directory = {
    connections: dir.connections.map(x => x.name === name ? next : x),
    events: [...dir.events, { type: "LeaseGranted", name, lease: id, at: ask.now }],
    seq: dir.seq + 1,
  };
  return ok(isKey(next) ? applyWarnings(granted, next, ask.now) : granted);
}

function endLease(c: SubscriptionConnection | KeyConnection, id: string): SubscriptionConnection | KeyConnection {
  return { ...c, leases: c.leases.filter(l => l.id !== id) };
}

function endAuthority(c: SubscriptionConnection | KeyConnection, id: string): SubscriptionConnection | KeyConnection {
  return { ...c, leases: c.leases.map(l => l.id === id ? { ...l, authority: "ended" as const } : l) };
}

export function refresh(dir: Directory, name: string, id: string, now: number, revision: string, margin: number): Result<Directory, Refusal> {
  const c = findConnection(dir, name);
  if (!c || !isMorndo(c)) return refuse(c ? "custody" : "missing");
  const row = c.leases.find(l => l.id === id);
  if (!row) return refuse("closed");
  if (row.authority === "ended") return refuse("closed");
  const reason = c.status !== "on" ? "off" as const
    : c.terms?.revision !== revision ? "terms" as const
    : isKey(c) && c.expiry !== null && now >= c.expiry ? "expired" as const
    : null;
  const others = c.leases.reduce((s, l) => s + (l.id === id || l.authority !== "live" ? 0 : l.reservation), 0);
  const room = isKey(c) && c.budget.kind === "capped" ? c.budget.amount - spentOf(c.spend) - others - margin : Number.POSITIVE_INFINITY;
  const over = isKey(c) && c.budget.kind === "capped" && !(room > 0);
  const why = reason ?? (over ? "budget" as const : null);
  if (why) return ok(replace(dir, endAuthority(c, id), { type: "LeaseRefreshRefused", name, lease: id, at: now, reason: why }));
  return ok(replace(dir, c, { type: "LeaseRefreshed", name, lease: id, at: now }));
}

export function closeLease(dir: Directory, name: string, id: string, outcome: string, amount: number, source: SpendSource, actor: Actor, at: number, duration: number | null): Result<Directory, Refusal> {
  const c = findConnection(dir, name);
  if (!c || !isMorndo(c)) return refuse(c ? "custody" : "missing");
  if (!c.leases.some(l => l.id === id)) return refuse("closed");
  if (!Number.isFinite(amount)) return refuse("budget");
  let next: Connection = endLease(c, id);
  if (isKey(next) && amount > 0) {
    const entry: Spend = { at, amount, source };
    const lowers = amount < 0 || spentOf([...next.spend, entry]) < spentOf(next.spend);
    if (lowers && !principal(actor).ok) return refuse("principal");
    const withSpend: KeyConnection = { ...next, spend: [...next.spend, entry] };
    next = { ...withSpend, warned: openWarnings(withSpend) };
  }
  const closed = replace(dir, next, { type: "LeaseClosed", name, lease: id, at, outcome, amount, source, duration });
  return ok(isKey(next) ? applyWarnings(closed, next, at) : closed);
}

export function loseLease(dir: Directory, name: string, id: string, at: number): Result<Directory, Refusal> {
  const c = findConnection(dir, name);
  if (!c || !isMorndo(c)) return refuse(c ? "custody" : "missing");
  if (!c.leases.some(l => l.id === id)) return refuse("closed");
  return ok(replace(dir, endLease(c, id), { type: "LeaseLost", name, lease: id, at }));
}

export function recordSpend(dir: Directory, name: string, amount: number, source: SpendSource, actor: Actor, at: number): Result<Directory, Refusal> {
  const c = findConnection(dir, name);
  if (!c || !isKey(c)) return refuse(c ? "kind" : "missing");
  if (!Number.isFinite(amount) || (source === "estimate" && amount < 0)) return refuse("budget");
  const entry: Spend = { at, amount, source };
  const lowers = amount < 0 || spentOf([...c.spend, entry]) < spentOf(c.spend);
  const who = lowers ? principal(actor) : ok("");
  if (!who.ok) return who;
  const withSpend: KeyConnection = { ...c, spend: [...c.spend, entry] };
  const next: KeyConnection = { ...withSpend, warned: openWarnings(withSpend) };
  const event: ConnEvent = source === "estimate"
    ? { type: "SpendRecorded", name, at, amount, source }
    : { type: "SpendReconciled", name, at, amount, source };
  return ok(applyWarnings(replace(dir, next, event), next, at));
}

export type HelperWindow = { calls: number; windowStart: number };

// The count a helper call applies: inside the window it adds one, past it the window starts over at one.
export function nextHelperWindow(w: HelperWindow, limit: number, intervalMs: number, now: number): HelperWindow & { over: boolean } {
  const inWindow = now - w.windowStart < intervalMs;
  const calls = inWindow ? w.calls + 1 : 1;
  return { calls, windowStart: inWindow ? w.windowStart : now, over: calls > limit };
}

export function noteHelper(
  dir: Directory, name: string, id: string, caller: Pick<Holder, "pid" | "startedAt" | "bootId">,
  ancestors: readonly Pick<Holder, "pid" | "startedAt" | "bootId">[], limit: number, intervalMs: number, now: number,
): Result<Directory, Refusal> {
  const c = findConnection(dir, name);
  if (!c || !isMorndo(c)) return refuse(c ? "custody" : "missing");
  const row = c.leases.find(l => l.id === id);
  if (!row || row.authority === "ended") return refuse("closed");
  const matches = (a: Pick<Holder, "pid" | "startedAt" | "bootId">, b: Pick<Holder, "pid" | "startedAt" | "bootId">) =>
    a.pid === b.pid && a.startedAt === b.startedAt && a.bootId === b.bootId;
  const holder = row.holder;
  if (!ancestors.some(a => matches(a, holder)) && !matches(caller, holder)) return refuse("helper");
  const counted = nextHelperWindow(row, limit, intervalMs, now);
  if (counted.over) return ok(replace(dir, endAuthority(c, id), { type: "AuthorityEnded", name, lease: id, at: now, reason: "helper_limit" }));
  const next = { ...c, leases: c.leases.map(l => l.id === id ? { ...l, calls: counted.calls, windowStart: counted.windowStart } : l) };
  return ok({ ...dir, connections: dir.connections.map(x => x.name === name ? next : x) });
}

function heldLease(dir: Directory, name: string, id: string): Lease | null {
  const c = findConnection(dir, name);
  if (!c || !isMorndo(c)) return null;
  return c.leases.find(l => l.id === id) ?? null;
}

function paintWindow(dir: Directory, name: string, id: string, window: HelperWindow): Directory {
  const c = findConnection(dir, name);
  if (!c || !isMorndo(c)) return dir;
  const leases = c.leases.map(l => l.id === id ? { ...l, calls: window.calls, windowStart: window.windowStart } : l);
  return { ...dir, connections: dir.connections.map(x => x.name === name ? { ...c, leases } : x) };
}

function sameProc(a: Pick<Holder, "pid" | "startedAt" | "bootId">, b: Pick<Holder, "pid" | "startedAt" | "bootId">): boolean {
  return a.pid === b.pid && a.startedAt === b.startedAt && a.bootId === b.bootId;
}

// A live lease this holder already has on one of these connections. Checked only when nothing is being closed.
function alreadyHeld(dir: Directory, alone: { holder: Holder; members: readonly string[] }): boolean {
  for (const name of alone.members) {
    const c = findConnection(dir, name);
    if (!c || !isMorndo(c)) continue;
    if (c.leases.some(row => row.authority === "live" && sameProc(row.holder, alone.holder))) return true;
  }
  return false;
}

// The new lease is granted first. A gate refusal keeps the old lease and the LeaseRefused directory; any other refusal
// carries no directory, so neither side of the hand-off is saved. With nothing to close, a holder who already has a live
// lease on the named connections is refused before the gate: two callers must not each grant one.
export function swapLease(
  dir: Directory, to: string, ask: LeaseAsk,
  close: { connection: string; lease: string } | null, window: HelperWindow,
  alone?: { holder: Holder; members: readonly string[] },
): Result<Directory, Refusal> {
  if (!close && alone && alreadyHeld(dir, alone)) return refuse("held");
  const old = close ? heldLease(dir, close.connection, close.lease) : null;
  if (close && !old) return refuse("closed");
  const granted = lease(dir, to, ask);
  if (!granted.ok) return granted;
  const next = paintWindow(granted.value, to, `l${dir.seq}`, window);
  if (!close || !old) return ok(next);
  const closed = closeLease(next, close.connection, old.id, "handoff", old.reservation, "estimate", { kind: "operator" }, ask.now, ask.now - old.start);
  if (!closed.ok) return refuse(closed.error.problem);
  return closed;
}

// One served key is one audit line with its caller, never a value (T-340): the bytes go only to the caller's stdout.
export function serveKey(dir: Directory, name: string, id: string, caller: KeyCaller, now: number): Result<Directory, Refusal> {
  const c = findConnection(dir, name);
  if (!c) return refuse("missing");
  if (!isKey(c)) return refuse("custody");
  const row = c.leases.find(l => l.id === id);
  if (!row || row.authority === "ended") return refuse("closed");
  return ok(replace(dir, c, { type: "KeyServed", name, lease: id, at: now, caller }));
}

// CN12. A check run warns every key from spend and from the clock, including a key with no lease.
export function check(dir: Directory, now: number): Directory {
  return dir.connections.reduce((d, c) => isKey(c) ? applyWarnings(d, c, now) : d, dir);
}

function openWarnings(c: KeyConnection): readonly string[] {
  if (c.budget.kind !== "capped" || !(c.budget.amount > 0)) {
    return c.warned.filter(k => !BUDGET_FRACTIONS.some(f => k === `${c.name}:${f}`));
  }
  const ratio = spentOf(c.spend) / c.budget.amount;
  return c.warned.filter(k => !BUDGET_FRACTIONS.some(f => k === `${c.name}:${f}` && ratio < f));
}

function applyWarnings(dir: Directory, c: KeyConnection, now: number): Directory {
  const fresh: string[] = [];
  if (c.budget.kind === "capped" && c.budget.amount > 0) {
    const ratio = spentOf(c.spend) / c.budget.amount;
    for (const f of BUDGET_FRACTIONS) if (ratio >= f) fresh.push(`${c.name}:${f}`);
  }
  if (c.expiry !== null) {
    for (const lead of EXPIRY_LEADS_MS) if (c.expiry - now <= lead) fresh.push(`${c.name}:expiry:${lead}`);
  }
  const crossed = fresh.filter(k => !c.warned.includes(k));
  if (!crossed.length) return dir;
  const next: KeyConnection = { ...c, warned: [...c.warned, ...crossed] };
  return {
    connections: dir.connections.map(x => x.name === c.name ? next : x),
    events: [...dir.events, ...crossed.map(threshold => ({ type: "ThresholdCrossed" as const, name: c.name, at: now, threshold }))],
    seq: dir.seq,
  };
}

export type Availability = "ready" | "off" | "revoked" | "terms" | "expired" | "budget" | "unarmed";
export function availability(c: Connection, now: number, revision: string): Availability {
  if (c.status === "revoked") return "revoked";
  if (c.status === "off") return "off";
  if (c.terms?.revision !== revision) return "terms";
  if (!providerArmed(c, revision)) return "unarmed";
  if (isKey(c) && c.expiry !== null && now >= c.expiry) return "expired";
  if (isKey(c) && c.budget.kind === "capped") {
    const room = c.budget.amount - spentOf(c.spend) - c.leases.reduce((s, l) => s + (l.authority === "live" ? l.reservation : 0), 0);
    if (!(room > 0)) return "budget";
  }
  return "ready";
}
