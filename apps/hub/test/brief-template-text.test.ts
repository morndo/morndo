// The template parser keeps text. A label word inside a section that does not use that label stays prose.
// A wrapped continuation stays in its list item. An evidence line that is not a link is a lint problem, and the
// line is named in that problem.
import { describe, expect, it } from "vitest";
import { parseBriefMarkdown } from "../src/adapters/brief-template.ts";

const head = `---
topic: Inbox
due: 2026-10-14
minutes: 4
recommend: b
---

# Approve option B: extend the script

## The ask
Choose.

## Why now
Note: the sample excludes weekend tickets.

## Options compared
| Factor | A · Keep | B · Extend |
|---|---|---|
| Cost | 1 | 2 |

## Why the recommendation
It is cheaper.

Assumptions:
- The saving holds for every
  ticket type.

## What would change the recommendation
A higher price.

## Main risk and control
Risk: it slips
Control: a weekly check

## What approval authorizes
Limits:
- one script

## Decision
- [a] Keep
- [b] Extend

## Evidence
see the weekly numbers
`;

describe("the template parser keeps text", () => {
  const parsed = () => parseBriefMarkdown(head);

  it("leaves a label word in prose when that section has no such label", () => {
    const why = parsed().draft.whyNow;
    expect(why).toContain("weekend tickets");
  });

  it("keeps a wrapped continuation on its list item", () => {
    const why = parsed().draft.why as { assumptions?: string[] };
    expect(why.assumptions?.[0]).toContain("ticket type");
  });

  it("reports an evidence line that is not a link, and names the line", () => {
    const problems = parsed().problems;
    const hit = problems.find(p => p.code === "bad_evidence");
    expect(hit?.text).toContain("see the weekly numbers");
    expect(parsed().draft.evidence).toEqual([]);
  });
});
