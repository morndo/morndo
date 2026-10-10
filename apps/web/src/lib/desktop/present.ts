// How a conversation is shown (ADR-0006, per-conversation settings). "clean" is the default: control markers that
// agents and tools put at the start of a message for machines ("[quiet]", "[lane-event]", "[tap 3]") are dropped,
// and system plumbing (lane events, background-task notes, compaction) is hidden. "verbose" shows everything as written.
import type { Message } from "@morndo/domain";

export type ShowMode = "clean" | "verbose";
export type ConversationPrefs = { show: ShowMode; activity: boolean; muted: boolean; starred: boolean };
export const DEFAULT_PREFS: ConversationPrefs = { show: "clean", activity: true, muted: false, starred: false };

// A leading [word] or [word detail], not a markdown link ("[text](url)") and not a one-letter checkbox ("[x]").
const MARKER = /^\s*\[[a-z][a-z0-9_-]{1,30}(?:[ :][^\]\n]{0,40})?\](?!\()[ \t]*\n?/i;

export function stripMarkers(text: string): string {
  let t = text;
  for (let i = 0; i < 5; i++) {
    const m = MARKER.exec(t);
    if (!m) break;
    t = t.slice(m[0].length);
  }
  return t.trimStart();
}

// The manager's buttons line ("[buttons <id>] key=Label | …") at the end of an answer: the app shows real buttons.
const BUTTONS_LINE = /\n?[ \t]*\[buttons\s+[A-Za-z0-9_-]{1,32}\][^\n]*\s*$/i;
export const stripButtonsLine = (text: string) => text.replace(BUTTONS_LINE, "").trimEnd();
// The chat bot's note for a file the principal attached: the app shows the file itself.
const OWNER_FILE = /\n*\[The owner attached a file: [^\]\n]+\]/g;
export const withoutFileNotes = (text: string) => text.replace(OWNER_FILE, "").trim();
// The principal's tap, as the chat bot or this app typed it ("[tap <id>] <key> (<Label>)"): shown as what he chose.
const TAP = /^\s*\[tap\s+([A-Za-z0-9_-]{1,32})\]\s+[A-Za-z0-9_-]{1,16}(?:\s+\((.*)\))?\s*$/;

export function present(messages: Message[], prefs: Pick<ConversationPrefs, "show" | "activity">): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    if (m.kind === "activity" && !prefs.activity) continue;
    if (prefs.show === "verbose") { out.push(m); continue; }
    if (m.kind === "event" && m.author.kind === "system") continue;
    const tap = m.author.kind === "principal" && m.kind === "text" ? TAP.exec(m.text) : null;
    if (tap) { out.push({ ...m, kind: "event", text: `chose “${tap[2] ?? "an option"}” · ${tap[1]}` }); continue; }
    if (m.kind === "text" || m.kind === "question") {
      let text = stripButtonsLine(stripMarkers(m.text));
      if (m.author.kind === "principal" && m.attachments?.length) text = text.replace(OWNER_FILE, "").trim();
      if (!text.trim() && m.attachments?.length) { out.push({ ...m, text: "" }); continue; }
      if (!text.trim()) continue;
      out.push(text === m.text ? m : { ...m, text });
    } else {
      out.push(m);
    }
  }
  return out;
}
