// The proof block and the --why lint (ADR-0035 step 4, B14 to B16): the lines `show`, `brief --show` and a filed brief
// print of a proof view, and the one warning a done's reason earns for each commit or pull request it names that the
// board did not verify. Pure functions of what the hub answered, so they are table-tested without a hub; the marks and
// the words of a reference's state are the domain's own, the ones its one line is worded with.
import { MARK, WORD, parseProofRef, type CoverageItem, type MergeRecord, type ProofBrief, type RefResult, type RefState } from "@morndo/domain";

// What the hub answers a read with (proof-service's view), as this CLI reads it: the state's line is all the text
// needs, so a newer hub's extra fields pass through unheard.
export type ProofView = { rev: number | null; brief: ProofBrief | null; results: readonly RefResult[]; coverage?: readonly CoverageItem[]; standIn?: boolean; state: { line: string } };

const COVERAGE_TAG: Record<CoverageItem["status"], string> = {
  covered: "[covered]", told: "[the lane's word]", open: "[open]", not_covered: "[not covered]",
};

// One line of brief text: newlines and runs of whitespace collapse so a lane cannot start its own line.
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

// A brief's rows by reference, the latest check winning, as the domain's proofOf reads the same rows.
const rowsBy = (results: readonly RefResult[]): ReadonlyMap<string, RefResult> => {
  const latest = new Map<string, RefResult>();
  for (const row of results) {
    const kept = latest.get(row.ref);
    if (kept === undefined || row.checkedAt > kept.checkedAt) latest.set(row.ref, row);
  }
  return latest;
};

// The block under a task: the one line the card shows, then the brief as filed — its own lines only when they say
// something, one line per reference with its mark and its detail or its word, the lane's attested checks as its word
// (never as verified, B14), and `noCode` when the task changed no repository.
export function proofBlock(view: ProofView): string[] {
  const body = proofLines(view);
  // A scratch hub that reads a stand-in forge says so first: its green is not GitHub's.
  return view.standIn === true ? ["  (read from a stand-in forge, not GitHub)", ...body] : body;
}

const listLines = (coverage: readonly CoverageItem[]): string[] => {
  if (coverage.length === 0) return [];
  const out = ["  Proof list (set by the manager):"];
  for (const item of coverage) {
    const lane = item.by === "lane" ? "  (added by the lane)" : "";
    out.push(`    ${COVERAGE_TAG[item.status]} ${item.spec}${lane}`);
  }
  return out;
};

function proofLines(view: ProofView): string[] {
  const coverage = view.coverage ?? [];
  const list = listLines(coverage);
  if (view.brief === null) return [`  Proof: ${view.state.line}`, ...list];
  const b = view.brief;
  const rows = rowsBy(view.results);
  const lines = [`  Proof: ${view.state.line}`, ...list, `    Brief (rev ${view.rev}): ${oneLine(b.summary)}`];
  if (b.decisions !== "") lines.push(`    Decisions: ${oneLine(b.decisions)}`);
  if (b.leftOut !== "") lines.push(`    Left out: ${oneLine(b.leftOut)}`);
  if (b.limits !== "") lines.push(`    Limits: ${oneLine(b.limits)}`);
  for (const ref of b.refs) {
    const row = rows.get(ref);
    const state: RefState = row?.state ?? "pending";           // no row yet: the check is on its way
    const tail = oneLine(row?.detail ?? WORD[state]);
    lines.push(`    ${MARK[state]} ${ref} ${tail}`);
  }
  for (const a of b.attested) lines.push(`    Attested (${a.kind}): ${oneLine(a.how)}  (the lane's word, not checked)`);
  if (b.noCode !== "") lines.push(`    No code change: ${oneLine(b.noCode)}`);
  return lines;
}

// Two shas name one commit when either is a prefix of the other: the 7-character form of a full one, or the same.
const sameCommit = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

// The commits and pull requests a done's reason names: hex, 7 to 40 characters, a digit among them (so no word of
// letters is one), whole between non-word characters; and `#` with its digits. Each as it stands in the text, so the
// warnings follow the reason's own order. A reason that names none has nothing to verify, so the look is never made.
export function whyTokens(why: string): { token: string; at: number }[] {
  const tokens: { token: string; at: number }[] = [];
  for (const m of why.matchAll(/(?<![A-Za-z0-9_])[0-9a-fA-F]{7,40}(?![A-Za-z0-9_])/g))
    if (/\d/.test(m[0])) tokens.push({ token: m[0], at: m.index ?? 0 });
  for (const m of why.matchAll(/#(\d+)/g)) tokens.push({ token: m[0], at: m.index ?? 0 });
  return tokens;
}

// The --why lint (plan 3.5): a done's reason is prose, never parsed, but a commit-shaped token or a `#n` it names is
// checked against what the board verified itself — a sha against a green reference of the brief or a merge record, a
// number against a green pull request — and each token that comes back unverified earns one warning line naming what
// did verify. Only the warning: the words stand, and what is sent never changes.
export function lintWhy(why: string, view: ProofView, merges: readonly MergeRecord[]): string[] {
  const tokens = whyTokens(why);
  if (tokens.length === 0) return [];
  // What the board verified: the brief's green references (their shas, and a pull request's number), and the task's
  // merge records. A reference that is not green verifies nothing, and neither does the lane's own word.
  const rows = rowsBy(view.results);
  const green = (view.brief?.refs ?? []).filter(ref => rows.get(ref)?.state === "green");
  const shas: string[] = [];
  const numbers: number[] = [];
  for (const ref of green) {
    const parsed = parseProofRef(ref);
    if (!parsed.ok) continue;
    shas.push(parsed.value.sha);
    if (parsed.value.kind === "pr") numbers.push(parsed.value.number);
  }
  const verified = (t: { token: string }) =>
    t.token.startsWith("#") ? numbers.includes(Number(t.token.slice(1)))
      : shas.some(sha => sameCommit(t.token.toLowerCase(), sha)) || merges.some(m => sameCommit(t.token.toLowerCase(), m.sha.toLowerCase()));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...tokens].sort((a, b) => a.at - b.at)) {
    if (seen.has(t.token) || verified(t)) continue;
    seen.add(t.token);
    out.push(`warning: --why names ${t.token}, which the board did not verify; verified: ${green.length > 0 ? green.join(", ") : "none"}`);
  }
  return out;
}
