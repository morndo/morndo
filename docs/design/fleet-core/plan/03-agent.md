## Lane notes (agent)

- **Checked against the real Tasks 1–3**, not stubs: the tree that Tasks 1–3 of [`01-foundation.md`](01-foundation.md) build, as revised in review round 2 (`fleetUrlOk`, `Res.store`, `tmuxLiteral`, `openConfined`, `deniedBy`, the new `LIMITS`), with its root `package.json`, `vitest.config.ts`, `tsconfig.tests.json` and `.oxlintrc.json`. Each task's end state (6, 7, 8, 9), and each "watch it fail" and "watch it pass" step, was rebuilt from this text alone. The counts in the steps are what those runs printed. The final code here is byte-identical to the tree that passed.
- **The test hooks file is created in Task 8** (Steps 1–4). Task 7's `FleetConnection.drop()` comes first, without hooks; Task 9's `run` loads the hooks.
- **Review round 2** (RECONCILIATION.md, "Review round 2"): a refused second instance (4409) keeps `status: conflict` and tries again every 5 minutes; the agent's ping timeout is 35 s; every `res` carries `store` (the database's stream id), and a restored database starts a new stream; the key's hash covers only what decides the effect, and a hash mismatch is `uncertain`; arguments are decoded with `OP_ARGS` first; `lane.start` passes its directory through `tmuxLiteral`; files are opened with `O_NOFOLLOW` after `confine` (`openConfined`), and the control plane's own state is never shared; relay copies and the upload inbox count toward the spool's byte budget; a spool that can't be written never crashes the agent; a plain `ws://` URL to another machine is refused.
- **Where:** macOS (Darwin 25.5.0), Node 24.21.0, tmux 3.6a, vitest 5.0.3, npm 11.19.0, git 2.50.1, on 2026-10-06.
  - `npx vitest run apps/node-agent/test`: 17 files, 144 passed and 1 skipped (Tasks 6, 7 and 8 end at 24, 45 and 106 + 1 skipped). The skipped test is the pane lock's, because macOS has no `flock(1)`.
  - The same suite run with `TMUX=/tmp/fake,1,0 TMUX_PANE=%99` set (as from inside a tmux pane) gives the same counts.
  - The tmux-heavy files pane-ops and inventory passed 3 more runs, each with 15 passed and 1 skipped.
  - `tsc -p apps/node-agent`, `tsc -p tsconfig.tests.json`, `npm run lint` and `npm run check` all exit 0. `check` reaches the agent through its `typecheck` script.
  - `npm install --offline` linked the new workspace (`node_modules/@morndo/node-agent`), and the lock gained only the workspace entries.
- **Real protocol:** the fake fleet decodes every agent message with `AgentFrames` and closes with 1008 on one that doesn't fit.
  - Every message the agent itself makes fits.
  - The tests' made-up IDs did not (`"instance-1"`, `"stream-1"` and `"second-instance"` are not UUIDs), so they are UUIDs now.
  - The ok results of the ops tests were checked once against `OP_RESULTS`, and all of them fit.
- **Negative controls:** each mutation was applied alone, the tests in brackets failed, and the mutation was reverted.
  - The hooks' guard:
    - without the `NODE_ENV` check [test-hooks, the `run` CLI test];
    - without the HOME check, or without realpath [test-hooks];
    - accepting an unknown hook [test-hooks].
  - `noDoneKeys`: not wired, or `DoneKeys` ignoring `disabled` [done-keys, executor, agent].
  - `dropAfterStarted`: `afterStarted` never called, a discarded answer sent, or `drop()` a no-op [executor, connection, agent].
  - `noExpect` not wired [pane-ops].
  - `typedAt`, health or the relay on `Date.now()` instead of the runtime's clock [pane-ops, agent].
  - `spoolFail` ignored or not wired [spool, agent].
  - `fixedStreamId` ignored [agent, `run` CLI].
  - `run` not passing the hooks, or not warning about them [`run` CLI].
  - Health probing another tmux socket than the policy's [agent]. Run it with a socket of its own (`healthProbe(config.home, { tmuxSocket: "test-control-elsewhere" })`), never without one: without one it asks the account's default tmux server (in round 2 it was run that way once; it only listed sessions).
  - The `##` escape removed from `-n` [lane-worktree-ops], or from `-c` [lane-worktree-ops: the directories `#{session_name}`, `#(touch m)`, `a#Sb ##x`].
  - Round 2:
    - a 4409 that stops dialing, or a retry that leaves `conflict` for `connecting`, or a retry without jitter [connection, retry];
    - the watchdog at 20 s instead of `LIMITS.agentPingTimeoutMs` [connection];
    - a plain `ws://` URL to another machine dialed: the check removed from `FleetConnection` [connection], from `loadConfig` [config], or from `parseJoinString` and `join.ts` together (the join then really joins through `ws://0.0.0.0`) [join];
    - `rotateStreamId` not stored [db]; no rotation for a restored database, or a rotation not stored [stream];
    - the key's hash over every argument (`expect` included), a hash mismatch answered `bad_args`, a key accepted on an op that takes none, arguments not decoded with `OP_ARGS` [done-keys, executor];
    - a late pane lock that types (the deadline's check after the lock removed) [pane-ops];
    - the opener given another home, so the control plane's state is shared [transcript-file-ops];
    - the upload inbox, the relay's copies or the spool ignoring the disk budget, or the agent's budget not counting the copies and the inbox [transcript-file-ops, relay-server, spool, agent];
    - `branchNameOk` that takes anything [lane-worktree-ops];
    - a `res` without `store`, or a `store` that ignores `fixedStreamId` [agent];
    - a stream sender whose ack can throw [stream, agent: an unhandled error and a hung agent]; `spoolFail` that lets acks through [spool, agent];
    - the done-key prune not wired into housekeeping [agent].
  - Not caught by design: the account and resume checks in `args.ts` repeat `OP_ARGS` (the same patterns), so removing them changes nothing a test can see; they stay as the last check before `claude-as`.
  - tmux `-u` removed from `tmuxArgv` [inventory]. The inventory file unsets the locale, `TMUX` and `TMUX_PANE` itself, so this fails whatever the runner's locale, also inside tmux. Leaving `TMUX` set hides the missing `-u`: with `TMUX` set and `-u` removed, the inventory file passed.
- **Not covered:**
  - Linux: tmux 3.3a and 3.4, and util-linux `flock`, so the pane-lock test never ran here. The steps' Linux counts are the macOS counts plus that one test; nobody observed them. They are recorded on the first CI run (plan.md, Global Constraints).
  - Whether tmux 3.3a or 3.4 runs a `#(…)` job found in `-c`: on 3.6a none ran within 2 s. The test asserts no `m` appears either way.
  - The earlier draft's Linux runs were against stubs, and they were not repeated.

# Tasks 6–9: the node agent (`apps/node-agent`, `morndo-node`)

Drafted for `docs/design/fleet-core/plan.md`, lane **Agent**, wave 1: Task 6 → 7 → 8 → 9. Spec: `docs/design/fleet-core/README.md` (§4, §5, §6) and ADR-0012. Section numbers (§N) refer to the spec.

### Task 6: Node agent skeleton: config, policy, identity, join, database

**Files:**
- Create: `apps/node-agent/package.json`, `apps/node-agent/tsconfig.json`
- Create: `apps/node-agent/src/paths.ts`, `apps/node-agent/src/atomic-write.ts`, `apps/node-agent/src/log.ts`, `apps/node-agent/src/crash.ts`, `apps/node-agent/src/version.ts`, `apps/node-agent/src/ws-text.ts`, `apps/node-agent/src/config.ts`, `apps/node-agent/src/identity.ts`, `apps/node-agent/src/join.ts`, `apps/node-agent/src/main.ts`
- Create: `apps/node-agent/src/db/migrations.ts`, `apps/node-agent/src/db/open.ts`
- Modify: `package-lock.json` (by `npm install`; workspace link only). Task 1 already wired `apps/node-agent` into the root `check` script (through `npm run typecheck --workspaces --if-present`), the vitest `units` project and `tsconfig.tests.json`; this task adds nothing there.
- Test: `apps/node-agent/test/helpers.ts`, `apps/node-agent/test/fake-fleet.ts`, `apps/node-agent/test/config.test.ts`, `apps/node-agent/test/db.test.ts`, `apps/node-agent/test/join.test.ts`

**Interfaces:**
- **Consumes** (Task 1, `@morndo/protocol`):
  - `NODE_NAME`, `FLEET_PROTO`, `LIMITS`, `CLOSE`, `Welcome`;
  - the types `AgentMessage`, `JoinString` (with `node`; plan Contracts, "Join flow") and `OpName`;
  - `parseJoinString` (which refuses a `url` that fails `fleetUrlOk`) and `fleetUrlOk`;
  - for the test fake: `formatJoinString`, `fleetSigPayload` and `nodeSigPayload`;
  - `parseBody`, which already exists in `decode.ts`.
- **Produces:**

```ts
// paths.ts
export type AgentPaths = { configDir: string; configFile: string; policyFile: string; keyPath: string; stateDir: string; dbPath: string; statusFile: string; relayFilesDir: string; inboxDir: string };
export function agentPaths(home: string): AgentPaths;
// atomic-write.ts
export function writeFileAtomic(path: string, data: string, mode?: number): void;
// log.ts
export type Level = "debug" | "info" | "warn" | "error"; export type Logger = Record<Level, (message: string, error?: unknown) => void>;
export function createLogger(o?: { level?: Level; home?: string; sink?: Sink }): Logger; export function redact(text: string, home?: string): string; export const log: Logger;
// config.ts (plan Contracts: AgentConfig, Policy)
export type Policy = { ops: OpName[]; session: string; repoRoots: string[]; fileRoots?: string[]; lockedPanes: Record<string, string>; tmuxSocket: string | null };
export type AgentConfig = { node: string; fleetUrl: string; fleetKey: string; keyPath: string; dbPath: string; relayPort: number; home: string; policy: Policy };
export const ALL_OPS: readonly OpName[]; export const isOpName: (s: unknown) => s is OpName; export const RELAY_PORT = 8787; export const DEFAULT_POLICY: Policy;
export class ConfigError extends Error; export function parsePolicy(value: Record<string, unknown>, where: string): Policy;
export function loadPolicy(path: string): Policy; export type StoredConfig = Omit<AgentConfig, "home" | "policy">; export function loadConfig(home: string): AgentConfig;
// identity.ts
export type NodeKey = { publicKey: string; sign(payload: string): string; pem(): string };
export function createNodeKey(): NodeKey; export function loadNodeKey(path: string): NodeKey;
export function fleetPublicKey(spkiBase64: string): KeyObject | null; export function signedBy(key: KeyObject, payload: string, sigBase64: string): boolean;
// join.ts
export class JoinError extends Error;
export function join(o: { home: string; joinString: string; timeoutMs?: number }): Promise<{ node: string; fleetUrl: string; configFile: string }>;
// db/migrations.ts, db/open.ts
export class DatabaseFromFuture extends Error; export const MIGRATIONS: readonly Migration[];
export function migrate(db: Database.Database, migrations?: readonly Migration[]): { from: number; to: number };
export type AgentDb = { db: Database.Database; streamId: string; close(): void }; export function openAgentDb(path: string): AgentDb;
export function rotateStreamId(db: Database.Database): string;   // a new stream for this database (Task 9: a restored backup)
// version.ts, ws-text.ts, crash.ts
export const AGENT_VERSION: string; export const PROTO_VERSIONS: number[]; export function wsText(raw: RawData): string;
export function exitOnCrash(log: Logger, exit?: (code: number) => never): void;
```

- [ ] **Step 1: Create `apps/node-agent/package.json`**

The same dependency versions the hub uses; nothing new. The `typecheck` script is how the root `npm run check` reaches the agent: Task 1's `check` runs `npm run typecheck --workspaces --if-present`. No lane adds `tsc -p apps/node-agent` to `check` itself, because before the app exists that command fails with TS5058.

```json
{
  "name": "@morndo/node-agent",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc -p ."
  },
  "bin": {
    "morndo-node": "./src/main.ts"
  },
  "dependencies": {
    "@morndo/node-ops": "0.0.0",
    "@morndo/protocol": "0.0.0",
    "better-sqlite3": "^13.0.3",
    "ws": "^8.22.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^9.6.0",
    "@types/ws": "^8.18.2"
  }
}
```

- [ ] **Step 2: Create `apps/node-agent/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["esnext"], "types": ["node"] },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Link the workspace**

Run: `npm install`

Expected:
- `added 1 package`;
- `node_modules/@morndo/node-agent` links to `../../apps/node-agent`;
- `git diff package-lock.json` shows only the new `apps/node-agent` workspace entries. No dependency version is added or changed.

- [ ] **Step 4: Create `apps/node-agent/test/helpers.ts`**

Shared by every agent test: a temporary HOME, polling, a logger that keeps its lines, and the isolated tmux server (`tmux -L test-<uuid>`), re-exported from node-ops' shared test helper `packages/node-ops/test/isolated-tmux.ts` (Task 2).

```ts
// Shared by the agent's tests: a temporary HOME, an isolated tmux server (`tmux -L test-<uuid>`, never the owner's; the
// helper node-ops' tests share), a logger that keeps its lines, and polling.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, type Logger } from "../src/log.ts";

export { isolatedTmux, type TestTmux } from "../../../packages/node-ops/test/isolated-tmux.ts";

export function tempHome(prefix = "morndo-node-"): { home: string; cleanup: () => void } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), prefix)));    // realpath: macOS /var is a link to /private/var
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

export const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function until(f: () => boolean | Promise<boolean>, ms = 5000, step = 25): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await f()) return true; await wait(step); }
  return f();
}

export function captureLog(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  return { log: createLogger({ level: "debug", sink: line => { lines.push(line); } }), lines };
}
```

- [ ] **Step 5: Create `apps/node-agent/test/config.test.ts`**

The failing test for config and policy.

```ts
// The node's configuration and policy: defaults, and refusals that name the file and the field (a typo must never
// widen what the fleet may do).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ALL_OPS, ConfigError, DEFAULT_POLICY, loadConfig, loadPolicy } from "../src/config.ts";
import { agentPaths } from "../src/paths.ts";
import { tempHome } from "./helpers.ts";

const homes: { cleanup: () => void }[] = [];
afterEach(() => { for (const h of homes.splice(0)) h.cleanup(); });
function home() { const h = tempHome(); homes.push(h); return h.home; }
function writeConfig(h: string, over: Record<string, unknown> = {}, policy?: unknown) {
  const p = agentPaths(h);
  mkdirSync(p.configDir, { recursive: true });
  writeFileSync(p.configFile, JSON.stringify({ node: "pc", fleetUrl: "ws://127.0.0.1:8791/agent", fleetKey: "MCowBQYDK2VwAyEA", keyPath: p.keyPath, dbPath: p.dbPath, relayPort: 8787, ...over }));
  if (policy !== undefined) writeFileSync(p.policyFile, JSON.stringify(policy));
}

describe("config.json", () => {
  it("is required: a machine that hasn't joined is told how to join", () => {
    expect(() => loadConfig(home())).toThrow(/has not joined a fleet.*morndo-node join/);
  });
  it("loads, with the default policy when policy.json is absent", () => {
    const h = home();
    writeConfig(h);
    const c = loadConfig(h);
    expect(c).toMatchObject({ node: "pc", relayPort: 8787, home: h });
    expect(c.policy).toEqual(DEFAULT_POLICY);
    expect(c.policy.ops).toEqual([...ALL_OPS]);
    expect(c.policy.session).toBe("main");
  });
  it("refuses a bad node name or URL, naming the field", () => {
    const a = home();
    writeConfig(a, { node: "PC_1" });
    expect(() => loadConfig(a)).toThrow(/node must match/);
    const b = home();
    writeConfig(b, { fleetUrl: "http://x" });
    expect(() => loadConfig(b)).toThrow(/fleetUrl/);
  });
  it("refuses a plain ws:// fleet URL to another machine; wss:// anywhere and ws:// to this machine pass (plan Contracts, fleetUrlOk)", () => {
    for (const fleetUrl of ["ws://100.64.0.1:8791/agent", "ws://cp.tail1234.ts.net/agent", "ws://0.0.0.0:8791/agent", "ws://127.0.0.1.nip.io/agent"]) {
      const h = home();
      writeConfig(h, { fleetUrl });
      expect(() => loadConfig(h), fleetUrl).toThrow(/fleetUrl must be wss:\/\/, or ws:\/\/ to this machine/);
    }
    for (const fleetUrl of ["wss://cp.tail1234.ts.net/agent", "ws://127.0.0.1:8791/agent", "ws://localhost:8791/agent", "ws://[::1]:8791/agent"]) {
      const h = home();
      writeConfig(h, { fleetUrl });
      expect(loadConfig(h).fleetUrl, fleetUrl).toBe(fleetUrl);
    }
  });
});

describe("policy.json", () => {
  it("keeps the defaults for fields it doesn't set", () => {
    const h = home();
    writeConfig(h, {}, { session: "work", ops: ["inventory.get", "pane.frame"] });
    expect(loadConfig(h).policy).toEqual({ ...DEFAULT_POLICY, session: "work", ops: ["inventory.get", "pane.frame"] });
  });
  it("refuses an unknown op, an unknown field and a relative path (negative controls for silent widening)", () => {
    const h = home();
    const p = agentPaths(h).policyFile;
    mkdirSync(agentPaths(h).configDir, { recursive: true });
    for (const [policy, message] of [
      [{ ops: ["pane.exec"] }, /ops must be a list of op names/],
      [{ opz: [] }, /unknown field opz/],
      [{ repoRoots: ["code"] }, /repoRoots must be a list of absolute paths/],
      [{ lockedPanes: { manager: "lock" } }, /lockedPanes/],
      [{ tmuxSocket: "a b" }, /tmuxSocket/],
    ] as const) {
      writeFileSync(p, JSON.stringify(policy));
      expect(() => loadPolicy(p)).toThrow(ConfigError);
      expect(() => loadPolicy(p)).toThrow(message);
    }
  });
  it("names the file when it isn't JSON", () => {
    const h = home();
    const p = join(h, "policy.json");
    writeFileSync(p, "{ ops: ");
    expect(() => loadPolicy(p)).toThrow(/policy\.json is not valid JSON/);
  });
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `npx vitest run apps/node-agent/test/config.test.ts`

Expected: FAIL, `Error: Cannot find module '../src/config.ts'` (or `'../src/log.ts'`, which `helpers.ts` imports).

- [ ] **Step 7: Create `apps/node-agent/src/paths.ts`**

```ts
// Where the node agent keeps its files (spec §5.5, §6). Configuration lives under ~/.config/morndo-node: config.json
// (written by `morndo-node join`), policy.json (the owner's to edit) and the node's private key. State lives under
// ~/.local/state/morndo-node: the database, the hook relay's file copies, the upload inbox, and the status the running
// agent reports. Every path derives from one home directory, so a test runs the whole agent in a temporary one.
import { join } from "node:path";

export type AgentPaths = {
  configDir: string; configFile: string; policyFile: string; keyPath: string;
  stateDir: string; dbPath: string; statusFile: string; relayFilesDir: string; inboxDir: string;
};

export function agentPaths(home: string): AgentPaths {
  const configDir = join(home, ".config", "morndo-node");
  const stateDir = join(home, ".local", "state", "morndo-node");
  return {
    configDir,
    configFile: join(configDir, "config.json"),
    policyFile: join(configDir, "policy.json"),
    keyPath: join(configDir, "node-key.pem"),
    stateDir,
    dbPath: join(stateDir, "agent.db"),
    statusFile: join(stateDir, "status.json"),
    relayFilesDir: join(stateDir, "relay-files"),
    inboxDir: join(stateDir, "inbox"),
  };
}
```

- [ ] **Step 8: Create `apps/node-agent/src/atomic-write.ts`**

```ts
// A file written whole or not at all: the bytes go to a temporary file in the same directory, are flushed to disk,
// and the temporary file is renamed over the target (rename(2) is atomic within one file system). A crash leaves the
// old file or the new one, never half of one, and never a stray temporary file after an error.
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function writeFileAtomic(path: string, data: string, mode = 0o600): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", mode);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, path);
  } catch (e) {
    try { closeSync(fd); } catch { /* already closed */ }
    rmSync(tmp, { force: true });
    throw e;
  }
}
```

- [ ] **Step 9: Create `apps/node-agent/src/log.ts`**

```ts
// The agent's logger, in the hub's pattern (apps/hub/src/adapters/log.ts, ADR-0008 A4): levels, and one sink that
// redacts every line, error stacks included. Typed text, hook bodies, keys, join strings and codes are never passed
// to it; the redactions below are the second line of defence for what slips into an error message anyway.
import { homedir } from "node:os";

export type Level = "debug" | "info" | "warn" | "error";
export type Sink = (line: string, level: Level) => void;
export type Logger = Record<Level, (message: string, error?: unknown) => void>;

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_CAUSES = 5;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const REDACTIONS: [RegExp, string][] = [
  [/morndo-join:\d+:[A-Za-z0-9_-]*/g, "[join-string]"],                                    // a join string carries a code
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[private-key]"],
  [/("(?:code|sig|fleetSig|nonce|clientNonce|key|text|data|bytes|body)"\s*:\s*")[^"]*(")/g, "$1[redacted]$2"],
  [/\b(Bearer\s+)[\w.~+/=-]+/gi, "$1[redacted]"],
  [/[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, "[email]"],
  [/\b(?:[A-Za-z0-9-]+\.)+ts\.net\b/gi, "[tailnet-host]"],                                // MagicDNS names
  [/(?<![\d.])100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}(?!\d)/g, "[tailnet-ip]"],   // 100.64.0.0/10
  [/\bfd7a:115c:a1e0(?::[0-9a-f]{0,4})*/gi, "[tailnet-ip]"],                              // fd7a:115c:a1e0::/48
];

// Every redaction, then the home directory written as "~" (never when the home is "/", which would eat every path).
export function redact(text: string, home: string = homedir()): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  if (home && home !== "/") out = out.replace(new RegExp(`${escape(home.replace(/\/+$/, ""))}(?=$|[^\\w-])`, "g"), "~");
  return out;
}

// An error for the log: its stack, then each cause in turn, up to a cap; anything else only by its shape.
export function toLogFormat(value: unknown): string {
  const one = (x: unknown): string => {
    if (x instanceof Error) return x.stack ?? `${x.name}: ${x.message}`;
    if (typeof x === "string") return x;
    if (Array.isArray(x)) return `[array of ${x.length}]`;
    if (x !== null && typeof x === "object") return `[object with keys: ${Object.keys(x).join(", ")}]`;
    return String(x);
  };
  const seen = new Set<unknown>([value]);
  let out = one(value);
  let cause = value instanceof Error ? value.cause : undefined;
  for (let depth = 0; cause !== undefined && depth < MAX_CAUSES && !seen.has(cause); depth++) {
    out += `\nCaused by: ${one(cause)}`;
    seen.add(cause);
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return out;
}

const standardSink: Sink = (line, level) => {
  (level === "warn" || level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
};

export const levelFrom = (v: string | undefined): Level => (v === "debug" || v === "info" || v === "warn" || v === "error" ? v : "info");

export function createLogger(o: { level?: Level; home?: string; sink?: Sink } = {}): Logger {
  const min = RANK[o.level ?? "info"];
  const sink = o.sink ?? standardSink;
  const home = o.home ?? homedir();
  const at = (level: Level) => (message: string, error?: unknown) => {
    if (RANK[level] < min) return;
    const line = `[morndo-node] ${level}: ${message}${error === undefined ? "" : `\n${toLogFormat(error)}`}`;
    sink(redact(line, home), level);
  };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

// The agent's one logger; MORNDO_NODE_LOG_LEVEL picks the level (default info).
export const log: Logger = createLogger({ level: levelFrom(process.env.MORNDO_NODE_LOG_LEVEL) });
```

- [ ] **Step 10: Create `apps/node-agent/src/crash.ts`**

```ts
// Process-level crash handlers, as the hub's (apps/hub/src/adapters/crash.ts, ADR-0008 A5): an unhandled rejection or
// an uncaught exception is logged through the redacting logger and the process exits 1, for the service manager to
// restart.
import type { Logger } from "./log.ts";

export function exitOnCrash(log: Logger, exit: (code: number) => never = code => process.exit(code)) {
  process.on("unhandledRejection", reason => { log.error("unhandled promise rejection; exiting", reason); exit(1); });
  process.on("uncaughtException", error => { log.error("uncaught exception; exiting", error); exit(1); });
}
```

- [ ] **Step 11: Create `apps/node-agent/src/version.ts`**

```ts
// What this agent tells the fleet about itself: its own version (from its package.json) and the agent-channel protocol
// versions it speaks, the current and the previous one (spec §5.2; plan Contracts: FLEET_PROTO).
import { readFileSync } from "node:fs";
import { FLEET_PROTO } from "@morndo/protocol";

export const AGENT_VERSION: string = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
export const PROTO_VERSIONS: number[] = [FLEET_PROTO - 1, FLEET_PROTO].filter(v => v >= 1);
```

- [ ] **Step 12: Create `apps/node-agent/src/config.ts`**

```ts
// The node's configuration (spec §5.1, §8; plan Contracts: AgentConfig, Policy). config.json says who this node is in
// the fleet and which fleet it trusts (written by `morndo-node join`); policy.json says what the fleet may do here
// (the owner's to edit; written with the defaults at join). Both are JSON under ~/.config/morndo-node/. A value that
// doesn't fit is an error naming the file and the field, never a silent default: a typo in the policy must not widen
// what the fleet may do.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { NODE_NAME, fleetUrlOk, type OpName } from "@morndo/protocol";
import { agentPaths } from "./paths.ts";

export type Policy = {
  ops: OpName[];
  session: string;
  repoRoots: string[];
  fileRoots?: string[];
  lockedPanes: Record<string, string>;
  tmuxSocket: string | null;
};
export type AgentConfig = {
  node: string; fleetUrl: string; fleetKey: string; keyPath: string; dbPath: string; relayPort: number; home: string; policy: Policy;
};

export const ALL_OPS: readonly OpName[] = [
  "inventory.get", "pane.captureMany", "pane.frame", "pane.keys", "pane.send", "op.status",
  "transcript.size", "transcript.read", "transcript.locate", "file.stat", "file.get", "file.put",
  "lane.start", "lane.stop", "worktree.list", "worktree.add",
];
export const isOpName = (s: unknown): s is OpName => typeof s === "string" && (ALL_OPS as readonly string[]).includes(s);

export const RELAY_PORT = 8787;
// Every op on (pane.keys too: the hub's terminal view needs it; spec §8 lists turning it off as the owner's mitigation),
// the tmux session "main", no repositories for worktrees until the owner names them, files under today's rules.
export const DEFAULT_POLICY: Policy = { ops: [...ALL_OPS], session: "main", repoRoots: [], lockedPanes: {}, tmuxSocket: null };

export class ConfigError extends Error {
  constructor(message: string) { super(message); this.name = "ConfigError"; }
}

type Obj = Record<string, unknown>;
const SESSION_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const SOCKET_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

function readJson(path: string): Obj {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { throw new ConfigError(`${path} is not valid JSON: ${(e as Error).message}`); }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ConfigError(`${path} must hold a JSON object`);
  return value as Obj;
}

const absolutePaths = (v: unknown): v is string[] => Array.isArray(v) && v.every(p => typeof p === "string" && isAbsolute(p));

export function parsePolicy(value: Obj, where: string): Policy {
  const known = ["ops", "session", "repoRoots", "fileRoots", "lockedPanes", "tmuxSocket"];
  const unknown = Object.keys(value).filter(k => !known.includes(k));
  if (unknown.length) throw new ConfigError(`${where}: unknown field ${unknown.join(", ")} (known: ${known.join(", ")})`);
  const policy: Policy = { ...DEFAULT_POLICY, ops: [...DEFAULT_POLICY.ops], repoRoots: [], lockedPanes: {} };
  if (value.ops !== undefined) {
    if (!Array.isArray(value.ops) || !value.ops.every(isOpName)) throw new ConfigError(`${where}: ops must be a list of op names (${ALL_OPS.join(", ")})`);
    policy.ops = [...new Set(value.ops)];
  }
  if (value.session !== undefined) {
    if (typeof value.session !== "string" || !SESSION_NAME.test(value.session)) throw new ConfigError(`${where}: session must be a tmux session name of letters, digits, "_" or "-"`);
    policy.session = value.session;
  }
  if (value.repoRoots !== undefined) {
    if (!absolutePaths(value.repoRoots)) throw new ConfigError(`${where}: repoRoots must be a list of absolute paths`);
    policy.repoRoots = value.repoRoots;
  }
  if (value.fileRoots !== undefined) {
    if (!absolutePaths(value.fileRoots)) throw new ConfigError(`${where}: fileRoots must be a list of absolute paths`);
    policy.fileRoots = value.fileRoots;
  }
  if (value.lockedPanes !== undefined) {
    const lp = value.lockedPanes;
    if (lp === null || typeof lp !== "object" || Array.isArray(lp) || !Object.values(lp).every(p => typeof p === "string" && isAbsolute(p))) {
      throw new ConfigError(`${where}: lockedPanes must map window names to absolute lock file paths`);
    }
    policy.lockedPanes = lp as Record<string, string>;
  }
  if (value.tmuxSocket !== undefined) {
    if (value.tmuxSocket !== null && (typeof value.tmuxSocket !== "string" || !SOCKET_NAME.test(value.tmuxSocket))) {
      throw new ConfigError(`${where}: tmuxSocket must be null (the default server) or a tmux -L socket name`);
    }
    policy.tmuxSocket = value.tmuxSocket;
  }
  return policy;
}

export function loadPolicy(path: string): Policy {
  return existsSync(path) ? parsePolicy(readJson(path), path) : { ...DEFAULT_POLICY, ops: [...DEFAULT_POLICY.ops], repoRoots: [], lockedPanes: {} };
}

// The fields of config.json, as `join` writes them.
export type StoredConfig = Omit<AgentConfig, "home" | "policy">;

export function loadConfig(home: string): AgentConfig {
  const paths = agentPaths(home);
  if (!existsSync(paths.configFile)) {
    throw new ConfigError(`This machine has not joined a fleet (no ${paths.configFile}). Run: morndo-node join '<join string>'`);
  }
  const c = readJson(paths.configFile);
  const where = paths.configFile;
  if (typeof c.node !== "string" || !NODE_NAME.test(c.node)) throw new ConfigError(`${where}: node must match ${NODE_NAME}`);
  // TLS on the network: Tailscale Serve terminates it in front of the fleet, so a plain ws:// URL is only ever this
  // machine's own fleet (plan Contracts, fleetUrlOk; spec §8 "Exposure").
  if (typeof c.fleetUrl !== "string" || !fleetUrlOk(c.fleetUrl)) {
    throw new ConfigError(`${where}: fleetUrl must be wss://, or ws:// to this machine (127.0.0.1, localhost or [::1])`);
  }
  if (typeof c.fleetKey !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(c.fleetKey)) throw new ConfigError(`${where}: fleetKey must be the fleet's public key (base64)`);
  if (typeof c.keyPath !== "string" || !isAbsolute(c.keyPath)) throw new ConfigError(`${where}: keyPath must be an absolute path`);
  if (typeof c.dbPath !== "string" || !isAbsolute(c.dbPath)) throw new ConfigError(`${where}: dbPath must be an absolute path`);
  if (typeof c.relayPort !== "number" || !Number.isInteger(c.relayPort) || c.relayPort < 0 || c.relayPort > 65535) {
    throw new ConfigError(`${where}: relayPort must be a port number`);
  }
  return {
    node: c.node, fleetUrl: c.fleetUrl, fleetKey: c.fleetKey, keyPath: c.keyPath, dbPath: c.dbPath, relayPort: c.relayPort,
    home, policy: loadPolicy(paths.policyFile),
  };
}
```

- [ ] **Step 13: Run it and watch it pass**

Run: `npx vitest run apps/node-agent/test/config.test.ts`

Expected: PASS, `Tests  7 passed (7)`.

- [ ] **Step 14: Create `apps/node-agent/test/db.test.ts`**

The failing test for the agent database.

```ts
// The agent's database: numbered migrations, WAL with synchronous=FULL, a streamId born with the database, and a
// newer database refused. Real SQLite files in a temporary directory.
import Database from "better-sqlite3";
import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseFromFuture, MIGRATIONS } from "../src/db/migrations.ts";
import { openAgentDb, rotateStreamId } from "../src/db/open.ts";
import { tempHome } from "./helpers.ts";

const homes: { cleanup: () => void }[] = [];
afterEach(() => { for (const h of homes.splice(0)) h.cleanup(); });
function dbPath() { const h = tempHome(); homes.push(h); return join(h.home, "state", "agent.db"); }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("agent database", () => {
  it("is created with WAL, synchronous=FULL, every migration and a streamId", () => {
    const path = dbPath();
    const a = openAgentDb(path);
    expect(a.db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(a.db.pragma("synchronous", { simple: true })).toBe(2);              // 2 = FULL
    expect(a.db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    const tables = (a.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(r => r.name);
    expect(tables).toEqual(["done_keys", "meta", "relay_files", "stream"]);
    expect(a.streamId).toMatch(UUID);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    a.close();
  });
  it("keeps its streamId across restarts, and a reset database gets a new one", () => {
    const path = dbPath();
    const first = openAgentDb(path);
    const id = first.streamId;
    first.close();
    const again = openAgentDb(path);
    expect(again.streamId).toBe(id);
    again.close();
    for (const f of [path, `${path}-wal`, `${path}-shm`]) rmSync(f, { force: true });
    expect(existsSync(path)).toBe(false);
    const reset = openAgentDb(path);
    expect(reset.streamId).toMatch(UUID);
    expect(reset.streamId).not.toBe(id);
    reset.close();
  });
  it("rotates to a new streamId on demand (a restored backup, Task 9), and keeps the new one across restarts", () => {
    const path = dbPath();
    const a = openAgentDb(path);
    const old = a.streamId;
    const next = rotateStreamId(a.db);
    expect(next).toMatch(UUID);
    expect(next).not.toBe(old);
    a.close();
    const again = openAgentDb(path);
    expect(again.streamId).toBe(next);
    again.close();
  });
  it("refuses a database written by a newer agent and changes nothing", () => {
    const path = dbPath();
    openAgentDb(path).close();
    const raw = new Database(path);
    raw.pragma("user_version = 99");
    raw.close();
    expect(() => openAgentDb(path)).toThrow(DatabaseFromFuture);
    const check = new Database(path);
    expect(check.pragma("user_version", { simple: true })).toBe(99);
    check.close();
  });
  it("stream sequence numbers never repeat, even after every row is deleted", () => {
    const a = openAgentDb(dbPath());
    const ins = a.db.prepare("INSERT INTO stream (at, path, body, size) VALUES (1, '/notify', '{}', 2)");
    ins.run(); ins.run();
    a.db.exec("DELETE FROM stream");
    expect(Number(ins.run().lastInsertRowid)).toBe(3);
    a.close();
  });
});
```

- [ ] **Step 15: Run it and watch it fail**

Run: `npx vitest run apps/node-agent/test/db.test.ts`

Expected: FAIL, `Error: Cannot find module '../src/db/migrations.ts'`.

- [ ] **Step 16: Create `apps/node-agent/src/db/migrations.ts`**

```ts
// Numbered schema migrations for the agent's database, in the hub's pattern (apps/hub/src/adapters/migrations.ts,
// ADR-0008 A1): the schema version is SQLite's user_version; every pending migration runs in one IMMEDIATE transaction
// that ends by setting the version, so a failure leaves the database as it was; a database written by a newer agent
// is refused rather than guessed at.
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export type Migration = { version: number; name: string; up(db: Database.Database): void };

export class DatabaseFromFuture extends Error {
  readonly found: number;
  readonly known: number;
  constructor(found: number, known: number) {
    super(`The database is at schema version ${found}, but this agent knows migrations only up to ${known}.`);
    this.name = "DatabaseFromFuture";
    this.found = found;
    this.known = known;
  }
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "the agent's schema: meta (streamId), done keys, the hook stream, relay file copies (fleet-core spec §5.3–5.5, §6)",
    up: db => {
      db.exec(`
        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE done_keys (
          key TEXT PRIMARY KEY, hash TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('started', 'done')),
          outcome TEXT, at INTEGER NOT NULL);
        CREATE TABLE stream (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, path TEXT NOT NULL, session TEXT, window TEXT,
          coalesce_key TEXT, body TEXT NOT NULL, size INTEGER NOT NULL);
        CREATE INDEX stream_coalesce ON stream (coalesce_key) WHERE coalesce_key IS NOT NULL;
        CREATE TABLE relay_files (
          ref TEXT PRIMARY KEY, file TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, at INTEGER NOT NULL,
          seq INTEGER, acked_at INTEGER);
      `);
      // The hook stream's identity is born with the database: a reset or reinstalled agent starts a new stream, so the
      // fleet never takes its first events for duplicates of the old stream's (spec §5.4).
      db.prepare("INSERT INTO meta (key, value) VALUES ('streamId', ?)").run(randomUUID());
    },
  },
];

export function migrate(db: Database.Database, migrations: readonly Migration[] = MIGRATIONS): { from: number; to: number } {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`migration ${m.name} is numbered ${m.version}, expected ${i + 1}`);
  });
  const known = migrations.length;
  const version = () => db.pragma("user_version", { simple: true }) as number;
  const first = version();
  if (first > known) throw new DatabaseFromFuture(first, known);
  if (first === known) return { from: first, to: first };
  return db.transaction(() => {
    const from = version();
    if (from > known) throw new DatabaseFromFuture(from, known);
    for (const m of migrations.slice(from)) m.up(db);
    db.pragma(`user_version = ${known}`);
    return { from, to: known };
  }).immediate();
}
```

- [ ] **Step 17: Create `apps/node-agent/src/db/open.ts`**

```ts
// The agent's own SQLite database (spec §6): done keys, the hook stream and the relay's file copies, with this agent
// as the only writer. WAL, and synchronous=FULL so that a commit (a `started` key, a spooled hook) survives a power
// cut before the agent acts or answers (https://www.sqlite.org/pragma.html#pragma_synchronous). The file is created
// 0600 in a 0700 directory: hook bodies are kept here until the fleet has them.
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "./migrations.ts";

export type AgentDb = { db: Database.Database; streamId: string; close(): void };

// A new hook stream for this database, stored at once (spec §5.4). The agent does this when the fleet has accepted more
// of the stream than this database ever wrote: a database restored from a backup, whose next seqs the fleet would take
// for duplicates (Task 9, agent.ts). Its stream id is also the store id every `res` carries, so a caller asking about a
// key the restored database lost sees another store.
export function rotateStreamId(db: Database.Database): string {
  const id = randomUUID();
  db.prepare("UPDATE meta SET value = ? WHERE key = 'streamId'").run(id);
  return id;
}

export function openAgentDb(path: string): AgentDb {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  closeSync(openSync(path, "a", 0o600));
  const db = new Database(path);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    migrate(db);
    const row = db.prepare("SELECT value FROM meta WHERE key = 'streamId'").get() as { value: string } | undefined;
    if (!row) throw new Error(`${path} has no streamId`);
    return { db, streamId: row.value, close: () => db.close() };
  } catch (e) {
    db.close();
    throw e;
  }
}
```

- [ ] **Step 18: Run it and watch it pass**

Run: `npx vitest run apps/node-agent/test/db.test.ts`

Expected: PASS, `Tests  5 passed (5)`.

- [ ] **Step 19: Create `apps/node-agent/test/fake-fleet.ts`**

The scripted fake fleet used by the join, connection, stream and agent tests (spec §9, "real agent against a scripted fake fleet"). It decodes every agent message with the protocol's own schemas (`AgentFrames`) and closes with 1008 on one that doesn't fit, so a message a real fleet would refuse fails its test. As the fleet does (plan Contracts, "Join flow"), it answers a good `join` with `welcome { connEpoch: 1, ackSeq: 0, streamKnown: false }` and closes with 1000. The agent closes with 1000 too once it has the welcome; whichever close comes first, the join has succeeded.

```ts
// A scripted fleet for the agent's tests (spec §9, "real agent against a scripted fake fleet"): a real ws server on a
// random port with its own Ed25519 key. It runs join and the mutual handshake the way the fleet service does, records
// every message the agent sends, and does what `script` says; a test changes `script` between connections. Every
// message is decoded with the protocol's own schemas (AgentFrames): one that doesn't fit is recorded in `malformed` and
// the connection is closed (1008), so an agent message a real fleet would refuse fails the test that sent it.
import { createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { AgentFrames, LIMITS, decodeValue, fleetSigPayload, formatJoinString, nodeSigPayload } from "@morndo/protocol";
import { wsText } from "../src/ws-text.ts";

export type Script = {
  join: "welcome" | number;                                   // the answer to `join`: welcome, or close with this code
  hello: "challenge" | number;                                // the answer to `hello`
  tamperSig: boolean;                                         // sign something other than the payload
  welcome: { connEpoch: number; ackSeq: number; streamKnown: boolean } | number;   // after a good proof, or a close code
  // As a real fleet keeps them: the highest seq accepted per stream. When set, a welcome's ackSeq and streamKnown are
  // those of the hello's streamId (unknown: 0 and false) instead of `welcome`'s.
  streams: Record<string, number> | null;
  pingMs: number | null;                                      // ping the agent this often after welcome
  autoAck: boolean;                                           // acknowledge every hook event at once
};
export type Msg = Record<string, unknown>;
export type Received = { conn: number; msg: Msg };

export type FakeFleet = {
  url: string;
  fleetKey: string;                                           // SPKI DER base64: what a join string pins
  script: Script;
  received: Received[];
  malformed: Received[];                                      // messages that don't fit the protocol's schemas
  closes: { conn: number; code: number }[];                   // each socket's close, as the fleet saw it
  connections(): number;                                      // sockets accepted so far
  trust(node: string, publicKeySpki: string): void;           // as if the node had joined
  joinString(node: string, code?: string): string;            // a join string with a fresh one-time code
  send(msg: Msg): void;                                       // to the newest socket
  closeAgent(code: number, reason?: string): void;
  terminateAgent(): void;
  live(): boolean;
  waitFor(pred: (m: Msg) => boolean, ms?: number, from?: number): Promise<Msg>;
  close(): Promise<void>;
};

export async function startFakeFleet(over: Partial<Script> = {}): Promise<FakeFleet> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const fleetKey = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const script: Script = { join: "welcome", hello: "challenge", tamperSig: false, welcome: { connEpoch: 1, ackSeq: 0, streamKnown: false }, streams: null, pingMs: null, autoAck: false, ...over };
  const received: Received[] = [];
  const malformed: Received[] = [];
  const closes: { conn: number; code: number }[] = [];
  const codes = new Map<string, string>();                    // code → node
  const nodeKeys = new Map<string, KeyObject>();
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: LIMITS.maxPayload });
  await new Promise<void>(resolve => wss.once("listening", () => resolve()));
  const address = wss.address();
  const port = typeof address === "object" && address ? address.port : 0;
  let count = 0;
  let current: WebSocket | null = null;
  const listeners = new Set<() => void>();
  const out = (ws: WebSocket, msg: Msg) => ws.send(JSON.stringify({ v: 1, ...msg }));

  wss.on("connection", ws => {
    const conn = ++count;
    current = ws;
    let node = "";
    let nonce = "";
    let stream = "";
    let ping: NodeJS.Timeout | null = null;
    ws.on("close", code => { if (ping) clearInterval(ping); closes.push({ conn, code }); });
    ws.on("message", raw => {
      const msg = JSON.parse(wsText(raw)) as Msg;
      received.push({ conn, msg });
      for (const l of listeners) l();
      if (decodeValue(AgentFrames, msg).kind !== "ok") {
        malformed.push({ conn, msg });
        ws.close(1008, "malformed");
        return;
      }
      switch (msg.t) {
        case "join": {
          const named = codes.get(String(msg.code));
          if (typeof script.join === "number" || named === undefined || named !== msg.node) {   // unknown, used, or another name's code
            ws.close(typeof script.join === "number" ? script.join : 4403, "refused");
            return;
          }
          codes.delete(String(msg.code));
          nodeKeys.set(named, createPublicKey({ key: Buffer.from(String(msg.publicKey), "base64"), format: "der", type: "spki" }));
          out(ws, { t: "welcome", connEpoch: 1, ackSeq: 0, streamKnown: false });   // placeholder values (plan Contracts)
          ws.close(1000, "joined");
          return;
        }
        case "hello": {
          node = String(msg.node);
          stream = String(msg.streamId);
          if (typeof script.hello === "number") { ws.close(script.hello, "refused"); return; }
          nonce = randomBytes(32).toString("base64url");
          const payload = fleetSigPayload(node, String(msg.clientNonce));
          const fleetSig = sign(null, Buffer.from(script.tamperSig ? `${payload}x` : payload), privateKey).toString("base64");
          out(ws, { t: "challenge", nonce, fleetSig });
          return;
        }
        case "proof": {
          const key = nodeKeys.get(node);
          const good = key !== undefined && verify(null, Buffer.from(nodeSigPayload(node, nonce)), key, Buffer.from(String(msg.sig), "base64"));
          if (!good) { ws.close(4401, "bad proof"); return; }
          const w = script.welcome;
          if (typeof w === "number") { ws.close(w, "refused"); return; }
          const known = script.streams;
          out(ws, { t: "welcome", ...w, ...(known ? { ackSeq: known[stream] ?? 0, streamKnown: Object.hasOwn(known, stream) } : {}) });
          if (script.pingMs !== null) ping = setInterval(() => ws.ping(), script.pingMs);
          return;
        }
        case "ev.hook": {
          const e = msg.event as { streamId: string; seq: number };
          if (script.autoAck) out(ws, { t: "ack", streamId: e.streamId, seq: e.seq });
          return;
        }
        default:
          return;
      }
    });
  });

  return {
    url: `ws://127.0.0.1:${port}/agent`,
    fleetKey,
    script,
    received,
    malformed,
    closes,
    connections: () => count,
    trust: (node, spki) => { nodeKeys.set(node, createPublicKey({ key: Buffer.from(spki, "base64"), format: "der", type: "spki" })); },
    joinString: (node, code = randomBytes(16).toString("base64url")) => {
      codes.set(code, node);
      return formatJoinString({ url: `ws://127.0.0.1:${port}/agent`, fleetKey, code, node });
    },
    send: msg => { if (current) out(current, msg); },
    closeAgent: (code, reason = "") => current?.close(code, reason),
    terminateAgent: () => current?.terminate(),
    live: () => current !== null && current.readyState === current.OPEN,
    waitFor: (pred, ms = 5000, from = 0) => new Promise((resolve, reject) => {
      const check = () => {
        const hit = received.slice(from).find(r => pred(r.msg));
        if (!hit) return false;
        listeners.delete(check);
        clearTimeout(timer);
        resolve(hit.msg);
        return true;
      };
      const timer = setTimeout(() => { listeners.delete(check); reject(new Error("the fake fleet never received the expected message")); }, ms);
      if (!check()) listeners.add(check);
    }),
    close: () => new Promise<void>(resolve => {
      for (const c of wss.clients) c.terminate();
      wss.close(() => resolve());
    }),
  };
}
```

- [ ] **Step 20: Create `apps/node-agent/test/join.test.ts`**

The failing join test, with plan Review Focus 5: whitespace, quotes and a trailing newline are accepted; a truncated string gives a clear error and leaves no state on disk.

```ts
// `morndo-node join` against a scripted fleet (spec §5.1; plan Review Focus 5): a join string pasted with whitespace,
// quotes or a trailing newline is accepted; a truncated one, a refused code or an unreachable fleet gives a clear error
// and leaves nothing on disk.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join as joinPath } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatJoinString, parseJoinString } from "@morndo/protocol";
import { loadConfig } from "../src/config.ts";
import { loadNodeKey } from "../src/identity.ts";
import { JoinError, join } from "../src/join.ts";
import { agentPaths } from "../src/paths.ts";
import { startFakeFleet, type FakeFleet } from "./fake-fleet.ts";
import { tempHome } from "./helpers.ts";

let fleet: FakeFleet;
const homes: { cleanup: () => void }[] = [];
beforeEach(async () => { fleet = await startFakeFleet(); });
afterEach(async () => { await fleet.close(); for (const h of homes.splice(0)) h.cleanup(); });
function home() { const h = tempHome(); homes.push(h); return h.home; }
// Nothing of the agent's on disk: no config or state directory at all.
const untouched = (h: string) => !existsSync(joinPath(h, ".config")) && !existsSync(joinPath(h, ".local"));

describe("join", () => {
  for (const [label, wrap] of [
    ["as printed", (s: string) => s],
    ["with spaces around it", (s: string) => `   ${s}  `],
    ["in double quotes", (s: string) => `"${s}"`],
    ["in single quotes with a trailing newline", (s: string) => `'${s}'\n`],
    ["with a trailing CRLF and a tab", (s: string) => `\t${s}\r\n`],
  ] as const) {
    it(`accepts a join string ${label}`, async () => {
      const h = home();
      const joined = await join({ home: h, joinString: wrap(fleet.joinString("pc")) });
      expect(joined).toMatchObject({ node: "pc", fleetUrl: fleet.url });
      const config = loadConfig(h);
      expect(config).toMatchObject({ node: "pc", fleetUrl: fleet.url, fleetKey: fleet.fleetKey, relayPort: 8787 });
      // The key the fleet was given is the key on disk, and only this user can read it.
      const sent = fleet.received.find(r => r.msg.t === "join")?.msg;
      expect(sent).toMatchObject({ v: 1, t: "join", node: "pc", proto: [1], agent: { version: "0.0.0" } });
      expect(sent?.publicKey).toBe(loadNodeKey(config.keyPath).publicKey);
      expect(statSync(config.keyPath).mode & 0o777).toBe(0o600);
      expect(statSync(agentPaths(h).configFile).mode & 0o777).toBe(0o600);
      expect(existsSync(agentPaths(h).policyFile)).toBe(true);
      expect(readdirSync(agentPaths(h).configDir).filter(f => f.endsWith(".tmp"))).toEqual([]);
    });
  }

  it("refuses a truncated join string with a clear error and writes nothing (and never dials)", async () => {
    const full = fleet.joinString("pc");
    for (const cut of [full.slice(0, -5), full.slice(0, 20), "morndo-join:1:", ""]) {
      const h = home();
      await expect(join({ home: h, joinString: cut })).rejects.toThrow(/not a complete join string.*Nothing was written/s);
      expect(untouched(h)).toBe(true);
    }
    expect(fleet.connections()).toBe(0);
  });

  it("writes nothing when the fleet refuses the code (4403), and says why", async () => {
    const h = home();
    const s = fleet.joinString("pc");
    await join({ home: home(), joinString: s });                       // the code is single use: this spends it
    await expect(join({ home: h, joinString: s })).rejects.toThrow(/refused the code.*Nothing was written/s);
    expect(untouched(h)).toBe(true);
  });

  it("writes nothing when the join string's name was changed: the code is bound to the name it was issued for", async () => {
    const issued = parseJoinString(fleet.joinString("pc"));
    if (!issued) throw new Error("the fake fleet's join string does not parse");
    const h = home();
    await expect(join({ home: h, joinString: formatJoinString({ ...issued, node: "other" }) })).rejects.toThrow(/refused the code.*Nothing was written/s);
    expect(untouched(h)).toBe(true);
  });

  it("refuses a plain ws:// fleet URL to another machine before dialing it, and writes nothing (plan Contracts, fleetUrlOk)", async () => {
    // ws://0.0.0.0:<port> reaches this machine's fake fleet if dialed, but its host is not a loopback name: no TLS, so
    // to the agent it is another machine.
    const port = Number(new URL(fleet.url).port);
    const plain = fleet.joinString("pc").replace(/^morndo-join:1:(.*)$/, (_, b64: string) => {
      const j = JSON.parse(Buffer.from(b64, "base64url").toString()) as Record<string, string>;
      return `morndo-join:1:${Buffer.from(JSON.stringify({ ...j, url: `ws://0.0.0.0:${port}/agent` })).toString("base64url")}`;
    });
    const h = home();
    await expect(join({ home: h, joinString: plain })).rejects.toThrow(/plain ws:\/\/ to another machine.*Nothing was written/s);
    expect(untouched(h)).toBe(true);
    expect(fleet.connections()).toBe(0);
  });

  it("writes nothing when the fleet can't be reached", async () => {
    const port = await new Promise<number>(resolve => {
      const srv = createServer().listen(0, "127.0.0.1", () => {
        const a = srv.address();
        srv.close(() => resolve(typeof a === "object" && a ? a.port : 0));
      });
    });
    const h = home();
    const closed = fleet.joinString("pc").replace(/^morndo-join:1:(.*)$/, (_, b64: string) => {
      const j = JSON.parse(Buffer.from(b64, "base64url").toString()) as Record<string, string>;
      return `morndo-join:1:${Buffer.from(JSON.stringify({ ...j, url: `ws://127.0.0.1:${port}/agent` })).toString("base64url")}`;   // a valid string, pointed at a closed port
    });
    await expect(join({ home: h, joinString: closed })).rejects.toThrow(JoinError);
    await expect(join({ home: h, joinString: closed })).rejects.toThrow(/Could not reach the fleet.*Nothing was written/s);
    expect(untouched(h)).toBe(true);
  });

  it("refuses to join twice and leaves the first join as it was", async () => {
    const h = home();
    await join({ home: h, joinString: fleet.joinString("pc") });
    const before = readFileSync(agentPaths(h).configFile, "utf8");
    await expect(join({ home: h, joinString: fleet.joinString("other") })).rejects.toThrow(/already joined/);
    expect(readFileSync(agentPaths(h).configFile, "utf8")).toBe(before);
  });

  it("keeps a policy.json the owner wrote before joining", async () => {
    const h = home();
    const p = agentPaths(h);
    mkdirSync(p.configDir, { recursive: true });
    writeFileSync(p.policyFile, JSON.stringify({ session: "lanes" }));
    await join({ home: h, joinString: fleet.joinString("pc") });
    expect(loadConfig(h).policy.session).toBe("lanes");
  });
});
```

- [ ] **Step 21: Run it and watch it fail**

Run: `npx vitest run apps/node-agent/test/join.test.ts`

Expected: FAIL, `Error: Cannot find module '../src/identity.ts'`: the first module the test imports that doesn't exist yet (`join.ts`, and `ws-text.ts` through `fake-fleet.ts`, are missing too).

- [ ] **Step 22: Create `apps/node-agent/src/ws-text.ts`**

```ts
// A WebSocket message as text. ws hands over a Buffer by default, a list of Buffers for a fragmented message, or an
// ArrayBuffer when asked to (ws 8.22.0 doc/ws.md, event 'message': `data` is Buffer | ArrayBuffer | Buffer[]).
import type { RawData } from "ws";

export function wsText(raw: RawData): string {
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  return Buffer.from(raw).toString("utf8");
}
```

- [ ] **Step 23: Create `apps/node-agent/src/identity.ts`**

```ts
// The node's own key and the fleet's pinned key (ADR-0012 decision 4; spec §5.1, §5.2). Ed25519 through node:crypto
// (https://nodejs.org/docs/latest-v24.x/api/crypto.html, read 2026-10-06: generateKeyPairSync('ed25519'), sign(null, …),
// verify(null, …), keyObject.export({ format: 'der', type: 'spki' }), createPublicKey({ key, format: 'der',
// type: 'spki' })). Public keys travel as SPKI DER in base64; the private key stays in a PKCS#8 PEM file of mode 0600.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

export type NodeKey = {
  publicKey: string;                    // SPKI DER, base64
  sign(payload: string): string;        // Ed25519 over the UTF-8 payload, base64
  pem(): string;                        // the private key, PKCS#8 PEM
};

function wrap(privateKey: KeyObject): NodeKey {
  return {
    publicKey: createPublicKey(privateKey).export({ format: "der", type: "spki" }).toString("base64"),
    sign: payload => sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64"),
    pem: () => privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

export function createNodeKey(): NodeKey {
  return wrap(generateKeyPairSync("ed25519").privateKey);
}

export function loadNodeKey(path: string): NodeKey {
  const key = createPrivateKey(readFileSync(path));
  if (key.asymmetricKeyType !== "ed25519") throw new Error(`${path} is not an Ed25519 private key`);
  return wrap(key);
}

// The fleet's public key from a join string or config.json, or null when it isn't an Ed25519 SPKI key.
export function fleetPublicKey(spkiBase64: string): KeyObject | null {
  try {
    const key = createPublicKey({ key: Buffer.from(spkiBase64, "base64"), format: "der", type: "spki" });
    return key.asymmetricKeyType === "ed25519" ? key : null;
  } catch {
    return null;
  }
}

export function signedBy(key: KeyObject, payload: string, sigBase64: string): boolean {
  try { return verify(null, Buffer.from(payload, "utf8"), key, Buffer.from(sigBase64, "base64")); }
  catch { return false; }
}
```

- [ ] **Step 24: Create `apps/node-agent/src/join.ts`**

```ts
// `morndo-node join '<join string>'` (spec §5.1), once per node:
// 1. the string is parsed whole (parseJoinString trims whitespace, a trailing newline and surrounding quotes);
// 2. a key pair is made in memory;
// 3. the fleet is asked to accept its public key with the one-time code, over a connection that closes after the
//    fleet's welcome;
// 4. only then are the private key (0600), a default policy.json (when there is none) and config.json written, each
//    atomically, config.json last: it is what makes the node joined.
// Any failure before step 4 (a truncated string, a plain ws:// URL to another machine, a bad fleet key, an unreachable
// fleet, a refused code) leaves nothing on disk, and says so. A fleet URL is wss://, or ws:// only to this machine
// (fleetUrlOk; parseJoinString already refuses any other): the agent never sends its key over a network in the clear.
import { existsSync, rmSync } from "node:fs";
import { WebSocket } from "ws";
import { CLOSE, LIMITS, NODE_NAME, Welcome, fleetUrlOk, parseBody, parseJoinString, type AgentMessage, type JoinString } from "@morndo/protocol";
import { writeFileAtomic } from "./atomic-write.ts";
import { DEFAULT_POLICY, RELAY_PORT, type StoredConfig } from "./config.ts";
import { createNodeKey, fleetPublicKey, type NodeKey } from "./identity.ts";
import { agentPaths } from "./paths.ts";
import { AGENT_VERSION, PROTO_VERSIONS } from "./version.ts";
import { wsText } from "./ws-text.ts";

export class JoinError extends Error {
  constructor(message: string) { super(message); this.name = "JoinError"; }
}

export type JoinOptions = { home: string; joinString: string; timeoutMs?: number };
export type Joined = { node: string; fleetUrl: string; configFile: string };

const NOTHING_WRITTEN = "Nothing was written.";

export async function join(o: JoinOptions): Promise<Joined> {
  const paths = agentPaths(o.home);
  if (existsSync(paths.configFile)) {
    throw new JoinError(`This machine already joined a fleet (${paths.configFile}). To join again, remove that file and ${paths.keyPath} first. ${NOTHING_WRITTEN}`);
  }
  const j = parseJoinString(o.joinString);
  if (!j) {
    throw new JoinError(`That is not a complete join string, or its fleet URL is plain ws:// to another machine (only wss://, or ws:// to this machine). Copy the whole line that \`morndo-fleet node add <name>\` printed (it starts with morndo-join:1:) and run this again. ${NOTHING_WRITTEN}`);
  }
  if (!NODE_NAME.test(j.node)) throw new JoinError(`The join string names the node ${JSON.stringify(j.node)}, which is not a valid node name. ${NOTHING_WRITTEN}`);
  if (!fleetUrlOk(j.url)) throw new JoinError(`The join string's fleet URL is plain ws:// to another machine: only wss://, or ws:// to this machine. ${NOTHING_WRITTEN}`);
  if (!fleetPublicKey(j.fleetKey)) throw new JoinError(`The join string's fleet key is not an Ed25519 public key. ${NOTHING_WRITTEN}`);

  const key = createNodeKey();
  await askFleet(j, key, o.timeoutMs ?? 15_000);

  const policyExisted = existsSync(paths.policyFile);
  const stored: StoredConfig = { node: j.node, fleetUrl: j.url, fleetKey: j.fleetKey, keyPath: paths.keyPath, dbPath: paths.dbPath, relayPort: RELAY_PORT };
  try {
    writeFileAtomic(paths.keyPath, key.pem(), 0o600);
    if (!policyExisted) writeFileAtomic(paths.policyFile, `${JSON.stringify(DEFAULT_POLICY, null, 2)}\n`, 0o600);
    writeFileAtomic(paths.configFile, `${JSON.stringify(stored, null, 2)}\n`, 0o600);
  } catch (e) {
    rmSync(paths.keyPath, { force: true });
    if (!policyExisted) rmSync(paths.policyFile, { force: true });
    throw new JoinError(`The fleet accepted this node, but its files could not be written (${(e as Error).message}). The code is used up: ask for a new one with \`morndo-fleet node add ${j.node}\`.`);
  }
  return { node: j.node, fleetUrl: j.url, configFile: paths.configFile };
}

// One connection: `join`, then the fleet's welcome (accepted) or a close code (refused).
function askFleet(j: JoinString, key: NodeKey, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(j.url, { maxPayload: LIMITS.maxPayload, handshakeTimeout: timeoutMs });
    let settled = false;
    let cause = "";
    const finish = (error: JoinError | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => {
      finish(new JoinError(`The fleet at ${j.url} did not answer within ${Math.round(timeoutMs / 1000)} s. ${NOTHING_WRITTEN}`));
      ws.terminate();
    }, timeoutMs);
    ws.on("open", () => {
      const msg: AgentMessage = { v: 1, t: "join", node: j.node, code: j.code, publicKey: key.publicKey, agent: { version: AGENT_VERSION }, proto: PROTO_VERSIONS };
      ws.send(JSON.stringify(msg));
    });
    ws.on("message", raw => {
      let value: unknown = null;
      try { value = JSON.parse(wsText(raw)); } catch { /* not JSON: refused below */ }
      if (parseBody(Welcome, value)) {
        finish(null);
        ws.close(1000, "joined");
      } else {
        finish(new JoinError(`The fleet answered something this agent does not understand. ${NOTHING_WRITTEN}`));
        ws.close(1002, "unexpected message");
      }
    });
    ws.on("error", e => { cause = (e as NodeJS.ErrnoException).code ?? e.message; });
    ws.on("close", code => {
      if (code === CLOSE.forbidden) {
        finish(new JoinError(`The fleet refused the code: it is unknown, expired (codes last 10 minutes) or already used. Ask for a new one with \`morndo-fleet node add ${j.node}\`. ${NOTHING_WRITTEN}`));
      } else if (code === CLOSE.unsupported) {
        finish(new JoinError(`The fleet does not speak this agent's protocol (versions ${PROTO_VERSIONS.join(", ")}). Update morndo-node or the fleet. ${NOTHING_WRITTEN}`));
      } else {
        finish(new JoinError(`Could not reach the fleet at ${j.url}${cause ? ` (${cause})` : ` (closed with ${code})`}. ${NOTHING_WRITTEN}`));
      }
    });
  });
}
```

- [ ] **Step 25: Create `apps/node-agent/src/main.ts`**

Only `join` for now; Task 7 adds `status`, Task 9 adds `run`. It is the package's `bin`, so it is executable: after writing it, run `chmod +x apps/node-agent/src/main.ts`. (Tasks 7 and 9 replace its content; writing over an existing file keeps its mode.)

```ts
#!/usr/bin/env node
// morndo-node: this machine's agent in a Morndo fleet (ADR-0012). `join` once, with the string the fleet printed.
import { homedir } from "node:os";
import { exitOnCrash } from "./crash.ts";
import { JoinError, join } from "./join.ts";
import { log } from "./log.ts";

const HELP = `morndo-node: this machine's agent in a Morndo fleet.

  morndo-node join '<join string>'   join the fleet once, with the string \`morndo-fleet node add <name>\` printed

Files: ~/.config/morndo-node/ (config.json, policy.json, node-key.pem) and ~/.local/state/morndo-node/.
MORNDO_NODE_LOG_LEVEL sets the log level (default info).`;

exitOnCrash(log);
const home = process.env.HOME || homedir();
const [cmd = "help", ...args] = process.argv.slice(2);
// The command's own output, for the person at the machine: not a log.
const print = (text: string) => process.stdout.write(`${text}\n`);

switch (cmd) {
  case "join": {
    if (args.length !== 1) { process.stderr.write("usage: morndo-node join '<join string>'\n"); process.exit(2); }
    try {
      const joined = await join({ home, joinString: args[0] ?? "" });
      print(`Joined the fleet at ${joined.fleetUrl} as ${joined.node}. Start the agent with: morndo-node run`);
    } catch (e) {
      if (!(e instanceof JoinError)) throw e;
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    break;
  }
  default:
    print(HELP);
}
```

- [ ] **Step 26: Run it and watch it pass**

Run: `npx vitest run apps/node-agent/test/join.test.ts`

Expected: PASS, `Tests  12 passed (12)`.

- [ ] **Step 27: Check the whole task: tests, types, lint and the CLI**

Run each command on its own (a chain would stop at the first failure and hide the rest):
- `npx vitest run apps/node-agent/test`. Expected: `Test Files  3 passed (3)` and `Tests  24 passed (24)`.
- `npx tsc -p apps/node-agent`. Expected: no output, exit 0.
- `npx tsc -p tsconfig.tests.json`. Expected: no output, exit 0.
- `npx oxlint --format=stylish apps/node-agent`. Expected: no output.
- `test -x apps/node-agent/src/main.ts && echo executable`. Expected: `executable`.
- `HOME=$(mktemp -d) node apps/node-agent/src/main.ts join 'morndo-join:1:abc'; echo "exit $?"`. Expected: `That is not a complete join string, … Nothing was written.`, then `exit 1`.

- [ ] **Step 28: Commit**

```bash
git add apps/node-agent package-lock.json
git commit -m "feat(node-agent): morndo-node join, config and policy, node key, agent database"
git ls-files -s apps/node-agent/src/main.ts
```

The last line prints the file with mode `100755`.


### Task 7: Connection to the fleet: mutual handshake, backoff, liveness, close codes

**Files:**
- Create: `apps/node-agent/src/conn/retry.ts`, `apps/node-agent/src/conn/send-queue.ts`, `apps/node-agent/src/conn/status-file.ts`, `apps/node-agent/src/conn/connection.ts`
- Modify: `apps/node-agent/src/main.ts` (adds `status`)
- Test: `apps/node-agent/test/send-queue.test.ts`, `apps/node-agent/test/retry.test.ts`, `apps/node-agent/test/connection.test.ts`

**Interfaces:**
- **Consumes:**
  - from Task 1: `CLOSE`, `LIMITS` (`agentPingTimeoutMs` 35 s, `conflictRetryMs` 5 min), `FleetMessage` (both the schema and its type), the type `AgentMessage`, `fleetSigPayload`, `nodeSigPayload`, `fleetUrlOk` and `parseBody`;
  - from Task 6: `signedBy`, the type `Logger`, `AGENT_VERSION`, `PROTO_VERSIONS`, `wsText`, `writeFileAtomic`, `loadConfig`, `ConfigError`, and `agentPaths`.
- **Produces:**

```ts
// retry.ts
export type RetryOptions = { baseMs?: number; capMs?: number; random?: () => number; now?: () => number };
export class RetrySchedule { constructor(o?: RetryOptions); nextDelay(): number; backoff(fn: () => void): number; after(ms: number, fn: () => void): void;
  afterAbout(ms: number, spread: number, fn: () => void): number /* ms ± spread (a fraction), jittered */; cancel(): void; reset(): void; retryInMs(): number | null }
// send-queue.ts
export type Lane = "control" | "bulk"; export type Wire = { send(data: string, cb: (err?: Error) => void): void };
export class SendQueue { constructor(wire: Wire); push(data: string, lane: Lane): void; close(): void; readonly pending: number }
// status-file.ts
export type ConnState = "stopped" | "connecting" | "online" | "backoff" | "refused" | "conflict" | "unsupported";
export type ConnStatus = { state: ConnState; since: number; connEpoch: number | null; lastClose: { code: number; reason: string } | null; retryInMs: number | null };
export type AgentStatus = ConnStatus & { node: string; instanceId: string; pid: number; spoolDepth: number; drops: number };
export function writeStatus(path: string, s: AgentStatus): void; export function readStatus(path: string): AgentStatus | null;
export function formatStatus(config: { node: string; fleetUrl: string }, s: AgentStatus | null, isAlive?: (pid: number) => boolean): string;
// connection.ts
export type ReqMessage = Extract<FleetMessage, { t: "req" }>; export type AckMessage = Extract<FleetMessage, { t: "ack" }>;
export type Welcomed = { connEpoch: number; ackSeq: number; streamKnown: boolean }; export const UNSUPPORTED_RETRY_MS = 3_600_000; export const CONFLICT_SPREAD = 0.2;
export type ConnectionOptions = { url: string; node: string; instanceId: string; streamId: string; fleetKey: KeyObject; nodeKey: { sign(payload: string): string };
  caps: string[]; claudeVersion: () => string | null; log: Logger; onWelcome(w: Welcomed): void; onRequest(m: ReqMessage): void;
  onBadRequest(id: string, op: unknown): void; onAck(m: AckMessage): void; onDown(): void; onStatus(s: ConnStatus): void;
  retry?: RetryOptions; pingTimeoutMs?: number; unsupportedRetryMs?: number };
export class FleetConnection { constructor(o: ConnectionOptions) /* throws TypeError for a url that fails fleetUrlOk */; status(): ConnStatus; readonly online: boolean; start(): void;
  send(msg: AgentMessage, lane?: Lane): boolean; drop(): void /* terminate the live socket; the ordinary redial follows */;
  setStreamId(id: string): void /* the next hello names this stream (Task 9: a rotated stream) */; stop(): Promise<void> }
```

- [ ] **Step 1: Create `apps/node-agent/test/send-queue.test.ts`**

The failing test for the two send queues (spec §5.2, "Frames").

```ts
// The two send queues (spec §5.2 "Frames"): control before bulk, one bulk message in flight.
import { describe, expect, it } from "vitest";
import { SendQueue } from "../src/conn/send-queue.ts";

function wire() {
  const sent: string[] = [];
  const callbacks: (() => void)[] = [];
  return { sent, finish: () => callbacks.shift()?.(), send: (d: string, cb: () => void) => { sent.push(d); callbacks.push(cb); } };
}

describe("send queues", () => {
  it("sends control messages at once, and holds the second bulk message until the first is written", () => {
    const w = wire();
    const q = new SendQueue(w);
    q.push("bulk-1", "bulk");
    q.push("bulk-2", "bulk");
    q.push("ctl-1", "control");
    expect(w.sent).toEqual(["bulk-1", "ctl-1"]);                          // ctl-1 overtook bulk-2
    q.push("ctl-2", "control");
    expect(w.sent).toEqual(["bulk-1", "ctl-1", "ctl-2"]);
    w.finish();                                                            // bulk-1 written
    expect(w.sent).toEqual(["bulk-1", "ctl-1", "ctl-2", "bulk-2"]);
  });
  it("drops what is queued when the connection closes", () => {
    const w = wire();
    const q = new SendQueue(w);
    q.push("bulk-1", "bulk");
    q.push("bulk-2", "bulk");
    q.close();
    w.finish();
    q.push("ctl", "control");
    expect(w.sent).toEqual(["bulk-1"]);
    expect(q.pending).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run apps/node-agent/test/send-queue.test.ts`

Expected: FAIL, `Error: Cannot find module '../src/conn/send-queue.ts'`.

- [ ] **Step 3: Create `apps/node-agent/src/conn/send-queue.ts`**

```ts
// The two send queues of one connection (spec §5.2, "Frames"): control messages (op results, events) always go before
// bulk ones (results carrying transcript or file bytes), and at most one bulk message is being written at a time; the
// next waits until ws reports the previous one written. So an op result never waits behind a transfer, and a 256 KiB
// chunk never queues inside ws behind more than one other.
export type Lane = "control" | "bulk";
export type Wire = { send(data: string, cb: (err?: Error) => void): void };

export class SendQueue {
  #wire: Wire;
  #control: string[] = [];
  #bulk: string[] = [];
  #bulkInFlight = false;
  #closed = false;

  constructor(wire: Wire) { this.#wire = wire; }

  push(data: string, lane: Lane): void {
    if (this.#closed) return;
    (lane === "control" ? this.#control : this.#bulk).push(data);
    this.#drain();
  }

  // The connection is gone: what is queued is dropped (hook events stay in the spool and are replayed).
  close(): void {
    this.#closed = true;
    this.#control = [];
    this.#bulk = [];
  }

  get pending(): number { return this.#control.length + this.#bulk.length; }

  #drain(): void {
    while (!this.#closed && this.#control.length) this.#wire.send(this.#control.shift() as string, () => {});
    if (this.#closed || this.#bulkInFlight || !this.#bulk.length) return;
    this.#bulkInFlight = true;
    this.#wire.send(this.#bulk.shift() as string, () => {
      this.#bulkInFlight = false;
      this.#drain();
    });
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run apps/node-agent/test/send-queue.test.ts`

Expected: PASS, `Tests  2 passed (2)`.

- [ ] **Step 5: Create `apps/node-agent/test/retry.test.ts`**

The failing backoff test, with plan Review Focus 4 (a wall-clock jump during backoff). Fake timers (`setTimeout`, `performance`) and a mocked `Date` move the clock an hour ahead and two hours back; this is checked both on the schedule itself and on the connection's real redials to an unreachable fleet.

```ts
// Backoff for dialing the fleet (spec §5.2): 1 s to 60 s, full jitter, on the monotonic clock. Plan Review Focus 4: a
// wall-clock jump during backoff changes nothing; checked with fake timers (setTimeout, performance) and a mocked Date
// moved by an hour in each direction.
import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FleetConnection } from "../src/conn/connection.ts";
import { RetrySchedule } from "../src/conn/retry.ts";
import type { ConnStatus } from "../src/conn/status-file.ts";
import { createNodeKey, fleetPublicKey } from "../src/identity.ts";
import { captureLog } from "./helpers.ts";

afterEach(() => { vi.useRealTimers(); });

describe("full-jitter backoff", () => {
  it("bounds grow 1 s, 2 s, 4 s … up to 60 s; the jitter is a fraction of the bound", () => {
    const top = new RetrySchedule({ random: () => 1 });
    expect(Array.from({ length: 9 }, () => top.nextDelay())).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
    const half = new RetrySchedule({ random: () => 0.5 });
    expect([half.nextDelay(), half.nextDelay(), half.nextDelay()]).toEqual([500, 1000, 2000]);
    expect(new RetrySchedule({ random: () => 0 }).nextDelay()).toBe(0);
  });
  it("starts from the base again after reset (a welcome)", () => {
    const r = new RetrySchedule({ random: () => 1 });
    r.nextDelay(); r.nextDelay(); r.nextDelay();
    r.reset();
    expect(r.nextDelay()).toBe(1000);
  });
  it("afterAbout jitters a fixed wait by ± a fraction (a refused second instance's 5 minutes ± 20 %)", () => {
    const at = (random: number) => { const r = new RetrySchedule({ random: () => random }); const d = r.afterAbout(300_000, 0.2, () => {}); r.cancel(); return d; };
    expect([at(0), at(0.5), at(1)]).toEqual([240_000, 300_000, 360_000]);
  });
});

describe("a wall-clock jump during backoff (Review Focus 4)", () => {
  it("neither fires the retry early nor holds it back, and the reported wait follows the monotonic clock", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const r = new RetrySchedule({ random: () => 1 });
    let fired = 0;
    r.backoff(() => { fired++; });                                     // 1000 ms
    vi.setSystemTime(Date.now() + 3_600_000);                          // the clock jumps an hour ahead
    expect(r.retryInMs()).toBe(1000);
    vi.advanceTimersByTime(999);
    expect(fired).toBe(0);
    vi.advanceTimersByTime(1);
    expect(fired).toBe(1);
    r.backoff(() => { fired++; });                                     // 2000 ms
    vi.setSystemTime(Date.now() - 7_200_000);                          // and two hours back
    expect(r.retryInMs()).toBe(2000);
    vi.advanceTimersByTime(1999);
    expect(fired).toBe(1);
    vi.advanceTimersByTime(1);
    expect(fired).toBe(2);
    expect(r.retryInMs()).toBeNull();
  });

  it("the connection's redials to an unreachable fleet keep their monotonic schedule across jumps", async () => {
    const port = await new Promise<number>(resolve => {
      const srv = createServer().listen(0, "127.0.0.1", () => {
        const a = srv.address();
        srv.close(() => resolve(typeof a === "object" && a ? a.port : 0));
      });
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const statuses: ConnStatus[] = [];
    const conn = new FleetConnection({
      url: `ws://127.0.0.1:${port}/agent`, node: "pc", instanceId: "i-1", streamId: "s-1",
      fleetKey: fleetPublicKey(createNodeKey().publicKey) ?? (() => { throw new Error("no key"); })(),
      nodeKey: createNodeKey(), caps: [], claudeVersion: () => null, log: captureLog().log,
      onWelcome: () => {}, onRequest: () => {}, onBadRequest: () => {}, onAck: () => {}, onDown: () => {},
      onStatus: s => { statuses.push(s); }, retry: { random: () => 1 },
    });
    const dials = () => statuses.filter(s => s.state === "connecting").length;
    // Real I/O (the refused TCP connect) still happens under fake timers; this waits for it without moving fake time.
    const settle = async (f: () => boolean) => { for (let i = 0; i < 20_000 && !f(); i++) await new Promise(r => setImmediate(r)); return f(); };
    conn.start();
    expect(await settle(() => dials() === 1 && conn.status().state === "backoff")).toBe(true);
    vi.setSystemTime(Date.now() + 3_600_000);
    expect(conn.status().retryInMs).toBe(1000);
    await vi.advanceTimersByTimeAsync(999);
    expect(dials()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settle(() => dials() === 2 && conn.status().state === "backoff")).toBe(true);
    vi.setSystemTime(Date.now() - 7_200_000);
    expect(conn.status().retryInMs).toBe(2000);
    await vi.advanceTimersByTimeAsync(1999);
    expect(dials()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settle(() => dials() === 3)).toBe(true);
    await conn.stop();
  });
});
```

- [ ] **Step 6: Create `apps/node-agent/test/connection.test.ts`**

The failing connection test against the scripted fake fleet. It covers the handshake in both directions, every close code, the same instanceId on reconnect, `drop()` (which the test hook `dropAfterStarted` uses, Task 8), and the ping watchdog. Its instance and stream IDs are UUIDs, as the protocol's `Hello` requires.

```ts
// The connection against a scripted fake fleet (spec §5.2, §9 "real agent against a scripted fake fleet"): mutual
// authentication, welcome, every close code (4409's retry every 5 minutes on fake timers), reconnect with the same
// instanceId, the ping watchdog (35 s by default), and the refusal of a plain ws:// URL to another machine.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "@morndo/protocol";
import { FleetConnection, UNSUPPORTED_RETRY_MS, type ConnectionOptions, type Welcomed } from "../src/conn/connection.ts";
import { formatStatus, type ConnStatus } from "../src/conn/status-file.ts";
import { createNodeKey, fleetPublicKey, type NodeKey } from "../src/identity.ts";
import { startFakeFleet, type FakeFleet } from "./fake-fleet.ts";
import { captureLog, until, wait } from "./helpers.ts";

// UUIDs, as the protocol's Hello requires (the fake fleet closes 1008 on a hello that doesn't fit).
const INSTANCE = randomUUID();
const STREAM = randomUUID();
let fleet: FakeFleet;
let key: NodeKey;
const conns: FleetConnection[] = [];
beforeEach(async () => {
  fleet = await startFakeFleet();
  key = createNodeKey();
  fleet.trust("pc", key.publicKey);
});
afterEach(async () => {
  vi.useRealTimers();
  for (const c of conns.splice(0)) await c.stop();
  await fleet.close();
});
// Real I/O (the sockets) still runs under fake timers; this waits for it without moving fake time (setImmediate is
// not faked by the toFake lists below).
const settle = async (f: () => boolean) => { for (let i = 0; i < 20_000 && !f(); i++) await new Promise(r => setImmediate(r)); return f(); };

function connect(over: Partial<ConnectionOptions> = {}) {
  const welcomes: Welcomed[] = [];
  const statuses: ConnStatus[] = [];
  const logged = captureLog();
  const fleetKey = fleetPublicKey(fleet.fleetKey);
  if (!fleetKey) throw new Error("the fake fleet's key does not parse");
  const conn = new FleetConnection({
    url: fleet.url, node: "pc", instanceId: INSTANCE, streamId: STREAM, fleetKey, nodeKey: key,
    caps: ["inventory.get"], claudeVersion: () => "2.1.286", log: logged.log,
    onWelcome: w => { welcomes.push(w); }, onRequest: () => {}, onBadRequest: () => {}, onAck: () => {}, onDown: () => {},
    onStatus: s => { statuses.push(s); }, retry: { baseMs: 20, capMs: 100 }, ...over,
  });
  conns.push(conn);
  conn.start();
  return { conn, welcomes, statuses, lines: logged.lines };
}
const hellos = () => fleet.received.filter(r => r.msg.t === "hello").map(r => r.msg);

describe("handshake", () => {
  it("authenticates both ways and goes online with the fleet's welcome", async () => {
    fleet.script.welcome = { connEpoch: 7, ackSeq: 3, streamKnown: true };
    const c = connect();
    expect(await until(() => c.conn.status().state === "online")).toBe(true);
    expect(c.welcomes).toEqual([{ connEpoch: 7, ackSeq: 3, streamKnown: true }]);
    expect(c.conn.status().connEpoch).toBe(7);
    expect(hellos()[0]).toMatchObject({
      v: 1, t: "hello", node: "pc", instanceId: INSTANCE, streamId: STREAM, proto: [1],
      agent: { version: "0.0.0" }, claude: { version: "2.1.286" }, caps: ["inventory.get"],
    });
    expect(String(hellos()[0]?.clientNonce)).toMatch(/^[A-Za-z0-9_-]{43}$/);   // 32 random bytes
    expect(fleet.received.some(r => r.msg.t === "proof")).toBe(true);          // the fake verified it, or it closes 4401
  });

  it("never proves anything to a fleet whose signature doesn't match the pinned key, and keeps dialing", async () => {
    fleet.script.tamperSig = true;
    const c = connect();
    expect(await until(() => fleet.connections() >= 3)).toBe(true);
    expect(fleet.received.some(r => r.msg.t === "proof")).toBe(false);
    expect(c.statuses.some(s => s.state === "online")).toBe(false);
    expect(c.lines.join("\n")).toMatch(/signature does not match/);
    fleet.script.tamperSig = false;                                           // negative control: the same fleet, signing right
    expect(await until(() => c.conn.status().state === "online")).toBe(true);
  });
});

describe("close codes", () => {
  for (const code of [4401, 4403]) {
    it(`${code}: stops dialing`, async () => {
      fleet.script.welcome = code;
      const c = connect();
      expect(await until(() => c.conn.status().state === "refused")).toBe(true);
      await wait(400);                                                        // 20 backoff periods
      expect(fleet.connections()).toBe(1);
      expect(c.conn.status().lastClose?.code).toBe(code);
    });
  }

  it("4409: says conflict in status, and doesn't dial again within the backoff", async () => {
    fleet.script.welcome = 4409;
    const c = connect();
    expect(await until(() => c.conn.status().state === "conflict")).toBe(true);
    await wait(400);                                                        // 20 backoff periods
    expect(fleet.connections()).toBe(1);
    const s = c.conn.status();
    expect(s.retryInMs).toBeGreaterThan(200_000);                           // 5 minutes ± 20 % away
    const text = formatStatus({ node: "pc", fleetUrl: fleet.url }, { ...s, node: "pc", instanceId: INSTANCE, pid: process.pid, spoolDepth: 0, drops: 0 });
    expect(text).toMatch(/conflict: another agent with this node's key is connected \(4409\)\. This one tries again every 5 minutes/);
    expect(text).toMatch(/retry in\s+\d+ s/);
  });

  it("4409: tries again every 5 minutes ± 20 % (LIMITS.conflictRetryMs) and stays in conflict meanwhile (fake timers)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    fleet.script.welcome = 4409;
    const draws = [0, 1];                                                   // the shortest wait, then the longest
    const c = connect({ retry: { baseMs: 20, capMs: 100, random: () => draws.shift() ?? 0.5 } });
    expect(await settle(() => c.conn.status().state === "conflict")).toBe(true);
    expect(c.conn.status().retryInMs).toBe(0.8 * LIMITS.conflictRetryMs);
    await vi.advanceTimersByTimeAsync(0.8 * LIMITS.conflictRetryMs - 1);
    expect(fleet.connections()).toBe(1);
    expect(c.conn.status().state).toBe("conflict");
    await vi.advanceTimersByTimeAsync(1);
    expect(await settle(() => fleet.connections() === 2 && fleet.closes.length === 2)).toBe(true);
    expect(await settle(() => c.conn.status().state === "conflict" && c.conn.status().retryInMs === 1.2 * LIMITS.conflictRetryMs)).toBe(true);
    expect(c.statuses.map(s => s.state)).toEqual(["connecting", "conflict", "conflict"]);   // never refused or in backoff, and conflict while it asks again
    expect(hellos().map(h => h.instanceId)).toEqual([INSTANCE, INSTANCE]);
  });

  it("4426: waits the long retry, not the backoff", async () => {
    expect(UNSUPPORTED_RETRY_MS).toBe(3_600_000);                            // hourly, in production
    fleet.script.welcome = 4426;
    const c = connect({ unsupportedRetryMs: 500 });
    expect(await until(() => c.conn.status().state === "unsupported")).toBe(true);
    await wait(250);
    expect(fleet.connections()).toBe(1);
    expect(await until(() => fleet.connections() === 2, 2000)).toBe(true);
  });

  it("an ordinary close dials again with backoff, as the same instance", async () => {
    const c = connect();
    expect(await until(() => c.conn.status().state === "online")).toBe(true);
    fleet.closeAgent(1011, "restart");
    expect(await until(() => c.welcomes.length === 2)).toBe(true);
    expect(hellos().map(h => h.instanceId)).toEqual([INSTANCE, INSTANCE]);
    expect(hellos()[0]?.clientNonce).not.toBe(hellos()[1]?.clientNonce);       // a fresh nonce per connection
  });

  it("drop() cuts the live socket: the fleet sees it close without a close frame, and the agent dials again", async () => {
    const c = connect();
    expect(await until(() => c.conn.status().state === "online")).toBe(true);
    c.conn.drop();
    expect(await until(() => fleet.closes.some(x => x.conn === 1))).toBe(true);
    expect(fleet.closes.find(x => x.conn === 1)?.code).toBe(1006);           // cut, not closed
    expect(await until(() => c.welcomes.length === 2)).toBe(true);
    expect(hellos().map(h => h.instanceId)).toEqual([INSTANCE, INSTANCE]);
  });
});

describe("ping watchdog", () => {
  it("waits LIMITS.agentPingTimeoutMs by default: 35 s, two of the fleet's 15 s pings and slack (fake timers)", async () => {
    expect(LIMITS.agentPingTimeoutMs).toBe(35_000);
    expect(LIMITS.agentPingTimeoutMs).toBeGreaterThan(2 * LIMITS.pingMs);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const c = connect();                                                    // no pingTimeoutMs: the default
    expect(await settle(() => c.conn.status().state === "online")).toBe(true);
    await vi.advanceTimersByTimeAsync(LIMITS.agentPingTimeoutMs - 1);       // armed when the socket opened
    expect(fleet.closes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settle(() => fleet.closes.some(x => x.conn === 1))).toBe(true);
    expect(c.lines.join("\n")).toMatch(/no ping from the fleet for 35 s/);
  });
  it("terminates a fleet that sends no pings, and dials again", async () => {
    const c = connect({ pingTimeoutMs: 300 });                               // the fake fleet pings only when told to
    expect(await until(() => c.conn.status().state === "online")).toBe(true);
    expect(await until(() => fleet.connections() >= 2, 3000)).toBe(true);
    expect(c.lines.join("\n")).toMatch(/no ping from the fleet/);
  });
  it("keeps a fleet that pings (negative control)", async () => {
    fleet.script.pingMs = 100;
    const c = connect({ pingTimeoutMs: 300 });
    expect(await until(() => c.conn.status().state === "online")).toBe(true);
    await wait(1000);
    expect(fleet.connections()).toBe(1);
    expect(c.conn.status().state).toBe("online");
  });
});

describe("the fleet's URL (plan Contracts, fleetUrlOk)", () => {
  it("refuses a plain ws:// URL to another machine and never dials it", async () => {
    // 0.0.0.0 reaches this machine's fake fleet if dialed, but its host is not a loopback name.
    const plain = fleet.url.replace("127.0.0.1", "0.0.0.0");
    expect(() => connect({ url: plain })).toThrow(/wss:\/\/, or ws:\/\/ to this machine/);
    await wait(300);
    expect(fleet.connections()).toBe(0);
  });
});

describe("sending", () => {
  it("refuses before welcome and over 512 KiB", async () => {
    fleet.script.hello = 1011;
    const c = connect();
    expect(c.conn.send({ v: 1, t: "proof", sig: "x" })).toBe(false);
    fleet.script.hello = "challenge";
    expect(await until(() => c.conn.status().state === "online")).toBe(true);
    const big = { v: 1, t: "ev.health", health: { pad: "x".repeat(600 * 1024) } } as const;
    expect(c.conn.send(big as never)).toBe(false);
    expect(c.lines.join("\n")).toMatch(/not sending a ev\.health message/);
  });
});
```

- [ ] **Step 7: Run it and watch it fail**

Run: `npx vitest run apps/node-agent/test/retry.test.ts apps/node-agent/test/connection.test.ts`

Expected: FAIL, `Error: Cannot find module '../src/conn/connection.ts'`.

- [ ] **Step 8: Create `apps/node-agent/src/conn/retry.ts`**

```ts
// When to dial the fleet again (spec §5.2): exponential backoff from 1 s up to 60 s with full jitter, a random delay
// between zero and the exponential bound: sleep = random(0, min(cap, base * 2 ** attempt)) (M. Brooker, "Exponential
// Backoff And Jitter", AWS Architecture Blog, 2015-03-04,
// https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/, read 2026-10-06).
// The wait runs on setTimeout, which Node schedules on its monotonic clock, and is reported from performance.now(): a
// wall-clock step (NTP, a laptop resuming) neither fires a retry early nor holds it back (plan Review Focus 4).
export type RetryOptions = { baseMs?: number; capMs?: number; random?: () => number; now?: () => number };

export class RetrySchedule {
  #base: number;
  #cap: number;
  #random: () => number;
  #now: () => number;
  #attempt = 0;
  #timer: NodeJS.Timeout | null = null;
  #dueAt: number | null = null;

  constructor(o: RetryOptions = {}) {
    this.#base = o.baseMs ?? 1000;
    this.#cap = o.capMs ?? 60_000;
    this.#random = o.random ?? Math.random;
    this.#now = o.now ?? (() => performance.now());
  }

  // The next backoff delay; each call counts as one more failed attempt.
  nextDelay(): number {
    const bound = Math.min(this.#cap, this.#base * 2 ** this.#attempt);
    this.#attempt = Math.min(this.#attempt + 1, 30);
    return Math.floor(this.#random() * bound);
  }

  // Runs `fn` after the next backoff delay; returns the delay.
  backoff(fn: () => void): number {
    const delay = this.nextDelay();
    this.after(delay, fn);
    return delay;
  }

  // Runs `fn` after `ms` ± `spread` (a fraction: 0.2 is ±20 %), from the same random source as the backoff, so many
  // refused agents don't ask again in step (a refused second instance's 5-minute retry). Returns the delay.
  afterAbout(ms: number, spread: number, fn: () => void): number {
    const delay = Math.round(ms * (1 - spread + 2 * spread * this.#random()));
    this.after(delay, fn);
    return delay;
  }

  // Runs `fn` after exactly `ms` (the hourly retry of an unsupported protocol), replacing any pending retry.
  after(ms: number, fn: () => void): void {
    this.cancel();
    this.#dueAt = this.#now() + ms;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#dueAt = null;
      fn();
    }, ms);
  }

  cancel(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#dueAt = null;
  }

  // After a welcome: the next failure starts from the base delay again.
  reset(): void { this.#attempt = 0; }

  retryInMs(): number | null {
    return this.#dueAt === null ? null : Math.max(0, this.#dueAt - this.#now());
  }
}
```

- [ ] **Step 9: Create `apps/node-agent/src/conn/status-file.ts`**

```ts
// What the running agent reports about itself, for `morndo-node status` (spec §5.2: a refused second instance shows the
// conflict in status, and tries again every 5 minutes). The agent rewrites ~/.local/state/morndo-node/status.json atomically
// on every connection change and with every health tick; `status` reads it and checks that the writer still lives.
import { readFileSync } from "node:fs";
import { writeFileAtomic } from "../atomic-write.ts";

export type ConnState = "stopped" | "connecting" | "online" | "backoff" | "refused" | "conflict" | "unsupported";
export type ConnStatus = {
  state: ConnState;
  since: number;                                         // wall clock, for people
  connEpoch: number | null;
  lastClose: { code: number; reason: string } | null;
  retryInMs: number | null;
};
export type AgentStatus = ConnStatus & { node: string; instanceId: string; pid: number; spoolDepth: number; drops: number };

export function writeStatus(path: string, s: AgentStatus): void {
  writeFileAtomic(path, `${JSON.stringify(s)}\n`, 0o600);
}

export function readStatus(path: string): AgentStatus | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as AgentStatus; }
  catch { return null; }
}

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

const STATE_TEXT: Record<ConnState, string> = {
  stopped: "stopped",
  connecting: "connecting to the fleet",
  online: "online",
  backoff: "disconnected; dialing again with backoff",
  refused: "refused by the fleet (revoked, unknown, or a key the fleet doesn't accept). It no longer dials: join again with a new code",
  conflict: "conflict: another agent with this node's key is connected (4409). This one tries again every 5 minutes, and takes over once the other is gone: stop the other agent (a cloned machine?)",
  unsupported: "the fleet does not speak this agent's protocol (4426); retrying hourly: update morndo-node or the fleet",
};

export function formatStatus(config: { node: string; fleetUrl: string }, s: AgentStatus | null, isAlive: (pid: number) => boolean = alive): string {
  const lines = [`node      ${config.node}`, `fleet     ${config.fleetUrl}`];
  if (!s || !isAlive(s.pid)) {
    lines.push("agent     not running (start it with: morndo-node run)");
    return lines.join("\n");
  }
  const since = new Date(s.since).toLocaleString();
  lines.push(`state     ${STATE_TEXT[s.state]} (since ${since})`);
  if (s.connEpoch !== null && s.state === "online") lines.push(`epoch     ${s.connEpoch}`);
  if (s.lastClose) lines.push(`closed    ${s.lastClose.code}${s.lastClose.reason ? ` ${s.lastClose.reason}` : ""}`);
  if (s.retryInMs !== null) lines.push(`retry in  ${Math.ceil(s.retryInMs / 1000)} s`);
  lines.push(`instance  ${s.instanceId} (pid ${s.pid})`);
  lines.push(`spool     ${s.spoolDepth} events waiting, ${s.drops} dropped`);
  return lines.join("\n");
}
```

- [ ] **Step 10: Create `apps/node-agent/src/conn/connection.ts`**

```ts
// The agent's one connection to the fleet service (spec §5.2), kept up for the life of the process.
// - Mutual authentication on every connection: `hello` with a fresh client nonce; the fleet's `challenge` must carry
//   its signature over that nonce under the key pinned at join, or the agent closes without proving anything; then
//   the agent's `proof`; then `welcome`.
// - `instanceId` is random per process and the same on every reconnect, so the fleet can tell a reconnect (replaces
//   the old connection) from a second agent with the same key (refused with 4409 while the live one answers the
//   fleet's ping).
// - Close codes: 4401 (bad proof) and 4403 (revoked or unknown) stop the dialing, since a retry would be refused the
//   same way. 4409 keeps `status: conflict` and tries again every LIMITS.conflictRetryMs (5 minutes, ±20 % jitter): a
//   live twin keeps refusing it, and once the other instance is gone (stopped, crashed, half-open) this one takes over.
//   4426 (protocol unsupported) retries hourly; lanes and hooks keep working meanwhile. Anything else (1013, too many
//   handshakes, included) dials again with backoff (retry.ts).
// - Liveness: the fleet pings every 15 s; with no ping for 35 s (LIMITS.agentPingTimeoutMs: two pings and slack) the
//   agent terminates the socket and dials again (ws 8.22.0 README, "How to detect and close broken connections?", read
//   2026-10-06).
// - The URL must pass fleetUrlOk: wss://, or ws:// only to this machine. Any other is refused when the connection is
//   made, before any dial: the agent never authenticates over a network in the clear.
// - A message that is not JSON, not of protocol version 1, or of a type the agent doesn't know closes the connection
//   (1008): nothing from the fleet is silently ignored. A malformed `req` with an id is answered instead (onBadRequest).
import { randomBytes, type KeyObject } from "node:crypto";
import { WebSocket } from "ws";
import { CLOSE, FleetMessage, LIMITS, fleetSigPayload, fleetUrlOk, nodeSigPayload, parseBody, type AgentMessage } from "@morndo/protocol";
import { signedBy } from "../identity.ts";
import type { Logger } from "../log.ts";
import { AGENT_VERSION, PROTO_VERSIONS } from "../version.ts";
import { wsText } from "../ws-text.ts";
import { RetrySchedule, type RetryOptions } from "./retry.ts";
import { SendQueue, type Lane } from "./send-queue.ts";
import type { ConnState, ConnStatus } from "./status-file.ts";

export type ReqMessage = Extract<FleetMessage, { t: "req" }>;
export type AckMessage = Extract<FleetMessage, { t: "ack" }>;
export type Welcomed = { connEpoch: number; ackSeq: number; streamKnown: boolean };

export const UNSUPPORTED_RETRY_MS = 3_600_000;
export const CONFLICT_SPREAD = 0.2;                       // a refused second instance retries 5 minutes ± 20 %

export type ConnectionOptions = {
  url: string;
  node: string;
  instanceId: string;
  streamId: string;
  fleetKey: KeyObject;
  nodeKey: { sign(payload: string): string };
  caps: string[];
  claudeVersion: () => string | null;
  log: Logger;
  onWelcome(w: Welcomed): void;
  onRequest(m: ReqMessage): void;
  onBadRequest(id: string, op: unknown): void;
  onAck(m: AckMessage): void;
  onDown(): void;
  onStatus(s: ConnStatus): void;
  retry?: RetryOptions;
  pingTimeoutMs?: number;
  unsupportedRetryMs?: number;
};

export class FleetConnection {
  #o: ConnectionOptions;
  #retry: RetrySchedule;
  #ws: WebSocket | null = null;
  #queue: SendQueue | null = null;
  #watchdog: NodeJS.Timeout | null = null;
  #stopping = false;
  #status: ConnStatus = { state: "stopped", since: Date.now(), connEpoch: null, lastClose: null, retryInMs: null };

  constructor(o: ConnectionOptions) {
    if (!fleetUrlOk(o.url)) throw new TypeError(`the fleet URL must be wss://, or ws:// to this machine (127.0.0.1, localhost or [::1]); not dialing ${o.url}`);
    this.#o = o;
    this.#retry = new RetrySchedule(o.retry);
  }

  status(): ConnStatus { return { ...this.#status, retryInMs: this.#retry.retryInMs() }; }
  get online(): boolean { return this.#queue !== null; }

  start(): void {
    this.#stopping = false;
    this.#dial();
  }

  // Queues a message on the live connection: false when there is none, or when the message is over the 512 KiB limit.
  send(msg: AgentMessage, lane: Lane = "control"): boolean {
    if (!this.#queue) return false;
    const data = JSON.stringify(msg);
    const bytes = Buffer.byteLength(data);
    if (bytes > LIMITS.maxMessageBytes) {
      this.#o.log.warn(`not sending a ${msg.t} message of ${bytes} bytes (the limit is ${LIMITS.maxMessageBytes})`);
      return false;
    }
    this.#queue.push(data, lane);
    return true;
  }

  // Cuts the live socket without a close handshake (the test hook dropAfterStarted, test-hooks.ts). The close that
  // follows is an ordinary one: the agent backs off and dials again as the same instance.
  drop(): void { this.#ws?.terminate(); }

  // The stream the next hello names (agent.ts rotates it for a restored database, then drops the connection).
  setStreamId(id: string): void { this.#o = { ...this.#o, streamId: id }; }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#retry.cancel();
    const ws = this.#ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) { this.#set("stopped"); return; }
    const closed = new Promise<void>(resolve => ws.once("close", () => resolve()));
    ws.close(1001, "agent stopping");
    const force = setTimeout(() => ws.terminate(), 2000);
    await closed;
    clearTimeout(force);
  }

  // `since` is when the state began: a retry that ends in the same state (conflict, say) keeps it.
  #set(state: ConnState, extra: Partial<ConnStatus> = {}): void {
    this.#status = { ...this.#status, ...extra, state, since: state === this.#status.state ? this.#status.since : Date.now() };
    this.#o.onStatus(this.status());
  }

  #arm(ws: WebSocket): void {
    if (this.#watchdog) clearTimeout(this.#watchdog);
    this.#watchdog = setTimeout(() => {
      this.#o.log.warn(`no ping from the fleet for ${Math.round((this.#o.pingTimeoutMs ?? LIMITS.agentPingTimeoutMs) / 1000)} s; dialing again`);
      ws.terminate();
    }, this.#o.pingTimeoutMs ?? LIMITS.agentPingTimeoutMs);
  }

  #disarm(): void {
    if (this.#watchdog) clearTimeout(this.#watchdog);
    this.#watchdog = null;
  }

  #dial(): void {
    const o = this.#o;
    // A refused second instance stays "conflict" while it asks again: status keeps saying what is wrong.
    if (this.#status.state !== "conflict") this.#set("connecting", { connEpoch: null });
    const ws = new WebSocket(o.url, { maxPayload: LIMITS.maxPayload, handshakeTimeout: 10_000 });
    this.#ws = ws;
    const clientNonce = randomBytes(32).toString("base64url");
    let phase: "hello" | "proof" | "online" = "hello";
    const protocolError = (what: string) => {
      o.log.warn(`the fleet sent ${what}; closing the connection`);
      ws.close(1008, "protocol error");
    };
    const raw = (msg: AgentMessage) => ws.send(JSON.stringify(msg));

    ws.on("open", () => {
      this.#arm(ws);
      raw({
        v: 1, t: "hello", node: o.node, instanceId: o.instanceId, streamId: o.streamId, proto: PROTO_VERSIONS,
        agent: { version: AGENT_VERSION }, claude: { version: o.claudeVersion() }, caps: o.caps, clientNonce,
      });
    });
    ws.on("ping", () => this.#arm(ws));
    ws.on("message", data => {
      let value: unknown;
      try { value = JSON.parse(wsText(data)); } catch { protocolError("a message that is not JSON"); return; }
      const msg = parseBody(FleetMessage, value);
      if (!msg) {
        const r = (value ?? {}) as { t?: unknown; id?: unknown; op?: unknown };
        if (phase === "online" && r.t === "req" && typeof r.id === "string") { o.onBadRequest(r.id, r.op); return; }
        protocolError(`a malformed or unknown message (${typeof r.t === "string" ? r.t.slice(0, 40) : "no type"})`);
        return;
      }
      switch (msg.t) {
        case "challenge": {
          if (phase !== "hello") { protocolError("a challenge out of turn"); return; }
          if (!signedBy(o.fleetKey, fleetSigPayload(o.node, clientNonce), msg.fleetSig)) {
            o.log.error("the fleet's signature does not match the fleet key pinned at join; closing without a proof");
            ws.close(1008, "bad fleet signature");
            return;
          }
          phase = "proof";
          raw({ v: 1, t: "proof", sig: o.nodeKey.sign(nodeSigPayload(o.node, msg.nonce)) });
          return;
        }
        case "welcome": {
          if (phase !== "proof") { protocolError("a welcome out of turn"); return; }
          phase = "online";
          this.#queue = new SendQueue({ send: (d, cb) => ws.send(d, cb) });
          this.#retry.reset();
          this.#set("online", { connEpoch: msg.connEpoch, lastClose: null });
          o.onWelcome({ connEpoch: msg.connEpoch, ackSeq: msg.ackSeq, streamKnown: msg.streamKnown });
          return;
        }
        case "req":
          if (phase !== "online") { protocolError("a request before welcome"); return; }
          o.onRequest(msg);
          return;
        case "ack":
          if (phase !== "online") { protocolError("an ack before welcome"); return; }
          o.onAck(msg);
          return;
      }
    });
    ws.on("error", e => o.log.debug(`connection error: ${(e as NodeJS.ErrnoException).code ?? e.message}`));
    ws.on("close", (code, reason) => this.#closed(ws, code, reason.toString("utf8").slice(0, 120)));
  }

  #closed(ws: WebSocket, code: number, reason: string): void {
    if (ws !== this.#ws) return;
    this.#disarm();
    this.#ws = null;
    const wasOnline = this.#queue !== null;
    this.#queue?.close();
    this.#queue = null;
    if (wasOnline) this.#o.onDown();
    const lastClose = { code, reason };
    const log = this.#o.log;
    if (this.#stopping) { this.#set("stopped", { lastClose, connEpoch: null }); return; }
    if (code === CLOSE.badProof || code === CLOSE.forbidden) {
      log.error(`the fleet refused this node (${code}${reason ? ` ${reason}` : ""}): it was revoked, is unknown, or its key is not the one the fleet holds. Not dialing again; join again with a new code.`);
      this.#set("refused", { lastClose, connEpoch: null });
      return;
    }
    if (code === CLOSE.conflict) {
      const wait = this.#retry.afterAbout(LIMITS.conflictRetryMs, CONFLICT_SPREAD, () => this.#dial());
      if (this.#status.state !== "conflict") {
        log.error(`the fleet refused this agent (4409): another agent with this node's key is connected. Lanes keep running; trying again every ${Math.round(LIMITS.conflictRetryMs / 60_000)} min (next in ${Math.round(wait / 1000)} s); see morndo-node status.`);
      }
      this.#set("conflict", { lastClose, connEpoch: null });
      return;
    }
    if (code === CLOSE.unsupported) {
      log.error(`the fleet does not speak this agent's protocol (4426); lanes keep running, trying again in ${Math.round((this.#o.unsupportedRetryMs ?? UNSUPPORTED_RETRY_MS) / 60_000)} min.`);
      this.#retry.after(this.#o.unsupportedRetryMs ?? UNSUPPORTED_RETRY_MS, () => this.#dial());
      this.#set("unsupported", { lastClose, connEpoch: null });
      return;
    }
    const delay = this.#retry.backoff(() => this.#dial());
    log.info(`connection to the fleet closed (${code}); dialing again in ${delay} ms`);
    this.#set("backoff", { lastClose, connEpoch: null });
  }
}
```

- [ ] **Step 11: Run it and watch it pass**

Run: `npx vitest run apps/node-agent/test/retry.test.ts apps/node-agent/test/connection.test.ts`

Expected: PASS, `Tests  19 passed (19)` (5 + 14).

- [ ] **Step 12: Replace `apps/node-agent/src/main.ts`: add `status`**

```ts
#!/usr/bin/env node
// morndo-node: this machine's agent in a Morndo fleet (ADR-0012). `join` once, with the string the fleet printed;
// `status` for a person at the machine.
import { homedir } from "node:os";
import { ConfigError, loadConfig, type AgentConfig } from "./config.ts";
import { formatStatus, readStatus } from "./conn/status-file.ts";
import { exitOnCrash } from "./crash.ts";
import { JoinError, join } from "./join.ts";
import { log } from "./log.ts";
import { agentPaths } from "./paths.ts";

const HELP = `morndo-node: this machine's agent in a Morndo fleet.

  morndo-node join '<join string>'   join the fleet once, with the string \`morndo-fleet node add <name>\` printed
  morndo-node status                 what the running agent reports

Files: ~/.config/morndo-node/ (config.json, policy.json, node-key.pem) and ~/.local/state/morndo-node/.
MORNDO_NODE_LOG_LEVEL sets the log level (default info).`;

const EXIT_CONFIG = 78;                     // EX_CONFIG (sysexits.h): the setup needs fixing, a restart won't help
exitOnCrash(log);
const home = process.env.HOME || homedir();
const [cmd = "help", ...args] = process.argv.slice(2);
// The commands' own output, for the person at the machine: not a log.
const print = (text: string) => process.stdout.write(`${text}\n`);

function configOrExit(): AgentConfig {
  try { return loadConfig(home); }
  catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    process.stderr.write(`${e.message}\n`);
    process.exit(EXIT_CONFIG);
  }
}

switch (cmd) {
  case "join": {
    if (args.length !== 1) { process.stderr.write("usage: morndo-node join '<join string>'\n"); process.exit(2); }
    try {
      const joined = await join({ home, joinString: args[0] ?? "" });
      print(`Joined the fleet at ${joined.fleetUrl} as ${joined.node}. Start the agent with: morndo-node run`);
    } catch (e) {
      if (!(e instanceof JoinError)) throw e;
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    break;
  }
  case "status": {
    const config = configOrExit();
    print(formatStatus(config, readStatus(agentPaths(home).statusFile)));
    break;
  }
  default:
    print(HELP);
}
```

- [ ] **Step 13: Check the whole task**

Run each command on its own:
- `npx vitest run apps/node-agent/test`. Expected: `Test Files  6 passed (6)` and `Tests  45 passed (45)`.
- `npx tsc -p apps/node-agent`. Expected: no output, exit 0.
- `npx tsc -p tsconfig.tests.json`. Expected: no output, exit 0.
- `npx oxlint --format=stylish apps/node-agent`. Expected: no output.
- `test -x apps/node-agent/src/main.ts && echo executable`. Expected: `executable` (writing the new content kept the mode Step 25 set).
- `HOME=$(mktemp -d) node apps/node-agent/src/main.ts status; echo "exit $?"`. Expected: `This machine has not joined a fleet (…/config.json). Run: morndo-node join '<join string>'`, then `exit 78`.

- [ ] **Step 14: Commit**

```bash
git add apps/node-agent
git commit -m "feat(node-agent): authenticated fleet connection with backoff, ping watchdog and close codes"
```


### Task 8: Operations

**Files:**
- Create (executor core): `apps/node-agent/src/test-hooks.ts`, `apps/node-agent/src/ops/args.ts`, `apps/node-agent/src/ops/deadline.ts`, `apps/node-agent/src/ops/serial-queue.ts`, `apps/node-agent/src/ops/done-keys.ts`, `apps/node-agent/src/ops/executor.ts`
- Create (ops): `apps/node-agent/src/ops/tmux-panes.ts`, `apps/node-agent/src/ops/inventory.ts`, `apps/node-agent/src/ops/capture-cap.ts`, `apps/node-agent/src/ops/pane-ops.ts`, `apps/node-agent/src/ops/transcript-ops.ts`, `apps/node-agent/src/ops/node-files.ts`, `apps/node-agent/src/ops/upload-inbox.ts`, `apps/node-agent/src/ops/file-ops.ts`, `apps/node-agent/src/ops/lane-ops.ts`, `apps/node-agent/src/ops/worktree-ops.ts`, `apps/node-agent/src/ops/table.ts`, `apps/node-agent/src/ops/runtime.ts`
- Modify: `.oxlintrc.json` (adds the agent's terminal fixture to the tmux fixtures under `no-control-regex: off`)
- Test: `apps/node-agent/test/test-hooks.test.ts`, `apps/node-agent/test/done-keys.test.ts`, `apps/node-agent/test/executor.test.ts`, `apps/node-agent/test/inventory.test.ts`, `apps/node-agent/test/pane-ops.test.ts`, `apps/node-agent/test/transcript-file-ops.test.ts`, `apps/node-agent/test/lane-worktree-ops.test.ts`, `apps/node-agent/test/fake-claude.fixture.ts`, `apps/node-agent/test/ops-harness.ts`

**Interfaces:**
- **Consumes:**
  - from Task 1: `LIMITS`, `OP_ARGS`, `parseWorkerId`, `formatWorkerId`, `ERROR_EXECUTED`, `KEYED_OPS`, `parseBody`, and the types `Expect`, `OpName`, `OpArgs`, `OpResult`, `OpError`, `ErrorCode`, `Pane`, `WorkerRef`;
  - from Tasks 2–3 (`@morndo/node-ops`): `tmuxAdapter`, `terminalAdapter`, `sessionRegistry`, `paneLock`, `denyRoots`, `deniedBy`, `openConfined`, `localTranscriptBytes`, `stampServer`, `tmuxArgv`, `exactSession`, `tmuxLiteral`, and the types `Tmux`, `Terminal`, `PaneLock`, `SessionInfo`. Every tmux call of the agent builds its argv with `tmuxArgv` (so `-u`), names its session with `exactSession`, passes every format-expanded argument that carries outside data (`-n` name, `-c` directory) through `tmuxLiteral`, and targets panes and windows by ID (`%N`, `@N`), never by name (plan Contracts, node-ops; Global Constraints, the tmux rules);
  - from Task 6: `AgentConfig`, `Policy`, `isOpName`, `agentPaths`, `openAgentDb`, and the type `Logger`.
- **Produces:**

```ts
// test-hooks.ts (plan Contracts, "Agent test hooks")
export type TestHooks = { dropAfterStarted?: string; noDoneKeys?: true; noExpect?: true; clockOffsetMs?: number; spoolFail?: true; fixedStreamId?: string };
export class TestHooksRefused extends Error; export const TEST_HOOKS_VAR = "MORNDO_NODE_TEST_HOOKS";
export function loadTestHooks(env: NodeJS.ProcessEnv, where: { home: string; accountHome: string }): TestHooks;
export function wallClock(hooks: TestHooks): () => number; export function dropOnce(match: string, drop: () => void): (key: string) => boolean;
// executor.ts
export type Failure = { ok: false; error: OpError }; export type Outcome<O extends OpName> = { ok: true; result: OpResult[O] } | Failure;
export type EffectContext = { ready(): OpError | null; remainingMs(): number };
export type ReadOp<O extends OpName> = { kind: "read"; run(args: OpArgs[O]): Promise<Outcome<O>> };
export type EffectOp<O extends OpName> = { kind: "effect"; queue(args: OpArgs[O]): string; run(args: OpArgs[O], ctx: EffectContext): Promise<Outcome<O>> };
export type OpTable = { [O in OpName]?: ReadOp<O> | EffectOp<O> };
export type Request = { id: string; op: string; args: unknown; timeoutMs: number; key?: string };
export type Reply = { id: string; invVersion: number; discarded?: true } & ({ ok: true; result: unknown } | { ok: false; error: OpError });
export const fail: (code: ErrorCode, message: string) => Failure; export const ok: <O extends OpName>(result: OpResult[O]) => Outcome<O>;
export const read: <O extends OpName>(run: (args: OpArgs[O]) => Promise<Outcome<O>>) => ReadOp<O>;
export const effect: <O extends OpName>(queue: (args: OpArgs[O]) => string, run: (args: OpArgs[O], ctx: EffectContext) => Promise<Outcome<O>>) => EffectOp<O>;
export class OpExecutor { constructor(d: { ops: OpTable; allowed: ReadonlySet<OpName>; doneKeys: DoneKeys; invVersion: () => number; log: Logger; now?: () => number;
  afterStarted?: (key: string) => boolean /* after a committed `started`; true: the reply says discarded */ });
  handle(req: Request): Promise<Reply> }
// done-keys.ts
export class DoneKeys { constructor(db: Database.Database, now?: () => number, o?: { disabled?: boolean } /* noDoneKeys */); lookup(key: string, hash: string): Prior; start(key: string, hash: string): boolean;
  finish(key: string, outcome: unknown): void; release(key: string): void; status(key: string): KeyStatus; prune(): number }
export function stableJson(v: unknown): string; export const EFFECT_FIELDS: { readonly [O in OpName]?: readonly string[] };
export const argsHash: (op: string, args: unknown) => string;   // over EFFECT_FIELDS[op] only: never expect or timeouts
// tmux-panes.ts, inventory.ts
export function tmuxRun(socket: string | null, args: string[], timeout?: number): Promise<string>;
export function listPanes(socket: string | null, session: string): Promise<PaneRow[]>;
export function paneFacts(socket: string | null, pane: string): Promise<PaneFacts | null>;
export type Snapshot = { invVersion: number; stamp: string | null; panes: Pane[]; lanes: Lane[]; rows: PaneRow[] };
export class Inventory { constructor(d: InventoryDeps); readonly invVersion: number; last(): Snapshot; refresh(): Promise<Snapshot>; windowOfPane(pane: string): string | null }
// pane-ops.ts: the guard is injectable for spec §9's negative control
export type GuardInput = { node: string; session: string; ref: WorkerRef; expect: Expect; facts: PaneFacts | null; sessionId: string | null };
export function expectationHolds(g: GuardInput): boolean;
// node-files.ts, upload-inbox.ts
export type Opened = Awaited<ReturnType<typeof openConfined>>;
export function nodeOpener(o: { home: string; stateDir: string; configDir: string; fileRoots?: string[] }): (path: string) => Promise<Opened>;
export function relayRef(db: Database.Database): (ref: string) => { file: string; size: number } | null;
export function openOwn(file: string): Promise<FileHandle | null>;   // a relay copy by its ref: node-ops' openNoFollow, a regular file
// worktree-ops.ts
export function branchNameOk(name: string): Promise<boolean>;   // git check-ref-format --branch: the node's last word on a branch name
export class UploadInbox { constructor(o: { dir: string; now?: () => number; room?: () => number }); put(a: OpArgs["file.put"], ctx: EffectContext): Promise<Outcome<"file.put">>;
  sweep(): number; bytes(): number /* what the inbox holds, partial uploads included */ }
// runtime.ts
export type OpsRuntime = { inventory: Inventory; doneKeys: DoneKeys; inbox: UploadInbox; registry: ReturnType<typeof sessionRegistry>; executor: OpExecutor;
  now: () => number /* the wall clock the node reports, clockOffsetMs included */ };
export type RuntimeOptions = { config: AgentConfig; db: Database.Database; log: Logger; guard?: (g: GuardInput) => boolean; hooks?: TestHooks;
  afterStarted?: (key: string) => boolean;
  lock?: (path: string, waitS: number) => PaneLock /* a test's slow lock; node-ops' paneLock otherwise */;
  room?: () => number /* bytes still free in the node's disk budget (Task 9); unlimited otherwise */ };
export function createOpsRuntime(o: RuntimeOptions): OpsRuntime;   // noDoneKeys, noExpect and clockOffsetMs act here
```

- [ ] **Step 1: Create `apps/node-agent/test/test-hooks.test.ts`**

The failing test for the agent's test hooks (plan Contracts, "Agent test hooks"): the loader's guard (`NODE_ENV=test` and a `HOME` that is not the account's own), its type checks, and the two helpers the runtime and the agent use.

```ts
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run apps/node-agent/test/test-hooks.test.ts`

Expected: FAIL, `Error: Cannot find module '../src/test-hooks.ts'`.

- [ ] **Step 3: Create `apps/node-agent/src/test-hooks.ts`**

Each hook is wired where it acts. In this task: `noDoneKeys`, `noExpect` and `clockOffsetMs` in the op runtime, and `dropAfterStarted` through the executor's `afterStarted` (with Task 7's `FleetConnection.drop()`). In Task 9: `spoolFail`, `fixedStreamId`, the wall clock of health and hook events, and `morndo-node run`, which loads the hooks first.

```ts
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
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run apps/node-agent/test/test-hooks.test.ts`

Expected: PASS, `Tests  7 passed (7)`.

- [ ] **Step 5: Create `apps/node-agent/test/done-keys.test.ts`**

The failing test for two-phase done keys (spec §5.3, "Idempotency"), and for the keys disabled (the test hook `noDoneKeys`).

```ts
// Two-phase done keys (spec §5.3 "Idempotency") on a real agent database.
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAgentDb, type AgentDb } from "../src/db/open.ts";
import { DoneKeys, EFFECT_FIELDS, argsHash, stableJson } from "../src/ops/done-keys.ts";
import { tempHome } from "./helpers.ts";

const open: { adb: AgentDb; cleanup: () => void }[] = [];
afterEach(() => { for (const o of open.splice(0)) { o.adb.close(); o.cleanup(); } });
function keys(now?: () => number, o: { disabled?: boolean } = {}) {
  const h = tempHome();
  const adb = openAgentDb(join(h.home, "agent.db"));
  open.push({ adb, cleanup: h.cleanup });
  return new DoneKeys(adb.db, now, o);
}

describe("done keys", () => {
  it("hash arguments alike whatever their key order", () => {
    expect(stableJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } })).toBe('{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}');
    expect(argsHash("pane.send", { text: "hi", workerId: "pc.0a1b2c3d.1" })).toBe(argsHash("pane.send", { workerId: "pc.0a1b2c3d.1", text: "hi" }));
    expect(argsHash("pane.send", { text: "hi" })).not.toBe(argsHash("pane.send", { text: "ho" }));
  });
  it("hash only what decides the effect: never the expectation (plan Contracts, \"Behaviour the agent and the fleet agree on\")", () => {
    const W = "pc.0a1b2c3d.1";
    const send = (o: Record<string, unknown>) => argsHash("pane.send", { workerId: W, text: "hi", expect: { server: "0a1b2c3d", window: "api" }, ...o });
    expect(send({ expect: { server: "0a1b2c3d", window: "api", sessionId: "3f0c1d2e-1111-4222-8333-444455556666" } })).toBe(send({}));
    expect(send({ text: "ho" })).not.toBe(send({}));
    expect(send({ workerId: "pc.0a1b2c3d.2" })).not.toBe(send({}));
    expect(argsHash("lane.start", { name: "a", cwd: "/w" })).not.toBe(argsHash("lane.start", { name: "a", cwd: "/w", account: "acct" }));
    expect(argsHash("file.put", { upload: "u", offset: 0, bytes: "AA==", final: false, name: "a" })).toBe(argsHash("file.put", { upload: "u", offset: 0, bytes: "AA==", final: false, name: "b" }));
    expect(argsHash("file.put", { upload: "u", offset: 0 })).not.toBe(argsHash("file.put", { upload: "u", offset: 4 }));
    expect(EFFECT_FIELDS["pane.send"]).toEqual(["workerId", "text"]);
  });
  it("go none → started → done, and a done key keeps its outcome", () => {
    const k = keys();
    const h = argsHash("pane.send", { text: "x" });
    expect(k.lookup("hub:a", h)).toEqual({ state: "none" });
    expect(k.status("hub:a")).toEqual({ state: "unknown" });
    expect(k.start("hub:a", h)).toBe(true);
    expect(k.lookup("hub:a", h)).toEqual({ state: "started" });
    expect(k.status("hub:a")).toEqual({ state: "started" });
    k.finish("hub:a", { problem: null, typedAt: 5 });
    expect(k.lookup("hub:a", h)).toEqual({ state: "done", outcome: { problem: null, typedAt: 5 } });
    expect(k.status("hub:a")).toEqual({ state: "done", outcome: { problem: null, typedAt: 5 } });
  });
  it("release a started key (a refusal before the side effect) but never a done one", () => {
    const k = keys();
    k.start("hub:b", "h");
    k.release("hub:b");
    expect(k.status("hub:b")).toEqual({ state: "unknown" });
    k.start("hub:c", "h");
    k.finish("hub:c", { ok: true });
    k.release("hub:c");
    expect(k.status("hub:c")).toMatchObject({ state: "done" });
  });
  it("tell a key reused with other arguments", () => {
    const k = keys();
    k.start("hub:d", "one");
    expect(k.lookup("hub:d", "two")).toEqual({ state: "mismatch" });
    expect(k.start("hub:d", "one")).toBe(false);                     // already recorded
  });
  it("record and consult nothing when disabled (the noDoneKeys test hook)", () => {
    const k = keys(undefined, { disabled: true });
    expect(k.start("hub:x", "h")).toBe(true);
    expect(k.start("hub:x", "h")).toBe(true);                       // nothing was recorded: it starts again
    expect(k.lookup("hub:x", "h")).toEqual({ state: "none" });
    expect(k.lookup("hub:x", "other")).toEqual({ state: "none" });   // not even a mismatch
    k.finish("hub:x", { ok: true });
    expect(k.status("hub:x")).toEqual({ state: "unknown" });
  });
  it("are pruned after 7 days", () => {
    let now = 1_000_000_000_000;
    const k = keys(() => now);
    k.start("hub:old", "h");
    now += 7 * 24 * 3_600_000 + 1;
    k.start("hub:new", "h");
    expect(k.prune()).toBe(1);
    expect(k.status("hub:old")).toEqual({ state: "unknown" });
    expect(k.status("hub:new")).toEqual({ state: "started" });
  });
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `npx vitest run apps/node-agent/test/done-keys.test.ts`

Expected: FAIL, `Error: Cannot find module '../src/ops/done-keys.ts'`.

- [ ] **Step 7: Create `apps/node-agent/src/ops/done-keys.ts`**

```ts
// Done keys in two phases (spec §5.3, "Idempotency"; ADR-0012 decision 7). `started` is committed before a side effect
// and `done` with its outcome after it, in the agent database (synchronous=FULL, so the commit survives a power cut
// before the side effect). A refusal before any side effect deletes the key, so a retry acts as if the first attempt
// never came. A repeat of a done key gets the stored outcome; of a started key, `uncertain`; of a key whose hash differs
// (other effect-determining arguments), `uncertain` too: that key's op may have run. The hash covers only what decides
// the effect (EFFECT_FIELDS), never `expect`, so a retry with a refreshed expectation is the same request. Keys are kept
// 7 days (LIMITS.doneKeyTtlMs). Disabled (the test hook noDoneKeys), nothing is recorded or consulted: a repeat acts
// again, the negative control for what the keys prevent.
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { LIMITS, type OpName } from "@morndo/protocol";

export type Prior = { state: "none" } | { state: "started" } | { state: "done"; outcome: unknown } | { state: "mismatch" };
export type KeyStatus = { state: "unknown" } | { state: "started" } | { state: "done"; outcome: unknown };

// JSON with object keys sorted at every level, so the same arguments hash alike however a client ordered them.
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

// What decides each keyed op's effect (plan Contracts, "Behaviour the agent and the fleet agree on"). Never `expect`, a
// timeout or the request id.
export const EFFECT_FIELDS: { readonly [O in OpName]?: readonly string[] } = {
  "pane.send": ["workerId", "text"],
  "lane.start": ["name", "cwd", "account", "resume"],
  "lane.stop": ["name"],
  "worktree.add": ["repo", "name", "base"],
  "file.put": ["upload", "offset"],
};

export const argsHash = (op: string, args: unknown): string => {
  const fields = EFFECT_FIELDS[op as OpName];
  const all = (args !== null && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const picked = fields ? Object.fromEntries(fields.map(f => [f, all[f]])) : args;
  return createHash("sha256").update(`${op}\n${stableJson(picked)}`).digest("hex");
};

type Row = { hash: string; state: "started" | "done"; outcome: string | null };

export class DoneKeys {
  #db: Database.Database;
  #now: () => number;
  #disabled: boolean;

  constructor(db: Database.Database, now: () => number = Date.now, o: { disabled?: boolean } = {}) {
    this.#db = db;
    this.#now = now;
    this.#disabled = o.disabled === true;
  }

  #row(key: string): Row | undefined {
    if (this.#disabled) return undefined;
    return this.#db.prepare("SELECT hash, state, outcome FROM done_keys WHERE key = ?").get(key) as Row | undefined;
  }

  lookup(key: string, hash: string): Prior {
    const r = this.#row(key);
    if (!r) return { state: "none" };
    if (r.hash !== hash) return { state: "mismatch" };
    if (r.state === "started") return { state: "started" };
    return { state: "done", outcome: r.outcome === null ? null : JSON.parse(r.outcome) as unknown };
  }

  // Phase 1, committed before the side effect. False if the key appeared meanwhile (then the caller answers uncertain).
  start(key: string, hash: string): boolean {
    if (this.#disabled) return true;
    return this.#db.prepare("INSERT INTO done_keys (key, hash, state, at) VALUES (?, ?, 'started', ?) ON CONFLICT(key) DO NOTHING")
      .run(key, hash, this.#now()).changes === 1;
  }

  // Phase 2, after the side effect.
  finish(key: string, outcome: unknown): void {
    if (this.#disabled) return;
    this.#db.prepare("UPDATE done_keys SET state = 'done', outcome = ?, at = ? WHERE key = ?").run(JSON.stringify(outcome), this.#now(), key);
  }

  // A refusal before any side effect: as if the key never came.
  release(key: string): void {
    if (this.#disabled) return;
    this.#db.prepare("DELETE FROM done_keys WHERE key = ? AND state = 'started'").run(key);
  }

  status(key: string): KeyStatus {
    const r = this.#row(key);
    if (!r) return { state: "unknown" };
    if (r.state === "started") return { state: "started" };
    return { state: "done", outcome: r.outcome === null ? null : JSON.parse(r.outcome) as unknown };
  }

  prune(): number {
    return this.#db.prepare("DELETE FROM done_keys WHERE at < ?").run(this.#now() - LIMITS.doneKeyTtlMs).changes;
  }
}
```

- [ ] **Step 8: Run it and watch it pass**

Run: `npx vitest run apps/node-agent/test/done-keys.test.ts`

Expected: PASS, `Tests  7 passed (7)`.

- [ ] **Step 9: Create `apps/node-agent/test/executor.test.ts`**

The failing executor test. It uses fake ops, so that each shared rule is checked on its own. It includes plan Review Focus 4 for deadlines: whether a queued op makes its deadline is decided by the monotonic clock, while `Date` jumps in both directions. It also checks the `afterStarted` hook (the test hook `dropAfterStarted`): it runs after `started` is committed and before the side effect, the op runs on, and its reply says `discarded`.

```ts
// The executor's shared rules (spec §5.3) with fake ops, so each rule is checked on its own: unknown ops, the policy,
// argument checks, keys, two-phase done keys, per-queue serialization, reads that never wait, and the deadline under a
// wall-clock jump (plan Review Focus 4).
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpName } from "@morndo/protocol";
import { ALL_OPS } from "../src/config.ts";
import { openAgentDb, type AgentDb } from "../src/db/open.ts";
import { DoneKeys } from "../src/ops/done-keys.ts";
import { OpExecutor, effect, fail, ok, read, type OpTable } from "../src/ops/executor.ts";
import { dropOnce } from "../src/test-hooks.ts";
import { captureLog, tempHome } from "./helpers.ts";

const W = "pc.0a1b2c3d.4";
const EXPECT = { server: "0a1b2c3d", window: "api" };
const open: { adb: AgentDb; cleanup: () => void }[] = [];
afterEach(() => { vi.useRealTimers(); for (const o of open.splice(0)) { o.adb.close(); o.cleanup(); } });

function executor(ops: OpTable, allowed: readonly OpName[] = ALL_OPS, o: { afterStarted?: (key: string) => boolean; noDoneKeys?: boolean } = {}) {
  const h = tempHome();
  const adb = openAgentDb(join(h.home, "agent.db"));
  open.push({ adb, cleanup: h.cleanup });
  const doneKeys = new DoneKeys(adb.db, Date.now, { disabled: o.noDoneKeys === true });
  const ex = new OpExecutor({
    ops, allowed: new Set(allowed), doneKeys, invVersion: () => 42, log: captureLog().log,
    ...(o.afterStarted ? { afterStarted: o.afterStarted } : {}),
  });
  let n = 0;
  const call = (op: string, args: unknown, o: { key?: string; timeoutMs?: number } = {}) =>
    ex.handle({ id: `r${++n}`, op, args, timeoutMs: o.timeoutMs ?? 5000, ...(o.key !== undefined ? { key: o.key } : {}) });
  return { ex, call, doneKeys, adb };
}
const sendArgs = (text = "hello") => ({ workerId: W, text, expect: EXPECT });

describe("the shared rules", () => {
  it("answers unknown_op, denied and bad_args, each not executed, with the current invVersion", async () => {
    const { call } = executor({ "inventory.get": read(async () => ok<"inventory.get">({ panes: [], invVersion: 42 })) }, ["inventory.get"]);
    expect(await call("pane.exec", {})).toEqual({ id: "r1", invVersion: 42, ok: false, error: { code: "unknown_op", executed: "no", message: expect.any(String) } });
    expect(await call("pane.frame", { workerId: W })).toMatchObject({ ok: false, error: { code: "denied", executed: "no" } });
    expect(await call("inventory.get", { extra: 1 })).toMatchObject({ ok: false, error: { code: "bad_args", executed: "no" } });
    expect(await call("inventory.get", {})).toMatchObject({ ok: true, result: { panes: [] } });
  });
  it("refuses a keyed op without a key, and bad arguments of every kind (a sample)", async () => {
    const { call } = executor({ "pane.send": effect(() => "q", async () => ok<"pane.send">({ problem: null, typedAt: 1 })) });
    expect(await call("pane.send", sendArgs())).toMatchObject({ error: { code: "bad_args", message: "pane.send needs a key" } });
    for (const args of [
      { ...sendArgs(), workerId: "%3" },                               // a legacy pane id is not a worker id
      { ...sendArgs(), workerId: "pc.0a1b2c3d.04" },                    // a leading zero: not the pane's one worker ID
      { ...sendArgs(), text: "x".repeat(8001) },                        // over LIMITS.maxSendText
      { ...sendArgs(), text: "" },
      { ...sendArgs(), expect: { server: "XYZ", window: "api" } },
      { ...sendArgs(), expect: { server: "0a1b2c3d", window: "a\tb" } },  // a control character in the window name
    ]) {
      expect(await call("pane.send", args, { key: "hub:k" })).toMatchObject({ ok: false, error: { code: "bad_args" } });
    }
  });
  it("refuses a key on an op that takes none, as the fleet does (plan Contracts)", async () => {
    const { call } = executor({
      "pane.keys": effect(() => "q", async () => ok<"pane.keys">({ ok: true })),
      "inventory.get": read(async () => ok<"inventory.get">({ panes: [], invVersion: 42 })),
    });
    expect(await call("pane.keys", { workerId: W, data: "x", expect: EXPECT }, { key: "hub:k" })).toMatchObject({ ok: false, error: { code: "bad_args", executed: "no", message: "pane.keys takes no key" } });
    expect(await call("inventory.get", {}, { key: "hub:k" })).toMatchObject({ ok: false, error: { code: "bad_args" } });
    expect(await call("pane.keys", { workerId: W, data: "x", expect: EXPECT })).toMatchObject({ ok: true });   // negative control
  });
  it("decodes with OP_ARGS first, as the fleet did: an unknown field is dropped, never passed on", async () => {
    let seen: unknown = null;
    const { call } = executor({ "lane.start": effect(a => `lane:${a.name}`, async a => { seen = a; return ok<"lane.start">({ workerId: W }); }) });
    expect(await call("lane.start", { name: "x", cwd: "/w", flags: "--dangerously-skip-permissions" }, { key: "hub:f" })).toMatchObject({ ok: true });
    expect(seen).toEqual({ name: "x", cwd: "/w" });
    for (const args of [{ name: "x", cwd: "/w", account: "acct_2" }, { name: "x", cwd: "/w", resume: "-r" }, { name: "x", cwd: "w" }]) {
      expect(await call("lane.start", args, { key: "hub:f2" }), JSON.stringify(args)).toMatchObject({ ok: false, error: { code: "bad_args" } });
    }
  });
});

describe("two-phase done keys through the executor", () => {
  it("commits started before the side effect, done after it, and a repeat gets the stored outcome without acting", async () => {
    let acted = 0;
    let seenDuring: unknown = null;
    const x = executor({
      "pane.send": effect(() => "pane:%4", async () => {
        seenDuring = x.doneKeys.status("hub:1");
        acted++;
        return ok<"pane.send">({ problem: null, typedAt: 111 });
      }),
    });
    expect(await x.call("pane.send", sendArgs(), { key: "hub:1" })).toMatchObject({ ok: true, result: { problem: null, typedAt: 111 } });
    expect(seenDuring).toEqual({ state: "started" });
    expect(x.doneKeys.status("hub:1")).toEqual({ state: "done", outcome: { problem: null, typedAt: 111 } });
    expect(await x.call("pane.send", sendArgs(), { key: "hub:1" })).toMatchObject({ ok: true, result: { problem: null, typedAt: 111 } });
    expect(acted).toBe(1);
  });
  it("deletes the key on a refusal with executed: no, so the retry acts", async () => {
    let attempt = 0;
    const x = executor({
      "pane.send": effect(() => "pane:%4", async () => (++attempt === 1 ? fail("draft_present", "a draft") : ok<"pane.send">({ problem: null, typedAt: 2 }))),
    });
    expect(await x.call("pane.send", sendArgs(), { key: "hub:2" })).toMatchObject({ ok: false, error: { code: "draft_present", executed: "no" } });
    expect(x.doneKeys.status("hub:2")).toEqual({ state: "unknown" });
    expect(await x.call("pane.send", sendArgs(), { key: "hub:2" })).toMatchObject({ ok: true });
    expect(attempt).toBe(2);
  });
  it("keeps the key started when the outcome is unknown: a repeat is uncertain and does not act", async () => {
    let acted = 0;
    const x = executor({ "pane.send": effect(() => "pane:%4", async () => { acted++; throw new Error("tmux died mid-paste"); }) });
    expect(await x.call("pane.send", sendArgs(), { key: "hub:3" })).toMatchObject({ ok: false, error: { code: "internal", executed: "maybe" } });
    expect(await x.call("pane.send", sendArgs(), { key: "hub:3" })).toMatchObject({ ok: false, error: { code: "uncertain", executed: "maybe" } });
    expect(acted).toBe(1);
  });
  it("answers uncertain (it may have run) for the same key with other effect-determining arguments, and does not act", async () => {
    let acted = 0;
    const x = executor({ "pane.send": effect(() => "pane:%4", async () => { acted++; return ok<"pane.send">({ problem: null, typedAt: 1 }); }) });
    await x.call("pane.send", sendArgs("one"), { key: "hub:4" });
    expect(await x.call("pane.send", sendArgs("two"), { key: "hub:4" })).toMatchObject({ ok: false, error: { code: "uncertain", executed: "maybe", message: expect.stringMatching(/other arguments/) } });
    expect(acted).toBe(1);
  });
  it("a retry with a refreshed expectation is the same request: the stored outcome, nothing acts again", async () => {
    let acted = 0;
    const x = executor({ "pane.send": effect(() => "pane:%4", async () => { acted++; return ok<"pane.send">({ problem: null, typedAt: 9 }); }) });
    expect(await x.call("pane.send", sendArgs("one"), { key: "hub:5" })).toMatchObject({ ok: true, result: { typedAt: 9 } });
    const refreshed = { ...sendArgs("one"), expect: { ...EXPECT, sessionId: "3f0c1d2e-1111-4222-8333-444455556666" } };
    expect(await x.call("pane.send", refreshed, { key: "hub:5", timeoutMs: 9000 })).toMatchObject({ ok: true, result: { typedAt: 9 } });
    expect(acted).toBe(1);
  });
});

describe("the afterStarted hook (the test hook dropAfterStarted)", () => {
  it("runs right after started is committed; the op runs on, its reply says discarded, and the key ends done", async () => {
    let acted = 0;
    const atHook: unknown[] = [];
    const x = executor(
      { "pane.send": effect(() => "pane:%4", async () => { acted++; return ok<"pane.send">({ problem: null, typedAt: 7 }); }) },
      ALL_OPS, { afterStarted: dropOnce("drop", () => { atHook.push(x.doneKeys.status("hub:drop-1"), acted); }) },
    );
    expect(await x.call("pane.send", sendArgs(), { key: "hub:drop-1" })).toMatchObject({ ok: true, discarded: true, result: { typedAt: 7 } });
    expect(atHook).toEqual([{ state: "started" }, 0]);                  // after the commit, before the side effect
    expect(acted).toBe(1);
    expect(x.doneKeys.status("hub:drop-1")).toEqual({ state: "done", outcome: { problem: null, typedAt: 7 } });
    const again = await x.call("pane.send", sendArgs(), { key: "hub:drop-1" });   // once per key: answered, from the stored outcome
    expect(again).toMatchObject({ ok: true, result: { typedAt: 7 } });
    expect(again.discarded).toBeUndefined();
    expect(acted).toBe(1);
    expect((await x.call("pane.send", sendArgs("other"), { key: "hub:keep" })).discarded).toBeUndefined();
  });
  it("with done keys disabled (noDoneKeys) runs at that same point, and a repeat acts again", async () => {
    let acted = 0;
    let drops = 0;
    const x = executor(
      { "pane.send": effect(() => "pane:%4", async () => { acted++; return ok<"pane.send">({ problem: null, typedAt: acted }); }) },
      ALL_OPS, { noDoneKeys: true, afterStarted: dropOnce("drop", () => { drops++; }) },
    );
    expect(await x.call("pane.send", sendArgs(), { key: "hub:drop-2" })).toMatchObject({ ok: true, discarded: true });
    expect(await x.call("pane.send", sendArgs(), { key: "hub:drop-2" })).toMatchObject({ ok: true, result: { typedAt: 2 } });
    expect([acted, drops]).toEqual([2, 1]);
    expect(x.doneKeys.status("hub:drop-2")).toEqual({ state: "unknown" });
  });
});

describe("concurrency", () => {
  it("runs side effects on one queue in arrival order, other queues alongside, and reads without waiting", async () => {
    const log: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    const x = executor({
      "pane.keys": effect(a => `pane:${a.workerId}`, async a => {
        log.push(`start ${a.data}`);
        if (a.data === "first") await gate;
        log.push(`end ${a.data}`);
        return ok<"pane.keys">({ ok: true });
      }),
      "pane.frame": read(async () => { log.push("read"); return ok<"pane.frame">({ frame: null }); }),
    });
    const first = x.call("pane.keys", { workerId: W, data: "first", expect: EXPECT });
    const second = x.call("pane.keys", { workerId: W, data: "second", expect: EXPECT });
    const other = x.call("pane.keys", { workerId: "pc.0a1b2c3d.5", data: "other", expect: EXPECT });
    await other;
    await x.call("pane.frame", { workerId: W });
    expect(log).toEqual(["start first", "start other", "end other", "read"]);
    release();
    await Promise.all([first, second]);
    expect(log.slice(4)).toEqual(["end first", "start second", "end second"]);
  });
});

describe("deadlines (spec §5.3) under a wall-clock jump (Review Focus 4)", () => {
  it("measure on the monotonic clock: a jump neither expires a waiting op nor extends one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const acted: string[] = [];
    const x = executor({
      "pane.keys": effect(() => "pane:%4", async (a, ctx) => {
        if (a.data === "blocker") { await new Promise(r => setTimeout(r, 600)); acted.push(a.data); return ok<"pane.keys">({ ok: true }); }
        const late = ctx.ready();
        if (late) return { ok: false, error: late };
        acted.push(a.data);
        return ok<"pane.keys">({ ok: true });
      }),
    });
    const keys = (data: string, timeoutMs: number) => x.call("pane.keys", { workerId: W, data, expect: EXPECT }, { timeoutMs });
    const blocker = keys("blocker", 5000);
    const inTime = keys("in-time", 1000);                              // deadline at 750 ms
    const tooLate = keys("too-late", 700);                             // deadline at 450 ms
    await vi.advanceTimersByTimeAsync(100);
    vi.setSystemTime(Date.now() + 3_600_000);                          // an hour ahead: must not expire in-time
    await vi.advanceTimersByTimeAsync(100);
    vi.setSystemTime(Date.now() - 7_200_000);                          // two hours back: must not save too-late
    await vi.advanceTimersByTimeAsync(400);                            // 600 ms: the blocker finishes
    expect(await blocker).toMatchObject({ ok: true });
    expect(await inTime).toMatchObject({ ok: true });
    expect(await tooLate).toMatchObject({ ok: false, error: { code: "timeout", executed: "no" } });
    expect(acted).toEqual(["blocker", "in-time"]);
  });
  it("a keyed op that times out before acting releases its key", async () => {
    const x = executor({ "pane.send": effect(() => "pane:%4", async (_a, ctx) => { const late = ctx.ready(); return late ? { ok: false, error: late } : ok<"pane.send">({ problem: null, typedAt: 1 }); }) });
    expect(await x.call("pane.send", sendArgs(), { key: "hub:t", timeoutMs: 100 })).toMatchObject({ ok: false, error: { code: "timeout", executed: "no" } });
    expect(x.doneKeys.status("hub:t")).toEqual({ state: "unknown" });
  });
});
```

- [ ] **Step 10: Run it and watch it fail**

Run: `npx vitest run apps/node-agent/test/executor.test.ts`

Expected: FAIL, `Error: Cannot find module '../src/ops/executor.ts'`.

- [ ] **Step 11: Create `apps/node-agent/src/ops/args.ts`**

The agent decodes every op's arguments with `OP_ARGS[op]`, the schema the fleet already checked them with (plan Contracts, "The agent parses as the fleet does"), so the two never disagree about what a request means. Only what a node alone can judge comes after it. The branch name of `worktree.add` is asked of git itself, in `worktree-ops.ts`, where git runs.

```ts
// The arguments of every op, as this node acts on them (spec §5.3, §8; plan Contracts, "The agent parses as the fleet
// does"): first OP_ARGS[op], the schema the fleet checked them with (strict, with LIMITS; an unknown field is dropped,
// never passed on), then only what this node alone can judge. This is where a path is opened and text is typed, so the
// checks hold even against a fleet that is wrong or compromised. Each checker returns the typed arguments, or null for
// `bad_args`.
import { OP_ARGS, parseBody, type OpArgs, type OpName } from "@morndo/protocol";

// C0 control characters and DEL (a function, not a regular expression with control characters: the lint rule).
export function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}
// The hook relay's own copies are named by 32 hex digits (relay-files.ts): any other ref is none of this node's.
export const RELAY_REF = /^[0-9a-f]{32}$/;
// lane.start's account and resume id become arguments of `claude-as <account> --resume <id>`: checked once more here,
// as OP_ARGS has them, right before they reach a command line, so neither can ever pass as a flag.
export const ACCOUNT = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const RESUME_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validKey = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512 && !hasControl(v);

type Checkers = { [O in OpName]: (a: unknown) => OpArgs[O] | null };
// OP_ARGS[op], then the node's own check of what came out.
const decoded = <O extends OpName>(op: O, node: (a: OpArgs[O]) => boolean = () => true) => (a: unknown): OpArgs[O] | null => {
  const v = parseBody(OP_ARGS[op], a) as OpArgs[O] | null;
  return v !== null && node(v) ? v : null;
};

export const CHECK: Checkers = {
  "inventory.get": decoded("inventory.get"),
  "pane.captureMany": decoded("pane.captureMany"),
  "pane.frame": decoded("pane.frame"),
  "pane.keys": decoded("pane.keys"),
  "pane.send": decoded("pane.send"),
  "op.status": decoded("op.status", a => validKey(a.key)),
  "transcript.size": decoded("transcript.size"),
  "transcript.read": decoded("transcript.read"),
  "transcript.locate": decoded("transcript.locate"),
  "file.stat": decoded("file.stat", a => a.ref === undefined || RELAY_REF.test(a.ref)),
  "file.get": decoded("file.get", a => a.ref === undefined || RELAY_REF.test(a.ref)),
  "file.put": decoded("file.put", a => !hasControl(a.name)),
  "lane.start": decoded("lane.start", a => (a.account === undefined || ACCOUNT.test(a.account)) && (a.resume === undefined || RESUME_ID.test(a.resume))),
  "lane.stop": decoded("lane.stop"),
  "worktree.list": decoded("worktree.list"),
  "worktree.add": decoded("worktree.add"),
};
```

- [ ] **Step 12: Create `apps/node-agent/src/ops/deadline.ts`**

```ts
// A request's deadline (spec §5.3, "Deadlines"): it starts when the request arrives and ends `timeoutMs` − 250 ms
// later (LIMITS.deadlineMarginMs), measured on performance.now(), so a wall-clock jump changes nothing (plan Review
// Focus 4). A side effect that hasn't started by then doesn't start: the answer is `timeout`, not executed.
import { LIMITS } from "@morndo/protocol";

export type Deadline = { remainingMs(): number; expired(): boolean };

export function startDeadline(timeoutMs: number, now: () => number = () => performance.now()): Deadline {
  const budget = Number.isFinite(timeoutMs) ? timeoutMs : 0;
  const end = now() + budget - LIMITS.deadlineMarginMs;
  return {
    remainingMs: () => Math.max(0, end - now()),
    expired: () => now() >= end,
  };
}
```

- [ ] **Step 13: Create `apps/node-agent/src/ops/serial-queue.ts`**

```ts
// One side-effecting op at a time per pane, lane, upload or repository, in arrival order (spec §5.3, "Concurrency").
// Different keys never wait for each other, and reads never come here.
export class SerialQueue {
  #tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn);
    const tail = next.then(() => undefined, () => undefined);
    this.#tails.set(key, tail);
    void tail.then(() => { if (this.#tails.get(key) === tail) this.#tails.delete(key); });
    return next;
  }

  get size(): number { return this.#tails.size; }
}
```

- [ ] **Step 14: Create `apps/node-agent/src/ops/executor.ts`**

```ts
// Every op the fleet asks of this node (spec §5.3), through one place that applies the rules they share:
// - the op must be known (`unknown_op`) and allowed by the node's policy (`denied`), its arguments must fit
//   (`bad_args`, args.ts: OP_ARGS first, as the fleet checked them), a keyed op (KEYED_OPS) must carry a key, and any
//   other op must carry none (`bad_args`, as at the fleet);
// - reads run at once and never wait for side effects;
// - side effects run one at a time per queue key (pane, lane, upload, repository), in arrival order, under a deadline
//   that starts when the request arrives (deadline.ts); when it passes before the side effect starts, the answer is
//   `timeout`, not executed;
// - keyed side effects use two-phase done keys (done-keys.ts): looked up first inside the queue (so a duplicate waits
//   for the original and gets its outcome), `started` before the side effect, `done` after it, released on any
//   refusal that says `executed: "no"`, kept `started` when the outcome is unknown. The key's hash covers only what
//   decides the effect (done-keys.ts, EFFECT_FIELDS); a repeat whose hash differs is `uncertain`: that key's op may
//   have run.
// Each op's own module calls `ctx.ready()` immediately before its side effect: the deadline's last check.
// `afterStarted` runs right after a keyed op's `started` is committed (the test hook dropAfterStarted cuts the connection
// there); when it answers true, the op runs on and its reply says `discarded`, for agent.ts never to send.
import { ERROR_EXECUTED, KEYED_OPS, type ErrorCode, type OpArgs, type OpError, type OpName, type OpResult } from "@morndo/protocol";
import { isOpName } from "../config.ts";
import type { Logger } from "../log.ts";
import { CHECK, validKey } from "./args.ts";
import { startDeadline, type Deadline } from "./deadline.ts";
import { argsHash, type DoneKeys } from "./done-keys.ts";
import { SerialQueue } from "./serial-queue.ts";

export type Failure = { ok: false; error: OpError };
export type Outcome<O extends OpName> = { ok: true; result: OpResult[O] } | Failure;
export type EffectContext = { ready(): OpError | null; remainingMs(): number };
export type ReadOp<O extends OpName> = { kind: "read"; run(args: OpArgs[O]): Promise<Outcome<O>> };
export type EffectOp<O extends OpName> = { kind: "effect"; queue(args: OpArgs[O]): string; run(args: OpArgs[O], ctx: EffectContext): Promise<Outcome<O>> };
export type OpTable = { [O in OpName]?: ReadOp<O> | EffectOp<O> };
export type Request = { id: string; op: string; args: unknown; timeoutMs: number; key?: string };
export type Reply = { id: string; invVersion: number; discarded?: true } & ({ ok: true; result: unknown } | { ok: false; error: OpError });

export const fail = (code: ErrorCode, message: string): Failure => ({ ok: false, error: { code, executed: ERROR_EXECUTED[code], message } });
export const ok = <O extends OpName>(result: OpResult[O]): Outcome<O> => ({ ok: true, result });
export const read = <O extends OpName>(run: (args: OpArgs[O]) => Promise<Outcome<O>>): ReadOp<O> => ({ kind: "read", run });
export const effect = <O extends OpName>(queue: (args: OpArgs[O]) => string, run: (args: OpArgs[O], ctx: EffectContext) => Promise<Outcome<O>>): EffectOp<O> =>
  ({ kind: "effect", queue, run });

type AnyOutcome = { ok: true; result: unknown } | Failure;
type Answered = AnyOutcome & { discarded?: true };
type AnyOp = { kind: "read"; run(args: unknown): Promise<AnyOutcome> }
  | { kind: "effect"; queue(args: unknown): string; run(args: unknown, ctx: EffectContext): Promise<AnyOutcome> };

export type ExecutorDeps = {
  ops: OpTable;
  allowed: ReadonlySet<OpName>;
  doneKeys: DoneKeys;
  invVersion: () => number;
  log: Logger;
  now?: () => number;
  afterStarted?: (key: string) => boolean;
};

export class OpExecutor {
  #d: ExecutorDeps;
  #queue = new SerialQueue();

  constructor(d: ExecutorDeps) { this.#d = d; }

  async handle(req: Request): Promise<Reply> {
    const deadline = startDeadline(req.timeoutMs, this.#d.now);
    let out: Answered;
    try { out = await this.#outcome(req, deadline); }
    catch (e) {
      this.#d.log.error(`op ${isOpName(req.op) ? req.op : "?"} failed`, e);
      out = fail("internal", "the node failed while running the op");
    }
    return { id: req.id, invVersion: this.#d.invVersion(), ...out };
  }

  async #outcome(req: Request, deadline: Deadline): Promise<Answered> {
    if (!isOpName(req.op)) return fail("unknown_op", `this node has no op ${JSON.stringify(String(req.op).slice(0, 40))}`);
    const op = req.op;
    if (!this.#d.allowed.has(op)) return fail("denied", `this node's policy does not allow ${op}`);
    const entry = this.#d.ops[op] as AnyOp | undefined;
    if (!entry) return fail("unknown_op", `this node has no ${op}`);
    const args = (CHECK[op] as (a: unknown) => unknown)(req.args);
    if (args === null) return fail("bad_args", `arguments that don't fit ${op}`);
    const keyed = KEYED_OPS.has(op);
    if (keyed && !validKey(req.key)) return fail("bad_args", `${op} needs a key`);
    if (!keyed && req.key !== undefined) return fail("bad_args", `${op} takes no key`);
    if (entry.kind === "read") return entry.run(args);
    return this.#effect(op, entry, args, keyed ? req.key : undefined, deadline);
  }

  #effect(op: OpName, entry: Extract<AnyOp, { kind: "effect" }>, args: unknown, key: string | undefined, deadline: Deadline): Promise<Answered> {
    const keys = this.#d.doneKeys;
    const hash = key === undefined ? "" : argsHash(op, args);
    return this.#queue.run(entry.queue(args), async () => {
      if (key !== undefined) {
        const prior = keys.lookup(key, hash);
        if (prior.state === "done") return { ok: true, result: prior.outcome };
        if (prior.state === "started") return fail("uncertain", "an earlier attempt with this key started, and its outcome is not known");
        if (prior.state === "mismatch") return fail("uncertain", "this key was used with other arguments: its op may have run");
      }
      if (deadline.expired()) return fail("timeout", "the deadline passed before the op could start");
      if (key !== undefined && !keys.start(key, hash)) return fail("uncertain", "an attempt with this key is already recorded");
      const discarded = key !== undefined && this.#d.afterStarted?.(key) === true;
      const ctx: EffectContext = {
        ready: () => (deadline.expired() ? fail("timeout", "the deadline passed before the side effect").error : null),
        remainingMs: () => deadline.remainingMs(),
      };
      let out: AnyOutcome;
      try { out = await entry.run(args, ctx); }
      catch (e) {
        this.#d.log.error(`op ${op} failed while acting`, e);
        out = fail("internal", "the node failed while running the op; it may have acted");    // "maybe": the key stays started
      }
      if (key !== undefined) {
        if (out.ok) keys.finish(key, out.result);
        else if (out.error.executed === "no") keys.release(key);
      }
      return discarded ? { ...out, discarded } : out;
    });
  }
}
```

- [ ] **Step 15: Run it and watch it pass**

Run: `npx vitest run apps/node-agent/test/executor.test.ts`

Expected: PASS, `Tests  14 passed (14)`.

- [ ] **Step 16: Commit**

```bash
git add apps/node-agent
git commit -m "feat(node-agent): op executor with policy, argument checks, two-phase done keys, monotonic deadlines and test hooks"
```

- [ ] **Step 17: Allow control characters in the agent's terminal fixture regex, as for the hub's fixtures**

Still needed: Task 1's override lists node-ops' and the hub's tmux fixtures, not this one, and without it `oxlint` reports two `no-control-regex` errors in `fake-claude.fixture.ts`. In `.oxlintrc.json`, find the override that turns `no-control-regex` off and add the fixture after `apps/hub/test/tmux-*.ts`:

```diff
         "apps/hub/test/steering.test.ts",
-        "apps/hub/test/tmux-*.ts"
+        "apps/hub/test/tmux-*.ts",
+        "apps/node-agent/test/fake-claude.fixture.ts"
       ],
```

- [ ] **Step 18: Create `apps/node-agent/test/fake-claude.fixture.ts`**

A stand-in for Claude Code's input box. It only records what is submitted; it never runs the real CLI.

```ts
// A stand-in for Claude Code's input box, run as a pane's program by the agent's tmux tests (never the real CLI), like
// apps/hub/test/tmux-fake-claude.fixture.ts. It turns bracketed paste on and draws a ─ rule, "❯ " and the input, a ─
// rule and a footer. Inside a paste every byte is text; outside it Enter submits and DEL deletes. It runs nothing: it
// records what reaches it. Usage: node fake-claude.fixture.ts <state dir>; writes <dir>/submitted.jsonl.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

const dir = process.argv[2] ?? ".";
const decoder = new StringDecoder("utf8");
let input = "";
let paste = false;
let pending = "";

function draw() {
  const line = input.replace(/\n/g, " ").replace(/[\x00-\x1f\x7f]/g, "");
  process.stdout.write(`\u001b[H\u001b[2J${"─".repeat(40)}\r\n\u001b[38;5;246m❯ \u001b[39m${line}\r\n${"─".repeat(40)}\r\n  ? for shortcuts`);
}

process.stdin.setRawMode(true);
process.stdout.write("\u001b[?2004h");
draw();
process.stdin.on("data", (chunk: Buffer) => {
  pending += decoder.write(chunk);
  while (pending) {
    if (pending.startsWith("\u001b[200~")) { paste = true; pending = pending.slice(6); continue; }
    if (pending.startsWith("\u001b[201~")) { paste = false; pending = pending.slice(6); continue; }
    if (pending[0] === "\u001b") {
      const csi = /^\u001b\[[0-9;?]*[ -/]*[@-~]/.exec(pending);
      if (!csi && pending.length < 8) break;
      pending = pending.slice(csi ? csi[0].length : 1);
      continue;
    }
    const ch = pending[0] ?? "";
    pending = pending.slice(1);
    if (paste) input += ch === "\r" ? "\n" : ch;
    else if (ch === "\r") { appendFileSync(join(dir, "submitted.jsonl"), `${JSON.stringify(input)}\n`); input = ""; }
    else if (ch === "\u007f") input = input.slice(0, -1);
    else if (ch >= " ") input += ch;
  }
  draw();
});
```

- [ ] **Step 19: Create `apps/node-agent/test/ops-harness.ts`**

This harness drives the agent's op side through the executor, on a temporary HOME and an isolated tmux server.

```ts
// The agent's op side on a temporary HOME and an isolated tmux server, driven through the executor as the fleet would
// drive it, without a connection.
import type { PaneLock } from "@morndo/node-ops";
import { DEFAULT_POLICY, type AgentConfig, type Policy } from "../src/config.ts";
import { openAgentDb, type AgentDb } from "../src/db/open.ts";
import type { Reply } from "../src/ops/executor.ts";
import type { GuardInput } from "../src/ops/pane-ops.ts";
import { createOpsRuntime, type OpsRuntime } from "../src/ops/runtime.ts";
import { agentPaths, type AgentPaths } from "../src/paths.ts";
import type { TestHooks } from "../src/test-hooks.ts";
import { captureLog } from "./helpers.ts";

export type Harness = OpsRuntime & {
  config: AgentConfig;
  paths: AgentPaths;
  adb: AgentDb;
  call(op: string, args: unknown, o?: { key?: string; timeoutMs?: number }): Promise<Reply>;
  close(): void;
};

export function opsHarness(o: { home: string; socket: string; node?: string; policy?: Partial<Policy>; guard?: (g: GuardInput) => boolean; hooks?: TestHooks;
  lock?: (path: string, waitS: number) => PaneLock; room?: () => number }): Harness {
  const paths = agentPaths(o.home);
  const config: AgentConfig = {
    node: o.node ?? "pc", fleetUrl: "ws://127.0.0.1:9/agent", fleetKey: "AA==", keyPath: paths.keyPath, dbPath: paths.dbPath,
    relayPort: 0, home: o.home, policy: { ...DEFAULT_POLICY, tmuxSocket: o.socket, ...o.policy },
  };
  const adb = openAgentDb(paths.dbPath);
  const runtime = createOpsRuntime({
    config, db: adb.db, log: captureLog().log, ...(o.guard ? { guard: o.guard } : {}), ...(o.hooks ? { hooks: o.hooks } : {}),
    ...(o.lock ? { lock: o.lock } : {}), ...(o.room ? { room: o.room } : {}),
  });
  let n = 0;
  return {
    ...runtime, config, paths, adb,
    call: (op, args, c = {}) => runtime.executor.handle({ id: `r${++n}`, op, args, timeoutMs: c.timeoutMs ?? 10_000, ...(c.key !== undefined ? { key: c.key } : {}) }),
    close: () => adb.close(),
  };
}
```

- [ ] **Step 20: Create `apps/node-agent/test/inventory.test.ts`**

The failing inventory and read test, with plan Review Focus 1–3: window names; tmux not running, or dying mid-run; 64 full panes in one 512 KiB message. The file runs as a service manager may start the agent: with no locale (`LANG`, `LC_ALL` and `LC_CTYPE` unset) and not inside tmux (`TMUX` and `TMUX_PANE` unset, since a client inside tmux writes UTF-8 whatever the locale). Without tmux's `-u`, the window-name test fails.

```ts
// The inventory and reads on a real, isolated tmux server (`tmux -L test-<uuid>`). Plan Review Focus:
// 1. window names with spaces, unicode, dots, slashes (and a tab) are reported exactly and routed by worker ID;
// 2. tmux not running when the agent starts, or dying mid-run: an empty inventory, no crash, old worker IDs no_pane,
//    and a server that appears gets a stamp;
// 3. 64 panes with full captures fit one 512 KiB message, each capture capped at 6 KiB with `truncated`.
// The file runs as a service manager may start the agent: with no locale (LANG, LC_ALL and LC_CTYPE unset) and not
// inside tmux (TMUX and TMUX_PANE unset; a client inside tmux writes UTF-8 whatever the locale). Names must come through
// all the same (tmux -u).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { tmuxAdapter } from "@morndo/node-ops";
import { LIMITS, parseWorkerId } from "@morndo/protocol";
import { isolatedTmux, tempHome, until, type TestTmux } from "./helpers.ts";
import { opsHarness, type Harness } from "./ops-harness.ts";

const SHELL = "bash --norc --noprofile";
let home: { home: string; cleanup: () => void };
let t: TestTmux;
let h: Harness;
const UNSET = ["LANG", "LC_ALL", "LC_CTYPE", "TMUX", "TMUX_PANE"] as const;
const saved = UNSET.map(k => process.env[k]);
beforeAll(() => { for (const k of UNSET) delete process.env[k]; });
afterAll(() => { UNSET.forEach((k, i) => { const v = saved[i]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }); });
beforeEach(() => { home = tempHome(); t = isolatedTmux(); h = opsHarness({ home: home.home, socket: t.socket }); });
afterEach(() => { h.close(); t.kill(); home.cleanup(); });

const stampNow = () => t.tmux("show-options", "-gqv", "@morndo-server").trim().slice(0, 8);
// The window name tmux itself shows for a pane (the whole output is the name: no splitting on anything).
const windowOf = (pane: string) => t.tmux("display-message", "-p", "-t", pane, "#{window_name}").replace(/\n$/, "");

describe("what the inventory reports", () => {
  const NAMES = ["fix: a/b ü.2", "x.y/z", "two  spaces", "tab\there", "ünïcødé ✓"];

  it("only single-pane windows of the policy's session, under worker IDs, with names exactly as they are", async () => {
    t.tmux("new-session", "-d", "-s", "main", "-n", NAMES[0] as string, "-x", "80", "-y", "20", SHELL);
    for (const n of NAMES.slice(1)) t.tmux("new-window", "-d", "-t", "=main:", "-n", n, SHELL);
    t.tmux("new-window", "-d", "-t", "=main:", "-n", "split", SHELL);
    t.tmux("split-window", "-d", "-t", "=main:split", SHELL);            // two panes: not a lane
    t.tmux("new-session", "-d", "-s", "other", "-n", "elsewhere", SHELL); // another session: not reported
    const r = await h.call("inventory.get", {});
    if (!r.ok) throw new Error(r.error.message);
    const { panes, invVersion } = r.result as { panes: { workerId: string; window: string; cwd: string }[]; invVersion: number };
    expect(panes.map(p => p.window).sort()).toEqual([...NAMES].sort());
    expect(invVersion).toBe(1);
    const stamp = stampNow();
    expect(stamp).toMatch(/^[0-9a-f]{8}$/);
    for (const p of panes) {
      const ref = parseWorkerId(p.workerId);
      expect(ref).toMatchObject({ node: "pc", server: stamp });
      expect(windowOf(`%${ref?.pane}`)).toBe(p.window);
      expect(p.workerId).toMatch(/^pc\.[0-9a-f]{8}\.\d+$/);              // URL-safe, nothing of the name in it
    }
    // Routed by worker ID with the exact name as the expectation: each pane gets only its own keys. A name with a
    // control character (the tab) is listed, but no expectation can name it: OP_ARGS refuses it here as at the fleet
    // (Review Focus 1).
    const steerable = panes.filter(p => !p.window.includes("\t"));
    expect(steerable).toHaveLength(NAMES.length - 1);
    for (const [i, p] of steerable.entries()) {
      const res = await h.call("pane.keys", { workerId: p.workerId, data: `echo routed-${i}-$((6*7))\r`, expect: { server: stamp, window: p.window } });
      expect(res).toMatchObject({ ok: true, result: { ok: true } });
    }
    for (const [i, p] of steerable.entries()) {
      expect(await until(async () => {
        const c = await h.call("pane.captureMany", { workerIds: [p.workerId] });
        const text = c.ok ? (c.result as { captures: { text: string | null }[] }).captures[0]?.text ?? "" : "";
        return text.includes(`routed-${i}-42`) && steerable.every((_, j) => j === i || !text.includes(`routed-${j}-42`));
      })).toBe(true);
    }
    const tabbed = panes.find(p => p.window.includes("\t"));
    if (!tabbed) throw new Error("no tab window");
    expect(await h.call("pane.keys", { workerId: tabbed.workerId, data: "x", expect: { server: stamp, window: tabbed.window } }))
      .toMatchObject({ ok: false, error: { code: "bad_args", executed: "no" } });
  });

  it("grows invVersion only when what is reported changes", async () => {
    t.tmux("new-session", "-d", "-s", "main", "-n", "one", SHELL);
    expect((await h.inventory.refresh()).invVersion).toBe(1);
    expect((await h.inventory.refresh()).invVersion).toBe(1);
    t.tmux("new-window", "-d", "-t", "=main:", "-n", "two", SHELL);
    expect((await h.inventory.refresh()).invVersion).toBe(2);
    t.tmux("rename-window", "-t", "=main:two", "deux");
    expect((await h.inventory.refresh()).invVersion).toBe(3);
  });
});

describe("tmux not running, or dying mid-run (Review Focus 2)", () => {
  it("answers an empty inventory without a server, and stamps the server once one appears", async () => {
    expect(await h.call("inventory.get", {})).toMatchObject({ ok: true, result: { panes: [], invVersion: 0 } });
    expect(await h.call("pane.captureMany", { workerIds: ["pc.0a1b2c3d.0"] })).toMatchObject({ ok: true, result: { captures: [{ text: null, truncated: false }] } });
    expect(await h.call("pane.send", { workerId: "pc.0a1b2c3d.0", text: "x", expect: { server: "0a1b2c3d", window: "a" } }, { key: "hub:none" }))
      .toMatchObject({ ok: false, error: { code: "no_pane", executed: "no" } });
    expect(h.doneKeys.status("hub:none")).toEqual({ state: "unknown" });
    t.tmux("new-session", "-d", "-s", "main", "-n", "late", SHELL);
    const r = await h.call("inventory.get", {});
    expect(r).toMatchObject({ ok: true, result: { panes: [{ window: "late" }] } });
    expect(t.tmux("show-options", "-gqv", "@morndo-server").trim()).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
  });

  it("empties the inventory when the server dies, and old worker IDs answer no_pane (not executed)", async () => {
    t.tmux("new-session", "-d", "-s", "main", "-n", "api", SHELL);
    const before = await h.inventory.refresh();
    const old = before.panes[0];
    if (!old) throw new Error("no pane");
    const stamp = before.stamp ?? "";
    t.kill();
    expect(await h.call("inventory.get", {})).toMatchObject({ ok: true, result: { panes: [], invVersion: 2 } });
    const exp = { server: stamp, window: "api" };
    expect(await h.call("pane.send", { workerId: old.workerId, text: "hi", expect: exp }, { key: "hub:dead" })).toMatchObject({ ok: false, error: { code: "no_pane", executed: "no" } });
    expect(await h.call("pane.keys", { workerId: old.workerId, data: "x", expect: exp })).toMatchObject({ ok: false, error: { code: "no_pane", executed: "no" } });
    expect(await h.call("pane.frame", { workerId: old.workerId })).toMatchObject({ ok: true, result: { frame: null } });
    expect(await h.call("pane.captureMany", { workerIds: [old.workerId] })).toMatchObject({ ok: true, result: { captures: [{ text: null }] } });
  });
});

describe("capture size (Review Focus 3)", () => {
  it("64 panes with full captures fit one 512 KiB message; each capture keeps its last 6 KiB and says truncated", async () => {
    // 200 lines of 180 characters with quotes, backslashes and non-ASCII, which JSON encoding makes longer.
    const line = (i: number) => `${String(i).padStart(3, "0")} "quoted" \\back\\ ü ❯ ─ ${"x".repeat(150)}`;
    const file = join(home.home, "screen.txt");
    writeFileSync(file, `${Array.from({ length: 200 }, (_, i) => line(i)).join("\n")}\n`);
    const show = `sh -c 'cat "${file}"; exec sleep 600'`;
    t.tmux("new-session", "-d", "-s", "main", "-n", "w0", "-x", "250", "-y", "50", show);
    for (let i = 1; i < 64; i++) t.tmux("new-window", "-d", "-t", "=main:", "-n", `w${i}`, show);
    const snap = await h.inventory.refresh();
    expect(snap.panes).toHaveLength(64);
    const ids = snap.panes.map(p => p.workerId);
    const raw = tmuxAdapter({ socket: t.socket, session: "main" });
    expect(await until(async () => (await Promise.all(snap.lanes.map(l => raw.capture(l.pane)))).every(c => c?.includes(line(199)) ?? false), 10_000)).toBe(true);
    const reply = await h.call("pane.captureMany", { workerIds: ids });
    if (!reply.ok) throw new Error(reply.error.message);
    const message = JSON.stringify({ v: 1, t: "res", ...reply });
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(LIMITS.maxMessageBytes);
    const captures = (reply.result as { captures: { workerId: string; text: string | null; truncated: boolean }[] }).captures;
    expect(captures.map(c => c.workerId)).toEqual(ids);
    for (const c of captures) {
      expect(c.truncated).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(c.text))).toBeLessThanOrEqual(LIMITS.captureBytesPerPane);
      expect(c.text?.endsWith(line(199))).toBe(true);                   // the bottom of the pane is kept
      expect(c.text?.startsWith(line(0).slice(0, 3)) ?? true).toBe(false);
    }
    // Negative control: the same captures uncapped would not fit one message.
    const uncapped = await Promise.all(snap.lanes.map(l => raw.capture(l.pane)));
    expect(Buffer.byteLength(JSON.stringify(uncapped))).toBeGreaterThan(LIMITS.maxMessageBytes);
  }, 60_000);
});
```

- [ ] **Step 21: Create `apps/node-agent/test/pane-ops.test.ts`**

The failing test for pane.send, pane.keys, pane.frame and the pane lock. It includes spec §9 "Pane reuse": a tmux restart reuses `%N`, a send to the old worker ID is `no_pane`, and the new pane receives nothing. The negative control turns the expectation check off, and then the same send types into the new pane, once with an injected guard and once with the test hook `noExpect`. The test hook `clockOffsetMs` moves `typedAt`.

```ts
// pane.send, pane.keys and pane.frame on a real isolated tmux server with a stand-in for Claude Code's input box
// (fake-claude.fixture.ts). Spec §4 "The expectation check", §5.3, §9 "Pane reuse" with its negative control, and the
// test hooks that act on panes (noExpect, clockOffsetMs).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PaneLock } from "@morndo/node-ops";
import { isolatedTmux, tempHome, until, wait, type TestTmux } from "./helpers.ts";
import { opsHarness, type Harness } from "./ops-harness.ts";

const FIXTURE = join(import.meta.dirname, "fake-claude.fixture.ts");
let home: { home: string; cleanup: () => void };
let t: TestTmux;
let h: Harness;
let lane = { workerId: "", stamp: "" };
const dirOf = (name: string) => { const d = join(home.home, name); mkdirSync(d, { recursive: true }); return d; };
const claude = (dir: string) => `${process.execPath} ${FIXTURE} ${dir}`;
const submitted = (dir: string) => (existsSync(join(dir, "submitted.jsonl")) ? readFileSync(join(dir, "submitted.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l) as string) : []);
const screen = (target: string) => t.tmux("capture-pane", "-p", "-t", target);

async function startLane(dir: string, name = "lane-a") {
  t.tmux("new-session", "-d", "-s", "main", "-n", name, "-x", "100", "-y", "20", claude(dir));
  expect(await until(() => screen("=main:0").includes("❯"))).toBe(true);
  const snap = await h.inventory.refresh();
  const p = snap.panes.find(x => x.window === name);
  if (!p || !snap.stamp) throw new Error("no lane");
  return { workerId: p.workerId, stamp: snap.stamp };
}

beforeEach(async () => {
  home = tempHome();
  t = isolatedTmux();
  h = opsHarness({ home: home.home, socket: t.socket });
  lane = await startLane(dirOf("a"));
});
afterEach(() => { h.close(); t.kill(); home.cleanup(); });

const send = (text: string, key: string, expect: Record<string, unknown> = {}, workerId = lane.workerId, harness = h, timeoutMs?: number) =>
  harness.call("pane.send", { workerId, text, expect: { server: lane.stamp, window: "lane-a", ...expect } }, { key, ...(timeoutMs !== undefined ? { timeoutMs } : {}) });

describe("pane.send", () => {
  it("types once, answers the node's typedAt, and a repeat of the key returns the stored outcome without typing", async () => {
    const before = Date.now();
    const r = await send("hello world", "hub:s1");
    expect(r).toMatchObject({ ok: true, result: { problem: null } });
    const typedAt = r.ok ? (r.result as { typedAt: number }).typedAt : 0;
    expect(typedAt).toBeGreaterThanOrEqual(before);
    expect(typedAt).toBeLessThanOrEqual(Date.now());
    expect(await until(() => submitted(join(home.home, "a")).length === 1)).toBe(true);
    expect(await send("hello world", "hub:s1")).toEqual(r.ok ? { ...r, id: "r2" } : r);
    await wait(500);
    expect(submitted(join(home.home, "a"))).toEqual(["hello world"]);
  });

  it("refuses with no_pane (not executed) when the window, server or session differ, and frees the key for the retry", async () => {
    for (const wrong of [{ window: "lane-b" }, { server: "00000000" }, { sessionId: "3f0c1d2e-0000-4000-8000-000000000000" }]) {
      expect(await send("only once", "hub:s2", wrong)).toMatchObject({ ok: false, error: { code: "no_pane", executed: "no" } });
      expect(h.doneKeys.status("hub:s2")).toEqual({ state: "unknown" });
    }
    expect(await send("only once", "hub:s2")).toMatchObject({ ok: true, result: { problem: null } });
    expect(await until(() => submitted(join(home.home, "a")).length === 1)).toBe(true);
    expect(submitted(join(home.home, "a"))).toEqual(["only once"]);
  });

  it("reports typedAt on the node's wall clock, which the clockOffsetMs test hook moves", async () => {
    const other = tempHome();
    const shifted = opsHarness({ home: other.home, socket: t.socket, hooks: { clockOffsetMs: 3_600_000 } });
    try {
      const before = Date.now();
      const r = await send("an hour ahead", "hub:c1", {}, lane.workerId, shifted);
      expect(r).toMatchObject({ ok: true, result: { problem: null } });
      const typedAt = r.ok ? (r.result as { typedAt: number }).typedAt : 0;
      expect(typedAt).toBeGreaterThanOrEqual(before + 3_600_000);
      expect(typedAt).toBeLessThanOrEqual(Date.now() + 3_600_000);
    } finally {
      shifted.close();
      other.cleanup();
    }
  });

  it("draft_present frees the key: after the draft is cleared, the retry with the same key types once", async () => {
    t.tmux("send-keys", "-t", "=main:0", "-l", "half");
    expect(await until(() => screen("=main:0").includes("❯ half"))).toBe(true);
    expect(await send("the message", "hub:s3")).toMatchObject({ ok: false, error: { code: "draft_present", executed: "no" } });
    expect(h.doneKeys.status("hub:s3")).toEqual({ state: "unknown" });
    t.tmux("send-keys", "-t", "=main:0", "BSpace", "BSpace", "BSpace", "BSpace");
    expect(await until(() => !screen("=main:0").includes("half"))).toBe(true);
    expect(await send("the message", "hub:s3")).toMatchObject({ ok: true, result: { problem: null } });
    expect(await until(() => submitted(join(home.home, "a")).length === 1)).toBe(true);
    expect(submitted(join(home.home, "a"))).toEqual(["the message"]);
  });
});

describe("pane reuse after a tmux restart (spec §9)", () => {
  async function restartWithReusedPane() {
    t.kill();
    const fresh = dirOf("b");
    t.tmux("new-session", "-d", "-s", "main", "-n", "lane-a", "-x", "100", "-y", "20", claude(fresh));
    expect(await until(() => screen("=main:0").includes("❯"))).toBe(true);
    expect(t.tmux("list-panes", "-a", "-F", "#{pane_id}").trim()).toBe(lane.workerId.replace(/^.*\./, "%"));   // %N reused
    await h.inventory.refresh();                                          // the new server gets its own stamp
    expect(t.tmux("show-options", "-gqv", "@morndo-server").trim().slice(0, 8)).not.toBe(lane.stamp);
    return fresh;
  }

  it("a send to the old worker ID is no_pane, and the new pane in the reused %N receives nothing", async () => {
    const fresh = await restartWithReusedPane();
    expect(await send("meant for the old lane", "hub:r1")).toMatchObject({ ok: false, error: { code: "no_pane", executed: "no" } });
    await wait(600);
    expect(submitted(fresh)).toEqual([]);
  });

  it("negative control: with the expectation check disabled, the same send types into the new pane", async () => {
    const fresh = await restartWithReusedPane();
    const other = tempHome();
    const unguarded = opsHarness({ home: other.home, socket: t.socket, guard: () => true });
    try {
      expect(await send("meant for the old lane", "hub:r2", {}, lane.workerId, unguarded)).toMatchObject({ ok: true, result: { problem: null } });
      expect(await until(() => submitted(fresh).length === 1)).toBe(true);
      expect(submitted(fresh)).toEqual(["meant for the old lane"]);
    } finally {
      unguarded.close();
      other.cleanup();
    }
  });

  it("negative control through the noExpect test hook: the same send types into the new pane", async () => {
    const fresh = await restartWithReusedPane();
    const other = tempHome();
    const unguarded = opsHarness({ home: other.home, socket: t.socket, hooks: { noExpect: true } });
    try {
      expect(await send("meant for the old lane", "hub:r3", {}, lane.workerId, unguarded)).toMatchObject({ ok: true, result: { problem: null } });
      expect(await until(() => submitted(fresh).length === 1)).toBe(true);
      expect(submitted(fresh)).toEqual(["meant for the old lane"]);
    } finally {
      unguarded.close();
      other.cleanup();
    }
  });
});

describe("pane.keys and pane.frame", () => {
  it("keys reach the expected pane only", async () => {
    t.tmux("new-window", "-d", "-t", "=main:", "-n", "shell", "bash --norc --noprofile");
    const snap = await h.inventory.refresh();
    const shell = snap.panes.find(p => p.window === "shell");
    if (!shell) throw new Error("no shell");
    expect(await h.call("pane.keys", { workerId: shell.workerId, data: "echo keyed-$((6*7))\r", expect: { server: lane.stamp, window: "shell" } }))
      .toMatchObject({ ok: true, result: { ok: true } });
    expect(await until(() => screen("=main:shell").includes("keyed-42"))).toBe(true);
    expect(await h.call("pane.keys", { workerId: shell.workerId, data: "echo nope\r", expect: { server: lane.stamp, window: "lane-a" } }))
      .toMatchObject({ ok: false, error: { code: "no_pane", executed: "no" } });
    await wait(300);
    expect(screen("=main:shell")).not.toContain("nope");
  });

  it("frame shows a live pane, and null for a worker ID of another server", async () => {
    const live = await h.call("pane.frame", { workerId: lane.workerId });
    expect(live).toMatchObject({ ok: true, result: { frame: { cols: 100, rows: 20 } } });
    expect(JSON.stringify(live)).toContain("❯");
    expect(await h.call("pane.frame", { workerId: lane.workerId.replace(/\.[0-9a-f]{8}\./, ".00000000.") })).toMatchObject({ ok: true, result: { frame: null } });
  });
});

describe("a pane lock that comes too late (spec §5.3, \"Deadlines\")", () => {
  it("never types: the lock arrived after the deadline, so the answer is timeout, not executed, and the key is freed", async () => {
    h.close();
    let held = 0;
    // A lock that another typist holds for 1.2 s: it is granted, but after this request's deadline (1 s − 250 ms).
    const late = (): PaneLock => async f => { await wait(1200); held++; return f(); };
    h = opsHarness({ home: home.home, socket: t.socket, policy: { lockedPanes: { "lane-a": join(home.home, "lane-a.lock") } }, lock: late });
    expect(await send("too late", "hub:late", {}, lane.workerId, h, 1000)).toMatchObject({ ok: false, error: { code: "timeout", executed: "no" } });
    expect(held).toBe(1);
    expect(h.doneKeys.status("hub:late")).toEqual({ state: "unknown" });
    await wait(500);
    expect(submitted(join(home.home, "a"))).toEqual([]);
    expect(await send("in time", "hub:late", {}, lane.workerId, h, 5000)).toMatchObject({ ok: true });   // negative control: a deadline the lock makes
    expect(await until(() => submitted(join(home.home, "a")).length === 1)).toBe(true);
  });
});

const hasFlock = (() => { try { execFileSync("flock", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();

describe("the pane lock (spec §3.1 \"Pane lock\")", () => {
  it.skipIf(!hasFlock)("a pane whose lock another typist holds is busy, not executed, and the key is freed", async () => {
    h.close();
    const lockFile = join(home.home, "manager.lock");
    writeFileSync(lockFile, "");
    h = opsHarness({ home: home.home, socket: t.socket, policy: { lockedPanes: { "lane-a": lockFile } } });
    const holder = spawn("flock", ["-x", lockFile, "-c", "echo held; sleep 5"], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise(r => holder.stdout.once("data", r));
    try {
      expect(await h.call("pane.send", { workerId: lane.workerId, text: "locked out", expect: { server: lane.stamp, window: "lane-a" } }, { key: "hub:l1", timeoutMs: 1500 }))
        .toMatchObject({ ok: false, error: { code: "busy", executed: "no" } });
      expect(h.doneKeys.status("hub:l1")).toEqual({ state: "unknown" });
      expect(submitted(join(home.home, "a"))).toEqual([]);
    } finally {
      holder.kill();
    }
  }, 20_000);
});
```

- [ ] **Step 22: Create `apps/node-agent/test/transcript-file-ops.test.ts`**

The failing test for transcript.*, file.stat, file.get and file.put, on a temporary HOME with a throwaway `~/.claude`.

```ts
// transcript.* through the session registry, file.stat/get under today's confinement rules, and file.put's staging
// (spec §3.1, §5.3, §8), on a temporary HOME with a throwaway ~/.claude.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localTranscriptBytes } from "@morndo/node-ops";
import { LIMITS } from "@morndo/protocol";
import { isolatedTmux, tempHome, type TestTmux } from "./helpers.ts";
import { opsHarness, type Harness } from "./ops-harness.ts";

const SID = "3f0c1d2e-1111-4222-8333-444455556666";
let home: { home: string; cleanup: () => void };
let t: TestTmux;
let h: Harness;
let transcript = "";
beforeEach(() => {
  home = tempHome();
  t = isolatedTmux();
  const claude = join(home.home, ".claude");
  mkdirSync(join(claude, "sessions"), { recursive: true });
  mkdirSync(join(claude, "projects", "-work"), { recursive: true });
  writeFileSync(join(claude, "sessions", "1.json"), JSON.stringify({ pid: process.pid, sessionId: SID, tmux: "main:@0.%0", cwd: "/work", version: "2.1.286" }));
  transcript = join(claude, "projects", "-work", `${SID}.jsonl`);
  const lines = Array.from({ length: 40 }, (_, i) => JSON.stringify({ type: "user", uuid: `u-${i}`, message: { content: i === 30 ? "the needle is here" : `line ${i} ${"ü".repeat(i)}` } }));
  writeFileSync(transcript, `${lines.join("\n")}\n`);
  h = opsHarness({ home: home.home, socket: t.socket });
});
afterEach(() => { h.close(); t.kill(); home.cleanup(); });

const bytesOf = (r: { ok: boolean; result?: unknown }) => Buffer.from(((r as { result: { bytes: string } }).result).bytes, "base64");

describe("transcript.*", () => {
  it("reads a session's transcript by id, in chunks that reassemble to the file's bytes", async () => {
    const size = statSync(transcript).size;
    expect(await h.call("transcript.size", { sessionId: SID })).toMatchObject({ ok: true, result: { size } });
    const parts: Buffer[] = [];
    for (let offset = 0, eof = false; !eof;) {
      const r = await h.call("transcript.read", { sessionId: SID, offset, max: 333 });
      if (!r.ok) throw new Error(r.error.message);
      const b = bytesOf(r);
      parts.push(b);
      offset += b.length;
      eof = (r.result as { eof: boolean }).eof;
    }
    expect(Buffer.concat(parts).equals(readFileSync(transcript))).toBe(true);
    const expected = await localTranscriptBytes(transcript).locate("the needle");
    expect(expected).not.toBeNull();
    expect(await h.call("transcript.locate", { sessionId: SID, needle: "the needle" })).toMatchObject({ ok: true, result: { offset: expected } });
  });
  it("answers null or bad_args for a session it doesn't have, and refuses ids that could be paths", async () => {
    const other = "00000000-0000-4000-8000-000000000000";
    expect(await h.call("transcript.size", { sessionId: other })).toMatchObject({ ok: true, result: { size: null } });
    expect(await h.call("transcript.read", { sessionId: other, offset: 0, max: 10 })).toMatchObject({ ok: false, error: { code: "bad_args" } });
    expect(await h.call("transcript.locate", { sessionId: other, needle: "x" })).toMatchObject({ ok: true, result: { offset: null } });
    for (const sessionId of ["../../etc/passwd", "a/b", "x.jsonl"]) {
      expect(await h.call("transcript.size", { sessionId })).toMatchObject({ ok: false, error: { code: "bad_args" } });
    }
    expect(await h.call("transcript.read", { sessionId: SID, offset: 0, max: LIMITS.chunkBytes + 1 })).toMatchObject({ ok: false, error: { code: "bad_args" } });
  });
});

describe("file.stat and file.get", () => {
  it("serves a plain file in 256 KiB chunks", async () => {
    const work = join(home.home, "work");
    mkdirSync(work);
    const data = randomBytes(600 * 1024);
    writeFileSync(join(work, "shot.png"), data);
    expect(await h.call("file.stat", { path: join(work, "shot.png") })).toMatchObject({ ok: true, result: { size: data.length, mtime: statSync(join(work, "shot.png")).mtimeMs } });
    const parts: Buffer[] = [];
    for (let offset = 0, eof = false; !eof;) {
      const r = await h.call("file.get", { path: join(work, "shot.png"), offset, max: LIMITS.chunkBytes });
      if (!r.ok) throw new Error(r.error.message);
      const b = bytesOf(r);
      expect(b.length).toBeLessThanOrEqual(LIMITS.chunkBytes);
      parts.push(b);
      offset += b.length;
      eof = (r.result as { eof: boolean }).eof;
    }
    expect(Buffer.concat(parts).equals(data)).toBe(true);
  });
  it("refuses credentials, secrets by name, the agent's own key and database, directories, big and missing files", async () => {
    const work = join(home.home, "work");
    mkdirSync(join(home.home, ".ssh"), { recursive: true });
    mkdirSync(work, { recursive: true });
    mkdirSync(h.paths.configDir, { recursive: true });
    writeFileSync(join(home.home, ".ssh", "id_ed25519"), "key");
    writeFileSync(join(work, ".env"), "TOKEN=x");
    writeFileSync(h.paths.keyPath, "-----BEGIN PRIVATE KEY-----");
    writeFileSync(join(work, "big.bin"), "");
    truncateSync(join(work, "big.bin"), LIMITS.maxFileBytes + 1);
    const cases: [string, string][] = [
      [join(home.home, ".ssh", "id_ed25519"), "denied"],
      [join(work, ".env"), "denied"],
      [h.paths.keyPath, "denied"],
      [h.paths.dbPath, "denied"],
      [work, "denied"],
      [join(work, "big.bin"), "too_large"],
      [join(work, "missing.txt"), "bad_args"],
    ];
    for (const [path, code] of cases) {
      expect(await h.call("file.get", { path, offset: 0, max: 10 }), path).toMatchObject({ ok: false, error: { code, executed: "no" } });
    }
    expect(await h.call("file.get", { path: "relative.txt", offset: 0, max: 10 })).toMatchObject({ ok: false, error: { code: "bad_args" } });
    writeFileSync(join(work, "ok.txt"), "fine");
    expect(await h.call("file.get", { path: join(work, "ok.txt"), offset: 0, max: 10 })).toMatchObject({ ok: true, result: { size: 4, eof: true } });   // negative control
  });
  it("never shares the control plane's own state, kira's, or an account's credentials (node-ops' deny list), also through a link", async () => {
    const secret = [
      [".local", "share", "morndo", "morndo.db"], [".local", "share", "morndo-fleet", "fleet.db"], [".local", "state", "morndo-fleet", "notes.txt"],
      [".local", "share", "kira", "state.json"], [".config", "kira", "config.json"], [".config", "morndo-fleet", "config.json"],
      [".config", "morndo-node", "policy.json"], [".claude-accounts", "acct2", ".credentials.json"], [".claude", ".credentials.json"],
    ].map(p => join(home.home, ...p));
    for (const f of secret) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, "kept here"); }
    const work = join(home.home, "work");
    mkdirSync(work, { recursive: true });
    symlinkSync(secret[0] as string, join(work, "innocent.txt"));
    for (const path of [...secret, join(work, "innocent.txt")]) {
      expect(await h.call("file.get", { path, offset: 0, max: 10 }), path).toMatchObject({ ok: false, error: { code: "denied", executed: "no" } });
      expect(await h.call("file.stat", { path }), path).toMatchObject({ ok: false, error: { code: "denied", executed: "no" } });
    }
    writeFileSync(join(home.home, ".local", "share", "notes.txt"), "beside them");      // negative control: not every file there
    expect(await h.call("file.get", { path: join(home.home, ".local", "share", "notes.txt"), offset: 0, max: 20 })).toMatchObject({ ok: true, result: { size: 11 } });
  });
  it("serves a hook relay copy by its ref, and only by a ref it holds", async () => {
    mkdirSync(h.paths.relayFilesDir, { recursive: true });
    const ref = "ab".repeat(16);
    writeFileSync(join(h.paths.relayFilesDir, ref), "relayed");
    h.adb.db.prepare("INSERT INTO relay_files (ref, file, name, size, at, seq) VALUES (?, ?, 'note.txt', 7, 1, 1)").run(ref, join(h.paths.relayFilesDir, ref));
    expect(await h.call("file.get", { ref, offset: 0, max: 100 })).toMatchObject({ ok: true, result: { bytes: Buffer.from("relayed").toString("base64"), size: 7, eof: true } });
    expect(await h.call("file.stat", { ref: "cd".repeat(16) })).toMatchObject({ ok: false, error: { code: "bad_args" } });
    expect(await h.call("file.stat", { ref, path: "/etc/hosts" })).toMatchObject({ ok: false, error: { code: "bad_args" } });
  });
});

describe("file.put", () => {
  const chunk = (upload: string, offset: number, bytes: Buffer, final: boolean, name = "photo.png") =>
    ({ upload, offset, bytes: bytes.toString("base64"), final, name });

  it("stages chunks in order and moves the upload into the inbox on the final one; a repeated chunk key appends nothing", async () => {
    const a = randomBytes(1000), b = randomBytes(500);
    expect(await h.call("file.put", chunk("upload-0001", 0, a, false), { key: "hub:up1:0" })).toMatchObject({ ok: true, result: { path: null } });
    expect(await h.call("file.put", chunk("upload-0001", 0, a, false), { key: "hub:up1:0" })).toMatchObject({ ok: true, result: { path: null } });
    expect(await h.call("file.put", chunk("upload-0001", 1000, b, true, "../Photo 1.png"), { key: "hub:up1:1000" }))
      .toMatchObject({ ok: false, error: { code: "bad_args", executed: "no" } });             // a name with "/": OP_ARGS refuses it, as the fleet does
    const done = await h.call("file.put", chunk("upload-0001", 1000, b, true, ".Photo 1.png"), { key: "hub:up1:1000" });
    if (!done.ok) throw new Error(done.error.message);
    const path = (done.result as { path: string }).path;
    expect(path).toBe(join(h.paths.inboxDir, "upload-0001-Photo_1.png"));                   // a safe name: no leading dot, no space
    expect(readFileSync(path).equals(Buffer.concat([a, b]))).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  it("refuses a chunk out of order, and an upload over 25 MiB", async () => {
    expect(await h.call("file.put", chunk("upload-0002", 10, randomBytes(5), false), { key: "hub:up2" })).toMatchObject({ ok: false, error: { code: "bad_args", executed: "no" } });
    mkdirSync(join(h.paths.inboxDir, ".partial"), { recursive: true });
    const partial = join(h.paths.inboxDir, ".partial", "upload-0003");
    writeFileSync(partial, "");
    truncateSync(partial, LIMITS.maxFileBytes);
    expect(await h.call("file.put", chunk("upload-0003", LIMITS.maxFileBytes, randomBytes(1), true), { key: "hub:up3" })).toMatchObject({ ok: false, error: { code: "too_large", executed: "no" } });
    expect(h.doneKeys.status("hub:up3")).toEqual({ state: "unknown" });
  });
  it("refuses a chunk the node's disk budget can't hold (too_large, not executed), and frees the key", async () => {
    h.close();
    h = opsHarness({ home: home.home, socket: t.socket, room: () => 1000 - h.inbox.bytes() });   // 1000 bytes, less what the inbox holds
    expect(await h.call("file.put", chunk("upload-0005", 0, randomBytes(800), false), { key: "hub:up5:0" })).toMatchObject({ ok: true, result: { path: null } });
    expect(h.inbox.bytes()).toBe(800);
    expect(await h.call("file.put", chunk("upload-0005", 800, randomBytes(300), true), { key: "hub:up5:800" }))
      .toMatchObject({ ok: false, error: { code: "too_large", executed: "no", message: expect.stringMatching(/disk budget/) } });
    expect(h.doneKeys.status("hub:up5:800")).toEqual({ state: "unknown" });
    expect(await h.call("file.put", chunk("upload-0005", 800, randomBytes(150), true), { key: "hub:up5:800" })).toMatchObject({ ok: true });   // what fits
  });
  it("forgets a partial upload untouched for 10 minutes", async () => {
    await h.call("file.put", chunk("upload-0004", 0, randomBytes(10), false), { key: "hub:up4:0" });
    const partial = join(h.paths.inboxDir, ".partial", "upload-0004");
    const old = (Date.now() - 11 * 60_000) / 1000;
    utimesSync(partial, old, old);
    expect(await h.call("file.put", chunk("upload-0004", 10, randomBytes(10), true), { key: "hub:up4:10" })).toMatchObject({ ok: false, error: { code: "bad_args", message: expect.stringMatching(/expired/) } });
  });
});
```

- [ ] **Step 23: Create `apps/node-agent/test/lane-worktree-ops.test.ts`**

The failing test for lane.start, lane.stop, worktree.list and worktree.add. Stand-in `claude` and `claude-as` executables record the arguments they receive, and throwaway git repositories live under the policy's `repoRoots`.

```ts
// lane.start, lane.stop, worktree.list and worktree.add (spec §4 "Lane names", §5.3, §8) on an isolated tmux server
// with a stand-in `claude` and `claude-as` on the server's PATH, and a throwaway git repository under repoRoots.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { branchNameOk } from "../src/ops/worktree-ops.ts";
import { isolatedTmux, tempHome, until, wait, type TestTmux } from "./helpers.ts";
import { opsHarness, type Harness } from "./ops-harness.ts";

const SID = "3f0c1d2e-1111-4222-8333-444455556666";
let home: { home: string; cleanup: () => void };
let t: TestTmux;
let h: Harness;
let bin = "";
let argvDir = "";
let work = "";
const savedPath = process.env.PATH;
const savedArgvDir = process.env.MORNDO_TEST_ARGV;

beforeEach(() => {
  home = tempHome();
  bin = join(home.home, "bin");
  argvDir = join(home.home, "argv");
  work = join(home.home, "work");
  for (const d of [bin, argvDir, work]) mkdirSync(d, { recursive: true });
  // Each stand-in records its own name and arguments, then stays running like a lane would.
  for (const name of ["claude", "claude-as"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$(basename "$0")" "$@" > "$MORNDO_TEST_ARGV/$(basename "$0").argv"\nexec sleep 600\n`);
    chmodSync(join(bin, name), 0o755);
  }
  // A tmux server started here (by a test or by lane.start) takes the stand-ins' PATH from this environment. The
  // isolated server's commands copy the environment when it is made, so it is made after this.
  process.env.PATH = `${bin}:${savedPath ?? ""}`;
  process.env.MORNDO_TEST_ARGV = argvDir;
  t = isolatedTmux();
  h = opsHarness({ home: home.home, socket: t.socket, policy: { repoRoots: [join(home.home, "code")] } });
});
afterEach(() => {
  h.close();
  t.kill();
  process.env.PATH = savedPath;
  if (savedArgvDir === undefined) delete process.env.MORNDO_TEST_ARGV; else process.env.MORNDO_TEST_ARGV = savedArgvDir;
  home.cleanup();
});

const argv = (name: string) => (existsSync(join(argvDir, `${name}.argv`)) ? readFileSync(join(argvDir, `${name}.argv`), "utf8").trim().split("\n") : null);

describe("lane.start", () => {
  it("starts claude-as with the typed account and resume id in a new window, and the answer's invVersion lists it", async () => {
    t.tmux("new-session", "-d", "-s", "main", "-n", "base", "sleep 600");
    const name = "fix: a/b ü.2 #S";                                // "#S" would become the session name unescaped
    const r = await h.call("lane.start", { name, cwd: work, account: "acct", resume: SID }, { key: "hub:ls1" });
    if (!r.ok) throw new Error(r.error.message);
    const workerId = (r.result as { workerId: string }).workerId;
    expect(workerId).toMatch(/^pc\.[0-9a-f]{8}\.\d+$/);
    expect(h.inventory.last().invVersion).toBe(r.invVersion);
    expect(h.inventory.last().panes.find(p => p.workerId === workerId)).toMatchObject({ window: name, cwd: work });
    expect(await until(() => argv("claude-as") !== null)).toBe(true);
    expect(argv("claude-as")).toEqual(["claude-as", "acct", "--resume", SID]);
  });
  it("starts plain claude without an account, and claude --resume with only a resume id", async () => {
    t.tmux("new-session", "-d", "-s", "main", "-n", "base", "sleep 600");
    expect(await h.call("lane.start", { name: "plain", cwd: work }, { key: "hub:ls2" })).toMatchObject({ ok: true });
    expect(await until(() => argv("claude") !== null)).toBe(true);
    expect(argv("claude")).toEqual(["claude"]);
    expect(await h.call("lane.start", { name: "resumed", cwd: work, resume: SID }, { key: "hub:ls3" })).toMatchObject({ ok: true });
    expect(await until(() => argv("claude")?.length === 3)).toBe(true);
    expect(argv("claude")).toEqual(["claude", "--resume", SID]);
  });
  it("refuses a name already taken on this node (not executed, key freed), a bad cwd and free-form flags", async () => {
    t.tmux("new-session", "-d", "-s", "main", "-n", "api", "sleep 600");
    expect(await h.call("lane.start", { name: "api", cwd: work }, { key: "hub:ls4" })).toMatchObject({ ok: false, error: { code: "name_taken", executed: "no" } });
    expect(h.doneKeys.status("hub:ls4")).toEqual({ state: "unknown" });
    expect(await h.call("lane.start", { name: "x", cwd: join(work, "missing") }, { key: "hub:ls5" })).toMatchObject({ ok: false, error: { code: "bad_args" } });
    mkdirSync(join(home.home, ".ssh"), { recursive: true });
    expect(await h.call("lane.start", { name: "x", cwd: join(home.home, ".ssh") }, { key: "hub:ls6" })).toMatchObject({ ok: false, error: { code: "denied" } });
    for (const args of [
      { name: "x", cwd: work, account: "--dangerously-skip-permissions" },
      { name: "x", cwd: work, account: "acct_2" },
      { name: "x", cwd: work, resume: "abc; rm -rf ~" },
      { name: "x", cwd: work, resume: "--fork-session" },
      { name: "bad\nname", cwd: work },
    ]) {
      expect(await h.call("lane.start", args, { key: "hub:ls7" })).toMatchObject({ ok: false, error: { code: "bad_args" } });
    }
    // Free-form flags are no field of lane.start: OP_ARGS drops them, as the fleet does, and claude never sees them.
    expect(await h.call("lane.start", { name: "flagged", cwd: work, flags: ["--model", "opus"] }, { key: "hub:ls7b" })).toMatchObject({ ok: true });
    expect(await until(() => argv("claude") !== null)).toBe(true);
    expect(argv("claude")).toEqual(["claude"]);
  });
  it("starts the tmux server and the policy's session when none runs", async () => {
    expect(await h.call("lane.start", { name: "first", cwd: work }, { key: "hub:ls8" })).toMatchObject({ ok: true });
    expect(t.tmux("list-windows", "-t", "=main", "-F", "#{window_name}").trim()).toBe("first");
  });
  it("starts in exactly the directory asked for, whatever tmux formats it holds: never expanded, never run", async () => {
    // tmux expands formats in -c as in -n (seen on tmux 3.6a: a directory a#{session_name}b started the pane in amainb),
    // and #(…) is a format that runs a shell command; tmuxLiteral doubles every #.
    t.tmux("new-session", "-d", "-s", "main", "-n", "base", "sleep 600");
    const dirs = ["#{session_name}", "#(touch m)", "a#Sb ##x"].map(n => { const d = join(work, n); mkdirSync(d); return d; });
    for (const [i, cwd] of dirs.entries()) {
      const name = `odd dir ${i} #(touch n)`;
      const r = await h.call("lane.start", { name, cwd }, { key: `hub:dir${i}` });
      if (!r.ok) throw new Error(r.error.message);
      const pane = `%${(r.result as { workerId: string }).workerId.replace(/^.*\./, "")}`;
      expect(t.tmux("display-message", "-p", "-t", pane, "#{pane_start_path}").replace(/\n$/, ""), cwd).toBe(realpathSync(cwd));
      expect(t.tmux("display-message", "-p", "-t", pane, "#{window_name}").replace(/\n$/, "")).toBe(name);
      expect(h.inventory.last().panes.find(p => p.window === name)).toMatchObject({ cwd: realpathSync(cwd) });
    }
    await wait(500);                                                        // time for a #(…) job, had one started
    for (const where of [work, ...dirs, home.home, process.cwd()]) {
      expect(readdirSync(where).filter(f => f === "m" || f === "n"), where).toEqual([]);
    }
  });
});

describe("lane.stop", () => {
  it("closes the lane's window; a name it doesn't have is no_pane", async () => {
    t.tmux("new-session", "-d", "-s", "main", "-n", "base", "sleep 600");
    t.tmux("new-window", "-d", "-t", "=main:", "-n", "done lane", "sleep 600");
    expect(await h.call("lane.stop", { name: "done lane" }, { key: "hub:st1" })).toMatchObject({ ok: true, result: { ok: true } });
    expect(t.tmux("list-windows", "-t", "=main", "-F", "#{window_name}").trim()).toBe("base");
    expect(await h.call("lane.stop", { name: "done lane" }, { key: "hub:st2" })).toMatchObject({ ok: false, error: { code: "no_pane", executed: "no" } });
  });
});

describe("worktrees", () => {
  function repo(path: string) {
    mkdirSync(path, { recursive: true });
    const git = (...a: string[]) => execFileSync("git", ["-C", path, "-c", "user.name=test", "-c", "user.email=test@example.invalid", ...a], { stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "init");
    return path;
  }
  it("lists and adds worktrees of a repository under repoRoots, beside it; a branch name may hold slashes", async () => {
    const app = repo(join(home.home, "code", "app"));
    expect(await h.call("worktree.list", { repo: app })).toMatchObject({ ok: true, result: { worktrees: [{ path: app, branch: "main" }] } });
    const r = await h.call("worktree.add", { repo: app, name: "feat-x", base: "main" }, { key: "hub:wt1" });
    expect(r).toMatchObject({ ok: true, result: { path: join(home.home, "code", "app-worktrees", "feat-x") } });
    expect(existsSync(join(home.home, "code", "app-worktrees", "feat-x", ".git"))).toBe(true);
    expect(await h.call("worktree.add", { repo: app, name: "fix/login", base: "main" }, { key: "hub:wt1b" }))
      .toMatchObject({ ok: true, result: { path: join(home.home, "code", "app-worktrees", "fix", "login") } });
    const list = await h.call("worktree.list", { repo: app });
    expect(list.ok && (list.result as { worktrees: { branch: string | null }[] }).worktrees.map(w => w.branch)).toEqual(["main", "feat-x", "fix/login"]);
    expect(await h.call("worktree.add", { repo: app, name: "feat-x", base: "main" }, { key: "hub:wt2" })).toMatchObject({ ok: false, error: { code: "name_taken" } });
    expect(await h.call("worktree.add", { repo: app, name: "feat-y", base: "no-such-branch" }, { key: "hub:wt3" })).toMatchObject({ ok: false, error: { code: "bad_args" } });
  });
  it("refuses repositories outside repoRoots, a new worktree that would land outside them, and names that could be options or paths", async () => {
    const outside = repo(join(home.home, "elsewhere", "app"));
    expect(await h.call("worktree.list", { repo: outside })).toMatchObject({ ok: false, error: { code: "denied" } });
    const app = repo(join(home.home, "code", "app2"));
    // Each is refused by OP_ARGS' branch rules, as the fleet refuses it; git agrees (branchNameOk, below).
    for (const name of ["-b", "../escape", ".hidden", "a//b", "a/", "x/.y", "a.lock", "HEAD"]) {
      expect(await h.call("worktree.add", { repo: app, name, base: "main" }, { key: "hub:wt4" }), name).toMatchObject({ ok: false, error: { code: "bad_args", executed: "no" } });
    }
    expect(execFileSync("git", ["-C", app, "branch", "--list"], { encoding: "utf8" }).trim()).toBe("* main");   // nothing was made
    // The node's own last word, behind OP_ARGS: git itself (git check-ref-format --branch).
    for (const name of ["HEAD", "-b", "a..b", "a.lock", ""]) expect(await branchNameOk(name), name).toBe(false);
    for (const name of ["feat-x", "fix/login", "a.b/c_d"]) expect(await branchNameOk(name), name).toBe(true);
    // A root that is itself the repository: listed, but a worktree beside it would be outside every root.
    const rooted = opsHarness({ home: home.home, socket: t.socket, policy: { repoRoots: [app] } });
    try {
      expect(await rooted.call("worktree.list", { repo: app })).toMatchObject({ ok: true, result: { worktrees: [{ path: app }] } });
      expect(await rooted.call("worktree.add", { repo: app, name: "feat-z", base: "main" }, { key: "hub:wt5" })).toMatchObject({ ok: false, error: { code: "denied" } });
    } finally {
      rooted.close();
    }
  });
});
```

- [ ] **Step 24: Run it and watch it fail**

Run: `npx vitest run apps/node-agent/test/inventory.test.ts apps/node-agent/test/pane-ops.test.ts apps/node-agent/test/transcript-file-ops.test.ts apps/node-agent/test/lane-worktree-ops.test.ts`

Expected: FAIL, `Error: Cannot find module '../src/ops/runtime.ts'` (imported by `ops-harness.ts`).

- [ ] **Step 25: Create `apps/node-agent/src/ops/tmux-panes.ts`**

```ts
// The tmux facts the agent acts on, each read with one tmux command (tmux(1), https://man7.org/linux/man-pages/man1/tmux.1.html,
// read 2026-10-06: list-panes -s, display-message -p, formats).
// - Every call goes through node-ops' tmuxArgv, so it passes `-u`: tmux writes UTF-8 only when the client's locale says
//   so, and an agent under a service manager must not depend on its locale (tmux-cli.ts).
// - Window names, paths and titles may hold tabs and newlines (they pass through raw with -u), so fields and records
//   are separated by markers built from a random nonce per call, which no name contains by accident.
// - A session target is exactSession(name), "=name": without "=" tmux also matches by prefix ("mai" finds "main").
//   Panes and windows are targeted by ID (%N, @N), never by name: a target's window part is matched as a pattern and
//   split at "." (plan Global Constraints, the tmux rules).
// - The -F formats here are built from fixed names and a random nonce, never from outside data.
// - display-message on a pane that doesn't exist exits 0 with an empty #{pane_id} (seen 2026-10-06; with a target that
//   matches nothing it even prints the session's current window), so a pane's facts count only when the pane_id read
//   back is the one asked for.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { exactSession, tmuxArgv } from "@morndo/node-ops";

const run = promisify(execFile);

export type PaneRow = { pane: string; paneNum: number; windowId: string; windowPanes: number; window: string; cwd: string; title: string | null; stamp: string };
export type PaneFacts = { session: string; windowPanes: number; window: string; stamp: string };

export async function tmuxRun(socket: string | null, args: string[], timeout = 5000): Promise<string> {
  return (await run("tmux", tmuxArgv(socket, args), { timeout, maxBuffer: 8 << 20 })).stdout;
}

function format(nonce: string, names: string[]): string {
  return `${names.map(n => `#{${n}}`).join(`<${nonce}>`)}</${nonce}>`;
}

function records(out: string, nonce: string, fields: number): string[][] {
  return out.split(`</${nonce}>\n`).filter(r => r.length > 0).map(r => r.split(`<${nonce}>`)).filter(f => f.length === fields);
}

// "8 hex of @morndo-server" (plan Contracts, stampServer): the first eight hex digits of the UUID stamped there.
const shortStamp = (v: string) => (/^[0-9a-f]{8}/.test(v) ? v.slice(0, 8) : "");

// Every pane of the policy's session, with its server's stamp ("" when not stamped yet); [] without a server or session.
export async function listPanes(socket: string | null, session: string): Promise<PaneRow[]> {
  const nonce = randomBytes(16).toString("hex");
  let out: string;
  try {
    out = await tmuxRun(socket, ["list-panes", "-s", "-t", exactSession(session), "-F",
      format(nonce, ["pane_id", "window_id", "window_panes", "@morndo-server", "host", "window_name", "pane_current_path", "pane_title"])]);
  } catch {
    return [];
  }
  return records(out, nonce, 8).flatMap(([pane = "", windowId = "", panes = "", stamp = "", host = "", window = "", cwd = "", title = ""]) => {
    const m = /^%(\d{1,9})$/.exec(pane);
    if (!m || !/^@\d+$/.test(windowId)) return [];
    return [{ pane, paneNum: Number(m[1]), windowId, windowPanes: Number(panes), window, cwd, title: title && title !== host ? title : null, stamp: shortStamp(stamp) }];
  });
}

// One pane's session, window and server stamp, read together; null when the pane doesn't exist or tmux doesn't run.
export async function paneFacts(socket: string | null, pane: string): Promise<PaneFacts | null> {
  if (!/^%\d{1,9}$/.test(pane)) return null;
  const nonce = randomBytes(16).toString("hex");
  let out: string;
  try {
    out = await tmuxRun(socket, ["display-message", "-p", "-t", pane, format(nonce, ["pane_id", "session_name", "window_panes", "@morndo-server", "window_name"])]);
  } catch {
    return null;
  }
  const [r] = records(out, nonce, 5);
  if (!r || r[0] !== pane) return null;
  const [, session = "", panes = "", stamp = "", window = ""] = r;
  return { session, windowPanes: Number(panes), window, stamp: shortStamp(stamp) };
}
```

- [ ] **Step 26: Create `apps/node-agent/src/ops/inventory.ts`**

```ts
// What this node reports (spec §4, §5.4): the panes of the policy's tmux session that are alone in their window (a lane
// is one window with one pane), each under its worker ID `<node>.<server stamp>.<pane>`, with the Claude Code session
// running there. The stamp is read in the same tmux command as the panes, so a list never mixes two servers; a server
// without a stamp (new, or restarted) is stamped and read again. `invVersion` grows whenever what is reported changes,
// within this agent process. Refreshes run one at a time, so each sees every change made before it was asked for.
import { formatWorkerId, type Pane } from "@morndo/protocol";
import type { SessionInfo } from "@morndo/node-ops";
import { listPanes, type PaneRow } from "./tmux-panes.ts";

export type InventoryDeps = {
  node: string;
  session: string;
  socket: string | null;
  sessions: () => Map<string, SessionInfo>;
  stamp: (socket: string | null) => Promise<string | null>;
};
export type Lane = { workerId: string; pane: string; windowId: string; window: string; sessionId: string | null };
export type Snapshot = { invVersion: number; stamp: string | null; panes: Pane[]; lanes: Lane[]; rows: PaneRow[] };

export class Inventory {
  #d: InventoryDeps;
  #snap: Snapshot = { invVersion: 0, stamp: null, panes: [], lanes: [], rows: [] };
  #reported = "[]";
  #chain: Promise<unknown> = Promise.resolve();

  constructor(d: InventoryDeps) { this.#d = d; }

  get invVersion(): number { return this.#snap.invVersion; }
  last(): Snapshot { return this.#snap; }

  refresh(): Promise<Snapshot> {
    const next = this.#chain.then(() => this.#read());
    this.#chain = next.catch(() => undefined);
    return next;
  }

  windowOfPane(pane: string): string | null {
    return this.#snap.rows.find(r => r.pane === pane)?.window ?? null;
  }

  async #read(): Promise<Snapshot> {
    const d = this.#d;
    let rows = await listPanes(d.socket, d.session);
    if (rows.length && rows.some(r => !r.stamp)) {
      await d.stamp(d.socket);
      rows = await listPanes(d.socket, d.session);
    }
    const stamp = rows[0]?.stamp || null;
    const sessions = d.sessions();
    const lanes: Lane[] = [];
    const panes: Pane[] = [];
    for (const r of rows) {
      if (r.windowPanes !== 1 || !r.stamp) continue;
      const s = sessions.get(r.pane);
      const workerId = formatWorkerId({ node: d.node, server: r.stamp, pane: r.paneNum });
      lanes.push({ workerId, pane: r.pane, windowId: r.windowId, window: r.window, sessionId: s?.sessionId ?? null });
      panes.push({
        workerId, window: r.window, cwd: r.cwd,
        ...(s ? { sessionId: s.sessionId } : {}),
        ...(r.title !== null ? { title: r.title } : {}),
        ...(s?.version ? { claudeVersion: s.version } : {}),
      });
    }
    const reported = JSON.stringify(panes);
    const invVersion = reported === this.#reported ? this.#snap.invVersion : this.#snap.invVersion + 1;
    this.#reported = reported;
    this.#snap = { invVersion, stamp, panes, lanes, rows };
    return this.#snap;
  }
}
```

- [ ] **Step 27: Create `apps/node-agent/src/ops/capture-cap.ts`**

```ts
// A pane capture capped for the wire (spec §5.2 "Frames"; plan Review Focus 3): 64 panes with full captures must fit
// one 512 KiB message, so each capture keeps at most 6 KiB (LIMITS.captureBytesPerPane) measured as it travels, JSON
// encoded, quotes and escapes included. The bottom of a pane matters most (the input box, a menu), so the cut keeps
// the end and starts at a line boundary, and never splits a character.
const jsonBytes = (s: string) => Buffer.byteLength(JSON.stringify(s));

export function capCapture(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (jsonBytes(text) <= maxBytes) return { text, truncated: false };
  let lo = 0, hi = text.length;                                  // the smallest start whose tail fits
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (jsonBytes(text.slice(mid)) <= maxBytes) hi = mid; else lo = mid + 1;
  }
  let start = lo;
  const nl = text.indexOf("\n", start);
  if (nl !== -1 && nl + 1 < text.length) start = nl + 1;        // begin at a whole line
  else if (start < text.length && /[\uDC00-\uDFFF]/.test(text.charAt(start))) start += 1;   // not inside a surrogate pair
  return { text: text.slice(start), truncated: true };
}

// `fn` over `items` with at most `limit` running at once, results in input order.
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
```

- [ ] **Step 28: Create `apps/node-agent/src/ops/pane-ops.ts`**

```ts
// pane.* (spec §4 "The expectation check", §5.3). A side effect on a pane happens only when, inside the pane's queue,
// under its lock if the policy names one, and immediately before acting, the pane is still the one the caller meant:
// - the worker ID names this node, and its server stamp is the tmux server's stamp now;
// - the pane is in the policy's session and alone in its window;
// - the window has the expected name, and the expected Claude Code session (when given) runs in the pane.
// Anything else is `no_pane`, not executed: a restarted tmux server that reused `%N`, or a renamed or reused pane,
// never receives text meant for another lane. Refusals of the input-box checks (menu_open, no_input_box,
// draft_present) come from node-ops' tmux send before its paste and are answered as errors, not executed; the result's
// `problem` is null or not_submitted (typed, but no submit seen).
import { LIMITS, parseWorkerId, type Expect, type WorkerRef } from "@morndo/protocol";
import type { PaneLock, SessionInfo, Terminal, Tmux } from "@morndo/node-ops";
import type { Policy } from "../config.ts";
import { capCapture, mapLimit } from "./capture-cap.ts";
import { effect, fail, ok, read, type EffectContext, type Failure, type OpTable } from "./executor.ts";
import type { Inventory } from "./inventory.ts";
import { paneFacts, type PaneFacts } from "./tmux-panes.ts";

export type GuardInput = { node: string; session: string; ref: WorkerRef; expect: Expect; facts: PaneFacts | null; sessionId: string | null };

export function expectationHolds(g: GuardInput): boolean {
  const f = g.facts;
  return f !== null
    && g.ref.node === g.node
    && g.expect.server === g.ref.server
    && f.stamp === g.ref.server
    && f.session === g.session
    && f.windowPanes === 1
    && f.window === g.expect.window
    && (g.expect.sessionId === undefined || g.expect.sessionId === g.sessionId);
}

export type PaneDeps = {
  node: string;
  policy: Policy;
  tmux: Tmux;
  terminal: Terminal;
  inventory: Inventory;
  sessions: () => Map<string, SessionInfo>;
  lock: (path: string, waitS: number) => PaneLock;
  now: () => number;                                      // the node's wall clock, for typedAt (runtime.ts)
  guard?: (g: GuardInput) => boolean;                     // a test replaces it to show what it prevents
};

const paneOf = (workerId: string) => `%${parseWorkerId(workerId)?.pane ?? -1}`;
const SEND_REFUSALS = { menu_open: "a menu is open in the pane", no_input_box: "the pane shows no input box", draft_present: "the pane's input box holds a draft", no_pane: "the pane went away", busy: "the pane is busy" } as const;

export function paneOps(d: PaneDeps): Pick<OpTable, "pane.captureMany" | "pane.frame" | "pane.keys" | "pane.send"> {
  const guard = d.guard ?? expectationHolds;
  const socket = d.policy.tmuxSocket;

  // The lock the policy names for the expected window (the manager's pane, say), then the expectation check, then the
  // deadline's last word, then `act`.
  async function guarded<R>(workerId: string, exp: Expect, ctx: EffectContext, act: (pane: string) => Promise<{ ok: true; result: R } | Failure>): Promise<{ ok: true; result: R } | Failure> {
    const ref = parseWorkerId(workerId);
    if (!ref) return fail("no_pane", "not a worker ID");
    const pane = `%${ref.pane}`;
    const inner = async (): Promise<{ ok: true; result: R } | Failure> => {
      const facts = await paneFacts(socket, pane);
      const sessionId = d.sessions().get(pane)?.sessionId ?? null;
      if (!guard({ node: d.node, session: d.policy.session, ref, expect: exp, facts, sessionId })) {
        return fail("no_pane", "the pane is not the one expected (server, window or session differ)");
      }
      const late = ctx.ready();
      if (late) return { ok: false, error: late };
      return act(pane);
    };
    const lockPath = d.policy.lockedPanes[exp.window];
    if (lockPath === undefined) return inner();
    const waitS = Math.max(1, Math.min(20, Math.ceil(ctx.remainingMs() / 1000)));
    const held = await d.lock(lockPath, waitS)(inner);
    return held === "busy" ? fail("busy", "another typist holds the pane's lock") : held;
  }

  return {
    "pane.captureMany": read(async a => {
      const snap = await d.inventory.refresh();
      const captures = await mapLimit(a.workerIds, 8, async workerId => {
        const lane = snap.lanes.find(l => l.workerId === workerId);
        const text = lane ? await d.tmux.capture(lane.pane) : null;
        if (text === null) return { workerId, text: null, truncated: false };
        return { workerId, ...capCapture(text, LIMITS.captureBytesPerPane) };
      });
      return ok<"pane.captureMany">({ captures });
    }),

    "pane.frame": read(async a => {
      const ref = parseWorkerId(a.workerId);
      const pane = `%${ref?.pane ?? -1}`;
      const facts = await paneFacts(socket, pane);
      const current = ref !== null && ref.node === d.node && facts !== null && facts.stamp === ref.server && facts.session === d.policy.session;
      return ok<"pane.frame">({ frame: current ? await d.terminal.frame(pane) : null });
    }),

    "pane.keys": effect(a => `pane:${paneOf(a.workerId)}`, (a, ctx) =>
      guarded(a.workerId, a.expect, ctx, async pane => ok<"pane.keys">({ ok: await d.terminal.keys(pane, a.data) }))),

    "pane.send": effect(a => `pane:${paneOf(a.workerId)}`, (a, ctx) =>
      guarded(a.workerId, a.expect, ctx, async pane => {
        const typedAt = d.now();                          // the node's clock, just before the paste (spec §3.1, echo matching)
        const problem = await d.tmux.send(pane, a.text);
        if (problem === null || problem === "not_submitted") return ok<"pane.send">({ problem, typedAt });
        return fail(problem, SEND_REFUSALS[problem]);
      })),
  };
}
```

- [ ] **Step 29: Create `apps/node-agent/src/ops/transcript-ops.ts`**

```ts
// transcript.* (spec §3.1, §5.3): a Claude Code session's transcript as bytes, found through the session registry on
// this node and read with node-ops' byte source. At most 256 KiB per read (LIMITS.chunkBytes, checked in args.ts),
// base64 on the wire; the hub's parser carries partial lines across reads.
import { localTranscriptBytes } from "@morndo/node-ops";
import { fail, ok, read, type OpTable } from "./executor.ts";

export function transcriptOps(d: { transcriptPath: (sessionId: string) => string | null }): Pick<OpTable, "transcript.size" | "transcript.read" | "transcript.locate"> {
  const source = (sessionId: string) => {
    const path = d.transcriptPath(sessionId);
    return path === null ? null : localTranscriptBytes(path);
  };
  return {
    "transcript.size": read(async a => ok<"transcript.size">({ size: (await source(a.sessionId)?.size()) ?? null })),
    "transcript.read": read(async a => {
      const got = await source(a.sessionId)?.read(a.offset, a.max);
      if (!got) return fail("bad_args", "no transcript of that session on this node");
      return ok<"transcript.read">({ bytes: Buffer.from(got.bytes).toString("base64"), eof: got.eof });
    }),
    "transcript.locate": read(async a => ok<"transcript.locate">({ offset: (await source(a.sessionId)?.locate(a.needle)) ?? null })),
  };
}
```

- [ ] **Step 30: Create `apps/node-agent/src/ops/node-files.ts`**

```ts
// Which files of this node the fleet may read (spec §3.1, §8): today's rules through node-ops' openConfined (symlinks
// resolved, credential places and the control plane's own state denied, secret names skipped, 25 MiB), with the
// agent's state directory as the data directory it denies, plus the agent's configuration directory, which holds the
// node's private key. openConfined opens the resolved path with O_NOFOLLOW and checks the open file again, so a link
// put in its place after the check is refused, never followed. Copies the hook relay made (relay-files) are read by
// their ref only, never by path, also with O_NOFOLLOW.
import type { FileHandle } from "node:fs/promises";
import { sep } from "node:path";
import type Database from "better-sqlite3";
import { openConfined, openNoFollow } from "@morndo/node-ops";

export type Opened = Awaited<ReturnType<typeof openConfined>>;

export function nodeOpener(o: { home: string; stateDir: string; configDir: string; fileRoots?: string[] }): (path: string) => Promise<Opened> {
  const inConfig = (p: string) => p === o.configDir || p.startsWith(o.configDir + sep);
  return async path => {
    if (inConfig(path)) return { ok: false, reason: "denied" };
    const c = await openConfined(path, { home: o.home, dataDir: o.stateDir, ...(o.fileRoots ? { roots: o.fileRoots } : {}) });
    if (c.ok && inConfig(c.real)) { await c.fh.close(); return { ok: false, reason: "denied" }; }
    return c;
  };
}

// A relay copy by its ref (relay_files, written by the hook relay).
export function relayRef(db: Database.Database): (ref: string) => { file: string; size: number } | null {
  const q = db.prepare("SELECT file, size FROM relay_files WHERE ref = ?");
  return ref => (q.get(ref) as { file: string; size: number } | undefined) ?? null;
}

// A file of the agent's own (a relay copy): opened without following a link (node-ops' openNoFollow), and only if it
// is a regular file; null otherwise.
export async function openOwn(file: string): Promise<FileHandle | null> {
  let fh: FileHandle;
  try { fh = await openNoFollow(file); } catch { return null; }
  if ((await fh.stat()).isFile()) return fh;
  await fh.close();
  return null;
}

export async function readChunk(fh: FileHandle, offset: number, max: number): Promise<{ bytes: string; size: number; eof: boolean }> {
  const size = (await fh.stat()).size;
  const n = Math.max(0, Math.min(max, size - offset));
  const buf = Buffer.alloc(n);
  if (n > 0) await fh.read(buf, 0, n, offset);
  return { bytes: buf.toString("base64"), size, eof: offset + n >= size };
}
```

- [ ] **Step 31: Create `apps/node-agent/src/ops/upload-inbox.ts`**

```ts
// file.put's staging (spec §5.3): an upload from the fleet arrives in chunks into
// ~/.local/state/morndo-node/inbox/.partial/<upload> and moves into the inbox on its final chunk, where a lane on this
// node opens it by path. Chunks arrive in order (offset = the bytes so far), up to 25 MiB in all; a partial upload
// untouched for 10 minutes is deleted. Files are 0600 in a 0700 directory. What the inbox holds counts toward the
// node's disk budget (LIMITS.spoolMaxBytes, with the hook spool and the relay's copies; Task 9): `room` says how much
// is still free, and a chunk that doesn't fit is refused before anything is written.
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { LIMITS, type OpArgs } from "@morndo/protocol";
import { fail, ok, type EffectContext, type Outcome } from "./executor.ts";

export const PARTIAL_TTL_MS = 10 * 60_000;

export function safeName(name: string): string {
  const cleaned = basename(name).replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 100);
  return cleaned || "upload";
}

export class UploadInbox {
  readonly dir: string;
  #partial: string;
  #now: () => number;
  #room: () => number;

  constructor(o: { dir: string; now?: () => number; room?: () => number }) {
    this.dir = o.dir;
    this.#partial = join(o.dir, ".partial");
    this.#now = o.now ?? Date.now;
    this.#room = o.room ?? (() => Number.POSITIVE_INFINITY);
  }

  // The bytes the inbox holds: finished uploads and partial ones.
  bytes(): number {
    let total = 0;
    for (const dir of [this.dir, this.#partial]) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        try { const st = statSync(join(dir, f)); if (st.isFile()) total += st.size; } catch { /* gone meanwhile */ }
      }
    }
    return total;
  }

  async put(a: OpArgs["file.put"], ctx: EffectContext): Promise<Outcome<"file.put">> {
    mkdirSync(this.#partial, { recursive: true, mode: 0o700 });
    this.sweep();
    const partial = join(this.#partial, a.upload);
    const have = existsSync(partial) ? statSync(partial).size : 0;
    if (a.offset !== have) return fail("bad_args", `offset ${a.offset} does not follow the ${have} bytes received (or the upload expired)`);
    const bytes = Buffer.from(a.bytes, "base64");
    if (bytes.length > LIMITS.chunkBytes) return fail("bad_args", "a chunk is at most 256 KiB");
    if (have + bytes.length > LIMITS.maxFileBytes) {
      rmSync(partial, { force: true });
      return fail("too_large", "an upload is at most 25 MiB");
    }
    const target = join(this.dir, `${a.upload}-${safeName(a.name)}`);
    if (a.final && existsSync(target)) return fail("bad_args", "this upload already finished");
    if (bytes.length > this.#room()) return fail("too_large", "this node's disk budget for uploads and hooks is full");
    const late = ctx.ready();
    if (late) return { ok: false, error: late };
    appendFileSync(partial, bytes, { mode: 0o600 });
    if (!a.final) return ok<"file.put">({ path: null });
    renameSync(partial, target);
    return ok<"file.put">({ path: target });
  }

  // Partial uploads untouched for 10 minutes; finished files older than a week (as the hub's own inbox keeps them).
  sweep(): number {
    const now = this.#now();
    let removed = 0;
    const drop = (dir: string, olderThan: number) => {
      if (!existsSync(dir)) return;
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        try {
          const st = statSync(p);
          if (st.isFile() && now - st.mtimeMs > olderThan) { rmSync(p, { force: true }); removed++; }
        } catch { /* gone meanwhile */ }
      }
    };
    drop(this.#partial, PARTIAL_TTL_MS);
    drop(this.dir, 7 * 24 * 3_600_000);
    return removed;
  }
}
```

- [ ] **Step 32: Create `apps/node-agent/src/ops/file-ops.ts`**

```ts
// file.stat, file.get and file.put (spec §3.1, §5.3). Paths go through node-files.ts' opener (today's rules, 25 MiB,
// O_NOFOLLOW after the check); refs name the hook relay's own copies. Each read works on the handle that was checked,
// never on the path again. Reads are chunked, at most 256 KiB each.
import type { FileHandle } from "node:fs/promises";
import { fail, ok, read, effect, type Failure, type OpTable } from "./executor.ts";
import { openOwn, readChunk, type Opened } from "./node-files.ts";
import type { UploadInbox } from "./upload-inbox.ts";

export type FileDeps = {
  open: (path: string) => Promise<Opened>;
  relayRef: (ref: string) => { file: string; size: number } | null;
  inbox: UploadInbox;
};

const REASON = {
  missing: ["bad_args", "no such file on this node"],
  denied: ["denied", "that file is in a place this node never shares"],
  secret: ["denied", "that file's name marks a secret"],
  not_file: ["denied", "that is not a regular file"],
  too_large: ["too_large", "files are shared up to 25 MiB"],
} as const;

export function fileOps(d: FileDeps): Pick<OpTable, "file.stat" | "file.get" | "file.put"> {
  // The open file a path or a ref names, or the refusal.
  const target = async (a: { path?: string; ref?: string }): Promise<{ fh: FileHandle } | Failure> => {
    if (a.ref !== undefined) {
      const r = d.relayRef(a.ref);
      const fh = r ? await openOwn(r.file) : null;
      return fh ? { fh } : fail("bad_args", "no relay copy with that ref");
    }
    const c = await d.open(a.path ?? "");
    if (c.ok) return { fh: c.fh };
    const [code, message] = REASON[c.reason];
    return fail(code, message);
  };
  return {
    "file.stat": read(async a => {
      const t = await target(a);
      if ("ok" in t) return t;
      try {
        const st = await t.fh.stat();
        return ok<"file.stat">({ size: st.size, mtime: st.mtimeMs });
      } finally { await t.fh.close(); }
    }),
    "file.get": read(async a => {
      const t = await target(a);
      if ("ok" in t) return t;
      try { return ok<"file.get">(await readChunk(t.fh, a.offset, a.max)); }
      finally { await t.fh.close(); }
    }),
    "file.put": effect(a => `upload:${a.upload}`, (a, ctx) => d.inbox.put(a, ctx)),
  };
}
```

- [ ] **Step 33: Create `apps/node-agent/src/ops/lane-ops.ts`**

```ts
// lane.start and lane.stop (spec §4 "Lane names", §5.3, §8): typed fields only, never free flags or a shell line. A
// lane is a tmux window in the policy's session running Claude Code, and its name is unique on this node (the fleet
// keeps it unique across nodes).
// - tmux runs the command's words directly, without `sh -c`, when it gets more than one (tmux(1) new-window: "shell-command
//   given as multiple arguments and executed directly", read 2026-10-06; seen: an argument "$(id)" arrives as written).
// - tmux expands formats in `-n` names ("#{pane_id}" becomes "%0") and in `-c` directories (a directory
//   "a#{session_name}b" starts the pane in "amainb"; seen on tmux 3.6a, 2026-10-06), and `#(…)` in a format names a shell
//   command, so the name and the directory both go through node-ops' tmuxLiteral ("#" written as "##"), and the
//   session through exactSession (never a prefix match). The command's own words are not expanded (seen: an argument
//   "v#{session_name}w" arrives as written), and account and resume can hold no "#" anyway.
// - The window to stop is targeted by its ID (@N) from the inventory, never by its name.
import { realpathSync, statSync } from "node:fs";
import { formatWorkerId, type OpArgs } from "@morndo/protocol";
import { deniedBy, denyRoots, exactSession, tmuxLiteral } from "@morndo/node-ops";
import type { Policy } from "../config.ts";
import { effect, fail, ok, type OpTable } from "./executor.ts";
import type { Inventory } from "./inventory.ts";
import { tmuxRun } from "./tmux-panes.ts";

export type LaneDeps = { node: string; policy: Policy; inventory: Inventory; home: string; stateDir: string; stamp: (socket: string | null) => Promise<string | null> };

export function laneCommand(a: OpArgs["lane.start"]): string[] {
  const resume = a.resume === undefined ? [] : ["--resume", a.resume];
  return a.account === undefined ? ["claude", ...resume] : ["claude-as", a.account, ...resume];
}

function realDir(p: string): string | null {
  try {
    const real = realpathSync(p);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export function laneOps(d: LaneDeps): Pick<OpTable, "lane.start" | "lane.stop"> {
  const socket = d.policy.tmuxSocket;
  const session = d.policy.session;
  const deny = denyRoots(d.home, d.stateDir);
  const sessionExists = async () => {
    try { await tmuxRun(socket, ["has-session", "-t", exactSession(session)]); return true; }
    catch { return false; }
  };

  return {
    "lane.start": effect(a => `lane:${a.name}`, async (a, ctx) => {
      const cwd = realDir(a.cwd);
      if (!cwd) return fail("bad_args", "cwd is not a directory on this node");
      if (deniedBy(cwd, deny)) return fail("denied", "lanes may not start in that directory");
      const snap = await d.inventory.refresh();
      if (snap.rows.some(r => r.window === a.name)) return fail("name_taken", "a window of that name already exists on this node");
      const late = ctx.ready();
      if (late) return { ok: false, error: late };
      const where = (await sessionExists()) ? ["new-window", "-d", "-t", `${exactSession(session)}:`] : ["new-session", "-d", "-s", tmuxLiteral(session)];
      const out = await tmuxRun(socket, [...where, "-n", tmuxLiteral(a.name), "-c", tmuxLiteral(cwd), "-P", "-F", "#{pane_id}", ...laneCommand(a)]);
      const pane = /^%(\d{1,9})$/.exec(out.trim());
      if (!pane) return fail("internal", "tmux did not report the new pane");
      const stamp = await d.stamp(socket);
      if (!stamp) return fail("internal", "the tmux server could not be stamped");
      await d.inventory.refresh();                           // so this answer's invVersion already lists the new lane
      return ok<"lane.start">({ workerId: formatWorkerId({ node: d.node, server: stamp, pane: Number(pane[1]) }) });
    }),

    "lane.stop": effect(a => `lane:${a.name}`, async (a, ctx) => {
      const snap = await d.inventory.refresh();
      const windows = [...new Set(snap.lanes.filter(l => l.window === a.name).map(l => l.windowId))];
      if (windows.length === 0) return fail("no_pane", "no lane of that name on this node");
      if (windows.length > 1) return fail("bad_args", "two windows on this node have that name; stop one in tmux");
      const late = ctx.ready();
      if (late) return { ok: false, error: late };
      await tmuxRun(socket, ["kill-window", "-t", windows[0] as string]);
      await d.inventory.refresh();
      return ok<"lane.stop">({ ok: true });
    }),
  };
}
```

- [ ] **Step 34: Create `apps/node-agent/src/ops/worktree-ops.ts`**

```ts
// worktree.list and worktree.add (spec §5.3): git worktrees of repositories under the policy's repoRoots, and new ones
// beside the repository at <repo>-worktrees/<name>, also under a root (git-worktree(1): `worktree list --porcelain -z`,
// `worktree add -b <branch> <path> <commit-ish>`; https://git-scm.com/docs/git-worktree, read 2026-10-06). A branch
// name may hold "/" (fix/login, a worktree at <repo>-worktrees/fix/login). OP_ARGS already refused what can't be one;
// git itself has the last word (`git check-ref-format --branch`, https://git-scm.com/docs/git-check-ref-format, read
// 2026-10-06), behind OP_ARGS' rules, which already refuse every name git refuses that was tried.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { promisify } from "node:util";
import { effect, fail, ok, read, type OpTable } from "./executor.ts";

const run = promisify(execFile);
const git = (repo: string, args: string[]) =>
  run("git", ["-C", repo, ...args], { timeout: 30_000, maxBuffer: 4 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
const under = (p: string, root: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

// Whether git takes `name` as a branch name: the node's own last word on it.
export async function branchNameOk(name: string): Promise<boolean> {
  try { await run("git", ["check-ref-format", "--branch", name], { timeout: 10_000 }); return true; }
  catch { return false; }
}

export function worktreePath(repo: string, name: string): string {
  return join(dirname(repo), `${basename(repo)}-worktrees`, name);
}

// `git worktree list --porcelain -z`: NUL-terminated lines, an empty line between worktrees.
export function parsePorcelain(out: string): { path: string; branch: string | null }[] {
  const trees: { path: string; branch: string | null }[] = [];
  let cur: { path: string; branch: string | null } | null = null;
  for (const line of out.split("\0")) {
    if (line === "") { if (cur) trees.push(cur); cur = null; continue; }
    if (line.startsWith("worktree ")) cur = { path: line.slice(9), branch: null };
    else if (cur && line.startsWith("branch refs/heads/")) cur.branch = line.slice(18);
  }
  if (cur) trees.push(cur);
  return trees;
}

export function worktreeOps(d: { repoRoots: string[] }): Pick<OpTable, "worktree.list" | "worktree.add"> {
  const roots = () => d.repoRoots.flatMap(r => { try { return [realpathSync(r)]; } catch { return []; } });
  const confinedRepo = (repo: string): string | null => {
    try {
      const real = realpathSync(repo);
      return statSync(real).isDirectory() && roots().some(r => under(real, r)) ? real : null;
    } catch {
      return null;
    }
  };
  return {
    "worktree.list": read(async a => {
      const repo = confinedRepo(a.repo);
      if (!repo) return fail("denied", "that repository is not under this node's repoRoots");
      try { return ok<"worktree.list">({ worktrees: parsePorcelain((await git(repo, ["worktree", "list", "--porcelain", "-z"])).stdout) }); }
      catch { return fail("bad_args", "that directory is not a git repository"); }
    }),
    "worktree.add": effect(a => `repo:${a.repo}`, async (a, ctx) => {
      const repo = confinedRepo(a.repo);
      if (!repo) return fail("denied", "that repository is not under this node's repoRoots");
      const path = worktreePath(repo, a.name);
      if (!roots().some(r => under(path, r))) return fail("denied", "the new worktree would not be under this node's repoRoots");
      if (!(await branchNameOk(a.name))) return fail("bad_args", "git does not take that as a branch name");
      if (existsSync(path)) return fail("name_taken", "a worktree of that name exists");
      try { await git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${a.name}`]); return fail("name_taken", "a branch of that name exists"); }
      catch { /* no such branch: good */ }
      try { await git(repo, ["rev-parse", "--verify", "--quiet", `${a.base}^{commit}`]); }
      catch { return fail("bad_args", "no commit of that name in the repository"); }
      const late = ctx.ready();
      if (late) return { ok: false, error: late };
      mkdirSync(dirname(path), { recursive: true });
      await git(repo, ["worktree", "add", "-b", a.name, path, a.base]);
      return ok<"worktree.add">({ path });
    }),
  };
}
```

- [ ] **Step 35: Create `apps/node-agent/src/ops/table.ts`**

```ts
// Every op of the protocol (plan Contracts: OpName), wired to this node's tmux, Claude Code files, disk and database.
import { join } from "node:path";
import type Database from "better-sqlite3";
import { paneLock, sessionRegistry, stampServer, terminalAdapter, tmuxAdapter, type PaneLock } from "@morndo/node-ops";
import type { AgentConfig } from "../config.ts";
import type { AgentPaths } from "../paths.ts";
import type { DoneKeys } from "./done-keys.ts";
import { ok, read, type OpTable } from "./executor.ts";
import { fileOps } from "./file-ops.ts";
import type { Inventory } from "./inventory.ts";
import { laneOps } from "./lane-ops.ts";
import { nodeOpener, relayRef } from "./node-files.ts";
import { paneOps, type GuardInput } from "./pane-ops.ts";
import { transcriptOps } from "./transcript-ops.ts";
import type { UploadInbox } from "./upload-inbox.ts";
import { worktreeOps } from "./worktree-ops.ts";

export type OpsDeps = {
  config: AgentConfig;
  paths: AgentPaths;
  db: Database.Database;
  doneKeys: DoneKeys;
  inventory: Inventory;
  inbox: UploadInbox;
  registry: ReturnType<typeof sessionRegistry>;
  now: () => number;
  guard?: (g: GuardInput) => boolean;
  lock?: (path: string, waitS: number) => PaneLock;
};

export function claudeDir(home: string): string { return join(home, ".claude"); }

export function buildOps(d: OpsDeps): OpTable {
  const { config, paths } = d;
  const policy = config.policy;
  return {
    "inventory.get": read(async () => {
      const s = await d.inventory.refresh();
      return ok<"inventory.get">({ panes: s.panes, invVersion: s.invVersion });
    }),
    "op.status": read(async a => ok<"op.status">(d.doneKeys.status(a.key))),
    ...paneOps({
      node: config.node, policy, inventory: d.inventory,
      tmux: tmuxAdapter({ socket: policy.tmuxSocket, session: policy.session }),
      terminal: terminalAdapter({ socket: policy.tmuxSocket }),
      sessions: () => d.registry.byPane(),
      lock: d.lock ?? ((path, waitS) => paneLock(path, waitS)),
      now: d.now,
      ...(d.guard ? { guard: d.guard } : {}),
    }),
    ...transcriptOps({ transcriptPath: sid => d.registry.transcriptPath(sid) }),
    ...fileOps({
      open: nodeOpener({ home: config.home, stateDir: paths.stateDir, configDir: paths.configDir, ...(policy.fileRoots ? { fileRoots: policy.fileRoots } : {}) }),
      relayRef: relayRef(d.db),
      inbox: d.inbox,
    }),
    ...laneOps({ node: config.node, policy, inventory: d.inventory, home: config.home, stateDir: paths.stateDir, stamp: stampServer }),
    ...worktreeOps({ repoRoots: policy.repoRoots }),
  };
}
```

- [ ] **Step 36: Create `apps/node-agent/src/ops/runtime.ts`**

```ts
// The op side of the agent, assembled: inventory, done keys, upload inbox, session registry and the executor over
// every op, and the wall clock the node reports. agent.ts runs it behind the fleet connection; the tests drive the
// executor directly. Three test hooks act here (test-hooks.ts): noDoneKeys, noExpect and clockOffsetMs.
import type Database from "better-sqlite3";
import { sessionRegistry, stampServer, type PaneLock } from "@morndo/node-ops";
import type { AgentConfig } from "../config.ts";
import type { Logger } from "../log.ts";
import { agentPaths } from "../paths.ts";
import { wallClock, type TestHooks } from "../test-hooks.ts";
import { DoneKeys } from "./done-keys.ts";
import { OpExecutor } from "./executor.ts";
import { Inventory } from "./inventory.ts";
import type { GuardInput } from "./pane-ops.ts";
import { buildOps, claudeDir } from "./table.ts";
import { UploadInbox } from "./upload-inbox.ts";

export type OpsRuntime = {
  inventory: Inventory;
  doneKeys: DoneKeys;
  inbox: UploadInbox;
  registry: ReturnType<typeof sessionRegistry>;
  executor: OpExecutor;
  now: () => number;                                      // the wall clock the node reports (clockOffsetMs included)
};

export type RuntimeOptions = {
  config: AgentConfig;
  db: Database.Database;
  log: Logger;
  guard?: (g: GuardInput) => boolean;                     // a test replaces the expectation check to show what it prevents
  hooks?: TestHooks;
  afterStarted?: (key: string) => boolean;                // the executor's hook after a committed `started` (agent.ts)
  lock?: (path: string, waitS: number) => PaneLock;       // a test's slow lock; node-ops' paneLock otherwise
  room?: () => number;                                    // bytes still free in the node's disk budget (agent.ts)
};

const acceptAny = () => true;

export function createOpsRuntime(o: RuntimeOptions): OpsRuntime {
  const { config } = o;
  const hooks = o.hooks ?? {};
  const now = wallClock(hooks);
  const paths = agentPaths(config.home);
  const registry = sessionRegistry(claudeDir(config.home));
  const inventory = new Inventory({
    node: config.node, session: config.policy.session, socket: config.policy.tmuxSocket,
    sessions: () => registry.byPane(), stamp: stampServer,
  });
  const doneKeys = new DoneKeys(o.db, Date.now, { disabled: hooks.noDoneKeys === true });
  const inbox = new UploadInbox({ dir: paths.inboxDir, ...(o.room ? { room: o.room } : {}) });
  const guard = o.guard ?? (hooks.noExpect ? acceptAny : undefined);
  const ops = buildOps({ config, paths, db: o.db, doneKeys, inventory, inbox, registry, now, ...(guard ? { guard } : {}), ...(o.lock ? { lock: o.lock } : {}) });
  const executor = new OpExecutor({
    ops, allowed: new Set(config.policy.ops), doneKeys, invVersion: () => inventory.invVersion, log: o.log,
    ...(o.afterStarted ? { afterStarted: o.afterStarted } : {}),
  });
  return { inventory, doneKeys, inbox, registry, executor, now };
}
```

- [ ] **Step 37: Run it and watch it pass**

Run: `npx vitest run apps/node-agent/test/inventory.test.ts apps/node-agent/test/pane-ops.test.ts apps/node-agent/test/transcript-file-ops.test.ts apps/node-agent/test/lane-worktree-ops.test.ts`

Expected: PASS, `Tests  34 passed (34)` on Linux. On macOS, which has no `flock(1)`, the pane-lock test is skipped: `33 passed | 1 skipped`.

- [ ] **Step 38: Check the whole task**

Run each command on its own:
- `npx vitest run apps/node-agent/test`. Expected: `Test Files  13 passed (13)` with `Tests  107 passed (107)` on Linux (106 passed and 1 skipped where there is no `flock`).
- `npx tsc -p apps/node-agent`. Expected: no output, exit 0.
- `npx tsc -p tsconfig.tests.json`. Expected: no output, exit 0.
- `npx oxlint --format=stylish apps/node-agent`. Expected: no output.

- [ ] **Step 39: Commit**

```bash
git add apps/node-agent .oxlintrc.json
git commit -m "feat(node-agent): every fleet op on the node's tmux, transcripts, files, lanes and worktrees"
```


### Task 9: Hook relay, durable stream, health and inventory events, `morndo-node run`

**Files:**
- Create: `apps/node-agent/src/relay/spool.ts`, `apps/node-agent/src/relay/relay-files.ts`, `apps/node-agent/src/relay/window-of.ts`, `apps/node-agent/src/relay/server.ts`, `apps/node-agent/src/relay/stream-sender.ts`, `apps/node-agent/src/events.ts`, `apps/node-agent/src/agent.ts`
- Modify: `apps/node-agent/src/main.ts` (adds `run`)
- Test: `apps/node-agent/test/spool.test.ts`, `apps/node-agent/test/relay-server.test.ts`, `apps/node-agent/test/stream.test.ts`, `apps/node-agent/test/agent.test.ts`, `apps/node-agent/test/agent-harness.ts`

**Interfaces:**
- **Consumes:**
  - from Task 1: `LIMITS`, `ERROR_EXECUTED`, and the types `HookEvent`, `Health`, `AgentMessage`, `OpError`;
  - from Tasks 2–3: `healthProbe(home, { tmuxSocket })` (the policy's tmux server, not the default one) and the type `SessionInfo`;
  - from Tasks 6–8: `openAgentDb`, `rotateStreamId`, `FleetConnection` (with `drop()` and `setStreamId()`), `writeStatus`, `formatStatus`, `readStatus`, `createOpsRuntime` (with `room`), `nodeOpener`, `Inventory`, `UploadInbox` (`bytes()`), `agentPaths`, `loadConfig`, `loadNodeKey`, `fleetPublicKey`, and from `test-hooks.ts` `loadTestHooks`, `TestHooksRefused`, `dropOnce` and the type `TestHooks`.
- **Produces:**

```ts
// relay/spool.ts
export type HookPath = HookEvent["path"];
export type SpoolEvent = { path: HookPath; at: number; session: string | null; window: string | null; body: unknown };
export type Stored = { seq: number; at: number; path: HookPath; window: string | null; body: unknown };
export type Appended = { ok: true; seq: number } | { ok: false; why: "full" | "write_failed" };
export const isProgress: (path: string) => boolean;
export class Spool { constructor(db: Database.Database, streamId: string, o?: { maxEvents?: number; maxBytes?: number; now?: () => number; failWrites?: boolean /* spoolFail */;
    held?: () => number /* bytes the relay's copies and the upload inbox hold: they count toward maxBytes */ });
  readonly streamId: string /* a getter */; rotate(streamId: string): void; drops: number; depth(): number; bytes(): number; maxSeq(): number;
  lastSeq(): number /* the highest seq this database ever issued, acknowledged rows included */; dropped(): void;
  append(e: SpoolEvent, within?: (seq: number) => void): Appended; after(seq: number, limit: number): Stored[]; ack(seq: number): void /* throws when it can't write */ }
// relay/relay-files.ts
export type Copied = { ok: true; ref: string; file: string; name: string; size: number } | { ok: false; status: 403 | 404 | 413 | 503 };
export class RelayFiles { constructor(o: { dir: string; db: Database.Database; open: (path: string) => Promise<Opened>; room?: () => number; now?: () => number });
  copy(path: string): Promise<Copied>; bytes(): number; record(c: { ref: string; file: string; name: string; size: number }, seq: number): void; discard(file: string): void; sweep(): number }
// relay/window-of.ts
export function windowResolver(o: { windowOfPane(pane: string): string | null; sessions(): Map<string, SessionInfo> }): (body: unknown) => string | null;
export function cachedFor<T>(ms: number, read: () => T, now?: () => number): () => T;
// relay/server.ts
export const HOOK_BODY_MAX = 448 * 1024; export type Relay = { port: number; close(): Promise<void> };
export function startRelay(d: { port: number; host?: string; spool: Spool; files: RelayFiles; windowOf: (body: unknown) => string | null;
  onAppended: () => void; log: Logger; now?: () => number }): Promise<Relay>;
// relay/stream-sender.ts
export class StreamSender { constructor(o: { spool: Spool; node: string; send: (m: AgentMessage) => boolean; window?: number; log?: Logger }); readonly inFlight: number;
  online(w: { ackSeq: number; streamKnown: boolean }): void; offline(): void; kick(): void; ack(seq: number): void }   // none of them throws: a spool it can't write is logged
// events.ts
export class EventLoops { constructor(o: { inventory: Inventory; send: (m: AgentMessage) => boolean; health: () => Promise<Health>; log: Logger; pollMs?: number; healthMs?: number });
  start(): void; online(): void; offline(): void; stop(): void }
// agent.ts
export type RunningAgent = { instanceId: string; readonly streamId: string /* rotated for a restored database */; relayPort: number; inventory: Inventory; spool: Spool; status(): AgentStatus; stop(): Promise<void> };
export function startAgent(o: { config: AgentConfig; log: Logger; hooks?: TestHooks; instanceId?: string; retry?: RetryOptions; pingTimeoutMs?: number;
  pollMs?: number; healthMs?: number; statusMs?: number; diskBudgetBytes?: number /* LIMITS.spoolMaxBytes; a test's smaller one */ }): Promise<RunningAgent>;
// main.ts `run`: loadTestHooks(process.env, { home, accountHome: os.userInfo().homedir }) before anything else; refused → the reason on
// stderr, exit 78; active hooks → one warning naming each; then startAgent({ config, log, hooks }).
```

- [ ] **Step 1: Create `apps/node-agent/test/spool.test.ts`**

The failing test for the durable spool: coalescing, caps, cumulative acks, a database that refuses writes, and the same failure on purpose (the test hook `spoolFail`).

```ts
// The durable hook stream (spec §5.4, §5.5): coalescing, caps (the relay's copies and the upload inbox included),
// cumulative acks, counters that survive a restart, and a database that can't be written.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAgentDb, type AgentDb } from "../src/db/open.ts";
import { Spool, type SpoolEvent } from "../src/relay/spool.ts";
import { tempHome } from "./helpers.ts";

const open: { adb: AgentDb; cleanup: () => void }[] = [];
afterEach(() => { for (const o of open.splice(0)) { o.adb.close(); o.cleanup(); } });
function db() {
  const h = tempHome();
  const adb = openAgentDb(join(h.home, "agent.db"));
  open.push({ adb, cleanup: h.cleanup });
  return adb;
}
const ev = (path: SpoolEvent["path"], session: string | null, body: unknown): SpoolEvent => ({ path, at: 1000, session, window: null, body });

describe("the spool", () => {
  it("keeps the latest progress event per session and every kept event, with growing seqs", () => {
    const adb = db();
    const s = new Spool(adb.db, adb.streamId);
    expect(s.append(ev("/cc", "a", { n: 1 }))).toEqual({ ok: true, seq: 1 });
    expect(s.append(ev("/notify", "a", { n: 2 }))).toEqual({ ok: true, seq: 2 });
    expect(s.append(ev("/cc", "a", { n: 3 }))).toEqual({ ok: true, seq: 3 });       // replaces seq 1
    expect(s.append(ev("/cc", "b", { n: 4 }))).toEqual({ ok: true, seq: 4 });
    expect(s.append(ev("/sl", "a", { n: 5 }))).toEqual({ ok: true, seq: 5 });       // /sl coalesces apart from /cc
    expect(s.after(0, 10).map(e => [e.seq, e.path, e.body])).toEqual([
      [2, "/notify", { n: 2 }], [3, "/cc", { n: 3 }], [4, "/cc", { n: 4 }], [5, "/sl", { n: 5 }],
    ]);
    expect(s.depth()).toBe(4);
  });
  it("drops progress at the cap, evicts the oldest progress for a kept event, and refuses a kept event only when that isn't enough", () => {
    const adb = db();
    const s = new Spool(adb.db, adb.streamId, { maxEvents: 3 });
    s.append(ev("/cc", "a", 1));
    s.append(ev("/notify", null, 2));
    s.append(ev("/hook/stop", null, 3));
    expect(s.append(ev("/sl", "b", 4))).toEqual({ ok: false, why: "full" });       // progress: dropped
    expect(s.drops).toBe(1);
    expect(s.append(ev("/notify", null, 5))).toMatchObject({ ok: true });         // evicts the /cc
    expect(s.after(0, 10).map(e => e.body)).toEqual([2, 3, 5]);
    expect(s.append(ev("/notify", null, 6))).toEqual({ ok: false, why: "full" }); // nothing left to evict
    expect(s.drops).toBe(2);
    const bytes = new Spool(adb.db, adb.streamId, { maxBytes: 10 });
    expect(bytes.append(ev("/notify", null, "x".repeat(20)))).toEqual({ ok: false, why: "full" });
  });
  it("counts what the relay's copies and the upload inbox hold toward its byte budget", () => {
    const adb = db();
    let held = 90;
    const s = new Spool(adb.db, adb.streamId, { maxBytes: 100, held: () => held });
    expect(s.append(ev("/notify", null, "x".repeat(20)))).toEqual({ ok: false, why: "full" });   // 22 bytes + 90 held > 100
    held = 0;
    expect(s.append(ev("/notify", null, "x".repeat(20)))).toMatchObject({ ok: true });            // negative control
  });
  it("deletes up to an acknowledged seq, marks the relay copies those events carried, and recounts after a restart", () => {
    const adb = db();
    const s = new Spool(adb.db, adb.streamId, { now: () => 5000 });
    s.append(ev("/notify", null, 1));
    s.append(ev("/file", null, { ref: "r" }), seq => {
      adb.db.prepare("INSERT INTO relay_files (ref, file, name, size, at, seq) VALUES ('r', '/x', 'n', 1, 1, ?)").run(seq);
    });
    s.append(ev("/notify", null, 3));
    s.ack(2);
    expect(s.after(0, 10).map(e => e.seq)).toEqual([3]);
    expect(adb.db.prepare("SELECT acked_at FROM relay_files WHERE ref = 'r'").get()).toEqual({ acked_at: 5000 });
    const again = new Spool(adb.db, adb.streamId);
    expect(again.depth()).toBe(1);
    expect(again.maxSeq()).toBe(3);
    again.ack(3);
    expect([again.depth(), again.maxSeq(), again.lastSeq()]).toEqual([0, 0, 3]);   // lastSeq: the highest ever issued
  });
  it("counts what it can't write when the database refuses writes (a full disk)", () => {
    const adb = db();
    const s = new Spool(adb.db, adb.streamId);
    adb.db.pragma("query_only = ON");
    expect(s.append(ev("/hook/stop", null, 1))).toEqual({ ok: false, why: "write_failed" });
    expect(s.append(ev("/cc", "a", 2))).toEqual({ ok: false, why: "write_failed" });
    expect(s.drops).toBe(2);
    expect(s.depth()).toBe(0);
    adb.db.pragma("query_only = OFF");
    expect(s.append(ev("/hook/stop", null, 3))).toMatchObject({ ok: true });     // negative control
  });
  it("fails every write the same way when told to (the spoolFail test hook), acks included", () => {
    const adb = db();
    const s = new Spool(adb.db, adb.streamId, { failWrites: true });
    expect(s.append(ev("/hook/stop", null, 1))).toEqual({ ok: false, why: "write_failed" });
    expect(s.append(ev("/cc", "a", 2))).toEqual({ ok: false, why: "write_failed" });
    expect(s.drops).toBe(2);
    expect(() => s.ack(1)).toThrow(/spoolFail/);
    expect(new Spool(adb.db, adb.streamId).depth()).toBe(0);
  });
  it("starts sending under a new stream id after rotate()", () => {
    const adb = db();
    const s = new Spool(adb.db, adb.streamId);
    const next = randomUUID();
    s.rotate(next);
    expect(s.streamId).toBe(next);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run apps/node-agent/test/spool.test.ts`

Expected: FAIL, `Error: Cannot find module '../src/relay/spool.ts'`.

- [ ] **Step 3: Create `apps/node-agent/src/relay/spool.ts`**

```ts
// The durable hook stream (spec §5.4, §5.5): every hook the relay accepts is committed here (synchronous=FULL) before
// it is answered, and stays until the fleet acknowledges it.
// - `seq` comes from an AUTOINCREMENT key, so it only grows within a stream, never repeats, and may have gaps:
//   coalescing deletes superseded rows. The fleet records the highest seq it accepted.
// - /cc and /sl are progress, coalesced to the latest per session: a new one replaces the unacknowledged one before it.
// - Caps (LIMITS.spoolMaxEvents, spoolMaxBytes): at the cap a progress event is dropped; a kept event first evicts the
//   oldest progress events, and is refused only when that isn't enough. The byte cap is the node's whole disk budget:
//   what the relay's copies and the upload inbox hold (`held`) counts toward it too.
// - Every event that couldn't be spooled (full, or the write failed) counts in `drops`, which health reports.
// - `failWrites` (the test hook spoolFail) makes every write fail the way a write to a full disk does: append answers
//   write_failed, ack throws (its callers, stream-sender.ts, log it and go on).
// - The stream id is the database's (meta); rotate() moves to a new one (agent.ts, for a restored database).
import type Database from "better-sqlite3";
import { LIMITS, type HookEvent } from "@morndo/protocol";

export type HookPath = HookEvent["path"];
export type SpoolEvent = { path: HookPath; at: number; session: string | null; window: string | null; body: unknown };
export type Stored = { seq: number; at: number; path: HookPath; window: string | null; body: unknown };
export type Appended = { ok: true; seq: number } | { ok: false; why: "full" | "write_failed" };

export const isProgress = (path: string): boolean => path === "/cc" || path === "/sl";

export class Spool {
  #streamId: string;
  #db: Database.Database;
  #maxEvents: number;
  #maxBytes: number;
  #now: () => number;
  #failWrites: boolean;
  #held: () => number;
  #count = 0;
  #bytes = 0;
  drops = 0;

  constructor(db: Database.Database, streamId: string, o: { maxEvents?: number; maxBytes?: number; now?: () => number; failWrites?: boolean; held?: () => number } = {}) {
    this.#db = db;
    this.#streamId = streamId;
    this.#maxEvents = o.maxEvents ?? LIMITS.spoolMaxEvents;
    this.#maxBytes = o.maxBytes ?? LIMITS.spoolMaxBytes;
    this.#now = o.now ?? Date.now;
    this.#failWrites = o.failWrites === true;
    this.#held = o.held ?? (() => 0);
    const r = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM stream").get() as { n: number; b: number };
    this.#count = r.n;
    this.#bytes = r.b;
  }

  get streamId(): string { return this.#streamId; }
  rotate(streamId: string): void { this.#streamId = streamId; }
  depth(): number { return this.#count; }
  bytes(): number { return this.#bytes; }
  maxSeq(): number { return (this.#db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM stream").get() as { m: number }).m; }
  // The highest seq this database ever issued, acknowledged (deleted) rows included: AUTOINCREMENT keeps it in
  // sqlite_sequence (https://www.sqlite.org/autoinc.html, read 2026-10-06).
  lastSeq(): number {
    return (this.#db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'stream'").get() as { seq: number } | undefined)?.seq ?? 0;
  }

  // Counted without spooling (a progress body too large to keep, say).
  dropped(): void { this.drops++; }

  // Commits the event; `within(seq)` runs in the same transaction (the relay records its file copy there).
  append(e: SpoolEvent, within?: (seq: number) => void): Appended {
    const body = JSON.stringify(e.body ?? null);
    const size = Buffer.byteLength(body);
    const coalesce = isProgress(e.path) ? `${e.path}\n${e.session ?? ""}` : null;
    try {
      if (this.#failWrites) throw new Error("the test hook spoolFail refuses every spool write");
      const out = this.#db.transaction((): Appended => {
        let count = this.#count, bytes = this.#bytes;
        if (coalesce !== null) {
          const old = this.#db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM stream WHERE coalesce_key = ?").get(coalesce) as { n: number; b: number };
          if (old.n) {
            this.#db.prepare("DELETE FROM stream WHERE coalesce_key = ?").run(coalesce);
            count -= old.n;
            bytes -= old.b;
          }
        }
        const held = this.#held();
        const full = () => count + 1 > this.#maxEvents || bytes + held + size > this.#maxBytes;
        if (full() && coalesce !== null) return { ok: false, why: "full" };
        while (full()) {
          const victim = this.#db.prepare("SELECT seq, size FROM stream WHERE coalesce_key IS NOT NULL ORDER BY seq LIMIT 1").get() as { seq: number; size: number } | undefined;
          if (!victim) return { ok: false, why: "full" };
          this.#db.prepare("DELETE FROM stream WHERE seq = ?").run(victim.seq);
          count -= 1;
          bytes -= victim.size;
        }
        const seq = Number(this.#db.prepare("INSERT INTO stream (at, path, session, window, coalesce_key, body, size) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(e.at, e.path, e.session, e.window, coalesce, body, size).lastInsertRowid);
        within?.(seq);
        this.#count = count + 1;
        this.#bytes = bytes + size;
        return { ok: true, seq };
      }).immediate();
      if (!out.ok) this.drops++;
      return out;
    } catch {
      this.drops++;
      return { ok: false, why: "write_failed" };
    }
  }

  // Events after `seq`, oldest first.
  after(seq: number, limit: number): Stored[] {
    return (this.#db.prepare("SELECT seq, at, path, window, body FROM stream WHERE seq > ? ORDER BY seq LIMIT ?").all(seq, limit) as
      { seq: number; at: number; path: HookPath; window: string | null; body: string }[])
      .map(r => ({ seq: r.seq, at: r.at, path: r.path, window: r.window, body: JSON.parse(r.body) as unknown }));
  }

  // A cumulative acknowledgement: everything up to `seq` is the fleet's now. Relay copies those events carried start
  // their 24 hours. Throws when the database can't be written.
  ack(seq: number): void {
    if (this.#failWrites) throw new Error("the test hook spoolFail refuses every spool write");
    this.#db.transaction(() => {
      const gone = this.#db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM stream WHERE seq <= ?").get(seq) as { n: number; b: number };
      this.#db.prepare("UPDATE relay_files SET acked_at = ? WHERE seq <= ? AND acked_at IS NULL").run(this.#now(), seq);
      this.#db.prepare("DELETE FROM stream WHERE seq <= ?").run(seq);
      this.#count -= gone.n;
      this.#bytes -= gone.b;
    }).immediate();
  }
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run apps/node-agent/test/spool.test.ts`

Expected: PASS, `Tests  7 passed (7)`.

- [ ] **Step 5: Create `apps/node-agent/test/relay-server.test.ts`**

The failing relay test over real HTTP. It covers each path's answer from spec §5.5, window identity, coalescing, and `/file` copies with their deletion 24 h after the ack. It also simulates a full disk: the database refuses writes (`PRAGMA query_only`), and `/cc` must still answer 204 while `/hook/stop` answers 503.

```ts
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
  const sessions = new Map([["%7", { sessionId: "sess-web", name: null, pane: "%7", cwd: "/w", version: null, pid: 1 }]]);
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
```

- [ ] **Step 6: Run it and watch it fail**

Run: `npx vitest run apps/node-agent/test/relay-server.test.ts`

Expected: FAIL, `Error: Cannot find module '../src/relay/relay-files.ts'`.

- [ ] **Step 7: Create `apps/node-agent/src/relay/relay-files.ts`**

```ts
// The hook relay's copies of files a lane sends with /file (spec §5.5): the named file is opened under today's
// confinement rules (node-files.ts' opener: O_NOFOLLOW after the check), copied from that open handle into
// ~/.local/state/morndo-node/relay-files/<ref>, 0600, and the event carries { ref, name, size } for the fleet to fetch
// with file.get. What the copies hold counts toward the node's disk budget (LIMITS.spoolMaxBytes, with the spool and
// the upload inbox): a copy that doesn't fit in `room` is refused (503, so the script's own fallback runs). A copy is
// deleted 24 hours after its event was acknowledged (LIMITS.relayFileKeepMs); a copy no event ever took (a crash
// between copy and commit) goes after 24 hours too.
import { randomBytes } from "node:crypto";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type Database from "better-sqlite3";
import { LIMITS } from "@morndo/protocol";
import type { Opened } from "../ops/node-files.ts";

export type Copied = { ok: true; ref: string; file: string; name: string; size: number } | { ok: false; status: 403 | 404 | 413 | 503 };

export class RelayFiles {
  #dir: string;
  #db: Database.Database;
  #open: (path: string) => Promise<Opened>;
  #room: () => number;
  #now: () => number;

  constructor(o: { dir: string; db: Database.Database; open: (path: string) => Promise<Opened>; room?: () => number; now?: () => number }) {
    this.#dir = o.dir;
    this.#db = o.db;
    this.#open = o.open;
    this.#room = o.room ?? (() => Number.POSITIVE_INFINITY);
    this.#now = o.now ?? Date.now;
  }

  async copy(path: string): Promise<Copied> {
    const c = await this.#open(path);
    if (!c.ok) return { ok: false, status: c.reason === "too_large" ? 413 : c.reason === "missing" ? 404 : 403 };
    try {
      if (c.size > this.#room()) return { ok: false, status: 503 };          // the disk budget is full
      mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
      const ref = randomBytes(16).toString("hex");
      const file = join(this.#dir, ref);
      const tmp = `${file}.tmp`;
      try {
        await pipeline(c.fh.createReadStream({ start: 0, autoClose: false }), createWriteStream(tmp, { mode: 0o600 }));
        chmodSync(tmp, 0o600);
        const size = statSync(tmp).size;
        if (size > LIMITS.maxFileBytes) { rmSync(tmp, { force: true }); return { ok: false, status: 413 }; }   // it grew meanwhile
        renameSync(tmp, file);
        return { ok: true, ref, file, name: basename(path), size };
      } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
      }
    } finally {
      await c.fh.close();
    }
  }

  // What the copies hold, for the disk budget.
  bytes(): number {
    return (this.#db.prepare("SELECT COALESCE(SUM(size), 0) AS b FROM relay_files").get() as { b: number }).b;
  }

  // Inside the spool's transaction: the copy belongs to the event `seq`.
  record(c: { ref: string; file: string; name: string; size: number }, seq: number): void {
    this.#db.prepare("INSERT INTO relay_files (ref, file, name, size, at, seq) VALUES (?, ?, ?, ?, ?, ?)").run(c.ref, c.file, c.name, c.size, this.#now(), seq);
  }

  discard(file: string): void { rmSync(file, { force: true }); }

  sweep(): number {
    const before = this.#now() - LIMITS.relayFileKeepMs;
    const old = this.#db.prepare("SELECT ref, file FROM relay_files WHERE acked_at IS NOT NULL AND acked_at < ?").all(before) as { ref: string; file: string }[];
    for (const r of old) rmSync(r.file, { force: true });
    this.#db.prepare("DELETE FROM relay_files WHERE acked_at IS NOT NULL AND acked_at < ?").run(before);
    let removed = old.length;
    if (existsSync(this.#dir)) {
      const known = new Set((this.#db.prepare("SELECT ref FROM relay_files").all() as { ref: string }[]).map(r => r.ref));
      for (const f of readdirSync(this.#dir)) {
        const p = join(this.#dir, f);
        try {
          if (!known.has(f.replace(/\.tmp$/, "")) && statSync(p).mtimeMs < before) { rmSync(p, { force: true }); removed++; }
        } catch { /* gone meanwhile */ }
      }
    }
    return removed;
  }
}
```

- [ ] **Step 8: Create `apps/node-agent/src/relay/window-of.ts`**

```ts
// Which window a hook came from (spec §5.5, "Identity in each event"): the pane named by TMUX_PANE in its body, else the
// pane its session_id runs in (the session registry), and then that pane's window in the latest inventory. Null when
// neither leads anywhere.
import type { SessionInfo } from "@morndo/node-ops";

export function windowResolver(o: { windowOfPane(pane: string): string | null; sessions(): Map<string, SessionInfo> }): (body: unknown) => string | null {
  return body => {
    if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
    const b = body as Record<string, unknown>;
    if (typeof b.TMUX_PANE === "string" && /^%\d{1,9}$/.test(b.TMUX_PANE)) return o.windowOfPane(b.TMUX_PANE);
    if (typeof b.session_id === "string") {
      for (const [pane, s] of o.sessions()) if (s.sessionId === b.session_id) return o.windowOfPane(pane);
    }
    return null;
  };
}

// The registry read at most once per `ms`: /sl arrives often, and each read lists ~/.claude/sessions.
export function cachedFor<T>(ms: number, read: () => T, now: () => number = () => performance.now()): () => T {
  let at = -Infinity;
  let value: T | undefined;
  return () => {
    if (value === undefined || now() - at >= ms) { value = read(); at = now(); }
    return value;
  };
}
```

- [ ] **Step 9: Create `apps/node-agent/src/relay/server.ts`**

```ts
// The hook relay on 127.0.0.1:<relayPort> (8787; spec §5.5, ADR-0012 decision 8). Claude Code's HTTP hooks and the box's
// hook scripts POST here on every node, so settings.json is the same everywhere. Every answer goes out after the event
// is committed to the durable stream (spool.ts) and before any network I/O:
// - /cc and /sl (progress, coalesced to the latest per session): always 204 with no body, also when the spool can't be
//   written or the body is too big, because an HTTP hook's answer is read by Claude Code and a slow one stalls the
//   session (spec §1, hooks docs checked 2026-10-06);
// - /hook/stop: 200 {"ok":true,"queued":true}; /hook/failure, /notify and /file: 202; when the spool can't be written
//   they answer 503, so the calling script's own fallback runs;
// - /file {path, …}: the file is copied under today's confinement rules into relay-files and the event carries
//   {…, ref, name, size} instead of the path; 413 over 25 MiB, 403 where files are never shared, 404 when missing, 503
//   when the node's disk budget can't hold the copy (counted as a drop, like a spool that can't be written).
// A body is JSON when it parses, else kept as text. Bodies over 448 KiB are refused (413) or, for progress, dropped, so
// an event always fits one 512 KiB message. A request carrying an Origin header comes from a web page, never from a
// hook: the script paths refuse it (403) and progress drops it, so a page in the owner's browser can't post hooks.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isAbsolute } from "node:path";
import type { Logger } from "../log.ts";
import type { RelayFiles } from "./relay-files.ts";
import { isProgress, type Appended, type Spool } from "./spool.ts";

export const HOOK_BODY_MAX = 448 * 1024;
const KEPT = new Set(["/hook/stop", "/hook/failure", "/notify", "/file"]);

export type RelayDeps = {
  port: number;
  host?: string;
  spool: Spool;
  files: RelayFiles;
  windowOf: (body: unknown) => string | null;
  onAppended: () => void;
  log: Logger;
  now?: () => number;
};
export type Relay = { port: number; close(): Promise<void> };

async function readBody(req: IncomingMessage, max: number): Promise<Buffer | "too_large"> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    if (size <= max) chunks.push(b);
  }
  return size > max ? "too_large" : Buffer.concat(chunks);
}

function parse(raw: Buffer): unknown {
  const text = raw.toString("utf8");
  if (!text.trim()) return null;
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

const field = (body: unknown, name: string): unknown =>
  (body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>)[name] : undefined);

export async function startRelay(d: RelayDeps): Promise<Relay> {
  const now = d.now ?? Date.now;
  const after = () => setImmediate(d.onAppended);
  const answer = (res: ServerResponse, status: number, headers: Record<string, string> = {}) => { res.writeHead(status, headers).end(); };

  const handle = async (req: IncomingMessage, res: ServerResponse, path: string) => {
    if (isProgress(path)) {
      const raw = req.headers.origin !== undefined ? "too_large" as const : await readBody(req, HOOK_BODY_MAX);
      const body = raw === "too_large" ? undefined : parse(raw);
      if (body === undefined || Buffer.byteLength(JSON.stringify(body)) > HOOK_BODY_MAX) d.spool.dropped();
      else {
        const session = field(body, "session_id");
        d.spool.append({ path: path as "/cc" | "/sl", at: now(), session: typeof session === "string" ? session : null, window: d.windowOf(body), body });
      }
      answer(res, 204);
      after();
      return;
    }
    if (!KEPT.has(path)) { answer(res, 404); return; }
    if (req.method !== "POST") { answer(res, 405, { Allow: "POST" }); return; }
    if (req.headers.origin !== undefined) { answer(res, 403); return; }
    const raw = await readBody(req, HOOK_BODY_MAX);
    if (raw === "too_large") { answer(res, 413); return; }
    let body = parse(raw);
    if (Buffer.byteLength(JSON.stringify(body)) > HOOK_BODY_MAX) { answer(res, 413); return; }
    const session = field(body, "session_id");
    const event = { path: path as "/hook/stop" | "/hook/failure" | "/notify" | "/file", at: now(), session: typeof session === "string" ? session : null, window: d.windowOf(body) };
    let appended: Appended;
    if (path === "/file") {
      const target = field(body, "path");
      if (typeof target !== "string" || !isAbsolute(target)) { answer(res, 400); return; }
      let copied: Awaited<ReturnType<RelayFiles["copy"]>>;
      try { copied = await d.files.copy(target); }
      catch (e) { d.log.warn("the relay could not copy a file", e); d.spool.dropped(); answer(res, 503); return; }
      if (!copied.ok) {
        if (copied.status === 503) d.spool.dropped();
        answer(res, copied.status);
        return;
      }
      const c = copied;
      const { path: _local, ...rest } = body as Record<string, unknown>;
      body = { ...rest, ref: c.ref, name: c.name, size: c.size };
      appended = d.spool.append({ ...event, body }, seq => d.files.record(c, seq));
      if (!appended.ok) d.files.discard(c.file);
    } else {
      appended = d.spool.append({ ...event, body });
    }
    if (!appended.ok) { answer(res, 503); return; }
    if (path === "/hook/stop") res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true,"queued":true}');
    else answer(res, 202);
    after();
  };

  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    handle(req, res, path).catch((e: unknown) => {
      d.log.error(`the hook relay failed on ${path.slice(0, 40)}`, e);
      if (!res.headersSent) answer(res, isProgress(path) ? 204 : 503);
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(d.port, d.host ?? "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : d.port,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}
```

- [ ] **Step 10: Run it and watch it pass**

Run: `npx vitest run apps/node-agent/test/relay-server.test.ts`

Expected: PASS, `Tests  10 passed (10)`.

- [ ] **Step 11: Commit**

```bash
git add apps/node-agent
git commit -m "feat(node-agent): hook relay with a durable, coalescing spool and relay file copies"
```

- [ ] **Step 12: Create `apps/node-agent/test/agent-harness.ts`**

This harness starts a whole agent on a temporary HOME. The agent joins the fake fleet through `join`, as an owner would, and gets a random relay port and an isolated tmux socket.

```ts
// A whole agent on a temporary HOME: joined to a scripted fake fleet (through `join`, as an owner would), its relay on
// a random port, its tmux an isolated server, with short intervals so the tests run fast.
import { join as joinPath } from "node:path";
import { startAgent, type RunningAgent } from "../src/agent.ts";
import { loadConfig, type AgentConfig } from "../src/config.ts";
import { join } from "../src/join.ts";
import { writeFileAtomic } from "../src/atomic-write.ts";
import { agentPaths } from "../src/paths.ts";
import type { TestHooks } from "../src/test-hooks.ts";
import type { FakeFleet } from "./fake-fleet.ts";
import { captureLog } from "./helpers.ts";

export async function joinedConfig(home: string, fleet: FakeFleet, socket: string): Promise<AgentConfig> {
  await join({ home, joinString: fleet.joinString("pc") });
  const paths = agentPaths(home);
  const stored = loadConfig(home);
  writeFileAtomic(paths.configFile, JSON.stringify({ node: stored.node, fleetUrl: stored.fleetUrl, fleetKey: stored.fleetKey, keyPath: stored.keyPath, dbPath: stored.dbPath, relayPort: 0 }));
  writeFileAtomic(paths.policyFile, JSON.stringify({ tmuxSocket: socket }));
  return loadConfig(home);
}

export async function runAgent(config: AgentConfig, o: { pollMs?: number; healthMs?: number; instanceId?: string; hooks?: TestHooks; diskBudgetBytes?: number } = {}) {
  const logged = captureLog();
  const agent: RunningAgent = await startAgent({
    config, log: logged.log, retry: { baseMs: 20, capMs: 100 }, pollMs: o.pollMs ?? 100, healthMs: o.healthMs ?? 200, statusMs: 100,
    ...(o.instanceId ? { instanceId: o.instanceId } : {}),
    ...(o.hooks ? { hooks: o.hooks } : {}),
    ...(o.diskBudgetBytes !== undefined ? { diskBudgetBytes: o.diskBudgetBytes } : {}),
  });
  const post = (path: string, body: unknown) =>
    fetch(`http://127.0.0.1:${agent.relayPort}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { agent, post, lines: logged.lines };
}

export const dbFiles = (config: AgentConfig) => [config.dbPath, `${config.dbPath}-wal`, `${config.dbPath}-shm`, joinPath(config.dbPath, "..", "status.json")];
```

- [ ] **Step 13: Create `apps/node-agent/test/stream.test.ts`**

The failing stream test (spec §9 "Stream"). After a reconnect, events must replay in order, replayed progress must carry the late marker, and new events must come after the replay. The window must hold at most 256 events. A reset database must start a new stream, and the fleet's `ackSeq` for an unknown stream must not make it skip events.

```ts
// The hook stream against a scripted fake fleet (spec §5.4, §9 "Stream"): replay from ackSeq + 1 before anything new,
// a window of 256 unacknowledged events, deletion on cumulative ack, late markers on replayed progress, a reset
// database that starts a new stream, a restored one (behind what the fleet accepted) that starts a new stream too, and
// a stream sender that never throws when its acks can't be written (a full disk must not crash the agent).
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "@morndo/protocol";
import type { AgentConfig } from "../src/config.ts";
import { openAgentDb } from "../src/db/open.ts";
import { Spool, type SpoolEvent } from "../src/relay/spool.ts";
import { StreamSender } from "../src/relay/stream-sender.ts";
import { startFakeFleet, type FakeFleet, type Msg } from "./fake-fleet.ts";
import { dbFiles, joinedConfig, runAgent } from "./agent-harness.ts";
import { captureLog, isolatedTmux, tempHome, until, type TestTmux } from "./helpers.ts";

let fleet: FakeFleet;
let home: { home: string; cleanup: () => void };
let t: TestTmux;
let config: AgentConfig;
const stops: (() => Promise<void>)[] = [];
beforeEach(async () => {
  fleet = await startFakeFleet();
  home = tempHome();
  t = isolatedTmux();
  config = await joinedConfig(home.home, fleet, t.socket);
});
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  await fleet.close();
  t.kill();
  home.cleanup();
});

type Hook = { streamId: string; seq: number; at: number; path: string; node: string; window: string | null; late?: true; body: unknown };
const hooks = (from = 0): Hook[] => fleet.received.slice(from).filter(r => r.msg.t === "ev.hook").map(r => (r.msg as Msg & { event: Hook }).event);

async function offlineAgent() {
  fleet.script.hello = 1011;                                            // the fleet turns the agent away for now
  const before = fleet.connections();
  const run = await runAgent(config);
  stops.push(() => run.agent.stop());
  expect(await until(() => fleet.connections() > before)).toBe(true);
  return run;
}

describe("replay after a reconnect", () => {
  it("sends from ackSeq + 1 in order, replayed progress marked late with its original time, then new events", async () => {
    const { agent, post } = await offlineAgent();
    for (let i = 1; i <= 5; i++) expect((await post("/notify", { n: i })).status).toBe(202);
    expect((await post("/cc", { session_id: "s", n: "old" })).status).toBe(204);
    expect((await post("/cc", { session_id: "s", n: "latest" })).status).toBe(204);      // replaces the one before
    expect(agent.spool.depth()).toBe(6);
    const cut = fleet.received.length;
    fleet.script.welcome = { connEpoch: 2, ackSeq: 2, streamKnown: true };
    fleet.script.hello = "challenge";
    expect(await until(() => hooks(cut).length === 4, 5000)).toBe(true);
    const replayed = hooks(cut);
    expect(replayed.map(e => e.seq)).toEqual([3, 4, 5, 7]);
    expect(replayed.map(e => e.body)).toEqual([{ n: 3 }, { n: 4 }, { n: 5 }, { session_id: "s", n: "latest" }]);
    expect(replayed.map(e => e.late ?? false)).toEqual([false, false, false, true]);
    expect(replayed.every(e => e.node === "pc" && e.streamId === agent.streamId)).toBe(true);
    expect(agent.spool.depth()).toBe(4);                                 // 1 and 2 were acknowledged by the welcome
    expect((await post("/notify", { n: "new" })).status).toBe(202);
    expect(await until(() => hooks(cut).length === 5)).toBe(true);
    expect(hooks(cut)[4]).toMatchObject({ seq: 8, body: { n: "new" } });
    expect(hooks(cut)[4]?.late).toBeUndefined();
    fleet.send({ t: "ack", streamId: agent.streamId, seq: 8 });
    expect(await until(() => agent.spool.depth() === 0)).toBe(true);
  });

  it("keeps at most 256 events unacknowledged in flight, and sends more as acks arrive", async () => {
    const { agent, post } = await offlineAgent();
    for (let i = 1; i <= 300; i++) await post("/notify", { n: i });
    const cut = fleet.received.length;
    fleet.script.welcome = { connEpoch: 2, ackSeq: 0, streamKnown: true };
    fleet.script.hello = "challenge";
    expect(await until(() => hooks(cut).length === 256)).toBe(true);
    await new Promise(r => setTimeout(r, 300));
    expect(hooks(cut)).toHaveLength(256);                                  // the window is full
    fleet.send({ t: "ack", streamId: agent.streamId, seq: 100 });
    expect(await until(() => hooks(cut).length === 300)).toBe(true);
    expect(hooks(cut).map(e => e.seq)).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
    expect(agent.spool.depth()).toBe(200);
  });

  it("ignores an ack for another stream", async () => {
    fleet.script.welcome = { connEpoch: 1, ackSeq: 0, streamKnown: true };
    const { agent, post } = await runAgent(config);
    stops.push(() => agent.stop());
    await post("/notify", { n: 1 });
    expect(await until(() => hooks().length === 1)).toBe(true);
    fleet.send({ t: "ack", streamId: randomUUID(), seq: 1 });
    await new Promise(r => setTimeout(r, 200));
    expect(agent.spool.depth()).toBe(1);
  });
});

describe("a reset database (spec §7 \"Agent database lost or reinstalled\")", () => {
  it("starts a new stream: a new streamId in hello, and the fleet's ackSeq for an unknown stream doesn't skip events", async () => {
    const first = await runAgent(config);
    expect(await until(() => fleet.received.some(r => r.msg.t === "hello"))).toBe(true);
    const oldStream = first.agent.streamId;
    await first.agent.stop();
    for (const f of dbFiles(config)) rmSync(f, { force: true });
    fleet.script.hello = 1011;
    const second = await runAgent(config);
    stops.push(() => second.agent.stop());
    expect(second.agent.streamId).not.toBe(oldStream);
    await second.post("/notify", { n: "after reset" });
    const cut = fleet.received.length;
    fleet.script.welcome = { connEpoch: 3, ackSeq: 50, streamKnown: false };
    fleet.script.hello = "challenge";
    expect(await until(() => hooks(cut).length === 1)).toBe(true);
    expect(hooks(cut)[0]).toMatchObject({ seq: 1, streamId: second.agent.streamId, body: { n: "after reset" } });
    expect(fleet.received.filter(r => r.msg.t === "hello").at(-1)?.msg.streamId).toBe(second.agent.streamId);
  });
});

describe("a restored database (its stream behind what the fleet accepted)", () => {
  it("starts a new stream, so the fleet never takes its next events for ones it already has; the new id is kept", async () => {
    const before = openAgentDb(config.dbPath);
    const oldStream = before.streamId;
    before.close();
    fleet.script.streams = { [oldStream]: 50 };                          // the fleet accepted up to 50; this database never wrote one
    const { agent, post } = await runAgent(config);
    stops.push(() => agent.stop());
    expect(await until(() => fleet.received.filter(r => r.msg.t === "hello").length === 2)).toBe(true);
    const ids = fleet.received.filter(r => r.msg.t === "hello").map(r => r.msg.streamId);
    expect(ids[0]).toBe(oldStream);
    expect(ids[1]).not.toBe(oldStream);
    expect(agent.streamId).toBe(ids[1]);
    await fleet.waitFor(m => m.t === "ev.inventory");
    const cut = fleet.received.length;
    expect((await post("/notify", { n: "after restore" })).status).toBe(202);
    expect(await until(() => hooks(cut).length === 1)).toBe(true);
    expect(hooks(cut)[0]).toMatchObject({ streamId: ids[1], seq: 1, body: { n: "after restore" } });
    await agent.stop();
    stops.length = 0;
    const after = openAgentDb(config.dbPath);
    expect(after.streamId).toBe(ids[1]);                                  // kept: a restart doesn't go back to the old stream
    after.close();
  });
});

describe("the stream sender on a disk that refuses writes", () => {
  const ev = (path: SpoolEvent["path"], session: string | null, body: unknown): SpoolEvent => ({ path, at: 1000, session, window: null, body });
  it("never throws: an ack it can't write is logged, the window opens, and sending goes on once the disk takes writes", () => {
    const h = tempHome();
    const adb = openAgentDb(join(h.home, "agent.db"));
    try {
      const spool = new Spool(adb.db, adb.streamId);
      for (let i = 1; i <= 3; i++) spool.append(ev("/notify", null, i));
      const sent: AgentMessage[] = [];
      const logged = captureLog();
      const sender = new StreamSender({ spool, node: "pc", send: m => { sent.push(m); return true; }, window: 3, log: logged.log });
      sender.online({ ackSeq: 0, streamKnown: true });
      expect(sent).toHaveLength(3);
      adb.db.pragma("query_only = ON");                                       // a full disk
      expect(() => sender.ack(3)).not.toThrow();
      expect(() => sender.online({ ackSeq: 2, streamKnown: true })).not.toThrow();
      expect(logged.lines.join("\n")).toMatch(/could not delete acknowledged hook events/);
      adb.db.pragma("query_only = OFF");
      spool.append(ev("/notify", null, 4));
      sender.kick();
      expect(sent.map(m => (m.t === "ev.hook" ? m.event.seq : 0)).slice(-1)).toEqual([4]);
    } finally { adb.close(); h.cleanup(); }
  });
});
```

- [ ] **Step 14: Create `apps/node-agent/test/agent.test.ts`**

The failing whole-agent test. Ops are answered over the connection, each answer with the database's `store`. The full inventory is sent after a welcome, and again on every change. Health events are sent, with `tmuxOk` from the policy's tmux server. A 4409 close is reported by `morndo-node status`, with the next try about 5 minutes away. Done keys older than 7 days are pruned when the agent starts. Acknowledgements the database can't write never take the agent down. The test hooks act over the connection:
- `dropAfterStarted`: the fake fleet sees the socket close and never gets that answer, the op ran, and `op.status` afterwards says `done`;
- with `noDoneKeys` as well, the repeat types again;
- `fixedStreamId` is in `hello`, the hook events and the acks;
- `clockOffsetMs` moves `health.wallClock` and each hook event's `at`;
- with `spoolFail`, `/hook/stop` answers 503 and `/cc` 204.

`morndo-node run` with hooks outside `NODE_ENV=test` exits 78 and says why. Under `NODE_ENV=test` with a throwaway `HOME`, it warns once, naming each hook, and applies them.

```ts
// The whole agent against a scripted fake fleet and an isolated tmux server (spec §5.2–5.4): ops answered over the
// connection (each with the database's store), inventory events (full after welcome, then on change), health events,
// the status a 4409 leaves for `morndo-node status`, housekeeping, a disk that refuses writes, and the test hooks
// (test-hooks.ts) as the agent and `morndo-node run` apply them.
import Database from "better-sqlite3";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIMITS } from "@morndo/protocol";
import type { AgentConfig } from "../src/config.ts";
import { openAgentDb } from "../src/db/open.ts";
import { startFakeFleet, type FakeFleet, type Msg } from "./fake-fleet.ts";
import { joinedConfig, runAgent } from "./agent-harness.ts";
import { isolatedTmux, tempHome, until, wait, type TestTmux } from "./helpers.ts";

const MAIN = join(import.meta.dirname, "..", "src", "main.ts");
const FIXTURE = join(import.meta.dirname, "fake-claude.fixture.ts");
let fleet: FakeFleet;
let home: { home: string; cleanup: () => void };
let t: TestTmux;
let config: AgentConfig;
const stops: (() => Promise<void>)[] = [];
beforeEach(async () => {
  fleet = await startFakeFleet({ welcome: { connEpoch: 4, ackSeq: 0, streamKnown: true } });
  home = tempHome();
  t = isolatedTmux();
  config = await joinedConfig(home.home, fleet, t.socket);
});
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
  await fleet.close();
  t.kill();
  home.cleanup();
});
const of = (type: string, from = 0) => fleet.received.slice(from).filter(r => r.msg.t === type).map(r => r.msg);

describe("over the connection", () => {
  it("sends the full inventory and health after welcome, then inventory again when tmux changes", async () => {
    t.tmux("new-session", "-d", "-s", "main", "-n", "api", "sleep 600");
    const { agent } = await runAgent(config);
    stops.push(() => agent.stop());
    const inv = await fleet.waitFor(m => m.t === "ev.inventory");
    expect(inv).toMatchObject({ v: 1, invVersion: 1, panes: [{ window: "api", workerId: expect.stringMatching(/^pc\.[0-9a-f]{8}\.\d+$/) }] });
    const health = await fleet.waitFor(m => m.t === "ev.health");
    const h = (health as Msg & { health: Record<string, unknown> }).health;
    expect(Object.keys(h).sort()).toEqual(["diskFreeHome", "drops", "load1", "memAvailable", "memTotal", "psiFull10", "psiSome10", "spoolDepth", "tmuxOk", "wallClock"]);
    expect(Math.abs((h.wallClock as number) - Date.now())).toBeLessThan(5000);
    t.tmux("new-window", "-d", "-t", "=main:", "-n", "web", "sleep 600");
    const next = await fleet.waitFor(m => m.t === "ev.inventory" && m.invVersion === 2);
    expect((next.panes as { window: string }[]).map(p => p.window).sort()).toEqual(["api", "web"]);
    await new Promise(r => setTimeout(r, 400));
    expect(of("ev.inventory").filter(m => m.invVersion === 2)).toHaveLength(1);      // sent once, not every poll
  });

  it("asks the policy's tmux server for health (tmuxOk), not the default one", async () => {
    t.tmux("new-session", "-d", "-s", "main", "-n", "api", "sleep 600");
    const { agent } = await runAgent(config);
    stops.push(() => agent.stop());
    expect(await fleet.waitFor(m => m.t === "ev.health")).toMatchObject({ health: { tmuxOk: true } });
    t.kill();
    const from = fleet.received.length;
    expect(await fleet.waitFor(m => m.t === "ev.health" && (m.health as { tmuxOk: boolean }).tmuxOk === false, 5000, from)).toBeTruthy();
  });

  it("answers requests by id: a result, an unknown op, a malformed request", async () => {
    const { agent } = await runAgent(config);
    stops.push(() => agent.stop());
    await fleet.waitFor(m => m.t === "ev.inventory");
    fleet.send({ t: "req", id: "q1", op: "inventory.get", args: {}, timeoutMs: 5000 });
    fleet.send({ t: "req", id: "q2", op: "pane.exec", args: {}, timeoutMs: 5000 });
    fleet.send({ t: "req", id: "q3", op: "pane.send", args: { workerId: "pc.0a1b2c3d.1" }, timeoutMs: 5000, key: "hub:x" });
    // Every answer carries the store: the stream id of the database whose done keys answer for it (plan Contracts, Res).
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "q1")).toMatchObject({ ok: true, result: { panes: [] }, invVersion: 0, store: agent.streamId });
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "q2")).toMatchObject({ ok: false, error: { code: "unknown_op", executed: "no" }, store: agent.streamId });
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "q3")).toMatchObject({ ok: false, error: { code: "bad_args", executed: "no" }, store: agent.streamId });
    fleet.send({ t: "req", id: "q4", op: "op.status", args: { key: "hub:never" }, timeoutMs: 5000 });
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "q4")).toMatchObject({ ok: true, result: { state: "unknown" }, store: agent.streamId });
  });

  it("re-sends the full inventory after a reconnect", async () => {
    t.tmux("new-session", "-d", "-s", "main", "-n", "api", "sleep 600");
    const { agent } = await runAgent(config);
    stops.push(() => agent.stop());
    await fleet.waitFor(m => m.t === "ev.inventory");
    const cut = fleet.received.length;
    fleet.closeAgent(1011, "fleet restart");
    expect(await fleet.waitFor(m => m.t === "ev.inventory", 5000, cut)).toMatchObject({ invVersion: 1, panes: [{ window: "api" }] });
  });
});

describe("status (spec §5.2: a refused second instance shows the conflict)", () => {
  it("after 4409 `morndo-node status` says conflict, and the next try is about 5 minutes away", async () => {
    fleet.script.welcome = 4409;
    const joins = fleet.connections();                                    // the join's own connection
    const second = randomUUID();
    const { agent } = await runAgent(config, { instanceId: second });
    stops.push(() => agent.stop());
    expect(await until(() => agent.status().state === "conflict")).toBe(true);
    const out = await until(() => execFileSync(process.execPath, [MAIN, "status"], { env: { ...process.env, HOME: home.home }, encoding: "utf8" }).includes("conflict"), 3000);
    expect(out).toBe(true);
    const text = execFileSync(process.execPath, [MAIN, "status"], { env: { ...process.env, HOME: home.home }, encoding: "utf8" });
    expect(text).toMatch(/node\s+pc/);
    expect(text).toMatch(/conflict: another agent with this node's key is connected \(4409\)\. This one tries again every 5 minutes/);
    expect(text).toMatch(new RegExp(`instance\\s+${second}`));
    const retry = Number(/retry in\s+(\d+) s/.exec(text)?.[1]);
    expect(retry).toBeGreaterThan(0.8 * LIMITS.conflictRetryMs / 1000 - 10);
    expect(retry).toBeLessThanOrEqual(1.2 * LIMITS.conflictRetryMs / 1000);
    expect(fleet.connections()).toBe(joins + 1);                          // dialed once; the next try is minutes away
  });
});

describe("housekeeping", () => {
  it("prunes done keys older than 7 days when the agent starts (and hourly after)", async () => {
    const adb = openAgentDb(config.dbPath);
    const insert = adb.db.prepare("INSERT INTO done_keys (key, hash, state, outcome, at) VALUES (?, 'h', 'done', '{}', ?)");
    insert.run("hub:old", Date.now() - LIMITS.doneKeyTtlMs - 60_000);
    insert.run("hub:fresh", Date.now());
    adb.close();
    const { agent } = await runAgent(config);
    stops.push(() => agent.stop());
    await fleet.waitFor(m => m.t === "ev.inventory");
    fleet.send({ t: "req", id: "s-old", op: "op.status", args: { key: "hub:old" }, timeoutMs: 5000 });
    fleet.send({ t: "req", id: "s-fresh", op: "op.status", args: { key: "hub:fresh" }, timeoutMs: 5000 });
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "s-old")).toMatchObject({ ok: true, result: { state: "unknown" } });
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "s-fresh")).toMatchObject({ ok: true, result: { state: "done" } });
  });
});

describe("the disk budget: the spool, the relay's copies and the upload inbox together", () => {
  it("refuses a relay copy (503) and an upload chunk (too_large) that what the others hold leaves no room for", async () => {
    const { agent, post } = await runAgent(config, { diskBudgetBytes: 1000 });
    stops.push(() => agent.stop());
    await fleet.waitFor(m => m.t === "ev.inventory");
    mkdirSync(join(home.home, "work"));
    writeFileSync(join(home.home, "work", "a.bin"), Buffer.alloc(700));
    writeFileSync(join(home.home, "work", "b.bin"), Buffer.alloc(400));
    expect((await post("/file", { path: join(home.home, "work", "a.bin") })).status).toBe(202);
    expect((await post("/file", { path: join(home.home, "work", "b.bin") })).status).toBe(503);   // 700 held + 400 > 1000
    fleet.send({ t: "req", id: "up", op: "file.put", args: { upload: "u1", offset: 0, bytes: Buffer.alloc(400).toString("base64"), final: true, name: "x.bin" }, timeoutMs: 5000, key: "hub:up" });
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "up")).toMatchObject({ ok: false, error: { code: "too_large", executed: "no" } });
    fleet.send({ t: "req", id: "up2", op: "file.put", args: { upload: "u2", offset: 0, bytes: Buffer.alloc(50).toString("base64"), final: true, name: "y.bin" }, timeoutMs: 5000, key: "hub:up2" });
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "up2")).toMatchObject({ ok: true });   // negative control: what fits
  });
});

describe("a disk that refuses writes (spoolFail)", () => {
  it("never takes the agent down: a welcome acknowledging events it can't delete is logged, and the agent stays online", async () => {
    fleet.script.welcome = { connEpoch: 4, ackSeq: 3, streamKnown: true };
    const before = openAgentDb(config.dbPath);
    for (let i = 0; i < 3; i++) before.db.prepare("INSERT INTO stream (at, path, body, size) VALUES (1, '/notify', '{}', 2)").run();   // seqs 1–3
    before.close();
    const { agent, lines } = await runAgent(config, { hooks: { spoolFail: true } });
    stops.push(() => agent.stop());
    await fleet.waitFor(m => m.t === "ev.inventory");
    expect(agent.status().state).toBe("online");
    expect(lines.join("\n")).toMatch(/could not delete acknowledged hook events/);
    fleet.send({ t: "ack", streamId: agent.streamId, seq: 3 });
    fleet.send({ t: "req", id: "after", op: "inventory.get", args: {}, timeoutMs: 5000 });
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "after")).toMatchObject({ ok: true });   // still answering
  });
});

describe("test hooks over the connection (test-hooks.ts)", () => {
  // A lane "api" running the stand-in for Claude Code's input box, and what was submitted in it.
  async function claudeLane() {
    const dir = join(home.home, "lane");
    mkdirSync(dir);
    t.tmux("new-session", "-d", "-s", "main", "-n", "api", "-x", "100", "-y", "20", `${process.execPath} ${FIXTURE} ${dir}`);
    expect(await until(() => t.tmux("capture-pane", "-p", "-t", "=main:0").includes("❯"))).toBe(true);
    const file = join(dir, "submitted.jsonl");
    return () => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l) as string) : []);
  }
  const sendReq = (id: string, workerId: string, text: string, key: string) =>
    fleet.send({ t: "req", id, op: "pane.send", args: { workerId, text, expect: { server: workerId.split(".")[1], window: "api" } }, timeoutMs: 10_000, key });
  let n = 0;
  const opStatus = async (key: string) => {
    const id = `status-${++n}`;
    const from = fleet.received.length;
    fleet.send({ t: "req", id, op: "op.status", args: { key }, timeoutMs: 5000 });
    return ((await fleet.waitFor(m => m.t === "res" && m.id === id, 5000, from)).result) as { state: string; outcome?: unknown };
  };
  // Up again: the new connection's full inventory has arrived, so the agent is past its welcome.
  const backOnline = (from: number) => fleet.waitFor(m => m.t === "ev.inventory", 5000, from);

  it("dropAfterStarted: the socket is cut right after started; the op runs on, its answer is never sent, op.status says done", async () => {
    const submitted = await claudeLane();
    const { agent } = await runAgent(config, { hooks: { dropAfterStarted: "drop" } });
    stops.push(() => agent.stop());
    const workerId = ((await fleet.waitFor(m => m.t === "ev.inventory")).panes as { workerId: string }[])[0]?.workerId ?? "";
    const live = fleet.connections();
    const cut = fleet.received.length;
    sendReq("send-1", workerId, "typed once", "hub:drop-1");
    expect(await until(() => fleet.closes.some(c => c.conn === live))).toBe(true);           // the fleet saw the socket go
    expect(await until(() => submitted().length === 1)).toBe(true);                           // the op ran on
    await backOnline(cut);
    let status: { state: string; outcome?: unknown } = { state: "" };
    expect(await until(async () => (status = await opStatus("hub:drop-1")).state === "done", 10_000)).toBe(true);
    expect(status.outcome).toMatchObject({ problem: null, typedAt: expect.any(Number) });
    await wait(300);
    expect(fleet.received.some(r => r.msg.t === "res" && r.msg.id === "send-1")).toBe(false);
    // The repeat on the new connection gets the stored outcome and types nothing: the done key at work.
    sendReq("send-2", workerId, "typed once", "hub:drop-1");
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "send-2")).toMatchObject({ ok: true, result: status.outcome });
    await wait(300);
    expect(submitted()).toEqual(["typed once"]);
  });

  it("noDoneKeys with dropAfterStarted (negative control): op.status knows nothing, and the repeat types again", async () => {
    const submitted = await claudeLane();
    const { agent } = await runAgent(config, { hooks: { dropAfterStarted: "drop", noDoneKeys: true } });
    stops.push(() => agent.stop());
    const workerId = ((await fleet.waitFor(m => m.t === "ev.inventory")).panes as { workerId: string }[])[0]?.workerId ?? "";
    const live = fleet.connections();
    const cut = fleet.received.length;
    sendReq("send-1", workerId, "typed twice", "hub:drop-2");
    expect(await until(() => fleet.closes.some(c => c.conn === live))).toBe(true);
    expect(await until(() => submitted().length === 1)).toBe(true);
    await backOnline(cut);
    expect(await opStatus("hub:drop-2")).toEqual({ state: "unknown" });
    sendReq("send-2", workerId, "typed twice", "hub:drop-2");
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "send-2", 10_000)).toMatchObject({ ok: true, result: { problem: null } });
    expect(await until(() => submitted().length === 2)).toBe(true);
    expect(submitted()).toEqual(["typed twice", "typed twice"]);
  });

  it("fixedStreamId: hello, hook events and acks use it instead of the database's stream id", async () => {
    const fixed = randomUUID();
    const { agent, post } = await runAgent(config, { hooks: { fixedStreamId: fixed } });
    stops.push(() => agent.stop());
    expect(await fleet.waitFor(m => m.t === "hello")).toMatchObject({ streamId: fixed });
    expect(agent.streamId).toBe(fixed);
    await fleet.waitFor(m => m.t === "ev.inventory");
    const before = Date.now();
    expect((await post("/notify", { n: 1 })).status).toBe(202);
    const event = (await fleet.waitFor(m => m.t === "ev.hook")).event as { streamId: string; seq: number; at: number };
    expect(event).toMatchObject({ streamId: fixed, seq: 1 });
    expect(event.at).toBeGreaterThanOrEqual(before);                                           // no clock offset here
    expect(event.at).toBeLessThanOrEqual(Date.now());
    fleet.send({ t: "ack", streamId: fixed, seq: 1 });
    expect(await until(() => agent.spool.depth() === 0)).toBe(true);
    fleet.send({ t: "req", id: "st", op: "op.status", args: { key: "hub:x" }, timeoutMs: 5000 });
    expect(await fleet.waitFor(m => m.t === "res" && m.id === "st")).toMatchObject({ store: fixed });   // the store follows it too
    const db = new Database(config.dbPath, { readonly: true });
    try { expect((db.prepare("SELECT value FROM meta WHERE key = 'streamId'").get() as { value: string }).value).not.toBe(fixed); }
    finally { db.close(); }
  });

  it("clockOffsetMs moves health.wallClock and each hook event's at", async () => {
    const { agent, post } = await runAgent(config, { hooks: { clockOffsetMs: 3_600_000 } });
    stops.push(() => agent.stop());
    const health = (await fleet.waitFor(m => m.t === "ev.health")).health as { wallClock: number };
    expect(Math.abs(health.wallClock - (Date.now() + 3_600_000))).toBeLessThan(5000);
    await fleet.waitFor(m => m.t === "ev.inventory");
    const before = Date.now();
    expect((await post("/notify", { n: 1 })).status).toBe(202);
    const event = (await fleet.waitFor(m => m.t === "ev.hook")).event as { at: number };
    expect(event.at).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(event.at).toBeLessThanOrEqual(Date.now() + 3_600_000);
  });

  it("spoolFail: /hook/stop answers 503 and /cc still 204; both count as drops in health", async () => {
    const { agent, post } = await runAgent(config, { hooks: { spoolFail: true } });
    stops.push(() => agent.stop());
    await fleet.waitFor(m => m.t === "ev.inventory");
    expect((await post("/hook/stop", { session_id: "s" })).status).toBe(503);
    expect((await post("/cc", { session_id: "s" })).status).toBe(204);
    expect(agent.spool.depth()).toBe(0);
    expect(await fleet.waitFor(m => m.t === "ev.health" && (m.health as { drops: number }).drops === 2)).toBeTruthy();
  });
});

describe("`morndo-node run` and test hooks", () => {
  it("refuses to start with MORNDO_NODE_TEST_HOOKS set outside NODE_ENV=test: exit 78, saying why, and never dials", () => {
    const before = fleet.connections();
    const r = spawnSync(process.execPath, [MAIN, "run"], {
      env: { ...process.env, HOME: home.home, NODE_ENV: "production", MORNDO_NODE_TEST_HOOKS: JSON.stringify({ spoolFail: true }) },
      encoding: "utf8", timeout: 10_000,
    });
    expect(r.status).toBe(78);
    expect(r.stderr).toMatch(/MORNDO_NODE_TEST_HOOKS is set, but NODE_ENV is not "test"/);
    expect(fleet.connections()).toBe(before);
  });

  it("starts with them under NODE_ENV=test and a throwaway HOME, warns once naming each, and applies them", async () => {
    const fixed = randomUUID();
    const child = spawn(process.execPath, [MAIN, "run"], {
      env: { ...process.env, HOME: home.home, NODE_ENV: "test", MORNDO_NODE_TEST_HOOKS: JSON.stringify({ fixedStreamId: fixed, spoolFail: true }) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const exited = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    try {
      expect(await fleet.waitFor(m => m.t === "hello", 10_000)).toMatchObject({ streamId: fixed });
      expect(stderr.match(/test hooks are on/g)).toHaveLength(1);
      expect(stderr).toMatch(/test hooks are on \(fixedStreamId, spoolFail\)/);
    } finally {
      child.kill("SIGTERM");
    }
    expect(await exited).toBe(0);
  });
});
```

- [ ] **Step 15: Run it and watch it fail**

Run: `npx vitest run apps/node-agent/test/stream.test.ts apps/node-agent/test/agent.test.ts`

Expected: FAIL, `Error: Cannot find module '../src/agent.ts'` (imported by `agent-harness.ts`).

- [ ] **Step 16: Create `apps/node-agent/src/relay/stream-sender.ts`**

```ts
// Sends the hook stream to the fleet (spec §5.4). After each welcome it starts from ackSeq + 1 (from the start when the
// fleet doesn't know this streamId), oldest first; events that arrive later have higher seqs, so the replay always goes
// before anything new. At most 256 events are unacknowledged in flight (LIMITS.replayWindow); cumulative acks delete
// what the fleet has and open the window again. Progress events (/cc, /sl) that were waiting when the connection came
// up carry late: true and their original `at` (spec §5.5).
// Its methods run inside the connection's message handlers, so none of them throws: an ack the database can't write (a
// full disk) is logged and still opens the window (the rows stay until a later ack deletes them), and a read that fails
// is tried again on the next event or ack. A throw there would be an uncaught exception, and the agent would restart
// into the same full disk, again and again.
import { LIMITS, type AgentMessage, type HookEvent } from "@morndo/protocol";
import type { Logger } from "../log.ts";
import { isProgress, type Spool } from "./spool.ts";

export class StreamSender {
  #spool: Spool;
  #node: string;
  #send: (m: AgentMessage) => boolean;
  #window: number;
  #log: Logger | null;
  #online = false;
  #sent: number[] = [];
  #lastSent = 0;
  #acked = 0;
  #horizon = 0;

  constructor(o: { spool: Spool; node: string; send: (m: AgentMessage) => boolean; window?: number; log?: Logger }) {
    this.#spool = o.spool;
    this.#node = o.node;
    this.#send = o.send;
    this.#window = o.window ?? LIMITS.replayWindow;
    this.#log = o.log ?? null;
  }

  get inFlight(): number { return this.#sent.length; }

  // Deletes up to `seq`; false (logged) when the database can't be written.
  #delete(seq: number): boolean {
    try { this.#spool.ack(seq); return true; }
    catch (e) { this.#log?.warn("could not delete acknowledged hook events (a full disk?); they stay until a later ack", e); return false; }
  }

  online(w: { ackSeq: number; streamKnown: boolean }): void {
    const base = w.streamKnown ? w.ackSeq : 0;
    if (base > 0) this.#delete(base);
    this.#acked = base;
    this.#lastSent = base;
    this.#sent = [];
    this.#horizon = this.#spool.maxSeq();
    this.#online = true;
    this.#pump();
  }

  offline(): void {
    this.#online = false;
    this.#sent = [];
  }

  // A new event was spooled.
  kick(): void { this.#pump(); }

  ack(seq: number): void {
    const upTo = Math.min(seq, this.#lastSent);             // never past what this connection was sent
    if (!this.#online || upTo <= this.#acked) return;
    this.#delete(upTo);                                     // the fleet has them either way: the window opens
    this.#acked = upTo;
    this.#sent = this.#sent.filter(s => s > upTo);
    this.#pump();
  }

  #pump(): void {
    while (this.#online && this.#sent.length < this.#window) {
      let rows: ReturnType<Spool["after"]>;
      try { rows = this.#spool.after(this.#lastSent, this.#window - this.#sent.length); }
      catch (e) { this.#log?.warn("could not read the hook stream; trying again with the next event", e); return; }
      if (!rows.length) return;
      for (const r of rows) {
        const event: HookEvent = {
          streamId: this.#spool.streamId, seq: r.seq, at: r.at, path: r.path, node: this.#node, window: r.window,
          ...(isProgress(r.path) && r.seq <= this.#horizon ? { late: true as const } : {}),
          body: r.body,
        };
        if (!this.#send({ v: 1, t: "ev.hook", event })) { this.offline(); return; }
        this.#sent.push(r.seq);
        this.#lastSent = r.seq;
      }
    }
  }
}
```

- [ ] **Step 17: Create `apps/node-agent/src/events.ts`**

```ts
// Inventory and health events (spec §5.4), latest wins. The inventory is read every 2 s (LIMITS.inventoryPollMs) and
// sent when its invVersion moved, and in full after every welcome; health every 30 s (LIMITS.healthMs) and after every
// welcome. Each loop waits for its previous round, so a slow tmux never piles reads up.
import { LIMITS, type AgentMessage, type Health } from "@morndo/protocol";
import type { Logger } from "./log.ts";
import type { Inventory } from "./ops/inventory.ts";

export type EventLoopOptions = {
  inventory: Inventory;
  send: (m: AgentMessage) => boolean;
  health: () => Promise<Health>;
  log: Logger;
  pollMs?: number;
  healthMs?: number;
};

export class EventLoops {
  #o: EventLoopOptions;
  #online = false;
  #sentVersion = -1;
  #timers = new Set<NodeJS.Timeout>();
  #stopped = false;

  constructor(o: EventLoopOptions) { this.#o = o; }

  start(): void {
    this.#loop(this.#o.pollMs ?? LIMITS.inventoryPollMs, () => this.#inventory());
    this.#loop(this.#o.healthMs ?? LIMITS.healthMs, () => this.#health());
  }

  // After a welcome: the full inventory and a health event, whatever was sent before.
  online(): void {
    this.#online = true;
    this.#sentVersion = -1;
    void this.#inventory();
    void this.#health();
  }

  offline(): void { this.#online = false; }

  stop(): void {
    this.#stopped = true;
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
  }

  #loop(ms: number, round: () => Promise<void>): void {
    const next = () => {
      if (this.#stopped) return;
      const t = setTimeout(() => {
        this.#timers.delete(t);
        void round().finally(next);
      }, ms);
      this.#timers.add(t);
    };
    next();
  }

  async #inventory(): Promise<void> {
    try {
      const s = await this.#o.inventory.refresh();
      if (!this.#online || s.invVersion === this.#sentVersion) return;
      if (this.#o.send({ v: 1, t: "ev.inventory", invVersion: s.invVersion, panes: s.panes })) this.#sentVersion = s.invVersion;
    } catch (e) {
      this.#o.log.warn("reading the inventory failed", e);
    }
  }

  async #health(): Promise<void> {
    if (!this.#online) return;
    try { this.#o.send({ v: 1, t: "ev.health", health: await this.#o.health() }); }
    catch (e) { this.#o.log.warn("reading health failed", e); }
  }
}
```

- [ ] **Step 18: Create `apps/node-agent/src/agent.ts`**

```ts
// The running agent, `morndo-node run` (spec §2, §5): one connection to the fleet with the ops behind it, the hook relay
// and its durable stream, the inventory and health events, and the status file. stop() ends all of it. Test hooks
// (test-hooks.ts) act here too: dropAfterStarted cuts the connection and never sends that op's answer, fixedStreamId
// replaces the database's stream id, spoolFail fails every spool write, and the runtime's wall clock (clockOffsetMs)
// stamps health and hook events.
// - Every `res` carries `store`: the stream id of this database, where its done keys live (plan Contracts, Res). A new
//   or restored database is a new store, so a caller asking op.status about a key that database lost can tell.
// - A restored database: when a welcome says the fleet accepted more of this stream than this database ever wrote
//   (ackSeq > its last seq), the database came back from a backup, and its next seqs would be taken for ones the fleet
//   already has. The agent starts a new stream (rotateStreamId), once per process, and dials again so the hello names
//   it.
// - The disk budget, LIMITS.spoolMaxBytes, is the spool's, the relay's copies' and the upload inbox's together.
import { randomUUID } from "node:crypto";
import { ERROR_EXECUTED, LIMITS, type AgentMessage, type OpError } from "@morndo/protocol";
import { healthProbe } from "@morndo/node-ops";
import { ConfigError, isOpName, type AgentConfig } from "./config.ts";
import { FleetConnection, type ReqMessage } from "./conn/connection.ts";
import type { RetryOptions } from "./conn/retry.ts";
import type { Lane } from "./conn/send-queue.ts";
import { writeStatus, type AgentStatus } from "./conn/status-file.ts";
import { openAgentDb, rotateStreamId } from "./db/open.ts";
import { EventLoops } from "./events.ts";
import { fleetPublicKey, loadNodeKey } from "./identity.ts";
import type { Logger } from "./log.ts";
import type { Inventory } from "./ops/inventory.ts";
import { nodeOpener } from "./ops/node-files.ts";
import { createOpsRuntime } from "./ops/runtime.ts";
import { agentPaths } from "./paths.ts";
import { RelayFiles } from "./relay/relay-files.ts";
import { startRelay, type Relay } from "./relay/server.ts";
import { Spool } from "./relay/spool.ts";
import { StreamSender } from "./relay/stream-sender.ts";
import { cachedFor, windowResolver } from "./relay/window-of.ts";
import { dropOnce, type TestHooks } from "./test-hooks.ts";

// Results that carry transcript or file bytes go on the bulk queue (spec §5.2 "Frames").
const BULK_OPS = new Set(["transcript.read", "file.get"]);
const HOUSEKEEPING_MS = 3_600_000;

export type AgentOptions = {
  config: AgentConfig;
  log: Logger;
  hooks?: TestHooks;
  instanceId?: string;
  retry?: RetryOptions;
  pingTimeoutMs?: number;
  pollMs?: number;
  healthMs?: number;
  statusMs?: number;
  diskBudgetBytes?: number;                                // LIMITS.spoolMaxBytes; a test sets a smaller one
};
export type RunningAgent = {
  instanceId: string;
  readonly streamId: string;                               // the store id too; rotated for a restored database
  relayPort: number;
  inventory: Inventory;
  spool: Spool;
  status(): AgentStatus;
  stop(): Promise<void>;
};

export async function startAgent(o: AgentOptions): Promise<RunningAgent> {
  const { config, log } = o;
  const hooks = o.hooks ?? {};
  const paths = agentPaths(config.home);
  const fleetKey = fleetPublicKey(config.fleetKey);
  if (!fleetKey) throw new ConfigError(`${paths.configFile}: fleetKey is not an Ed25519 public key`);
  const nodeKey = loadNodeKey(config.keyPath);
  const adb = openAgentDb(config.dbPath);
  let streamId = hooks.fixedStreamId ?? adb.streamId;
  let rotated = false;
  const instanceId = o.instanceId ?? randomUUID();
  let conn: FleetConnection | null = null;
  // The disk budget: what the relay's copies and the upload inbox hold counts toward the spool's byte cap, and both are
  // refused what the budget can't hold. (Read through closures: spool and files are made just below.)
  const budget = o.diskBudgetBytes ?? LIMITS.spoolMaxBytes;
  const held = (): number => files.bytes() + ops.inbox.bytes();
  const room = (): number => budget - spool.bytes() - held();
  const ops = createOpsRuntime({
    config, db: adb.db, log, hooks, room: () => room(),
    ...(hooks.dropAfterStarted !== undefined ? { afterStarted: dropOnce(hooks.dropAfterStarted, () => conn?.drop()) } : {}),
  });
  const spool: Spool = new Spool(adb.db, streamId, { failWrites: hooks.spoolFail === true, maxBytes: budget, held: cachedFor(1000, held) });
  const open = nodeOpener({ home: config.home, stateDir: paths.stateDir, configDir: paths.configDir, ...(config.policy.fileRoots ? { fileRoots: config.policy.fileRoots } : {}) });
  const files: RelayFiles = new RelayFiles({ dir: paths.relayFilesDir, db: adb.db, open, room: () => room() });
  const sessions = cachedFor(2000, () => ops.registry.byPane());

  const send = (m: AgentMessage, lane: Lane = "control") => conn?.send(m, lane) ?? false;
  const sender = new StreamSender({ spool, node: config.node, send: m => send(m), log });
  const events = new EventLoops({
    inventory: ops.inventory, send: m => send(m), log,
    health: async () => ({
      ...(await healthProbe(config.home, { tmuxSocket: config.policy.tmuxSocket })), wallClock: ops.now(), spoolDepth: spool.depth(), drops: spool.drops,
    }),
    ...(o.pollMs !== undefined ? { pollMs: o.pollMs } : {}),
    ...(o.healthMs !== undefined ? { healthMs: o.healthMs } : {}),
  });
  const status = (): AgentStatus => ({
    ...(conn?.status() ?? { state: "stopped", since: Date.now(), connEpoch: null, lastClose: null, retryInMs: null }),
    node: config.node, instanceId, pid: process.pid, spoolDepth: spool.depth(), drops: spool.drops,
  });
  const saveStatus = () => {
    try { writeStatus(paths.statusFile, status()); } catch (e) { log.warn("could not write status.json", e); }
  };
  const errorRes = (id: string, error: OpError): AgentMessage => ({ v: 1, t: "res", id, invVersion: ops.inventory.invVersion, store: streamId, ok: false, error });

  const answer = async (m: ReqMessage) => {
    const reply = await ops.executor.handle({ id: m.id, op: m.op, args: m.args, timeoutMs: m.timeoutMs, ...(m.key !== undefined ? { key: m.key } : {}) });
    if (reply.discarded) { log.warn(`test hook dropAfterStarted: the answer to a ${m.op} request is not sent`); return; }
    let res: AgentMessage = reply.ok
      ? { v: 1, t: "res", id: reply.id, invVersion: reply.invVersion, store: streamId, ok: true, result: reply.result }
      : { v: 1, t: "res", id: reply.id, invVersion: reply.invVersion, store: streamId, ok: false, error: reply.error };
    if (Buffer.byteLength(JSON.stringify(res)) > LIMITS.maxMessageBytes) {
      res = errorRes(m.id, { code: "too_large", executed: ERROR_EXECUTED.too_large, message: "the answer is over 512 KiB" });
    }
    if (!send(res, BULK_OPS.has(m.op) ? "bulk" : "control")) log.info(`the answer to a ${isOpName(m.op) ? m.op : "?"} request found no live connection`);
  };

  let relay: Relay;
  try {
    relay = await startRelay({
      port: config.relayPort, spool, files, log, onAppended: () => sender.kick(), now: ops.now,
      windowOf: windowResolver({ windowOfPane: p => ops.inventory.windowOfPane(p), sessions }),
    });
  } catch (e) {
    adb.close();
    throw e;
  }

  conn = new FleetConnection({
    url: config.fleetUrl, node: config.node, instanceId, streamId, fleetKey, nodeKey,
    caps: config.policy.ops, log,
    claudeVersion: () => [...sessions().values()].find(s => s.version)?.version ?? null,
    onWelcome: w => {
      if (restored(w)) return;
      sender.online(w);
      events.online();
    },
    onRequest: m => { answer(m).catch((e: unknown) => log.error("answering a request failed", e)); },
    onBadRequest: (id, op) => {
      send(errorRes(id, isOpName(op)
        ? { code: "bad_args", executed: ERROR_EXECUTED.bad_args, message: "a request that doesn't fit its op" }
        : { code: "unknown_op", executed: ERROR_EXECUTED.unknown_op, message: "this node has no such op" }));
    },
    onAck: a => { if (a.streamId === streamId) sender.ack(a.seq); },
    onDown: () => { sender.offline(); events.offline(); },
    onStatus: () => saveStatus(),
    ...(o.retry ? { retry: o.retry } : {}),
    ...(o.pingTimeoutMs !== undefined ? { pingTimeoutMs: o.pingTimeoutMs } : {}),
  });

  // A welcome that acknowledges more of this stream than this database ever wrote: a restored database. A new stream,
  // once per process (a fleet that claimed it again would only make the agent redial in a loop), then a new hello.
  function restored(w: { ackSeq: number; streamKnown: boolean }): boolean {
    let last: number;
    try { last = spool.lastSeq(); } catch (e) { log.warn("could not read the hook stream's last seq", e); return false; }
    if (!w.streamKnown || w.ackSeq <= last) return false;
    if (hooks.fixedStreamId !== undefined || rotated) {
      log.error(`the fleet has seq ${w.ackSeq} of stream ${streamId}, but this database wrote only up to ${last}; ${rotated ? "a new stream was started already" : "the stream id is fixed by a test hook"}, so new events may be taken for duplicates`);
      return false;
    }
    try {
      if (last > 0) spool.ack(last);                          // every row it holds, the fleet has already
      streamId = rotateStreamId(adb.db);
    } catch (e) {
      log.error("could not start a new hook stream (a full disk?); new events may be taken for duplicates", e);
      return false;
    }
    rotated = true;
    spool.rotate(streamId);
    conn?.setStreamId(streamId);
    log.warn(`the fleet has seq ${w.ackSeq} of this database's stream, which wrote only up to ${last}: a restored backup? Starting a new stream ${streamId}`);
    conn?.drop();                                             // dial again: the new hello names the new stream
    return true;
  }

  const housekeeping = () => {
    try { ops.doneKeys.prune(); files.sweep(); ops.inbox.sweep(); }
    catch (e) { log.warn("housekeeping failed", e); }
  };
  housekeeping();
  const timers = [setInterval(housekeeping, HOUSEKEEPING_MS), setInterval(saveStatus, o.statusMs ?? LIMITS.healthMs)];
  events.start();
  conn.start();

  return {
    instanceId, get streamId() { return streamId; }, relayPort: relay.port, inventory: ops.inventory, spool, status,
    stop: async () => {
      for (const t of timers) clearInterval(t);
      events.stop();
      await conn?.stop();
      await relay.close();
      saveStatus();
      adb.close();
    },
  };
}
```

- [ ] **Step 19: Replace `apps/node-agent/src/main.ts`: add `run`**

```ts
#!/usr/bin/env node
// morndo-node: this machine's agent in a Morndo fleet (ADR-0012). `join` once, with the string the fleet printed; `run`
// under the service manager; `status` for a person at the machine.
import { homedir, userInfo } from "node:os";
import { startAgent, type RunningAgent } from "./agent.ts";
import { ConfigError, loadConfig, type AgentConfig } from "./config.ts";
import { formatStatus, readStatus } from "./conn/status-file.ts";
import { exitOnCrash } from "./crash.ts";
import { DatabaseFromFuture } from "./db/migrations.ts";
import { JoinError, join } from "./join.ts";
import { log } from "./log.ts";
import { agentPaths } from "./paths.ts";
import { TestHooksRefused, loadTestHooks, type TestHooks } from "./test-hooks.ts";

const HELP = `morndo-node: this machine's agent in a Morndo fleet.

  morndo-node join '<join string>'   join the fleet once, with the string \`morndo-fleet node add <name>\` printed
  morndo-node run                    run the agent: the connection to the fleet, the ops, the hook relay
  morndo-node status                 what the running agent reports

Files: ~/.config/morndo-node/ (config.json, policy.json, node-key.pem) and ~/.local/state/morndo-node/ (agent.db,
relay-files/, inbox/, status.json). MORNDO_NODE_LOG_LEVEL sets the log level (default info).`;

const EXIT_CONFIG = 78;                     // EX_CONFIG (sysexits.h): the setup needs fixing, a restart won't help
exitOnCrash(log);
const home = process.env.HOME || homedir();
const [cmd = "help", ...args] = process.argv.slice(2);
// The commands' own output, for the person at the machine: not a log.
const print = (text: string) => process.stdout.write(`${text}\n`);

function configOrExit(): AgentConfig {
  try { return loadConfig(home); }
  catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    process.stderr.write(`${e.message}\n`);
    process.exit(EXIT_CONFIG);
  }
}

// The account's own home directory, from the password database rather than $HOME (os.userInfo(), test-hooks.ts); ""
// when the account has none.
function accountHome(): string {
  try { return userInfo().homedir; } catch { return ""; }
}

// tmux writes UTF-8 only under a UTF-8 locale (tmux(1), -u). Every tmux call passes -u (node-ops' tmuxArgv), but a tmux
// server that lane.start launches, and the lanes in it, inherit this environment: a service started without a locale
// gets C.UTF-8.
function ensureUtf8Locale() {
  const first = process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || "";
  if (/utf-?8/i.test(first)) return;
  if (process.env.LC_ALL) log.warn("LC_ALL is set to a locale without UTF-8; tmux output may lose characters");
  else process.env.LC_CTYPE = "C.UTF-8";
}

switch (cmd) {
  case "join": {
    if (args.length !== 1) { process.stderr.write("usage: morndo-node join '<join string>'\n"); process.exit(2); }
    try {
      const joined = await join({ home, joinString: args[0] ?? "" });
      print(`Joined the fleet at ${joined.fleetUrl} as ${joined.node}. Start the agent with: morndo-node run`);
    } catch (e) {
      if (!(e instanceof JoinError)) throw e;
      process.stderr.write(`${e.message}\n`);
      process.exit(1);
    }
    break;
  }
  case "run": {
    // Test hooks before anything else: with MORNDO_NODE_TEST_HOOKS set outside a test, the agent refuses to start.
    let hooks: TestHooks;
    try { hooks = loadTestHooks(process.env, { home, accountHome: accountHome() }); }
    catch (e) {
      if (!(e instanceof TestHooksRefused)) throw e;
      process.stderr.write(`${e.message}\n`);
      process.exit(EXIT_CONFIG);
    }
    if (Object.keys(hooks).length) log.warn(`test hooks are on (${Object.keys(hooks).join(", ")}): this agent is for tests only`);
    ensureUtf8Locale();
    const config = configOrExit();
    let agent: RunningAgent;
    try { agent = await startAgent({ config, log, hooks }); }
    catch (e) {
      if (e instanceof ConfigError) {
        log.error(e.message);
        process.exit(EXIT_CONFIG);
      }
      if (e instanceof DatabaseFromFuture) {
        log.error(`${config.dbPath} was written by a newer morndo-node (schema version ${e.found}); this one knows up to ${e.known}. Run the newer agent, or restore a backup.`);
        process.exit(EXIT_CONFIG);
      }
      if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
        log.error(`the hook relay's port 127.0.0.1:${config.relayPort} is taken (another relay?); set relayPort in ${agentPaths(home).configFile}`);
        process.exit(EXIT_CONFIG);
      }
      throw e;
    }
    log.info(`morndo-node ${config.node}: hook relay on 127.0.0.1:${agent.relayPort}, dialing ${config.fleetUrl} as instance ${agent.instanceId}`);
    const stop = async () => { await agent.stop(); process.exit(0); };
    process.on("SIGINT", () => void stop());
    process.on("SIGTERM", () => void stop());
    break;
  }
  case "status": {
    const config = configOrExit();
    print(formatStatus(config, readStatus(agentPaths(home).statusFile)));
    break;
  }
  default:
    print(HELP);
}
```

- [ ] **Step 20: Run it and watch it pass**

Run: `npx vitest run apps/node-agent/test/stream.test.ts apps/node-agent/test/agent.test.ts`

Expected: PASS, `Tests  21 passed (21)`.

- [ ] **Step 21: Check the whole agent**

Run each command on its own:
- `npx vitest run apps/node-agent/test`. Expected: `Test Files  17 passed (17)` with `Tests  145 passed (145)` on Linux (144 passed and 1 skipped where there is no `flock`).
- `npm run check`. Expected: exit 0.
- `npx oxlint --format=stylish apps/node-agent`. Expected: no output.
- `test -x apps/node-agent/src/main.ts && echo executable`. Expected: `executable`.
- `HOME=$(mktemp -d) node apps/node-agent/src/main.ts run; echo "exit $?"`. Expected: `This machine has not joined a fleet (…). Run: morndo-node join '<join string>'`, then `exit 78`.
- `npx vitest run apps/node-agent/test/pane-ops.test.ts apps/node-agent/test/inventory.test.ts`, three times. Expected: each run passes.

- [ ] **Step 22: Commit**

```bash
git add apps/node-agent
git commit -m "feat(node-agent): morndo-node run with stream replay, inventory and health events, and status"
```

