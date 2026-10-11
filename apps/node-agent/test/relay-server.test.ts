// The hook relay over real HTTP (spec §5.5): each path's answer, window identity, coalescing, /file copies, and what
// happens when the spool can't be written (a full disk, simulated by a database that refuses writes).
import { existsSync, mkdirSync, readFileSync, readdirSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIMITS } from "@morndo/protocol";
import { openAgentDb, type AgentDb } from "../src/db/open.ts";
import { nodeOpener } from "../src/ops/node-files.ts";
import { agentPaths, type AgentPaths } from "../src/paths.ts";
import { RelayFiles } from "../src/relay/relay-files.ts";
import { HOOK_BODY_MAX, startRelay, type Relay } from "../src/relay/server.ts";
import { Spool } from "../src/relay/spool.ts";
import { windowResolver } from "../src/relay/window-of.ts";
import { captureLog, tempHome } from "./helpers.ts";

let home: { home: string; cleanup: () => void };
let paths: AgentPaths;
let adb: AgentDb;
let spool: Spool;
let files: RelayFiles;
let relay: Relay;
let now = 1_000;                                                    // one clock for the relay, the spool and the copies
let kicks = 0;
beforeEach(async () => {
  now = 1_000;
  home = tempHome();
  paths = agentPaths(home.home);
  adb = openAgentDb(paths.dbPath);
  spool = new Spool(adb.db, adb.streamId, { now: () => now });
  files = new RelayFiles({ dir: paths.relayFilesDir, db: adb.db, open: nodeOpener({ home: home.home, stateDir: paths.stateDir, configDir: paths.configDir }), now: () => now });
  const windows = new Map([["%3", "api lane"], ["%7", "web"]]);
  const sessions = new Map([["%7", { sessionId: "sess-web", name: null, pane: "%7", cwd: "/w", version: null, pid: 1, status: null }]]);
  relay = await startRelay({
    port: 0, spool, files, log: captureLog().log, onAppended: () => { kicks++; }, now: () => now,
    windowOf: windowResolver({ windowOfPane: p => windows.get(p) ?? null, sessions: () => sessions }),
  });
});
afterEach(async () => { await relay.close(); adb.close(); home.cleanup(); });

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${relay.port}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const rows = () => spool.after(0, 1000);

describe("answers (spec §5.5)", () => {
  it("204 empty for /cc and /sl, 200 {ok,queued} for /hook/stop, 202 for the others; each after the event is spooled", async () => {
    const cc = await post("/cc", { session_id: "s1", TMUX_PANE: "%3" });
    expect(cc.status).toBe(204);
    expect(await cc.text()).toBe("");
    expect((await post("/sl", { session_id: "s1" })).status).toBe(204);
    const stop = await post("/hook/stop", { session_id: "sess-web", last: "done" });
    expect(stop.status).toBe(200);
    expect(await stop.json()).toEqual({ ok: true, queued: true });
    expect((await post("/hook/failure", { error: "x" })).status).toBe(202);
    expect((await post("/notify", "plain words")).status).toBe(202);
    expect(rows().map(r => [r.path, r.window, r.body])).toEqual([
      ["/cc", "api lane", { session_id: "s1", TMUX_PANE: "%3" }],
      ["/sl", null, { session_id: "s1" }],
      ["/hook/stop", "web", { session_id: "sess-web", last: "done" }],          // session_id → pane %7 → its window
      ["/hook/failure", null, { error: "x" }],
      ["/notify", null, "plain words"],
    ]);
    expect(rows().every(r => r.at === 1_000)).toBe(true);
  });
  it("404 for an unknown path, 405 for a GET on a script path, and refuses requests from web pages", async () => {
    expect((await post("/elsewhere", {})).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${relay.port}/hook/stop`)).status).toBe(405);
    expect((await post("/notify", { x: 1 }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await post("/cc", { session_id: "s" }, { Origin: "https://evil.example" })).status).toBe(204);
    expect(rows()).toEqual([]);
  });
  it("coalesces /cc to the latest per session", async () => {
    for (const n of [1, 2, 3]) await post("/cc", { session_id: "a", n });
    await post("/cc", { session_id: "b", n: 4 });
    expect(rows().map(r => r.body)).toEqual([{ session_id: "a", n: 3 }, { session_id: "b", n: 4 }]);
  });
  it("refuses bodies too big for one message: dropped for progress, 413 for the script paths", async () => {
    const big = { pad: "x".repeat(HOOK_BODY_MAX) };
    expect((await post("/cc", big)).status).toBe(204);
    expect((await post("/notify", big)).status).toBe(413);
    expect(rows()).toEqual([]);
    expect(spool.drops).toBe(1);
  });
});

describe("a spool that can't be written (a full disk)", () => {
  it("still answers 204 on /cc and /sl, and 503 on the script paths so their fallbacks run; drops are counted", async () => {
    mkdirSync(join(home.home, "work"));
    writeFileSync(join(home.home, "work", "f.txt"), "data");
    adb.db.pragma("query_only = ON");
    expect((await post("/cc", { session_id: "a" })).status).toBe(204);
    expect((await post("/sl", { session_id: "a" })).status).toBe(204);
    for (const path of ["/hook/stop", "/hook/failure", "/notify"]) expect((await post(path, { x: 1 })).status, path).toBe(503);
    expect((await post("/file", { path: join(home.home, "work", "f.txt") })).status).toBe(503);
    expect(existsSync(paths.relayFilesDir) ? readdirSync(paths.relayFilesDir) : []).toEqual([]);   // the copy went too
    expect(spool.drops).toBe(6);
    adb.db.pragma("query_only = OFF");
    expect((await post("/hook/stop", { x: 1 })).status).toBe(200);              // negative control
  });
});

describe("/file", () => {
  it("copies the file under confinement and spools its ref, name and size instead of the path", async () => {
    mkdirSync(join(home.home, "work"));
    writeFileSync(join(home.home, "work", "report.pdf"), "pdf-bytes");
    expect((await post("/file", { path: join(home.home, "work", "report.pdf"), caption: "the report", TMUX_PANE: "%3" })).status).toBe(202);
    const [row] = rows();
    const body = row?.body as { ref: string; name: string; size: number; caption: string };
    expect(body).toEqual({ ref: expect.stringMatching(/^[0-9a-f]{32}$/), name: "report.pdf", size: 9, caption: "the report", TMUX_PANE: "%3" });
    expect(row?.window).toBe("api lane");
    expect(readFileSync(join(paths.relayFilesDir, body.ref), "utf8")).toBe("pdf-bytes");
    expect(adb.db.prepare("SELECT seq FROM relay_files WHERE ref = ?").get(body.ref)).toEqual({ seq: row?.seq });
  });
  it("answers 413 over 25 MiB, 403 for credentials and secrets, 404 for a missing file, 400 without a path", async () => {
    mkdirSync(join(home.home, "work"));
    mkdirSync(join(home.home, ".ssh"));
    writeFileSync(join(home.home, "work", "big.bin"), "");
    truncateSync(join(home.home, "work", "big.bin"), LIMITS.maxFileBytes + 1);
    writeFileSync(join(home.home, ".ssh", "id_rsa"), "k");
    writeFileSync(join(home.home, "work", ".env"), "k");
    expect((await post("/file", { path: join(home.home, "work", "big.bin") })).status).toBe(413);
    expect((await post("/file", { path: join(home.home, ".ssh", "id_rsa") })).status).toBe(403);
    expect((await post("/file", { path: join(home.home, "work", ".env") })).status).toBe(403);
    expect((await post("/file", { path: join(home.home, "work", "nope.txt") })).status).toBe(404);
    expect((await post("/file", { caption: "no path" })).status).toBe(400);
    expect(rows()).toEqual([]);
  });
  it("deletes a copy 24 hours after its event was acknowledged, not before", async () => {
    mkdirSync(join(home.home, "work"));
    writeFileSync(join(home.home, "work", "a.txt"), "a");
    await post("/file", { path: join(home.home, "work", "a.txt") });
    const [row] = rows();
    if (!row) throw new Error("nothing spooled");
    const ref = (row.body as { ref: string }).ref;
    spool.ack(row.seq);
    now += LIMITS.relayFileKeepMs;
    expect(files.sweep()).toBe(0);
    expect(existsSync(join(paths.relayFilesDir, ref))).toBe(true);
    now += 1;
    expect(files.sweep()).toBe(1);
    expect(existsSync(join(paths.relayFilesDir, ref))).toBe(false);
    expect(adb.db.prepare("SELECT COUNT(*) AS n FROM relay_files").get()).toEqual({ n: 0 });
  });
});

describe("the disk budget (LIMITS.spoolMaxBytes: the spool, the relay's copies and the upload inbox together)", () => {
  it("answers /file with 503 when the copy doesn't fit, so the script's fallback runs; nothing is copied or spooled, and it counts as a drop", async () => {
    mkdirSync(join(home.home, "work"));
    writeFileSync(join(home.home, "work", "big.txt"), "x".repeat(11));
    writeFileSync(join(home.home, "work", "small.txt"), "x".repeat(10));
    const tight = new RelayFiles({ dir: paths.relayFilesDir, db: adb.db, open: nodeOpener({ home: home.home, stateDir: paths.stateDir, configDir: paths.configDir }), room: () => 10, now: () => now });
    const small = await startRelay({ port: 0, spool, files: tight, log: captureLog().log, onAppended: () => {}, now: () => now, windowOf: () => null });
    try {
      const at = (path: string) => fetch(`http://127.0.0.1:${small.port}/file`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
      expect((await at(join(home.home, "work", "big.txt"))).status).toBe(503);
      expect(existsSync(paths.relayFilesDir) ? readdirSync(paths.relayFilesDir) : []).toEqual([]);
      expect(rows()).toEqual([]);
      expect(spool.drops).toBe(1);
      expect((await at(join(home.home, "work", "small.txt"))).status).toBe(202);      // negative control: what fits
      expect(tight.bytes()).toBe(10);
    } finally {
      await small.close();
    }
  });
});

describe("kicks", () => {
  it("tells the stream sender after each spooled event", async () => {
    const before = kicks;
    await post("/notify", { x: 1 });
    await new Promise(r => setImmediate(r));
    expect(kicks).toBe(before + 1);
  });
});
