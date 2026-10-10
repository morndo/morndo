// The needs-you list adapter on synthetic documents shaped like the manager's (field names vary by item).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ledgerReader, parseDeadline, parseLedger } from "../src/adapters/ledger.ts";

const dir = mkdtempSync(join(tmpdir(), "morndo-ledger-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const doc = {
  needsYou: [
    { id: "ny-1", kind: "tap", question: "Ship the demo release?", default: "hold", deadline: "2026-10-02", blocking: true, task: "demo", ts: "2026-10-01T08:00+02:00", status: "open" },
    { id: "ny-2", kind: "time", item: "Sign the lease", default: "not done", added: "2026-10-01T09:00+02:00" },
    { id: "ny-3", kind: "tap", what: "Rotate the keys?", addedAt: "2026-10-01T10:00+02:00", status: "closed", answer: "rotate", closedAt: "2026-10-01T11:00+02:00" },
    { id: "bad id with spaces", kind: "tap", question: "x" },
    "not an object",
  ],
  needsYouClosed: [{ id: "ny-0", kind: "tap", question: "Old one", status: "answered", resolution: "done", closedAt: "2026-09-30T10:00+02:00" }],
};

describe("translating the list", () => {
  it("reads every field-name variant into one shape", () => {
    const items = Object.fromEntries(parseLedger(doc).map(i => [i.id, i]));
    expect(Object.keys(items).sort()).toEqual(["ny-0", "ny-1", "ny-2", "ny-3"]);
    expect(items["ny-1"]).toMatchObject({ need: "decision", title: "Ship the demo release?", ifNoAnswer: "hold", blocking: true, project: "demo", open: true });
    expect(items["ny-1"]?.addedAt).toBe(Date.parse("2026-10-01T08:00+02:00"));
    expect(items["ny-2"]).toMatchObject({ need: "time", title: "Sign the lease", open: true });
    expect(items["ny-3"]).toMatchObject({ title: "Rotate the keys?", open: false, resolution: "rotate", closedAt: Date.parse("2026-10-01T11:00+02:00") });
    expect(items["ny-0"]).toMatchObject({ open: false, resolution: "done" });
  });
  it("a date without a time is due at the end of that day", () => {
    const d = new Date(parseDeadline("2026-10-02") ?? 0);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 9, 2, 23, 59]);
    expect(parseDeadline("someday")).toBeNull();
  });
});

describe("reading the file", () => {
  it("a missing or half-written file is 'not ok', never an empty list", () => {
    const path = join(dir, "ledger.json");
    expect(ledgerReader(path)().ok).toBe(false);
    writeFileSync(path, JSON.stringify(doc).slice(0, 80));
    expect(ledgerReader(path)().ok).toBe(false);
    writeFileSync(path, JSON.stringify(doc));
    const r = ledgerReader(path)();
    expect(r.ok && r.items.length).toBe(4);
  });
});

// The manager's list gives a short form from 2026-10-04 (the owner's feedback on the phone): a title of a few words,
// one sentence, the minutes it takes, its options, a link and the long details. Each is optional and checked here.
describe("the list's short form", () => {
  const one = (x: Record<string, unknown>) => {
    const i = parseLedger({ needsYou: [{ id: "ny-5", kind: "time", what: "A long text: with every step in it.", ...x }] })[0];
    if (!i) throw new Error("not read");
    return i;
  };
  it("reads title, summary, minutes, options, link and details next to the long question", () => {
    const i = one({
      title: "Check the garden", summary: "Water the beds on the north side, then log it.", minutes: 10,
      options: [{ key: "now", label: "Watering now" }, { key: "later", label: "After lunch" }],
      link: "https://example.com/garden", details: "Step 1.\nStep 2.",
    });
    expect(i).toMatchObject({
      title: "A long text: with every step in it.", shortTitle: "Check the garden", summary: "Water the beds on the north side, then log it.",
      minutes: 10, options: [{ key: "now", label: "Watering now" }, { key: "later", label: "After lunch" }], link: "https://example.com/garden", details: "Step 1.\nStep 2.",
    });
  });
  it("without them, each is null and the options are none", () => {
    expect(one({})).toMatchObject({ shortTitle: null, summary: null, minutes: null, options: [], link: null, details: null });
  });
  it("drops what doesn't fit: a link that isn't http(s), minutes that aren't a positive number, options the tap grammar rejects", () => {
    expect(one({ link: "javascript:alert(1)" }).link).toBeNull();
    expect(one({ link: "not a url" }).link).toBeNull();
    for (const m of [0, -5, "10", Number.NaN, 100_000]) expect(one({ minutes: m }).minutes).toBeNull();
    expect(one({ minutes: 7.6 }).minutes).toBe(8);
    expect(one({ options: [{ key: "has space", label: "X" }] }).options).toEqual([]);                  // a key the tap line can't carry
    expect(one({ options: [{ key: "a", label: "x".repeat(41) }] }).options).toEqual([]);              // longer than a button label
    expect(one({ options: [{ key: "a", label: "A" }, { key: "a", label: "B" }] }).options).toEqual([]);  // a key twice
    expect(one({ options: [{ key: "a", label: "line\u001b[2J" }] }).options).toEqual([]);            // a control character
    expect(one({ options: Array.from({ length: 7 }, (_, n) => ({ key: `k${n}`, label: `L${n}` })) }).options).toEqual([]);
    expect(one({ options: "now|later" }).options).toEqual([]);
  });
  it("a title or summary is one line: newlines fold into spaces", () => {
    expect(one({ title: "Two\nlines", summary: "One\n\nsentence." })).toMatchObject({ shortTitle: "Two lines", summary: "One sentence." });
  });
});
