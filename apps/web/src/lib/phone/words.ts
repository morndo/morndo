// How catch-up says things (ADR-0009): an update's headline from the agent's latest answer, and short spans of time.
import { statusOf, type Message } from "@morndo/domain";
import { stripButtonsLine, stripMarkers } from "../desktop/present.ts";

// The agent's latest answer in one sentence: its first line of words, without markers, its STATUS lead or markdown;
// at most 140 characters. Null when the new messages hold no answer of the agent's.
export function headline(messages: readonly Message[]): string | null {
  const m = messages.findLast(x => x.author.kind === "agent" && x.kind === "text" && x.text.trim());
  if (!m) return null;
  const text = statusOf(stripButtonsLine(stripMarkers(m.text))).rest;
  const line = text.split("\n").map(l => l.replace(/^[#>\-*\s]+|[*_`]+/g, "").trim()).find(l => l.length > 0) ?? "";
  const sentence = /^(.+?[.!?])(\s|$)/.exec(line)?.[1] ?? line;
  if (!sentence) return null;
  return sentence.length > 140 ? `${sentence.slice(0, 139).trimEnd()}…` : sentence;
}

// "38 min", "2 h 14 min", "3 days".
export function spanLabel(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return "under a minute";
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) { const h = Math.floor(min / 60), m = min % 60; return m ? `${h} h ${m} min` : `${h} h`; }
  return `${Math.round(min / 1440)} days`;
}

// The update's kicker: since when it is new.
export const sinceLabel = (mark: number | null, now: number) => (mark === null ? "never read here" : `since you looked ${spanLabel(now - mark)} ago`);

// How long a run took: "1 min 48 s", "35 s".
export function tookLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${s % 60} s` : spanLabel(ms);
}
