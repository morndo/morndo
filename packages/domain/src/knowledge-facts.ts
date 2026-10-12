// Model facts, preferences and the Scorecard link (ADR-0026; design docs/design/capability-knowledge, sections 7 and 8). Three pure
// pieces of the Knowledge context: models.dev's api.json trimmed to a snapshot and judged for freshness, the user's preferences file
// parsed with a refusal per broken entry, and an SOP step's model class linked to the Scorecard cells of its role group.
import { MODEL_CLASSES, type ModelClass } from "./knowledge.ts";
import { isDate, isRec, PREFERENCE_ID, shown, text, utcMs } from "./knowledge-guards.ts";
import { err, ok, type Result } from "./shared.ts";

export const SNAPSHOT_STALE_DAYS = 30;

export type ModelFact = { provider: string; model: string; name: string; family: string | null; context: number | null; output: number | null; inputPrice: number | null; outputPrice: number | null; released: string | null };
export type ModelSnapshot = { source: string; fetched: string; licence: string; models: ModelFact[] };

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const numOf = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null);
const strOrNull = (x: unknown): x is string | null => typeof x === "string" || x === null;
const numOrNull = (x: unknown): x is number | null => x === null || (typeof x === "number" && Number.isFinite(x) && x >= 0);

export function trimModelsDev(api: unknown, meta: { source: string; fetched: string; licence: string }): Result<ModelSnapshot, string> {
  if (!isRec(api)) return err("api.json is a mapping of providers, each mapping model ids to models");
  if (!isDate(meta.fetched)) return err(`fetched must be a real date, YYYY-MM-DD, not '${shown(meta.fetched)}'`);
  if (!text(meta.source) || !text(meta.licence)) return err("source and licence are non-empty strings");
  const models: ModelFact[] = [];
  // A blank provider or model key is left out with the rest of what can't be kept, so all it keeps reads back (readSnapshot).
  for (const p of Object.keys(api).sort(byText)) {
    if (!text(p)) continue;
    const provider = api[p];
    const catalog = isRec(provider) ? provider.models : undefined;
    if (!isRec(catalog)) continue; // a provider whose models is not a mapping holds nothing we can keep
    for (const m of Object.keys(catalog).sort(byText)) {
      const raw = catalog[m];
      if (!text(m) || !isRec(raw)) continue;
      const limit = isRec(raw.limit) ? raw.limit : {};
      const cost = isRec(raw.cost) ? raw.cost : {};
      models.push({
        provider: p, model: m,
        name: text(raw.name) ? raw.name : m,
        family: typeof raw.family === "string" ? raw.family : null,
        context: numOf(limit.context), output: numOf(limit.output),
        inputPrice: numOf(cost.input), outputPrice: numOf(cost.output),
        released: typeof raw.release_date === "string" ? raw.release_date : null,
      });
    }
  }
  if (models.length === 0) return err("no model fact remains: every provider maps model ids to models");
  return ok({ source: meta.source, fetched: meta.fetched, licence: meta.licence, models });
}

export function readSnapshot(doc: unknown): Result<ModelSnapshot, string> {
  if (!isRec(doc)) return err("a snapshot is a mapping");
  if (!text(doc.source)) return err("source is a non-empty string");
  if (!isDate(doc.fetched)) return err("fetched must be a real date, YYYY-MM-DD");
  if (!text(doc.licence)) return err("licence is a non-empty string");
  if (!Array.isArray(doc.models)) return err("models is a list of model facts");
  const models: ModelFact[] = [];
  for (const [i, raw] of (doc.models as unknown[]).entries()) {
    if (!isRec(raw)) return err(`models[${i}] is a mapping`);
    if (!(text(raw.provider) && text(raw.model) && text(raw.name))) return err(`models[${i}] names its provider, model and name`);
    if (!(strOrNull(raw.family) && strOrNull(raw.released))) return err(`models[${i}] holds family and released as strings or null`);
    if (!(numOrNull(raw.context) && numOrNull(raw.output) && numOrNull(raw.inputPrice) && numOrNull(raw.outputPrice))) return err(`models[${i}] holds its numbers as non-negative numbers or null`);
    models.push({ provider: raw.provider, model: raw.model, name: raw.name, family: raw.family, context: raw.context, output: raw.output, inputPrice: raw.inputPrice, outputPrice: raw.outputPrice, released: raw.released });
  }
  return ok({ source: doc.source, fetched: doc.fetched, licence: doc.licence, models });
}

// Fresh up to SNAPSHOT_STALE_DAYS old, stale past it, and future when fetched after today: a wrong clock or a wrong date in the
// file, an anomaly to warn about, never fresh.
export type Freshness = { ageDays: number; state: "fresh" | "stale" | "future" };

export function freshness(fetched: string, today: string): Freshness {
  const ageDays = Math.round((utcMs(today) - utcMs(fetched)) / 86_400_000);
  return { ageDays, state: ageDays < 0 ? "future" : ageDays > SNAPSHOT_STALE_DAYS ? "stale" : "fresh" };
}

export const PREFERENCE_FIELDS = ["id", "holder", "on", "said", "tasks"] as const;

export type Preference = { id: string; holder: string; on: string; said: string; tasks: string[] };

// The preferences that hold, one refusal per entry or field that doesn't, by its place in the file, and each id the file
// holds only in refused entries, with the first refusal's words, so a citation of it can say why it doesn't resolve.
export type ParsedPreferences = { preferences: Preference[]; refusals: { at: string; message: string }[]; leftOut: ReadonlyMap<string, string> };

export function parsePreferences(doc: unknown): ParsedPreferences {
  const list = isRec(doc) ? doc.preferences : undefined;
  if (!isRec(doc) || !Array.isArray(list)) return { preferences: [], refusals: [{ at: "preferences", message: "a preferences file is a mapping with a preferences list" }], leftOut: new Map() };
  const refusals = Object.keys(doc).filter(k => k !== "preferences").map(k => ({ at: k, message: `'${k}' is not a field of the preferences file: it holds a preferences list` }));
  // Each entry on its own first: a preference, or the reason it is none.
  const judged = (list as unknown[]).map((raw, i) => ({ at: `preferences[${i}]`, id: isRec(raw) && typeof raw.id === "string" ? raw.id : null, ...judgePreference(raw) }));
  // Then the ids among the entries that hold: one two of them use names no one preference, so both are left out. An entry
  // refused for another reason never counts.
  const places = new Map<string, string[]>();
  for (const j of judged) if (j.preference) places.set(j.preference.id, [...(places.get(j.preference.id) ?? []), j.at]);
  const preferences: Preference[] = [];
  const leftOut = new Map<string, string>();
  for (const { at, id, preference, why } of judged) {
    const same = preference ? (places.get(preference.id) ?? []) : [];
    if (preference && same.length < 2) {
      preferences.push(preference);
      continue;
    }
    const message = preference ? `id '${preference.id}' is used by ${same.slice(0, -1).join(", ")} and ${same.at(-1)}: an id names one preference` : why;
    refusals.push({ at, message });
    if (id !== null && !leftOut.has(id)) leftOut.set(id, message);
  }
  for (const p of preferences) leftOut.delete(p.id);
  return { preferences, refusals, leftOut };
}

function judgePreference(raw: unknown): { preference: Preference; why: null } | { preference: null; why: string } {
  const no = (why: string) => ({ preference: null, why });
  if (!isRec(raw)) return no("a preference is a mapping");
  const extra = Object.keys(raw).find(k => !(PREFERENCE_FIELDS as readonly string[]).includes(k));
  if (extra !== undefined) return no(`'${extra}' is not a preference field (${PREFERENCE_FIELDS.join(", ")})`);
  if (!(text(raw.id) && PREFERENCE_ID.test(raw.id))) return no("id is lowercase letters, digits and hyphens, starting with a letter or a digit");
  if (!text(raw.holder)) return no("holder is a non-empty string");
  if (!isDate(raw.on)) return no("on must be a real date, YYYY-MM-DD");
  if (!text(raw.said)) return no("said is a non-empty string");
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0 || !raw.tasks.every(text)) return no("tasks is a non-empty list of task names");
  return { preference: { id: raw.id, holder: raw.holder, on: raw.on, said: raw.said, tasks: raw.tasks as string[] }, why: null };
}

export function renderPreference(p: Preference): string {
  return `${p.said} (${p.holder === "principal" ? "your" : `${p.holder}'s`} preference, ${p.on})`;
}

export type ScorecardCell = { entry: string; group: string; modelClass: ModelClass | "unknown"; family: string; runs: number; firstTry: number; editsAsked: number };

export function roleGroup(role: string): string {
  const cut = role.indexOf("-");
  return cut < 0 ? role : role.slice(0, cut);
}

export function scorecardFor(step: { role: string; model: unknown }, cells: readonly ScorecardCell[]): Result<ScorecardCell[], string> {
  const model = step.model;
  if (!isRec(model)) return err(`unknown class '${shown(model)}'`);
  const cls = model.class;
  if (!(MODEL_CLASSES as readonly unknown[]).includes(cls)) return err(`unknown class '${shown(cls)}'`);
  const group = roleGroup(step.role);
  return ok(cells.filter(c => c.group === group && c.modelClass === cls).sort((a, b) => byText(a.entry, b.entry)));
}
