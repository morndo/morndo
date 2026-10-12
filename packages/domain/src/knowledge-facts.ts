// Model facts, preferences and the Scorecard link (ADR-0026; design docs/design/capability-knowledge, sections 7 and 8). Three pure
// pieces of the Knowledge context: models.dev's api.json trimmed to a snapshot and judged for freshness, the user's preferences file
// parsed with a refusal per broken entry, and an SOP step's model class linked to the Scorecard cells of its role group. This file is
// the stub: every function returns a wrong value on purpose, so the behavioural tests in test/knowledge-facts.test.ts fail by
// assertion, not by import error, until the next task implements them.
import { MODEL_CLASSES, type ModelClass } from "./knowledge.ts";
import { err, ok, type Result } from "./shared.ts";

export const SNAPSHOT_STALE_DAYS = 30;

export type ModelFact = { provider: string; model: string; name: string; family: string | null; context: number | null; output: number | null; inputPrice: number | null; outputPrice: number | null; released: string | null };
export type ModelSnapshot = { source: string; fetched: string; licence: string; models: ModelFact[] };

const NOTHING: ModelSnapshot = { source: "", fetched: "", licence: "", models: [] };

export function trimModelsDev(_api: unknown, _meta: { source: string; fetched: string; licence: string }): Result<ModelSnapshot, string> {
  return ok(NOTHING);
}

export function readSnapshot(_doc: unknown): Result<ModelSnapshot, string> {
  return ok(NOTHING);
}

export function freshness(_fetched: string, _today: string): { ageDays: number; stale: boolean } {
  return { ageDays: -1, stale: false };
}

export const PREFERENCE_FIELDS = ["id", "holder", "on", "said", "tasks"] as const;

export type Preference = { id: string; holder: string; on: string; said: string; tasks: string[] };

export function parsePreferences(_doc: unknown): { preferences: Preference[]; refusals: { at: string; message: string }[] } {
  return { preferences: [], refusals: [] };
}

export function renderPreference(_p: Preference): string {
  return "";
}

export type ScorecardCell = { entry: string; group: string; modelClass: ModelClass | "unknown"; family: string; runs: number; firstTry: number; editsAsked: number };

export function roleGroup(_role: string): string {
  return "";
}

export function scorecardFor(_step: { role: string; model: unknown }, _cells: readonly ScorecardCell[]): Result<ScorecardCell[], string> {
  return err(`unknown class '${MODEL_CLASSES[0]}'`);
}
