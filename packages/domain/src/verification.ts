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
// that said done. The row carries which of the three, and the revisions it was made at (DG12).
export const CLAIM_OUTCOMES = ["done", "merged", "shipped", "fixed"] as const;
export type ClaimOutcome = (typeof CLAIM_OUTCOMES)[number];
export type ClaimVia = "filed" | "review" | "lane_event";
export type ClaimRevision = { subject: SubjectRef; revision: Revision | null };
export type Claim = {
  id: string;
  seq: number;
  at: number;
  subject: SubjectRef;
  revision: Revision | null;
  outcome: ClaimOutcome;
  lane: string;
  via?: ClaimVia;                         // filed, moved to review, or a lane event that said done (DG12)
  revisions?: readonly ClaimRevision[];   // the revisions it was made at, filled in by the hub (DG12)
  round?: number | null;                  // a task with no change: the sequence of that round's first claim (DG12)
  task?: TaskKey;                         // counts as the task's link to this subject (§3.3)
  note?: string;
};

// A task's link to a change or a deploy (§3.1): the only way a task groups its changes into one digest item (DG5).
// The hub stamps `seq` and `at` together. A link or an assignment raises the item only when it changes the line
// (subjects, revisions, level, chips), and the section is not part of that line (DG8).
export type LinkRecord = { task: TaskKey; target: SubjectRef; by: string; seq: number; at: number };
export type Assignment = { task: TaskKey; lane: string; seq: number; at: number };

export const NOTE_MAX = 140;
const HTTPS_LINK = /^https:\/\/\S+$/;
const ATTACHMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
// §3.3: "nothing that could carry credentials" — no userinfo in the authority, and no parameter whose whole name
// says it is one (token, key, secret, password, sig, signature, …; presigned forms like X-Amz-Signature included).
const USERINFO_LINK = /^https:\/\/[^/?#]*@/;
// A whole parameter-name word, case-insensitive. "signature" is its own word so X-Amz-Signature is refused and
// "design" is not; "authorization" is its own word so "author" is not.
const CREDENTIAL_WORD = /^(?:token|key|secret|password|passwd|pwd|sig|signature|auth|authorization|credential)s?$/i;
// The whole lowercased name. "key" is included: subscriptionkey ends with it. keyword does not, and monkey is
// allowlisted below because the ordinary word happens to end in key.
const CREDENTIAL_SUFFIX = /(?:keys?|tokens?|secrets?|password|passwd|pwd|signature|credentials?)$/i;
const RUN_TOGETHER_KEY = /^(?:apikey|apikeys|accesskey|accesskeyid|privatekey|secretkey|sessionkey|clientkey|subscriptionkey)$/i;
// Known parameter names that contain a credential word and are not secrets. When unsure, refuse: a name has to be
// listed here to be kept.
const HARMLESS_NAME: Readonly<Record<string, string>> = {
  pagetoken: "pageToken: a pagination cursor",
  nextpagetoken: "nextPageToken: a pagination cursor",
  sortkey: "sortKey: which field a list is ordered by",
  cachekey: "cacheKey: a cache entry's name",
  primarykey: "primaryKey: a database column",
  monkey: "monkey: an ordinary word that ends in key",
  maxtokens: "max_tokens: how many tokens a model may spend",
};

const decodeName = (raw: string): string => {
  try { return decodeURIComponent(raw); } catch { return raw; }
};

// accessToken → access, Token; AWSAccessKeyId → AWS, Access, Key, Id; key2 → key, 2.
const splitCamel = (part: string): string[] => {
  const pieces: string[] = [];
  let start = 0;
  const isUpper = (c: string) => c >= "A" && c <= "Z";
  const isLower = (c: string) => c >= "a" && c <= "z";
  const isDigit = (c: string) => c >= "0" && c <= "9";
  const isLetter = (c: string) => isUpper(c) || isLower(c);
  for (let i = 1; i < part.length; i++) {
    const prev = part[i - 1] ?? "";
    const cur = part[i] ?? "";
    const next = part[i + 1] ?? "";
    const boundary = (isLower(prev) || isDigit(prev)) && isUpper(cur)
      || isUpper(prev) && isUpper(cur) && isLower(next)
      || isLetter(prev) && isDigit(cur)
      || isDigit(prev) && isLetter(cur);
    if (boundary) { pieces.push(part.slice(start, i)); start = i; }
  }
  pieces.push(part.slice(start));
  return pieces;
};

// The name, percent-decoded. A piece split on punctuation, camelCase or a digit boundary must be a credential
// word, or the whole name ends with one (other than plain "key"), or it is a known run-together form (apikey).
const nameCarriesCredential = (raw: string): boolean => {
  const name = decodeName(raw);
  const lower = name.toLowerCase();
  // Separators are not part of the name: page_token and sort-key are the same allowlist entries as pageToken and sortKey.
  const normalised = lower.replace(/[^a-z0-9]/g, "");
  if (Object.hasOwn(HARMLESS_NAME, normalised)) return false;
  if (RUN_TOGETHER_KEY.test(lower)) return true;
  if (CREDENTIAL_SUFFIX.test(lower)) return true;
  return name.split(/[^A-Za-z0-9]+/).flatMap(splitCamel).some(part => CREDENTIAL_WORD.test(part));
};

const pairNames = (segment: string): string[] => {
  const names: string[] = [];
  for (const part of segment.split(/[&;]/)) {
    const eq = part.indexOf("=");
    if (eq > 0) names.push(part.slice(0, eq));
  }
  return names;
};

// Query, fragment and ';' parameters. Checked against Node's URL (https://nodejs.org/docs/latest-v24.x/api/url.html,
// read 2026-10-12): ';' stays in the path, and the fragment is not a query. The domain tsconfig has no URL lib, so
// the three parts are split here the same way. %74 in a name is "t" once decoded.
const credentialParam = (link: string): boolean => {
  const hashAt = link.indexOf("#");
  const hash = hashAt === -1 ? "" : link.slice(hashAt + 1);
  const beforeHash = hashAt === -1 ? link : link.slice(0, hashAt);
  const queryAt = beforeHash.indexOf("?");
  const query = queryAt === -1 ? "" : beforeHash.slice(queryAt + 1);
  const beforeQuery = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const slash = beforeQuery.indexOf("/", beforeQuery.indexOf("://") + 3);
  const pathname = slash === -1 ? "" : beforeQuery.slice(slash);
  const names = [...pairNames(query), ...pairNames(hash)];
  for (const seg of pathname.split("/")) {
    const semi = seg.indexOf(";");
    if (semi !== -1) names.push(...pairNames(seg.slice(semi + 1)));
  }
  return names.some(nameCarriesCredential);
};

export type RecordProblem = "empty" | "too_long" | "bad_link" | "bad_counts" | "bad_name";

// The guards on the records themselves, at the edge where they are filed. The digest recomputes from what is stored,
// so a record that never passes these still shows (struck through, capped); these keep the stores clean.
// A link that may be stored: an attachment id, or an https URL without userinfo and without a query parameter
// named like a credential (§3.3).
const safeLink = (link: string): boolean =>
  ATTACHMENT_ID.test(link) ? true : HTTPS_LINK.test(link) && !USERINFO_LINK.test(link) && !credentialParam(link);

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
  if (e.link !== undefined && !safeLink(e.link)) return err("bad_link");
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
