// Probes of a key pool (ADR-0037, slice 3; KP6, KP7, KP11, KP16): a probe is claimed before it is made, an exhausted member is checked when
// it is due and not before, a probe that finds it dry again waits twice as long (up to a week), a refusal that named a date waits for
// that date, and only a Messages answer brings a member back. Pure, `now` is the clock. Names, refs and fingerprints are synthetic.
import { describe, expect, it } from "vitest";
import {
  addKey, claimProbe, createKeyPool, dueMembers, emptyDirectory, findConnection, joinKeyPool, reportKeyOutcome,
  KEY_POOL_RECHECK_MAX_MS, KEY_PROBE_CLAIM_MS,
  type Actor, type Connection, type KeyPool, type Outcome,
} from "../src/index.ts";

const T = 1_700_000_000_000;
const SEC = 1_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const principal: Actor = { kind: "principal", command: "c1" };
const PLANTED_REF = "ref-planted-vault-0001";
const PLANTED_FP = "feedfacecafe";

function ok<V>(r: { ok: true; value: V } | { ok: false; error: unknown }): V {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.error)}`);
  return r.value;
}
const word = (r: { ok: boolean; error?: unknown }): string => (r.ok ? "ok" : String(r.error));

function pool(n: number): KeyPool {
  let dir = emptyDirectory();
  for (let i = 1; i <= n; i++) {
    dir = ok(addKey(dir, {
      name: `k${i}`, vendor: "v", runtime: "r", isolation: "rules", floor: "rules",
      ref: i === 1 ? PLANTED_REF : `ref-k${i}`, fingerprint: i === 1 ? PLANTED_FP : `0123456789a${i}`,
      billing: "metered", budget: { kind: "unlimited" }, expiry: null,
    }, principal, T));
  }
  let p = ok(createKeyPool({ name: "p", runtime: "r", vendor: "v", policy: { mode: "round-robin", recheckEveryMs: DAY } }, { connections: dir.connections.map(c => c.name), pools: [], deleted: [] }, principal, T));
  for (let i = 1; i <= n; i++) p = ok(joinKeyPool(p, findConnection(dir, `k${i}`) as Connection, { elsewhere: [] }, null, true, principal, T));
  return p;
}
const dry = (resumeAt: number | null = null): Outcome => ({ kind: "exhausted", reason: resumeAt === null ? "credit" : "spend-limit", resumeAt });
const good: Outcome = { kind: "ok", evidence: "messages" };
// k1 and k2 ran dry at T; k3 is fine.
const dryAtT = (n = 3): KeyPool => {
  let p = pool(n);
  for (const name of ["k1", "k2"].slice(0, Math.min(2, n))) p = ok(reportKeyOutcome(p, name, dry(), T, T));
  return p;
};
const member = (p: KeyPool, name: string) => {
  const m = p.members.find(row => row.credential === name);
  if (!m) throw new Error(`no ${name}`);
  return m;
};
const types = (p: KeyPool) => p.events.map(e => e.type);

describe("a member starts with no probe claimed and no failed probe", () => {
  it("probingUntil is null and failedProbes is 0, for every joined member", () => {
    for (const m of pool(3).members) expect([m.probingUntil, m.failedProbes]).toEqual([null, 0]);
  });
});

describe("kp16 a probe is claimed before it is made", () => {
  it("claims a due exhausted member: probingUntil is thirty seconds out, nextCheck moves on in the same write, one ProbeClaimed, health and lastChange untouched", () => {
    const p = dryAtT();
    const at = T + DAY;
    const claimed = ok(claimProbe(p, "k1", at, "due"));
    const m = member(claimed, "k1");
    expect(m.probingUntil).toBe(at + KEY_PROBE_CLAIM_MS);
    expect(KEY_PROBE_CLAIM_MS).toBe(30 * SEC);
    expect(m.nextCheck).toBe(at + DAY);
    expect(m.health).toEqual(member(p, "k1").health);
    expect(m.lastChange).toBe(member(p, "k1").lastChange);
    expect(claimed.events.at(-1)).toEqual({ type: "ProbeClaimed", member: "k1", why: "due", at });
    expect(types(claimed).filter(t => t === "ProbeClaimed")).toHaveLength(1);
  });
  it("is refused before the member is due, and the pool is not touched", () => {
    const p = dryAtT();
    expect(word(claimProbe(p, "k1", T + DAY - 1, "due"))).toBe("not_due");
    expect(member(p, "k1").probingUntil).toBeNull();
  });
  it("a second prober finds the claim and does not probe; a lapsed claim can be taken", () => {
    const first = ok(claimProbe(dryAtT(), "k1", T + DAY, "due"));
    expect(word(claimProbe(first, "k1", T + DAY + 10 * SEC, "manual"))).toBe("claimed");
    expect(word(claimProbe(first, "k1", T + DAY + 29 * SEC, "manual"))).toBe("claimed");
    const again = ok(claimProbe(first, "k1", T + DAY + 30 * SEC, "manual"));
    expect(member(again, "k1").probingUntil).toBe(T + DAY + 60 * SEC);
  });
  it("a manual claim does not wait for the member to be due", () => {
    const claimed = ok(claimProbe(dryAtT(), "k1", T + HOUR, "manual"));
    expect(member(claimed, "k1").probingUntil).toBe(T + HOUR + KEY_PROBE_CLAIM_MS);
    expect(claimed.events.at(-1)).toMatchObject({ type: "ProbeClaimed", why: "manual" });
  });
  it("a member that is not exhausted cannot be claimed as due or manual; a missing one is missing", () => {
    const p = dryAtT();
    expect(word(claimProbe(p, "k3", T + DAY, "due"))).toBe("state");
    expect(word(claimProbe(p, "k3", T + DAY, "manual"))).toBe("state");
    expect(word(claimProbe(p, "zz", T + DAY, "due"))).toBe("missing");
  });
  it("a suspected member is an active one: the claim sets probingUntil only, nextCheck stays null; an exhausted one is not suspected", () => {
    const p = dryAtT();
    const claimed = ok(claimProbe(p, "k3", T + HOUR, "suspect"));
    expect(member(claimed, "k3")).toMatchObject({ probingUntil: T + HOUR + KEY_PROBE_CLAIM_MS, nextCheck: null });
    expect(claimed.events.at(-1)).toEqual({ type: "ProbeClaimed", member: "k3", why: "suspect", at: T + HOUR });
    expect(word(claimProbe(p, "k1", T + HOUR, "suspect"))).toBe("state");
  });
});

describe("dueMembers", () => {
  it("lists the exhausted members whose time has come and whose claim is not live, in ring order", () => {
    let p = pool(4);
    p = ok(reportKeyOutcome(p, "k1", dry(), T, T));
    p = ok(reportKeyOutcome(p, "k2", dry(), T + HOUR, T + HOUR));
    p = ok(reportKeyOutcome(p, "k3", dry(), T + 2 * HOUR, T + 2 * HOUR));
    expect(dueMembers(p, T + DAY - 1)).toEqual([]);
    expect(dueMembers(p, T + DAY)).toEqual(["k1"]);
    expect(dueMembers(p, T + DAY + 2 * HOUR)).toEqual(["k1", "k2", "k3"]);
    const claimed = ok(claimProbe(p, "k2", T + DAY + 2 * HOUR, "due"));
    expect(dueMembers(claimed, T + DAY + 2 * HOUR + SEC)).toEqual(["k1", "k3"]);
  });
  it("never lists a member whose claim is live, even if a stored pool has its next check in the past (the claim normally moves it on)", () => {
    const p = ok(reportKeyOutcome(pool(2), "k1", dry(), T, T));
    const odd = { ...p, members: p.members.map(m => m.credential === "k1" ? { ...m, probingUntil: T + DAY + 10 * SEC } : m) };
    expect(member(odd, "k1").nextCheck).toBeLessThanOrEqual(T + DAY);
    expect(dueMembers(odd, T + DAY)).toEqual([]);
    expect(dueMembers(odd, T + DAY + 10 * SEC)).toEqual(["k1"]);
  });
  it("never lists an active or a failing member", () => {
    let p = pool(3);
    p = ok(reportKeyOutcome(p, "k1", dry(), T, T));
    p = ok(reportKeyOutcome(p, "k2", { kind: "failing", reason: "rejected" }, T, T));
    expect(dueMembers(p, T + 30 * DAY)).toEqual(["k1"]);
  });
});

describe("a probe's answer (reported via probe, observed when the probe began)", () => {
  const claimedAt = T + DAY;
  const claimed = () => ok(claimProbe(dryAtT(), "k1", claimedAt, "due"));
  const answer = (p: KeyPool, outcome: Outcome, observedAt = claimedAt, now = claimedAt + 2 * SEC) =>
    ok(reportKeyOutcome(p, "k1", outcome, observedAt, now, "probe"));

  it("dry again: the interval doubles from the claim, nothing is raised, health and lastChange stay (KP11), and the claim stays until it lapses", () => {
    const p = answer(claimed(), dry());
    const m = member(p, "k1");
    expect(m.failedProbes).toBe(1);
    expect(m.nextCheck).toBe(claimedAt + 2 * SEC + 2 * DAY);
    // The claim is left to lapse on its own: a manual probe cannot run more than once in thirty seconds, answered or not.
    expect(m.probingUntil).toBe(claimedAt + KEY_PROBE_CLAIM_MS);
    expect(m.health).toMatchObject({ state: "exhausted", reason: "credit" });
    expect(m.lastChange).toBe(T);
    expect(types(p).filter(t => t === "KeyExhausted")).toHaveLength(2);
    expect(types(p)).toEqual(types(claimed()));
  });
  it("doubles again each time and stops at a week", () => {
    let p = claimed();
    let at = claimedAt;
    const gaps: number[] = [];
    for (let i = 0; i < 5; i++) {
      p = ok(reportKeyOutcome(p, "k1", dry(), at, at + 2 * SEC, "probe"));
      gaps.push((member(p, "k1").nextCheck as number) - (at + 2 * SEC));
      at = member(p, "k1").nextCheck as number;
      p = ok(claimProbe(p, "k1", at, "due"));
    }
    expect(gaps).toEqual([2 * DAY, 4 * DAY, KEY_POOL_RECHECK_MAX_MS, KEY_POOL_RECHECK_MAX_MS, KEY_POOL_RECHECK_MAX_MS]);
    expect(KEY_POOL_RECHECK_MAX_MS).toBe(7 * DAY);
  });
  it("a refusal that names a date waits for that date, not for the interval", () => {
    const resume = T + 10 * DAY;
    const p = answer(claimed(), dry(resume));
    expect(member(p, "k1").nextCheck).toBe(resume);
    expect(member(p, "k1").health).toEqual({ state: "exhausted", reason: "spend-limit", resumeAt: resume });
    expect(dueMembers(p, resume - 1)).not.toContain("k1");
    expect(dueMembers(p, resume)).toContain("k1");
  });
  it("a Messages ok brings the member back: active, no claim, no failed probe, one KeyRecovered by probe", () => {
    let p = answer(claimed(), dry());
    p = ok(claimProbe(p, "k1", member(p, "k1").nextCheck as number, "due"));
    const back = ok(reportKeyOutcome(p, "k1", good, member(p, "k1").nextCheck as number - 1, T + 4 * DAY, "probe"));
    expect(member(back, "k1")).toMatchObject({ health: { state: "active" }, probingUntil: null, failedProbes: 0, nextCheck: null });
    expect(back.events.filter(e => e.type === "KeyRecovered")).toEqual([expect.objectContaining({ member: "k1", how: "probe" })]);
  });
  it("kp7 an ok that is not from a Messages request recovers nothing and the claim stays", () => {
    const p = answer(claimed(), { kind: "ok", evidence: "other" });
    expect(member(p, "k1")).toMatchObject({ health: { state: "exhausted" }, probingUntil: claimedAt + KEY_PROBE_CLAIM_MS });
  });
  it("a pool of one that comes back is refilled", () => {
    let p = ok(reportKeyOutcome(pool(1), "k1", dry(), T, T));
    expect(types(p)).toContain("PoolEmpty");
    p = ok(claimProbe(p, "k1", T + DAY, "due"));
    p = ok(reportKeyOutcome(p, "k1", good, T + DAY, T + DAY + SEC, "probe"));
    expect(types(p)).toContain("PoolRefilled");
    expect(p.standing).toBe("ok");
  });
  it("kp6 an answer from a probe that began before a newer change is ignored", () => {
    const p = claimed();
    const revived = { ...p, members: p.members.map(m => m.credential === "k1" ? { ...m, lastChange: claimedAt + 5 * SEC } : m) };
    const after = ok(reportKeyOutcome(revived, "k1", good, claimedAt, claimedAt + 9 * SEC, "probe"));
    expect(after).toEqual(revived);
  });
  it("a report (not a probe) of dry on a member that is already dry changes nothing: it does not double the interval", () => {
    const p = claimed();
    const same = ok(reportKeyOutcome(p, "k1", dry(), claimedAt, claimedAt + SEC));
    expect(same).toEqual(p);
  });
  it("a probe that finds the key refused makes it failing, which blocks the pool: one KeyFailed", () => {
    const p = answer(claimed(), { kind: "failing", reason: "rejected" });
    expect(member(p, "k1")).toMatchObject({ health: { state: "failing", reason: "rejected" }, probingUntil: null });
    expect(p.standing).toBe("blocked");
    expect(types(p).filter(t => t === "KeyFailed")).toHaveLength(1);
  });
  it("a rate limit or an unknown answer changes nothing in the member's health and leaves the claim to lapse", () => {
    for (const outcome of [{ kind: "limited", retryAfterMs: 5000 }, { kind: "unknown" }] as Outcome[]) {
      const p = answer(claimed(), outcome);
      expect(member(p, "k1").health).toMatchObject({ state: "exhausted" });
      expect(member(p, "k1").probingUntil).toBe(claimedAt + KEY_PROBE_CLAIM_MS);
      expect(member(p, "k1").failedProbes).toBe(0);
    }
  });
});

describe("a suspected member (kp18: its first report came right after a hand-off)", () => {
  const suspected = () => ok(claimProbe(dryAtT(), "k3", T + HOUR, "suspect"));
  it("a probe that finds it dry marks it exhausted at once, once", () => {
    const p = ok(reportKeyOutcome(suspected(), "k3", dry(), T + HOUR, T + HOUR + SEC, "probe"));
    expect(member(p, "k3").health).toMatchObject({ state: "exhausted", reason: "credit" });
    expect(member(p, "k3").probingUntil).toBeNull();
    expect(types(p).filter(t => t === "KeyExhausted")).toHaveLength(3);
  });
  it("a probe that finds it healthy leaves it active and clears the claim", () => {
    const p = ok(reportKeyOutcome(suspected(), "k3", good, T + HOUR, T + HOUR + SEC, "probe"));
    expect(member(p, "k3")).toMatchObject({ health: { state: "active" }, probingUntil: null, nextCheck: null });
    expect(types(p)).toEqual(types(suspected()));
  });
});

describe("kp12 a probe leaves no secret in the pool", () => {
  it("the pool's JSON after a claim, a failed probe and a recovery holds no fingerprint or vault ref", () => {
    let p = ok(claimProbe(dryAtT(), "k1", T + DAY, "due"));
    p = ok(reportKeyOutcome(p, "k1", dry(), T + DAY, T + DAY + SEC, "probe"));
    p = ok(claimProbe(p, "k1", member(p, "k1").nextCheck as number, "due"));
    p = ok(reportKeyOutcome(p, "k1", good, member(p, "k1").lastChange, T + 5 * DAY, "probe"));
    const json = JSON.stringify(p);
    expect(json).not.toContain(PLANTED_FP);
    expect(json).not.toContain(PLANTED_REF);
  });
});
