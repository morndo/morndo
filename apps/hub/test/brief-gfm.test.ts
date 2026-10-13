// GFM tables (spec §4.10, https://github.github.com/gfm/#tables-extension-, read 2026-10-13).
// Example 199 uses a one-hyphen delimiter (`:-:`) and rows without a leading or trailing pipe.
import { describe, expect, it } from "vitest";
import { parseBriefMarkdown } from "../src/adapters/brief-template.ts";

describe("GFM comparison tables", () => {
  it("accepts a one-hyphen delimiter and rows without edge pipes", () => {
    const text = `---
topic: Inbox
due: 2026-10-14
minutes: 4
recommend: b
---

# Approve option B: extend the script

## The ask
Choose.

## Why now
Now.

## Options compared
Factor | A · Keep | B · Extend
:-: | --- | ---
Cost | 1 | 2

## Why the recommendation
It is cheaper.

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
`;
    const { draft, problems } = parseBriefMarkdown(text);
    const comparison = draft.comparison as { rows?: { factor: string; cells: string[] }[] };
    expect(problems.map(p => p.code)).not.toContain("missing_section");
    expect(comparison.rows).toEqual([{ factor: "Cost", cells: ["1", "2"] }]);
  });
});
