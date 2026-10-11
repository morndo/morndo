// Decision briefs (ADR-0023): lintBrief's rules, DB1 to DB10, each shown to refuse by one change to the guide's valid
// example (docs/agents/decision-requests.md), so a lint that stops refusing fails here (the design's mutation table,
// §7). The example itself is the fixture; every mutation is one rule broken.
import { describe, expect, it } from "vitest";
import {
  askFromBrief, askVersion, briefMarkdown, cardOf, Escalations, escalationId, endpointId, hasMoney, HUB_TTL_MS,
  KEEP_SETTLED_MS, lintBrief, refusal, sessionId,
  type Ask, type BriefProblem, type DecisionBrief, type Sighting, type SourceState,
} from "../src/index.ts";

// The guide's example is dated: `now` is fixed at 2026-10-01, its due is the end of 2026-10-14 (a date alone is the end
// of its day, as the template adapter will read it).
const NOW = Date.UTC(2026, 9, 1, 8, 0);
const DUE = Date.UTC(2026, 9, 14, 23, 59, 59, 999);

const example = (): Record<string, unknown> => ({
  topic: "Support inbox triage",
  due: DUE,
  minutes: 4,
  headline: "Approve option B: extend the in-house triage script",
  recommend: "b",
  ask: {
    text: "Approve **$2,400** of contractor time and **6 agent-days** to extend the in-house triage script so it tags and routes new tickets. It starts paying back in about **3 weeks** and saves an estimated **5 staff hours a week**.",
    alternative: "buy the hosted add-on (C) for **$180 a month**; it starts faster and costs more from month 14.",
    uncertainty: "the saving comes from a two-week sample of 310 tickets.",
  },
  whyNow: "- Tickets waiting more than a day rose from 9 to 23 a week over the last month.\n- The contractor who wrote the script has a free slot from 2026-10-20 to 2026-11-07; the next one is in January.\n- A decision by 2026-10-14 keeps that slot.",
  options: [
    { key: "a", label: "Keep manual triage" },
    { key: "b", label: "Extend the triage script" },
    { key: "c", label: "Buy a hosted add-on" },
  ],
  comparison: {
    rows: [
      { factor: "Expected outcome", cells: ["The backlog keeps growing at today's rate", "Most tickets tagged and routed on arrival", "As B, plus a reporting view"] },
      { factor: "Year-one cost", cells: ["$0", "$2,400", "$2,160"] },
      { factor: "Ongoing cost", cells: ["5 staff hours a week", "About 1 agent-day a quarter", "$180 a month"] },
      { factor: "Internal effort", cells: ["none", "6 agent-days", "2 agent-days to set up"] },
      { factor: "Time to benefit", cells: ["none", "3 weeks", "1 week"] },
      { factor: "Measured benefit", cells: ["none (the baseline)", "Estimated 5 h a week, from the sample", "Estimated 4 h a week, from a vendor trial"] },
      { factor: "Principal drawback", cells: ["Waiting times keep rising", "We maintain the script", "Ticket text leaves our systems"] },
    ],
    note: "costs are cash only, without tax. Agent-days and staff hours are not priced.",
  },
  why: {
    text: "B gets most of C's benefit, keeps ticket text in our own systems, and costs less than C from month 14. A is right only if the backlog shrinks by itself, and nothing in the last month points to that.",
    assumptions: [
      "The contractor's quote of $2,400 is a fixed price (the quote is linked below).",
      "The saving seen in the two-week sample holds for every ticket type.",
    ],
    downside: "if the saving is only 2 hours a week, B still beats A, but C's reporting view would have been worth more; we would switch to C at the review point, having spent the $2,400.",
  },
  changeIf: "If the script tags fewer than 60% of tickets correctly in its first week, stop B and choose C.",
  risk: {
    risk: "the script routes an urgent ticket to the wrong queue.",
    control: "for the first two weeks a person checks every ticket tagged urgent before it is routed, and the error rate is posted daily.",
  },
  authorizes: {
    limits: ["Up to $2,400 with the contractor, at a fixed price.", "Up to 6 agent-days on the script and its tests."],
    freshApproval: "any spend above $2,400, a new vendor, or sending ticket text outside our systems.",
    reviewPoint: "2026-11-07, on tagging accuracy and hours saved, against the 60% line above.",
  },
  ifNoAnswer: "The contractor's slot lapses. We keep manual triage (A) and ask again in January.",
  evidence: [
    { label: "Two-week triage sample", url: "https://example.com/triage-sample" },
    { label: "Contractor quote", url: "https://example.com/contractor-quote" },
    { label: "Hosted add-on trial notes", url: "https://example.com/addon-trial" },
  ],
  blocking: false,
  project: "support",
  task: null,
  ref: null,
});

// Lint one mutation of the example: `over` changes fields on a deep copy.
const lint = (over: (draft: Record<string, unknown>) => void, now = NOW): { brief: unknown; problems: BriefProblem[] } => {
  const draft = structuredClone(example());
  over(draft);
  return lintBrief(draft, now);
};
// The problems as one line each, "level code (where)", in order: what a refusal prints.
const lines = (over: (draft: Record<string, unknown>) => void, now = NOW): string[] =>
  lint(over, now).problems.map(p => `${p.level} ${p.code} (${p.where})`);

describe("DB6: the brief's shape", () => {
  it("the guide's example passes with no problems", () => {
    const r = lint(() => {});
    expect(r.problems).toEqual([]);
    expect(r.brief).not.toBe(null);
  });
  it("a required section that is missing is refused", () => {
    expect(lines(d => { delete d.whyNow; })).toEqual(["error missing_section (whyNow)"]);
  });
  it("a section the template doesn't have is refused, so a typo never hides one", () => {
    expect(lines(d => { (d as Record<string, unknown>)["why now"] = "soon"; })).toEqual(["error unknown_section (why now)"]);
  });
  it("a section that is present but empty is refused", () => {
    expect(lines(d => { d.changeIf = "  "; })).toEqual(["error empty_section (changeIf)"]);
  });
  it("a nested section is checked leaf by leaf", () => {
    expect(lines(d => { d.risk = { risk: "the script routes an urgent ticket to the wrong queue." }; }))
      .toEqual(["error missing_section (risk.control)"]);
  });
  it("not an object at all is refused in one line", () => {
    const r = lintBrief("approve something", NOW);
    expect(r.brief).toBe(null);
    expect(r.problems.map(p => `${p.level} ${p.code} (${p.where})`)).toEqual(["error missing_section (root)"]);
  });
});

describe("caps (section 4.3)", () => {
  it("a topic past 60 characters is refused", () => {
    expect(lines(d => { d.topic = "T".repeat(61); })).toEqual(["error too_long (topic)"]);
  });
  it("a cell past 120 characters is refused, with its place named", () => {
    expect(lines(d => {
      const rows = (d.comparison as { rows: { factor: string; cells: string[] }[] }).rows;
      rows[2]!.cells[1] = "x".repeat(121);
    })).toEqual(["error too_long (comparison.rows[2].cells[1])"]);
  });
  it("a whole brief past 16 KB as JSON is refused", () => {
    expect(lines(d => { d.ifNoAnswer = "x".repeat(17_000); })).toContain("error too_long (brief)");
  });
  it("a control character is refused, also where it breaks the one-line fields", () => {
    expect(lines(d => { d.headline = `Approve option B:${"\n"}extend the triage script`; })).toEqual(["error control_char (headline)"]);
    expect(lines(d => {
      (d.ask as { text: string }).text = "Approve \u0000 of contractor time.";
    })).toEqual(["error control_char (ask.text)"]);
  });
  it("a paragraph break is allowed in the prose fields", () => {
    expect(lines(d => { (d.ask as { text: string }).text = `${"Approve **$2,400** of contractor time."}\n\nIt pays back in **3 weeks**.`; })).toEqual([]);
  });
});

describe("DB1: two to six options, in the manager protocol's grammar", () => {
  const relabel = (d: Record<string, unknown>, i: number, label: string) => {
    ((d.options as { key: string; label: string }[])[i]!).label = label;
  };
  it("a lone option is refused: a decision needs a real choice", () => {
    expect(lines(d => { d.options = (d.options as unknown[]).slice(0, 1); })).toEqual(["error no_options (options)"]);
  });
  it("seven options are refused", () => {
    expect(lines(d => {
      const more = (d.options as { key: string; label: string }[]).map(o => ({ ...o }));
      for (let i = more.length; i < 7; i++) more.push({ key: `x${i}`, label: `Extra option ${i}` });
      d.options = more;
    })).toEqual(["error too_many_options (options)"]);
  });
  it("a key outside the grammar is refused, with its place", () => {
    expect(lines(d => { ((d.options as { key: string; label: string }[])[0]!).key = "not a key!"; }))
      .toEqual(["error bad_option (options[0])"]);
  });
  it("a key past 16 characters is refused", () => {
    expect(lines(d => { ((d.options as { key: string; label: string }[])[0]!).key = "extend-the-triage-script"; }))
      .toEqual(["error bad_option (options[0])"]);
  });
  it("a repeated key is refused", () => {
    expect(lines(d => { ((d.options as { key: string; label: string }[])[2]!).key = "a"; }))
      .toEqual(["error duplicate_option (options[2])"]);
  });
  it("an empty label is refused", () => {
    expect(lines(d => { relabel(d, 0, ""); })).toEqual(["error bad_option (options[0])"]);
  });
  it("a label past 40 characters is refused as a cap", () => {
    expect(lines(d => { relabel(d, 0, "L".repeat(41)); })).toEqual(["error too_long (options[0].label)"]);
  });
  it("a missing options list is refused as a missing section", () => {
    expect(lines(d => { delete d.options; })).toEqual(["error missing_section (options)"]);
  });
});

describe("DB2: one recommendation, named in the headline", () => {
  it("a recommend that is not an option key is refused", () => {
    expect(lines(d => { d.recommend = "d"; })).toEqual(["error no_recommendation (recommend)"]);
    expect(lines(d => { delete d.recommend; })).toEqual(["error no_recommendation (recommend)"]);
  });
  it("a headline that names another option is refused, in words the design spells (§5.1)", () => {
    const r = lint(d => { d.headline = "Approve option C: buy the hosted add-on"; });
    expect(r.problems).toEqual([{
      level: "error", code: "headline_option", where: "headline",
      text: "the headline names option C, but recommend is b; name the option you recommend",
    }]);
  });
  it("a headline that names no option is refused", () => {
    expect(lines(d => { d.headline = "Approve the extension of the triage script"; }))
      .toEqual(["error headline_option (headline)"]);
  });
  it("a headline that names two options is refused", () => {
    expect(lines(d => { d.headline = "Approve option B or option C"; }))
      .toEqual(["error headline_option (headline)"]);
  });
  it("the key in the headline may be any case", () => {
    expect(lines(d => { d.headline = "approve option b: extend the in-house triage script"; })).toEqual([]);
  });
});

describe("DB3: a due time after filing, and the minutes to read and decide", () => {
  it("a missing due is refused", () => {
    expect(lines(d => { delete d.due; })).toEqual(["error no_due (due)"]);
  });
  it("a due that is not a time is refused", () => {
    expect(lines(d => { d.due = "2026-10-14"; })).toEqual(["error bad_due (due)"]);
  });
  it("a due at or before now is refused", () => {
    expect(lines(d => { d.due = NOW - 1; }, NOW)).toEqual(["error due_past (due)"]);
    expect(lines(d => { d.due = NOW; }, NOW)).toEqual(["error due_past (due)"]);
  });
  it("the minutes are refused when missing, not whole, or outside 1 to 30", () => {
    expect(lines(d => { delete d.minutes; })).toEqual(["error bad_minutes (minutes)"]);
    expect(lines(d => { d.minutes = 4.5; })).toEqual(["error bad_minutes (minutes)"]);
    expect(lines(d => { d.minutes = 0; })).toEqual(["error bad_minutes (minutes)"]);
    expect(lines(d => { d.minutes = 31; })).toEqual(["error bad_minutes (minutes)"]);
  });
});

describe("DB4: one column per option, three to ten factor rows, a note", () => {
  const rows = (d: Record<string, unknown>) => (d.comparison as { rows: { factor: string; cells: string[] }[] }).rows;
  it("a row with a cell short is refused: an option has no column", () => {
    expect(lines(d => { rows(d)[1]!.cells = rows(d)[1]!.cells.slice(0, 2); })).toEqual(["error table_columns (comparison.rows[1])"]);
  });
  it("a row with a cell extra is refused: a column has no option", () => {
    expect(lines(d => { rows(d)[1]!.cells = [...rows(d)[1]!.cells, "extra"]; })).toEqual(["error table_columns (comparison.rows[1])"]);
  });
  it("cells that are not a list are refused", () => {
    expect(lines(d => { (rows(d)[0]! as { factor: string; cells: string[] }).cells = "none" as unknown as string[]; }))
      .toEqual(["error table_columns (comparison.rows[0])"]);
  });
  it("an empty cell is refused: \"n/a\" is a value, an empty cell is not", () => {
    expect(lines(d => { rows(d)[3]!.cells[1] = " "; })).toEqual(["error empty_cell (comparison.rows[3].cells[1])"]);
  });
  it("\"n/a\" and \"none\" are values, not empty cells", () => {
    expect(lines(d => { rows(d)[3]!.cells[2] = "n/a"; rows(d)[4]!.cells[0] = "none"; })).toEqual([]);
  });
  it("two factor rows are refused, and so are eleven", () => {
    expect(lines(d => { (d.comparison as { rows: unknown[] }).rows = rows(d).slice(0, 2); })).toEqual(["error table_rows (comparison.rows)"]);
    expect(lines(d => {
      const more = [...rows(d)];
      for (let i = more.length; i < 11; i++) more.push({ factor: `Extra factor ${i}`, cells: ["x", "y", "z"] });
      (d.comparison as { rows: unknown[] }).rows = more;
    })).toEqual(["error table_rows (comparison.rows)"]);
  });
  it("a missing rows list is refused as a missing section", () => {
    expect(lines(d => { delete (d.comparison as { rows?: unknown }).rows; })).toEqual(["error missing_section (comparison.rows)"]);
  });
  it("a missing or blank note is refused", () => {
    expect(lines(d => { delete (d.comparison as { note?: string }).note; })).toEqual(["error no_table_note (comparison.note)"]);
    expect(lines(d => { (d.comparison as { note: string }).note = "  "; })).toEqual(["error no_table_note (comparison.note)"]);
  });
});

describe("DB5: money needs its assumptions, every brief a downside case", () => {
  it("money anywhere with no stated assumption is refused", () => {
    expect(lines(d => { (d.why as { assumptions: string[] }).assumptions = []; }))
      .toEqual(["error money_without_assumption (why.assumptions)"]);
  });
  it("money in one cell alone is enough to require the assumptions", () => {
    expect(lines(d => {
      (d.why as { assumptions: string[] }).assumptions = [];
      ((d.comparison as { rows: { factor: string; cells: string[] }[] }).rows[1]!).cells[0] = "from $0 to $900";
    })).toEqual(["error money_without_assumption (why.assumptions)"]);
  });
  it("a missing downside case is refused", () => {
    expect(lines(d => { delete (d.why as { downside?: string }).downside; })).toEqual(["error no_downside (why.downside)"]);
    expect(lines(d => { (d.why as { downside: string }).downside = " "; })).toEqual(["error no_downside (why.downside)"]);
  });
  it("assumptions may be empty when no money appears", () => {
    expect(lines(d => {
      (d.why as { assumptions: string[] }).assumptions = [];
      (d.ask as { text: string; alternative: string }).text = "Approve **6 agent-days** to extend the in-house triage script. It pays back in about **3 weeks**.";
      (d.ask as { text: string; alternative: string }).alternative = "buy the hosted add-on (C); it starts faster and costs more from month 14.";
      ((d.comparison as { rows: { factor: string; cells: string[] }[] }).rows[1]!).cells = ["none", "6 agent-days", "a subscription"];
      ((d.comparison as { rows: { factor: string; cells: string[] }[] }).rows[2]!).cells = ["5 staff hours a week", "About 1 agent-day a quarter", "a subscription"];
      (d.why as { text: string }).text = "B keeps ticket text in our own systems. A is right only if the backlog shrinks by itself, and nothing in the last month points to that.";
      (d.why as { assumptions: string[] }).assumptions = [];
      (d.authorizes as { limits: string[] }).limits = ["Up to 6 agent-days on the script and its tests."];
      (d.authorizes as { freshApproval: string }).freshApproval = "a new vendor, or sending ticket text outside our systems.";
      (d.why as { downside: string }).downside = "if the saving is only 2 hours a week, B still beats A; we would stop at the review point.";
    })).toEqual([]);
  });
});

describe("the money pattern (design §4.2)", () => {
  // The pattern is exported for the compact card (cardOf): one place decides what counts as spend.
  const money = (text: string) => hasMoney(text);
  it.each([
    ["$2,400", true], ["€180", true], ["£30", true], ["¥9,000", true], ["₹4 lakh in $ terms", true],
    ["2.4k EUR", true], ["$0", true], ["$2,400.", true], ["up to $900", true], ["2400$", true], ["180 EUR", true], ["about 2.4k USD", true],
  ])("%s is money", (text, want) => expect(money(text)).toBe(want));
  it.each([
    ["3 weeks", false], ["6 agent-days", false], ["5 staff hours a week", false], ["60% of tickets", false],
    ["from 9 to 23 a week", false], ["month 14", false], ["EUR without a number", false], ["the k factor", false], ["5 min", false],
  ])("%s is not money", (text, want) => expect(money(text)).toBe(want));
});

describe("DB7: prose in the brief's markdown subset", () => {
  it("a heading of the asker's own is refused: the format owns the outline", () => {
    expect(lines(d => { d.whyNow = `## The backlog\n- Tickets waiting more than a day rose from 9 to 23 a week.`; }))
      .toEqual(["error bad_markdown (whyNow)"]);
  });
  it("raw HTML is refused", () => {
    expect(lines(d => { (d.ask as { text: string }).text = "Approve <b>$2,400</b> of contractor time."; }))
      .toEqual(["error bad_markdown (ask.text)"]);
  });
  it("an image is refused", () => {
    expect(lines(d => { (d.why as { text: string }).text = "B gets most of C's benefit. ![chart](https://example.com/chart.png)"; }))
      .toEqual(["error bad_markdown (why.text)"]);
  });
  it("a link that is not https is refused", () => {
    expect(lines(d => { (d.ask as { text: string }).text = "Approve [the quote](http://example.com/quote) money."; }))
      .toEqual(["error bad_link (ask.text)"]);
  });
  it("an https link, bold, a list, a quote and a fenced block are the subset", () => {
    expect(lines(d => {
      (d.why as { text: string }).text = [
        "B gets most of C's benefit, as the [sample](https://example.com/triage-sample) shows.",
        "",
        "> Costs less than C from month 14.",
        "",
        "```",
        "tag-rate 0.62",
        "```",
      ].join("\n");
    })).toEqual([]);
  });
  it("an evidence url that is not https is refused", () => {
    expect(lines(d => { ((d.evidence as { label: string; url: string }[])[0]!).url = "http://example.com/triage-sample"; }))
      .toEqual(["error bad_link (evidence[0].url)"]);
  });
});

describe("warnings: a weak brief comes back with its brief (DB10)", () => {
  it("no evidence listed is a warning", () => {
    expect(lines(d => { d.evidence = []; })).toEqual(["warning no_evidence (evidence)"]);
    expect(lines(d => { delete d.evidence; })).toEqual(["warning no_evidence (evidence)"]);
  });
  it("an ask without a number in bold is a warning: the principal reads the numbers first", () => {
    expect(lines(d => {
      (d.ask as { text: string }).text = "Approve $2,400 of contractor time and 6 agent-days to extend the triage script.";
    })).toEqual(["warning ask_no_bold_figure (ask.text)"]);
  });
  it("a why-now that names no date or time is a warning", () => {
    expect(lines(d => { d.whyNow = "- Tickets waiting more than a day rose sharply over the last month."; }))
      .toEqual(["warning why_now_no_date (whyNow)"]);
  });
  it("a change-if with no number or date in it is a warning", () => {
    expect(lines(d => { d.changeIf = "If the tagging turns out to be poor, stop and choose the add-on."; }))
      .toEqual(["warning change_if_vague (changeIf)"]);
  });
  it("minutes below the reading time are a warning", () => {
    expect(lines(d => { d.minutes = 2; })).toEqual(["warning minutes_low (minutes)"]);
  });
  it("a warning never refuses: the brief still comes back", () => {
    const r = lint(d => { d.evidence = []; });
    expect(r.brief).not.toBe(null);
    expect(r.problems.map(p => p.level)).toEqual(["warning"]);
  });
});

describe("the compact card, derived for every Ask (§4.4)", () => {
  const brief = (): DecisionBrief => lintBrief(example(), NOW).brief!;      // the guide's example, money in it
  // The example with every money figure scrubbed out: the same brief, without spend.
  const noMoney = (): DecisionBrief => {
    const b = brief();
    const row = (i: number, cells: string[]) => ({ factor: b.comparison.rows[i]!.factor, cells });
    return {
      ...b,
      ask: { text: "Approve **6 agent-days** to extend the in-house triage script.", alternative: "buy the hosted add-on (C); it starts faster and costs more from month 14.", uncertainty: b.ask.uncertainty },
      comparison: { rows: b.comparison.rows.map((r, i) => i === 1 ? row(1, ["none", "6 agent-days", "a subscription"]) : i === 2 ? row(2, ["5 staff hours a week", "About 1 agent-day a quarter", "a subscription"]) : r), note: "costs are effort only; nothing is priced." },
      why: { ...b.why, text: "B gets most of C's benefit and keeps ticket text in our own systems.", assumptions: ["The saving seen in the two-week sample holds for every ticket type."], downside: "if the saving is only 2 hours a week, we would stop at the review point." },
      authorizes: { ...b.authorizes, limits: ["Up to 6 agent-days on the script and its tests."], freshApproval: "a new vendor, or sending ticket text outside our systems." },
    };
  };
  const ask = (over: Partial<Ask> = {}): Ask => ({
    id: escalationId("d-1"), asker: { kind: "manager", name: "Manager", workerId: null }, need: "decision",
    title: "Pick the weekday for the newsletter", shortTitle: null, summary: null, minutes: null, link: null, details: null,
    context: null, contextKind: "markdown", options: [], answerBy: "tap", recommendation: null, ifNoAnswer: null,
    deadline: null, blocking: false, project: null, askedAt: NOW, messageId: null, tracking: "age", ...over,
  });

  it("a brief with spend: read and decide, no quick answers (owner decision Q2's default)", () => {
    expect(cardOf({ ...ask(), brief: brief() })).toEqual({
      topic: "Support inbox triage", headline: "Approve option B: extend the in-house triage script",
      recommended: "Extend the triage script", due: DUE, minutes: 4, spend: true, quickAnswers: [], hasBrief: true,
    });
  });
  it("a brief without spend: the quick answers are its options, the recommended one first", () => {
    expect(cardOf({ ...ask(), brief: noMoney() })).toEqual({
      topic: "Support inbox triage", headline: "Approve option B: extend the in-house triage script",
      recommended: "Extend the triage script", due: DUE, minutes: 4, spend: false,
      quickAnswers: [
        { key: "b", label: "Extend the triage script" },
        { key: "a", label: "Keep manual triage" },
        { key: "c", label: "Buy a hosted add-on" },
      ],
      hasBrief: true,
    });
  });
  it("a plain ask with the short form: card from its own fields", () => {
    const a = ask({
      shortTitle: "Newsletter send day", summary: "Pick the weekday", minutes: 2, deadline: DUE,
      options: [{ key: "tue", label: "Tuesday", detail: null }, { key: "thu", label: "Thursday", detail: null }],
    });
    expect(cardOf({ ...a, brief: null })).toEqual({
      topic: "Newsletter send day", headline: "Pick the weekday", recommended: "Tuesday", due: DUE, minutes: 2,
      spend: false, quickAnswers: [{ key: "tue", label: "Tuesday" }, { key: "thu", label: "Thursday" }], hasBrief: false,
    });
  });
  it("a plain ask with only a long title: the first clause is the topic, the rest is the headline", () => {
    const a = ask({ title: "Should we ship the release candidate today, or wait?" });
    const card = cardOf({ ...a, brief: null });
    expect(card.topic).toBe("Should we ship the release candidate today, or wait?");
    expect(card.headline).toBe(null);
    expect(card.recommended).toBe(null);
    expect(card.quickAnswers).toEqual([]);
    const b = ask({ title: "Pick the send day: Tuesday or Thursday for the newsletter?" });
    expect(cardOf({ ...b, brief: null }).topic).toBe("Pick the send day");
    expect(cardOf({ ...b, brief: null }).headline).toBe("Tuesday or Thursday for the newsletter?");
  });
  it("a long title past 60 characters is cut at a word; the whole text becomes the headline (§4.4)", () => {
    const a = ask({ title: "Should we ship the release candidate today together with the migration, or wait for Monday?" });
    const card = cardOf({ ...a, brief: null });
    expect(card.topic.length).toBeLessThanOrEqual(60);
    expect(card.topic.endsWith("…")).toBe(true);
    expect(card.topic.startsWith("Should we ship the release candidate today")).toBe(true);
    expect(card.headline).toBe("Should we ship the release candidate today together with the migration, or wait for Monday?");
  });
  it("a plain ask that mentions money says so", () => {
    const a = ask({ title: "Spend $2,400 on the contractor", summary: "Approve the quote" });
    expect(cardOf({ ...a, brief: null }).spend).toBe(true);
  });
  it("an ask answered in words has no quick answers and no recommendation", () => {
    const a = ask({ answerBy: "words", title: "Where should the demo point?" });
    const card = cardOf({ ...a, brief: null });
    expect(card.quickAnswers).toEqual([]);
    expect(card.recommended).toBe(null);
  });
  it("a time item carries its minutes and deadline only", () => {
    const a = ask({ need: "time", title: "Review the release notes", minutes: 10, deadline: DUE, answerBy: "words" });
    expect(cardOf({ ...a, brief: null })).toEqual({
      topic: "Review the release notes", headline: null, recommended: null, due: DUE, minutes: 10,
      spend: false, quickAnswers: [], hasBrief: false,
    });
  });
});

describe("E14: an ask the hub tracks is answerable until the hub withdraws or settles it", () => {
  const MIN = 60_000;
  const hubAsk = (over: Partial<Ask> = {}): Ask => ({
    id: escalationId("d-1"), asker: { kind: "manager", name: "Manager", workerId: null }, need: "decision",
    title: "Approve option B: extend the in-house triage script", shortTitle: "Support inbox triage", summary: null,
    minutes: 4, link: null, details: "the brief, as markdown", context: null, contextKind: "markdown",
    options: [{ key: "b", label: "Extend the triage script", detail: null }], answerBy: "tap",
    recommendation: null, ifNoAnswer: null, deadline: DUE, blocking: false, project: null,
    askedAt: NOW, messageId: null, tracking: "hub", ...over,
  });
  const seen = (a: Ask, source: SourceState = { kind: "open" }): Sighting => ({ ask: a, source, answered: null });

  it("stays open and answerable while the hub holds it, even when a round of sightings misses it", () => {
    const x = new Escalations();
    x.reconcile([seen(hubAsk())], NOW, true);
    expect(x.get("d-1")?.status).toBe("open");
    x.reconcile([seen(hubAsk(), { kind: "missing" })], NOW + MIN, true);
    expect(x.get("d-1")?.status).toBe("open");            // a missing sighting is not a withdrawal
    expect(refusal(x.get("d-1"), NOW + MIN)).toBe(null);
  });
  it("overdue is not expired: it stays answerable past its due time", () => {
    const x = new Escalations();
    x.reconcile([seen(hubAsk())], NOW, true);
    const overdue = DUE + 6 * 24 * 3_600_000;
    expect(refusal(x.get("d-1"), overdue)).toBe(null);
    expect(x.check("d-1", { kind: "option", key: "b" }, overdue).ok).toBe(true);
  });
  it("expires seven days after its due time, and an answer is then refused", () => {
    const x = new Escalations();
    x.reconcile([seen(hubAsk())], NOW, true);
    expect(x.get("d-1")?.status).toBe("open");
    x.reconcile([seen(hubAsk())], DUE + HUB_TTL_MS, true);
    expect(x.get("d-1")?.status).toBe("expired");
    expect(refusal(x.get("d-1"), DUE + HUB_TTL_MS)).toBe("expired");
  });
  it("the asker's withdraw or settle ends it before that", () => {
    const x = new Escalations();
    x.reconcile([seen(hubAsk())], NOW, true);
    x.reconcile([seen(hubAsk(), { kind: "settled", resolution: "Withdrawn: the question went away", at: NOW + MIN })], NOW + MIN, true);
    expect(x.get("d-1")?.status).toBe("settled");
    expect(refusal(x.get("d-1"), NOW + MIN)).toBe("settled");
  });
  it("an ask no round of sightings reports still ends by its due, not by the day of its message", () => {
    const x = new Escalations();
    x.reconcile([seen(hubAsk())], NOW, true);
    expect(x.reconcile([], DUE + HUB_TTL_MS - 1, true)).toBe(false);
    expect(x.get("d-1")?.status).toBe("open");
    x.reconcile([], DUE + HUB_TTL_MS, true);
    expect(x.get("d-1")?.status).toBe("expired");
  });
});

describe("DB9: restating a brief makes the next version and a new ask", () => {
  const manager = { kind: "manager", name: "Manager", workerId: null } as const;
  const by = { endpointId: endpointId("e1"), sessionId: sessionId("s1") };
  const seen = (a: Ask, source: SourceState = { kind: "open" }): Sighting => ({ ask: a, source, answered: null });
  // The example restated: two other options, so an answer for v1 names no option v2 has.
  const restated = (): DecisionBrief => {
    const draft = example();
    draft.options = [{ key: "c", label: "Buy a hosted add-on" }, { key: "d", label: "Do nothing" }];
    draft.recommend = "c";
    draft.headline = "Approve option C: buy the hosted add-on";
    for (const r of (draft.comparison as { rows: { cells: string[] }[] }).rows) r.cells = r.cells.slice(0, 2);
    return lintBrief(draft, NOW).brief!;
  };
  it("a Decision given for the earlier version no longer answers the new one (E11)", () => {
    const v1 = lintBrief(example(), NOW).brief!;
    const x = new Escalations();
    x.reconcile([seen(askFromBrief("d-1", v1, manager, 1, NOW))], NOW, true);
    expect(x.record("d-1", { kind: "option", key: "b" }, by, NOW + 1).ok).toBe(true);
    x.reconcile([seen(askFromBrief("d-1", restated(), manager, 2, NOW + 60_000))], NOW + 60_000, true);
    const e = x.get("d-1");
    expect(e?.status).toBe("open");
    expect(e?.decision).toBe(null);
    expect(e?.askedAgain).toBe(true);
    expect(e?.options.map(o => o.key)).toEqual(["c", "d"]);
  });
  it("a Decision restored after a restart doesn't answer the newer version either", () => {
    const x = new Escalations();
    x.restore([{
      id: escalationId("d-1"),
      decision: { choice: { kind: "option", key: "b", label: "Extend the triage script" }, at: NOW + 1, via: "here", ...by },
    }]);
    x.reconcile([seen(askFromBrief("d-1", restated(), manager, 2, NOW + 60_000))], NOW + 60_000, true);
    expect(x.get("d-1")?.decision).toBe(null);
    expect(x.get("d-1")?.status).toBe("open");
  });
});

describe("briefMarkdown: the brief as one text, in the guide's own shape", () => {
  it("renders the guide's sections in the guide's order, and its table one column per option", () => {
    const brief = lintBrief(example(), NOW).brief!;
    const md = briefMarkdown(brief);
    expect(md.startsWith("# Approve option B: extend the in-house triage script\n\n## The ask\n")).toBe(true);
    expect(md).toContain("Alternative: buy the hosted add-on (C) for **$180 a month**; it starts faster and costs more from month 14.");
    expect(md).toContain("Main uncertainty: the saving comes from a two-week sample of 310 tickets.");
    expect(md).toContain("| Factor | A · Keep manual triage | B · Extend the triage script | C · Buy a hosted add-on |");
    expect(md).toContain("| Year-one cost | $0 | $2,400 | $2,160 |");
    expect(md).toContain("Note: costs are cash only, without tax. Agent-days and staff hours are not priced.");
    expect(md).toContain("Downside case: if the saving is only 2 hours a week, B still beats A, but C's reporting view would have been worth more; we would switch to C at the review point, having spent the $2,400.");
    expect(md).toContain("Risk: the script routes an urgent ticket to the wrong queue.\nControl: for the first two weeks a person checks every ticket tagged urgent before it is routed, and the error rate is posted daily.");
    expect(md).toContain("Needs fresh approval: any spend above $2,400, a new vendor, or sending ticket text outside our systems.");
    expect(md).toContain("## If no decision by the due date\nThe contractor's slot lapses. We keep manual triage (A) and ask again in January.");
    expect(md).toContain("## Decision\n- [a] Keep manual triage\n- [b] Extend the triage script\n- [c] Buy a hosted add-on");
    expect(md).toContain("## Evidence\n- [Two-week triage sample](https://example.com/triage-sample)\n- [Contractor quote](https://example.com/contractor-quote)\n- [Hosted add-on trial notes](https://example.com/addon-trial)");
    const headings = ["# Approve", "## The ask", "## Why now", "## Options compared", "## Why the recommendation",
      "## What would change the recommendation", "## Main risk and control", "## What approval authorizes",
      "## If no decision by the due date", "## Decision", "## Evidence"].map(h => md.indexOf(h));
    expect(headings).toEqual([...headings].sort((a, b) => a - b));
  });
  it("leaves out the sections a brief leaves out", () => {
    const draft = example();
    draft.ifNoAnswer = null;
    draft.evidence = [];
    const brief = lintBrief(draft, NOW).brief!;            // no_evidence is a warning; the brief stands
    const md = briefMarkdown(brief);
    expect(md).not.toContain("## If no decision by the due date");
    expect(md).not.toContain("## Evidence");
  });
});

describe("askFromBrief: one Ask, filled for the apps that don't know briefs (§4.5)", () => {
  const manager = { kind: "manager", name: "Manager", workerId: null } as const;
  it("fills every field an old app reads, the recommended option first", () => {
    const brief = lintBrief(example(), NOW).brief!;
    const ask = askFromBrief("d-12", brief, manager, 1, NOW);
    expect(ask).toEqual({
      id: "d-12", asker: manager, need: "decision",
      title: "Approve option B: extend the in-house triage script",
      shortTitle: "Support inbox triage", summary: "Approve option B: extend the in-house triage script",
      minutes: 4, link: null, details: briefMarkdown(brief), context: null, contextKind: "markdown",
      options: [
        { key: "b", label: "Extend the triage script", detail: null },
        { key: "a", label: "Keep manual triage", detail: null },
        { key: "c", label: "Buy a hosted add-on", detail: null },
      ],
      answerBy: "tap", recommendation: "Approve option B: extend the in-house triage script",
      ifNoAnswer: "The contractor's slot lapses. We keep manual triage (A) and ask again in January.",
      deadline: DUE, blocking: false, project: "support", askedAt: NOW, messageId: null, tracking: "hub",
      briefVersion: 1,
    });
  });
});

describe("askVersion: a restated brief changes it, with or without the markdown (§4.5)", () => {
  it("the brief's version number is in the hash, so a restate changes it even when the text doesn't", () => {
    const brief = lintBrief(example(), NOW).brief!;
    const manager = { kind: "manager", name: "Manager", workerId: null } as const;
    const a = askFromBrief("d-12", brief, manager, 1, NOW);
    const v1 = askVersion(a);
    expect(v1).toBe(askVersion(a));                          // pure: the same ask, the same version
    expect(askVersion({ ...a, briefVersion: 2 })).not.toBe(v1);
  });
  it("an ask without a brief hashes as before, digit for digit", () => {
    const v = askVersion({
      askedAt: 1_790_736_000_000, messageId: "m-1", title: "Question ny-1", context: "Some context.",
      options: [{ key: "ship", label: "Ship it", detail: null }, { key: "hold", label: "Hold", detail: null }],
      recommendation: null, ifNoAnswer: "hold", deadline: null,
      shortTitle: "Short", summary: "One sentence.", minutes: 2, link: null, details: "The long text.",
    });
    expect(v).toBe("vd53659b59b");                           // pinned before briefVersion joined the hash
  });
});
