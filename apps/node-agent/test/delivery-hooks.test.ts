// The test hooks fleet clients adds for Task 16's drills (RECONCILIATION.md ruling 20): the loader takes
// them under its usual guard, killOnce matches keys as dropOnce does, and the executor's afterEffect runs right after a
// keyed op acted, before its `done` is written (where killAfterEffect kills the agent). The kill itself is the drills'.
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ALL_OPS } from "../src/config.ts";
import { openAgentDb, type AgentDb } from "../src/db/open.ts";
import { DoneKeys } from "../src/ops/done-keys.ts";
import { OpExecutor, effect, fail, ok } from "../src/ops/executor.ts";
import { TestHooksRefused, killOnce, loadTestHooks } from "../src/test-hooks.ts";
import { captureLog, tempHome } from "./helpers.ts";

const homes: { cleanup: () => void }[] = [];
const dbs: AgentDb[] = [];
afterEach(() => { for (const d of dbs.splice(0)) d.close(); for (const h of homes.splice(0)) h.cleanup(); });
const env = (hooks: unknown): NodeJS.ProcessEnv => ({ NODE_ENV: "test", MORNDO_NODE_TEST_HOOKS: JSON.stringify(hooks) });

describe("the drills' test hooks", () => {
  it("loads killAfterEffect, noSessionBinding, retypeUnderFirstKey and deliveryStartGraceMs, and refuses a value of the wrong type", () => {
    const h = tempHome();
    homes.push(h);
    const where = { home: h.home, accountHome: "/nonexistent-account-home" };
    const all = { killAfterEffect: "lanes:drill-killed", noSessionBinding: true, retypeUnderFirstKey: true, deliveryStartGraceMs: 3000 };
    expect(loadTestHooks(env(all), where)).toEqual(all);
    for (const bad of [{ killAfterEffect: "" }, { noSessionBinding: false }, { retypeUnderFirstKey: 1 }, { deliveryStartGraceMs: -1 }, { deliveryStartGraceMs: 1.5 }]) {
      expect(() => loadTestHooks(env(bad), where), JSON.stringify(bad)).toThrow(TestHooksRefused);
    }
  });

  it("killOnce kills the first time a key that contains its text has acted", () => {
    const kills: string[] = [];
    const k = killOnce("drill-killed", () => { kills.push("kill"); });
    k("lanes:other");
    expect(kills).toEqual([]);
    k("lanes:drill-killed-1a2b");
    k("lanes:drill-killed-1a2b");
    expect(kills).toEqual(["kill"]);
  });

  it("runs the executor's afterEffect right after a keyed op acted, before its done is written; never for a refusal or an unkeyed op", async () => {
    const h = tempHome();
    homes.push(h);
    const adb = openAgentDb(join(h.home, "agent.db"));
    dbs.push(adb);
    const keys = new DoneKeys(adb.db);
    const seen: string[] = [];
    const x = new OpExecutor({
      ops: {
        "pane.send": effect(() => "q", async a => (a.text === "refuse me" ? fail("menu_open", "a menu") : ok<"pane.send">({ problem: null, typedAt: 1 }))),
        "pane.keys": effect(() => "q", async () => ok<"pane.keys">({ ok: true })),
      },
      allowed: new Set(ALL_OPS), doneKeys: keys, invVersion: () => 0, log: captureLog().log,
      afterEffect: key => { seen.push(`${key} ${keys.status(key).state}`); },
    });
    const W = "pc.0a1b2c3d.1";
    const EXPECT = { server: "0a1b2c3d", window: "w" };
    expect(await x.handle({ id: "1", op: "pane.send", args: { workerId: W, text: "typed", expect: EXPECT }, timeoutMs: 5000, key: "hub:a" })).toMatchObject({ ok: true });
    expect(await x.handle({ id: "2", op: "pane.send", args: { workerId: W, text: "refuse me", expect: EXPECT }, timeoutMs: 5000, key: "hub:b" })).toMatchObject({ ok: false });
    expect(await x.handle({ id: "3", op: "pane.keys", args: { workerId: W, data: "x", expect: EXPECT }, timeoutMs: 5000 })).toMatchObject({ ok: true });
    expect(seen).toEqual(["hub:a started"]);
    expect(keys.status("hub:a")).toMatchObject({ state: "done" });
  });
});
