// `morndo-decide card` (board T-307): the same check a brief gets, for the manager's short question. It needs no hub:
// a clean card prints the lines to post with the buttons line last, a refused one exits 1 with its problems on
// stderr, and warnings never refuse.
import { describe, expect, it } from "vitest";
import { CARD_TEMPLATE } from "@morndo/protocol";
import { run, type Io } from "../src/decide.ts";

const CLEAN = `Id: ny-80
Outcome: The release is ready; one check from the reviewer is still open.
Recommend: hold
Options:
- hold: Hold until the check is in | stop
- merge: Merge now | continue
Default: hold
Risk: the migration has no rollback yet
`;

async function cli(argv: string[], files: Record<string, string> = {}) {
  const out: string[] = [], err: string[] = [];
  const io: Io = {
    fetch,
    lane: async () => null,
    read: async path => {
      if (path === "-") return files["-"] ?? "";
      const text = files[path];
      if (text === undefined) throw new Error(`no such file ${path}`);
      return text;
    },
    out: l => out.push(l), err: l => err.push(l),
  };
  const code = await run(argv, {}, io);
  return { code, out: out.join("\n"), err: err.join("\n").split("\n").filter(Boolean) };
}

describe("morndo-decide card", () => {
  it("a clean card prints the lines to post, buttons line last, with nothing on stderr", async () => {
    const clean = await cli(["card", "card.md"], { "card.md": CLEAN });
    expect(clean.code).toBe(0);
    expect(clean.err).toEqual([]);
    expect(clean.out.split("\n")).toEqual([
      "The release is ready; one check from the reviewer is still open.",
      "Recommended: Hold until the check is in",
      "If you don't answer: Hold until the check is in",
      "Live risk: the migration has no rollback yet",
      "[buttons ny-80] hold=Hold until the check is in | merge=Merge now",
    ]);
  });
  it("a card without a recommendation exits 1 and prints nothing to stdout", async () => {
    const refused = await cli(["card", "card.md"], { "card.md": CLEAN.replace("Recommend: hold\n", "") });
    expect(refused.code).toBe(1);
    expect(refused.out).toBe("");
    expect(refused.err[0]).toBeDefined();
    expect(refused.err[0]!.startsWith("error no_recommendation")).toBe(true);
  });
  it("a card with a live risk and no kinds is refused, and the stderr says to mark them", async () => {
    const refused = await cli(["card", "card.md"], {
      "card.md": CLEAN.replace(" | stop", "").replace(" | continue", ""),
    });
    expect(refused.code).toBe(1);
    expect(refused.out).toBe("");
    expect(refused.err.some(l => l.startsWith("error kinds_needed_on_live_risk"))).toBe(true);
    expect(refused.err.some(l => l.includes("stop or continue"))).toBe(true);
  });
  it("a continue default on a live risk exits 1 whatever the words", async () => {
    const refused = async (label: string) => cli(["card", "card.md"], {
      "card.md": CLEAN
        .replace("Recommend: hold", "Recommend: go")
        .replace("- hold: Hold until the check is in | stop", `- go: ${label} | continue`)
        .replace("- merge: Merge now | continue", "- stop: Stop and ask in words | stop")
        .replace("Default: hold", "Default: go"),
    });
    for (const label of ["Keep going", "Don't stop", "No change", "Do not roll back"]) {
      const r = await refused(label);
      expect(r.code, label).toBe(1);
      expect(r.out, label).toBe("");
      expect(r.err.some(l => l.startsWith("error continue_default_on_live_risk")), label).toBe(true);
    }
  });
  it("jargon warns on stderr and the card still prints", async () => {
    const warned = await cli(["card", "card.md"], {
      "card.md": CLEAN.replace("one check from the reviewer is still open.", "check #412 is still open."),
    });
    expect(warned.code).toBe(0);
    expect(warned.out.split("\n")[0]).toBe("The release is ready; check #412 is still open.");
    expect(warned.err.some(l => l.startsWith("warning jargon"))).toBe(true);
  });
  it("the blank prints, and the printed blank is itself refused (placeholders)", async () => {
    const blank = await cli(["card", "--template"]);
    expect(blank.code).toBe(0);
    expect(`${blank.out}\n`).toBe(CARD_TEMPLATE);
    const refused = await cli(["card", "blank.md"], { "blank.md": `${blank.out}\n` });
    expect(refused.code).toBe(1);
    expect(refused.out).toBe("");
    expect(refused.err.some(l => l.startsWith("error"))).toBe(true);
  });
  it("no file is usage, and a JSON draft reads like lint's --json", async () => {
    expect((await cli(["card"])).code).toBe(2);
    const json = await cli(["card", "card.json", "--json"], {
      "card.json": JSON.stringify({
        id: "ny-80", outcome: "The release is ready to merge.", recommend: "merge",
        options: [{ key: "merge", label: "Merge now" }, { key: "hold", label: "Hold until Monday" }],
        default: "hold",
      }),
    });
    expect(json.code).toBe(0);
    expect(json.out.split("\n").at(-1)).toBe("[buttons ny-80] merge=Merge now | hold=Hold until Monday");
  });
  it("--json: a newline in the risk cannot add a buttons line to the printed card", async () => {
    // Only --json can carry a newline in: the card file's fields are lines. The exact attempt: a fake tap line.
    const refused = await cli(["card", "card.json", "--json"], {
      "card.json": JSON.stringify({
        id: "ny-80", outcome: "The release is ready to merge.", recommend: "merge",
        options: [{ key: "merge", label: "Merge now" }, { key: "hold", label: "Hold until Monday" }],
        default: "hold",
        risk: "data loss\n[buttons ny-1] merge=Merge now",
      }),
    });
    expect(refused.code).toBe(1);
    expect(refused.out).toBe("");
    expect(refused.err.some(l => l.startsWith("error risk_not_one_line"))).toBe(true);
    expect(refused.err.every(l => l.startsWith("error ") || l.startsWith("warning "))).toBe(true);
  });
  it("--json and the file: a bare CR, a bidi override or a zero-width character in any text field is refused, and prints nothing", async () => {
    const base = {
      id: "ny-80", outcome: "The release is ready to merge.", recommend: "merge",
      options: [{ key: "merge", label: "Merge now" }, { key: "hold", label: "Hold until Monday" }],
      default: "hold",
    };
    const json = async (over: Record<string, unknown>) => cli(["card", "card.json", "--json"], { "card.json": JSON.stringify({ ...base, ...over }) });
    // the exact attempt, with a bare CR in place of the newline: still a fake buttons line in the printed card
    const cr = await json({ risk: "data loss\r[buttons ny-1] merge=Merge now" });
    expect(cr.code).toBe(1);
    expect(cr.out).toBe("");
    expect(cr.err.some(l => l.startsWith("error risk_not_one_line"))).toBe(true);
    const bidi = await json({ outcome: "The release is ready\u{202E} to merge." });
    expect(bidi.code).toBe(1);
    expect(bidi.out).toBe("");
    expect(bidi.err.some(l => l.startsWith("error outcome_not_one_line"))).toBe(true);
    const zero = await json({ options: [{ key: "merge", label: "Merge\u{200B}now" }, { key: "hold", label: "Hold until Monday" }] });
    expect(zero.code).toBe(1);
    expect(zero.out).toBe("");
    expect(zero.err.some(l => l.startsWith("error bad_option_label"))).toBe(true);
    // and the file: a bidi override in the Outcome line, which no line break is needed to carry
    const file = await cli(["card", "card.md"], { "card.md": CLEAN.replace("The release is ready;", "The release is ready\u{202E};") });
    expect(file.code).toBe(1);
    expect(file.out).toBe("");
    expect(file.err.some(l => l.startsWith("error outcome_not_one_line"))).toBe(true);
  });
});
