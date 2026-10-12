// models.dev's command line (ADR-0026, design docs/design/capability-knowledge, section 7). `refresh` fetches api.json and the
// licence, trims them with the domain's trimModelsDev into a dated snapshot under the cache directory, and `show` prints the newest
// one, with a filter, a staleness warning past SNAPSHOT_STALE_DAYS (K6) and `?` for a missing value. Exit 0: refreshed or shown,
// and a cache with nothing in it yet. 1: no fact matches the filter. 2: a bad call, a failed fetch, or anything unexpected, as one
// line. Never run in CI against the network: the tests pass a fake fetch, and only main.ts hands run the real one.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshness, readSnapshot, SNAPSHOT_STALE_DAYS, trimModelsDev, type ModelFact } from "../../../packages/domain/src/knowledge-facts.ts";

export const API_URL = "https://models.dev/api.json";
export const LICENCE_URL = "https://raw.githubusercontent.com/anomalyco/models.dev/dev/LICENSE";

export type Fetched = { ok: boolean; status: number; text: () => Promise<string> };
export type Io = { out: (line: string) => void; err: (line: string) => void; fetch: (url: string) => Promise<Fetched>; cacheDir: string; today: string };

const USAGE = "usage: models-dev <refresh|show> [provider|provider/model] [--dir <cache-dir>] [--today YYYY-MM-DD]";
const NO_SNAPSHOT = "models.dev: no snapshot yet; run npm run knowledge:models -- refresh";
const SNAPSHOT_FILE = /^\d{4}-\d{2}-\d{2}\.json$/;
const firstLine = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";
const shown = (n: number | null): string => (n === null ? "?" : String(n));

const factLine = (m: ModelFact): string =>
  `${m.provider}/${m.model}  ${m.name}  context ${shown(m.context)}  output ${shown(m.output)}  per 1M tokens in $${shown(m.inputPrice)} out $${shown(m.outputPrice)}  released ${m.released ?? "?"}`;

export async function run(args: readonly string[], io: Io): Promise<number> {
  try {
    let cmd = "";
    let filter = "";
    let dir = io.cacheDir;
    let today = io.today;
    let bad = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i] ?? "";
      if (a === "--dir") dir = args[++i] ?? "\0";
      else if (a === "--today") today = args[++i] ?? "\0";
      else if (a.startsWith("--")) bad = true;
      else if (!cmd) cmd = a;
      else if (cmd === "show" && !filter) filter = a;
      else bad = true;
    }
    if (bad || dir === "\0" || (cmd !== "refresh" && cmd !== "show") || !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
      io.err(USAGE);
      return 2;
    }

    if (cmd === "refresh") {
      const api = await io.fetch(API_URL);
      if (!api.ok) {
        io.err(`models-dev: can't fetch ${API_URL}: ${api.status}`);
        return 2;
      }
      let doc: unknown;
      try {
        doc = JSON.parse(await api.text());
      } catch (e) {
        io.err(`models-dev: api.json is not JSON: ${firstLine(e)}`);
        return 2;
      }
      const licence = await io.fetch(LICENCE_URL);
      if (!licence.ok) {
        io.err(`models-dev: can't fetch ${LICENCE_URL}: ${licence.status}`);
        return 2;
      }
      const snap = trimModelsDev(doc, { source: API_URL, fetched: today, licence: await licence.text() });
      if (!snap.ok) {
        io.err(`models-dev: ${snap.error}`);
        return 2;
      }
      const path = join(dir, `${today}.json`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, `${JSON.stringify(snap.value, null, 2)}\n`);
      const providers = new Set(snap.value.models.map(m => m.provider)).size;
      io.out(`models.dev: ${snap.value.models.length} models from ${providers} providers, fetched ${today}, written to ${path}`);
      return 0;
    }

    const files = (existsSync(dir) ? readdirSync(dir) : []).filter(n => SNAPSHOT_FILE.test(n)).sort();
    const newest = files[files.length - 1];
    if (newest === undefined) {
      io.out(NO_SNAPSHOT);
      return 0;
    }
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(join(dir, newest), "utf8"));
    } catch (e) {
      io.err(`models-dev: ${newest} is not JSON: ${firstLine(e)}`);
      return 2;
    }
    const snap = readSnapshot(doc);
    if (!snap.ok) {
      io.err(`models-dev: ${newest}: ${snap.error}`);
      return 2;
    }
    const facts = snap.value.models.filter(m => !filter || m.provider === filter || `${m.provider}/${m.model}` === filter);
    if (facts.length === 0) {
      io.err(`models-dev: no model matches '${filter}'`);
      return 1;
    }
    io.out(`models.dev, fetched ${snap.value.fetched}, from ${snap.value.source}`);
    const { ageDays, stale } = freshness(snap.value.fetched, today);
    if (stale) io.out(`warning  stale-snapshot  fetched ${snap.value.fetched}, ${ageDays} days ago, past ${SNAPSHOT_STALE_DAYS}: run npm run knowledge:models -- refresh`);
    for (const m of facts) io.out(factLine(m));
    return 0;
  } catch (e) {
    io.err(`models-dev: ${firstLine(e)}`);
    return 2;
  }
}
