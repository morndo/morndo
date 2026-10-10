// The test hooks' loader (plan Contracts, "Agent test hooks"): refused unless NODE_ENV is "test" and HOME is not the
// account's own home directory, every hook checked for its type; and the two helpers the runtime and the agent use.
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TestHooksRefused, dropOnce, loadTestHooks, wallClock } from "../src/test-hooks.ts";
import { tempHome } from "./helpers.ts";

const homes: { cleanup: () => void }[] = [];
afterEach(() => { for (const h of homes.splice(0)) h.cleanup(); });
// An "account" home and a throwaway one beside it.
function dirs() {
  const t = tempHome();
  homes.push(t);
  const account = join(t.home, "account");
  const throwaway = join(t.home, "throwaway");
  mkdirSync(account);
  mkdirSync(throwaway);
  return { root: t.home, account, throwaway };
}
// NODE_ENV "test" unless given; null leaves it unset.
const env = (hooks: unknown, nodeEnv: string | null = "test"): NodeJS.ProcessEnv => ({
  ...(nodeEnv === null ? {} : { NODE_ENV: nodeEnv }),
  MORNDO_NODE_TEST_HOOKS: typeof hooks === "string" ? hooks : JSON.stringify(hooks),
});

describe("loadTestHooks", () => {
  it("is empty when the variable is unset or empty, whatever NODE_ENV and HOME are", () => {
    const d = dirs();
    expect(loadTestHooks({}, { home: d.account, accountHome: d.account })).toEqual({});
    expect(loadTestHooks({ NODE_ENV: "production", MORNDO_NODE_TEST_HOOKS: " " }, { home: d.account, accountHome: d.account })).toEqual({});
  });
  it("loads every hook under NODE_ENV=test with a throwaway HOME", () => {
    const d = dirs();
    const all = { dropAfterStarted: "hub:drop", noDoneKeys: true, noExpect: true, clockOffsetMs: -5000, spoolFail: true, fixedStreamId: "3f0c1d2e-1111-4222-8333-444455556666" };
    expect(loadTestHooks(env(all), { home: d.throwaway, accountHome: d.account })).toEqual(all);
  });
  it("is refused outside NODE_ENV=test, saying why", () => {
    const d = dirs();
    for (const nodeEnv of [null, "production", "development", "TEST"]) {
      const load = () => loadTestHooks(env({ spoolFail: true }, nodeEnv), { home: d.throwaway, accountHome: d.account });
      expect(load, String(nodeEnv)).toThrow(TestHooksRefused);
      expect(load).toThrow(/NODE_ENV is not "test"/);
    }
  });
  it("is refused when HOME is the account's own home, also through a symbolic link or a trailing slash", () => {
    const d = dirs();
    const link = join(d.root, "link-to-account");
    symlinkSync(d.account, link);
    for (const home of [d.account, `${d.account}/`, link]) {
      expect(() => loadTestHooks(env({ spoolFail: true }), { home, accountHome: d.account }), home).toThrow(/HOME is this account's own home directory/);
    }
    expect(() => loadTestHooks(env({ spoolFail: true }), { home: d.throwaway, accountHome: "" })).toThrow(/home directory is unknown/);
  });
  it("refuses bad JSON, an unknown hook and a value of the wrong type", () => {
    const d = dirs();
    const where = { home: d.throwaway, accountHome: d.account };
    for (const [raw, message] of [
      ["{ spoolFail: true", /not valid JSON/],
      ["[]", /a JSON object/],
      ["null", /a JSON object/],
      [{ spoolFails: true }, /unknown hook "spoolFails"/],
      [{ noDoneKeys: false }, /noDoneKeys has a value of the wrong type/],
      [{ noExpect: "yes" }, /noExpect/],
      [{ clockOffsetMs: "5000" }, /clockOffsetMs/],
      [{ clockOffsetMs: 1.5 }, /clockOffsetMs/],
      [{ fixedStreamId: "stream-1" }, /fixedStreamId/],
      [{ dropAfterStarted: "" }, /dropAfterStarted/],
    ] as const) {
      const load = () => loadTestHooks(env(raw), where);
      expect(load, JSON.stringify(raw)).toThrow(TestHooksRefused);
      expect(load).toThrow(message);
    }
  });
});

describe("the hooks' helpers", () => {
  it("wallClock is Date.now(), moved by clockOffsetMs", () => {
    const before = Date.now();
    const plain = wallClock({})();
    const ahead = wallClock({ clockOffsetMs: 3_600_000 })();
    const after = Date.now();
    expect(plain).toBeGreaterThanOrEqual(before);
    expect(plain).toBeLessThanOrEqual(after);
    expect(ahead).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(ahead).toBeLessThanOrEqual(after + 3_600_000);
  });
  it("dropOnce drops the first time a key that matches is started, once per key", () => {
    let drops = 0;
    const hook = dropOnce("drop", () => { drops++; });
    expect([hook("hub:keep"), hook("hub:drop-1"), hook("hub:drop-1"), hook("hub:drop-2")]).toEqual([false, true, false, true]);
    expect(drops).toBe(2);
  });
});
