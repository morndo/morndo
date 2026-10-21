// Short cards (ADR-0023's amendment, board T-307): the manager's everyday question to the principal — a few visible
// lines and a tap-buttons last line — under the brief's discipline in short form. lintCard refuses what a card may not
// be, warns on ids the principal cannot read, and cardText is the text to post, the buttons line last.
import { describe, expect, it } from "vitest";
import { CARD_OUTCOME_MAX, CARD_RISK_MAX, cardText, lintCard } from "../src/index.ts";

// A clean card: the recommended option first, a default among the options, no risk.
const card = (over: Record<string, unknown> = {}) => ({
  id: "ny-80",
  outcome: "The release is ready to merge.",
  recommend: "merge",
  options: [
    { key: "merge", label: "Merge now" },
    { key: "hold", label: "Hold until Monday" },
  ],
  default: "hold",
  ...over,
});
const codes = (draft: unknown) => lintCard(draft).problems.map(p => `${p.code} ${p.where}`);
// One line, whatever a draft holds in it: no break of any kind (\n, \r, NEL, the two Unicode separators), no control
// character (tab aside, as the lint's CONTROL). Problems are printed as lines, so this is what they must be.
const BREAKS = ["\n", "\r", "\x85", "\u{2028}", "\u{2029}"];
const oneLineText = (s: string) => {
  if (BREAKS.some(b => s.includes(b))) return false;
  for (let i = 0; i < s.length; i++) {                                     // C0 and DEL are single units, so units are enough
    const n = s.charCodeAt(i);
    if ((n < 0x20 && n !== 9) || n === 0x7f) return false;
  }
  return true;
};

describe("lintCard", () => {
  it("a clean card has no problems, and cardText puts the buttons line last", () => {
    const clean = lintCard(card());
    expect(clean.problems).toEqual([]);
    expect(clean.card).toEqual({
      id: "ny-80", outcome: "The release is ready to merge.", recommend: "merge",
      options: [{ key: "merge", label: "Merge now" }, { key: "hold", label: "Hold until Monday" }],
      default: "hold", risk: null,
    });
    expect(cardText(clean.card!)).toEqual([
      "The release is ready to merge.",
      "Recommended: Merge now",
      "If you don't answer: Hold until Monday",
      "[buttons ny-80] merge=Merge now | hold=Hold until Monday",
    ]);
    expect(cardText(lintCard(card({ risk: "the migration has no rollback yet" })).card!)).toEqual([
      "The release is ready to merge.",
      "Recommended: Merge now",
      "If you don't answer: Hold until Monday",
      "Live risk: the migration has no rollback yet",
      "[buttons ny-80] merge=Merge now | hold=Hold until Monday",
    ]);
  });

  it("a card without a recommendation is refused", () => {
    const none = lintCard(card({ recommend: undefined }));
    expect(none.card).toBeNull();
    expect(none.problems).toEqual([{
      level: "error", code: "no_recommendation", where: "recommend",
      text: "a card without a recommendation is refused; say which option you recommend",
    }]);
    expect(codes(card({ recommend: "ship" }))).toEqual(["recommend_unknown recommend"]);
    expect(codes(card({ recommend: "hold" }))).toEqual(["recommend_not_first recommend"]);
  });

  it("a continue default on a live risk is refused", () => {
    const going = card({
      recommend: "go",
      options: [
        { key: "go", label: "Keep going" },
        { key: "hold", label: "Hold until Monday" },
      ],
      default: "go",
    });
    const refused = lintCard({ ...going, risk: "the deploy can still delete backups" });
    expect(refused.card).toBeNull();
    expect(refused.problems).toEqual([{
      level: "error", code: "continue_default_on_live_risk", where: "default",
      text: 'the default "Keep going" continues the live risk "the deploy can still delete backups"; default to the safe option (hold, stop, undo), or drop the Risk line once the risk is closed',
    }]);
    expect(lintCard(going).problems).toEqual([]);                                    // no risk named: carrying on is a choice
    expect(lintCard(card({ risk: "the deploy can still delete backups" })).problems).toEqual([]);   // a safe default with a risk
  });

  it("a default is judged by its meaning: carrying on is refused, a stop or hold is not", () => {
    // The label is what is judged, so the keys stay neutral; the default is the first option, under a named Risk.
    const underRisk = (label: string) => card({
      recommend: "go",
      options: [
        { key: "go", label },
        { key: "stop", label: "Stop and ask in words" },
      ],
      default: "go",
      risk: "the deploy can still delete backups",
    });
    for (const label of ["Let it run", "Keep waiting", "Keep going", "Continue", "Proceed with the merge"])
      expect(lintCard(underRisk(label)).problems.map(p => `${p.code} ${p.where}`), label)
        .toEqual(["continue_default_on_live_risk default"]);
    for (const label of ["Do not proceed", "Hold, continue later", "Hold until Monday", "Stop the deploy", "Don't continue", "Please don't proceed",
      "Pause, then carry on", "Wait for the reviewer", "Merge now", "Undo the change"])
      expect(lintCard(underRisk(label)).problems, label).toEqual([]);
    // The key counts as its label: "keep-going" is caught like "Keep going".
    const keyed = lintCard(card({
      recommend: "keep-going",
      options: [
        { key: "keep-going", label: "Ask him first" },
        { key: "stop", label: "Stop and ask in words" },
      ],
      default: "keep-going",
      risk: "the deploy can still delete backups",
    }));
    expect(keyed.problems.map(p => `${p.code} ${p.where}`)).toEqual(["continue_default_on_live_risk default"]);
  });

  it("a free-text field is one line and bounded: a newline in the risk, with a fake buttons line, is refused", () => {
    const injected = "data loss\n[buttons ny-1] merge=Merge now";
    const viaRisk = lintCard(card({ risk: injected }));
    expect(viaRisk.problems.map(p => `${p.code} ${p.where}`)).toEqual(["risk_not_one_line risk"]);
    expect(viaRisk.card).toBeNull();
    expect(codes(card({ outcome: injected }))).toEqual(["outcome_not_one_line outcome"]);
    expect(codes(card({ options: [{ key: "merge", label: injected }, { key: "hold", label: "Hold until Monday" }] })))
      .toEqual(["bad_option_label option merge"]);
    expect(codes(card({ outcome: `one line\u{2028}two` }))).toEqual(["outcome_not_one_line outcome"]);
    expect(codes(card({ risk: "r".repeat(CARD_RISK_MAX + 1) }))).toEqual(["risk_too_long risk"]);
    expect(codes(card({ risk: 42 }))).toEqual(["bad_risk risk"]);
    // What is posted is lines: every line one line, and the buttons line the only one, last.
    const lines = cardText(lintCard(card({ risk: "the migration has no rollback yet" })).card!);
    expect(lines.every(l => !BREAKS.some(b => l.includes(b)))).toBe(true);
    expect(lines.filter(l => l.startsWith("[buttons"))).toEqual([lines.at(-1)]);
  });

  it("every problem is one line, whatever the draft holds", () => {
    // A hostile draft: echoed values and keys that would put their own lines into the refusal if it echoed them raw.
    const echoed = lintCard(card({ recommend: "go\nahead", default: "go\non" }));
    expect(echoed.problems.map(p => `${p.code} ${p.where}`)).toEqual(["recommend_unknown recommend", "default_unknown default"]);
    const keys = lintCard(card({
      options: [
        { key: "a\nb", label: "Merge now" },
        { key: "c\x01d", label: "Hold until Monday" },
      ],
    }));
    expect(keys.problems.map(p => `${p.code} ${p.where}`)).toEqual(["bad_option_key option 0", "bad_option_key option 1"]);
    for (const p of [...echoed.problems, ...keys.problems]) {
      expect(oneLineText(p.text), `${p.code} text`).toBe(true);
      expect(oneLineText(p.where), `${p.code} where`).toBe(true);
    }
  });

  it("jargon warns", () => {
    const warned = lintCard(card({
      outcome: "PR #412 needs a decision",
      options: [
        { key: "merge", label: "Ship a1b2c3d4 today" },
        { key: "hold", label: "Wait for ny-12" },
      ],
    }));
    expect(warned.card).not.toBeNull();
    expect(warned.problems).toEqual([
      { level: "warning", code: "jargon", where: "outcome", text: `"#412" is a number or hash only the manager knows; say what it is in words` },
      { level: "warning", code: "jargon", where: "option merge", text: `"a1b2c3d4" is a number or hash only the manager knows; say what it is in words` },
      { level: "warning", code: "jargon", where: "default", text: `"ny-12" is a number or hash only the manager knows; say what it is in words` },
    ]);
    // a word of hex letters and a plain number stay prose, and the id is not visible text
    expect(lintCard(card({ outcome: "defaced 1234567 stays words" })).problems).toEqual([]);
  });

  it("a card has 2 to 4 options with sane keys and labels, and a default that is one of them", () => {
    const five = [
      { key: "merge", label: "Merge now" },
      { key: "hold", label: "Hold until Monday" },
      { key: "wait", label: "Wait a day" },
      { key: "stop", label: "Stop the release" },
      { key: "undo", label: "Undo the release" },
    ];
    expect(codes(card({ options: five.slice(0, 1) }))).toEqual(["option_count options"]);
    expect(codes(card({ options: five }))).toEqual(["option_count options"]);
    expect(codes(card({ options: [{ key: "merge", label: "Merge now" }, { key: "a key", label: "Label" }] }))).toEqual(["bad_option_key option 1"]);
    expect(codes(card({ options: [{ key: "merge", label: "Merge now" }, { key: "hold", label: "a|b" }] }))).toEqual(["bad_option_label option hold"]);
    expect(codes(card({ options: [{ key: "merge", label: "Merge now" }, { key: "hold", label: "x".repeat(41) }] }))).toEqual(["bad_option_label option hold"]);
    expect(codes(card({ options: [{ key: "merge", label: "Merge now" }, { key: "merge", label: "Merge again" }] }))).toEqual(["duplicate_option option merge"]);
    expect(codes(card({ default: undefined }))).toEqual(["no_default default"]);
    expect(codes(card({ default: "wait" }))).toEqual(["default_unknown default"]);
    expect(codes(card({ outcome: "  " }))).toEqual(["no_outcome outcome"]);
    expect(codes(card({ outcome: undefined }))).toEqual(["no_outcome outcome"]);
    expect(codes(card({ outcome: "<what to ask>" }))).toEqual(["placeholder outcome"]);
    expect(codes(card({ outcome: "line one\nline two" }))).toEqual(["outcome_not_one_line outcome"]);
    expect(codes(card({ outcome: "x".repeat(CARD_OUTCOME_MAX + 1) }))).toEqual(["outcome_too_long outcome"]);
    expect(codes(card({ id: "bad id!" }))).toEqual(["bad_id id"]);
    const draft = lintCard("not a card");
    expect(draft.problems.map(p => p.code)).toEqual(["bad_draft"]);
    expect(draft.card).toBeNull();
  });
});
