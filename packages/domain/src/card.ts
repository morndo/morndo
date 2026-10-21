// Short cards (ADR-0023's amendment, board T-307): the manager's everyday question to the principal — a few visible
// lines and a tap-buttons last line, sent on his phone, never filed. The same discipline as a brief, as a short form:
// lintCard is the one check (DB10's rule), pure, called by `morndo-decide card`, which files nothing. Errors first,
// then warnings; a card with errors is not returned and carries only its errors, so a refusal says what to fix.
import type { BriefProblem } from "./brief.ts";

export type CardOption = { key: string; label: string };       // the manager protocol's grammar, so a tap line answers

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

// The buttons line's id rule (the manager protocol): letters, digits, - and _, at most 32.
const ID = /^[A-Za-z0-9_-]{1,32}$/;
// An option key (DB1's grammar): letters, digits, - and _, at most 16.
const KEY = /^[A-Za-z0-9_-]{1,16}$/;
// A control character (C0 or DEL, minus tab and newline), as brief.ts; the outcome and the labels are one line each,
// so there a line break is refused as one.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000D-\u001F\u007F]/;
// A placeholder left from the blank: "<…>" with no line break of its own inside.
const PLACEHOLDER = /<[^<>\n]*>/;
// The words of a default that carries on as today (T-307). With a live Risk named, carrying on by default is the one
// dangerous silence lint can refuse without judging truth: when he does not answer, the safe option is what happens.
const CONTINUES = /\b(continue|keep going|keep running|keep it|proceed|carry on|go ahead|resume|leave it|do nothing|ignore|as is)\b/i;
// Jargon the principal cannot read on a phone card: a tracker number, a commit hash, an ask id (T-307). A hash needs
// both a digit and a letter, so a word of letters alone ("defaced") and a plain number ("1234567") stay prose.
const JARGON = [
  /#\d+/g,
  /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gi,
  /\bny-\d+\b/gi,
] as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string";
const blank = (s: string) => s.trim() === "";

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
  else if (draft.outcome.includes("\n") || CONTROL.test(draft.outcome)) error("outcome_not_one_line", "outcome", "the outcome is one line, no line breaks or control characters");
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
      const where = `option ${isText(key) ? key : i}`;
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
      if (!isText(label) || blank(label) || label.length > 40 || label.includes("|") || label.includes("\n") || CONTROL.test(label)) {
        error("bad_option_label", where, 'a one-line label of 1 to 40 characters, with no "|"');
        optionsBroken = true;
        continue;
      }
      if (PLACEHOLDER.test(label)) {
        error("placeholder", where, "fill in or remove the placeholder");
        optionsBroken = true;
        continue;
      }
      options.push({ key, label });
    }
  }

  // A card without a recommendation is refused (T-307): the buttons line puts the recommended option first, so name
  // it, and list it first.
  let recommend = "";
  const rec = isText(draft.recommend) ? draft.recommend : "";
  if (!isText(draft.recommend) || draft.recommend.trim() === "") {
    error("no_recommendation", "recommend", "a card without a recommendation is refused; say which option you recommend");
  } else if (!optionsBroken && !options.some(o => o.key === rec)) {
    error("recommend_unknown", "recommend", `"${rec}" is not one of the option keys (${options.map(o => o.key).join(", ")})`);
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
    error("default_unknown", "default", `"${given}" is not one of the option keys (${options.map(o => o.key).join(", ")})`);
  } else if (defOpt !== undefined) {
    def = given;
  }

  let risk: string | null = isText(draft.risk) && draft.risk.trim() !== "" ? draft.risk : null;
  if (risk !== null && PLACEHOLDER.test(risk)) {
    error("placeholder", "risk", "fill in or remove the placeholder");
    risk = null;
  }

  // The key counts as its label here (its - and _ read as spaces), so "keep-going" is caught like "Keep going". A
  // safe default with a risk, or a carrying-on default with no risk named, is fine.
  const carriesOn = defOpt !== undefined && (CONTINUES.test(defOpt.label) || CONTINUES.test(defOpt.key.replace(/[-_]/g, " ")));
  if (risk !== null && carriesOn) {
    error("continue_default_on_live_risk", "default",
      `the default "${defOpt!.label}" continues the live risk "${risk}"; default to the safe option (hold, stop, undo), or drop the Risk line once the risk is closed`);
  }

  if (problems.some(p => p.level === "error")) return { card: null, problems };

  // Warnings, as a brief's: they come back with the card and never refuse. The default's label is named "default",
  // not by its option, so one label warns once: it is the line that says what happens when he does not answer.
  const jargon = (where: string, text: string) => {
    for (const re of JARGON) for (const m of text.matchAll(re)) {
      problems.push({ level: "warning", code: "jargon", where, text: `"${m[0]}" is a number or hash only the manager knows; say what it is in words` });
    }
  };
  jargon("outcome", outcome);
  for (const o of options) if (o.key !== def) jargon(`option ${o.key}`, o.label);
  jargon("default", defOpt!.label);
  if (risk !== null) jargon("risk", risk);

  return { card: { id, outcome, recommend, options, default: def, risk }, problems };
}

// The text to post (T-307): a few visible lines, the buttons line last, so the principal can tap. The options are in
// the card's order — lint has put the recommended one first and named the default.
export function cardText(card: ShortCard): string[] {
  return [
    card.outcome,
    `Recommended: ${card.options[0]!.label}`,
    `If you don't answer: ${card.options.find(o => o.key === card.default)?.label ?? ""}`,
    ...(card.risk !== null ? [`Live risk: ${card.risk}`] : []),
    `[buttons ${card.id}] ${card.options.map(o => `${o.key}=${o.label}`).join(" | ")}`,
  ];
}
