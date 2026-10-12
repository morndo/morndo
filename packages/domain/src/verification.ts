// Verification, the digest's records (docs/design/home-digest/README.md §3.3; ADR-0025; V1 and V2 in docs/domain.md):
// a claim is a lane's statement that an outcome holds on a revision; evidence is one check's result on one revision
// from one producer. Only a producer other than the claimants' counts toward verifying (V1); any failing evidence on
// the claimed revision refutes the claim, whatever else passed (V2). Nothing here reads a clock or a disk: records in,
// judgements out. `SubjectRef` is the digest's (docs/domain.md "Home digest"); the import is a type, so this file
// stays free of the digest's read model.

import { err, ok, type Result } from "./shared.ts";
import { LANE_NAME, parseTaskKey, type TaskKey } from "./board.ts";
import type { SubjectRef } from "./digest.ts";

// A revision of a change: the commit, and the patch id the forge computes for its diff. A rebase changes the commit
// and keeps the patch id, so evidence naming the same patch id is still on this revision (V1).
export type Revision = { sha: string; patchId: string | null };

export const revisionCovers = (of: Revision, claimed: Revision): boolean =>
  of.sha === claimed.sha || (of.patchId !== null && of.patchId === claimed.patchId);

// Who produced a piece of evidence (§3.3): the forge's own adapters, the manager, a lane, or the principal. Lanes on
// one machine share the forge account, so `lane` is the only kind that can be the author of the work it reports on.
export type ProducerKind = "forge" | "manager" | "lane" | "principal";
export type Producer = { kind: ProducerKind; name: string; token?: string };

export const EVIDENCE_KINDS = ["ci", "tests", "review", "live", "screenshot", "deploy", "file"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export const EVIDENCE_RESULTS = ["pass", "fail", "incomplete", "info"] as const;
export type EvidenceResult = (typeof EVIDENCE_RESULTS)[number];
export type TestCounts = { passed: number; failed: number; skipped: number };

// One check's result on one revision (§3.3). Never a summary, never a worker's words: `note` is a caption for the
// link, capped at NOTE_MAX. `link` is an https URL or an attachment id — nothing that could carry credentials.
export type Evidence = {
  id: string;
  seq: number;                            // the digest counter at its arrival (§4)
  at: number;                             // ms since epoch, from the record
  subject: SubjectRef;
  revision: Revision | null;              // null: bound to a task's claim round instead (§3.3)
  kind: EvidenceKind;
  result: EvidenceResult;
  counts?: TestCounts;                    // the tests kind alone
  link?: string;
  note?: string;
  producer: Producer;
};

// The outcomes a lane can claim (§3.1). A claim is filed by a lane, a board task moved to review, or a lane event
// that said done; which of the three made it is the weekly count's business (DG12), not the record's.
export const CLAIM_OUTCOMES = ["done", "merged", "shipped", "fixed"] as const;
export type ClaimOutcome = (typeof CLAIM_OUTCOMES)[number];
export type Claim = {
  id: string;
  seq: number;
  at: number;
  subject: SubjectRef;
  revision: Revision | null;
  outcome: ClaimOutcome;
  lane: string;
  task?: TaskKey;                         // counts as the task's link to this subject (§3.3)
  note?: string;
};

// A task's link to a change or a deploy (§3.1): the only way a task groups its changes into one digest item (DG5).
export type LinkRecord = { task: TaskKey; target: SubjectRef; by: string; at: number };
export type Assignment = { task: TaskKey; lane: string };

export const NOTE_MAX = 140;
const HTTPS_LINK = /^https:\/\/\S+$/;
const ATTACHMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
export type RecordProblem = "empty" | "too_long" | "bad_link" | "bad_counts" | "bad_name";

// The guards on the records themselves, at the edge where they are filed. The digest recomputes from what is stored,
// so a record that never passes these still shows (struck through, capped); these keep the stores clean.
export function checkClaim(c: Claim): Result<Claim, RecordProblem> {
  if (c.lane === "") return err("empty");
  if (!LANE_NAME.test(c.lane)) return err("bad_name");
  if (c.task !== undefined && parseTaskKey(c.task) === null) return err("bad_name");
  if (c.note !== undefined && c.note.length > NOTE_MAX) return err("too_long");
  return ok(c);
}

export function checkEvidence(e: Evidence): Result<Evidence, RecordProblem> {
  if (!LANE_NAME.test(e.producer.name)) return err("bad_name");
  if (e.note !== undefined && e.note.length > NOTE_MAX) return err("too_long");
  if (e.link !== undefined && !HTTPS_LINK.test(e.link) && !ATTACHMENT_ID.test(e.link)) return err("bad_link");
  if (e.counts !== undefined && e.kind !== "tests") return err("bad_counts");
  return ok(e);
}

// The claimants of a subject (§3.3): every lane that filed a claim on it or linked it, and every lane ever assigned a
// task linked to it — a reassignment does not make the old assignee independent. The subject task itself is one of its
// linked tasks, so its own ever-assignees are its claimants. A claim naming a task is itself the link. Computed from
// the current records each time, so a lane that claims later stops its earlier evidence counting.
export function claimantsOf(subject: SubjectRef, claims: readonly Claim[], links: readonly LinkRecord[], assignments: readonly Assignment[]): ReadonlySet<string> {
  const ref = subjectKey(subject);
  const lanes = new Set<string>();
  for (const c of claims) if (subjectKey(c.subject) === ref) lanes.add(c.lane);
  const tasks = new Set<string>();
  if (subject.kind === "task") tasks.add(subject.key);
  for (const l of links) if (subjectKey(l.target) === ref) { lanes.add(l.by); tasks.add(l.task); }
  for (const c of claims) if (c.task !== undefined && subjectKey(c.subject) === ref) tasks.add(c.task);
  for (const a of assignments) if (tasks.has(a.task)) lanes.add(a.lane);
  return lanes;
}

// V1: is this producer other than the claimants? The forge, the manager and the principal never authored the work. A
// lane is independent when it is no claimant — and when nobody claimed the subject at all, no lane is either: the
// forge account is shared by every lane on a machine, so lane evidence on an unclaimed change proves nothing.
export function independentOf(producer: Producer, claimants: ReadonlySet<string>): boolean {
  if (producer.kind !== "lane") return true;
  if (claimants.size === 0) return false;
  return !claimants.has(producer.name);
}

// The verdict on a claim, in the digest's slice of it (V1, V2, V4). Any failing evidence on the claimed revision
// refutes it, whatever else passed and whoever produced the failure (V2); nothing makes it Verified yet, because the
// Done-means does not exist (V1, V4) — the digest shows levels, not Verdicts, until one does. The claimants change
// nothing here: their evidence refutes as surely as anyone's, and it verifies nothing (V1).
export type Verdict = "refuted" | "unverified";
export function claimVerdict(claim: Pick<Claim, "subject" | "revision">, evidence: readonly Evidence[], claimants: ReadonlySet<string>): Verdict {
  void claimants;                         // named for V1, unused on purpose: see above
  if (claim.revision !== null) {
    for (const e of evidence) {
      if (e.result !== "fail" || e.revision === null) continue;
      if (subjectKey(e.subject) !== subjectKey(claim.subject)) continue;
      if (revisionCovers(e.revision, claim.revision)) return "refuted";
    }
  }
  return "unverified";
}

// The stable key of a subject, shared with the digest: one subject, one key, whatever object carries it.
export function subjectKey(subject: SubjectRef): string {
  switch (subject.kind) {
    case "task": return subject.key;
    case "change": return `${subject.repo}#${subject.n}`;
    case "deploy": return `${subject.repo}:${subject.env}@${subject.sha}`;   // §3.1: an environment at a revision
    case "ask": return `ask:${subject.id}`;
    case "decision": return `decision:${subject.id}`;
    case "lane": return `lane:${subject.name}`;
    case "job": return `job:${subject.id}`;
  }
}
