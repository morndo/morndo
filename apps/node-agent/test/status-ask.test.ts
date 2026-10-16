// The relay's one question per turn (reliable lanes §3.1): which Stop bodies are asked for a status line, and, over real
// HTTP, that an asked Stop is answered {"decision":"block","reason"} and kept marked statusAsked (its answer still reaches
// subscribers), while the Stop that follows (Claude Code's stop_hook_active) is kept as the turn's end.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StatusContract } from "../src/config.ts";
import { openAgentDb, type AgentDb } from "../src/db/open.ts";
import { nodeOpener } from "../src/ops/node-files.ts";
import { agentPaths } from "../src/paths.ts";
import { RelayFiles } from "../src/relay/relay-files.ts";
import { startRelay, type Relay } from "../src/relay/server.ts";
import { Spool } from "../src/relay/spool.ts";
import { STATUS_ASK, statusAsk } from "../src/relay/status-ask.ts";
import { captureLog, tempHome } from "./helpers.ts";

const ASK: StatusContract = { mode: "ask", exempt: ["manager"] };
const stop = (over: Record<string, unknown> = {}) => ({
  session_id: "s1", hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "I pushed the branch.", background_tasks: [], session_crons: [], ...over,
});

describe("which Stops are asked", () => {
  it("a lane's Claude Code Stop whose answer states no status, with nothing running or scheduled", () => {
    expect(statusAsk(stop(), "api", ASK)).toBe(STATUS_ASK);
    expect(STATUS_ASK).toContain("STATUS: WAITING <on what> for <N> min");
  });

  it("never: a status line, stop_hook_active, background work, a wake-up, an exempt or unplaced window, mode off, another body", () => {
    expect(statusAsk(stop({ last_assistant_message: "STATUS: DONE\nMerged." }), "api", ASK)).toBeNull();
    expect(statusAsk(stop({ last_assistant_message: "**Status: waiting** on CI for 10 min" }), "api", ASK)).toBeNull();
    expect(statusAsk(stop({ stop_hook_active: true }), "api", ASK)).toBeNull();          // once per turn
    expect(statusAsk(stop({ background_tasks: [{ id: "b1", status: "running" }] }), "api", ASK)).toBeNull();
    expect(statusAsk(stop({ session_crons: [{ id: "c1" }] }), "api", ASK)).toBeNull();
    expect(statusAsk(stop(), "manager", ASK)).toBeNull();
    expect(statusAsk(stop(), null, ASK)).toBeNull();
    expect(statusAsk(stop(), "api", { mode: "off", exempt: [] })).toBeNull();
    expect(statusAsk(stop({ hook_event_name: "SubagentStop" }), "api", ASK)).toBeNull();
    expect(statusAsk({ window: "api", text: "no status", background: 0 }, "api", ASK)).toBeNull();   // the owner's script's body
    expect(statusAsk(stop({ last_assistant_message: undefined }), "api", ASK)).toBeNull();
    expect(statusAsk("text", "api", ASK)).toBeNull();
  });
});

describe("the relay asks over HTTP", () => {
  let home: { home: string; cleanup: () => void };
  let adb: AgentDb;
  let spool: Spool;
  let relay: Relay;
  beforeEach(async () => {
    home = tempHome();
    const paths = agentPaths(home.home);
    adb = openAgentDb(paths.dbPath);
    spool = new Spool(adb.db, adb.streamId, { now: () => 1_000 });
    const files = new RelayFiles({ dir: paths.relayFilesDir, db: adb.db, open: nodeOpener({ home: home.home, stateDir: paths.stateDir, configDir: paths.configDir }), now: () => 1_000 });
    relay = await startRelay({
      port: 0, spool, files, log: captureLog().log, onAppended: () => {}, now: () => 1_000,
      windowOf: () => "api", ask: (body, window) => statusAsk(body, window, ASK),
    });
  });
  afterEach(async () => { await relay.close(); adb.close(); home.cleanup(); });
  const post = (body: unknown) => fetch(`http://127.0.0.1:${relay.port}/hook/stop`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  it("blocks the first Stop and keeps it marked statusAsked; the one Claude Code sends after is kept as it is (negative control: a status line is not asked)", async () => {
    const asked = await post(stop());
    expect(asked.status).toBe(200);
    expect(asked.headers.get("content-type")).toBe("application/json");
    expect(await asked.json()).toEqual({ decision: "block", reason: STATUS_ASK });
    expect(spool.after(0, 10).map(e => e.body)).toEqual([{ ...stop(), statusAsked: true }]);
    const after = await post(stop({ stop_hook_active: true, last_assistant_message: "STATUS: DONE\nPushed." }));
    expect(await after.json()).toEqual({ ok: true, queued: true });
    const plain = await post(stop({ last_assistant_message: "STATUS: BLOCKED on the key" }));
    expect(await plain.json()).toEqual({ ok: true, queued: true });
    expect(spool.after(0, 10).map(e => (e.body as { statusAsked?: boolean }).statusAsked ?? false)).toEqual([true, false, false]);
  });
});
