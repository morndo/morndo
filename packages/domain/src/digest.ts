// The Home digest (docs/design/home-digest/README.md §3–§7; ADR-0025; DG1–DG12 in docs/domain.md): one list of
// everything that changed since the principal last looked, every line one click from the record that made it, with
// proof on every line. It is a read model, not a writer: records in, items out (DG1), the clock arrives as `now`, and
// it grants and starts nothing (DG11). The claim and evidence records it is built from live in verification.ts.

import { cutText, unreachable } from "./shared.ts";
import type { TaskKey } from "./board.ts";
import {
  claimantsOf, independentOf, NOTE_MAX, revisionCovers, subjectKey,
  type Assignment, type Claim, type Evidence, type EvidenceKind, type LinkRecord, type Revision,
} from "./verification.ts";

export { subjectKey as subjectRef } from "./verification.ts";

// ---- subjects (§3.1): a task, a change at a revision, a deploy, an ask, a decision, a lane, a job — never a message

export const SUBJECT_KINDS = ["task", "change", "deploy", "ask", "decision", "lane", "job"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];
export type SubjectRef =
  | { kind: "task"; key: TaskKey }
  | { kind: "change"; repo: string; n: number }
  | { kind: "deploy"; repo: string; env: string; sha: string }   // §3.1: an environment at a revision
  | { kind: "ask"; id: string }
  | { kind: "decision"; id: string }
  | { kind: "lane"; name: string }
  | { kind: "job"; id: string };

export const sameSubject = (a: SubjectRef, b: SubjectRef): boolean => subjectKey(a) === subjectKey(b);

// ---- events (§3.2): one fact about one subject, from one record — never a summary (DG1)

export const EVENT_KINDS = ["needs_you", "decided_for_you", "failed", "rolled_back", "stale_or_stuck", "shipped", "merged", "done", "opened_or_pushed"] as const;
export type DigestEventKind = (typeof EVENT_KINDS)[number];
export type DigestEvent = {
  kind: DigestEventKind;
  subject: SubjectRef;
  seq: number;                            // the digest counter at its arrival (§4)
  at: number;                             // ms since epoch, from the record
  origin: string;                         // names the record (its store and id): every line one click from it (DG1)
};

// ---- sections (§5): the attention order the phone shows

export const SECTIONS = ["needs_you", "decided_for_you", "failed_or_rolled_back", "stale_or_stuck", "shipped", "merged", "done", "opened_or_pushed"] as const;
export type Section = (typeof SECTIONS)[number];
export const sectionOfEvent = (kind: DigestEventKind): Section =>
  kind === "failed" || kind === "rolled_back" ? "failed_or_rolled_back" : kind;

// ---- levels (§3.4): claimed, checked, reviewed, verified live — and failed, which outranks them all (DG3)

export const LEVELS = ["claimed", "checked", "reviewed", "verified_live"] as const;
export type Level = (typeof LEVELS)[number];
export type ItemLevel = Level | "failed";
export const LEVEL_RANK: Record<ItemLevel, number> = { failed: 0, claimed: 1, checked: 2, reviewed: 3, verified_live: 4 };

// §3.3: what one passing piece of evidence of this kind can raise the level to. A `file` raises nothing; a `live`
// check and a `screenshot` reach verified live, but only from a producer other than the claimant (V1) and only once
// the deploy containing the revision has landed (subjectLevel holds that gate).
export const RAISES: Record<EvidenceKind, Level | null> = {
  ci: "checked", tests: "checked", review: "reviewed", live: "verified_live", screenshot: "verified_live", deploy: "checked", file: null,
};

// What one subject brings to its item (§3.4, §3.3): its revision now, the evidence on record for it, its claimants,
// and the causes of failure that stay current (DG3). All of it comes from records (DG1); a lane's own report of any
// of it is worth nothing (DG10).
export type SubjectState = {
  subject: SubjectRef;
  title: string | null;                   // the task's or the change's title, from records
  revision: Revision | null;              // a change's or a deploy's current revision; a task has none
  claimRound: number | null;              // a task without a change: the time of its last move to review (§3.3)
  deployedAt: number | null;              // when the deploy containing this revision landed; ancestry is the forge's
  reverted: boolean;                      // a merged change that was reverted stays failed (DG3)
  rolledBack: boolean;                    // a rolled-back deploy stays failed (DG3)
  reopened: boolean;                      // a task moved out of done is failed until it is accepted again (DG3)
};

// The level of one subject (DG2, DG3, DG4). Evidence on the current revision — the same commit, or the same patch id
// after a rebase — is current; a claim round binds a task's own evidence the same way. Evidence on an earlier
// revision is voided: still shown, struck through, raising nothing (DG4). Any failing evidence on the current
// revision, a revert, a rollback or a reopen shows failed, whatever else passed (V2, DG3). Otherwise the level is the
// highest an independent producer's passing evidence reaches (V1, DG2).
export type SubjectLevel = { level: ItemLevel; current: Evidence[]; voided: Evidence[] };
export function subjectLevel(s: SubjectState, evidence: readonly Evidence[], claimants: ReadonlySet<string>): SubjectLevel {
  const key = subjectKey(s.subject);
  const current: Evidence[] = [], voided: Evidence[] = [];
  for (const e of evidence) {
    if (subjectKey(e.subject) !== key) continue;
    const onRevision = e.revision !== null && s.revision !== null && revisionCovers(e.revision, s.revision);
    const onRound = e.revision === null && s.revision === null && s.claimRound !== null && e.at >= s.claimRound;
    (onRevision || onRound ? current : voided).push(e);
  }
  let level: ItemLevel = "claimed";
  if (current.some(e => e.result === "fail") || s.reverted || s.rolledBack || s.reopened) level = "failed";
  else {
    for (const e of current) {
      if (e.result !== "pass" || !independentOf(e.producer, claimants)) continue;
      const raises = RAISES[e.kind];
      if (raises === null) continue;
      if (raises === "verified_live" && (s.deployedAt === null || e.at < s.deployedAt)) continue;
      if (LEVEL_RANK[raises] > LEVEL_RANK[level]) level = raises;
    }
  }
  return { level, current, voided };
}

// ---- the digest itself (§3.5): items, one per root subject (DG5)

export type NeedsYouState = { subject: SubjectRef; blocking: boolean; due: number | null; since: number };
export type DigestInput = {
  now: number;
  newest: number;                         // the hub's newest digest sequence (§4): the mark never passes it (DG7)
  mark: DigestMark | null;
  events: readonly DigestEvent[];
  evidence: readonly Evidence[];
  claims: readonly Claim[];
  links: readonly LinkRecord[];
  assignments: readonly Assignment[];
  states: readonly SubjectState[];
  needsYou: readonly NeedsYouState[];     // live conditions only: an ask still open (DG6, C1)
  stale: readonly StaleCondition[];       // computed by staleConditions, never reported by a lane (DG10)
};

export type DigestItem = {
  id: string;                             // the root subject's ref
  seq: number;                            // the newest digest sequence it reaches
  at: number;
  section: Section;                       // the first section a live condition or an event since the mark belongs to (DG5)
  level: ItemLevel | null;                // null: a subject with no ladder (an ask, a decision, a lane, a job)
  title: string | null;
  claim: { lane: string; words: string } | null;   // the lane's words, quoted and capped (DG1)
  lane: string | null;
  subjects: SubjectRef[];                 // the root first (DG5)
  events: DigestEvent[];                  // the trail, oldest first (§5)
  evidence: Evidence[];                   // on the current revision
  voided: Evidence[];                     // on an earlier one: shown struck through (DG4)
  fresh: boolean;                         // DG8
  changed: "level" | "section" | null;    // DG8: what changed since it was seen
  needsYou: { blocking: boolean; due: number | null } | null;
  staleSince: number | null;              // DG6: how long the live condition has held
};
export type DigestResult = { sections: { section: Section; items: DigestItem[] }[]; counts: Record<Section, number> };

const bareState = (subject: SubjectRef): SubjectState =>
  ({ subject, title: null, revision: null, claimRound: null, deployedAt: null, reverted: false, rolledBack: false, reopened: false });

// One item per root subject (DG5): a task roots the changes and deploys linked to it — the link is the only way a
// task groups its changes — and everything else is its own root.
type Group = { root: SubjectRef; members: SubjectRef[] };

// The first task linked to a subject at or before `at` (a link record, or a claim naming both, §3.3): its root, in
// time order. A link filed later is not in the map, so a closed week does not change when someone links afterwards
// (DG9, DG12). Omit `at` for the digest as it stands now.
export function linkMapOf(links: readonly LinkRecord[], claims: readonly Claim[], at = Number.POSITIVE_INFINITY): Map<string, TaskKey> {
  const map = new Map<string, TaskKey>();
  const all = [
    ...links.map(l => ({ target: l.target, task: l.task, at: l.at })),
    ...claims.filter(c => c.task !== undefined).map(c => ({ target: c.subject, task: c.task as TaskKey, at: c.at })),
  ].sort((a, b) => a.at - b.at);
  for (const l of all) {
    if (l.at > at) break;
    if (!map.has(subjectKey(l.target))) map.set(subjectKey(l.target), l.task);
  }
  return map;
}

// DG5's root, as a key: the linked task for a change or a deploy, the subject itself otherwise. DG12 counts and
// matches claims per root subject and revision, so a change and the task it is linked to are one.
const rootKeyOf = (s: SubjectRef, linked: ReadonlyMap<string, TaskKey>): string => {
  if (s.kind === "task") return subjectKey(s);
  const t = linked.get(subjectKey(s));
  return t !== undefined ? t : subjectKey(s);
};

export function buildDigest(input: DigestInput): DigestResult {
  const claimants = (s: SubjectRef) => claimantsOf(s, input.claims, input.links, input.assignments);
  const stateOf = (s: SubjectRef): SubjectState => {
    for (const st of input.states) if (sameSubject(st.subject, s)) return st;
    return bareState(s);
  };
  // The first look (no mark) shows the last 24 hours (§4); after that, the mark decides (DG7).
  const sinceMark = (e: DigestEvent) => (input.mark !== null ? e.seq > input.mark.seq : e.at >= input.now - DAY_MS);

  const linkOf = linkMapOf(input.links, input.claims);
  const rootOf = (s: SubjectRef): SubjectRef => {
    if (s.kind === "task") return s;
    const t = linkOf.get(subjectKey(s));
    return t !== undefined ? { kind: "task", key: t } : s;
  };

  const groups = new Map<string, Group>();
  const addSubject = (s: SubjectRef) => {
    const root = rootOf(s);
    const k = subjectKey(root);
    let g = groups.get(k);
    if (g === undefined) { g = { root, members: [root] }; groups.set(k, g); }
    if (subjectKey(s) !== k && !g.members.some(m => sameSubject(m, s))) g.members.push(s);
  };
  for (const e of input.events) addSubject(e.subject);
  for (const e of input.evidence) addSubject(e.subject);
  for (const c of input.claims) addSubject(c.subject);
  for (const l of input.links) addSubject(l.target);
  for (const s of input.states) addSubject(s.subject);
  for (const n of input.needsYou) addSubject(n.subject);
  for (const c of input.stale) addSubject(staleSubject(c));

  const items: DigestItem[] = [];
  for (const [rootKey, group] of groups) {
    const keys = new Set(group.members.map(m => subjectKey(m)));
    const events = input.events.filter(e => keys.has(subjectKey(e.subject))).sort((a, b) => a.seq - b.seq);
    const trail = events.filter(sinceMark);

    // DG6: needs you and stale are live conditions — they hold whatever the mark, and leave only when they clear.
    const live = input.needsYou.find(n => keys.has(subjectKey(n.subject))) ?? null;
    const staleCond = input.stale.find(c => keys.has(subjectKey(staleSubject(c)))) ?? null;
    // DG5: the first section, in the attention order (§5), that a live condition of its own or one of its events
    // since the mark belongs to — a decision or a failure outranks a stale condition; needs you outranks both.
    const belongs: Section[] = [];
    if (live !== null) belongs.push("needs_you");
    if (staleCond !== null) belongs.push("stale_or_stuck");
    for (const e of trail) belongs.push(sectionOfEvent(e.kind));
    let section: Section | null = null;
    for (const s of SECTIONS) if (belongs.includes(s)) { section = s; break; }
    if (section === null) continue;

    const evidence: Evidence[] = [], voided: Evidence[] = [];
    for (const m of group.members) {
      const sl = subjectLevel(stateOf(m), input.evidence, claimants(m));
      evidence.push(...sl.current); voided.push(...sl.voided);
    }
    evidence.sort((a, b) => a.seq - b.seq);
    voided.sort((a, b) => a.seq - b.seq);

    // §3.4: a task's level is the lowest of its linked changes and deploys — reopened it is failed (DG3) — and its
    // own evidence when it has none.
    const root = group.root;
    let level: ItemLevel | null = null;
    if (root.kind === "task" || root.kind === "change" || root.kind === "deploy") {
      const linked = root.kind === "task" ? group.members.filter(m => m.kind === "change" || m.kind === "deploy") : [];
      if (linked.length > 0) {
        level = linked.reduce((low, m) => {
          const sl = subjectLevel(stateOf(m), input.evidence, claimants(m));
          return LEVEL_RANK[sl.level] < LEVEL_RANK[low] ? sl.level : low;
        }, "verified_live" as ItemLevel);
        if (stateOf(root).reopened) level = "failed";
      } else {
        level = subjectLevel(stateOf(root), input.evidence, claimants(root)).level;
      }
    }

    const groupClaims = input.claims.filter(c => keys.has(subjectKey(c.subject))).sort((a, b) => a.at - b.at);
    const last = groupClaims[groupClaims.length - 1] ?? null;
    const groupLinks = input.links.filter(l => keys.has(subjectKey(l.target)));
    const groupAssignments = root.kind === "task" ? input.assignments.filter(a => a.task === root.key) : [];
    // Claims, links and assignments are records too (DG8): a claim, or a claimant change through a link or an
    // assignment, raises the item's sequence past the mark, so the level drop shows as new again.
    const records = [...events, ...evidence, ...voided, ...groupClaims];
    for (const raised of [...groupLinks, ...groupAssignments]) records.push(raised);
    const seq = records.reduce((m, r) => Math.max(m, r.seq), 0);
    const n = itemNew({ id: rootKey, seq, level, section }, input.mark);
    items.push({
      id: rootKey,
      seq,
      at: records.reduce((m, r) => Math.max(m, r.at), live?.since ?? staleCond?.since ?? 0),   // §3.5: the newest record's time, never now
      section,
      level,
      title: group.members.map(m => stateOf(m).title).find(t => t !== null) ?? null,
      claim: last === null ? null : { lane: last.lane, words: cutText(last.note ?? "", NOTE_MAX) },
      lane: last?.lane ?? null,
      subjects: group.members,
      events: trail,
      evidence,
      voided,
      fresh: n.fresh,
      changed: n.changed,
      needsYou: live === null ? null : { blocking: live.blocking, due: live.due },
      staleSince: staleCond?.since ?? null,
    });
  }

  const compare = (section: Section, a: DigestItem, b: DigestItem): number => {
    if (section === "needs_you") {                                       // C3: blocking, then due, then the oldest
      const blocking = Number(b.needsYou?.blocking ?? false) - Number(a.needsYou?.blocking ?? false);
      if (blocking !== 0) return blocking;
      const due = (a.needsYou?.due ?? Number.POSITIVE_INFINITY) - (b.needsYou?.due ?? Number.POSITIVE_INFINITY);
      if (due !== 0) return due;
      return a.seq - b.seq;
    }
    if (section === "stale_or_stuck") return (a.staleSince ?? 0) - (b.staleSince ?? 0) || a.seq - b.seq;
    return b.seq - a.seq;                                                // §5: the rest, newest first
  };
  const counts = {} as Record<Section, number>;
  for (const s of SECTIONS) counts[s] = 0;
  for (const i of items) counts[i.section]++;
  return {
    sections: SECTIONS
      .map(section => ({ section, items: items.filter(i => i.section === section).sort((a, b) => compare(section, a, b)) }))
      .filter(s => s.items.length > 0),
    counts,
  };
}

// ---- the mark (§4, DG7, DG8): a sequence number the digest counter has reached, and what was seen above it

export type SeenAt = { id: string; seq: number; level: ItemLevel | null; section: Section };
export type DigestMark = { seq: number; seen: readonly SeenAt[] };

// DG7: "Mark all seen" covers the lines the device displayed and the folded Opened section — never a line behind
// "N more". Walking from the mark, it advances across every item that was displayed, or already seen above at the
// sequence it shows now (DG8: an item seen at an older sequence was not covered at this one), stops at the first
// that was not, and never passes the hub's newest sequence. Items displayed behind that gap are recorded as seen
// above the mark, with what they showed.
export function markAllSeen(mark: DigestMark | null, items: readonly SeenAt[], covered: readonly string[], newest: number): DigestMark {
  const base = mark?.seq ?? 0;
  const shown = new Set(covered);
  const prior = new Map((mark?.seen ?? []).map(s => [s.id, s]));
  let seq = base;
  const walked: SeenAt[] = [];
  for (const it of [...items].sort((a, b) => a.seq - b.seq || (a.id < b.id ? -1 : 1))) {
    if (it.seq <= base) continue;
    const seenAt = prior.get(it.id);
    // DG7, DG8: a prior seen entry covers this line only when nothing about it changed — the same sequence, level
    // and section. A changed item behind "N more" was not covered, so the mark stops.
    const unchanged = seenAt !== undefined && seenAt.seq === it.seq && seenAt.level === it.level && seenAt.section === it.section;
    if (!shown.has(it.id) && !unchanged) break;
    walked.push(it);
    seq = it.seq;
  }
  const next = Math.max(base, Math.min(seq, newest));
  const seen = new Map<string, SeenAt>();
  for (const s of [...(mark?.seen ?? []), ...items.filter(it => shown.has(it.id)), ...walked]) {
    if (s.seq > next) seen.set(s.id, s);
  }
  return { seq: next, seen: [...seen.values()] };
}

// Opening an item (its task, lane, brief or evidence) marks that item seen, with what it showed, and moves nothing
// else (§4).
export function openedItem(mark: DigestMark | null, item: SeenAt): DigestMark {
  const base = mark?.seq ?? 0;
  const seen = new Map((mark?.seen ?? []).filter(s => s.seq > base).map(s => [s.id, s]));
  if (item.seq > base) seen.set(item.id, item);
  return { seq: base, seen: [...seen.values()] };
}

// DG8: an item is new while its sequence is above the mark and it was not seen at that sequence. An item whose level
// or section changed after it was seen is new again, with what changed.
export function itemNew(item: SeenAt, mark: DigestMark | null): { fresh: boolean; changed: "level" | "section" | null } {
  if (mark === null) return { fresh: true, changed: null };              // the first look: everything shown is new
  const seen = mark.seen.find(s => s.id === item.id) ?? null;
  const changed = seen === null ? null : seen.level !== item.level ? "level" : seen.section !== item.section ? "section" : null;
  const fresh = (item.seq > mark.seq && (seen === null || seen.seq !== item.seq)) || changed !== null;
  return { fresh, changed };
}

// §4: two devices racing keep the larger value, and both sets of items seen above it — and an item seen on both
// keeps its newer entry, whichever mark carries it.
export function mergeMarks(a: DigestMark | null, b: DigestMark | null): DigestMark | null {
  if (a === null) return b;
  if (b === null) return a;
  const seq = Math.max(a.seq, b.seq);
  const seen = new Map<string, SeenAt>();
  for (const s of [...a.seen, ...b.seen]) {
    if (s.seq <= seq) continue;
    const prior = seen.get(s.id);
    if (prior === undefined || s.seq > prior.seq) seen.set(s.id, s);
  }
  return { seq, seen: [...seen.values()] };
}

// ---- stale (§6.3, DG10): computed from records and side effects, never a worker's own report

export const STALE_LIMITS_DEFAULT = {
  busyMs: 45 * 60_000,                   // a lane busy with no side effect
  blockedMs: 4 * 3_600_000,              // a task blocked
  reviewMs: 8 * 3_600_000,               // a task waiting in review
  quietMs: 24 * 3_600_000,               // a task in progress with nothing happening
  queuedJobMs: 60 * 60_000,              // a job queued
} as const;
export type StaleLimits = { busyMs: number; blockedMs: number; reviewMs: number; quietMs: number; queuedJobMs: number };

// Side effects (§6.3): a commit, a working-tree change, a push, a board event by the lane, a job it started or
// ended, a claim or evidence it filed, a message it sent. A moving screen is not one.
export type StaleFacts = {
  lanes: readonly { name: string; workingSince: number | null; lastSideEffectAt: number | null }[];
  tasks: readonly { key: TaskKey; blockedSince: number | null; reviewSince: number | null; doingSince: number | null; lastActivityAt: number | null }[];
  jobs: readonly { id: string; queuedSince: number | null }[];
  deliveries: readonly { lane: string; uncertainSince: number }[];   // delivery uncertain or given up (ADR-0014)
};

export type StaleCondition =
  | { kind: "lane_busy"; lane: string; since: number }
  | { kind: "task_blocked"; task: TaskKey; since: number }
  | { kind: "task_in_review"; task: TaskKey; since: number }
  | { kind: "task_quiet"; task: TaskKey; since: number }
  | { kind: "job_queued"; job: string; since: number }
  | { kind: "delivery_uncertain"; lane: string; since: number };

// A condition becomes an event when its limit is crossed, at that time, and stays listed while it holds (DG6, DG10).
// §6.3 asks for none of the side effects in the window, so the clock starts at the latest one: an effect right after
// the work began holds the window open only for its own limit, not forever.
export function staleConditions(facts: StaleFacts, limits: StaleLimits, now: number): StaleCondition[] {
  const out: StaleCondition[] = [];
  for (const l of facts.lanes) {
    if (l.workingSince === null) continue;
    const since = Math.max(l.workingSince, l.lastSideEffectAt ?? 0) + limits.busyMs;
    if (now >= since) out.push({ kind: "lane_busy", lane: l.name, since });
  }
  for (const t of facts.tasks) {
    if (t.blockedSince !== null && now >= t.blockedSince + limits.blockedMs)
      out.push({ kind: "task_blocked", task: t.key, since: t.blockedSince + limits.blockedMs });
    if (t.reviewSince !== null && now >= t.reviewSince + limits.reviewMs)
      out.push({ kind: "task_in_review", task: t.key, since: t.reviewSince + limits.reviewMs });
    if (t.doingSince === null) continue;
    const quietSince = Math.max(t.doingSince, t.lastActivityAt ?? 0) + limits.quietMs;
    if (now >= quietSince) out.push({ kind: "task_quiet", task: t.key, since: quietSince });
  }
  for (const j of facts.jobs) {
    if (j.queuedSince !== null && now >= j.queuedSince + limits.queuedJobMs)
      out.push({ kind: "job_queued", job: j.id, since: j.queuedSince + limits.queuedJobMs });
  }
  for (const d of facts.deliveries) out.push({ kind: "delivery_uncertain", lane: d.lane, since: d.uncertainSince });
  return out;
}

export function staleSubject(c: StaleCondition): SubjectRef {
  switch (c.kind) {
    case "lane_busy": return { kind: "lane", name: c.lane };
    case "task_blocked": case "task_in_review": case "task_quiet": return { kind: "task", key: c.task };
    case "job_queued": return { kind: "job", id: c.job };
    case "delivery_uncertain": return { kind: "lane", name: c.lane };
    default: return unreachable(c);
  }
}

// ---- the weekly view (§7, DG9, DG12)

export const LATER_FAILED_MS = 14 * 24 * 3_600_000;       // a claim counts as later failed within 14 days (DG12)
export const DAY_MS = 24 * 3_600_000;

// What made a claim count (DG12): a lane filed it, a board task was moved to review, or a lane event said done. What
// failed it later: failing evidence on that revision, a merge reverted, a deploy rolled back, a task reopened.
export type ClaimSource = { subject: SubjectRef; revision: Revision | null; at: number; via: "filed" | "review" | "lane_event" };
export type ClaimFailure = { subject: SubjectRef; revision: Revision | null; at: number; via: "evidence" | "reverted" | "rolled_back" | "reopened" };
export type CountedClaim = { subject: SubjectRef; revision: Revision | null; at: number };

// DG12: counted once per root subject and revision, at the earliest of its sources. A claim filed on the change and
// the same revision claimed when its task moved to review are one count: the root is the linked task (DG5).
export function countedClaims(sources: readonly ClaimSource[], links: readonly LinkRecord[] = [], claims: readonly Claim[] = []): CountedClaim[] {
  const byKey = new Map<string, CountedClaim>();
  for (const s of [...sources].sort((a, b) => a.at - b.at)) {
    const linked = linkMapOf(links, claims, s.at);
    const key = `${rootKeyOf(s.subject, linked)}@${s.revision?.sha ?? "-"}`;
    if (!byKey.has(key)) byKey.set(key, { subject: s.subject, revision: s.revision, at: s.at });
  }
  return [...byKey.values()];
}

// An ISO week in the principal's zone, from the edge: the domain counts, the edge draws the windows.
export type WeekWindow = { week: string; start: number; end: number };
export type WeeklyRecords = {
  shipped: readonly { at: number; verifiedLive: boolean }[];   // successful deploys of a revision with a merged change
  merged: readonly { at: number }[];
  reverted: readonly { at: number }[];
  done: readonly { key: TaskKey; startAt: number; doneAt: number }[];   // startAt: its first move to doing
  deploys: readonly { env: string; at: number; failed: boolean }[];     // every deploy, for the recovery measure
  deploysOf: readonly { subject: SubjectRef; at: number }[];            // when a change's deploy landed
  stuck: readonly { raisedAt: number; clearedAt: number | null; actedOn: boolean }[];
  claimSources: readonly ClaimSource[];
  claimRounds: readonly { subject: SubjectRef; at: number }[];          // every move to review
  claimFailures: readonly ClaimFailure[];
  claims: readonly Claim[];
  links: readonly LinkRecord[];
  assignments: readonly Assignment[];
  evidence: readonly Evidence[];
  subjectStates: readonly SubjectState[];
};
export type LevelHeld = { level: ItemLevel; claims: number; laterFailed: number };
export type WeeklyRow = {
  week: string;
  provisional: boolean;                   // recomputed until 14 days after the week ends, then frozen
  shipped: number; shippedVerifiedLive: number;
  merged: number; reverted: number; done: number;
  timeToDoneMs: { median: number; p90: number } | null;
  claims: number; laterFailed: number; levels: LevelHeld[];
  failedDeploys: number; recoveryMs: number | null;
  stuckRaised: number; stuckFalseAlarms: number;
};

const nearestRank = (sorted: readonly number[], p: number): number | null =>
  sorted.length === 0 ? null : (sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? null);
const medianOf = (sorted: readonly number[]): number | null =>
  sorted.length === 0 ? null : (sorted[Math.floor((sorted.length - 1) / 2)] ?? null);

// The level a claim's item showed at a moment (DG12): the same ladder, fed only the records from before it. A claim
// about a task with a revision (a board or lane-event claim, §3.1) is about the heads of its linked changes, so it is
// judged on those subjects at that revision — a task with changes shows the lowest of theirs (§3.4) — and a task
// without one on its own claim round. A revert, a rollback or a reopen was not failed just before it landed, so the
// ladder runs without those flags.
function levelHeld(claim: CountedClaim, judgeAt: number, r: WeeklyRecords): ItemLevel {
  // A task claim names one revision (§3.1). Each linked change is judged at its own head, and a deploy at the
  // revision in its subject: the claim's sha is not theirs, so their evidence must not be voided against it.
  const revisionOf = (s: SubjectRef): Revision | null => {
    const recorded = s.kind === "deploy"
      ? { sha: s.sha, patchId: null }
      : r.subjectStates.find(st => subjectKey(st.subject) === subjectKey(s))?.revision ?? null;
    return recorded ?? claim.revision;
  };
  const levelOn = (s: SubjectRef): ItemLevel => {
    const key = subjectKey(s);
    let round: number | null = null;
    for (const c of r.claimRounds) if (subjectKey(c.subject) === key && c.at <= judgeAt) round = Math.max(round ?? c.at, c.at);
    let deployed: number | null = null;
    for (const d of r.deploysOf) if (subjectKey(d.subject) === key && d.at <= judgeAt) deployed = deployed === null ? d.at : Math.max(deployed, d.at);
    const claimants = claimantsOf(s, r.claims.filter(c => c.at <= judgeAt), r.links.filter(l => l.at <= judgeAt), r.assignments);
    return subjectLevel(
      {
        subject: s, title: null, revision: revisionOf(s),
        claimRound: claim.revision === null ? round : null, deployedAt: deployed,
        reverted: false, rolledBack: false, reopened: false,
      },
      r.evidence.filter(e => e.at < judgeAt),
      claimants,
    ).level;
  };
  const linked = linkMapOf(r.links, r.claims, judgeAt);
  const judged: SubjectRef[] = [];
  if (claim.subject.kind === "task" && claim.revision !== null) {
    // DG5: a subject is rooted under its first task. A later link to this task does not make it part of the claim.
    const add = (t: SubjectRef, at: number) => {
      if (at > judgeAt || rootKeyOf(t, linked) !== subjectKey(claim.subject)) return;
      if (!judged.some(s => subjectKey(s) === subjectKey(t))) judged.push(t);
    };
    for (const l of r.links) if (l.task === claim.subject.key) add(l.target, l.at);
    for (const c of r.claims) if (c.task === claim.subject.key) add(c.subject, c.at);
  }
  const ladder = judged.length > 0 ? judged : [claim.subject];
  let level: ItemLevel = "verified_live";
  for (const s of ladder) {
    const lvl = levelOn(s);
    if (LEVEL_RANK[lvl] < LEVEL_RANK[level]) level = lvl;             // §3.4: a task shows the lowest of its changes
  }
  return level;
}

export function weeklyView(r: WeeklyRecords, weeks: readonly WeekWindow[], now: number): WeeklyRow[] {
  const counted = countedClaims(r.claimSources, r.links, r.claims);
  return weeks.map(w => {
    const inWeek = (at: number) => at >= w.start && at < w.end;
    const weekClaims = counted.filter(c => inWeek(c.at));
    const failureOf = (c: CountedClaim) => r.claimFailures.find(f => {
      const linked = linkMapOf(r.links, r.claims, f.at);
      return rootKeyOf(f.subject, linked) === rootKeyOf(c.subject, linked) && f.at >= c.at && f.at - c.at <= LATER_FAILED_MS
        && (f.revision === null ? c.revision === null : c.revision !== null && revisionCovers(f.revision, c.revision));
    }) ?? null;
    const levels = new Map<ItemLevel, LevelHeld>();
    for (const c of weekClaims) {
      const f = failureOf(c);
      const level = levelHeld(c, f === null ? Math.min(c.at + LATER_FAILED_MS, now) : f.at, r);
      const row = levels.get(level) ?? { level, claims: 0, laterFailed: 0 };
      row.claims++;
      if (f !== null) row.laterFailed++;
      levels.set(level, row);
    }
    const done = r.done.filter(d => inWeek(d.doneAt));
    const times = done.map(d => d.doneAt - d.startAt).sort((a, b) => a - b);
    const shipped = r.shipped.filter(s => inWeek(s.at));
    const recoveries: number[] = [];
    for (const d of r.deploys) {
      if (!inWeek(d.at) || !d.failed) continue;
      const next = r.deploys.filter(x => x.env === d.env && !x.failed && x.at >= d.at).sort((a, b) => a.at - b.at)[0];
      if (next !== undefined) recoveries.push(next.at - d.at);
    }
    return {
      week: w.week,
      provisional: now < w.end + LATER_FAILED_MS,
      shipped: shipped.length,
      shippedVerifiedLive: shipped.filter(s => s.verifiedLive).length,
      merged: r.merged.filter(m => inWeek(m.at)).length,
      reverted: r.reverted.filter(m => inWeek(m.at)).length,
      done: done.length,
      timeToDoneMs: times.length === 0 ? null : { median: medianOf(times) ?? 0, p90: nearestRank(times, 0.9) ?? 0 },
      claims: weekClaims.length,
      laterFailed: weekClaims.filter(c => failureOf(c) !== null).length,
      levels: [...levels.values()].sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]),
      failedDeploys: r.deploys.filter(d => inWeek(d.at) && d.failed).length,
      recoveryMs: medianOf(recoveries.sort((a, b) => a - b)),
      stuckRaised: r.stuck.filter(s => inWeek(s.raisedAt)).length,
      stuckFalseAlarms: r.stuck.filter(s => inWeek(s.raisedAt) && s.clearedAt !== null && s.clearedAt - s.raisedAt <= 15 * 60_000 && !s.actedOn).length,
    };
  });
}

// ---- DG11: the digest's one action is not one of its own

// The digest grants and starts nothing (O4, B8, C6): seeing, marking and opening are preferences, and a veto is a
// Command (AC7) that asks the manager to reconsider — never a Mandate, a Decision, an Acknowledgement, a Verdict or
// a board move.
export type DigestVeto = { kind: "command"; to: "manager"; decisionId: string };
export const vetoDecision = (decisionId: string): DigestVeto => ({ kind: "command", to: "manager", decisionId });
