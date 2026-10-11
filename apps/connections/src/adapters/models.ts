// Model lists are fetched by the CLI under a probe lease, then cached for the sync lister.
// Anthropic's list wants x-api-key. OpenAI's list wants Authorization: Bearer.
// https://platform.claude.com/docs/en/api/models/list and
// https://developers.openai.com/api/reference/resources/models/methods/list — checked 2026-10-10.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { VendorPreset } from "@morndo/protocol";
import type { ModelLister, ModelRow } from "../application/ports.ts";

type Listed = { data?: { id?: unknown }[] };

export function modelHeaders(shape: "anthropic-list" | "openai-list", key: string): Record<string, string> {
  if (key === "") return {};
  if (shape === "anthropic-list") return { "x-api-key": key, "anthropic-version": "2023-06-01" };
  return { authorization: `Bearer ${key}` };
}

export async function fetchModelIds(preset: VendorPreset, key = "", fetchImpl: typeof fetch = fetch): Promise<readonly string[]> {
  const models = preset.models;
  if (models.source === "static") return models.ids;
  if (models.source !== "endpoint") return [];
  const response = await fetchImpl(models.url, { headers: modelHeaders(models.shape, key) });
  if (!response.ok) throw new Error(`model list ${response.status}`);
  const body = await response.json() as Listed;
  const ids = (body.data ?? []).flatMap(row => typeof row.id === "string" && row.id !== "" ? [row.id] : []);
  return ids;
}

export function wantedModel(pick: string | undefined): string | null {
  if (!pick) return null;
  const model = pick.split("@")[0];
  return model && model !== "" ? model : null;
}

const PLACEHOLDER_MODELS = new Set(["default", "ask"]);

export function launchChoice(picks: Readonly<Record<string, string>>, role: string): { model: string; effort: string } {
  const pick = picks[role] ?? picks["*"];
  const named = wantedModel(pick);
  const model = named === null || PLACEHOLDER_MODELS.has(named) ? "" : named;
  const effort = pick?.split("@")[1];
  return { model, effort: effort && effort !== "" ? effort : "high" };
}

export function sameModel(alias: string, reported: string, patterns: Readonly<Record<string, string>> = {}): boolean {
  if (reported === alias) return true;
  const pattern = patterns[alias];
  if (pattern === undefined) return false;
  if (pattern === "*") return reported !== "";
  const source = pattern.startsWith("^") ? pattern : `^(?:${pattern})$`;
  try { return new RegExp(source).test(reported); }
  catch { return false; }
}

export function modelMissing(ids: readonly string[], pick: string | undefined, patterns: Readonly<Record<string, string>> = {}): boolean {
  const model = wantedModel(pick);
  return model !== null && ids.length > 0 && !ids.some(id => sameModel(model, id, patterns));
}

export class FileModels implements ModelLister {
  readonly #dir: string;
  constructor(dir: string) { this.#dir = dir; }

  models(connection: { name: string; vendor: string }): readonly ModelRow[] {
    try {
      const body = JSON.parse(readFileSync(join(this.#dir, `${connection.vendor}.json`), "utf8")) as { ids?: unknown };
      if (!Array.isArray(body.ids)) return [];
      return body.ids.flatMap(id => typeof id === "string" ? [{ id, efforts: null }] : []);
    } catch { return []; }
  }

  write(vendor: string, ids: readonly string[]): void {
    mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(this.#dir, `${vendor}.json`), JSON.stringify({ ids }), { mode: 0o600 });
  }
}
