// Short cards (ADR-0023's amendment, board T-307): the manager's everyday question to the principal — a few visible
// lines and a tap-buttons last line — under the brief's discipline in short form. lintCard refuses what a card may not
// be, warns on ids the principal cannot read, and cardText is the text to post, the buttons line last.
import { describe, expect, it } from "vitest";
import { CARD_OUTCOME_MAX, cardText, lintCard } from "../src/index.ts";

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
    expect(codes(card({ options: [{ key: "merge", label: "Merge now" }, { key: "a key", label: "Label" }] }))).toEqual(["bad_option_key option a key"]);
    expect(codes(card({ options: [{ key: "merge", label: "Merge now" }, { key: "hold", label: "a|b" }] }))).toEqual(["bad_option_label option hold"]);
    expect(codes(card({ options: [{ key: "merge", label: "Merge now" }, { key: "hold", label: "x".repeat(41) }] }))).toEqual(["bad_option_label option hold"]);
    expect(codes(card({ options: [{ key: "merge", label: "Merge now" }, { key: "merge", label: "Merge again" }] }))).toEqual(["duplicate_option option merge"]);
    expect(codes(card({ default: undefined }))).toEqual(["no_default default"]);
    expect(codes(card({ default: "wait" }))).toEqual(["default_unknown default"]);
    expect(codes(card({ outcome: "<what to ask>" }))).toEqual(["placeholder outcome"]);
    expect(codes(card({ outcome: "line one\nline two" }))).toEqual(["outcome_not_one_line outcome"]);
    expect(codes(card({ outcome: "x".repeat(CARD_OUTCOME_MAX + 1) }))).toEqual(["outcome_too_long outcome"]);
    expect(codes(card({ id: "bad id!" }))).toEqual(["bad_id id"]);
    const draft = lintCard("not a card");
    expect(draft.problems.map(p => p.code)).toEqual(["bad_draft"]);
    expect(draft.card).toBeNull();
  });
});
