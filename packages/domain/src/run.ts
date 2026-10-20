// Runs context (docs/domain.md "Runs: what each lane is doing now"; ADR-0032): one lane's current activity, derived from
// what the fleet observed, never from the board. deriveRun takes the facts (the lane watch's last turn end and the hooks
// after it, the node's session state, the lane's running jobs, whether its window and node are there) and answers the
// Run, by R7's precedence: gone, unknown, needs you, working, job, background, wake-up, declared, ended. Every wait has a
// deadline (R3) and every Run its source and the time its phase began (R8). Pure: no clock but `now`, no I/O.

export const RUN_PHASES = ["working", "waiting", "needs_you", "ended", "gone", "unknown"] as const;
export type RunPhase = (typeof RUN_PHASES)[number];
export type RunSource = "hook" | "session" | "job" | "status";
export type RunOutcome = "done" | "blocked" | "needs_decision" | "no_status";
// The node's session state for the lane's pane (the session registry: Claude Code's own `busy`, `idle`, `waiting`,
// `shell`), or null: no session there, or an engine that has none.
export type LaneSessionState = "busy" | "idle" | "waiting" | "shell";

// What a turn end left pending (R6): a background task by its type and a short description, a wake-up by its schedule.
export type PendingTask = { type: string; label: string };
export type PendingWake = { schedule: string; recurring: boolean };
export type RunWait =
  | { on: "background"; tasks: PendingTask[] }
  | { on: "wakeup"; next: number | null }
  | { on: "job"; jobs: { id: string; name: string }[] }
  | { on: "declared"; what: string | null };

// The lane's last turn end, as the lane watch keeps it. `until`: a WAITING line's lease (its `for`), if it named one.
export type TurnEnd = {
  at: number;
  status: "done" | "blocked" | "needs_decision" | "waiting" | null;
  line: string;
  tasks: readonly PendingTask[];
  wakes: readonly PendingWake[];
  waitingOn: string | null;
  until: number | null;
};

export type RunFacts = {
  lane: string;
  node: string;
  sessionId?: string;
  nodeOnline: boolean;
  windowAlive: boolean;
  session: LaneSessionState | null;
  turn: TurnEnd | null;
  // The hooks from this lane after its last turn end (or since the fleet started, before any): the first and the latest,
  // by the node's clock. The status line's refresh and the idle notice are not activity (the lane watch's rule).
  activity: { first: number; last: number } | null;
  needsInput: { at: number; question?: string } | null;  // a needs_input after the last turn end, with no answered since
  jobs: readonly { id: string; name: string; startedAt: number }[];  // running jobs whose notice goes to this lane
  waitMs: number;           // the lane watch's waiting lease (laneWatch.waitingMin)
  tzOffsetMin: number | null;  // the node's UTC offset, for its wake-ups' schedules; null: not known, no fire time
  changedAt: number;        // when the window came, went, or its node changed status: the `since` of gone and unknown
  now: number;
};

export type Run = {
  lane: string;
  node: string;
  sessionId?: string;
  phase: RunPhase;
  wait?: RunWait;
  deadline: number | null;
  overdue: boolean;
  outcome?: RunOutcome;
  line?: string;
  question?: string;
  since: number;
  source: RunSource;
};

// Without a hook for this long, a lane with no session state is not called working on its hooks alone: a lane that died
// mid-turn must not look busy for ever (R5's spirit for engines that report no session).
export const ACTIVE_MS = 10 * 60_000;
// A wake-up's grace after its fire time (R3).
export const WAKE_GRACE_MS = 5 * 60_000;
export const LABEL_MAX = 80;
export const PENDING_MAX = 8;

export function deriveRun(f: RunFacts): Run {
  const base = { lane: f.lane, node: f.node, ...(f.sessionId === undefined ? {} : { sessionId: f.sessionId }) };
  const t = f.turn;
  const line = t ? { line: t.line } : {};
  // R5: a window gone from an online node; a node not online says nothing about its lanes.
  if (!f.nodeOnline) return { ...base, phase: "unknown", deadline: null, overdue: false, since: f.changedAt, source: "session", ...line };
  if (!f.windowAlive) return { ...base, phase: "gone", deadline: null, overdue: false, since: f.changedAt, source: "session", ...line };
  if (f.session === "waiting" || f.needsInput) {
    return {
      ...base, phase: "needs_you", deadline: null, overdue: false, ...line,
      ...(f.needsInput?.question ? { question: f.needsInput.question } : {}),
      since: f.needsInput?.at ?? f.activity?.last ?? f.changedAt, source: f.session === "waiting" ? "session" : "hook",
    };
  }
  const after = (at: number | undefined) => at !== undefined && (t === null || at > t.at);
  if (f.session === "busy" || f.session === "shell") {
    return { ...base, phase: "working", deadline: null, overdue: false, since: after(f.activity?.first) ? (f.activity?.first ?? f.now) : (t?.at ?? f.changedAt), source: "session", ...line };
  }
  if (f.session === null && f.activity && after(f.activity.last) && f.now - f.activity.last < ACTIVE_MS) {
    return { ...base, phase: "working", deadline: null, overdue: false, since: f.activity.first, source: "hook", ...line };
  }
  if (f.jobs.length > 0) {
    const jobs = f.jobs.map(j => ({ id: j.id, name: j.name }));
    return { ...base, phase: "waiting", wait: { on: "job", jobs }, deadline: null, overdue: false, since: Math.min(...f.jobs.map(j => j.startedAt)), source: "job", ...line };
  }
  if (t === null) return { ...base, phase: "ended", outcome: "no_status", deadline: null, overdue: false, since: f.changedAt, source: "session" };
  // Activity since the turn end ends a wait's overdue (the lane watch's stale needs "nothing since").
  const quiet = !(f.activity && f.activity.last > t.at);
  const lease = t.until ?? t.at + f.waitMs;
  if (t.tasks.length > 0) {
    return { ...base, phase: "waiting", wait: { on: "background", tasks: [...t.tasks] }, deadline: lease, overdue: quiet && f.now > lease, since: t.at, source: "hook", line: t.line };
  }
  if (t.wakes.length > 0) {
    const fires = t.wakes.map(w => (f.tzOffsetMin === null ? null : nextFire(w.schedule, t.at, f.tzOffsetMin)));
    const known = fires.filter((x): x is number => x !== null);
    const next = known.length > 0 ? Math.min(...known) : null;
    const deadline = next !== null ? next + WAKE_GRACE_MS : lease;
    return { ...base, phase: "waiting", wait: { on: "wakeup", next }, deadline, overdue: quiet && f.now > deadline, since: t.at, source: "hook", line: t.line };
  }
  if (t.status === "waiting") {
    return { ...base, phase: "waiting", wait: { on: "declared", what: t.waitingOn }, deadline: lease, overdue: quiet && f.now > lease, since: t.at, source: "status", line: t.line };
  }
  return { ...base, phase: "ended", outcome: t.status ?? "no_status", deadline: null, overdue: false, since: t.at, source: t.status ? "status" : "hook", line: t.line };
}

// R6: what a turn end's pending lists keep, from the agent CLI's own arrays (Claude Code's Stop `background_tasks` and
// `session_crons`) or the owner's scripts' counts. A task's label is its description, else its type: never its command.
// `redact` is the shared redactor (the protocol's); the domain imports no wire package.
export function pendingOf(tasks: unknown, crons: unknown, redact: (s: string) => string): { tasks: PendingTask[]; wakes: PendingWake[] } {
  const rec = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const word = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
  const outTasks: PendingTask[] = [];
  if (Array.isArray(tasks)) {
    for (const x of tasks.slice(0, PENDING_MAX)) {
      if (!rec(x)) continue;
      const type = word(x.type, 40) || "task";
      const label = clip(redact(word(x.description, 400)), LABEL_MAX) || type;
      outTasks.push({ type, label });
    }
  } else {
    const n = Number.isFinite(Number(tasks)) ? Math.min(PENDING_MAX, Math.max(0, Math.trunc(Number(tasks)))) : 0;
    for (let i = 0; i < n; i++) outTasks.push({ type: "task", label: "background work" });
  }
  const wakes: PendingWake[] = [];
  if (Array.isArray(crons)) {
    for (const x of crons.slice(0, PENDING_MAX)) {
      if (!rec(x)) continue;
      const schedule = word(x.schedule, 100);
      if (schedule) wakes.push({ schedule, recurring: x.recurring === true });
    }
  } else {
    const n = Number.isFinite(Number(crons)) ? Math.min(PENDING_MAX, Math.max(0, Math.trunc(Number(crons)))) : 0;
    for (let i = 0; i < n; i++) wakes.push({ schedule: "", recurring: false });
  }
  return { tasks: outTasks, wakes };
}

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

// The next time a five-field cron schedule (minute hour day-of-month month day-of-week, in the node's local time at UTC
// offset `offsetMin`) fires after `after`, or null when it can't be read or doesn't fire within a year. Fields: `*`, a
// number, `a-b`, `*/n` or `a-b/n`, and lists of those; day-of-week 0 or 7 is Sunday. When both day fields are restricted,
// either may match (cron's own rule). A one-shot wake-up encodes its single fire time this way.
export function nextFire(schedule: string, after: number, offsetMin: number): number | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [mi, ho, dom, mo, dow] = parts as [string, string, string, string, string];
  const minutes = field(mi, 0, 59), hours = field(ho, 0, 23), days = field(dom, 1, 31), months = field(mo, 1, 12), weekdays = field(dow, 0, 7);
  if (!minutes || !hours || !days || !months || !weekdays) return null;
  if (weekdays.has(7)) weekdays.add(0);
  const domAny = dom === "*", dowAny = dow === "*";
  const shift = offsetMin * 60_000;
  // Walk the local clock minute by minute from the next whole minute, skipping whole hours and days that can't match.
  let local = Math.floor((after + shift) / 60_000) * 60_000 + 60_000;
  const end = local + 366 * 86_400_000;
  while (local <= end) {
    const d = new Date(local);
    const dayOk = (() => {
      const a = days.has(d.getUTCDate()), b = weekdays.has(d.getUTCDay());
      if (domAny && dowAny) return true;
      if (domAny) return b;
      if (dowAny) return a;
      return a || b;
    })();
    if (!months.has(d.getUTCMonth() + 1) || !dayOk) {
      local = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
      continue;
    }
    if (!hours.has(d.getUTCHours())) { local = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1); continue; }
    if (minutes.has(d.getUTCMinutes())) return local - shift;
    local += 60_000;
  }
  return null;
}

function field(spec: string, lo: number, hi: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) return null;
    let a = lo, b = hi;
    if (m[1] !== "*") {
      const [x, y] = (m[1] as string).split("-").map(Number) as [number, number | undefined];
      a = x; b = y ?? (m[2] === undefined ? x : hi);
    }
    if (a < lo || b > hi || a > b) return null;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}
