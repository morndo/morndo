// Key pool (ADR-0037; KP1-KP15): which API-key Connection serves the next request, and the rules around it. One history per
// invariant, and a negative control where a guard could silently go missing. `now` is the clock; nothing here reads it.
// Names, refs and fingerprints are synthetic; the planted values must never reach a pool, its events or its JSON.
import { describe, expect, it } from "vitest";
import {
  acknowledgeKeyPoolTerms, addKey, addLayer, addSubscription, chooseKey, createKeyPool, joinKeyPool, keyPicked, keyPoolStanding,
  keyPoolBackAt, keyRotated, leaveKeyPool, moveKeyMember, reportKeyOutcome, reviveKey, revoke, setKeyPoolPolicy, settleKeyPool,
  type Actor, type Connection, type Directory, type KeyPool, type Names, type Outcome,
  emptyDirectory, findConnection, newKeyPoolEvents,
} from "../src/index.ts";

const T = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const principal = (command = "c1"): Actor => ({ kind: "principal", command });
const operator: Actor = { kind: "operator" };
const PLANTED_REF = "ref-planted-vault-0001";
const PLANTED_FP = "feedfacecafe";
const NO_NAMES: Names = { connections: [], pools: [], deleted: [] };

function ok<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.error)}`);
  return r.value;
}
const word = (r: { ok: boolean; error?: unknown }): string => {
  if (r.ok) return "ok";
  const e = r.error;
  return typeof e === "string" ? e : (e as { problem: string }).problem;
};

// A directory of key Connections k1..kN (vendor v, runtime r), each with its own fingerprint and ref.
function keys(n: number, over: { vendor?: string; runtime?: string } = {}): Directory {
  let dir = emptyDirectory();
  for (let i = 1; i <= n; i++) {
    dir = ok(addKey(dir, {
      name: `k${i}`, vendor: over.vendor ?? "v", runtime: over.runtime ?? "r", isolation: "rules", floor: "rules",
      ref: i === 1 ? PLANTED_REF : `ref-k${i}`, fingerprint: i === 1 ? PLANTED_FP : `0123456789a${i}`,
      billing: "metered", budget: { kind: "unlimited" }, expiry: null,
    }, principal(), T));
  }
  return dir;
}
const conn = (dir: Directory, name: string): Connection => {
  const c = findConnection(dir, name);
  if (!c) throw new Error(`no ${name}`);
  return c;
};

// A pool "p" over k1..kN, members joined in order, each as the owner's own account.
function pool(n: number, mode: "round-robin" | "drain" = "round-robin"): KeyPool {
  const dir = keys(n);
  let p = ok(createKeyPool({ name: "p", runtime: "r", vendor: "v", policy: { mode, recheckEveryMs: DAY } }, { connections: dir.connections.map(c => c.name), pools: [], deleted: [] }, principal(), T));
  for (let i = 1; i <= n; i++) p = ok(joinKeyPool(p, conn(dir, `k${i}`), { elsewhere: [] }, null, true, principal(), T));
  return p;
}
const exhausted = (reason: "credit" | "spend-limit" = "credit", resumeAt: number | null = null): Outcome => ({ kind: "exhausted", reason, resumeAt });
const picks = (p: KeyPool, n: number): { names: string[]; pool: KeyPool } => {
  const names: string[] = [];
  let cur = p;
  for (let i = 0; i < n; i++) {
    const chosen = ok(chooseKey(cur));
    names.push(chosen.member);
    cur = chosen.pool;
  }
  return { names, pool: cur };
};
const roundTrip = (p: KeyPool): KeyPool => JSON.parse(JSON.stringify(p)) as KeyPool;
const mark = (p: KeyPool, member: string, outcome: Outcome, at = T + MIN): KeyPool => ok(reportKeyOutcome(p, member, outcome, at, at));

describe("kp1 names are unique across pools, Connections (revoked included) and deleted pools", () => {
  const input = (name: string) => ({ name, runtime: "r", vendor: "v" });
  it("refuses a bad name, a pool name, a Connection name, a revoked Connection's name and a deleted pool's name", () => {
    expect(word(createKeyPool(input("Bad Name"), NO_NAMES, principal(), T))).toBe("bad_name");
    expect(word(createKeyPool(input("1abc"), NO_NAMES, principal(), T))).toBe("bad_name");
    expect(word(createKeyPool(input("p"), { ...NO_NAMES, pools: ["p"] }, principal(), T))).toBe("taken");
    expect(word(createKeyPool(input("k1"), { ...NO_NAMES, connections: ["k1"] }, principal(), T))).toBe("taken");
    const dir = ok(revoke(keys(1), "k1", principal(), T));
    expect(conn(dir, "k1").status).toBe("revoked");
    expect(word(createKeyPool(input("k1"), { ...NO_NAMES, connections: dir.connections.map(c => c.name) }, principal(), T))).toBe("taken");
    expect(word(createKeyPool(input("gone"), { ...NO_NAMES, deleted: ["gone"] }, principal(), T))).toBe("taken");
    expect(word(createKeyPool(input("fresh-1"), NO_NAMES, principal(), T))).toBe("ok");
  });
  it("starts with defaults round-robin and 24 h, and an event that carries the command id", () => {
    const p = ok(createKeyPool(input("p"), NO_NAMES, principal("cmd-9"), T));
    expect(p.policy).toEqual({ mode: "round-robin", recheckEveryMs: DAY });
    expect(p.members).toEqual([]);
    expect(p.events).toEqual([{ type: "KeyPoolCreated", pool: "p", at: T, command: "cmd-9" }]);
  });
  it("kp10 creating a pool is the principal's", () => {
    expect(word(createKeyPool(input("p"), NO_NAMES, operator, T))).toBe("principal");
    expect(word(createKeyPool(input("p"), NO_NAMES, { kind: "principal", command: "" }, T))).toBe("principal");
  });
  it("refuses a recheck outside 1 h to 7 d and an unknown mode", () => {
    const bad = (policy: { mode: "round-robin" | "drain"; recheckEveryMs: number }) => word(createKeyPool({ ...input("p"), policy }, NO_NAMES, principal(), T));
    expect(bad({ mode: "drain", recheckEveryMs: HOUR - 1 })).toBe("bad_policy");
    expect(bad({ mode: "drain", recheckEveryMs: 7 * DAY + 1 })).toBe("bad_policy");
    expect(bad({ mode: "drain", recheckEveryMs: HOUR })).toBe("ok");
    expect(bad({ mode: "drain", recheckEveryMs: 7 * DAY })).toBe("ok");
    expect(bad({ mode: "random" as "drain", recheckEveryMs: DAY })).toBe("bad_policy");
  });
});

describe("kp2 who can join", () => {
  const base = () => ok(createKeyPool({ name: "p", runtime: "r", vendor: "v" }, NO_NAMES, principal(), T));
  const join = (p: KeyPool, c: Connection, elsewhere: string[] = []) => joinKeyPool(p, c, { elsewhere }, null, true, principal(), T);
  it("takes an api-key Connection of the pool's vendor and runtime", () => {
    const p = ok(join(base(), conn(keys(1), "k1")));
    expect(p.members.map(m => m.credential)).toEqual(["k1"]);
    expect(p.members[0]?.health).toEqual({ state: "active" });
  });
  it("refuses a subscription, an engine-layer Connection, a key of another vendor or runtime, a revoked one", () => {
    const sub = ok(addSubscription(emptyDirectory(), { name: "s1", vendor: "v", runtime: "r", isolation: "rules", floor: "rules", configDir: "/cfg/s1" }, principal(), T));
    const layer = ok(addLayer(emptyDirectory(), { name: "l1", vendor: "v", runtime: "r", isolation: "rules", floor: "rules", kind: "api-key" }, principal(), T));
    expect(word(join(base(), conn(sub, "s1")))).toBe("not_a_key");
    expect(word(join(base(), conn(layer, "l1")))).toBe("not_a_key");
    expect(word(join(base(), conn(keys(1, { vendor: "other" }), "k1")))).toBe("other_vendor");
    expect(word(join(base(), conn(keys(1, { runtime: "other" }), "k1")))).toBe("other_runtime");
    expect(word(join(base(), conn(ok(revoke(keys(1), "k1", principal(), T)), "k1")))).toBe("revoked");
  });
  it("refuses a member twice, and a Connection that is in another key pool", () => {
    const p = ok(join(base(), conn(keys(1), "k1")));
    expect(word(join(p, conn(keys(1), "k1")))).toBe("exists");
    expect(word(join(base(), conn(keys(1), "k1"), ["k1"]))).toBe("in_pool");
  });
  it("kp10 adding a member is the principal's", () => {
    expect(word(joinKeyPool(base(), conn(keys(1), "k1"), { elsewhere: [] }, null, true, operator, T))).toBe("principal");
  });
});

describe("own account (terms): a pool holds only keys of accounts the owner holds", () => {
  const base = () => ok(createKeyPool({ name: "p", runtime: "r", vendor: "v" }, NO_NAMES, principal(), T));
  const k = (n = 1) => conn(keys(n), `k${n}`);
  it("refuses a member whose organization is unknown or not confirmed, until the principal confirms", () => {
    expect(word(joinKeyPool(base(), k(), { elsewhere: [] }, null, false, principal(), T))).toBe("foreign_organization");
    expect(word(joinKeyPool(base(), k(), { elsewhere: [] }, "org-x", false, principal(), T))).toBe("foreign_organization");
  });
  it("a confirmation adds the organization to ownedOrgs and writes OwnerConfirmed with the command id; the id is in no event", () => {
    const p = ok(joinKeyPool(base(), k(), { elsewhere: [] }, "org-secret-id", true, principal("cmd-7"), T));
    expect(p.ownedOrgs).toEqual(["org-secret-id"]);
    expect(p.events.find(e => e.type === "OwnerConfirmed")).toEqual({ type: "OwnerConfirmed", member: "k1", at: T, command: "cmd-7" });
    expect(JSON.stringify(p.events)).not.toContain("org-secret-id");
  });
  it("a member of a confirmed organization joins without the flag", () => {
    const first = ok(joinKeyPool(base(), k(1), { elsewhere: [] }, "org-a", true, principal(), T));
    const second = ok(joinKeyPool(first, conn(keys(2), "k2"), { elsewhere: [] }, "org-a", false, principal(), T));
    expect(second.members.map(m => m.credential)).toEqual(["k1", "k2"]);
    expect(second.events.filter(e => e.type === "OwnerConfirmed")).toHaveLength(1);
  });
  it("negative control: the same member from a different organization is still refused without the flag", () => {
    const first = ok(joinKeyPool(base(), k(1), { elsewhere: [] }, "org-a", true, principal(), T));
    expect(word(joinKeyPool(first, conn(keys(2), "k2"), { elsewhere: [] }, "org-b", false, principal(), T))).toBe("foreign_organization");
  });
  it("a confirmation with no readable organization records the confirmation and no organization", () => {
    const p = ok(joinKeyPool(base(), k(), { elsewhere: [] }, null, true, principal("c3"), T));
    expect(p.ownedOrgs).toEqual([]);
    expect(p.events.map(e => e.type)).toContain("OwnerConfirmed");
  });
});

describe("terms acknowledgement (CN4 pattern)", () => {
  it("is the principal's, records who and which revision, and replaces an older one", () => {
    const p = ok(createKeyPool({ name: "p", runtime: "r", vendor: "v" }, NO_NAMES, principal(), T));
    expect(p.terms).toBeNull();
    expect(word(acknowledgeKeyPoolTerms(p, "2026-10-25", "ada", operator, T))).toBe("principal");
    const a = ok(acknowledgeKeyPoolTerms(p, "2026-10-25", "ada", principal("c2"), T + 1));
    expect(a.terms).toEqual({ by: "ada", at: T + 1, revision: "2026-10-25" });
    expect(a.events.at(-1)).toEqual({ type: "TermsAcknowledged", revision: "2026-10-25", by: "ada", at: T + 1, command: "c2" });
    expect(ok(acknowledgeKeyPoolTerms(a, "2027-01-01", "bo", principal(), T + 2)).terms?.revision).toBe("2027-01-01");
  });
});

describe("kp3 an exhausted member is never picked; a failing member blocks the pool", () => {
  it("skips an exhausted member whatever the cursor and the mode", () => {
    for (const mode of ["round-robin", "drain"] as const) {
      const p = mark(pool(3, mode), "k2", exhausted());
      for (const cursor of [null, "k1", "k2", "k3"]) {
        const at = { ...p, cursor };
        const { names } = picks(at, 6);
        expect(names, `${mode} cursor ${cursor}`).not.toContain("k2");
      }
    }
  });
  it("negative control: with the guard removed the exhausted member is picked (the test can fail)", () => {
    const p = mark(pool(3), "k2", exhausted());
    const unguarded = { ...p, members: p.members.map(m => ({ ...m, health: { state: "active" as const } })) };
    expect(picks({ ...unguarded, cursor: "k1" }, 1).names).toEqual(["k2"]);
  });
  it("a failing member blocks every pick with pool_blocked, whatever the cursor and the mode", () => {
    for (const mode of ["round-robin", "drain"] as const) {
      const p = mark(pool(3, mode), "k2", { kind: "failing", reason: "denied" });
      for (const cursor of [null, "k1", "k2", "k3"]) {
        const r = chooseKey({ ...p, cursor });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toEqual({ problem: "pool_blocked", member: "k2", reason: "denied" });
      }
    }
  });
});

describe("kp4 rotation order is deterministic and survives restarts", () => {
  it("round-robin follows the join order and wraps", () => {
    expect(picks(pool(3), 7).names).toEqual(["k1", "k2", "k3", "k1", "k2", "k3", "k1"]);
  });
  it("round-robin takes the first servable member after the cursor", () => {
    const p = { ...mark(pool(4), "k3", exhausted()), cursor: "k2" };
    expect(picks(p, 4).names).toEqual(["k4", "k1", "k2", "k4"]);
  });
  it("drain stays on the cursor's member while it is servable, then moves on and stays there", () => {
    let p = pool(3, "drain");
    expect(picks(p, 3).names).toEqual(["k1", "k1", "k1"]);
    p = mark(picks(p, 2).pool, "k1", exhausted());
    const next = picks(p, 3);
    expect(next.names).toEqual(["k2", "k2", "k2"]);
    expect(picks(mark(next.pool, "k2", exhausted()), 2).names).toEqual(["k3", "k3"]);
  });
  it("the same state picks the same member after a save and a load", () => {
    const p = picks(pool(3), 2).pool;
    expect(picks(roundTrip(p), 3).names).toEqual(picks(p, 3).names);
    expect(ok(chooseKey(roundTrip(p))).member).toBe("k3");
  });
  it("a pick sets the cursor and nothing else about the members", () => {
    const p = pool(3);
    const r = ok(chooseKey(p));
    expect(r.pool.cursor).toBe("k1");
    expect(r.pool.members).toEqual(p.members);
  });
  it("skip leaves out members a gate declined, and the cursor moves to the one finally chosen", () => {
    const r = ok(chooseKey(pool(3), ["k1"]));
    expect(r.member).toBe("k2");
    expect(r.pool.cursor).toBe("k2");
    expect(word(chooseKey(pool(2), ["k1", "k2"]))).toBe("none_left");
  });
});

describe("kp5 a pick that finds no servable member refuses and serves nothing", () => {
  it("pool_empty carries the earliest return time and never an exhausted member", () => {
    let p = pool(3);
    p = mark(p, "k1", exhausted("spend-limit", T + 3 * DAY), T + MIN);
    p = mark(p, "k2", exhausted("credit"), T + 2 * MIN);
    p = mark(p, "k3", exhausted("credit"), T + 3 * MIN);
    const r = chooseKey(p);
    expect(r.ok).toBe(false);
    // k1 resumes at its date; k2 and k3 are due again one recheck interval after they were marked
    if (!r.ok) expect(r.error).toEqual({ problem: "pool_empty", backAt: T + 2 * MIN + DAY });
    expect(keyPoolBackAt(p)).toBe(T + 2 * MIN + DAY);
  });
  it("a pool with no members refuses with pool_empty and no time", () => {
    const p = ok(createKeyPool({ name: "p", runtime: "r", vendor: "v" }, NO_NAMES, principal(), T));
    const r = chooseKey(p);
    if (r.ok) throw new Error("picked from nothing");
    expect(r.error).toEqual({ problem: "pool_empty", backAt: null });
  });
});

describe("kp6 an outcome older than the member's last change changes nothing", () => {
  it("a stale exhausted report after a recovery does not undo it", () => {
    let p = mark(pool(2), "k1", exhausted(), T + 10 * MIN);
    p = ok(reportKeyOutcome(p, "k1", { kind: "ok", evidence: "messages" }, T + 20 * MIN, T + 20 * MIN, "probe"));
    expect(p.members[0]?.health.state).toBe("active");
    const late = ok(reportKeyOutcome(p, "k1", exhausted(), T + 15 * MIN, T + 21 * MIN));
    expect(late).toBe(p);
  });
  it("a stale failing report after a revive changes nothing", () => {
    let p = mark(pool(2), "k1", { kind: "failing", reason: "rejected" }, T + 10 * MIN);
    p = ok(reviveKey(p, "k1", principal(), T + 20 * MIN));
    expect(ok(reportKeyOutcome(p, "k1", { kind: "failing", reason: "rejected" }, T + 19 * MIN, T + 21 * MIN))).toBe(p);
  });
  it("a report observed at the moment of the change is not older", () => {
    const p = mark(pool(2), "k1", exhausted(), T + 10 * MIN);
    expect(ok(reportKeyOutcome(p, "k1", { kind: "failing", reason: "held" }, T + 10 * MIN, T + 10 * MIN)).members[0]?.health.state).toBe("failing");
  });
  it("a report about a member that is not in the pool is refused", () => {
    expect(word(reportKeyOutcome(pool(1), "nope", exhausted(), T, T))).toBe("missing");
  });
});

describe("kp7 how a member is left", () => {
  it("exhausted is left by a Messages ok", () => {
    const p = mark(pool(2), "k1", exhausted());
    const back = ok(reportKeyOutcome(p, "k1", { kind: "ok", evidence: "messages" }, T + 2 * MIN, T + 2 * MIN, "probe"));
    expect(back.members[0]?.health).toEqual({ state: "active" });
    expect(back.events.at(-1)).toMatchObject({ type: "KeyRecovered", member: "k1", how: "probe" });
  });
  it("an ok from anything but a Messages request (count_tokens, a model list) is never recovery", () => {
    const p = mark(pool(2), "k1", exhausted());
    const same = ok(reportKeyOutcome(p, "k1", { kind: "ok", evidence: "other" }, T + 2 * MIN, T + 2 * MIN, "probe"));
    expect(same.members[0]?.health.state).toBe("exhausted");
  });
  it("failing is not left by any ok, a probe's included", () => {
    const p = mark(pool(2), "k1", { kind: "failing", reason: "rejected" });
    const same = ok(reportKeyOutcome(p, "k1", { kind: "ok", evidence: "messages" }, T + 2 * MIN, T + 2 * MIN, "probe"));
    expect(same.members[0]?.health).toEqual({ state: "failing", reason: "rejected" });
  });
  it("failing is left by revive, and by the Connection's rotation to a new key", () => {
    const p = mark(pool(2), "k1", { kind: "failing", reason: "held" });
    expect(ok(reviveKey(p, "k1", principal("c5"), T + 5 * MIN)).members[0]?.health).toEqual({ state: "active" });
    const rotated = keyRotated(p, "k1", T + 5 * MIN);
    expect(rotated.members[0]?.health).toEqual({ state: "active" });
    expect(rotated.events.at(-1)).toMatchObject({ type: "KeyRecovered", member: "k1", how: "rotation" });
  });
  it("exhausted is left by revive too; revive of an active member is refused; revive is the principal's (kp10)", () => {
    const p = mark(pool(2), "k1", exhausted());
    expect(word(reviveKey(p, "k1", operator, T + 5 * MIN))).toBe("principal");
    expect(ok(reviveKey(p, "k1", principal(), T + 5 * MIN)).members[0]?.health.state).toBe("active");
    expect(word(reviveKey(pool(2), "k1", principal(), T))).toBe("active");
    expect(word(reviveKey(p, "nope", principal(), T))).toBe("missing");
  });
  it("a rotation of a member that is exhausted leaves it exhausted, and of an active one changes nothing", () => {
    const p = mark(pool(2), "k1", exhausted());
    expect(keyRotated(p, "k1", T + 5 * MIN).members[0]?.health.state).toBe("exhausted");
    const fresh = pool(2);
    expect(keyRotated(fresh, "k1", T + 5 * MIN)).toBe(fresh);
  });
});

describe("outcomes: what each one does to a member", () => {
  it("exhausted records the reason, when it may be tried again, and one KeyExhausted", () => {
    const p = mark(pool(2), "k1", exhausted("spend-limit", T + 2 * DAY), T + MIN);
    expect(p.members[0]).toMatchObject({ health: { state: "exhausted", reason: "spend-limit", resumeAt: T + 2 * DAY }, since: T + MIN, lastChange: T + MIN, nextCheck: T + 2 * DAY });
    expect(p.events.filter(e => e.type === "KeyExhausted")).toEqual([{ type: "KeyExhausted", member: "k1", reason: "spend-limit", resumeAt: T + 2 * DAY, at: T + MIN }]);
    const credit = mark(pool(2), "k1", exhausted("credit"), T + MIN);
    expect(credit.members[0]?.nextCheck).toBe(T + MIN + DAY);
  });
  it("failing records the reason and one KeyFailed, and also beats an exhausted member", () => {
    let p = mark(pool(2), "k1", exhausted(), T + MIN);
    p = mark(p, "k1", { kind: "failing", reason: "cap" }, T + 2 * MIN);
    expect(p.members[0]?.health).toEqual({ state: "failing", reason: "cap" });
    expect(p.events.filter(e => e.type === "KeyFailed")).toEqual([{ type: "KeyFailed", member: "k1", reason: "cap", at: T + 2 * MIN }]);
  });
  it("an exhausted report about a failing member changes nothing: a refused account stays blocked", () => {
    const p = mark(pool(2), "k1", { kind: "failing", reason: "denied" }, T + MIN);
    expect(ok(reportKeyOutcome(p, "k1", exhausted(), T + 2 * MIN, T + 2 * MIN))).toBe(p);
  });
  it("limited is recorded and changes no health, no cursor and no order", () => {
    const p = pool(2);
    const l = ok(reportKeyOutcome(p, "k1", { kind: "limited", retryAfterMs: 30_000 }, T + MIN, T + MIN));
    expect(l.members).toEqual(p.members);
    expect(l.cursor).toBe(p.cursor);
    expect(l.events.at(-1)).toEqual({ type: "KeyLimited", member: "k1", retryAfterSeconds: 30, at: T + MIN });
    expect(picks(l, 2).names).toEqual(["k1", "k2"]);
  });
  it("unknown never changes anything, and neither does an ok on an active member", () => {
    const p = pool(2);
    expect(ok(reportKeyOutcome(p, "k1", { kind: "unknown" }, T + MIN, T + MIN))).toBe(p);
    expect(ok(reportKeyOutcome(p, "k1", { kind: "ok", evidence: "messages" }, T + MIN, T + MIN))).toBe(p);
  });
});

describe("kp8 a member that leaves takes its health with it", () => {
  it("removing a member drops it, and a cursor on it falls back so the next pick is the member after it", () => {
    const p = { ...pool(4), cursor: "k2" };
    const gone = ok(leaveKeyPool(p, "k2", T + MIN));
    expect(gone.members.map(m => m.credential)).toEqual(["k1", "k3", "k4"]);
    expect(gone.cursor).toBe("k1");
    expect(ok(chooseKey(gone)).member).toBe("k3");
    expect(ok(leaveKeyPool({ ...p, cursor: "k1" }, "k1", T)).cursor).toBeNull();
    expect(gone.events.at(-1)).toEqual({ type: "MemberLeft", member: "k2", why: "left", at: T + MIN });
    expect(word(leaveKeyPool(p, "nope", T))).toBe("missing");
  });
  it("a revoked Connection leaves in the same way, with its reason", () => {
    const gone = ok(leaveKeyPool(pool(2), "k1", T + MIN, "revoked"));
    expect(gone.events.at(-1)).toEqual({ type: "MemberLeft", member: "k1", why: "revoked", at: T + MIN });
  });
  it("a member that left and joins again starts active, with no memory of its old health", () => {
    const dir = keys(2);
    const sick = mark(pool(2), "k1", exhausted());
    const left = ok(leaveKeyPool(sick, "k1", T + 2 * MIN));
    const back = ok(joinKeyPool(left, conn(dir, "k1"), { elsewhere: [] }, null, true, principal(), T + 3 * MIN));
    expect(back.members.map(m => m.credential)).toEqual(["k2", "k1"]);
    expect(back.members[1]?.health).toEqual({ state: "active" });
  });
  it("narrowing is anyone's: removing a member needs no principal", () => {
    expect(word(leaveKeyPool(pool(2), "k1", T))).toBe("ok");
  });
});

describe("kp9 a gate refusal does not change health, moves the cursor to the member leased, and writes one MemberPicked", () => {
  it("records the declined members and their gate words in one event", () => {
    const p = pool(3);
    const first = ok(chooseKey(p));
    expect(first.member).toBe("k1");
    const second = ok(chooseKey(first.pool, ["k1"]));
    expect(second.member).toBe("k2");
    const noted = keyPicked(second.pool, "k2", [{ member: "k1", word: "budget" }], T + MIN);
    expect(noted.cursor).toBe("k2");
    expect(noted.members.map(m => m.health)).toEqual(p.members.map(m => m.health));
    expect(noted.events.filter(e => e.type === "MemberPicked")).toEqual([{ type: "MemberPicked", member: "k2", declined: [{ member: "k1", word: "budget" }], at: T + MIN }]);
  });
  it("drain does not return to a declined member on the next pick", () => {
    const p = pool(3, "drain");
    const second = ok(chooseKey(ok(chooseKey(p)).pool, ["k1"]));
    expect(second.member).toBe("k2");
    expect(ok(chooseKey(second.pool)).member).toBe("k2");
  });
});

describe("kp10 narrowing is anyone's, widening is the principal's", () => {
  it("move and policy: changing the order is the principal's (kp14), setting a policy is allowed with or without a name", () => {
    expect(word(moveKeyMember(pool(3), "k3", 0, operator, T))).toBe("principal");
    expect(word(setKeyPoolPolicy(pool(2), { mode: "drain" }, null, T))).toBe("ok");
    expect(word(setKeyPoolPolicy(pool(2), { recheckEveryMs: 1000 }, "ada", T))).toBe("bad_policy");
  });
});

describe("kp11 PoolEmpty, PoolBlocked and KeyExhausted are raised once per transition", () => {
  const types = (p: KeyPool) => p.events.map(e => e.type);
  it("PoolEmpty once when the last servable member goes, PoolRefilled once when one comes back", () => {
    let p = mark(pool(2), "k1", exhausted(), T + MIN);
    expect(types(p)).not.toContain("PoolEmpty");
    p = mark(p, "k2", exhausted(), T + 2 * MIN);
    expect(types(p).filter(t => t === "PoolEmpty")).toHaveLength(1);
    expect(p.events.find(e => e.type === "PoolEmpty")).toEqual({ type: "PoolEmpty", backAt: T + MIN + DAY, at: T + 2 * MIN });
    expect(keyPoolStanding(p)).toBe("empty");
    p = settleKeyPool(settleKeyPool(p, T + 3 * MIN), T + 4 * MIN);
    expect(types(p).filter(t => t === "PoolEmpty")).toHaveLength(1);
    p = ok(reportKeyOutcome(p, "k1", { kind: "ok", evidence: "messages" }, T + 5 * MIN, T + 5 * MIN, "probe"));
    expect(types(p).filter(t => t === "PoolRefilled")).toHaveLength(1);
    expect(keyPoolStanding(p)).toBe("ok");
    p = mark(p, "k1", exhausted(), T + 6 * MIN);
    expect(types(p).filter(t => t === "PoolEmpty")).toHaveLength(2);
  });
  it("PoolBlocked once on the transition, even while other members still serve", () => {
    let p = mark(pool(3), "k2", { kind: "failing", reason: "rejected" }, T + MIN);
    expect(types(p).filter(t => t === "PoolBlocked")).toHaveLength(1);
    expect(p.events.find(e => e.type === "PoolBlocked")).toEqual({ type: "PoolBlocked", member: "k2", reason: "rejected", at: T + MIN });
    p = mark(p, "k3", { kind: "failing", reason: "denied" }, T + 2 * MIN);
    expect(types(p).filter(t => t === "PoolBlocked")).toHaveLength(1);
    p = settleKeyPool(p, T + 3 * MIN);
    expect(types(p).filter(t => t === "PoolBlocked")).toHaveLength(1);
    expect(keyPoolStanding(p)).toBe("blocked");
    p = ok(reviveKey(ok(reviveKey(p, "k2", principal(), T + 4 * MIN)), "k3", principal(), T + 5 * MIN));
    expect(types(p).filter(t => t === "PoolRefilled")).toHaveLength(1);
  });
  it("a repeated exhausted refusal raises nothing new", () => {
    const once = mark(pool(2), "k1", exhausted(), T + MIN);
    const again = ok(reportKeyOutcome(once, "k1", exhausted(), T + 2 * MIN, T + 2 * MIN));
    expect(again.events.filter(e => e.type === "KeyExhausted")).toHaveLength(1);
    expect(again.events).toEqual(once.events);
  });
  it("settle on a healthy pool or one with no members raises nothing", () => {
    const p = pool(2);
    expect(settleKeyPool(p, T + MIN)).toBe(p);
    const none = ok(createKeyPool({ name: "p", runtime: "r", vendor: "v" }, NO_NAMES, principal(), T));
    expect(settleKeyPool(none, T + MIN)).toBe(none);
  });
  it("newKeyPoolEvents returns what one step added, even past the event limit", () => {
    const before = pool(2);
    const after = mark(before, "k1", exhausted());
    expect(newKeyPoolEvents(before, after).map(e => e.type)).toEqual(["KeyExhausted"]);
    let big = pool(2);
    for (let i = 0; i < 600; i++) big = ok(reportKeyOutcome(big, "k1", { kind: "limited", retryAfterMs: null }, T + i, T + i));
    expect(big.events.length).toBeLessThanOrEqual(500);
    const next = mark(big, "k2", exhausted(), T + 700);
    expect(newKeyPoolEvents(big, next).map(e => e.type)).toEqual(["KeyExhausted"]);
  });
});

describe("kp12 no event or JSON of the pool carries a secret, fingerprint, vault ref or provider text", () => {
  it("after every kind of step the pool holds names, words and times only", () => {
    const dir = keys(3);
    expect(conn(dir, "k1")).toMatchObject({ ref: PLANTED_REF, fingerprint: PLANTED_FP });
    let p = pool(3);
    p = ok(acknowledgeKeyPoolTerms(p, "r1", "ada", principal(), T));
    p = ok(chooseKey(p)).pool;
    p = keyPicked(p, "k1", [{ member: "k2", word: "terms" }], T + 1);
    p = mark(p, "k1", exhausted("credit"), T + 2 * MIN);
    p = mark(p, "k2", { kind: "failing", reason: "held" }, T + 3 * MIN);
    p = ok(reportKeyOutcome(p, "k3", { kind: "limited", retryAfterMs: 5000 }, T + 4 * MIN, T + 4 * MIN));
    p = ok(moveKeyMember(p, "k3", 0, principal(), T + 5 * MIN));
    p = ok(setKeyPoolPolicy(p, { mode: "drain" }, "ada", T + 6 * MIN));
    p = ok(reviveKey(p, "k2", principal(), T + 7 * MIN));
    p = ok(leaveKeyPool(p, "k3", T + 8 * MIN));
    for (const text of [JSON.stringify(p), JSON.stringify(p.events)]) {
      expect(text).not.toContain(PLANTED_REF);
      expect(text).not.toContain(PLANTED_FP);
      expect(text).not.toMatch(/sk-|Bearer|api[_-]?key/i);
    }
    const shown = new Set(p.events.flatMap(e => Object.keys(e)));
    for (const forbidden of ["ref", "fingerprint", "key", "secret", "status", "message", "text", "header", "requestId", "organization"]) expect(shown.has(forbidden)).toBe(false);
  });
});

describe("kp13 a pool of one picks its member every time", () => {
  it("in both modes, and again after it was exhausted and recovered", () => {
    for (const mode of ["round-robin", "drain"] as const) {
      expect(picks(pool(1, mode), 4).names).toEqual(["k1", "k1", "k1", "k1"]);
    }
    let p = mark(pool(1), "k1", exhausted(), T + MIN);
    expect(word(chooseKey(p))).toBe("pool_empty");
    p = ok(reportKeyOutcome(p, "k1", { kind: "ok", evidence: "messages" }, T + 2 * MIN, T + 2 * MIN, "probe"));
    expect(ok(chooseKey(p)).member).toBe("k1");
  });
});

describe("kp14 changing the order is the principal's and does not move the cursor's member", () => {
  it("moves a member to an index, keeps the cursor naming the same member and the next pick follows the new ring", () => {
    const p = ok(chooseKey(ok(chooseKey(pool(3))).pool)).pool;          // cursor on k2
    expect(p.cursor).toBe("k2");
    const moved = ok(moveKeyMember(p, "k3", 0, principal("c8"), T + MIN));
    expect(moved.members.map(m => m.credential)).toEqual(["k3", "k1", "k2"]);
    expect(moved.cursor).toBe("k2");
    expect(ok(chooseKey(moved)).member).toBe("k3");
    expect(moved.events.at(-1)).toEqual({ type: "MemberMoved", member: "k3", to: 0, at: T + MIN, command: "c8" });
  });
  it("refuses an index outside the ring, an unknown member and a missing principal", () => {
    expect(word(moveKeyMember(pool(3), "k1", 3, principal(), T))).toBe("bad_index");
    expect(word(moveKeyMember(pool(3), "k1", -1, principal(), T))).toBe("bad_index");
    expect(word(moveKeyMember(pool(3), "nope", 0, principal(), T))).toBe("missing");
    expect(word(moveKeyMember(pool(3), "k1", 1, operator, T))).toBe("principal");
  });
});

describe("kp15 concurrent picks are serialised by the pool's version", () => {
  // The service saves the cursor before a gate attempt, on the version it read; the second picker re-reads and sees it.
  it("two picks, the second on the first's saved state, give different members in round-robin and the same in drain", () => {
    const rr = pool(2);
    const a = ok(chooseKey(rr));
    const b = ok(chooseKey(roundTrip(a.pool)));
    expect([a.member, b.member]).toEqual(["k1", "k2"]);
    const dr = pool(2, "drain");
    const c = ok(chooseKey(dr));
    const d = ok(chooseKey(roundTrip(c.pool)));
    expect([c.member, d.member]).toEqual(["k1", "k1"]);
  });
  it("a pick that lost its save and re-reads the winner's state does not advance the cursor twice", () => {
    const base = pool(3);
    const won = ok(chooseKey(base));                // the winner's pick, saved
    const retry = ok(chooseKey(won.pool));          // the loser re-picks on fresh state
    expect(retry.pool.cursor).toBe("k2");
    expect(won.pool.cursor).toBe("k1");
  });
});

describe("policy", () => {
  it("setKeyPoolPolicy changes the mode and the recheck interval, and records who", () => {
    const p = ok(setKeyPoolPolicy(pool(2), { mode: "drain", recheckEveryMs: 6 * HOUR }, "ada", T + MIN));
    expect(p.policy).toEqual({ mode: "drain", recheckEveryMs: 6 * HOUR });
    expect(p.events.at(-1)).toEqual({ type: "PolicyChanged", mode: "drain", recheckEveryMs: 6 * HOUR, by: "ada", at: T + MIN });
    expect(word(setKeyPoolPolicy(pool(2), { mode: "nope" as "drain" }, null, T))).toBe("bad_policy");
  });
  it("a changed recheck interval does not move a member's nextCheck that is already set", () => {
    const marked = mark(pool(2), "k1", exhausted(), T + MIN);
    const next = marked.members[0]?.nextCheck;
    const p = ok(setKeyPoolPolicy(marked, { recheckEveryMs: 2 * HOUR }, null, T + 2 * MIN));
    expect(p.members[0]?.nextCheck).toBe(next);
  });
});
