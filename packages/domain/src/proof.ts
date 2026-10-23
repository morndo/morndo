// Proof of work (ADR-0035; B13 to B16 in docs/domain.md): the reference a lane names so the board can check the work
// itself — a pull request at a commit, or that commit's checks — the brief that carries it with the lane's attested
// checks, the one line the card shows, and the brief that still counts once the task has been back in progress. Pure:
// the hub fetches every reference and hands the results in; nothing here reaches a forge, and no clock of its own runs.
import type { TaskEvent } from "./board.ts";
import { cutText, err, ok, type Result } from "./shared.ts";

// B14: a reference is whole or it is refused — repository, number or sha, all present. The repo keeps the case it was
// written in; the sha is stored lower case. These shapes are shared with a task's merge records (B11, board.ts).
export const REPO_NAME = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
export const MERGE_SHA = /^[0-9a-f]{7,40}$/;

export type ProofMode = "off" | "warn" | "on";
export const PROOF_MODES: readonly ProofMode[] = ["off", "warn", "on"];
export type CheckSelector = { name: string } | { id: number };
export type ProofRef =
  | { kind: "pr"; repo: string; number: number; sha: string }
  | { kind: "ci"; repo: string; sha: string; checks: "*" | CheckSelector[] };
export type ProofRefProblem = { problem: "bad_ref"; detail: string };

const GRAMMAR = "a reference is owner/repo#PR@sha or owner/repo@sha:check,check";
const badRef = (): Result<never, ProofRefProblem> => err({ problem: "bad_ref", detail: GRAMMAR });

// `owner/repo#42@3e9d1a7` (a pull request at a commit) or `owner/repo@3e9d1a7:ci,lint` (that commit's checks: `*` for
// every one, or one to ten names, `id=<n>` for a check the forge knows by number). A url, whitespace or a control
// character anywhere but around a check name, a sha under 7 characters: none of it is a reference, and the hub never
// turns a lane's words into an address — only these shapes are ever read (plan §3.8).
export function parseProofRef(input: string): Result<ProofRef, ProofRefProblem> {
  const s = input.trim();
  if (s.includes("://")) return err({ problem: "bad_ref", detail: "a url is not a reference" });
  const pr = /^([A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100})#([1-9]\d{0,8})@([0-9a-fA-F]{7,40})$/.exec(s);
  if (pr) return ok({ kind: "pr", repo: pr[1]!, number: Number(pr[2]), sha: pr[3]!.toLowerCase() });
  const ci = /^([A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100})@([0-9a-fA-F]{7,40}):(.+)$/.exec(s);
  if (ci) {
    const rest = ci[3]!;
    if (rest === "*") return ok({ kind: "ci", repo: ci[1]!, sha: ci[2]!.toLowerCase(), checks: "*" });
    const parts = rest.split(",");
    if (parts.length > 10) return badRef();
    const checks: CheckSelector[] = [];
    const seen = new Set<string>();
    for (const raw of parts) {
      const t = raw.trim();
      if (t === "" || t.length > 100 || /[\x00-\x1f\x7f]/.test(t)) return badRef();
      const id = /^id=(\d{1,12})$/.exec(t);
      const shape = id === null ? `name:${t}` : `id:${id[1]}`;
      if (seen.has(shape)) continue;                       // written twice: kept once, order kept
      seen.add(shape);
      checks.push(id === null ? { name: t } : { id: Number(id[1]) });
    }
    return ok({ kind: "ci", repo: ci[1]!, sha: ci[2]!.toLowerCase(), checks });
  }
  return badRef();
}

// The canonical form: what is stored and shown, and what parses back to the same reference (the round trip).
export function refString(ref: ProofRef): string {
  if (ref.kind === "pr") return `${ref.repo}#${ref.number}@${ref.sha}`;
  const checks = ref.checks === "*" ? "*" : ref.checks.map(c => ("name" in c ? c.name : `id=${c.id}`)).join(",");
  return `${ref.repo}@${ref.sha}:${checks}`;
}

export const ATTESTED_KINDS = ["tests", "manual", "ui", "data", "infra"] as const;
export type AttestedKind = (typeof ATTESTED_KINDS)[number];
export type Attested = { kind: AttestedKind; how: string };

// The stored brief (B13). The arrays are plain on purpose: the protocol package checks its wire shape against this type
// for equality, and a readonly array would not be one.
export type ProofBrief = { summary: string; decisions: string; leftOut: string; limits: string; refs: string[]; attested: Attested[]; noCode: string };
// What a lane sends: `decisions`, `refs`, `attested` and `noCode` may be left out.
export type BriefInput = { summary: string; decisions?: string; leftOut: string; limits: string; refs?: string[]; attested?: { kind: string; how: string }[]; noCode?: string };

export const BRIEF_LIMITS = { summary: 500, decisions: 500, leftOut: 300, limits: 300, noCode: 200, how: 300, refs: 8, attested: 6, bytes: 8192 } as const;
export type ProofBriefProblem = "empty" | "too_long" | "bad_text" | "too_many" | "bad_ref" | "ref_unrelated" | "ref_repo";
export type ProofBriefRefusal = { problem: ProofBriefProblem; detail?: string };

// The same rule as board.ts text(): control characters except \n and \t are refused, line endings of any kind become
// \n, each field is trimmed and bounded. Here the refusal names the brief's own rule, not the board's.
const briefText = (v: string, max: number, allowEmpty: boolean): Result<string, ProofBriefRefusal> => {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v)) return err({ problem: "bad_text" });
  const t = v.replace(/\r\n?/g, "\n").trim();
  if (!t && !allowEmpty) return err({ problem: "empty" });
  if (t.length > max) return err({ problem: "too_long" });
  return ok(t);
};

// Two shas are of the same commit when either is a prefix of the other: the 7-character form of a full one, or the same.
const sameCommit = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

// One brief, judged whole, in this order (the first refusal wins). A reference must be whole (B14), its repository one
// the board checks (the hub holds a credential that may read private work; a lane must not aim it, plan §3.3), and a ci
// reference must hang off a pull request of the same brief or a merge record of the task, so a lane cannot point the
// board at any green commit of anyone's pull request. `noCode` stands in for the references (a memo, an analysis).
export function checkBrief(input: BriefInput, ctx: { allowedRepos: readonly string[]; merges: readonly { repo: string; sha: string }[] }): Result<ProofBrief, ProofBriefRefusal> {
  const summary = briefText(input.summary, BRIEF_LIMITS.summary, false);
  if (!summary.ok) return summary;
  const decisions = briefText(input.decisions ?? "", BRIEF_LIMITS.decisions, true);
  if (!decisions.ok) return decisions;
  const leftOut = briefText(input.leftOut, BRIEF_LIMITS.leftOut, false);
  if (!leftOut.ok) return leftOut;
  const limits = briefText(input.limits, BRIEF_LIMITS.limits, false);
  if (!limits.ok) return limits;
  const noCode = briefText(input.noCode ?? "", BRIEF_LIMITS.noCode, true);
  if (!noCode.ok) return noCode;
  const attestedIn = input.attested ?? [];
  const hows: string[] = [];
  for (const a of attestedIn) {
    const how = briefText(a.how, BRIEF_LIMITS.how, false);
    if (!how.ok) return how;
    hows.push(how.value);
  }
  if (attestedIn.length > BRIEF_LIMITS.attested) return err({ problem: "too_many" });
  const attested: Attested[] = [];
  for (let i = 0; i < attestedIn.length; i++) {
    const kind = attestedIn[i]!.kind;
    if (!(ATTESTED_KINDS as readonly string[]).includes(kind)) return err({ problem: "bad_text", detail: "attested kind" });
    attested.push({ kind: kind as AttestedKind, how: hows[i]! });
  }
  const refsIn = input.refs ?? [];
  if (refsIn.length > BRIEF_LIMITS.refs) return err({ problem: "too_many" });
  const repos = new Set([...ctx.allowedRepos, ...ctx.merges.map(m => m.repo)].map(r => r.toLowerCase()));
  const parsed: ProofRef[] = [];
  const refs: string[] = [];
  const held = new Set<string>();
  for (const raw of refsIn) {
    const r = parseProofRef(raw);
    if (!r.ok) return err({ problem: "bad_ref", detail: `${raw}: ${r.error.detail}` });
    const canonical = refString(r.value);
    if (held.has(canonical)) continue;                    // written twice: kept once, order kept
    if (!repos.has(r.value.repo.toLowerCase())) return err({ problem: "ref_repo", detail: r.value.repo });
    held.add(canonical);
    parsed.push(r.value);
    refs.push(canonical);
  }
  for (const ref of parsed) {
    if (ref.kind !== "ci") continue;
    const hangs = parsed.some(p => p.kind === "pr" && p.repo.toLowerCase() === ref.repo.toLowerCase() && sameCommit(ref.sha, p.sha))
      || ctx.merges.some(m => m.repo.toLowerCase() === ref.repo.toLowerCase() && sameCommit(ref.sha, m.sha.toLowerCase()));
    if (!hangs) return err({ problem: "ref_unrelated", detail: refString(ref) });
  }
  if (noCode.value !== "" && refs.length > 0) return err({ problem: "bad_ref", detail: "noCode stands in for refs; give one or the other" });
  const brief: ProofBrief = { summary: summary.value, decisions: decisions.value, leftOut: leftOut.value, limits: limits.value, refs, attested, noCode: noCode.value };
  if (utf8Bytes(JSON.stringify(brief)) > BRIEF_LIMITS.bytes) return err({ problem: "too_long" });
  return ok(brief);
}

// UTF-8 length in bytes, counted by the encoding's own shapes: the domain compiles with no platform library, so there
// is no text coder to call. JSON.stringify never writes a lone surrogate (it writes the escaped shape), so a pair is
// always the one four-byte form.
function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

export type RefState = "green" | "pending" | "red" | "mismatch" | "missing" | "unfetchable";
// The states this build knows, for a store that reads a row without guessing: a state not among them (a newer hub
// wrote it) is never taken for one.
export const REF_STATES: readonly RefState[] = ["green", "pending", "red", "mismatch", "missing", "unfetchable"];
export type RefResult = { ref: string; state: RefState; detail: string | null; checkedAt: number };   // ref: a brief's own canonical form
export type ProofKind = "no_brief" | "unchecked" | "pending" | "failing" | "unfetchable" | "verified" | "attested_only";
export type ProofState = { kind: ProofKind; green: number; total: number; accepts: boolean; line: string };

const MARK: Record<RefState, string> = { green: "✓", red: "✗", mismatch: "≠", missing: "?", unfetchable: "!", pending: "…" };
const WORD: Record<RefState, string> = { green: "green", red: "failed", mismatch: "mismatch", missing: "missing", unfetchable: "unfetchable", pending: "pending" };

// What the card shows of one brief against the results the hub holds (B15): one line, whatever the references' states.
// Verified proof only — attested items never move it (B14), one reference the board could not read is never green, and
// one red reference makes the whole task failing whatever else is green. A reference with no row yet counts as pending.
export function proofOf(brief: ProofBrief | null, results: readonly RefResult[]): ProofState {
  if (brief === null) return { kind: "no_brief", green: 0, total: 0, accepts: false, line: "proof: no brief" };
  if (brief.refs.length === 0) {
    if (brief.noCode !== "") return { kind: "attested_only", green: 0, total: 0, accepts: true, line: "proof: attested only (no code change)" };
    return { kind: "unchecked", green: 0, total: 0, accepts: false, line: "proof: unchecked (no reference to verify)" };
  }
  const latest = new Map<string, RefResult>();
  for (const row of results) {
    const kept = latest.get(row.ref);
    if (kept === undefined || row.checkedAt > kept.checkedAt) latest.set(row.ref, row);   // several rows: the latest check wins
  }
  const states = brief.refs.map(ref => latest.get(ref)?.state ?? "pending");
  const green = states.filter(s => s === "green").length;
  const kind: ProofKind = states.some(s => s === "red" || s === "mismatch" || s === "missing") ? "failing"
    : states.some(s => s === "unfetchable") ? "unfetchable"
    : states.some(s => s === "pending") ? "pending" : "verified";
  const parts = brief.refs.map((ref, i) => states[i] === "green" ? "" : ` · ${MARK[states[i]!]} ${ref} ${latest.get(ref)?.detail ?? WORD[states[i]!]}`);
  const whole = `proof: ${green} of ${brief.refs.length} green${parts.join("")}`;
  return { kind, green, total: brief.refs.length, accepts: kind === "verified", line: whole.length > 600 ? `${cutText(whole, 599)}…` : whole };
}

// B13: the brief that still counts — the newest `briefed` event, unless the task has been back in progress since (a
// review → doing move with a higher rev stales every brief before it; a new round of work files a new one).
export function currentBrief(events: readonly TaskEvent[]): { brief: ProofBrief; rev: number } | null {
  let back = 0;
  for (const e of events) if (e.change.kind === "moved" && e.change.from === "review" && e.change.to === "doing" && e.rev > back) back = e.rev;
  let best: { brief: ProofBrief; rev: number } | null = null;
  for (const e of events) if (e.change.kind === "briefed" && e.rev > back && (best === null || e.rev > best.rev)) best = { brief: e.change.brief, rev: e.rev };
  return best;
}

// What applyAction judges a Done against (B16): the brief as filed, the results the hub read for its references, and
// the mode the gate runs in (off: the gate is not there; warn: the Done is accepted with what was seen recorded; on:
// not green refuses). `allowedRepos` absent: MORNDO_REPO plus the task's merge records, as checkBrief is told there.
export type ProofGate = { mode: ProofMode; brief: ProofBrief | null; results: readonly RefResult[]; allowedRepos?: readonly string[] };
