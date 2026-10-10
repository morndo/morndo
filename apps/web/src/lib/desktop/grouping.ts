// Turns a conversation into Slack-style rows: day dividers, message groups (same author within 5 minutes share one
// header), and, for agents, runs of tool use folded into one activity line.
import type { Message } from "@morndo/domain";

export type Row =
  | { kind: "day"; key: string; label: string }
  | { kind: "msg"; key: string; message: Message; head: boolean }
  | { kind: "activity"; key: string; at: number; tools: { name: string; count: number }[] }
  | { kind: "event"; key: string; message: Message };

const GROUP_MS = 5 * 60_000;

export function dayLabel(at: number, now = Date.now()): string {
  const d = new Date(at), t = new Date(now);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(t) - day(d)) / 86_400_000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", ...(d.getFullYear() !== t.getFullYear() ? { year: "numeric" } : {}) });
}

export function toRows(messages: Message[], now = Date.now()): Row[] {
  const rows: Row[] = [];
  let lastDay = "";
  let lastHead: Message | null = null;                   // the message whose header the next one may share
  for (const m of messages) {
    const day = new Date(m.at).toDateString();
    if (day !== lastDay) {
      rows.push({ kind: "day", key: `day-${day}`, label: dayLabel(m.at, now) });
      lastDay = day;
      lastHead = null;
    }
    if (m.kind === "activity") {
      const prev = rows.at(-1);
      const name = m.tools?.[0] ?? m.text;
      if (prev?.kind === "activity") {
        const t = prev.tools.find(x => x.name === name);
        if (t) t.count++;
        else prev.tools.push({ name, count: 1 });
      } else {
        rows.push({ kind: "activity", key: `act-${m.id}`, at: m.at, tools: [{ name, count: 1 }] });
      }
      continue;
    }
    if (m.kind === "event") {
      rows.push({ kind: "event", key: m.id, message: m });
      lastHead = null;
      continue;
    }
    const sameAuthor = lastHead && lastHead.author.name === m.author.name && lastHead.author.kind === m.author.kind && m.at - lastHead.at < GROUP_MS;
    const head = !sameAuthor || m.kind === "question";
    rows.push({ kind: "msg", key: m.id, message: m, head });
    if (head) lastHead = m;
  }
  return rows;
}

export const clock = (at: number) => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
