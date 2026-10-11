// lane.start hosts the tmux server before it accepts the deadline. A host that throws started nothing.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpName } from "@morndo/protocol";
import { DEFAULT_POLICY } from "../src/config.ts";
import { openAgentDb, type AgentDb } from "../src/db/open.ts";
import { DoneKeys } from "../src/ops/done-keys.ts";
import { OpExecutor, type OpTable } from "../src/ops/executor.ts";
import { laneOps } from "../src/ops/lane-ops.ts";
import type { Inventory } from "../src/ops/inventory.ts";
import { captureLog, isolatedTmux, tempHome, type TestTmux } from "./helpers.ts";

const open: { adb: AgentDb; cleanup: () => void; tmux: TestTmux }[] = [];
afterEach(async () => { for (const o of open.splice(0)) { o.adb.close(); await o.tmux.kill(); o.cleanup(); } });

const emptyInventory = { refresh: async () => ({ invVersion: 1, stamp: null, panes: [], lanes: [], rows: [] }) } as unknown as Inventory;

function start(host: (opts: { socket: string | null }) => Promise<unknown>) {
  const home = tempHome();
  const tmux = isolatedTmux();
  const work = join(home.home, "work");
  mkdirSync(work);
  const adb = openAgentDb(join(home.home, "agent.db"));
  open.push({ adb, cleanup: home.cleanup, tmux });
  const doneKeys = new DoneKeys(adb.db, Date.now);
  const ops = laneOps({
    node: "pc", policy: { ...DEFAULT_POLICY, tmuxSocket: tmux.socket }, inventory: emptyInventory,
    home: home.home, stateDir: join(home.home, "state"), stamp: async () => "3fa2c1d0", host,
  }) as OpTable;
  const ex = new OpExecutor({ ops, allowed: new Set<OpName>(["lane.start"]), doneKeys, invVersion: () => 1, log: captureLog().log });
  const call = (key: string) => ex.handle({
    id: "r1", op: "lane.start", args: { name: "kept", cwd: work }, timeoutMs: 5000, key,
  });
  return { call, doneKeys };
}

describe("lane.start hosts the server before it is willing to open a session", () => {
  it("a host that throws is a refusal with executed no, and the key is free", async () => {
    let hosted = 0;
    const { call, doneKeys } = start(async () => { hosted += 1; throw new Error("scope refused"); });
    expect(await call("hub:host")).toMatchObject({
      ok: false, error: { code: "internal", executed: "no", message: "the tmux server could not be started outside this service" },
    });
    expect(hosted).toBe(1);
    expect(doneKeys.status("hub:host")).toEqual({ state: "unknown" });
  });
});
