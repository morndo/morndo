// Decision briefs (ADR-0023): lintBrief's rules, DB1 to DB10, each shown to refuse by one change to the guide's valid
// example (docs/agents/decision-requests.md), so a lint that stops refusing fails here (the design's mutation table,
// §7). The example itself is the fixture; every mutation is one rule broken.
import { describe, expect, it } from "vitest";
import { lintBrief, type BriefProblem } from "../src/index.ts";

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
