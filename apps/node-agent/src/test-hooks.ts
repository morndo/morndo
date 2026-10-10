// Hooks for the agent's tests and the QA drill only (plan Contracts, "Agent test hooks"). Each one bends one thing the
// agent does, to show what the real behaviour prevents (a negative control) or to reach a state that is hard to time
// (the connection lost right after a `started` key is committed). They come from MORNDO_NODE_TEST_HOOKS (JSON) and are
// refused unless NODE_ENV is "test" AND the agent's HOME is not the account's own home directory:
// - there is no build step (Node runs the TypeScript as stripped types), so no build flag can remove them, and an
//   environment variable alone can leak into a unit file;
// - every test and the QA drill run the agent with a throwaway HOME, and the installed agent runs with the account's
//   real home, so a production agent refuses to start with hooks rather than run with them;
// - the account's home is os.userInfo().homedir, which the operating system gives from the password database, where
//   os.homedir() would read $HOME (https://nodejs.org/docs/latest-v24.x/api/os.html#osuserinfooptions, read 2026-10-06).
// Bad JSON, an unknown hook or a value of the wrong type is refused too: a typo must not silently turn a hook off.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export type TestHooks = {
  dropAfterStarted?: string;  // a keyed op whose key contains this: right after `started` is committed (with noDoneKeys: at that
                              // point), the fleet socket is terminated and that op's result discarded; the op runs on. Once per key.
  noDoneKeys?: true;          // negative control: keys are neither recorded nor consulted; op.status answers "unknown"
  noExpect?: true;            // negative control: a worker ID resolves by its pane number alone; `expect` is not checked
  clockOffsetMs?: number;     // added to every wall-clock time the agent reports (typedAt, health.wallClock, HookEvent.at)
  spoolFail?: true;           // every spool write fails, as on a full disk
  fixedStreamId?: string;     // negative control: this stream id (a UUID) instead of the database's own
};

export class TestHooksRefused extends Error {
  constructor(message: string) { super(message); this.name = "TestHooksRefused"; }
}

export const TEST_HOOKS_VAR = "MORNDO_NODE_TEST_HOOKS";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VALID: { [K in keyof Required<TestHooks>]: (v: unknown) => boolean } = {
  dropAfterStarted: v => typeof v === "string" && v.length > 0,
  noDoneKeys: v => v === true,
  noExpect: v => v === true,
  clockOffsetMs: v => Number.isSafeInteger(v),
  spoolFail: v => v === true,
  fixedStreamId: v => typeof v === "string" && UUID.test(v),
};

// A directory with its links resolved, so a link to the account's home is that home; one that doesn't exist (yet) is
// only made absolute.
const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };

// `home`: the HOME the agent runs with; `accountHome`: the account's own home (os.userInfo().homedir), "" when unknown.
export function loadTestHooks(env: NodeJS.ProcessEnv, where: { home: string; accountHome: string }): TestHooks {
  const raw = env[TEST_HOOKS_VAR];
  if (raw === undefined || raw.trim() === "") return {};
  if (env.NODE_ENV !== "test") {
    throw new TestHooksRefused(`${TEST_HOOKS_VAR} is set, but NODE_ENV is not "test": test hooks never run outside tests. Unset ${TEST_HOOKS_VAR}.`);
  }
  if (!where.accountHome) throw new TestHooksRefused(`${TEST_HOOKS_VAR} is set, but this account's home directory is unknown, so HOME can't be told apart from it.`);
  if (real(where.home) === real(where.accountHome)) {
    throw new TestHooksRefused(`${TEST_HOOKS_VAR} is set, but HOME is this account's own home directory: test hooks run only with a throwaway HOME.`);
  }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new TestHooksRefused(`${TEST_HOOKS_VAR} is not valid JSON.`); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TestHooksRefused(`${TEST_HOOKS_VAR} must hold a JSON object.`);
  for (const [name, v] of Object.entries(value)) {
    if (!Object.hasOwn(VALID, name)) {
      throw new TestHooksRefused(`${TEST_HOOKS_VAR}: unknown hook ${JSON.stringify(name.slice(0, 40))} (known: ${Object.keys(VALID).join(", ")}).`);
    }
    if (!VALID[name as keyof TestHooks](v)) throw new TestHooksRefused(`${TEST_HOOKS_VAR}: ${name} has a value of the wrong type.`);
  }
  return value as TestHooks;
}

// The wall clock the agent reports (pane.send's typedAt, health.wallClock, HookEvent.at), moved by clockOffsetMs.
export function wallClock(hooks: TestHooks): () => number {
  const offset = hooks.clockOffsetMs ?? 0;
  return () => Date.now() + offset;
}

// dropAfterStarted as the executor's afterStarted hook: the first time a key that contains `match` is started in this
// process, `drop` cuts the connection and the answer is to be discarded (true).
export function dropOnce(match: string, drop: () => void): (key: string) => boolean {
  const dropped = new Set<string>();
  return key => {
    if (!key.includes(match) || dropped.has(key)) return false;
    dropped.add(key);
    drop();
    return true;
  };
}
