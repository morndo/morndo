// A conversation as bubbles (ADR-0011): day separators ("Today", "Yesterday", a date), his messages on the right, the
// lane's on the left, consecutive ones from one author within 3 minutes grouped (Signal's own rule: Signal-Android
// V2ConversationItemShape.kt clusterTimeout = 3.minutes, read 2026-10-05), tool calls folded into one quiet line.
import { cutText, type Message } from "@morndo/domain";

export const CLUSTER_MS = 3 * 60_000;
// Two files in one message can share a name. The key is the message and the place, so the list never collapses them.
export const attachmentKey = (messageId: string, index: number) => `${messageId}:${index}`;
export type Bubble = { kind: "bubble"; m: Message; mine: boolean; first: boolean; last: boolean };
export type Item =
  | { kind: "day"; key: string; label: string }
  | Bubble
  | { kind: "tools"; key: string; count: number; names: string[]; at: number };

export function dayLabel(at: number, now: number): string {
  const day = (t: number) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return new Date(at).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}

const author = (m: Message) => `${m.author.kind}:${m.author.name}`;

export function bubbles(messages: readonly Message[], now: number): Item[] {
  const out: Item[] = [];
  let lastDay = "";
  for (const m of messages) {
    const label = dayLabel(m.at, now);
    if (label !== lastDay) { out.push({ kind: "day", key: `day:${m.at}`, label }); lastDay = label; }
    if (m.kind === "activity") {
      const prev = out.at(-1);
      if (prev?.kind === "tools") { prev.count += m.tools?.length ?? 1; prev.names = [...new Set([...prev.names, ...(m.tools ?? [])])]; }
      else out.push({ kind: "tools", key: `tools:${m.id}`, count: m.tools?.length ?? 1, names: [...new Set(m.tools ?? [])], at: m.at });
      continue;
    }
    const prev = out.at(-1);
    const joins = prev?.kind === "bubble" && author(prev.m) === author(m) && m.at - prev.m.at <= CLUSTER_MS;
    if (joins) prev.last = false;
    out.push({ kind: "bubble", m, mine: m.author.kind === "principal", first: !joins, last: true });
  }
  return out;
}

// An agent's long answer shows its start, with "Show more" (the owner reads on a phone).
export const LONG_CHARS = 900;
export const isLong = (text: string) => text.length > LONG_CHARS || text.split("\n").length > 14;
export function shortened(text: string): string {
  const lines = text.split("\n").slice(0, 14).join("\n");
  const cut = cutText(lines, LONG_CHARS);
  const end = cut.lastIndexOf("\n\n") > LONG_CHARS / 2 ? cut.lastIndexOf("\n\n") : cut.length;
  return `${cut.slice(0, end).trimEnd()}…`;
}
