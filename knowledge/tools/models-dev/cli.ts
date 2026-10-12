// models.dev's command line (ADR-0026, design docs/design/capability-knowledge, section 7). `refresh` fetches api.json and the
// licence, trims them with the domain's trimModelsDev into a dated snapshot under the cache directory, and `show` prints the
// newest one, with a staleness warning past SNAPSHOT_STALE_DAYS (K6) and `?` for a missing value. A stub for now: the tests in
// knowledge/models-dev.test.ts come first and fail on it, and the next task implements run against knowledge-facts.ts.
export const API_URL = "https://models.dev/api.json";
export const LICENCE_URL = "https://raw.githubusercontent.com/anomalyco/models.dev/dev/LICENSE";

export type Fetched = { ok: boolean; status: number; text: () => Promise<string> };
export type Io = { out: (line: string) => void; err: (line: string) => void; fetch: (url: string) => Promise<Fetched>; cacheDir: string; today: string };

export async function run(_args: readonly string[], _io: Io): Promise<number> {
  return -1; // unimplemented, so every test that checks an exit code fails on the stub
}
