// Model facts, preferences and the Scorecard link (ADR-0026; design docs/design/capability-knowledge, sections 7 and 8): models.dev's
// api.json trimmed to one fact per provider and model, with nulls where a value is missing, empty or negative; a stored snapshot
// re-validated; freshness past SNAPSHOT_STALE_DAYS; the preferences file parsed with one refusal per broken entry and rendered as its
// holder's view, never as a fact (K4); and an SOP step's model class linked to its role group's Scorecard cells, sorted by entry and
// never by a score (K9). The module is a stub, so every test here fails by assertion until it is implemented.
import { describe, expect, it } from "vitest";
import {
  freshness, parsePreferences, readSnapshot, renderPreference, roleGroup, scorecardFor, trimModelsDev,
  type ModelSnapshot, type Preference, type ScorecardCell,
} from "../src/knowledge-facts.ts";
import type { Result } from "../src/shared.ts";

// An err carries a string message; ok gives null, so a stub that answers ok fails every refusal expectation.
const refusal = (r: Result<unknown, string>): string | null => (r.ok ? null : r.error);

const META = { source: "models.dev", fetched: "2026-10-12", licence: "MIT" };
// A made-up api.json: zenith before acme and, within acme, small before large, so the snapshot's order is sorted, not copied.
const API = {
  zenith: { id: "zenith", name: "Zenith", models: { "zenith-pro": { id: "zenith-pro", name: "Zenith Pro", family: "zenith-pro", release_date: "2026-09-01", limit: { context: 200_000, output: 32_000 }, cost: { input: 1.25, output: 5 } } } },
  acme: {
    id: "acme", name: "Acme", models: {
      "acme-small-1": { id: "acme-small-1", name: "", limit: { context: -8, output: 8_192 } },
      "acme-large-2": { id: "acme-large-2", name: "Acme Large 2", family: "acme-large", release_date: "2026-08-15", limit: { context: 400_000, output: 64_000 }, cost: { input: 3, output: 12 } },
    },
  },
};

const SNAPSHOT: ModelSnapshot = {
  source: "models.dev", fetched: "2026-10-12", licence: "MIT",
  models: [
    { provider: "acme", model: "acme-large-2", name: "Acme Large 2", family: "acme-large", context: 400_000, output: 64_000, inputPrice: 3, outputPrice: 12, released: "2026-08-15" },
    { provider: "acme", model: "acme-small-1", name: "acme-small-1", family: null, context: null, output: 8_192, inputPrice: null, outputPrice: null, released: null },
    { provider: "zenith", model: "zenith-pro", name: "Zenith Pro", family: "zenith-pro", context: 200_000, output: 32_000, inputPrice: 1.25, outputPrice: 5, released: "2026-09-01" },
  ],
};

describe("trimModelsDev", () => {
  it("keeps one fact per provider and model, nulls what is missing, empty or negative, and sorts by provider then model", () => {
    expect(trimModelsDev(API, META)).toEqual({ ok: true, value: SNAPSHOT });
  });
  it("refuses what is not a mapping of providers with models, and a date that is not one, and an empty licence", () => {
    expect(refusal(trimModelsDev([], META))).toEqual(expect.any(String));
    expect(refusal(trimModelsDev({}, META))).toEqual(expect.any(String));
    expect(refusal(trimModelsDev(API, { ...META, fetched: "2026-02-30" }))).toEqual(expect.any(String));
    expect(refusal(trimModelsDev(API, { ...META, licence: "" }))).toEqual(expect.any(String));
  });
});

describe("readSnapshot", () => {
  it("accepts what trimModelsDev made, through a JSON round trip", () => {
    expect(readSnapshot(JSON.parse(JSON.stringify(SNAPSHOT)))).toEqual({ ok: true, value: SNAPSHOT });
  });
  it("refuses a snapshot without a fetched date, without a models list, or holding a fact that is not one", () => {
    const doc: Record<string, unknown> = { ...SNAPSHOT };
    delete doc.fetched;
    expect(refusal(readSnapshot(doc))).toEqual(expect.any(String));
    expect(refusal(readSnapshot({ ...SNAPSHOT, models: "none" }))).toEqual(expect.any(String));
    expect(refusal(readSnapshot({ ...SNAPSHOT, models: [{ ...(SNAPSHOT.models[0] ?? {}), model: 7 }] }))).toEqual(expect.any(String));
  });
});

describe("freshness", () => {
  it("ageDays is the whole days between the dates; a snapshot is stale only past SNAPSHOT_STALE_DAYS", () => {
    expect(freshness("2026-10-12", "2026-10-12")).toEqual({ ageDays: 0, stale: false });
    expect(freshness("2026-09-12", "2026-10-12")).toEqual({ ageDays: 30, stale: false });
    expect(freshness("2026-09-11", "2026-10-12")).toEqual({ ageDays: 31, stale: true });
  });
});

const WRITE_LONG: Preference = { id: "write-long", holder: "principal", on: "2026-10-11", said: "Acme models for long-form writing.", tasks: ["draft"] };
const SEARCH_ACME: Preference = { id: "search-pass-acme", holder: "principal", on: "2026-10-11", said: "Acme for the search pass.", tasks: ["search-pass"] };

describe("parsePreferences", () => {
  it("keeps the valid entries, in order", () => {
    expect(parsePreferences({ preferences: [WRITE_LONG, SEARCH_ACME] })).toEqual({ preferences: [WRITE_LONG, SEARCH_ACME], refusals: [] });
  });
  it("a broken entry is left out, with one refusal naming its place in the file", () => {
    expect(parsePreferences({ preferences: [{ ...WRITE_LONG, on: "2026-13-01" }, SEARCH_ACME] })).toEqual({
      preferences: [SEARCH_ACME],
      refusals: [{ at: "preferences[0]", message: expect.any(String) }],
    });
  });
  it("a field the file does not have breaks the entry", () => {
    expect(parsePreferences({ preferences: [{ ...WRITE_LONG, rank: 1 }] })).toEqual({ preferences: [], refusals: [{ at: "preferences[0]", message: expect.any(String) }] });
  });
  it("a doc that is not a mapping with a preferences list is one refusal, at preferences", () => {
    expect(parsePreferences("nothing")).toEqual({ preferences: [], refusals: [{ at: "preferences", message: expect.any(String) }] });
  });
});

describe("renderPreference", () => {
  it("shows a preference as its holder's, with its date, never as a fact (K4)", () => {
    expect(renderPreference(WRITE_LONG)).toBe("Acme models for long-form writing. (your preference, 2026-10-11)");
    expect(renderPreference({ ...WRITE_LONG, holder: "editor" })).toBe("Acme models for long-form writing. (editor's preference, 2026-10-11)");
  });
});

describe("roleGroup", () => {
  it("is the role up to its first hyphen (ADR-0020's role group)", () => {
    expect(roleGroup("implement-ui")).toBe("implement");
    expect(roleGroup("review")).toBe("review");
  });
});

// Made-up Scorecard cells. Among the implement/flagship three, no ordering of runs, firstTry or editsAsked, up or down, is the
// entry order, so a sort by any score fails the first test below (K9: knowledge never ranks).
const CELLS: readonly ScorecardCell[] = [
  { entry: "zenith-pro", group: "implement", modelClass: "flagship", family: "zenith", runs: 4, firstTry: 1, editsAsked: 6 },
  { entry: "zenith-mini", group: "review", modelClass: "fast", family: "zenith", runs: 12, firstTry: 9, editsAsked: 3 },
  { entry: "acme-large-2", group: "implement", modelClass: "flagship", family: "acme", runs: 6, firstTry: 2, editsAsked: 8 },
  { entry: "beta-omni-1", group: "implement", modelClass: "flagship", family: "beta", runs: 9, firstTry: 8, editsAsked: 1 },
  { entry: "acme-everyday-3", group: "implement", modelClass: "everyday", family: "acme", runs: 11, firstTry: 10, editsAsked: 2 },
  { entry: "beta-old-1", group: "implement", modelClass: "unknown", family: "beta", runs: 2, firstTry: 0, editsAsked: 2 },
  { entry: "acme-turbo", group: "review", modelClass: "flagship", family: "acme", runs: 3, firstTry: 3, editsAsked: 0 },
];
const cell = (entry: string): ScorecardCell => {
  const found = CELLS.find(c => c.entry === entry);
  if (!found) throw new Error(`no cell ${entry}`);
  return found;
};

describe("scorecardFor", () => {
  it("links a step's class to its role group's cells, sorted by entry and never by a score (K9)", () => {
    const step = { role: "implement-backend", model: { class: "flagship", family: "any" } };
    expect(scorecardFor(step, CELLS)).toEqual({ ok: true, value: [cell("acme-large-2"), cell("beta-omni-1"), cell("zenith-pro")] });
  });
  it("a class that isn't one, or a model id where the model belongs, is refused", () => {
    expect(scorecardFor({ role: "implement-backend", model: { class: "huge", family: "any" } }, CELLS)).toEqual({ ok: false, error: "unknown class 'huge'" });
    expect(scorecardFor({ role: "implement-backend", model: "acme-large-2" }, CELLS)).toEqual({ ok: false, error: "unknown class 'acme-large-2'" });
  });
  it("a class with no cells for that role group is ok with nothing", () => {
    expect(scorecardFor({ role: "validate-links", model: { class: "fast", family: "any" } }, CELLS)).toEqual({ ok: true, value: [] });
  });
});
