// Board context, B18 and D7 (ADR-0040): what a blocked task waits on, in a form the board checks itself, and the board's
// own move once all of it is over. A block's reason is the mover's words and nobody re-reads them: on 2026-10-25 five
// tasks still sat blocked on a tap, a merge or a release that had happened days before (T-331 for 100 h). A wait is one
// of four things the hub can read without a person: another task on this board (done?), a pull request on a forge the
// hub reads (merged or closed?), a card on the owner's list (closed?), or a time (reached?). The board judges each one on
// what it read itself, never on a lane's word, and an unread one is unknown, never over. When every wait a block names is
// over, the board moves the task to do (D7) and says which ended; it never moves it further, and never to Done (D5).
// A block of words only stays as before, and after STALE_BLOCK_MS it is flagged so someone looks at it.
import { MORNDO_REPO, REASON_MAX, parseTaskKey, type Task, type TaskKey, type TaskStatus } from "./board.ts";
import { REPO_NAME } from "./proof.ts";
import { err, ok, type Result } from "./shared.ts";

export type Wait =
  | { kind: "task"; key: TaskKey }
  | { kind: "pr"; repo: string; n: number }
  | { kind: "card"; id: string }
  | { kind: "time"; at: number };

// At most this many waits on one block: each is a read per check, and a list longer than this is a plan, not a wait.
export const WAITS_MAX = 3;
// A time wait is at most this far ahead: further than that is a reminder, and the board is not a calendar.
export const TIME_AHEAD_MAX_MS = 90 * 24 * 3_600_000;
// A block of words only, unchanged this long, is flagged (isStaleBlock).
export const STALE_BLOCK_MS = 48 * 3_600_000;

export type WaitRefusal = { problem: "bad_wait"; detail: string };
const refuse = (detail: string): Result<never, WaitRefusal> => err({ problem: "bad_wait", detail });

const CARD = /^ny-[1-9]\d{0,8}$/;
const PR = /^(?:pr@)?(?:([^#\s]+))?#([1-9]\d{0,8})$/;
// An instant with its offset: a time without one would be read in the hub's zone, which is nobody's 09:30.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

// One wait from its spelling: "T-12", "#93" (morndo/morndo), "owner/repo#93" or "pr@owner/repo#93", "ny-530", or
// "until:<ISO 8601 instant with Z or an offset>". `repos`: the repositories the hub reads (B14's allowlist); a pull
// request anywhere else is refused here, so the board never holds a wait it cannot check.
export function parseWait(spec: string, now: number, repos: readonly string[]): Result<Wait, WaitRefusal> {
  const s = spec.trim();
  const key = parseTaskKey(s);
  if (key) return ok({ kind: "task", key });
  if (CARD.test(s)) return ok({ kind: "card", id: s });
  const pr = PR.exec(s);
  if (pr) {
    const repo = pr[1] ?? MORNDO_REPO;
    if (!REPO_NAME.test(repo)) return refuse(`"${repo}" is not a repository (owner/name)`);
    const known = repos.find(r => r.toLowerCase() === repo.toLowerCase());
    if (!known) return refuse(`the board reads no pull requests in ${repo}; it reads ${repos.join(", ") || "none"}`);
    return ok({ kind: "pr", repo: known, n: Number(pr[2]) });
  }
  if (s.startsWith("until:")) {
    const when = s.slice("until:".length);
    if (!INSTANT.test(when)) return refuse("a time is an ISO 8601 instant with Z or an offset, e.g. until:2026-10-28T09:00+01:00");
    const at = Date.parse(when);
    if (!Number.isFinite(at)) return refuse(`"${when}" is not a time`);
    if (at <= now) return refuse("that time has passed already");
    if (at - now > TIME_AHEAD_MAX_MS) return refuse("a time wait is at most 90 days ahead");
    return ok({ kind: "time", at });
  }
  return refuse(`"${s}" is none of T-12, #93, owner/repo#93, ny-530 or until:<time>`);
}

// The one spelling of a wait, as the CLI and the record show it.
export function waitSpec(w: Wait): string {
  switch (w.kind) {
    case "task": return w.key;
    case "pr": return `${w.repo}#${w.n}`;
    case "card": return w.id;
    case "time": return `until:${new Date(w.at).toISOString()}`;
  }
}

// A block's waits from their spellings, each once, at most WAITS_MAX, never the task itself.
export function parseWaits(specs: readonly string[], self: TaskKey, now: number, repos: readonly string[]): Result<Wait[], WaitRefusal | { problem: "too_many"; detail: string }> {
  const out: Wait[] = [];
  const seen = new Set<string>();
  for (const spec of specs) {
    const w = parseWait(spec, now, repos);
    if (!w.ok) return w;
    if (w.value.kind === "task" && w.value.key === self) return refuse(`${self} cannot wait on itself`);
    const canon = waitSpec(w.value).toLowerCase();
    if (seen.has(canon)) continue;
    seen.add(canon);
    out.push(w.value);
  }
  if (out.length > WAITS_MAX) return err({ problem: "too_many", detail: `at most ${WAITS_MAX} waits` });
  return ok(out);
}

// What the hub read for a wait, in the domain's words: a task's status on this board, a pull request's state on its
// forge, a card's state on the owner's list. A time needs no read. null: nothing could be read.
export type WaitFact =
  | { kind: "task"; status: TaskStatus }
  | { kind: "pr"; state: "open" | "merged" | "closed" }
  | { kind: "card"; state: "open" | "closed" };
export type WaitState = "over" | "open" | "unknown";
export type JudgedWait = { state: WaitState; label: string };

const STATUS_WORDS: Record<TaskStatus, string> = { backlog: "in the backlog", todo: "to do", doing: "in progress", blocked: "blocked", review: "in review", done: "done" };
const prName = (w: { repo: string; n: number }) => (w.repo.toLowerCase() === MORNDO_REPO ? `#${w.n}` : `${w.repo}#${w.n}`);
const minute = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;

// Over only on what was read: a done task, a merged or closed pull request, a closed card, a time reached. Anything
// else is open, and nothing read (or a fact of another kind) is unknown, never over.
export function judgeWait(w: Wait, fact: WaitFact | null, now: number): JudgedWait {
  switch (w.kind) {
    case "time":
      return now >= w.at ? { state: "over", label: `${minute(w.at)} reached` } : { state: "open", label: `until ${minute(w.at)}` };
    case "task":
      if (fact === null || fact.kind !== "task") return { state: "unknown", label: fact === null ? `${w.key} is not on the board` : `${w.key} can't be read now` };
      return { state: fact.status === "done" ? "over" : "open", label: `${w.key} ${STATUS_WORDS[fact.status]}` };
    case "pr":
      if (fact === null || fact.kind !== "pr") return { state: "unknown", label: `${prName(w)} can't be read now` };
      return { state: fact.state === "open" ? "open" : "over", label: `${prName(w)} ${fact.state}` };
    case "card":
      if (fact === null || fact.kind !== "card") return { state: "unknown", label: fact === null ? `${w.id} is not on the owner's list` : `${w.id} can't be read now` };
      return fact.state === "closed" ? { state: "over", label: `${w.id} closed` } : { state: "open", label: `${w.id} still open` };
  }
}

// D7: the board's move for a blocked task whose every named wait is over, judged in the order the waits were named.
// Nothing for a block of words only, a task no longer blocked, or readings that don't match the waits one for one.
export function waitMove(task: Task, judged: readonly JudgedWait[]): { to: "todo"; reason: string; rule: "D7" } | null {
  const waits = task.waits ?? [];
  if (task.status !== "blocked" || waits.length === 0 || judged.length !== waits.length) return null;
  if (!judged.every(j => j.state === "over")) return null;
  const reason = `its wait is over: ${judged.map(j => j.label).join(", ")}`.replace(/\s+/g, " ").slice(0, REASON_MAX);
  return { to: "todo", reason, rule: "D7" };
}

// A block of words only that nobody changed for STALE_BLOCK_MS: the board cannot tell whether it is over, so it says so.
export const isStaleBlock = (task: Task, now: number): boolean =>
  task.status === "blocked" && (task.waits ?? []).length === 0 && now - task.stateChangedAt >= STALE_BLOCK_MS;
