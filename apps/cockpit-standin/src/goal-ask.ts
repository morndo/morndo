// Reads a goal change out of a sentence. The grammar is closed: a sentence is tokenised, a few sentence shapes per field
// (budget, target or goal, deadline, priority, guardrail) are tried against all of its tokens, and a shape only counts when
// it consumes every token. One left-over word, a second number, a second topic where the shape has one, a word like not,
// unless, instead or except, a leading clause: no proposal. The caller then keeps the message and asks what is missing.
//
// Pure: the text, the facts of the topics the reader may see, the chat's topic and the clock go in; a typed proposal or
// null comes out.
import type { MeasuredValue } from "@morndo/cockpit-api";

export type Money = { amountMinor: number; currency: string };
export type GuardrailFact = { id: string; what: string; limit: MeasuredValue };
export type TopicFact = {
  id: string;
  name: string;
  rank: number | null;
  cap: Money | null;
  goal: { target: number; unit: string; deadlineAt: string | null; guardrails: GuardrailFact[] } | null;
};
export type GoalAsk = {
  topicId: string;
  field: "target" | "deadline" | "unit" | "budget" | "priority" | "guardrail";
  from: number;
  to: number;
  deadlineAt: string | null;
  unit: string | null;
  budget: { from: Money; to: Money; period: string | null } | null;
  priority: { from: number | null; to: number } | null;
  guardrail: { guardrailId: string; name: string; from: MeasuredValue; to: MeasuredValue } | null;
};

/** The number a measured value carries: minor units of money, a count, percentage points. */
export function measuredNumber(value: MeasuredValue | null | undefined): number | undefined {
  if (!value) return undefined;
  if (value.kind === "count") return value.value;
  if (value.kind === "money") return value.money.amountMinor;
  if (value.kind === "rate") return value.percent;
  return undefined;
}

/** "8,000", "8.000", "12.500,50" and "1.5" as numbers: groups of three are thousands, anything else after the last mark is decimals. */
export function amountOf(digits: string): number {
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(digits)) return Number(digits.replace(/[.,]/g, ""));
  const mark = Math.max(digits.lastIndexOf("."), digits.lastIndexOf(","));
  if (mark < 0) return Number(digits);
  return Number(`${digits.slice(0, mark).replace(/[.,]/g, "")}.${digits.slice(mark + 1)}`);
}

// ---- tokens

type Tok = { k: "w" | "n" | "c" | "%" | "o" | "i" | "p"; s: string; raw: string; v: number; plain: boolean; mult: boolean };

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_SHORT: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6 };
const CURRENCY = new Set(["eur", "euro", "euros"]);

function tokenize(text: string): Tok[] {
  const source = text.normalize("NFKC").replace(/[‘’]/g, "'")
    .replace(/\bno\.\s*(?=\d)/gi, "number ")
    .replace(/(?<![\d.,])(\d{1,3})((?: \d{3})+)(?!\d)/g, (_all, head: string, rest: string) => head + rest.replaceAll(" ", ""));
  const out: Tok[] = [];
  const pattern = /(\d{4}-\d{2}-\d{2})|(\d+(?:[.,]\d+)*)(st|nd|rd|th|k(?![\p{L}]))?|([\p{L}][\p{L}'-]*)|(€)|(%)|(\S)/giu;
  for (const match of source.matchAll(pattern)) {
    const [, iso, digits, suffix, word, euro, percent, other] = match;
    if (iso) out.push({ k: "i", s: iso, raw: iso, v: 0, plain: false, mult: false });
    else if (digits) {
      const suffixed = suffix?.toLowerCase();
      const ordinal = suffixed === "st" || suffixed === "nd" || suffixed === "rd" || suffixed === "th";
      const mult = suffixed === "k";
      const value = amountOf(digits) * (mult ? 1000 : 1);
      out.push({ k: ordinal ? "o" : "n", s: digits, raw: match[0], v: value, plain: /^\d+$/.test(digits), mult });
    } else if (word) {
      let lower = word.toLowerCase().replace(/^[-']+|[-']+$/g, "");
      lower = lower.replace(/'s$/, "");
      if (!lower) continue;
      if (CURRENCY.has(lower)) out.push({ k: "c", s: "eur", raw: word, v: 0, plain: false, mult: false });
      else if (lower === "percent") out.push({ k: "%", s: "%", raw: word, v: 0, plain: false, mult: false });
      else out.push({ k: "w", s: lower, raw: word.replace(/'s$/i, ""), v: 0, plain: false, mult: false });
    } else if (euro) out.push({ k: "c", s: "eur", raw: euro, v: 0, plain: false, mult: false });
    else if (percent) out.push({ k: "%", s: "%", raw: percent, v: 0, plain: false, mult: false });
    else if (other) out.push({ k: "p", s: other, raw: other, v: 0, plain: false, mult: false });
  }
  while (out.at(-1)?.k === "p" && (out.at(-1)?.s === "." || out.at(-1)?.s === "!")) out.pop();
  return out;
}

const singular = (word: string) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word);
const sameToken = (left: Tok, right: Tok) => left.k === right.k && (left.k === "w" ? singular(left.s) === singular(right.s) : left.s === right.s);

// ---- the matcher: every shape is a pattern, a pattern yields every way it can consume tokens from a position

type Env = Record<string, any>;
type State = { i: number; env: Env };
type Cx = { topics: readonly Fact[]; chat: string | null; now: number; ranked: number };
type Pat = string | Pat[] | ((tokens: Tok[], state: State, cx: Cx) => Iterable<State>);
type Fact = TopicFact & { words: Tok[]; guards: (GuardrailFact & { words: Tok[] })[] };

function* walk(pat: Pat, tokens: Tok[], state: State, cx: Cx): Generator<State> {
  if (typeof pat === "string") {
    const token = tokens[state.i];
    if (token && (token.k === "w" || token.k === "p") && pat.split("|").includes(token.s)) yield { i: state.i + 1, env: state.env };
    return;
  }
  if (Array.isArray(pat)) {
    yield* chain(pat, 0, tokens, state, cx);
    return;
  }
  yield* pat(tokens, state, cx);
}

function* chain(pats: Pat[], at: number, tokens: Tok[], state: State, cx: Cx): Generator<State> {
  const pat = pats[at];
  if (pat === undefined) {
    yield state;
    return;
  }
  for (const next of walk(pat, tokens, state, cx)) yield* chain(pats, at + 1, tokens, next, cx);
}

const alt = (...pats: Pat[]): Pat => function* (tokens, state, cx) {
  for (const pat of pats) yield* walk(pat, tokens, state, cx);
};
const opt = (...pats: Pat[]): Pat => function* (tokens, state, cx) {
  yield* walk(pats, tokens, state, cx);
  yield state;
};
const some = (pat: Pat): Pat => function* (tokens, state, cx) {
  for (const next of walk(pat, tokens, state, cx)) if (next.i > state.i) yield next;
};
const bind = (key: string, read: (tokens: Tok[], at: number, cx: Cx, env: Env) => Iterable<[number, unknown]>): Pat => function* (tokens, state, cx) {
  for (const [next, value] of read(tokens, state.i, cx, state.env)) yield { i: next, env: { ...state.env, [key]: value } };
};

// ---- the words a shape may hold

const UP = new Set(["raise", "increase", "lift", "boost", "extend", "push", "grow", "bump", "expand"]);
const DOWN = new Set(["lower", "cut", "reduce", "decrease", "drop", "trim", "shrink", "lessen", "demote"]);
const SET = new Set(["set", "change", "make", "put", "bring", "move", "update", "adjust", "hold", "keep", "give", "tighten", "loosen"]);
const direction = (word: string): "up" | "down" | "set" | undefined => UP.has(word) ? "up" : DOWN.has(word) ? "down" : SET.has(word) ? "set" : undefined;

const verb = (only?: "up" | "down"): Pat => bind("verb", function* (tokens, at) {
  const token = tokens[at];
  const dir = token?.k === "w" ? direction(token.s) : undefined;
  if (dir && (!only || dir === only)) yield [at + 1, dir];
});
const PRE: Pat = [opt("please"), opt(verb())];
const PRE_RELATIVE: Pat = [opt("please"), verb()];
const DET = opt(alt("the", "our", "a", "an", "my"));
const TAIL: Pat = [opt(alt(["for", "now"], "now", ["right", "now"])), opt("please")];
const TAIL_PRIORITY: Pat = [opt(alt(["for", "now"], "now", ["this", "week"], ["this", "month"], ["this", "quarter"])), opt("please")];
// What stands between a name and its value: "to", "is now", "should be at most", or a restating ", set it to".
const intro = (...more: string[]): Pat => alt([",", "set", "it", "to"], plainIntro(...more));
const plainIntro = (...more: string[]): Pat => some([
  opt(":"),
  opt(alt(["is", "now"], "is", ["should", "be"], ["must", "be"], ["will", "be"], ["to", "be"], "becomes", "moves", "goes", "now")),
  opt(alt("to", "at", "of", ...more)),
  opt(alt(["at", "most"], ["no", "more", "than"], ["up", "to"])),
]);

const topicSlot = (key: string): Pat => function* (tokens, state, cx) {
  for (const topic of cx.topics) {
    if (topic.words.length > 0 && topic.words.every((word, n) => tokens[state.i + n]?.k === "w" && tokens[state.i + n]?.s === word.s)) {
      yield { i: state.i + topic.words.length, env: { ...state.env, [key]: topic.id } };
    }
  }
};

type Amount = { v: number; cur: boolean; pct: boolean; k: boolean };
function* amountsAt(tokens: Tok[], at: number): Generator<[number, Amount]> {
  let j = at;
  let cur = false;
  if (tokens[j]?.k === "c") {
    cur = true;
    j++;
  }
  const number = tokens[j];
  if (number?.k !== "n") return;
  j++;
  let k = number.mult;
  if (!k && tokens[j]?.k === "w" && tokens[j]?.s === "k") {
    k = true;
    j++;
  }
  const value = number.v * (number.mult || !k ? 1 : 1000);
  let pct = false;
  if (tokens[j]?.k === "%") {
    pct = true;
    j++;
  } else if (!cur && tokens[j]?.k === "c") {
    cur = true;
    j++;
  }
  if (cur && pct) return;
  yield [j, { v: value, cur, pct, k }];
}
const amountSlot = (key: string): Pat => bind(key, function* (tokens, at) { yield* amountsAt(tokens, at); });

const PERIODS: Record<string, string> = { week: "week", month: "month", day: "day", weekly: "week", monthly: "month", daily: "day" };
const periodSlot: Pat = bind("period", function* (tokens, at) {
  const first = tokens[at];
  const second = tokens[at + 1];
  if (first?.k === "w" && ["a", "per", "each", "every"].includes(first.s) && second?.k === "w" && ["week", "month", "day"].includes(second.s)) yield [at + 2, PERIODS[second.s]];
  else if (first?.k === "w" && ["weekly", "monthly", "daily"].includes(first.s)) yield [at + 1, PERIODS[first.s]];
});

type DateSpec = { d: number; m: number; y: number | null } | { end: "quarter" | "month" | "year" } | { iso: string };
const monthOf = (token: Tok | undefined): number | undefined => {
  if (token?.k !== "w") return undefined;
  const full = MONTHS.indexOf(token.s);
  return full >= 0 ? full : MONTH_SHORT[token.s];
};
const dayOf = (token: Tok | undefined): number | undefined => (token && (token.k === "o" || (token.k === "n" && token.plain)) && token.v >= 1 && token.v <= 31 ? token.v : undefined);
const yearOf = (token: Tok | undefined): number | undefined => (token?.k === "n" && /^20\d{2}$/.test(token.s) ? token.v : undefined);
const dateSlot: Pat = bind("date", function* (tokens, at) {
  let j = at;
  const iso = tokens[j];
  if (iso?.k === "i") {
    yield [j + 1, { iso: iso.s } satisfies DateSpec];
    return;
  }
  if (tokens[j]?.s === "the" && tokens[j + 1]?.s === "end") j++;
  if (tokens[j]?.s === "end" && tokens[j + 1]?.s === "of") {
    let n = j + 2;
    if (tokens[n]?.s === "the") n++;
    const unit = tokens[n]?.s;
    if (unit === "quarter" || unit === "month" || unit === "year") yield [n + 1, { end: unit } satisfies DateSpec];
    return;
  }
  if (tokens[j]?.s === "the") j++;
  const day = dayOf(tokens[j]);
  if (day !== undefined) {
    let n = j + 1;
    if (tokens[n]?.s === "of") n++;
    const month = monthOf(tokens[n]);
    if (month === undefined) return;
    const year = yearOf(tokens[n + 1]);
    yield [n + (year === undefined ? 1 : 2), { d: day, m: month, y: year ?? null } satisfies DateSpec];
    return;
  }
  const month = monthOf(tokens[j]);
  const second = dayOf(tokens[j + 1]);
  if (month === undefined || second === undefined) return;
  let n = j + 2;
  if (tokens[n]?.s === "," && yearOf(tokens[n + 1]) !== undefined) n++;
  const year = yearOf(tokens[n]);
  yield [n + (year === undefined ? 0 : 1), { d: second, m: month, y: year ?? null } satisfies DateSpec];
});

// A date without a year is its next occurrence.
function deadlineFor(spec: DateSpec, now: number): string | null {
  const base = new Date(now);
  if ("iso" in spec) {
    const parsed = new Date(`${spec.iso}T16:00:00Z`);
    return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== spec.iso || parsed.getTime() <= now ? null : parsed.toISOString();
  }
  if ("end" in spec) {
    const year = base.getUTCFullYear();
    const month = spec.end === "quarter" ? (Math.floor(base.getUTCMonth() / 3) + 1) * 3 : spec.end === "month" ? base.getUTCMonth() + 1 : 12;
    const result = new Date(Date.UTC(year, month, 0, 16));
    return result.getTime() <= now ? null : result.toISOString();
  }
  const year = spec.y ?? base.getUTCFullYear();
  let result = new Date(Date.UTC(year, spec.m, spec.d, 16));
  if (spec.y === null && result.getTime() <= now) result = new Date(Date.UTC(year + 1, spec.m, spec.d, 16));
  if (result.getUTCDate() !== spec.d || result.getUTCMonth() !== spec.m || result.getTime() <= now) return null;
  return result.toISOString();
}

const berlinDay = (at: string | number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));

/** A rank after "to": number 2, #2, 2nd, second, or a plain 2. */
const rankSlot = (key: string, plain: boolean): Pat => bind(key, function* (tokens, at) {
  const first = tokens[at];
  const second = tokens[at + 1];
  const whole = (token: Tok | undefined) => (token?.k === "n" && token.plain && token.v >= 1 && token.v <= 99 ? token.v : undefined);
  if (first?.k === "w" && ["number", "rank", "position", "place"].includes(first.s) && whole(second) !== undefined) yield [at + 2, whole(second)];
  else if (first?.s === "#" && whole(second) !== undefined) yield [at + 2, whole(second)];
  else if (first?.k === "o" && first.v >= 1) yield [at + 1, first.v];
  else if (first?.k === "w" && first.s in ORDINALS) yield [at + 1, ORDINALS[first.s]];
  else if (plain && whole(first) !== undefined) yield [at + 1, whole(first)];
});
/** The rank in "the top priority", "our third priority". */
const rankAdjective = (key: string): Pat => bind(key, function* (tokens, at) {
  const first = tokens[at];
  if (first?.k === "w" && first.s === "top") yield [at + 1, 1];
  else if (first?.k === "w" && first.s in ORDINALS) yield [at + 1, ORDINALS[first.s]];
  else if (first?.k === "o" && first.v >= 1) yield [at + 1, first.v];
});

const ABOVE = ["over", "above", "before"];
const BELOW = ["below", "after", "behind", "under", "beneath"];
const relation: Pat = bind("rel", function* (tokens, at) {
  const first = tokens[at];
  if (first?.k !== "w") return;
  if (ABOVE.includes(first.s)) yield [at + 1, "above"];
  else if (BELOW.includes(first.s)) yield [at + 1, "below"];
  else if (first.s === "ahead" && tokens[at + 1]?.s === "of") yield [at + 2, "above"];
  else if (first.s === "in" && tokens[at + 1]?.s === "front" && tokens[at + 2]?.s === "of") yield [at + 3, "above"];
});
const comparison: Pat = bind("cmp", function* (tokens, at) {
  const first = tokens[at];
  if (first?.k === "w" && (first.s === "higher" || first.s === "lower")) yield [at + 1, first.s === "higher" ? "above" : "below"];
});
const byOneWord: Pat = function* (tokens, state) {
  const first = tokens[state.i];
  const second = tokens[state.i + 1];
  if (first?.s !== "by") return;
  if (second?.s === "one" || (second?.k === "n" && second.s === "1")) yield { i: state.i + 2, env: state.env };
};

const guardSlot: Pat = function* (tokens, state, cx) {
  const byLength = new Map<number, { topicId: string; guard: GuardrailFact }[]>();
  for (const topic of cx.topics) {
    for (const guard of topic.guards) {
      if (guard.words.length === 0) continue;
      if (guard.words.every((word, n) => { const token = tokens[state.i + n]; return token !== undefined && sameToken(token, word); })) {
        byLength.set(guard.words.length, [...(byLength.get(guard.words.length) ?? []), { topicId: topic.id, guard }]);
      }
    }
  }
  for (const [length, found] of byLength) yield { i: state.i + length, env: { ...state.env, found } };
};

/** One to six words or numbers: a unit or the tail of a guardrail's limit; the builder says whether they are one. */
const spanSlot = (key: string, most = 6): Pat => function* (tokens, state) {
  for (let length = 1; length <= most; length++) {
    const span = tokens.slice(state.i, state.i + length);
    if (span.length < length || span.some(token => token.k !== "w" && token.k !== "n")) return;
    yield { i: state.i + length, env: { ...state.env, [key]: span } };
  }
};

// ---- the shapes

const MORE = ["on", "until", "by"];
const NOUN_GOAL = alt("target", "goal");
const BUDGET = ["budget", opt("cap")] satisfies Pat[];
const T = topicSlot("topic");
const LEAD = [PRE, DET] satisfies Pat[];
const AFTER_NUMBER: Pat[] = [opt(spanSlot("unit")), opt([alt(...MORE), dateSlot]), TAIL];
const DEADLINE_NOUN = alt("deadline", ["due", "date"], ["end", "date"]);

type Shape = { field: GoalAsk["field"]; pat: Pat; relative?: boolean };
const SHAPES: Shape[] = [
  // budget
  { field: "budget", pat: [...LEAD, opt(T), ...BUDGET, intro(), amountSlot("amount"), opt(periodSlot), TAIL] },
  { field: "budget", pat: [...LEAD, ...BUDGET, alt("for", "of"), T, intro(), amountSlot("amount"), opt(periodSlot), TAIL] },
  { field: "budget", pat: [PRE, T, DET, ...BUDGET, "of", amountSlot("amount"), opt(periodSlot), TAIL] },
  { field: "budget", pat: [opt("please"), DET, ...BUDGET, "of", amountSlot("amount"), opt(periodSlot), "for", T, TAIL] },
  { field: "budget", relative: true, pat: [PRE_RELATIVE, DET, opt(T), ...BUDGET, "by", amountSlot("amount"), opt(periodSlot), TAIL] },
  { field: "budget", relative: true, pat: [PRE_RELATIVE, DET, ...BUDGET, alt("for", "of"), T, "by", amountSlot("amount"), opt(periodSlot), TAIL] },
  // target or goal, with a unit and a date when the sentence says them
  { field: "target", pat: [...LEAD, opt(T), NOUN_GOAL, intro(), amountSlot("amount"), ...AFTER_NUMBER] },
  { field: "target", pat: [...LEAD, NOUN_GOAL, alt("for", "of"), T, intro(), amountSlot("amount"), ...AFTER_NUMBER] },
  { field: "target", pat: [...LEAD, NOUN_GOAL, "of", amountSlot("amount"), opt(spanSlot("unit")), "for", T, TAIL] },
  { field: "target", relative: true, pat: [PRE_RELATIVE, DET, opt(T), NOUN_GOAL, "by", amountSlot("amount"), opt(spanSlot("unit")), TAIL] },
  { field: "unit", pat: [...LEAD, opt(T), opt(NOUN_GOAL), "unit", intro(), spanSlot("unit", 4), TAIL] },
  // deadline
  { field: "deadline", pat: [...LEAD, opt(T), DEADLINE_NOUN, opt("back"), intro(...MORE, "for"), dateSlot, TAIL] },
  { field: "deadline", pat: [...LEAD, DEADLINE_NOUN, alt("for", "of"), T, intro(...MORE), dateSlot, TAIL] },
  // priority
  { field: "priority", pat: [...LEAD, "priority", alt("of", "for"), T, intro(), rankSlot("rank", true), TAIL_PRIORITY] },
  { field: "priority", pat: [...LEAD, opt(T), "priority", opt(intro()), rankSlot("rank", true), TAIL_PRIORITY] },
  { field: "priority", pat: [PRE, T, DET, rankAdjective("rank"), "priority", TAIL_PRIORITY] },
  { field: "priority", pat: [PRE, T, "priority", rankSlot("rank", true), TAIL_PRIORITY] },
  { field: "priority", pat: [PRE, T, alt("to", "as"), DET, rankAdjective("rank"), "priority", TAIL_PRIORITY] },
  { field: "priority", pat: [T, alt(["should", "be"], "is", ["must", "be"], ["will", "be"], "becomes", ["to", "be"]), DET, rankAdjective("rank"), "priority", TAIL_PRIORITY] },
  { field: "priority", pat: [opt("please"), alt("prioritise", "prioritize"), T, rankAdjective("rank"), TAIL_PRIORITY] },
  { field: "priority", pat: [opt("please"), alt("prioritise", "prioritize"), T, relation, topicSlot("ref"), TAIL_PRIORITY] },
  { field: "priority", pat: [...LEAD, "priority", alt("of", "for"), T, relation, topicSlot("ref"), TAIL_PRIORITY] },
  { field: "priority", pat: [PRE, T, "priority", relation, topicSlot("ref"), TAIL_PRIORITY] },
  { field: "priority", pat: [PRE, T, DET, comparison, "priority", "than", topicSlot("ref"), TAIL_PRIORITY] },
  { field: "priority", pat: [T, alt(["should", "get"], ["should", "have"], ["should", "be"], "gets", "has", "needs"), DET, comparison, "priority", "than", topicSlot("ref"), TAIL_PRIORITY] },
  { field: "priority", relative: true, pat: [PRE_RELATIVE, DET, "priority", alt("of", "for"), T, opt(byOneWord), TAIL_PRIORITY] },
  { field: "priority", relative: true, pat: [PRE_RELATIVE, T, "priority", opt(byOneWord), TAIL_PRIORITY] },
  { field: "priority", relative: true, pat: [PRE_RELATIVE, T, byOneWord, TAIL_PRIORITY] },
  // guardrail
  { field: "guardrail", pat: [...LEAD, opt(T), guardSlot, "guardrail", intro(), amountSlot("amount"), opt(spanSlot("trail", 3)), TAIL] },
  { field: "guardrail", pat: [...LEAD, opt(T), "guardrail", opt(alt("on", "for", "of")), guardSlot, intro(), amountSlot("amount"), opt(spanSlot("trail", 3)), TAIL] },
  { field: "guardrail", relative: true, pat: [PRE_RELATIVE, DET, opt(T), guardSlot, "guardrail", "by", amountSlot("amount"), TAIL] },
  { field: "guardrail", relative: true, pat: [PRE_RELATIVE, DET, opt(T), "guardrail", opt(alt("on", "for", "of")), guardSlot, "by", amountSlot("amount"), TAIL] },
];

// ---- from the way a sentence was read to a proposal

const NOT = new Set(["not", "never", "unless", "instead", "except", "if", "but", "although", "though", "whether", "rather", "nor", "neither",
  "dont", "don't", "doesn't", "cannot", "can't", "won't", "shouldn't", "mustn't", "isn't", "aren't", "wasn't", "didn't"]);
// What a unit never holds: a time, a comparison, a connective, a hedge.
const UNIT_STOP = new Set(["this", "next", "last", "per", "each", "every", "for", "instead", "unless", "not", "no", "if", "except", "but", "and", "or",
  "then", "than", "from", "once", "after", "before", "when", "while", "until", "by", "on", "at", "in", "the", "a", "an", "of", "to", "with", "without",
  "about", "around", "roughly", "approximately", "more", "less", "most", "least", "please", "now", "thanks", "today", "tomorrow", "tonight", "week",
  "weeks", "month", "months", "quarter", "year", "years", "day", "days", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  ...MONTHS, ...Object.keys(MONTH_SHORT)]);

const topicOf = (cx: Cx, named: unknown) => cx.topics.find(topic => topic.id === (typeof named === "string" ? named : cx.chat));
const isEuro = (cap: Money) => cap.currency === "EUR";
const minorOf = (euros: number) => {
  const minor = Math.round(euros * 100);
  return Math.abs(euros * 100 - minor) < 1e-6 ? minor : null;
};
const tidy = (value: number) => Math.round(value * 10000) / 10000;
const BLANK = { deadlineAt: null, unit: null, budget: null, priority: null, guardrail: null } satisfies Partial<GoalAsk>;

function unitOf(span: Tok[], goalUnit: string): { own: true } | { own: false; unit: string } | null {
  const own = tokenize(goalUnit).filter(token => token.k === "w" || token.k === "n");
  // the whole unit, or plain words of it ("pages" of "Pages in the top 10")
  const plain = span.every(token => token.k === "w" && !UNIT_STOP.has(token.s));
  for (let start = 0; start + span.length <= own.length; start++) {
    if (!(plain || span.length === own.length)) break;
    if (span.every((token, n) => { const against = own[start + n]; return against !== undefined && sameToken(token, against); })) return { own: true };
  }
  // A new unit is a plain plural noun phrase ("qualified partners"); anything else a number could trail is not one.
  const last = span.at(-1)?.s ?? "";
  if (span.length > 3 || span.some(token => token.k !== "w" || UNIT_STOP.has(token.s)) || last.length < 4 || !last.endsWith("s") || last.endsWith("ss")) return null;
  return { own: false, unit: span.map(token => token.raw).join(" ") };
}

function buildGuardrail(relative: boolean, env: Env, cx: Cx): GoalAsk | null {
  const dir: "up" | "down" | "set" | undefined = env.verb;
  const sign = dir === "up" ? 1 : dir === "down" ? -1 : 0;
  if (relative && sign === 0) return null;
  const amount: Amount | undefined = env.amount;
  const found: { topicId: string; guard: GuardrailFact }[] = env.found ?? [];
  const named = typeof env.topic === "string" ? env.topic : null;
  const chosen = named ? found.find(item => item.topicId === named)
    : found.find(item => item.topicId === cx.chat) ?? (found.length === 1 ? found[0] : undefined);
  const guard = chosen?.guard;
  if (!chosen || !guard || !amount) return null;
  const limit = guard.limit;
  const reading = measuredNumber(limit);
  if (reading === undefined) return null;
  let to: MeasuredValue;
  if (limit.kind === "money") {
    if (amount.pct) return null;
    const asked = minorOf(amount.v);
    const minor = asked === null ? null : relative ? reading + sign * asked : asked;
    if (minor === null || minor < 0) return null;
    to = { ...limit, money: { ...limit.money, amountMinor: minor } };
  } else if (limit.kind === "count") {
    if (amount.cur || amount.pct || !Number.isInteger(amount.v)) return null;
    const value = relative ? reading + sign * amount.v : amount.v;
    if (value < 0) return null;
    const trail: Tok[] | undefined = env.trail;
    if (trail) {
      const unit = tokenize(limit.unit ?? "").filter(token => token.k === "w" || token.k === "n");
      if (unit.length !== trail.length || !trail.every((token, n) => { const against = unit[n]; return against !== undefined && sameToken(token, against); })) return null;
    }
    to = { ...limit, value };
  } else if (limit.kind === "rate") {
    if (amount.cur || env.trail) return null;
    const percent = tidy(relative ? reading + sign * amount.v : amount.v);
    if (percent < 0) return null;
    to = { ...limit, percent };
  } else return null;
  if (limit.kind === "money" && env.trail) return null;
  if (measuredNumber(to) === reading) return null;
  return {
    ...BLANK, topicId: chosen.topicId, field: "guardrail", from: Math.round(reading), to: Math.round(measuredNumber(to) ?? 0),
    guardrail: { guardrailId: guard.id, name: guard.what, from: structuredClone(limit), to },
  };
}

function build(field: GoalAsk["field"], relative: boolean, env: Env, cx: Cx): GoalAsk | null {
  const dir: "up" | "down" | "set" | undefined = env.verb;
  const sign = dir === "up" ? 1 : dir === "down" ? -1 : 0;
  if (relative && sign === 0) return null;
  if (field === "guardrail") return buildGuardrail(relative, env, cx);
  const topic = topicOf(cx, env.topic);
  const amount: Amount | undefined = env.amount;
  if (!topic?.goal) return null;
  const goal = topic.goal;
  if (field === "budget") {
    const cap = topic.cap;
    if (!amount || !cap || !isEuro(cap) || amount.pct || !(amount.cur || amount.k)) return null;
    const asked = minorOf(amount.v);
    if (asked === null) return null;
    const minor = relative ? cap.amountMinor + sign * asked : asked;
    if (minor <= 0 || minor === cap.amountMinor) return null;
    const to = { amountMinor: minor, currency: cap.currency };
    return { ...BLANK, topicId: topic.id, field, from: cap.amountMinor, to: minor, budget: { from: { ...cap }, to, period: env.period ?? null } };
  }
  if (field === "target" || field === "unit") {
    const current = goal.target;
    let to = current;
    let unit: string | null = null;
    if (field === "target") {
      if (!amount || amount.cur || amount.pct) return null;
      to = relative ? current + sign * amount.v : amount.v;
      if (!Number.isSafeInteger(to) || to <= 0 || !Number.isInteger(amount.v)) return null;
    }
    const span: Tok[] | undefined = env.unit;
    if (span) {
      const read = unitOf(span, goal.unit);
      if (!read) return null;
      if (!read.own) {
        if (read.unit.toLowerCase() === goal.unit.toLowerCase()) return null;
        unit = read.unit;
      }
      if (field === "unit" && !unit) return null;
    }
    let deadlineAt: string | null = null;
    if (env.date) {
      deadlineAt = deadlineFor(env.date as DateSpec, cx.now);
      if (!deadlineAt) return null;
      if (goal.deadlineAt && berlinDay(goal.deadlineAt) === berlinDay(deadlineAt)) deadlineAt = null;
    }
    if (to === current && !deadlineAt && !unit) return null;
    const kind = to !== current ? "target" : deadlineAt ? "deadline" : "unit";
    return { ...BLANK, topicId: topic.id, field: kind, from: current, to, deadlineAt, unit };
  }
  if (field === "deadline") {
    const deadlineAt = env.date ? deadlineFor(env.date as DateSpec, cx.now) : null;
    if (!deadlineAt) return null;
    if (goal.deadlineAt && berlinDay(goal.deadlineAt) === berlinDay(deadlineAt)) return null;
    return { ...BLANK, topicId: topic.id, field, from: goal.target, to: goal.target, deadlineAt };
  }
  if (field === "priority") {
    const from = topic.rank;
    if (from === null) return null;
    let to: number | undefined;
    if (typeof env.rank === "number") to = env.rank;
    else if (typeof env.ref === "string" && (env.rel || env.cmp)) {
      const other = cx.topics.find(item => item.id === env.ref);
      if (!other || other.rank === null || other.id === topic.id) return null;
      const close = from < other.rank ? other.rank - 1 : other.rank;
      to = (env.rel ?? env.cmp) === "above" ? close : close + 1;
    } else if (relative) to = from - sign;
    if (to === undefined || to < 1 || to > cx.ranked) return null;
    return { ...BLANK, topicId: topic.id, field, from, to, priority: { from, to } };
  }
  return null;
}

/**
 * The proposal a sentence asks for, or null when it asks for none. `topics` holds only what the reader may see; a topic that is
 * not in it does not exist for this sentence. `ranked` is how many topics hold a priority rank.
 */
export function readGoalAsk(text: string, topics: readonly TopicFact[], chatTopicId: string | null, now: string, ranked: number): GoalAsk | null {
  const tokens = tokenize(text);
  if (tokens.length === 0 || tokens.length > 40) return null;
  if (tokens.some((token, n) => (token.k === "w" && NOT.has(token.s)) || (token.k === "w" && token.s === "no" && !(tokens[n + 1]?.s === "more" && tokens[n + 2]?.s === "than")) || (token.k === "p" && (token.s === "?" || token.s === ";")))) return null;
  const cx: Cx = {
    topics: topics.map(topic => ({
      ...topic, words: tokenize(topic.name).filter(token => token.k === "w"),
      guards: (topic.goal?.guardrails ?? []).map(guard => ({ ...guard, words: tokenize(guard.what).filter(token => token.k !== "p") })),
    })),
    chat: chatTopicId, now: Date.parse(now), ranked,
  };
  const found = new Map<string, GoalAsk>();
  for (const shape of SHAPES) {
    for (const state of walk(shape.pat, tokens, { i: 0, env: {} }, cx)) {
      if (state.i !== tokens.length) continue;
      const ask = build(shape.field, shape.relative === true, state.env, cx);
      if (ask) found.set(JSON.stringify(ask), ask);
    }
  }
  return found.size === 1 ? [...found.values()][0] ?? null : null;
}
