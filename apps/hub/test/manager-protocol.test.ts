// The manager's chat protocol, with the cases the chat bot's own tests use, so the two read it alike.
import { describe, expect, it } from "vitest";
import { parseAnswer, parseTap, tapLine, wordsLine } from "../src/adapters/manager-protocol.ts";

describe("buttons line", () => {
  it("reads the last line as options, recommended first, and keeps the body without it", () => {
    const a = parseAnswer("[quiet]\nThe page is ready.\n\n[buttons ny-80] pr=Open PR | hold=Hold");
    expect(a.quiet).toBe(true);
    expect(a.body).toBe("The page is ready.");
    expect(a.buttons).toEqual({ id: "ny-80", options: [{ key: "pr", label: "Open PR" }, { key: "hold", label: "Hold" }] });
  });
  it("ignores trailing blank lines but not a buttons line in the middle", () => {
    expect(parseAnswer("Q\n[buttons r1] a=A\n\n").buttons?.id).toBe("r1");
    expect(parseAnswer("[buttons r1] a=A\nmore text").buttons).toBeUndefined();
  });
  it("leaves a line it can't read as text, and says why (negative controls)", () => {
    expect(parseAnswer("Q\n[buttons r1]").bad).toBe("no options");
    expect(parseAnswer("Q\n[buttons r1] a=A | b").bad).toBe("an option isn't key=Label");
    expect(parseAnswer("Q\n[buttons r1] a=A | a=B").bad).toBe("a key is used twice");
    expect(parseAnswer(`Q\n[buttons r1] a=${"x".repeat(41)}`).bad).toMatch(/longer than 40/);
    expect(parseAnswer("Q\n[buttons r1] a=1|b=2|c=3|d=4|e=5|f=6|g=7").bad).toMatch(/more than 6/);
    const bad = parseAnswer("Q\n[buttons r1] a=A | a=B");
    expect(bad.body).toContain("[buttons r1]");
  });
});

describe("tap line", () => {
  it("is written the way kira types it, and read back", () => {
    const line = tapLine("ny-80", { key: "pr", label: "Open PR" });
    expect(line).toBe("[tap ny-80] pr (Open PR)");
    expect(parseTap(line)).toEqual({ id: "ny-80", key: "pr", label: "Open PR" });
    expect(parseTap("[tap ny-1] a")).toEqual({ id: "ny-1", key: "a", label: "a" });
    expect(parseTap("I'd say [tap ny-1] a (A)")).toBeNull();
  });
  it("an answer in words names the item first", () => {
    expect(wordsLine("ny-21", "  yes, sign it ")).toBe("About ny-21: yes, sign it");
  });
});
