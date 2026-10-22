// The phone's chat list and status view, in words (ADR-0011): which rows, in which order (H2), what each previews, how
// many messages that matter it holds (H1), and its status in one line (H3). Pure: the feed's state comes in.
import { chatOrder, cutText, laneStatus, statusOf, type LaneStatus, type Message, type RosterEntry, type Run } from "@morndo/domain";
import type { ChatRowWire } from "@morndo/protocol";
import type { DecisionItem } from "../../desktop/decisions.ts";
import { stripButtonsLine, stripMarkers, withoutFileNotes } from "../../desktop/present.ts";
import { onOwnWork } from "../../desktop/run-words.ts";
import { BACKGROUND_LABEL } from "../../lanes.ts";
import { spanLabel } from "../words.ts";
import { ABSENT_MANAGER } from "../../manager.ts";

export const MANAGER = "manager";
export const displayName = (name: string) => (name === MANAGER ? "Manager" : name);

// A message as one plain line: no markers, no STATUS lead, no markdown, the first line of words, at most `max` characters.
export function plain(text: string, max = 120): string {
  const t = statusOf(stripButtonsLine(stripMarkers(withoutFileNotes(text)))).rest;
  const line = t.split("\n").map(l => l
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(^|[^\w\\])(\*{1,3}|_{1,3})([^\s*_].*?[^\s*_]|[^\s*_])\2(?=$|[^\w])/g, "$1$3")
    .replace(/(^|[^\w\\])`([^`\n]+)`(?=$|[^\w])/g, "$1$2")
    .replace(/^[`*_]+/, "")
    .trim()).find(l => l.length > 0) ?? "";
  return line.length > max ? `${cutText(line, max - 1).trimEnd()}…` : line;
}

// What a row previews: "You: …" for his own, the question or file for those, else the words.
export function preview(m: Message | null): string {
  if (!m) return "No messages yet";
  const tap = /^\s*\[tap\s+[A-Za-z0-9_-]{1,32}\]\s+\S+(?:\s+\((.*)\))?\s*$/.exec(m.text);
  if (m.author.kind === "principal") return tap ? `You chose “${tap[1] ?? "an option"}”` : `You: ${plain(m.text) || "sent a file"}`;
  if (m.kind === "question") return `Asks: ${plain(m.text)}`;
  if (m.kind === "file") return `Sent ${m.attachments?.length === 1 ? (m.attachments[0]?.name ?? "a file") : `${m.attachments?.length ?? 0} files`}`;
  if (m.author.kind === "peer") return `${m.author.name}: ${plain(m.text)}`;
  return plain(m.text) || "…";
}

// "14:05" today, "Yesterday", a weekday within the week, else "3 Oct".
export function when(at: number, now: number): string {
  const d = new Date(at), n = new Date(now);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(n) - day(d)) / 86_400_000);
  if (days <= 0) return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString("en-GB", { weekday: "short" });
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export type Status = LaneStatus & { line: string; label: string };
// A lane's status line (H3): "Waits for you: Ship it tonight?", "Working: Running the tests.", "Finished: …", "Blocked: …",
// "Idle: …"; and its short label with since when ("Waits 2 h", "Working 12 min", "Idle since 13:40"). `run`: the lane's Run
// on the board, which keeps a lane that waits on its own background work (R2) working.
export function status(w: RosterEntry, asks: readonly DecisionItem[], answer: Message | null, now: number, repliedAt: number | null = null, run?: Run | null): Status {
  const s = laneStatus({
    state: w.state, changedAt: w.changedAt, needsYou: w.needsYou, answer, repliedAt,
    asks: asks.map(d => ({ title: d.shortTitle ?? d.title, askedAt: d.askedAt })),
  });
  // The manager while it has no window (a restart): not running, whatever its last state said.
  if (w.id === ABSENT_MANAGER) return { kind: "idle", since: w.changedAt, ask: null, answer: null, line: "Not running", label: "Not running" };
  const said = s.answer ? plain(s.answer.text) : "";
  const reported = s.answer && statusOf(s.answer.text).status === "decision";
  const line = s.kind === "waits" ? `Waits for you: ${s.ask ? plain(s.ask) : reported && said ? said : "a prompt on its screen"}`
    : s.kind === "working" ? (said ? `Working: ${said}` : "Working")
    : s.kind === "finished" ? `Finished: ${said}` : s.kind === "blocked" ? `Blocked: ${said}` : said ? `Last said: ${said}` : "Nothing said yet";
  // A lane whose machine doesn't answer stays listed as offline. Only an open decision still says it waits;
  // a stale prompt on its screen does not.
  if (w.offline && !(s.kind === "waits" && s.ask)) return { kind: "idle", since: w.changedAt, ask: null, answer: null, line: "Offline", label: "Offline" };
  // A lane not otherwise at work that waits on its own work still works (R2); one that waits for him, or is blocked, is not
  // moved by its Run.
  if (run && onOwnWork(run) && (s.kind === "idle" || s.kind === "finished")) {
    return { kind: "working", since: run.since, ask: null, answer: s.answer,
      line: said ? `${BACKGROUND_LABEL}: ${said}` : BACKGROUND_LABEL, label: `${BACKGROUND_LABEL} ${spanLabel(now - run.since)}` };
  }
  const span = spanLabel(now - s.since);
  const label = s.kind === "waits" ? `Waits ${span}` : s.kind === "working" ? `Working ${span}` : `${s.kind === "finished" ? "Finished" : s.kind === "blocked" ? "Blocked" : "Idle"} ${when(s.since, now).includes(":") ? `since ${when(s.since, now)}` : when(s.since, now).toLowerCase()}`;
  return { ...s, line, label };
}

export type ChatListRow = {
  worker: string; name: string; display: string; lastAt: number | null; preview: string; unread: number; muted: boolean;
  needsYou: boolean; active: boolean; offline: boolean; status: Status;
};

// The chat list (H2): the manager pinned first, then the newest activity on top. Two panes with one name are two rows
// (each its own conversation on screen); their read mark is shared (O7). A muted lane shows no count.
export function chatRows(o: {
  workers: readonly RosterEntry[]; chats: Readonly<Record<string, ChatRowWire>>; decisions: readonly DecisionItem[]; muted: readonly string[]; now: number;
  managerQueue?: boolean | null;                    // the hub's queue for the manager: what its not-running row says
  runs?: ReadonlyMap<string, Run> | null;           // the board's Runs, by lane name: own-work waits still work (R2)
}): ChatListRow[] {
  const absent = o.managerQueue ? "Not running; what you write waits for it" : "Not running; start it to message it";
  const rows = o.workers.map(w => {
    const c = o.chats[w.id];
    const asks = o.decisions.filter(d => d.status === "open" && d.need === "decision" && d.asker.workerId === w.id);
    const muted = o.muted.includes(w.name);
    const replied = c && "repliedAt" in c ? (c.repliedAt ?? null) : (c?.last?.author.kind === "principal" ? c.last.at : null);
    const st = status(w, asks, c?.answer ?? null, o.now, replied, o.runs?.get(w.name));
    return {
      worker: w.id, name: w.name, display: displayName(w.name), lastAt: c?.lastAt ?? w.lastMessageAt,
      preview: w.id === ABSENT_MANAGER ? absent : c ? preview(c.last) : w.title ?? "", unread: muted ? 0 : c?.unread ?? 0, muted,
      needsYou: st.kind === "waits", active: w.state === "active" && !w.offline, offline: w.offline, status: st,
    };
  });
  return chatOrder(rows, MANAGER);
}

// The Status view (H3): who waits for him first (the oldest wait on top), then who works, then the rest, by name.
export function statusRows(rows: readonly ChatListRow[]): ChatListRow[] {
  const rank = (r: ChatListRow) => (r.status.kind === "waits" ? 0 : r.status.kind === "working" ? 1 : r.status.kind === "blocked" ? 2 : 3);
  return [...rows].sort((a, b) => Number(b.name === MANAGER) - Number(a.name === MANAGER) || rank(a) - rank(b)
    || (rank(a) === 0 ? a.status.since - b.status.since : 0) || a.display.localeCompare(b.display));
}

export const sinceText = (ms: number) => spanLabel(ms);
