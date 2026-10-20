// A lane's Run on the board (ADR-0032, design §7): the ring on the assignee's avatar, the dot and the one live line under
// a card's title, the header's counts, which card a lane's Run shows on, and the lanes that work without a task. Pure:
// the Runs come decoded from the board frame (board.ts decodeRuns) and the clock as `now`; nothing here reads the page or
// the hub. The words say the state, and the ring and the dot only repeat it in the status colours (COLOR.md 2: colour is
// never the only cue). The Run's phase and wait are the fleet's (R1, R7); this only says them.
import type { Run, Task, TaskKey, TaskStatus } from "@morndo/domain";

// How a Run looks: `ring` and `dot` are class lists RunAvatar.svelte and RunDot.svelte draw, `words` the live line.
//   ring: a shape (ring-solid, ring-dashed, ring-dotted), a tone (ring-working, ring-muted, ring-warn), and ring-pulse
//   dot:  a shape (dot-fill, dot-hollow), a tone (dot-working, dot-muted, dot-warn, dot-ink, dot-bad, dot-idle)
// The shape says what the lane is on (working and needs-you solid, its own work dashed, a wake-up dotted), the tone how
// it stands; a wait past its deadline (R3, overdue) keeps its shape and turns to the warning tone.
export type RunLook = { ring: string | null; dot: string; words: string };

// The statuses a lane's task is open in: its Run shows on one of those cards (runCards), and a lane with none of them
// is a lane without a task (lanesWithoutTask). Backlog is nobody's yet and done is accepted: a Run never shows there.
export const OPEN: readonly TaskStatus[] = ["todo", "doing", "blocked", "review"];

// A span of time, short: "<1m", "3m", "1h 5m", "2h", "3d". A Run's times are by its node's clock, so one a little ahead
// of this device's is "<1m", never negative.
export function span(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
// A time of day on this device's clock, as 14:42 (24 hours, whatever the locale).
export const hhmm = (at: number) => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// A status line's word and the rest of the line after it: `STATUS: DONE. Fix pushed` is DONE and "Fix pushed". The
// pattern is the one lane events read the line with (packages/protocol/src/lane-status.ts, STATUS_LINE: decoration
// around the word is allowed), so what counts as a status here is what the fleet counted. A line that states none is
// all rest.
export type SaidWord = "DONE" | "BLOCKED" | "NEEDS DECISION" | "WAITING";
const STATUS_LINE = /^[\W_]*STATUS[\W_]*:?[\W_]*(DONE|BLOCKED|NEEDS DECISION|WAITING)\b(.*)$/i;
export function saidOf(line: string): { word: SaidWord | null; rest: string } {
  const m = STATUS_LINE.exec(line.trim());
  if (!m) return { word: null, rest: line.trim() };
  const rest = (m[2] ?? "").replace(/^[\s*_`~:.,;—–-]+/u, "").replace(/[\s*_`~]+$/u, "").trim();
  return { word: (m[1] ?? "").toUpperCase().replace(/\s+/g, " ") as SaidWord, rest };
}
const OUTCOME_WORD = { done: "DONE", blocked: "BLOCKED", needs_decision: "NEEDS DECISION" } as const;

const more = (n: number) => (n > 0 ? ` (+${n} more)` : "");

// The look of `run` at `now`, or null when it shows nothing on a card: no Run, or a lane that is gone (R5), which the
// card's "not running" chip says instead.
export function runLook(run: Run | null | undefined, now: number, clock: (at: number) => string = hhmm): RunLook | null {
  if (!run || run.phase === "gone") return null;
  const late = run.overdue ? " · overdue" : "";
  const tone = (t: string) => (run.overdue ? "warn" : t);
  const look = (ring: string | null, dot: string, words: string): RunLook => ({ ring, dot, words: words + late });
  const since = span(now - run.since);
  switch (run.phase) {
    case "unknown": return look(null, "dot-hollow dot-idle", "Its machine is offline");
    case "working": return look("ring-solid ring-working ring-pulse", "dot-fill dot-working", `Working · ${since}`);
    case "needs_you": return look("ring-solid ring-warn", "dot-fill dot-warn", run.question?.trim() ? `Needs you: ${run.question.trim()}` : "Needs you");
    case "ended": {
      if (run.outcome === undefined || run.outcome === "no_status") return look(null, "dot-fill dot-idle", "Idle");
      const { rest } = saidOf(run.line ?? "");
      const dot = run.outcome === "done" ? "dot-ink" : run.outcome === "blocked" ? "dot-bad" : "dot-warn";
      return look(null, `dot-fill ${dot}`, `Said ${OUTCOME_WORD[run.outcome]}${rest ? `: ${rest}` : ""}`);
    }
    case "waiting": {
      const w = run.wait;
      if (w?.on === "background") {
        const first = w.tasks[0]?.label.trim();
        return look(`ring-dashed ring-${tone("working")}`, `dot-hollow dot-${tone("working")}`,
          first ? `In the background: ${first}${more(w.tasks.length - 1)} · ${since}` : `In the background · ${since}`);
      }
      if (w?.on === "job") {
        const first = w.jobs[0]?.name.trim();
        return look(`ring-dashed ring-${tone("working")}`, `dot-hollow dot-${tone("working")}`,
          first ? `Job ${first} running${more(w.jobs.length - 1)}` : "A job is running");
      }
      if (w?.on === "wakeup") {
        return look(`ring-dotted ring-${tone("muted")}`, `dot-hollow dot-${tone("muted")}`,
          w.next === null ? "A wake-up is scheduled" : `Wakes at ${clock(w.next)}`);
      }
      // Declared (R4), or a wait this build doesn't know: nothing the fleet saw will wake it.
      const what = w?.on === "declared" ? w.what?.trim() : "";
      return look("ring-dashed ring-warn", "dot-hollow dot-warn", `Says waiting${what ? ` on ${what}` : ""} · nothing will wake it`);
    }
  }
}

// One word for a Run's phase, as the lanes-without-a-task row names it beside the lane.
export const PHASE_WORDS: Record<Run["phase"], string> = {
  working: "working", waiting: "waiting", needs_you: "needs you", ended: "ended", gone: "gone", unknown: "offline",
};
// A wait on the lane's own work (R2): background tasks of the agent CLI, a job of the lane, or a wake-up it scheduled.
// Declared is not: nothing of its own will wake it (R4).
export const onOwnWork = (r: Run) => r.phase === "waiting" && (r.wait?.on === "background" || r.wait?.on === "job" || r.wait?.on === "wakeup");

// The header's two counts: lanes working now, and lanes waiting on their own work.
export function runCounts(runs: Iterable<Run>): { working: number; ownWork: number } {
  let working = 0, ownWork = 0;
  for (const r of runs) {
    if (r.phase === "working") working++;
    else if (onOwnWork(r)) ownWork++;
  }
  return { working, ownWork };
}

// The card each lane's Run shows on, by task key: one card per lane, the one it is on. Its task in progress (B5: at most
// one); else its open task changed last (after D1 moved it to review, that one; a to do the manager handed it later, that
// one). Its other cards keep a plain avatar, so one lane never looks busy on three cards at once.
export function runCards(tasks: readonly Task[], runs: ReadonlyMap<string, Run>): Map<TaskKey, Run> {
  const pick = new Map<string, Task>();
  for (const t of tasks) {
    if (t.assignee === null || !OPEN.includes(t.status) || !runs.has(t.assignee)) continue;
    const had = pick.get(t.assignee);
    const rank = (x: Task) => [x.status === "doing" ? 1 : 0, x.updatedAt, x.n] as const;
    if (!had || cmp(rank(t), rank(had)) > 0) pick.set(t.assignee, t);
  }
  const out = new Map<TaskKey, Run>();
  for (const [lane, t] of pick) out.set(t.key, runs.get(lane) as Run);
  return out;
}
const cmp = (a: readonly number[], b: readonly number[]) => {
  for (let i = 0; i < a.length; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
};

// Design §7, "Lanes without a task": the Runs working or waiting whose lane has no open task, by lane name, so their
// work is never off the board.
export function lanesWithoutTask(runs: Iterable<Run>, tasks: readonly Task[]): Run[] {
  const busy = new Set(tasks.filter(t => t.assignee !== null && OPEN.includes(t.status)).map(t => t.assignee));
  return [...runs].filter(r => (r.phase === "working" || r.phase === "waiting") && !busy.has(r.lane)).sort((a, b) => (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0));
}
