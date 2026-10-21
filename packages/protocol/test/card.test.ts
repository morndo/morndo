// The short-card template (ADR-0023's amendment, board T-307): Key: value lines and an Options: block of "- key:
// Label | kind", read by hand the way the brief's template is. A problem here is one the draft cannot say; the domain
// lints the draft it returns.
import { describe, expect, it } from "vitest";
import { CARD_TEMPLATE, parseCardMarkdown } from "../src/index.ts";

const EXAMPLE = `Id: ny-80
Outcome: The release is ready; one check from the reviewer is still open.
Recommend: hold
Options:
- hold: Hold until the check is in | stop
- merge: Merge now | continue
Default: hold
Risk: the migration has no rollback yet
`;

describe("parseCardMarkdown", () => {
  it("reads the example into the draft shape", () => {
    expect(parseCardMarkdown(EXAMPLE)).toEqual({
      draft: {
        id: "ny-80",
        outcome: "The release is ready; one check from the reviewer is still open.",
        recommend: "hold",
        options: [
          { key: "hold", label: "Hold until the check is in", kind: "stop" },
          { key: "merge", label: "Merge now", kind: "continue" },
        ],
        default: "hold",
        risk: "the migration has no rollback yet",
      },
      problems: [],
    });
  });
  it("the blank parses with no problems, and \\r\\n is read as \\n", () => {
    expect(parseCardMarkdown(CARD_TEMPLATE).problems).toEqual([]);
    expect(parseCardMarkdown(EXAMPLE.replace(/\n/g, "\r\n")).draft).toEqual(parseCardMarkdown(EXAMPLE).draft);
  });
  it("an option line carries its kind after a bar", () => {
    expect(parseCardMarkdown("Options:\n- hold: Hold until Monday | stop\n").draft).toEqual({
      options: [{ key: "hold", label: "Hold until Monday", kind: "stop" }],
    });
    // no bar: no kind key on the option, so the domain's lint names what is missing under a live risk
    const bare = parseCardMarkdown("Options:\n- hold: Hold until Monday\n").draft.options as { kind?: unknown }[];
    expect(bare[0]).not.toHaveProperty("kind");
  });
  it("a kind that is neither stop nor continue is a problem", () => {
    expect(parseCardMarkdown("Options:\n- hold: Hold until Monday | pause\n").problems).toEqual([{
      level: "error", code: "bad_option_kind", where: "line 2", text: expect.any(String),
    }]);
  });
  it("an unknown line, a duplicate field and a bad option line each name their line", () => {
    expect(parseCardMarkdown("Id: ny-80\nTopic: the release\n").problems)
      .toEqual([{ level: "error", code: "unknown_line", where: "line 2", text: expect.any(String) }]);
    expect(parseCardMarkdown("Id: ny-80\nId: ny-81\n").problems.map(p => `${p.code} ${p.where}`)).toEqual(["duplicate_line line 2"]);
    expect(parseCardMarkdown("Options:\n- nope\n").problems.map(p => `${p.code} ${p.where}`)).toEqual(["bad_option_line line 2"]);
    // an option line outside Options: is no field of the card
    expect(parseCardMarkdown("- merge: Merge now\n").problems.map(p => p.code)).toEqual(["unknown_line"]);
  });
  it("an empty value leaves the field out, and the draft always has options", () => {
    expect(parseCardMarkdown("Id: ny-80\nOutcome:\n").draft).toEqual({ id: "ny-80", options: [] });
    expect(parseCardMarkdown("").draft).toEqual({ options: [] });
  });

  it("a problem never echoes a bidi override, a zero-width character or a control: they come back escaped", () => {
    const hostile = "Outcome\u202E: merge\u200B\u0007";
    const { problems } = parseCardMarkdown(`${hostile}\n- a b: x\n`);
    expect(problems.length).toBeGreaterThan(0);
    for (const p of problems) expect(`${p.text}${p.where}`).not.toMatch(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/);
  });
});
