// The 50 scenarios in the Home digest semantics (Rule 1, Rule 2). One test per row id.
// Names, repos and shas are made up. Q1 asserts sequence and fresh; Q2 asserts the weekly levels.
import { describe, expect, it } from "vitest";
import {
  buildDigest, countedClaims, itemNew, markAllSeen, mergeMarks, weeklyView,
  type Claim, type ClaimFailure, type DigestEvent, type DigestInput, type DigestItem,
  type DigestMark, type Evidence, type Producer, type Revision, type SubjectRef, type SubjectState, type WeeklyRecords, type WeekWindow,
} from "../src/index.ts";
import { taskKey } from "../src/index.ts";

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const rev = (sha: string, patchId: string | null = null): Revision => ({ sha, patchId });
const task = (n: number): SubjectRef => ({ kind: "task", key: taskKey(n) });
const change = (repo: string, n: number): SubjectRef => ({ kind: "change", repo, n });
const deploy = (repo: string, env: string, sha: string): SubjectRef => ({ kind: "deploy", repo, env, sha });
const ask = (id: string): SubjectRef => ({ kind: "ask", id });
const FORGE = { kind: "forge" as const, name: "forge-1" };
const MGR = { kind: "manager" as const, name: "manager" };
const lane = (name: string) => ({ kind: "lane" as const, name });
const A = rev("sha-a", "p-a");
const A2 = rev("sha-a2", "p-a");
const B = rev("sha-b", "p-b");
const w7 = change("acme/web", 7);
const w8 = change("acme/web", 8);
const w9 = change("acme/web", 9);
const w1 = change("acme/web", 1);
const api3 = change("acme/api", 3);

const atOf = (seq: number) => NOW - 100 + seq;
const ev = (seq: number, subject: SubjectRef, revision: Revision | null, kind: Evidence["kind"], result: Evidence["result"], producer: Producer = FORGE): Evidence =>
  ({ id: `e${seq}`, seq, at: atOf(seq), subject, revision, kind, result, producer });
const cl = (seq: number, subject: SubjectRef, revision: Revision | null, laneName: string, extra: Partial<Claim> = {}): Claim =>
  ({ id: `c${seq}`, seq, at: atOf(seq), subject, revision, outcome: "done", lane: laneName, via: "filed", revisions: extra.revisions ?? (subject.kind === "task" ? [] : [{ subject, revision }]), ...extra });
const ln = (seq: number, t: number, target: SubjectRef, by: string) =>
  ({ task: taskKey(t), target, by, seq, at: atOf(seq) });
const asg = (seq: number, t: number, laneName: string) =>
  ({ task: taskKey(t), lane: laneName, seq, at: atOf(seq) });
const hd = (seq: number, subject: SubjectRef, revision: Revision) =>
  ({ subject, revision, seq, at: atOf(seq) });
const evt = (seq: number, kind: DigestEvent["kind"], subject: SubjectRef): DigestEvent =>
  ({ kind, subject, seq, at: atOf(seq), origin: `${kind}:${seq}` });
const st = (subject: SubjectRef): SubjectState =>
  ({ subject, title: null, claimRound: null, deployedAt: null, reverted: false, rolledBack: false, reopened: false });
const stale = (n: number) => ({ kind: "task_in_review" as const, task: taskKey(n), since: NOW - 9 * HOUR });
const seen = (id: string, seq: number, level: DigestItem["level"]): DigestMark["seen"][number] =>
  ({ id, seq, level });

const dg = (o: Partial<DigestInput>) => buildDigest({
  now: NOW, newest: 10_000, mark: null, events: [], evidence: [], claims: [], links: [], assignments: [],
  states: [], needsYou: [], stale: [], changeHeads: [], ...o,
});
const items = (d: ReturnType<typeof dg>) => d.sections.flatMap(s => s.items);
const one = (d: ReturnType<typeof dg>, id: string) => items(d).find(i => i.id === id);

const base = (t: number, evidence: Evidence[] = [ev(9, w7, A, "review", "pass", lane("rvw"))]): Partial<DigestInput> => ({
  changeHeads: [hd(2, w7, A)], states: [st(w7)], links: [ln(3, t, w7, "bld")], claims: [cl(4, w7, A, "bld")], evidence, stale: [stale(t)],
});

const WEEK: WeekWindow[] = [{ week: "w1", start: NOW - DAY, end: NOW + 6 * DAY }];
const blank = (): WeeklyRecords => ({
  shipped: [], merged: [], reverted: [], done: [], deploys: [], deploysOf: [], stuck: [],
  claimFailures: [], claims: [], links: [], assignments: [], evidence: [],
});
let idn = 0;
const wev = (subject: SubjectRef, revision: Revision | null, kind: Evidence["kind"], result: Evidence["result"], at: number, producer: Producer = FORGE): Evidence =>
  ({ id: `w${++idn}`, seq: idn, at, subject, revision, kind, result, producer });
const wcl = (subject: SubjectRef, revision: Revision | null, laneName: string, at: number, extra: Partial<Claim> = {}): Claim =>
  ({ id: `w${++idn}`, seq: idn, at, subject, revision, outcome: "done", lane: laneName, via: extra.via ?? "filed", revisions: extra.revisions ?? (subject.kind === "task" ? [] : [{ subject, revision }]), ...extra });
const wln = (t: number, target: SubjectRef, at: number, by = "bld") =>
  ({ task: taskKey(t), target, by, seq: ++idn, at });
const fail = (subject: SubjectRef, revision: Revision | null, at: number, via: ClaimFailure["via"]): ClaimFailure =>
  ({ subject, revision, at, via });
const levelsOf = (o: Partial<WeeklyRecords>, now = NOW + 30 * DAY) => {
  const [row] = weeklyView({ ...blank(), ...o }, WEEK, now);
  return {
    claims: row?.claims ?? 0,
    laterFailed: row?.laterFailed ?? 0,
    levels: [...(row?.levels ?? [])].map(l => `${l.level} ${l.claims}/${l.laterFailed}`).sort(),
  };
};

describe("Rule 1: new since the mark", () => {
  it("N01", () => {
    const d = dg({ ...base(1), claims: [cl(4, w7, A, "bld"), cl(20, w7, A, "rvw")], mark: { seq: 15, seen: [] } });
    expect(one(d, "T-1"), "N01").toMatchObject({ seq: 20, fresh: true });
  });
  it("N02", () => {
    const linked = dg({ ...base(1), links: [ln(3, 1, w7, "bld"), ln(20, 1, w7, "rvw")], mark: { seq: 15, seen: [] } });
    expect(one(linked, "T-1"), "N02").toMatchObject({ seq: 20, fresh: true });
    const assigned = dg({ ...base(1), assignments: [asg(20, 1, "rvw")], mark: { seq: 15, seen: [] } });
    expect(one(assigned, "T-1"), "N02").toMatchObject({ seq: 20, fresh: true });
  });
  it("N03", () => {
    const d = dg({ ...base(1), links: [ln(3, 1, w7, "bld"), ln(5, 2, w7, "bld")], assignments: [asg(20, 2, "rvw")], mark: { seq: 15, seen: [] } });
    expect(one(d, "T-1"), "N03").toMatchObject({ seq: 20, fresh: true });
    expect(one(d, "T-2"), "N03").toBeUndefined();
  });
  it("N04", () => {
    const d = dg({
      ...base(1, [ev(9, w7, A, "ci", "pass")]),
      assignments: [asg(6, 1, "bld"), asg(30, 1, "bld")],
      links: [ln(3, 1, w7, "bld"), ln(31, 1, w7, "bld")],
      mark: { seq: 8, seen: [seen("T-1", 9, "checked")] },
    });
    expect(one(d, "T-1"), "N04").toMatchObject({ seq: 9, fresh: false });
  });
  it("N05", () => {
    const d = dg({
      ...base(1, [ev(9, w7, A, "ci", "pass")]),
      assignments: [asg(30, 1, "oth")],
      mark: { seq: 8, seen: [seen("T-1", 9, "checked")] },
    });
    expect(one(d, "T-1"), "N05").toMatchObject({ seq: 9, fresh: false });
  });
  it("N06", () => {
    const d = dg({
      states: [st(w7)], changeHeads: [hd(2, w7, A)],
      links: [ln(3, 12, w7, "bld"), ln(50, 12, w7, "rvw")],
      claims: [cl(4, w7, A, "bld"), cl(5, task(12), null, "rvw")],
      events: [evt(8, "merged", w7)],
      evidence: [ev(9, w7, A, "review", "pass", lane("rvw"))],
      assignments: [asg(40, 12, "rvw")],
      stale: [stale(12)], mark: { seq: 30, seen: [] },
    });
    expect(one(d, "T-12"), "N06").toMatchObject({ seq: 40, fresh: true });
  });
  it("N07", () => {
    const d = dg({
      events: [evt(10, "opened_or_pushed", w7)],
      links: [ln(30, 4, w7, "bld"), ln(40, 4, w7, "bld")],
      stale: [stale(4)], mark: { seq: 20, seen: [] },
    });
    expect(one(d, "T-4"), "N07").toMatchObject({ seq: 30, fresh: true });
  });
  it("N08", () => {
    const d = dg({
      states: [st(w7)], changeHeads: [hd(2, w7, A)],
      events: [evt(10, "opened_or_pushed", w7)],
      links: [ln(30, 12, w7, "bld")],
      claims: [cl(40, w7, A, "bld", { task: taskKey(99) })],
      stale: [stale(12)], mark: { seq: 35, seen: [] },
    });
    expect(one(d, "T-12"), "N08").toMatchObject({ seq: 40, fresh: true });
  });
  it("N09", () => {
    // Sequence and time agree, which is what the hub stamps (SQ10). The claim is first, so the root is T-99.
    const d = dg({
      states: [st(w7)],
      claims: [cl(20, w7, A, "bld", { task: taskKey(99) })],
      links: [ln(30, 12, w7, "bld")],
      events: [evt(10, "opened_or_pushed", w7)],
      stale: [stale(99)],
    });
    expect(one(d, "T-99"), "N09").toBeDefined();
    expect(one(d, "T-12"), "N09").toBeUndefined();
  });
  it("N10", () => {
    const d = dg({
      needsYou: [{ subject: ask("a1"), blocking: false, due: null, since: NOW - HOUR }],
      events: [evt(9, "needs_you", ask("a1")), evt(8, "stale_or_stuck", task(3))],
      stale: [{ kind: "task_quiet", task: taskKey(3), since: NOW - HOUR }],
      mark: { seq: 5, seen: [] },
    });
    expect(one(d, "ask:a1"), "N10").toMatchObject({ seq: 9, fresh: true });
    expect(one(d, "T-3"), "N10").toMatchObject({ seq: 8, fresh: true });
  });
  it("N11", () => {
    const d = dg({
      needsYou: [
        { subject: ask("a2"), blocking: false, due: null, since: NOW - HOUR },
        { subject: ask("a1"), blocking: false, due: null, since: NOW - 2 * HOUR },
      ],
      events: [evt(12, "needs_you", ask("a2")), evt(9, "needs_you", ask("a1"))],
      mark: { seq: 5, seen: [] },
    });
    const ids = d.sections.find(s => s.section === "needs_you")?.items.map(i => i.id) ?? [];
    expect(ids, "N11").toEqual(["ask:a1", "ask:a2"]);
  });
  it("N12", () => {
    const d = dg({
      events: [evt(7, "failed", w1), evt(9, "failed", w1)],
      mark: { seq: 5, seen: [seen("acme/web#1", 7, "claimed")] },
    });
    expect(one(d, "acme/web#1"), "N12").toMatchObject({ seq: 9, fresh: true });
  });
  it("N13", () => {
    const d = dg({
      claims: [cl(4, w1, A, "bld"), cl(12, w1, B, "bld")],
      events: [evt(7, "failed", w1)],
      states: [st(w1)],
      mark: { seq: 5, seen: [seen("acme/web#1", 7, "claimed")] },
    });
    expect(one(d, "acme/web#1"), "N13").toMatchObject({ seq: 12, fresh: true });
  });
  it("N14", () => {
    const input = { events: [evt(7, "merged", w1), evt(9, "opened_or_pushed", w1)] };
    const before = dg({ ...input, mark: { seq: 5, seen: [] } });
    const item = one(before, "acme/web#1");
    expect(item, "the mark never enters").toMatchObject({ seq: 9, fresh: true });
    const marked = markAllSeen(
      { seq: 5, seen: [] },
      [{ id: "acme/web#1", seq: item?.seq ?? 0, level: item?.level ?? null }],
      ["acme/web#1"],
      100,
    );
    expect(marked.seq, "N14").toBe(9);
    const after = dg({ ...input, mark: marked });
    expect(one(after, "acme/web#1")?.fresh ?? false, "N14").toBe(false);
  });
  it("N15", () => {
    const d = dg({
      events: [evt(7, "failed", w1), evt(12, "merged", w1)],
      mark: { seq: 10, seen: [seen("acme/web#1", 12, "claimed")] },
    });
    expect(one(d, "acme/web#1"), "N15").toMatchObject({ seq: 12, fresh: false });
  });
  it("N16", () => {
    const d = dg({
      states: [st(w7)],
      links: [ln(3, 3, w7, "bld")],
      claims: [cl(4, w7, A, "bld")],
      evidence: [ev(9, w7, A, "ci", "pass")],
      changeHeads: [hd(20, w7, B)],
      events: [evt(20, "opened_or_pushed", w7)],
      stale: [stale(3)], mark: { seq: 15, seen: [] },
    });
    expect(one(d, "T-3"), "N16").toMatchObject({ seq: 20, fresh: true });
  });
  it("N17", () => {
    const d = dg({
      states: [st(w7)],
      links: [ln(3, 3, w7, "bld")],
      claims: [cl(4, w7, A, "bld")],
      evidence: [ev(9, w7, A, "ci", "pass")],
      changeHeads: [hd(2, w7, A), hd(20, w7, B)],
      stale: [stale(3)], mark: { seq: 15, seen: [] },
    });
    expect(one(d, "T-3"), "N17").toMatchObject({ seq: 20, fresh: true });
  });
  it("N18", () => {
    const d = dg({
      states: [st(w7)],
      links: [ln(3, 3, w7, "bld")],
      claims: [cl(4, w7, A, "bld")],
      evidence: [ev(9, w7, A, "ci", "pass")],
      changeHeads: [hd(2, w7, A), hd(30, w7, A)],
      stale: [stale(3)],
      mark: { seq: 8, seen: [seen("T-3", 9, "checked")] },
    });
    expect(one(d, "T-3"), "N18").toMatchObject({ seq: 9, fresh: false });
  });
  it("N19", () => {
    const d = dg({
      states: [st(w7)],
      links: [ln(3, 3, w7, "bld")],
      claims: [cl(4, w7, A, "bld")],
      evidence: [ev(9, w7, A, "ci", "pass")],
      changeHeads: [hd(2, w7, A), hd(30, w7, A2)],
      events: [evt(30, "opened_or_pushed", w7)],
      stale: [stale(3)], mark: { seq: 15, seen: [] },
    });
    expect(one(d, "T-3"), "N19").toMatchObject({ seq: 30, fresh: true, level: "checked" });
  });
  it("N20", () => {
    const d = dg({
      states: [st(w7)],
      links: [ln(3, 3, w7, "bld")],
      claims: [cl(4, w7, A, "bld")],
      evidence: [ev(30, w7, A, "ci", "pass")],
      changeHeads: [hd(2, w7, A), hd(10, w7, B)],
      events: [evt(10, "opened_or_pushed", w7)],
      stale: [stale(3)], mark: { seq: 20, seen: [] },
    });
    expect(one(d, "T-3"), "N20").toMatchObject({ seq: 30, fresh: true });
  });
  it("N21", () => {
    const d = dg({
      states: [st(w7)],
      links: [ln(3, 3, w7, "bld")],
      claims: [cl(4, w7, A, "bld")],
      evidence: [ev(9, w7, A, "tests", "pass", lane("bld"))],
      changeHeads: [hd(2, w7, A)],
      stale: [stale(3)], mark: { seq: 5, seen: [] },
    });
    expect(one(d, "T-3"), "N21").toMatchObject({ seq: 9, fresh: true });
  });
  it("N22", () => {
    const d = dg({
      states: [st(w8)], changeHeads: [hd(2, w8, B)],
      evidence: [ev(9, w8, B, "ci", "pass")],
      links: [ln(20, 1, w8, "bld")],
      stale: [stale(1)], mark: { seq: 15, seen: [] },
    });
    expect(one(d, "T-1"), "N22").toMatchObject({ seq: 20, fresh: true });
  });
  it("N23", () => {
    const d = dg({
      states: [st(w9)], changeHeads: [hd(2, w9, A)],
      links: [ln(3, 4, w9, "bld"), ln(20, 12, w9, "oth")],
      claims: [cl(4, w9, A, "bld")],
      evidence: [ev(9, w9, A, "review", "pass", lane("rvw"))],
      assignments: [asg(21, 12, "rvw")],
      stale: [stale(4), stale(12)], mark: { seq: 15, seen: [] },
    });
    expect(one(d, "T-4"), "N23").toMatchObject({ seq: 21, fresh: true });
    expect(one(d, "T-12"), "N23").toMatchObject({ fresh: false });
    expect(one(d, "T-12")?.seq ?? 0, "N23").not.toBe(21);
  });
  it("N24", () => {
    const d = dg({
      ...base(1),
      evidence: [ev(9, w7, A, "review", "pass", lane("rvw")), ev(10, w7, A, "review", "pass", lane("rv2"))],
      assignments: [asg(20, 1, "rvw")],
      mark: { seq: 15, seen: [] },
    });
    expect(one(d, "T-1"), "N24").toMatchObject({ seq: 20, fresh: true, level: "reviewed" });
  });
  it("N25", () => {
    const d = dg({
      links: [ln(3, 3, w7, "bld")],
      events: [evt(6, "merged", w7), evt(8, "stale_or_stuck", task(3))],
      mark: { seq: 5, seen: [seen("T-3", 8, "claimed")] },
    });
    expect(one(d, "T-3"), "N25").toMatchObject({ seq: 8, fresh: false, section: "merged" });
  });
  it("N26", () => {
    const mark = markAllSeen(
      { seq: 3, seen: [seen("x", 5, "reviewed")] },
      [
        { id: "x", seq: 5, level: "failed" },
        { id: "y", seq: 7, level: "checked" },
      ],
      ["y"],
      100,
    );
    expect(mark.seq, "N26").toBe(3);
    expect(itemNew({ id: "x", seq: 5, level: "failed" }, mark).fresh, "N26").toBe(true);
  });
  it("N27", () => {
    const mark = mergeMarks(
      { seq: 10, seen: [seen("X", 12, null)] },
      { seq: 10, seen: [seen("X", 11, null)] },
    );
    expect(mark?.seen, "N27").toEqual([seen("X", 12, null)]);
    expect(itemNew({ id: "X", seq: 12, level: null }, mark).fresh, "N27").toBe(false);
  });
});

describe("Rule 2: which revision a claim is judged at", () => {
  const a1 = rev("sha-a1", "p-a");
  const b1 = rev("sha-b1", "p-b");
  const sw = rev("sha-w", "p-w");
  const sp = rev("sha-p", "p-p");

  it("W01", () => {
    expect(levelsOf({
      links: [wln(1, w7, NOW - DAY)],
      claims: [wcl(w7, A, "bld", NOW)],
      evidence: [wev(w7, A, "ci", "pass", NOW + DAY)],
    }), "W01").toEqual({ claims: 1, laterFailed: 0, levels: ["checked 1/0"] });
  });
  it("W02", () => {
    expect(levelsOf({
      links: [wln(1, w7, NOW - DAY)],
      claims: [wcl(w7, A, "bld", NOW)],
      evidence: [wev(w7, A, "review", "pass", NOW + DAY, lane("rvw"))],
    }), "W02").toEqual({ claims: 1, laterFailed: 0, levels: ["reviewed 1/0"] });
  });
  it("W03", () => {
    expect(levelsOf({
      claims: [wcl(w7, null, "bld", NOW, { revisions: [{ subject: w7, revision: A }] })],
      evidence: [wev(w7, A, "ci", "pass", NOW + DAY)],
    }), "W03").toEqual({ claims: 1, laterFailed: 0, levels: ["checked 1/0"] });
  });
  it("W04", () => {
    expect(levelsOf({
      claims: [wcl(w7, null, "bld", NOW)],
      evidence: [wev(w7, A, "ci", "pass", NOW + DAY)],
    }), "never the live head").toEqual({ claims: 1, laterFailed: 0, levels: ["claimed 1/0"] });
  });
  it("W05", () => {
    const prod = deploy("acme/web", "prod", "sha-b1");
    expect(levelsOf({
      links: [wln(12, w7, NOW - DAY), wln(12, w8, NOW - DAY), wln(12, prod, NOW - DAY)],
      claims: [wcl(task(12), a1, "bld", NOW, { via: "review", revisions: [{ subject: w7, revision: a1 }, { subject: w8, revision: b1 }] })],
      evidence: [wev(w7, a1, "ci", "pass", NOW + DAY), wev(w8, b1, "ci", "pass", NOW + DAY), wev(prod, b1, "deploy", "pass", NOW + DAY)],
    }), "W05").toEqual({ claims: 1, laterFailed: 0, levels: ["checked 1/0"] });
  });
  it("W06", () => {
    expect(levelsOf({
      links: [wln(12, w7, NOW - MIN), wln(12, api3, NOW - MIN)],
      claims: [wcl(task(12), sw, "bld", NOW, { via: "review", revisions: [{ subject: w7, revision: sw }, { subject: api3, revision: sp }] })],
      evidence: [wev(w7, sw, "ci", "pass", NOW + DAY), wev(api3, sp, "ci", "pass", NOW + DAY)],
    }), "W06").toEqual({ claims: 1, laterFailed: 0, levels: ["checked 1/0"] });
  });
  it("W07", () => {
    expect(levelsOf({
      links: [wln(12, w7, NOW - MIN)],
      claims: [wcl(task(12), A, "bld", NOW, { via: "review", revisions: [{ subject: w7, revision: A }] })],
      evidence: [wev(w7, A, "ci", "pass", NOW + DAY)],
    }, NOW + 8 * DAY), "W07").toEqual({ claims: 1, laterFailed: 0, levels: ["checked 1/0"] });
  });
  it("W08", () => {
    expect(levelsOf({
      claims: [wcl(w7, null, "bld", NOW, { revisions: [{ subject: w7, revision: A }] })],
      evidence: [wev(w7, A, "ci", "pass", NOW + DAY)],
    }), "W08").toEqual({ claims: 1, laterFailed: 0, levels: ["checked 1/0"] });
  });
  it("W09", () => {
    expect(levelsOf({
      links: [wln(12, w7, NOW - MIN)],
      claims: [wcl(task(12), A, "bld", NOW, { via: "review", revisions: [{ subject: w7, revision: A }] })],
      evidence: [wev(w7, A, "ci", "pass", NOW + HOUR)],
    }), "W09").toEqual({ claims: 1, laterFailed: 0, levels: ["checked 1/0"] });
  });
  it("W10", () => {
    const want = { claims: 2, laterFailed: 0, levels: ["checked 1/0", "claimed 1/0"] };
    const common = {
      links: [wln(12, w7, NOW - MIN)],
      claims: [
        wcl(task(12), A, "bld", NOW, { via: "review", revisions: [{ subject: w7, revision: A }] }),
        wcl(task(12), B, "bld", NOW + 2 * DAY, { via: "review", revisions: [{ subject: w7, revision: B }] }),
      ],
      evidence: [wev(w7, A, "ci", "pass", NOW + 12 * HOUR)],
    };
    expect(levelsOf(common), "W10").toEqual(want);
  });
  it("W11", () => {
    expect(levelsOf({
      claims: [wcl(task(12), A, "bld", NOW, { via: "review" })],
      links: [wln(12, w7, NOW + HOUR)],
      evidence: [wev(w7, A, "ci", "pass", NOW + DAY)],
    }), "W11").toEqual({ claims: 1, laterFailed: 0, levels: ["claimed 1/0"] });
  });
  it("W12", () => {
    expect(levelsOf({
      claims: [wcl(w7, A, "bld", NOW), wcl(task(12), null, "bld", NOW, { via: "review" })],
      evidence: [wev(w7, A, "ci", "pass", NOW + DAY), wev(w7, A, "ci", "fail", NOW + 10 * DAY)],
      claimFailures: [fail(w7, A, NOW + 10 * DAY, "evidence")],
      links: [wln(12, w7, NOW + 21 * DAY)],
    }), "W12").toEqual({ claims: 2, laterFailed: 1, levels: ["checked 1/1", "claimed 1/0"] });
  });
  it("W13", () => {
    expect(levelsOf({
      links: [wln(4, w9, NOW - 2 * DAY), wln(12, w9, NOW - DAY)],
      claims: [wcl(task(12), A, "bld", NOW, { via: "review" })],
      evidence: [wev(w9, A, "ci", "fail", NOW + DAY)],
      claimFailures: [fail(w9, A, NOW + DAY, "evidence")],
    }), "W13").toEqual({ claims: 1, laterFailed: 0, levels: ["claimed 1/0"] });
  });
  it("W14", () => {
    expect(levelsOf({
      links: [wln(12, w7, NOW - DAY)],
      claims: [
        wcl(w7, A, "bld", NOW),
        wcl(task(12), A, "bld", NOW + MIN, { via: "review", revisions: [{ subject: w7, revision: A }] }),
      ],
      evidence: [wev(w7, A, "ci", "pass", NOW + DAY), wev(w7, A, "review", "pass", NOW + 2 * DAY, lane("rvw"))],
    }), "W14").toEqual({ claims: 1, laterFailed: 0, levels: ["reviewed 1/0"] });
  });
  it("W15", () => {
    const common = {
      links: [wln(1, w7, NOW - DAY)],
      claims: [wcl(w7, A, "bld", NOW, { task: taskKey(1) })],
      evidence: [wev(w7, A, "ci", "pass", NOW + DAY), wev(w7, A, "review", "pass", NOW + DAY, lane("rvw"))],
    };
    expect(levelsOf({ ...common, assignments: [{ task: taskKey(1), lane: "rvw", seq: 1, at: NOW + 16 * DAY }] }), "W15").toEqual({ claims: 1, laterFailed: 0, levels: ["reviewed 1/0"] });
    expect(levelsOf({ ...common, assignments: [{ task: taskKey(1), lane: "rvw", seq: 2, at: NOW + 10 * DAY }] }), "W15").toEqual({ claims: 1, laterFailed: 0, levels: ["checked 1/0"] });
  });
  it("W16", () => {
    expect(levelsOf({
      assignments: [
        { task: taskKey(12), lane: "la", seq: 1, at: NOW - 2 * DAY },
        { task: taskKey(12), lane: "lb", seq: 2, at: NOW - DAY },
      ],
      claims: [wcl(task(12), null, "lb", NOW, { via: "review" })],
      evidence: [wev(task(12), null, "review", "pass", NOW + HOUR, lane("la"))],
    }), "W16").toEqual({ claims: 1, laterFailed: 0, levels: ["claimed 1/0"] });
  });
  it("W17", () => {
    const p1 = deploy("acme/web", "prod", "sha-m1");
    const p2 = deploy("acme/web", "prod", "sha-m2");
    const m2 = rev("sha-m2");
    expect(levelsOf({
      links: [wln(1, p1, NOW - DAY), wln(2, p2, NOW - HOUR)],
      claims: [wcl(p2, m2, "bld", NOW, { task: taskKey(2), outcome: "shipped" })],
      deploysOf: [{ subject: p2, at: NOW - HOUR }],
      evidence: [wev(p2, m2, "live", "pass", NOW + HOUR, MGR), wev(p1, rev("sha-m1"), "live", "fail", NOW + HOUR, MGR)],
    }), "W17").toEqual({ claims: 1, laterFailed: 0, levels: ["verified_live 1/0"] });
  });
  it("W18", () => {
    expect(levelsOf({
      links: [wln(1, w7, NOW - DAY), wln(1, w8, NOW - DAY)],
      claims: [
        wcl(w7, A, "bld", NOW, { task: taskKey(1) }),
        wcl(task(1), A, "bld", NOW + HOUR, { via: "review", revisions: [{ subject: w7, revision: A }, { subject: w8, revision: B }] }),
      ],
      evidence: [wev(w7, A, "ci", "pass", NOW + DAY), wev(w8, B, "ci", "fail", NOW + 2 * DAY)],
      claimFailures: [fail(w8, B, NOW + 2 * DAY, "evidence")],
    }), "W18").toEqual({ claims: 2, laterFailed: 1, levels: ["checked 1/0", "claimed 1/1"] });
  });
  it("W19", () => {
    expect(levelsOf({
      claims: [wcl(task(1), null, "bld", NOW, { via: "review" }), wcl(task(1), null, "bld", NOW + 3 * DAY, { via: "review" })],
      evidence: [wev(task(1), null, "tests", "pass", NOW + DAY, MGR)],
    }), "W19").toEqual({ claims: 2, laterFailed: 0, levels: ["checked 1/0", "claimed 1/0"] });
  });
  it("W20", () => {
    expect(levelsOf({
      links: [wln(1, w7, NOW - DAY)],
      claims: [wcl(task(1), A, "bld", NOW, { via: "review", revisions: [{ subject: w7, revision: A }] })],
      evidence: [wev(w7, A, "ci", "pass", NOW + DAY)],
      claimFailures: [fail(task(1), null, NOW + 5 * DAY, "reopened")],
    }), "W20").toEqual({ claims: 1, laterFailed: 1, levels: ["checked 1/1"] });
  });
  it("W21", () => {
    const pm = deploy("acme/web", "prod", "sha-m");
    expect(levelsOf({
      links: [wln(1, w7, NOW - DAY), wln(1, pm, NOW + DAY)],
      claims: [wcl(w7, A, "bld", NOW, { task: taskKey(1) })],
      evidence: [wev(w7, A, "ci", "pass", NOW + DAY)],
      claimFailures: [fail(w7, A, NOW + 3 * DAY, "rolled_back")],
    }), "W21").toEqual({ claims: 1, laterFailed: 1, levels: ["checked 1/1"] });
  });
  it("W22", () => {
    expect(levelsOf({
      claims: [wcl(w7, A, "bld", NOW)],
      evidence: [wev(w7, A2, "ci", "pass", NOW + DAY)],
    }), "W22").toEqual({ claims: 1, laterFailed: 0, levels: ["checked 1/0"] });
  });
  it("W23", () => {
    expect(levelsOf({
      claims: [wcl(w7, A, "bld", NOW)],
      evidence: [wev(w7, A, "ci", "pass", NOW + DAY), wev(w7, A, "review", "fail", NOW + 3 * DAY, lane("rvw"))],
      claimFailures: [fail(w7, A, NOW + 3 * DAY, "evidence")],
    }), "W23").toEqual({ claims: 1, laterFailed: 1, levels: ["checked 1/1"] });
  });
});

const WEEKS: WeekWindow[] = [
  { week: "w1", start: NOW - DAY, end: NOW + 6 * DAY },
  { week: "w2", start: NOW + 6 * DAY, end: NOW + 13 * DAY },
];
const bothWeeks = (o: Partial<WeeklyRecords>, now = NOW + 30 * DAY) =>
  weeklyView({ ...blank(), ...o }, WEEKS, now).map(row => ({
    week: row.week,
    claims: row.claims,
    laterFailed: row.laterFailed,
    levels: row.levels.map(l => `${l.level} ${l.claims}/${l.laterFailed}`).sort(),
  }));

describe("Rule 1: a change head is required", () => {
  it("S51", () => {
    const d = dg({
      states: [st(w7)],
      links: [ln(3, 7, w7, "bld")],
      claims: [cl(4, w7, A, "bld")],
      evidence: [ev(9, w7, A, "review", "pass", lane("rvw"))],
      stale: [stale(7)],
      changeHeads: [],
      mark: { seq: 5, seen: [] },
    });
    expect(one(d, "T-7"), "S51").toMatchObject({ seq: 9, fresh: true, level: "claimed" });
    expect(one(d, "T-7")?.voided, "S51").toHaveLength(1);
    // @ts-expect-error changeHeads is required: a call that omits it does not compile (NEW 1.5a)
    const _omitted: DigestInput = {
      now: NOW, newest: 1, mark: null, events: [], evidence: [], claims: [], links: [], assignments: [], states: [], needsYou: [], stale: [],
    };
    void _omitted;
  });
  it("S52", () => {
    const d = dg({
      states: [st(w7)],
      links: [ln(3, 7, w7, "bld")],
      claims: [cl(4, w7, A, "bld")],
      evidence: [ev(9, w7, A, "review", "pass", lane("rvw"))],
      stale: [stale(7)],
      changeHeads: [hd(12, w7, A)],
      mark: { seq: 10, seen: [] },
    });
    expect(one(d, "T-7"), "S52").toMatchObject({ seq: 12, fresh: true, level: "reviewed" });
  });
});

describe("Rule 2: rounds, roots and which failure matches", () => {
  const t5 = task(5);
  const t6 = task(6);
  const t8 = task(8);
  const t9 = task(9);
  const t10 = task(10);
  it("S53", () => {
    expect(levelsOf({
      claims: [wcl(t5, null, "bld", NOW, { via: "review", round: 1 })],
      evidence: [wev(t5, null, "tests", "pass", NOW + HOUR, MGR), wev(t5, null, "review", "fail", NOW + DAY, lane("rvw"))],
      claimFailures: [fail(t5, null, NOW + DAY, "evidence")],
    }), "S53").toEqual({ claims: 1, laterFailed: 1, levels: ["checked 1/1"] });
  });
  it("S54", () => {
    expect(levelsOf({
      claims: [
        wcl(t5, null, "bld", NOW, { via: "review", round: 1 }),
        wcl(t5, null, "bld", NOW + 3 * DAY, { via: "review", round: 2 }),
      ],
      evidence: [wev(t5, null, "tests", "pass", NOW + HOUR, MGR), wev(t5, null, "review", "fail", NOW + 5 * DAY, lane("rvw"))],
      claimFailures: [fail(t5, null, NOW + 5 * DAY, "evidence")],
    }), "S54").toEqual({ claims: 2, laterFailed: 1, levels: ["checked 1/0", "claimed 1/1"] });
  });
  it("S55", () => {
    expect(levelsOf({
      claims: [
        wcl(t6, null, "bld", NOW, { via: "review", round: 1 }),
        wcl(t6, null, "bld", NOW + MIN, { via: "lane_event", round: 1 }),
      ],
      evidence: [wev(t6, null, "review", "pass", NOW + HOUR, lane("rvw"))],
    }), "S55").toEqual({ claims: 1, laterFailed: 0, levels: ["reviewed 1/0"] });
  });
  it("S56", () => {
    const edge = NOW + 6 * DAY;
    expect(bothWeeks({
      claims: [
        wcl(t6, null, "bld", edge - MIN, { via: "lane_event", round: 1 }),
        wcl(t6, null, "bld", edge + MIN, { via: "review", round: 1 }),
      ],
      evidence: [wev(t6, null, "tests", "pass", edge - 30_000, MGR)],
    }), "S56").toEqual([
      { week: "w1", claims: 1, laterFailed: 0, levels: ["checked 1/0"] },
      { week: "w2", claims: 0, laterFailed: 0, levels: [] },
    ]);
  });
  it("S57", () => {
    expect(levelsOf({
      assignments: [{ task: taskKey(8), lane: "la", seq: 1, at: NOW - DAY }],
      claims: [
        wcl(t8, null, "la", NOW, { via: "review", round: 1 }),
        wcl(t8, null, "la", NOW + 3 * DAY, { via: "review", round: 2 }),
        wcl(t8, null, "rvw", NOW + 5 * DAY, { via: "filed", round: 3 }),
      ],
      evidence: [wev(t8, null, "review", "pass", NOW + DAY, lane("rvw"))],
    }), "S57").toEqual({ claims: 3, laterFailed: 0, levels: ["claimed 3/0"] });
  });
  it("S58", () => {
    expect(levelsOf({
      assignments: [{ task: taskKey(8), lane: "la", seq: 1, at: NOW - DAY }, { task: taskKey(8), lane: "rvw", seq: 2, at: NOW + 5 * DAY }],
      claims: [
        wcl(t8, null, "la", NOW, { via: "review", round: 1 }),
        wcl(t8, null, "la", NOW + 3 * DAY, { via: "review", round: 2 }),
      ],
      evidence: [wev(t8, null, "review", "pass", NOW + DAY, lane("rvw"))],
    }), "S58").toEqual({ claims: 2, laterFailed: 0, levels: ["claimed 2/0"] });
  });
  it("S59", () => {
    const prod = deploy("acme/web", "prod", A.sha);
    const base59 = {
      links: [wln(9, w7, NOW - DAY)],
      claims: [wcl(t9, null, "bld", NOW, { via: "review", revisions: [{ subject: w7, revision: A }] })],
      evidence: [wev(w7, A, "ci", "pass", NOW + DAY)],
    };
    expect(levelsOf({ ...base59, claimFailures: [fail(prod, rev(A.sha), NOW + 3 * DAY, "rolled_back")] }), "S59").toEqual({ claims: 1, laterFailed: 0, levels: ["checked 1/0"] });
    expect(levelsOf({
      ...base59,
      claimFailures: [fail(prod, rev(A.sha), NOW + 3 * DAY, "rolled_back"), fail(w7, A, NOW + 3 * DAY, "rolled_back")],
    }), "S59").toEqual({ claims: 1, laterFailed: 1, levels: ["checked 1/1"] });
  });
  it("S60", () => {
    const prod = deploy("acme/web", "prod", A.sha);
    expect(levelsOf({
      links: [wln(9, w7, NOW - DAY), wln(9, prod, NOW - DAY)],
      claims: [wcl(t9, null, "bld", NOW, { via: "review", revisions: [{ subject: w7, revision: A }, { subject: prod, revision: rev(A.sha) }] })],
      evidence: [wev(w7, A, "ci", "pass", NOW + DAY)],
      claimFailures: [fail(prod, rev(A.sha), NOW + 3 * DAY, "rolled_back")],
    }), "S60").toEqual({ claims: 1, laterFailed: 1, levels: ["checked 1/1"] });
  });
  it("S61", () => {
    const prod = deploy("acme/web", "prod", A.sha);
    expect(levelsOf({
      links: [wln(9, w7, NOW - DAY), wln(9, w8, NOW - DAY)],
      claims: [wcl(w8, B, "bld", NOW, { task: taskKey(9) })],
      evidence: [wev(w8, B, "ci", "pass", NOW + DAY)],
      claimFailures: [fail(prod, rev(A.sha), NOW + 3 * DAY, "rolled_back"), fail(w7, A, NOW + 3 * DAY, "rolled_back")],
    }), "S61").toEqual({ claims: 1, laterFailed: 0, levels: ["checked 1/0"] });
  });
  it("S62", () => {
    const pm = deploy("acme/api", "prod", "sha-m");
    expect(levelsOf({
      links: [wln(10, pm, NOW - DAY)],
      claims: [wcl(t10, null, "bld", NOW, { via: "review", revisions: [{ subject: pm, revision: rev("sha-m") }] })],
      evidence: [wev(pm, rev("sha-m"), "deploy", "pass", NOW + DAY)],
      claimFailures: [fail(pm, rev("sha-m"), NOW + 2 * DAY, "rolled_back")],
    }), "S62").toEqual({ claims: 1, laterFailed: 1, levels: ["checked 1/1"] });
  });
  it("S63", () => {
    expect(levelsOf({
      links: [{ task: taskKey(1), target: w7, by: "bld", seq: 5, at: NOW + DAY }],
      claims: [
        wcl(w7, A, "bld", NOW, { seq: 6 }),
        wcl(task(1), null, "bld", NOW + HOUR, { via: "review", seq: 7, revisions: [{ subject: w7, revision: A }] }),
      ],
      evidence: [wev(w7, A, "ci", "pass", NOW + 2 * DAY)],
    }), "S63").toEqual({ claims: 1, laterFailed: 0, levels: ["checked 1/0"] });
  });
  it("S64", () => {
    const d = dg({
      links: [{ task: taskKey(1), target: w7, by: "bld", seq: 5, at: atOf(5) + DAY }],
      claims: [cl(6, w7, A, "bld", { task: taskKey(2), at: atOf(6) - DAY })],
      events: [evt(1, "opened_or_pushed", w7)],
      changeHeads: [hd(2, w7, A)],
      states: [st(w7)],
    });
    expect(one(d, "T-1")?.subjects, "S64").toContainEqual(w7);
    expect(levelsOf({
      links: [{ task: taskKey(1), target: w7, by: "bld", seq: 5, at: NOW + DAY }],
      claims: [wcl(w7, A, "bld", NOW, { seq: 6, task: taskKey(2) })],
      claimFailures: [fail(task(1), null, NOW + 2 * DAY, "reopened")],
    }), "S64").toEqual({ claims: 1, laterFailed: 1, levels: ["claimed 1/1"] });
  });
  it("S65", () => {
    // An unstamped claim joins the hand-over open at its sequence. It does not start another.
    expect(levelsOf({
      claims: [
        wcl(t5, null, "bld", NOW, { via: "review", seq: 10, round: 10 }),
        wcl(t5, null, "bld", NOW + 1000, { via: "lane_event", seq: 11 }),
      ],
      evidence: [wev(t5, null, "review", "pass", NOW + 5000, lane("rvw"))],
    }), "S65").toEqual({ claims: 1, laterFailed: 0, levels: ["reviewed 1/0"] });
  });
  it("S66", () => {
    // The held claim is the lowest sequence in the round. Evidence before that claim's clock is outside the round.
    const first = NOW;
    const skewed = NOW - 5000;
    const claims = [
      wcl(t5, null, "bld", first, { via: "review", seq: 20, round: 20 }),
      wcl(t5, null, "bld", skewed, { via: "lane_event", seq: 21, round: 20 }),
    ];
    expect(countedClaims(claims, []), "S66").toEqual([{ subject: t5, revision: null, at: first }]);
    expect(levelsOf({
      claims,
      evidence: [wev(t5, null, "review", "pass", skewed + 1000, lane("rvw"))],
    }), "S66").toEqual({ claims: 1, laterFailed: 0, levels: ["claimed 1/0"] });
  });
  it("S67", () => {
    // The link's sequence is before the claim, so the linking lane is a claimant even though its clock is after J.
    expect(levelsOf({
      links: [{ task: taskKey(12), target: w7, by: "rvw", seq: 3, at: NOW + 20 * DAY }],
      claims: [wcl(w7, A, "bld", NOW, { seq: 6, task: taskKey(12) })],
      evidence: [wev(w7, A, "review", "pass", NOW + DAY, lane("rvw"))],
    }), "S67").toEqual({ claims: 1, laterFailed: 0, levels: ["claimed 1/0"] });
  });
  it("S68", () => {
    // A round sequence and a clock are different numbers. The same digits must not collapse two hand-overs.
    const claims = [
      wcl(t5, null, "bld", NOW, { via: "review", seq: 10, round: 5 }),
      wcl(t5, null, "bld", 5, { via: "lane_event", seq: 4 }),
    ];
    expect(countedClaims(claims, []), "S68").toHaveLength(2);
  });
});
