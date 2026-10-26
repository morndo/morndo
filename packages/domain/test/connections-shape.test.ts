// CN1, as an allowlist (ADR-0018 §4). A built connection, lease, routing policy and every event has exactly these keys.
// A field whose name looks like a secret fails even if someone adds it to the list.
import { describe, expect, it } from "vitest";
import {
  acknowledge, addKey, addSubscription, closeLease, emptyDirectory, emptyPolicy, ensureRole, lease, loseLease,
  noteDrift, noteHelper, parseEngine, placeNew, project, recordSpend, refresh, revoke, revokeName, reviseTerms, rotate, setBudget,
  setExpiry, setGlobalAuto, setIsolation, setOverride, setPicks, setPriority, setRepo, setTaskCeiling, turnOff, turnOn, type Directory, type Lease, type Policy,
} from "../src/index.ts";

const BANNED = /secret|value|plaintext|apiKey|token/i;

export function keyProblems(value: unknown, allow: readonly string[]): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return ["not-a-record"];
  const keys = Object.keys(value);
  return [
    ...keys.filter(k => !allow.includes(k)).map(k => `extra:${k}`),
    ...allow.filter(k => !keys.includes(k)).map(k => `missing:${k}`),
    ...keys.filter(k => BANNED.test(k)).map(k => `banned:${k}`),
  ];
}

const CONNECTION = ["name", "vendor", "runtime", "status", "terms", "repo", "isolation", "custody", "kind"];
const SUBSCRIPTION = [...CONNECTION, "configDir", "leases"];
const KEY = [...CONNECTION, "ref", "fingerprint", "billing", "budget", "expiry", "spend", "leases", "warned"];
const LEASE = ["id", "connection", "holder", "role", "entry", "runtime", "workspace", "isolation", "start", "reservation", "probe", "calls", "windowStart", "authority"];
const POLICY = ["autoSettings", "events", "priority", "roles"];
const ROLE = ["auto", "override", "picks", "priority", "riskPicks", "role", "seenChain", "seenRisk", "written", "writtenRisk"];
const EVENT: Record<string, readonly string[]> = {
  ConnectionAdded: ["type", "name", "at", "command"],
  ConnectionRotated: ["type", "name", "at", "command", "fingerprint"],
  ConnectionRevoked: ["type", "name", "at", "command"],
  ConnectionTurnedOn: ["type", "name", "at", "command"],
  ConnectionTurnedOff: ["type", "name", "at"],
  TermsAcknowledged: ["type", "name", "at", "command", "revision"],
  TermsChanged: ["type", "name", "at", "revision"],
  RepoListChanged: ["type", "name", "at", "command"],
  IsolationChanged: ["type", "name", "at", "command"],
  BudgetChanged: ["type", "name", "at", "command"],
  ExpiryChanged: ["type", "name", "at", "command"],
  LeaseGranted: ["type", "name", "lease", "at"],
  LeaseRefused: ["type", "name", "at", "reason"],
  LeaseRefreshed: ["type", "name", "lease", "at"],
  LeaseRefreshRefused: ["type", "name", "lease", "at", "reason"],
  LeaseClosed: ["type", "name", "lease", "at", "outcome", "amount", "source", "duration"],
  LeaseLost: ["type", "name", "lease", "at"],
  AuthorityEnded: ["type", "name", "lease", "at", "reason"],
  SpendRecorded: ["type", "name", "at", "amount", "source"],
  SpendReconciled: ["type", "name", "at", "amount", "source"],
  ThresholdCrossed: ["type", "name", "at", "threshold"],
  PriorityChanged: ["type", "at", "command"],
  OverrideChanged: ["type", "role", "at", "command"],
  PicksChanged: ["type", "role", "at", "command"],
  ChainProjected: ["type", "role", "at", "chain"],
  ChainDrifted: ["type", "role", "at"],
  ChainKept: ["type", "role", "at"],
  AutoSwitched: ["type", "scope", "role", "on", "at", "command"],
  AutoSettingsChanged: ["type", "setting", "name", "from", "to", "at", "command"],
};

const T = 1_700_000_000_000;
const who = { kind: "principal" as const, command: "c1" };
const operator = { kind: "operator" as const };
const must = <T>(r: { ok: true; value: T } | { ok: false; error: { problem: string } }): T => {
  if (!r.ok) throw new Error(r.error.problem);
  return r.value;
};

function history(): { dir: Directory; policy: Policy; lease: Lease } {
  let dir = must(addSubscription(emptyDirectory(), {
    name: "sub-a", vendor: "vendor-a", runtime: "runtime-a", isolation: "rules", floor: "rules", configDir: "/cfg",
  }, who, T));
  dir = must(addKey(dir, {
    name: "key-a", vendor: "vendor-a", runtime: "runtime-a", isolation: "rules", floor: "rules",
    ref: "ref-a", fingerprint: "0123456789ab", billing: "metered", budget: { kind: "capped", amount: 10 }, expiry: T + 86_400_000,
  }, who, T));
  dir = must(rotate(dir, "key-a", "ref-b", "0123456789ac", who, T));
  dir = must(acknowledge(dir, "key-a", "r1", "ada", who, T));
  dir = must(setBudget(dir, "key-a", { kind: "capped", amount: 8 }, who, T));
  const ask = {
    now: T, revision: "r1", workspace: { path: "/work", remotes: [] }, dialect: "d",
    runtime: { isolation: "rules" as const, dialects: ["d"] }, floor: "rules" as const, limit: 2, reserve: 1, margin: 0, probe: false,
    holder: { node: "n", pid: 1, startedAt: 1, bootId: "b", lane: null }, role: "implement", entry: "key-a:m", runtimeName: "runtime-a",
  };
  const refused = lease(dir, "sub-a", ask);
  if (refused.ok || !refused.error.directory) throw new Error("expected a recorded refusal");
  dir = refused.error.directory;
  dir = must(acknowledge(dir, "sub-a", "r1", "ada", who, T));
  dir = must(reviseTerms(dir, "key-a", "r2", T));
  dir = must(acknowledge(dir, "key-a", "r2", "ada", who, T));
  dir = must(setIsolation(dir, "key-a", "os", "rules", who, T));
  dir = must(setRepo(dir, "key-a", { allow: [], deny: ["host/no"] }, "rules", who, T));
  dir = must(setExpiry(dir, "key-a", T + 2 * 86_400_000, who, T));
  dir = must(lease(dir, "key-a", { ...ask, revision: "r2", runtime: { isolation: "os", dialects: ["d"] } }));
  const open = dir.connections.find(c => c.name === "key-a");
  const leaseRow = open && open.custody === "morndo" ? open.leases[0] : undefined;
  if (!leaseRow) throw new Error("no open lease");
  dir = must(refresh(dir, "key-a", "l1", T + 1, "r2", 0));
  dir = must(loseLease(dir, "key-a", "l1", T + 1));
  dir = must(lease(dir, "key-a", { ...ask, now: T + 2, revision: "r2", runtime: { isolation: "os", dialects: ["d"] } }));
  const caller = { pid: ask.holder.pid, startedAt: ask.holder.startedAt, bootId: ask.holder.bootId };
  dir = must(noteHelper(dir, "key-a", "l2", caller, [caller], 1, 60_000, T + 2));
  dir = must(noteHelper(dir, "key-a", "l2", caller, [caller], 1, 60_000, T + 3));
  dir = must(recordSpend(dir, "key-a", 1, "estimate", operator, T));
  dir = must(recordSpend(dir, "key-a", 2, "provider", operator, T));
  dir = must(closeLease(dir, "key-a", "l2", "done", 0, "estimate", operator, T + 3, 10));
  dir = must(lease(dir, "key-a", { ...ask, now: T + 4, revision: "r2", runtime: { isolation: "os", dialects: ["d"] } }));
  dir = must(turnOff(dir, "key-a", T + 5));
  dir = must(refresh(dir, "key-a", "l3", T + 6, "r2", 0));
  dir = must(turnOn(dir, "key-a", who, T + 7));
  dir = must(revoke(dir, "sub-a", who, T + 8));
  const pick = parseEngine("key-a:m@high");
  if (!pick) throw new Error("pick");
  let policy = ensureRole(emptyPolicy(), "implement");
  const known = [{ name: "key-a", kind: "api-key" as const, models: ["m"], efforts: ["high"] }];
  policy = must(setOverride(policy, "implement", "follow", null, known, "c1", T));
  policy = must(setPriority(policy, { mode: "custom", order: ["key-a"] }, known, "c1", T));
  policy = placeNew(policy, "key-b", T);
  policy = must(setPicks(policy, "implement", [pick], null, [{ name: "key-a", kind: "api-key", models: ["m"], efforts: ["high"] }], "c1", T));
  policy = must(project(policy, "implement", [{ name: "key-a", kind: "api-key" }], T));
  policy = noteDrift(policy, "implement", T);
  policy = revokeName(policy, "key-a", [{ name: "key-a", kind: "api-key" }], T).policy;
  policy = must(setGlobalAuto(policy, true, "step-up", "c1", T));
  policy = must(setTaskCeiling(policy, 2, "session", "c1", T));
  return { dir, policy, lease: leaseRow };
}

describe("connection and routing shapes", () => {
  it("an added field, and a banned field name, fail the allowlist (negative control)", () => {
    expect(keyProblems({ name: "a", extra: 1 }, ["name"])).toContain("extra:extra");
    expect(keyProblems({ name: "a", secret: "x" }, ["name", "secret"])).toContain("banned:secret");
  });

  it("a built connection, its lease and every event match the allowlist", () => {
    const { dir, policy, lease: openLease } = history();
    expect(keyProblems(openLease, LEASE)).toEqual([]);
    for (const c of dir.connections) {
      const allow = c.kind === "api-key" && c.custody === "morndo" ? KEY : c.kind === "subscription" && c.custody === "morndo" ? SUBSCRIPTION : CONNECTION;
      expect(keyProblems(c, allow), c.name).toEqual([]);
      if (c.custody === "morndo") {
        for (const row of c.leases) expect(keyProblems(row, LEASE), row.id).toEqual([]);
      }
    }
    const seen = new Set<string>();
    for (const event of dir.events) {
      seen.add(event.type);
      expect(keyProblems(event, EVENT[event.type] ?? []), event.type).toEqual([]);
    }
    for (const event of policy.events) {
      seen.add(event.type);
      expect(keyProblems(event, EVENT[event.type] ?? []), event.type).toEqual([]);
    }
    expect(keyProblems(policy, POLICY)).toEqual([]);
    const role = policy.roles[0];
    expect(keyProblems(role, ROLE)).toEqual([]);
    expect(Object.keys(EVENT).filter(t => !seen.has(t))).toEqual([]);
  });
});
