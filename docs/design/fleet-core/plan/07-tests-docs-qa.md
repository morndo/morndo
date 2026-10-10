## Lane notes (tests, docs, QA)

Tasks 16–20 were type-checked against stubs of the other lanes' code when they were drafted; they run for real only once Tasks 1–15 have landed. What they rely on, beyond the Contracts (a test fails loudly if one doesn't hold):
- With `MORNDO_FLEET_SOCKET` set, the hub reads no local tmux and no `~/.claude`.
- `POST /api/workers/<workerId>/send` answers 200 `{ ok: true, at }`, where `at` is the node's `typedAt`. A first attempt whose node answered "maybe" (the drop after `started`) is 409 `{ error: "uncertain" }` (changed during execution: it was a 500 `{ error: "internal error" }` until the final review's I1) and keeps the hub's `started` row; its repeat asks `op.status`: `done` → 200 `{ error: "duplicate", ok: true, at }`, `unknown` from the same store, not behind its store sequence → it types. A repeat still in doubt is 409 `{ error: "uncertain" }` too; a send to an offline node is 409 `{ error: "node_offline" }`, released before the paste.
- `EscalationService.answer` sends with a key that contains `answer:<escalation id>:`.
- The fleet routes a `{ node }` target without judging the worker ID inside `args`; the agent does that.
- `morndo-fleet node add <name>` prints the join string on a line of its own, starting `morndo-join:1:`; `morndo-node join` exits 0 once welcomed.
- The agent reads its policy from `policy.json`, never from `config.json` (Task 6). The harness and the QA runbook write the test's tmux socket and session there, and the harness reads the config back with the agent's own `loadConfig` before it runs an agent.
- The agent accepts test hooks only with `NODE_ENV=test` and a `HOME` that isn't the account's own; the harness sets `NODE_ENV=test` when it passes hooks.

**Review round 2** (plan.md Contracts as revised; RECONCILIATION.md "Review round 2"). What these tasks now also rely on:
- Every answer to an op sent to a node carries `store` (the agent database's stream id), `null` for a refusal before anything was sent; the hub keeps the store of a send in doubt and answers its repeat `uncertain` (409) when `op.status` says `unknown` from another store (Task 14). `fixedStreamId` is a fixed store too, and it stays fixed when the agent would otherwise start a new stream for a restored database (Task 9): the store drill's control and the stream drill's control both depend on that.
- `EscalationService.answer`'s key is `answer:<escalation id>:<ask>:…` (Task 5): it still contains `answer:<escalation id>:`, which is what the drills' `dropAfterStarted` matches.
- The hub lists every window of every node (two windows of one name included), and refuses an answer for a manager whose name is in conflict with 409 `{ error: "lane_conflict" }`, typing nothing (Task 14).
- An agent refused with 4409 keeps `status: conflict` (its status line starts `conflict: another agent with this node's key is connected (4409)`, Task 7) and tries again every 5 minutes; the fleet admits a second instance only when the live one misses the instance check's ping (3 s, Task 11).
- The harness's fleet listens on `127.0.0.1` with a `ws://127.0.0.1:<port>/agent` public URL: the only plain `ws://` the fleet (Task 10) and the agent (Task 7) accept is to a loopback host.
- `statuses()` subscribes, waits for the fleet's replay of the node's current status, discards it, and only then returns: a drill that subscribes before its drop sees the drop, and a soak that expects no flips isn't fooled by the replay.

### Where the shared helpers live (decided for Task 16)

| Choice | Verdict |
|---|---|
| `e2e/` | No. `e2e/` holds standalone scripts with the PASS/FAIL harness. They need the built web app and Chromium, and they run under `npm run e2e`. The drills don't need a browser, and they must run in vitest, so that CI's test step and `npm test` hold them (spec §12.1). |
| `apps/*/test/` | No. Each of those folders is one app's tests, importing that app's source. These tests start three apps (fleet, agent, hub) and own none of them. |
| **`test/` at the repo root** | Yes:<br>• `test/fleet-harness.ts` holds the helpers (it imports no vitest);<br>• `test/fixtures/fake-claude-pane.ts` is the lane stand-in;<br>• `test/fleet/*.test.ts` holds the tests, in a vitest project of their own (`fleet`). |

`e2e/fleet-two-node.e2e.ts` and the QA helper import the harness by relative path, as `e2e/push.e2e.ts` already imports `../apps/hub/src/adapters/webpush.ts`.

The harness uses `afterAll` in Task 16's one-setup file, as `apps/hub/test/tmux.test.ts` does, and `afterEach` in Task 17's files. It also kills every tmux server and child process it started in a process `exit` hook, so a crashed test file leaves nothing behind.

---

### Task 16: Integration of a real agent with a real fleet

**Files:**
- Create: `test/fixtures/fake-claude-pane.ts`
- Create: `test/fleet-harness.ts`
- Create: `test/fleet/integration.test.ts`
- Create: `test/fleet/duplicate-names.test.ts`
- Modify: `vitest.config.ts` (a `fleet` project)
- Modify: `tsconfig.tests.json` (include `test`; Task 1 already includes `apps/node-agent/test` and `apps/fleet/test`)
- Modify: `.oxlintrc.json` (the fixture's control-character regex)
- Test: `test/fleet/integration.test.ts`, `test/fleet/duplicate-names.test.ts`

**Interfaces:**
- Consumes:
  - `FleetClient` (`apps/hub/src/adapters/fleet-client.ts`, Task 14's first commit): `constructor(socketPath)`, `caps()`, `nodes()`, `lanes()`, `op()` (its `OpAnswer` carries `store`), `events()` and `alerts()`.
  - `formatWorkerId`, `parseWorkerId`, `WORKER_ID` (`packages/protocol/src/worker-id.ts`).
  - `LIMITS`, `Pane`, `Expect`, `HookEvent`, `OpName` (`packages/protocol/src/fleet.ts`).
  - `AgentConfig` and `loadConfig(home)` (`apps/node-agent/src/config.ts`), `agentPaths(home)` (`apps/node-agent/src/paths.ts`): the agent keeps `config.json` and `policy.json` apart (Task 6). `FleetConfig` (`apps/fleet/src/config.ts`), read from `<HOME>/.config/morndo-fleet/config.json` (Task 10).
  - `TestHooks` (`apps/node-agent/src/test-hooks.ts`, Tasks 8–9).
  - `isolatedTmux` (`packages/node-ops/test/isolated-tmux.ts`) and `tmuxArgv`, `exactSession`, `tmuxLiteral` (`packages/node-ops/src/tmux-cli.ts`), Task 2.
  - The hub's answer to an answer for a manager whose name is in conflict: 409 `{ error: "lane_conflict" }`, nothing typed (Task 14).
  - The CLIs `morndo-node join|run|status` and `morndo-fleet serve|node add|node revoke`.
  - The hub: `MORNDO_FLEET_SOCKET`, `Store` (`apps/hub/src/adapters/store.ts`), `hashSecret` (`apps/hub/src/application/access-service.ts`), and `endpointId`, `pairingTokenId`, `sessionId` from `@morndo/domain`.
- Produces (`test/fleet-harness.ts`, used by Tasks 17, 18 and 20):
  ```ts
  export const ROOT: string; export const AGENT_MAIN: string; export const FLEET_MAIN: string; export const HUB_MAIN: string; export const FAKE_CLAUDE: string;
  export { sleep };                                       // node:timers/promises setTimeout
  export function until<T>(what: string, f: () => T | Promise<T>, ms?: number, every?: number): Promise<NonNullable<T>>;
  export function freePort(): Promise<number>;
  export function cleanEnv(home: string, extra?: Record<string, string>): NodeJS.ProcessEnv;
  export function stopAll(): Promise<void>;
  export type Proc = { name: string; child: ChildProcess; log: string; alive(): boolean; stop(signal?: NodeJS.Signals): Promise<void>; pause(): void; resume(): void; tail(lines?: number): string };
  export type TmuxServer = { socket: string; run(...args: string[]): string; has(session: string): boolean; stamp(): string | null; kill(): void };
  export function tmuxServer(): TmuxServer;
  export type Lane = { window: string; paneId: string; dir: string; sessionId: string | null; transcript: string | null; submitted(): string[]; screen(): string; draft(text: string): void; clear(): void };
  export function fakeLane(t: TmuxServer, o: { window: string; session?: string; prose?: string; claudeHome?: string; offsetMs?: number }): Promise<Lane>;
  export function shellLane(t: TmuxServer, o: { window: string; session?: string; split?: boolean }): { window: string; paneId: string };
  export type Fleet = { home: string; port: number; socketPath: string; config: FleetConfig; client: FleetClient; proc(): Proc; cli(...args: string[]): { code: number | null; out: string; err: string }; addNode(name: string): string; revoke(name: string): void; restart(signal?: NodeJS.Signals, whileDown?: () => Promise<void>): Promise<void> };
  export function startFleet(o?: { subscribers?: FleetConfig["subscribers"] }): Promise<Fleet>;
  export type Agent = { node: string; home: string; configPath: string; readonly relayPort: number; config(): AgentConfig; proc(): Proc | null; run(hooks?: TestHooks): Promise<void>; stop(signal?: NodeJS.Signals): Promise<void>; waitOnline(ms?: number): Promise<void>; waitOffline(ms?: number): Promise<void>; resetDatabase(hooks?: TestHooks): Promise<void>; clone(): Promise<Agent> };
  export function joinAgent(fleet: Fleet, node: string, o: { tmux: TmuxServer; session?: string; policy?: Partial<AgentConfig["policy"]> }): Promise<Agent>;
  export type FeedWatch = { workers(): { id: string; name: string }[]; seen: Set<string>; names: Set<string>; screens: { worker: string; text: string; got: number }[]; watch(worker: string | null): void; close(): void };
  export type Reply = { status: number; body: Record<string, unknown> };
  export type Hub = { base: string; origin: string; port: number; home: string; cookie: string; env: NodeJS.ProcessEnv; post(path: string, body: unknown): Promise<Reply>; send(workerId: string, text: string, requestId?: string): Promise<Reply>; answer(id: string, key: string, requestId?: string): Promise<Reply>; feed(): Promise<FeedWatch>; audit(): string; pairUrl(): string; stop(): Promise<void> };
  export function startHub(fleet: Fleet, o?: { pollMs?: number; web?: "stub" | "build"; ledger?: unknown }): Promise<Hub>;
  export type Delivery = { key: string; event: HookEvent; got: number };
  export type Subscriber = { url: string; received: Delivery[]; unique(): Map<string, Delivery> };
  export function subscriber(o?: { delayMs?: number }): Promise<Subscriber>;
  export function hook(agent: Agent, path: HookEvent["path"], body: unknown): Promise<{ status: number; text: string }>;
  export function keyParts(key: string): { node: string; streamId: string; seq: number };
  export function paneOf(client: FleetClient, node: string, window: string): Promise<Pane>;
  export function expectOf(p: Pane): Expect;
  export function statuses(fleet: Fleet, node: string): Promise<string[]>;   // the flips after the replay of the current status
  ```
- Produces (`test/fixtures/fake-claude-pane.ts`): `node fake-claude-pane.ts <state dir> [--claude=<dir> --session=<id> --tmux-session=<name>] [--offset=<ms>]`. It writes:
  - `<state dir>/submitted.jsonl`: one JSON string per submit;
  - `<state dir>/raw.bin`: every byte it received;
  - with `--claude`, `<dir>/sessions/<pid>.json` and `<dir>/projects/-qa/<session>.jsonl`.

  It reads `<state dir>/prose.txt` at start.
- Produces: a vitest project named `fleet`, which runs `test/fleet/**/*.test.ts`.

- [ ] **Step 1: Wire the `fleet` project, the type check and lint for `test/`**

In `vitest.config.ts`, add after the `browserWorkers` line:

```ts
// The fleet's cross-app drills (test/fleet, spec §9): real fleet, agent and hub processes on isolated tmux servers. Most of
// their time is waiting (reconnects, health every 30 s, a 75 s flapping window), not CPU, so they run after everything
// else, in a group of their own, a few files at a time. CI runs them in a job of their own (.github/workflows/ci.yml).
// Projects in a later groupOrder run after the earlier groups (https://vitest.dev/config/sequence.html, v5.0.3, read
// 2026-10-06).
const fleetWorkers = Math.min(4, Math.max(2, Math.floor(availableParallelism() / 2)));
```

and add a third project after the `chromium` one:

```ts
      { test: { name: "fleet", include: ["test/fleet/**/*.test.ts"], maxWorkers: fleetWorkers, testTimeout: 120_000, hookTimeout: 60_000, sequence: { groupOrder: 2 } } },
```

In `tsconfig.tests.json`, change `"include"` to (Task 1 added the two app folders; only `"test"` is new here):

```json
  "include": [
    "packages/*/test",
    "apps/hub/test",
    "apps/node-agent/test",
    "apps/fleet/test",
    "test",
    "vitest.config.ts"
  ]
```

In `.oxlintrc.json`, add `"test/fixtures/*.ts"` to the `files` of the override that turns `no-control-regex` off, after `"apps/hub/test/tmux-*.ts"`.

- [ ] **Step 2: Write the lane stand-in `test/fixtures/fake-claude-pane.ts`**

```ts
// A stand-in for an agent CLI's input box in a tmux pane, for the fleet tests (test/fleet), the fleet's two-node e2e and
// its QA runbook. It is never the real CLI, so none of the real one's hooks fire. It draws like Claude Code 2.1.286, as
// apps/hub/test/tmux-fake-claude.fixture.ts does: optional prose, a ─ rule, "❯ " and the input, a ─ rule, a footer. It
// turns bracketed paste on (ESC[?2004h). Inside a paste every byte is text; outside it, Enter submits and Ctrl-U clears
// the draft. It runs nothing: it only records.
// Usage: node fake-claude-pane.ts <state dir> [--claude=<dir> --session=<id> --tmux-session=<name>] [--offset=<ms>]
//   <state dir>/prose.txt        read at start: the prose drawn above the box
//   <state dir>/raw.bin          every byte received
//   <state dir>/submitted.jsonl  one JSON string per submit
//   --claude: a session file <dir>/sessions/<pid>.json naming this pane (from TMUX_PANE), and a transcript
//     <dir>/projects/-qa/<session>.jsonl. Each submit adds one user line to the transcript, timed on this machine's clock
//     plus --offset (the node's clock, the one the real CLI writes with). Shapes as in
//     apps/hub/src/adapters/claude-sessions.ts.
// Options take the --name=value form: util.parseArgs takes a value starting with "-" (a negative offset) only that way
// (https://nodejs.org/docs/latest-v24.x/api/util.html#utilparseargsconfig, read 2026-10-06).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { claude: { type: "string" }, session: { type: "string" }, "tmux-session": { type: "string" }, offset: { type: "string" } },
});
const dir = positionals[0] ?? ".";
const offset = Number(values.offset ?? 0);
const clock = () => Date.now() + offset;
const prose = existsSync(join(dir, "prose.txt")) ? readFileSync(join(dir, "prose.txt"), "utf8").replace(/\n+$/, "") : "";

let transcript: string | null = null;
if (values.claude && values.session) {
  const sessions = join(values.claude, "sessions");
  const project = join(values.claude, "projects", "-qa");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(project, { recursive: true });
  transcript = join(project, `${values.session}.jsonl`);
  if (!existsSync(transcript)) {
    const t0 = clock() - 60_000;
    writeFileSync(transcript, [
      { type: "ai-title", aiTitle: "Fleet fixture" },
      { type: "user", uuid: "seed-1", timestamp: new Date(t0).toISOString(), origin: { kind: "human" }, message: { role: "user", content: "seeded prompt" } },
      { type: "assistant", uuid: "seed-2", timestamp: new Date(t0 + 1000).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "seeded reply" }] } },
    ].map(l => JSON.stringify(l)).join("\n") + "\n");
  }
  writeFileSync(join(sessions, `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId: values.session, tmux: `${values["tmux-session"] ?? "qa"}:@0.${process.env.TMUX_PANE ?? ""}`,
    name: null, cwd: process.cwd(), version: "2.1.286", updatedAt: clock(),
  }));
}

const decoder = new StringDecoder("utf8");
let input = "";
let paste = false;
let pending = "";

function draw() {
  const line = input.replace(/\n/g, " ").replace(/[\x00-\x1f\x7f]/g, "");
  process.stdout.write(`\x1b[H\x1b[2J${prose ? `${prose.replace(/\n/g, "\r\n")}\r\n\r\n` : ""}${"─".repeat(40)}\r\n`
    + `\x1b[38;5;246m❯ \x1b[39m${line}\r\n${"─".repeat(40)}\r\n  ? for shortcuts`);
}
function submit() {
  appendFileSync(join(dir, "submitted.jsonl"), `${JSON.stringify(input)}\n`);
  if (transcript) {
    appendFileSync(transcript, `${JSON.stringify({ type: "user", uuid: randomUUID(), timestamp: new Date(clock()).toISOString(), origin: { kind: "human" }, message: { role: "user", content: input } })}\n`);
  }
  input = "";
}

process.stdin.setRawMode(true);
process.stdout.write("\x1b[?2004h");
draw();
process.stdin.on("data", (chunk: Buffer) => {
  appendFileSync(join(dir, "raw.bin"), chunk);
  pending += decoder.write(chunk);
  while (pending) {
    if (pending.startsWith("\x1b[200~")) { paste = true; pending = pending.slice(6); continue; }
    if (pending.startsWith("\x1b[201~")) { paste = false; pending = pending.slice(6); continue; }
    if (pending[0] === "\x1b") {
      const csi = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(pending);
      if (!csi && pending.length < 8) break;               // the rest of the sequence is still on its way
      pending = pending.slice(csi ? csi[0].length : 1);     // other keys are ignored
      continue;
    }
    const ch = pending[0] ?? "";
    pending = pending.slice(1);
    if (paste) input += ch === "\r" ? "\n" : ch;
    else if (ch === "\r") submit();
    else if (ch === "\x15") input = "";                     // Ctrl-U: the draft is cleared
    else if (ch >= " " && ch !== "\x7f") input += ch;
  }
  draw();
});
```

- [ ] **Step 3: Check the stand-in by hand on an isolated tmux server**

Run:

```sh
S=test-fixture-$$; D=$(mktemp -d); H=$(mktemp -d); echo "box on n1" > $D/prose.txt
T() { env -u TMUX -u TMUX_PANE tmux -u -L $S "$@"; }
P=$(T new-session -d -s qa -n "fix: a/b ü.2" -x 100 -y 30 -c $D -P -F '#{pane_id}' "$(command -v node)" --no-warnings test/fixtures/fake-claude-pane.ts $D --claude=$H/.claude --session=sid-1 --tmux-session=qa --offset=-10000)
sleep 1; T send-keys -t $P -l "half a thought"; sleep 0.3; T capture-pane -p -t $P | grep '❯'
T send-keys -t $P C-u; sleep 0.3; T capture-pane -p -t $P | grep '❯'
printf 'hello\nfrom the paste' | T load-buffer -b b1 -; T paste-buffer -p -d -b b1 -t $P; T send-keys -t $P Enter; sleep 0.5
cat $D/submitted.jsonl; cat $H/.claude/sessions/*.json; echo; tail -1 $H/.claude/projects/-qa/sid-1.jsonl; date -u +%FT%TZ
T kill-server; rm -rf $D $H
```

Expected (seen on 2026-10-06 with tmux 3.6a):
- `❯ half a thought`, then `❯`: the draft is shown, then cleared.
- `"hello\nfrom the paste"`.
- A session file with `"tmux":"qa:@0.%0"`.
- A transcript line whose `timestamp` is 10 s before the `date` printed after it.

- [ ] **Step 4: Write `test/fleet-harness.ts`**

```ts
// Shared spawning for the fleet's cross-app tests (test/fleet/*.test.ts), its two-node e2e (e2e/fleet-two-node.e2e.ts)
// and its QA helper (e2e/fleet-qa.ts). It runs:
// - a real `morndo-fleet`, real `morndo-node` agents and a real hub in fleet mode (MORNDO_FLEET_SOCKET);
// - each as a child process with its own temporary HOME, on random free ports;
// - every agent on its own isolated tmux server (`tmux -L test-<uuid>`);
// - lanes that are test/fixtures/fake-claude-pane.ts, never the real agent CLI.
// Nothing here reads or touches the owner's tmux servers, ~/.claude, ports 8787/8790/8791 or Morndo data. It imports no
// vitest: the e2e script uses it too. stopAll() stops everything it started, and an exit hook does the same if a test
// file dies.
// Why the repo root and not e2e/: e2e/ holds standalone scripts that need the built web app and Chromium (npm run e2e).
// These helpers also serve vitest files that CI's test step must run, and they span three apps, so no app's test folder
// owns them.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket } from "ws";
import { endpointId, pairingTokenId, sessionId } from "@morndo/domain";
import { Store } from "../apps/hub/src/adapters/store.ts";
import { hashSecret } from "../apps/hub/src/application/access-service.ts";
import { FleetClient } from "../apps/hub/src/adapters/fleet-client.ts";
import { loadConfig, type AgentConfig } from "../apps/node-agent/src/config.ts";
import { agentPaths } from "../apps/node-agent/src/paths.ts";
import type { TestHooks } from "../apps/node-agent/src/test-hooks.ts";
import type { FleetConfig } from "../apps/fleet/src/config.ts";
import { exactSession, tmuxArgv, tmuxLiteral } from "../packages/node-ops/src/tmux-cli.ts";
import { isolatedTmux } from "../packages/node-ops/test/isolated-tmux.ts";
import type { Expect, HookEvent, OpName, Pane } from "../packages/protocol/src/fleet.ts";
import { parseWorkerId } from "../packages/protocol/src/worker-id.ts";

export { sleep };
export const ROOT = join(import.meta.dirname, "..");
export const AGENT_MAIN = join(ROOT, "apps/node-agent/src/main.ts");
export const FLEET_MAIN = join(ROOT, "apps/fleet/src/main.ts");
export const HUB_MAIN = join(ROOT, "apps/hub/src/main.ts");
export const FAKE_CLAUDE = join(ROOT, "test/fixtures/fake-claude-pane.ts");

const ALL_OPS: OpName[] = ["inventory.get", "pane.captureMany", "pane.frame", "pane.keys", "pane.send", "op.status",
  "transcript.size", "transcript.read", "transcript.locate", "file.stat", "file.get", "file.put", "lane.start", "lane.stop",
  "worktree.list", "worktree.add"];

// ---- bookkeeping: everything started here is stopped by stopAll(), or by the exit hook below if a test file dies.
const procs = new Set<Proc>();
const servers = new Set<string>();
const dirs = new Set<string>();
const closers: (() => void | Promise<void>)[] = [];

function tempDir(prefix: string, base = tmpdir()): string {
  const d = mkdtempSync(join(base, prefix));
  dirs.add(d);
  return d;
}
const tmuxEnv = (): NodeJS.ProcessEnv => { const env = { ...process.env }; delete env.TMUX; delete env.TMUX_PANE; return env; };

export async function stopAll(): Promise<void> {
  for (const close of closers.splice(0).reverse()) { try { await close(); } catch { /* already gone */ } }
  await Promise.all([...procs].map(p => p.stop()));
  for (const s of servers) spawnSync("tmux", ["-L", s, "kill-server"], { env: tmuxEnv() });
  servers.clear();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.clear();
}
process.once("exit", () => {
  for (const p of procs) { try { p.child.kill("SIGKILL"); } catch { /* gone */ } }
  for (const s of servers) spawnSync("tmux", ["-L", s, "kill-server"], { env: tmuxEnv() });
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// A child's environment: the test's own, minus anything that could point it at the owner's system, with its own HOME.
const DROP = /^(MORNDO_|CLAUDE_CONFIG_DIR$|TMUX$|TMUX_PANE$|XDG_(CONFIG|STATE|DATA|RUNTIME)_)/;
export function cleanEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!DROP.test(k)) env[k] = v;
  return { ...env, HOME: home, ...extra };
}

export const freePort = () => new Promise<number>(resolve => {
  const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => resolve(p)); });
});

// Waits until f returns something truthy. On timeout the error names what it waited for, the last error f threw, and
// the tail of every live process's log.
export async function until<T>(what: string, f: () => T | Promise<T>, ms = 10_000, every = 100): Promise<NonNullable<T>> {
  const end = performance.now() + ms;
  let last: unknown = null;
  for (;;) {
    try { const v = await f(); if (v) return v as NonNullable<T>; } catch (e) { last = e; }
    if (performance.now() > end) {
      const logs = [...procs].map(p => `--- ${p.name} (${p.log})\n${p.tail(15)}`).join("\n");
      throw new Error(`timed out after ${ms} ms waiting for ${what}${last ? ` (last error: ${(last as Error).message})` : ""}\n${logs}`);
    }
    await sleep(every);
  }
}

// ---- child processes
export type Proc = {
  name: string; child: ChildProcess; log: string;
  alive(): boolean; stop(signal?: NodeJS.Signals): Promise<void>; pause(): void; resume(): void; tail(lines?: number): string;
};
function startProc(name: string, args: string[], env: NodeJS.ProcessEnv, log: string): Proc {
  const child = spawn(process.execPath, ["--no-warnings", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (d: Buffer) => appendFileSync(log, d));
  child.stderr?.on("data", (d: Buffer) => appendFileSync(log, d));
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  let paused = false;
  const p: Proc = {
    name, child, log,
    alive: () => child.exitCode === null && child.signalCode === null,
    async stop(signal = "SIGTERM") {
      procs.delete(p);
      if (!p.alive()) return;
      if (paused) { child.kill("SIGCONT"); paused = false; }                 // a stopped process can't act on SIGTERM
      child.kill(signal);
      const force = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(force);
    },
    pause() { child.kill("SIGSTOP"); paused = true; },
    resume() { child.kill("SIGCONT"); paused = false; },
    tail: (lines = 20) => (existsSync(log) ? readFileSync(log, "utf8").split("\n").slice(-lines).join("\n") : ""),
  };
  procs.add(p);
  return p;
}

// ---- isolated tmux servers and lanes (tmux(1): -L, new-session/new-window -P -F, a command given as several arguments
// runs without sh -c, user options start with @; https://man7.org/linux/man-pages/man1/tmux.1.html, read 2026-10-06).
// node-ops' rules (Task 2): every call passes -u, a session target is "=name", every argument tmux expands as a format
// (a window name, a new session's name, the start directory) goes through tmuxLiteral ("#" as "##"), and a pane is
// targeted by its %N, never by a window name; and the shared isolatedTmux, whose kill() waits until the server is gone,
// so a drill can start a new one at once.
export type TmuxServer = { socket: string; run(...args: string[]): string; has(session: string): boolean; stamp(): string | null; kill(): void };
export function tmuxServer(): TmuxServer {
  const t = isolatedTmux();
  servers.add(t.socket);
  const quiet = (args: string[]) => spawnSync("tmux", tmuxArgv(t.socket, args), { env: tmuxEnv(), encoding: "utf8" });
  return {
    socket: t.socket,
    run: (...args) => t.tmux(...args),
    has: session => quiet(["has-session", "-t", exactSession(session)]).status === 0,
    stamp: () => {
      const r = quiet(["show-options", "-gqv", "@morndo-server"]);
      return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
    },
    kill: () => t.kill(),
  };
}

function openWindow(t: TmuxServer, session: string, window: string, cwd: string, command: string[]): string {
  const where = t.has(session)
    ? ["new-window", "-d", "-t", `${exactSession(session)}:`, "-n", tmuxLiteral(window)]
    : ["new-session", "-d", "-s", tmuxLiteral(session), "-n", tmuxLiteral(window), "-x", "100", "-y", "30"];
  return t.run(...where, "-c", tmuxLiteral(cwd), "-P", "-F", "#{pane_id}", ...command).trim();
}

export type Lane = {
  window: string; paneId: string; dir: string; sessionId: string | null; transcript: string | null;
  submitted(): string[]; screen(): string; draft(text: string): void; clear(): void;
};
// A lane: one window running the fixture. With `claudeHome` (an agent's HOME), the fixture writes its session file and
// transcript into <claudeHome>/.claude, so the agent reports its session and serves its transcript.
export async function fakeLane(t: TmuxServer, o: { window: string; session?: string; prose?: string; claudeHome?: string; offsetMs?: number }): Promise<Lane> {
  const session = o.session ?? "qa";
  const dir = tempDir("morndo-lane-");
  if (o.prose) writeFileSync(join(dir, "prose.txt"), o.prose);
  const sessionId = o.claudeHome ? randomUUID() : null;
  const claude = o.claudeHome ? join(o.claudeHome, ".claude") : null;
  const paneId = openWindow(t, session, o.window, dir, [process.execPath, "--no-warnings", FAKE_CLAUDE, dir,
    ...(claude && sessionId ? [`--claude=${claude}`, `--session=${sessionId}`, `--tmux-session=${session}`] : []),
    ...(o.offsetMs ? [`--offset=${o.offsetMs}`] : [])]);
  const screen = () => t.run("capture-pane", "-p", "-t", paneId);
  await until(`${o.window}'s input box`, () => screen().includes("❯"));
  const file = join(dir, "submitted.jsonl");
  return {
    window: o.window, paneId, dir, sessionId,
    transcript: claude && sessionId ? join(claude, "projects", "-qa", `${sessionId}.jsonl`) : null,
    submitted: () => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l) as string) : []),
    screen,
    draft: text => { t.run("send-keys", "-t", paneId, "-l", text); },
    clear: () => { t.run("send-keys", "-t", paneId, "C-u"); },
  };
}
// A plain shell window; `split` adds a second pane (a window with two panes is no lane, spec §4).
export function shellLane(t: TmuxServer, o: { window: string; session?: string; split?: boolean }): { window: string; paneId: string } {
  const paneId = openWindow(t, o.session ?? "qa", o.window, tmpdir(), ["bash", "--norc", "--noprofile"]);
  if (o.split) t.run("split-window", "-d", "-t", paneId, "bash", "--norc", "--noprofile");
  return { window: o.window, paneId };
}

// ---- the fleet service
export type Fleet = {
  home: string; port: number; socketPath: string; config: FleetConfig; client: FleetClient; proc(): Proc;
  cli(...args: string[]): { code: number | null; out: string; err: string };
  addNode(name: string): string; revoke(name: string): void;
  // Stops the service (SIGKILL by default), runs `whileDown` while nothing listens, then serves again on the same database.
  restart(signal?: NodeJS.Signals, whileDown?: () => Promise<void>): Promise<void>;
};
export async function startFleet(o: { subscribers?: FleetConfig["subscribers"] } = {}): Promise<Fleet> {
  const home = tempDir("morndo-fleet-");
  // The client socket's path must fit sockaddr_un.sun_path: 103 bytes on macOS, 107 on Linux
  // (https://nodejs.org/docs/latest-v24.x/api/net.html#identifying-paths-for-ipc-connections, read 2026-10-06). A temp
  // HOME on macOS is ~60 already, so the socket gets a short directory under /tmp, mode 0700 (mkdtemp), owned by us, as
  // the fleet requires (spec §5.6). The agent endpoint listens on loopback with a ws:// public URL to loopback: the only
  // plain ws:// the fleet's config (Task 10) and the agent (fleetUrlOk, Task 7) accept.
  const sockDir = tempDir("mf-", "/tmp");
  const port = await freePort();
  const config: FleetConfig = {
    listen: { host: "127.0.0.1", port }, socketPath: join(sockDir, "fleet.sock"),
    dbPath: join(home, ".local/share/morndo-fleet/fleet.db"), keyPath: join(home, ".local/share/morndo-fleet/fleet-key.pem"),
    publicUrl: `ws://127.0.0.1:${port}/agent`, subscribers: o.subscribers ?? [],
  };
  mkdirSync(join(home, ".config/morndo-fleet"), { recursive: true });
  writeFileSync(join(home, ".config/morndo-fleet/config.json"), JSON.stringify(config, null, 2));
  const env = cleanEnv(home);
  const client = new FleetClient(config.socketPath);
  let proc: Proc | null = null;
  const serve = async () => {
    proc = startProc("fleet", [FLEET_MAIN, "serve"], env, join(home, "fleet.log"));
    await until("the fleet's client API", async () => (await client.caps()).api.includes(1), 15_000);
  };
  await serve();
  const cli = (...args: string[]) => {
    const r = spawnSync(process.execPath, ["--no-warnings", FLEET_MAIN, ...args], { env, encoding: "utf8", timeout: 30_000 });
    return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
  };
  return {
    home, port, socketPath: config.socketPath, config, client, cli,
    proc: () => { if (!proc) throw new Error("the fleet isn't running"); return proc; },
    addNode(name) {
      const r = cli("node", "add", name);
      const line = r.out.split("\n").map(l => l.trim()).find(l => l.startsWith("morndo-join:1:"));
      if (r.code !== 0 || !line) throw new Error(`morndo-fleet node add ${name} exited ${r.code}: ${r.err}`);
      return line;
    },
    revoke(name) {
      const r = cli("node", "revoke", name);
      if (r.code !== 0) throw new Error(`morndo-fleet node revoke ${name} exited ${r.code}: ${r.err}`);
    },
    async restart(signal = "SIGKILL", whileDown) { await proc?.stop(signal); await whileDown?.(); await serve(); },
  };
}

// ---- node agents
export type Agent = {
  node: string; home: string; configPath: string; readonly relayPort: number;
  config(): AgentConfig; proc(): Proc | null;
  run(hooks?: TestHooks): Promise<void>; stop(signal?: NodeJS.Signals): Promise<void>;
  waitOnline(ms?: number): Promise<void>; waitOffline(ms?: number): Promise<void>;
  resetDatabase(hooks?: TestHooks): Promise<void>; clone(): Promise<Agent>;
};
// `node add` → `join` in a fresh HOME, then this test's relay port goes into config.json and its tmux server and session
// into policy.json (the agent keeps the two apart, Task 6: a policy written into config.json would be ignored, and the
// agent would act on the default tmux server). Not run yet.
export async function joinAgent(fleet: Fleet, node: string, o: { tmux: TmuxServer; session?: string; policy?: Partial<AgentConfig["policy"]> }): Promise<Agent> {
  const home = tempDir(`morndo-node-${node}-`);
  const joinString = fleet.addNode(node);
  // The fleet is a child process, so waiting on `join` synchronously blocks nothing it needs.
  const r = spawnSync(process.execPath, ["--no-warnings", AGENT_MAIN, "join", joinString], { env: cleanEnv(home), encoding: "utf8", timeout: 30_000 });
  if (r.status !== 0) throw new Error(`morndo-node join ${node} exited ${r.status}: ${r.stderr}${r.stdout}`);
  const paths = agentPaths(home);
  const stored = JSON.parse(readFileSync(paths.configFile, "utf8")) as Record<string, unknown>;
  writeFileSync(paths.configFile, JSON.stringify({ ...stored, relayPort: await freePort() }, null, 2), { mode: 0o600 });
  writeFileSync(paths.policyFile, JSON.stringify({
    ops: ALL_OPS, session: o.session ?? "qa", tmuxSocket: o.tmux.socket, repoRoots: [join(home, "repos")], lockedPanes: {}, ...o.policy,
  }, null, 2), { mode: 0o600 });
  // A test agent never runs on anyone's default tmux server: read the config back as the agent will.
  const loaded = loadConfig(home);
  if (loaded.policy.tmuxSocket !== o.tmux.socket) throw new Error(`${node}'s policy names tmux socket ${String(loaded.policy.tmuxSocket)}, not the test's`);
  return agentAt(fleet, node, home);
}

function agentAt(fleet: Fleet, node: string, home: string): Agent {
  const configPath = agentPaths(home).configFile;
  const config = () => loadConfig(home);
  const status = async () => (await fleet.client.nodes()).find(n => n.name === node)?.status ?? null;
  let proc: Proc | null = null;
  const a: Agent = {
    node, home, configPath, config,
    get relayPort() { return config().relayPort; },
    proc: () => proc,
    async run(hooks) {
      // The agent refuses test hooks unless NODE_ENV is "test" and its HOME isn't the account's own (Task 8).
      const extra: Record<string, string> = hooks ? { MORNDO_NODE_TEST_HOOKS: JSON.stringify(hooks), NODE_ENV: "test" } : {};
      proc = startProc(`agent ${node} (${home})`, [AGENT_MAIN, "run"], cleanEnv(home, extra), join(home, "agent.log"));
    },
    async stop(signal = "SIGTERM") { await proc?.stop(signal); proc = null; },
    async waitOnline(ms = 15_000) { await until(`${node} online`, async () => (await status()) === "online", ms); },
    async waitOffline(ms = 15_000) { await until(`${node} not online`, async () => (await status()) !== "online", ms); },
    async resetDatabase(hooks) {
      await a.stop();
      await a.waitOffline();
      const db = config().dbPath;
      for (const f of [db, `${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
      await a.run(hooks);
      await a.waitOnline();
    },
    // A cloned machine: the same config, policy and private key in another HOME, with its own relay port (a clone has its
    // own loopback) and a fresh database (copying a live WAL database could tear it, and the conflict doesn't depend on it).
    async clone() {
      const twin = tempDir(`morndo-node-${node}-twin-`);
      const original = config();
      const moved = JSON.parse(readFileSync(configPath, "utf8").replaceAll(home, twin)) as Record<string, unknown> & { keyPath: string };
      mkdirSync(dirname(moved.keyPath), { recursive: true });
      cpSync(original.keyPath, moved.keyPath);
      cpSync(agentPaths(home).policyFile, agentPaths(twin).policyFile);
      writeFileSync(agentPaths(twin).configFile, JSON.stringify({ ...moved, relayPort: await freePort() }, null, 2), { mode: 0o600 });
      return agentAt(fleet, node, twin);
    },
  };
  return a;
}

// Every status flip of one node from now on ("online" | "stale" | "offline"), from the fleet's events. A new events
// subscription first replays each registered node's current status (Contracts, `WS /v1/events`): that frame is not a
// flip, so it is awaited and discarded before this returns. Awaiting it also means the subscription is live, so a drop
// that follows is seen (a subscription still connecting would miss it). A reconnect of the subscription (a fleet
// restart) replays the status again, recorded like a flip; the drills that restart the fleet don't use this.
export async function statuses(fleet: Fleet, node: string): Promise<string[]> {
  const seen: string[] = [];
  let replayed = false;
  closers.push(fleet.client.events(e => {
    if (e.t !== "status" || e.node !== node) return;
    if (!replayed) { replayed = true; return; }
    seen.push((e.body as { status: string }).status);
  }));
  await until(`${node}'s current status replayed to a new events subscription`, () => replayed);
  return seen;
}

export async function paneOf(client: FleetClient, node: string, window: string): Promise<Pane> {
  const r = await client.op({ node }, "inventory.get", {});
  if (!r.ok) throw new Error(`inventory.get on ${node}: ${r.error.code}`);
  const p = r.result.panes.find(x => x.window === window);
  if (!p) throw new Error(`no pane "${window}" on ${node}: ${r.result.panes.map(x => x.window).join(", ")}`);
  return p;
}
export function expectOf(p: Pane): Expect {
  const ref = parseWorkerId(p.workerId);
  if (!ref) throw new Error(`not a worker id: ${p.workerId}`);
  return { server: ref.server, window: p.window, ...(p.sessionId ? { sessionId: p.sessionId } : {}) };
}

// ---- the hook relay and a test subscriber on the hook bus
export async function hook(agent: Agent, path: HookEvent["path"], body: unknown): Promise<{ status: number; text: string }> {
  const r = await fetch(`http://127.0.0.1:${agent.relayPort}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, text: await r.text() };
}
export const keyParts = (key: string) => {
  const [node = "", streamId = "", seq = "0"] = key.split(":");
  return { node, streamId, seq: Number(seq) };
};
export type Delivery = { key: string; event: HookEvent; got: number };
export type Subscriber = { url: string; received: Delivery[]; unique(): Map<string, Delivery> };
// Records each delivery before it answers (after `delayMs`), so a fleet killed mid-request redelivers it: at least once.
export async function subscriber(o: { delayMs?: number } = {}): Promise<Subscriber> {
  const received: Delivery[] = [];
  const server = createHttpServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (d: Buffer) => parts.push(d));
    req.on("end", () => {
      received.push({ key: String(req.headers["idempotency-key"] ?? ""), event: JSON.parse(Buffer.concat(parts).toString()) as HookEvent, got: performance.now() });
      setTimeout(() => res.writeHead(200).end(), o.delayMs ?? 0);
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`,
    received,
    unique: () => { const m = new Map<string, Delivery>(); for (const d of received) if (!m.has(d.key)) m.set(d.key, d); return m; },
  };
}

// ---- the hub in fleet mode
export type FeedWatch = {
  workers(): { id: string; name: string }[];
  seen: Set<string>; names: Set<string>;                        // every worker id and name the hub ever listed here
  screens: { worker: string; text: string; got: number }[];    // screen frames of the watched worker
  watch(worker: string | null): void; close(): void;
};
export type Reply = { status: number; body: Record<string, unknown> };
export type Hub = {
  base: string; origin: string; port: number; home: string; cookie: string; env: NodeJS.ProcessEnv;
  post(path: string, body: unknown): Promise<Reply>;
  send(workerId: string, text: string, requestId?: string): Promise<Reply>;
  answer(id: string, key: string, requestId?: string): Promise<Reply>;
  feed(): Promise<FeedWatch>; audit(): string; pairUrl(): string; stop(): Promise<void>;
};

// A device and a verified session written straight into the hub's database before it starts, as e2e/qa-session.ts
// does, so a test can steer with a cookie and no passkey.
function seedSession(home: string): string {
  const store = new Store(home);
  const now = Date.now();
  const secret = randomBytes(32).toString("base64url");
  const id = `fleet-test-${randomBytes(4).toString("hex")}`;
  store.transaction(() => {
    store.saveEndpoint({
      id: endpointId(id), name: "fleet test", credential: { id, publicKey: new Uint8Array([0]), counter: 0, transports: [] },
      pairedAt: now, pairedWith: pairingTokenId("fleet-test-seeded"), lastSeenAt: now, revokedAt: null,
    });
    store.saveSession({ id: sessionId(hashSecret(secret)), endpointId: endpointId(id), startedAt: now, lastSeenAt: now, verifiedAt: now, endedAt: null, endReason: null });
  });
  store.close();
  return secret;
}

export async function startHub(fleet: Fleet, o: { pollMs?: number; web?: "stub" | "build"; ledger?: unknown } = {}): Promise<Hub> {
  const home = tempDir("morndo-hub-");
  const port = await freePort();
  const origin = `http://localhost:${port}`;
  const base = `http://127.0.0.1:${port}`;
  let web = join(ROOT, "apps/web/build");
  if (o.web !== "build") {
    web = join(home, "web");
    mkdirSync(web);
    writeFileSync(join(web, "200.html"), "<!doctype html><html><body>stub</body></html>");
  }
  const extra: Record<string, string> = {
    MORNDO_HOME: home, MORNDO_PORT: String(port), MORNDO_ORIGIN: origin, MORNDO_FLEET_SOCKET: fleet.socketPath,
    MORNDO_POLL_MS: String(o.pollMs ?? 400), MORNDO_QUIET_AFTER_MS: "2000", MORNDO_WEB_DIR: web, MORNDO_INBOX: join(home, "inbox"),
  };
  if (o.ledger !== undefined) {
    const ledger = join(home, "ledger.json");
    writeFileSync(ledger, JSON.stringify(o.ledger));
    extra.MORNDO_LEDGER = ledger;
  }
  const env = cleanEnv(home, extra);
  const secret = seedSession(home);
  const log = join(home, "hub.log");
  const proc = startProc("hub", [HUB_MAIN, "serve"], env, log);
  await until("the hub listening", () => existsSync(log) && readFileSync(log, "utf8").includes("morndo hub on"), 30_000);
  const headers = { origin, "content-type": "application/json", cookie: `__Host-morndo=${secret}` };
  const post = async (path: string, body: unknown): Promise<Reply> => {
    const r = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  };
  const cli = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", HUB_MAIN, ...args], { env, encoding: "utf8", timeout: 30_000 }).stdout ?? "";
  return {
    base, origin, port, home, env, cookie: secret, post,
    send: (workerId, text, requestId = randomUUID()) => post(`/api/workers/${encodeURIComponent(workerId)}/send`, { text, requestId, seen: "none" }),
    answer: (id, key, requestId = randomUUID()) => post(`/api/escalations/${encodeURIComponent(id)}/answer`, { key, requestId }),
    feed: () => openFeed(base, origin, secret),
    audit: () => cli("audit", "200"),
    pairUrl: () => cli("pair").split("\n").find(l => l.includes("/pair#t="))?.trim() ?? "",
    stop: () => proc.stop(),
  };
}

type FeedFrame = {
  t: string; workers?: { id: string; name: string }[]; worker?: string; text?: string;
  events?: { body: { type: string; worker?: { id: string; name: string }; workerId?: string; name?: string } }[];
};
async function openFeed(base: string, origin: string, secret: string): Promise<FeedWatch> {
  const ws = new WebSocket(`${base.replace("http", "ws")}/api/feed`, { headers: { origin, cookie: `__Host-morndo=${secret}` } });
  const roster = new Map<string, string>();
  const seen = new Set<string>();
  const names = new Set<string>();
  const screens: FeedWatch["screens"] = [];
  let snapshots = 0;
  const add = (id: string, name: string) => { roster.set(id, name); seen.add(id); names.add(name); };
  ws.on("message", raw => {
    const m = JSON.parse((Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as ArrayBuffer)).toString("utf8")) as FeedFrame;   // as apps/hub/test frameText
    if (m.t === "snapshot") { roster.clear(); for (const w of m.workers ?? []) add(w.id, w.name); snapshots++; }
    else if (m.t === "events") {
      for (const { body: b } of m.events ?? []) {
        if (b.type === "WorkerAppeared" && b.worker) add(b.worker.id, b.worker.name);
        else if (b.type === "WorkerRenamed" && b.workerId && b.name) add(b.workerId, b.name);
        else if (b.type === "WorkerGone" && b.workerId) roster.delete(b.workerId);
      }
    } else if (m.t === "screen" && m.worker && typeof m.text === "string") screens.push({ worker: m.worker, text: m.text, got: performance.now() });
  });
  ws.on("error", () => { /* a hub that went away: the test's own checks say what failed */ });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("unexpected-response", (_req, res) => reject(new Error(`the feed refused the upgrade: ${res.statusCode}`)));
  });
  closers.push(() => ws.close());
  ws.send(JSON.stringify({ t: "hello" }));
  await until("the hub's first snapshot", () => snapshots > 0);
  return {
    workers: () => [...roster].map(([id, name]) => ({ id, name })),
    seen, names, screens,
    watch: worker => ws.send(JSON.stringify({ t: "watch", worker })),
    close: () => ws.close(),
  };
}
```

If `FleetConfig` or `AgentConfig` gained a required field since the Contracts were written, fill it in here: the type check in Step 8 names it.

- [ ] **Step 5: Write `test/fleet/integration.test.ts`**

```ts
// Real agent + real fleet (spec §9 "Integration"):
// - `node add` → `join` → `run`;
// - the agent's inventory in /v1/lanes;
// - every pane op and the transcript ops through the fleet's client API (FleetClient);
// - revocation.
// Child processes with temporary HOMEs and random ports, one isolated tmux server, and a throwaway ~/.claude in the agent's
// HOME. The fixture pane writes its own session file there (test/fleet-harness.ts, test/fixtures/fake-claude-pane.ts).
// Negative control (spec §9): a send to a missing pane answers no_pane, not executed, and types nothing.
// Review Focus 1: a window named "fix: a/b ü.2" keeps its name through the agent, the fleet and its lane registry.
// Every answer to an op the fleet sent to the node carries the node's store (its database's stream id), op.status's
// too; a refusal before anything was sent carries null (plan Contracts, "Behaviour the agent and the fleet agree on").
// One setup for the whole file, so its tmux server and processes are stopped in afterAll (as apps/hub/test/tmux.test.ts).
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LIMITS } from "../../packages/protocol/src/fleet.ts";
import { WORKER_ID, formatWorkerId, parseWorkerId } from "../../packages/protocol/src/worker-id.ts";
import { expectOf, fakeLane, joinAgent, paneOf, shellLane, sleep, startFleet, stopAll, tmuxServer, until, type Agent, type Fleet, type Lane, type TmuxServer } from "../fleet-harness.ts";

const ODD = "fix: a/b ü.2";
let fleet: Fleet;
let agent: Agent;
let tmux: TmuxServer;
let box: Lane;
let plain: Lane;

beforeAll(async () => {
  fleet = await startFleet();
  tmux = tmuxServer();
  agent = await joinAgent(fleet, "n1", { tmux });
  box = await fakeLane(tmux, { window: "box", prose: "box on n1", claudeHome: agent.home });
  plain = await fakeLane(tmux, { window: "plain" });
  shellLane(tmux, { window: ODD });
  shellLane(tmux, { window: "split", split: true });                 // two panes: not a lane
  shellLane(tmux, { window: "elsewhere", session: "other" });        // not the policy's session
  await agent.run();
  await agent.waitOnline();
}, 60_000);
afterAll(stopAll);

const key = () => `hub:it-${randomUUID()}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let sendKey = "";
let sendStore = "";

describe("a real agent joined to a real fleet", () => {
  it("joins through node add → join → run, and is online with its agent version", async () => {
    const n = (await fleet.client.nodes()).find(x => x.name === "n1");
    expect(n?.status).toBe("online");
    expect(n?.agent).toBeTruthy();
  });

  it("puts its lanes in /v1/lanes: one-pane windows of the policy's session only, the odd name intact", async () => {
    const lanes = await until("n1's three lanes", async () => {
      const l = (await fleet.client.lanes()).filter(x => x.node === "n1");
      return l.length === 3 ? l : null;
    });
    expect(lanes.map(l => l.name).sort()).toEqual(["box", ODD, "plain"].sort());
    const stamp = tmux.stamp();
    expect(stamp).toMatch(/^[0-9a-f]{8}/);
    for (const l of lanes) {
      expect(l.workerId).toMatch(WORKER_ID);
      expect(parseWorkerId(l.workerId ?? "")).toMatchObject({ node: "n1", server: stamp?.slice(0, 8) });
      expect(l.conflict).toBe(false);
    }
  });

  it("reports the session that the pane's session file names", async () => {
    expect((await paneOf(fleet.client, "n1", "box")).sessionId).toBe(box.sessionId);
    expect((await paneOf(fleet.client, "n1", "plain")).sessionId).toBeUndefined();
  });

  it("pane.send types once into the input box and answers the node's time of typing", async () => {
    const p = await paneOf(fleet.client, "n1", "box");
    const before = Date.now();
    sendKey = key();
    const r = await fleet.client.op({ workerId: p.workerId }, "pane.send", { workerId: p.workerId, text: "integration: hello box", expect: expectOf(p) }, { key: sendKey });
    const after = Date.now();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.store).toMatch(UUID);
    sendStore = r.store;
    expect(r.result.problem).toBeNull();
    expect(r.result.typedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(r.result.typedAt).toBeLessThanOrEqual(after + 1000);
    await until("the text in box", () => box.submitted().includes("integration: hello box"));
    await sleep(500);
    expect(box.submitted().filter(t => t === "integration: hello box")).toHaveLength(1);
  });

  it("op.status: the send's key is done with its result, from the store that took it; a key never used is unknown", async () => {
    const p = await paneOf(fleet.client, "n1", "box");
    const done = await fleet.client.op({ workerId: p.workerId }, "op.status", { key: sendKey });
    expect(done).toMatchObject({ ok: true, store: sendStore, result: { state: "done", outcome: { problem: null } } });
    expect(await fleet.client.op({ workerId: p.workerId }, "op.status", { key: key() })).toMatchObject({ ok: true, store: sendStore, result: { state: "unknown" } });
  });

  it("answers a send to a missing pane with no_pane, not executed, and types nothing (negative control)", async () => {
    const p = await paneOf(fleet.client, "n1", "box");
    const missing = formatWorkerId({ node: "n1", server: parseWorkerId(p.workerId)?.server ?? "", pane: 999 });
    const before = [box.submitted().length, plain.submitted().length];
    const r = await fleet.client.op({ workerId: missing }, "pane.send", { workerId: missing, text: "integration: nowhere", expect: expectOf(p) }, { key: key() });
    expect(r).toMatchObject({ ok: false, error: { code: "no_pane", executed: "no" }, store: sendStore });   // the node answered it
    await sleep(500);
    expect([box.submitted().length, plain.submitted().length]).toEqual(before);
  });

  it("pane.keys types into the pane, and the Enter in them submits", async () => {
    const p = await paneOf(fleet.client, "n1", "plain");
    const r = await fleet.client.op({ workerId: p.workerId }, "pane.keys", { workerId: p.workerId, data: "keys-ok\r", expect: expectOf(p) });
    expect(r).toMatchObject({ ok: true, result: { ok: true } });
    await until("the keys submitted in plain", () => plain.submitted().includes("keys-ok"));
  });

  it("pane.frame returns the pane as tmux draws it", async () => {
    const p = await paneOf(fleet.client, "n1", "box");
    const r = await fleet.client.op({ workerId: p.workerId }, "pane.frame", { workerId: p.workerId });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.frame).toMatchObject({ cols: 100, rows: 30 });
    const text = r.result.frame?.lines.join("\n") ?? "";
    expect(text).toContain("box on n1");
    expect(text).toContain("❯");
  });

  it("pane.captureMany captures several panes in one op, with null for a missing one", async () => {
    const [b, o] = await Promise.all([paneOf(fleet.client, "n1", "box"), paneOf(fleet.client, "n1", ODD)]);
    const missing = formatWorkerId({ node: "n1", server: parseWorkerId(b.workerId)?.server ?? "", pane: 999 });
    const r = await fleet.client.op({ node: "n1" }, "pane.captureMany", { workerIds: [b.workerId, o.workerId, missing] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const by = new Map(r.result.captures.map(c => [c.workerId, c]));
    expect(by.get(b.workerId)?.text).toContain("box on n1");
    expect(typeof by.get(o.workerId)?.text).toBe("string");
    expect(by.get(missing)?.text).toBeNull();
  });

  it("transcript.size and transcript.read return the session's bytes, in chunks of at most 256 KiB, past a long line", async () => {
    const path = box.transcript ?? "";
    const sid = box.sessionId ?? "";
    // A 600 KiB line: more than two chunks (real transcripts carry lines up to 3.7 MB, spec §1).
    appendFileSync(path, `${JSON.stringify({ type: "assistant", uuid: "long-1", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "x".repeat(600 * 1024) }] } })}\n`);
    expect(await fleet.client.op({ node: "n1" }, "transcript.size", { sessionId: sid })).toMatchObject({ ok: true, result: { size: statSync(path).size } });
    expect(await fleet.client.op({ node: "n1" }, "transcript.size", { sessionId: randomUUID() })).toMatchObject({ ok: true, result: { size: null } });
    const parts: Buffer[] = [];
    for (let offset = 0, eof = false; !eof;) {
      const r = await fleet.client.op({ node: "n1" }, "transcript.read", { sessionId: sid, offset, max: LIMITS.chunkBytes });
      if (!r.ok) throw new Error(`transcript.read at ${offset}: ${r.error.code}`);
      const bytes = Buffer.from(r.result.bytes, "base64");
      expect(bytes.length).toBeLessThanOrEqual(LIMITS.chunkBytes);
      parts.push(bytes);
      offset += bytes.length;
      eof = r.result.eof;
      expect(parts.length).toBeLessThan(10);                          // a read that never moves would loop forever
    }
    expect(Buffer.concat(parts).equals(readFileSync(path))).toBe(true);
  });

  it("transcript.locate finds the line that holds a message id, and null for an absent one", async () => {
    const sid = box.sessionId ?? "";
    const file = readFileSync(box.transcript ?? "");
    const at = file.indexOf('"uuid":"seed-2"');
    const lineStart = file.lastIndexOf(0x0a, at) + 1;
    const lineEnd = file.indexOf(0x0a, at);
    const r = await fleet.client.op({ node: "n1" }, "transcript.locate", { sessionId: sid, needle: "seed-2" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.result.offset).not.toBeNull();
    expect(r.result.offset ?? -1).toBeGreaterThanOrEqual(lineStart);
    expect(r.result.offset ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(lineEnd);
    expect(await fleet.client.op({ node: "n1" }, "transcript.locate", { sessionId: sid, needle: "no-such-message" })).toMatchObject({ ok: true, result: { offset: null } });
  });

  it("revoke: the live node is cut off at once, its ops are refused as not executed, and it never comes back", async () => {
    const p = await paneOf(fleet.client, "n1", "box");
    fleet.revoke("n1");
    await agent.waitOffline(5000);
    const r = await fleet.client.op({ node: "n1" }, "pane.captureMany", { workerIds: [p.workerId] });
    expect(r).toMatchObject({ ok: false, error: { code: "node_offline", executed: "no" }, store: null });   // never sent
    expect((await fleet.client.lanes()).filter(l => l.node === "n1")).toEqual([]);                       // its lanes are dropped
    await agent.stop();
    await agent.run();                                                // a fresh process with the revoked key
    for (const end = performance.now() + 5000; performance.now() < end;) {
      expect((await fleet.client.nodes()).find(n => n.name === "n1")?.status ?? "offline").not.toBe("online");
      await sleep(250);
    }
  });
});
```

- [ ] **Step 6: Write `test/fleet/duplicate-names.test.ts`**

```ts
// Duplicate lane names (spec §4 "Lane names"; plan Contracts: "Hub ports" listWorkers, "Hub services" the manager, and
// the client API's routing). Real fleet, real agents and the hub in fleet mode (test/fleet-harness.ts).
// - Two `claude` windows on one node: the hub lists both, each under its own worker ID, and a send by worker ID types
//   into the pane picked, and only there (the owner picked one pane). The fleet keeps one row for the name, in
//   conflict, with no worker, and refuses a route by the name itself (lane_conflict, not executed, nothing sent).
// - A `manager` window on each of two nodes: the manager's name is in conflict, so an answer to the manager's ask is
//   refused (409 lane_conflict) and typed in neither pane.
// Negative control: once one of the two managers is gone, the same answer types once, into the one left. The refusal
// was the conflict, not a broken answer path.
// No manager pane has a session file: with one, the hub would read the tap back from its conversation and count the
// ask as answered there (E8).
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { parseWorkerId } from "../../packages/protocol/src/worker-id.ts";
import { fakeLane, joinAgent, sleep, startFleet, startHub, stopAll, tmuxServer, until, type FeedWatch, type Lane } from "../fleet-harness.ts";

afterEach(stopAll);

const TAP = "[tap ny-1] ship (Ship it)";
const ledger = () => ({ needsYou: [{ id: "ny-1", kind: "tap", question: "Ship the conflict build?",
  options: [{ key: "ship", label: "Ship it" }, { key: "hold", label: "Hold" }],
  deadline: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), ts: new Date().toISOString() }] });
// The worker ID the hub lists for a lane's pane (`%N` is the worker ID's pane number).
const idOf = (feed: FeedWatch, lane: Lane) => {
  const id = feed.workers().find(w => parseWorkerId(w.id)?.pane === Number(lane.paneId.slice(1)))?.id;
  if (!id) throw new Error(`the hub doesn't list ${lane.paneId}: ${JSON.stringify(feed.workers())}`);
  return id;
};

describe("two windows of one name on one node", () => {
  it("the hub lists both and steers each by its worker ID; a route by the name is refused", async () => {
    const fleet = await startFleet();
    const tmux = tmuxServer();
    const agent = await joinAgent(fleet, "n1", { tmux });
    const first = await fakeLane(tmux, { window: "claude", prose: "the first claude" });
    const second = await fakeLane(tmux, { window: "claude", prose: "the second claude" });
    await agent.run();
    await agent.waitOnline();
    const lane = await until("claude in conflict in the registry", async () => {
      const l = (await fleet.client.lanes()).find(x => x.name === "claude");
      return l?.conflict ? l : null;
    }, 15_000);
    expect(lane).toMatchObject({ node: "n1", workerId: null, conflict: true });
    const hub = await startHub(fleet);
    const feed = await hub.feed();
    const both = await until("both claude windows on the hub", () => {
      const ws = feed.workers().filter(w => w.name === "claude");
      return ws.length === 2 ? ws : null;
    }, 15_000);
    expect(both.every(w => w.id.startsWith("n1."))).toBe(true);
    expect(new Set(both.map(w => w.id)).size).toBe(2);
    expect(await hub.send(idOf(feed, second), "to the second claude")).toMatchObject({ status: 200, body: { ok: true } });
    await until("the text in the second claude", () => second.submitted().includes("to the second claude"));
    const byName = await fleet.client.op({ lane: "claude" }, "pane.send",
      { workerId: idOf(feed, first), text: "by the name", expect: { server: parseWorkerId(idOf(feed, first))?.server ?? "", window: "claude" } },
      { key: `hub:dup-${randomUUID()}` });
    expect(byName).toMatchObject({ ok: false, error: { code: "lane_conflict", executed: "no" }, store: null });
    await sleep(1000);
    expect(first.submitted()).toEqual([]);
    expect(second.submitted()).toEqual(["to the second claude"]);
  });
});

describe("a manager window on each of two nodes", () => {
  it("an answer is refused (lane_conflict) and typed in neither; with one manager left, it types once (negative control)", async () => {
    const fleet = await startFleet();
    const [t1, t2] = [tmuxServer(), tmuxServer()];
    const n1 = await joinAgent(fleet, "n1", { tmux: t1 });
    const n2 = await joinAgent(fleet, "n2", { tmux: t2 });
    const m1 = await fakeLane(t1, { window: "manager", prose: "manager on n1" });
    const m2 = await fakeLane(t2, { window: "manager", prose: "manager on n2" });
    await Promise.all([n1.run(), n2.run()]);
    await Promise.all([n1.waitOnline(), n2.waitOnline()]);
    await until("manager in conflict", async () => (await fleet.client.lanes()).find(l => l.name === "manager")?.conflict === true, 15_000);
    const hub = await startHub(fleet, { ledger: ledger() });
    const feed = await hub.feed();
    await until("both managers on the hub", () => feed.workers().filter(w => w.name === "manager").length === 2, 15_000);
    expect(await hub.answer("ny-1", "ship")).toMatchObject({ status: 409, body: { error: "lane_conflict" } });
    await sleep(1500);
    expect([m1.submitted(), m2.submitted()]).toEqual([[], []]);
    // The control: n2's manager window goes (its server with it: it was the only window), so the name has one claim.
    t2.run("kill-window", "-t", m2.paneId);
    await until("manager out of conflict", async () => (await fleet.client.lanes()).find(l => l.name === "manager")?.conflict === false, 15_000);
    // The hub learns it on its next polls; each refused attempt typed nothing, so trying again is safe.
    await until("the answer accepted", async () => (await hub.answer("ny-1", "ship")).status === 200, 20_000);
    await until("the tap in n1's manager pane", () => m1.submitted().includes(TAP));
    await sleep(1000);
    expect(m1.submitted().filter(t => t === TAP)).toHaveLength(1);
    expect(m2.submitted()).toEqual([]);
  });
});
```

- [ ] **Step 7: Run the integration and duplicate-name tests**

Run: `npx vitest run --project fleet test/fleet/integration.test.ts test/fleet/duplicate-names.test.ts`
Expected: PASS, `Test Files  2 passed (2)` and `Tests  14 passed (14)` (12 + 2). Seen on 2026-10-06 (review round 2, macOS, Node 24.21.0, tmux 3.6a): exactly that, in about 11 s, on a scratch tree holding Tasks 1–15b as the plan text gives them (the agent, fleet and hub lanes' trees merged), with `npm run check` and `npm run lint` clean on it.

A failure prints the process logs (`until` adds the tail of every live log). Read the one that failed before changing anything. A wrong name in the harness is this task's bug; a wrong behaviour of the agent, the fleet or the hub belongs to the task that owns it, and is reported to it.

- [ ] **Step 8: Type check, lint, and confirm nothing was left running**

Run: `npm run check`
Expected: exit 0, with no new errors.

Run: `npm run lint`
Expected: exit 0, no problems reported.

Run: `pgrep -fl 'apps/(node-agent|fleet)/src/main.ts' || echo "no agent or fleet left"`
Expected: `no agent or fleet left`.

Run: `ls "$(dirname "$(mktemp -u)")" /tmp | grep -E '^(morndo-(fleet|node|hub|lane)-|mf-)' || echo "no temp dirs left"`
Expected: `no temp dirs left`.

Run: `for s in /tmp/tmux-$(id -u)/test-*; do [ -S "$s" ] && tmux -L "$(basename "$s")" ls 2>/dev/null; done; echo done`
Expected: only `done`. A socket file may remain, but no server answers on it.

- [ ] **Step 9: Commit**

```bash
git add test/fixtures/fake-claude-pane.ts test/fleet-harness.ts test/fleet/integration.test.ts test/fleet/duplicate-names.test.ts vitest.config.ts tsconfig.tests.json .oxlintrc.json
git commit -m "test(fleet): real agent and real fleet integration, duplicate lane names, with a shared harness"
```

### Task 17: Chaos and failure drills

**Files:**
- Create: `test/fleet/drills-retry.test.ts`
- Create: `test/fleet/drills-stream.test.ts`
- Create: `test/fleet/drills-nodes.test.ts`
- Create: `test/fleet/flapping.test.ts`
- Modify: `.github/workflows/ci.yml` (the `ci` job's test step leaves out the `fleet` project; a new `fleet` job runs it)
- Test: the four files above

**Interfaces:**
- Consumes:
  - Task 16's harness (`test/fleet-harness.ts`), every export listed there.
  - `TestHooks` (Tasks 8–9).
  - `FleetClient.alerts()` and the `alert` and `status` event bodies (Contracts: Client API, Alerts).
  - The subscriber delivery format (Contracts: Hook bus delivery).
  - The hub's answers to a send (Contracts): a first attempt whose node answered "maybe" is a 409 `uncertain` (a 500 until the final review's I1); the repeat resolves through `op.status`, and an `unknown` from another store than the one the send went to, or from that store at a lower store sequence, stays `uncertain` (409, Task 14; the store sequence, 2026-10-07).
  - From the hub in fleet mode (Tasks 14 and 15): `POST /api/workers/<workerId>/send`, `POST /api/escalations/<id>/answer`, the feed's `watch` with worker IDs, `MORNDO_LEDGER`, and `morndo audit`.
  - The app's echo matcher, `matchEchoes` and `OutboxRecord` (`apps/web/src/lib/outbox/state.ts`, with Task 5's `typedAt`): the clock drill runs the app's own rule, not a copy of it.
  - `parseWorkerId` and `expectOf`.
- Produces: no code for later tasks.
  - The `fleet` CI job, which runs `npx vitest run --project fleet` with `FLEET_FLAP_MS=300000`.
  - The env variable `FLEET_FLAP_MS`: the flapping window in ms, default 75 000.

How each drill is made, and why:

| Drill | Real | Placed by a hook or a fake | Negative control |
|---|---|---|---|
| (b) drop after the paste | processes, socket, reconnect, done keys, the hub's send rows | the drop's moment: `dropAfterStarted` (no outside cut can land between `started` and the paste reliably) | the same with `noDoneKeys`: typed twice |
| (b′) drop after the paste, then the agent's database lost | the hub's recorded store, the agent's database deleted and recreated (a new store) | the drop: `dropAfterStarted` | the same with `fixedStreamId` (the database lost but its store id kept): `unknown` passes as the same store, and the repeat types a second time |
| (a) retry after `draft_present` | all | the draft is typed into the pane with tmux | none named by the spec; a retry that stays refused would fail the drill itself |
| (c) escalation answer retried | all, with the manager's needs-you list as a real file | the drop: `dropAfterStarted` | the same with `noDoneKeys`: typed twice |
| database reset | the agent's database deleted between runs | none | `fixedStreamId`: the new stream's first events are lost |
| fleet restart mid-stream | SIGKILL and a restart on the same database; hook events posted while nothing listens, spooled by the agent and replayed after its reconnect | the subscriber is this test's HTTP server, 20 ms a delivery, so the kill lands mid-stream | none named |
| slow node | SIGSTOP on the agent process | none | the spec's control (sequential polling) needs the hub's poller swapped, so it lives in Task 14's unit test against `fake-fleet.ts`. Here the stalled node's own lane is shown not to move, which proves the stall |
| flapping | two agent processes with one key; the fleet's instance check (a ping to the live one, 3 s) and the twin's retries every 5 minutes | none | none named |
| clock | the fleet's offset check, and the app's own echo matcher (`matchEchoes`) | the node's clock 10 s behind: `clockOffsetMs`, and the fixture's `--offset` | the same record matched on the hub's clock (no `typedAt`) misses the echo |
| tmux restart | a killed and recreated tmux server; `%N` reuse is checked, not assumed | none | `noExpect`: the old ID types into the new pane |
| spool unwritable | the relay's answers, health's `drops` | the failing write: `spoolFail` (a real full disk needs root or a tmpfs) | control: the same posts with a writable spool are queued |

- [ ] **Step 1: Write `test/fleet/drills-retry.test.ts`**

```ts
// Retry drills (spec §9 "Retry and duplicates"; §7 "Connection lost during pane.send", "Retry after a refusal before
// the paste"), end to end: the hub in fleet mode → the real fleet → a real agent, all child processes
// (test/fleet-harness.ts), with lanes that record every submit (test/fixtures/fake-claude-pane.ts).
// Real: processes, sockets, the agent's reconnect, its done keys in its own database, the hub's send records.
// Placed by a hook: the drop. The agent's test hook `dropAfterStarted` (MORNDO_NODE_TEST_HOOKS) terminates its fleet
// socket right after it commits an op's `started` row, and lets the paste run on. The agent then reconnects with its
// own backoff. A cut from outside can't reliably land between `started` and the paste.
// Negative controls (spec §9: "(b) and (c) without keys type twice"): the same drills with the agent's done keys off
// (`noDoneKeys`) must type twice. That shows it is the keys, not luck, that keep the drills to once.
// (b′) is (b) with the agent's database lost between the drop and the repeat: the node's new store has no key, so its
// `unknown` must not count (spec §3.1, §7). Its control keeps the store id across the loss (`fixedStreamId`), and the
// repeat types again: it is the store check, not luck, that keeps it in doubt.
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { TestHooks } from "../../apps/node-agent/src/test-hooks.ts";
import { fakeLane, joinAgent, paneOf, sleep, startFleet, startHub, statuses, stopAll, tmuxServer, until } from "../fleet-harness.ts";

afterEach(stopAll);

const TAP = "[tap ny-1] ship (Ship it)";
const once = (xs: string[], x: string) => xs.filter(t => t === x).length;

// One node with two lanes, and the hub in fleet mode with a needs-you list holding one open tap decision.
async function office(hooks: TestHooks = {}) {
  const fleet = await startFleet();
  const tmux = tmuxServer();
  const agent = await joinAgent(fleet, "n1", { tmux });
  const box = await fakeLane(tmux, { window: "box", prose: "box on n1" });
  // The manager's pane has no session file. If it had one, the hub would read the tap back from its conversation and
  // count the ask as answered there (E8), and the retry would never be typed. These drills are about typing.
  const manager = await fakeLane(tmux, { window: "manager", prose: "manager on n1" });
  await agent.run(hooks);
  await agent.waitOnline();
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const hub = await startHub(fleet, { ledger: { needsYou: [{ id: "ny-1", kind: "tap", question: "Ship the drill build?",
    options: [{ key: "ship", label: "Ship it" }, { key: "hold", label: "Hold" }], deadline: tomorrow, ts: new Date().toISOString() }] } });
  const feed = await hub.feed();
  await until("box and manager on the hub", () => feed.names.has("box") && feed.names.has("manager"), 15_000);
  // Subscribed, its replay of n1's current status discarded, before anything is sent: the drop's flips are all seen.
  const flips = await statuses(fleet, "n1");
  const [boxPane, managerPane] = await Promise.all([paneOf(fleet.client, "n1", "box"), paneOf(fleet.client, "n1", "manager")]);
  return { fleet, agent, box, manager, hub, flips, id: boxPane.workerId, managerId: managerPane.workerId };
}
type Office = Awaited<ReturnType<typeof office>>;
// The drop shows in the fleet as offline, then online again once the agent has reconnected. `flips` holds only what
// happened after office() subscribed, so "online" at the end is the reconnect, never the subscription's replay.
const backAfterDrop = (flips: string[]) => until("n1 dropped and back", () => flips.includes("offline") && flips.at(-1) === "online", 20_000);
// Once the hub itself sends to n1 again: a fresh send to the manager pane is typed (a 409 node_offline before that typed
// nothing, so trying again is safe). After it, a repeat in doubt is judged by what the node says, not by its absence.
const hubReaches = (o: Office) =>
  until("the hub sending to n1 again", async () => (await o.hub.send(o.managerId, `probe ${randomUUID()}`)).status === 200, 15_000);

describe("retry drills through the hub, the fleet and an agent", () => {
  it("(b) a drop after the paste, then a repeat: op.status says done, the hub says duplicate, typed once", async () => {
    const rid = randomUUID();
    const o = await office({ dropAfterStarted: rid });
    const text = "drill b: drop after the paste";
    const first = await o.hub.send(o.id, text, rid);
    // The node's answer was "maybe" (the connection dropped after `started`): the hub keeps its started row and answers
    // 409 uncertain (plan Contracts, "The hub's answers to a send"; a 500 until the final review's I1). A repeat still in
    // doubt is 409 uncertain too.
    expect(first).toMatchObject({ status: 409, body: { error: "uncertain" } });
    await until("the paste in box", () => o.box.submitted().includes(text));
    await backAfterDrop(o.flips);
    expect(await o.hub.send(o.id, text, rid)).toMatchObject({ status: 200, body: { error: "duplicate", ok: true } });
    await sleep(1000);
    expect(once(o.box.submitted(), text)).toBe(1);
  });

  it("(b) negative control: without done keys, the repeat types it a second time", async () => {
    const rid = randomUUID();
    const o = await office({ dropAfterStarted: rid, noDoneKeys: true });
    const text = "drill b: no keys";
    const first = await o.hub.send(o.id, text, rid);
    expect(first).toMatchObject({ status: 409, body: { error: "uncertain" } });
    await until("the paste in box", () => o.box.submitted().includes(text));
    await backAfterDrop(o.flips);
    expect(await o.hub.send(o.id, text, rid)).toMatchObject({ status: 200, body: { ok: true } });
    await until("the second paste", () => once(o.box.submitted(), text) === 2);
  });

  it("(b′) a drop after the paste, then the agent's database is lost: the repeat stays in doubt (409 uncertain), typed once", async () => {
    const rid = randomUUID();
    const o = await office({ dropAfterStarted: rid });
    const text = "drill b': the node's store is new";
    expect(await o.hub.send(o.id, text, rid)).toMatchObject({ status: 409, body: { error: "uncertain" } });
    await until("the paste in box", () => o.box.submitted().includes(text));
    await backAfterDrop(o.flips);
    await o.agent.resetDatabase();                          // a new database, so a new store that knows no key
    await hubReaches(o);                                    // so the 409 below is the store's doing, not an offline node
    for (let i = 0; i < 2; i++) {                           // the repeat, and a Check again after it
      expect(await o.hub.send(o.id, text, rid)).toMatchObject({ status: 409, body: { error: "uncertain" } });
    }
    await sleep(1000);
    expect(once(o.box.submitted(), text)).toBe(1);
  });

  it("(b′) negative control: the database lost but its store id kept (fixedStreamId), the repeat types a second time", async () => {
    const rid = randomUUID();
    const store = randomUUID();
    const o = await office({ dropAfterStarted: rid, fixedStreamId: store });
    const text = "drill b': the store id kept";
    expect(await o.hub.send(o.id, text, rid)).toMatchObject({ status: 409, body: { error: "uncertain" } });
    await until("the paste in box", () => o.box.submitted().includes(text));
    await backAfterDrop(o.flips);
    await o.agent.resetDatabase({ fixedStreamId: store });
    await hubReaches(o);
    expect(await o.hub.send(o.id, text, rid)).toMatchObject({ status: 200, body: { ok: true } });
    await until("the second paste", () => once(o.box.submitted(), text) === 2);
  });

  it("(a) draft_present, then a retry with the same request: typed once, the draft never sent", async () => {
    const o = await office();
    const rid = randomUUID();
    const text = "drill a: after the draft";
    o.box.draft("half a thought");
    await until("the draft on screen", () => o.box.screen().includes("half a thought"));
    expect(await o.hub.send(o.id, text, rid)).toMatchObject({ status: 409, body: { error: "draft_present" } });
    o.box.clear();
    await until("the draft cleared", () => !o.box.screen().includes("half a thought"));
    expect(await o.hub.send(o.id, text, rid)).toMatchObject({ status: 200, body: { ok: true } });
    await until("the text in box", () => o.box.submitted().includes(text));
    await sleep(500);
    expect(once(o.box.submitted(), text)).toBe(1);
    expect(o.box.submitted()).not.toContain("half a thought");
  });

  it("(c) an escalation answer retried after a drop: typed once, one Decision recorded", async () => {
    const o = await office({ dropAfterStarted: "answer:ny-1:" });
    expect((await o.hub.answer("ny-1", "ship")).status).toBe(409);           // the node's answer was "maybe": uncertain
    await until("the tap in the manager's pane", () => o.manager.submitted().includes(TAP));
    await backAfterDrop(o.flips);
    expect(await o.hub.answer("ny-1", "ship")).toMatchObject({ status: 200, body: { ok: true } });
    await sleep(1000);
    expect(once(o.manager.submitted(), TAP)).toBe(1);
    expect(o.hub.audit().split("\n").filter(l => l.includes("EscalationAnswered") && l.includes("ny-1"))).toHaveLength(1);
  });

  it("(c) negative control: without done keys, the retried answer types a second time", async () => {
    const o = await office({ dropAfterStarted: "answer:ny-1:", noDoneKeys: true });
    expect((await o.hub.answer("ny-1", "ship")).status).toBe(409);
    await until("the tap in the manager's pane", () => o.manager.submitted().includes(TAP));
    await backAfterDrop(o.flips);
    expect((await o.hub.answer("ny-1", "ship")).status).toBe(200);
    await until("the second tap", () => once(o.manager.submitted(), TAP) === 2);
  });
});
```

- [ ] **Step 2: Run the retry drills**

Run: `npx vitest run --project fleet test/fleet/drills-retry.test.ts`
Expected: PASS, `Tests  7 passed (7)`, in about 60–90 s (seen on 2026-10-06 on the same merged tree: 7 passed in 85 s).

The first answer in (b), (b′) and (c) is a 409 `uncertain`: the node's answer was "maybe" (plan Contracts, "The hub's answers to a send"; this plan had a 500, today's throw, until the final review's I1 changed it during execution). The decisive checks: the repeat says `duplicate` (or, for the answer, 200), and the text was typed once; in (b′), the repeat after the database loss stays 409 `uncertain` and the text was typed once, while its control, identical but for the kept store id, types it a second time.

- [ ] **Step 3: Write `test/fleet/drills-stream.test.ts`**

```ts
// Hook-stream drills (spec §9 "Stream"; §7 "Agent database lost or reinstalled", "Spool cannot be written"; §5.4–§5.6).
// A test subscriber (an HTTP server in this process) sits on the fleet's hook bus.
// Real: the agent's relay, its database, the fleet's outbox and its restart (SIGKILL, then a restart on the same
// database), with hook events posted while the fleet is down, so the agent's spool and its replay after the reconnect
// are exercised end to end.
// Placed by a hook:
// - the spool failure (`spoolFail`): a real full disk needs root or a tmpfs, and what is under test is the relay's
//   answer to a failed write;
// - the negative control's fixed stream id (`fixedStreamId`). The spec's control is "the same reset without streamId
//   drops the new events".
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TestHooks } from "../../apps/node-agent/src/test-hooks.ts";
import { hook, joinAgent, keyParts, startFleet, stopAll, subscriber, tmuxServer, until, type Delivery } from "../fleet-harness.ts";

afterEach(stopAll);

const PATHS = ["/cc", "/sl", "/hook/stop", "/hook/failure", "/notify", "/file"] as const;
async function node(o: { delayMs?: number; hooks?: TestHooks } = {}) {
  const sub = await subscriber(o.delayMs === undefined ? {} : { delayMs: o.delayMs });
  const fleet = await startFleet({ subscribers: [{ name: "test", url: sub.url, paths: [...PATHS] }] });
  const agent = await joinAgent(fleet, "n1", { tmux: tmuxServer() });
  await agent.run(o.hooks);
  await agent.waitOnline();
  return { sub, fleet, agent };
}
const stop = (n: number) => ({ session_id: "s-drill", hook_event_name: "Stop", n });
const n = (d: Delivery) => (d.event.body as { n: number }).n;

describe("the hook stream", () => {
  it("an agent database reset starts a new stream, and every event of the new stream is delivered", async () => {
    const { sub, agent } = await node();
    for (let i = 1; i <= 5; i++) expect((await hook(agent, "/hook/stop", stop(i))).status).toBe(200);
    await until("the first stream's 5 events", () => sub.unique().size === 5, 15_000);
    const first = keyParts([...sub.unique().keys()][0] ?? "").streamId;
    await agent.resetDatabase();
    for (let i = 101; i <= 107; i++) expect((await hook(agent, "/hook/stop", stop(i))).status).toBe(200);
    await until("the new stream's 7 events", () => sub.unique().size === 12, 15_000);
    const fresh = [...sub.unique().values()].filter(d => keyParts(d.key).streamId !== first);
    expect(new Set(fresh.map(d => keyParts(d.key).streamId)).size).toBe(1);
    expect(fresh.map(d => keyParts(d.key).seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(fresh.map(n)).toEqual([101, 102, 103, 104, 105, 106, 107]);
  });

  it("negative control: the same reset under one fixed stream id loses the new stream's first events", async () => {
    const hooks: TestHooks = { fixedStreamId: "00000000-0000-4000-8000-000000000001" };
    const { sub, agent } = await node({ hooks });
    for (let i = 1; i <= 5; i++) await hook(agent, "/hook/stop", stop(i));
    await until("the first 5 events", () => sub.unique().size === 5, 15_000);
    await agent.resetDatabase(hooks);
    for (let i = 101; i <= 107; i++) await hook(agent, "/hook/stop", stop(i));
    // 106 and 107 (seq 6 and 7) are past the old stream's last seq, so they arrive. Once they have arrived, in-order
    // delivery means 101–105 never will.
    await until("106 and 107", () => [...sub.unique().values()].some(d => n(d) === 107), 15_000);
    expect([...sub.unique().values()].map(n).filter(x => x > 100)).toEqual([106, 107]);
  });

  it("a fleet restart mid-stream, with events posted while it is down: every event reaches the subscriber at least once, in order, and its key deduplicates it", async () => {
    const N = 200;
    const DOWN = 50;                                                     // posted while no fleet listens
    const { sub, fleet, agent } = await node({ delayMs: 20 });         // 20 ms a delivery: 200 take at least 4 s
    for (let i = 1; i <= N; i++) expect((await hook(agent, "/hook/stop", stop(i))).status).toBe(200);
    await until("delivery under way", () => sub.received.length >= 10, 15_000);
    expect(sub.unique().size).toBeLessThan(N);                           // the kill lands mid-stream, not after it
    await fleet.restart("SIGKILL", async () => {
      // The relay answers once the event is durable on the node (spec §5.5), whatever the fleet does: these wait in the
      // agent's spool and reach the fleet only by the replay after its reconnect (spec §5.4).
      for (let i = N + 1; i <= N + DOWN; i++) expect((await hook(agent, "/hook/stop", stop(i))).status).toBe(200);
    });
    await agent.waitOnline(30_000);
    await until(`all ${N + DOWN} keys`, () => sub.unique().size === N + DOWN, 60_000);
    expect([...sub.unique().values()].map(n)).toEqual(Array.from({ length: N + DOWN }, (_, i) => i + 1));   // first arrivals in order
    for (const d of sub.received) expect(d.event).toEqual(sub.unique().get(d.key)?.event);       // a repeat is the same event
    expect(new Set([...sub.unique().keys()].map(k => keyParts(k).streamId)).size).toBe(1);        // one stream, before and after
    console.log(`fleet restart drill: ${sub.received.length - N - DOWN} repeated deliveries, each deduplicated by its key`);
  });

  it("the spool can't be written: /cc and /sl still answer 204, the script paths 503, and the drops are counted", async () => {
    const { agent, fleet } = await node({ hooks: { spoolFail: true } });
    const file = join(agent.home, "note.txt");
    writeFileSync(file, "a file a hook sent\n");
    const got: Record<string, number> = {};
    for (const path of PATHS) got[path] = (await hook(agent, path, { session_id: "s-drill", hook_event_name: "Notification", path: file })).status;
    expect(got).toEqual({ "/cc": 204, "/sl": 204, "/hook/stop": 503, "/hook/failure": 503, "/notify": 503, "/file": 503 });
    // Health goes every 30 s (LIMITS.healthMs), so the counter shows within one interval.
    await until("the drops in n1's health", async () => ((await fleet.client.nodes()).find(x => x.name === "n1")?.health?.drops ?? 0) >= 2, 40_000);
  });

  it("control: the same posts with a writable spool are queued", async () => {
    const { agent } = await node();
    const file = join(agent.home, "note.txt");
    writeFileSync(file, "a file a hook sent\n");
    const got: Record<string, number> = {};
    for (const path of PATHS) got[path] = (await hook(agent, path, { session_id: "s-drill", hook_event_name: "Notification", path: file })).status;
    expect(got).toEqual({ "/cc": 204, "/sl": 204, "/hook/stop": 200, "/hook/failure": 202, "/notify": 202, "/file": 202 });
    expect(JSON.parse((await hook(agent, "/hook/stop", stop(1))).text)).toEqual({ ok: true, queued: true });
  });
});
```

- [ ] **Step 4: Run the stream drills**

Run: `npx vitest run --project fleet test/fleet/drills-stream.test.ts`
Expected: PASS, `Tests  5 passed (5)`. The restart drill prints `fleet restart drill: <k> repeated deliveries…`. Any k ≥ 0 is fine, since delivery is at least once; what it checks is that the 50 events posted while the fleet was down arrive, after the first 200, in order, on the same stream. The spool drill waits up to one health interval, so the whole file takes about 60–90 s. Seen on 2026-10-06 on the merged round-2 tree: 5 passed in 42 s, `fleet restart drill: 1 repeated deliveries, each deduplicated by its key`.

The fixed-stream-id control relies on `fixedStreamId` staying fixed: Task 9 starts a new stream for a restored database (the welcome's `ackSeq` past the local maximum), but not when the hook fixes the stream id. If that control starts passing, check that first.

- [ ] **Step 5: Write `test/fleet/drills-nodes.test.ts`**

```ts
// Node drills (spec §9 "Isolation", "Clock", "Pane reuse"; §7 "Node down or partitioned", "tmux server restarted",
// "Clock offset > 2 s"): a real fleet and real agents, plus the hub in fleet mode where the drill is about the hub.
// Real: SIGSTOP on an agent process; a tmux server killed and recreated (the drill checks that %N was reused, rather
// than assuming it); the hub's polling.
// Placed by a hook:
// - the agent's wall clock 10 s behind (`clockOffsetMs`, and the fixture's --offset for the transcript it writes);
// - the negative control's missing expectation check (`noExpect`).
// The Isolation row's own negative control (sequential polling misses the bound) needs the hub's poller swapped, so it
// lives with the poller in Task 14 (apps/hub/test, against fake-fleet.ts). Here the stalled node's own lane is shown not
// to move, which proves the stall is real.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { matchEchoes, type OutboxRecord } from "../../apps/web/src/lib/outbox/state.ts";
import type { TestHooks } from "../../apps/node-agent/src/test-hooks.ts";
import { parseWorkerId } from "../../packages/protocol/src/worker-id.ts";
import { expectOf, fakeLane, joinAgent, paneOf, sleep, startFleet, startHub, stopAll, tmuxServer, until } from "../fleet-harness.ts";

afterEach(stopAll);
const POLL = 500;

describe("a slow node", () => {
  it("a stalled agent (SIGSTOP) doesn't hold up the other node's lanes on the hub", async () => {
    const fleet = await startFleet();
    const [t1, t2] = [tmuxServer(), tmuxServer()];
    const n1 = await joinAgent(fleet, "n1", { tmux: t1 });
    const n2 = await joinAgent(fleet, "n2", { tmux: t2 });
    const a1 = await fakeLane(t1, { window: "a1", prose: "a1 on n1" });
    const b1 = await fakeLane(t2, { window: "b1", prose: "b1 on n2" });
    await Promise.all([n1.run(), n2.run()]);
    await Promise.all([n1.waitOnline(), n2.waitOnline()]);
    const hub = await startHub(fleet, { pollMs: POLL });
    const [w1, w2] = await Promise.all([paneOf(fleet.client, "n1", "a1"), paneOf(fleet.client, "n2", "b1")]);
    const [f1, f2] = await Promise.all([hub.feed(), hub.feed()]);
    await until("a1 and b1 on the hub", () => f1.seen.has(w1.workerId) && f1.seen.has(w2.workerId), 15_000);
    f1.watch(w1.workerId);
    f2.watch(w2.workerId);
    await until("b1's screen while n2 runs", () => f2.screens.some(s => s.text.includes("b1 on n2")), 10_000);   // the watch works
    n2.proc()?.pause();
    const latencies: number[] = [];
    // 8 ticks over about 16 s. For the first ~15 s, n2 still counts as online to the fleet (a ping every 15 s), so ops sent
    // to it hang until they time out: the hardest case for the hub.
    for (let k = 1; k <= 8; k++) {
      const t0 = performance.now();
      a1.draft(` tick-${k}`);
      b1.draft(` b-tick-${k}`);
      await until(`a1's tick-${k} on the hub`, () => f1.screens.some(s => s.text.includes(` tick-${k}`)), 10_000);
      latencies.push(performance.now() - t0);
      await sleep(2000);
    }
    expect(Math.max(...latencies)).toBeLessThan(POLL + 1500);                 // within a poll interval, plus margin
    expect(f2.screens.some(s => s.text.includes("b-tick-"))).toBe(false);     // the stall was real: b1 never moved
    n2.proc()?.resume();
    await until("b1 moves again once n2 runs", () => f2.screens.some(s => s.text.includes("b-tick-8")), 40_000);
  });
});

describe("clocks", () => {
  it("an agent 10 s behind: the fleet raises a clock alert, and echo matching on the node's time still matches", async () => {
    // Behind, not ahead. With the node behind, matching on the hub's clock misses the echo. Ahead, it would match anyway,
    // and the drill would prove nothing.
    const OFFSET = -10_000;
    const fleet = await startFleet();
    const tmux = tmuxServer();
    const agent = await joinAgent(fleet, "n1", { tmux });
    const box = await fakeLane(tmux, { window: "box", claudeHome: agent.home, offsetMs: OFFSET });
    await agent.run({ clockOffsetMs: OFFSET });
    await agent.waitOnline();
    const alert = await until("a clock alert for n1", async () => (await fleet.client.alerts()).find(a => a.kind === "clock_offset" && a.node === "n1") ?? null, 40_000);
    expect(Number(alert.detail.offsetMs)).toBeGreaterThan(-12_000);
    expect(Number(alert.detail.offsetMs)).toBeLessThan(-8_000);
    const hub = await startHub(fleet);
    const id = (await paneOf(fleet.client, "n1", "box")).workerId;
    const feed = await hub.feed();
    await until("box on the hub", () => feed.seen.has(id), 15_000);
    const hubNow = Date.now();
    const sent = await hub.send(id, "clock drill echo", randomUUID());
    expect(sent).toMatchObject({ status: 200, body: { ok: true } });
    const at = Number(sent.body.at);
    expect(at).toBeGreaterThan(hubNow + OFFSET - 2000);                       // the node's time of typing, not the hub's
    expect(at).toBeLessThan(hubNow + OFFSET + 2000);
    type Line = { uuid?: string; message?: { content?: unknown }; timestamp?: string };
    const line = await until("the echo in the transcript", () => readFileSync(box.transcript ?? "", "utf8").split("\n").filter(Boolean)
      .map(l => JSON.parse(l) as Line).find(l => l.message?.content === "clock drill echo") ?? null);
    const echo = { id: line.uuid ?? "echo", at: Date.parse(line.timestamp ?? ""), text: "clock drill echo" };
    // The app's own matcher (apps/web/src/lib/outbox/state.ts), on the record the app keeps once the hub answers 200:
    // `typedAt` is the hub's `at`, the node's time of typing (Task 5).
    const record: OutboxRecord = {
      id: "r1", worker: id, workerName: "box", text: "clock drill echo", uploads: [], createdAt: hubNow, budgetFrom: hubNow,
      state: "sent", error: null, attempts: 1, seen: "none", sentAt: hubNow, typedAt: at,
    };
    expect(matchEchoes([record], [echo]).get("r1")).toBe(echo.id);           // matched on the node's clock
    // Control: the same record without the node's time falls back to when it was written, on this machine's (the hub's)
    // clock, and misses the echo, which the node wrote 10 s "earlier".
    expect(matchEchoes([{ ...record, typedAt: null }], [echo]).size).toBe(0);
  });
});

describe("a tmux server restart", () => {
  async function restartDrill(hooks: TestHooks) {
    const fleet = await startFleet();
    const tmux = tmuxServer();
    const agent = await joinAgent(fleet, "n1", { tmux });
    await fakeLane(tmux, { window: "alpha", prose: "the old alpha" });
    await agent.run(hooks);
    await agent.waitOnline();
    const old = await paneOf(fleet.client, "n1", "alpha");
    tmux.kill();                                                              // the server dies, as on a crash or a reboot
    const fresh = await fakeLane(tmux, { window: "alpha", prose: "the new alpha" });
    const now = await until("alpha's new worker id", async () => {
      const p = await paneOf(fleet.client, "n1", "alpha").catch(() => null);
      return p && p.workerId !== old.workerId ? p : null;
    }, 15_000);
    const [was, is] = [parseWorkerId(old.workerId), parseWorkerId(now.workerId)];
    expect(is?.server).not.toBe(was?.server);                                 // a new stamp
    expect(is?.pane).toBe(was?.pane);                                         // tmux handed out the same %N again: the drill is real
    const r = await fleet.client.op({ node: "n1" }, "pane.send",
      { workerId: old.workerId, text: "meant for the old alpha", expect: expectOf(old) }, { key: `hub:tr-${randomUUID()}` });
    return { fleet, fresh, old, r };
  }

  it("old worker ids answer no_pane, and the new pane receives nothing", async () => {
    const { fleet, fresh, old, r } = await restartDrill({});
    expect(r).toMatchObject({ ok: false, error: { code: "no_pane", executed: "no" } });
    const cap = await fleet.client.op({ node: "n1" }, "pane.captureMany", { workerIds: [old.workerId] });
    expect(cap).toMatchObject({ ok: true, result: { captures: [{ workerId: old.workerId, text: null }] } });
    await sleep(1500);
    expect(fresh.submitted()).toEqual([]);
  });

  it("negative control: without the expectation check, the old worker id types into the new pane", async () => {
    const { fresh, r } = await restartDrill({ noExpect: true });
    expect(r.ok).toBe(true);
    await until("the text in the new alpha", () => fresh.submitted().includes("meant for the old alpha"));
  });
});
```

- [ ] **Step 6: Run the node drills**

Run: `npx vitest run --project fleet test/fleet/drills-nodes.test.ts`
Expected: PASS, `Tests  4 passed (4)`, in about 60–90 s. The clock drill waits up to one health interval for its alert. Seen on 2026-10-06 on the merged round-2 tree: 4 passed in 30 s.

If the slow-node bound fails with latencies near the hub's op timeout, the hub's poll waits for the stalled node before it applies the other node's captures, which is spec §3.1's "a slow node never delays the others". Report it to Task 14; don't widen the bound.

- [ ] **Step 7: Write `test/fleet/flapping.test.ts`**

```ts
// Flapping (spec §9 "Flapping", §5.2 "Instances", §7 "Two agent instances with one key"). A second agent process with
// the same key stands next to the first, as on a cloned machine: config and key copied, its own relay port. It runs for
// FLEET_FLAP_MS: 75 s by default, which covers the agent's whole backoff ladder up to its 60 s cap. CI's fleet job sets
// the spec's 5 minutes.
// Exactly one instance stays connected: the node never leaves "online". The twin's hello makes the fleet ping the live
// instance (the instance check, 3 s, Task 11); it answers, so the twin is refused with 4409. The twin keeps
// `status: conflict` and tries again every 5 minutes (Task 7), so the CI soak (5 minutes) may see one retry; the fleet
// raises one instance_conflict alert per refused instance for as long as the live connection lasts, so retries add none.
// Ops on the connected instance never fail.
// Real processes throughout; no hook.
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_MAIN, cleanEnv, fakeLane, joinAgent, paneOf, sleep, startFleet, statuses, stopAll, tmuxServer } from "../fleet-harness.ts";

afterEach(stopAll);
const FLAP_MS = Number(process.env.FLEET_FLAP_MS ?? 75_000);

describe("two instances with one key", () => {
  it(`for ${FLAP_MS / 1000} s: one connected, one alert, no failed op`, async () => {
    const fleet = await startFleet();
    const tmux = tmuxServer();
    const first = await joinAgent(fleet, "n1", { tmux });
    await fakeLane(tmux, { window: "box" });
    await first.run();
    await first.waitOnline();
    const id = (await paneOf(fleet.client, "n1", "box")).workerId;
    const flips = await statuses(fleet, "n1");                              // the replay of "online" is not a flip
    const twin = await first.clone();
    await twin.run();
    const failures: string[] = [];
    let ops = 0;
    const end = performance.now() + FLAP_MS;
    while (performance.now() < end) {
      const r = await fleet.client.op({ node: "n1" }, "pane.captureMany", { workerIds: [id] });
      ops++;
      if (!r.ok) failures.push(r.error.code);
      await sleep(2000);
    }
    const conflicts = (await fleet.client.alerts()).filter(a => a.kind === "instance_conflict" && a.node === "n1");
    expect(conflicts).toHaveLength(1);
    // The status CLI only reads the twin's status file: nothing in this process needs to answer it.
    const twinStatus = spawnSync(process.execPath, ["--no-warnings", AGENT_MAIN, "status"], { env: cleanEnv(twin.home), encoding: "utf8" }).stdout;
    expect(twinStatus).toMatch(/conflict: another agent with this node's key is connected \(4409\)/);
    expect(flips.filter(s => s !== "online")).toEqual([]);                    // never stale or offline: only "online" may follow
    expect(failures).toEqual([]);
    expect(ops).toBeGreaterThanOrEqual(Math.floor(FLAP_MS / 2500));
    expect((await fleet.client.nodes()).find(n => n.name === "n1")?.status).toBe("online");
  }, FLAP_MS + 60_000);
});
```

- [ ] **Step 8: Run the flapping drill, short and then at its default**

Run: `FLEET_FLAP_MS=15000 npx vitest run --project fleet test/fleet/flapping.test.ts`
Expected: PASS, `Tests  1 passed (1)`, in about 20 s. This is the quick check that it is wired. (Seen on 2026-10-06: 18 s.)

Run: `npx vitest run --project fleet test/fleet/flapping.test.ts`
Expected: PASS in about 80 s. (Seen on 2026-10-06: 78 s.)

Why `statuses()` is awaited (review round 2): the events socket first replays the node's current status, and the old `statuses()` recorded that "online" as a flip, so `expect(flips).toEqual([])` depended on whether the subscription connected before or after the replay. The replay is now awaited and discarded, and what follows may only be "online" (a re-admission of the live instance), never "stale" or "offline".

- [ ] **Step 9: Split CI: the `ci` job without the fleet project, and a `fleet` job for it**

In `.github/workflows/ci.yml`, replace the step

```yaml
      - name: Tests (units, then the Chromium files)
        if: ${{ !cancelled() && steps.tools.outcome == 'success' }}
        run: npm test
```

with

```yaml
      # The fleet's drills run in their own job below, beside this one (`--project=!fleet` leaves them out;
      # https://vitest.dev/guide/cli.html, --project, v5.0.3, read 2026-10-06).
      - name: Tests (units, then the Chromium files)
        if: ${{ !cancelled() && steps.tools.outcome == 'success' }}
        run: npx vitest run --project='!fleet'
```

and add a second job after the `ci` job (same indentation as `ci:`):

```yaml
  # The fleet's cross-app drills (test/fleet; spec §9): real fleet, agent and hub processes on isolated tmux servers. They
  # get a job of their own: jobs run in parallel by default
  # (https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax, read 2026-10-06), so their
  # waiting (reconnects, health every 30 s, the flapping soak) adds no wall time to `ci`. The soak runs the spec's full
  # 5 minutes here (FLEET_FLAP_MS), and 75 s on a developer's machine.
  fleet:
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version-file: package.json # engines.node
          cache: npm

      - run: npm ci

      - name: tmux
        run: |
          sudo apt-get update
          sudo apt-get install -y --no-install-recommends tmux

      - name: Fleet drills (test/fleet)
        env:
          FLEET_FLAP_MS: "300000"
        run: npx vitest run --project fleet
```

Expected duration of the `fleet` job: about 1.5 min of setup, plus about 6 min of tests. The 5-minute soak runs in one worker while the other four files (about 4 min in a row) run in the second, so the `ci` job's wall time doesn't change.

- [ ] **Step 10: Run every fleet file together, as the job will**

Run: `npx vitest run --project fleet`
Expected: PASS, `Test Files  6 passed (6)` and `Tests  31 passed (31)` (integration 12, duplicate names 2, retry 7, stream 5, nodes 4, flapping 1). Seen on 2026-10-06 on the merged round-2 tree (macOS, 2 workers), as the job runs it with `FLEET_FLAP_MS=300000`: exactly that, in 303 s, the 300 s soak alongside the other five files.

Run: `npx vitest run --project='!fleet'`
Expected: the same totals as `npm test` before this task: units and Chromium, none of `test/fleet`.

Run: `npm run check`
Expected: exit 0.

Run: `npm run lint`
Expected: exit 0, no problems reported.

Run: `pgrep -fl 'apps/(node-agent|fleet|hub)/src/main.ts' || echo "nothing left running"`
Expected: `nothing left running`.

- [ ] **Step 11: Commit**

```bash
git add test/fleet/drills-retry.test.ts test/fleet/drills-stream.test.ts test/fleet/drills-nodes.test.ts test/fleet/flapping.test.ts .github/workflows/ci.yml
git commit -m "test(fleet): chaos and failure drills, each with its negative control"
```

---

### Task 18: The two-node CI e2e

**Files:**
- Create: `e2e/fleet-two-node.e2e.ts`
- Modify: `e2e/harness.ts` (`pairedPage` takes anything with a `pairUrl()`)
- Modify: `package.json` (the `e2e` script)
- Modify: `.github/workflows/ci.yml` (a step `e2e fleet-two-node`, and a step `Negative controls apply`)
- Create (Steps 8–13, spec §12.1): `scripts/negative-controls.ts` (the plan's negative controls as data, and their runner), `.github/workflows/negative-controls.yml` (weekly and on demand)
- Modify: `tsconfig.tests.json` (include `scripts`)
- Test: `e2e/fleet-two-node.e2e.ts`; the runner's own checks (Step 11)

**Interfaces:**
- Consumes:
  - Task 16's harness: `startFleet`, `tmuxServer`, `joinAgent`, `fakeLane`, `startHub` (with `web: "build"`), `until`, `sleep` and `stopAll`; `Hub.feed()` and `Hub.pairUrl()`; and `Fleet.revoke`, `Fleet.client.lanes()` and `Fleet.client.nodes()`.
  - From `e2e/harness.ts`: `checks`, `assert`, `outDir` and `pairedPage`.
  - The web app's desktop selectors: `aside.side`, `h1`, `#composer`, `.chan .tabs` and the region `Terminal of #<lane>` (as in `e2e/desktop.e2e.ts`).
- Produces:
  - `pairedPage(browser: Browser, office: Pick<Office, "pairUrl">, o?)`. It was `office: Office`; no caller changes.
  - The CI step `e2e fleet-two-node`.
  - `scripts/negative-controls.ts`: `type Control` and `CONTROLS` (plan.md, "Negative controls, as data"), and the runner (`--check`, `--only`, `--list`); the CI step `Negative controls apply` and the workflow `Negative controls`.

Both modes: the hub suites that touch a port run in legacy and fleet mode by default (`MORNDO_HUB_MODES` unset is `legacy,fleet`; Task 14's `hub-mode.ts` and the suites it lists), so CI's test step already runs each of them twice; nothing here changes that, and the `ci` job must not set `MORNDO_HUB_MODES`.

- [ ] **Step 1: Let `pairedPage` pair with any hub**

In `e2e/harness.ts`, change the signature line

```ts
export async function pairedPage(browser: Browser, office: Office, o: {
```

to

```ts
export async function pairedPage(browser: Browser, office: Pick<Office, "pairUrl">, o: {
```

(it uses only `office.pairUrl()`; the fleet harness's `Hub` has one).

- [ ] **Step 2: Write `e2e/fleet-two-node.e2e.ts`**

```ts
// The fleet's two-node e2e (spec §9 "Two nodes (CI)", §12.1; ADR-0012). It runs:
// - one real fleet service;
// - two real agents (n1, n2) on two isolated tmux servers;
// - the real hub in fleet mode (MORNDO_FLEET_SOCKET), serving the built web app, in headless Chromium paired through a
//   virtual passkey.
// The hub lists both nodes' lanes and steers each. A third node (n3) joined and was revoked before it ever ran. Its lane
// never appears: not in the app, the hub's feed or the fleet's lane registry.
// Child processes with temporary HOMEs and random ports (test/fleet-harness.ts). The lanes are
// test/fixtures/fake-claude-pane.ts, which records every submit.
// Run: npm run build (once), then: node e2e/fleet-two-node.e2e.ts
// Screenshots go to $E2E_OUT (default: a temp dir). Exit code 0 only if every check passed. About 30 s.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { assert, checks, outDir, pairedPage } from "./harness.ts";
import { fakeLane, joinAgent, sleep, startFleet, startHub, stopAll, tmuxServer, until } from "../test/fleet-harness.ts";

const OUT = outDir("fleet-two-node");
assert(existsSync(join(import.meta.dirname, "../apps/web/build/200.html")), "build the web app first: npm run build");
const { check, watch, finish } = checks(OUT);
const POLL = 400;
let code = 1;
const browser = await chromium.launch();
try {
  const fleet = await startFleet();
  const [t1, t2, t3] = [tmuxServer(), tmuxServer(), tmuxServer()];
  const n1 = await joinAgent(fleet, "n1", { tmux: t1 });
  const n2 = await joinAgent(fleet, "n2", { tmux: t2 });
  const n3 = await joinAgent(fleet, "n3", { tmux: t3 });
  const alpha = await fakeLane(t1, { window: "alpha", prose: "alpha on n1", claudeHome: n1.home });
  const beta = await fakeLane(t2, { window: "beta", prose: "beta on n2", claudeHome: n2.home });
  await fakeLane(t3, { window: "gamma", prose: "gamma on n3", claudeHome: n3.home });
  fleet.revoke("n3");                                                  // joined, then revoked before it ever ran
  const hub = await startHub(fleet, { web: "build", pollMs: POLL });
  const feed = await hub.feed();                                        // watching before any agent runs
  await Promise.all([n1.run(), n2.run(), n3.run()]);
  await Promise.all([n1.waitOnline(), n2.waitOnline()]);
  const { page } = await pairedPage(browser, hub);
  watch(page);
  const side = page.locator("aside.side");

  await check("the hub lists both nodes' lanes, each worker on its own node", async () => {
    await until("alpha and beta in the hub's feed", () => feed.names.has("alpha") && feed.names.has("beta"), 15_000);
    const workers = feed.workers();
    assert(workers.some(w => w.name === "alpha" && w.id.startsWith("n1.")), `alpha isn't n1's: ${JSON.stringify(workers)}`);
    assert(workers.some(w => w.name === "beta" && w.id.startsWith("n2.")), `beta isn't n2's: ${JSON.stringify(workers)}`);
    await side.getByRole("button", { name: /alpha/ }).first().waitFor({ timeout: 10_000 });
    await side.getByRole("button", { name: /beta/ }).first().waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(OUT, "1-both-nodes.png") });
  });

  await check("a revoked node never appears: not in the app, the hub's feed or the fleet's lanes", async () => {
    await sleep(5 * POLL + 2000);                                       // several polls after n3's refused attempts
    assert(![...feed.seen].some(id => id.startsWith("n3.")) && !feed.names.has("gamma"), `the hub listed n3: ${JSON.stringify([...feed.seen])}`);
    const lanes = await fleet.client.lanes();
    assert(!lanes.some(l => l.node === "n3" || l.name === "gamma"), `the fleet registered n3's lane: ${JSON.stringify(lanes)}`);
    assert((await fleet.client.nodes()).find(n => n.name === "n3")?.status !== "online", "n3 is online");
    assert(await side.getByRole("button", { name: /gamma/ }).count() === 0, "the app lists gamma");
  });

  for (const [lane, box, other, node] of [["alpha", alpha, beta, "n1"], ["beta", beta, alpha, "n2"]] as const) {
    await check(`steering ${lane} types into ${node}'s pane once, and nowhere else`, async () => {
      const text = `hello ${lane} on ${node}, from the hub`;
      await side.getByRole("button", { name: new RegExp(lane) }).first().click();
      await page.locator("h1", { hasText: lane }).waitFor();
      await page.locator("#composer").fill(text);
      await page.keyboard.press("Enter");
      await until(`the text in ${lane}`, () => box.submitted().includes(text), 10_000);
      await sleep(800);
      const times = box.submitted().filter(t => t === text).length;
      assert(times === 1, `typed ${times} times`);
      assert(!other.submitted().includes(text), "it reached the other node's pane");
      await page.screenshot({ path: join(OUT, `2-steer-${lane}.png`) });
    });
  }

  await check("the Terminal tab shows n2's pane, drawn on n2 and carried by the fleet", async () => {
    await side.getByRole("button", { name: /beta/ }).first().click();
    await page.locator("h1", { hasText: "beta" }).waitFor();
    await page.locator(".chan .tabs").getByRole("tab", { name: "Terminal" }).click();
    await page.getByRole("region", { name: "Terminal of #beta" }).locator(".xterm-rows", { hasText: "beta on n2" }).waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(OUT, "3-terminal-n2.png") });
  });
  code = finish();
} finally {
  await browser.close();
  await stopAll();
}
process.exit(code);
```

- [ ] **Step 3: Run it**

Run: `npm run build`
Expected: exit 0.

Run: `node e2e/fleet-two-node.e2e.ts`
Expected: five `PASS` lines, then `5/5 checks passed. Screenshots: <dir>`, and exit code 0, in about 30 s. Open `1-both-nodes.png` and `3-terminal-n2.png` and look at them: alpha and beta are both listed, and the terminal shows "beta on n2".

Seen on 2026-10-06 (review round 2) on a scratch tree holding Tasks 1–15b as the plan text gives them: five `PASS` lines and `5/5 checks passed` in 10 s; the screenshots show alpha and beta both listed, and the Terminal tab drawing `beta on n2`.

- [ ] **Step 4: Show the revoked-node check fails without its guard**

Comment out the line `fleet.revoke("n3");` and run `node e2e/fleet-two-node.e2e.ts` again.
Expected: `FAIL  a revoked node never appears…` (n3's gamma appears) and exit code 1. (Seen on 2026-10-06: `4/5 checks passed`, exit 1.)

Restore the line and run it once more: `5/5 checks passed`.

- [ ] **Step 5: Add it to `npm run e2e` and to CI**

In `package.json`, in the `e2e` script, insert `&& node e2e/fleet-two-node.e2e.ts` after `node e2e/readability.e2e.ts` (before `&& node e2e/gallery.e2e.ts`).

In `.github/workflows/ci.yml`, after the step `e2e readability`, add:

```yaml
      # ADR-0012: one fleet service, two agents on two isolated tmux servers, the hub in fleet mode; a revoked node never
      # appears (spec §9 "Two nodes (CI)"). About 30–60 s.
      - name: e2e fleet-two-node
        if: ${{ !cancelled() && steps.build.outcome == 'success' && steps.tools.outcome == 'success' }}
        env: { E2E_OUT: "${{ runner.temp }}/e2e/fleet-two-node" }
        run: node e2e/fleet-two-node.e2e.ts
```

CI time: this step adds about 30–60 s to the `ci` job. tmux and Chromium are already installed there (step `tools`). The fleet drills are in the parallel `fleet` job (Task 17), so the workflow's wall time grows by about a minute at most.

- [ ] **Step 6: Run the whole e2e set as CI will**

Run: `npm run e2e`
Expected: every script ends with `N/N checks passed`, including `5/5` for fleet-two-node, and the command exits 0.

Run: `pgrep -fl 'apps/(node-agent|fleet|hub)/src/main.ts' || echo "nothing left running"`
Expected: `nothing left running`.

- [ ] **Step 7: Commit**

```bash
git add e2e/fleet-two-node.e2e.ts e2e/harness.ts package.json .github/workflows/ci.yml
git commit -m "test(e2e): two nodes, one fleet, the hub in fleet mode"
```

- [ ] **Step 8: Write `scripts/negative-controls.ts`**

Spec §12.1 asks that each negative control *demonstrably* fails when its guard is removed. The steps of Tasks 1–17 each showed it once, by hand; this makes it repeatable. Every control a step describes as "change X to Y, run Z, it fails" is an entry: the file, the exact text, its replacement, the test files and a piece of the failure. A control written as a test of its own (a case named "… (negative control)", the drills' hook-based controls) runs with every suite and needs no entry.

The entries below are every control the plan's steps describe as one change in one file, for Tasks 1–15b as round 2 left them (each one run, Step 11). When a lane changes a control's code, its entry changes in the same commit; `--check` (Step 10, and the `ci` job) fails on an entry whose text is gone. What can't be one entry is in the table after Step 13.

```ts
// The plan's negative controls, run again (docs/design/fleet-core/README.md §12.1: "each negative control demonstrably
// fails when its guard is removed"; plan.md, "Negative controls, as data"). Each entry removes or breaks one guard in one
// file and names the test files that must then fail. A control written as a test of its own (a case named "… (negative
// control)") runs with every suite and needs no entry here.
//   node scripts/negative-controls.ts                  run every control (minutes: one worktree, one npm ci, each test twice)
//   node scripts/negative-controls.ts --only <id>      run one; repeat --only for more
//   node scripts/negative-controls.ts --check          read-only, in this checkout: every entry's text is there exactly once
//   node scripts/negative-controls.ts --list           the entries
// It never changes the checkout it was started from. It makes one temporary worktree of HEAD (git worktree add --detach;
// uncommitted changes are not in it), runs `npm ci --offline` there once, and for each control:
//   1. runs the named test files unchanged: they must pass, or the control would prove nothing (cached per file set);
//   2. applies the change: `find` must occur exactly once in `file`;
//   3. runs them again: they must fail, and print `expect` when the entry gives one;
//   4. restores the file with `git checkout -- <file>` inside the temporary worktree, and checks it is as it was.
// At the end it removes that worktree (`git worktree remove --force <its path>`) and nothing else: it never prunes.
// Exit: 0 every control bit; 1 a control passed, its tests failed unchanged, or an entry no longer applies; 2 setup failed.
// util.parseArgs: https://nodejs.org/docs/latest-v24.x/api/util.html#utilparseargsconfig. import.meta.main ("true when
// the current module is the entry point", added in v24.2.0, stability 1.0; engines.node is >=24.12):
// https://nodejs.org/docs/latest-v24.x/api/esm.html#importmetamain, read 2026-10-06.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

export type Control = {
  id: string;          // "t8-no-done-keys": t<task>-<what is removed>
  task: string;        // "8", "15b"
  file: string;        // the file the control changes, from the repository root
  find: string;        // exact text, found exactly once in that file
  replace: string;     // what the control puts in its place ("" removes it)
  run: string[];       // vitest files, from the repository root, that must fail with it
  expect?: string;     // a piece of the failure the step names
};

export const CONTROLS: Control[] = [
  // ---- Task 1: the protocol (01-foundation.md, Steps 7 and 10)
  { id: "t1-worker-id-leading-zeros", task: "1", file: "packages/protocol/src/worker-id.ts",
    find: String.raw`\.(0|[1-9]\d{0,8})$/`, replace: String.raw`\.(\d{1,9})$/`,
    run: ["packages/protocol/test/worker-id.test.ts"], expect: "pc.3fa2c1d0.012" },
  { id: "t1-lane-start-flags", task: "1", file: "packages/protocol/src/fleet.ts",
    find: "account: z.exactOptional(account()), resume: z.exactOptional(z.uuid())",
    replace: "account: z.exactOptional(token()), resume: z.exactOptional(sessionId())",
    run: ["packages/protocol/test/fleet.test.ts"], expect: "--dangerously-skip-permissions" },
  { id: "t1-ws-loopback-only", task: "1", file: "packages/protocol/src/fleet.ts",
    find: "|| LOOPBACK_WS.test(url)", replace: String.raw`|| /^ws:\/\/[!-~]+$/.test(url)`,
    run: ["packages/protocol/test/fleet.test.ts"], expect: "ws://100.64.0.1:8791/agent" },
  { id: "t1-branch-names", task: "1", file: "packages/protocol/src/fleet.ts",
    find: String.raw`z.regex(/^(?![-/.]|HEAD$)(?!.*(?:\.\.|\/\/|\/\.|@\{|\.lock(?:\/|$)))(?!.*[/.]$)[A-Za-z0-9._/-]{1,200}$/)`,
    replace: String.raw`z.regex(/^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/)`,
    run: ["packages/protocol/test/fleet.test.ts"], expect: "a//b" },
  { id: "t1-res-store-required", task: "1", file: "packages/protocol/src/fleet.ts",
    find: "store: z.uuid(), ok: z.literal(true)", replace: "store: z.exactOptional(z.uuid()), ok: z.literal(true)",
    run: ["packages/protocol/test/fleet.test.ts"], expect: "expected 'ok' to be 'malformed'" },
  // ---- Task 2: node-ops (Steps 19, 24, 29)
  { id: "t2-confine-normalize", task: "2", file: "packages/node-ops/src/file-rules.ts",
    find: "const asked = normalize(path);", replace: "const asked = path;",
    run: ["packages/node-ops/test/file-rules.test.ts"], expect: "missing" },
  { id: "t2-confine-real-path", task: "2", file: "packages/node-ops/src/file-rules.ts",
    find: `  if (deniedBy(real, deny)) return { ok: false, reason: "denied" };\n`, replace: "",
    run: ["packages/node-ops/test/file-rules.test.ts"], expect: "a link into a deny root" },
  { id: "t2-deny-prefix", task: "2", file: "packages/node-ops/src/file-rules.ts",
    find: `(r.endsWith("*") ? path.startsWith(r.slice(0, -1)) : path === r`, replace: `(false ? path.startsWith(r.slice(0, -1)) : path === r`,
    run: ["packages/node-ops/test/file-rules.test.ts"], expect: ".local/share/morndo" },
  { id: "t2-secret-credentials-json", task: "2", file: "packages/node-ops/src/file-rules.ts",
    find: String.raw`|\.?credentials(\.json)?)$/i`, replace: String.raw`|credentials(\.json)?)$/i`,
    run: ["packages/node-ops/test/file-rules.test.ts"], expect: ".credentials.json" },
  { id: "t2-open-no-follow", task: "2", file: "packages/node-ops/src/file-rules.ts",
    find: "constants.O_RDONLY | constants.O_NOFOLLOW", replace: "constants.O_RDONLY",
    run: ["packages/node-ops/test/file-rules.test.ts"] },
  { id: "t2-hub-files-denied-by", task: "2", file: "apps/hub/src/adapters/files.ts",
    find: "|| deniedBy(real, opts.deny);", replace: "|| opts.deny.some(d => real === d || real.startsWith(`${d}/`));",
    run: ["apps/hub/test/files.test.ts"], expect: "fleet.db" },
  { id: "t2-tmux-u", task: "2", file: "packages/node-ops/src/tmux-cli.ts",
    find: `return ["-u", ...(socket`, replace: "return [...(socket",
    run: ["packages/node-ops/test/tmux-cli.test.ts"], expect: "'-u', 'list-sessions'" },
  { id: "t2-tmux-literal", task: "2", file: "packages/node-ops/src/tmux-cli.ts",
    find: `export const tmuxLiteral = (s: string): string => s.replaceAll("#", "##");`, replace: "export const tmuxLiteral = (s: string): string => s;",
    run: ["packages/node-ops/test/tmux-cli.test.ts"], expect: "amain b" },
  { id: "t2-kill-waits", task: "2", file: "packages/node-ops/test/isolated-tmux.ts",
    find: "    for (let i = 0; i < 100 && !gone(); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);\n", replace: "",
    run: ["packages/node-ops/test/tmux-cli.test.ts"], expect: "to throw" },
  { id: "t2-kill-removes-socket", task: "2", file: "packages/node-ops/test/isolated-tmux.ts",
    find: "    rmSync(join(process.env.TMUX_TMPDIR || \"/tmp\", `tmux-${process.getuid?.() ?? 0}`, socket), { force: true });\n", replace: "",
    run: ["packages/node-ops/test/tmux-cli.test.ts"], expect: "expected true to be false" },
  { id: "t2-health-tmux-ok", task: "2", file: "packages/node-ops/src/health.ts",
    find: `["list-sessions"]`, replace: `["-V"]`,
    run: ["packages/node-ops/test/stamp-health.test.ts"], expect: "expected true to be false" },
  { id: "t2-stamp-kept", task: "2", file: "packages/node-ops/src/stamp.ts",
    find: `    const known = await read();\n    if (known) return known;\n    try { await tmux(["set-option", "-g", "-o", "@morndo-server", randomUUID()]); }`,
    replace: `    try { await tmux(["set-option", "-g", "@morndo-server", randomUUID()]); }`,
    run: ["packages/node-ops/test/stamp-health.test.ts"], expect: "keeps a stamp that is already there" },
  // ---- Task 3: transcript bytes and the reader (Steps 4, 10)
  { id: "t3-locate-window-edge", task: "3", file: "packages/node-ops/src/transcript-bytes.ts",
    find: "after = buf.subarray(0, n.length - 1);", replace: "after = Buffer.alloc(0);",
    run: ["packages/node-ops/test/transcript-bytes.test.ts"], expect: "a needle across the edge" },
  { id: "t3-no-carry", task: "3", file: "apps/hub/src/adapters/claude-sessions.ts",
    find: "    else cursor.carry = carried;", replace: "    else { /* no carry */ }",
    run: ["apps/hub/test/transcript-long-lines.test.ts"], expect: "a 3 MB line arrives whole" },
  { id: "t3-no-skip", task: "3", file: "apps/hub/src/adapters/claude-sessions.ts",
    find: "    if (length > maxLine) { cursor.skip", replace: "    if (false) { cursor.skip",
    run: ["apps/hub/test/transcript-long-lines.test.ts"], expect: "a 10 MB line is one message too large" },
  { id: "t3-older-past-long-line", task: "3", file: "apps/hub/src/adapters/claude-sessions.ts",
    find: "  if (!page.length && at > 0) {", replace: "  if (false) {",
    run: ["apps/hub/test/transcript-long-lines.test.ts"], expect: "never asking twice" },
  { id: "t3-follow-keeps-place", task: "3", file: "apps/hub/src/adapters/claude-sessions.ts",
    find: "    delete cursor.sends; delete cursor.latest; delete cursor.carry; delete cursor.skip;\n    Object.assign(cursor, before);\n", replace: "",
    run: ["apps/hub/test/transcript-long-lines.test.ts"], expect: "leaves the cursor as it was" },

  // ---- Tasks 4 and 5: the hub's async ports and keys (02-hub-async.md; each step's "Then check that it bites").
  { id: "t4-sequential-poll", task: "4", file: "apps/hub/src/application/observation-service.ts",
    find: "    const rounds: Promise<void>[] = [];\n    for (const [node, ids] of byNode) {\n      if (states && states.get(node) !== \"online\") continue;      // not online: skipped at once\n      if (this.#working.has(node)) continue;                       // its last round still runs: no second one on top\n      this.#working.add(node);\n      rounds.push(this.#pollNode(ids).then(\n        r => { this.#arrived.push(r); },\n        (e: unknown) => { log.warn(`observation: node ${node} failed this round: ${(e as Error).message}`); },\n      ).finally(() => { this.#working.delete(node); }));\n    }\n    if (!rounds.length) return;\n    let timer: NodeJS.Timeout | undefined;\n    const waited = new Promise<void>(resolve => { timer = setTimeout(resolve, this.#nodeWaitMs); });\n    try { await Promise.race([Promise.allSettled(rounds), waited]); }\n    finally { clearTimeout(timer); }",
    replace: "    for (const [node, ids] of byNode) {                            // NEGATIVE CONTROL: one node after the other\n      if (states && states.get(node) !== \"online\") continue;\n      this.#arrived.push(await this.#pollNode(ids));\n    }",
    run: ["apps/hub/test/observation-nodes.test.ts"], expect: "expected false to be true" },
  { id: "t4-source-unavailable-drops-follow", task: "4", file: "apps/hub/src/application/observation-service.ts",
    find: "        if (e instanceof SourceUnavailable && !round.rebuilt.has(id)) continue;\n",
    replace: "",
    run: ["apps/hub/test/observation-unavailable.test.ts"], expect: "expected [] to deeply equal [ 'a1:0' ]" },
  { id: "t5-answer-key-random", task: "5", file: "apps/hub/src/application/escalation-service.ts",
    find: "answerKey(e.id, e, choice)",
    replace: "`${answerKey(e.id, e, choice)}:${Math.random()}`",
    run: ["apps/hub/test/escalation-answer-keys.test.ts"], expect: "to deeply equal [ { pane: '%0', …(2) } ]" },
  { id: "t5-answer-key-without-ask", task: "5", file: "apps/hub/src/application/escalation-service.ts",
    find: "answerKey(e.id, e, choice)",
    replace: "answerKey(e.id, { messageId: null, askedAt: 0 }, choice)",
    run: ["apps/hub/test/escalation-answer-keys.test.ts"], expect: "expected [ 'answer:ny-7:t0:option:ship' ]" },
  { id: "t5-node-offline-kept", task: "5", file: "apps/hub/src/application/steering-service.ts",
    find: "\"busy\", \"node_offline\"]);",
    replace: "\"busy\"]);",
    run: ["apps/hub/test/steering-keys.test.ts"], expect: "expected { state: 'started'" },
  // ---- Tasks 6-9: the agent (03-agent.md; each step's "Then check that it bites"). Its join's plain-ws:// control
  // changes two files, so it is in Task 18's table of controls the runner can't express.
  { id: "t6-config-fleeturl", task: "6", file: "apps/node-agent/src/config.ts",
    find: "!fleetUrlOk(c.fleetUrl)",
    replace: "!/^wss?:\\/\\/[^\\s]+$/.test(c.fleetUrl)",
    run: ["apps/node-agent/test/config.test.ts"], expect: "ws://100.64.0.1:8791/agent" },
  { id: "t6-rotate-not-stored", task: "6", file: "apps/node-agent/src/db/open.ts",
    find: "  db.prepare(\"UPDATE meta SET value = ? WHERE key = 'streamId'\").run(id);\n",
    replace: "",
    run: ["apps/node-agent/test/db.test.ts"] },
  { id: "t7-4409-no-retry", task: "7", file: "apps/node-agent/src/conn/connection.ts",
    find: "const wait = this.#retry.afterAbout(LIMITS.conflictRetryMs, CONFLICT_SPREAD, () => this.#dial());",
    replace: "const wait = 0;",
    run: ["apps/node-agent/test/connection.test.ts"], expect: "expected null to be 240000" },
  { id: "t7-4409-leaves-conflict", task: "7", file: "apps/node-agent/src/conn/connection.ts",
    find: "    if (this.#status.state !== \"conflict\") this.#set(\"connecting\", { connEpoch: null });",
    replace: "    this.#set(\"connecting\", { connEpoch: null });",
    run: ["apps/node-agent/test/connection.test.ts"] },
  { id: "t7-ping-timeout-20s", task: "7", file: "apps/node-agent/src/conn/connection.ts",
    find: "    }, this.#o.pingTimeoutMs ?? LIMITS.agentPingTimeoutMs);",
    replace: "    }, this.#o.pingTimeoutMs ?? 20_000);",
    run: ["apps/node-agent/test/connection.test.ts"] },
  { id: "t7-plain-ws-dialed", task: "7", file: "apps/node-agent/src/conn/connection.ts",
    find: "    if (!fleetUrlOk(o.url)) throw new TypeError(`the fleet URL must be wss://, or ws:// to this machine (127.0.0.1, localhost or [::1]); not dialing ${o.url}`);\n",
    replace: "",
    run: ["apps/node-agent/test/connection.test.ts"] },
  { id: "t7-no-jitter", task: "7", file: "apps/node-agent/src/conn/retry.ts",
    find: "Math.round(ms * (1 - spread + 2 * spread * this.#random()))",
    replace: "ms",
    run: ["apps/node-agent/test/retry.test.ts", "apps/node-agent/test/connection.test.ts"] },
  { id: "t8-hash-all-args", task: "8", file: "apps/node-agent/src/ops/done-keys.ts",
    find: "  const picked = fields ? Object.fromEntries(fields.map(f => [f, all[f]])) : args;",
    replace: "  const picked = args;",
    run: ["apps/node-agent/test/done-keys.test.ts", "apps/node-agent/test/executor.test.ts"] },
  { id: "t8-mismatch-bad-args", task: "8", file: "apps/node-agent/src/ops/executor.ts",
    find: "        if (prior.state === \"mismatch\") return fail(\"uncertain\", \"this key was used with other arguments: its op may have run\");",
    replace: "        if (prior.state === \"mismatch\") return fail(\"bad_args\", \"this key was used with other arguments\");",
    run: ["apps/node-agent/test/executor.test.ts"] },
  { id: "t8-key-on-unkeyed-op", task: "8", file: "apps/node-agent/src/ops/executor.ts",
    find: "    if (!keyed && req.key !== undefined) return fail(\"bad_args\", `${op} takes no key`);\n",
    replace: "",
    run: ["apps/node-agent/test/executor.test.ts"] },
  { id: "t8-args-without-op-args", task: "8", file: "apps/node-agent/src/ops/args.ts",
    find: "  const v = parseBody(OP_ARGS[op], a) as OpArgs[O] | null;",
    replace: "  const v = (typeof a === \"object\" && a !== null ? a : null) as OpArgs[O] | null;",
    run: ["apps/node-agent/test/executor.test.ts"] },
  { id: "t8-c-unescaped", task: "8", file: "apps/node-agent/src/ops/lane-ops.ts",
    find: "\"-c\", tmuxLiteral(cwd)",
    replace: "\"-c\", cwd",
    run: ["apps/node-agent/test/lane-worktree-ops.test.ts"] },
  { id: "t8-n-unescaped", task: "8", file: "apps/node-agent/src/ops/lane-ops.ts",
    find: "\"-n\", tmuxLiteral(a.name)",
    replace: "\"-n\", a.name",
    run: ["apps/node-agent/test/lane-worktree-ops.test.ts"] },
  { id: "t8-opener-wrong-home", task: "8", file: "apps/node-agent/src/ops/node-files.ts",
    find: "openConfined(path, { home: o.home,",
    replace: "openConfined(path, { home: \"/nonexistent-home\",",
    run: ["apps/node-agent/test/transcript-file-ops.test.ts"] },
  { id: "t8-late-lock-types", task: "8", file: "apps/node-agent/src/ops/pane-ops.ts",
    find: "      const late = ctx.ready();\n      if (late) return { ok: false, error: late };\n      return act(pane);",
    replace: "      return act(pane);",
    run: ["apps/node-agent/test/pane-ops.test.ts"] },
  { id: "t8-inbox-no-budget", task: "8", file: "apps/node-agent/src/ops/upload-inbox.ts",
    find: "    if (bytes.length > this.#room()) return fail(\"too_large\", \"this node's disk budget for uploads and hooks is full\");\n",
    replace: "",
    run: ["apps/node-agent/test/transcript-file-ops.test.ts"] },
  { id: "t8-branch-git-check-off", task: "8", file: "apps/node-agent/src/ops/worktree-ops.ts",
    find: "  try { await run(\"git\", [\"check-ref-format\", \"--branch\", name], { timeout: 10_000 }); return true; }\n  catch { return false; }",
    replace: "  return name.length >= 0;",
    run: ["apps/node-agent/test/lane-worktree-ops.test.ts"], expect: "HEAD" },
  { id: "t9-res-without-store", task: "9", file: "apps/node-agent/src/agent.ts",
    find: "invVersion: reply.invVersion, store: streamId, ok: true",
    replace: "invVersion: reply.invVersion, ok: true",
    run: ["apps/node-agent/test/agent.test.ts"] },
  { id: "t9-store-ignores-fixed-stream", task: "9", file: "apps/node-agent/src/agent.ts",
    find: "invVersion: reply.invVersion, store: streamId, ok: true",
    replace: "invVersion: reply.invVersion, store: adb.streamId, ok: true",
    run: ["apps/node-agent/test/agent.test.ts"] },
  { id: "t9-no-rotation", task: "9", file: "apps/node-agent/src/agent.ts",
    find: "    if (!w.streamKnown || w.ackSeq <= last) return false;",
    replace: "    if (w.streamKnown || !w.streamKnown) return false;",
    run: ["apps/node-agent/test/stream.test.ts"] },
  { id: "t9-rotation-not-stored", task: "9", file: "apps/node-agent/src/agent.ts",
    find: "      streamId = rotateStreamId(adb.db);",
    replace: "      streamId = randomUUID();",
    run: ["apps/node-agent/test/stream.test.ts"] },
  { id: "t9-held-not-counted", task: "9", file: "apps/node-agent/src/relay/spool.ts",
    find: "bytes + held + size > this.#maxBytes",
    replace: "bytes + size > this.#maxBytes + 0 * held",
    run: ["apps/node-agent/test/spool.test.ts"] },
  { id: "t9-relay-no-budget", task: "9", file: "apps/node-agent/src/relay/relay-files.ts",
    find: "      if (c.size > this.#room()) return { ok: false, status: 503 };          // the disk budget is full\n",
    replace: "",
    run: ["apps/node-agent/test/relay-server.test.ts"] },
  { id: "t9-budget-ignores-held", task: "9", file: "apps/node-agent/src/agent.ts",
    find: "  const room = (): number => budget - spool.bytes() - held();",
    replace: "  const room = (): number => budget - spool.bytes();",
    run: ["apps/node-agent/test/agent.test.ts"] },
  { id: "t9-sender-throws", task: "9", file: "apps/node-agent/src/relay/stream-sender.ts",
    find: "    try { this.#spool.ack(seq); return true; }\n    catch (e) { this.#log?.warn(\"could not delete acknowledged hook events (a full disk?); they stay until a later ack\", e); return false; }",
    replace: "    this.#spool.ack(seq); return true;",
    run: ["apps/node-agent/test/stream.test.ts", "apps/node-agent/test/agent.test.ts"] },
  { id: "t9-prune-not-wired", task: "9", file: "apps/node-agent/src/agent.ts",
    find: "    try { ops.doneKeys.prune(); files.sweep(); ops.inbox.sweep(); }",
    replace: "    try { files.sweep(); ops.inbox.sweep(); }",
    run: ["apps/node-agent/test/agent.test.ts"] },
  { id: "t9-spoolfail-ack-ok", task: "9", file: "apps/node-agent/src/relay/spool.ts",
    find: "    if (this.#failWrites) throw new Error(\"the test hook spoolFail refuses every spool write\");\n    this.#db.transaction(() => {",
    replace: "    this.#db.transaction(() => {",
    run: ["apps/node-agent/test/spool.test.ts", "apps/node-agent/test/agent.test.ts"] },
  { id: "t9-health-other-socket", task: "9", file: "apps/node-agent/src/agent.ts",
    find: "healthProbe(config.home, { tmuxSocket: config.policy.tmuxSocket })",
    replace: "healthProbe(config.home, { tmuxSocket: \"test-control-elsewhere\" })",
    run: ["apps/node-agent/test/agent.test.ts"] },
  // ---- Tasks 10-13: the fleet (04-fleet.md; each step's "Then check that it bites").
  { id: "t10-listen-anywhere", task: "10", file: "apps/fleet/src/config.ts",
    find: "    if (!LOOPBACK_HOST.test(l.host)) {",
    replace: "    if (!LOOPBACK_HOST.test(l.host) && false) {",
    run: ["apps/fleet/test/config.test.ts"], expect: "0.0.0.0" },
  { id: "t10-publicurl-plain", task: "10", file: "apps/fleet/src/config.ts",
    find: "  if (!fleetUrlOk(u)) throw",
    replace: "  if (!fleetUrlOk(u) && false) throw",
    run: ["apps/fleet/test/config.test.ts"], expect: "100.64.0.7:8791/agent" },
  { id: "t10-alerts-one-cap", task: "10", file: "apps/fleet/src/adapters/audit.ts",
    find: "    return [...security, ...others].sort(",
    replace: "    security.length = 0;\n    return [...security, ...others].sort(",
    run: ["apps/fleet/test/audit.test.ts"], expect: "no number of other alerts" },
  { id: "t10-no-prune", task: "10", file: "apps/fleet/src/adapters/audit.ts",
    find: "\"DELETE FROM audit WHERE at < ?\"",
    replace: "\"DELETE FROM audit WHERE at < ? AND 0\"",
    run: ["apps/fleet/test/audit.test.ts"], expect: "prune() deletes audit rows" },
  { id: "t11-no-instance-check", task: "11", file: "apps/fleet/src/application/connections.ts",
    find: "      const answered = await this.#check(cur);",
    replace: "      const answered = true;",
    run: ["apps/fleet/test/instances.test.ts"], expect: "half-open" },
  { id: "t11-no-handshake-limit", task: "11", file: "apps/fleet/src/adapters/agent-session.ts",
    find: "        if (!d.handshakes.take(d.source)) return tooMany();\n        if (!speaks(m.proto)) { refused",
    replace: "        if (!speaks(m.proto)) { refused",
    run: ["apps/fleet/test/agent-auth.test.ts"], expect: "past its bucket" },
  { id: "t11-bulk-wait-unbounded", task: "11", file: "apps/fleet/src/application/connections.ts",
    find: "        }, o.timeoutMs),",
    replace: "        }, o.timeoutMs + 600_000),",
    run: ["apps/fleet/test/requests.test.ts"], expect: "behind a hung transfer" },
  { id: "t11-bulk-full-timeout", task: "11", file: "apps/fleet/src/application/connections.ts",
    find: "        const left = Math.floor(w.o.timeoutMs - (this.#mono() - w.at));",
    replace: "        const left = w.o.timeoutMs;",
    run: ["apps/fleet/test/requests.test.ts"], expect: "what is left of its own timeout" },
  { id: "t11-no-bulk-cap", task: "11", file: "apps/fleet/src/application/connections.ts",
    find: "    if (q.waiting.length >= LIMITS.bulkQueueMax) {",
    replace: "    if (q.waiting.length >= Infinity) {",
    run: ["apps/fleet/test/requests.test.ts"], expect: "at most 8 bulk ops" },
  { id: "t11-store-from-connection", task: "11", file: "apps/fleet/src/application/requests.ts",
    find: "invVersion: res.invVersion, store: res.store });",
    replace: "invVersion: res.invVersion, store: p.store });",
    run: ["apps/fleet/test/requests.test.ts"], expect: "every answer carries its store" },
  { id: "t11-no-1009", task: "11", file: "apps/fleet/src/adapters/agent-session.ts",
    find: "    if (raw.length > LIMITS.maxMessageBytes) return close(1009, \"message too big\");\n",
    replace: "",
    run: ["apps/fleet/test/agent-auth.test.ts"], expect: "1009" },
  { id: "t11-no-retention-on-start", task: "11", file: "apps/fleet/src/serve.ts",
    find: "  pruneAudit();\n",
    replace: "",
    run: ["apps/fleet/test/liveness.test.ts"], expect: "go when the service starts" },
  { id: "t11-no-admission-audit", task: "11", file: "apps/fleet/src/application/connections.ts",
    find: "    this.#audit.record(\"agent\", \"conn.admitted\", a.node, { instanceId: a.instanceId, epoch, source: a.source });\n",
    replace: "",
    run: ["apps/fleet/test/agent-auth.test.ts"], expect: "conn.admitted" },
  { id: "t12-no-name-reservation", task: "12", file: "apps/fleet/src/application/router.ts",
    find: "    if (this.#reserved(name)) return refuse(",
    replace: "    if (false && this.#reserved(name)) return refuse(",
    run: ["apps/fleet/test/router.test.ts"], expect: "reserves its name" },
  { id: "t12-no-op-audit", task: "12", file: "apps/fleet/src/application/router.ts",
    find: "    if (SIDE_EFFECT_OPS.has(op)) {",
    replace: "    if (false) {",
    run: ["apps/fleet/test/router.test.ts", "apps/fleet/test/client-api.test.ts"], expect: "audits" },
  { id: "t12-events-unbounded", task: "12", file: "apps/fleet/src/adapters/client-api.ts",
    find: "        if (ws.bufferedAmount > eventsBufferBytes) {",
    replace: "        if (false) {",
    run: ["apps/fleet/test/client-api.test.ts"], expect: "falls too far behind" },
  { id: "t12-revoked-offline-lanes-kept", task: "12", file: "apps/fleet/src/application/connections.ts",
    find: "    for (const n of this.#nodes.list()) if (n.revokedAt !== null && this.#revocations.get(n.name) !== n.revokedAt) this.revoke(n.name);\n",
    replace: "",
    run: ["apps/fleet/test/client-api.test.ts"], expect: "while the node is offline" },
  { id: "t12-conflict-routed-by-name", task: "12", file: "apps/fleet/src/application/router.ts",
    find: "      if (r.kind === \"conflict\") return refuse(",
    replace: "      if (r.kind === \"conflict\" && false) return refuse(",
    run: ["apps/fleet/test/router.test.ts", "apps/fleet/test/client-api.test.ts"], expect: "lane_conflict" },
  { id: "t12-worker-id-blocked-by-conflict", task: "12", file: "apps/fleet/src/application/router.ts",
    find: "      node = ref.node;\n      workerId = target.workerId;\n",
    replace: "      node = ref.node;\n      workerId = target.workerId;\n      if (this.#lanes.list().some(l => l.conflict)) return refuse(failed(\"lane_conflict\", \"a name is in conflict\"));\n",
    run: ["apps/fleet/test/router.test.ts", "apps/fleet/test/client-api.test.ts"], expect: "still reachable by its worker ID" },
  { id: "t12-no-store-on-refusal", task: "12", file: "apps/fleet/src/adapters/client-api.ts",
    find: "      if (!parsed.ok) return json(res, 400, { ok: false, error: opError(\"bad_args\", parsed.message), store: null });",
    replace: "      if (!parsed.ok) return json(res, 400, { ok: false, error: opError(\"bad_args\", parsed.message) });",
    run: ["apps/fleet/test/client-api.test.ts"], expect: "POST /v1/op answers the outcome" },
  { id: "t13-dead-letter-alert-each", task: "13", file: "apps/fleet/src/application/delivery.ts",
    find: "      if (!this.#deadEpisodes.has(s.name)) {",
    replace: "      if (true) {",
    run: ["apps/fleet/test/delivery.test.ts"], expect: "one dead_letter alert per subscriber episode" },
  { id: "t13-dead-letter-episode-never-ends", task: "13", file: "apps/fleet/src/application/delivery.ts",
    find: " this.#deadEpisodes.delete(s.name); return; }",
    replace: " return; }",
    run: ["apps/fleet/test/delivery.test.ts"], expect: "one dead_letter alert per subscriber episode" },
  { id: "t13-status-no-bus", task: "13", file: "apps/fleet/src/main.ts",
    find: "  for (const b of bus) {\n",
    replace: "  for (const b of bus.slice(0, 0)) {\n",
    run: ["apps/fleet/test/status.test.ts"], expect: "waiting" },
  // ---- Task 14: the fleet client, the fleet adapters and the repeat path (05-hub-fleet.md).
  { id: "t14-client-no-alert-event", task: "14", file: "apps/hub/src/adapters/fleet-client.ts",
    find: "const EVENTS = new Set<string>([\"inventory\", \"health\", \"status\", \"conflict\", \"alert\"]);",
    replace: "const EVENTS = new Set<string>([\"inventory\", \"health\", \"status\", \"conflict\"]);",
    run: ["apps/hub/test/fleet-client.test.ts"], expect: "not within 5000 ms" },
  { id: "t14-client-einval-reached", task: "14", file: "apps/hub/src/adapters/fleet-client.ts",
    find: ", \"EINVAL\", \"ENAMETOOLONG\"]);",
    replace: "]);",
    run: ["apps/hub/test/fleet-client.test.ts"], expect: "expected true to be false" },
  { id: "t14-client-no-name", task: "14", file: "apps/hub/src/adapters/fleet-client.ts",
    find: "const CLIENT = { \"x-morndo-client\": \"hub\" };",
    replace: "const CLIENT = {};",
    run: ["apps/hub/test/fleet-client.test.ts"], expect: "expected Set{ '' } to deeply equal Set{ 'hub' }" },
  { id: "t14-listing-waits", task: "14", file: "apps/hub/src/adapters/fleet-adapters.ts",
    find: "within(refreshInventory(node), LIMITS.inventoryWaitMs)",
    replace: "refreshInventory(node).catch(() => {})",
    run: ["apps/hub/test/fleet-adapters.test.ts"], expect: "to be less than 800" },
  { id: "t14-keys-uncertain-as-refused", task: "14", file: "apps/hub/src/adapters/fleet-adapters.ts",
    find: "return r.error.executed === \"maybe\" ? \"uncertain\" : false;",
    replace: "return false;",
    run: ["apps/hub/test/fleet-adapters.test.ts"], expect: "expected false to be 'uncertain'" },
  { id: "t14-unavailable-as-gone", task: "14", file: "apps/hub/src/adapters/fleet-adapters.ts",
    find: "    if (NOT_NOW.has(r.error.code)) throw new SourceUnavailable(`${op} on ${node}: ${r.error.code}`);\n",
    replace: "",
    run: ["apps/hub/test/fleet-adapters.test.ts"], expect: "promise resolved \"null\" instead of rejecting" },
  { id: "t14-http-keys-refused", task: "14", file: "apps/hub/src/adapters/http.ts",
    find: "      if (typed === \"uncertain\") send({ t: \"error\", error: \"keys_uncertain\" });\n      else if (!typed) send({ t: \"error\", error: \"keys_refused\" });",
    replace: "      if (!typed || typed === \"uncertain\") send({ t: \"error\", error: \"keys_refused\" });",
    run: ["apps/hub/test/http-terminal-throws.test.ts"], expect: "expected [ Array(1) ] to deeply equal [ Array(1) ]" },
  { id: "t14-fleet-desktop", task: "14", file: "apps/hub/src/adapters/local-ports.ts",
    find: "    if (fleet || !config.vnc) return null;",
    replace: "    if (!config.vnc) return null;",
    run: ["apps/hub/test/local-ports.test.ts"], expect: "to be null" },
  { id: "t14-settle-hub-clock", task: "14", file: "apps/hub/src/application/steering-service.ts",
    find: "at: s.typedAt }; }",
    replace: "at: this.#now() }; }",
    run: ["apps/hub/test/fleet-steering.test.ts"], expect: "expected { ok: false, …(2) } to deeply equal { ok: false, …(2) }" },
  { id: "t14-unknown-never-trusted", task: "14", file: "apps/hub/src/application/steering-service.ts",
    find: "      this.#store.dropSend(key);\n      return null;",
    replace: "      return { ok: false, problem: \"uncertain\" };",
    run: ["apps/hub/test/fleet-steering.test.ts"], expect: "expected { ok: false, problem: 'uncertain' } to deeply equal { ok: true, at: 1791277200007 }" },
  { id: "t14-store-not-checked", task: "14", file: "apps/hub/src/application/steering-service.ts",
    find: "row.store === null || row.store !== s.store",
    replace: "false",
    run: ["apps/hub/test/fleet-steering.test.ts"], expect: "expected { ok: true, at: 1791277200007 } to deeply equal { ok: false, problem: 'uncertain' }" },
  { id: "t14-repeat-not-registered", task: "14", file: "apps/hub/src/application/steering-service.ts",
    find: "    this.#typing.set(key, job);\n",
    replace: "",
    run: ["apps/hub/test/fleet-steering.test.ts"], expect: "expected [ …(2) ] to deeply equal [ …(2) ]" },
  { id: "t14-manager-in-conflict", task: "14", file: "apps/hub/src/application/escalation-service.ts",
    find: "named.some(w => w.conflict) ? null : named[0]?.id ?? null",
    replace: "named[0]?.id ?? null",
    run: ["apps/hub/test/fleet-conflicts.test.ts"], expect: "to match object { ok: false, problem: 'lane_conflict' }" },
  { id: "t14-no-conflict-flags", task: "14", file: "apps/hub/src/adapters/fleet-adapters.ts",
    find: "conflict: view.conflicted(name),",
    replace: "conflict: false,",
    run: ["apps/hub/test/fleet-conflicts.test.ts"], expect: "expected false to be true" },
  { id: "t14-fleet-down-throws", task: "14", file: "apps/hub/src/application/observation-service.ts",
    find: "      if (!this.#nodeStates) throw e;",
    replace: "      throw e;",
    run: ["apps/hub/test/fleet-unavailable.test.ts"], expect: "connect ENOENT" },
  // ---- Task 15b: the offline marker, the fleet banner, keys "may have been typed", Check again (06-web-uncertain-offline.md).
  // The Chromium files need Chromium (npx playwright install chromium).
  { id: "t15b-check-new-id", task: "15b", file: "apps/web/src/lib/outbox/outbox.ts",
    find: "if (r.state === \"uncertain\") return this.#check(id);",
    replace: "if (r.state === \"uncertain\") { await this.discard(id); await this.enqueue({ worker: r.worker, workerName: r.workerName, text: r.text, uploads: r.uploads, seen: r.seen }); return; }",
    run: ["apps/web/test/outbox.test.ts", "apps/web/test/outbox-web.test.ts"], expect: "to deeply equal" },
  { id: "t15b-every-refusal-definite", task: "15b", file: "apps/web/src/lib/outbox/outbox.ts",
    find: "o.status === 409 || (o.status === 404 && o.code === \"no_pane\") || (o.status === 403 && o.code === \"step_up\");",
    replace: "true;",
    run: ["apps/web/test/outbox.test.ts", "apps/web/test/outbox-web.test.ts"], expect: "state: 'uncertain'" },
  { id: "t15b-check-blind-to-refusals", task: "15b", file: "apps/web/src/lib/outbox/outbox.ts",
    find: "    if (outcome.kind === \"refused\" && definiteRefusal(outcome)) {\n      await this.#save({ ...r, state: advance(r.state, \"failed\"), error: outcome.code });\n      return;\n    }\n",
    replace: "",
    run: ["apps/web/test/outbox.test.ts", "apps/web/test/outbox-web.test.ts"], expect: "state: 'failed'" },
  { id: "t15b-no-fleet-banner-wide", task: "15b", file: "apps/web/src/lib/desktop/Desktop.svelte",
    find: "  <FleetNotice available={feed.fleetAvailable} />\n",
    replace: "",
    run: ["apps/web/test/fleet-unavailable-web.test.ts"], expect: "Timeout 5000ms exceeded" },
  { id: "t15b-no-fleet-banner-narrow", task: "15b", file: "apps/web/src/lib/phone/Phone.svelte",
    find: "  <FleetNotice available={feed.fleetAvailable} />\n",
    replace: "",
    run: ["apps/web/test/fleet-unavailable-web.test.ts"], expect: "Timeout 5000ms exceeded" },
  { id: "t15b-no-fleet-frame-after-hello", task: "15b", file: "apps/hub/src/adapters/http.ts",
    find: "            send({ t: \"fleet\", available: observation.fleet() === \"ok\" });   // a resumed feed may have missed a change\n",
    replace: "",
    run: ["apps/hub/test/feed-fleet.test.ts"], expect: "expected [] to deeply equal [ true ]" },
  { id: "t15b-no-fleet-frame-on-change", task: "15b", file: "apps/hub/src/adapters/http.ts",
    find: "        fleet: status => send({ t: \"fleet\", available: status === \"ok\" }),\n",
    replace: "",
    run: ["apps/hub/test/feed-fleet.test.ts"], expect: "expected false to be true" },
  { id: "t15b-keys-one-wording", task: "15b", file: "apps/web/src/lib/desktop/TerminalView.svelte",
    find: "note = m.error === \"keys_uncertain\" ? \"Those keys may have been typed.\" : \"The pane didn't take those keys.\"; break;",
    replace: "note = \"The pane didn't take those keys.\"; break;",
    run: ["apps/web/test/terminal-keys-web.test.ts"], expect: "to be 'Those keys may have been typed.'" },
  { id: "t15b-no-refusal-words", task: "15b", file: "apps/web/src/lib/desktop/decisions.ts",
    find: "  lane_conflict: \"Two windows are named like the manager, so the answer wasn't typed: nobody can tell which one it's for. Close or rename one of them, then try again.\",\n",
    replace: "",
    run: ["apps/web/test/decision-refusals.test.ts"], expect: "expected [ 'lane_conflict' ] to deeply equal []" },
  { id: "t15b-no-offline-marker-wide", task: "15b", file: "apps/web/src/lib/desktop/Sidebar.svelte",
    find: "              {#if w.offline}<span class=\"off\">offline</span>{/if}\n",
    replace: "",
    run: ["apps/web/test/worker-offline-web.test.ts"], expect: "expected 'alpha' to contain 'offline'" },
  { id: "t15b-no-offline-marker-narrow", task: "15b", file: "apps/web/src/lib/phone/Agents.svelte",
    find: "{#if w.offline}<span class=\"when muted\">offline</span>\n            {:else if w.needsYou}",
    replace: "{#if w.needsYou}",
    run: ["apps/web/test/worker-offline-web.test.ts"], expect: "to be 'offline'" },
];

// ---- the runner

const ROOT = join(import.meta.dirname, "..");
const say = (line: string) => process.stdout.write(`${line}\n`);
const occurrences = (text: string, find: string) => (find ? text.split(find).length - 1 : 0);

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

// The entries themselves: unique ids, and every field filled.
function malformed(controls: readonly Control[]): string[] {
  const seen = new Set<string>();
  const bad: string[] = [];
  for (const c of controls) {
    if (seen.has(c.id)) bad.push(`${c.id}: a second entry with this id`);
    seen.add(c.id);
    if (!c.find || !c.file || !c.run.length || c.find === c.replace) bad.push(`${c.id}: needs a file, a find that differs from its replace, and tests to run`);
  }
  return bad;
}

function check(controls: readonly Control[]): number {
  let stale = 0;
  for (const c of controls) {
    let n = 0;
    try { n = occurrences(readFileSync(join(ROOT, c.file), "utf8"), c.find); } catch { n = -1; }
    if (n !== 1) stale++;
    say(`${n === 1 ? "ok   " : "STALE"} ${c.id}: ${n === -1 ? `${c.file} is missing` : `found ${n} time${n === 1 ? "" : "s"} in ${c.file}`}`);
  }
  return stale;
}

function vitest(tree: string, files: string[]) {
  const r = spawnSync(process.execPath, [join(tree, "node_modules/vitest/vitest.mjs"), "run", ...files], {
    cwd: tree, encoding: "utf8", timeout: 15 * 60_000, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  return { passed: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const tail = (out: string) => out.trim().split("\n").filter(l => /FAIL|×|Error|expected|Tests /.test(l)).slice(0, 6).map(l => `      ${l.trim()}`).join("\n");

function runAll(controls: readonly Control[], keep: boolean): number {
  const head = git(ROOT, "rev-parse", "HEAD");
  if (git(ROOT, "status", "--porcelain")) say(`note: uncommitted changes are not in the run; it runs HEAD (${head.slice(0, 7)})`);
  const tmp = mkdtempSync(join(tmpdir(), "morndo-controls-"));
  const tree = join(tmp, "tree");
  let failures = 0;
  try {
    git(ROOT, "worktree", "add", "--detach", tree, head);
    const ci = spawnSync("npm", ["ci", "--offline", "--no-audit", "--no-fund"], { cwd: tree, encoding: "utf8" });
    if (ci.status !== 0) {
      say(`setup: npm ci --offline failed in ${tree} (run npm ci once in this checkout to fill npm's cache):\n${(ci.stdout + ci.stderr).trim().split("\n").slice(-8).join("\n")}`);
      return 2;
    }
    const baseline = new Map<string, { passed: boolean; out: string }>();
    for (const c of controls) {
      const path = join(tree, c.file);
      const original = readFileSync(path, "utf8");
      const n = occurrences(original, c.find);
      if (n !== 1) { failures++; say(`STALE    ${c.id}: its text is found ${n} times in ${c.file}`); continue; }
      const key = [...c.run].sort().join(" ");
      if (!baseline.has(key)) baseline.set(key, vitest(tree, c.run));
      const before = baseline.get(key);
      if (!before?.passed) { failures++; say(`BASELINE ${c.id}: ${c.run.join(", ")} fail without the change, so it proves nothing\n${tail(before?.out ?? "")}`); continue; }
      writeFileSync(path, original.replace(c.find, () => c.replace));
      const after = vitest(tree, c.run);
      git(tree, "checkout", "--", c.file);
      if (readFileSync(path, "utf8") !== original) { say(`setup: ${c.file} was not restored in ${tree}`); return 2; }
      if (after.passed) { failures++; say(`PASSED   ${c.id}: ${c.run.join(", ")} still pass with the guard removed`); continue; }
      if (c.expect && !after.out.includes(c.expect)) { failures++; say(`ELSEWHERE ${c.id}: the tests failed, but without "${c.expect}"\n${tail(after.out)}`); continue; }
      say(`bit      ${c.id}`);
    }
  } finally {
    if (keep) say(`kept: ${tree}`);
    else {
      try { git(ROOT, "worktree", "remove", "--force", tree); } catch (e) { say(`cleanup: ${(e as Error).message}; remove it with: git worktree remove --force ${tree}`); }
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  say(`${controls.length - failures}/${controls.length} controls bit`);
  return failures ? 1 : 0;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { only: { type: "string", multiple: true }, check: { type: "boolean" }, list: { type: "boolean" }, keep: { type: "boolean" } } });
  const bad = malformed(CONTROLS);
  if (bad.length) { for (const b of bad) say(`ENTRY    ${b}`); process.exit(1); }
  const chosen = values.only?.length ? CONTROLS.filter(c => values.only?.includes(c.id)) : CONTROLS;
  const unknown = (values.only ?? []).filter(id => !CONTROLS.some(c => c.id === id));
  if (unknown.length) { say(`no such control: ${unknown.join(", ")}`); process.exit(2); }
  if (values.list) { for (const c of chosen) say(`${c.id}\tTask ${c.task}\t${c.file}\t${c.run.join(" ")}`); process.exit(0); }
  if (values.check) process.exit(check(chosen) ? 1 : 0);
  process.exit(runAll(chosen, values.keep ?? false));
}
```

- [ ] **Step 9: Type-check and lint it**

In `tsconfig.tests.json`, add `"scripts",` to `"include"` after `"test",` (Task 16), so the runner is type-checked with the tests.

Run: `npx tsc -p tsconfig.tests.json`
Expected: exit 0.

Run: `npm run lint`
Expected: exit 0, no problems reported.

- [ ] **Step 10: Check that every entry still applies**

Run: `node scripts/negative-controls.ts --check`
Expected: one `ok` line per entry and exit 0. A `STALE` line names an entry whose text is no longer in its file exactly once: correct the entry to the code as it now is (the step that describes the control says what it removes), never the code to the entry.

- [ ] **Step 11: Run every control, and check that the runner itself can fail**

Run: `node scripts/negative-controls.ts`
Expected: one `bit` line per entry, then `N/N controls bit` and exit 0, in a few minutes (Task 15b's Chromium files need Chromium: `npx playwright install chromium`). It runs `HEAD`, in a temporary worktree it removes afterwards: `git worktree list` shows the same entries before and after, and `git status` the same. On macOS, a control whose tests include `pane-lock.test.ts` would be a `BASELINE` line (no `flock(1)`); none does. Run on 2026-10-06 (Node 24.21.0, tmux 3.6a, macOS), each group in a copy of its lane's tree, with `--only` for its entries: Tasks 1–3 at round 2's foundation, 22 of 22 bit in 27 s; Tasks 6–9 at the agent lane's round-2 tree, 28 of 28 in 200 s; Tasks 10–13 at the fleet lane's, 23 of 23 in 113 s; Tasks 4, 5, 14 and 15b at the hub and web lanes' round-2 tree (Tasks 4–15b from this text), 31 of 31 in 230 s, the Chromium files headless. Each run left `git worktree list` as it found it.

| Entries | Tree | Bit | Time |
|---|---|---|---|
| Tasks 1–3 (22) | the foundation, round 2 | 22 of 22 | 27 s |
| Tasks 6–9 (28) | the agent lane, round 2 | 28 of 28 | 200 s |
| Tasks 10–13 (23) | the fleet lane, round 2 | 23 of 23 | 113 s |
| Tasks 4, 5, 14, 15b (31) | the hub and web lanes, round 2 (Tasks 4–15b) | 31 of 31 | 230 s |

In that last run `t5-node-offline-kept` first printed `ELSEWHERE`: its tests failed, as they should, but with `expected { state: 'started', …(3) } to be null`, not the `…(2)` its step names. By the final tree the send row has one more field (Task 14's `store`), so its `expect` is the stable part, `expected { state: 'started'`; run again with that, it bit. An `expect` names the failure as the final tree prints it, not as the task's own step did.

Then show that the runner tells a control that doesn't bite from one that does. Copy it to a scratch name with three made-up entries added at the top of `CONTROLS`: one that changes only a comment (`find: "// The fleet's agent channel", replace: "// the fleet's agent channel"` in `packages/protocol/src/fleet.ts`, run `packages/protocol/test/fleet.test.ts`), one whose text is nowhere (`find: "no such text anywhere"`), and one whose tests fail unchanged on macOS (run `packages/node-ops/test/pane-lock.test.ts`, with the file's first line as `find`). Run the copy with `--only` for the three and one real entry, then delete the copy.
Expected (seen 2026-10-06 on macOS against Tasks 1–3): `bit` for the real one, then `PASSED` (the tests still pass with the guard "removed"), `STALE` (found 0 times) and `BASELINE` (they fail without the change, so it proves nothing), `1/4 controls bit`, and exit 1.

- [ ] **Step 12: Run them in CI: the check on every push, every control weekly**

In `.github/workflows/ci.yml`, after the step `Types`, add:

```yaml
      # Every negative control's text is still where its entry says (scripts/negative-controls.ts --check: read-only, a
      # second). The controls themselves run weekly: .github/workflows/negative-controls.yml.
      - name: Negative controls apply
        if: ${{ !cancelled() && steps.deps.outcome == 'success' }}
        run: node scripts/negative-controls.ts --check
```

Create `.github/workflows/negative-controls.yml`:

```yaml
# The plan's negative controls, run again (docs/design/fleet-core/README.md §12.1; scripts/negative-controls.ts): each
# removes one guard in a temporary worktree and expects the tests it names to fail. Weekly and on demand rather than on
# every push: a full run applies every control and runs its tests twice. CI's `ci` job checks on every push that each
# control still applies (`--check`). "Scheduled workflows run on the latest commit on the default branch", in UTC, and
# workflow_dispatch "will only trigger a workflow run if the workflow file exists on the default branch"
# (https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows, read 2026-10-06).
# Actions pinned as in ci.yml.
name: Negative controls

on:
  schedule:
    - cron: "17 4 * * 1"    # Mondays, 04:17 UTC
  workflow_dispatch:

permissions:
  contents: read

jobs:
  controls:
    runs-on: ubuntu-24.04
    timeout-minutes: 90
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false

      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version-file: package.json # engines.node
          cache: npm

      # Fills npm's cache, so the runner's own `npm ci --offline` in its temporary worktree finds every package.
      - run: npm ci

      - name: tmux and Playwright's Chromium (with its system libraries)
        run: |
          sudo apt-get update
          sudo apt-get install -y --no-install-recommends tmux
          npx playwright install --with-deps chromium

      - name: Every negative control
        run: node scripts/negative-controls.ts
```

A full run takes a few minutes for the entries above, plus each later lane's. The job keeps nothing: the runner removes its worktree.

- [ ] **Step 13: Commit**

```bash
git add scripts/negative-controls.ts tsconfig.tests.json .github/workflows/ci.yml .github/workflows/negative-controls.yml
git commit -m "test: the plan's negative controls as data, checked on every push and run weekly"
```

After the push, check the run: `gh run watch` (or `gh run list --branch feat/fleet-core -L 1`). Both jobs must be green, `e2e fleet-two-node` must say `5/5 checks passed`, `Negative controls apply` must print only `ok` lines, and the `fleet` job must show `Tests  31 passed (31)`. Download the screenshots (`gh run download <run id> -n e2e-screenshots`) and look at `fleet-two-node/1-both-nodes.png`. Then start `Negative controls` once by hand (`gh workflow run negative-controls.yml --ref feat/fleet-core` works only once the file is on the default branch; until then, run Step 11 locally) and record its result.

**Controls the runner can't express (yet).** Each is shown by its own step, by hand, or is owed as an entry:

| Control | Where | Why it isn't an entry |
|---|---|---|
| `OpResult["pane.keys"]` changed to `{ ok: string }`: `tsc` fails | Task 1, Step 11 | a compile-time check (`npx tsc -p packages/protocol`); the runner runs vitest files |
| `feed.ts` from before Step 15.3: the legacy-id Chromium test fails | Task 15, Step 15.12 | the whole file from an earlier commit (`git show <commit>^:…`), not one change |
| `fleet.revoke("n3")` commented out: the e2e fails | Task 18, Step 4 | an e2e script with the built app and Chromium, not vitest |
| the `fleet` case removed from `apps/web/src/lib/feed.svelte.ts`: `npm run check` exits 1, svelte-check naming `unreachable(m)` | Task 15b (Step 15b.23's control) | a type check (svelte-check), not a vitest file |
| the fleet mode's rig asked (two added assertions) | Task 14, Step 14.24 | an added check that the rig is used, not a guard removed |
| a plain `ws://` join string to another machine: the check removed from `parseJoinString` and `join.ts` together | Task 7 (03's lane notes) | two files at once (the protocol's `JoinStringSchema` refine and `join.ts`'s `fleetUrlOk` line); `join.test.ts` then fails, `promise resolved` |
| the agent's round-1 controls: the hooks' guard (`NODE_ENV`, the HOME check, an unknown hook), `noDoneKeys`, `dropAfterStarted`, `noExpect`, the runtime's clock, `spoolFail` not wired, `fixedStreamId` ignored, `run` not passing or not warning about hooks, `-u` seen from the inventory | Tasks 6–9 (03's lane notes) | described by what they remove, without the exact edit; each becomes an entry when its code is next touched (round 2's 28 are entries) |
| the fleet's round-1 guards: the join's name binding, the `OP_RESULTS` check, `lane_conflict`, conflict blocking, the fleet-wide name check, alerts as events, the events socket's order, the conflict event's body and place, the file refusal's shape, the op-shaped 415, `args` required, the key namespace, no top-level `expect`, the `publicUrl` check, `homeOf`, alerts oldest first, the alert dedupes, the fake agent's protocol check | Tasks 10–13 (04's lane notes) | as above (round 2's 23 are entries) |
| the drills' controls (`noDoneKeys`, `fixedStreamId`, `noExpect`; the store drill's kept store id) | Tasks 16–17 | tests of their own, run with every `fleet` run |

---

### Task 19: Docs

**Files:**
- Modify: `docs/domain.md` (a new section, "Fleet: where the workers run", and the context map)
- Create (or Modify, if Tasks 6–13 started one; keep their citations): `apps/node-agent/README.md`
- Create (or Modify, if Tasks 10–13 started one; keep their citations): `apps/fleet/README.md`
- Modify: `apps/hub/README.md` (the `MORNDO_FLEET_SOCKET` row and the fleet checks, if Task 14 didn't add them)
- Modify: `README.md` (the lines that are now wrong: "stays local, with no remote", "documents only", "Local only")
- Test: the checks in Step 6

**Interfaces:**
- Consumes:
  - Every name in the Contracts.
  - The behaviour landed by Tasks 1–18 (each command and default is checked against it in Step 6).
- Produces: documentation only.

- [ ] **Step 1: Add the Fleet context to `docs/domain.md`**

Insert this section after the Catch-up section (after its paragraph "Events: none in the audit. Last caught up is a preference…") and before `## Candidate: Record context (ADR-0002 after the name)`:

````markdown
## Fleet: where the workers run

Added 2026-10-06 by [ADR-0012](adr/0012-fleet-pull-agents-and-a-separate-fleet-service.md); design in [`design/fleet-core/README.md`](design/fleet-core/README.md). The workers run on one machine or several. Each machine that hosts them is a Node. The Fleet, on the control plane, knows the nodes, routes typed operations to them and delivers what their hooks report. Like Observation, it grants nothing (O4): it carries Commands and Decisions to a pane and decides none.

| Term | Means | Is not |
|---|---|---|
| Node | A machine that hosts workers, known to the Fleet by a name and a public key. Its agent dials the Fleet, never the reverse, and acts on that machine only. | A login to the machine; an isolation boundary (the workers run as the same user as its agent). |
| Fleet | The control plane's service that knows the nodes, routes operations to them, keeps the Lane registry and runs the Hook bus. Its clients are the hub, the chat bot and the owner's tools. | The hub: a hub deploy or crash never cuts the other clients off from the nodes. |
| Join | A node's one-time admission: it redeems a Join code and pins the Fleet's public key, and the Fleet keeps the node's public key. | Pairing (AC1), which admits an Endpoint of the principal, not a machine. |
| Join code | A one-time secret, valid 10 minutes and bound to one node name, printed with the Fleet's address and public key. The Fleet keeps only its hash. | A password, a reusable invite, or anything the node presents again. |
| Instance | One running agent process of a node, named by a random id per process. | The node: a node has at most one live Instance. |
| Worker ID | `<node>.<server>.<pane>`: one pane of one run of a node's terminal multiplexer server. Opaque outside its node. | The multiplexer's pane number, which a restarted server hands out again. |
| Expectation | What a caller saw of a pane when it decided to act on it: its server, window and session. The node checks it immediately before acting. | A lock or a lease. |
| Operation key | The caller's name for one side-effecting operation, the same for every retry of it, namespaced by client. | The id of one attempt; a Mandate. |
| Lane | A worker as the principal names it: its window's name, unique across the Fleet. | The pane or the session behind it. |
| Lane registry | The Fleet's record of which node each lane name belongs to, and of the names in conflict. | Where the workers run: each node reports that itself. |
| Store | A node's own database of Operation keys and its Hook stream, named by the stream's id. A new or restored database is a new Store. | The node: a node that loses its database keeps its name and key. |
| Hook stream | One node's durable, ordered hook events: a stream id made with the node's store, and sequence numbers from 1. | The feed (O1), which is one hub run's view. |
| Hook bus | The Fleet's delivery of hook events to its configured subscribers: at least once, in order per stream, each event with an idempotency key. | Exactly once: subscribers deduplicate. |
| Alert | Something for the owner to look at that changes no state: a second Instance, a node's network source changed, a clock offset, a node over its message rate, a lane name in conflict, a dead letter, a full backlog. | An Escalation: nothing waits on his answer. |

Aggregates **Node** (its key, Instance and status: online, stale, offline or revoked), **JoinCode**, **LaneName** and **HookStream** (with what each subscriber has had delivered).

| # | Invariant |
|---|---|
| FL1 | A node is admitted only by redeeming a Join code that is unexpired (at most 10 minutes old), unused and bound to that node's name. A code admits one node, once, under its own name. |
| FL2 | Every connection proves both ends before any operation. The node signs the Fleet's fresh challenge with its key, and the Fleet signs the node's fresh challenge with the key the node pinned at its Join. A mismatch on either side ends the connection. |
| FL3 | A node has at most one live Instance. Another Instance with the same key is admitted only if the live one fails to answer a ping within 3 seconds (then the live one's connection is closed): a crashed or half-open Instance can't lock its node out. Otherwise it is refused, with one Alert per refused Instance while the live one lasts, and it tries again every 5 minutes. The same Instance reconnecting replaces its own old connection. |
| FL4 | A revoked node is cut off at once and never connects again. Its lanes are never listed and nothing is routed to it. Joining again takes a new Join code. |
| FL5 | A Worker ID names one pane of one server run and is never given to another pane. A restarted server is stamped anew, so its old Worker IDs answer `no_pane`. |
| FL6 | A side-effecting pane operation acts only while its Expectation holds, checked inside that pane's queue immediately before acting. Otherwise it is refused as `no_pane`, not executed. |
| FL7 | A keyed operation takes effect at most once per Operation key within 7 days. The node records the key as started, durably, before the side effect, and as done, with its outcome, after it. A repeat answers with the outcome (done) or with uncertain (started, never finished); a repeat whose effect-deciding arguments differ from the key's is uncertain too. A refusal before any side effect releases the key, so a retry may act. Every answer names the node's Store (where its keys live): a node that answers "unknown" from another Store than the one that took the operation can't vouch for it, and the operation stays in doubt. |
| FL8 | Every refusal says whether anything ran: `no` (safe to retry) or `maybe`. Only `uncertain` and `internal` are `maybe`. |
| FL9 | A lane name belongs to the node that registered it first. A name reported twice, by two nodes or by two windows, routes nowhere by name until the owner resolves it (`lane_conflict`, not executed), and raises an Alert; every window stays listed, and an operation on a Worker ID still reaches the pane the principal picked. Starting a lane under a registered name, or one whose start is under way, is refused (`name_taken`). |
| FL10 | A hook event is acknowledged to its sender only once it is durable on the node, and the node is acknowledged only once the event is in the Fleet's outbox. Within a stream, sequence numbers grow by one, and a new stream never collides with an old one. |
| FL11 | Each subscriber gets each event at least once, in order per stream, under the key `<node>:<stream>:<seq>`, and deduplicates on it. An event a subscriber refuses (a 4xx other than 408 and 429), or one that fails 20 times, goes to dead letters with an Alert. |
| FL12 | A node that drops off is shown offline with its workers, never as gone. Operations to it are refused as not executed (`node_offline`). One node's slowness never delays another node's operations or observations. When the Fleet itself can't be reached, every worker is shown not online and the hub says the Fleet is unavailable. |
| FL13 | Correctness never depends on the clocks agreeing: the time a Command was typed is the node's own, on the clock its transcripts use. An offset of more than 2 seconds raises an Alert. |
| FL14 | The Fleet runs typed operations only, never a command line, and no credential of an agent CLI crosses it. A node's own policy may refuse any operation (`denied`). |

Events (the Fleet's audit): JoinCodeIssued, NodeJoined, NodeConnected, NodeStale, NodeOffline, NodeRevoked, InstanceRefused, InstanceReplaced (a live Instance that missed the instance check), LaneRegistered, LaneConflicted, OperationRun (every side-effecting operation: which client asked, its target, its key's namespace and its outcome, never its text), HookDeadLettered, AlertRaised. The audit, Alerts included, is kept 90 days. Hook events themselves are not audited. They are kept until delivered, plus 24 hours.

Relations: the Fleet supplies Observation and Steering (see the context map). Access, Authority, Escalation and Verification stay on the hub. The Fleet never sees an Endpoint or a Mandate, nor what a Decision means.
````

In `## Context map`, under **Between contexts**, add as the last bullet:

```markdown
- *Fleet supplies Observation and Steering* (customer and supplier). Observation reads workers, screens and transcripts through it. A Command (S5) and the delivery of a Decision (E8) reach a pane as keyed operations, so neither is typed twice across a dropped connection (FL7). The Hook bus feeds the chat bot, a subscriber, which turns hook events into Escalations through its own adapter.
```

In the **Anti-corruption layers** table, add these two rows after the row `Agent CLI hooks (Claude Code)`:

```markdown
| Node agent over tmux and Claude Code's files (`morndo-node`) | panes, windows and the tmux server's stamp to Workers with Worker IDs; Claude Code's session files and transcripts to bytes by session id; a typed operation to tmux commands under the node's policy |
| Hook relay (`morndo-node`, `127.0.0.1:8787`) | a Claude Code HTTP hook to an event of the node's Hook stream, answered only once it is durable (a script path answers 503 when it can't be) |
```

- [ ] **Step 2: Write `apps/node-agent/README.md`**

````markdown
# Morndo node agent (`morndo-node`)

One per machine that hosts lanes ([ADR-0012](../../docs/adr/0012-fleet-pull-agents-and-a-separate-fleet-service.md); design: [`docs/design/fleet-core`](../../docs/design/fleet-core/README.md)). It keeps one authenticated WebSocket to the fleet service, dialed from here, so the machine needs no inbound port. Over it, the agent runs typed operations on this machine's own tmux server and `~/.claude`: inventory, captures, frames, keys and sends, transcripts, files, lanes and worktrees. It also serves the hook relay on `127.0.0.1:8787`, so `~/.claude/settings.json` can be the same on every machine.

Installing it as a user service is sub-project 3. Until then it runs by hand, and nothing in this sub-project is installed on a live system.

## Run it

Needs Node 24 (`>=24.12`; the services run on `~/.nvm/versions/node/v24.21.0/bin/node --no-warnings`) and tmux 3.4 or newer.

```sh
# 1. On the control plane: a join string for this machine's name, single use, valid 10 minutes
node --no-warnings apps/fleet/src/main.ts node add pc
# 2. Here: make this node's key, pin the fleet's key, and join (quotes, spaces and a trailing newline are fine)
node --no-warnings apps/node-agent/src/main.ts join 'morndo-join:1:…'
# 3. Here: connect, and keep connecting (backoff from 1 s up to 60 s, with full jitter)
node --no-warnings apps/node-agent/src/main.ts run
# What it is doing: connection, protocol, stream, spool depth
node --no-warnings apps/node-agent/src/main.ts status
```

A truncated join string is refused with a clear error, and nothing is written. So is one whose fleet URL is plain `ws://` to anything but this machine (`127.x.x.x`, `localhost`, `[::1]`): over the network the agent speaks only `wss://` (TLS through Tailscale Serve). It refuses such a URL in `config.json` too, and checks it again at every connect.

How it reacts to the fleet's closes:

| Close | What the agent does |
|---|---|
| 4401 (bad proof), 4403 (revoked or unknown) | stops dialing; `status` says why |
| 4409 (another instance of this node is live) | keeps `status: conflict` (`conflict: another agent with this node's key is connected (4409). This one tries again every 5 minutes…`) and tries again every 5 minutes (±20 %), so it takes over once the other instance is gone; the fleet admits it at once if the other one stops answering pings |
| 4426 (unsupported protocol) | keeps its lanes running, tries again hourly |
| anything else (1013 too many handshakes from this address included) | backs off from 1 s up to 60 s, with full jitter |

It also drops a fleet connection that sent no ping for 35 s (the fleet pings every 15 s).

## Files

Every path below derives from `HOME`. A test or QA agent with a temporary `HOME` shares nothing with the machine's own.

| Path | What |
|---|---|
| `~/.config/morndo-node/config.json` | Who this node is and which fleet it trusts (below). `join` writes it, mode 0600; `relayPort` may be edited before `run`. |
| `~/.config/morndo-node/policy.json` | What the fleet may do here (below). `join` writes the defaults when there is none; the owner edits it. A field that doesn't fit stops `run` with an error naming the file and the field. |
| `~/.config/morndo-node/node-key.pem` | This node's Ed25519 private key (PKCS#8), mode 0600. A device credential, not an isolation boundary: lanes run as the same user and can read it (see the security model). |
| `~/.local/state/morndo-node/agent.db` | Done keys and the hook stream (the spool). SQLite in WAL mode with `synchronous=FULL`, so a committed key or event survives a power loss. Numbered migrations; a database from a newer agent is refused. Its stream id names this node's **store**: every answer carries it. A new database is a new store; so is a restored one, which the agent notices when the fleet has acknowledged more of its stream than the database holds, and then starts a new stream (once per process; never under the `fixedStreamId` test hook). |
| `~/.local/state/morndo-node/relay-files/` | Copies of the files hooks sent to `/file`, deleted 24 h after the fleet acknowledged them. The spool, these copies and the inbox share one disk budget of 256 MiB; a `/file` that doesn't fit is answered 503 (so the hook script's fallback runs). |
| `~/.local/state/morndo-node/inbox/` | Images the hub put here for a lane (`file.put`); a partial upload is deleted after 10 minutes. A chunk that doesn't fit the shared budget is refused `too_large`, nothing written. |
| `~/.local/state/morndo-node/status.json` | What the running agent reports, for `morndo-node status`. |

## Config

| Field | Default | Meaning |
|---|---|---|
| `node` | from the join code | This node's name, `[a-z0-9-]{1,32}`. |
| `fleetUrl` | from the join string | Where the agent dials: `ws://127.0.0.1:8791/agent` on the control plane, the fleet's `wss://` tailnet address elsewhere (sub-project 3). Plain `ws://` only to a loopback host; the agent refuses any other. |
| `fleetKey` | from the join string | The fleet's public key (SPKI DER, base64), pinned. A fleet that can't sign with it is refused. |
| `keyPath` | `~/.config/morndo-node/node-key.pem` | This node's private key. |
| `dbPath` | `~/.local/state/morndo-node/agent.db` | The agent's database. |
| `relayPort` | `8787` | The hook relay, on 127.0.0.1 only. A test agent beside a live one takes another port (the QA uses 18787). |

`HOME` itself is where `~/.claude` is read and the root of the file rules.

### Policy (`policy.json`)

| Field | Default | Meaning |
|---|---|---|
| `ops` | every operation | The operations this node runs; anything else is refused as `denied` (not executed). Leave out `pane.keys` to stop raw keystrokes, which is the hub's Terminal control. Text sent with `pane.send` can still run commands in a Claude Code pane (`!` mode); see the security model. |
| `session` | `main` | The only tmux session reported. Only its windows with one pane are lanes. |
| `repoRoots` | none | Where `worktree.list` and `worktree.add` may work. |
| `fileRoots` | today's rules only | If set, `file.*` is also limited to these directories. |
| `lockedPanes` | none | Window name → a lock file that the box's other typists take (`flock`); a send into that window waits for it. On the control plane: `{ "manager": "/home/owner/.local/share/kira/manager-pane.lock" }`. |
| `tmuxSocket` | `null` (the default server) | `tmux -L <name>`. A test or QA agent always names its own. |

## Operations

The full table is in the design, section 5.3. What a caller relies on:

- **Arguments.** Each op's arguments are decoded with the protocol's own schema (`OP_ARGS`, the one the fleet checked; a field it doesn't know is dropped, never passed on), then judged by what only this node can: paths against its policy's roots, a branch name by `git check-ref-format --branch` (`/` allowed), an account and a resume id once more before `claude-as`, a `file.put` name with no `/`. Anything that fails is `bad_args`, not executed. A key on an op that takes none is `bad_args`, as is a keyed op without one.
- **Expectations.** Every side-effecting pane op carries an expectation: `{ server, window, sessionId? }`. It is checked inside that pane's queue immediately before acting, and a mismatch is `no_pane`, not executed. A restarted tmux server gets a new stamp (`@morndo-server`), so its old worker IDs answer `no_pane`.
- **Keys, in two phases.** `pane.send`, `file.put`, `lane.start`, `lane.stop` and `worktree.add` take a key:
  - before the side effect, `key → started` is committed, with a hash of what decides the effect (the op and, for `pane.send`, the worker ID and text; never the expectation or the timeout);
  - after it, `key → done` with its outcome;
  - a refusal with `executed: "no"` deletes the key, so a retry may act;
  - a repeat returns the stored outcome (done) or `uncertain` (started); a repeat with a different hash is `uncertain` too (`executed: "maybe"`);
  - `op.status { key }` answers `unknown`, `started` or `done`, and, like every answer, names this node's store;
  - keys are kept 7 days.
- **Deadlines.** A request's deadline runs on a monotonic clock (`timeoutMs` − 250 ms). If the side effect hasn't started by then, the answer is `timeout`, not executed. A pane lock that is free only after the deadline never types.
- **tmux.** Every call passes `-u`; a session is named `=name`; every argument tmux reads as a format and that carries outside data (a window name, a lane's directory) has its `#` doubled (`tmuxLiteral`), so a directory named `#{session_name}` or `#(…)` is taken as it is; panes and windows are targeted by their IDs, never by name.
- **Limits.** Messages are at most 512 KiB; bulk data moves in chunks of at most 256 KiB; files are at most 25 MiB; sends at most 8000 characters; keys at most 4096; `captureMany` at most 64 panes, each capped at 6 KiB with `truncated: true`.

## Hook relay (`127.0.0.1:8787`)

It answers after the event is in the durable stream, and before any network I/O.

| Path | Answer | Kept | When the spool can't be written |
|---|---|---|---|
| `/cc`, `/sl` | 204, empty | the latest per session | still 204 (a session never stalls); counted in `health.drops` |
| `/hook/stop` | 200 `{ ok: true, queued: true }` | every event | 503, so the hook script's fallback runs |
| `/hook/failure`, `/notify` | 202 | every event | 503 |
| `/file` | 202 (413 over 25 MiB) | a copy under `relay-files/`, by today's file rules | 503 |

Each event gets this node's name and the window it finds through `TMUX_PANE` or `session_id`, then flows in order to the fleet (`streamId`, `seq`) and is replayed after a reconnect, before anything new. A spool write that fails while the fleet acknowledges events (a full disk) is logged; it never takes the agent down. Hook entries in `settings.json` get `"timeout": 5` (sub-project 3): an HTTP hook failure doesn't block Claude Code, but a slow hook stalls the session.

## Security model

What it protects:
- The agent dials out; there is no inbound port.
- Both ends prove themselves on every connection: this node signs the fleet's challenge, and the fleet signs this node's with the key pinned at join.
- Operations are typed. There is no generic exec, `lane.start` takes typed fields and never free flags, and file and worktree paths are confined here with today's rules: symlinks resolved, deny roots, secret file names, 25 MiB. The deny roots include the state of every Morndo service and of kira (`~/.local/share/morndo*`, `~/.local/state/morndo*`, `~/.config/morndo*`, `~/.local/share/kira`, `~/.config/kira`: the hub's `morndo.db`, the fleet's `fleet.db` and key, this agent's own key and database), and every `.credentials.json` is a secret name (`~/.claude/`, each `~/.claude-accounts/<name>/`). A file is opened without following a link in its last place (`O_NOFOLLOW`), so one swapped in after the check is refused.
- No Claude Code credential or token ever crosses the wire: each node logs in to its own accounts.
- Logs go through the redacting logger; typed text, hook bodies, keys and codes are never logged.

What it doesn't protect:
- **A compromised control plane can do about what SSH could.** Text typed into a Claude Code pane can run commands. Mitigations: leave out `pane.keys`, and the fleet's audit records who did what.
- **The node key is readable by same-user lanes.** A lane that steals it could pose as this node from elsewhere on the tailnet. Mitigations: the fleet alerts when a node's source address changes, and `morndo-fleet node revoke` cuts it off.

## Test hooks (never in production)

`MORNDO_NODE_TEST_HOOKS` (JSON) turns on fault injection for the fleet's drills (`test/fleet`) and the QA runbook's drop drill. `run` refuses to start with it (exit 78, naming why) unless `NODE_ENV=test` and `HOME` is not the account's own home directory (read from the password database, not from `$HOME`), so an installed agent can't run with it. With it, `run` logs a warning naming each active hook. No unit file or install script sets it.

| Hook | Effect |
|---|---|
| `dropAfterStarted: "<substring>"` | For a keyed op whose key contains it: right after `started` is committed, the socket is terminated and that op's result discarded; the op runs on. Once per key. |
| `noDoneKeys: true` | Keys are neither recorded nor consulted (negative control) |
| `noExpect: true` | Worker IDs resolve by pane number alone; expectations are not checked (negative control) |
| `clockOffsetMs: <n>` | Every wall-clock time this agent reports is shifted by n ms |
| `spoolFail: true` | Every spool write fails, the deletion of acknowledged events included |
| `fixedStreamId: "<uuid>"` | This stream id instead of the database's own, and so this store in every answer; kept even where a restored database would start a new stream (negative control) |

## Checks

```sh
npx vitest run --project units apps/node-agent     # the agent's own tests
npx vitest run --project fleet                     # real fleet + real agents (+ the hub), isolated tmux servers
```

## Sources (checked 2026-10-06; re-check when upgrading)

- Node.js 24: `crypto` (Ed25519 `generateKeyPairSync('ed25519')`, `sign(null, …)`, `verify(null, …)`) https://nodejs.org/docs/latest-v24.x/api/crypto.html; `net`, Unix socket path lengths https://nodejs.org/docs/latest-v24.x/api/net.html#identifying-paths-for-ipc-connections; `util.parseArgs` https://nodejs.org/docs/latest-v24.x/api/util.html#utilparseargsconfig
- `ws` 8: ping/pong liveness and `terminate()` (README, "How to detect and close broken connections?"), `maxPayload` and client options (doc/ws.md). https://github.com/websockets/ws
- SQLite: `PRAGMA synchronous=FULL` in WAL mode is durable across a power loss; `NORMAL` may roll back the last transactions. https://www.sqlite.org/pragma.html#pragma_synchronous, https://www.sqlite.org/wal.html
- better-sqlite3: https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md
- tmux(1), 3.4: `-L`, user options (`@…`), `show-options -gqv`, `capture-pane`, `send-keys -H/-l`, `paste-buffer -p`; formats (`#{…}`, `#(…)`, `##` for a literal `#`) in `new-window -n/-c` and `rename-window`. https://man7.org/linux/man-pages/man1/tmux.1.html
- git-check-ref-format(1), `--branch`: https://git-scm.com/docs/git-check-ref-format
- open(2), `O_NOFOLLOW`: https://man7.org/linux/man-pages/man2/open.2.html; Node.js `fs.constants`: https://nodejs.org/docs/latest-v24.x/api/fs.html#file-open-constants
- Claude Code hooks: HTTP hook failures are non-blocking, the default timeout is 600 s, the per-hook `timeout` is in seconds, and the common input fields include `session_id`. https://code.claude.com/docs/en/hooks
````

- [ ] **Step 3: Write `apps/fleet/README.md`**

````markdown
# Morndo fleet service (`morndo-fleet`)

The control plane's service ([ADR-0012](../../docs/adr/0012-fleet-pull-agents-and-a-separate-fleet-service.md); design: [`docs/design/fleet-core`](../../docs/design/fleet-core/README.md)). Every node's agent dials it. It knows the nodes and their keys, routes typed operations to them, keeps the lane registry, and delivers hook events to subscribers. The hub, kira and the `lanes` CLI are its clients, over a versioned API on a Unix socket. It is separate from the hub, so a hub deploy or crash never cuts the other clients off from the lanes.

## Run it

Needs Node 24 (`>=24.12`).

```sh
node --no-warnings apps/fleet/src/main.ts serve              # the agent endpoint and the client API
node --no-warnings apps/fleet/src/main.ts node add <name>    # a join string: single use, 10 minutes, bound to <name>
node --no-warnings apps/fleet/src/main.ts node list          # nodes, status, last seen
node --no-warnings apps/fleet/src/main.ts node revoke <name> # cut it off now and for good
node --no-warnings apps/fleet/src/main.ts status             # nodes; per subscriber, its outbox depth and its dead letters
```

`status` prints each node and its status, then one line per subscriber: `<name>  <n> waiting  <n> dead letters (latest <time>: <reason>)`, where `waiting` is its outbox (events not yet delivered).

`node add`, `node list` and `node revoke` open fleet.db themselves and tell the running service through its client socket (a revoke closes the node's connection at once, 4403). Any process of the owner's user can run them (accepted; they are audited). The hub uses the fleet when `MORNDO_FLEET_SOCKET` names its socket (`apps/hub/README.md`).

## Files

Every path derives from `HOME`.

| Path | What |
|---|---|
| `~/.config/morndo-fleet/config.json` | The config (below), or the file `MORNDO_FLEET_CONFIG` names; a missing field takes its default. |
| `~/.local/share/morndo-fleet/fleet.db` | Nodes, public keys, join-code hashes, accepted `seq` per `(node, streamId)`, lane names, outbox, dead letters, alerts, audit (kept 90 days, alerts included). Numbered migrations; a database from a newer fleet is refused. |
| the config's `keyPath` | The fleet's Ed25519 private key. Its public half goes into every join string, and every agent pins it. |
| `~/.local/state/morndo-fleet/fleet.sock` | The client API. The fleet refuses to start unless the socket's directory belongs to its user and has mode 0700. |

## Config

| Field | Default | Meaning |
|---|---|---|
| `listen` | `{ "host": "127.0.0.1", "port": 8791 }` | The agent endpoint, `/agent`. The host must be loopback (`127.x.x.x`, `localhost` or `::1`): over the tailnet the endpoint is reached through Tailscale Serve, which terminates TLS in front of it (sub-project 3), so it is never plain on the network. |
| `socketPath` | `~/.local/state/morndo-fleet/fleet.sock` | The client API. Its path must fit a Unix socket address: 107 bytes on Linux, 103 on macOS. |
| `dbPath` | `~/.local/share/morndo-fleet/fleet.db` | |
| `keyPath` | `~/.local/share/morndo-fleet/fleet-key.pem` | Made on first use, mode 0600. |
| `publicUrl` | `ws://127.0.0.1:8791/agent` | What join strings tell agents to dial: `wss://…`, or `ws://` to a loopback host only. Anything else is refused at start. |
| `subscribers` | `[]` | `[{ "name", "url", "paths": ["/hook/stop", …] }]`: who gets which hook events. |

## Agent endpoint

Once per node, the join: the agent sends `join { node, code, publicKey, agent, proto }`; the fleet checks the code (unexpired, unused, issued for that node), keeps the public key, answers `welcome` and closes. A refused code is 4403.

Each connection after that goes through four messages. Every message is JSON, `{ v: 1, t, … }`, checked with zod/mini; an unknown `t` is answered with an error, never ignored.
1. The agent sends `hello { node, instanceId, streamId, proto, agent, claude, caps, clientNonce }`.
2. The fleet sends `challenge { nonce, fleetSig }`. `fleetSig` signs the agent's nonce with the fleet's key.
3. The agent sends `proof { sig }`, signing the fleet's nonce.
4. The fleet sends `welcome { connEpoch, ackSeq, streamKnown }`, where `ackSeq` and `streamKnown` are for the hello's `streamId`.

| Close | Why | What the agent does |
|---|---|---|
| 4401 | bad proof | stays off: join again with a new code |
| 4403 | revoked, unknown, or a refused join code | stays off |
| 4409 | another instance of this node is live: it answered the instance check's ping (an alert is raised once per refused instance) | keeps `status: conflict`, tries again every 5 minutes |
| 4426 | unsupported protocol (the current and the previous version are accepted) | keeps its lanes, retries hourly |
| 1013 | too many joins and hellos from that source address (10 at once, one more every 6 s), counted before any key work | backs off as after any drop |
| 1009 | a message over 1 MiB | backs off as after any drop |

Instances: a hello with another instance ID than the live connection's makes the fleet ping the live connection and wait 3 s, without holding up any other node. No pong: the old connection is closed and the newcomer admitted, so a crashed or half-open agent can't lock its node out. A pong: the newcomer is refused with 4409.

Liveness: the fleet pings every 15 s and terminates a connection that missed a pong. A node is `online` after a welcome, `stale` from a missed pong, and `offline` once closed. Messages are at most 512 KiB (`maxPayload` 1 MiB), and control messages go before bulk chunks. Bulk ops (transcript reads, file reads) run one at a time per node with at most 8 waiting; one more is `busy`, not executed, and an op's timeout counts from when it was queued.

## Client API (`/v1/`, on the socket)

| Route | What |
|---|---|
| `GET /v1/caps` | `{ api: [1] }` |
| `GET /v1/nodes` | `{ name, status, health, agent }[]` |
| `GET /v1/lanes` | `{ name, node, workerId, conflict }[]` |
| `GET /v1/lanes/<name>` | one lane (`conflict: true` while two windows claim it; `workerId: null` when two windows on its owner do), or 404 `{ error: "no_such_lane" }` |
| `GET /v1/alerts` | oldest first, `{ id, at, node, kind, detail }` (kinds below): the latest 500 security alerts (`instance_conflict`, `source_changed`, `clock_offset`) and the latest 500 others, so other alerts never push a security one out |
| `POST /v1/nodes/<name>/revoke` | `{ ok: true, revoked }`; closes the node's connection (4403) and drops its lanes, as `node revoke` does |
| `POST /v1/op` | `{ node? \| workerId? \| lane?, op, args, key?, timeoutMs? }`, with `expect` inside `args`. Sent to the node, which answers `{ ok: true, result, invVersion, store }` or `{ ok: false, error: { code, executed, message }, store }`. `store` names the node's database the answer came from (a caller that sees it change knows the node's keys may be gone); it is `null` when nothing was sent: `node_offline` (not executed) when the node isn't online, `lane_conflict` when two windows claim the lane named, `name_taken` for a `lane.start` of a name registered or being started, `busy` when 8 bulk ops already wait. Every side-effecting op is audited (`op.<name>`: the target, the key's namespace, the outcome and the client from the `x-morndo-client` header; never the text, keys typed or file bytes). |
| `GET /v1/files/<node>/<ref\|path>` | a file, chunked; a refusal before the first byte is `{ ok: false, error }` (403 denied, 413 too large, 503 node offline, …) |
| `WS /v1/events` | `status`, `inventory`, `health`, `conflict`, `alert`, the current state first. A client more than 8 MiB of events behind is closed with 1013; on reconnecting it gets the current state first. |

From a shell: `curl --unix-socket ~/.local/state/morndo-fleet/fleet.sock http://fleet/v1/nodes`.

## Lane registry

A name belongs to the node that reported it first. Two nodes, or two windows on one node, with the same name stop routing by that name (`lane_conflict`, not executed), and the conflict shows until the owner renames one; each window stays listed, and an op by worker ID still reaches its pane. `lane.start` refuses a name registered anywhere in the fleet, or one whose `lane.start` is still under way (`name_taken`): the name is reserved from the request until the registry holds it, at most 10 s after the node's answer, and at once released when the start was refused before anything ran (`executed: "no"`). A revoked node's lanes are dropped.

## Hook bus

- An event is in the outbox before the agent is acknowledged.
- Each subscriber gets it at least once, in order per `(node, streamId)`, as `POST <url>` with `Idempotency-Key: <node>:<streamId>:<seq>` and the `HookEvent` as the JSON body. It must deduplicate on that key.
- Backoff is exponential. A 4xx other than 408 and 429, or 20 failed attempts, sends the event to dead letters with an alert; 408, 429 and 5xx are retried.
- Each subscriber's backlog is capped at 50,000 events; coalesced events (`/cc`, `/sl`) are dropped first, then an alert is raised.
- Rows are deleted 24 h after delivery, and a subscriber removed from the config loses its rows.

## Alerts

Alerts are audit rows, kept 90 days like the rest of the audit (old rows go when the service starts, and daily). The three security kinds (`instance_conflict`, `source_changed`, `clock_offset`) are capped apart from the others: `GET /v1/alerts` keeps the latest 500 of each.

The audit also holds `op.<name>` for every side-effecting op (actor `client`; `{ target, keyNs, outcome, client }`), `conn.admitted`, `conn.refused` (with its reason and source address) and `conn.replaced` (a live instance closed because it missed the instance check), besides joins and revocations.

| Kind | When |
|---|---|
| `instance_conflict` | A second instance of a node was refused (4409) because the live one answered the instance check. One alert per refused instance for as long as the live connection lasts; its retries every 5 minutes raise none. |
| `clock_offset` | A node's health clock is more than 2 s off, after allowing for the round trip. Correctness doesn't depend on it, since echo matching uses the node's own `typedAt`. |
| `dead_letter` | A subscriber refused an event, or the event failed 20 times. Once per episode: the first dead letter after a delivery to that subscriber succeeded (or since start); later ones count into it until a delivery succeeds again. |
| `backlog_full` | A subscriber's backlog reached 50,000 events. |
| `source_changed` | A node's tailnet source address changed: possibly a stolen node key. |
| `rate_limited` | A node sent more than its rate allows (hook events are exempt); its connection was closed. |
| `lane_conflict` | A lane name got a second claimant. |

## Security model

- The agent endpoint is reachable only on localhost or the tailnet (TLS through Serve): it listens on loopback only, and plain `ws://` is accepted only to loopback, on both ends. The client API is only a 0700 Unix socket with an owner check.
- Joins and hellos are counted per source address before any signature is checked, so a flood can't make the fleet do key work (1013 over 10 at once, one more every 6 s). It is only logged: no audit row and no alert, since an unauthenticated address names no node and must not be able to fill either.
- Join codes are single use, expire after 10 minutes, and are bound to a name; the fleet keeps only their SHA-256 hash, compared in constant time. The fleet stores no reusable secret of a node: only its public key. Tailscale identity headers are not used, because Serve omits them for tagged devices.
- What it doesn't protect: a compromised control plane can act on every node about as well as SSH would, since text sent into a Claude Code pane can run commands. The node policy, the audit and `node revoke` are the mitigations (design, section 8).

## Checks

```sh
npx vitest run --project units apps/fleet          # the fleet's own tests
npx vitest run --project fleet                     # real fleet + real agents (+ the hub), isolated tmux servers
node e2e/fleet-two-node.e2e.ts                     # after npm run build: two nodes, the hub in fleet mode
```

## Sources (checked 2026-10-06; re-check when upgrading)

- `ws` 8: `noServer` with authentication in `upgrade`, ping/pong with `terminate()`, `maxPayload`, `ws+unix:` client URLs. https://github.com/websockets/ws (README.md, doc/ws.md)
- Node.js 24: `crypto` (Ed25519 sign and verify, `timingSafeEqual`) https://nodejs.org/docs/latest-v24.x/api/crypto.html; `http` over a Unix socket (`server.listen(path)`) https://nodejs.org/docs/latest-v24.x/api/http.html; Unix socket path lengths https://nodejs.org/docs/latest-v24.x/api/net.html#identifying-paths-for-ipc-connections
- SQLite WAL and `synchronous`: https://www.sqlite.org/wal.html, https://www.sqlite.org/pragma.html#pragma_synchronous
- Tailscale Serve: identity headers are not set for tagged devices. https://tailscale.com/kb/1312/serve
- Fencing tokens (the lane leases of a later sub-project): https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html
````

- [ ] **Step 4: Bring `apps/hub/README.md` up to date (only what Task 14 didn't add)**

In the Settings table, after the row `MORNDO_CLAUDE_DIR`, add this row if it isn't there:

```markdown
| `MORNDO_FLEET_SOCKET` | unset | The fleet service's client socket (`apps/fleet`). When set, the hub reaches every node's tmux and transcripts through the fleet, and `MORNDO_TMUX_SOCKET`, `MORNDO_TMUX_SESSION` and `MORNDO_CLAUDE_DIR` don't apply; there is no desktop view (whatever `MORNDO_VNC` says), and when the fleet can't be reached every worker shows as not online, under a "Fleet unavailable" banner. When unset, it uses this machine's tmux and `~/.claude` as before (design, section 10). |
```

In the Checks block, add these two lines after `npm run e2e`:

```sh
npx vitest run --project fleet     # the fleet's drills: real fleet, agents and hub, isolated tmux servers (about 5 min)
node e2e/fleet-two-node.e2e.ts     # two nodes, one fleet, the hub in fleet mode (after npm run build)
```

- [ ] **Step 5: Correct the root `README.md` where it is now wrong**

Replace

```markdown
Future home: github.com/morndo (the owner's org). This repo stays local, with no remote, until the owner approves pushing it there.

This repo holds documents only so far; the first build step awaits the owner's OK. "The product" in older text means Morndo.
```

with

```markdown
Home: github.com/morndo/morndo, a private repository in the owner's org; changes land through pull requests. "The product" in older text means Morndo.
```

After the section `## Web endpoint (increment 1, read-only)` and its paragraph, add:

```markdown
## Fleet (ADR-0012)

One Morndo on one machine or across several:
- `apps/fleet` (`morndo-fleet`): the control plane's fleet service;
- `apps/node-agent` (`morndo-node`): one per machine that hosts lanes;
- `packages/node-ops`: the machine-local code;
- `packages/protocol`: the wire format and worker IDs.

The hub uses them when `MORNDO_FLEET_SOCKET` is set. The design is [`docs/design/fleet-core/README.md`](docs/design/fleet-core/README.md) and [ADR-0012](docs/adr/0012-fleet-pull-agents-and-a-separate-fleet-service.md). How to run them: [`apps/fleet/README.md`](apps/fleet/README.md), [`apps/node-agent/README.md`](apps/node-agent/README.md).
```

In `## Rules for this repo`, replace the line `- Local only: no remote until the owner approves one.` with:

```markdown
- The repository lives in the owner's org (github.com/morndo/morndo, private); nothing is published elsewhere.
```

Leave every other line as it is: this task corrects only what is now wrong, and only about this.

- [ ] **Step 6: Check the docs against the code and the sources**

Run (each default named in the READMEs exists in the code):

```sh
for s in 8787 8791 'fleet.sock' 'agent.db' 'fleet.db' 'morndo-join:1:' '@morndo-server' 'MORNDO_NODE_TEST_HOOKS' 'dropAfterStarted' 'instance_conflict' 'Idempotency-Key' \
  'instancePongMs' 'conflictRetryMs' 'agentPingTimeoutMs' 'auditKeepMs' 'handshakeBurst' 'bulkQueueMax' 'eventsBufferBytes' 'fleetUrlOk' \
  'tmuxLiteral' 'O_NOFOLLOW' 'check-ref-format' '.local/share/kira' 'x-morndo-client'; do
  r=$(grep -rliF -- "$s" apps/node-agent/src apps/fleet/src packages/protocol/src packages/node-ops/src | head -1); printf '%-24s %s\n' "$s" "${r:-MISSING}"
done
for s in 'SourceUnavailable' 'keys_uncertain' 'no_desktop' 'lane_conflict'; do
  r=$(grep -rliF -- "$s" apps/hub/src apps/web/src | head -1); printf '%-24s %s\n' "$s" "${r:-MISSING}"
done
```

Expected: a file path on every line, and no `MISSING`. Where the code says otherwise, the code wins: correct the README and note the difference in the commit message.

Then read each claim of round 2 against the task that implements it, and keep only what the code does (each README line names behaviour, so one that the code lacks is a bug in one or the other):

| README claim | Implemented in | Checked by |
|---|---|---|
| 4409: `status: conflict`, retry every 5 minutes (±20 %) | Task 7 | its retry test |
| the instance check: a ping, 3 s, then admit or 4409 | Task 11 | its half-open (`autoPong: false`) test |
| ping timeout 35 s | Task 7 (`LIMITS.agentPingTimeoutMs`) | its liveness test |
| `ws://` only to loopback; `listen.host` loopback | Tasks 1, 7, 10 | `fleetUrlOk` and config tests |
| `store` on every answer, `null` before dispatch | Tasks 8, 12 | their store tests |
| key hash covers only what decides the effect; a differing hash is `uncertain` | Task 8 | done-keys test |
| a restored database starts a new stream | Task 9 | its rotation test |
| relay copies and the inbox count toward the spool budget | Task 9 | its budget test |
| the deny roots and `.credentials.json`; `O_NOFOLLOW` | Tasks 2, 8 | file-rules and file-ops tests |
| `tmuxLiteral` for `-c`/`-n`; targets by ID | Tasks 2, 8 | tmux-cli and lane-ops tests |
| audit of every side-effecting op; 90-day retention; security alerts capped apart; `dead_letter` once per episode | Tasks 10–13 | their audit and alert tests |
| 1013 for handshakes over the rate, before key work | Task 11 | its rate test |
| bulk queue: 8 waiting, `busy`; timeout from enqueue | Task 12 | its queue tests |
| events socket closed with 1013 over 8 MiB behind | Task 12 | its backpressure test |
| a name reserved while its `lane.start` runs | Task 12 | its race test |
| `status` shows outbox depth and dead letters | Task 13 | its status test |
| "Fleet unavailable", no desktop in fleet mode, keys "may have been typed" | Tasks 14, 15b | their hub and Chromium tests |

Run (every relative link resolves):

```sh
for f in README.md docs/domain.md apps/hub/README.md apps/node-agent/README.md apps/fleet/README.md; do
  grep -o '](\([^)#]*\))' "$f" | sed 's/^](//; s/)$//' | grep -v '^http' | while read -r l; do [ -e "$(dirname "$f")/$l" ] || echo "$f: broken $l"; done
done; echo checked
```

Expected: `checked` only.

Re-open each URL in the two READMEs' Sources sections, and confirm what each line claims still holds. If a page changed, update the line and its date.

Run: `npm run lint`
Expected: exit 0, no problems reported.

Run: `npm run check`
Expected: exit 0. The docs don't change code; these two guard against stray edits.

- [ ] **Step 7: Commit**

```bash
git add docs/domain.md apps/node-agent/README.md apps/fleet/README.md apps/hub/README.md README.md
git commit -m "docs(fleet): the Fleet context, and how to run the agent and the fleet service"
```

---

### Task 20: The manual QA runbook and its evidence

**Files:**
- Create: `e2e/fleet-qa.ts` (the runbook's helper: nodes, lanes, alerts, a lane's worker ID, a send as a device, screenshots)
- Create: `docs/design/fleet-core/qa.md` (the runbook)
- Modify: `README.md` (the Fleet section links the runbook)
- Create at execution time: `qa/<YYYY-MM-DD>-fleet-core.md` and `qa/img-fleet/*.png` (the evidence record, in the repo's QA convention)
- Test: the helper's smoke run (Step 2) and the runbook itself

**Interfaces:**
- Consumes:
  - `FleetClient` (`nodes`, `lanes`, `alerts`).
  - `pairedPage(browser, { pairUrl })` (Task 18) and `e2e/qa-session.ts`.
  - The test hook `dropAfterStarted` (Tasks 8–9), which the agent accepts only with `NODE_ENV=test` and a `HOME` that isn't the account's own.
  - The agent's `config.json` and `policy.json` (Task 6) and the fleet's `config.json` (Task 10).
  - `test/fixtures/fake-claude-pane.ts`.
  - The CLIs of both services, and the hub's `serve`, `pair` and `audit`.
  - `e2e/qa-session.ts <MORNDO_HOME> --reverify <cookie>`: marks the QA session's passkey as checked now, so a send isn't refused `step_up` (before CP-8, PC-7 and PC-8).
  - The branch under test, `feat/fleet-core` (plan.md, "Branches and worktrees"), and Node 24.21.0 from nvm on both Linux hosts.
- Produces: the runbook and the evidence for spec §12, done criterion 3.

- [ ] **Step 1: Write `e2e/fleet-qa.ts`**

```ts
// QA helpers for the fleet runbook (docs/design/fleet-core/qa.md), on synthetic lanes only:
//   node e2e/fleet-qa.ts nodes  <fleet socket>            one line per node: name, status, agent version
//   node e2e/fleet-qa.ts lanes  <fleet socket>            one line per lane: name, node, worker id, a conflict
//   node e2e/fleet-qa.ts alerts <fleet socket>            one JSON line per alert
//   node e2e/fleet-qa.ts worker <fleet socket> <lane>     the lane's worker id (exit 1 if it has none)
//   node e2e/fleet-qa.ts send <hub port> <cookie> <worker id> <text> [request id]
//        POST /api/workers/<id>/send on 127.0.0.1:<port>, Origin http://localhost:<port>, as the device whose cookie
//        e2e/qa-session.ts printed; prints the status and the body
//   node e2e/fleet-qa.ts shots <pair url> <out dir> <action>...
//        headless Chromium paired through a virtual passkey (e2e/harness.ts pairedPage), then each action in turn:
//        list:<file> | lane:<lane>:<file> | terminal:<lane>:<file> | send:<lane>:<text>:<file>
//        The device revokes itself at the end, so repeated runs stay under the hub's 6 devices (AC2).
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { FleetClient } from "../apps/hub/src/adapters/fleet-client.ts";

const [cmd = "", ...a] = process.argv.slice(2);
const say = (line: string) => process.stdout.write(`${line}\n`);
function usage(): never {
  process.stderr.write("usage: node e2e/fleet-qa.ts nodes|lanes|alerts <socket> | worker <socket> <lane> | send <port> <cookie> <worker id> <text> [request id] | shots <pair url> <dir> <action>...\n");
  process.exit(2);
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

switch (cmd) {
  case "nodes":
    for (const n of await new FleetClient(a[0] ?? usage()).nodes()) say(`${n.name}  ${n.status}  ${n.agent ?? "-"}`);
    break;
  case "lanes":
    for (const l of await new FleetClient(a[0] ?? usage()).lanes()) say(`${l.name}  ${l.node}  ${l.workerId ?? "-"}${l.conflict ? "  CONFLICT" : ""}`);
    break;
  case "alerts":
    for (const x of await new FleetClient(a[0] ?? usage()).alerts()) say(JSON.stringify(x));
    break;
  case "worker": {
    const lane = (await new FleetClient(a[0] ?? usage()).lanes()).find(l => l.name === a[1]);
    if (!lane?.workerId) { process.stderr.write(`no worker for lane ${a[1] ?? ""}\n`); process.exit(1); }
    say(lane.workerId);
    break;
  }
  case "send": {
    const [port = "", cookie = "", id = "", text = "", requestId = randomUUID()] = a;
    if (!port || !cookie || !id || !text) usage();
    const r = await fetch(`http://127.0.0.1:${port}/api/workers/${encodeURIComponent(id)}/send`, {
      method: "POST",
      headers: { origin: `http://localhost:${port}`, "content-type": "application/json", cookie: `__Host-morndo=${cookie}` },
      body: JSON.stringify({ text, requestId, seen: "none" }),
    });
    say(`${r.status} ${await r.text()}`);
    break;
  }
  case "shots": {
    const [pairUrl = "", dir = "", ...actions] = a;
    if (!pairUrl || !dir || !actions.length) usage();
    mkdirSync(dir, { recursive: true });
    const { chromium } = await import("playwright");
    const { pairedPage } = await import("./harness.ts");
    const browser = await chromium.launch();
    try {
      const { page } = await pairedPage(browser, { pairUrl: () => pairUrl });
      const side = page.locator("aside.side");
      for (const action of actions) {
        const [kind = "", ...rest] = action.split(":");
        if (!["list", "lane", "terminal", "send"].includes(kind) || !rest.length) usage();
        const file = join(dir, rest.at(-1) ?? "shot.png");
        const lane = rest[0] ?? "";
        if (kind !== "list") {
          await side.getByRole("button", { name: new RegExp(escape(lane)) }).first().click();
          await page.locator("h1", { hasText: lane }).waitFor();
        }
        if (kind === "terminal") {
          await page.locator(".chan .tabs").getByRole("tab", { name: "Terminal" }).click();
          await page.getByRole("region", { name: `Terminal of #${lane}` }).locator(".xterm-rows").waitFor({ timeout: 15_000 });
        }
        if (kind === "send") {
          await page.locator("#composer").fill(rest.slice(1, -1).join(":"));
          await page.keyboard.press("Enter");
        }
        await page.waitForTimeout(kind === "send" ? 3000 : 1500);
        await page.screenshot({ path: file });
        say(`${action} -> ${file}`);
      }
      const me = await page.evaluate(() => fetch("/api/me").then(r => r.json())) as { endpoint: { id: string } };
      const status = await page.evaluate(id => fetch(`/api/devices/${id}/revoke`, { method: "POST" }).then(r => r.status), me.endpoint.id);
      say(`this QA device revoked itself: ${status}`);
    } finally {
      await browser.close();
    }
    break;
  }
  default:
    usage();
}
process.exit(0);                                         // a FleetClient may still hold its socket
```

- [ ] **Step 2: Smoke-run the helper against a throwaway fleet**

Run:

```sh
node --no-warnings e2e/fleet-qa.ts; echo "exit $?"
node --no-warnings --input-type=module -e '
import { execFileSync } from "node:child_process";
import { fakeLane, joinAgent, startFleet, stopAll, tmuxServer } from "./test/fleet-harness.ts";
const fleet = await startFleet(); const t = tmuxServer(); const a = await joinAgent(fleet, "smoke", { tmux: t });
await fakeLane(t, { window: "scratch" }); await a.run(); await a.waitOnline();
const qa = (...x) => execFileSync(process.execPath, ["--no-warnings", "e2e/fleet-qa.ts", ...x], { encoding: "utf8" }).trim();
console.log(qa("nodes", fleet.socketPath)); console.log(qa("lanes", fleet.socketPath)); console.log(qa("worker", fleet.socketPath, "scratch"));
await stopAll();'
```

Expected: the usage line and `exit 2`; then `smoke  online  <version>`; then `scratch  smoke  smoke.<8 hex>.<n>`; then the bare worker ID `smoke.<8 hex>.<n>`.

- [ ] **Step 3: Write `docs/design/fleet-core/qa.md`**

````markdown
# Fleet core: manual QA runbook

For spec section 12, done criterion 3, and section 9's "Manual QA" row. It checks the fleet on `cp.example`: the fleet service, the hub in fleet mode and a local agent. It adds a **test** agent on the owner's PC. The evidence it produces goes into `qa/<date>-fleet-core.md`, with screenshots in `qa/img-fleet/`.

**Run it** after Tasks 1–19 are merged into the branch under test, with CI green on it. It takes about an hour. Three shells take part, all driven from the Mac:
- the Mac, which drives everything;
- the control plane (`ssh operator@cp.example`);
- WSL on the PC (`ssh devbox`, the owner's alias that lands in WSL).

Every block says where it runs, what to expect, and which evidence file it writes.

## The rules

1. **Nothing here touches the PC's live system.** That means:
   - not the default tmux server, its session `main` or any lane;
   - not kira or its port 8787;
   - not the live hub or `~/.local/share/morndo`;
   - not `~/.claude`, and certainly not `~/.claude/settings.json`.

   The PC's test agent runs with `HOME=~/morndo-qa/home`, so its config, key, database and `.claude` all live there. Its scratch lane is a fake input box (`test/fixtures/fake-claude-pane.ts`), not Claude Code, so no real hook fires into kira.
2. **On the PC, every tmux command goes through `TT`** (`tmux -L morndo-test`), and on the control plane through `TQ` (`tmux -L morndo-qa`). A bare `tmux` in a block is a mistake: stop.
3. **Every PC step needs the owner's go-ahead** (PC-0), and so does the PC cleanup, C-2. The Mac and control-plane steps don't: they use their own directories and ports.
4. **The QA's own ports:**
   - the hub on 18790;
   - the fleet on 18791;
   - the relays on 18787;
   - the Mac's end of the tunnel on 28791.

   Never 8787, 8790 or 8791.
5. **Join strings and cookies are secrets.** They never go into evidence: the blocks redact them.
6. **When an Expect doesn't hold, stop.** Keep everything running, save the output as evidence, and find out why before going on. Clean up only once the evidence is safe.
7. **Every block starts by sourcing its machine's variables file** (section 0): `. /tmp/morndo-qa-vars.sh` on the Mac, `. ~/morndo-qa.vars.sh` on the control plane and the PC. The branch under test is set once, in the Mac's file.
8. **Cleanup removes only what this runbook created** (each path is listed in section 4). It never runs `git worktree prune` in the owner's repositories (it removes its own worktree by its path), never kills a tmux server but `morndo-qa` and `morndo-test`, and never touches the live tmux server `main`, kira or `~/.claude/settings.json`.

## 0. Variables

Each machine has one variables file, and every block below starts by sourcing it (rule 7), so a new shell or a block run on its own has the same values. The branch under test is set once, in the Mac's file (plan.md, "Branches and worktrees": `feat/fleet-core`), and the Mac writes it into the other two. Node is pinned on both Linux hosts: `~/.nvm/versions/node/v24.21.0/bin/node`, never whatever `node` the `PATH` finds.

**V-1 Mac** (zsh):

```sh
cat > /tmp/morndo-qa-vars.sh <<'EOF'
# The fleet QA's variables on the Mac (docs/design/fleet-core/qa.md, section 0). Every Mac block sources this file.
export BRANCH=feat/fleet-core                     # the branch under test, set here and nowhere else
export CP=operator@cp.example PC_WSL=devbox
export EVID=/tmp/morndo-qa-evidence MACREPO=/tmp/morndo-qa-mac
pair() { ssh "$CP" bash -s <<'EOS' | grep -o 'http://localhost:18790/pair#[^ ]*'
. ~/morndo-qa.vars.sh; cd "$REPO"; env "${HUB_ENV[@]}" "$NODE" --no-warnings apps/hub/src/main.ts pair
EOS
}
shots() { (cd "$MACREPO" && node --no-warnings e2e/fleet-qa.ts shots "$(pair)" "$EVID/img" "$@"); }
EOF
. /tmp/morndo-qa-vars.sh; mkdir -p "$EVID/img"; echo "$BRANCH"
```

Expect: `feat/fleet-core`.

**V-2 The control plane's file, written from the Mac.** Run on the Mac:

```sh
. /tmp/morndo-qa-vars.sh
ssh "$CP" 'set -o noclobber; cat > ~/morndo-qa.vars.sh' <<EOF
# The fleet QA's variables on the control plane, written from the Mac (qa.md, section 0). Every block here sources it.
export BRANCH='$BRANCH'
export NODE="\$HOME/.nvm/versions/node/v24.21.0/bin/node" QA="\$HOME/morndo-qa"
export PATH="\$(dirname "\$NODE"):\$PATH" REPO="\$HOME/morndo-qa/repo" SOCK="\$HOME/morndo-qa/run/fleet.sock"
qa() { "\$NODE" --no-warnings "\$REPO/e2e/fleet-qa.ts" "\$@"; }
TQ() { tmux -L morndo-qa "\$@"; }
if [ -f "\$QA/hub.vars" ]; then . "\$QA/hub.vars"; fi     # HUB_HOME and HUB_ENV, from CP-2 on
EOF
ssh "$CP" '. ~/morndo-qa.vars.sh; echo "$BRANCH $NODE"'
```

Expect: `feat/fleet-core /home/owner/.nvm/versions/node/v24.21.0/bin/node`. `cannot overwrite existing file` means an earlier QA left its file: stop (CP-1 would find its `~/morndo-qa` too).

The PC's file is written the same way in PC-1, only after the owner's go-ahead.

## 1. Mac

**M-1 Preflight.** Run on the Mac:

```sh
. /tmp/morndo-qa-vars.sh
{ node --version; lsof -nP -iTCP:18790 -sTCP:LISTEN; lsof -nP -iTCP:28791 -sTCP:LISTEN; ssh "$CP" 'hostname'; } 2>&1 | tee "$EVID/m-01-preflight.txt"
```

Expect:
- `v24.12` or newer;
- nothing listening on 18790 or 28791;
- `cp.example`.

Nothing touches the PC before PC-0.

**M-2 A worktree for the screenshots.** Run on the Mac:

```sh
. /tmp/morndo-qa-vars.sh
git -C ~/Projects/morndo fetch origin "$BRANCH"
git -C ~/Projects/morndo worktree add --detach "$MACREPO" "origin/$BRANCH"
cd "$MACREPO" && npm ci && npx playwright install chromium && git log --oneline -1 | tee "$EVID/m-02-revision.txt"
```

Expect: `npm ci` ends without an error, and the revision is the one under test. It needs about 0.6 GB on the Mac's disk, and C-5 removes it. Playwright's Chromium stays in its shared cache.

## 2. Control plane (no go-ahead needed)

**CP-1 Preflight, read-only.** Run on the control plane:

```sh
. ~/morndo-qa.vars.sh
{ hostname; uname -sr; "$NODE" --version; command -v tmux && tmux -V; git -C ~/morndo status --short --branch | head -3
  ss -ltn | grep -E ':(18787|18790|18791)\b' || echo "ports 18787, 18790, 18791 free"
  test -e "$QA" && echo "STOP: $QA exists" || echo "$QA absent"; df -h "$HOME" | tail -1; } 2>&1 | tee /tmp/cp-01-preflight.txt
```

Expect:
- `cp.example`, `Linux …`, `v24.21.0`;
- `tmux 3.4` or newer;
- `ports … free`;
- `… absent`.

If tmux is missing, stop and ask the owner: installing packages on the control plane belongs to sub-project 3.

**CP-2 Directories, worktree, dependencies, build.** Run on the control plane:

```sh
. ~/morndo-qa.vars.sh
mkdir -m 700 "$QA" && mkdir -p "$QA"/{evidence,logs,lane,hub-home,hub-inbox} && mkdir -m 700 "$QA/run"
mv /tmp/cp-01-preflight.txt "$QA/evidence/"
HUB_HOME=$(mktemp -d /tmp/morndo-qa-hub-XXXXXX)          # e2e/qa-session.ts accepts only a morndo-* dir in /tmp
cat > "$QA/hub.vars" <<EOF
HUB_HOME='$HUB_HOME'
HUB_ENV=(HOME='$QA/hub-home' MORNDO_HOME='$HUB_HOME' MORNDO_PORT=18790 MORNDO_ORIGIN=http://localhost:18790 MORNDO_FLEET_SOCKET='$SOCK' MORNDO_POLL_MS=1000 MORNDO_INBOX='$QA/hub-inbox' 'MORNDO_OFFICE_NAME=Fleet QA')
EOF
. ~/morndo-qa.vars.sh                                      # now with HUB_HOME and HUB_ENV
git -C ~/morndo fetch origin "$BRANCH" && git -C ~/morndo worktree add --detach "$REPO" "origin/$BRANCH"
cd "$REPO" && npm ci && npm run build
git log --oneline -1 | tee "$QA/evidence/cp-02-revision.txt"
```

Expect: the same revision as `m-02-revision.txt`, and `apps/web/build/200.html` exists. If `git fetch` can't authenticate here, stop and ask; don't copy keys onto the server.

**CP-3 The fleet service.** Run on the control plane:

```sh
. ~/morndo-qa.vars.sh
mkdir -p "$QA/fleet-home/.config/morndo-fleet"
cat > "$QA/fleet-home/.config/morndo-fleet/config.json" <<EOF
{ "listen": { "host": "127.0.0.1", "port": 18791 }, "socketPath": "$SOCK",
  "dbPath": "$QA/fleet-home/.local/share/morndo-fleet/fleet.db",
  "keyPath": "$QA/fleet-home/.local/share/morndo-fleet/fleet-key.pem",
  "publicUrl": "ws://127.0.0.1:18791/agent", "subscribers": [] }
EOF
cd "$REPO"
HOME=$QA/fleet-home nohup "$NODE" --no-warnings apps/fleet/src/main.ts serve > "$QA/logs/fleet.log" 2>&1 & echo $! > "$QA/fleet.pid"
sleep 2
{ HOME=$QA/fleet-home "$NODE" --no-warnings apps/fleet/src/main.ts status; qa nodes "$SOCK"; ss -ltn | grep ':18791\b'; ls -ld "$QA/run"; } 2>&1 | tee "$QA/evidence/cp-03-fleet.txt"
```

Expect: `status` answers with no nodes; `qa nodes` prints nothing; 127.0.0.1:18791 is listening; `$QA/run` is `drwx------`.

**CP-4 The hub, in fleet mode, on a throwaway data directory.** Run on the control plane:

```sh
. ~/morndo-qa.vars.sh; cd "$REPO"
nohup env "${HUB_ENV[@]}" "$NODE" --no-warnings apps/hub/src/main.ts serve > "$QA/logs/hub.log" 2>&1 & echo $! > "$QA/hub.pid"
sleep 3; grep -m1 'morndo hub on' "$QA/logs/hub.log" | tee "$QA/evidence/cp-04-hub.txt"
"$NODE" --no-warnings e2e/qa-session.ts "$HUB_HOME" "QA curl" > "$QA/cookie" && chmod 600 "$QA/cookie" && echo "cookie saved (not shown)" | tee -a "$QA/evidence/cp-04-hub.txt"
```

Expect: `[hub] info: morndo hub on http://127.0.0.1:18790, for http://localhost:18790`, then `cookie saved (not shown)`.

**CP-5 A local agent `cp` with a scratch lane.** Run on the control plane:

```sh
. ~/morndo-qa.vars.sh; cd "$REPO"
JOIN=$(HOME=$QA/fleet-home "$NODE" --no-warnings apps/fleet/src/main.ts node add cp | grep -o 'morndo-join:1:[A-Za-z0-9_-]*')
echo "join string: ${#JOIN} characters (not shown)" | tee "$QA/evidence/cp-05-agent.txt"
HOME=$QA/cp-home "$NODE" --no-warnings apps/node-agent/src/main.ts join "$JOIN" 2>&1 | sed -E 's/morndo-join:1:[A-Za-z0-9_-]+/morndo-join:1:[redacted]/g' | tee -a "$QA/evidence/cp-05-agent.txt"
unset JOIN
HOME=$QA/cp-home "$NODE" -e '
const fs = require("node:fs"), d = `${process.env.HOME}/.config/morndo-node`, f = `${d}/config.json`, c = JSON.parse(fs.readFileSync(f, "utf8"));
c.relayPort = 18787;
fs.writeFileSync(f, JSON.stringify(c, null, 2), { mode: 0o600 });
const policy = { session: "qa", tmuxSocket: process.argv[1], repoRoots: [], lockedPanes: {} };
fs.writeFileSync(`${d}/policy.json`, JSON.stringify(policy, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ node: c.node, fleetUrl: c.fleetUrl, relayPort: c.relayPort, policy: JSON.parse(fs.readFileSync(`${d}/policy.json`, "utf8")) }));' morndo-qa | tee -a "$QA/evidence/cp-05-agent.txt"
echo "cp-scratch on cp (QA)" > "$QA/lane/prose.txt"
TQ new-session -d -s qa -n cp-scratch -x 120 -y 30 -c "$QA/lane" "$NODE" --no-warnings "$REPO/test/fixtures/fake-claude-pane.ts" "$QA/lane" --claude="$QA/cp-home/.claude" --session="$(cat /proc/sys/kernel/random/uuid)" --tmux-session=qa
HOME=$QA/cp-home nohup "$NODE" --no-warnings apps/node-agent/src/main.ts run > "$QA/logs/cp-agent.log" 2>&1 & echo $! > "$QA/cp-agent.pid"
sleep 5; { qa nodes "$SOCK"; qa lanes "$SOCK"; } | tee -a "$QA/evidence/cp-05-agent.txt"
```

Expect:
- the join string's length only;
- `join` succeeding (exit 0);
- the config line with `"fleetUrl":"ws://127.0.0.1:18791/agent"`, `"relayPort":18787`, and a policy read back from `policy.json` with `"session":"qa"` and `"tmuxSocket":"morndo-qa"` (the agent reads its policy only from there: without it, it would act on the default tmux server);
- `cp  online  <version>`;
- `cp-scratch  cp  cp.<8 hex>.0`.

**CP-6 Mac: tunnels, and the hub with one node.** Run on the Mac:

```sh
. /tmp/morndo-qa-vars.sh
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:18790:127.0.0.1:18790 -L 127.0.0.1:28791:127.0.0.1:18791 "$CP" & echo $! > /tmp/morndo-qa-tunnel-cp.pid
sleep 2; shots list:cp-06-hub-one-node.png | tee "$EVID/cp-06-shots.txt"
```

Expect: `list:cp-06-hub-one-node.png -> …` and `this QA device revoked itself: 200`. The screenshot lists `cp-scratch`.

**CP-7 A send and a frame on the control plane's node.** Run on the Mac:

```sh
. /tmp/morndo-qa-vars.sh
shots "send:cp-scratch:hello cp from the hub:cp-07-send.png" terminal:cp-scratch:cp-07-frame.png | tee "$EVID/cp-07-shots.txt"
```

Then run on the control plane:

```sh
. ~/morndo-qa.vars.sh
cat "$QA/lane/submitted.jsonl" | tee "$QA/evidence/cp-07-submitted.txt"
```

Expect `"hello cp from the hub"`, exactly once. `cp-07-send.png` shows the message in cp-scratch's conversation, and `cp-07-frame.png` shows the Terminal tab with "cp-scratch on cp (QA)" and the input box.

**CP-8 The drop-after-paste drill.** The control plane's agent restarts with the test hook for one request ID only; every other send behaves normally. Run on the control plane:

```sh
. ~/morndo-qa.vars.sh; cd "$REPO"
"$NODE" --no-warnings e2e/qa-session.ts "$HUB_HOME" --reverify "$(cat "$QA/cookie")" | tee "$QA/evidence/cp-08-reverify.txt"
COOKIE=$(cat "$QA/cookie"); WID=$(qa worker "$SOCK" cp-scratch); RID=$(cat /proc/sys/kernel/random/uuid)
kill "$(cat "$QA/cp-agent.pid")"; sleep 2
HOME=$QA/cp-home NODE_ENV=test MORNDO_NODE_TEST_HOOKS="{\"dropAfterStarted\":\"$RID\"}" nohup "$NODE" --no-warnings apps/node-agent/src/main.ts run > "$QA/logs/cp-agent-drill.log" 2>&1 & echo $! > "$QA/cp-agent.pid"
sleep 5
{ echo "worker $WID, request $RID"
  echo "1st:"; qa send 18790 "$COOKIE" "$WID" "qa drill: drop after the paste" "$RID"
  sleep 4; qa nodes "$SOCK"
  echo "repeat:"; qa send 18790 "$COOKIE" "$WID" "qa drill: drop after the paste" "$RID"
  echo "typed: $(grep -c 'qa drill: drop after the paste' "$QA/lane/submitted.jsonl")"
  grep -i -m3 'hook' "$QA/logs/cp-agent-drill.log"; } 2>&1 | tee "$QA/evidence/cp-08-drop-after-paste.txt"
unset COOKIE
```

Expect:
- `verified now` first. A send needs a session whose passkey was checked recently (the hub's step-up window), and the QA cookie was checked in CP-4; `e2e/qa-session.ts --reverify` marks it checked now, so a 403 `step_up` can't stand in for the drill's answers. PC-7 and PC-8 do the same before their sends;
- `1st:` then `409 {"error":"uncertain"}`: the node's answer was "maybe", and the hub keeps its started row (plan Contracts, "The hub's answers to a send"; a 500 `{"error":"internal error"}` until the final review's I1);
- `cp  online`, since it reconnected;
- `repeat:` then `200 {"error":"duplicate","ok":true,…}`;
- `typed: 1`;
- a log line naming `dropAfterStarted` (the agent's warning about active test hooks).

The agent accepts the hook only because `NODE_ENV=test` is set and its `HOME` (`$QA/cp-home`) isn't the account's own; without `NODE_ENV=test`, `run` exits 78 and says why.

Then run on the Mac: `. /tmp/morndo-qa-vars.sh; shots lane:cp-scratch:cp-08-drop-drill.png`. The conversation shows the message once.

**CP-9 Back to normal.** Run on the control plane:

```sh
. ~/morndo-qa.vars.sh; cd "$REPO"; kill "$(cat "$QA/cp-agent.pid")"; sleep 2
HOME=$QA/cp-home nohup "$NODE" --no-warnings apps/node-agent/src/main.ts run > "$QA/logs/cp-agent.log" 2>&1 & echo $! > "$QA/cp-agent.pid"
sleep 5; { qa nodes "$SOCK"; echo "test hook warnings: $(grep -c 'test hooks are on' "$QA/logs/cp-agent.log")"; echo "alerts:"; qa alerts "$SOCK"; } | tee "$QA/evidence/cp-09-normal.txt"
```

Expect: `cp  online`; `test hook warnings: 0` (the agent's warning about active hooks reads `test hooks are on (…)`; a plain `hook` would also match the relay's own lines); and under `alerts:` nothing, or only lines the record explains (a `clock_offset` would mean this host's clock is more than 2 s off: record the offset).

## 3. The PC test agent: **OWNER'S GO-AHEAD REQUIRED for every step**

**PC-0 Ask.** Send the owner this, and wait for his answer:

> Fleet QA, PC part: may I run a TEST node agent on the PC for about 30 minutes? It runs from `~/morndo-qa` only, with HOME set there. It gets its own tmux server (`tmux -L morndo-test`) holding one scratch pane: a fake input box, no Claude Code. Its relay is on 127.0.0.1:18787, and it reaches the control plane's QA fleet through an SSH tunnel from the Mac (127.0.0.1:18791 on the PC). It never touches tmux `main`, kira (8787), the live hub, `~/.claude` or `~/.claude/settings.json`. I'll restart its own test tmux server once, for a drill, and stop it once. The cleanup removes all of it.

Record his answer verbatim, with the time, in `$EVID/pc-00-go-ahead.txt`. **Without a yes, stop here.** Record the PC part as not done; done criterion 3 then stays open.

**PC-1 The PC's variables file, then a preflight, read-only.** Run on the Mac (as V-2 did for the control plane):

```sh
. /tmp/morndo-qa-vars.sh
ssh "$PC_WSL" 'set -o noclobber; cat > ~/morndo-qa.vars.sh' <<EOF
# The fleet QA's variables on the PC (WSL), written from the Mac (qa.md, PC-1). Every PC block sources it.
export BRANCH='$BRANCH'
export NODE="\$HOME/.nvm/versions/node/v24.21.0/bin/node" QA="\$HOME/morndo-qa"
export REPO="\$HOME/morndo-qa/repo"
TT() { tmux -L morndo-test "\$@"; }
EOF
ssh "$PC_WSL" '. ~/morndo-qa.vars.sh; echo "$BRANCH $NODE"'
```

Expect: `feat/fleet-core /home/<user>/.nvm/versions/node/v24.21.0/bin/node`.

Then run on the PC:

```sh
. ~/morndo-qa.vars.sh
{ hostname; grep -o 'microsoft[^ ]*' /proc/version; "$NODE" --version; tmux -V
  echo "listening:"; ss -ltn | grep -E ':(8787|18787|18791)\b'
  TT ls 2>&1 | head -1
  test -e "$QA" && echo "STOP: $QA exists" || echo "$QA absent"
  sha256sum ~/.claude/settings.json; df -h "$HOME" | tail -1; } 2>&1 | tee /tmp/pc-01-preflight.txt
```

Expect:
- a WSL2 kernel (the `microsoft…` part; if it's missing, `$PC_WSL` doesn't land in WSL: stop);
- `v24.21.0` (the pinned Node; if the file is missing, stop: nvm's 24.21.0 is what the services run on);
- tmux 3.4 or newer;
- under `listening:`, exactly one line, for 8787 (live kira); 18787 and 18791 are free;
- `no server running on …/morndo-test`;
- `… absent`;
- a hash of `settings.json`, which C-2 compares.

**PC-2 Directory, clone, dependencies.** Run on the PC:

```sh
. ~/morndo-qa.vars.sh
mkdir -m 700 "$QA" && mkdir -p "$QA"/{evidence,logs,lane,home} && mv /tmp/pc-01-preflight.txt "$QA/evidence/"
git clone --quiet --depth 1 --branch "$BRANCH" git@github.com:morndo/morndo.git "$REPO"
cd "$REPO" && npm ci 2>&1 | tail -2 && git log --oneline -1 | tee "$QA/evidence/pc-02-revision.txt"
```

Expect: the same revision as `cp-02-revision.txt`. npm's download cache (`~/.npm`) is shared and only grows; it holds no state of this QA.

**PC-3 The tunnel to the control plane's fleet, through the Mac.** Run on the Mac:

```sh
. /tmp/morndo-qa-vars.sh
ssh -N -o ExitOnForwardFailure=yes -R 127.0.0.1:18791:127.0.0.1:28791 "$PC_WSL" & echo $! > /tmp/morndo-qa-tunnel-pc.pid
```

Then run on the PC:

```sh
. ~/morndo-qa.vars.sh
(exec 3<>/dev/tcp/127.0.0.1/18791) && echo "fleet reachable on 127.0.0.1:18791" | tee "$QA/evidence/pc-03-tunnel.txt"
```

Expect: `fleet reachable …`. The path is PC 18791 → the Mac's 28791 → the control plane's 18791 (CP-6). No SSH trust between the PC and the control plane is needed, and nothing is configured on either host.

**PC-4 Join `pc-test`, a scratch lane, run.** Run on the Mac, which carries the join string from the control plane to the PC without it touching any file:

```sh
. /tmp/morndo-qa-vars.sh
JOIN=$(ssh "$CP" bash -s <<'EOS' | grep -o 'morndo-join:1:[A-Za-z0-9_-]*'
. ~/morndo-qa.vars.sh; cd "$REPO"; HOME=$QA/fleet-home "$NODE" --no-warnings apps/fleet/src/main.ts node add pc-test
EOS
)
ssh "$PC_WSL" "JOIN='$JOIN' bash -s" <<'EOS' 2>&1 | sed -E 's/morndo-join:1:[A-Za-z0-9_-]+/morndo-join:1:[redacted]/g' | tee "$EVID/pc-04-join.txt"
. ~/morndo-qa.vars.sh; cd "$REPO"; HOME=$QA/home "$NODE" --no-warnings apps/node-agent/src/main.ts join "$JOIN"; echo "join exit $?"
EOS
unset JOIN
```

Then run on the PC:

```sh
. ~/morndo-qa.vars.sh; cd "$REPO"
HOME=$QA/home "$NODE" -e '
const fs = require("node:fs"), d = `${process.env.HOME}/.config/morndo-node`, f = `${d}/config.json`, c = JSON.parse(fs.readFileSync(f, "utf8"));
c.relayPort = 18787;
fs.writeFileSync(f, JSON.stringify(c, null, 2), { mode: 0o600 });
const policy = { session: "qa", tmuxSocket: process.argv[1], repoRoots: [], lockedPanes: {} };
fs.writeFileSync(`${d}/policy.json`, JSON.stringify(policy, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ node: c.node, fleetUrl: c.fleetUrl, relayPort: c.relayPort, policy: JSON.parse(fs.readFileSync(`${d}/policy.json`, "utf8")) }));' morndo-test | tee "$QA/evidence/pc-04-config.txt"
echo "pc-scratch on pc-test (QA)" > "$QA/lane/prose.txt"
TT new-session -d -s qa -n pc-scratch -x 120 -y 30 -c "$QA/lane" "$NODE" --no-warnings "$REPO/test/fixtures/fake-claude-pane.ts" "$QA/lane" --claude="$QA/home/.claude" --session="$(cat /proc/sys/kernel/random/uuid)" --tmux-session=qa
TT list-panes -a -F '#{session_name}:#{window_name} #{pane_id}' | tee "$QA/evidence/pc-04-panes.txt"
HOME=$QA/home nohup "$NODE" --no-warnings apps/node-agent/src/main.ts run > "$QA/logs/pc-agent.log" 2>&1 & echo $! > "$QA/pc-agent.pid"
```

Expect:
- `join exit 0`;
- the config line with `"node":"pc-test"`, `"relayPort":18787`, and a policy read back from `policy.json` with `"session":"qa"` and `"tmuxSocket":"morndo-test"`. **If the policy doesn't show `morndo-test`, stop**: the agent would act on the PC's default tmux server, where the live lanes run;
- `qa:pc-scratch %0`.

**PC-5 The hub lists both nodes.** Run on the control plane:

```sh
. ~/morndo-qa.vars.sh
sleep 5; { qa nodes "$SOCK"; qa lanes "$SOCK"; } | tee "$QA/evidence/pc-05-both-nodes.txt"
```

Expect: `cp  online` and `pc-test  online`; `cp-scratch  cp  cp.…` and `pc-scratch  pc-test  pc-test.…`.

Then run on the Mac:

```sh
. /tmp/morndo-qa-vars.sh
shots list:pc-05-hub-both-nodes.png lane:pc-scratch:pc-05-pc-lane.png | tee "$EVID/pc-05-shots.txt"
```

Expect: `pc-05-hub-both-nodes.png` lists cp-scratch and pc-scratch.

**PC-6 A send and a frame on the PC's node.** Run on the Mac:

```sh
. /tmp/morndo-qa-vars.sh
shots "send:pc-scratch:hello pc-test from the control plane:pc-06-send.png" terminal:pc-scratch:pc-06-frame.png | tee "$EVID/pc-06-shots.txt"
```

Then run on the PC:

```sh
. ~/morndo-qa.vars.sh
cat "$QA/lane/submitted.jsonl" | tee "$QA/evidence/pc-06-submitted.txt"
```

Expect `"hello pc-test from the control plane"`, exactly once. The frame shows "pc-scratch on pc-test (QA)", drawn on the PC.

**PC-7 The tmux-restart drill, on the test server only.** Run on the control plane:

```sh
. ~/morndo-qa.vars.sh
qa worker "$SOCK" pc-scratch | tee "$QA/evidence/pc-07-old-id.txt"
```

Then run on the PC:

```sh
. ~/morndo-qa.vars.sh
TT kill-server
until ! TT ls >/dev/null 2>&1; do sleep 0.2; done     # kill-server returns before the server is gone (tmux 3.3a)
mkdir -p "$QA/lane2" && echo "pc-scratch after the restart (QA)" > "$QA/lane2/prose.txt"
TT new-session -d -s qa -n pc-scratch -x 120 -y 30 -c "$QA/lane2" "$NODE" --no-warnings "$REPO/test/fixtures/fake-claude-pane.ts" "$QA/lane2"
TT list-panes -a -F '#{session_name}:#{window_name} #{pane_id}' | tee "$QA/evidence/pc-07-panes-after.txt"
```

Then run on the control plane:

```sh
. ~/morndo-qa.vars.sh; cd "$REPO"
"$NODE" --no-warnings e2e/qa-session.ts "$HUB_HOME" --reverify "$(cat "$QA/cookie")" | tee "$QA/evidence/pc-07-reverify.txt"
OLD=$(cat "$QA/evidence/pc-07-old-id.txt"); NEW=$OLD
for i in $(seq 1 30); do NEW=$(qa worker "$SOCK" pc-scratch 2>/dev/null || echo "$OLD"); [ "$NEW" != "$OLD" ] && break; sleep 1; done
{ echo "old $OLD"; echo "new $NEW"
  qa send 18790 "$(cat "$QA/cookie")" "$OLD" "qa drill: meant for the old pane"; } | tee "$QA/evidence/pc-07-restart.txt"
```

Then run on the PC:

```sh
. ~/morndo-qa.vars.sh
sleep 2; { test -s "$QA/lane2/submitted.jsonl" && cat "$QA/lane2/submitted.jsonl" || echo "the new pane received nothing"; } | tee "$QA/evidence/pc-07-new-pane.txt"
```

Expect:
- `verified now` (the cookie's step-up, as in CP-8);
- `qa:pc-scratch %0` again: tmux reused the pane number;
- `old pc-test.<a>.0` and `new pc-test.<b>.0`, where a ≠ b (a new server stamp) and the pane number is the same;
- the send to the old ID answers `404 {"error":"no_pane"}`;
- `the new pane received nothing`.

Then run on the Mac:

```sh
. /tmp/morndo-qa-vars.sh
shots list:pc-07-after-restart.png
```

The screenshot shows pc-scratch listed again.

**PC-8 Stopping the PC test agent marks only its lanes offline.** Run on the PC:

```sh
. ~/morndo-qa.vars.sh
kill "$(cat "$QA/pc-agent.pid")"; echo "pc-test agent stopped" | tee "$QA/evidence/pc-08-stop.txt"
```

Then run on the control plane:

```sh
. ~/morndo-qa.vars.sh; cd "$REPO"
"$NODE" --no-warnings e2e/qa-session.ts "$HUB_HOME" --reverify "$(cat "$QA/cookie")" | tee "$QA/evidence/pc-08-reverify.txt"
sleep 5; { qa nodes "$SOCK"; qa lanes "$SOCK"
  echo "send to cp:"; qa send 18790 "$(cat "$QA/cookie")" "$(qa worker "$SOCK" cp-scratch)" "cp is still steered after pc-test stopped"
  echo "send to pc:"; qa send 18790 "$(cat "$QA/cookie")" "$(qa worker "$SOCK" pc-scratch)" "pc-test is offline"
  echo "alerts:"; qa alerts "$SOCK"; } | tee "$QA/evidence/pc-08-offline.txt"
grep -c 'cp is still steered' "$QA/lane/submitted.jsonl"
```

Then run on the Mac:

```sh
. /tmp/morndo-qa-vars.sh
shots list:pc-08-pc-offline.png
```

Expect:
- `verified now` (the cookie's step-up, as in CP-8);
- `pc-test  offline` and `cp  online`;
- `send to cp:` then `200 {"ok":true,…}`, and the grep prints `1`;
- `send to pc:` then `409 {"error":"node_offline"}`: refused before anything was typed;
- the screenshot still lists both lanes (an offline node's workers stay listed, never gone), with the offline marker on pc-scratch only (Task 15b);
- under `alerts:`, no `instance_conflict`; any other line is explained in the record (a `clock_offset` for `pc-test` means the PC's clock is more than 2 s off the control plane's: record the offset).

## 4. Cleanup

Only what this runbook created goes (rule 8):
- Mac: the worktree `/tmp/morndo-qa-mac` (by its path), the tunnels' pid files `/tmp/morndo-qa-tunnel-*.pid`, and, once the record is committed, `/tmp/morndo-qa-evidence` and `/tmp/morndo-qa-vars.sh`;
- control plane: `~/morndo-qa` (its worktree `~/morndo-qa/repo` removed by its path first), `~/morndo-qa.vars.sh`, the hub's data `/tmp/morndo-qa-hub-*`, the tmux server `morndo-qa`, and `/tmp/cp-cleanup.txt` once copied;
- PC: `~/morndo-qa`, `~/morndo-qa.vars.sh`, the tmux server `morndo-test`, and `/tmp/pc-cleanup.txt` once copied.

Nothing else: no `git worktree prune` in `~/Projects/morndo` or `~/morndo` (a prune would also drop the owner's own stale worktree entries), no other tmux server, not kira, not `~/.claude/settings.json`.

**C-1 Save the evidence first.** Run on the Mac:

```sh
. /tmp/morndo-qa-vars.sh
scp -r "$CP:morndo-qa/evidence" "$EVID/cp" && scp -r "$PC_WSL:morndo-qa/evidence" "$EVID/pc" && ls -R "$EVID" | head -50
```

**C-2 PC (covered by the go-ahead in PC-0).** Run on the PC:

```sh
. ~/morndo-qa.vars.sh
kill "$(cat "$QA/pc-agent.pid")" 2>/dev/null; TT kill-server 2>/dev/null; rm -rf "$QA" ~/morndo-qa.vars.sh
{ ss -ltn | grep -E ':(18787|18791)\b' || echo "18787, 18791 free"
  TT ls 2>&1 | head -1
  for f in "$HOME/morndo-qa" "$HOME/morndo-qa.vars.sh"; do test -e "$f" && echo "STILL THERE: $f" || echo "gone: $f"; done
  sha256sum ~/.claude/settings.json; ss -ltn | grep -E ':8787\b'; } 2>&1 | tee /tmp/pc-cleanup.txt
```

Expect:
- `18787, 18791 free` (the Mac's tunnel goes in C-3; if 18791 still shows, run C-3 and check again);
- `no server running on …/morndo-test`;
- `gone: …/morndo-qa` and `gone: …/morndo-qa.vars.sh`;
- the **same** hash as in PC-1;
- 8787 still listening (kira untouched).

Then run on the Mac: `. /tmp/morndo-qa-vars.sh; scp "$PC_WSL:/tmp/pc-cleanup.txt" "$EVID/pc/" && ssh "$PC_WSL" rm /tmp/pc-cleanup.txt`.

**C-3 Mac tunnels.** Run on the Mac:

```sh
. /tmp/morndo-qa-vars.sh
kill "$(cat /tmp/morndo-qa-tunnel-pc.pid)" "$(cat /tmp/morndo-qa-tunnel-cp.pid)"; rm /tmp/morndo-qa-tunnel-pc.pid /tmp/morndo-qa-tunnel-cp.pid
lsof -nP -iTCP:18790 -sTCP:LISTEN; lsof -nP -iTCP:28791 -sTCP:LISTEN; echo "tunnels closed"
```

**C-4 Control plane.** Run on the control plane:

```sh
. ~/morndo-qa.vars.sh
kill "$(cat "$QA/cp-agent.pid")" "$(cat "$QA/hub.pid")" "$(cat "$QA/fleet.pid")" 2>/dev/null; sleep 2
TQ kill-server 2>/dev/null
git -C ~/morndo worktree remove --force "$REPO"          # this runbook's worktree, by its path; never a prune
rm -rf "$QA" "$HUB_HOME" ~/morndo-qa.vars.sh
{ ss -ltn | grep -E ':(18787|18790|18791)\b' || echo "18787, 18790, 18791 free"
  TQ ls 2>&1 | head -1; git -C ~/morndo worktree list
  for f in "$HOME/morndo-qa" "$HOME/morndo-qa.vars.sh" "$HUB_HOME"; do test -e "$f" && echo "STILL THERE: $f" || echo "gone: $f"; done
  pgrep -fl 'morndo-qa' || echo "no QA process left"; } 2>&1 | tee /tmp/cp-cleanup.txt
```

Expect:
- the ports free;
- `no server running` (for `morndo-qa`);
- the worktree list without `morndo-qa/repo`, and otherwise as it was (CP-1's `git status` line is the main worktree; no other entry changed);
- `gone:` for each of the three paths;
- `no QA process left`.

Then run on the Mac: `. /tmp/morndo-qa-vars.sh; scp "$CP:/tmp/cp-cleanup.txt" "$EVID/cp/" && ssh "$CP" rm /tmp/cp-cleanup.txt`.

**C-5 Mac.** Run on the Mac:

```sh
. /tmp/morndo-qa-vars.sh
git -C ~/Projects/morndo worktree remove --force "$MACREPO"     # by its path; never a prune
git -C ~/Projects/morndo worktree list
```

Expect: no `/tmp/morndo-qa-mac`, and the other entries as before. `$EVID` and `/tmp/morndo-qa-vars.sh` stay until the record below is committed; delete them afterwards with `rm -rf /tmp/morndo-qa-evidence /tmp/morndo-qa-vars.sh`.

## 5. The record

Write `qa/<YYYY-MM-DD>-fleet-core.md` in the shape of the earlier QA records (a private QA record, not in this tree):
- the branch and revision, the hosts, Node and tmux versions, and the owner's go-ahead (his words and the time);
- a "How it was checked" table: CI (the run's link: `ci` and `fleet` jobs, `e2e fleet-two-node`) and this runbook (manual, the agent at the keys);
- the table below, each row with yes/no and the decisive output line, quoted from the evidence files;
- what the QA found, and what changed because of it (or "nothing").

Copy the screenshots to `qa/img-fleet/`. Look at each one before committing: it must show what its row claims. Copy no `.txt` file into the repo that holds a secret; the blocks above redact join strings and never print the cookie.

| Done criterion 3 (spec section 12) | Evidence |
|---|---|
| The hub lists both nodes | `img-fleet/pc-05-hub-both-nodes.png`, `pc/pc-05-both-nodes.txt` |
| A send | `img-fleet/cp-07-send.png`, `img-fleet/pc-06-send.png`, `cp/cp-07-submitted.txt`, `pc/pc-06-submitted.txt` (once each) |
| A frame | `img-fleet/cp-07-frame.png`, `img-fleet/pc-06-frame.png` |
| The drop-after-paste drill | `cp/cp-08-drop-after-paste.txt` (`409 uncertain`, then `200 duplicate`, `typed: 1`), `img-fleet/cp-08-drop-drill.png` |
| The tmux-restart drill | `pc/pc-07-*.txt` (the old and new ID, `404 no_pane`, "the new pane received nothing"), `img-fleet/pc-07-after-restart.png` |
| Section 9's control: stopping the PC test agent marks only its lanes offline | `cp/pc-08-offline.txt` (pc-test offline, cp online, `409 node_offline` to pc-scratch, `200` to cp-scratch, the alerts), `img-fleet/pc-08-pc-offline.png` (the offline marker on pc-scratch only) |
| Nothing live touched | `pc/pc-01-preflight.txt` and `pc/pc-cleanup.txt`: the same `settings.json` hash, 8787 listening before and after, no `morndo-test` server and no `~/morndo-qa` left; `cp/cp-cleanup.txt` |
````

- [ ] **Step 4: Link the runbook from the root README, and commit the helper and the runbook**

In `README.md`, at the end of the `## Fleet (ADR-0012)` paragraph (Task 19), add the sentence: ``The manual QA: [`docs/design/fleet-core/qa.md`](docs/design/fleet-core/qa.md).``

```bash
git add e2e/fleet-qa.ts docs/design/fleet-core/qa.md README.md
git commit -m "docs(fleet): manual QA runbook for the control plane and a PC test node"
```

- [ ] **Step 5: Run sections 0–2 (Mac and control plane), stopping at the first Expect that doesn't hold**

Follow `docs/design/fleet-core/qa.md` from V-1 to CP-9. Each step's Expect is its pass condition, and each evidence file must exist before the next step: `. /tmp/morndo-qa-vars.sh; ls "$EVID" "$EVID/img"` on the Mac, `ls ~/morndo-qa/evidence` on the control plane.

- [ ] **Step 6: OWNER'S GO-AHEAD REQUIRED. Ask (PC-0) and wait**

Send the PC-0 message exactly as the runbook words it, and record the answer. Without a clear yes, skip Steps 7–8: do C-1 for the control plane only, then C-3, C-4 and C-5, and record criterion 3 as "PC part not done: no go-ahead".

- [ ] **Step 7: OWNER'S GO-AHEAD REQUIRED. Run section 3 (PC-1 to PC-8)**

Follow the runbook. On the PC, before each block, re-read it for a bare `tmux` (rule 2). If any Expect fails, stop and keep everything running for diagnosis; tell the owner what failed before you clean up.

- [ ] **Step 8: Clean up (section 4)**

Run C-1 to C-5 in order. On the PC, C-2 is covered by the go-ahead. Each cleanup block's Expect must hold; in particular, the `settings.json` hash from PC-1 and C-2 must be identical.

- [ ] **Step 9: Write the record and commit it**

Write `qa/<YYYY-MM-DD>-fleet-core.md` as section 5 says, and copy the screenshots to `qa/img-fleet/`.

Run: `grep -nE 'morndo-join:1:[A-Za-z0-9_-]{20,}|__Host-morndo=' qa/*-fleet-core.md qa/img-fleet/ -r || echo "no secrets in the record"`
Expected: `no secrets in the record`.

```bash
git add qa/<YYYY-MM-DD>-fleet-core.md qa/img-fleet
git commit -m "docs(qa): fleet core on the control plane and a PC test node"
```

Delete `/tmp/morndo-qa-evidence` and `/tmp/morndo-qa-vars.sh` afterwards (`rm -rf` of those two paths only).
