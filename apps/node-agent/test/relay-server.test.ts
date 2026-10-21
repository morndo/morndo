// The hook relay over real HTTP (spec §5.5): each path's answer, window identity, coalescing, /file copies, and what
// happens when the spool can't be written (a full disk, simulated by a database that refuses writes).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionRegistry } from "@morndo/node-ops";
import { LIMITS } from "@morndo/protocol";
import { openAgentDb, type AgentDb } from "../src/db/open.ts";
import { nodeOpener } from "../src/ops/node-files.ts";
import { agentPaths, type AgentPaths } from "../src/paths.ts";
import { RelayFiles } from "../src/relay/relay-files.ts";
import { HOOK_BODY_MAX, startRelay, type Relay } from "../src/relay/server.ts";
import { Spool } from "../src/relay/spool.ts";
import { foreignStop, windowResolver } from "../src/relay/window-of.ts";
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
    foreign: foreignStop({ headless: () => false }),                     // none of these bodies is headless; the (B6) describe uses a real registry
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

// B6: a headless run started in a lane's pane posts its Stop and its failures as the lane (the pane's window); the relay
// answers them and drops them, so the lane's turn is not ended by them. Judged by the poster's own session file alone
// (sessions.ts headless, read again per event); every other Stop is the lane's (fail open).
describe("a Stop from another session (B6)", () => {
  const windows = new Map([["%3", "api lane"], ["%7", "web"]]);
  // A relay over a real session registry: `sessionFiles` as `<name>.json` → fields, writable again while it runs.
  const claudeRig = async (sessionFiles: [string, Record<string, unknown>][]) => {
    const claude = mkdtempSync(join(tmpdir(), "morndo-claude-"));
    mkdirSync(join(claude, "sessions"));
    for (const [name, fields] of sessionFiles) writeFileSync(join(claude, "sessions", name), JSON.stringify(fields));
    const reg = sessionRegistry(claude);
    const relay = await startRelay({
      port: 0, spool, files, log: captureLog().log, onAppended: () => { kicks++; }, now: () => now,
      windowOf: windowResolver({ windowOfPane: p => windows.get(p) ?? null, sessions: () => reg.byPane() }),
      foreign: foreignStop({ headless: id => reg.headless(id) }),
    });
    return {
      post: (path: string, body: unknown) =>
        fetch(`http://127.0.0.1:${relay.port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      write: (name: string, fields: Record<string, unknown>) => writeFileSync(join(claude, "sessions", name), JSON.stringify(fields)),
      close: async () => { await relay.close(); rmSync(claude, { recursive: true, force: true }); },
    };
  };
  const lane = { pid: process.pid, sessionId: "sess-lane", tmux: "qa:@0.%7", entrypoint: "cli", startedAt: 1_000 };
  const headless = { pid: process.pid, sessionId: "sess-headless", tmux: "qa:@0.%7", entrypoint: "sdk-cli", startedAt: 2_000 };
  it("a headless Stop is not a lane finish; the lane's own Stop is", async () => {
    for (const [first, second] of [[lane, headless], [headless, lane]] as const) {
      const rig = await claudeRig([["1.json", first], ["2.json", second]]);
      try {
        const before = rows().length;
        const kicksBefore = kicks;
        const dropped = await rig.post("/hook/stop", { TMUX_PANE: "%7", session_id: "sess-headless", last: "x" });
        expect(dropped.status).toBe(200);
        expect(await dropped.json()).toEqual({ ok: true, queued: false });
        expect(rows().length).toBe(before);
        expect(kicks).toBe(kicksBefore);
        const kept = await rig.post("/hook/stop", { TMUX_PANE: "%7", session_id: "sess-lane" });
        expect(kept.status).toBe(200);
        expect(await kept.json()).toEqual({ ok: true, queued: true });
        expect(rows().slice(before).map(r => [r.path, r.window])).toEqual([["/hook/stop", "web"]]);
      } finally {
        await rig.close();
      }
    }
  });
  it("the lane's Stop after /clear and after a resume is a lane finish", async () => {
    // /clear gives the same process a new session id; a resume leaves a headless run in the pane that is the older one.
    // Neither drops the lane's own Stop: only a session that positively says headless is dropped (fail open).
    const rig = await claudeRig([["1.json", lane]]);
    try {
      rig.write("1.json", { ...lane, sessionId: "sess-cleared" });
      const cleared = await rig.post("/hook/stop", { TMUX_PANE: "%7", session_id: "sess-cleared" });
      expect(cleared.status).toBe(200);
      expect(await cleared.json()).toEqual({ ok: true, queued: true });
      rig.write("1.json", { ...lane, sessionId: "sess-resumed", startedAt: 3_000 });
      rig.write("2.json", { ...headless, startedAt: 500 });             // older than the lane's, the same pane
      const dropped = await rig.post("/hook/stop", { TMUX_PANE: "%7", session_id: "sess-headless" });
      expect(await dropped.json()).toEqual({ ok: true, queued: false });
      const resumed = await rig.post("/hook/stop", { TMUX_PANE: "%7", session_id: "sess-resumed" });
      expect(resumed.status).toBe(200);
      expect(await resumed.json()).toEqual({ ok: true, queued: true });
      expect(rows().map(r => [r.path, r.window])).toEqual([["/hook/stop", "web"], ["/hook/stop", "web"]]);
    } finally {
      await rig.close();
    }
  });
  it("an unknown session's Stop is a lane finish", async () => {
    const rig = await claudeRig([["1.json", lane]]);
    try {
      const stop = await rig.post("/hook/stop", { TMUX_PANE: "%7", session_id: "sess-nobody" });
      expect(stop.status).toBe(200);
      expect(await stop.json()).toEqual({ ok: true, queued: true });
      expect(rows().map(r => [r.path, r.window])).toEqual([["/hook/stop", "web"]]);
    } finally {
      await rig.close();
    }
  });
  it("a headless run's failure is not the lane's: /hook/failure from a headless session is answered 202 and not spooled; the lane's own is kept", async () => {
    const rig = await claudeRig([["1.json", lane], ["2.json", headless]]);
    try {
      const kicksBefore = kicks;
      const foreign = await rig.post("/hook/failure", { TMUX_PANE: "%7", session_id: "sess-headless", error: "x" });
      expect(foreign.status).toBe(202);
      expect(await foreign.text()).toBe("");
      expect(rows()).toEqual([]);
      expect(kicks).toBe(kicksBefore);
      const own = await rig.post("/hook/failure", { TMUX_PANE: "%7", session_id: "sess-lane", error: "x" });
      expect(own.status).toBe(202);
      expect(rows().map(r => [r.path, r.window])).toEqual([["/hook/failure", "web"]]);
    } finally {
      await rig.close();
    }
  });
  it("only a Stop or a failure is judged: a notice from the same foreign session is still kept", async () => {
    const rig = await claudeRig([["1.json", lane], ["2.json", headless]]);
    try {
      const note = await rig.post("/notify", { TMUX_PANE: "%7", session_id: "sess-headless", text: "hi" });
      expect(note.status).toBe(202);
      expect(rows().map(r => [r.path, r.window])).toEqual([["/notify", "web"]]);
    } finally {
      await rig.close();
    }
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
