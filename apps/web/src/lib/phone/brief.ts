// How one item reads on the phone, and which buttons it gets. Timeline text must stay short enough to read. Pure. An item reads as:
// - a short title on one line: the list's own title, or the first clause of its text (at most 60 characters);
// - one plain sentence: the list's summary, or none;
// - a meta line: decision or how long a task takes, what it blocks, when it is due;
// - everything else behind "More": the long text, the details, a link, what happens without an answer.
// Never the raw text as the headline.
import type { DecisionItem } from "../desktop/decisions.ts";
import { clause } from "@morndo/domain";
import { heroTime } from "./horizon.ts";

export type Brief = {
  title: string;
  sentence: string | null;
  meta: string[];
  more: { text: string | null; link: string | null; ifNoAnswer: string | null; recommendation: string | null };
};

export type Action =
  | { kind: "decide" }                                                // opens the decision's card
  | { kind: "option"; key: string; label: string; recommended: boolean }
  | { kind: "default"; text: string }                                 // "go with the default", for a decision without options
  | { kind: "done" } | { kind: "later" }                              // a task
  | { kind: "words" };                                                // "Answer in my own words"

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

const httpLink = (s: string | null) => (s && /^https?:\/\//i.test(s) ? s : null);

// "due 16:00", "due tomorrow"; once its time has passed (as Horizon's overdue: at or before now), "overdue since 08:00"
// or "overdue since Sat", in words and not only in colour.
export function due(at: number, now: number): string {
  const t = heroTime(at, now);
  const when = t === "Tomorrow" || t === "Today" ? t.toLowerCase() : t;
  return at <= now ? `overdue since ${when}` : `due ${when}`;
}

export function brief(d: DecisionItem, now: number): Brief {
  // A short form of whitespace only is no short form (ADR-0023 §4.4, as the domain's compact card): the title's
  // first clause takes over, never a blank row.
  const own = d.shortTitle?.trim() ? oneLine(d.shortTitle) : null;
  const c = own ? null : clause(d.title);
  const title = own ?? c?.title ?? d.title;
  const sentence = d.summary?.trim() ? oneLine(d.summary) : null;
  // The long text behind More: all of it when the list gave a title, else what the title left out; never a repeat.
  const long = own ? (oneLine(d.title) === own || oneLine(d.title) === sentence ? null : d.title.trim()) : c?.rest ?? null;
  const text = [long, d.details?.trim() || null].filter((x): x is string => !!x).join("\n\n") || null;
  const meta = [
    d.need === "decision" ? "Decision" : null,
    d.minutes ? `≈${d.minutes} min` : null,
    d.need === "time" ? "only you" : null,
    d.blocking ? `blocks ${d.project ?? "work"}` : null,
    d.deadline !== null ? due(d.deadline, now) : null,
  ].filter((x): x is string => x !== null);
  return { title, sentence, meta, more: { text, link: httpLink(d.link), ifNoAnswer: d.ifNoAnswer, recommendation: d.recommendation } };
}

// The buttons, where they show: a row on the dashboard (Today) or a decision's card (catch-up). A decision's row opens
// its card; a task is never "decided": Done and Later, or its own options. His own words are always one button away.
export function actions(d: DecisionItem, where: "row" | "card"): Action[] {
  if (d.status !== "open") return [];
  if (d.need === "decision" && where === "row") return [{ kind: "decide" }];
  if (d.answerBy === "screen") return [];
  const options: Action[] = d.answerBy === "tap" ? d.options.map((o, i) => ({ kind: "option", key: o.key, label: o.label, recommended: i === 0 })) : [];
  if (d.need === "time") return [...(options.length ? options : [{ kind: "done" } as const]), { kind: "later" }, { kind: "words" }];
  if (!options.length && d.ifNoAnswer) return [{ kind: "default", text: d.ifNoAnswer }, { kind: "words" }];
  return [...options, { kind: "words" }];
}
