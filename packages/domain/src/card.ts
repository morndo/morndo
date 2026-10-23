// Short cards (ADR-0023's amendment, board T-307): the manager's everyday question to the principal — a few visible
// lines and a tap-buttons last line, sent on his phone, never filed. The same discipline as a brief, as a short form:
// lintCard is the one check (DB10's rule), pure, called by `morndo-decide card`, which files nothing. Errors first,
// then warnings; a card with errors is not returned and carries only its errors, so a refusal says what to fix.
import type { BriefProblem } from "./brief.ts";

// The kind an option declares, not the words of its label (T-307, round 3): no reading of a label's meaning could be
// made reliable, so under a live Risk the asker marks what silence does — stop or continue — and lint reads only that.
export type CardOption = { key: string; label: string; kind?: "stop" | "continue" };   // the manager protocol's grammar, so a tap line answers

// ShortCard, not Card: the phone's DecisionCard is a Card in catchup.ts already, and this is the card a manager
// writes (T-307's "short cards"), so the two never meet under one name.
export type ShortCard = {
  id: string;            // the buttons line's id
  outcome: string;       // one line: what is asked or what happened
  recommend: string;     // an option key, and the first one
  options: CardOption[]; // 2–4, the recommended first
  default: string;       // an option key: what applies if he does not answer
  risk: string | null;   // the live risk this touches, when there is one
};

export const CARD_OUTCOME_MAX = 140;
export const CARD_RISK_MAX = 140;

// The buttons line's id rule (the manager protocol): letters, digits, - and _, at most 32.
const ID = /^[A-Za-z0-9_-]{1,32}$/;
// An option key (DB1's grammar): letters, digits, - and _, at most 16.
const KEY = /^[A-Za-z0-9_-]{1,16}$/;
// What a one-line field may not hold (T-307), by Unicode property and not by a list of characters, which always missed
// one: every control (Cc: the C0 and C1 controls, tab and the line breaks among them), every format character (Cf: the
// bidirectional overrides, isolates and marks, the zero-width ones, the soft hyphen, the Arabic number signs), every
// Default_Ignorable_Code_Point (the invisible operators, the combining grapheme joiner, the variation selectors, the
// Hangul fillers, the tag characters, the Mongolian vowel separator) and the Unicode line and paragraph separators
// (U+2028, U+2029, Zl and Zp). A bidi override can make `merge` look like `hold` on a phone card; a line break would add
// a line of its own to the printed card, a fake buttons line among them (a draft from --json). Ordinary text of any
// script, accents and CJK among it, is none of these. (The file is already in .oxlintrc.json's no-control-regex override.)
const INVISIBLE_CLASS = "\\p{Cc}\\p{Cf}\\p{Default_Ignorable_Code_Point}\\u2028\\u2029";
const INVISIBLE = new RegExp(`[${INVISIBLE_CLASS}]`, "u");
// A placeholder left from the blank: "<…>" with no line break of its own inside.
const PLACEHOLDER = /<[^<>\n]*>/;
// What quoted() escapes: the same set, so a draft value echoed into a problem's text can neither add a line of its own nor
// hide inside one.
const ESCAPE = new RegExp(`[${INVISIBLE_CLASS}]`, "gu");
// Jargon the principal cannot read on a phone card: a tracker number, a commit hash, an ask id (T-307). A hash needs
// both a digit and a letter, so a word of letters alone ("defaced") and a plain number ("1234567") stay prose.
const JARGON = [
  /#\d+/g,
  /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gi,
  /\bny-\d+\b/gi,
] as const;

// Every jargon match in a text, in text order, as matched (T-308): lintCard warns on each in a card's fields, and the
// node's relay asks the orchestrator's digest and cards the same question.
export function jargonIn(text: string): string[] {
  const found: { at: number; term: string }[] = [];
  for (const re of JARGON) for (const m of text.matchAll(re)) found.push({ at: m.index ?? 0, term: m[0] });
  return found.sort((a, b) => a.at - b.at).map(f => f.term);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string";
const blank = (s: string) => s.trim() === "";
const oneLine = (s: string) => !INVISIBLE.test(s);

// A draft value echoed into a problem's text, made safe to print (T-307): JSON-quoted, and every character that could
// break the line or hide in it comes back as its \uXXXX escape.
// A character above U+FFFF (a tag character) is one escape, \u{e0041}, not its two surrogate halves.
const escapeCode = (c: string) => {
  const cp = c.codePointAt(0) ?? 0;
  return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, "0")}`;
};
export function quoted(value: string): string {
  return JSON.stringify(value).replace(ESCAPE, escapeCode);
}

export function lintCard(draft: unknown): { card: ShortCard | null; problems: BriefProblem[] } {
  const problems: BriefProblem[] = [];
  const error = (code: string, where: string, text: string) => problems.push({ level: "error", code, where, text });

  if (!isObj(draft)) {
    error("bad_draft", "card", "a card is one object with the card file's fields");
    return { card: null, problems };
  }

  let id = "";
  if (!isText(draft.id) || !ID.test(draft.id)) error("bad_id", "id", "an id of letters, digits, - and _ (at most 32), the buttons line's id");
  else id = draft.id;

  let outcome = "";
  if (!isText(draft.outcome) || blank(draft.outcome)) error("no_outcome", "outcome", "say in one plain line what is asked or what happened");
  else if (!oneLine(draft.outcome)) error("outcome_not_one_line", "outcome", "the outcome is one line, no line breaks, control or hidden direction/zero-width characters");
  else if (draft.outcome.length > CARD_OUTCOME_MAX) error("outcome_too_long", "outcome", `${draft.outcome.length} characters; the cap is ${CARD_OUTCOME_MAX}`);
  else if (PLACEHOLDER.test(draft.outcome)) error("placeholder", "outcome", "fill in or remove the placeholder");
  else outcome = draft.outcome;

  // Two to four options in the manager protocol's grammar (DB1): five is no card for a phone, one is no question.
  // When the options are broken there is nothing to recommend or default against yet; the asker fixes those first,
  // as with a brief.
  const optionsIn = draft.options;
  const options: CardOption[] = [];
  let optionsBroken = !Array.isArray(optionsIn);
  if (!Array.isArray(optionsIn)) error("option_count", "options", 'a card has two to four options under "Options:", as "- key: Label" lines');
  else if (optionsIn.length < 2 || optionsIn.length > 4) error("option_count", "options", `a card has two to four options; this one has ${optionsIn.length}`);
  if (Array.isArray(optionsIn)) {
    optionsBroken ||= optionsIn.length < 2 || optionsIn.length > 4;
    for (let i = 0; i < optionsIn.length; i++) {
      const o: unknown = optionsIn[i];
      if (!isObj(o)) {
        error("bad_option_key", `option ${i}`, "an option is a key and a label");
        optionsBroken = true;
        continue;
      }
      const { key, label } = o;
      // The where names the key only when the key is one word of the grammar: a draft's own key must not put its own
      // line into the problem.
      const where = `option ${isText(key) && KEY.test(key) ? key : i}`;
      if (!isText(key) || !KEY.test(key)) {
        error("bad_option_key", where, "a key of letters, digits, - and _ (at most 16)");
        optionsBroken = true;
        continue;
      }
      if (options.some(x => x.key === key)) {
        error("duplicate_option", where, `option ${key} appears twice; keys must be unique`);
        optionsBroken = true;
        continue;
      }
      if (!isText(label) || blank(label) || label.length > 40 || label.includes("|") || !oneLine(label)) {
        error("bad_option_label", where, 'a one-line label of 1 to 40 characters, with no "|", no line breaks, control or hidden direction/zero-width characters');
        optionsBroken = true;
        continue;
      }
      if (PLACEHOLDER.test(label)) {
        error("placeholder", where, "fill in or remove the placeholder");
        optionsBroken = true;
        continue;
      }
      // The kind the draft declares (T-307): a kind is never guessed from a label's words, and one that is neither
      // stop nor continue is the asker's mistake to fix.
      const kind: unknown = o.kind;
      if (kind === "stop" || kind === "continue") options.push({ key, label, kind });
      else if (kind !== undefined) {
        error("bad_option_kind", where, "an option's kind is stop or continue, written after the label's \"|\"");
        optionsBroken = true;
        continue;
      } else options.push({ key, label });
    }
  }

  // A card without a recommendation is refused (T-307): the buttons line puts the recommended option first, so name
  // it, and list it first.
  let recommend = "";
  const rec = isText(draft.recommend) ? draft.recommend : "";
  if (!isText(draft.recommend) || draft.recommend.trim() === "") {
    error("no_recommendation", "recommend", "a card without a recommendation is refused; say which option you recommend");
  } else if (!optionsBroken && !options.some(o => o.key === rec)) {
    error("recommend_unknown", "recommend", `${quoted(rec)} is not one of the option keys (${options.map(o => o.key).join(", ")})`);
  } else if (!optionsBroken && options[0]!.key !== rec) {
    error("recommend_not_first", "recommend", "the recommended option goes first, as the buttons line puts it first");
  } else if (!optionsBroken) {
    recommend = rec;
  }

  // What applies if he does not answer: one of the options, named — never left to guess (T-307).
  let def = "";
  const given = isText(draft.default) ? draft.default.trim() : "";
  if (given === "") error("no_default", "default", "say what applies if he does not answer");
  const defOpt = optionsBroken || given === "" ? undefined : options.find(o => o.key === given);
  if (!optionsBroken && given !== "" && defOpt === undefined) {
    error("default_unknown", "default", `${quoted(given)} is not one of the option keys (${options.map(o => o.key).join(", ")})`);
  } else if (defOpt !== undefined) {
    def = given;
  }

  // The risk, when there is one: one line of words, bounded like the outcome. A draft from --json can hold anything,
  // and the card is posted as lines, so a line break here would add a line of its own to the principal's card.
  let risk: string | null = null;
  if (isText(draft.risk) && !blank(draft.risk)) {
    if (!oneLine(draft.risk)) error("risk_not_one_line", "risk", "the risk is one line, no line breaks, control or hidden direction/zero-width characters");
    else if (draft.risk.length > CARD_RISK_MAX) error("risk_too_long", "risk", `${draft.risk.length} characters; the cap is ${CARD_RISK_MAX}`);
    else if (PLACEHOLDER.test(draft.risk)) error("placeholder", "risk", "fill in or remove the placeholder");
    else risk = draft.risk;
  } else if (draft.risk !== undefined && draft.risk !== null) {
    error("bad_risk", "risk", "the risk is one line of words, when there is one");
  }

  // A live risk declares what silence does (T-307): every option marked stop or continue, and the default a stop.
  // The kinds are the asker's own declaration — lint reads no wording — and without a Risk they are optional. With
  // the kinds there but none of them a stop, the default is a continue, and this same error says it.
  if (risk !== null && !optionsBroken) {
    if (options.some(o => o.kind === undefined)) {
      error("kinds_needed_on_live_risk", "options",
        "a card with a live risk marks each option stop or continue (… | stop), so what happens if he does not answer is declared, not guessed");
    } else if (defOpt !== undefined && defOpt.kind === "continue") {
      error("continue_default_on_live_risk", "default",
        `the default "${defOpt.label}" continues the live risk "${risk}"; default to a stop option, or drop the Risk line once the risk is closed`);
    }
  }

  if (problems.some(p => p.level === "error")) return { card: null, problems };

  // Warnings, as a brief's: they come back with the card and never refuse. The default's label is named "default",
  // not by its option, so one label warns once: it is the line that says what happens when he does not answer.
  const jargon = (where: string, text: string) => {
    for (const term of jargonIn(text)) {
      problems.push({ level: "warning", code: "jargon", where, text: `"${term}" is a number or hash only the manager knows; say what it is in words` });
    }
  };
  jargon("outcome", outcome);
  for (const o of options) if (o.key !== def) jargon(`option ${o.key}`, o.label);
  jargon("default", defOpt!.label);
  if (risk !== null) jargon("risk", risk);

  return { card: { id, outcome, recommend, options, default: def, risk }, problems };
}

// The text to post (T-307): a few visible lines, the buttons line last, so the principal can tap. The options are in
// the card's order — lint has put the recommended one first and named the default. A kind is never printed: it is for
// lint, not for the principal.
export function cardText(card: ShortCard): string[] {
  return [
    card.outcome,
    `Recommended: ${card.options[0]!.label}`,
    `If you don't answer: ${card.options.find(o => o.key === card.default)?.label ?? ""}`,
    ...(card.risk !== null ? [`Live risk: ${card.risk}`] : []),
    `[buttons ${card.id}] ${card.options.map(o => `${o.key}=${o.label}`).join(" | ")}`,
  ];
}
