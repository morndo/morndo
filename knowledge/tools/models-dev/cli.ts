// models.dev's command line (ADR-0026, design docs/design/capability-knowledge, section 7). `refresh` fetches api.json and the
// licence, each within FETCH_TIMEOUT_MS, trims them with the domain's trimModelsDev into a snapshot dated today under the cache
// directory (cacheDirOf), written whole or not at all, and `show` prints the newest snapshot that reads, saying which newer ones it skipped,
// with a filter, a warning past SNAPSHOT_STALE_DAYS (K6) or for a date after today, and `?` for a missing value. Exit 0:
// refreshed or shown, and a cache with nothing in it yet. 1: no fact matches the filter. 2: a bad call, a failed or timed-out
// fetch, or anything unexpected, as one line. Never run in CI against the network: the tests pass a fake fetch, and only
// main.ts hands run the real one.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freshness, SNAPSHOT_STALE_DAYS, trimModelsDev, type ModelFact, type ModelSnapshot } from "../../../packages/domain/src/knowledge-facts.ts";
import { isDate } from "../../../packages/domain/src/knowledge-guards.ts";
import { err, ok, type Result } from "../../../packages/domain/src/shared.ts";
import { firstLine, readSnapshotFile, SNAPSHOT_FILE } from "../shared.ts";

export const API_URL = "https://models.dev/api.json";
export const LICENCE_URL = "https://raw.githubusercontent.com/anomalyco/models.dev/dev/LICENSE";
// How long one request may take, its body included: api.json is about 5 MB.
export const FETCH_TIMEOUT_MS = 60_000;
// A temporary file older than this belongs to a refresh that died before its rename; a younger one may be one still writing.
export const LEFTOVER_MS = 10 * 60_000;
const TMP_FILE = /^\d{4}-\d{2}-\d{2}\.json\.\d+\.tmp$/;

// The snapshot directory: under $XDG_CACHE_HOME, or ~/.cache when it is unset or empty.
export const cacheDirOf = (env: Readonly<Record<string, string | undefined>>, home: string): string =>
  join(env.XDG_CACHE_HOME || join(home, ".cache"), "morndo-knowledge", "models-dev");

// A body it won't read is cancelled, so the connection is let go at once (undici's README, "Garbage Collection": always
// either consume or cancel the response body; read 2026-10-12).
export type Fetched = { ok: boolean; status: number; text: () => Promise<string>; body?: { cancel: () => Promise<void> } | null };
// fetch honours the signal for the headers and the body, as the platform's fetch does. today is the real date: refresh always
// dates its snapshot with it, and only show takes --today. timeoutMs and writeFile are for tests; they default to the real ones.
export type Io = {
  out: (line: string) => void;
  err: (line: string) => void;
  fetch: (url: string, signal: AbortSignal) => Promise<Fetched>;
  cacheDir: string;
  today: string;
  timeoutMs?: number;
  writeFile?: (path: string, data: string) => void;
};

const USAGE = "usage: models-dev refresh [--dir <cache-dir>] | models-dev show [provider|provider/model] [--dir <cache-dir>] [--today YYYY-MM-DD]";
const NO_SNAPSHOT = "models.dev: no snapshot yet; run npm run knowledge:models -- refresh";
const orUnknown = (n: number | null): string => (n === null ? "?" : String(n));
const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

const factLine = (m: ModelFact): string =>
  `${m.provider}/${m.model}  ${m.name}  context ${orUnknown(m.context)}  output ${orUnknown(m.output)}  per 1M tokens in $${orUnknown(m.inputPrice)} out $${orUnknown(m.outputPrice)}  released ${m.released ?? "?"}`;

// One request, its body included, within the deadline: the body, or why not as one line.
async function fetchText(io: Io, url: string): Promise<Result<string, string>> {
  const ms = io.timeoutMs ?? FETCH_TIMEOUT_MS;
  const signal = AbortSignal.timeout(ms);
  try {
    const res = await io.fetch(url, signal);
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined); // the status is the failure; a body that won't cancel adds nothing
      return err(`can't fetch ${url}: ${res.status}`);
    }
    return ok(await res.text());
  } catch (e) {
    return err(`can't fetch ${url}: ${signal.aborted ? `no answer within ${ms / 1000} s` : firstLine(e)}`);
  }
}

// The snapshot whole or not at all: written to a temporary file beside it, then renamed over it, which POSIX rename(2) does
// atomically within one file system. A write that breaks leaves the cache as it was.
function writeWhole(path: string, data: string, write: (path: string, data: string) => void): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    write(tmp, data);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

// Removes the temporary files of refreshes that died, which nothing else would ever remove.
function clearLeftovers(dir: string, now: number): void {
  for (const name of readdirSync(dir).filter(n => TMP_FILE.test(n))) {
    const stat = statSync(join(dir, name), { throwIfNoEntry: false });
    if (stat && now - stat.mtimeMs > LEFTOVER_MS) rmSync(join(dir, name), { force: true });
  }
}

export async function run(args: readonly string[], io: Io): Promise<number> {
  try {
    let cmd = "";
    let filter = "";
    let dir = io.cacheDir;
    let today = io.today;
    let dated = false;
    let bad = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i] ?? "";
      if (a === "--dir") dir = args[++i] ?? "\0";
      else if (a === "--today") {
        today = args[++i] ?? "\0";
        dated = true;
      }
      else if (a.startsWith("--")) bad = true;
      else if (!cmd) cmd = a;
      else if (cmd === "show" && !filter) filter = a;
      else bad = true;
    }
    if (bad || dir === "\0" || (cmd !== "refresh" && cmd !== "show") || !isDate(today)) {
      io.err(USAGE);
      return 2;
    }

    if (cmd === "refresh") {
      if (dated) {
        io.err("models-dev: refresh dates its snapshot with today's real date; --today is for show");
        return 2;
      }
      const api = await fetchText(io, API_URL);
      if (!api.ok) {
        io.err(`models-dev: ${api.error}`);
        return 2;
      }
      let doc: unknown;
      try {
        doc = JSON.parse(api.value);
      } catch (e) {
        io.err(`models-dev: api.json is not JSON: ${firstLine(e)}`);
        return 2;
      }
      const licence = await fetchText(io, LICENCE_URL);
      if (!licence.ok) {
        io.err(`models-dev: ${licence.error}`);
        return 2;
      }
      const snap = trimModelsDev(doc, { source: API_URL, fetched: today, licence: licence.value });
      if (!snap.ok) {
        io.err(`models-dev: ${snap.error}`);
        return 2;
      }
      const path = join(dir, `${today}.json`);
      try {
        mkdirSync(dir, { recursive: true });
        clearLeftovers(dir, Date.now());
        writeWhole(path, `${JSON.stringify(snap.value, null, 2)}\n`, io.writeFile ?? writeFileSync);
      } catch (e) {
        io.err(`models-dev: can't write ${path}: ${firstLine(e)}`);
        return 2;
      }
      const providers = new Set(snap.value.models.map(m => m.provider)).size;
      io.out(`models.dev: ${snap.value.models.length} models from ${providers} providers, fetched ${today}, written to ${path}`);
      return 0;
    }

    // Newest first: the first that reads is shown, and each newer one that doesn't is named.
    const files = (existsSync(dir) ? readdirSync(dir) : []).filter(n => SNAPSHOT_FILE.test(n)).sort().reverse();
    if (files.length === 0) {
      io.out(NO_SNAPSHOT);
      return 0;
    }
    const skipped: { file: string; why: string }[] = [];
    let found: { file: string; snap: ModelSnapshot } | null = null;
    for (const file of files) {
      const read = readSnapshotFile(join(dir, file));
      if (read.ok) {
        found = { file, snap: read.value };
        break;
      }
      skipped.push({ file, why: read.error });
    }
    if (found === null) {
      const newest = `the newest, ${files[0]}: ${skipped[0]?.why ?? ""}`;
      io.err(files.length === 1 ? `models-dev: the one snapshot in ${dir} doesn't read; ${newest}` : `models-dev: none of the ${files.length} snapshots in ${dir} reads; ${newest}`);
      return 2;
    }
    const { file, snap } = found;
    const facts = snap.models.filter(m => !filter || m.provider === filter || `${m.provider}/${m.model}` === filter);
    if (facts.length > 0) io.out(`models.dev, fetched ${snap.fetched}, from ${snap.source}`);
    for (const s of skipped) io.out(`warning  skipped-snapshot  ${s.file}  ${s.why}; using ${file}`);
    if (facts.length === 0) {
      io.err(`models-dev: no model matches '${filter}'`);
      return 1;
    }
    const { ageDays, state } = freshness(snap.fetched, today);
    if (state === "stale") io.out(`warning  stale-snapshot  fetched ${snap.fetched}, ${ageDays} days ago, past ${SNAPSHOT_STALE_DAYS}: run npm run knowledge:models -- refresh`);
    if (state === "future") io.out(`warning  future-snapshot  fetched ${snap.fetched}, ${days(-ageDays)} after today, ${today}: check this machine's clock and the snapshot's date`);
    for (const m of facts) io.out(factLine(m));
    return 0;
  } catch (e) {
    io.err(`models-dev: ${firstLine(e)}`);
    return 2;
  }
}
