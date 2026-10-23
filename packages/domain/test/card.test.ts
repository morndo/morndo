// Short cards (ADR-0023's amendment, board T-307): the manager's everyday question to the principal — a few visible
// lines and a tap-buttons last line — under the brief's discipline in short form. lintCard refuses what a card may not
// be, warns on ids the principal cannot read, and cardText is the text to post, the buttons line last.
import { describe, expect, it } from "vitest";
import { CARD_OUTCOME_MAX, CARD_RISK_MAX, cardText, jargonIn, lintCard } from "../src/index.ts";

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
// character (a tab cannot break a line, so it passes here; a card's own fields refuse it). Problems are printed as
// lines, so this is what they must be.
const BREAKS = ["\n", "\r", "\x85", "\u{2028}", "\u{2029}"];
const oneLineText = (s: string) => {
  if (BREAKS.some(b => s.includes(b))) return false;
  for (let i = 0; i < s.length; i++) {                                     // C0 and DEL are single units, so units are enough
    const n = s.charCodeAt(i);
    if ((n < 0x20 && n !== 9) || n === 0x7f) return false;
  }
  return true;
};
// Every character a text field refuses beyond plain words (T-307): the C0 controls (tab and the line breaks among
// them), DEL and the C1 controls, the two Unicode separators, the bidirectional overrides and isolates, and the
// zero-width characters — each can break a line, reorder it, or hide a word of it on the principal's phone.
const HOSTILE = [
  "\r", "\n", "\t", "\u0000", "\u0007", "\u0008", "\u000B", "\u000C", "\u001B", "\u007F", "\u0085", "\u009F",
  "\u{2028}", "\u{2029}", "\u{200B}", "\u{200C}", "\u{200D}", "\u{FEFF}",
  "\u{202A}", "\u{202B}", "\u{202C}", "\u{202D}", "\u{202E}", "\u{2066}", "\u{2067}", "\u{2068}", "\u{2069}",
];

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
    expect(cardText(lintCard(card({
      risk: "the migration has no rollback yet",
      options: [
        { key: "merge", label: "Merge now", kind: "continue" },
        { key: "hold", label: "Hold until Monday", kind: "stop" },
      ],
    })).card!)).toEqual([
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
        { key: "go", label: "Keep going", kind: "continue" },
        { key: "hold", label: "Hold until Monday", kind: "stop" },
      ],
      default: "go",
    });
    const refused = lintCard({ ...going, risk: "the deploy can still delete backups" });
    expect(refused.card).toBeNull();
    expect(refused.problems).toEqual([{
      level: "error", code: "continue_default_on_live_risk", where: "default",
      text: 'the default "Keep going" continues the live risk "the deploy can still delete backups"; default to a stop option, or drop the Risk line once the risk is closed',
    }]);
    expect(lintCard(going).problems).toEqual([]);                                    // no risk named: carrying on is a choice
    expect(lintCard(card({                                                          // a stop default with a risk
      risk: "the deploy can still delete backups",
      options: [
        { key: "merge", label: "Merge now", kind: "continue" },
        { key: "hold", label: "Hold until Monday", kind: "stop" },
      ],
    })).problems).toEqual([]);
  });

  it("a live risk needs every option marked stop or continue, and a stop default; the wording is never read", () => {
    // Round 3 (T-307): no word list can judge a label ("Don't stop" carries on, "Keep it paused" stops), so the asker
    // declares each option's kind and lint reads only that. The default is the first option, under a named Risk.
    const underRisk = (kind: "stop" | "continue", label: string) => card({
      recommend: "go",
      options: [
        { key: "go", label, kind },
        { key: "stop", label: "Stop and ask in words", kind: "stop" },
      ],
      default: "go",
      risk: "the deploy can still delete backups",
    });
    // No kinds declared under a live risk: one error for the card, and no card.
    const bare = lintCard(card({ risk: "the deploy can still delete backups" }));
    expect(bare.problems).toEqual([{
      level: "error", code: "kinds_needed_on_live_risk", where: "options",
      text: "a card with a live risk marks each option stop or continue (… | stop), so what happens if he does not answer is declared, not guessed",
    }]);
    expect(bare.card).toBeNull();
    // A continue default is refused and a stop default is clean, whatever the words say.
    for (const label of ["Don't stop", "Never stop", "No change", "Do not roll back", "Let it run", "Keep waiting", "Hold until Monday"])
      expect(lintCard(underRisk("continue", label)).problems.map(p => `${p.code} ${p.where}`), label)
        .toEqual(["continue_default_on_live_risk default"]);
    for (const label of ["Keep it paused", "Hold, continue later", "Do not proceed", "Merge now", "Don't stop"])
      expect(lintCard(underRisk("stop", label)).problems, label).toEqual([]);
    // Without a risk no kinds are needed, a continue default is fine, and a kind that is neither word is refused.
    expect(lintCard(card({
      recommend: "go",
      options: [
        { key: "go", label: "Keep going", kind: "continue" },
        { key: "hold", label: "Hold until Monday", kind: "continue" },
      ],
      default: "go",
    })).problems).toEqual([]);
    expect(codes(card({
      options: [
        { key: "merge", label: "Merge now", kind: "pause" },
        { key: "hold", label: "Hold until Monday" },
      ],
    }))).toEqual(["bad_option_kind option merge"]);
  });

  it("cardText never prints a kind", () => {
    const withKinds = lintCard(card({
      recommend: "go",
      options: [
        { key: "go", label: "Keep going", kind: "continue" },
        { key: "hold", label: "Hold until Monday", kind: "stop" },
      ],
      default: "hold",
      risk: "the migration has no rollback yet",
    }));
    expect(withKinds.problems).toEqual([]);
    const lines = cardText(withKinds.card!);
    expect(lines).toEqual([
      "The release is ready to merge.",
      "Recommended: Keep going",
      "If you don't answer: Hold until Monday",
      "Live risk: the migration has no rollback yet",
      "[buttons ny-80] go=Keep going | hold=Hold until Monday",
    ]);
    // The kind is for lint, not for the principal: neither word appears, and the only bars are the buttons line's.
    for (const line of lines) expect(/\b(?:stop|continue)\b/.test(line)).toBe(false);
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
    const lines = cardText(lintCard(card({
      risk: "the migration has no rollback yet",
      options: [
        { key: "merge", label: "Merge now", kind: "continue" },
        { key: "hold", label: "Hold until Monday", kind: "stop" },
      ],
    })).card!);
    expect(lines.every(l => !BREAKS.some(b => l.includes(b)))).toBe(true);
    expect(lines.filter(l => l.startsWith("[buttons"))).toEqual([lines.at(-1)]);
  });

  it("no text field holds a control, a line separator, a bidi override or a zero-width character", () => {
    // Each of HOSTILE, in each field the card prints: the card is refused with an error naming that field.
    const fields = [
      ["outcome", "outcome_not_one_line", "outcome", (c: string) => ({ outcome: `a${c}b` })],
      ["option label", "bad_option_label", "option merge", (c: string) => ({
        options: [{ key: "merge", label: `a${c}b` }, { key: "hold", label: "Hold until Monday" }],
      })],
      ["risk", "risk_not_one_line", "risk", (c: string) => ({ risk: `a${c}b` })],
    ] as const;
    for (const c of HOSTILE) {
      const name = `U+${c.codePointAt(0)!.toString(16)}`;
      for (const [field, code, where, over] of fields) {
        const lint = lintCard(card(over(c)));
        expect(lint.problems.map(p => `${p.code} ${p.where}`), `${field} holds ${name}`).toContain(`${code} ${where}`);
        expect(lint.card, `${field} holds ${name}`).toBeNull();
      }
    }
  });

  // The invisible and look-alike characters beyond the first set (T-307 review): each group on its own, in each field the
  // card prints, and echoed escaped in a problem's text, the astral ones whole as \u{...}.
  const INVISIBLE: [string, string[], string[]][] = [
    ["the left-to-right and right-to-left marks", ["\u{200E}", "\u{200F}"], ["\\u200e", "\\u200f"]],
    ["the Arabic letter mark", ["\u{061C}"], ["\\u061c"]],
    ["the word joiner", ["\u{2060}"], ["\\u2060"]],
    ["the soft hyphen", ["\u{00AD}"], ["\\u00ad"]],
    ["the Hangul fillers", ["\u{115F}", "\u{1160}", "\u{3164}", "\u{FFA0}"], ["\\u115f", "\\u1160", "\\u3164", "\\uffa0"]],
    ["the tag characters", ["\u{E0000}", "\u{E0001}", "\u{E0041}", "\u{E007F}"], ["\\u{e0000}", "\\u{e0001}", "\\u{e0041}", "\\u{e007f}"]],
  ];
  it.each(INVISIBLE)("%s: refused in every text field, and echoed escaped", (_group, chars, escapes) => {
    const fields = [
      ["outcome", "outcome_not_one_line", "outcome", (c: string) => ({ outcome: `a${c}b` })],
      ["option label", "bad_option_label", "option merge", (c: string) => ({ options: [{ key: "merge", label: `a${c}b` }, { key: "hold", label: "Hold until Monday" }] })],
      ["risk", "risk_not_one_line", "risk", (c: string) => ({ risk: `a${c}b` })],
    ] as const;
    chars.forEach((c, i) => {
      const name = `U+${c.codePointAt(0)!.toString(16)}`;
      for (const [field, code, where, over] of fields) {
        const lint = lintCard(card(over(c)));
        expect(lint.problems.map(p => `${p.code} ${p.where}`), `${field} holds ${name}`).toContain(`${code} ${where}`);
        expect(lint.card, `${field} holds ${name}`).toBeNull();
      }
      // Echoed in a problem (an unknown recommended option): escaped, never raw, and the problem stays one visible line.
      const echo = lintCard(card({ recommend: `go${c}ahead` }));
      const text = echo.problems.map(p => p.text).join(" ");
      expect(text, `echo of ${name}`).toContain(escapes[i]!);
      expect(text.includes(c), `echo of ${name} is not raw`).toBe(false);
    });
  });

  // No list of characters (T-307 review): the Unicode properties decide. Every code point the standard marks Default_Ignorable
  // (the invisible function characters, variation selectors, the Hangul fillers, the tag characters), every format character
  // (Cf) and every control (Cc) is refused in each text field and echoed escaped; ordinary text from any script passes.
  it("every Default_Ignorable, Cf and Cc code point is refused in every text field, and echoed escaped", () => {
    const hidden = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}]/u;
    const points: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;                    // a lone surrogate is no character
      const c = String.fromCodePoint(cp);
      if (hidden.test(c)) points.push(c);
    }
    expect(points.length).toBeGreaterThan(4000);                       // the property really was walked
    const missed: string[] = [];
    for (const c of points) {
      const name = `U+${c.codePointAt(0)!.toString(16)}`;
      const fields = [
        lintCard(card({ outcome: `a${c}b` })).card,
        lintCard(card({ options: [{ key: "merge", label: `a${c}b` }, { key: "hold", label: "Hold until Monday" }] })).card,
        lintCard(card({ risk: `a${c}b` })).card,
      ];
      if (fields.some(f => f !== null)) missed.push(name);
      const echo = lintCard(card({ recommend: `go${c}ahead` })).problems.map(p => p.text).join(" ");
      if (echo.includes(c) || !echo.includes("\\")) missed.push(`${name} echo`);    // never raw, always an escape (JSON's \n or \uXXXX)
    }
    expect(missed).toEqual([]);
    // The ones the review named, by name: invisible operators, the combining grapheme joiner, the Mongolian vowel separator,
    // the emoji variation selector.
    for (const c of ["\u{2061}", "\u{2062}", "\u{2063}", "\u{2064}", "\u{034F}", "\u{180E}", "\u{FE0F}"]) {
      expect(lintCard(card({ outcome: `a${c}b` })).card, `U+${c.codePointAt(0)!.toString(16)}`).toBeNull();
    }
  });

  it("ordinary text passes: punctuation, umlauts, CJK, accents and plain symbols", () => {
    for (const text of ["Hold, continue later", "Zürich äöüß, naïve café", "你好，世界", "Ship it ✅ — Tuesday", "Fiancée’s “quote” (50%)"]) {
      const lint = lintCard(card({ outcome: text, risk: text, options: [{ key: "merge", label: text.slice(0, 30), kind: "continue" }, { key: "hold", label: "Hold until Monday", kind: "stop" }] }));
      expect(lint.problems.filter(p => p.level === "error"), text).toEqual([]);
    }
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
    // And one that neither breaks the line nor shows: a bidi override and a zero-width character, echoed escaped.
    const hiddenEcho = lintCard(card({ recommend: "go\u{202E}ahead", default: "go\u{200B}on" }));
    expect(hiddenEcho.problems.map(p => `${p.code} ${p.where}`)).toEqual(["recommend_unknown recommend", "default_unknown default"]);
    expect(hiddenEcho.problems[0]!.text).toContain("\\u202e");
    expect(hiddenEcho.problems[1]!.text).toContain("\\u200b");
    const hiddenKeys = lintCard(card({
      options: [
        { key: "a\u{202E}b", label: "Merge now" },
        { key: "c\u{200B}d", label: "Hold until Monday" },
      ],
    }));
    expect(hiddenKeys.problems.map(p => `${p.code} ${p.where}`)).toEqual(["bad_option_key option 0", "bad_option_key option 1"]);
    for (const p of [...echoed.problems, ...keys.problems, ...hiddenEcho.problems, ...hiddenKeys.problems]) {
      expect(oneLineText(p.text), `${p.code} text`).toBe(true);
      expect(oneLineText(p.where), `${p.code} where`).toBe(true);
      for (const c of ["\u{202E}", "\u{200B}"]) {
        expect(p.text.includes(c), `${p.code} text`).toBe(false);
        expect(p.where.includes(c), `${p.code} where`).toBe(false);
      }
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

describe("jargonIn", () => {
  it("jargonIn finds a tracker number, a commit hash and an ask id, in order", () => {
    expect(jargonIn("see #96 and 5b354d6, ny-538")).toEqual(["#96", "5b354d6", "ny-538"]);
  });

  it("jargonIn leaves a word of letters alone and a plain number alone", () => {
    expect(jargonIn("defaced")).toEqual([]);
    expect(jargonIn("1234567")).toEqual([]);
  });
});
