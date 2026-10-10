// Background jobs (ADR-0017; docs/design/background-jobs). A job is one command on one node. This module decides
// the states, the queue order, the one notice and who may start while the hub is away. It starts nothing and
// reads nothing: no supervisor, no file, no socket, no clock. Callers pass `at` and `now`.
import { err, ok, type Result } from "./shared.ts";
import { COMMENT_MAX, LANE_NAME, parseTaskKey, type TaskKey } from "./board.ts";

export const JOB_OUTCOMES = ["exited", "timed_out", "cancelled", "lost", "refused"] as const;
export type JobOutcome = (typeof JOB_OUTCOMES)[number];
export const JOB_STATES = ["queued", "starting", "running", ...JOB_OUTCOMES] as const;
export type JobState = (typeof JOB_STATES)[number];
export const QUEUE_REASONS = ["class", "load", "memory", "guard_unknown"] as const;
export type QueueReason = (typeof QUEUE_REASONS)[number];
export const NOTICE_STATES = ["none", "pending", "queued", "typed", "held", "delivered", "uncertain", "given_up", "commented"] as const;
export type NoticeState = (typeof NOTICE_STATES)[number];

// Which notice may follow which. Order in NOTICE_STATES is not a rank: uncertain can still be confirmed delivered,
// and a delivered notice does not become uncertain or given up.
const NOTICE_MOVES: Readonly<Record<NoticeState, readonly NoticeState[]>> = {
  none: ["pending"],
  pending: ["queued", "typed", "commented", "given_up"],
  queued: ["typed", "held", "given_up"],
  typed: ["held", "delivered", "uncertain", "given_up", "commented"],
  held: ["typed", "delivered", "uncertain", "given_up"],
  delivered: ["commented"],
  uncertain: ["delivered"],
  given_up: [],
  commented: [],
};

export function noticeCanMove(from: NoticeState, to: NoticeState): boolean {
  return NOTICE_MOVES[from].includes(to);
}

// A later observation may skip steps the fleet never saw. Legal means reachable forward, not only the next edge.
export function noticeCanReach(from: NoticeState, to: NoticeState): boolean {
  if (from === to) return true;
  const seen = new Set<NoticeState>([from]);
  const queue: NoticeState[] = [from];
  while (queue.length > 0) {
    const cur = queue.pop();
    if (cur === undefined) break;
    for (const next of NOTICE_MOVES[cur]) {
      if (next === to) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return false;
}
// The delivery text cap (protocol maxSendText). The notice is cut to this after redaction.
export const NOTICE_MAX = 8000;
export const NOTICE_LINES = 40;
export const NOTICE_LINE_MAX = 200;
// A line is cut to this before any pattern runs, so a long line cannot blow the scan up.
export const NOTICE_SCAN_MAX = 4096;
// A lane's token hash may authorize a start this long after the hub last accepted it.
export const TOKEN_CACHE_MS = 24 * 60 * 60 * 1000;

export const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/;
export const JOB_CLASS = /^[a-z0-9-]{1,32}$/;
// A hash, not a command: no spaces, so a command line cannot be stored in its place.
export const COMMAND_HASH = /^[A-Za-z0-9]{16,128}$/;

export type NotifyTarget =
  | { kind: "lane"; name: string }
  | { kind: "task"; key: TaskKey }
  | { kind: "fleet" };

export type Job = {
  id: string;
  lane: string;
  name: string;
  jobClass: string;
  notify: NotifyTarget;
  commandHash: string;
  cwdHash: string;
  acceptedAt: number;
  state: JobState;
  position: number | null;
  reason: QueueReason | null;
  outcome: JobOutcome | null;
  exitCode: number | null;
  durationMs: number | null;
  notice: NoticeState;
  noticeId: string | null;
  error: "did_not_start" | null;
  startedAt: number | null;
  endedAt: number | null;
};

export type StartBody = {
  id: string;
  lane: string;
  name: string;
  jobClass: string;
  notify: NotifyTarget;
  commandHash: string;
  cwdHash: string;
};

export type StartProblem = "bad_id" | "bad_lane" | "bad_name" | "bad_class" | "bad_notify" | "bad_hash" | "id_conflict";

export type FinishEvent =
  | { outcome: "exited"; exitCode: number | null; durationMs: number; error?: "did_not_start" | null }
  | { outcome: "timed_out" | "cancelled"; exitCode: number | null; durationMs: number }
  | { outcome: "lost"; at: number }
  | { outcome: "refused" };

export type FinishProblem = "not_running" | "already_terminal" | "bad_exit";

export type Guard = "off" | "load" | "memory" | "unknown";
export type Schedule = { jobs: Job[]; refused: readonly string[] };

export type TokenCache = { lane: string; hash: string; checkedAt: number };
export type TokenDecision =
  | { reachable: true; allowed: boolean }
  | { reachable: false; lane: string; hash: string; cache: TokenCache | null; now: number };

export type NoticeInput = {
  name: string;
  outcome: JobOutcome;
  id: string;
  jobClass: string;
  exitCode: number | null;
  durationMs: number;
  logPath: string;
  home: string;
  lines: readonly string[];
  error: "did_not_start" | null;
};

// What the fleet is allowed to hold (J1, J6). No command, no working directory, no environment.
export type FleetJob = {
  v: 1;
  t: "job";
  id: string;
  node: string;
  lane: string;
  name: string;
  class: string;
  state: JobState;
  outcome: JobOutcome | null;
  exit: number | null;
  durationSec: number | null;
  notify: NotifyTarget;
  task: TaskKey | null;
  notice: NoticeState;
  at: number;
  ended: number | null;
  tail: string;
  position: number | null;
  reason: QueueReason | null;
  error: "did_not_start" | null;
};

export const noticeIdOf = (id: string) => `node:job:${id}:done`;

const sameNotify = (a: NotifyTarget, b: NotifyTarget): boolean => {
  if (a.kind !== b.kind) return false;
  if (a.kind === "lane" && b.kind === "lane") return a.name === b.name;
  if (a.kind === "task" && b.kind === "task") return a.key === b.key;
  return a.kind === "fleet";
};

const notifyOf = (n: NotifyTarget): NotifyTarget | null => {
  if (n.kind === "fleet") return n;
  if (n.kind === "lane") return LANE_NAME.test(n.name) ? { kind: "lane", name: n.name } : null;
  const key = parseTaskKey(n.key);
  return key ? { kind: "task", key } : null;
};

const hasControl = (name: string): boolean => {
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
};
const cleanName = (name: string): string | null => {
  if (hasControl(name)) return null;
  const t = name.trim();
  return t && t.length <= 64 ? t : null;
};

// J3's id, and J2's idempotent start: the same id and body is the job already stored. A different body, or the same
// id from another lane, is a conflict and starts nothing. The body is the lane, the command hash, the directory
// hash, the class and the notify target.
export function acceptJob(existing: Job | null, body: StartBody, at: number): Result<Job, StartProblem> {
  if (!JOB_ID.test(body.id)) return err("bad_id");
  if (!LANE_NAME.test(body.lane)) return err("bad_lane");
  const name = cleanName(body.name);
  if (!name) return err("bad_name");
  if (!JOB_CLASS.test(body.jobClass)) return err("bad_class");
  const notify = notifyOf(body.notify);
  if (!notify) return err("bad_notify");
  if (!COMMAND_HASH.test(body.commandHash) || !COMMAND_HASH.test(body.cwdHash)) return err("bad_hash");
  if (existing) {
    const same = existing.lane === body.lane && existing.commandHash === body.commandHash && existing.cwdHash === body.cwdHash
      && existing.jobClass === body.jobClass && sameNotify(existing.notify, notify);
    return same ? ok(existing) : err("id_conflict");
  }
  return ok({
    id: body.id, lane: body.lane, name, jobClass: body.jobClass, notify, commandHash: body.commandHash, cwdHash: body.cwdHash,
    acceptedAt: at, state: "queued", position: null, reason: null, outcome: null, exitCode: null, durationMs: null,
    notice: "none", noticeId: null, error: null, startedAt: null, endedAt: null,
  });
}

const open = (state: JobState) => state === "queued" || state === "starting" || state === "running";
const terminal = (state: JobState): state is JobOutcome => !open(state);

const exitOk = (code: number | null) => code === null || (Number.isInteger(code) && code >= 0 && code <= 255);
const durationOk = (ms: number) => Number.isInteger(ms) && ms >= 0;

// A start that never began. The stored row drops the event's exit and duration, so a replay matches on this
// fact rather than on those numbers.
const neverRan = (job: Job, event: FinishEvent): boolean =>
  event.outcome === "exited" && (event.error ?? null) === "did_not_start"
  && (job.state === "starting" || (job.state === "exited" && job.error === "did_not_start" && job.startedAt === null));

// J2, J4: one terminal outcome. The same outcome again is the same job. A different one is refused. `lost` is a
// running job whose exit was never recorded, and it still gets a notice. A queued job can be cancelled, not lost.
export function finish(job: Job, event: FinishEvent): Result<Job, FinishProblem> {
  if (event.outcome === "exited" && neverRan(job, event)) {
    if (!exitOk(event.exitCode) || !durationOk(event.durationMs)) return err("bad_exit");
    return job.state === "starting" ? ok(ended(job, event)) : ok(job);
  }
  if (terminal(job.state)) {
    if (event.outcome !== job.outcome) return err("already_terminal");
    if (event.outcome === "lost" || event.outcome === "refused") return ok(job);
    if (event.outcome === "cancelled" && job.startedAt === null) return ok(job);
    if (event.exitCode !== job.exitCode || event.durationMs !== job.durationMs) return err("already_terminal");
    if (event.outcome === "exited" && (event.error ?? null) !== job.error) return err("already_terminal");
    return ok(job);
  }
  if (event.outcome === "refused") return job.state === "queued" ? ok(ended(job, event)) : err("not_running");
  if (event.outcome === "lost") {
    if (job.state !== "running" && job.state !== "starting") return err("not_running");
    if (!Number.isInteger(event.at) || (job.startedAt !== null && !Number.isInteger(job.startedAt))) return err("bad_exit");
    return ok(ended(job, event));
  }
  if (event.outcome !== "cancelled" && job.state !== "running") return err("not_running");
  if (!exitOk(event.exitCode) || !durationOk(event.durationMs)) return err("bad_exit");
  return ok(ended(job, event));
}

function ended(job: Job, event: FinishEvent): Job {
  const fromQueue = (event.outcome === "cancelled" || event.outcome === "refused") && job.state === "queued";
  const dropped = neverRan(job, event);
  const exitCode = event.outcome === "lost" || event.outcome === "refused" || fromQueue || dropped ? null : event.exitCode;
  const durationMs = event.outcome === "lost" ? Math.max(0, event.at - (job.startedAt ?? event.at)) : fromQueue || event.outcome === "refused" || dropped ? 0 : event.durationMs;
  const error = event.outcome === "exited" ? (event.error ?? null) : null;
  return {
    ...job, state: event.outcome, outcome: event.outcome, exitCode, durationMs, error,
    position: null, reason: null, notice: "pending", noticeId: noticeIdOf(job.id),
  };
}

const ownLimit = (limits: Readonly<Record<string, number>>, jobClass: string): number | null => {
  if (!Object.hasOwn(limits, jobClass)) return null;
  const limit = limits[jobClass];
  return typeof limit === "number" && Number.isFinite(limit) ? limit : null;
};

// J5: each class runs at most its limit, in the order accepted. A free slot is `starting`, with no start time, until
// work has begun. A full class queues with `class`. A guard queues with its own reason and
// does not stop a job that is already running. `off` means the guard is not configured. A class that is not an own
// property of the policy is terminal `refused`, with a notice. It is not left queued.
export function schedule(jobs: readonly Job[], limits: Readonly<Record<string, number>>, guard: Guard): Schedule {
  const queuedOf = new Map<string, Job[]>();
  const runningOf = new Map<string, number>();
  for (const job of jobs) {
    if (job.state === "running" || job.state === "starting") {
      runningOf.set(job.jobClass, (runningOf.get(job.jobClass) ?? 0) + 1);
      continue;
    }
    if (job.state !== "queued") continue;
    const list = queuedOf.get(job.jobClass) ?? [];
    list.push(job);
    queuedOf.set(job.jobClass, list);
  }
  const updates = new Map<string, Job>();
  const refused: string[] = [];
  for (const [jobClass, queued] of queuedOf) {
    const limit = ownLimit(limits, jobClass);
    if (limit === null) {
      for (const job of queued) {
        refused.push(job.id);
        const done = finish(job, { outcome: "refused" });
        if (done.ok) updates.set(job.id, done.value);
      }
      continue;
    }
    let slots = Math.max(0, limit - (runningOf.get(jobClass) ?? 0));
    const blocking = guard === "load" || guard === "memory" || guard === "unknown";
    const reason: QueueReason = slots === 0 ? "class" : guard === "unknown" ? "guard_unknown" : guard === "off" ? "class" : guard;
    queued.sort((a, b) => a.acceptedAt - b.acceptedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let position = 1;
    for (const job of queued) {
      if (slots > 0 && !blocking) {
        slots -= 1;
        updates.set(job.id, { ...job, state: "starting", position: null, reason: null, startedAt: null, endedAt: null });
      } else {
        updates.set(job.id, { ...job, position: position++, reason });
      }
    }
  }
  return { jobs: jobs.map(job => updates.get(job.id) ?? job), refused };
}

// A secret name is a whole key, or one `_` / `-` / `.` segment of a key: password, credential, secret, token,
// auth, pass, key. A longer word that merely contains one of those (passed, author, monkey, keyboard) is not.
const SECRET_WORDS = new Set(["password", "credential", "secret", "token", "auth", "pass", "key"]);

const isWord = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isName = (c: number) => isWord(c) || c === 45 || c === 46;

function secretName(name: string): boolean {
  let start = 0;
  for (let i = 0; i <= name.length; i++) {
    const c = name.charCodeAt(i);
    if (i === name.length || c === 95 || c === 45 || c === 46) {
      if (SECRET_WORDS.has(name.slice(start, i).toLowerCase())) return true;
      start = i + 1;
    }
  }
  return false;
}

// The value of an assignment: a quoted string, or the rest of the line when it is bare. One forward scan.
function readValue(text: string, at: number): number {
  const q = text.charCodeAt(at);
  if (q === 34 || q === 39) {
    for (let i = at + 1; i < text.length; i++) if (text.charCodeAt(i) === q || text.charCodeAt(i) === 10) return i + (text.charCodeAt(i) === q ? 1 : 0);
    return text.length;
  }
  let i = at;
  while (i < text.length && text.charCodeAt(i) !== 10) i++;
  return i;
}

function akiaAt(text: string, i: number): boolean {
  if (i > 0 && isWord(text.charCodeAt(i - 1))) return false;
  if (text.slice(i, i + 4) !== "AKIA") return false;
  const end = i + 20;
  if (end > text.length || isWord(text.charCodeAt(end))) return false;
  for (let j = i + 4; j < end; j++) {
    const c = text.charCodeAt(j);
    if (!((c >= 48 && c <= 57) || (c >= 65 && c <= 90))) return false;
  }
  return true;
}

// Quoted JSON keys (`"password": "x"`, `"access_token":"x"`) and bare `name=value` / `name: value`, when the name
// itself is a secret key. One pass, no regex, so a long line cannot backtrack.
export function redactJobOutput(text: string): string {
  if (text.length > NOTICE_SCAN_MAX) text = text.slice(0, NOTICE_SCAN_MAX);
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (akiaAt(text, i)) {
      out += "[redacted]";
      i += 20;
      continue;
    }
    const q = text.charCodeAt(i);
    if ((q === 34 || q === 39) && (i === 0 || !isName(text.charCodeAt(i - 1)))) {
      let j = i + 1;
      while (j < text.length && isName(text.charCodeAt(j))) j++;
      if (j > i + 1 && text.charCodeAt(j) === q && secretName(text.slice(i + 1, j))) {
        let k = j + 1;
        while (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9) k++;
        if (text.charCodeAt(k) === 58) {
          k++;
          while (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9) k++;
          if (k < text.length && text.charCodeAt(k) !== 10) {
            out += text.slice(i, k) + "[redacted]";
            i = readValue(text, k);
            continue;
          }
        }
      }
    }
    if (isName(q) && (i === 0 || !isName(text.charCodeAt(i - 1)))) {
      let j = i + 1;
      while (j < text.length && isName(text.charCodeAt(j))) j++;
      const name = text.slice(i, j);
      let k = j;
      while (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9) k++;
      const sep = text.charCodeAt(k);
      if (secretName(name) && (sep === 61 || sep === 58)) {
        k++;
        while (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9) k++;
        if (k < text.length && text.charCodeAt(k) !== 10) {
          out += text.slice(i, k) + "[redacted]";
          i = readValue(text, k);
          continue;
        }
      }
      out += name;
      i = j;
      continue;
    }
    out += text[i];
    i++;
  }
  return out;
}

const heading = (n: NoticeInput): string => {
  const exit = n.exitCode === null ? "-" : String(n.exitCode);
  const duration = (Math.round(n.durationMs / 100) / 10).toFixed(1);
  const lines = [
    `[morndo-job] ${n.name} ${n.outcome}`,
    `id: ${n.id}`,
    `class: ${n.jobClass}`,
    `exit: ${exit}`,
    `duration: ${duration}`,
    `log: ${n.logPath}`,
  ];
  if (n.error === "did_not_start") lines.push("error: did_not_start");
  return `${lines.join("\n")}\n---`;
};

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]+-----/;
const PEM_END = /-----END [A-Z0-9 ]+-----/;
// A key body is one base64 line long enough to be part of a block. `+` or padding marks it; a slash path has neither.
const keyBody = (line: string) => /^[A-Za-z0-9+/]{16,}={0,2}$/.test(line) && /[+=]/.test(line);

// Secret lines are decided on the whole log, before any tail is cut: a PEM span, a lone BEGIN or END line, or a
// base64 key body whose armor line is already gone.
function secretLines(lines: readonly string[]): boolean[] {
  const secret = lines.map(() => false);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!PEM_BEGIN.test(line)) continue;
    let endAt = -1;
    for (let j = i + 1; j < lines.length; j++) if (PEM_END.test(lines[j] ?? "")) { endAt = j; break; }
    if (endAt === -1) continue;
    for (let j = i; j <= endAt; j++) secret[j] = true;
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (PEM_BEGIN.test(line) || PEM_END.test(line) || keyBody(line)) secret[i] = true;
  }
  return secret;
}

function preparedLines(lines: readonly string[]): string[] {
  const raw = lines.flatMap(line => plain(line).split("\n")).map(line => line.length > NOTICE_SCAN_MAX ? line.slice(0, NOTICE_SCAN_MAX) : line);
  const secret = secretLines(raw);
  return raw.map((line, i) => secret[i] ? "[redacted]" : redactJobOutput(line));
}

const clipLine = (line: string) => line.length > NOTICE_LINE_MAX ? line.slice(0, NOTICE_LINE_MAX) : line;

// The shared redactor has already run. Some of its replacements are longer than the text they hide, so the size
// cap is applied here, by dropping the oldest tail lines. The newest line stays.
function fitNotice(text: string): string {
  const parts = text.split("\n");
  const mark = parts.indexOf("---");
  const head = mark === -1 ? parts : parts.slice(0, mark + 1);
  let tail = mark === -1 ? [] : parts.slice(mark + 1);
  let dropped = false;
  if (tail.length > NOTICE_LINES) {
    tail = tail.slice(-NOTICE_LINES);
    dropped = true;
  }
  const render = (): string => {
    const shown = tail.map((line, i) => {
      const clipped = clipLine(line);
      return dropped && i === 0 ? `[truncated] ${clipped}` : clipped;
    });
    return [...head.map(clipLine), ...shown].join("\n");
  };
  for (;;) {
    const shown = tail.map((line, i) => dropped && i === 0 ? `[truncated] ${line}` : line);
    if ([...head, ...shown].join("\n").length <= NOTICE_MAX) return render();
    if (tail.length === 0) {
      const body = render();
      return body.length <= NOTICE_MAX ? body : body.slice(0, NOTICE_MAX);
    }
    tail = tail.slice(1);
    dropped = true;
  }
}

// J6: job secrets and the shared redactor both run on the uncapped line. The 200-character cut and the delivery
// cap happen after that, so a home path or a tailnet name on the cut cannot leak a prefix, and a longer
// replacement cannot push the newest line off the end.
// A frame's text: controls are gone, and a suffix such as the pool note still leaves the field within NOTICE_MAX.
export function boundNotice(text: string, suffix?: string): string {
  const clean = plain(text);
  const next = !suffix || clean.includes(suffix)
    ? clean
    : (clean.includes("\n---") ? clean.replace("\n---", `\n${suffix}\n---`) : `${clean}\n${suffix}`);
  return fitBound(next);
}

// Drop oldest log lines, the ones after the footer. The footer, a suffix, and the newest lines stay.
function fitBound(text: string): string {
  if (text.length <= NOTICE_MAX) return text;
  const parts = text.split("\n");
  const mark = parts.indexOf("---");
  if (mark === -1) return text.slice(text.length - NOTICE_MAX);
  let head = parts.slice(0, mark + 1);
  let tail = parts.slice(mark + 1);
  const joined = () => [...head, ...tail].join("\n");
  while (tail.length > 1 && joined().length > NOTICE_MAX) tail = tail.slice(1);
  while (head.length > 1 && joined().length > NOTICE_MAX) head = head.slice(1);
  const body = joined();
  return body.length <= NOTICE_MAX ? body : body.slice(body.length - NOTICE_MAX);
}

export function noticeText(input: NoticeInput, redact: (text: string, home: string) => string): string {
  const lines = preparedLines(input.lines).slice(-NOTICE_LINES);
  const title = plain(heading(input));
  const body = `${title}${lines.length ? `\n${lines.join("\n")}` : ""}`;
  return fitNotice(redact(body, input.home));
}

// CSI runs to its final byte (0x40-0x7e). OSC runs to BEL, ST (ESC \ or U+009C), or the end of the text.
function consumeCsi(text: string, i: number): number {
  while (i < text.length) {
    const d = text.charCodeAt(i);
    if (d >= 0x40 && d <= 0x7e) return i;
    i++;
  }
  return text.length;
}

function consumeOsc(text: string, i: number): number {
  while (i < text.length) {
    const d = text.charCodeAt(i);
    if (d === 0x07 || d === 0x9c) return i;
    if (d === 0x1b && text.charCodeAt(i + 1) === 0x5c) return i + 1;
    i++;
  }
  return text.length;
}

// Controls other than newline and tab never reach a notice. That includes an OSC payload and the 8-bit C1
// controls U+0080-U+009F, not only a 7-bit CSI sequence.
function plain(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x1b) {
      const next = text.charCodeAt(i + 1);
      if (next === 0x5b) i = consumeCsi(text, i + 2);
      else if (next === 0x5d) i = consumeOsc(text, i + 2);
      else if (next >= 0x40 && next <= 0x5f) i += 1;
      continue;
    }
    if (c === 0x9b) { i = consumeCsi(text, i + 1); continue; }
    if (c === 0x9d) { i = consumeOsc(text, i + 1); continue; }
    if (c >= 0x80 && c <= 0x9f) continue;
    if (c === 0x09 || c === 0x0a || (c >= 0x20 && c !== 0x7f)) out += text[i];
  }
  return out;
}

// A board comment is at most COMMENT_MAX and refuses control characters. Drop tail lines until it fits.
function fitComment(raw: string): string {
  const clean = plain(raw).trim();
  if (clean.length <= COMMENT_MAX) return clean;
  const parts = clean.split("\n");
  const cut = parts.indexOf("---");
  const head = cut === -1 ? [] : parts.slice(0, cut + 1);
  let tail = cut === -1 ? parts.slice() : parts.slice(cut + 1);
  let dropped = false;
  while (tail.length > 0) {
    const shown = dropped ? [`[truncated] ${tail[0] ?? ""}`, ...tail.slice(1)] : tail;
    const body = [...head, ...shown].join("\n");
    if (body.length <= COMMENT_MAX) return body;
    tail = tail.slice(1);
    dropped = true;
  }
  const only = head.join("\n");
  return only.length <= COMMENT_MAX ? only : only.slice(0, COMMENT_MAX);
}

// J7: a task target becomes one comment. It never carries a status, so the board does not move.
export function taskEffect(job: Job, text: string): { task: TaskKey; text: string; status: null } | null {
  return job.notify.kind === "task" ? { task: job.notify.key, text: fitComment(text), status: null } : null;
}

// The hub's comment, from the fleet's row. Only a finished job, and only a task target. The words are the notice.
export function taskNotice(job: { outcome: JobOutcome | null; notify: NotifyTarget; tail: string }): { task: TaskKey; text: string; status: null } | null {
  if (job.outcome === null || job.notify.kind !== "task") return null;
  const text = fitComment(job.tail);
  if (!text) return null;
  return { task: job.notify.key, text, status: null };
}

// A failure the owner should hear about (design §7): a non-zero exit, a timeout, or lost. A zero exit, a cancel,
// and a refusal are not: success is the notice, and a cancel was asked for.
export function jobFailed(job: { outcome: JobOutcome | null; exit: number | null }): boolean {
  if (job.outcome === "timed_out" || job.outcome === "lost") return true;
  return job.outcome === "exited" && job.exit !== null && job.exit !== 0;
}

export type JobCounts = { node: string; running: number; queued: number; failed: number };

// A node clock this far ahead of the receiver is still "now". Further ahead is the receiver's time.
export const ENDED_SKEW_MS = 5 * 60 * 1000;

export function clampEnded(ended: number | null, receivedAt: number, skewMs = ENDED_SKEW_MS): number | null {
  if (ended === null || ended <= receivedAt + skewMs) return ended;
  return receivedAt;
}

// Counts beside a node: running and queued now, and failures whose real end is inside the last day.
// A clock a little ahead still counts. The observation stamp does not.
export function jobCounts(jobs: readonly { node: string; state: JobState; outcome: JobOutcome | null; exit: number | null; ended: number | null }[], now: number, windowMs = 24 * 60 * 60 * 1000): JobCounts[] {
  const byNode = new Map<string, JobCounts>();
  for (const job of jobs) {
    const row = byNode.get(job.node) ?? { node: job.node, running: 0, queued: 0, failed: 0 };
    if (job.state === "running") row.running += 1;
    if (job.state === "queued") row.queued += 1;
    if (jobFailed(job) && job.ended !== null && job.ended <= now + ENDED_SKEW_MS && now - job.ended <= windowMs) row.failed += 1;
    byNode.set(job.node, row);
  }
  return [...byNode.values()].sort((a, b) => a.node.localeCompare(b.node));
}

// J1: the fleet's copy. No command, no working directory, no environment.
export function fleetRecord(job: Job, extra: { node: string; at: number; tail: string }): FleetJob {
  return {
    v: 1, t: "job", id: job.id, node: extra.node, lane: job.lane, name: job.name, class: job.jobClass,
    state: job.state, outcome: job.outcome, exit: job.exitCode,
    durationSec: job.durationMs === null ? null : Math.round(job.durationMs / 100) / 10,
    notify: job.notify, task: job.notify.kind === "task" ? job.notify.key : null,
    notice: job.notice, at: extra.at, ended: job.endedAt, tail: boundNotice(extra.tail),
    position: job.position, reason: job.reason, error: job.error,
  };
}

// Decision 7: a live answer wins, including a refusal. Offline, the same lane and hash are good for 24 hours from the
// last check the hub accepted. The cache holds the hash only; this function never sees the token.
export function tokenAllows(d: TokenDecision): boolean {
  if (d.reachable) return d.allowed;
  const cache = d.cache;
  if (!cache || cache.lane !== d.lane || cache.hash !== d.hash) return false;
  const age = d.now - cache.checkedAt;
  return age >= 0 && age <= TOKEN_CACHE_MS;
}
