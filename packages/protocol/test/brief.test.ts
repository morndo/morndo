// A decision brief on the wire (ADR-0023, design §4.5): a decision item may carry the brief it was filed from, and an
// app that can't read it falls back to the plain fields — never a half brief. The brief's own JSON Schema is committed
// (schema/decision-brief.json), so an engine that files by tool call sends what the hub reads.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DecisionBriefSchema, DecisionItemSchema } from "../src/index.ts";
import * as z from "../src/z.ts";

// The guide's example, as the hub stores it (the domain's lint passed it; here it is only wire JSON).
const brief = {
  topic: "Support inbox triage", due: Date.UTC(2026, 9, 14, 23, 59, 59, 999), minutes: 4,
  headline: "Approve option B: extend the in-house triage script", recommend: "b",
  ask: {
    text: "Approve **$2,400** of contractor time and **6 agent-days** to extend the in-house triage script.",
    alternative: "buy the hosted add-on (C) for **$180 a month**.",
    uncertainty: "the saving comes from a two-week sample of 310 tickets.",
  },
  whyNow: "- A decision by 2026-10-14 keeps the contractor's slot.",
  options: [{ key: "a", label: "Keep manual triage" }, { key: "b", label: "Extend the triage script" }, { key: "c", label: "Buy a hosted add-on" }],
  comparison: {
    rows: [
      { factor: "Year-one cost", cells: ["$0", "$2,400", "$2,160"] },
      { factor: "Ongoing cost", cells: ["5 staff hours a week", "About 1 agent-day a quarter", "$180 a month"] },
      { factor: "Principal drawback", cells: ["Waiting times keep rising", "We maintain the script", "Ticket text leaves our systems"] },
    ],
    note: "costs are cash only, without tax. Agent-days and staff hours are not priced.",
  },
  why: {
    text: "B gets most of C's benefit and keeps ticket text in our own systems.",
    assumptions: ["The contractor's quote of $2,400 is a fixed price."],
    downside: "if the saving is only 2 hours a week, we would stop at the review point.",
  },
  changeIf: "If the script tags fewer than 60% of tickets correctly in its first week, stop B and choose C.",
  risk: { risk: "the script routes an urgent ticket to the wrong queue.", control: "a person checks every urgent ticket for two weeks." },
  authorizes: {
    limits: ["Up to $2,400 with the contractor, at a fixed price."],
    freshApproval: "any spend above $2,400, a new vendor, or sending ticket text outside our systems.",
    reviewPoint: "2026-11-07, on tagging accuracy and hours saved.",
  },
  ifNoAnswer: "The contractor's slot lapses.",
  evidence: [{ label: "Two-week triage sample", url: "https://example.com/triage-sample" }],
  blocking: false, project: "support", task: null, ref: null,
};

const item = {
  id: "d-1", asker: { kind: "manager", name: "manager", workerId: null }, need: "decision",
  title: "Approve option B: extend the in-house triage script", shortTitle: "Support inbox triage",
  summary: "Approve option B: extend the in-house triage script", minutes: 4, link: null,
  details: "# Approve option B: …", context: null, contextKind: "markdown",
  options: [{ key: "b", label: "Extend the triage script", detail: null }], answerBy: "tap",
  recommendation: "Approve option B: extend the in-house triage script", ifNoAnswer: "The contractor's slot lapses.",
  deadline: Date.UTC(2026, 9, 14, 23, 59, 59, 999), blocking: false, project: "support", askedAt: 1, messageId: null,
  tracking: "hub", status: "open", source: "open", decision: null, resolution: null, settledAt: null, askedAgain: false,
  answerable: null, version: "v1234", brief, briefVersion: 2,
};

const read = (value: unknown) => {
  const r = z.safeParse(DecisionItemSchema, value);
  if (!r.success) throw new Error(JSON.stringify(r.error.issues));
  return r.data;
};

describe("a decision item's brief on the wire (§4.5)", () => {
  it("reads an item with its brief and its version", () => {
    const d = read(item);
    expect(d.brief?.topic).toBe("Support inbox triage");
    expect(d.brief?.comparison.rows).toHaveLength(3);
    expect(d.briefVersion).toBe(2);
  });
  it("a hub from before briefs sends neither: both read as absent", () => {
    const old = structuredClone(item) as Record<string, unknown>;
    delete old.brief;
    delete old.briefVersion;
    const d = read(old);
    expect(d.brief).toBe(null);
    expect(d.briefVersion).toBe(0);
  });
  it("a brief this app can't parse is null, never a half brief, and the item survives", () => {
    const d = read({ ...item, brief: { topic: "Support inbox triage" } });          // a section short: not a brief
    expect(d.brief).toBe(null);
    expect(d.title).toBe(item.title);
    const truncated = read({ ...item, brief: "approve something" });
    expect(truncated.brief).toBe(null);
  });
  it("an unknown part inside the brief doesn't stop the read: the hub already lints what a brief is", () => {
    const d = read({ ...item, brief: { ...brief, blocking: "yes" } });              // a shape this build may not know
    expect(d.brief?.blocking).toBe(false);
    expect(d.brief?.topic).toBe("Support inbox triage");
  });
  it("the brief's own schema reads the hub's JSON as the domain type", () => {
    const r = z.safeParse(DecisionBriefSchema, brief);
    expect(r.success).toBe(true);
  });
  it("the committed JSON Schema equals the generated one (MORNDO_WRITE_SCHEMA=1 to rewrite it)", () => {
    const generated = `${JSON.stringify(z.toJSONSchema(DecisionBriefSchema), null, 2)}\n`;
    const path = join(import.meta.dirname, "../schema/decision-brief.json");
    if (process.env.MORNDO_WRITE_SCHEMA === "1") writeFileSync(path, generated);
    expect(readFileSync(path, "utf8")).toBe(generated);
  });
});
