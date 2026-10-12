// The Home digest's read model (docs/design/home-digest/README.md §3–§7; ADR-0025; DG1–DG12 in docs/domain.md): one
// list of everything that changed since the principal last looked, every line one click from the record that made it,
// with proof on every line. Synthetic data: every name, sha, repo and link is made up.
import { describe, expect, it } from "vitest";
import {
  DAY_MS, LATER_FAILED_MS, SECTIONS, STALE_LIMITS_DEFAULT, buildDigest, countedClaims, itemNew, markAllSeen,
  mergeMarks, openedItem, staleConditions, subjectRef, subjectLevel, vetoDecision, weeklyView,
  type Claim, type ClaimSource, type DigestEvent, type DigestEventKind, type DigestInput, type DigestItem,
  type DigestMark, type Evidence, type EvidenceKind, type EvidenceResult,
  type NeedsYouState, type Producer, type Revision, type Section, type SeenAt, type StaleCondition,
  type StaleFacts, type StaleLimits, type SubjectRef, type SubjectState, type WeeklyRecords, type WeekWindow,
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

const FORGE: Producer = { kind: "forge", name: "forge-1" };
const lane = (name: string): Producer => ({ kind: "lane", name });
const MANGER: Producer = { kind: "manager", name: "manager" };

let seqN = 0;
const evidence = (o: Partial<Evidence> & { subject: SubjectRef; kind: EvidenceKind; result: EvidenceResult }): Evidence => ({
  id: `e-${++seqN}`, seq: seqN, at: NOW, revision: null, producer: FORGE, ...o,
});
const claim = (o: Partial<Claim> & { subject: SubjectRef; lane: string }): Claim =>
  ({ id: `cl-${++seqN}`, seq: seqN, at: NOW, revision: null, outcome: "done", ...o });
const event = (kind: DigestEventKind, subject: SubjectRef, seq: number, at: number): DigestEvent =>
  ({ kind, subject, seq, at, origin: `${kind}:${subjectRef(subject)}:${seq}` });
const state = (subject: SubjectRef, o: Partial<SubjectState> = {}): SubjectState => ({
  subject, revision: null, claimRound: null, deployedAt: null, reverted: false, rolledBack: false, reopened: false, title: null, ...o,
});
const digest = (o: Partial<DigestInput> = {}) =>
  buildDigest({ now: NOW, newest: 10_000, mark: null, events: [], evidence: [], claims: [], links: [], assignments: [], states: [], needsYou: [], stale: [], ...o });
const allItems = (d: { sections: { items: DigestItem[] }[] }) => d.sections.flatMap(s => s.items);
const one = (d: ReturnType<typeof digest>, id: string) => allItems(d).find(i => i.id === id);
const inSection = (d: ReturnType<typeof digest>, s: Section) => d.sections.find(x => x.section === s)?.items ?? [];

// ---- DG1: everything on a line is derived from records; a worker's words are a quotation, never a verdict

describe("derived from records (DG1)", () => {
  const c7 = change("acme/web", 7);
  const a1 = rev("sha-a1", "patch-1");
  it("a lane's words show as a quoted claim, capped at 140, and set neither level, section nor verb", () => {
    const d = digest({
      states: [state(c7, { revision: a1, title: "Add the digest" })],
      claims: [claim({ subject: c7, revision: a1, lane: "builder", note: "SHIPPED! everything verified green, trust me " + "x".repeat(150) })],
      events: [event("opened_or_pushed", c7, 2, NOW)],
    });
    const item = one(d, "acme/web#7");
    expect(item?.section).toBe("opened_or_pushed");          // the section came from the event, not the words
    expect(item?.level).toBe("claimed");                     // so did no level
    expect(item?.claim).toEqual({ lane: "builder", words: ("SHIPPED! everything verified green, trust me " + "x".repeat(150)).slice(0, 140) });
    expect(item?.title).toBe("Add the digest");              // a title from records is a title, not words
  });
  it("section counts are counts of items", () => {
    const d = digest({
      events: [event("merged", change("acme/web", 7), 2, NOW), event("merged", change("acme/web", 8), 3, NOW), event("done", task(1), 4, NOW)],
    });
    expect(d.counts.merged).toBe(2);
    expect(d.counts.done).toBe(1);
    for (const s of d.sections) expect(s.items.length, s.section).toBe(d.counts[s.section]);
  });
});

// ---- DG2: the level is the highest an independent producer's passing evidence reaches on this revision

describe("the level ladder (DG2)", () => {
  const c7 = change("acme/web", 7);
  const a1 = rev("sha-a1", "patch-1");
  it("a claimant's own CI link does not raise the level; it is shown, attached by the claimant", () => {
    const d = digest({
      states: [state(c7, { revision: a1 })],
      claims: [claim({ subject: c7, revision: a1, lane: "builder" })],
      evidence: [evidence({ subject: c7, revision: a1, kind: "ci", result: "pass", producer: lane("builder") })],
      events: [event("opened_or_pushed", c7, 2, NOW)],
    });
    expect(one(d, "acme/web#7")?.level).toBe("claimed");
    expect(one(d, "acme/web#7")?.evidence).toHaveLength(1);
  });
  it("a lane ever assigned the linked task is a claimant too: its review does not raise", () => {
    const d = digest({
      states: [state(c7, { revision: a1 })],
      claims: [claim({ subject: c7, revision: a1, lane: "builder" })],
      links: [{ task: taskKey(3), target: c7, by: "builder", at: NOW - 1, seq: 0 }],
      assignments: [{ task: taskKey(3), lane: "reviewer", seq: 0, at: 0 }],
      evidence: [evidence({ subject: c7, revision: a1, kind: "review", result: "pass", producer: lane("reviewer") })],
      events: [event("opened_or_pushed", c7, 2, NOW)],
    });
    expect(one(d, "T-3")?.level).toBe("claimed");           // the linked task roots the item (DG5)
  });
  it("the forge's CI raises it to checked, another lane's review to reviewed; the highest holds", () => {
    const base = {
      states: [state(c7, { revision: a1 })],
      events: [event("merged", c7, 2, NOW)],
      claims: [claim({ subject: c7, revision: a1, lane: "builder" })],
    };
    const ciOnly = digest({ ...base, evidence: [evidence({ subject: c7, revision: a1, kind: "ci", result: "pass" })] });
    expect(one(ciOnly, "acme/web#7")?.level).toBe("checked");
    const both = digest({ ...base, evidence: [
      evidence({ subject: c7, revision: a1, kind: "ci", result: "pass" }),
      evidence({ subject: c7, revision: a1, kind: "review", result: "pass", producer: lane("reviewer") }),
    ] });
    expect(one(both, "acme/web#7")?.level).toBe("reviewed");
  });
  it("a lane that later claims stops its earlier evidence counting: the level is computed from current records", () => {
    const base = {
      states: [state(c7, { revision: a1 })],
      events: [event("merged", c7, 2, NOW)],
      evidence: [evidence({ subject: c7, revision: a1, kind: "review", result: "pass", producer: lane("reviewer") })],
    };
    expect(one(digest({ ...base, claims: [claim({ subject: c7, revision: a1, lane: "builder" })] }), "acme/web#7")?.level).toBe("reviewed");
    expect(one(digest({ ...base, claims: [
      claim({ subject: c7, revision: a1, lane: "builder" }),
      claim({ subject: c7, revision: a1, lane: "reviewer", at: NOW + 5 }),
    ] }), "acme/web#7")?.level).toBe("claimed");
  });
  it("on a change nobody claimed or linked, a lane's evidence counts for nothing; the forge's still does", () => {
    const d = digest({
      states: [state(c7, { revision: a1 })],
      evidence: [evidence({ subject: c7, revision: a1, kind: "ci", result: "pass", producer: lane("builder") })],
      events: [event("opened_or_pushed", c7, 2, NOW)],
    });
    expect(one(d, "acme/web#7")?.level).toBe("claimed");
    const withForge = digest({
      states: [state(c7, { revision: a1 })],
      evidence: [
        evidence({ subject: c7, revision: a1, kind: "ci", result: "pass", producer: lane("builder") }),
        evidence({ subject: c7, revision: a1, kind: "ci", result: "pass" }),
      ],
      events: [event("opened_or_pushed", c7, 2, NOW)],
    });
    expect(one(withForge, "acme/web#7")?.level).toBe("checked");
  });
  it("verified live: only from another producer, and only once the deploy containing the revision has landed", () => {
    const base = { claims: [claim({ subject: c7, revision: a1, lane: "builder" })], events: [event("merged", c7, 2, NOW)] };
    const before = digest({ ...base, states: [state(c7, { revision: a1, deployedAt: NOW + 10 })],
      evidence: [evidence({ subject: c7, revision: a1, kind: "live", result: "pass", producer: lane("reviewer"), at: NOW + 5 })] });
    expect(one(before, "acme/web#7")?.level).toBe("claimed");        // before the deploy: not a live check of it
    const after = digest({ ...base, states: [state(c7, { revision: a1, deployedAt: NOW + 10 })],
      evidence: [evidence({ subject: c7, revision: a1, kind: "live", result: "pass", producer: lane("reviewer"), at: NOW + 20 })] });
    expect(one(after, "acme/web#7")?.level).toBe("verified_live");
    const own = digest({ ...base, states: [state(c7, { revision: a1, deployedAt: NOW + 10 })],
      evidence: [evidence({ subject: c7, revision: a1, kind: "live", result: "pass", producer: lane("builder"), at: NOW + 20 })] });
    expect(one(own, "acme/web#7")?.level).toBe("claimed");           // the claimant's own live check raises nothing
    const shot = digest({ ...base, states: [state(c7, { revision: a1, deployedAt: NOW + 10 })],
      evidence: [evidence({ subject: c7, revision: a1, kind: "screenshot", result: "pass", producer: lane("reviewer"), at: NOW + 20 })] });
    expect(one(shot, "acme/web#7")?.level).toBe("verified_live");
  });
  it("a task with no change of its own climbs the same ladder on its own evidence", () => {
    const t5 = task(5);
    const d = digest({
      states: [state(t5, { claimRound: NOW - 1 })],
      claims: [claim({ subject: t5, lane: "builder" })],
      evidence: [evidence({ subject: t5, kind: "tests", result: "pass", producer: MANGER, at: NOW })],
      events: [event("done", t5, 2, NOW)],
    });
    expect(one(d, "T-5")?.level).toBe("checked");
  });
  it("a former assignee's review of its own task raises nothing: reassignment never buys independence (V1)", () => {
    const t12 = task(12);
    const d = digest({
      states: [state(t12, { claimRound: NOW - 1 })],
      claims: [claim({ subject: t12, lane: "builder" })],
      assignments: [{ task: taskKey(12), lane: "reviewer", seq: 0, at: 0 }, { task: taskKey(12), lane: "builder", seq: 0, at: 0 }],
      evidence: [evidence({ subject: t12, kind: "review", result: "pass", producer: lane("reviewer"), at: NOW })],
      events: [event("done", t12, 2, NOW)],
    });
    expect(one(d, "T-12")?.level).toBe("claimed");           // reviewer was T-12's assignee before builder
  });
});

// ---- DG3: any failing evidence on the current revision, a revert, a rollback or a reopen shows failed

describe("failure (DG3)", () => {
  const c7 = change("acme/web", 7);
  const a1 = rev("sha-a1", "patch-1");
  it("a failing check beats a passing review", () => {
    const d = digest({
      states: [state(c7, { revision: a1 })],
      claims: [claim({ subject: c7, revision: a1, lane: "builder" })],
      evidence: [
        evidence({ subject: c7, revision: a1, kind: "review", result: "pass", producer: lane("reviewer") }),
        evidence({ subject: c7, revision: a1, kind: "ci", result: "fail" }),
      ],
      events: [event("merged", c7, 2, NOW)],
    });
    expect(one(d, "acme/web#7")?.level).toBe("failed");
  });
  it("a red run on an unclaimed change in progress shows failed, not Failed: work in progress", () => {
    const d = digest({
      states: [state(c7, { revision: a1 })],
      evidence: [evidence({ subject: c7, revision: a1, kind: "ci", result: "fail" })],
      events: [event("opened_or_pushed", c7, 2, NOW)],
    });
    expect(one(d, "acme/web#7")?.level).toBe("failed");
    expect(one(d, "acme/web#7")?.section).toBe("opened_or_pushed");
    expect(d.counts.failed_or_rolled_back).toBe(0);
  });
  it("a reverted change and a rolled-back deploy stay failed while their cause is current", () => {
    const reverted = digest({
      states: [state(c7, { revision: a1, reverted: true })],
      evidence: [evidence({ subject: c7, revision: a1, kind: "review", result: "pass", producer: lane("reviewer") })],
      events: [event("rolled_back", c7, 2, NOW)],
    });
    expect(one(reverted, "acme/web#7")?.level).toBe("failed");
    const prod = deploy("acme/web", "prod", "sha-a1");
    const rolledBack = digest({
      states: [state(prod, { revision: a1, rolledBack: true })],
      events: [event("rolled_back", prod, 2, NOW)],
    });
    expect(one(rolledBack, "acme/web:prod@sha-a1")?.level).toBe("failed");
    expect(one(rolledBack, "acme/web:prod@sha-a1")?.section).toBe("failed_or_rolled_back");
  });
  it("a reopened task is failed until it is accepted as done again, then its level is recomputed", () => {
    const t5 = task(5);
    const reopened = digest({
      states: [state(t5, { claimRound: NOW - 1, reopened: true })],
      claims: [claim({ subject: t5, lane: "builder" })],
      evidence: [evidence({ subject: t5, kind: "tests", result: "pass", producer: MANGER, at: NOW })],
      events: [event("failed", t5, 2, NOW)],
    });
    expect(one(reopened, "T-5")?.level).toBe("failed");
    const again = digest({
      states: [state(t5, { claimRound: NOW - 1 })],
      claims: [claim({ subject: t5, lane: "builder" })],
      evidence: [evidence({ subject: t5, kind: "tests", result: "pass", producer: MANGER, at: NOW })],
      events: [event("done", t5, 3, NOW)],
    });
    expect(one(again, "T-5")?.level).toBe("checked");
  });
});

// ---- DG4: a new revision voids earlier evidence; the same patch id keeps it

describe("voiding on a new revision (DG4)", () => {
  const c7 = change("acme/web", 7);
  it("a new push voids the level: earlier evidence stays visible, struck through", () => {
    const old = rev("sha-a1", "patch-1");
    const d = digest({
      states: [state(c7, { revision: rev("sha-b2", "patch-2") })],
      claims: [claim({ subject: c7, revision: old, lane: "builder" })],
      evidence: [evidence({ subject: c7, revision: old, kind: "ci", result: "pass" })],
      events: [event("opened_or_pushed", c7, 2, NOW)],
    });
    expect(one(d, "acme/web#7")?.level).toBe("claimed");
    expect(one(d, "acme/web#7")?.voided).toHaveLength(1);
    expect(one(d, "acme/web#7")?.evidence).toHaveLength(0);
  });
  it("the same patch id keeps it: a rebase is the same change", () => {
    const d = digest({
      states: [state(c7, { revision: rev("sha-b2", "patch-9") })],
      claims: [claim({ subject: c7, revision: rev("sha-a1", "patch-9"), lane: "builder" })],
      evidence: [evidence({ subject: c7, revision: rev("sha-a1", "patch-9"), kind: "ci", result: "pass" })],
      events: [event("opened_or_pushed", c7, 2, NOW)],
    });
    expect(one(d, "acme/web#7")?.level).toBe("checked");
  });
  it("a task's claim round voids its earlier evidence the same way a push does", () => {
    const t5 = task(5);
    const d = digest({
      states: [state(t5, { claimRound: NOW + 10 })],
      claims: [claim({ subject: t5, lane: "builder" })],
      evidence: [evidence({ subject: t5, kind: "tests", result: "pass", producer: MANGER, at: NOW })],
      events: [event("done", t5, 2, NOW)],
    });
    expect(one(d, "T-5")?.level).toBe("claimed");
    expect(one(d, "T-5")?.voided).toHaveLength(1);
  });
});

// ---- DG5: one item per root subject, in the first section it belongs to

describe("items and sections (DG5)", () => {
  it("a task groups its linked changes and deploys into one item; an unlinked change is its own root", () => {
    const t1 = task(1);
    const c7 = change("acme/web", 7);
    const c8 = change("acme/web", 8);
    const prod = deploy("acme/web", "prod", "sha-a1");
    const d = digest({
      events: [
        event("merged", c7, 3, NOW - 3 * MIN),
        event("shipped", prod, 4, NOW - 2 * MIN),
        event("done", t1, 5, NOW - MIN),
        event("merged", c8, 6, NOW),
      ],
      links: [
        { task: taskKey(1), target: c7, by: "builder", at: NOW - 10 * MIN, seq: 0 },
        { task: taskKey(1), target: prod, by: "builder", at: NOW - 10 * MIN, seq: 0 },
      ],
    });
    expect(allItems(d).map(i => i.id).sort()).toEqual(["T-1", "acme/web#8"]);
    const group = one(d, "T-1");
    expect(group?.subjects[0]).toEqual(t1);
    expect(group?.section).toBe("shipped");                 // the first section any of its events belongs to
    expect(group?.events.map(e => e.kind)).toEqual(["merged", "shipped", "done"]);
  });
  it("an item sits in the first section an event since the mark belongs to; events behind the mark are its trail", () => {
    const c7 = change("acme/web", 7);
    const d = digest({
      mark: { seq: 6, seen: [] },
      events: [event("merged", c7, 3, NOW - 2 * MIN), event("failed", c7, 8, NOW)],
    });
    expect(one(d, "acme/web#7")?.section).toBe("failed_or_rolled_back");
    expect(one(d, "acme/web#7")?.events.map(e => e.kind)).toEqual(["failed"]);
  });
  it("with no mark at all, the first look shows the last 24 hours, not everything", () => {
    const c7 = change("acme/web", 7);
    const d = digest({ events: [event("opened_or_pushed", c7, 2, NOW - 25 * HOUR), event("merged", c7, 3, NOW - 2 * HOUR)] });
    expect(one(d, "acme/web#7")?.section).toBe("merged");
    const older = digest({ events: [event("opened_or_pushed", c7, 2, NOW - 25 * HOUR)] });
    expect(one(older, "acme/web#7")).toBeUndefined();
  });
  it("a deploy is an environment at a revision: a later deploy of the same env groups under its own task (§3.1)", () => {
    const prodA = { kind: "deploy", repo: "acme/web", env: "prod", sha: "sha-a1" } as SubjectRef;
    const prodB = { kind: "deploy", repo: "acme/web", env: "prod", sha: "sha-b2" } as SubjectRef;
    const d = digest({
      events: [event("shipped", prodA, 3, NOW - 2 * MIN), event("shipped", prodB, 4, NOW - MIN)],
      links: [
        { task: taskKey(1), target: prodA, by: "builder", at: NOW - 10 * MIN, seq: 0 },
        { task: taskKey(2), target: prodB, by: "builder", at: NOW - 9 * MIN, seq: 0 },
      ],
    });
    expect(allItems(d).map(i => i.id).sort()).toEqual(["T-1", "T-2"]);
    expect(one(d, "T-1")?.events.map(e => e.subject)).toEqual([prodA]);
    expect(one(d, "T-2")?.events.map(e => e.subject)).toEqual([prodB]);
  });
  it("a decision or a failure since the mark outranks a stale condition; needs you outranks both (§5 order)", () => {
    const t12 = task(12);
    const inReview = { kind: "task_in_review" as const, task: taskKey(12), since: NOW - 9 * HOUR };
    expect(one(digest({ stale: [inReview], events: [event("rolled_back", t12, 8, NOW)] }), "T-12")?.section).toBe("failed_or_rolled_back");
    expect(one(digest({ stale: [inReview], events: [event("decided_for_you", t12, 8, NOW)] }), "T-12")?.section).toBe("decided_for_you");
    expect(one(digest({
      stale: [inReview],
      needsYou: [{ subject: t12, blocking: false, due: null, since: NOW - MIN }],
      events: [event("failed", t12, 8, NOW)],
    }), "T-12")?.section).toBe("needs_you");
    expect(one(digest({ stale: [inReview], events: [event("shipped", t12, 8, NOW)] }), "T-12")?.section).toBe("stale_or_stuck");
  });
});

// ---- §3.5: the line's own time — its newest record's, never the moment the digest was built

describe("the line's time (§3.5)", () => {
  it("an item's time is its newest record's time, not now; a live condition's line says since when it holds", () => {
    const c7 = change("acme/web", 7);
    const d = digest({ events: [event("merged", c7, 2, NOW - 5 * HOUR)] });
    expect(one(d, "acme/web#7")?.at).toBe(NOW - 5 * HOUR);
    const a1 = ask("ask-1");
    const needs = digest({ needsYou: [{ subject: a1, blocking: true, due: null, since: NOW - 2 * HOUR }] });
    expect(one(needs, "ask:ask-1")?.at).toBe(NOW - 2 * HOUR);
  });
});

// ---- DG6: needs you and stale are live conditions: they hold whatever the mark, and leave when they clear

describe("live conditions (DG6)", () => {
  it("a needs-you item is listed with no event at all, above any mark, and leaves when the ask is settled", () => {
    const a1 = ask("ask-1");
    const needs: NeedsYouState[] = [{ subject: a1, blocking: true, due: null, since: NOW - MIN }];
    const d = digest({ mark: { seq: 100, seen: [] }, needsYou: needs });
    expect(one(d, "ask:ask-1")?.section).toBe("needs_you");
    expect(one(d, "ask:ask-1")?.needsYou).toEqual({ blocking: true, due: null });
    expect(inSection(digest({ needsYou: [] }), "needs_you")).toEqual([]);
  });
  it("a stale condition holds and leaves the same way, with how long it has held", () => {
    const stale: StaleCondition[] = [{ kind: "lane_busy", lane: "builder", since: NOW - 46 * MIN }];
    const d = digest({ mark: { seq: 100, seen: [] }, stale });
    expect(one(d, "lane:builder")?.section).toBe("stale_or_stuck");
    expect(one(d, "lane:builder")?.staleSince).toBe(NOW - 46 * MIN);
    expect(inSection(digest({ stale: [] }), "stale_or_stuck")).toEqual([]);
  });
  it("a needs-you condition outranks a stale one on the same subject", () => {
    const t4 = task(4);
    const d = digest({
      needsYou: [{ subject: t4, blocking: false, due: NOW + 10 * MIN, since: NOW - MIN }],
      stale: [{ kind: "task_blocked", task: taskKey(4), since: NOW - 5 * HOUR }],
    });
    expect(one(d, "T-4")?.section).toBe("needs_you");
  });
});

// ---- DG7: the mark moves only forward, and never past a line the device did not show

describe("the mark (DG7)", () => {
  const a: SeenAt = { id: "a", seq: 5, level: "claimed", section: "opened_or_pushed" };
  const b: SeenAt = { id: "b", seq: 7, level: "checked", section: "merged" };
  const c: SeenAt = { id: "c", seq: 9, level: "claimed", section: "done" };
  const items = [a, b, c];
  it("mark all seen covers what was displayed: it stops at the first line that was not, keeping that one unseen", () => {
    expect(markAllSeen({ seq: 4, seen: [] }, items, ["a", "c"], 9)).toEqual({ seq: 5, seen: [c] });
    expect(markAllSeen({ seq: 4, seen: [] }, items, ["a", "b", "c"], 9)).toEqual({ seq: 9, seen: [] });
  });
  it("it never passes the hub's newest sequence, and it never moves back", () => {
    expect(markAllSeen({ seq: 4, seen: [] }, items, ["a", "b", "c"], 8)).toEqual({ seq: 8, seen: [c] });   // c stays seen above
    expect(markAllSeen({ seq: 6, seen: [] }, items, ["a"], 9)).toEqual({ seq: 6, seen: [] });
  });
  it("a line already seen above the mark counts as covered: the walk may pass it", () => {
    expect(markAllSeen({ seq: 5, seen: [c] }, items, ["a", "b"], 9)).toEqual({ seq: 9, seen: [] });
    expect(markAllSeen({ seq: 4, seen: [] }, items, ["a"], 9)).toEqual({ seq: 5, seen: [] });   // stops at b
  });
  it("an item seen at an older sequence is a gap: the walk stops at it, unseen at its new sequence (DG8)", () => {
    const x5: SeenAt = { id: "x", seq: 5, level: "claimed", section: "merged" };
    const x9: SeenAt = { ...x5, seq: 9 };                                 // a new event moved x, behind "N more"
    const y: SeenAt = { id: "y", seq: 11, level: "claimed", section: "done" };
    const mark = markAllSeen({ seq: 3, seen: [x5] }, [x9, y], [], 20);
    expect(mark).toEqual({ seq: 3, seen: [x5] });                         // x was not displayed at 9: nothing passes it
    expect(itemNew(x9, mark)).toEqual({ fresh: true, changed: null });    // and its update stays new (DG8)
  });
  it("a prior-seen item behind N more stops the mark when its level or section changed (DG7, DG8)", () => {
    // The mark is {seq:3, seen:[x@5 reviewed]}. x is still @5 but now failed, and it sits behind "N more".
    // y@7 is displayed. Covering x because the sequence matches would mark the failure seen.
    const xSeen: SeenAt = { id: "x", seq: 5, level: "reviewed", section: "merged" };
    const xFailed: SeenAt = { ...xSeen, level: "failed" };
    const xMoved: SeenAt = { ...xSeen, section: "failed_or_rolled_back" };
    const y: SeenAt = { id: "y", seq: 7, level: "claimed", section: "done" };
    const level = markAllSeen({ seq: 3, seen: [xSeen] }, [xFailed, y], ["y"], 20);
    expect(level.seq).toBe(3);
    expect(itemNew(xFailed, level)).toEqual({ fresh: true, changed: "level" });
    const section = markAllSeen({ seq: 3, seen: [xSeen] }, [xMoved, y], ["y"], 20);
    expect(section.seq).toBe(3);
    expect(itemNew(xMoved, section)).toEqual({ fresh: true, changed: "section" });
  });
  it("opening an item marks that item seen and moves nothing else", () => {
    expect(openedItem({ seq: 4, seen: [] }, b)).toEqual({ seq: 4, seen: [b] });
    const again = openedItem({ seq: 4, seen: [b] }, { ...b, level: "failed" });
    expect(again).toEqual({ seq: 4, seen: [{ ...b, level: "failed" }] });
  });
  it("two devices racing keep the larger value, and both sets of items seen above it", () => {
    const x: SeenAt = { id: "x", seq: 6, level: "claimed", section: "merged" };
    const y: SeenAt = { id: "y", seq: 8, level: null, section: "needs_you" };
    expect(mergeMarks({ seq: 5, seen: [x] }, { seq: 7, seen: [y] })).toEqual({ seq: 7, seen: [y] });
    expect(mergeMarks(null, { seq: 7, seen: [y] })).toEqual({ seq: 7, seen: [y] });
    expect(mergeMarks({ seq: 7, seen: [y] }, null)).toEqual({ seq: 7, seen: [y] });
    expect(mergeMarks(null, null)).toBeNull();
  });
  it("an item seen on both devices keeps its newer entry, whichever mark carries it (§4)", () => {
    const x5: SeenAt = { id: "x", seq: 5, level: "claimed", section: "done" };
    const x8: SeenAt = { ...x5, seq: 8, level: "checked", section: "merged" };
    expect(mergeMarks({ seq: 3, seen: [x8] }, { seq: 2, seen: [x5] })).toEqual({ seq: 3, seen: [x8] });
    expect(mergeMarks({ seq: 3, seen: [x5] }, { seq: 2, seen: [x8] })).toEqual({ seq: 3, seen: [x8] });
  });
});

// ---- DG8: new while above the mark and unseen; changed after seen, new again

describe("new since the last look (DG8)", () => {
  const seen: SeenAt = { id: "acme/web#7", seq: 7, level: "checked", section: "merged" };
  it("new while its sequence is above the mark and unseen; seen at that sequence, it is not", () => {
    expect(itemNew({ ...seen, seq: 8 }, { seq: 5, seen: [] })).toEqual({ fresh: true, changed: null });
    expect(itemNew(seen, { seq: 7, seen: [seen] })).toEqual({ fresh: false, changed: null });
    expect(itemNew({ ...seen, seq: 6 }, { seq: 7, seen: [] })).toEqual({ fresh: false, changed: null });   // below the mark
  });
  it("a level or section that changed after it was seen makes it new again, with what changed", () => {
    expect(itemNew({ ...seen, level: "failed" }, { seq: 7, seen: [seen] })).toEqual({ fresh: true, changed: "level" });
    expect(itemNew({ ...seen, section: "failed_or_rolled_back" }, { seq: 7, seen: [seen] })).toEqual({ fresh: true, changed: "section" });
  });
  it("the digest says it of its items: a failing check after the mark marks the line changed", () => {
    const c7 = change("acme/web", 7);
    const a1 = rev("sha-a1", "patch-1");
    const d = digest({
      mark: { seq: 7, seen: [seen] },
      states: [state(c7, { revision: a1 })],
      claims: [claim({ subject: c7, revision: a1, lane: "builder" })],
      events: [event("merged", c7, 7, NOW - MIN), event("failed", c7, 8, NOW)],   // the fail evidence is a failed event (§3.2)
      evidence: [evidence({ subject: c7, revision: a1, kind: "ci", result: "fail", seq: 8 })],
    });
    expect(one(d, "acme/web#7")).toMatchObject({ fresh: true, changed: "level" });
  });
  it("a claim or a claimant change raises the item's sequence: a level drop after the mark is new again", () => {
    const t12 = task(12);
    const d = digest({
      mark: { seq: 15, seen: [] },                        // the mark passed the item; its seen entry was dropped
      states: [state(t12, { claimRound: NOW - 10 })],
      claims: [
        claim({ subject: t12, lane: "builder", seq: 5, at: NOW - 9 }),
        claim({ subject: t12, lane: "reviewer", seq: 20, at: NOW - MIN }),   // the reviewer claims: its review stops counting
      ],
      evidence: [evidence({ subject: t12, kind: "review", result: "pass", producer: lane("reviewer"), seq: 9, at: NOW - 8 })],
      events: [event("done", t12, 8, NOW - 8)],
      stale: [{ kind: "task_in_review", task: taskKey(12), since: NOW - 9 * HOUR }],   // keeps the line listed
    });
    expect(one(d, "T-12")).toMatchObject({ level: "claimed", fresh: true, changed: null });
  });
  it("a link or an assignment that changes the claimants raises the item's sequence (DG8)", () => {
    // Reviewed at seq 9 by a lane that is not a claimant. The mark is 15. The reviewer then links the change,
    // or is assigned the linked task: the level drops to claimed, and that record's sequence makes it new.
    const c7 = change("acme/web", 7);
    const a1 = rev("sha-a1", "patch-1");
    const reviewed: Partial<DigestInput> = {
      mark: { seq: 15, seen: [] },
      states: [state(c7, { revision: a1 })],
      claims: [claim({ subject: c7, revision: a1, lane: "builder", seq: 4, at: NOW - 10 })],
      evidence: [evidence({ subject: c7, revision: a1, kind: "review", result: "pass", producer: lane("reviewer"), seq: 9, at: NOW - 8 })],
      events: [event("merged", c7, 8, NOW - 8)],
      stale: [{ kind: "task_in_review", task: taskKey(3), since: NOW - 9 * HOUR }],
    };
    const linked = digest({
      ...reviewed,
      links: [{ task: taskKey(3), target: c7, by: "reviewer", at: NOW - MIN, seq: 20 }],
    });
    expect(one(linked, "T-3")).toMatchObject({ level: "claimed", seq: 20, fresh: true });
    const assigned = digest({
      ...reviewed,
      links: [{ task: taskKey(3), target: c7, by: "builder", at: NOW - 20, seq: 3 }],
      assignments: [{ task: taskKey(3), lane: "reviewer", seq: 20, at: NOW - MIN }],
    });
    expect(one(assigned, "T-3")).toMatchObject({ level: "claimed", seq: 20, fresh: true });
  });
});

// ---- DG9: a rebuild gives the same answer; counts are counts

describe("rebuild determinism (DG9)", () => {
  it("the same records give the same items, levels and counts", () => {
    const t1 = task(1);
    const c7 = change("acme/web", 7);
    const a1 = rev("sha-a1", "patch-1");
    const input = {
      mark: { seq: 2, seen: [] } as DigestMark,
      events: [event("merged", c7, 3, NOW), event("done", t1, 4, NOW)],
      states: [state(c7, { revision: a1, title: "Add the digest" }), state(t1)],
      claims: [claim({ subject: c7, revision: a1, lane: "builder" })],
      links: [{ task: taskKey(1), target: c7, by: "builder", at: NOW - 1, seq: 0 }],
      assignments: [{ task: taskKey(1), lane: "builder", seq: 0, at: 0 }],
      evidence: [
        evidence({ subject: c7, revision: a1, kind: "ci", result: "pass" }),
        evidence({ subject: c7, revision: a1, kind: "review", result: "pass", producer: lane("reviewer") }),
      ],
      needsYou: [{ subject: task(2), blocking: true, due: null, since: NOW - MIN }],
    };
    expect(digest(input)).toEqual(digest(input));
  });
});

// ---- DG10: stale is computed from side effects, never reported by a lane

describe("stale conditions (DG10)", () => {
  const facts = (o: Partial<StaleFacts> = {}): StaleFacts => ({ lanes: [], tasks: [], jobs: [], deliveries: [], ...o });
  it("a lane busy past the limit with no side effect since it started is stale; a side effect restarts the clock", () => {
    const quiet = staleConditions(facts({ lanes: [{ name: "builder", workingSince: NOW - 46 * MIN, lastSideEffectAt: NOW - 50 * MIN }] }), STALE_LIMITS_DEFAULT, NOW);
    expect(quiet).toEqual([{ kind: "lane_busy", lane: "builder", since: NOW - 46 * MIN + STALE_LIMITS_DEFAULT.busyMs }]);
    const busy = staleConditions(facts({ lanes: [{ name: "builder", workingSince: NOW - 46 * MIN, lastSideEffectAt: NOW - 10 * MIN }] }), STALE_LIMITS_DEFAULT, NOW);
    expect(busy).toEqual([]);
    const short = staleConditions(facts({ lanes: [{ name: "builder", workingSince: NOW - 44 * MIN, lastSideEffectAt: null }] }), STALE_LIMITS_DEFAULT, NOW);
    expect(short).toEqual([]);
  });
  it("the clock restarts at the latest side effect: one early effect does not hold the window open forever", () => {
    // Working since 09:00, one commit at 09:01, then nothing until 14:00 (§6.3: none of them in the window).
    const since = NOW - 5 * HOUR + MIN + STALE_LIMITS_DEFAULT.busyMs;
    const lanes = [{ name: "builder", workingSince: NOW - 5 * HOUR, lastSideEffectAt: NOW - 5 * HOUR + MIN }];
    expect(staleConditions(facts({ lanes }), STALE_LIMITS_DEFAULT, NOW)).toEqual([{ kind: "lane_busy", lane: "builder", since }]);
    expect(staleConditions(facts({ lanes }), STALE_LIMITS_DEFAULT, since - MIN)).toEqual([]);
    const tasks = [{ key: taskKey(7), blockedSince: null, reviewSince: null, doingSince: NOW - 25 * HOUR, lastActivityAt: NOW - 25 * HOUR + 5 * MIN }];
    expect(staleConditions(facts({ tasks }), STALE_LIMITS_DEFAULT, NOW))
      .toEqual([{ kind: "task_quiet", task: taskKey(7), since: NOW - 25 * HOUR + 5 * MIN + STALE_LIMITS_DEFAULT.quietMs }]);
  });
  it("a blocked task, a review left waiting, a quiet task and a queued job each have their limit", () => {
    const t2 = taskKey(2);
    const found = staleConditions(facts({
      tasks: [{ key: t2, blockedSince: NOW - 4 * HOUR - MIN, reviewSince: NOW - 8 * HOUR - MIN, doingSince: NOW - 24 * HOUR - MIN, lastActivityAt: null }],
      jobs: [{ id: "job-9", queuedSince: NOW - 61 * MIN }],
    }), STALE_LIMITS_DEFAULT, NOW);
    expect(found.map(c => c.kind).sort()).toEqual(["job_queued", "task_blocked", "task_in_review", "task_quiet"]);
    const fine = staleConditions(facts({
      tasks: [{ key: t2, blockedSince: NOW - 3 * HOUR, reviewSince: NOW - 7 * HOUR, doingSince: NOW - 23 * HOUR, lastActivityAt: NOW - MIN }],
      jobs: [{ id: "job-9", queuedSince: NOW - 59 * MIN }],
    }), STALE_LIMITS_DEFAULT, NOW);
    expect(fine).toEqual([]);
  });
  it("a delivery turned uncertain is stale at once, from when it became uncertain", () => {
    const found = staleConditions(facts({ deliveries: [{ lane: "builder", uncertainSince: NOW - MIN }] }), STALE_LIMITS_DEFAULT, NOW);
    expect(found).toEqual([{ kind: "delivery_uncertain", lane: "builder", since: NOW - MIN }]);
  });
  it("the limits come from config, not from the code", () => {
    const tight: StaleLimits = { ...STALE_LIMITS_DEFAULT, busyMs: 10 * MIN };
    const at11 = facts({ lanes: [{ name: "builder", workingSince: NOW - 11 * MIN, lastSideEffectAt: null }] });
    expect(staleConditions(at11, tight, NOW)).toHaveLength(1);
    expect(staleConditions(at11, STALE_LIMITS_DEFAULT, NOW)).toEqual([]);
  });
});

// ---- DG11: the digest grants and starts nothing

describe("no powers of its own (DG11)", () => {
  it("building, marking and opening change no record: the digest is a reading, not an action", () => {
    const c7 = change("acme/web", 7);
    const input: DigestInput = {
      now: NOW, newest: 10, mark: { seq: 2, seen: [] }, events: [event("merged", c7, 3, NOW)],
      states: [state(c7, { title: "Add the digest" })], claims: [claim({ subject: c7, lane: "builder" })],
      links: [], assignments: [], evidence: [], needsYou: [{ subject: c7, blocking: true, due: null, since: NOW }],
      stale: [{ kind: "lane_busy", lane: "builder", since: NOW - MIN }],
    };
    const before = JSON.stringify(input);
    buildDigest(input);
    markAllSeen(input.mark, [], [], input.newest);
    expect(JSON.stringify(input)).toBe(before);
  });
  it("a veto is a command to the manager naming the decision, never a Decision, a Verdict or a board move", () => {
    expect(vetoDecision("d-9")).toEqual({ kind: "command", to: "manager", decisionId: "d-9" });
  });
});

// ---- DG12: a claim is counted once per subject and revision, and as later failed within 14 days

describe("the weekly count of claims (DG12)", () => {
  const c7 = change("acme/web", 7);
  const a1 = rev("sha-a1", "patch-1");
  it("counted once per root subject and revision, at the earliest of its sources", () => {
    const sources: ClaimSource[] = [
      { subject: c7, revision: a1, at: NOW + 1, via: "filed" },
      { subject: c7, revision: a1, at: NOW, via: "review" },
      { subject: c7, revision: rev("sha-b2", "patch-2"), at: NOW + 2, via: "lane_event" },
    ];
    expect(countedClaims(sources)).toEqual([
      { subject: c7, revision: a1, at: NOW },
      { subject: c7, revision: rev("sha-b2", "patch-2"), at: NOW + 2 },
    ]);
  });
  const records = (o: Partial<WeeklyRecords> = {}): WeeklyRecords => ({
    shipped: [], merged: [], reverted: [], done: [], deploys: [], deploysOf: [], stuck: [],
    claimSources: [], claimRounds: [], claimFailures: [], claims: [], links: [], assignments: [], evidence: [], subjectStates: [],
    ...o,
  });
  const week = (start = NOW, end = NOW + 7 * DAY): WeekWindow => ({ week: "w-40", start, end });
  it("later failed within 14 days, counted under the level the item showed just before it failed", () => {
    const r = records({
      claimSources: [{ subject: c7, revision: a1, at: NOW, via: "review" }],
      claimRounds: [{ subject: c7, at: NOW }],
      claims: [claim({ subject: c7, revision: a1, lane: "builder" })],
      subjectStates: [state(c7, { revision: a1 })],
      evidence: [
        evidence({ subject: c7, revision: a1, kind: "ci", result: "pass", at: NOW + DAY }),
        evidence({ subject: c7, revision: a1, kind: "ci", result: "fail", at: NOW + 10 * DAY }),
      ],
      claimFailures: [{ subject: c7, revision: a1, at: NOW + 10 * DAY, via: "evidence" }],
    });
    const [row] = weeklyView(r, [week()], NOW + 11 * DAY);
    expect(row).toMatchObject({ claims: 1, laterFailed: 1, provisional: true });
    expect(row?.levels).toEqual([{ level: "checked", claims: 1, laterFailed: 1 }]);
  });
  it("past 14 days it is not later failed; a claim that held is counted under its level when the window ended", () => {
    const base = records({
      claimSources: [{ subject: c7, revision: a1, at: NOW, via: "review" }],
      claimRounds: [{ subject: c7, at: NOW }],
      claims: [claim({ subject: c7, revision: a1, lane: "builder" })],
      subjectStates: [state(c7, { revision: a1 })],
      evidence: [
        evidence({ subject: c7, revision: a1, kind: "ci", result: "pass", at: NOW + DAY }),
        evidence({ subject: c7, revision: a1, kind: "review", result: "pass", producer: lane("reviewer"), at: NOW + 2 * DAY }),
      ],
    });
    const late: WeeklyRecords = { ...base, claimFailures: [{ subject: c7, revision: a1, at: NOW + 15 * DAY, via: "evidence" }] };
    const [row] = weeklyView(late, [week()], NOW + 16 * DAY);
    expect(row).toMatchObject({ claims: 1, laterFailed: 0 });
    expect(row?.levels).toEqual([{ level: "reviewed", claims: 1, laterFailed: 0 }]);
    const [frozen] = weeklyView(base, [week()], NOW + 22 * DAY);
    expect(frozen?.provisional).toBe(false);            // 14 days after the week ended, it is frozen
  });
  it("a revert, a rollback and a reopen count as later failed as surely as failing evidence", () => {
    const t5 = task(5);
    const r = records({
      claimSources: [{ subject: t5, revision: null, at: NOW, via: "review" }],
      claimRounds: [{ subject: t5, at: NOW }],
      claims: [claim({ subject: t5, lane: "builder" })],
      claimFailures: [{ subject: t5, revision: null, at: NOW + DAY, via: "reopened" }],
    });
    const [row] = weeklyView(r, [week()], NOW + 8 * DAY);
    expect(row).toMatchObject({ claims: 1, laterFailed: 1 });
    expect(row?.levels).toEqual([{ level: "claimed", claims: 1, laterFailed: 1 }]);
  });
  it("a claim on a task is one count with its linked change's claim, judged with the change's evidence (§3.1)", () => {
    const t12 = task(12);
    const links = [{ task: taskKey(12), target: c7, by: "builder", at: NOW - MIN, seq: 0 }];
    const sources: ClaimSource[] = [
      { subject: c7, revision: a1, at: NOW, via: "filed" },
      { subject: t12, revision: a1, at: NOW + MIN, via: "review" },       // T-12 moved to review at #87's head
    ];
    expect(countedClaims(sources, links)).toEqual([{ subject: c7, revision: a1, at: NOW }]);
    const r = records({
      claimSources: sources,
      claimRounds: [{ subject: t12, at: NOW + MIN }],
      claims: [claim({ subject: c7, revision: a1, lane: "builder", at: NOW })],
      links,
      evidence: [
        evidence({ subject: c7, revision: a1, kind: "ci", result: "pass", at: NOW + DAY }),
        evidence({ subject: c7, revision: a1, kind: "review", result: "pass", producer: lane("reviewer"), at: NOW + 2 * DAY }),
      ],
    });
    const [row] = weeklyView(r, [week()], NOW + 8 * DAY);
    expect(row).toMatchObject({ claims: 1, laterFailed: 0 });
    expect(row?.levels).toEqual([{ level: "reviewed", claims: 1, laterFailed: 0 }]);
  });
  it("a failure recorded on the linked change fails the task's claim (DG12)", () => {
    const t12 = task(12);
    const r = records({
      claimSources: [{ subject: t12, revision: a1, at: NOW, via: "review" }],
      claimRounds: [{ subject: t12, at: NOW }],
      claims: [claim({ subject: t12, revision: a1, lane: "builder", at: NOW })],
      links: [{ task: taskKey(12), target: c7, by: "builder", at: NOW - MIN, seq: 0 }],
      evidence: [
        evidence({ subject: c7, revision: a1, kind: "ci", result: "pass", at: NOW + DAY }),
        evidence({ subject: c7, revision: a1, kind: "ci", result: "fail", at: NOW + 10 * DAY }),
      ],
      claimFailures: [{ subject: c7, revision: a1, at: NOW + 10 * DAY, via: "evidence" }],
    });
    const [row] = weeklyView(r, [week()], NOW + 11 * DAY);
    expect(row).toMatchObject({ claims: 1, laterFailed: 1 });
    expect(row?.levels).toEqual([{ level: "checked", claims: 1, laterFailed: 1 }]);
  });
  it("a link filed after a claim does not change how that week was counted (DG9, DG12)", () => {
    // Week 1 counted #7 and T-12 as two claims. Three weeks later someone links them. A rebuild still counts two,
    // and the failure on #7 does not fail T-12's claim.
    const t12 = task(12);
    const sources: ClaimSource[] = [
      { subject: c7, revision: a1, at: NOW, via: "filed" },
      { subject: t12, revision: a1, at: NOW, via: "review" },
    ];
    const links = [{ task: taskKey(12), target: c7, by: "builder", at: NOW + 21 * DAY, seq: 40 }];
    expect(countedClaims(sources, links)).toEqual([
      { subject: c7, revision: a1, at: NOW },
      { subject: t12, revision: a1, at: NOW },
    ]);
    const r = records({
      claimSources: sources,
      claimRounds: [{ subject: t12, at: NOW }],
      claims: [
        claim({ subject: c7, revision: a1, lane: "builder", at: NOW }),
        claim({ subject: t12, revision: a1, lane: "builder", at: NOW }),
      ],
      links,
      subjectStates: [state(c7, { revision: a1 })],
      evidence: [
        evidence({ subject: c7, revision: a1, kind: "ci", result: "pass", at: NOW + DAY }),
        evidence({ subject: c7, revision: a1, kind: "ci", result: "fail", at: NOW + 10 * DAY }),
      ],
      claimFailures: [{ subject: c7, revision: a1, at: NOW + 10 * DAY, via: "evidence" }],
    });
    const [row] = weeklyView(r, [week()], NOW + 22 * DAY);
    expect(row?.claims).toBe(2);
    expect(row?.laterFailed).toBe(1);
    expect(row?.levels).toEqual([
      { level: "claimed", claims: 1, laterFailed: 0 },
      { level: "checked", claims: 1, laterFailed: 1 },
    ]);
  });
  it("each linked change and deploy is judged at its own head, not at the task claim's revision", () => {
    // T-12 moved to review at #7's head a1, and is also linked to #8 at b1 and to a deploy of b1.
    // Forge CI passed on both heads. Judging #8 and the deploy at a1 voids that evidence.
    const t12 = task(12);
    const c8 = change("acme/web", 8);
    const b1 = rev("sha-b1", "patch-2");
    const prod = deploy("acme/web", "prod", "sha-b1");
    const r = records({
      claimSources: [{ subject: t12, revision: a1, at: NOW, via: "review" }],
      claimRounds: [{ subject: t12, at: NOW }],
      claims: [claim({ subject: t12, revision: a1, lane: "builder", at: NOW })],
      links: [
        { task: taskKey(12), target: c7, by: "builder", at: NOW - MIN, seq: 0 },
        { task: taskKey(12), target: c8, by: "builder", at: NOW - MIN, seq: 0 },
        { task: taskKey(12), target: prod, by: "builder", at: NOW - MIN, seq: 0 },
      ],
      subjectStates: [state(c7, { revision: a1 }), state(c8, { revision: b1 }), state(prod, { revision: b1 })],
      evidence: [
        evidence({ subject: c7, revision: a1, kind: "ci", result: "pass", at: NOW + DAY }),
        evidence({ subject: c8, revision: b1, kind: "ci", result: "pass", at: NOW + DAY }),
        evidence({ subject: prod, revision: b1, kind: "deploy", result: "pass", at: NOW + DAY }),
      ],
    });
    const [row] = weeklyView(r, [week()], NOW + 8 * DAY);
    expect(row).toMatchObject({ claims: 1, laterFailed: 0 });
    expect(row?.levels).toEqual([{ level: "checked", claims: 1, laterFailed: 0 }]);
  });
  it("the weekly columns are counts of records: shipped, merged, reverted, done with its times, deploys, stuck", () => {
    const t1 = taskKey(1), t2 = taskKey(2), t3 = taskKey(3);
    const r = records({
      shipped: [{ at: NOW + HOUR, verifiedLive: true }, { at: NOW + 2 * HOUR, verifiedLive: false }],
      merged: [{ at: NOW + HOUR }],
      reverted: [{ at: NOW + 3 * HOUR }],
      done: [
        { key: t1, startAt: NOW, doneAt: NOW + HOUR },
        { key: t2, startAt: NOW, doneAt: NOW + 3 * HOUR },
        { key: t3, startAt: NOW, doneAt: NOW + 10 * HOUR },
      ],
      deploys: [
        { env: "prod", at: NOW, failed: true },
        { env: "staging", at: NOW + HOUR, failed: false },
        { env: "prod", at: NOW + 2 * HOUR, failed: false },
      ],
      stuck: [
        { raisedAt: NOW, clearedAt: NOW + 5 * MIN, actedOn: false },     // a false alarm
        { raisedAt: NOW, clearedAt: NOW + 5 * MIN, actedOn: true },      // somebody acted
        { raisedAt: NOW, clearedAt: NOW + 20 * MIN, actedOn: false },    // cleared too late
        { raisedAt: NOW, clearedAt: null, actedOn: false },              // still held
      ],
    });
    const [row] = weeklyView(r, [week()], NOW + 8 * DAY);
    expect(row).toMatchObject({
      shipped: 2, shippedVerifiedLive: 1, merged: 1, reverted: 1, done: 3,
      timeToDoneMs: { median: 3 * HOUR, p90: 10 * HOUR },
      failedDeploys: 1, recoveryMs: 2 * HOUR,
      stuckRaised: 4, stuckFalseAlarms: 1,
    });
  });
  it("a rebuild of the weekly view gives the same rows", () => {
    const r = records({
      shipped: [{ at: NOW + HOUR, verifiedLive: true }],
      claimSources: [{ subject: c7, revision: a1, at: NOW, via: "review" }],
      claims: [claim({ subject: c7, revision: a1, lane: "builder" })],
    });
    expect(weeklyView(r, [week()], NOW + 8 * DAY)).toEqual(weeklyView(r, [week()], NOW + 8 * DAY));
  });
});

// ---- the ladder on its own, for the level names the design fixes

describe("level names (§3.4)", () => {
  const c7 = change("acme/web", 7);
  const a1 = rev("sha-a1", "patch-1");
  it("claimed with no evidence, checked by a check, reviewed by a review, verified live by a live check", () => {
    expect(subjectLevel(state(c7, { revision: a1 }), [], new Set()).level).toBe("claimed");
    expect(subjectLevel(state(c7, { revision: a1 }), [evidence({ subject: c7, revision: a1, kind: "tests", result: "pass" })], new Set()).level).toBe("checked");
    expect(subjectLevel(state(c7, { revision: a1 }), [evidence({ subject: c7, revision: a1, kind: "review", result: "pass" })], new Set()).level).toBe("reviewed");
    expect(subjectLevel(state(c7, { revision: a1, deployedAt: 0 }), [evidence({ subject: c7, revision: a1, kind: "live", result: "pass" })], new Set()).level).toBe("verified_live");
    expect(SECTIONS).toEqual(["needs_you", "decided_for_you", "failed_or_rolled_back", "stale_or_stuck", "shipped", "merged", "done", "opened_or_pushed"]);
    expect(LATER_FAILED_MS).toBe(14 * DAY);
    expect(DAY_MS).toBe(DAY);
  });
});
