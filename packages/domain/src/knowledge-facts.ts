// Model facts, preferences and the Scorecard link (ADR-0026; design docs/design/capability-knowledge, sections 7 and 8). Three pure
// pieces of the Knowledge context: models.dev's api.json trimmed to a snapshot and judged for freshness, the user's preferences file
// parsed with a refusal per broken entry, and an SOP step's model class linked to the Scorecard cells of its role group.
import { MODEL_CLASSES, type ModelClass } from "./knowledge.ts";
import { err, ok, type Result } from "./shared.ts";

export const SNAPSHOT_STALE_DAYS = 30;

export type ModelFact = { provider: string; model: string; name: string; family: string | null; context: number | null; output: number | null; inputPrice: number | null; outputPrice: number | null; released: string | null };
export type ModelSnapshot = { source: string; fetched: string; licence: string; models: ModelFact[] };

type Rec = Record<string, unknown>;
const isRec = (x: unknown): x is Rec => typeof x === "object" && x !== null && !Array.isArray(x);
const text = (x: unknown): x is string => typeof x === "string" && x.trim() !== "";
const shown = (x: unknown): string => (typeof x === "string" ? x : (JSON.stringify(x) ?? "nothing"));
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const numOf = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null);
const strOrNull = (x: unknown): x is string | null => typeof x === "string" || x === null;
const numOrNull = (x: unknown): x is number | null => x === null || (typeof x === "number" && Number.isFinite(x) && x >= 0);
const utcMs = (date: string): number => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10));
// A real date round-trips through Date.UTC: 2026-02-30 rolls over into March, so it is not one.
const isDate = (x: unknown): x is string => typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x) && new Date(utcMs(x)).toISOString().slice(0, 10) === x;

export function trimModelsDev(api: unknown, meta: { source: string; fetched: string; licence: string }): Result<ModelSnapshot, string> {
  if (!isRec(api)) return err("api.json is a mapping of providers, each mapping model ids to models");
  if (!isDate(meta.fetched)) return err(`fetched must be a real date, YYYY-MM-DD, not '${shown(meta.fetched)}'`);
  if (!text(meta.source) || !text(meta.licence)) return err("source and licence are non-empty strings");
  const models: ModelFact[] = [];
  for (const p of Object.keys(api).sort(byText)) {
    const provider = api[p];
    const catalog = isRec(provider) ? provider.models : undefined;
    if (!isRec(catalog)) continue; // a provider whose models is not a mapping holds nothing we can keep
    for (const m of Object.keys(catalog).sort(byText)) {
      const raw = catalog[m];
      if (!isRec(raw)) continue;
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

export function freshness(fetched: string, today: string): { ageDays: number; stale: boolean } {
  const ageDays = Math.round((utcMs(today) - utcMs(fetched)) / 86_400_000);
  return { ageDays, stale: ageDays > SNAPSHOT_STALE_DAYS };
}

export const PREFERENCE_FIELDS = ["id", "holder", "on", "said", "tasks"] as const;

export type Preference = { id: string; holder: string; on: string; said: string; tasks: string[] };

const PREF_ID = /^[a-z0-9][a-z0-9-]*$/;

export function parsePreferences(doc: unknown): { preferences: Preference[]; refusals: { at: string; message: string }[] } {
  const preferences: Preference[] = [];
  const refusals: { at: string; message: string }[] = [];
  const list = isRec(doc) ? doc.preferences : undefined;
  if (!Array.isArray(list)) return { preferences, refusals: [{ at: "preferences", message: "a preferences file is a mapping with a preferences list" }] };
  (list as unknown[]).forEach((raw, i) => {
    const at = `preferences[${i}]`;
    const refuse = (message: string) => refusals.push({ at, message });
    if (!isRec(raw)) return refuse("a preference is a mapping");
    const extra = Object.keys(raw).find(k => !(PREFERENCE_FIELDS as readonly string[]).includes(k));
    if (extra !== undefined) return refuse(`'${extra}' is not a preference field (${PREFERENCE_FIELDS.join(", ")})`);
    if (!(text(raw.id) && PREF_ID.test(raw.id))) return refuse("id is lowercase letters, digits and hyphens, starting with a letter or a digit");
    if (!text(raw.holder)) return refuse("holder is a non-empty string");
    if (!isDate(raw.on)) return refuse("on must be a real date, YYYY-MM-DD");
    if (!text(raw.said)) return refuse("said is a non-empty string");
    if (!Array.isArray(raw.tasks) || raw.tasks.length === 0 || !raw.tasks.every(text)) return refuse("tasks is a non-empty list of task names");
    preferences.push({ id: raw.id, holder: raw.holder, on: raw.on, said: raw.said, tasks: raw.tasks as string[] });
  });
  return { preferences, refusals };
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
