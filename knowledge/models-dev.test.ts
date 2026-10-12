// models-dev, the command. Its logic (knowledge/tools/models-dev/cli.ts) through `run`: refresh trims models.dev's api.json and
// licence into a dated snapshot under a cache directory (the fixture is made-up, in api.json's shape), and show prints the newest
// snapshot, with a filter, a staleness warning past SNAPSHOT_STALE_DAYS that never fails (K6) and `?` for a missing value. The net
// is a fake that records the URLs it serves, so nothing here reaches models.dev. Then main.ts, as sop-check's, sets the exit code.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { SNAPSHOT_STALE_DAYS } from "../packages/domain/src/knowledge-facts.ts";
import { API_URL, LICENCE_URL, run, type Io } from "./tools/models-dev/cli.ts";

const LICENCE = "Example licence: permission granted to test.";
const FIXTURE = readFileSync(join(import.meta.dirname, "tools/models-dev/fixture-api.json"), "utf8");
const tmp = mkdtempSync(join(tmpdir(), "models-dev-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// What trimModelsDev makes of the fixture for 2026-10-12: sorted by provider then model, one fact per model, nothing else kept.
const LARGE_FACT = { provider: "acme", model: "acme-large-2", name: "Acme Large 2", family: "acme-large", context: 400_000, output: 64_000, inputPrice: 3, outputPrice: 12, released: "2026-08-15" };
const SMALL_FACT = { provider: "acme", model: "acme-small-1", name: "Acme Small 1", family: null, context: 128_000, output: 16_384, inputPrice: null, outputPrice: null, released: null };
const PRO_FACT = { provider: "zenith", model: "zenith-pro", name: "Zenith Pro", family: "zenith-pro", context: 200_000, output: 32_000, inputPrice: 1.25, outputPrice: 5, released: "2026-09-01" };
const SNAPSHOT = { source: API_URL, fetched: "2026-10-12", licence: LICENCE, models: [LARGE_FACT, SMALL_FACT, PRO_FACT] };

const HEADER = `models.dev, fetched 2026-10-12, from ${API_URL}`;
const LARGE_LINE = "acme/acme-large-2  Acme Large 2  context 400000  output 64000  per 1M tokens in $3 out $12  released 2026-08-15";
const SMALL_LINE = "acme/acme-small-1  Acme Small 1  context 128000  output 16384  per 1M tokens in $? out $?  released ?";
const PRO_LINE = "zenith/zenith-pro  Zenith Pro  context 200000  output 32000  per 1M tokens in $1.25 out $5  released 2026-09-01";
const FACTS = [LARGE_LINE, SMALL_LINE, PRO_LINE];
const NO_SNAPSHOT = "models.dev: no snapshot yet; run npm run knowledge:models -- refresh";
const STALE = `warning  stale-snapshot  fetched 2026-10-12, 31 days ago, past ${SNAPSHOT_STALE_DAYS}: run npm run knowledge:models -- refresh`;

// A fake net: it records each URL it is asked for and answers the fixture for api.json and the made-up licence for the licence.
// `api` breaks the api.json answer on demand: another status, a body that is not JSON, or a rejected promise.
type Api = { text?: string; ok?: boolean; offline?: boolean };
const call = async (args: readonly string[], cacheDir: string, api: Api = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const urls: string[] = [];
  const io: Io = {
    out: l => out.push(l), err: l => err.push(l), cacheDir, today: "2026-10-12",
    fetch: url => {
      urls.push(url);
      if (api.offline) return Promise.reject(new Error("the net is down"));
      if (url === LICENCE_URL) return Promise.resolve({ ok: true, status: 200, text: async () => LICENCE });
      return Promise.resolve({ ok: api.ok ?? true, status: api.ok === false ? 503 : 200, text: async () => api.text ?? FIXTURE });
    },
  };
  return { code: await run(args, io), out, err, urls };
};

describe("refresh", () => {
  it("fetches api.json and the licence, trims to one fact per model and writes today's snapshot", async () => {
    const dir = join(tmp, "refresh");
    const r = await call(["refresh"], dir);
    expect([r.code, r.err]).toEqual([0, []]);
    expect(r.urls).toEqual([API_URL, LICENCE_URL]);
    const path = join(dir, "2026-10-12.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(SNAPSHOT);
    expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(SNAPSHOT, null, 2)}\n`);
    expect(r.out).toEqual([`models.dev: 3 models from 2 providers, fetched 2026-10-12, written to ${path}`]);
  });
  it("a 503 from api.json writes nothing and fails with one line", async () => {
    const dir = join(tmp, "down");
    const r = await call(["refresh"], dir, { ok: false });
    expect([r.code, r.out, r.err.length]).toEqual([2, [], 1]);
    expect(r.err[0]).toMatch(/^models-dev: /);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });
  it("a fetch that throws fails the same way", async () => {
    const r = await call(["refresh"], join(tmp, "offline"), { offline: true });
    expect([r.code, r.out, r.err.length]).toEqual([2, [], 1]);
    expect(r.err[0]).toMatch(/^models-dev: /);
  });
  it("a body that is not JSON fails with one line", async () => {
    const r = await call(["refresh"], join(tmp, "not-json"), { text: "this is not json" });
    expect([r.code, r.out, r.err.length]).toEqual([2, [], 1]);
    expect(r.err[0]).toMatch(/^models-dev: /);
  });
});

describe("show", () => {
  it("with no snapshot yet it says how to get one, and fails nothing", async () => {
    expect(await call(["show"], join(tmp, "no-snapshot"))).toEqual({ code: 0, out: [NO_SNAPSHOT], err: [], urls: [] });
  });
  it("after a refresh it shows the header and one line per fact, with ? for a missing value", async () => {
    const dir = join(tmp, "shown");
    expect((await call(["refresh"], dir)).code).toBe(0);
    expect(await call(["show"], dir)).toEqual({ code: 0, out: [HEADER, ...FACTS], err: [], urls: [] });
  });
  it("takes a provider or a provider/model as its filter; nothing matching is exit 1", async () => {
    const dir = join(tmp, "filtered");
    expect((await call(["refresh"], dir)).code).toBe(0);
    expect(await call(["show", "acme"], dir)).toEqual({ code: 0, out: [HEADER, LARGE_LINE, SMALL_LINE], err: [], urls: [] });
    expect(await call(["show", "acme/acme-large-2"], dir)).toEqual({ code: 0, out: [HEADER, LARGE_LINE], err: [], urls: [] });
    expect(await call(["show", "nobody"], dir)).toEqual({ code: 1, out: [], err: [expect.any(String)], urls: [] });
  });
  it("warns past SNAPSHOT_STALE_DAYS without failing, and not a day earlier", async () => {
    const dir = join(tmp, "stale");
    expect((await call(["refresh"], dir)).code).toBe(0);
    expect(await call(["show", "--today", "2026-11-12"], dir)).toEqual({ code: 0, out: [HEADER, STALE, ...FACTS], err: [], urls: [] });
    expect(await call(["show", "--today", "2026-11-11"], dir)).toEqual({ code: 0, out: [HEADER, ...FACTS], err: [], urls: [] });
  });
  it("reads the newest snapshot by name, and --dir points it away from the cache directory", async () => {
    const dir = join(tmp, "two");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-09-01.json"), `${JSON.stringify({ ...SNAPSHOT, fetched: "2026-09-01", models: [PRO_FACT] }, null, 2)}\n`);
    expect((await call(["refresh"], dir)).code).toBe(0);
    expect(await call(["show", "--dir", dir], join(tmp, "elsewhere"))).toEqual({ code: 0, out: [HEADER, ...FACTS], err: [], urls: [] });
  });
  it("a snapshot file that is not JSON is exit 2, one line", async () => {
    const dir = join(tmp, "corrupt");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-10-12.json"), "{");
    const r = await call(["show"], dir);
    expect([r.code, r.out, r.err.length]).toEqual([2, [], 1]);
  });
});

describe("bad calls", () => {
  it("no command, an unknown command, a flag without its value or a malformed --today: exit 2, one line, nothing on out", async () => {
    for (const args of [[], ["fetch"], ["show", "--dir"], ["refresh", "--today", "soon"]]) {
      const r = await call(args, join(tmp, "bad"));
      expect([args, r.code, r.err.length, r.out]).toEqual([args, 2, 1, []]);
    }
  });
});

describe("main", () => {
  it("sets the exit code and lets output drain, instead of exiting at once", () => {
    const main = readFileSync("knowledge/tools/models-dev/main.ts", "utf8");
    expect([main.includes("process.exitCode"), main.includes("process.exit(")]).toEqual([true, false]);
  });
});
