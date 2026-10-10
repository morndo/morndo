## Lane notes (hub-fleet)

**How this part was checked.** Tasks 14 and 15 were applied, from this text, on top of Tasks 4 and 5 (`02-hub-async.md`, applied the same way) in a copy of the executed and reconciled Tasks 1–3, Node 24.21.0, macOS. A script took every created file and every replacement from this document's code blocks and stopped on any old text that wasn't in its file exactly once; afterwards every code block here was found in the tree, or is old text that a later step replaces. The fleet side is the fake fleet of Step 14.1 only: the real fleet (Task 12) and agent (Task 8) were not run against these adapters.

**What passed** (`npx vitest run apps/hub packages apps/web`, which includes the Chromium tests; Playwright 1.63 with its headless Chromium):
- After Task 14: 142 files, 1129 tests; with `MORNDO_HUB_MODES=fleet`, 1090. After Task 15: 147 and 1155; fleet only, 1113 (round 2, on Tasks 1–5 as round 2 left them; round 1 had 139/1080 and 144/1101). The nine both-mode suites: 40 tests per mode, 79 in both. The Chromium project alone: 21 files, 87 tests.
- The only failures: `packages/node-ops/test/pane-lock.test.ts`, 2 tests, as before Task 4 (macOS has no `flock(1)`).
- `npm run check` exited 0 and `npm run lint` reported nothing after each task.
- Step 14.21's smoke run was run as written (bash, no `timeout(1)`); its results are the ones listed there.
- Every "see it fail" step was run, with the messages written below, and every negative control listed (fleet client, `#settle`, Step 15.12).
- Not kept as a test, checked once: over HTTP, a send whose node answered "maybe" is 500 `internal error` (409 `uncertain` since the fix wave, final review I1); its repeat while the node says started is 409 `uncertain`; once the node says done, 200 `duplicate` with the node's `typedAt`.

**Round 2** (2026-10-06; items 3, 4, 5, 8, 12, 13, 15, 17, 18, 21, 25 and 33 of the second review). Replayed from this text on Tasks 1–3 as round 2 left them and Tasks 4–5 from `02-hub-async.md`, one commit per stage, then checked file for file against the tree the changes were made in. Every changed or new "see it fail" step, every count and every listed control was run on that replay; the messages and counts below are those runs'. What changed:
- **Roster and names in conflict** (item 4): the fleet's roster is every window of every node, from the inventories; `conflict` comes from the lane registry; a send by worker id still goes; the manager is found by name only while its name isn't in conflict, and its answers are refused `lane_conflict` meanwhile. The fake fleet's registry is now the real one's (one row per name, `workerId: null` when two windows on the owner claim it) and routes `{ lane }` with `lane_conflict`.
- **Stores** (item 5): every op answer carries the node's store; a send in doubt keeps the store it went to (migration 10; 9 went to `ask_first_seen` during execution); a repeat types anew only on `unknown` from that same store. Two repeats at once ask once (item 21).
- **The fleet down** (item 12), **a 300 ms listing** (item 13), **`SourceUnavailable`** (item 15), **`keys_uncertain`** (item 25), **no desktop with a fleet** (item 33).
- **Both modes** (item 17): nine suites (Step 14.23), plus `http-older` from Task 15.
- **Controls after commits** (item 8): Steps 14.6, 14.12, 14.17 and 14.31 commit first and then run their controls, so `git checkout` restores this task's code, never an older one, and never meets an untracked file.
- **One command per Run line** (item 18).

**Decided while reconciling** (plan.md's Contracts hold the shapes): `HubPorts` carries `nodeStates`; `legacyPorts` (local-ports.ts) builds the legacy set for main.ts, and hub-mode.ts' legacy mode wraps each suite's own fakes with `local-node.ts`' builders instead; a repeat of a send in doubt that the node finished answers the node's `typedAt`; no path is decoded whole any more (Step 15.8); `node_offline`'s words are Task 5's. Remaining gaps not covered by Task 15b are at the end of this part.

---

### Task 14: Fleet client and fleet adapters in the hub

**Files:**
- Create: `apps/hub/src/adapters/fleet-client.ts`
- Create: `apps/hub/src/adapters/fleet-adapters.ts`
- Create: `apps/hub/src/adapters/local-ports.ts` (`legacyPorts`: the legacy set of ports, over Task 4/5's `local-node.ts`)
- Create: `apps/hub/test/helpers/fake-fleet.ts` (reusable fake fleet service)
- Create: `apps/hub/test/helpers/hub-mode.ts` (both-modes helper, `fleetRig`, the service factories)
- Create: `apps/hub/test/fleet-client.test.ts`
- Create: `apps/hub/test/fleet-adapters.test.ts`
- Create: `apps/hub/test/local-ports.test.ts`
- Create: `apps/hub/test/fleet-steering.test.ts`
- Create: `apps/hub/test/config-fleet.test.ts`
- Create (Steps 14.27–14.31): `apps/hub/test/fleet-conflicts.test.ts`, `apps/hub/test/fleet-unavailable.test.ts`
- Modify: `apps/hub/src/config.ts`:
  - `:1-2` (imports);
  - `:23-24` (`Config` type, after `inboxDir`);
  - `:91` (`loadConfig` return, after `inboxDir`);
  - a new function at the end.
- Modify: `apps/hub/src/main.ts` (as Task 5 left it):
  - `:16-17`, `:28-29` (imports);
  - `:39-43` (HELP);
  - the `serve` block from the legacy construction through `new RemoteService(...)` (`:78-121`);
  - `:161` (`stop`);
  - a new function at the end.
- Modify: `apps/hub/src/application/steering-service.ts` (as Task 5 left it):
  - the `./ports.ts` import, and `BEFORE_PASTE`'s comment;
  - the fields and the constructor (`status`, the 9th parameter);
  - the repeat path in `send`, registered before its first await, and a new private method `#judge`;
  - a new private method, `#settle`;
  - `#type` keeps the store a send in doubt went to.
- Modify: `apps/hub/src/adapters/store.ts` (`send` returns the store; `setSendStore`) and `apps/hub/src/adapters/migrations.ts` (migration 10, `sends.node_store`; 9 went to `ask_first_seen` during execution)
- Modify: `apps/hub/src/application/ports.ts` (the hub's `Terminal` and `HubPorts`; `Terminal as PaneTerminal` in the node-ops import)
- Modify: `apps/hub/src/application/remote-service.ts` (the hub's `Terminal`) and `apps/hub/src/adapters/http.ts` (`keys_uncertain`)
- Modify (Step 14.29): `apps/hub/src/application/observation-service.ts` (`fleet()`, `conflicted()`, the listing kept while the fleet is down), `apps/hub/src/application/escalation-service.ts` (`managerOf`, `lane_conflict`)
- Modify (tests): `apps/hub/test/http-crash-fixture.ts` (a `keys-uncertain` variant), `apps/hub/test/http-terminal-throws.test.ts` (one test)
- Modify (rewrite, both modes):
  - `apps/hub/test/steering-durable.test.ts`
  - `apps/hub/test/observation-waiting-on.test.ts`
  - `apps/hub/test/remote-service.test.ts`
  - `apps/hub/test/observation-nodes.test.ts`, `observation-attachments.test.ts`, `steering-keys.test.ts`, `escalation-answer-keys.test.ts`, `steering-inflight-duplicate.test.ts`, `steering-throw-retry.test.ts` (round 2, item 17)
- Test: all the test files above, plus every hub, web and protocol suite.

`SendOutcome.problem`'s `"node_offline"` and its `store`, the `offline` and `conflict` flags of `listWorkers` items, `SendStatus`'s answers (an `unknown` with its store), `SendInDoubt`, `SourceUnavailable`, `BEFORE_PASTE`'s `node_offline` and `AnswerResult`'s `node_offline` are already Task 4's and Task 5's (plan.md, "Hub ports" and "Hub services and builders"); this task gives them their fleet meaning.

**Interfaces:**
- Consumes:
  - **`@morndo/protocol`:**
    - `CLIENT_API`, `LIMITS`, `ERROR_EXECUTED`;
    - `formatWorkerId(ref)`, `parseWorkerId(id): WorkerRef | null`;
    - types `Pane`, `Expect`, `OpError`, `ErrorCode`, `OpName`, `OpArgs`, `OpResult`, `Health`, `Alert`, `AlertKind`.
  - **`@morndo/node-ops`:**
    - `sessionRegistry(dir)`, `tmuxAdapter`, `terminalAdapter` (local-ports.ts), `paneLock`, `denyRoots` (main.ts);
    - types `SendProblem`, `SessionInfo`, `Terminal`, `Frame`.
  - **`apps/hub/src/application/ports.ts`** (Task 4): `Tmux`, `SendOutcome`, `SendStatus`, `SendInDoubt`, `Sessions`, `TranscriptSource`, `SourceUnavailable`, `RemoteFiles`, `UploadSink`, `NodeState`, `NodeStates`.
  - **`apps/hub/src/adapters/local-node.ts`** (Tasks 4, 5): `localTmux`, `localSessions`, `localTranscripts`, `localUploads`, `localFiles`.
  - **Services** (Tasks 4, 5): `new ObservationService(tmux, quietAfterMs, now?, o?: ObservationSources)`; `new SteeringService(store, tmux, now?, policy?, inbox?, waitingOn?, nameOf?, uploads = localUploads())`; EscalationService's `send: (pane, text, key) => Promise<SendProblem | "node_offline" | null>`; `Store.send(key)` with `typedAt`, `Store.finishSend(key, typedAt)`, `Store.dropSend(key)`.
  - **Task 12's `/v1/` API**, in the wire format of plan.md's "Client API" table (Contracts): every op answer carries the node's `store` (null for the fleet's refusals before anything was sent), the lane registry has one row per name, and the fleet answers an op's deadline itself at `timeoutMs` (plus up to 1000 ms), counted from when it queued it.
- Produces:
  ```ts
  // apps/hub/src/adapters/fleet-client.ts
  export class FleetClient {
    constructor(socketPath: string);
    caps(): Promise<{ api: number[] }>;
    nodes(): Promise<FleetNode[]>;
    lanes(): Promise<FleetLane[]>;
    alerts(): Promise<Alert[]>;
    op<O extends OpName>(target: OpTarget, op: O, args: OpArgs[O], opts?: { key?: string; timeoutMs?: number }): Promise<OpAnswer<O>>;
    fileStream(node: string, refOrPath: string): AsyncIterable<Uint8Array>;
    events(on: (e: FleetEvent) => void): () => void;
  }
  export class FleetUnavailable extends Error { readonly reached: boolean }
  export class FleetMismatch extends Error {}
  export class FleetOpFailed extends Error { readonly error: OpError }
  export function checkFleet(client: FleetClient): Promise<"ok" | "unsupported" | "unreachable">;
  export type NodeStatus; export type FleetNode; export type FleetLane; export type FleetEvent; export type OpTarget;
  export type OpAnswer<O>;   // { ok: true; result; invVersion; store: string } | { ok: false; error; store: string | null }
  // every request carries `x-morndo-client: hub`
  // apps/hub/src/adapters/fleet-adapters.ts
  export function fleetPorts(client: FleetClient, o: { files: LocalFileStore | null; stagingDir: string; timeouts?: Partial<FleetTimeouts> }): FleetPorts;
  export type FleetPorts; export type FleetTimeouts; export const FLEET_TIMEOUTS; export type LocalFileStore;
  // apps/hub/src/application/ports.ts
  export type Terminal = Omit<PaneTerminal, "keys"> & { keys(id, data): Promise<boolean | "uncertain"> };
  export type HubPorts = { tmux; terminal: Terminal; sessions; transcripts; files; uploads; sendStatus: SendStatus | null; nodeStates: NodeStates | null };
  // apps/hub/src/adapters/local-ports.ts
  export function legacyPorts(config: Config, deps: { files: Pick<Files, "register"> }): HubPorts;   // sendStatus null, nodeStates null
  export function desktopTarget(config: Config, fleet: boolean): () => DesktopTarget | null;         // null with a fleet: no_desktop
  // apps/hub/src/adapters/store.ts, migrations.ts
  Store.send(key): { state; at; typedAt; store: string | null } | null;  Store.setSendStore(key, store): void;   // migration 10 (9 went to ask_first_seen during execution)
  // apps/hub/src/application/observation-service.ts (Step 14.29)
  fleet(): "ok" | "unavailable";  conflicted(id: string): boolean;  Listener.fleet?(status: "ok" | "unavailable"): void;
  // apps/hub/src/application/escalation-service.ts (Step 14.29)
  export function managerOf(workers: readonly { id; name; conflict? }[], managerName: string): string | null;
  Watch.workers(): { id; name; conflict?: boolean }[];  AnswerResult.problem gains "lane_conflict"
  // apps/hub/src/config.ts
  Config.fleetSocket?: string | null
  // apps/hub/src/application/steering-service.ts
  constructor(store, tmux, now, policy, inbox, waitingOn, nameOf, uploads, status: SendStatus | null = null)   // status appended last
  // apps/hub/test/helpers/fake-fleet.ts
  export function startFakeFleet(o: { nodes: FakeNode[]; api?: number[]; socketPath?: string }): Promise<FakeFleet>;   // FakeFleet.raise(alert), .clients
  export function localNode(name: string, server: string, backend: NodeBackend): FakeNode;   // FakeNode.store, .resetStore()
  export function memoryBackend(panes: Record<string, MemoryPane>, o?: {...}): MemoryBackend;
  export const LOST: Reply; export function refusal(code: ErrorCode, message?: string): Reply; export function until(f, ms?): Promise<void>;
  // apps/hub/test/helpers/hub-mode.ts
  export const HUB_MODES: HubMode[];                    // from MORNDO_HUB_MODES, default "legacy,fleet"
  export function portsFor(mode: HubMode, local: LocalPorts): Promise<ModePorts>;
  export function fleetRig(nodes: FakeNode[], o?: { files?: LocalFileStore; timeouts?: Partial<FleetTimeouts> }): Promise<FleetRig>;
  export function claudeDirPorts(dir: string): { sessions: Sessions; transcripts: TranscriptSource };
  export function observationFor(p: HubPorts, o): ObservationService;
  export function steeringFor(p: HubPorts, o): SteeringService;
  export function escalationsFor(p: HubPorts, o): EscalationService;   // o.ledger: the manager's list, when a suite needs one
  // LocalPorts.fileStore: the hub's own store for a fleet hub's copies (portsFor's fleet mode)
  ```

**Behaviour, in one place:**
- **Listing.** Every poll calls `GET /v1/lanes` and `GET /v1/nodes`, two Unix-socket requests. Inventory events keep each node's panes (cwd, session, window) current between polls.
  - The roster is every window of every node, from each node's inventory, each with its node: two windows of one name are both listed (round 2, item 4). `conflict` is the lane registry's flag for the name; the registry's one row per name never decides what is listed. A node the hub has no inventory of (offline since the hub started) is listed from the registry's rows.
  - A node's inventory is fetched again (`inventory.get`, every node at once) when it is missing, or when the registry and the cached inventory disagree (a worker id or window the cache lacks, or a cached window the registry doesn't name). The listing waits for each at most `LIMITS.inventoryWaitMs` (300 ms); a slower answer is applied when it lands, and the next listing has it (round 2, item 13). One refresh per node runs at a time, so a hung node is asked once.
  - Workers of a node that is not `online` stay listed, with `offline: true`.
  - **The fleet down.** A listing that fails (the fleet's socket gone or not answering) keeps the last roster, every worker offline, and `ObservationService.fleet()` says `"unavailable"` (once, to each listener) until a listing comes again; no node is asked meanwhile (round 2, item 12; spec §7). Task 15b shows it.
- **Names in conflict.** A send by worker id goes whatever the registry says of its name: the owner picked that pane. The manager is found by name only while its name isn't in conflict; meanwhile its asks come from the ledger alone, and an answer is refused `lane_conflict`, typed into neither window (round 2, item 4).
- **Captures.** One `pane.captureMany` per node, in parallel, chunked at 64 ids. A node the fleet doesn't call online is skipped at once (spec §3.1). Each op carries `timeoutMs: 1200`, so a slow node holds a poll at most that long.
- **Sends.** `pane.send` carries the key `hub:<caller's key>` and `expect: { server, window, sessionId? }` from the latest inventory.
  - The window and session are looked up once from the node when the worker isn't cached yet.
  - Refusals before the paste come back as problems. `node_offline` comes back as a problem as well.
  - `timeout` (with `executed: "no"`) becomes `busy`.
  - `executed: "maybe"` throws `SendInDoubt` with the store it went to, so SteeringService keeps the send in doubt and records that store with its row (migration 10; 9 went to `ask_first_seen` during execution). That first attempt is a 500 `{ error: "internal error" }` from the hub's send route, as any throw is today (a 409 `{ error: "uncertain" }` since the fix wave, final review I1); its repeat asks the node (`op.status`), and a repeat still in doubt is a 409 `{ error: "uncertain" }` (http.ts answers every refusal but `step_up` (403) and `no_pane` (404) with 409).
  - A request that never reached the fleet (`FleetUnavailable`, `reached: false`) is `node_offline`; one the fleet took and never answered is `SendInDoubt` with no store.
- **Keys** (`pane.keys`). They carry `expect: { server, window }` with **no** session: keys are typed while watching the screen, and a `/clear` typed a moment ago starts a new session. An answer that may have come after they were typed (`executed: "maybe"`, or the fleet took them and never answered) is `"uncertain"`, which the terminal socket sends as `keys_uncertain`, never as a refusal (round 2, item 25).
- **Transcripts.** A node that can't answer now (`node_offline`, `timeout`, `busy`, `uncertain`, `internal`, or the fleet not answering) is `SourceUnavailable`: the follow keeps its place (round 2, item 15). A refusal (`bad_args`, `denied`, `no_pane`) or a node no inventory names is null, a transcript that is gone.
- **Send status.** `op.status` answers `{ state: "done", typedAt }` (the node's own time, from the stored outcome) only when the stored outcome has `problem: null`. A paste recorded with a problem stays `started`, the same answer a local `started` row gives. `unknown` comes with the store that answered; SteeringService types anew only when that is the store its row recorded, and stays `uncertain` otherwise (round 2, item 5). Two repeats at once ask once and paste at most once (item 21).
- **Desktop.** With a fleet the desktop target is null, so the remote view answers `no_desktop` (spec §3.1; round 2, item 33).
- **Node states.** `nodeStates()` answers the fleet view's status of every node heard of; ObservationService skips a node that isn't `online` without asking it (Task 4).
- **Uploads.** `file.put` sends chunks of at most 256 KiB, keyed `hub:upload:<id>:<n>`. Each chunk is tried up to three times, and the key makes a repeat safe.
- **Files.** The hub asks `file.stat` first; an unchanged file isn't copied again. It then streams `GET /v1/files/<node>/<path>` into a staging file named as the original, hands it to the hub's own file store, and deletes the staging file.

- [ ] **Step 14.1: Write the fake fleet test helper**

This is test infrastructure. Every Task 14 and Task 15 test, and Tasks 17 and 18, use it.

Create `apps/hub/test/helpers/fake-fleet.ts`:

```ts
// A fake fleet service for the hub's tests (spec §9: "They run in both legacy and fleet configuration against a fake
// fleet"): the client API (/v1/, spec §5.6, in the wire format of plan.md § Contracts, "Client API") on a temporary
// Unix socket, with nodes made of the test's own ports. Each node keeps the agent's two-phase keys (spec §5.3: started
// before the side effect, done with the reply after, released on a refusal with executed "no"; a repeat of a done key
// gets the stored reply, of a started one "uncertain", and a key reused with other effect-determining arguments is
// "uncertain" too) and checks every expectation right before acting (spec §4), so the hub's fleet adapters meet the
// answers a real agent gives. Each node has a store (its agent database's id) that every answer carries; resetStore()
// is an agent database lost and made anew, its keys gone. The lane registry is the real one's (Task 12): one row per
// name, owned by the first node that claimed it, in conflict while two windows claim it (its workerId null when both are
// on the owner), and routing by a name in conflict is lane_conflict. A test can take a node offline, announce an
// inventory, and put itself in front of any op (to drop an answer after the paste, say). Synthetic data only.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { CLIENT_API, ERROR_EXECUTED, LIMITS, formatWorkerId, parseWorkerId, type Alert, type ErrorCode, type OpError, type Pane } from "@morndo/protocol";
import type { SendProblem, SessionInfo, Terminal } from "@morndo/node-ops";
import type { Sessions, Tmux, TranscriptSource } from "../../src/application/ports.ts";

export type NodeStatus = "online" | "stale" | "offline";
export type Reply = { ok: true; result: unknown } | { ok: false; error: OpError };
export type FleetCall = { op: string; node: string | null; target: Record<string, string>; args: unknown; key: string | null; timeoutMs: number | null };
export type Intercept = (call: FleetCall, next: () => Promise<Reply>) => Promise<Reply>;

export const refusal = (code: ErrorCode, message: string = code): Reply => ({ ok: false, error: { code, executed: ERROR_EXECUTED[code], message } });
// The fleet's answer when the connection to the node dropped while an op was out: it may or may not have happened.
export const LOST: Reply = refusal("uncertain", "the connection to the node dropped");

export async function until(f: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error(`not within ${ms} ms`);
    await new Promise(r => setTimeout(r, 20));
  }
}

// One node's machine as the legacy hub sees it: its ports keyed by tmux pane ids ("%1"). The node names those panes
// `<node>.<server>.<pane>` on the wire.
export type NodeBackend = {
  tmux: Tmux;
  terminal?: Terminal;
  sessions?: Sessions;
  transcripts?: TranscriptSource;
  readFile?: (path: string) => Promise<{ bytes: Uint8Array; mtime: number } | null>;
  inboxDir?: string;
};
export type KeyRow = { state: "started" | "done"; hash: string; reply?: Reply };
export type FakeNode = {
  readonly name: string;
  readonly server: string;
  readonly keys: Map<string, KeyRow>;                       // the agent's done keys, for a test to look at
  readonly store: string;                                   // its agent database's id, on every answer
  resetStore(): void;                                       // the agent database lost: a new store, no keys
  inventory(): Promise<{ panes: Pane[]; invVersion: number }>;
  invVersion(): number;
  handle(op: string, args: unknown, key: string | null): Promise<Reply>;
  file(refOrPath: string): Promise<Uint8Array | null>;
};

const BEFORE_PASTE = new Set<string>(["no_pane", "menu_open", "no_input_box", "draft_present", "busy"] satisfies SendProblem[]);
const ok = (result: unknown): Reply => ({ ok: true, result });

// What decides a keyed op's effect (plan.md, "Behaviour"): never its expectation, its deadline or its request id.
function effectOf(op: string, a: Record<string, unknown>): unknown[] {
  switch (op) {
    case "pane.send": return [op, a.workerId, a.text];
    case "file.put": return [op, a.upload, a.offset];
    case "lane.start": return [op, a.name, a.cwd, a.account, a.resume];
    case "lane.stop": return [op, a.name];
    case "worktree.add": return [op, a.repo, a.name, a.base];
    default: return [op, a];
  }
}

export function localNode(name: string, server: string, b: NodeBackend): FakeNode {
  const keys = new Map<string, KeyRow>();
  let store = randomUUID();
  const uploads = new Map<string, Buffer[]>();
  let version = 0;
  let last = "";
  const idOf = (pane: string) => {
    const n = /^%(\d{1,9})$/.exec(pane)?.[1];
    return n === undefined ? null : formatWorkerId({ node: name, server, pane: Number(n) });
  };
  // The tmux pane a worker id names on this node, or null: another node, another tmux server, or not a worker id.
  const paneOf = (workerId: string) => {
    const ref = parseWorkerId(workerId);
    return ref && ref.node === name && ref.server === server ? `%${ref.pane}` : null;
  };

  async function inventory(): Promise<{ panes: Pane[]; invVersion: number }> {
    const workers = await b.tmux.listWorkers();
    const sessions = b.sessions ? await b.sessions.byPane() : new Map<string, SessionInfo>();
    const panes: Pane[] = workers.flatMap(w => {
      const workerId = idOf(w.id);
      if (workerId === null) return [];
      const s = sessions.get(w.id);
      return [{
        workerId, window: w.name, cwd: s?.cwd || w.location,
        ...(s ? { sessionId: s.sessionId } : {}), ...(s?.name ? { title: s.name } : {}), ...(s?.version ? { claudeVersion: s.version } : {}),
      }];
    });
    const now = JSON.stringify(panes);
    if (now !== last) { last = now; version++; }
    return { panes, invVersion: version };
  }

  // The agent's check right before acting (spec §4): the same tmux server, the window still named so, and the same
  // session when one is named. Any mismatch is null ("no_pane", nothing done).
  async function expected(workerId: string, expect: unknown): Promise<string | null> {
    const pane = paneOf(workerId);
    const e = (typeof expect === "object" && expect !== null ? expect : {}) as { server?: unknown; window?: unknown; sessionId?: unknown };
    if (pane === null || e.server !== server) return null;
    const p = (await inventory()).panes.find(x => x.workerId === workerId);
    if (!p || p.window !== e.window) return null;
    if (e.sessionId !== undefined && p.sessionId !== e.sessionId) return null;
    return pane;
  }

  async function keyed(key: string | null, op: string, args: unknown, run: () => Promise<Reply>): Promise<Reply> {
    if (key === null) return run();
    const hash = JSON.stringify(effectOf(op, (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>));
    const known = keys.get(key);
    if (known) {
      if (known.hash !== hash) return refusal("uncertain", "this key was used for another request, which may have run");
      return known.state === "done" && known.reply ? known.reply : refusal("uncertain", "started and never finished");
    }
    keys.set(key, { state: "started", hash });
    let reply: Reply;
    try { reply = await run(); }
    catch (e) { return refusal("internal", (e as Error).message); }        // the key stays started: it may have happened
    if (!reply.ok && reply.error.executed === "no") keys.delete(key);
    else keys.set(key, { state: "done", hash, reply });
    return reply;
  }

  async function handle(op: string, args: unknown, key: string | null): Promise<Reply> {
    const a = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
    const str = (k: string) => { const v = a[k]; return typeof v === "string" ? v : ""; };
    const num = (k: string) => { const v = a[k]; return typeof v === "number" ? v : 0; };
    switch (op) {
      case "inventory.get":
        return ok(await inventory());
      case "pane.captureMany": {
        const ids = Array.isArray(a.workerIds) ? a.workerIds.filter((x): x is string => typeof x === "string") : [];
        if (ids.length > LIMITS.captureManyMax) return refusal("too_large");
        const panes = ids.map(paneOf);
        const texts = await b.tmux.captureMany(panes.filter((p): p is string => p !== null));
        return ok({ captures: ids.map((workerId, i) => { const p = panes[i]; return { workerId, text: p ? texts.get(p) ?? null : null, truncated: false }; }) });
      }
      case "pane.frame": {
        const p = paneOf(str("workerId"));
        return ok({ frame: p !== null && b.terminal ? await b.terminal.frame(p) : null });
      }
      case "pane.keys": {
        const p = await expected(str("workerId"), a.expect);
        if (p === null) return refusal("no_pane");
        return ok({ ok: b.terminal ? await b.terminal.keys(p, str("data")) : false });
      }
      case "pane.send":
        return keyed(key, op, args, async () => {
          const p = await expected(str("workerId"), a.expect);
          if (p === null) return refusal("no_pane");
          const out = await b.tmux.send(p, str("text"), key ?? "");
          if (out.problem !== null && BEFORE_PASTE.has(out.problem)) return refusal(out.problem as ErrorCode);
          if (out.problem === "node_offline") return refusal("node_offline");
          return ok({ problem: out.problem, typedAt: out.typedAt });
        });
      case "op.status": {
        const k = keys.get(str("key"));
        if (!k) return ok({ state: "unknown" });
        return ok(k.state === "done" && k.reply ? { state: "done", outcome: k.reply.ok ? k.reply.result : k.reply.error } : { state: "started" });
      }
      case "transcript.size":
        return ok({ size: b.transcripts ? await b.transcripts.size(str("sessionId")) : null });
      case "transcript.read": {
        const r = b.transcripts ? await b.transcripts.read(str("sessionId"), num("offset"), Math.min(num("max"), LIMITS.chunkBytes)) : null;
        return r ? ok({ bytes: Buffer.from(r.bytes).toString("base64"), eof: r.eof }) : refusal("bad_args", "no such transcript");
      }
      case "transcript.locate":
        return ok({ offset: b.transcripts ? await b.transcripts.locate(str("sessionId"), str("needle")) : null });
      case "file.stat": {
        const f = b.readFile ? await b.readFile(str("path")) : null;
        return f ? ok({ size: f.bytes.length, mtime: f.mtime }) : refusal("denied", "not readable");
      }
      case "file.put":
        return keyed(key, op, args, async () => {
          if (b.inboxDir === undefined) return refusal("denied", "no inbox on this node");
          const id = str("upload");
          const parts = uploads.get(id) ?? [];
          const have = parts.reduce((n, p) => n + p.length, 0);
          if (num("offset") !== have) return refusal("bad_args", "a chunk out of order");
          const chunk = Buffer.from(str("bytes"), "base64");
          if (have + chunk.length > LIMITS.maxFileBytes) { uploads.delete(id); return refusal("too_large"); }
          parts.push(chunk);
          if (a.final !== true) { uploads.set(id, parts); return ok({ path: null }); }
          uploads.delete(id);
          mkdirSync(b.inboxDir, { recursive: true });
          const path = join(b.inboxDir, `${id}-${basename(str("name"))}`);
          writeFileSync(path, Buffer.concat(parts));
          return ok({ path });
        });
      default:
        return refusal("unknown_op", op);
    }
  }

  return {
    name, server, keys, inventory, handle,
    get store() { return store; },
    resetStore() { store = randomUUID(); keys.clear(); },
    invVersion: () => version,
    file: async refOrPath => (b.readFile ? (await b.readFile(refOrPath))?.bytes ?? null : null),
  };
}

// A node's machine in memory: panes by tmux id with a window name, a cwd, a screen and maybe a session; what was typed
// into them; transcripts by session and files by path. `problem` makes sends to that pane come back so (a refusal before
// the paste, or "not_submitted" after it). `hold()` makes the next send wait in the pane after its paste until released.
export type MemoryPane = { name: string; cwd: string; screen: string; sessionId?: string; problem?: SendProblem | null };
export type MemoryBackend = NodeBackend & {
  panes: Record<string, MemoryPane>;
  typed: { pane: string; text: string; key: string }[];
  keysTyped: { pane: string; data: string }[];
  typedAt: number | null;                                   // the node's clock for typedAt; null: Date.now()
  hold(): () => void;
};
export function memoryBackend(
  panes: Record<string, MemoryPane>,
  o: { inboxDir?: string; files?: Record<string, Uint8Array>; transcripts?: Record<string, Uint8Array> } = {},
): MemoryBackend {
  let held: Promise<void> | null = null;
  const transcriptOf = (sessionId: string) => o.transcripts?.[sessionId] ?? null;
  const b: MemoryBackend = {
    panes, typed: [], keysTyped: [], typedAt: null,
    hold() {
      let release = () => {};
      held = new Promise<void>(r => { release = r; });
      return () => release();
    },
    tmux: {
      listWorkers: async () => Object.entries(b.panes).map(([id, p]) => ({ id, name: p.name, location: p.cwd, node: "local", offline: false })),
      capture: async id => b.panes[id]?.screen ?? null,
      captureMany: async ids => new Map(ids.map(id => [id, b.panes[id]?.screen ?? null])),
      send: async (id, text, key) => {
        const p = b.panes[id];
        if (!p) return { problem: "no_pane", typedAt: 0 };
        if (p.problem && p.problem !== "not_submitted") return { problem: p.problem, typedAt: 0 };
        b.typed.push({ pane: id, text, key });
        const wait = held;
        held = null;
        if (wait) await wait;
        return { problem: p.problem ?? null, typedAt: b.typedAt ?? Date.now() };
      },
    },
    terminal: {
      frame: async id => {
        const p = b.panes[id];
        if (!p) return null;
        const lines = p.screen.split("\n");
        return { cols: 80, rows: lines.length, x: 0, y: 0, cursor: true, lines };
      },
      keys: async (id, data) => {
        if (!b.panes[id]) return false;
        b.keysTyped.push({ pane: id, data });
        return true;
      },
    },
    sessions: {
      byPane: async () => {
        const out = new Map<string, SessionInfo>();
        for (const [id, p] of Object.entries(b.panes)) {
          if (p.sessionId !== undefined) out.set(id, { sessionId: p.sessionId, name: null, pane: id, cwd: p.cwd, version: null, pid: 1 });
        }
        return out;
      },
    },
    transcripts: {
      size: async sessionId => transcriptOf(sessionId)?.length ?? null,
      read: async (sessionId, offset, max) => {
        const t = transcriptOf(sessionId);
        return t ? { bytes: t.subarray(offset, offset + max), eof: offset + max >= t.length } : null;
      },
      locate: async (sessionId, needle) => {
        const t = transcriptOf(sessionId);
        if (!t) return null;
        const at = Buffer.from(t).indexOf(needle);
        return at === -1 ? null : at;
      },
    },
    readFile: async path => {
      const f = o.files?.[path];
      return f ? { bytes: f, mtime: 1 } : null;
    },
    ...(o.inboxDir !== undefined ? { inboxDir: o.inboxDir } : {}),
  };
  return b;
}

export type FakeFleet = {
  readonly socketPath: string;
  readonly calls: FleetCall[];                              // every POST /v1/op, in order
  readonly clients: string[];                               // the x-morndo-client header of every request, in order
  readonly fileReads: string[];                             // "<node>:<path>" of every GET /v1/files
  node(name: string): FakeNode;
  setStatus(node: string, status: NodeStatus): Promise<void>;
  announce(node: string): Promise<void>;                    // an inventory event with the node's panes now
  raise(alert: Alert): void;                                // served by GET /v1/alerts from now on, and sent as an event
  intercept(op: string, f: Intercept | null): void;
  close(): Promise<void>;
};

// A file the fleet refuses before its first byte (plan.md, "Client API"): the status for the node's error code.
const FILE_STATUS: Partial<Record<ErrorCode, number>> = { bad_args: 400, denied: 403, too_large: 413, node_offline: 503, timeout: 504, uncertain: 502, internal: 502 };

export async function startFakeFleet(o: { nodes: FakeNode[]; api?: number[]; socketPath?: string }): Promise<FakeFleet> {
  const dir = o.socketPath === undefined ? mkdtempSync(join(tmpdir(), "mf-")) : null;
  const socketPath = o.socketPath ?? join(dir ?? "", "fleet.sock");
  const nodes = new Map(o.nodes.map(n => [n.name, n]));
  const status = new Map<string, NodeStatus>(o.nodes.map(n => [n.name, "online"]));
  const lastPanes = new Map<string, Pane[]>();
  const calls: FleetCall[] = [];
  const clients: string[] = [];
  const fileReads: string[] = [];
  const owners = new Map<string, string>();                 // lane name → the node that registered it first
  const intercepts = new Map<string, Intercept>();
  const subscribers = new Set<WebSocket>();
  const alerts: Alert[] = [];

  const inventoryOf = async (name: string): Promise<{ panes: Pane[]; invVersion: number }> => {
    const n = nodes.get(name);
    if (!n) return { panes: [], invVersion: 0 };
    if (status.get(name) !== "online") return { panes: lastPanes.get(name) ?? [], invVersion: n.invVersion() };
    const inv = await n.inventory();
    lastPanes.set(name, inv.panes);
    return inv;
  };
  // The lane registry (spec §4, as Task 12's): one row per name, from every node's windows (the last ones known for a
  // node that isn't online). A name belongs to the first node that claimed it and stays its owner while it claims it; a
  // name two windows claim is in conflict, and its workerId is null when both are on the owner.
  async function lanes(): Promise<{ name: string; node: string; workerId: string | null; conflict: boolean }[]> {
    const claims = (await Promise.all([...nodes.keys()].map(async node =>
      (await inventoryOf(node)).panes.map(p => ({ name: p.window, node, workerId: p.workerId }))))).flat();
    const names = [...new Set(claims.map(c => c.name))].sort();
    for (const name of [...owners.keys()]) if (!names.includes(name)) owners.delete(name);
    return names.map(name => {
      const mine = claims.filter(c => c.name === name);
      const owner = mine.some(c => c.node === owners.get(name)) ? owners.get(name) ?? "" : mine[0]?.node ?? "";
      owners.set(name, owner);
      const owned = mine.filter(c => c.node === owner);
      return { name, node: owner, workerId: owned.length === 1 ? owned[0]?.workerId ?? null : null, conflict: mine.length > 1 };
    });
  }
  // `store`: the node's store at the moment the request went out; null for the fleet's own refusals before that.
  async function op(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const target: Record<string, string> = {};
    for (const k of ["workerId", "node", "lane"] as const) { const v = body[k]; if (typeof v === "string") target[k] = v; }
    let args = body.args;
    let name = target.node ?? (target.workerId !== undefined ? parseWorkerId(target.workerId)?.node : undefined) ?? null;
    let refused: Reply | null = null;
    if (target.lane !== undefined) {
      const lane = (await lanes()).find(l => l.name === target.lane);
      if (!lane) refused = refusal("no_pane", "no such lane");
      else if (lane.conflict || lane.workerId === null) refused = refusal("lane_conflict", "two windows claim this lane");
      else {
        name = lane.node;
        const a = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
        const owner = nodes.get(lane.node);
        if ((body.op === "pane.send" || body.op === "pane.keys") && a.expect === undefined && owner) {
          args = { ...a, workerId: a.workerId ?? lane.workerId, expect: { server: owner.server, window: lane.name } };
        }
      }
    }
    const call: FleetCall = {
      op: String(body.op), node: name, target, args,
      key: typeof body.key === "string" ? body.key : null, timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : null,
    };
    calls.push(call);
    if (refused) return { ...refused, store: null };
    const n = name === null ? undefined : nodes.get(name);
    if (!n || name === null) return { ...refusal("no_pane", "no such node"), store: null };
    if (status.get(name) !== "online") return { ...refusal("node_offline", "the node is not online"), store: null };
    const store = n.store;
    const next = () => n.handle(call.op, call.args, call.key);
    const f = intercepts.get(call.op);
    return { ...(f ? await f(call, next) : await next()), invVersion: n.invVersion(), store };
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://fleet");
    clients.push(String(req.headers["x-morndo-client"] ?? ""));
    const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && url.pathname === "/v1/caps") return json(200, { api: o.api ?? [CLIENT_API] });
    if (req.method === "GET" && url.pathname === "/v1/nodes") {
      return json(200, [...nodes.keys()].map(name => ({ name, status: status.get(name) ?? "offline", health: null, agent: "fake" })));
    }
    if (req.method === "GET" && url.pathname === "/v1/lanes") return json(200, await lanes());
    if (req.method === "GET" && url.pathname === "/v1/alerts") return json(200, alerts);
    if (req.method === "POST" && url.pathname === "/v1/op") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      return json(200, await op(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>));
    }
    const file = /^\/v1\/files\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && file) {
      const name = decodeURIComponent(file[1] ?? "");
      const path = decodeURIComponent(file[2] ?? "");
      fileReads.push(`${name}:${path}`);
      const refuse = (r: Reply) => json(r.ok ? 500 : FILE_STATUS[r.error.code] ?? 404, r);
      const n = nodes.get(name);
      if (!n || status.get(name) !== "online") return refuse(refusal("node_offline"));
      const bytes = await n.file(path);
      if (!bytes) return refuse(refusal("denied", "not readable"));
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(bytes.length) });
      for (let i = 0; i < bytes.length; i += 65_536) res.write(bytes.subarray(i, i + 65_536));
      return res.end();
    }
    return json(404, { error: "no such route" });
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
  });
  const wss = new WebSocketServer({ noServer: true });
  const send = (ws: WebSocket, e: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(e)); };
  const broadcast = (e: unknown) => { for (const ws of subscribers) send(ws, e); };
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url ?? "/", "http://fleet").pathname !== "/v1/events") { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      subscribers.add(ws);
      ws.on("close", () => subscribers.delete(ws));
      ws.on("error", () => {});
      // State first, as the fleet does (spec §5.4, ADR-0012 "State over events"): every node's status, every online
      // node's inventory.
      void (async () => {
        try {
          for (const name of nodes.keys()) {
            send(ws, { t: "status", node: name, body: { status: status.get(name) } });
            if (status.get(name) === "online") send(ws, { t: "inventory", node: name, body: await inventoryOf(name) });
          }
        } catch { /* a node's backend failed: the test sees it elsewhere */ }
      })();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, () => resolve()); });

  return {
    socketPath, calls, clients, fileReads,
    node(name) {
      const n = nodes.get(name);
      if (!n) throw new Error(`no node ${name}`);
      return n;
    },
    async setStatus(name, s) {
      status.set(name, s);
      broadcast({ t: "status", node: name, body: { status: s } });
      if (s === "online") broadcast({ t: "inventory", node: name, body: await inventoryOf(name) });
    },
    async announce(name) { broadcast({ t: "inventory", node: name, body: await inventoryOf(name) }); },
    raise(alert) { alerts.push(alert); broadcast({ t: "alert", node: alert.node ?? "", body: alert }); },
    intercept(opName, f) { if (f) intercepts.set(opName, f); else intercepts.delete(opName); },
    async close() {
      for (const ws of subscribers) ws.terminate();
      wss.close();
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      if (dir !== null) rmSync(dir, { recursive: true, force: true });
      else rmSync(socketPath, { force: true });
    },
  };
}
```

- [ ] **Step 14.2: Write the failing fleet client test**

Create `apps/hub/test/fleet-client.test.ts`:

```ts
// The hub's fleet client (spec §5.6) against the fake fleet on a real Unix socket: capabilities, nodes, lanes and
// alerts, an op's body and its answers (each with the store of the node that answered, none for the fleet's own
// refusals), routing by a lane's name, a file streamed in chunks, events and their reconnect after the fleet restarts,
// and the ways the fleet can fail to be one: never reached (nothing can have happened), reached without an answer in
// time (it may have), and an answer that isn't the client API. Every request names its client.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Alert } from "@morndo/protocol";
import { FleetClient, FleetMismatch, FleetOpFailed, FleetUnavailable, checkFleet, type FleetEvent } from "../src/adapters/fleet-client.ts";
import { localNode, memoryBackend, startFakeFleet, until, type FakeFleet } from "./helpers/fake-fleet.ts";

const PC1 = "pc.aaaaaaaa.1";
const NOTES = Buffer.from("n".repeat(300_000));
let dir: string;
let fleet: FakeFleet;
let stops: (() => void)[] = [];
const pcNode = () => localNode("pc", "aaaaaaaa", memoryBackend({ "%1": { name: "alpha", cwd: "/w/alpha", screen: "$ " } }, { files: { "/w/alpha/notes.txt": NOTES } }));

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "morndo-fleet-client-"));
  fleet = await startFakeFleet({ nodes: [pcNode()], socketPath: join(dir, "fleet.sock") });
});
afterEach(async () => {
  for (const stop of stops) stop();
  stops = [];
  await fleet.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the fleet client (spec §5.6)", () => {
  it("reads the capabilities, the nodes and the lanes", async () => {
    const c = new FleetClient(fleet.socketPath);
    expect(await c.caps()).toEqual({ api: [1] });
    expect(await checkFleet(c)).toBe("ok");
    expect(await c.nodes()).toEqual([{ name: "pc", status: "online", health: null, agent: "fake" }]);
    expect(await c.lanes()).toEqual([{ name: "alpha", node: "pc", workerId: PC1, conflict: false }]);
    expect(fleet.clients.length).toBeGreaterThan(0);
    expect(new Set(fleet.clients)).toEqual(new Set(["hub"]));                        // x-morndo-client, for the fleet's audit
  });

  it("posts an op with its target, args, key and deadline, and returns the node's answer", async () => {
    const c = new FleetClient(fleet.socketPath);
    const r = await c.op({ node: "pc" }, "pane.captureMany", { workerIds: [PC1] }, { timeoutMs: 1500 });
    expect(r).toEqual({ ok: true, result: { captures: [{ workerId: PC1, text: "$ ", truncated: false }] }, invVersion: expect.any(Number), store: fleet.node("pc").store });
    const sent = await c.op({ workerId: PC1 }, "pane.send", { workerId: PC1, text: "hi", expect: { server: "aaaaaaaa", window: "alpha" } }, { key: "hub:k1" });
    expect(sent).toMatchObject({ ok: true, result: { problem: null } });
    expect(fleet.calls).toEqual([
      { op: "pane.captureMany", node: "pc", target: { node: "pc" }, args: { workerIds: [PC1] }, key: null, timeoutMs: 1500 },
      { op: "pane.send", node: "pc", target: { workerId: PC1 }, args: { workerId: PC1, text: "hi", expect: { server: "aaaaaaaa", window: "alpha" } }, key: "hub:k1", timeoutMs: 5000 },
    ]);
  });

  it("passes the fleet's refusals through as they are", async () => {
    const c = new FleetClient(fleet.socketPath);
    expect(await c.op({ node: "nowhere" }, "inventory.get", {})).toEqual({ ok: false, error: { code: "no_pane", executed: "no", message: "no such node" }, store: null });
    await fleet.setStatus("pc", "offline");
    expect(await c.op({ node: "pc" }, "inventory.get", {})).toEqual({ ok: false, error: { code: "node_offline", executed: "no", message: "the node is not online" }, store: null });
  });

  it("routes by a lane's name; a name two windows claim is one registry row, in conflict, and routing by it is lane_conflict", async () => {
    const c = new FleetClient(fleet.socketPath);
    const sent = await c.op({ lane: "alpha" }, "pane.send", { workerId: PC1, text: "by name", expect: { server: "aaaaaaaa", window: "alpha" } }, { key: "hub:k-lane" });
    expect(sent).toMatchObject({ ok: true, store: fleet.node("pc").store });
    await fleet.close();
    const twice = memoryBackend({ "%1": { name: "alpha", cwd: "/w/a", screen: "$ " }, "%2": { name: "alpha", cwd: "/w/b", screen: "$ " } });
    fleet = await startFakeFleet({ nodes: [localNode("pc", "aaaaaaaa", twice)], socketPath: join(dir, "fleet.sock") });
    expect(await c.lanes()).toEqual([{ name: "alpha", node: "pc", workerId: null, conflict: true }]);
    expect(await c.op({ lane: "alpha" }, "pane.send", { workerId: PC1, text: "never", expect: { server: "aaaaaaaa", window: "alpha" } }, { key: "hub:k-c" }))
      .toEqual({ ok: false, error: { code: "lane_conflict", executed: "no", message: "two windows claim this lane" }, store: null });
    expect(twice.typed).toEqual([]);
  });

  it("streams a file in chunks; a file the node refuses is FleetOpFailed with the node's reason", async () => {
    const c = new FleetClient(fleet.socketPath);
    const chunks: Uint8Array[] = [];
    for await (const chunk of c.fileStream("pc", "/w/alpha/notes.txt")) chunks.push(chunk);
    expect(Buffer.concat(chunks).equals(NOTES)).toBe(true);
    expect(chunks.length).toBeGreaterThan(1);
    const refused = await (async () => { for await (const chunk of c.fileStream("pc", "/etc/shadow")) chunks.push(chunk); })().catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(FleetOpFailed);
    expect((refused as FleetOpFailed).error).toEqual({ code: "denied", executed: "no", message: "not readable" });
    await fleet.setStatus("pc", "offline");
    const offline = await (async () => { for await (const chunk of c.fileStream("pc", "/w/alpha/notes.txt")) chunks.push(chunk); })().catch((e: unknown) => e);
    expect((offline as FleetOpFailed).error).toEqual({ code: "node_offline", executed: "no", message: "node_offline" });
  });

  it("reads the alerts, oldest first, and gets each new one as an event", async () => {
    const c = new FleetClient(fleet.socketPath);
    expect(await c.alerts()).toEqual([]);
    const seen: FleetEvent[] = [];
    stops.push(c.events(e => seen.push(e)));
    await until(() => seen.some(e => e.t === "status"));
    const first: Alert = { id: 1, at: 1_791_000_000_000, node: "pc", kind: "clock_offset", detail: { offsetMs: 2500 } };
    const second: Alert = { id: 2, at: 1_791_000_000_500, node: null, kind: "backlog_full", detail: { subscriber: "lanes", cap: 50_000, droppedProgress: 12, deadLettered: 0 } };
    fleet.raise(first);
    fleet.raise(second);
    expect(await c.alerts()).toEqual([first, second]);
    await until(() => seen.filter(e => e.t === "alert").length === 2);
    expect(seen.filter(e => e.t === "alert")).toEqual([{ t: "alert", node: "pc", body: first }, { t: "alert", node: "", body: second }]);
  });

  it("delivers events, the state first, and subscribes again after the fleet restarts", async () => {
    const c = new FleetClient(fleet.socketPath);
    const seen: FleetEvent[] = [];
    stops.push(c.events(e => seen.push(e)));
    await until(() => seen.some(e => e.t === "inventory" && e.node === "pc"));
    expect(seen[0]).toEqual({ t: "status", node: "pc", body: { status: "online" } });
    await fleet.close();
    seen.length = 0;
    fleet = await startFakeFleet({ nodes: [pcNode()], socketPath: join(dir, "fleet.sock") });
    await until(() => seen.some(e => e.t === "status" && e.node === "pc"), 10_000);
  });

  it("no socket: unavailable without having reached the fleet, so nothing can have happened", async () => {
    const none = new FleetClient(join(dir, "missing.sock"));
    const e = await none.nodes().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(FleetUnavailable);
    expect((e as FleetUnavailable).reached).toBe(false);
    expect(await checkFleet(none)).toBe("unreachable");
    const tooLong = await new FleetClient(join(dir, `${"x".repeat(120)}.sock`)).nodes().catch((x: unknown) => x);   // over the path limit
    expect((tooLong as FleetUnavailable).reached).toBe(false);
  });

  it("an op the fleet doesn't answer in time: unavailable, reached (it may have happened)", async () => {
    fleet.intercept("pane.send", () => new Promise(() => {}));
    const c = new FleetClient(fleet.socketPath);
    const e = await c.op({ workerId: PC1 }, "pane.send", { workerId: PC1, text: "hi", expect: { server: "aaaaaaaa", window: "alpha" } }, { key: "hub:k2", timeoutMs: 100 })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(FleetUnavailable);
    expect((e as FleetUnavailable).reached).toBe(true);
  });

  it("a server that isn't the fleet's client API is a mismatch; a fleet without this API version is unsupported", async () => {
    const strangerPath = join(dir, "stranger.sock");
    const stranger = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html></html>"); });
    await new Promise<void>(resolve => stranger.listen(strangerPath, () => resolve()));
    try {
      const c = new FleetClient(strangerPath);
      await expect(c.caps()).rejects.toBeInstanceOf(FleetMismatch);
      expect(await checkFleet(c)).toBe("unsupported");
    } finally {
      await new Promise<void>(resolve => stranger.close(() => resolve()));
    }
    await fleet.close();
    fleet = await startFakeFleet({ nodes: [], api: [2, 3], socketPath: join(dir, "fleet.sock") });
    expect(await checkFleet(new FleetClient(fleet.socketPath))).toBe("unsupported");
  });
});
```

- [ ] **Step 14.3: Run it and see it fail**

Run: `npx vitest run apps/hub/test/fleet-client.test.ts`
Expected: FAIL. The suite errors with `Error: Cannot find module '../src/adapters/fleet-client.ts' imported from …/apps/hub/test/fleet-client.test.ts`, and no tests run.

- [ ] **Step 14.4: Implement the fleet client**

Create `apps/hub/src/adapters/fleet-client.ts`:

```ts
// The hub's client of the fleet service's client API (ADR-0012; docs/design/fleet-core/README.md §5.6; the wire format
// in plan.md § Contracts, "Client API"): HTTP and one WebSocket over the fleet's Unix socket.
// - Requests use node:http with `socketPath` ("Unix domain socket. Cannot be used if one of host or port is specified",
//   https://nodejs.org/docs/latest-v24.x/api/http.html#httprequestoptions-callback, read 2026-10-06) and `agent: false`
//   ("causes a new Agent with default values to be used", same page): a new connection per request, because a kept-alive
//   socket the fleet closed while idle fails a request after it was written, and a send would be in doubt for nothing.
// - Events use ws's IPC URL `ws+unix:<socket path>:<request path>` ("The character `:` is the separator between the IPC
//   path (the UNIX domain socket path or the Windows named pipe) and the URL path",
//   https://github.com/websockets/ws/blob/master/doc/ws.md#ipc-connections, read 2026-10-06), and reconnect with backoff.
// Every answer is checked for shape: one that isn't the client API is the fleet's fault and is never guessed at. Every
// request names this client (`x-morndo-client: hub`), which the fleet's audit records with each op it sends to a node.
import { request, type IncomingMessage } from "node:http";
import { WebSocket } from "ws";
import { CLIENT_API, type Alert, type AlertKind, type ErrorCode, type Health, type OpArgs, type OpError, type OpName, type OpResult } from "@morndo/protocol";
import type { NodeState } from "../application/ports.ts";
import { log } from "./log.ts";

export type NodeStatus = NodeState;                     // "online" | "stale" | "offline"
export type FleetNode = { name: string; status: NodeStatus; health: Health | null; agent: string | null };
export type FleetLane = { name: string; node: string; workerId: string | null; conflict: boolean };
// `alert`: its body is an Alert, and `node` is the alert's node or "".
export type FleetEvent = { t: "inventory" | "health" | "status" | "conflict" | "alert"; node: string; body: unknown };
export type OpTarget = { workerId: string } | { node: string } | { lane: string };
// `store`: the store of the node that answered (the agent database its keys live in, plan.md "Behaviour"); null on a
// refusal made before anything was sent to a node.
export type OpAnswer<O extends OpName> = { ok: true; result: OpResult[O]; invVersion: number; store: string }
  | { ok: false; error: OpError; store: string | null };

// The fleet couldn't be asked, or didn't answer in time. `reached` is false when the request never left this process
// (no socket there, refused, no permission): nothing can have been done. True otherwise: it may have been.
export class FleetUnavailable extends Error {
  readonly reached: boolean;
  constructor(message: string, reached: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = "FleetUnavailable";
    this.reached = reached;
  }
}
// The socket answered, but not as the client API does (another service there, or a fleet of another version).
export class FleetMismatch extends Error {
  constructor(message: string) { super(message); this.name = "FleetMismatch"; }
}
// An op the fleet refused, or answered "maybe" for, where the caller can't go on with a plain value: the node's error.
export class FleetOpFailed extends Error {
  readonly error: OpError;
  constructor(op: string, error: OpError) {
    super(`${op}: ${error.code}: ${error.message}`);
    this.name = "FleetOpFailed";
    this.error = error;
  }
}

// The connect itself failed, so nothing was sent. EINVAL: a socket path over the system's limit (104 bytes on macOS).
const NOT_SENT = new Set(["ENOENT", "ECONNREFUSED", "EACCES", "ENOTDIR", "ENOTSOCK", "EINVAL", "ENAMETOOLONG"]);
const MAX_ANSWER_BYTES = 8 << 20;           // the largest JSON answer read: every node's lanes, say
const DEFAULT_TIMEOUT_MS = 5000;
// The fleet answers an op's deadline itself (`timeout`, counted from when it queued the op); the client waits that long
// plus this, so a slow node is the fleet's `timeout`, and only a fleet that doesn't answer at all is FleetUnavailable.
const ANSWER_SLACK_MS = 2000;
const CLIENT = { "x-morndo-client": "hub" };
const FILE_IDLE_MS = 30_000;
const RECONNECT_MS = [1000, 2000, 5000, 10_000, 30_000] as const;
const STATUSES = new Set<string>(["online", "stale", "offline"]);
const EVENTS = new Set<string>(["inventory", "health", "status", "conflict", "alert"]);
const ERROR_CODES = new Set<string>(["bad_args", "unknown_op", "denied", "no_pane", "menu_open", "no_input_box", "draft_present", "busy",
  "name_taken", "lane_conflict", "too_large", "timeout", "node_offline", "uncertain", "internal"] satisfies ErrorCode[]);
const ALERT_KINDS = new Set<string>(["instance_conflict", "source_changed", "clock_offset", "rate_limited", "lane_conflict", "dead_letter",
  "backlog_full"] satisfies AlertKind[]);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isOpError = (v: unknown): v is OpError =>
  isRecord(v) && typeof v.code === "string" && ERROR_CODES.has(v.code) && (v.executed === "no" || v.executed === "maybe") && typeof v.message === "string";
const isNode = (v: unknown): v is FleetNode =>
  isRecord(v) && typeof v.name === "string" && typeof v.status === "string" && STATUSES.has(v.status)
  && (v.health === null || isRecord(v.health)) && (v.agent === null || typeof v.agent === "string");
const isLane = (v: unknown): v is FleetLane =>
  isRecord(v) && typeof v.name === "string" && typeof v.node === "string" && (v.workerId === null || typeof v.workerId === "string")
  && typeof v.conflict === "boolean";
// An alert's shape; its kind may be one a newer fleet added.
const isAlert = (v: unknown): v is Omit<Alert, "kind"> & { kind: string } =>
  isRecord(v) && typeof v.id === "number" && typeof v.at === "number" && (v.node === null || typeof v.node === "string")
  && typeof v.kind === "string" && isRecord(v.detail);

export class FleetClient {
  readonly #socketPath: string;

  constructor(socketPath: string) { this.#socketPath = socketPath; }

  async caps(): Promise<{ api: number[] }> {
    const v = await this.#json("GET", "/v1/caps");
    if (!isRecord(v) || !Array.isArray(v.api) || !v.api.every(n => Number.isInteger(n))) throw new FleetMismatch("GET /v1/caps: not a capability list");
    return { api: v.api as number[] };
  }

  async nodes(): Promise<FleetNode[]> {
    const v = await this.#json("GET", "/v1/nodes");
    if (!Array.isArray(v) || !v.every(isNode)) throw new FleetMismatch("GET /v1/nodes: not a node list");
    return v;
  }

  async lanes(): Promise<FleetLane[]> {
    const v = await this.#json("GET", "/v1/lanes");
    if (!Array.isArray(v) || !v.every(isLane)) throw new FleetMismatch("GET /v1/lanes: not a lane list");
    return v;
  }

  // What the fleet raised for the owner (plan.md, "Alerts"): the latest 500, oldest first. A kind this hub doesn't know
  // (a newer fleet's) is left out, as an event of a kind it doesn't know is.
  async alerts(): Promise<Alert[]> {
    const v = await this.#json("GET", "/v1/alerts");
    if (!Array.isArray(v) || !v.every(isAlert)) throw new FleetMismatch("GET /v1/alerts: not an alert list");
    return v.filter((a): a is Alert => ALERT_KINDS.has(a.kind));
  }

  // One typed op (spec §5.3). The result's fields are checked by whoever reads them; the envelope is checked here.
  async op<O extends OpName>(target: OpTarget, op: O, args: OpArgs[O], opts: { key?: string; timeoutMs?: number } = {}): Promise<OpAnswer<O>> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const body = { ...target, op, args, timeoutMs, ...(opts.key !== undefined ? { key: opts.key } : {}) };
    const v = await this.#json("POST", "/v1/op", body, timeoutMs + ANSWER_SLACK_MS);
    if (isRecord(v) && v.ok === true && "result" in v && typeof v.store === "string") {
      return { ok: true, result: v.result as OpResult[O], invVersion: typeof v.invVersion === "number" ? v.invVersion : 0, store: v.store };
    }
    if (isRecord(v) && v.ok === false && isOpError(v.error)) return { ok: false, error: v.error, store: typeof v.store === "string" ? v.store : null };
    throw new FleetMismatch(`POST /v1/op ${op}: not an op answer`);
  }

  // A file on a node, streamed (GET /v1/files): the fleet reads it in chunks of at most 256 KiB under the node's rules.
  async *fileStream(node: string, refOrPath: string): AsyncIterable<Uint8Array> {
    const path = `/v1/files/${encodeURIComponent(node)}/${encodeURIComponent(refOrPath)}`;
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      const req = request({ socketPath: this.#socketPath, agent: false, method: "GET", path, headers: CLIENT }, resolve);
      req.setTimeout(FILE_IDLE_MS, () => req.destroy(new Error(`no data for ${FILE_IDLE_MS} ms`)));
      req.on("error", (e: NodeJS.ErrnoException) => reject(new FleetUnavailable(`GET /v1/files: ${e.message}`, !NOT_SENT.has(e.code ?? ""), { cause: e })));
      req.end();
    });
    try {
      if (res.statusCode !== 200) {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of res) {
          size += (c as Buffer).length;
          if (size > 65_536) break;
          chunks.push(c as Buffer);
        }
        let v: unknown = null;
        try { v = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { /* not JSON: not the client API */ }
        if (isRecord(v) && v.ok === false && isOpError(v.error)) throw new FleetOpFailed(`file on ${node}`, v.error);
        throw new FleetMismatch(`GET /v1/files: answered ${res.statusCode ?? "nothing"}`);
      }
      for await (const chunk of res) yield chunk as Buffer;
    } finally {
      res.destroy();
    }
  }

  // The fleet's events (spec §5.6: inventory, health, node status, conflicts, alerts), until the returned function is
  // called.
  // A closed socket is opened again after 1, 2, 5, 10, then every 30 s, each with jitter; the fleet sends the current
  // state first on every new subscription, so nothing missed meanwhile stays missed.
  events(on: (e: FleetEvent) => void): () => void {
    let stopped = false;
    let socket: WebSocket | null = null;
    let timer: NodeJS.Timeout | null = null;
    let failures = 0;
    const connect = () => {
      if (stopped) return;
      const ws = new WebSocket(`ws+unix:${this.#socketPath}:/v1/events`, { maxPayload: MAX_ANSWER_BYTES, headers: CLIENT });
      socket = ws;
      ws.on("open", () => { failures = 0; });
      // A frame arrives as a Buffer (ws's default binaryType "nodebuffer").
      ws.on("message", (raw: Buffer) => {
        let v: unknown;
        try { v = JSON.parse(raw.toString("utf8")); } catch { log.warn("fleet events: a frame that isn't JSON, ignored"); return; }
        if (!isRecord(v) || typeof v.t !== "string" || typeof v.node !== "string" || !("body" in v)) { log.warn("fleet events: a frame of an unknown shape, ignored"); return; }
        if (!EVENTS.has(v.t)) return;                                 // a kind a newer fleet added
        try { on({ t: v.t as FleetEvent["t"], node: v.node, body: v.body }); }
        catch (e) { log.error("fleet events: a listener failed", e); }
      });
      ws.on("error", e => log.warn(`fleet events: ${e.message}`));
      ws.on("close", () => {
        socket = null;
        if (stopped) return;
        const base = RECONNECT_MS[Math.min(failures++, RECONNECT_MS.length - 1)] ?? 30_000;
        timer = setTimeout(connect, base / 2 + Math.random() * (base / 2));
        timer.unref();
      });
    };
    connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      socket?.terminate();
    };
  }

  // A JSON request. The client API puts the outcome in the body whatever the status, so any status is read.
  #json(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = request({
        socketPath: this.#socketPath, agent: false, method, path,
        headers: data ? { ...CLIENT, "content-type": "application/json", "content-length": String(data.length) } : CLIENT,
      }, res => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_ANSWER_BYTES) { req.destroy(new Error(`an answer over ${MAX_ANSWER_BYTES} bytes`)); return; }
          chunks.push(c);
        });
        res.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch { reject(new FleetMismatch(`${method} ${path}: answered ${res.statusCode ?? "nothing"} without JSON`)); }
        });
        res.on("error", e => reject(new FleetUnavailable(`${method} ${path}: ${e.message}`, true, { cause: e })));
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
      req.on("error", (e: NodeJS.ErrnoException) => reject(new FleetUnavailable(`${method} ${path}: ${e.message}`, !NOT_SENT.has(e.code ?? ""), { cause: e })));
      req.end(data ?? undefined);
    });
  }
}

// Whether the fleet at this socket speaks this hub's client API (spec §5.6: GET /v1/caps lists the versions it takes).
export async function checkFleet(client: FleetClient): Promise<"ok" | "unsupported" | "unreachable"> {
  try { return (await client.caps()).api.includes(CLIENT_API) ? "ok" : "unsupported"; }
  catch (e) { return e instanceof FleetMismatch ? "unsupported" : "unreachable"; }
}
```

- [ ] **Step 14.5: Run it and see it pass**

Run: `npx vitest run apps/hub/test/fleet-client.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 14.6: Commit, then the negative controls**

```bash
git add apps/hub/src/adapters/fleet-client.ts apps/hub/test/helpers/fake-fleet.ts apps/hub/test/fleet-client.test.ts
git commit -m "feat(hub): fleet client for the client API over a Unix socket"
```

The controls come after the commit: `fleet-client.ts` was a new, untracked file before it, which `git checkout` can't restore. Each one is restored with `git checkout -- apps/hub/src/adapters/fleet-client.ts`, and `git status` is clean after each:
- Drop `"alert"` from `EVENTS`. `npx vitest run apps/hub/test/fleet-client.test.ts -t alerts` fails with `Error: not within 5000 ms` (the alert event is never delivered).
- Drop `"EINVAL", "ENAMETOOLONG"` from `NOT_SENT`. `npx vitest run apps/hub/test/fleet-client.test.ts` fails in "no socket: …" with `AssertionError: expected true to be false` on macOS (a socket path over 104 bytes fails its connect with EINVAL, and nothing was sent).
- Replace `const CLIENT = { "x-morndo-client": "hub" };` with `const CLIENT = {};`. `npx vitest run apps/hub/test/fleet-client.test.ts -t capabilities` fails with `AssertionError: expected Set{ '' } to deeply equal Set{ 'hub' }` (the fleet's audit couldn't name this client).

- [ ] **Step 14.7: Write the both-modes helper**

Create `apps/hub/test/helpers/hub-mode.ts`. It is the only test file that builds the services (Tasks 4 and 5 define their constructors); the legacy ports it hands back are the suite's own fakes, with Task 4/5's `local-node.ts` builders where it needs real ones. It imports `fleet-adapters.ts`, which Step 14.10 creates.

```ts
// The hub's suites in both configurations (spec §9, "Hub: the existing suites, adapted where this spec changes types ...
// They run in both legacy and fleet configuration against a fake fleet"). A suite builds its local ports as the legacy
// hub sees them, keyed by tmux pane ids (fakes, or real adapters on a private tmux server). `portsFor("legacy", …)`
// hands them back as they are; `portsFor("fleet", …)` puts them behind the fake fleet (fake-fleet.ts) as one node and
// hands back the hub's fleet adapters over a real Unix socket. Worker ids differ by mode, so a suite names a pane as
// `ports.id("%1")`.
//   both modes (the default):  npx vitest run apps/hub
//   one mode:                  MORNDO_HUB_MODES=fleet npx vitest run apps/hub/test/steering-durable.test.ts
// The services are built here only (observationFor, steeringFor, escalationsFor), so a constructor change is one edit.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POLICY, type AccessPolicy } from "@morndo/domain";
import { sessionRegistry, type Terminal } from "@morndo/node-ops";
import { formatWorkerId } from "@morndo/protocol";
import { FleetClient } from "../../src/adapters/fleet-client.ts";
import { fleetPorts, type FleetPorts, type FleetTimeouts, type LocalFileStore } from "../../src/adapters/fleet-adapters.ts";
import { localSessions, localTranscripts, localUploads } from "../../src/adapters/local-node.ts";
import type { LedgerRead } from "../../src/adapters/ledger.ts";
import type { Store } from "../../src/adapters/store.ts";
import type { Inbox } from "../../src/adapters/uploads.ts";
import type { HubPorts, RemoteFiles, Sessions, Tmux, TranscriptSource, UploadSink } from "../../src/application/ports.ts";
import { ObservationService } from "../../src/application/observation-service.ts";
import { SteeringService } from "../../src/application/steering-service.ts";
import { EscalationService, type Watch } from "../../src/application/escalation-service.ts";
import { localNode, startFakeFleet, type FakeFleet, type FakeNode, type NodeBackend } from "./fake-fleet.ts";

export type HubMode = "legacy" | "fleet";
export const HUB_MODES: HubMode[] = modes(process.env.MORNDO_HUB_MODES);
function modes(v: string | undefined): HubMode[] {
  const out = (v ?? "legacy,fleet").split(",").map(s => s.trim()).filter(Boolean);
  for (const m of out) if (m !== "legacy" && m !== "fleet") throw new Error(`MORNDO_HUB_MODES: unknown mode "${m}" (legacy, fleet)`);
  return out as HubMode[];
}

export type FleetRig = { fleet: FakeFleet; client: FleetClient; ports: FleetPorts; close(): Promise<void> };
// A fake fleet with these nodes, and the hub's fleet adapters on it, started (events subscribed, nodes looked at).
export async function fleetRig(nodes: FakeNode[], o: { files?: LocalFileStore; timeouts?: Partial<FleetTimeouts> } = {}): Promise<FleetRig> {
  const fleet = await startFakeFleet({ nodes });
  const client = new FleetClient(fleet.socketPath);
  const ports = fleetPorts(client, {
    files: o.files ?? null, stagingDir: mkdtempSync(join(tmpdir(), "morndo-staging-")), ...(o.timeouts ? { timeouts: o.timeouts } : {}),
  });
  await ports.start();
  return { fleet, client, ports, close: async () => { ports.stop(); await fleet.close(); } };
}

// `files` is the legacy hub's copier; in fleet mode a file is read on the node (`readFile`) and copied into `fileStore`,
// the hub's own store (files.ts), as the fleet adapters do.
export type LocalPorts = {
  tmux: Tmux; terminal?: Terminal; sessions?: Sessions; transcripts?: TranscriptSource; files?: RemoteFiles; uploads?: UploadSink;
  readFile?: NonNullable<NodeBackend["readFile"]>; inboxDir?: string; fileStore?: LocalFileStore;
};
// `id` and `close` are functions, not methods: a suite passes them on unbound (`id: p.id`).
export type ModePorts = HubPorts & { mode: HubMode; id: (pane: string) => string; rig: FleetRig | null; close: () => Promise<void> };

export const TEST_NODE = "test";
export const TEST_SERVER = "0a1b2c3d";
const NO_TERMINAL: Terminal = { frame: async () => null, keys: async () => false };
const NO_FILES: RemoteFiles = { register: async () => ({ id: null, size: null }) };

// "%3" as the fleet names it on this node: "test.0a1b2c3d.3". Anything else is passed on as it is.
export function workerIdOf(node: string, server: string, pane: string): string {
  const n = /^%(\d{1,9})$/.exec(pane)?.[1];
  return n === undefined ? pane : formatWorkerId({ node, server, pane: Number(n) });
}

export async function portsFor(mode: HubMode, local: LocalPorts): Promise<ModePorts> {
  if (mode === "legacy") {
    return {
      mode, tmux: local.tmux, terminal: local.terminal ?? NO_TERMINAL, sessions: local.sessions ?? null, transcripts: local.transcripts ?? null,
      files: local.files ?? NO_FILES, uploads: local.uploads ?? localUploads(), sendStatus: null, nodeStates: null,
      id: pane => pane, rig: null, close: async () => {},
    };
  }
  const backend: NodeBackend = { tmux: local.tmux };
  if (local.terminal) backend.terminal = local.terminal;
  if (local.sessions) backend.sessions = local.sessions;
  if (local.transcripts) backend.transcripts = local.transcripts;
  if (local.readFile) backend.readFile = local.readFile;
  if (local.inboxDir !== undefined) backend.inboxDir = local.inboxDir;
  const rig = await fleetRig([localNode(TEST_NODE, TEST_SERVER, backend)], local.fileStore ? { files: local.fileStore } : {});
  const p = rig.ports;
  return {
    mode, tmux: p.tmux, terminal: p.terminal, sessions: p.sessions, transcripts: p.transcripts, files: p.files, uploads: p.uploads,
    sendStatus: p.sendStatus, nodeStates: p.nodeStates, id: pane => workerIdOf(TEST_NODE, TEST_SERVER, pane), rig, close: () => rig.close(),
  };
}

// Sessions and transcripts from an agent config directory, as the legacy hub reads them (local-node.ts), as ports.
export function claudeDirPorts(dir: string): { sessions: Sessions; transcripts: TranscriptSource } {
  const registry = sessionRegistry(dir);
  return { sessions: localSessions(registry), transcripts: localTranscripts(registry) };
}

export function observationFor(p: HubPorts, o: { quietAfterMs: number; now?: () => number }): ObservationService {
  return new ObservationService(p.tmux, o.quietAfterMs, o.now ?? Date.now,
    { sessions: p.sessions, transcripts: p.transcripts, files: p.files, nodeStates: p.nodeStates });
}

export function steeringFor(p: HubPorts, o: {
  store: Store; now?: () => number; policy?: () => AccessPolicy; inbox?: Pick<Inbox, "get"> | null;
  waitingOn?: (workerId: string) => string; nameOf?: (workerId: string) => string | null;
}): SteeringService {
  return new SteeringService(o.store, p.tmux, o.now ?? Date.now, o.policy ?? (() => DEFAULT_POLICY), o.inbox ?? null,
    o.waitingOn ?? (() => "none"), o.nameOf ?? (() => null), p.uploads);
}

export function escalationsFor(p: HubPorts, o: { store: Store; watch: Watch; now?: () => number; managerName?: string; ledger?: (() => LedgerRead) | null }): EscalationService {
  return new EscalationService({
    watch: o.watch, ledger: o.ledger ?? null, store: o.store, managerName: o.managerName ?? "manager",
    send: async (pane, text, key) => (await p.tmux.send(pane, text, key)).problem, ...(o.now ? { now: o.now } : {}),
  });
}
```

- [ ] **Step 14.8: Write the failing fleet adapters test**

Create `apps/hub/test/fleet-adapters.test.ts`:

```ts
// The hub's ports over the fleet (spec §3.1, §4, §5.3) against the fake fleet, two nodes:
// - listing every node's windows, with each worker's node; a slow or hung node never holds the listing more than 300 ms;
// - captures in one pane.captureMany per node;
// - a send with the caller's key and the expectation from the latest inventory, and the node refusing it once that no
//   longer holds;
// - a node going offline;
// - terminal frames and keys;
// - sessions from the inventory, and transcripts by session;
// - an image put in keyed chunks;
// - a worker's file copied into the hub's store;
// - what op.status says of a key, and from which store;
// - keys that may have been typed ("uncertain"), and transcripts that can't be read now (SourceUnavailable);
// - an inventory event applied without a poll.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId } from "@morndo/domain";
import { fileStore } from "../src/adapters/files.ts";
import type { LocalFileStore } from "../src/adapters/fleet-adapters.ts";
import { SendInDoubt, SourceUnavailable } from "../src/application/ports.ts";
import { LOST, localNode, memoryBackend, until, type MemoryBackend, type MemoryPane } from "./helpers/fake-fleet.ts";
import { fleetRig, observationFor, type FleetRig } from "./helpers/hub-mode.ts";

const PC1 = "pc.aaaaaaaa.1";
const PC2 = "pc.aaaaaaaa.2";
const BOX1 = "box.bbbbbbbb.1";
const BOX = "──────\n❯ ";
const TRANSCRIPT = Buffer.from(`${"a".repeat(300_000)}\n{"uuid":"needle"}\n`);
const REPORT = Buffer.from("%PDF-1.7 synthetic");

let dir: string;
let rig: FleetRig | null = null;
let pc: MemoryBackend;
let box: MemoryBackend;
let alpha: MemoryPane;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "morndo-fleet-adapters-"));
  alpha = { name: "alpha", cwd: "/w/alpha", screen: BOX, sessionId: "s-alpha" };
  pc = memoryBackend({ "%1": alpha, "%2": { name: "gamma", cwd: "/w/gamma", screen: "gamma $ " } },
    { inboxDir: join(dir, "pc-inbox"), transcripts: { "s-alpha": TRANSCRIPT }, files: { "/w/alpha/report.pdf": REPORT } });
  box = memoryBackend({ "%1": { name: "beta", cwd: "/w/beta", screen: BOX } });
});
afterEach(async () => {
  await rig?.close();
  rig = null;
  rmSync(dir, { recursive: true, force: true });
});
const start = async (o: { files?: LocalFileStore } = {}) => (rig = await fleetRig([localNode("pc", "aaaaaaaa", pc), localNode("box", "bbbbbbbb", box)], o));
const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);

describe("listing and captures", () => {
  it("lists every window with its worker id, its node and the basename of its cwd", async () => {
    const { ports } = await start();
    expect((await ports.tmux.listWorkers()).sort(byId)).toEqual([
      { id: BOX1, name: "beta", location: "beta", node: "box", offline: false, conflict: false },
      { id: PC1, name: "alpha", location: "alpha", node: "pc", offline: false, conflict: false },
      { id: PC2, name: "gamma", location: "gamma", node: "pc", offline: false, conflict: false },
    ]);
  });

  it("waits at most 300 ms for a slow node's inventory, and applies it when it lands (spec §3.1)", async () => {
    const { ports, fleet } = await start();
    await ports.tmux.listWorkers();
    box.panes["%2"] = { name: "delta", cwd: "/w/delta", screen: BOX };                // a new window, not announced
    fleet.intercept("inventory.get", async (call, next) => { if (call.node === "box") await new Promise(r => setTimeout(r, 1000)); return next(); });
    const t0 = Date.now();
    const first = await ports.tmux.listWorkers();
    expect(Date.now() - t0).toBeLessThan(800);
    expect(first.map(w => w.id).sort()).toEqual([BOX1, PC1, PC2]);                    // the slow node's answer isn't in yet
    await until(() => fleet.calls.filter(c => c.op === "inventory.get" && c.node === "box").length === 1);
    await new Promise(r => setTimeout(r, 1100));
    expect((await ports.tmux.listWorkers()).map(w => w.id).sort()).toEqual([BOX1, "box.bbbbbbbb.2", PC1, PC2]);   // applied as it landed
    expect(fleet.calls.filter(c => c.op === "inventory.get" && c.node === "box")).toHaveLength(1);
  });

  it("a node whose inventory.get never answers holds no listing, and is asked once at a time", async () => {
    const { ports, fleet } = await start();
    await ports.tmux.listWorkers();
    box.panes["%2"] = { name: "delta", cwd: "/w/delta", screen: BOX };
    fleet.intercept("inventory.get", async (call, next) => (call.node === "box" ? new Promise(() => {}) : next()));
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      expect((await ports.tmux.listWorkers()).map(w => w.id).sort()).toEqual([BOX1, PC1, PC2]);
      expect(Date.now() - t0).toBeLessThan(800);
    }
    expect(fleet.calls.filter(c => c.op === "inventory.get" && c.node === "box")).toHaveLength(1);   // the one in flight
  });

  it("captures with one pane.captureMany per node; an id that isn't a worker id is null without asking", async () => {
    const { ports, fleet } = await start();
    await ports.tmux.listWorkers();
    const before = fleet.calls.length;
    expect(Object.fromEntries(await ports.tmux.captureMany([PC1, PC2, BOX1, "%1"]))).toEqual({ [PC1]: BOX, [PC2]: "gamma $ ", [BOX1]: BOX, "%1": null });
    expect(fleet.calls.slice(before).map(c => ({ op: c.op, node: c.node, args: c.args, timeoutMs: c.timeoutMs })).sort((a, b) => String(a.node).localeCompare(String(b.node)))).toEqual([
      { op: "pane.captureMany", node: "box", args: { workerIds: [BOX1] }, timeoutMs: 1200 },
      { op: "pane.captureMany", node: "pc", args: { workerIds: [PC1, PC2] }, timeoutMs: 1200 },
    ]);
  });

  it("a node that goes offline: its workers stay listed, marked offline, and aren't asked; the other node still updates", async () => {
    const { ports, fleet } = await start();
    const obs = observationFor(ports, { quietAfterMs: 60_000 });
    await obs.poll();
    expect(obs.snapshot().workers.map(w => w.id).sort()).toEqual([BOX1, PC1, PC2]);
    await fleet.setStatus("box", "offline");
    alpha.screen = "pc moved on";
    const before = fleet.calls.length;
    await obs.poll();
    expect(obs.screen(PC1)).toBe("pc moved on");
    expect(obs.snapshot().workers.map(w => w.id).sort()).toEqual([BOX1, PC1, PC2]);              // not gone
    expect(fleet.calls.slice(before).filter(c => c.node === "box")).toEqual([]);                  // skipped at once
    expect((await ports.tmux.listWorkers()).find(w => w.id === BOX1)).toEqual({ id: BOX1, name: "beta", location: "beta", node: "box", offline: true, conflict: false });
    expect(ports.nodeStatus("box")).toBe("offline");
    expect(await ports.nodeStates()).toEqual(new Map([["box", "offline"], ["pc", "online"]]));   // what observation skips by
  });
});

describe("sending (spec §4, §5.3)", () => {
  it("sends with the caller's key under hub:, the expectation from the latest inventory, and the node's typedAt", async () => {
    pc.typedAt = 1_791_000_000_123;
    const { ports, fleet } = await start();
    await ports.tmux.listWorkers();
    expect(await ports.tmux.send(PC1, "ship it", "ep1:r1")).toEqual({ problem: null, typedAt: 1_791_000_000_123, store: fleet.node("pc").store });
    expect(fleet.calls.filter(c => c.op === "pane.send")).toEqual([{
      op: "pane.send", node: "pc", target: { workerId: PC1 }, key: "hub:ep1:r1", timeoutMs: 10_000,
      args: { workerId: PC1, text: "ship it", expect: { server: "aaaaaaaa", window: "alpha", sessionId: "s-alpha" } },
    }]);
    expect(pc.typed).toEqual([{ pane: "%1", text: "ship it", key: "hub:ep1:r1" }]);
  });

  it("an expectation that no longer holds is refused by the node: no_pane, nothing typed, the key released", async () => {
    const { ports, fleet } = await start();
    await ports.tmux.listWorkers();                                    // the hub's view: %1 is "alpha"
    alpha.name = "renamed";                                            // renamed on the node since
    expect(await ports.tmux.send(PC1, "ship it", "ep1:r2")).toEqual({ problem: "no_pane", typedAt: 0 });
    expect(pc.typed).toEqual([]);
    expect(fleet.node("pc").keys.has("hub:ep1:r2")).toBe(false);
  });

  it("refusals before the paste are problems; an answer lost after the paste throws SendInDoubt with the node's store", async () => {
    const { ports, fleet } = await start();
    await ports.tmux.listWorkers();
    alpha.problem = "menu_open";
    expect(await ports.tmux.send(PC1, "x", "k1")).toEqual({ problem: "menu_open", typedAt: 0 });
    alpha.problem = null;
    fleet.intercept("pane.send", async (_call, next) => { await next(); return LOST; });
    const lost = await ports.tmux.send(PC1, "y", "k2").catch((e: unknown) => e);
    expect(lost).toBeInstanceOf(SendInDoubt);
    expect((lost as SendInDoubt).store).toBe(fleet.node("pc").store);
    expect(pc.typed.map(t => t.text)).toEqual(["y"]);
    expect(await ports.tmux.send("%1", "z", "k3")).toEqual({ problem: "no_pane", typedAt: 0 });   // a legacy id: no pane here
  });

  it("op.status: done, with the node's typedAt, only when typed and submitted; pasted but not submitted stays in doubt; unknown, from its store; offline", async () => {
    pc.typedAt = 1_791_000_000_321;
    const { ports, fleet } = await start();
    await ports.tmux.listWorkers();
    await ports.tmux.send(PC1, "a", "k-done");
    expect(await ports.sendStatus(PC1, "k-done")).toEqual({ state: "done", typedAt: 1_791_000_000_321 });
    alpha.problem = "not_submitted";
    expect(await ports.tmux.send(PC1, "b", "k-pasted")).toEqual({ problem: "not_submitted", typedAt: 1_791_000_000_321, store: fleet.node("pc").store });
    expect(await ports.sendStatus(PC1, "k-pasted")).toEqual({ state: "started" });
    expect(await ports.sendStatus(PC1, "k-never")).toEqual({ state: "unknown", store: fleet.node("pc").store });
    expect(fleet.calls.filter(c => c.op === "op.status").map(c => c.args)).toEqual([{ key: "hub:k-done" }, { key: "hub:k-pasted" }, { key: "hub:k-never" }]);
    expect(await ports.sendStatus("%1", "k-done")).toEqual({ state: "offline" });                 // a legacy row: can't be asked
    await fleet.setStatus("pc", "offline");
    expect(await ports.sendStatus(PC1, "k-done")).toEqual({ state: "offline" });
  });
});

describe("terminal, sessions and transcripts", () => {
  it("frames and keys through the node; keys carry the expectation without a session, and never more than 4096", async () => {
    const { ports, fleet } = await start();
    await ports.tmux.listWorkers();
    expect(await ports.terminal.frame(PC1)).toEqual({ cols: 80, rows: 2, x: 0, y: 0, cursor: true, lines: ["──────", "❯ "] });
    expect(await ports.terminal.frame("%1")).toBeNull();
    expect(await ports.terminal.keys(PC1, "ls\r")).toBe(true);
    expect(pc.keysTyped).toEqual([{ pane: "%1", data: "ls\r" }]);
    expect(fleet.calls.filter(c => c.op === "pane.keys")).toEqual([{
      op: "pane.keys", node: "pc", target: { workerId: PC1 }, key: null, timeoutMs: 3000,
      args: { workerId: PC1, data: "ls\r", expect: { server: "aaaaaaaa", window: "alpha" } },
    }]);
    expect(await ports.terminal.keys(PC1, "x".repeat(4097))).toBe(false);
  });

  it("keys whose answer was lost may have been typed: uncertain, never refused; keys the node refused are false", async () => {
    const { ports, fleet } = await start();
    await ports.tmux.listWorkers();
    fleet.intercept("pane.keys", async (_call, next) => { await next(); return LOST; });
    expect(await ports.terminal.keys(PC1, "y")).toBe("uncertain");
    expect(pc.keysTyped).toEqual([{ pane: "%1", data: "y" }]);
    fleet.intercept("pane.keys", null);
    alpha.name = "renamed";                                            // the expectation no longer holds: no_pane, not typed
    expect(await ports.terminal.keys(PC1, "n")).toBe(false);
    expect(pc.keysTyped).toHaveLength(1);
  });

  it("sessions come from the inventory; a transcript is read from the node whose pane runs it, a chunk at a time", async () => {
    const { ports, fleet } = await start();
    await ports.tmux.listWorkers();
    expect([...(await ports.sessions.byPane())]).toEqual([[PC1, { sessionId: "s-alpha", name: null, pane: PC1, cwd: "/w/alpha", version: null, pid: 0 }]]);
    expect(await ports.transcripts.size("s-alpha")).toBe(TRANSCRIPT.length);
    const first = await ports.transcripts.read("s-alpha", 0, 1 << 20);
    expect(first?.bytes.length).toBe(262_144);
    expect(first?.eof).toBe(false);
    const rest = await ports.transcripts.read("s-alpha", 262_144, 1 << 20);
    expect(rest?.eof).toBe(true);
    expect(Buffer.concat([first?.bytes ?? new Uint8Array(), rest?.bytes ?? new Uint8Array()]).equals(TRANSCRIPT)).toBe(true);
    expect(await ports.transcripts.locate("s-alpha", "needle")).toBe(TRANSCRIPT.indexOf("needle"));
    expect(await ports.transcripts.size("s-unknown")).toBeNull();
    expect(fleet.calls.filter(c => c.op.startsWith("transcript.")).every(c => c.node === "pc")).toBe(true);
  });

  it("a transcript whose node can't answer now is SourceUnavailable, never gone (null), so the follow keeps its place", async () => {
    const { ports, fleet } = await start();
    await ports.tmux.listWorkers();
    fleet.intercept("transcript.read", async () => LOST);
    await expect(ports.transcripts.read("s-alpha", 0, 10)).rejects.toBeInstanceOf(SourceUnavailable);
    fleet.intercept("transcript.read", null);
    await fleet.setStatus("pc", "offline");
    await expect(ports.transcripts.size("s-alpha")).rejects.toBeInstanceOf(SourceUnavailable);
    await expect(ports.transcripts.locate("s-alpha", "needle")).rejects.toBeInstanceOf(SourceUnavailable);
    await fleet.setStatus("pc", "online");
    expect(await ports.transcripts.size("s-alpha")).toBe(TRANSCRIPT.length);           // back: read on from where it was
  });

  it("an inventory event updates the sessions without a poll", async () => {
    const { ports, fleet } = await start();
    await ports.tmux.listWorkers();
    alpha.sessionId = "s-new";
    await fleet.announce("pc");
    await until(async () => (await ports.sessions.byPane()).get(PC1)?.sessionId === "s-new");
  });
});

describe("images and files", () => {
  it("puts an image on the worker's node in keyed 256 KiB chunks; a chunk whose answer was lost goes again with its key", async () => {
    const img = Buffer.alloc(600_000, 7);
    const path = join(dir, "pasted-1.png");
    writeFileSync(path, img);
    const upload = { id: "u1", endpointId: endpointId("ep1"), path, mime: "image/png" as const, size: img.length, at: 0 };
    const { ports, fleet } = await start();
    let lost = false;
    fleet.intercept("file.put", async (call, next) => {
      const r = await next();
      if (!lost && (call.args as { offset: number }).offset === 262_144) { lost = true; return LOST; }
      return r;
    });
    expect(await ports.uploads.stage(upload, PC1)).toEqual({ ok: true, path: join(dir, "pc-inbox", "u1-pasted-1.png") });
    expect(readFileSync(join(dir, "pc-inbox", "u1-pasted-1.png")).equals(img)).toBe(true);
    expect(fleet.calls.filter(c => c.op === "file.put").map(c => { const a = c.args as { offset: number; final: boolean }; return [c.key, a.offset, a.final]; })).toEqual([
      ["hub:upload:u1:0", 0, false], ["hub:upload:u1:1", 262_144, false], ["hub:upload:u1:1", 262_144, false], ["hub:upload:u1:2", 524_288, true],
    ]);
    expect(await ports.uploads.stage(upload, "%1")).toEqual({ ok: false, problem: "no_pane" });
    await fleet.setStatus("pc", "offline");
    expect(await ports.uploads.stage(upload, PC1)).toEqual({ ok: false, problem: "node_offline" });
  });

  it("copies a worker's file into the hub's store once, streamed from its node; one the node refuses is no copy", async () => {
    const store = fileStore({ dir: join(dir, "files"), deny: [] });
    const { ports, fleet } = await start({ files: store });
    const first = await ports.files.register(PC1, "/w/alpha/report.pdf");
    expect(first.size).toBe(REPORT.length);
    expect(first.id).toMatch(/^[0-9a-f]{32}$/);
    const kept = store.get(first.id ?? "");
    expect(kept && readFileSync(kept.file).equals(REPORT)).toBe(true);
    expect(kept?.meta.name).toBe("report.pdf");
    expect(await ports.files.register(PC1, "/w/alpha/report.pdf")).toEqual(first);
    expect(fleet.fileReads).toEqual(["pc:/w/alpha/report.pdf"]);                     // unchanged: not streamed again
    expect(await ports.files.register(PC1, "/etc/shadow")).toEqual({ id: null, size: null });
    expect(await ports.files.register("%1", "/w/alpha/report.pdf")).toEqual({ id: null, size: null });
  });
});
```

Create `apps/hub/test/local-ports.test.ts`, for the legacy set as one builder:

```ts
// The legacy set of ports (fleet core §10): this machine's tmux and Claude Code as the one node "local" (local-node.ts),
// with no fleet to ask about a send in doubt or about which nodes answer; and the desktop, which only a legacy hub has
// (spec §3.1: "no desktop" with a fleet). A tmux server name nobody runs, a temp Claude config dir and a fake file store:
// never the owner's tmux or ~/.claude.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId } from "@morndo/domain";
import { desktopTarget, legacyPorts } from "../src/adapters/local-ports.ts";
import { Store } from "../src/adapters/store.ts";
import type { Authenticated } from "../src/application/access-service.ts";
import { RemoteService } from "../src/application/remote-service.ts";
import { loadConfig } from "../src/config.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-legacy-ports-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const config = (claudeDir: string) => loadConfig({ MORNDO_HOME: join(dir, "data"), MORNDO_TMUX_SOCKET: `test-${randomUUID()}`, MORNDO_CLAUDE_DIR: claudeDir });
const files = (asked: string[]) => ({ register: async (path: string) => { asked.push(path); return { id: "a".repeat(32), size: 3 }; } });

describe("legacyPorts", () => {
  it("has no fleet to ask: no send status and no node states", () => {
    const p = legacyPorts(config("off"), { files: files([]) });
    expect([p.sendStatus, p.nodeStates]).toEqual([null, null]);
  });
  it("this machine's tmux, on its own server: none running under that name, so no workers and no frame", async () => {
    const p = legacyPorts(config("off"), { files: files([]) });
    expect(await p.tmux.listWorkers()).toEqual([]);
    expect(await p.terminal.frame("%1")).toBeNull();
  });
  it("conversations only with a Claude config dir: none for \"off\", the registry's sessions for a directory", async () => {
    expect(legacyPorts(config("off"), { files: files([]) }).sessions).toBeNull();
    mkdirSync(join(dir, "claude", "sessions"), { recursive: true });
    writeFileSync(join(dir, "claude", "sessions", "1.json"), JSON.stringify({ pid: process.pid, sessionId: "s1", tmux: "qa:@0.%1", name: "builder", cwd: "/w", version: "2.1.286", updatedAt: 1 }));
    const p = legacyPorts(config(join(dir, "claude")), { files: files([]) });
    expect([...((await p.sessions?.byPane()) ?? new Map()).keys()]).toEqual(["%1"]);
    expect(await p.transcripts?.size("s1")).toBeNull();                        // no transcript file yet
  });
  it("an attached image is staged at its inbox path; a worker's file goes to the hub's store by its path", async () => {
    const asked: string[] = [];
    const p = legacyPorts(config("off"), { files: files(asked) });
    const upload = { id: "u1", endpointId: endpointId("ep1"), path: join(dir, "inbox", "pasted-1.png"), mime: "image/png" as const, size: 4, at: 1 };
    expect(await p.uploads.stage(upload, "%1")).toEqual({ ok: true, path: upload.path });
    expect(await p.files.register("%1", "/w/out.png")).toEqual({ id: "a".repeat(32), size: 3 });
    expect(asked).toEqual(["/w/out.png"]);
  });
});

describe("the desktop", () => {
  it("is this machine's VNC in legacy mode; with a fleet there is none, whatever MORNDO_VNC says, so it is no_desktop", () => {
    const c = loadConfig({ MORNDO_HOME: join(dir, "data"), MORNDO_VNC: "127.0.0.1:5901", MORNDO_VNC_PASSWORD_FILE: join(dir, "no-such-file") });
    expect(desktopTarget(c, false)()).toEqual({ host: "127.0.0.1", port: 5901, password: null });
    expect(desktopTarget(c, true)()).toBeNull();
    const store = new Store(join(dir, "store"));
    try {
      const at = Date.now();
      const a: Authenticated = {
        session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: at, lastSeenAt: at, verifiedAt: at, endedAt: null, endReason: null },
        endpoint: { id: endpointId("ep1"), name: "Mac", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: at, revokedAt: null },
      };
      const remote = (fleet: boolean) => new RemoteService({ store, terminal: legacyPorts(c, { files: files([]) }).terminal, panes: () => [], desktop: desktopTarget(c, fleet) });
      expect(remote(true).open(a, { kind: "desktop" }, false)).toEqual({ ok: false, refused: "no_desktop" });
      expect(remote(false).open(a, { kind: "desktop" }, false).ok).toBe(true);           // negative control: legacy has one
    } finally { store.close(); }
  });
});
```

Keystrokes whose node may have typed them reach the app as `keys_uncertain`, never as a refusal (round 2, item 25). In `apps/hub/test/http-crash-fixture.ts`, replace
```ts
// a tmux slowed by a busy machine would; "ok" (the default) does none of that.
export type Variant = "ok" | "keys-throw" | "frame-throw" | "keys-slow-first";
```
with
```ts
// a tmux slowed by a busy machine would; "keys-uncertain" answers every key press "uncertain", as a fleet node whose
// answer was lost does (Task 14); "ok" (the default) does none of that.
export type Variant = "ok" | "keys-throw" | "frame-throw" | "keys-slow-first" | "keys-uncertain";
```
and replace
```ts
    keys: async (_id: string, data: string) => {
      if (variant === "keys-throw") throw new Error("tmux: can't find pane");
```
with
```ts
    keys: async (_id: string, data: string): Promise<boolean | "uncertain"> => {
      if (variant === "keys-throw") throw new Error("tmux: can't find pane");
      if (variant === "keys-uncertain") return "uncertain";
```
In `apps/hub/test/http-terminal-throws.test.ts`, before `  it("on a frame: the connection closes, and the hub still answers", async () => {` add:
```ts
  it("keys whose node may have typed them (its answer lost): the app is told keys_uncertain, never keys_refused", async () => {
    hub = await startHub("keys-uncertain");
    const ws = await openSocket(hub, "/api/terminal?pane=%251&control=1", true);
    const seen: string[] = [];
    ws.on("message", d => seen.push(frameText(d)));
    ws.send(JSON.stringify({ t: "keys", data: "y" }));
    await settle(800);
    expect(seen.filter(m => m.includes("keys_"))).toEqual([JSON.stringify({ t: "error", error: "keys_uncertain" })]);
  }, 20_000);
```

- [ ] **Step 14.9: Run it and see it fail**

Run: `npx vitest run apps/hub/test/fleet-adapters.test.ts apps/hub/test/local-ports.test.ts apps/hub/test/http-terminal-throws.test.ts`
Expected: FAIL. The first two suites error and run no tests: `Error: Cannot find module '../../src/adapters/fleet-adapters.ts' imported from …/apps/hub/test/helpers/hub-mode.ts` and `Error: Cannot find module '../src/adapters/local-ports.ts' imported from …/apps/hub/test/local-ports.test.ts`. In `http-terminal-throws`, 1 of 4 fails: "keys whose node may have typed them …" with `AssertionError: expected [ Array(1) ] to deeply equal [ Array(1) ]` (the socket says `keys_refused`).

- [ ] **Step 14.10: Implement the fleet adapters, `HubPorts` and the legacy builder**

Create `apps/hub/src/adapters/fleet-adapters.ts`:

```ts
// The hub's ports over the fleet service (ADR-0012; docs/design/fleet-core/README.md §3.1, §4, §5).
// - The view: every node's status and panes, kept by the fleet's events and checked again on each poll; the roster is
//   every node's panes (two windows of one name are both listed), and the lane registry says which names are in conflict.
// - The ports: each one is typed ops through the FleetClient.
// - Worker ids are `<node>.<server>.<pane>` (packages/protocol worker-id.ts). An id that isn't one, a legacy `%N` among
//   them, is no pane here.
// - Keys are the caller's, namespaced "hub:" (spec §5.3, "Keys are namespaced by client").
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { open, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Frame, SendProblem, SessionInfo } from "@morndo/node-ops";
import { LIMITS, parseWorkerId, type Expect, type OpArgs, type OpResult, type Pane } from "@morndo/protocol";
import {
  SendInDoubt, SourceUnavailable,
  type HubPorts, type NodeStates, type RemoteFiles, type SendOutcome, type SendStatus, type Sessions, type Terminal, type Tmux, type TranscriptSource, type UploadSink,
} from "../application/ports.ts";
import { FleetOpFailed, FleetUnavailable, type FleetClient, type FleetEvent, type FleetLane, type NodeStatus, type OpAnswer } from "./fleet-client.ts";
import { log } from "./log.ts";

export type FleetTimeouts = { listMs: number; captureMs: number; sendMs: number; keysMs: number; frameMs: number; statusMs: number; transcriptMs: number; fileMs: number };
// What each op may take before the fleet answers `timeout` itself (spec §5.3, deadlines; counted from when the fleet
// queued it). A poll waits at most captureMs for a node's screens, so one slow node never holds the others for longer
// than that (spec §3.1). listMs is a background inventory refresh's: a listing waits for it at most
// LIMITS.inventoryWaitMs (300 ms), and its answer is applied whenever it lands.
export const FLEET_TIMEOUTS: FleetTimeouts = {
  listMs: 2000, captureMs: 1200, sendMs: 10_000, keysMs: 3000, frameMs: 3000, statusMs: 3000, transcriptMs: 5000, fileMs: 10_000,
};

// The hub's own store of file copies (files.ts): it hashes a file at a path, keeps it and serves it by id.
export type LocalFileStore = { register(path: string): { id: string | null; size: number | null } | Promise<{ id: string | null; size: number | null }> };

export type FleetPorts = HubPorts & {
  sessions: Sessions; transcripts: TranscriptSource; sendStatus: SendStatus; nodeStates: NodeStates;
  nodeStatus(node: string): NodeStatus | null;              // null: not heard of yet
  start(): Promise<void>;                                   // subscribe to the events, and a first look at the nodes
  stop(): void;
};

type Copy = { id: string | null; size: number | null };
const NO_COPY: Copy = { id: null, size: null };
const COPIES_KEPT = 5000;
const hubKey = (key: string) => `hub:${key}`;
// Refusals the agent answers before anything reached the pane (executed "no", the key released): a retry may type.
const BEFORE_PASTE = new Set<string>(["no_pane", "menu_open", "no_input_box", "draft_present", "busy"] satisfies SendProblem[]);
const SEND_PROBLEMS = new Set<string>(["no_pane", "menu_open", "no_input_box", "draft_present", "busy", "not_submitted"] satisfies SendProblem[]);
const STATUSES = new Set<string>(["online", "stale", "offline"]);
// A node that can't answer now: its transcript is SourceUnavailable, not gone (spec §3.1).
const NOT_NOW = new Set<string>(["node_offline", "timeout", "busy", "uncertain", "internal"]);
// `p`, waited for at most `ms`; whatever it comes to (late, failed) is left to it.
const within = (p: Promise<unknown>, ms: number) => new Promise<void>(resolve => {
  const timer = setTimeout(resolve, ms);
  p.then(() => { clearTimeout(timer); resolve(); }, () => { clearTimeout(timer); resolve(); });
});

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const optional = (v: unknown) => v === undefined || typeof v === "string";
const isPane = (v: unknown): v is Pane =>
  isRecord(v) && typeof v.workerId === "string" && typeof v.window === "string" && typeof v.cwd === "string"
  && optional(v.sessionId) && optional(v.title) && optional(v.claudeVersion);
const isFrame = (v: unknown): v is Frame =>
  isRecord(v) && [v.cols, v.rows, v.x, v.y].every(n => typeof n === "number") && typeof v.cursor === "boolean"
  && Array.isArray(v.lines) && v.lines.every(l => typeof l === "string");

// What the hub knows of the nodes: each one's status, its panes from its latest full inventory, and the lane registry's
// rows (one per name, `conflict` while two windows claim it).
class NodeView {
  #status = new Map<string, NodeStatus>();
  #panes = new Map<string, Map<string, Pane>>();            // node → worker id → its pane
  #lanes: FleetLane[] = [];
  #conflicted = new Set<string>();                          // lane names in conflict

  status(node: string): NodeStatus | null { return this.#status.get(node) ?? null; }
  states(): ReadonlyMap<string, NodeStatus> { return new Map(this.#status); }
  setStatus(node: string, status: NodeStatus) { this.#status.set(node, status); }
  has(node: string) { return this.#panes.has(node); }
  // A full inventory replaces what was known of the node; a pane of another node in it is never taken.
  setPanes(node: string, panes: unknown) {
    if (!Array.isArray(panes)) return;
    const known = new Map<string, Pane>();
    for (const p of panes) if (isPane(p) && parseWorkerId(p.workerId)?.node === node) known.set(p.workerId, p);
    this.#panes.set(node, known);
  }
  pane(workerId: string): Pane | null {
    const ref = parseWorkerId(workerId);
    return ref ? this.#panes.get(ref.node)?.get(workerId) ?? null : null;
  }
  all(): Pane[] { return [...this.#panes.values()].flatMap(m => [...m.values()]); }
  setLanes(lanes: FleetLane[]) { this.#lanes = lanes; this.#conflicted = new Set(lanes.filter(l => l.conflict).map(l => l.name)); }
  lanes(): FleetLane[] { return this.#lanes; }
  conflicted(name: string) { return this.#conflicted.has(name); }
  nodeOfSession(sessionId: string): string | null {
    for (const [node, panes] of this.#panes) for (const p of panes.values()) if (p.sessionId === sessionId) return node;
    return null;
  }
  apply(e: FleetEvent) {
    if (e.t === "status" && isRecord(e.body) && typeof e.body.status === "string" && STATUSES.has(e.body.status)) this.setStatus(e.node, e.body.status as NodeStatus);
    else if (e.t === "inventory" && isRecord(e.body)) this.setPanes(e.node, e.body.panes);
    else if (e.t === "conflict" && isRecord(e.body) && typeof e.body.name === "string" && Array.isArray(e.body.nodes)) {
      if (e.body.nodes.length) this.#conflicted.add(e.body.name); else this.#conflicted.delete(e.body.name);
    }
  }
}

export function fleetPorts(client: FleetClient, o: { files: LocalFileStore | null; stagingDir: string; timeouts?: Partial<FleetTimeouts> }): FleetPorts {
  const t: FleetTimeouts = { ...FLEET_TIMEOUTS, ...o.timeouts };
  const view = new NodeView();
  let unsubscribe = () => {};

  // A node's inventory asked for again, one refresh per node at a time. Its answer is applied when it lands, whether or
  // not anyone still waits for it.
  const refreshing = new Map<string, Promise<void>>();
  function refreshInventory(node: string): Promise<void> {
    let p = refreshing.get(node);
    if (!p) {
      p = client.op({ node }, "inventory.get", {}, { timeoutMs: t.listMs }).then(r => {
        if (r.ok) { view.setPanes(node, r.result.panes); view.setStatus(node, "online"); }
        else if (r.error.code === "node_offline") view.setStatus(node, "offline");
      }).finally(() => { refreshing.delete(node); });
      refreshing.set(node, p);
    }
    return p;
  }
  // The pane a worker id names, from its node's latest inventory; asked of the node once when it isn't there yet.
  async function paneOf(workerId: string): Promise<Pane | null> {
    const ref = parseWorkerId(workerId);
    if (!ref) return null;
    const known = view.pane(workerId);
    if (known) return known;
    await refreshInventory(ref.node);
    return view.pane(workerId);
  }
  // Polling skips a node the fleet doesn't call online, at once (spec §3.1); a node not heard of yet is asked.
  const polled = (node: string) => { const s = view.status(node); return s === null || s === "online"; };

  const tmux: Tmux = {
    // Every window of every node, from each node's inventory, with its node (spec §4): two windows of one name are both
    // listed, and `conflict` is the lane registry's word on that name. An inventory that is missing, or behind the registry
    // (a new pane, a renamed or closed window), is asked for again, every node at once; the listing waits for each at
    // most LIMITS.inventoryWaitMs, and a slower answer is applied when it lands, so a slow or hung node never holds the
    // listing (spec §3.1). A node the hub has no inventory of (offline since the hub started) is listed from the
    // registry's rows, offline.
    async listWorkers() {
      const [lanes, nodes] = await Promise.all([client.lanes(), client.nodes()]);
      for (const n of nodes) view.setStatus(n.name, n.status);
      view.setLanes(lanes);
      const names = new Set(lanes.map(l => l.name));
      const behind = new Set<string>();
      for (const n of nodes) if (n.status === "online" && !view.has(n.name)) behind.add(n.name);
      for (const l of lanes) {
        if (l.workerId === null || view.status(l.node) !== "online") continue;
        if (view.pane(l.workerId)?.window !== l.name) behind.add(l.node);
      }
      for (const p of view.all()) {
        const node = parseWorkerId(p.workerId)?.node ?? "";
        if (view.status(node) === "online" && !names.has(p.window)) behind.add(node);
      }
      await Promise.all([...behind].map(node => within(refreshInventory(node), LIMITS.inventoryWaitMs)));
      const worker = (id: string, name: string, cwd: string, node: string) => ({
        id, name, location: basename(cwd) || cwd, node, offline: view.status(node) !== "online", conflict: view.conflicted(name),
      });
      const listed = view.all().map(p => worker(p.workerId, p.window, p.cwd, parseWorkerId(p.workerId)?.node ?? ""));
      for (const l of lanes) {
        if (l.workerId !== null && !view.has(l.node) && parseWorkerId(l.workerId)?.node === l.node) listed.push(worker(l.workerId, l.name, "", l.node));
      }
      return listed;
    },
    async capture(id) { return (await tmux.captureMany([id])).get(id) ?? null; },
    async captureMany(ids) {
      const out = new Map<string, string | null>(ids.map(id => [id, null]));
      const byNode = new Map<string, string[]>();
      for (const id of ids) {
        const node = parseWorkerId(id)?.node;
        if (node !== undefined) byNode.set(node, [...(byNode.get(node) ?? []), id]);
      }
      await Promise.allSettled([...byNode].map(async ([node, list]) => {
        if (!polled(node)) return;
        for (let i = 0; i < list.length; i += LIMITS.captureManyMax) {
          const r = await client.op({ node }, "pane.captureMany", { workerIds: list.slice(i, i + LIMITS.captureManyMax) }, { timeoutMs: t.captureMs });
          if (!r.ok) { if (r.error.code === "node_offline") view.setStatus(node, "offline"); return; }
          for (const c of r.result.captures) if (out.has(c.workerId)) out.set(c.workerId, typeof c.text === "string" ? c.text : null);
        }
      }));
      return out;
    },
    async send(id, text, key) {
      const refused = (problem: SendOutcome["problem"]): SendOutcome => ({ problem, typedAt: 0 });
      const ref = parseWorkerId(id);
      if (!ref) return refused("no_pane");
      let pane: Pane | null;
      try { pane = await paneOf(id); }
      catch (e) { if (e instanceof FleetUnavailable) return refused("node_offline"); throw e; }   // nothing was sent yet
      if (!pane) { const s = view.status(ref.node); return refused(s === "offline" || s === "stale" ? "node_offline" : "no_pane"); }
      const expect: Expect = { server: ref.server, window: pane.window, ...(pane.sessionId !== undefined ? { sessionId: pane.sessionId } : {}) };
      let r: OpAnswer<"pane.send">;
      try { r = await client.op({ workerId: id }, "pane.send", { workerId: id, text, expect }, { key: hubKey(key), timeoutMs: t.sendMs }); }
      catch (e) {
        if (e instanceof FleetUnavailable && !e.reached) return refused("node_offline");
        // The fleet took it and never answered: it may be in the pane, and no store said so.
        if (e instanceof FleetUnavailable) throw new SendInDoubt(null, `pane.send to ${id}: ${e.message}`, { cause: e });
        throw e;
      }
      if (r.ok) {
        const { problem, typedAt } = r.result;
        if ((problem === null || SEND_PROBLEMS.has(problem)) && typeof typedAt === "number") return { problem, typedAt, store: r.store };
        throw new SendInDoubt(r.store, "pane.send: an answer this hub doesn't know");
      }
      const e = r.error;
      // It may be in the pane: the caller keeps it in doubt, with the store it went to (spec §3.1).
      if (e.executed === "maybe") throw new SendInDoubt(r.store, `pane.send: ${e.code}: ${e.message}`);
      if (BEFORE_PASTE.has(e.code)) return refused(e.code as SendProblem);
      if (e.code === "node_offline") { view.setStatus(ref.node, "offline"); return refused("node_offline"); }
      if (e.code === "timeout") return refused("busy");                     // the deadline came before typing began
      throw new FleetOpFailed("pane.send", e);                              // denied, bad_args, too_large: a setup fault
    },
  };

  const terminal: Terminal = {
    async frame(id) {
      if (!parseWorkerId(id)) return null;
      const r = await client.op({ workerId: id }, "pane.frame", { workerId: id }, { timeoutMs: t.frameMs });
      return r.ok && isFrame(r.result.frame) ? r.result.frame : null;
    },
    // Keystrokes are never retried (no key): an answer that may have come after they were typed ("maybe", or the fleet
    // took them and never answered) is "uncertain", which the app shows as "may have been typed", never as refused.
    async keys(id, data) {
      const ref = parseWorkerId(id);
      if (!ref || !data || data.length > LIMITS.maxKeys) return false;
      let pane: Pane | null;
      try { pane = await paneOf(id); } catch { return false; }                    // nothing was sent yet
      if (!pane) return false;
      // No session in the expectation: keys are typed watching the screen, and a /clear typed a moment ago starts a new one.
      let r: OpAnswer<"pane.keys">;
      try { r = await client.op({ workerId: id }, "pane.keys", { workerId: id, data, expect: { server: ref.server, window: pane.window } }, { timeoutMs: t.keysMs }); }
      catch (e) { if (e instanceof FleetUnavailable) return e.reached ? "uncertain" : false; throw e; }
      if (r.ok) return r.result.ok === true;
      return r.error.executed === "maybe" ? "uncertain" : false;
    },
  };

  const sessions: Sessions = {
    async byPane() {
      const out = new Map<string, SessionInfo>();
      for (const p of view.all()) {
        if (p.sessionId === undefined) continue;
        out.set(p.workerId, { sessionId: p.sessionId, name: p.title ?? null, pane: p.workerId, cwd: p.cwd, version: p.claudeVersion ?? null, pid: 0 });
      }
      return out;
    },
  };

  // A transcript lives on the node whose pane runs its session. null: no such transcript (gone). A node that can't answer
  // now (offline, slow, the fleet down) is SourceUnavailable: the hub's follow keeps its place, and the next poll asks
  // again (spec §3.1).
  async function transcriptOp<O extends "transcript.size" | "transcript.read" | "transcript.locate">(node: string, op: O, args: OpArgs[O]): Promise<OpResult[O] | null> {
    let r: OpAnswer<O>;
    try { r = await client.op({ node }, op, args, { timeoutMs: t.transcriptMs }); }
    catch (e) { if (e instanceof FleetUnavailable) throw new SourceUnavailable(`${op} on ${node}: ${e.message}`, { cause: e }); throw e; }
    if (r.ok) return r.result;
    if (NOT_NOW.has(r.error.code)) throw new SourceUnavailable(`${op} on ${node}: ${r.error.code}`);
    return null;                                                 // refused (bad_args, denied, no_pane): nothing to read
  }
  const transcripts: TranscriptSource = {
    async size(sessionId) {
      const node = view.nodeOfSession(sessionId);
      if (node === null) return null;
      const r = await transcriptOp(node, "transcript.size", { sessionId });
      return r && typeof r.size === "number" ? r.size : null;
    },
    async read(sessionId, offset, max) {
      const node = view.nodeOfSession(sessionId);
      if (node === null) return null;
      // At most one chunk per op (spec §5.2): a caller asking for more gets a short read and asks again from there.
      const r = await transcriptOp(node, "transcript.read", { sessionId, offset, max: Math.min(max, LIMITS.chunkBytes) });
      if (!r || typeof r.bytes !== "string") return null;
      return { bytes: Buffer.from(r.bytes, "base64"), eof: r.eof === true };
    },
    async locate(sessionId, needle) {
      const node = view.nodeOfSession(sessionId);
      if (node === null) return null;
      const r = await transcriptOp(node, "transcript.locate", { sessionId, needle });
      return r && typeof r.offset === "number" ? r.offset : null;
    },
  };

  // A file a worker's message names, copied from its node into the hub's own store (files.ts).
  // 1. Ask for its size and time first, so an unchanged file isn't copied again.
  // 2. Stream it in chunks (GET /v1/files) into a staging file named as the original.
  // 3. Hand the staging file to the store, which hashes it, keeps it and serves it by id; then delete the staging file.
  // The node applies today's rules before anything is read (spec §5.3: symlinks resolved, deny roots, secret names, 25 MiB).
  mkdirSync(o.stagingDir, { recursive: true, mode: 0o700 });
  const copies = new Map<string, { size: number; mtime: number; copy: Copy }>();   // node and path → its last copy
  const copying = new Map<string, Promise<Copy>>();
  async function copyFrom(node: string, path: string): Promise<Copy> {
    const k = `${node}\0${path}`;
    const known = copies.get(k);
    try {
      const st = await client.op({ node }, "file.stat", { path }, { timeoutMs: t.fileMs });
      if (!st.ok) return known?.copy ?? NO_COPY;                 // gone, refused or offline: the copy, if any (as files.ts)
      const { size, mtime } = st.result;
      if (size > LIMITS.maxFileBytes) return { id: null, size };
      if (known && known.size === size && known.mtime === mtime) return known.copy;
      if (!o.files) return NO_COPY;
      const dir = join(o.stagingDir, createHash("sha256").update(k).digest("hex").slice(0, 32));
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        const staged = join(dir, basename(path));
        const fh = await open(staged, "w", 0o600);
        let total = 0;
        try {
          for await (const chunk of client.fileStream(node, path)) {
            total += chunk.length;
            if (total > LIMITS.maxFileBytes) return { id: null, size: total };      // it grew past the cap while copied
            await fh.write(chunk);
          }
        } finally { await fh.close(); }
        const copy = await o.files.register(staged);
        copies.set(k, { size, mtime, copy });
        while (copies.size > COPIES_KEPT) copies.delete(copies.keys().next().value as string);
        return copy;
      } finally { await rm(dir, { recursive: true, force: true }); }
    } catch (e) {
      log.warn(`a file from ${node} was not copied: ${(e as Error).message}`);
      return known?.copy ?? NO_COPY;
    }
  }
  const files: RemoteFiles = {
    register(workerId, path) {
      const node = parseWorkerId(workerId)?.node;
      if (node === undefined) return Promise.resolve(NO_COPY);
      const k = `${node}\0${path}`;
      const running = copying.get(k);
      if (running) return running;
      const p = copyFrom(node, path).finally(() => copying.delete(k));
      copying.set(k, p);
      return p;
    },
  };

  // An image the principal attached, put on the node of the worker it goes to (spec §3.1, Uploads), in chunks of at most
  // 256 KiB, each keyed `upload:<id>:<chunk>`. A chunk asked again after a lost answer gets the node's stored outcome.
  async function putChunk(node: string, args: OpArgs["file.put"], key: string): Promise<{ ok: true; path: string | null } | { ok: false; problem: "no_pane" | "too_large" | "node_offline" }> {
    for (let attempt = 0; attempt < 3; attempt++) {
      let r: OpAnswer<"file.put">;
      try { r = await client.op({ node }, "file.put", args, { key, timeoutMs: t.fileMs }); }
      catch { continue; }                                       // the fleet didn't answer: the same key again
      if (r.ok) return { ok: true, path: typeof r.result.path === "string" ? r.result.path : null };
      if (r.error.code === "node_offline" || r.error.code === "too_large") return { ok: false, problem: r.error.code };
      if (r.error.executed === "maybe") continue;
      log.warn(`an image for ${node} was refused: ${r.error.code}`);
      return { ok: false, problem: "no_pane" };
    }
    return { ok: false, problem: "node_offline" };
  }
  const uploads: UploadSink = {
    async stage(upload, workerId) {
      const node = parseWorkerId(workerId)?.node;
      if (node === undefined) return { ok: false, problem: "no_pane" };
      let bytes: Buffer;
      try { bytes = await readFile(upload.path); }
      catch { log.warn("an attached image is gone from the hub's inbox"); return { ok: false, problem: "no_pane" }; }
      if (bytes.length > LIMITS.maxFileBytes) return { ok: false, problem: "too_large" };
      const chunks = Math.max(1, Math.ceil(bytes.length / LIMITS.chunkBytes));
      for (let i = 0; i < chunks; i++) {
        const offset = i * LIMITS.chunkBytes;
        const final = i === chunks - 1;
        const part = bytes.subarray(offset, offset + LIMITS.chunkBytes).toString("base64");
        const r = await putChunk(node, { upload: upload.id, offset, bytes: part, final, name: basename(upload.path) }, hubKey(`upload:${upload.id}:${i}`));
        if (!r.ok) return r;
        if (final) return r.path === null ? { ok: false, problem: "no_pane" } : { ok: true, path: r.path };
      }
      return { ok: false, problem: "no_pane" };
    },
  };

  // What the node knows of a key (spec §3.1, "Uncertain becomes resolvable"). op.status answers a done key with the op's
  // stored result, for pane.send `{ problem, typedAt }` (plan.md, "Behaviour the agent and the fleet agree on").
  // - "done" only for a send that was typed and submitted, with the node's own typedAt.
  // - One the node recorded with a problem (pasted, not submitted) stays in doubt ("started"), as a local "started" row does.
  // - "unknown" with the store that answered: the caller compares it with the store its send went to.
  // - Not a node's worker id (a legacy %N row), or a node that can't be asked: "offline".
  const sendStatus: SendStatus = async (id, key) => {
    const node = parseWorkerId(id)?.node;
    if (node === undefined) return { state: "offline" };
    let r: OpAnswer<"op.status">;
    try { r = await client.op({ node }, "op.status", { key: hubKey(key) }, { timeoutMs: t.statusMs }); }
    catch { return { state: "offline" }; }
    if (!r.ok) return { state: "offline" };
    const { state, outcome } = r.result;
    if (state === "done") {
      return isRecord(outcome) && outcome.problem === null && typeof outcome.typedAt === "number" ? { state: "done", typedAt: outcome.typedAt } : { state: "started" };
    }
    if (state === "unknown") return { state: "unknown", store: r.store };
    return state === "started" ? { state } : { state: "offline" };
  };
  // Which nodes answer now, as the view knows them (the fleet's status events, and each poll's GET /v1/nodes).
  const nodeStates: NodeStates = async () => view.states();

  return {
    tmux, terminal, sessions, transcripts, files, uploads, sendStatus, nodeStates,
    nodeStatus: node => view.status(node),
    async start() {
      unsubscribe = client.events(e => view.apply(e));
      try { for (const n of await client.nodes()) view.setStatus(n.name, n.status); }
      catch (e) { log.warn(`fleet: the first look at the nodes failed (${(e as Error).message}); each poll asks again`); }
    },
    stop() {
      unsubscribe();
      rmSync(o.stagingDir, { recursive: true, force: true });
    },
  };
}
```

Then add the hub's `Terminal` and `HubPorts` to `apps/hub/src/application/ports.ts` (Task 4 already gave `SendOutcome` its `"node_offline"` and `store`, `listWorkers` items their `offline` and `conflict`, `SendStatus` its answers, and `SendInDoubt` and `SourceUnavailable`). Replace
```ts
import type { SendProblem, SessionInfo } from "@morndo/node-ops";
```
with
```ts
import type { SendProblem, SessionInfo, Terminal as PaneTerminal } from "@morndo/node-ops";
```
and append:
```ts

// The terminal view's port: node-ops' Terminal, except that keys may answer "uncertain": the node may have typed them
// (the connection dropped while they were out), so the app says "may have been typed", never "refused" (Task 14).
export type Terminal = Omit<PaneTerminal, "keys"> & { keys(id: string, data: string): Promise<boolean | "uncertain"> };

// Every port the hub's services take, as one set: the legacy local adapters (local-ports.ts) or the fleet's
// (fleet-adapters.ts), chosen by MORNDO_FLEET_SOCKET (spec §10). `sendStatus` and `nodeStates` are the fleet's alone.
export type HubPorts = {
  tmux: Tmux; terminal: Terminal; sessions: Sessions | null; transcripts: TranscriptSource | null;
  files: RemoteFiles; uploads: UploadSink; sendStatus: SendStatus | null; nodeStates: NodeStates | null;
};
```

The remote service and the terminal socket take the hub's `Terminal`. In `apps/hub/src/application/remote-service.ts`, replace
```ts
import type { Terminal } from "@morndo/node-ops";
import type { Authenticated } from "./access-service.ts";
```
with
```ts
import type { Authenticated } from "./access-service.ts";
import type { Terminal } from "./ports.ts";
```
and in `apps/hub/src/adapters/http.ts` (the terminal socket's `onKeys`), replace
```ts
      let typed = false;
      try { typed = await remote.terminal.keys(pane, m.data); }
      catch (e) { log.warn(`terminal ${pane}: keys failed`, e); }
      if (!typed) send({ t: "error", error: "keys_refused" });
```
with
```ts
      // "uncertain": the node may have typed them (the connection dropped while they were out), so the app says "may have
      // been typed", never "refused" (fleet core §3.1); keystrokes are never retried.
      let typed: boolean | "uncertain" = false;
      try { typed = await remote.terminal.keys(pane, m.data); }
      catch (e) { log.warn(`terminal ${pane}: keys failed`, e); }
      if (typed === "uncertain") send({ t: "error", error: "keys_uncertain" });
      else if (!typed) send({ t: "error", error: "keys_refused" });
```

Create `apps/hub/src/adapters/local-ports.ts`, the legacy set as one builder over Task 4/5's `local-node.ts`, and the desktop target, which only a legacy hub has (spec §3.1):

```ts
// The hub's ports in legacy single-host mode (fleet core §10): this machine's tmux and Claude Code as the one node
// "local" (local-node.ts), as one set. main.ts takes these unless MORNDO_FLEET_SOCKET names a fleet (fleet-adapters.ts).
// No fleet means nobody to ask about a send in doubt (sendStatus) or about which nodes answer (nodeStates).
import { sessionRegistry, terminalAdapter, tmuxAdapter } from "@morndo/node-ops";
import type { HubPorts } from "../application/ports.ts";
import type { Config } from "../config.ts";
import type { Files } from "./files.ts";
import { localFiles, localSessions, localTmux, localTranscripts, localUploads } from "./local-node.ts";
import { readVncPassword, type DesktopTarget } from "./rfb.ts";

export function legacyPorts(config: Config, deps: { files: Pick<Files, "register"> }): HubPorts {
  const registry = config.claudeDir ? sessionRegistry(config.claudeDir) : null;
  return {
    tmux: localTmux(tmuxAdapter({ socket: config.tmuxSocket, session: config.tmuxSession })),
    terminal: terminalAdapter({ socket: config.tmuxSocket }),
    sessions: registry ? localSessions(registry) : null,
    transcripts: registry ? localTranscripts(registry) : null,
    files: localFiles(deps.files),
    uploads: localUploads(),
    sendStatus: null,
    nodeStates: null,
  };
}

// The office's desktop (VNC) for the remote view: this machine's, in legacy mode only. With a fleet it is null whatever
// MORNDO_VNC says (fleet core §3.1: "no desktop" until the desktop op exists), so the route answers no_desktop and the
// app shows no Desktop tab. The password is read for each connection, so a changed vncpasswd file applies without a
// restart.
export function desktopTarget(config: Config, fleet: boolean): () => DesktopTarget | null {
  return () => {
    if (fleet || !config.vnc) return null;
    let password: string | null = null;
    try { password = readVncPassword(config.vnc.passwordFile); } catch { /* no password file: the server must allow None */ }
    return { host: config.vnc.host, port: config.vnc.port, password };
  };
}
```

- [ ] **Step 14.11: Run it and see it pass**

Run: `npx vitest run apps/hub/test/fleet-adapters.test.ts apps/hub/test/fleet-client.test.ts apps/hub/test/local-ports.test.ts apps/hub/test/http-terminal-throws.test.ts`
Expected: PASS, 16 tests in `fleet-adapters.test.ts`, 10 in `fleet-client.test.ts`, 5 in `local-ports.test.ts` and 4 in `http-terminal-throws.test.ts`.

- [ ] **Step 14.12: Commit, then the negative controls**

```bash
git add apps/hub/src/adapters/fleet-adapters.ts apps/hub/src/adapters/local-ports.ts apps/hub/src/application/ports.ts apps/hub/src/application/remote-service.ts \
  apps/hub/src/adapters/http.ts apps/hub/test/helpers/hub-mode.ts apps/hub/test/fleet-adapters.test.ts apps/hub/test/local-ports.test.ts \
  apps/hub/test/http-crash-fixture.ts apps/hub/test/http-terminal-throws.test.ts
git commit -m "feat(hub): fleet adapters for every hub port, and the legacy set as one"
```

Each control alone, undone with `git checkout -- <file>`, `git status` clean after each:
- **The listing waits for a slow node** (round 2, item 13). In `fleet-adapters.ts`, replace `within(refreshInventory(node), LIMITS.inventoryWaitMs)` with `refreshInventory(node).catch(() => {})`. `npx vitest run apps/hub/test/fleet-adapters.test.ts -t "300 ms|never answers"` fails twice: "waits at most 300 ms …" with `AssertionError: expected 1006 to be less than 800` (the listing waited for the slow node's whole second), and "… never answers holds no listing …" with `AssertionError: expected 4007 to be less than 800` (it waited until the client gave up).
- **Keys whose answer was lost read as refused** (item 25). Replace `return r.error.executed === "maybe" ? "uncertain" : false;` with `return false;`. `npx vitest run apps/hub/test/fleet-adapters.test.ts -t "may have been typed"` fails with `AssertionError: expected false to be 'uncertain'`.
- **A node that can't answer now reads as a transcript that is gone** (item 15). Delete the line `    if (NOT_NOW.has(r.error.code)) throw new SourceUnavailable(`${op} on ${node}: ${r.error.code}`);`. `npx vitest run apps/hub/test/fleet-adapters.test.ts -t SourceUnavailable` fails with `AssertionError: promise resolved "null" instead of rejecting` (a node that can't answer now read as a transcript that is gone).
- **The socket says refused for uncertain keys** (item 25). In `http.ts`, replace `      if (typed === "uncertain") send({ t: "error", error: "keys_uncertain" });` and the line after it with `      if (!typed || typed === "uncertain") send({ t: "error", error: "keys_refused" });`. `npx vitest run apps/hub/test/http-terminal-throws.test.ts -t uncertain` fails with `AssertionError: expected [ Array(1) ] to deeply equal [ Array(1) ]` (`keys_refused` where `keys_uncertain` was due).
- **A fleet hub with a desktop** (item 33). In `local-ports.ts`, replace `    if (fleet || !config.vnc) return null;` with `    if (!config.vnc) return null;`. `npx vitest run apps/hub/test/local-ports.test.ts` fails in "the desktop …" with `AssertionError: expected { host: '127.0.0.1', port: 5901, …(1) } to be null`.

- [ ] **Step 14.13: Write the failing steering test (the repeat path, spec §3.1)**

Create `apps/hub/test/fleet-steering.test.ts`:

```ts
// The repeat of a send in doubt, resolved by the node's own record (spec §3.1 "Uncertain becomes resolvable"; §7
// "Connection lost during pane.send"). The hub's row says started, and op.status decides:
// - done → duplicate, at the node's own typedAt, typed once;
// - unknown from the store the send went to → the node never started it, so it is typed now, once;
// - unknown from another store (the agent's database was lost meanwhile), or with no store known (the fleet took the send
//   and never answered) → uncertain, never typed again;
// - started, or the node can't be asked → uncertain.
// Two repeats at once ask the node once and paste at most once. A node that is offline refuses before anything is
// typed, so the row goes and the retry types once the node is back.
// SteeringService on a real store, the fleet adapters, the fake fleet; no tmux.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import type { Authenticated } from "../src/application/access-service.ts";
import { LOST, localNode, memoryBackend, until, type MemoryBackend } from "./helpers/fake-fleet.ts";
import { fleetRig, steeringFor, type FleetRig } from "./helpers/hub-mode.ts";

const NOW = Date.UTC(2026, 9, 6, 9);
const PC1 = "pc.aaaaaaaa.1";
const RID = "0b7a52c1-4d2e-4f3a-9b8c-7d6e5f4a3b2c";
const KEY = `ep1:${RID}`;
const A: Authenticated = {
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: NOW - 1000, lastSeenAt: NOW, verifiedAt: NOW - 1000, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Mac", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: NOW, revokedAt: null },
};

let dir: string;
let store: Store;
let pc: MemoryBackend;
let rig: FleetRig;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "morndo-fleet-steering-"));
  store = new Store(dir);
  pc = memoryBackend({ "%1": { name: "alpha", cwd: "/w/alpha", screen: "──────\n❯ " } });
  pc.typedAt = NOW + 7;                                  // the node's clock, a little ahead of the hub's
  rig = await fleetRig([localNode("pc", "aaaaaaaa", pc)]);
  await rig.ports.tmux.listWorkers();
});
afterEach(async () => {
  await rig.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
// A new SteeringService on the same store and the same fleet stands for the hub restarting.
const steering = () => steeringFor(rig.ports, { store, now: () => NOW });
const send = () => steering().send(A, PC1, "ship it", RID, [], "none");
const rows = () => store.db.prepare("SELECT key, state FROM sends ORDER BY key").all();
const statusCalls = () => rig.fleet.calls.filter(c => c.op === "op.status").length;

describe("a repeat of a send in doubt asks the node (op.status)", () => {
  it("a drop after the paste: uncertain while the node's record says started; duplicate once it says done; typed once", async () => {
    const release = pc.hold();                                         // the pane takes the paste, then waits
    rig.fleet.intercept("pane.send", async (_call, next) => { void next(); return LOST; });
    await expect(send()).rejects.toThrow(/uncertain/);
    rig.fleet.intercept("pane.send", null);
    expect(rows()).toEqual([{ key: KEY, state: "started" }]);
    await until(() => pc.typed.length === 1);
    expect(await send()).toEqual({ ok: false, problem: "uncertain" });   // the node: started
    release();
    await until(() => rig.fleet.node("pc").keys.get(`hub:${KEY}`)?.state === "done");
    expect(await send()).toEqual({ ok: false, problem: "duplicate", at: NOW + 7 });   // the node's typedAt, from op.status
    expect(pc.typed.map(t => t.text)).toEqual(["ship it"]);
    expect(rows()).toEqual([{ key: KEY, state: "done" }]);
  });

  it("lost before the node had it: op.status unknown, so the repeat types it, once", async () => {
    rig.fleet.intercept("pane.send", async () => LOST);
    await expect(send()).rejects.toThrow(/uncertain/);
    rig.fleet.intercept("pane.send", null);
    expect(pc.typed).toEqual([]);
    expect(await send()).toEqual({ ok: true, at: NOW + 7 });
    expect(pc.typed.map(t => t.text)).toEqual(["ship it"]);
    expect(rows()).toEqual([{ key: KEY, state: "done" }]);
    expect(rig.fleet.calls.filter(c => c.op === "op.status")).toHaveLength(1);
  });

  it("a drop after the paste, then the node's agent database lost (a new store): uncertain, never typed again", async () => {
    rig.fleet.intercept("pane.send", async (_call, next) => { await next(); return LOST; });
    await expect(send()).rejects.toThrow(/uncertain/);
    rig.fleet.intercept("pane.send", null);
    expect(store.send(KEY)?.store).toBe(rig.fleet.node("pc").store);   // the store the send went to, kept with its row
    rig.fleet.node("pc").resetStore();                                 // its keys are gone: op.status can only say unknown
    expect(await send()).toEqual({ ok: false, problem: "uncertain" });
    expect(pc.typed.map(t => t.text)).toEqual(["ship it"]);
    expect(rows()).toEqual([{ key: KEY, state: "started" }]);
  });

  it("the fleet took the send and never answered: no store is known, so an unknown from the node isn't trusted", async () => {
    await rig.close();
    rig = await fleetRig([localNode("pc", "aaaaaaaa", pc)], { timeouts: { sendMs: 50 } });
    await rig.ports.tmux.listWorkers();
    rig.fleet.intercept("pane.send", () => new Promise(() => {}));   // the request is taken; no answer ever comes
    await expect(send()).rejects.toThrow(/no answer within/);
    rig.fleet.intercept("pane.send", null);
    expect(store.send(KEY)).toMatchObject({ state: "started", store: null });
    expect(await send()).toEqual({ ok: false, problem: "uncertain" });
    expect(pc.typed).toEqual([]);
  });

  it("two repeats at once: the node is asked once, and the send typed once", async () => {
    rig.fleet.intercept("pane.send", async () => LOST);               // lost before the node had it: unknown, its store
    await expect(send()).rejects.toThrow(/uncertain/);
    rig.fleet.intercept("pane.send", null);
    const s = steering();                                             // one hub process, two repeats at once
    const [one, two] = await Promise.all([s.send(A, PC1, "ship it", RID, [], "none"), s.send(A, PC1, "ship it", RID, [], "none")]);
    expect([one, two]).toEqual([{ ok: true, at: NOW + 7 }, { ok: false, problem: "duplicate", at: NOW + 7 }]);
    expect(statusCalls()).toBe(1);
    expect(pc.typed.map(t => t.text)).toEqual(["ship it"]);
  });

  it("the node can't be asked about it: uncertain, and nothing is typed", async () => {
    rig.fleet.intercept("pane.send", async () => LOST);
    await expect(send()).rejects.toThrow(/uncertain/);
    rig.fleet.intercept("pane.send", null);
    await rig.fleet.setStatus("pc", "offline");
    expect(await send()).toEqual({ ok: false, problem: "uncertain" });
    expect(rows()).toEqual([{ key: KEY, state: "started" }]);
    expect(pc.typed).toEqual([]);
  });
});

describe("a node that is offline", () => {
  it("refuses before typing: the row goes, and the retry types once the node is back", async () => {
    await rig.fleet.setStatus("pc", "offline");
    expect(await send()).toEqual({ ok: false, problem: "node_offline" });
    expect(rows()).toEqual([]);
    await rig.fleet.setStatus("pc", "online");
    expect(await send()).toEqual({ ok: true, at: NOW + 7 });
    expect(pc.typed.map(t => t.text)).toEqual(["ship it"]);
  });
});
```

- [ ] **Step 14.14: Run it and see it fail**

Run: `npx vitest run apps/hub/test/fleet-steering.test.ts`
Expected: FAIL, 5 of 7 tests failed (SteeringService has no `op.status` yet, and `steeringFor` passes none, so every repeat is "uncertain"; nor does it keep a send's store):
- "a drop after the paste": `AssertionError: expected { ok: false, problem: 'uncertain' } to deeply equal { ok: false, …(2) }`;
- "lost before the node had it": `AssertionError: expected { ok: false, problem: 'uncertain' } to deeply equal { ok: true, at: 1791277200007 }`;
- "… the node's agent database lost (a new store) …": `AssertionError: expected undefined to be '<the node's store>'` (no store kept with the row);
- "the fleet took the send and never answered …": `AssertionError: expected { state: 'started', …(2) } to match object { state: 'started', store: null }`;
- "two repeats at once …": `AssertionError: expected [ { ok: false, …(1) }, …(1) ] to deeply equal [ …(2) ]`.

Two pass already: "the node can't be asked" (without `op.status` every repeat is "uncertain", which is also what this case wants), and "refuses before typing" (Task 5 put `node_offline` in `BEFORE_PASTE`).

- [ ] **Step 14.15: Implement the repeat path in SteeringService, with the store each send went to**

In `apps/hub/src/application/steering-service.ts` (as Task 5 left it; Task 5 already made `BEFORE_PASTE` a `Set<SendOutcome["problem"]>` that holds `node_offline`, and `SendResult` carries it):

1. **Import.** Replace `import type { SendOutcome, Tmux, UploadSink } from "./ports.ts";` with `import { SendInDoubt, type SendOutcome, type SendStatus, type Tmux, type UploadSink } from "./ports.ts";`.
2. **`BEFORE_PASTE`'s comment.** Replace
   ```ts
   // Refusals that come before anything is pasted (tmux.ts, and a fleet's "node_offline", executed "no"): nothing reached
   // the pane, so a retry may type it. A "not_submitted" comes after the paste, and a throw can't tell: those keep their
   // row, and a repeat is "uncertain".
   ```
   with
   ```ts
   // Refusals that come before anything is pasted (tmux.ts, and a fleet's "node_offline", executed "no"): nothing reached
   // the pane, so a retry may type it. A "not_submitted" comes after the paste, and a throw can't tell: those keep their
   // row, and a repeat asks the node (op.status) when there is one, else is "uncertain".
   ```
3. **Field.** After `  #uploads: UploadSink;` add:
   ```ts
     #status: SendStatus | null;                                // the fleet's op.status; null: the legacy hub, nobody else knows
   ```
4. **Constructor.** Replace
   ```ts
       nameOf: (workerId: string) => string | null = () => null, uploads: UploadSink = localUploads(),
     ) {
   ```
   with
   ```ts
       nameOf: (workerId: string) => string | null = () => null, uploads: UploadSink = localUploads(),
       status: SendStatus | null = null,
     ) {
       this.#status = status;
   ```
   The existing assignments stay below it.
5. **The repeat path, registered before its first await** (round 2, item 21: two repeats of a send in doubt at once ask the node once and paste at most once). Replace
   ```ts
       const known = this.#store.send(key);
       if (known?.state === "done") return { ok: false, problem: "duplicate", at: known.typedAt ?? known.at };
       if (known?.state === "started") return { ok: false, problem: "uncertain" };   // the hub stopped while typing it

       if (!mayCommand(a.session, now, this.#policy())) return { ok: false, problem: "step_up" };
   ```
   with
   ```ts
       const known = this.#store.send(key);
       if (known?.state === "done") return { ok: false, problem: "duplicate", at: known.typedAt ?? known.at };
       // Registered before the first await (the node asked about a send in doubt, the images staged), so a repeat arriving
       // meanwhile waits for this one: two repeats of a send in doubt at once paste it at most once.
       const job = this.#judge(a, key, workerId, text, uploads, now, known?.state === "started", seen, name);
       this.#typing.set(key, job);
       try { return await job; }
       finally { this.#typing.delete(key); }
     }

     // A send in doubt is settled with its node first; then the send is judged on arrival and typed.
     async #judge(a: Authenticated, key: string, workerId: string, text: string, uploads: string[], now: number, inDoubt: boolean, seen?: string, name?: string): Promise<SendResult> {
       if (inDoubt) {
         const settled = await this.#settle(key, workerId);
         if (settled) return settled;                       // still in doubt, or typed after all; null: never started, judged anew
       }
       if (!mayCommand(a.session, now, this.#policy())) return { ok: false, problem: "step_up" };
   ```
   (the checks between `step_up` and `attachable` stay as they are, now in `#judge`), and replace
   ```ts
       const attached = attachable(uploads, id => this.#inbox?.get(id), a.endpoint.id, now);
       if (!attached.ok) return { ok: false, problem: attached.error };
       // Registered before the first await, so a repeat arriving while the images are staged waits for this one.
       const job = this.#stageAndType(a, key, workerId, text, attached.value, now);
       this.#typing.set(key, job);
       try { return await job; }
       finally { this.#typing.delete(key); }
     }
   ```
   with
   ```ts
       const attached = attachable(uploads, id => this.#inbox?.get(id), a.endpoint.id, now);
       if (!attached.ok) return { ok: false, problem: attached.error };
       return this.#stageAndType(a, key, workerId, text, attached.value, now);
     }
   ```
6. **`#settle`.** Add this private method right after `#judge` (before `#stageAndType`):
   ```ts
     // A repeat of a send this hub recorded "started" and never finished: the hub stopped, or the connection dropped,
     // while it was being typed. Without a fleet nobody else knows: "uncertain", as before. With one, the node's record
     // of the key decides (spec §3.1):
     // - done → "duplicate" with the node's own typedAt (what the echo is matched by), recorded done here too;
     // - unknown, from the store the send went to → it never started there, so the row goes and the send is judged and
     //   typed as a new one (null);
     // - unknown from another store (a new or restored agent database, whose keys are gone), or with no store recorded
     //   (no answer ever came) → "uncertain": nobody can say it wasn't typed;
     // - started, or the node can't be asked → "uncertain".
     // A repeat while this process is still settling or typing it never gets here: it waits for that outcome (above). The
     // row is read again after the node answered.
     async #settle(key: string, workerId: string): Promise<SendResult | null> {
       if (!this.#status) return { ok: false, problem: "uncertain" };
       let s: Awaited<ReturnType<SendStatus>>;
       try { s = await this.#status(workerId, key); }
       catch (e) { log.warn(`the state of a send to ${workerId} can't be asked; the repeat stays uncertain`, e); return { ok: false, problem: "uncertain" }; }
       const row = this.#store.send(key);
       if (!row) return null;                                         // gone meanwhile: judged anew
       if (row.state === "done") return { ok: false, problem: "duplicate", at: row.typedAt ?? row.at };
       if (s.state === "done") { this.#store.finishSend(key, s.typedAt); return { ok: false, problem: "duplicate", at: s.typedAt }; }
       if (s.state === "unknown") {
         if (row.store === null || row.store !== s.store) {
           log.warn(`a send to ${workerId} in doubt: its node answers from another store than the one the send went to; it stays uncertain`);
           return { ok: false, problem: "uncertain" };
         }
         this.#store.dropSend(key);
         return null;
       }
       return { ok: false, problem: "uncertain" };
     }
   ```
7. **The store a send went to** (round 2, item 5). In `#type`, replace
   ```ts
       try { outcome = await this.#tmux.send(workerId, body, key); }
       catch (e) { log.warn(`send to ${workerId} failed while typing; a repeat will be uncertain`, e); throw e; }
   ```
   with
   ```ts
       try { outcome = await this.#tmux.send(workerId, body, key); }
       catch (e) {
         if (e instanceof SendInDoubt && e.store !== null) this.#store.setSendStore(key, e.store);   // the store a repeat asks
         log.warn(`send to ${workerId} failed while typing; a repeat will be uncertain`, e);
         throw e;
       }
       if (outcome.store) this.#store.setSendStore(key, outcome.store);
   ```

In `apps/hub/src/adapters/store.ts` (as Task 5 left it), replace `send(key)` (its comment above it stays):
```ts
  send(key: string): { state: "started" | "done"; at: number; typedAt: number | null } | null {
    const r = this.db.prepare("SELECT state, at, typed_at FROM sends WHERE key = ?").get(key) as { state: "started" | "done"; at: number; typed_at: number | null } | undefined;
    return r ? { state: r.state, at: r.at, typedAt: r.typed_at } : null;
  }
```
with
```ts
  send(key: string): { state: "started" | "done"; at: number; typedAt: number | null; store: string | null } | null {
    const r = this.db.prepare("SELECT state, at, typed_at, node_store FROM sends WHERE key = ?").get(key) as { state: "started" | "done"; at: number; typed_at: number | null; node_store: string | null } | undefined;
    return r ? { state: r.state, at: r.at, typedAt: r.typed_at, store: r.node_store } : null;
  }
  // The store of the node a send went to (fleet core §3.1), kept with its row: only that store can say it never started.
  setSendStore(key: string, store: string) { this.db.prepare("UPDATE sends SET node_store = ? WHERE key = ?").run(store, key); }
```

In `apps/hub/src/adapters/migrations.ts`, add as the last element of `MIGRATIONS`, after the `version: 9` entry (`ask_first_seen`: 9 went to it during execution, in Task 5's fix round) and before the closing `];`:
```ts
  {
    version: 10,
    name: "sends.node_store: the agent database a send in doubt went to, so a repeat can tell a lost key from a send never started (fleet core §3.1)",
    up: db => { if (!hasColumn(db, "sends", "node_store")) db.exec("ALTER TABLE sends ADD COLUMN node_store TEXT"); },
  },
```

In `apps/hub/test/helpers/hub-mode.ts`, `steeringFor` now hands the fleet's `op.status` on: replace
```ts
    o.waitingOn ?? (() => "none"), o.nameOf ?? (() => null), p.uploads);
```
with
```ts
    o.waitingOn ?? (() => "none"), o.nameOf ?? (() => null), p.uploads, p.sendStatus);
```

EscalationService is unchanged here: Task 5 already let its `send` answer `"node_offline"` and gave `AnswerResult` that problem.

- [ ] **Step 14.16: Run it and see it pass**

Run: `npx vitest run apps/hub/test/fleet-steering.test.ts apps/hub/test/steering-durable.test.ts apps/hub/test/steering-inflight-duplicate.test.ts apps/hub/test/steering-throw-retry.test.ts apps/hub/test/migrations.test.ts`
Expected: PASS, 5 files, 30 tests: 7 in `fleet-steering.test.ts`, 8 in `migrations.test.ts` (it migrates to the latest version, 9 now), and the three legacy steering suites unchanged (the legacy hub passes no status, so a repeat is still "uncertain").

- [ ] **Step 14.17: Commit, then the negative controls**

```bash
git add apps/hub/src/application/steering-service.ts apps/hub/src/adapters/store.ts apps/hub/src/adapters/migrations.ts apps/hub/test/helpers/hub-mode.ts apps/hub/test/fleet-steering.test.ts
git commit -m "feat(hub): resolve repeats of sends in doubt with op.status, from the store each send went to"
```

The controls come after the commit, so that `git checkout -- apps/hub/src/application/steering-service.ts` restores this task's code, not Task 5's. Each one alone, restored that way before the next, `git status` clean after each:
- In `#settle`, replace `at: s.typedAt }; }` with `at: this.#now() }; }` (the hub's clock instead of the node's). `npx vitest run apps/hub/test/fleet-steering.test.ts` fails in "a drop after the paste" with `AssertionError: expected { ok: false, …(2) } to deeply equal { ok: false, …(2) }` (`at` is `NOW`, not `NOW + 7`).
- Replace the two lines `      this.#store.dropSend(key);` and `      return null;` in `#settle` with `      return { ok: false, problem: "uncertain" };` (an unknown never trusted). The same run fails in "lost before the node had it" with `AssertionError: expected { ok: false, problem: 'uncertain' } to deeply equal { ok: true, at: 1791277200007 }`; "two repeats at once" fails as well.
- Replace `row.store === null || row.store !== s.store` with `false` (an unknown trusted from any store). The same run fails in "…the node's agent database lost (a new store)…" and in "the fleet took the send and never answered…", each with `AssertionError: expected { ok: true, at: 1791277200007 } to deeply equal { ok: false, problem: 'uncertain' }`: the repeat typed the text a second time.
- Delete the line `    this.#typing.set(key, job);` in `send` (a repeat no longer waits for the one settling). `npx vitest run apps/hub/test/fleet-steering.test.ts -t "two repeats"` fails with `AssertionError: expected [ …(2) ] to deeply equal [ …(2) ]`: the second repeat asked the node too, and was answered while the first one's paste was in flight.

- [ ] **Step 14.18: Write the failing config test**

Create `apps/hub/test/config-fleet.test.ts`:

```ts
// MORNDO_FLEET_SOCKET (spec §10): set, the hub's ports go through the fleet service's client socket; unset, the legacy
// local adapters, exactly as before. A relative path is refused at start: ws names the socket by its absolute path.
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

describe("MORNDO_FLEET_SOCKET", () => {
  it("unset or empty: no fleet, the legacy local adapters", () => {
    expect(loadConfig({}).fleetSocket).toBeNull();
    expect(loadConfig({ MORNDO_FLEET_SOCKET: "" }).fleetSocket).toBeNull();
  });
  it("set: the fleet's client socket, an absolute path", () => {
    expect(loadConfig({ MORNDO_FLEET_SOCKET: "/home/o/.local/state/morndo-fleet/fleet.sock" }).fleetSocket).toBe("/home/o/.local/state/morndo-fleet/fleet.sock");
  });
  it("a relative path is refused, not guessed at", () => {
    expect(() => loadConfig({ MORNDO_FLEET_SOCKET: "fleet.sock" })).toThrow("MORNDO_FLEET_SOCKET must be an absolute path: fleet.sock");
  });
});
```

- [ ] **Step 14.19: Run it and see it fail**

Run: `npx vitest run apps/hub/test/config-fleet.test.ts`
Expected: FAIL, 3 tests:
- `expected undefined to be null`;
- `expected undefined to be '/home/o/.local/state/morndo-fleet/fle…'`;
- `expected [Function] to throw an error`.

- [ ] **Step 14.20: Implement the `MORNDO_FLEET_SOCKET` switch (config.ts, main.ts)**

In `apps/hub/src/config.ts`:

1. **Imports** (`:1-2`). Replace `import { join } from "node:path";` with:
   ```ts
   import { isAbsolute, join } from "node:path";
   ```
2. **`Config` type.** After the `inboxDir: string;` line (`:24`), add:
   ```ts
     // MORNDO_FLEET_SOCKET: the fleet service's client socket (ADR-0012, spec §5.6), an absolute path. Absent or null: the
     // legacy local adapters, this machine's tmux and Claude Code directly (spec §10).
     fleetSocket?: string | null;
   ```
3. **`loadConfig` return.** After the `inboxDir: env.MORNDO_INBOX || join(homedir(), ".cache/morndo/inbox"),` line (`:91`), add:
   ```ts
       fleetSocket: fleetSocket(env),
   ```
4. **A new function** at the end of the file:
   ```ts
   // MORNDO_FLEET_SOCKET, when set: an absolute path, since ws's IPC URL names the socket by it ("ws+unix:/absolute/path/to/
   // uds_socket:/pathname", https://github.com/websockets/ws/blob/master/doc/ws.md#ipc-connections, read 2026-10-06), and a
   // relative one would depend on where the service happened to start.
   function fleetSocket(env: NodeJS.ProcessEnv): string | null {
     const v = env.MORNDO_FLEET_SOCKET || null;
     if (v !== null && !isAbsolute(v)) throw new Error(`MORNDO_FLEET_SOCKET must be an absolute path: ${v}`);
     return v;
   }
   ```

In `apps/hub/src/main.ts` (as Task 5 left it):

1. **Imports.** Replace (`:16-17`)
   ```ts
   import { denyRoots, paneLock, sessionRegistry, terminalAdapter, tmuxAdapter } from "@morndo/node-ops";
   import type { Tmux } from "./application/ports.ts";
   ```
   with
   ```ts
   import { denyRoots, paneLock } from "@morndo/node-ops";
   import { CLIENT_API } from "@morndo/protocol";
   import type { HubPorts, Tmux } from "./application/ports.ts";
   ```
   and replace (`:28-29`)
   ```ts
   import { localFiles, localSessions, localTmux, localTranscripts, localUploads } from "./adapters/local-node.ts";
   import { homedir } from "node:os";
   ```
   with
   ```ts
   import { desktopTarget, legacyPorts } from "./adapters/local-ports.ts";
   import { FleetClient, checkFleet } from "./adapters/fleet-client.ts";
   import { fleetPorts, type FleetPorts, type LocalFileStore } from "./adapters/fleet-adapters.ts";
   import { mkdtempSync } from "node:fs";
   import { homedir, tmpdir } from "node:os";
   import { join } from "node:path";
   ```
   and delete the line `import { readVncPassword } from "./adapters/rfb.ts";` (`:25`): the desktop target is `local-ports.ts`' now (`desktopTarget`).
2. **HELP** (`:41-43`). Replace
   ```
   MORNDO_CLAUDE_DIR, MORNDO_MANAGER_WINDOW (default "manager"), MORNDO_LEDGER (the manager's needs-you list),
   MORNDO_PANE_LOCK (the lock file other typists into the manager's pane take), MORNDO_VNC (host:port of the desktop's
   VNC server) and MORNDO_VNC_PASSWORD_FILE.`;
   ```
   with
   ```
   MORNDO_CLAUDE_DIR, MORNDO_MANAGER_WINDOW (default "manager"), MORNDO_LEDGER (the manager's needs-you list),
   MORNDO_PANE_LOCK (the lock file other typists into the manager's pane take), MORNDO_VNC (host:port of the desktop's
   VNC server), MORNDO_VNC_PASSWORD_FILE and MORNDO_FLEET_SOCKET (the fleet service's client socket; unset, this
   machine's tmux and Claude Code directly).`;
   ```
3. **The `serve` block.** Replace everything from
   ```ts
       // Legacy single-host mode (fleet core §10): this machine is the one node, "local".
   ```
   (`:78`) through the end of `new RemoteService({…});` (`:121`) with:
   ```ts
       const files = fileStore({ dir: config.filesDir, deny: denyRoots(homedir(), config.dataDir) });
       // MORNDO_FLEET_SOCKET set: every port goes through the fleet service; unset: this machine's tmux and Claude Code, as
       // before (spec §10). Nothing below this line knows which.
       const fleet = config.fleetSocket ? await openFleet(config.fleetSocket, files) : null;
       const ports: HubPorts = fleet ?? legacyPorts(config, { files });
       // A poll waits for its nodes at most one poll interval, and skips a node that isn't online (fleet core §3.1).
       const observation = new ObservationService(ports.tmux, config.quietAfterMs, Date.now, {
         sessions: ports.sessions, transcripts: ports.transcripts, files: ports.files, nodeStates: ports.nodeStates, nodeWaitMs: config.pollMs,
       });
       // Typing into the manager's pane takes the lock its other typists take, so two pastes never merge into one message.
       // Legacy only: with a fleet, the node's agent takes it (spec §3.1, "Pane lock").
       const managerPane = () => observation.snapshot().workers.find(w => w.name === config.managerWindow)?.id ?? null;
       const lock = !fleet && config.paneLock ? paneLock(config.paneLock) : null;
       const typist: Tmux = !lock ? ports.tmux : {
         ...ports.tmux,
         send: async (id, text, key) => {
           if (id !== managerPane()) return ports.tmux.send(id, text, key);
           const r = await lock(() => ports.tmux.send(id, text, key));
           return r === "busy" ? { problem: "busy", typedAt: Date.now() } : r;
         },
       };
       const inbox = uploadInbox({ dir: config.inboxDir, registry: store });
       // A Command is judged on arrival against what the worker waits for now (S6). With a fleet, a repeat of a send in
       // doubt asks the worker's node (op.status, spec §3.1).
       const steering = new SteeringService(store, typist, Date.now, () => access.policy(), inbox, id => observation.waitingOn(id),
         id => observation.nameOf(id), ports.uploads, ports.sendStatus);
       const escalations = new EscalationService({
         watch: {
           workers: () => observation.snapshot().workers.map(w => ({ id: w.id as string, name: w.name })),
           history: id => observation.history(id, CONVERSATION_CAP),
           openQuestions: id => observation.openQuestions(id),
           screen: id => observation.screen(id),
         },
         ledger: config.ledgerPath ? ledgerReader(config.ledgerPath) : null,
         store, managerName: config.managerWindow, send: async (pane, text, key) => (await typist.send(pane, text, key)).problem, policy: () => access.policy(),
       });
       const remote = new RemoteService({
         store, terminal: ports.terminal, policy: () => access.policy(),
         panes: () => observation.snapshot().workers.map(w => w.id as string),
         // This machine's desktop in legacy mode only; with a fleet there is none (spec §3.1), so it answers no_desktop.
         desktop: desktopTarget(config, fleet !== null),
       });
   ```
4. **`stop`** (`:161`, before this step's edits). Replace
   ```ts
       const stop = async () => { clearInterval(sweepInbox); stopRetention(); observation.stop(); escalations.stop(); notifications.stop(); await http.close(); store.close(); process.exit(0); };
   ```
   with
   ```ts
       const stop = async () => { clearInterval(sweepInbox); stopRetention(); observation.stop(); escalations.stop(); notifications.stop(); fleet?.stop(); await http.close(); store.close(); process.exit(0); };
   ```
5. **`openFleet`.** Add it at the end of the file, after the `switch`:
   ```ts

   // The fleet adapters on MORNDO_FLEET_SOCKET (spec §10). The client API version is checked once:
   // - one this hub doesn't speak is a setting to fix, said in one sentence with exit 78, like a database from the future
   //   (openStore above);
   // - a fleet that doesn't answer yet is only said: the observation loop keeps asking, and the hub serves meanwhile
   //   (spec §7, "Fleet service down or restarting").
   async function openFleet(socket: string, files: LocalFileStore): Promise<FleetPorts> {
     const client = new FleetClient(socket);
     const check = await checkFleet(client);
     if (check === "unsupported") {
       log.error(`the fleet service at ${socket} doesn't offer client API version ${CLIENT_API}; update morndo-fleet or this hub`);
       process.exit(EXIT_CONFIG);
     }
     if (check === "unreachable") log.warn(`the fleet service at ${socket} doesn't answer yet; the hub keeps asking`);
     const ports = fleetPorts(client, { files, stagingDir: mkdtempSync(join(tmpdir(), "morndo-fleet-files-")) });
     await ports.start();
     return ports;
   }
   ```

- [ ] **Step 14.21: Run the config test, then start the real hub in both modes on throwaway directories**

Run: `npx vitest run apps/hub/test/config-fleet.test.ts`
Expected: PASS, 3 tests.

Then smoke-run the real entry point, starting with fleet mode against a socket that doesn't exist. It uses only a temporary directory (`mktemp -d`: keep its path short, a Unix socket path holds at most 104 bytes on macOS) and binds a random port on 127.0.0.1. It never touches the owner's tmux, `~/.claude` or hub data. Each run is started in the background, given time, and stopped with SIGTERM, which the hub answers by shutting down cleanly (`stop` in main.ts); no `timeout(1)` is needed.
```bash
t=$(mktemp -d)
MORNDO_HOME="$t/data" MORNDO_INBOX="$t/inbox" MORNDO_PORT=0 MORNDO_FLEET_SOCKET="$t/none.sock" \
  node --no-warnings apps/hub/src/main.ts serve > "$t/fleet.log" 2>&1 & pid=$!
sleep 15; kill $pid; wait $pid; echo "exit $?"
grep -c "doesn't answer yet; the hub keeps asking" "$t/fleet.log"; grep -c "first look failed" "$t/fleet.log"; grep -c "morndo hub on http://127.0.0.1:0" "$t/fleet.log"
MORNDO_HOME="$t/data" MORNDO_FLEET_SOCKET=fleet.sock node --no-warnings apps/hub/src/main.ts serve; echo "exit $?"
MORNDO_HOME="$t/data2" MORNDO_INBOX="$t/inbox2" MORNDO_PORT=0 MORNDO_TMUX_SOCKET="test-$(uuidgen)" MORNDO_CLAUDE_DIR=off \
  node --no-warnings apps/hub/src/main.ts serve > "$t/legacy.log" 2>&1 & pid=$!
sleep 5; kill $pid; wait $pid; echo "exit $?"
grep -c "morndo hub on" "$t/legacy.log"; rm -rf "$t"
```
Expected:
- The fleet run prints `exit 0` (it ran until the SIGTERM and stopped cleanly). Its log has one "doesn't answer yet" line, the `connect ENOENT` warnings of the event subscription and of the first look at the nodes, five `first look failed` warnings (one every 2 s), then one `morndo hub on` line: the greps print `1`, `5` and `1`.
- The relative path exits 1 with `Error: MORNDO_FLEET_SOCKET must be an absolute path: fleet.sock` (thrown by `loadConfig`, reported by `exitOnCrash` as an uncaught exception).
- The legacy run (a tmux server name nobody runs, so no workers) prints `exit 0`, and its grep prints `1`.

- [ ] **Step 14.22: Commit**

```bash
git add apps/hub/src/config.ts apps/hub/src/main.ts apps/hub/test/config-fleet.test.ts
git commit -m "feat(hub): MORNDO_FLEET_SOCKET selects the fleet adapters"
```

- [ ] **Step 14.23: Run the steering, observation and remote suites in both modes**

This is how the existing suites run against the fake fleet. Each suite builds its local ports, calls `portsFor(mode, …)` inside `describe.each(HUB_MODES)`, names panes as `ports.id("%N")`, and builds services only through `hub-mode.ts`. `HUB_MODES` comes from `MORNDO_HUB_MODES` (default `legacy,fleet`).

Every suite whose services touch the ports runs in both modes (spec §12.2; round 2, item 17): the three below that round 1 converted (`steering-durable`, `observation-waiting-on`, `remote-service`), and six more that touch them (`observation-nodes`, `observation-attachments`, `steering-keys`, `escalation-answer-keys`, `steering-inflight-duplicate`, `steering-throw-retry`). `http-older` runs in both modes from Task 15 on (Step 15.6): its fleet mode sends worker ids in the feed's frames, which the protocol takes from Step 15.3. The port-touching suites that stay legacy-only, and why:
- `steering.test.ts`, `tmux-no-input-box.test.ts` and the moved `tmux-*` tests run the local tmux adapter on a private tmux server: they test that adapter, and the fleet's counterpart is the agent's own tests on a real tmux (Task 8);
- `local-node.test.ts` and `local-ports.test.ts` test the legacy adapters themselves;
- `observation-refollow.test.ts`, `observation-loop-errors.test.ts` (it runs the hub in a child process) and `escalation-window.test.ts` read this machine's session registry and transcript files directly; they are left for later, and are listed so in RECONCILIATION.md.

Replace `apps/hub/test/steering-durable.test.ts` with:

```ts
// The hub's dedupe of request ids is durable (ADR-0008 phase C; S5): a row is written "started" before typing and
// "done" after. After a restart, a repeat of a done request is "duplicate"; a repeat of one that was still being typed
// when the hub stopped is "uncertain" and is never typed again. A refusal before the paste leaves no row, so a retry may
// type. And a Command is judged on arrival against the needs-you state it saw (S6): "stale" if it changed either way.
// Both configurations (spec §9):
// - the legacy hub types through its local port;
// - the fleet hub types through the fake fleet, whose node keeps the agent's two-phase keys, so a repeat there asks the
//   node (op.status) and gets the same answers.
// Real SQLite in a temp dir, and one fake agent pane per test. A new SteeringService on the same store and the same pane
// stands for the hub restarting.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId } from "@morndo/domain";
import type { SendProblem } from "@morndo/node-ops";
import { Store } from "../src/adapters/store.ts";
import type { SendOutcome, Tmux } from "../src/application/ports.ts";
import type { Authenticated } from "../src/application/access-service.ts";
import { until } from "./helpers/fake-fleet.ts";
import { HUB_MODES, portsFor, steeringFor, type ModePorts } from "./helpers/hub-mode.ts";

const NOW = Date.UTC(2026, 9, 2, 8);
let dir: string;
let store: Store;
let now: number;
const authAs = (endpoint: string): Authenticated => ({
  session: { id: sessionId(`s-${endpoint}`), endpointId: endpointId(endpoint), startedAt: NOW - 1000, lastSeenAt: NOW, verifiedAt: NOW - 1000, endedAt: null, endReason: null },
  endpoint: { id: endpointId(endpoint), name: endpoint, credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: NOW, revokedAt: null },
});
const A = authAs("ep1");
const RID = "6f1b8a52-3c1d-4e6f-9a7b-2c3d4e5f6a7b";

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-steer-durable-")); store = new Store(dir); now = NOW; });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

type Next = SendProblem | null | "hang" | "throw";
const BEFORE: readonly SendProblem[] = ["menu_open", "no_input_box", "draft_present", "no_pane", "busy"];
// One agent pane: what its next send does (then it types normally again), and every text that reached it.
function fakePane() {
  const typed: string[] = [];
  let next: Next = null;
  const tmux: Tmux = {
    listWorkers: async () => [{ id: "%1", name: "alpha", location: "w", node: "local", offline: false }],
    capture: async () => "──────\n❯ ",
    captureMany: async ids => new Map(ids.map(id => [id, "──────\n❯ "])),
    send: async (_id, text): Promise<SendOutcome> => {
      const outcome = next;
      next = null;
      if (outcome !== null && outcome !== "hang" && outcome !== "throw" && BEFORE.includes(outcome)) return { problem: outcome, typedAt: 0 };
      typed.push(text);
      if (outcome === "hang") return new Promise<SendOutcome>(() => {});        // the hub dies while typing
      if (outcome === "throw") throw new Error("tmux: server exited");
      return { problem: outcome, typedAt: now };
    },
  };
  return { tmux, typed, set: (n: Next) => { next = n; } };
}
const rows = () => store.db.prepare("SELECT key, state FROM sends ORDER BY key").all();

describe.each(HUB_MODES)("durable dedupe across a restart (S5), %s hub", mode => {
  let pane: ReturnType<typeof fakePane>;
  let ports: ModePorts;
  beforeEach(async () => { pane = fakePane(); ports = await portsFor(mode, { tmux: pane.tmux }); });
  afterEach(async () => { await ports.close(); });
  const steering = () => steeringFor(ports, { store, now: () => now });
  const W = () => ports.id("%1");

  it("a repeat after the first was typed and recorded done is duplicate, and isn't typed again", async () => {
    expect(await steering().send(A, W(), "ship it", RID, [], "none")).toEqual({ ok: true, at: NOW });
    expect(rows()).toEqual([{ key: `ep1:${RID}`, state: "done" }]);
    now = NOW + 5000;
    // The first typing's time comes back, for matching the echo (review M2; spec §3.1: the node's own typedAt).
    expect(await steering().send(A, W(), "ship it", RID, [], "none")).toEqual({ ok: false, problem: "duplicate", at: NOW });
    expect(pane.typed).toEqual(["ship it"]);
  });
  it("a repeat of a send the hub was still typing when it stopped is uncertain, never typed again", async () => {
    pane.set("hang");
    // In fleet mode this request ends when the fake fleet closes after the test: that rejection is expected.
    void steering().send(A, W(), "ship it", RID, [], "none").catch(() => {});
    await until(() => pane.typed.length === 1);
    expect(rows()).toEqual([{ key: `ep1:${RID}`, state: "started" }]);
    expect(await steering().send(A, W(), "ship it", RID, [], "none")).toEqual({ ok: false, problem: "uncertain" });
    expect(pane.typed).toHaveLength(1);
  });
  it("a refusal before anything was pasted leaves no row: the retry types it", async () => {
    for (const before of BEFORE) {
      pane.set(before);
      expect(await steering().send(A, W(), "y", RID, [], "none")).toEqual({ ok: false, problem: before });
      expect(rows(), before).toEqual([]);
    }
    expect(await steering().send(A, W(), "y", RID, [], "none")).toEqual({ ok: true, at: NOW });
    expect(pane.typed).toEqual(["y"]);
  });
  it("not submitted: the text was pasted, so the row stays and a repeat is uncertain, never typed twice (review H2)", async () => {
    pane.set("not_submitted");
    expect(await steering().send(A, W(), "y", RID, [], "none")).toEqual({ ok: false, problem: "not_submitted" });
    expect(rows()).toEqual([{ key: `ep1:${RID}`, state: "started" }]);
    expect(await steering().send(A, W(), "y", RID, [], "none")).toEqual({ ok: false, problem: "uncertain" });
    expect(pane.typed).toEqual(["y"]);
  });
  it("a throw while typing may have pasted it: the row stays and a repeat is uncertain (review H2)", async () => {
    pane.set("throw");
    await expect(steering().send(A, W(), "y", RID, [], "none")).rejects.toThrow(/server exited/);
    expect(rows()).toEqual([{ key: `ep1:${RID}`, state: "started" }]);
    expect(await steering().send(A, W(), "y", RID, [], "none")).toEqual({ ok: false, problem: "uncertain" });
    expect(pane.typed).toEqual(["y"]);
  });
  it("request ids are per Endpoint: another device's same id is its own send", async () => {
    await steering().send(A, W(), "y", RID, [], "none");
    expect(await steering().send(authAs("ep2"), W(), "y", RID, [], "none")).toEqual({ ok: true, at: NOW });
    expect(pane.typed).toEqual(["y", "y"]);
  });
  it("records older than 24 hours are pruned", async () => {
    await steering().send(A, W(), "y", RID, [], "none");
    expect(store.pruneSends(now + 24 * 3_600_000 - 1)).toBe(0);
    expect(store.pruneSends(now + 24 * 3_600_000 + 1)).toBe(1);
    expect(rows()).toEqual([]);
  });
});

describe.each(HUB_MODES)("judged on arrival against what it answers (S6), %s hub", mode => {
  let pane: ReturnType<typeof fakePane>;
  let ports: ModePorts;
  beforeEach(async () => { pane = fakePane(); ports = await portsFor(mode, { tmux: pane.tmux }); });
  afterEach(async () => { await ports.close(); });
  const steering = (waitingOn: (w: string) => string) => steeringFor(ports, { store, now: () => now, waitingOn });
  const W = () => ports.id("%1");

  it("composed with no question showing, a question showing now: stale, nothing typed", async () => {
    expect(await steering(() => "q:toolu_1").send(A, W(), "2", RID, [], "none")).toEqual({ ok: false, problem: "stale" });
    expect(pane.typed).toEqual([]);
    expect(rows()).toEqual([]);
  });
  it("composed for one question, another showing now (answered elsewhere, asked again, or changed): stale", async () => {
    expect(await steering(() => "q:toolu_2").send(A, W(), "Keep it", RID, [], "q:toolu_1")).toEqual({ ok: false, problem: "stale" });
    expect(await steering(() => "none").send(A, W(), "Keep it", RID, [], "q:toolu_1")).toEqual({ ok: false, problem: "stale" });
    expect(pane.typed).toEqual([]);
  });
  it("the same state as when it was composed: typed (steering a busy agent keeps working)", async () => {
    expect(await steering(() => "none").send(A, W(), "carry on", RID, [], "none")).toEqual({ ok: true, at: NOW });
    expect(await steering(() => "menu:ab12").send(A, W(), "1", "7f1b8a52-3c1d-4e6f-9a7b-2c3d4e5f6a7b", [], "menu:ab12")).toEqual({ ok: true, at: NOW });
    expect(pane.typed).toHaveLength(2);
  });
});
```

Replace `apps/hub/test/observation-waiting-on.test.ts` with:

```ts
// What each worker waits for, on the roster (ADR-0008 phase C, S6): an open question by its id, else a menu on its
// screen by its digest, else nothing; the hub judges a Command against it on arrival. And older pages (O9) through the
// observation service. Synthetic transcript and screens. Both configurations (spec §9): in fleet mode the same pane,
// session and transcript sit behind the fake fleet as one node, and the worker is named by its worker id.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { menuIdentity } from "@morndo/node-ops";
import type { Tmux } from "../src/application/ports.ts";
import { HUB_MODES, claudeDirPorts, observationFor, portsFor, type HubMode, type ModePorts } from "./helpers/hub-mode.ts";

let dir: string;
let ports: ModePorts | null = null;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-waiting-")); });
afterEach(async () => {
  await ports?.close();
  ports = null;
  rmSync(dir, { recursive: true, force: true });
});

const MENU = "Allow this edit?\n❯ 1. Yes\n  2. No\n\nEsc to cancel";
async function setup(mode: HubMode, lines: unknown[], screen: string) {
  mkdirSync(join(dir, "sessions"));
  mkdirSync(join(dir, "projects", "-w"), { recursive: true });
  writeFileSync(join(dir, "sessions", "1.json"), JSON.stringify({ pid: process.pid, sessionId: "s1", tmux: "qa:@0.%1", name: "builder", cwd: "/w", version: "2.1.286", updatedAt: 1 }));
  writeFileSync(join(dir, "projects", "-w", "s1.jsonl"), lines.map(l => JSON.stringify(l)).join("\n") + "\n");
  let shown = screen;
  const tmux: Tmux = {
    listWorkers: async () => [{ id: "%1", name: "builder", location: "w", node: "local", offline: false }],
    capture: async id => (id === "%1" ? shown : null),
    captureMany: async ids => new Map(ids.map(id => [id, id === "%1" ? shown : null])),
    send: async () => ({ problem: null, typedAt: 0 }),
  };
  const p = await portsFor(mode, { tmux, ...claudeDirPorts(dir) });
  ports = p;
  return { svc: observationFor(p, { quietAfterMs: 60_000 }), id: p.id, show: (s: string) => { shown = s; } };
}
const ask = { type: "assistant", uuid: "a1", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_9", name: "AskUserQuestion", input: { questions: [{ question: "Keep it?", header: "Keep", multiSelect: false, options: [{ label: "Yes", description: "" }] }] } }] } };
const said = { type: "assistant", uuid: "a0", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Working." }] } };

describe.each(HUB_MODES)("waitingOn on the roster, %s hub", mode => {
  it("an open question, by its id", async () => {
    const { svc, id } = await setup(mode, [ask], MENU);                 // a question draws a menu too: the question wins
    await svc.poll();
    expect(svc.snapshot().workers[0]?.waitingOn).toBe("q:toolu_9");
    expect(svc.waitingOn(id("%1"))).toBe("q:toolu_9");
  });
  it("a menu on the screen, by its digest; then nothing once it's answered", async () => {
    const { svc, id, show } = await setup(mode, [said], MENU);
    await svc.poll();
    expect(svc.waitingOn(id("%1"))).toBe(`menu:${menuIdentity(MENU)}`);
    show("──────\n❯ ");
    await svc.poll();
    expect(svc.waitingOn(id("%1"))).toBe("none");
    expect(svc.snapshot().workers[0]?.waitingOn).toBeNull();
  });
  it("an unknown worker waits on nothing", async () => {
    const { svc, id } = await setup(mode, [], "");
    expect(svc.waitingOn(id("%42"))).toBe("none");
  });
});

describe.each(HUB_MODES)("older pages through the observation service (O9), %s hub", mode => {
  it("reads the worker's own transcript backwards from the message asked for", async () => {
    const lines = Array.from({ length: 150 }, (_, i) => ({ type: "assistant", uuid: `r${i}`, timestamp: new Date(Date.UTC(2026, 9, 2, 8, 0, i)).toISOString(), message: { role: "assistant", content: [{ type: "text", text: `reply ${i}` }] } }));
    const { svc, id } = await setup(mode, lines, "──────\n❯ ");
    await svc.poll();
    const page = await svc.older(id("%1"), "r120:0");
    expect(page.messages.map(m => m.text)).toEqual(Array.from({ length: 100 }, (_, i) => `reply ${20 + i}`));
    expect(page.done).toBe(false);
    expect(await svc.older(id("%1"), "r20:0")).toMatchObject({ done: true });       // the page before r20: where r120's page began
    expect(await svc.older(id("%9"), "r1:0")).toEqual({ messages: [], done: false, missing: true });   // not a followed worker (L1)
    expect(await svc.older(id("%1"), "gone:0")).toEqual({ messages: [], done: false, missing: true }); // not in its transcript
  });
});
```

Replace `apps/hub/test/remote-service.test.ts` with:

```ts
// Who may watch and who may control (AC9), on synthetic sessions. And, through the port, a watcher gets the worker's
// frames and a controller's keys reach that worker's pane only. Both configurations (spec §9): in fleet mode the terminal
// sits behind the fake fleet, and the worker is named by its worker id.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId } from "@morndo/domain";
import type { Terminal } from "@morndo/node-ops";
import { Store } from "../src/adapters/store.ts";
import type { Tmux } from "../src/application/ports.ts";
import { RemoteService } from "../src/application/remote-service.ts";
import type { Authenticated } from "../src/application/access-service.ts";
import { HUB_MODES, portsFor, type ModePorts } from "./helpers/hub-mode.ts";

const T0 = Date.UTC(2026, 9, 1, 8);
const FRAME = { cols: 80, rows: 1, x: 2, y: 0, cursor: true, lines: ["$ "] };
let now = T0;
let dir: string;
let store: Store;
const auth = (verifiedAt: number, id = "s1"): Authenticated => ({
  session: { id: sessionId(id), endpointId: endpointId("ep1"), startedAt: T0 - 3_600_000 * 3, lastSeenAt: now, verifiedAt, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Mac", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: now, revokedAt: null },
});

beforeEach(() => { now = T0; dir = mkdtempSync(join(tmpdir(), "morndo-remote-")); store = new Store(dir); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe.each(HUB_MODES)("watching and control, %s hub", mode => {
  let ports: ModePorts;
  let keys: { pane: string; data: string }[];
  beforeEach(async () => {
    keys = [];
    const tmux: Tmux = {
      listWorkers: async () => [{ id: "%3", name: "builder", location: "w", node: "local", offline: false }],
      capture: async () => "$ ",
      captureMany: async ids => new Map(ids.map(id => [id, "$ "])),
      send: async () => ({ problem: null, typedAt: 0 }),
    };
    const terminal: Terminal = {
      frame: async id => (id === "%3" ? FRAME : null),
      keys: async (id, data) => { if (id !== "%3") return false; keys.push({ pane: id, data }); return true; },
    };
    ports = await portsFor(mode, { tmux, terminal });
  });
  afterEach(async () => { await ports.close(); });
  const service = (desktop = true) => new RemoteService({
    store, terminal: ports.terminal, panes: () => [ports.id("%3")], now: () => now,
    desktop: () => (desktop ? { host: "127.0.0.1", port: 5901, password: "x" } : null),
  });

  it("anyone signed in may watch; control needs a fresh passkey check (AC7, AC9)", () => {
    const r = service();
    const stale = auth(T0 - 2 * 3_600_000);
    expect(r.open(stale, { kind: "desktop" }, false).ok).toBe(true);
    expect(r.open(stale, { kind: "desktop" }, true)).toEqual({ ok: false, refused: "step_up" });
    const c = r.open(auth(T0), { kind: "terminal", workerId: ports.id("%3") }, true);
    expect(c.ok && c.viewer.grant !== null).toBe(true);
    expect(store.audit(5).map(a => a.type)).toEqual(["ControlStarted"]);
  });
  it("only known panes, and the desktop only when it is configured", () => {
    expect(service().open(auth(T0), { kind: "terminal", workerId: ports.id("%99") }, false)).toEqual({ ok: false, refused: "no_pane" });
    expect(service(false).open(auth(T0), { kind: "desktop" }, false)).toEqual({ ok: false, refused: "no_desktop" });
  });
  it("control lapses when the passkey check gets stale; ending it is recorded (never the input)", () => {
    const r = service();
    const a = auth(T0);
    const c = r.open(a, { kind: "desktop" }, true);
    if (!c.ok) throw new Error(c.refused);
    expect(r.holds(c.viewer, a)).toBe("ok");
    now = T0 + 3_600_000;
    expect(r.holds(c.viewer, a)).toBe("lapsed");
    expect(r.holds(c.viewer, null)).toBe("ended");
    expect(r.holds(c.viewer, auth(T0, "s2"))).toBe("ended");          // another session can't take over the connection
    r.closed(c.viewer, "lapsed");
    expect(store.audit(5).map(a => a.type)).toEqual(["ControlEnded", "ControlStarted"]);
    expect(store.audit(1)[0]?.body).toMatchObject({ reason: "lapsed", target: { kind: "desktop" } });
  });
  it("a watcher gets that worker's frames, and keys under control reach that pane only", async () => {
    const r = service();
    expect(await r.terminal.frame(ports.id("%3"))).toEqual(FRAME);
    expect(await r.terminal.frame(ports.id("%99"))).toBeNull();
    expect(await r.terminal.keys(ports.id("%3"), "ls\r")).toBe(true);
    expect(await r.terminal.keys(ports.id("%99"), "rm -rf /tmp/x\r")).toBe(false);
    expect(keys).toEqual([{ pane: "%3", data: "ls\r" }]);
  });
});
```

Replace `apps/hub/test/observation-nodes.test.ts` with (two nodes, one that never answers, as the ports' contract has them and behind the fake fleet):

```ts
// Polling per node, in parallel (fleet core §3.1, §9 "Isolation"): one captureMany per node and poll, a node that never
// answers doesn't hold up another's screens beyond one poll interval, and a node that isn't online is skipped at once.
// Both configurations (spec §9): nodes "a" and "b" as the ports' contract has them, and the same two nodes behind the
// fake fleet, through the hub's fleet adapters. No tmux, no transcripts.
import { afterEach, describe, expect, it } from "vitest";
import type { FeedEvent } from "@morndo/domain";
import { ObservationService, type Listener } from "../src/application/observation-service.ts";
import type { NodeState, NodeStates, Tmux } from "../src/application/ports.ts";
import { localNode, until } from "./helpers/fake-fleet.ts";
import { HUB_MODES, fleetRig, type HubMode } from "./helpers/hub-mode.ts";

const SERVERS: Record<string, string> = { a: "00000001", b: "00000002" };
const SLOW = "a.00000001.1";
const FAST = "b.00000002.1";
const idOf = (node: string, pane: string) => `${node}.${SERVERS[node] ?? ""}.${pane.slice(1)}`;

// A node: its panes (tmux id → window name) and how it answers a captureMany (by tmux ids).
type NodeSpec = { panes: Record<string, string>; capture(panes: string[]): Promise<Map<string, string | null>> };
type Nodes = { tmux: Pick<Tmux, "listWorkers" | "captureMany">; nodeStates: NodeStates; calls: { node: string; ids: string[] }[]; setState(node: string, s: NodeState): Promise<void>; close(): Promise<void> };

// Nodes "a" and "b" as the ports see them in `mode`; `calls` is every captureMany a node got, by worker id.
async function nodesFor(mode: HubMode, specs: Record<string, NodeSpec>): Promise<Nodes> {
  const calls: { node: string; ids: string[] }[] = [];
  const capture = (node: string, panes: string[]) => { calls.push({ node, ids: panes.map(p => idOf(node, p)) }); return specs[node]?.capture(panes) ?? Promise.resolve(new Map()); };
  if (mode === "legacy") {
    let states = new Map<string, NodeState>(Object.keys(specs).map(n => [n, "online"]));
    return {
      calls, close: async () => {},
      nodeStates: async () => states,
      setState: async (node, s) => { states = new Map(states).set(node, s); },
      tmux: {
        listWorkers: async () => Object.entries(specs).flatMap(([node, s]) => Object.entries(s.panes).map(([pane, name]) => ({ id: idOf(node, pane), name, location: "", node, offline: false }))),
        captureMany: async ids => {
          const node = ids[0]?.split(".")[0] ?? "";
          const got = await capture(node, ids.map(id => `%${id.split(".")[2] ?? ""}`));
          return new Map([...got].map(([pane, text]) => [idOf(node, pane), text]));
        },
      },
    };
  }
  const rig = await fleetRig(Object.entries(specs).map(([node, s]) => localNode(node, SERVERS[node] ?? "", {
    tmux: {
      listWorkers: async () => Object.entries(s.panes).map(([pane, name]) => ({ id: pane, name, location: "", node: "local", offline: false })),
      capture: async () => null, captureMany: panes => capture(node, panes), send: async () => ({ problem: null, typedAt: 0 }),
    },
  })));
  return {
    calls, tmux: rig.ports.tmux, nodeStates: rig.ports.nodeStates, close: () => rig.close(),
    setState: async (node, s) => { await rig.fleet.setStatus(node, s); await until(async () => (await rig.ports.nodeStates()).get(node) === s); },
  };
}
const until1 = async (ok: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise(r => setTimeout(r, 5));
  return ok();
};
const watcher = (watching: string, seen: { text: string; at: number }[], events: FeedEvent[] = []): Listener => ({
  events: e => { events.push(...e); },
  screen: (w, text) => { if (w === watching) seen.push({ text, at: Date.now() }); },
  messages: () => {}, history: () => {}, watching: () => watching,
});

let svc: ObservationService | null = null;
let nodes: Nodes | null = null;
afterEach(async () => { svc?.stop(); svc = null; await nodes?.close(); nodes = null; });

describe.each(HUB_MODES)("a node that never answers, %s hub", mode => {
  // Node "a" never answers a captureMany; node "b" answers at once with its current screen.
  let fastScreen = "b: first";
  const specs = (): Record<string, NodeSpec> => ({
    a: { panes: { "%1": "slow-lane" }, capture: () => new Promise(() => {}) },
    b: { panes: { "%1": "fast-lane" }, capture: async panes => new Map(panes.map(p => [p, fastScreen])) },
  });
  it("doesn't hold up another node's screens beyond one poll interval, and gets no second captureMany meanwhile", async () => {
    const POLL = 300;
    fastScreen = "b: first";
    nodes = await nodesFor(mode, specs());
    svc = new ObservationService(nodes.tmux, 60_000, Date.now, { nodeWaitMs: POLL, nodeStates: nodes.nodeStates });
    const seen: { text: string; at: number }[] = [];
    svc.subscribe(watcher(FAST, seen));
    svc.start(POLL);
    expect(await until1(() => svc?.screen(FAST) === "b: first", 5 * POLL)).toBe(true);
    const changedAt = Date.now();
    fastScreen = "b: second";
    expect(await until1(() => seen.some(s => s.text === "b: second"), 10 * POLL)).toBe(true);
    const delay = (seen.find(s => s.text === "b: second")?.at ?? Infinity) - changedAt;
    expect(delay).toBeLessThanOrEqual(POLL + 150);                     // one poll interval, plus scheduling slack
    expect(nodes.calls.filter(c => c.node === "a")).toHaveLength(1);    // still waiting on the first: not asked again
    expect(nodes.calls.filter(c => c.node === "b").length).toBeGreaterThanOrEqual(2);
  });
  it("one poll returns after at most nodeWaitMs, with the answering node's screens applied", async () => {
    fastScreen = "b: first";
    nodes = await nodesFor(mode, specs());
    svc = new ObservationService(nodes.tmux, 60_000, Date.now, { nodeWaitMs: 200, nodeStates: nodes.nodeStates });
    const t0 = Date.now();
    await svc.poll();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(svc.screen(FAST)).toBe("b: first");
    expect(svc.screen(SLOW)).toBeUndefined();
  });
});

describe.each(HUB_MODES)("node states, %s hub", mode => {
  it("a node that is not online gets no captureMany; one that is online does (negative control)", async () => {
    nodes = await nodesFor(mode, {
      a: { panes: { "%1": "slow-lane" }, capture: async panes => new Map(panes.map(p => [p, "a"])) },
      b: { panes: { "%1": "fast-lane" }, capture: async panes => new Map(panes.map(p => [p, "b"])) },
    });
    await nodes.setState("a", "stale");
    svc = new ObservationService(nodes.tmux, 60_000, Date.now, { nodeStates: nodes.nodeStates, nodeWaitMs: 5_000 });
    const t0 = Date.now();
    await svc.poll();
    expect(Date.now() - t0).toBeLessThan(1000);                        // skipped at once: no wait for node "a"
    expect(nodes.calls.map(c => c.node)).toEqual(["b"]);
    await nodes.setState("b", "offline");
    await svc.poll();
    expect(nodes.calls.map(c => c.node)).toEqual(["b"]);
    expect(svc.snapshot().workers.map(w => w.id).sort()).toEqual([SLOW, FAST]);   // still listed; only their screens wait
  });
});

describe.each(HUB_MODES)("one captureMany per node and poll, %s hub", mode => {
  it("each node is asked once, for its own workers only, and a late round is applied by the next poll", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    nodes = await nodesFor(mode, {
      a: { panes: { "%1": "a1", "%2": "a2" }, capture: async panes => { await gate; return new Map(panes.map(p => [p, `screen ${idOf("a", p)}`])); } },
      b: { panes: { "%3": "b3" }, capture: async panes => new Map(panes.map(p => [p, `screen ${idOf("b", p)}`])) },
    });
    svc = new ObservationService(nodes.tmux, 60_000, Date.now, { nodeWaitMs: 50, nodeStates: nodes.nodeStates });
    await svc.poll();
    expect([...nodes.calls].sort((x, y) => x.node.localeCompare(y.node))).toEqual([{ node: "a", ids: ["a.00000001.1", "a.00000001.2"] }, { node: "b", ids: ["b.00000002.3"] }]);
    expect(svc.screen("a.00000001.1")).toBeUndefined();                 // node "a" hadn't answered within 50 ms
    release();
    await new Promise(r => setTimeout(r, 200));
    await svc.poll();
    expect(svc.screen("a.00000001.1")).toBe("screen a.00000001.1");     // its round, applied by the next poll
    expect(svc.screen("a.00000001.2")).toBe("screen a.00000001.2");
  });
});
```

Replace `apps/hub/test/observation-attachments.test.ts` with (the legacy hub's copier, and the fleet hub's: read on the node, copied into the hub's own store):

```ts
// Files in a conversation are copied in the background (fleet core §3.1): a message shows its attachment as pending
// until the copy lands, then whoever watches that worker gets the message's attachments again. Synthetic transcript.
// Both configurations (spec §9): the legacy hub's copier (a fake whose copies land when the test says), and the fleet
// hub's, which reads the file on the worker's node through the fake fleet and hands it to the hub's own store (a fake
// store whose copies land when the test says).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LocalFileStore } from "../src/adapters/fleet-adapters.ts";
import type { Listener } from "../src/application/observation-service.ts";
import type { RemoteFiles, Tmux } from "../src/application/ports.ts";
import { HUB_MODES, claudeDirPorts, observationFor, portsFor, type HubMode, type ModePorts } from "./helpers/hub-mode.ts";

let dir: string;
let ports: ModePorts | null = null;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-attach-")); });
afterEach(async () => { await ports?.close(); ports = null; rmSync(dir, { recursive: true, force: true }); });

const T = "2026-10-06T08:00:00.000Z";
const ID = "a".repeat(32);
const said = (uuid: string, text: string) => JSON.stringify({ type: "user", uuid, timestamp: T, origin: { kind: "human" }, message: { role: "user", content: text } });
const TMUX: Tmux = {
  listWorkers: async () => [{ id: "%1", name: "builder", location: "w", node: "local", offline: false }],
  capture: async () => "❯ ", captureMany: async ids => new Map(ids.map(id => [id, "❯ "])), send: async () => ({ problem: null, typedAt: 0 }),
};

// A copier whose copies land when release() is called (the slow ones only, when `slow` says which), as the legacy hub's
// RemoteFiles and as the fleet hub's own store; `asked`: the file names it was asked to copy.
function slowFiles(result: { id: string | null; size: number | null } | Error, slow: (name: string) => boolean = () => true) {
  const asked: string[] = [];
  let release: () => void = () => {};
  const landed = new Promise<void>(r => { release = r; });
  const copy = async (path: string) => {
    asked.push(basename(path));
    if (slow(basename(path))) await landed;
    if (result instanceof Error) throw result;
    return result;
  };
  const files: RemoteFiles = { register: (_workerId, path) => copy(path) };
  const store: LocalFileStore = { register: path => copy(path) };
  return { files, store, asked, release };
}

// A worker %1 whose transcript holds `lines`; its files are copied by `f`.
async function setup(mode: HubMode, lines: string[], f: ReturnType<typeof slowFiles>) {
  mkdirSync(join(dir, "sessions"));
  mkdirSync(join(dir, "projects", "-w"), { recursive: true });
  writeFileSync(join(dir, "sessions", "1.json"), JSON.stringify({ pid: process.pid, sessionId: "s1", tmux: "qa:@0.%1", name: "builder", cwd: "/w", version: "2.1.286", updatedAt: 1 }));
  writeFileSync(join(dir, "projects", "-w", "s1.jsonl"), lines.join("\n") + "\n");
  ports = await portsFor(mode, {
    tmux: TMUX, ...claudeDirPorts(dir), files: f.files, fileStore: f.store,
    readFile: async path => (path.startsWith("/inbox/") ? { bytes: Buffer.from(`bytes of ${path}`), mtime: 1 } : null),
  });
  const p = ports;
  const svc = observationFor(p, { quietAfterMs: 60_000 });
  // What the watcher was sent, as it was at that moment (the messages are the service's own objects, changed later).
  const sent: { t: string; body: unknown }[] = [];
  const keep = (t: string, body: unknown) => sent.push({ t, body: JSON.parse(JSON.stringify(body)) as unknown });
  const listener: Listener = {
    events: () => {}, screen: () => {}, watching: () => p.id("%1"),
    history: (_w, ms) => keep("history", ms.map(m => m.attachments ?? [])),
    messages: (_w, ms) => keep("messages", ms.map(m => m.attachments ?? [])),
    attachments: (w, message, attachments) => keep("attachments", { w, message, attachments }),
  };
  svc.subscribe(listener);
  return { svc, sent, id: p.id };
}
const settle = (ms = 20) => new Promise(r => setTimeout(r, ms));
const photo = { name: "pasted-1.png", mime: "image/png", kind: "image", caption: null };

describe.each(HUB_MODES)("a file in a message is copied in the background, %s hub", mode => {
  it("pending until the copy lands, then the watcher gets the message's attachments with the copy's id", async () => {
    const f = slowFiles({ id: ID, size: 9 });
    const { svc, sent, id } = await setup(mode, [said("u1", "Look\n\n[The owner attached a file: /inbox/pasted-1.png]")], f);
    await svc.poll();
    expect(sent).toEqual([{ t: "history", body: [[{ ...photo, id: null, size: null, pending: true }]] }]);
    await settle(200);
    expect(f.asked).toEqual(["pasted-1.png"]);
    f.release();
    await settle(200);
    expect(sent.at(-1)).toEqual({ t: "attachments", body: { w: id("%1"), message: "u1", attachments: [{ ...photo, id: ID, size: 9 }] } });
    expect(svc.history(id("%1"))[0]?.attachments).toEqual([{ ...photo, id: ID, size: 9 }]);   // and the conversation has it
  });
  it("a copy that fails ends pending as not available (id null), and the watcher is told so", async () => {
    const f = slowFiles(new Error("fleet: node_offline"));
    const { svc, sent, id } = await setup(mode, [said("u1", "Look\n\n[The owner attached a file: /inbox/pasted-1.png]")], f);
    await svc.poll();
    f.release();
    await settle(200);
    expect(sent.at(-1)).toEqual({ t: "attachments", body: { w: id("%1"), message: "u1", attachments: [{ ...photo, id: null, size: null }] } });
  });
  it("an older page waits for copies that land at once; one still copying after 1 s goes out pending, and its frame follows", async () => {
    const f = slowFiles({ id: ID, size: 9 }, name => name === "slow.png");
    const { svc, sent, id } = await setup(mode, [
      said("u0", "first\n\n[The owner attached a file: /inbox/p0.png]"), said("u1", "second\n\n[The owner attached a file: /inbox/slow.png]"), said("u2", "latest"),
    ], f);
    await svc.poll();
    await settle(200);
    sent.length = 0;
    const page = await svc.older(id("%1"), "u2");
    expect(page.messages.map(m => [m.id, m.attachments?.[0]?.id ?? null, m.attachments?.[0]?.pending ?? false])).toEqual([["u0", ID, false], ["u1", null, true]]);
    expect(sent).toEqual([]);
    f.release();
    await settle(200);
    const frames = sent.filter(x => x.t === "attachments").map(x => x.body as { message: string; attachments: { id: string | null }[] });
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every(x => x.message === "u1" && x.attachments[0]?.id === ID)).toBe(true);
  });
});
```

Replace `apps/hub/test/steering-keys.test.ts` with (keys, the node's typedAt and staged uploads; in fleet mode the key reaches the node under `hub:`):

```ts
// Sends carry keys and come back with the node's time (fleet core §3.1): the key is the request's own
// (<endpoint>:<request>), a refusal before the paste (a node that isn't online among them) still lets the retry type,
// the time the app matches the echo by is the node's typedAt (a node clock 10 s behind the hub's here), and an attached
// image that can't be put on the worker's machine refuses the send before anything is typed. A fake node that keeps
// keys as the agent does: a key it typed answers its stored outcome; a refusal before the paste keeps nothing (spec
// §5.3). Both configurations (spec §9): in fleet mode the node sits behind the fake fleet (which keeps the agent's keys
// too) and gets the key under the hub's namespace ("hub:"). Real SQLite in a temp dir.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId, type Upload } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { localUploads } from "../src/adapters/local-node.ts";
import type { SendOutcome, Tmux, UploadSink } from "../src/application/ports.ts";
import type { Authenticated } from "../src/application/access-service.ts";
import { HUB_MODES, portsFor, steeringFor, type ModePorts } from "./helpers/hub-mode.ts";

const HUB_NOW = Date.UTC(2026, 9, 6, 9);
const NODE_BEHIND_MS = 10_000;                                         // the node's clock, 10 s behind the hub's
const A: Authenticated = {
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: HUB_NOW - 1000, lastSeenAt: HUB_NOW, verifiedAt: HUB_NOW - 1000, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Mac", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: HUB_NOW, revokedAt: null },
};
const RID = "0f1b8a52-3c1d-4e6f-9a7b-2c3d4e5f6a7b";
let dir: string;
let store: Store;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-steer-keys-")); store = new Store(dir); });
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

// The node's pane %1: answers the next scripted problems first (then types), keeps the outcome of what it typed by key.
function node(script: SendOutcome["problem"][] = []) {
  const typed: { text: string; key: string }[] = [];
  const keys: string[] = [];
  const done = new Map<string, SendOutcome>();
  const tmux: Tmux = {
    listWorkers: async () => [{ id: "%1", name: "alpha", location: "w", node: "local", offline: false }],
    capture: async () => "❯ ", captureMany: async ids => new Map(ids.map(id => [id, "❯ "])),
    send: async (_id, text, key) => {
      keys.push(key);
      const stored = done.get(key);
      if (stored) return stored;
      const problem = script.shift() ?? null;
      if (problem) return { problem, typedAt: HUB_NOW - NODE_BEHIND_MS };   // refused before the paste: nothing kept
      typed.push({ text, key });
      const outcome = { problem: null, typedAt: HUB_NOW - NODE_BEHIND_MS };
      done.set(key, outcome);
      return outcome;
    },
  };
  return { tmux, typed, keys };
}

describe.each(HUB_MODES)("keys, %s hub", mode => {
  let ports: ModePorts | null = null;
  afterEach(async () => { await ports?.close(); ports = null; });
  // The key as the node gets it: the request's own, under the hub's namespace once it goes through a fleet.
  const atNode = (key: string) => (mode === "fleet" ? `hub:${key}` : key);
  const steering = async (n: ReturnType<typeof node>, o: { inbox?: { get(id: string): Upload | undefined }; uploads?: UploadSink } = {}) => {
    ports ??= await portsFor(mode, { tmux: n.tmux });
    return steeringFor({ ...ports, uploads: o.uploads ?? localUploads() }, { store, now: () => HUB_NOW, inbox: o.inbox ?? null });
  };
  const W = () => ports?.id("%1") ?? "";

  it("the node gets the request's own key, <endpoint>:<request>", async () => {
    const n = node();
    const s = await steering(n);
    expect(await s.send(A, W(), "ship it", RID)).toMatchObject({ ok: true });
    expect(n.keys).toEqual([atNode(`ep1:${RID}`)]);
  });
  it("draft_present, then the retry with the same request: typed, once, with the same key", async () => {
    const n = node(["draft_present"]);
    const s = await steering(n);
    expect(await s.send(A, W(), "ship it", RID)).toEqual({ ok: false, problem: "draft_present" });
    expect(await s.send(A, W(), "ship it", RID)).toMatchObject({ ok: true });
    expect(n.typed).toEqual([{ text: "ship it", key: atNode(`ep1:${RID}`) }]);
    expect(n.keys).toEqual([atNode(`ep1:${RID}`), atNode(`ep1:${RID}`)]);
  });
  it("a node that isn't online refuses before the paste: no row is kept, and the retry types, once", async () => {
    const n = node(["node_offline"]);
    const s = await steering(n);
    expect(await s.send(A, W(), "ship it", RID)).toEqual({ ok: false, problem: "node_offline" });
    expect(store.send(`ep1:${RID}`)).toBeNull();
    expect(await s.send(A, W(), "ship it", RID)).toMatchObject({ ok: true });
    expect(n.typed).toEqual([{ text: "ship it", key: atNode(`ep1:${RID}`) }]);
  });

  it("a send answers the node's typedAt, 10 s behind the hub, and a repeat after a restart answers the same", async () => {
    const n = node();
    expect(await (await steering(n)).send(A, W(), "ship it", RID)).toEqual({ ok: true, at: HUB_NOW - NODE_BEHIND_MS });
    const restarted = await steering(n);                               // a new service on the same database
    expect(await restarted.send(A, W(), "ship it", RID)).toEqual({ ok: false, problem: "duplicate", at: HUB_NOW - NODE_BEHIND_MS });
  });

  describe("attached images are staged on the worker's machine first", () => {
    const upload: Upload = { id: "u1", endpointId: endpointId("ep1"), path: "/hub/inbox/pasted-1.png", mime: "image/png", size: 4, at: HUB_NOW - 1000 };
    const inbox = { get: (id: string) => (id === "u1" ? upload : undefined) };
    it("a stage that fails refuses the send before anything is typed, writes no row, and the retry types", async () => {
      const n = node();
      let offline = true;
      const staged: string[] = [];
      const uploads: UploadSink = {
        stage: async (u, workerId) => { staged.push(`${u.id}@${workerId}`); return offline ? { ok: false, problem: "node_offline" } : { ok: true, path: "/node/inbox/pasted-1.png" }; },
      };
      const s = await steering(n, { inbox, uploads });
      expect(await s.send(A, W(), "look", RID, ["u1"])).toEqual({ ok: false, problem: "node_offline" });
      expect(n.keys).toEqual([]);
      expect(store.send(`ep1:${RID}`)).toBeNull();
      offline = false;
      expect(await s.send(A, W(), "look", RID, ["u1"])).toMatchObject({ ok: true });
      expect(n.typed.map(t => t.text)).toEqual(["look\n\n[The owner attached a file: /node/inbox/pasted-1.png]"]);   // the path there
      expect(staged).toEqual([`u1@${W()}`, `u1@${W()}`]);
    });
    it("on this machine (the local sink) the note names the inbox path", async () => {
      const n = node();
      expect(await (await steering(n, { inbox })).send(A, W(), "look", RID, ["u1"])).toMatchObject({ ok: true });
      expect(n.typed.map(t => t.text)).toEqual(["look\n\n[The owner attached a file: /hub/inbox/pasted-1.png]"]);
    });
    it("a repeat that comes while the first is still staging waits for it: typed once", async () => {
      const n = node();
      let release: () => void = () => {};
      const gate = new Promise<void>(r => { release = r; });
      const uploads: UploadSink = { stage: async u => { await gate; return { ok: true, path: u.path }; } };
      const s = await steering(n, { inbox, uploads });
      const first = s.send(A, W(), "look", RID, ["u1"]);
      const repeat = s.send(A, W(), "look", RID, ["u1"]);
      release();
      expect({ first: await first, repeat: await repeat }).toEqual({
        first: { ok: true, at: HUB_NOW - NODE_BEHIND_MS }, repeat: { ok: false, problem: "duplicate", at: HUB_NOW - NODE_BEHIND_MS },
      });
      expect(n.typed).toHaveLength(1);
    });
  });
});
```

Replace `apps/hub/test/escalation-answer-keys.test.ts` with (an answer retried after a drop, and a question asked again; in fleet mode the fake fleet loses the first answer):

```ts
// An answer carries a key to the asker's node (fleet core §3.1, §9 "Retry and duplicates" (c)): answer:<id>:<ask>:<choice>.
// The node keeps what it typed by key, as the agent does, so an answer retried after the connection dropped once the
// line was pasted is typed once; and a question asked again is a new ask, so the same choice for it is typed again.
// Both configurations (spec §9): the legacy hub's port drops the connection after its first paste (it throws); in fleet
// mode the node sits behind the fake fleet, which keeps the keys and loses its first answer after the paste. Synthetic
// list and conversation.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId, type Message } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { ledgerReader } from "../src/adapters/ledger.ts";
import { answerKey } from "../src/application/escalation-service.ts";
import type { SendOutcome, Tmux } from "../src/application/ports.ts";
import type { Authenticated } from "../src/application/access-service.ts";
import { LOST } from "./helpers/fake-fleet.ts";
import { HUB_MODES, escalationsFor, portsFor, type HubMode, type ModePorts } from "./helpers/hub-mode.ts";

const T0 = Date.UTC(2026, 9, 6, 8);
let dir: string;
let store: Store;
let ledgerPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "morndo-answer-keys-"));
  store = new Store(dir);
  ledgerPath = join(dir, "ledger.json");
  writeFileSync(ledgerPath, JSON.stringify({ needsYou: [{ id: "ny-7", kind: "tap", question: "Ship the demo release tonight?", default: "hold" }], needsYouClosed: [] }));
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

const auth: Authenticated = {
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: T0, lastSeenAt: T0, verifiedAt: T0, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Mac", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: T0, revokedAt: null },
};
const asked = (id: string, at: number): Message => ({ id, at, author: { kind: "agent", name: "manager" }, kind: "text", text: "Ready.\n\n[buttons ny-7] ship=Ship it | hold=Hold for a day" });

// The manager's pane %0: types, keeps the key's outcome (a key it typed answers that, not typed again). In legacy mode
// its first `drops` sends drop the connection after the paste (throw); in fleet mode the fake fleet loses those answers.
function node(mode: HubMode, drops: number) {
  const typed: { pane: string; text: string; key: string }[] = [];
  const done = new Map<string, SendOutcome>();
  let lose = drops;
  const tmux: Tmux = {
    listWorkers: async () => [{ id: "%0", name: "manager", location: "manager", node: "local", offline: false }],
    capture: async () => "❯ ", captureMany: async ids => new Map(ids.map(id => [id, "❯ "])),
    send: async (pane, text, key) => {
      const known = done.get(key);
      if (known) return known;                                         // typed before: its outcome, not typed again
      typed.push({ pane, text, key });
      done.set(key, { problem: null, typedAt: T0 });
      if (mode === "legacy" && lose-- > 0) throw new Error("fleet: connection lost after the paste");
      return { problem: null, typedAt: T0 };
    },
  };
  const loseFirst = (ports: ModePorts) => {
    if (mode !== "fleet") return;
    let left = drops;
    ports.rig?.fleet.intercept("pane.send", async (_call, next) => { const r = await next(); return left-- > 0 ? LOST : r; });
  };
  return { tmux, typed, loseFirst };
}

describe.each(HUB_MODES)("answers and their keys, %s hub", mode => {
  let ports: ModePorts | null = null;
  let manager: Message[] = [];
  beforeEach(() => { manager = [asked("m1", T0 - 60_000)]; });
  afterEach(async () => { await ports?.close(); ports = null; });
  const atNode = (key: string) => (mode === "fleet" ? `hub:${key}` : key);
  const start = async (n: ReturnType<typeof node>) => {
    ports = await portsFor(mode, { tmux: n.tmux });
    const p = ports;
    n.loseFirst(p);
    return escalationsFor(p, {
      store, now: () => T0, ledger: ledgerReader(ledgerPath, () => T0),
      watch: { workers: () => [{ id: p.id("%0"), name: "manager" }], history: id => (id === p.id("%0") ? manager : []), openQuestions: () => [], screen: () => undefined },
    });
  };

  it("an answer retried after the connection dropped is typed once: the retry carries the same key and gets the node's outcome", async () => {
    const n = node(mode, 1);
    const s = await start(n);
    s.poll();
    await expect(s.answer(auth, "ny-7", { kind: "option", key: "ship" }, "r1")).rejects.toThrow(mode === "fleet" ? /uncertain/ : /connection lost/);
    expect(await s.answer(auth, "ny-7", { kind: "option", key: "ship" }, "r1")).toMatchObject({ ok: true });
    expect(n.typed).toEqual([{ pane: "%0", text: "[tap ny-7] ship (Ship it)", key: atNode("answer:ny-7:m1:option:ship") }]);
    expect(store.audit(10).filter(a => a.type === "EscalationAnswered")).toHaveLength(1);
  });

  it("a question asked again is a new ask: the same tap is typed once for each ask, never lost to the first one's key", async () => {
    const n = node(mode, 0);
    const s = await start(n);
    s.poll();
    expect(await s.answer(auth, "ny-7", { kind: "option", key: "ship" }, "r1")).toMatchObject({ ok: true });
    manager = [...manager, asked("m2", T0 - 30_000)];                  // the manager asks ny-7 again, a newer message
    s.poll();
    expect(await s.answer(auth, "ny-7", { kind: "option", key: "ship" }, "r2")).toMatchObject({ ok: true });
    expect(n.typed.map(t => t.key)).toEqual([atNode("answer:ny-7:m1:option:ship"), atNode("answer:ny-7:m2:option:ship")]);
  });
});

describe("answerKey", () => {
  it("names the ask and the choice; words go by their digest, never as they are", () => {
    const ask = { messageId: "m1", askedAt: T0 };
    expect(answerKey("ny-7", ask, { kind: "option", key: "ship" })).toBe("answer:ny-7:m1:option:ship");
    expect(answerKey("ny-7", { messageId: null, askedAt: T0 }, { kind: "option", key: "ship" })).toBe(`answer:ny-7:t${T0}:option:ship`);
    const words = answerKey("ny-8", ask, { kind: "words", text: "  Monday the 12th " });
    expect(words).toMatch(/^answer:ny-8:m1:words:[0-9a-f]{16}$/);
    expect(words).toBe(answerKey("ny-8", ask, { kind: "words", text: "Monday the 12th" }));
    expect(words).not.toContain("Monday");
    expect(answerKey("ny-8", ask, { kind: "words", text: "Tuesday" })).not.toBe(words);
  });
});
```

Replace `apps/hub/test/steering-inflight-duplicate.test.ts` with (a repeat while the first send is still typing):

```ts
// A repeated send (same session and request id) gets the first send's real outcome, never "duplicate" before that
// outcome is known (code review R3). The web client retries a send whose answer it never got with the same request id
// and counts "duplicate" as delivered, so the hub may only say "duplicate" once the text really was typed in. While
// the first send is still typing, a repeat waits for it: delivered → "duplicate" (the HTTP layer answers 200 ok), refused
// → that same refusal. The text is typed once either way. SteeringService with a fake Tmux whose send() finishes when
// the test says so; no real tmux. Both configurations (spec §9): in fleet mode the pane sits behind the fake fleet.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { endpointId, sessionId } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import type { SendProblem } from "@morndo/node-ops";
import type { Tmux } from "../src/application/ports.ts";
import type { Authenticated } from "../src/application/access-service.ts";
import { HUB_MODES, portsFor, steeringFor, type ModePorts } from "./helpers/hub-mode.ts";

let dir: string;
let store: Store;
const now = Date.UTC(2026, 9, 1, 8);
const auth: Authenticated = {
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: now - 1000, lastSeenAt: now, verifiedAt: now - 1000, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Mac", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: now, revokedAt: null },
};

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "morndo-steer-inflight-")); store = new Store(dir); });
afterAll(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

// A pane whose first send() finishes with `first` when the test calls finish(); any later send() succeeds at once
// (so a repeat that typed again would come back ok instead of the first send's refusal).
function slowPane(first: SendProblem | null) {
  const typed: string[] = [];
  let finish = () => {};
  const done = new Promise<void>(r => (finish = r));
  let started = () => {};
  const typing = new Promise<void>(r => (started = r));
  const tmux: Tmux = {
    listWorkers: async () => [{ id: "%1", name: "alpha", location: "w", node: "local", offline: false }],
    capture: async () => "❯ ", captureMany: async ids => new Map(ids.map(id => [id, "❯ "])),
    async send(_id, text) {
      typed.push(text);
      if (typed.length > 1) return { problem: null, typedAt: now };
      started();
      await done;
      return { problem: first, typedAt: now };
    },
  };
  return { tmux, typed, typing, finish: () => finish() };
}

// Has the promise settled within a few turns of the event loop?
async function settledSoon(p: Promise<unknown>) {
  let settled = false;
  void p.then(() => (settled = true), () => (settled = true));
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 10));
  return settled;
}

const sends = () => store.audit(50).filter(e => e.type === "CommandSent").length;

describe.each(HUB_MODES)("a repeated request id while the first send is still typing, %s hub", mode => {
  let ports: ModePorts | null = null;
  afterEach(async () => { await ports?.close(); ports = null; });
  const service = async (pane: ReturnType<typeof slowPane>) => {
    ports = await portsFor(mode, { tmux: pane.tmux });
    return { s: steeringFor(ports, { store, now: () => now }), W: ports.id("%1") };
  };
  it("the first send is refused (menu_open): the repeat gets that refusal too, never duplicate/ok", async () => {
    const pane = slowPane("menu_open");
    const { s, W } = await service(pane);
    const before = sends();
    const first = s.send(auth, W, "ship the alpha release", `rq-a-${mode}`);
    await pane.typing;                                            // the first send is in the pane now
    const repeat = s.send(auth, W, "ship the alpha release", `rq-a-${mode}`);
    pane.finish();
    expect({ first: await first, repeat: await repeat }).toEqual({
      first: { ok: false, problem: "menu_open" },
      repeat: { ok: false, problem: "menu_open" },
    });
    expect(pane.typed).toHaveLength(1);                           // the repeat did not type it again
    expect(sends() - before).toBe(0);
  });

  it("the first send is delivered: the repeat is told duplicate only once that is known, and the text is typed once", async () => {
    const pane = slowPane(null);
    const { s, W } = await service(pane);
    const before = sends();
    const first = s.send(auth, W, "ship the alpha release", `rq-b-${mode}`);
    await pane.typing;
    const repeat = s.send(auth, W, "ship the alpha release", `rq-b-${mode}`);
    expect(await settledSoon(repeat), "the repeat answered before the first send's outcome was known").toBe(false);
    pane.finish();
    expect({ first: await first, repeat: await repeat }).toEqual({
      first: { ok: true, at: now },
      repeat: { ok: false, problem: "duplicate", at: now },               // http.ts answers this 200 {"error":"duplicate","ok":true}
    });
    expect(pane.typed).toHaveLength(1);
    expect(sends() - before).toBe(1);
  });

  it("control: a repeat after the first send was delivered is told duplicate, as today", async () => {
    const pane = slowPane(null);
    const { s, W } = await service(pane);
    const first = s.send(auth, W, "ship the alpha release", `rq-c-${mode}`);
    await pane.typing;
    pane.finish();
    expect(await first).toMatchObject({ ok: true });
    expect(await s.send(auth, W, "ship the alpha release", `rq-c-${mode}`)).toMatchObject({ ok: false, problem: "duplicate" });
    expect(pane.typed).toHaveLength(1);
  });
});
```

Replace `apps/hub/test/steering-throw-retry.test.ts` with (a send whose typing threw):

```ts
// A send whose typing threw may or may not have reached the pane: tmux can fail after the paste as well as before. So a
// retry with the same request id is told "uncertain", never "duplicate" (review of the R3 fix, R4: the web client counts
// "duplicate" as delivered) and never typed again (ADR-0008 phase C review H2: exactly once). SteeringService with a
// fake Tmux whose first send() throws; no real tmux. Both configurations (spec §9): in fleet mode the pane sits behind
// the fake fleet, whose node keeps the key started (it may have run), so the retry asks it and stays uncertain.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { endpointId, sessionId } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import type { Tmux } from "../src/application/ports.ts";
import type { Authenticated } from "../src/application/access-service.ts";
import { HUB_MODES, portsFor, steeringFor, type ModePorts } from "./helpers/hub-mode.ts";

let dir: string;
let store: Store;
const now = Date.UTC(2026, 9, 1, 8);
const auth: Authenticated = {
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: now - 1000, lastSeenAt: now, verifiedAt: now - 1000, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Mac", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: now, revokedAt: null },
};

beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "morndo-steer-throw-")); store = new Store(dir); });
afterAll(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

// A pane whose first send() throws (as `tmux exited 1` does) when `throwFirst`, and whose other sends succeed.
function pane(throwFirst: boolean) {
  const typed: string[] = [];
  const tmux: Tmux = {
    listWorkers: async () => [{ id: "%1", name: "alpha", location: "w", node: "local", offline: false }],
    capture: async () => "❯ ", captureMany: async ids => new Map(ids.map(id => [id, "❯ "])),
    async send(_id, text) {
      typed.push(text);
      if (throwFirst && typed.length === 1) throw new Error("tmux exited 1");
      return { problem: null, typedAt: now };
    },
  };
  return { tmux, typed };
}

describe.each(HUB_MODES)("a send whose typing threw, %s hub", mode => {
  let ports: ModePorts | null = null;
  afterEach(async () => { await ports?.close(); ports = null; });
  const service = async (p: ReturnType<typeof pane>) => {
    ports = await portsFor(mode, { tmux: p.tmux });
    return { s: steeringFor(ports, { store, now: () => now }), W: ports.id("%1") };
  };
  it("is answered 'uncertain' on the retry with the same request id: never 'duplicate', never typed twice", async () => {
    const p = pane(true);
    const { s, W } = await service(p);
    await expect(s.send(auth, W, "ship it", `req-throw-${mode}`)).rejects.toThrow("tmux exited 1");
    const retry = await s.send(auth, W, "ship it", `req-throw-${mode}`);
    expect(retry).toEqual({ ok: false, problem: "uncertain" });
    expect(p.typed.length).toBe(1);
  });

  it("control: a delivered send's retry is still 'duplicate', typed once", async () => {
    const p = pane(false);
    const { s, W } = await service(p);
    expect(await s.send(auth, W, "ship it", `req-ok-${mode}`)).toEqual({ ok: true, at: now });
    expect(await s.send(auth, W, "ship it", `req-ok-${mode}`)).toEqual({ ok: false, problem: "duplicate", at: now });
    expect(p.typed.length).toBe(1);
  });
});
```

- [ ] **Step 14.24: Run the nine suites in each mode, then both**

Run each mode alone first, then both (the default), each command on its own:
```bash
MORNDO_HUB_MODES=legacy npx vitest run apps/hub/test/steering-durable.test.ts apps/hub/test/observation-waiting-on.test.ts apps/hub/test/remote-service.test.ts apps/hub/test/observation-nodes.test.ts apps/hub/test/observation-attachments.test.ts apps/hub/test/steering-keys.test.ts apps/hub/test/escalation-answer-keys.test.ts apps/hub/test/steering-inflight-duplicate.test.ts apps/hub/test/steering-throw-retry.test.ts
MORNDO_HUB_MODES=fleet npx vitest run apps/hub/test/steering-durable.test.ts apps/hub/test/observation-waiting-on.test.ts apps/hub/test/remote-service.test.ts apps/hub/test/observation-nodes.test.ts apps/hub/test/observation-attachments.test.ts apps/hub/test/steering-keys.test.ts apps/hub/test/escalation-answer-keys.test.ts apps/hub/test/steering-inflight-duplicate.test.ts apps/hub/test/steering-throw-retry.test.ts
npx vitest run --reporter=verbose apps/hub/test/steering-durable.test.ts apps/hub/test/observation-waiting-on.test.ts apps/hub/test/remote-service.test.ts apps/hub/test/observation-nodes.test.ts apps/hub/test/observation-attachments.test.ts apps/hub/test/steering-keys.test.ts apps/hub/test/escalation-answer-keys.test.ts apps/hub/test/steering-inflight-duplicate.test.ts apps/hub/test/steering-throw-retry.test.ts
```
Expected:
- **Legacy run:** PASS, 9 files, 40 tests: steering-durable 10, observation-waiting-on 4, remote-service 4, observation-nodes 4, observation-attachments 3, steering-keys 7, escalation-answer-keys 3 (two per mode, and `answerKey`'s own test, which runs once whatever the modes), steering-inflight-duplicate 3, steering-throw-retry 2.
- **Fleet run:** PASS, the same 40.
- **Both modes:** PASS, 79 tests (`answerKey`'s once). The verbose names show each suite twice, e.g. `durable dedupe across a restart (S5), legacy hub` and `durable dedupe across a restart (S5), fleet hub`.

A green fleet run must have actually asked the fake fleet. Check it on one test: in `steering-durable.test.ts`'s first test, after `    expect(pane.typed).toEqual(["ship it"]);`, temporarily add
```ts
    if (mode === "fleet") expect(ports.rig?.fleet.calls.some(c => c.op === "pane.send")).toBe(true);
    if (mode === "legacy") expect(ports.rig).toBeNull();
```
Run: `npx vitest run apps/hub/test/steering-durable.test.ts -t "recorded done is duplicate"`
Expected: PASS, 2 tests (one per mode), 18 skipped. Then remove the two lines.

- [ ] **Step 14.25: Run every suite, the type check and the linter**

Run each on its own:
```bash
npx vitest run apps/hub packages apps/web
MORNDO_HUB_MODES=fleet npx vitest run apps/hub packages apps/web
npm run check
npm run lint
```
Expected:
- vitest (both modes): every file PASSES but `packages/node-ops/test/pane-lock.test.ts`, which needs `flock(1)` and fails on macOS (2 tests) as before; on macOS 140 files, 1125 tests, 2 failed. The hub suites include `fleet-client`, `fleet-adapters`, `local-ports`, `fleet-steering` and `config-fleet`, plus the nine suites twice (legacy hub, fleet hub). No test is skipped (the summary shows no "skipped" count).
- vitest (`MORNDO_HUB_MODES=fleet`): the same, with the nine suites once: 140 files, 1086 tests, the same 2 failed.
- `npm run check`: exits 0.
- `npm run lint`: reports nothing after its command line.

- [ ] **Step 14.26: Commit**

```bash
git add apps/hub/test/steering-durable.test.ts apps/hub/test/observation-waiting-on.test.ts apps/hub/test/remote-service.test.ts apps/hub/test/observation-nodes.test.ts apps/hub/test/observation-attachments.test.ts apps/hub/test/steering-keys.test.ts apps/hub/test/escalation-answer-keys.test.ts apps/hub/test/steering-inflight-duplicate.test.ts apps/hub/test/steering-throw-retry.test.ts
git commit -m "test(hub): run every suite that touches the ports in legacy and fleet mode"
```

- [ ] **Step 14.27: Write the failing tests: names in conflict, and the fleet down**

Round 2, items 4 and 12. The fleet's lane registry keeps one row per name; two windows of one name put it in conflict (spec §4). The roster still lists every window (Step 14.10's `listWorkers`), each marked; a send by worker id still goes; what goes by name refuses: the manager's answers. And with the fleet service down (spec §7), the hub keeps the roster, every worker offline, says "unavailable" once, and asks no node meanwhile.

Create `apps/hub/test/fleet-conflicts.test.ts`:

```ts
// Names in conflict (spec §4; ADR-0012 decision 11): the fleet's lane registry keeps one row per name, and two windows
// claiming one name put it in conflict, whether on one node or two. The hub's roster still lists every window, each with
// its node, and marks the conflicted ones; a send by worker id still goes (the owner picked that pane). What goes by
// name refuses: the manager's answers, while two windows are called "manager", are refused lane_conflict and typed into
// neither. The fleet adapters, the observation and escalation services, and the fake fleet (whose registry is Task
// 12's); no tmux.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId, type Message } from "@morndo/domain";
import { ledgerReader } from "../src/adapters/ledger.ts";
import { Store } from "../src/adapters/store.ts";
import type { Authenticated } from "../src/application/access-service.ts";
import type { ObservationService } from "../src/application/observation-service.ts";
import { localNode, memoryBackend, type MemoryBackend } from "./helpers/fake-fleet.ts";
import { escalationsFor, fleetRig, observationFor, steeringFor, type FleetRig } from "./helpers/hub-mode.ts";

const T0 = Date.UTC(2026, 9, 6, 8);
const BOX = "──────\n❯ ";
const PC1 = "pc.aaaaaaaa.1";
const PC2 = "pc.aaaaaaaa.2";
const auth: Authenticated = {
  session: { id: sessionId("s1"), endpointId: endpointId("ep1"), startedAt: T0, lastSeenAt: T0, verifiedAt: T0, endedAt: null, endReason: null },
  endpoint: { id: endpointId("ep1"), name: "Mac", credential: { id: "c", publicKey: new Uint8Array([1]), counter: 0, transports: [] }, pairedAt: 0, pairedWith: "t" as never, lastSeenAt: T0, revokedAt: null },
};

let dir: string;
let store: Store;
let rig: FleetRig | null = null;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-conflicts-")); store = new Store(dir); });
afterEach(async () => { await rig?.close(); rig = null; store.close(); rmSync(dir, { recursive: true, force: true }); });

// The workers as main.ts hands them to the escalations: each with its conflict.
const seen = (obs: ObservationService) => () => obs.snapshot().workers.map(w => ({ id: w.id as string, name: w.name, conflict: obs.conflicted(w.id) }));

describe("two windows of one name on one node", () => {
  it("are both listed, each with its node and marked in conflict; the registry row has no worker; a send by worker id still goes", async () => {
    const pc = memoryBackend({ "%1": { name: "claude", cwd: "/w/a", screen: BOX }, "%2": { name: "claude", cwd: "/w/b", screen: BOX } });
    rig = await fleetRig([localNode("pc", "aaaaaaaa", pc)]);
    const listed = (await rig.ports.tmux.listWorkers()).sort((a, b) => a.id.localeCompare(b.id));
    expect(listed).toEqual([
      { id: PC1, name: "claude", location: "a", node: "pc", offline: false, conflict: true },
      { id: PC2, name: "claude", location: "b", node: "pc", offline: false, conflict: true },
    ]);
    expect(await rig.client.lanes()).toEqual([{ name: "claude", node: "pc", workerId: null, conflict: true }]);
    const obs = observationFor(rig.ports, { quietAfterMs: 60_000 });
    await obs.poll();
    expect(obs.snapshot().workers.map(w => w.id).sort()).toEqual([PC1, PC2]);
    expect([obs.conflicted(PC1), obs.conflicted(PC2)]).toEqual([true, true]);
    const RID = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
    expect(await steeringFor(rig.ports, { store, now: () => T0 }).send(auth, PC2, "to the second", RID, [], "none")).toEqual({ ok: true, at: expect.any(Number) });
    expect(pc.typed.map(t => [t.pane, t.text])).toEqual([["%2", "to the second"]]);
  });
});

describe("two windows called manager, on two nodes", () => {
  let pc: MemoryBackend;
  let box: MemoryBackend;
  let history: Message[];
  beforeEach(() => {
    pc = memoryBackend({ "%1": { name: "manager", cwd: "/w/m", screen: BOX } });
    box = memoryBackend({ "%1": { name: "beta", cwd: "/w/beta", screen: BOX } });
    const ledgerPath = join(dir, "ledger.json");
    writeFileSync(ledgerPath, JSON.stringify({ needsYou: [{ id: "ny-7", kind: "tap", question: "Ship the demo release tonight?", default: "hold" }], needsYouClosed: [] }));
    history = [{ id: "m1", at: T0 - 60_000, author: { kind: "agent", name: "manager" }, kind: "text", text: "Ready.\n\n[buttons ny-7] ship=Ship it | hold=Hold for a day" }];
  });
  const start = async () => {
    rig = await fleetRig([localNode("pc", "aaaaaaaa", pc), localNode("box", "bbbbbbbb", box)]);
    const obs = observationFor(rig.ports, { quietAfterMs: 60_000 });
    const ledger = ledgerReader(join(dir, "ledger.json"), () => T0);
    const escalations = escalationsFor(rig.ports, {
      store, now: () => T0, ledger,
      watch: { workers: seen(obs), history: id => (id === PC1 ? history : []), openQuestions: () => [], screen: id => obs.screen(id) },
    });
    return { obs, escalations };
  };

  it("an answer to the manager is refused lane_conflict and typed into neither; with one manager again, it goes to that one", async () => {
    const { obs, escalations } = await start();
    await obs.poll();
    escalations.poll();                                                // the manager's ask, seen while there is one manager
    box.panes["%1"] = { name: "manager", cwd: "/w/m2", screen: BOX };  // a second window takes the name
    await rig?.fleet.announce("box");
    await obs.poll();
    expect(obs.conflicted(PC1)).toBe(true);
    expect(await escalations.answer(auth, "ny-7", { kind: "option", key: "ship" }, "r1")).toMatchObject({ ok: false, problem: "lane_conflict" });
    expect([...pc.typed, ...box.typed]).toEqual([]);
    box.panes["%1"] = { name: "beta", cwd: "/w/beta", screen: BOX };   // the owner resolves it: one manager again
    await rig?.fleet.announce("box");
    await obs.poll();
    expect(await escalations.answer(auth, "ny-7", { kind: "option", key: "ship" }, "r2")).toMatchObject({ ok: true });
    expect(pc.typed.map(t => [t.pane, t.text])).toEqual([["%1", "[tap ny-7] ship (Ship it)"]]);
    expect(box.typed).toEqual([]);
  });
});
```

Create `apps/hub/test/fleet-unavailable.test.ts`:

```ts
// The fleet service down or restarting (spec §7): the hub keeps the roster it had, every worker offline (nothing is
// known of them now; Task 15b shows the marker), says "unavailable" once to whoever listens (the feed's banner, Task
// 15b), asks no node anything meanwhile, and is "ok" again with the first listing once the fleet answers. A legacy hub
// never says unavailable: a listing that fails there is the poll's own failure, as before. The fleet adapters over the
// fake fleet, on a socket path that outlives it.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FeedEvent } from "@morndo/domain";
import { FleetClient } from "../src/adapters/fleet-client.ts";
import { fleetPorts, type FleetPorts } from "../src/adapters/fleet-adapters.ts";
import { ObservationService, type Listener } from "../src/application/observation-service.ts";
import { localNode, memoryBackend, startFakeFleet, type FakeFleet } from "./helpers/fake-fleet.ts";

const PC1 = "pc.aaaaaaaa.1";
const pcNode = () => localNode("pc", "aaaaaaaa", memoryBackend({ "%1": { name: "alpha", cwd: "/w/alpha", screen: "$ " } }));

let dir: string;
let fleet: FakeFleet | null;
let ports: FleetPorts;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mf-"));
  fleet = await startFakeFleet({ nodes: [pcNode()], socketPath: join(dir, "fleet.sock") });
  ports = fleetPorts(new FleetClient(join(dir, "fleet.sock")), { files: null, stagingDir: join(dir, "staging") });
  await ports.start();
});
afterEach(async () => { ports.stop(); await fleet?.close(); rmSync(dir, { recursive: true, force: true }); });

describe("the fleet down", () => {
  it("keeps the roster, says unavailable once, asks no node meanwhile, and is ok again once the fleet answers", async () => {
    let captures = 0;
    const tmux = { listWorkers: () => ports.tmux.listWorkers(), captureMany: (ids: string[]) => { captures++; return ports.tmux.captureMany(ids); } };
    const svc = new ObservationService(tmux, 60_000, Date.now, { nodeStates: ports.nodeStates });
    const said: string[] = [];
    const events: FeedEvent[] = [];
    const listener: Listener = { events: e => { events.push(...e); }, screen: () => {}, messages: () => {}, history: () => {}, watching: () => null, fleet: s => { said.push(s); } };
    svc.subscribe(listener);
    await svc.poll();
    expect([svc.fleet(), svc.snapshot().workers.map(w => w.id)]).toEqual(["ok", [PC1]]);
    await fleet?.close();
    fleet = null;
    captures = 0;
    await svc.poll();
    await svc.poll();
    expect(svc.fleet()).toBe("unavailable");
    expect(svc.snapshot().workers.map(w => w.id)).toEqual([PC1]);                 // still listed, not gone
    expect(events.filter(e => e.body.type === "WorkerGone")).toEqual([]);
    expect(captures).toBe(0);                                                       // nothing asked of any node
    fleet = await startFakeFleet({ nodes: [pcNode()], socketPath: join(dir, "fleet.sock") });
    await svc.poll();
    expect(svc.fleet()).toBe("ok");
    expect(said).toEqual(["unavailable", "ok"]);                                    // once each way
  });
});

describe("a legacy hub", () => {
  it("never says unavailable: a listing that fails is the poll's failure, as before", async () => {
    const svc = new ObservationService({ listWorkers: async () => { throw new Error("tmux: server exited"); }, captureMany: async () => new Map() }, 60_000);
    await expect(svc.poll()).rejects.toThrow(/server exited/);
    expect(svc.fleet()).toBe("ok");
  });
});
```

- [ ] **Step 14.28: Run them and see them fail**

Run: `npx vitest run apps/hub/test/fleet-conflicts.test.ts apps/hub/test/fleet-unavailable.test.ts`
Expected: FAIL, 4 of 4: `TypeError: obs.conflicted is not a function` (fleet-conflicts, both) and `TypeError: svc.fleet is not a function` (fleet-unavailable, both). The roster itself already lists both `claude` windows: Step 14.10's `listWorkers` builds it from the inventories.

- [ ] **Step 14.29: Implement the fleet's availability and the manager by its registry name**

In `apps/hub/src/application/observation-service.ts` (as Task 5 left it):
1. In `Listener`, replace its last member and the line that closes it,
   ```ts
     watching(): string | null;
   };
   ```
   with
   ```ts
     watching(): string | null;
     // Whether the fleet answers, each time that changes (Task 14; fleet core §7): "unavailable" while no listing can be
     // had. A legacy hub never calls it.
     fleet?(status: "ok" | "unavailable"): void;
   };
   type Listing = Awaited<ReturnType<Tmux["listWorkers"]>>;
   ```
2. After `  #arrived: NodeRound[] = [];                          // rounds done and not yet applied` add:
   ```ts
     #listing: Listing = [];                              // the last listing that came
     #conflicted = new Set<string>();                     // workers whose name the lane registry has in conflict
     #fleet: "ok" | "unavailable" = "ok";
   ```
3. After `  subscribe(l: Listener) { this.#listeners.add(l); return () => this.#listeners.delete(l); }` add:
   ```ts
     // Whether the fleet answers (fleet core §7); a legacy hub's is always "ok".
     fleet(): "ok" | "unavailable" { return this.#fleet; }
     // Whether a worker's name is in conflict in the fleet's lane registry (two windows claim it): routes by that name
     // (the manager's answers) refuse it; a send by its worker id still goes (Task 14).
     conflicted(id: string): boolean { return this.#conflicted.has(id); }
   ```
4. In `poll()`, replace `      const listing = await this.#tmux.listWorkers();` with `      const listing = await this.#list();`.
5. Before `  // Which agent session runs in which pane, read again every 10 s.` add:
   ```ts
     // The listing. With a fleet (nodeStates set), one that can't be had (the fleet down or unreachable) keeps the last
     // roster with every worker offline, since nothing is known of them now, and says "unavailable" until a listing comes
     // again (fleet core §7: "the hub shows fleet unavailable"). Legacy: a failure is the poll's, as before.
     async #list(): Promise<Listing> {
       try {
         const listing = await this.#tmux.listWorkers();
         this.#listing = listing;
         this.#conflicted = new Set(listing.filter(w => w.conflict).map(w => w.id));
         this.#setFleet("ok");
         return listing;
       } catch (e) {
         if (!this.#nodeStates) throw e;
         if (this.#fleet === "ok") log.warn(`fleet unavailable (${(e as Error).message}): the roster stays, every worker offline`);
         this.#setFleet("unavailable");
         return this.#listing.map(w => ({ ...w, offline: true }));
       }
     }
     #setFleet(status: "ok" | "unavailable") {
       if (status === this.#fleet) return;
       this.#fleet = status;
       for (const l of this.#listeners) l.fleet?.(status);
     }
   ```
6. In `#pollNodes`, right after `  async #pollNodes() {` add:
   ```ts
       if (this.#fleet === "unavailable") return;                 // nothing can be asked of any node now
   ```

In `apps/hub/src/application/escalation-service.ts` (as Task 5 left it):
1. In `Watch`, replace `  workers(): { id: string; name: string }[];` with
   ```ts
     // `conflict`: the fleet's lane registry has this name in conflict (two windows claim it, Task 14); legacy never says.
     workers(): { id: string; name: string; conflict?: boolean }[];
   ```
2. In `AnswerResult`, replace `| "node_offline" | "step_up" |` with `| "node_offline" | "lane_conflict" | "step_up" |` (http.ts answers it 409, as every refusal but `step_up`, `unknown` and `no_pane`).
3. Before `export const answerKey =` add:
   ```ts
   // The manager's pane: the worker named so (the first, as the legacy hub always took it), or none while that name is in
   // conflict in the fleet (two windows claim it, on one node or two, Task 14): which one asked can't be told, so its asks
   // come from the ledger alone and an answer is refused (lane_conflict), never typed into either.
   export function managerOf(workers: readonly { id: string; name: string; conflict?: boolean }[], managerName: string): string | null {
     const named = workers.filter(w => w.name === managerName);
     return named.some(w => w.conflict) ? null : named[0]?.id ?? null;
   }
   ```
4. In `#managerSightings`, replace `    const manager = this.#watch.workers().find(w => w.name === this.#managerName) ?? null;` with
   ```ts
       const managerId = managerOf(this.#watch.workers(), this.#managerName);
       const manager = managerId === null ? null : { id: managerId };
   ```
5. In `answer`, replace `      if (!e.asker.workerId) return { ok: false, problem: "no_pane", item: this.#view(id) };` with
   ```ts
         if (!e.asker.workerId) {
           const conflict = e.asker.kind === "manager" && this.#watch.workers().some(w => w.name === this.#managerName && w.conflict);
           return { ok: false, problem: conflict ? "lane_conflict" : "no_pane", item: this.#view(id) };
         }
   ```

In `apps/hub/src/main.ts` (as Step 14.20 left it):
1. Replace `import { EscalationService } from "./application/escalation-service.ts";` with `import { EscalationService, managerOf } from "./application/escalation-service.ts";`.
2. Replace `    const managerPane = () => observation.snapshot().workers.find(w => w.name === config.managerWindow)?.id ?? null;` with
   ```ts
       // The workers as escalations see them: with each one's conflict (two windows claim its name, Task 14).
       const workers = () => observation.snapshot().workers.map(w => ({ id: w.id as string, name: w.name, conflict: observation.conflicted(w.id) }));
       const managerPane = () => managerOf(workers(), config.managerWindow);
   ```
3. Replace `        workers: () => observation.snapshot().workers.map(w => ({ id: w.id as string, name: w.name })),` with `        workers,`.

- [ ] **Step 14.30: Run them and see them pass, then every suite**

Run: `npx vitest run apps/hub/test/fleet-conflicts.test.ts apps/hub/test/fleet-unavailable.test.ts`
Expected: PASS, 4 tests.

Run each on its own:
```bash
npx vitest run apps/hub packages apps/web
MORNDO_HUB_MODES=fleet npx vitest run apps/hub packages apps/web
npm run check
npm run lint
```
Expected:
- vitest (both modes): every file PASSES but `pane-lock.test.ts` on macOS (2 tests): 142 files, 1129 tests, 2 failed.
- vitest (`MORNDO_HUB_MODES=fleet`): 142 files, 1090 tests, the same 2 failed.
- `npm run check`: exits 0. `npm run lint`: reports nothing.

- [ ] **Step 14.31: Commit, then the negative controls**

```bash
git add apps/hub/src/application/observation-service.ts apps/hub/src/application/escalation-service.ts apps/hub/src/main.ts apps/hub/test/fleet-conflicts.test.ts apps/hub/test/fleet-unavailable.test.ts
git commit -m "feat(hub): the fleet's availability, and the manager by its name only while it isn't in conflict"
```

The controls come after the commit, each alone, each undone with `git checkout -- <file>`, `git status` clean after each:
- In `escalation-service.ts`, replace `named.some(w => w.conflict) ? null : named[0]?.id ?? null` with `named[0]?.id ?? null` (the first window called manager, as before). `npx vitest run apps/hub/test/fleet-conflicts.test.ts` fails in "an answer to the manager is refused lane_conflict …" with `AssertionError: expected { ok: true, …(1) } to match object { ok: false, problem: 'lane_conflict' }`: the answer was typed into one of the two.
- In `fleet-adapters.ts`, replace `conflict: view.conflicted(name),` with `conflict: false,`. The same run fails in both tests (the listing with `AssertionError: expected [ { id: 'pc.aaaaaaaa.1', …(5) }, …(1) ] to deeply equal [ { id: 'pc.aaaaaaaa.1', …(5) }, …(1) ]`, the manager's with `AssertionError: expected false to be true` on `obs.conflicted(PC1)`).
- In `observation-service.ts`, replace `      if (!this.#nodeStates) throw e;` with `      throw e;` (a fleet hub's failed listing as the poll's failure, as a legacy hub's). `npx vitest run apps/hub/test/fleet-unavailable.test.ts` fails in "keeps the roster, says unavailable once …" with `Error: connect ENOENT …/fleet.sock`: the poll throws, as a legacy hub's does, so nothing is kept or said.


---

### Task 15: Worker IDs end to end

**Files:**
- Modify: `packages/protocol/src/feed.ts`:
  - `:7-21` (imports; `PANE`, `paneId` and `workerId` replaced);
  - `:36` (the `worker` fields gain `node`);
  - `:189`, `:190`, `:195`, `:202` (client frames: `details`, `watch`, `older`, `catchup`; line numbers as Task 5 left the file).
- Modify: `packages/domain/src/observation.ts:5` (`Worker` gains `node`)
- Modify: `packages/node-ops/src/tmux.ts:18` (Task 2's pane listing: a pane on this machine doesn't know its node)
- Modify: `apps/hub/src/adapters/http.ts`:
  - `:25-28` (import `isWorkerOrLegacyId`);
  - `:302-306` (the send route);
  - `:354` (the static files: no whole path is decoded any more);
  - new `decodeSegment` and exported `workerIdFromSegment` before `startHttp` (`:119`).
- Modify: `apps/hub/src/application/escalation-service.ts` (as Task 5 left it):
  - `:7-10` (import `menuEscalationId`);
  - `:226`, `:238` (menu ids).
- Modify: `apps/hub/src/application/observation-service.ts` (the listing handed to `Roster.observeListing` carries `node`).
- Modify: `apps/web/src/lib/gallery/data.ts:14` (`node`)
- Modify (`Worker` and `RosterEntry` literals gain `node`):
  - `packages/domain/test/observation.test.ts:47`, `packages/domain/test/waiting-on.test.ts:19`, `packages/domain/test/conversation.test.ts:45`;
  - `apps/web/test/horizon.test.ts:15`, `apps/web/test/lanes.test.ts:6-8`.

  The hub's tests need none: Task 4 moved every listing literal to the port's item, which has its `node` already.
- Create:
  - `packages/protocol/test/worker-ids.test.ts`;
  - `apps/hub/test/escalation-menu-ids.test.ts`;
  - `apps/hub/test/fleet-two-nodes.test.ts`;
- Modify (rewrite, both modes): `apps/hub/test/http-older.test.ts` (Task 4's), once the feed takes worker ids;
  - `apps/web/test/outbox-legacy-id.test.ts`;
  - `apps/web/test/outbox-legacy-web.test.ts`.
- Test: the files above, plus every hub, web and protocol suite.

**Interfaces:**
- Consumes:
  - from `packages/protocol/src/worker-id.ts` (Task 1): `WORKER_ID`, `LEGACY_PANE_ID`, `isWorkerOrLegacyId(id): boolean`, `menuEscalationId(workerId): string`;
  - from Task 14: `fleetRig`, `observationFor`, `steeringFor`, `escalationsFor`, `portsFor`, `localNode`, `memoryBackend`;
  - from Task 5: the outbox's `typedAt`, and `words.ts`' wording for `node_offline` and `too_large`.
- Produces:
  ```ts
  // packages/domain/src/observation.ts
  export type Worker = { id: WorkerId; name: string; location: string; node: string };   // RosterEntry gains node with it
  // packages/protocol/src/feed.ts: every frame that names a worker takes WORKER_ID or LEGACY_PANE_ID; RosterEntrySchema
  // and WorkerAppeared.worker carry `node` (a hub that doesn't say: "")
  // apps/hub/src/adapters/http.ts: a path is split into segments first, and each is decoded once (decodeSegment)
  export function workerIdFromSegment(segment: string): string | null;
  // menu escalation ids: menuEscalationId(workerId), "menu-pc_3fa2c1d0_12"; a legacy "%4" stays "menu-4"
  ```

**Decision: the protocol accepts both forms, always, not by mode.** The code settles it:
1. **One app build talks to either hub.**
   - `apps/web` decodes every frame with `@morndo/protocol` (`feed.svelte.ts:5`).
   - Which hub it is depends only on `MORNDO_FLEET_SOCKET`, on the hub's side, which the app can't see.
   - A mode-dependent decoder would make the app learn the mode first: another frame, another round trip, another way to fail.
2. **The legacy hub keeps `%N` until sub-project 4** (spec §4, §10; `packages/node-ops/src/tmux.ts:116` lists only `%N` panes). The decoder must take `%N` for as long as a legacy hub exists.
3. **Each hub already refuses ids it doesn't hold.**
   - The legacy adapters answer `no_pane` or null for anything that isn't `%N` (`packages/node-ops/src/tmux.ts:122,146`, `terminal.ts:39,56`). The fleet adapters do the same for anything that isn't a worker id (`parseWorkerId` → null).
   - Accepting both forms at the edge therefore costs no safety. It also gives the failure the spec asks for (ADR-0012 Consequences): an old outbox entry for `%N` reaches the fleet hub's send route and gets `404 no_pane`, which the outbox words as "is no longer running" (`words.ts:13`).
   - A decoder that refused `%N` on a fleet hub would close the feed with 1003 for a `watch` frame (`http.ts:442`). The send would answer "no such route", which the outbox shows as `Not sent: the hub answered "no such route"` (`words.ts:42`).
4. **Strictness stays where it was.** The roster's own ids were never checked (`feed.ts:21`, `anyWorkerId`). The ids the app sends, and the per-worker frames the hub sends, are still checked: anything that fits neither grammar (`../etc`, `main:0`, upper case, a 33-character node) is malformed.

- [ ] **Step 15.1: Write the failing protocol test**

Create `packages/protocol/test/worker-ids.test.ts`:

```ts
// Worker ids on the feed (spec §4; ADR-0012): the fleet's `<node>.<server>.<pane>` and a legacy hub's `%N` are both taken
// in every frame that names a worker, whichever hub the app talks to (one build serves both, and each hub answers an id
// it doesn't hold as no pane). Anything else is malformed. A roster entry carries its node; one from a hub that doesn't
// say has node "". Menu escalation ids for the same %N on two nodes, or on two tmux servers of one node, never collide.
import { describe, expect, it } from "vitest";
import { ClientFeedFrames, ServerFeedFrames, decode, decodeEvent, menuEscalationId } from "../src/index.ts";

const GOOD = ["pc.3fa2c1d0.12", "a.00000000.0", `${"n".repeat(32)}.ffffffff.999999999`, "%0", "%12", "%999999999"];
const BAD = ["pc.3fa2c1d0", "PC.3fa2c1d0.1", "pc.3FA2C1D0.1", "pc.3fa2c1d.1", "pc.3fa2c1d0.1.2", "pc_3fa2c1d0_1",
  `${"n".repeat(33)}.3fa2c1d0.1`, "pc.3fa2c1d0.1234567890", "pc.3fa2c1d0.-1", " pc.3fa2c1d0.1", "%", "%1a", "%1234567890",
  "../../etc", "main:0", ""];
const kind = (d: { kind: string }) => d.kind;
const clientFrames = (id: string) => [{ t: "watch", worker: id }, { t: "details", worker: id }, { t: "older", worker: id, before: "a1:0" }, { t: "catchup", worker: id }];
const message = { id: "m1", at: 1, author: { kind: "agent", name: "builder" }, kind: "text", text: "Starting." };
const serverFrames = (id: string) => [
  { t: "screen", worker: id, text: "$ ", at: 1 },
  { t: "history", worker: id, messages: [message], session: null },
  { t: "messages", worker: id, messages: [message] },
  { t: "details", worker: id, session: null },
  { t: "older", worker: id, before: "a1:0", messages: [], done: true },
];

describe("worker ids in the app's frames", () => {
  it("takes both forms in watch, details, older and catchup", () => {
    for (const id of GOOD) for (const f of clientFrames(id)) expect(kind(decode(ClientFeedFrames, JSON.stringify(f))), `${f.t} ${id}`).toBe("ok");
  });
  it("calls anything else malformed (negative control)", () => {
    for (const id of BAD) for (const f of clientFrames(id)) expect(kind(decode(ClientFeedFrames, JSON.stringify(f))), `${f.t} ${JSON.stringify(id)}`).toBe("malformed");
  });
});

describe("worker ids in the hub's frames", () => {
  it("takes both forms in screen, history, messages, details and older", () => {
    for (const id of GOOD) for (const f of serverFrames(id)) expect(kind(decode(ServerFeedFrames, JSON.stringify(f))), `${f.t} ${id}`).toBe("ok");
  });
  it("calls a frame for anything else malformed", () => {
    for (const id of BAD) for (const f of serverFrames(id)) expect(kind(decode(ServerFeedFrames, JSON.stringify(f))), `${f.t} ${JSON.stringify(id)}`).toBe("malformed");
  });
});

describe("the roster's node", () => {
  const entry = { id: "pc.3fa2c1d0.12", name: "alpha", location: "alpha", node: "pc", title: null, lastMessageAt: null, needsYou: false, waitingOn: null, state: "quiet", changedAt: 0 };
  it("keeps each worker's node; an entry from a hub that doesn't say has node \"\"", () => {
    const d = decode(ServerFeedFrames, JSON.stringify({ t: "snapshot", epoch: "e1", seq: 0, workers: [entry, { ...entry, id: "%1", node: undefined }] }));
    expect(d.kind === "ok" && d.frame.t === "snapshot" ? d.frame.workers.map(w => [w.id, w.node]) : null).toEqual([["pc.3fa2c1d0.12", "pc"], ["%1", ""]]);
  });
  it("a worker appearing carries its node", () => {
    const e = decodeEvent({ epoch: "e1", seq: 1, at: 1, body: { type: "WorkerAppeared", worker: { id: "box.0a0a0a0a.3", name: "beta", location: "beta", node: "box" }, state: "quiet", changedAt: 1 } });
    expect(e.kind === "event" && e.event.body.type === "WorkerAppeared" ? e.event.body.worker.node : null).toBe("box");
  });
});

describe("menu escalation ids", () => {
  it("never collide for the same %N on two nodes or two tmux servers, and fit the hub's answer route", () => {
    const ids = ["pc.3fa2c1d0.1", "box.3fa2c1d0.1", "pc.0a0a0a0a.1", "pc.3fa2c1d0.11", "%1"].map(menuEscalationId);
    expect(ids).toEqual(["menu-pc_3fa2c1d0_1", "menu-box_3fa2c1d0_1", "menu-pc_0a0a0a0a_1", "menu-pc_3fa2c1d0_11", "menu-1"]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,80}$/);           // http.ts: /api/escalations/<id>/answer
  });
});
```

- [ ] **Step 15.2: Run it and see it fail**

Run: `npx vitest run packages/protocol/test/worker-ids.test.ts`
Expected: FAIL, 4 tests:
- "takes both forms in watch, details, older and catchup": `watch pc.3fa2c1d0.12: expected 'malformed' to be 'ok'`;
- "takes both forms in screen, …": `screen pc.3fa2c1d0.12: expected 'malformed' to be 'ok'`;
- "keeps each worker's node": `expected [ …(2) ] to deeply equal [ [ 'pc.3fa2c1d0.12', 'pc' ], …(1) ]` (the node is dropped);
- "a worker appearing carries its node": `expected undefined to be 'box'`.

The two negative controls and the menu id test pass already (Task 1 provides `menuEscalationId`).

- [ ] **Step 15.3: Implement worker ids in the protocol and `node` in the domain**

In `packages/protocol/src/feed.ts`:

1. **`:7-21`.** Replace the lines from the `@morndo/domain` type import through the `anyWorkerId` line. The `@morndo/domain` import stays as it is. The block becomes:
   ```ts
   import type {
     AnswerRefusal, CatchUpConversation, Escalation, EscalationId, EndpointId, FeedBody, FeedEvent, Message, RosterEntry, SessionId, WorkerId,
   } from "@morndo/domain";
   import { isWorkerOrLegacyId } from "./worker-id.ts";
   import * as z from "./z.ts";

   const str = (max = 100_000) => z.string().check(z.maxLength(max));       // app → hub: limited
   const text = () => z.string();                                           // hub → app: any length
   // zod's catch: a schema that reads a value it doesn't know as the fallback (named so it isn't taken for Promise.catch).
   const orElse = z.catch;
   const count = () => z.number().check(z.gte(0));
   // A worker the app names: the fleet's `<node>.<server>.<pane>` or a legacy hub's `%N` (worker-id.ts), both, always.
   // One build of the app talks to either hub, and only the hub's own configuration (MORNDO_FLEET_SOCKET) decides which.
   // Each hub answers an id it doesn't hold as no pane, so an older app's `%N` reaches a fleet hub and fails there as
   // no_pane, never as a frame this decoder refused (ADR-0012; spec §4). Zod Mini's refinement: .check(z.refine(…))
   // (https://zod.dev/packages/mini, read 2026-10-06).
   const workerIdText = z.string().check(z.refine(isWorkerOrLegacyId));
   const workerId = z.pipe(workerIdText, z.transform(s => s as WorkerId));
   // A roster entry's id isn't checked further here: the hub assigns it.
   const anyWorkerId = z.pipe(text(), z.transform(s => s as WorkerId));
   ```
2. **`:36`.** It becomes:
   ```ts
   // `node`: the machine the worker runs on (ADR-0012); a hub from before the fleet doesn't say: "".
   const worker = { id: anyWorkerId, name: text(), location: text(), node: orElse(text(), "") };
   ```
3. **In `ClientFeedFrames`.** Replace `paneId` by `workerIdText` in the four frames:
   ```ts
     details: z.object({ t: z.literal("details"), worker: workerIdText }),
     watch: z.object({ t: z.literal("watch"), worker: z.nullable(workerIdText) }),
   ```
   ```ts
     older: z.object({ t: z.literal("older"), worker: workerIdText, before: str(500).check(z.minLength(1)) }),
   ```
   ```ts
     catchup: z.object({ t: z.literal("catchup"), worker: z.exactOptional(workerIdText) }),
   ```

In `packages/domain/src/observation.ts:5`, replace the line with:

```ts
// node: the machine it runs on, a fleet node's name or the legacy hub's own label (ADR-0012).
export type Worker = { id: WorkerId; name: string; location: string; node: string };
```

In `packages/node-ops/src/tmux.ts` (Task 2's), the tmux adapter lists this machine's panes and can't know which node it is: whoever uses it names the node (the hub's `localTmux` says `"local"`). Replace (`:18`)
```ts
  listWorkers(): Promise<Worker[]>;
```
with
```ts
  listWorkers(): Promise<Omit<Worker, "node">[]>;        // panes on this machine; the caller names their node (local-node.ts)
```
Without it, `tsc -p packages/node-ops` fails at `tmux.ts:105` (`listWorkers` returns no `node`).

Give every `Worker` and `RosterEntry` literal its node:
- `packages/domain/test/observation.test.ts:47`:
  ```ts
  const w = (id: string, name = id) => ({ id: workerId(id), name, location: "/tmp", node: "local" });
  ```
- `packages/domain/test/waiting-on.test.ts:19`:
  ```ts
      r.observeListing([{ id: workerId("%1"), name: "builder", location: "/w", node: "local" }], 0);
  ```
- `packages/domain/test/conversation.test.ts:45`:
  ```ts
      r.observeListing([{ id: workerId("%1"), name: "builder", location: "x", node: "local" }], 0);
  ```
- `apps/web/test/horizon.test.ts:15`:
  ```ts
  const worker = (name: string, o: Partial<RosterEntry> = {}): RosterEntry => ({ id: `%${name}` as WorkerId, name, location: "/work", node: "local", title: null, lastMessageAt: null, needsYou: false, waitingOn: null, state: "quiet", changedAt: 0, ...o });
  ```
- `apps/web/test/lanes.test.ts:6-8`:
  ```ts
  const w = (name: string, over: Partial<RosterEntry> = {}): RosterEntry => ({
    id: `%${name}` as WorkerId, name, location: "demo", node: "local", title: null, lastMessageAt: null, needsYou: false, waitingOn: null, state: "quiet", changedAt: 0, ...over,
  });
  ```
- `apps/web/src/lib/gallery/data.ts:14` (every id there carries the gallery's marker, so the node does too):
  ```ts
      id: `${MARK}-${name}` as WorkerId, name, location: "%0", node: MARK, title: null, lastMessageAt: null, needsYou: false, waitingOn: null,
  ```
- **`apps/hub/src/application/observation-service.ts`.** The port's listing becomes domain `Worker`s for `Roster.observeListing` field by field (Task 4), so the node is carried there. Replace
  ```ts
        const bodies = this.#roster.observeListing(listing.map(w => ({ id: workerId(w.id), name: w.name, location: w.location })), now);
  ```
  with
  ```ts
        const bodies = this.#roster.observeListing(listing.map(w => ({ id: workerId(w.id), name: w.name, location: w.location, node: w.node })), now);
  ```
  Without it, `npm run check` fails with `Property 'node' is missing` there.

- [ ] **Step 15.4: Run it and see it pass; type-check the shape checks**

Run each on its own:
- `npx vitest run packages/protocol packages/domain`
- `npm run check`

Expected:
- vitest: PASS, every protocol and domain test, including 7 in `worker-ids.test.ts`.
- `npm run check`: exits 0. Its `check<Same<z.output<typeof RosterEntrySchema>, RosterEntry>>` and the `FeedBody` check in `feed.ts:209-214` prove the wire and the domain agree on `node`.

- [ ] **Step 15.5: Commit**

```bash
git add packages/protocol/src/feed.ts packages/protocol/test/worker-ids.test.ts packages/domain/src/observation.ts packages/domain/test packages/node-ops/src/tmux.ts \
  apps/web/test/horizon.test.ts apps/web/test/lanes.test.ts apps/web/src/lib/gallery/data.ts apps/hub/src/application/observation-service.ts
git commit -m "feat(protocol): fleet worker ids in feed frames, and each worker's node"
```

- [ ] **Step 15.6: Write the failing hub tests (menu ids; the two-node run)**

Create `apps/hub/test/escalation-menu-ids.test.ts`:

```ts
// Menu escalation ids (spec §4): "menu-" and the worker id with "." as "_", from one definition (packages/protocol
// worker-id.ts, menuEscalationId).
// - Two nodes' panes with the same %N are two asks with two ids, each fit for the answer route.
// - A legacy pane keeps its old id ("%4" → "menu-4"), so a Decision the legacy hub stored for it still applies.
// - Old menu-N rows are provenance, never pruned (retention.ts), as spec §4 and §15 (item 7) say; a fleet hub simply
//   never sights them again, and they stop being loaded after 7 days (Store.decisions).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId, type Decision } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import type { Tmux } from "../src/application/ports.ts";
import { escalationsFor, portsFor, type ModePorts } from "./helpers/hub-mode.ts";

const T0 = Date.UTC(2026, 9, 6, 10);
const MENU = "work…\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel\n\n";
const NO_TMUX: Tmux = {
  listWorkers: async () => [], capture: async () => null, captureMany: async ids => new Map(ids.map(id => [id, null])),
  send: async () => ({ problem: "no_pane", typedAt: 0 }),
};
const DECIDED: Decision = { choice: { kind: "words" }, at: T0 - 60_000, via: "here", endpointId: endpointId("ep1"), sessionId: sessionId("s1") };

let dir: string;
let store: Store;
let ports: ModePorts;
beforeEach(async () => { dir = mkdtempSync(join(tmpdir(), "morndo-menu-ids-")); store = new Store(dir); ports = await portsFor("legacy", { tmux: NO_TMUX }); });
afterEach(async () => { await ports.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });

// The board after one look at these workers, each showing a menu on its screen.
function board(workers: { id: string; name: string }[]) {
  const s = escalationsFor(ports, {
    store, now: () => T0,
    watch: { workers: () => workers, history: () => [], openQuestions: () => [], screen: id => (workers.some(w => w.id === id) ? MENU : undefined) },
  });
  s.poll();
  return s.board().items;
}

describe("menu escalation ids", () => {
  it("the same %N on two nodes is two asks with two ids, each fit for the answer route", () => {
    const ids = board([{ id: "pc.aaaaaaaa.1", name: "alpha" }, { id: "box.bbbbbbbb.1", name: "beta" }]).map(i => i.id).sort();
    expect(ids).toEqual(["menu-box_bbbbbbbb_1", "menu-pc_aaaaaaaa_1"]);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,80}$/);           // http.ts: /api/escalations/<id>/answer
  });
  it("a legacy pane keeps its id, so a Decision stored for it before a restart still applies", () => {
    store.saveDecision("menu-4", DECIDED);
    expect(board([{ id: "%4", name: "reviewer" }]).find(i => i.id === "menu-4")?.decision).toMatchObject({ choice: { kind: "words" }, via: "here" });
  });
  it("an old menu-N row never attaches to a fleet worker's menu", () => {
    store.saveDecision("menu-1", DECIDED);
    expect(board([{ id: "pc.aaaaaaaa.1", name: "alpha" }]).map(i => [i.id, i.decision])).toEqual([["menu-pc_aaaaaaaa_1", null]]);
  });
});
```

Create `apps/hub/test/fleet-two-nodes.test.ts`:

```ts
// The hub in fleet mode end to end, against a fake fleet with two nodes whose panes are both %1 (spec §9, "Two nodes":
// "the hub lists and steers both"). It checks that:
// - the roster names both workers by worker id, with their node;
// - the feed takes those ids in its frames;
// - a send reaches only its own node;
// - the terminal route opens a worker id;
// - a legacy %N from an older app's outbox is no pane;
// - a malformed or foreign id is no route, and a path that doesn't decode is never a 500 (each segment is decoded once);
// - the two menus are two asks with two ids.
// The real HTTP server and services, fake passkeys, a temp data dir, and the fleet adapters over a real Unix socket.
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { ServerFeedFrames, decode } from "@morndo/protocol";
import type { Config } from "../src/config.ts";
import { Store } from "../src/adapters/store.ts";
import { loadOrCreateIdentity } from "../src/adapters/identity.ts";
import { startHttp } from "../src/adapters/http.ts";
import type { Passkeys } from "../src/adapters/passkeys.ts";
import { AccessService } from "../src/application/access-service.ts";
import { RemoteService } from "../src/application/remote-service.ts";
import type { ObservationService } from "../src/application/observation-service.ts";
import type { EscalationService } from "../src/application/escalation-service.ts";
import { localNode, memoryBackend, type MemoryBackend, type MemoryPane } from "./helpers/fake-fleet.ts";
import { escalationsFor, fleetRig, observationFor, steeringFor, type FleetRig } from "./helpers/hub-mode.ts";

const ORIGIN = "https://hub.example.test";
const PC1 = "pc.aaaaaaaa.1";
const BOX1 = "box.bbbbbbbb.1";
const BOX = "──────\n❯ ";
const MENU = "Allow this edit?\n❯ 1. Yes\n  2. No\n\nEsc to cancel";

type FleetHub = {
  observation: ObservationService;
  escalations: EscalationService;
  cookie(): Promise<string>;
  get(path: string): Promise<Response>;
  post(path: string, body: unknown, cookie: string): Promise<Response>;
  socket(path: string, cookie: string): Promise<WebSocket>;
  close(): Promise<void>;
};

// The hub as main.ts builds it in fleet mode, on a random port: its services on the fleet adapters.
async function startFleetHub(rig: FleetRig): Promise<FleetHub> {
  const dir = mkdtempSync(join(tmpdir(), "morndo-fleet-hub-"));
  const web = join(dir, "web");
  mkdirSync(web);
  writeFileSync(join(web, "200.html"), "<!doctype html><html><body>shell</body></html>");
  const store = new Store(dir);
  const config: Config = {
    dataDir: dir, port: 0, origin: ORIGIN, rpId: "hub.example.test", rpName: "Morndo", requireProxyIdentity: false, principalLogin: null,
    tmuxSocket: null, tmuxSession: null, claudeDir: null, webDir: web, officeName: null, pollMs: 1000, quietAfterMs: 60_000,
    managerWindow: "manager", ledgerPath: null, paneLock: null, vnc: null, filesDir: join(dir, "files"), inboxDir: join(dir, "inbox"),
    fleetSocket: rig.fleet.socketPath,
  };
  let n = 0;
  const passkeys: Passkeys = {
    registrationOptions: async () => ({ challenge: `reg-${++n}` }) as never,
    verifyRegistration: async () => ({ credential: { id: `cred-${++n}`, publicKey: new Uint8Array([1]), counter: 1, transports: [] }, userVerified: true }),
    authenticationOptions: async () => ({ challenge: `auth-${++n}` }) as never,
    verifyAuthentication: async () => ({ userVerified: true, newCounter: ++n }),
  };
  const access = new AccessService(store, passkeys);
  const observation = observationFor(rig.ports, { quietAfterMs: 60_000 });
  const steering = steeringFor(rig.ports, { store, policy: () => access.policy(), waitingOn: id => observation.waitingOn(id), nameOf: id => observation.nameOf(id) });
  const escalations = escalationsFor(rig.ports, {
    store,
    watch: {
      workers: () => observation.snapshot().workers.map(w => ({ id: w.id as string, name: w.name, conflict: observation.conflicted(w.id) })),
      history: id => observation.history(id), openQuestions: id => observation.openQuestions(id), screen: id => observation.screen(id),
    },
  });
  const remote = new RemoteService({ store, terminal: rig.ports.terminal, panes: () => observation.snapshot().workers.map(w => w.id as string), desktop: () => null });
  const http = startHttp({ config, identity: loadOrCreateIdentity(dir), access, observation, steering, escalations, remote });
  await http.ready;
  const base = `http://127.0.0.1:${(http.server.address() as AddressInfo).port}`;
  return {
    observation, escalations,
    async cookie() {
      const opts = await access.pairOptions(access.issueConsoleToken().secret, "phone");
      if (!("flowId" in opts)) throw new Error(opts.refused);
      const r = await access.pairVerify(opts.flowId, {} as never);
      if (!("cookieSecret" in r)) throw new Error(r.refused);
      return r.cookieSecret;
    },
    get: path => fetch(base + path),
    post: (path, body, secret) => fetch(base + path, {
      method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", cookie: `__Host-morndo=${secret}` }, body: JSON.stringify(body),
    }),
    socket: (path, secret) => new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(base.replace("http", "ws") + path, { headers: { origin: ORIGIN, cookie: `__Host-morndo=${secret}` } });
      ws.on("open", () => resolve(ws));
      ws.on("unexpected-response", (_req, res) => reject(new Error(`upgrade refused: ${res.statusCode ?? "?"}`)));
      ws.on("error", () => {});
    }),
    close: async () => { await http.close(); store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

// The next frame of type `t` on this socket, within 5 s.
function frameOf(ws: WebSocket, t: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const on = (raw: unknown) => {
      const m = JSON.parse(String(raw)) as Record<string, unknown>;
      if (m.t !== t) return;
      clearTimeout(timer);
      ws.off("message", on);
      resolve(m);
    };
    const timer = setTimeout(() => { ws.off("message", on); reject(new Error(`no ${t} frame within 5 s`)); }, 5000);
    ws.on("message", on);
  });
}

let pc: MemoryBackend;
let box: MemoryBackend;
let pcPane: MemoryPane;
let boxPane: MemoryPane;
let rig: FleetRig;
let hub: FleetHub;
let cookie: string;
beforeEach(async () => {
  pcPane = { name: "alpha", cwd: "/w/alpha", screen: BOX };
  boxPane = { name: "beta", cwd: "/w/beta", screen: BOX };
  pc = memoryBackend({ "%1": pcPane });
  box = memoryBackend({ "%1": boxPane });
  pc.typedAt = 1_791_000_000_001;
  box.typedAt = 1_791_000_000_002;
  rig = await fleetRig([localNode("pc", "aaaaaaaa", pc), localNode("box", "bbbbbbbb", box)]);
  hub = await startFleetHub(rig);
  await hub.observation.poll();
  hub.escalations.poll();
  cookie = await hub.cookie();
});
afterEach(async () => { await hub.close(); await rig.close(); });
const sendBody = (text: string, name: string) => ({ text, requestId: randomUUID(), seen: "none", name });
const sentTo = () => rig.fleet.calls.filter(c => c.op === "pane.send").map(c => c.target.workerId);

describe("the hub in fleet mode with two nodes (spec §9)", () => {
  it("lists both workers by worker id, with their node, in the feed's snapshot", async () => {
    const ws = await hub.socket("/api/feed", cookie);
    const snapshot = frameOf(ws, "snapshot");
    ws.send(JSON.stringify({ t: "hello" }));
    const d = decode(ServerFeedFrames, JSON.stringify(await snapshot));
    ws.close();
    if (d.kind !== "ok" || d.frame.t !== "snapshot") throw new Error(`the snapshot decodes as ${d.kind}`);
    expect(d.frame.workers.map(w => ({ id: w.id, name: w.name, node: w.node, location: w.location })).sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: BOX1, name: "beta", node: "box", location: "beta" },
      { id: PC1, name: "alpha", node: "pc", location: "alpha" },
    ]);
  });

  it("takes a watch of a worker id, and sends that worker's screen", async () => {
    const ws = await hub.socket("/api/feed", cookie);
    let closed: number | null = null;
    ws.on("close", code => { closed = code; });
    const screen = frameOf(ws, "screen");
    ws.send(JSON.stringify({ t: "hello" }));
    ws.send(JSON.stringify({ t: "watch", worker: PC1 }));
    expect(await screen).toMatchObject({ t: "screen", worker: PC1, text: BOX });
    expect(closed).toBeNull();
    ws.close();
  });

  it("steers each node: a send reaches only the pane of the worker it names, with that node's typedAt", async () => {
    const toPc = await hub.post(`/api/workers/${PC1}/send`, sendBody("to the pc", "alpha"), cookie);
    expect(toPc.status).toBe(200);
    expect(await toPc.json()).toEqual({ ok: true, at: 1_791_000_000_001 });
    const toBox = await hub.post(`/api/workers/${encodeURIComponent(BOX1)}/send`, sendBody("to the box", "beta"), cookie);
    expect(await toBox.json()).toEqual({ ok: true, at: 1_791_000_000_002 });
    expect(pc.typed.map(t => t.text)).toEqual(["to the pc"]);
    expect(box.typed.map(t => t.text)).toEqual(["to the box"]);
  });

  it("a legacy %N from an older app's outbox is no pane (404), and nothing is typed anywhere", async () => {
    const r = await hub.post("/api/workers/%251/send", sendBody("from an older app", "alpha"), cookie);
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: "no_pane" });
    expect(sentTo()).toEqual([]);
    expect([...pc.typed, ...box.typed]).toEqual([]);
  });

  it("route matching: a worker id percent-encoded is the same worker; malformed or foreign ids are no route, never a 500", async () => {
    const encoded = await hub.post(`/api/workers/${PC1.replaceAll(".", "%2E")}/send`, sendBody("encoded dots", "alpha"), cookie);
    expect(encoded.status).toBe(200);
    for (const path of ["/api/workers/%/send", "/api/workers/..%2F..%2Fetc/send", "/api/workers/PC.aaaaaaaa.1/send", "/api/workers/pc.aaaaaaaa.1.2/send",
      "/api/workers/main:0/send", "/api/workers/pc_aaaaaaaa_1/send", "/api/workers/pc.aaaaaaaa.1%00/send", "/api/nope/%"]) {
      const r = await hub.post(path, sendBody("never", "alpha"), cookie);
      expect([path, r.status, await r.json()]).toEqual([path, 404, { error: "no such route" }]);
    }
    expect(sentTo()).toEqual([PC1]);
    expect(pc.typed.map(t => t.text)).toEqual(["encoded dots"]);
  });

  it("a page path that doesn't decode is never a 500: the app shell answers it, and an escaped slash finds no file", async () => {
    for (const path of ["/%", "/%E0%A4%A", "/a%2F..%2F..%2F200.html", "/..%2F..%2Fetc%2Fpasswd"]) {
      const r = await hub.get(path);
      expect([path, r.status, await r.text()]).toEqual([path, 200, "<!doctype html><html><body>shell</body></html>"]);
    }
  });

  it("opens a worker id's terminal (the ?pane= route) and streams that node's frame", async () => {
    const ws = await hub.socket(`/api/terminal?pane=${encodeURIComponent(BOX1)}`, cookie);
    const frame = await frameOf(ws, "frame");
    ws.close();
    expect(frame.lines).toEqual(["──────", "❯ "]);
  });

  it("menus on both nodes' %1 are two asks with two ids, and the answer route takes them", async () => {
    pcPane.screen = MENU;
    boxPane.screen = MENU;
    await hub.observation.poll();
    hub.escalations.poll();
    expect(hub.escalations.board().items.map(i => i.id).sort()).toEqual(["menu-box_bbbbbbbb_1", "menu-pc_aaaaaaaa_1"]);
    const r = await hub.post("/api/escalations/menu-pc_aaaaaaaa_1/answer", { key: "1", requestId: randomUUID() }, cookie);
    expect(r.status).toBe(409);                                         // routed, and answered on the worker's own screen
    expect(await r.json()).toMatchObject({ error: "on_screen", item: { id: "menu-pc_aaaaaaaa_1", asker: { workerId: PC1 } } });
  });
});
```

Replace `apps/hub/test/http-older.test.ts` with the version below, which runs in both modes (round 2, item 17): its fleet mode names the worker by its worker id in the feed's frames, which the protocol takes since Step 15.3. It also reads a real page through each mode's ports, and, in fleet mode, asks one while the worker's node is offline: that page is `missing`, which the app shows as "Couldn't load older messages" with Try again, and it loads once the node is back (round 2, item 15).

```ts
// An older page over the feed (fleet core §3.1): older() is async now, and its transcript may be on another node. A
// page that fails is answered as missing, never an unhandled rejection (exitOnCrash would end the hub; vitest fails the
// run on one), and one connection's older pages run one at a time. Both configurations (spec §9): the observation over
// the legacy hub's ports and over the fleet adapters, with a real page read through each; and, in fleet mode, a page
// asked while the worker's node can't answer is missing (the app offers Try again), and comes once the node answers.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OlderResult } from "../src/application/observation-service.ts";
import type { Tmux } from "../src/application/ports.ts";
import { HUB_MODES, claudeDirPorts, observationFor, portsFor, type HubMode, type ModePorts } from "./helpers/hub-mode.ts";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";
import { frameText } from "./http-crash-fixture.ts";

let dir: string;
let hub: InProcessHub | null = null;
let ports: ModePorts | null = null;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-older-")); });
afterEach(async () => { await hub?.close(); hub = null; await ports?.close(); ports = null; rmSync(dir, { recursive: true, force: true }); });

const TMUX: Tmux = {
  listWorkers: async () => [{ id: "%1", name: "builder", location: "w", node: "local", offline: false }],
  capture: async () => "❯ ", captureMany: async ids => new Map(ids.map(id => [id, "❯ "])), send: async () => ({ problem: null, typedAt: 0 }),
};
// A worker %1 whose transcript holds 150 replies; the hub's observation over the ports of `mode`.
async function observed(mode: HubMode) {
  mkdirSync(join(dir, "sessions"));
  mkdirSync(join(dir, "projects", "-w"), { recursive: true });
  writeFileSync(join(dir, "sessions", "1.json"), JSON.stringify({ pid: process.pid, sessionId: "s1", tmux: "qa:@0.%1", name: "builder", cwd: "/w", version: "2.1.286", updatedAt: 1 }));
  const lines = Array.from({ length: 150 }, (_, i) => JSON.stringify({ type: "assistant", uuid: `r${i}`, timestamp: new Date(Date.UTC(2026, 9, 2, 8, 0, i)).toISOString(), message: { role: "assistant", content: [{ type: "text", text: `reply ${i}` }] } }));
  writeFileSync(join(dir, "projects", "-w", "s1.jsonl"), `${lines.join("\n")}\n`);
  ports = await portsFor(mode, { tmux: TMUX, ...claudeDirPorts(dir) });
  return { observation: observationFor(ports, { quietAfterMs: 60_000 }), id: ports.id };
}

// Every "older" frame the socket gets, in order; `count(n)` waits until n have come.
function olderFrames(ws: WebSocket) {
  const got: Record<string, unknown>[] = [];
  ws.on("message", d => { const m = JSON.parse(frameText(d)) as Record<string, unknown>; if (m.t === "older") got.push(m); });
  const count = async (n: number) => {
    for (let i = 0; i < 300 && got.length < n; i++) await new Promise(r => setTimeout(r, 10));
    return got;
  };
  return { got, count };
}

describe.each(HUB_MODES)("older pages on the feed, %s hub", mode => {
  it("a page whose read fails is answered missing, and the feed goes on", async () => {
    const { observation, id } = await observed(mode);
    vi.spyOn(observation, "older").mockImplementation(async (_w, before) => {
      if (before === "boom") throw new Error("fleet: node_offline");
      return { messages: [], done: true };
    });
    hub = await startInProcessHub({ observation });
    const ws = await hub.socket("/api/feed", await hub.cookie());
    const f = olderFrames(ws);
    ws.send(JSON.stringify({ t: "older", worker: id("%1"), before: "boom" }));
    ws.send(JSON.stringify({ t: "older", worker: id("%1"), before: "m1" }));
    expect(await f.count(2)).toEqual([
      { t: "older", worker: id("%1"), before: "boom", messages: [], done: false, missing: true },
      { t: "older", worker: id("%1"), before: "m1", messages: [], done: true },
    ]);
  });
  it("one connection's pages run one at a time, in the order asked", async () => {
    const { observation, id } = await observed(mode);
    const log: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    vi.spyOn(observation, "older").mockImplementation(async (_w, before): Promise<OlderResult> => {
      log.push(`start ${before}`);
      if (before === "slow") await gate;
      log.push(`end ${before}`);
      return { messages: [], done: false };
    });
    hub = await startInProcessHub({ observation });
    const ws = await hub.socket("/api/feed", await hub.cookie());
    const f = olderFrames(ws);
    ws.send(JSON.stringify({ t: "older", worker: id("%1"), before: "slow" }));
    ws.send(JSON.stringify({ t: "older", worker: id("%1"), before: "fast" }));
    await new Promise(r => setTimeout(r, 100));
    expect(log).toEqual(["start slow"]);                                // the second waits for the first
    release();
    expect((await f.count(2)).map(m => m.before)).toEqual(["slow", "fast"]);
    expect(log).toEqual(["start slow", "end slow", "start fast", "end fast"]);
  });
  it("a real page, read from the worker's own transcript through the ports", async () => {
    const { observation, id } = await observed(mode);
    await observation.poll();
    hub = await startInProcessHub({ observation });
    const ws = await hub.socket("/api/feed", await hub.cookie());
    const f = olderFrames(ws);
    ws.send(JSON.stringify({ t: "older", worker: id("%1"), before: "r120:0" }));
    const page = (await f.count(1))[0] ?? {};
    expect((page.messages as { text: string }[]).map(m => m.text)).toEqual(Array.from({ length: 100 }, (_, i) => `reply ${20 + i}`));
    expect(page.done).toBe(false);
  });
});

describe.runIf(HUB_MODES.includes("fleet"))("an older page while the worker's node can't answer (fleet hub)", () => {
  it("is missing, so the app offers Try again; the follow keeps its place; the page comes once the node answers", async () => {
    const { observation, id } = await observed("fleet");
    await observation.poll();
    const held = observation.history(id("%1")).length;
    hub = await startInProcessHub({ observation });
    const ws = await hub.socket("/api/feed", await hub.cookie());
    const f = olderFrames(ws);
    await ports?.rig?.fleet.setStatus("test", "offline");
    ws.send(JSON.stringify({ t: "older", worker: id("%1"), before: "r120:0" }));
    expect(await f.count(1)).toEqual([{ t: "older", worker: id("%1"), before: "r120:0", messages: [], done: false, missing: true }]);
    expect(observation.history(id("%1"))).toHaveLength(held);           // nothing of the follow was dropped
    await ports?.rig?.fleet.setStatus("test", "online");
    ws.send(JSON.stringify({ t: "older", worker: id("%1"), before: "r120:0" }));
    expect((await f.count(2))[1]?.messages).toHaveLength(100);
  });
});
```

- [ ] **Step 15.7: Run them and see them fail**

Run: `npx vitest run apps/hub/test/escalation-menu-ids.test.ts apps/hub/test/fleet-two-nodes.test.ts apps/hub/test/http-older.test.ts`
Expected: FAIL.
- **`escalation-menu-ids`, 2 failed:**
  - "two asks with two ids": `AssertionError: expected [ 'menu-box.bbbbbbbb.1', …(1) ] to deeply equal [ 'menu-box_bbbbbbbb_1', …(1) ]`;
  - "never attaches": `AssertionError: expected [ [ 'menu-pc.aaaaaaaa.1', null ] ] to deeply equal [ [ 'menu-pc_aaaaaaaa_1', null ] ]`.

  The legacy test passes: `%4` was already `menu-4`.
- **`fleet-two-nodes`, 4 failed:**
  - "steers each node": `AssertionError: expected 404 to be 200`, since the send route only matches `%\d+`;
  - "route matching": `AssertionError: expected 404 to be 200` for the encoded id (and with that fixed alone, `/api/workers/%/send` would answer 500: a `URIError` from `decodeURIComponent` over the whole path);
  - "a page path that doesn't decode is never a 500": `AssertionError: expected [ '/%', 500, …(1) ] to deeply equal [ '/%', 200, …(1) ]` (`staticFile` decodes the whole path too);
  - "menus": `AssertionError: expected [ 'menu-box.bbbbbbbb.1', …(1) ] to deeply equal [ 'menu-box_bbbbbbbb_1', …(1) ]`.

  The snapshot, watch, legacy `%251` and terminal tests pass: Step 15.3 fixed the protocol, and the terminal route never matched ids.
- **`http-older`:** passes already, 7 tests: Step 15.3 let the feed take worker ids, which is all its fleet mode needed; it is converted here because before that its fleet mode couldn't run.

- [ ] **Step 15.8: Implement worker ids in the hub's routes and menu ids**

In `apps/hub/src/adapters/http.ts`:

1. **Imports** (`:25-28`). Add `isWorkerOrLegacyId` to the `@morndo/protocol` import:
   ```ts
   import {
     AnswerBody, ClientFeedFrames, ClientTerminalFrames, IdentityProveBody, LinkDecisionBody, PairCheckBody, PairOptionsBody, PasskeyVerifyBody, PolicyBody, PushSubscriptionBody, SendBody,
     decode, isWorkerOrLegacyId, parseBody, type FrameOf, type Output, type Schema,
   } from "@morndo/protocol";
   ```
2. **`decodeSegment` and `workerIdFromSegment`.** Add them right before `export function startHttp(` (`:119`):
   ```ts
   // One URL path segment, percent-decoded once (the URL's pathname keeps the escapes it came with), or null: a malformed
   // escape (decodeURIComponent throws a URIError) or a segment that decodes to "/" or "\0", which would be another path
   // once joined. A path is split into its segments first and never decoded whole: decoding it whole turned a stray "%"
   // into a URIError, a 500 (GET /%, and every signed-in request that got as far as the send route, /api/workers/%/send
   // among them), and an escaped "/" into a separator.
   function decodeSegment(segment: string): string | null {
     let s: string;
     try { s = decodeURIComponent(segment); } catch { return null; }
     return s.includes("/") || s.includes("\0") ? null : s;
   }

   // A worker id from one URL path segment (the app sends encodeURIComponent(id), so "%1" travels as "%251"): the fleet's
   // `<node>.<server>.<pane>` or a legacy `%N` (packages/protocol worker-id.ts), else null.
   export function workerIdFromSegment(segment: string): string | null {
     const id = decodeSegment(segment);
     return id !== null && isWorkerOrLegacyId(id) ? id : null;
   }
   ```
3. **The send route** (`:302-306`). Replace:
   ```ts
       const send = /^\/api\/workers\/(%\d+)\/send$/.exec(decodeURIComponent(path));
       if (send && method === "POST") {
         limited(buckets.commands.take(a.endpoint.id));
         const body = await readBody(req, SendBody);
         const r = await steering.send(a, send[1] ?? "", body.text, body.requestId, body.uploads ?? [], body.seen, body.name);
   ```
   with:
   ```ts
       // Sending into a worker, named by its worker id or a legacy pane id (one segment, percent-decoded once). Any other
       // segment is no route; a %N a fleet hub doesn't hold reaches steering and is no pane, as an older app's outbox
       // expects (ADR-0012).
       const send = /^\/api\/workers\/([^/]+)\/send$/.exec(path);
       const sendTo = send ? workerIdFromSegment(send[1] ?? "") : null;
       if (send && sendTo === null) throw new HttpError(404, "no such route");
       if (sendTo !== null && method === "POST") {
         limited(buckets.commands.take(a.endpoint.id));
         const body = await readBody(req, SendBody);
         const r = await steering.send(a, sendTo, body.text, body.requestId, body.uploads ?? [], body.seen, body.name);
   ```
   The three lines after it (the `r.ok`, `duplicate` and status answers) stay as they are.
4. **The static files** (`staticFile`, `:354-355`). Replace
   ```ts
       const candidate = normalize(join(root, decodeURIComponent(path)));
       const inside = candidate === root || candidate.startsWith(root + sep);
   ```
   with
   ```ts
       // Each segment decoded on its own (decodeSegment); a path with one that doesn't decode is no file, and the app shell
       // answers it, as any path the app doesn't know.
       const segments = path.split("/").map(decodeSegment);
       const candidate = segments.every((s): s is string => s !== null) ? normalize(join(root, ...segments)) : null;
       const inside = candidate !== null && (candidate === root || candidate.startsWith(root + sep));
   ```

In `apps/hub/src/application/escalation-service.ts` (as Task 14 left it):

1. **Imports** (after the `@morndo/domain` import, `:10`):
   ```ts
   import { menuEscalationId } from "@morndo/protocol";
   ```
2. **`:226`.** Replace `const id = \`menu-${w.id.replace(/^%/, "")}\`;` with:
   ```ts
           const id = menuEscalationId(w.id);                     // "menu-pc_3fa2c1d0_12"; a legacy "%4" stays "menu-4" (spec §4)
   ```
3. **`:238`.** Replace ``this.#menus.delete(`menu-${w.id.replace(/^%/, "")}`);`` with:
   ```ts
           this.#menus.delete(menuEscalationId(w.id));
   ```

- [ ] **Step 15.9: Run them and see them pass, with the legacy route tests**

Run: `npx vitest run apps/hub/test/escalation-menu-ids.test.ts apps/hub/test/fleet-two-nodes.test.ts apps/hub/test/http-older.test.ts apps/hub/test/http.test.ts apps/hub/test/http-protocol.test.ts apps/hub/test/escalation-service.test.ts`
Expected: PASS, every test.
- 6 files, 62 tests. `escalation-menu-ids`: 3 tests. `fleet-two-nodes`: 8 tests. `http-older`: 7 (three per mode, and the fleet hub's page while its node is offline).
- `http.test.ts` and `http-protocol.test.ts` still post to `/api/workers/%251/send` and get their old answers, so the legacy `%N` route is unchanged.
- `escalation-service.test.ts` still finds `menu-4`.

- [ ] **Step 15.10: Commit**

```bash
git add apps/hub/src/adapters/http.ts apps/hub/src/application/escalation-service.ts apps/hub/test/escalation-menu-ids.test.ts apps/hub/test/fleet-two-nodes.test.ts apps/hub/test/http-older.test.ts
git commit -m "feat(hub): worker ids in the send route and menu escalation ids"
```

- [ ] **Step 15.11: Write the failing web tests (an older app's outbox; a fleet hub's ids in the browser)**

Create `apps/web/test/outbox-legacy-id.test.ts`:

```ts
// An outbox an older app left in this browser (ADR-0008 phase C) may hold Commands for legacy pane ids ("%3"). A fleet
// hub has no such worker, but its send route still matches (worker-id.ts takes both forms) and it answers 404 "no_pane":
// the entry ends Not sent, said in words, and nothing throws. Entries for worker ids go as usual. A node the hub can't
// reach is said in words too. The real Outbox and post(); a memory store seeded as IndexedDB would hand the records
// back; fetch answers as a fleet hub does.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Outbox } from "../src/lib/outbox/outbox.ts";
import { post } from "../src/lib/outbox/device.ts";
import { memoryStore } from "../src/lib/outbox/store.ts";
import type { OutboxRecord } from "../src/lib/outbox/state.ts";
import { sendReason } from "../src/lib/outbox/words.ts";

const T0 = Date.UTC(2026, 9, 6, 12);
const record = (id: string, worker: string, workerName: string): OutboxRecord => ({
  id, worker, workerName, text: `to ${workerName}`, uploads: [], createdAt: T0 - 1000, budgetFrom: T0 - 1000,
  state: "queued", error: null, attempts: 0, seen: "none", sentAt: null, typedAt: null,
});
let requests: string[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  requests = [];
  vi.stubGlobal("fetch", async (input: string) => {
    const worker = decodeURIComponent(/^\/api\/workers\/([^/]+)\/send$/.exec(input)?.[1] ?? "");
    requests.push(worker);
    const [status, body] = /^%\d+$/.test(worker) ? [404, { error: "no_pane" }] : [200, { ok: true, at: T0 }];
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("an outbox an older app left, against a fleet hub", () => {
  it("a legacy %N entry ends Not sent as no_pane, in words; a worker id entry goes", async () => {
    const store = memoryStore();
    await store.put(record("00000000-0000-4000-8000-000000000001", "%3", "alpha"));
    await store.put(record("00000000-0000-4000-8000-000000000002", "pc.3fa2c1d0.12", "beta"));
    const o = new Outbox({
      store, post, connected: () => true, onChange: () => {},
      timers: { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>) },
    });
    await o.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(requests.sort()).toEqual(["%3", "pc.3fa2c1d0.12"]);
    const legacy = o.records.find(r => r.worker === "%3");
    expect(legacy).toMatchObject({ state: "failed", error: "no_pane" });
    expect(legacy ? sendReason(legacy, "alpha") : null).toBe("alpha is no longer running.");
    expect(o.records.find(r => r.worker === "pc.3fa2c1d0.12")).toMatchObject({ state: "sent", typedAt: T0 });
  });

  it("a node the hub can't reach is said in words (Task 5's wording), never as its code", () => {
    const r: OutboxRecord = { ...record("00000000-0000-4000-8000-000000000003", "pc.3fa2c1d0.12", "beta"), state: "failed", error: "node_offline" };
    expect(sendReason(r, "beta")).toBe("beta is on a machine that isn't answering right now, so nothing was typed. Try again once it's back.");
  });
});
```

Create `apps/web/test/outbox-legacy-web.test.ts`:

```ts
// The app against a fleet hub (spec §4; ADR-0012), in headless Chromium with its real IndexedDB:
// - workers are named `<node>.<server>.<pane>`;
// - an outbox an older app left may still hold a Command for a legacy `%N`. That entry fails as no_pane (the fleet hub
//   has no such worker), with no error on the page;
// - a conversation with a new id works end to end: its frames decode, and a message is posted to its id and ended by its
//   echo.
// The real Desktop client, a fake feed (harness.ts), and a fake send endpoint that answers as a fleet hub does.
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fakeFeed, startWeb, type FeedWin, type Web } from "./harness.ts";

const PC = "pc.3fa2c1d0.1";
type FleetWin = FeedWin & { __sends: string[] };
type Row = { worker: string; state: string; error: string | null };

// Runs in the page before the app: POST /api/workers/<id>/send as a fleet hub answers it.
function fleetHub() {
  const w = globalThis as unknown as FleetWin & { fetch: typeof fetch };
  w.__sends = [];
  const inner = w.fetch.bind(w);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  w.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    const m = /^\/api\/workers\/([^/]+)\/send$/.exec(url);
    if (!m) return inner(input, init);
    const worker = decodeURIComponent(m[1] ?? "");
    w.__sends.push(worker);
    if (/^%\d+$/.test(worker)) return json({ error: "no_pane" }, 404);
    const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { requestId: string; text: string };
    w.__feedPush({ t: "messages", worker, messages: [{ id: `echo-${body.requestId}`, at: Date.now(), author: { kind: "principal", name: "You" }, kind: "text", text: body.text }] });
    return json({ ok: true, at: Date.now() });
  };
}

// Runs in the page: one record put into the outbox's IndexedDB store, as an older app left it.
async function seed(r: Record<string, unknown>) {
  const idb = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = idb.open("morndo", 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains("outbox")) req.result.createObjectStore("outbox", { keyPath: "id" }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("open failed"));
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("outbox", "readwrite");
    tx.objectStore("outbox").put(r);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("write failed"));
  });
  db.close();
}
// Runs in the page: every record in the outbox's store.
async function rows(): Promise<Row[]> {
  const idb = (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = idb.open("morndo", 1);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("open failed"));
  });
  const all = await new Promise<unknown[]>((resolve, reject) => {
    const req = db.transaction("outbox", "readonly").objectStore("outbox").getAll();
    req.onsuccess = () => resolve(req.result as unknown[]);
    req.onerror = () => reject(req.error ?? new Error("read failed"));
  });
  db.close();
  return all as Row[];
}

let web: Web;
let tab: Page;
let errors: string[];
beforeAll(async () => { web = await startWeb(); }, 60_000);
afterAll(async () => { await web?.close(); });
beforeEach(async () => {
  const context = await web.browser.newContext();                     // a fresh IndexedDB per test
  tab = await context.newPage();
  errors = [];
  tab.on("pageerror", e => errors.push(e.message));
  await tab.addInitScript(fakeFeed, { workers: [{ id: "pc.3fa2c1d0.0", name: "manager" }, { id: PC, name: "alpha" }] });
  await tab.addInitScript(fleetHub);
}, 60_000);
afterEach(async () => { await tab.context().close(); });

describe("the app against a fleet hub", () => {
  it("an older app's %N entry fails as no_pane; a worker id conversation sends and is echoed; no page errors", { timeout: 30_000 }, async () => {
    await tab.goto(web.url);
    await tab.locator("button.row", { hasText: "alpha" }).first().waitFor();
    const now = await tab.evaluate(() => Date.now());
    await tab.evaluate(seed, {
      id: "00000000-0000-4000-8000-0000000000aa", worker: "%1", workerName: "alpha", text: "from an older app", uploads: [],
      createdAt: now, budgetFrom: now, state: "queued", error: null, attempts: 0, seen: "none", sentAt: null, hubAt: null,
    });
    await tab.reload();                                                 // the outbox resumes what IndexedDB holds
    await tab.waitForFunction(() => (globalThis as unknown as FleetWin).__sends.includes("%1"));
    await expect.poll(async () => (await tab.evaluate(rows)).find(r => r.worker === "%1"), { timeout: 10_000 }).toMatchObject({ state: "failed", error: "no_pane" });
    await tab.locator("button.row", { hasText: "alpha" }).first().click();
    await tab.getByRole("heading", { level: 1, name: "alpha", exact: true }).waitFor();
    const box = tab.getByRole("textbox", { name: "Message alpha" });
    await box.fill("hello from the fleet");
    await box.press("Enter");
    await tab.locator("article.msg:not(.pending)", { hasText: "hello from the fleet" }).waitFor({ timeout: 10_000 });
    expect(await tab.evaluate(() => (globalThis as unknown as FleetWin).__sends)).toEqual(["%1", PC]);
    expect(errors).toEqual([]);
  });
});
```

- [ ] **Step 15.12: Run them and see them fail**

Before this task's protocol change the Chromium test failed on the echo. Step 15.3 has landed, so it may already pass. To see it fail (red) and show what the test catches, temporarily revert `packages/protocol/src/feed.ts` to the old pattern for one run:
```bash
before=$(git log -1 --format=%H --grep='feat(protocol): fleet worker ids in feed frames')
git show "$before^:packages/protocol/src/feed.ts" > packages/protocol/src/feed.ts
npx vitest run apps/web/test/outbox-legacy-id.test.ts apps/web/test/outbox-legacy-web.test.ts
git checkout HEAD -- packages/protocol/src/feed.ts
```
Expected: FAIL, 1 of 3 tests:
- `outbox-legacy-web`: `TimeoutError: locator.waitFor: Timeout 10000ms exceeded` on the echo, because with the old pattern the app drops every `messages` frame for `pc.3fa2c1d0.1` as malformed.

Both `outbox-legacy-id` tests pass in both states: the `%3` test guards what already works, and Task 5 already gave `node_offline` its words.

After the `git checkout`, `git diff --stat packages/protocol/src/feed.ts` is empty. The Step 15.3 version is restored.

- [ ] **Step 15.13: Confirm the web wording and the gallery's node**

Nothing to write here. `apps/web/src/lib/outbox/words.ts` has `node_offline` (and `too_large`) in `PROBLEMS` since Task 5; adding the key again would be a duplicate key, a type error. `apps/web/src/lib/gallery/data.ts` already carries `node: MARK` from Step 15.3. Nothing else in `apps/web/src` parses a worker id:
- `outbox/device.ts:13`, `TerminalView.svelte:43` and `Agents.svelte:31` all pass it through `encodeURIComponent`;
- the drafts are keyed by the id as given.

- [ ] **Step 15.14: Run them and see them pass**

Run: `npx vitest run apps/web/test/outbox-legacy-id.test.ts apps/web/test/outbox-legacy-web.test.ts apps/web/test/outbox.test.ts apps/web/test/outbox-words.test.ts apps/web/test/outbox-web.test.ts apps/web/test/feed-frames.test.ts`
Expected: PASS, every test (6 files). `outbox-legacy-id` runs 2 tests and `outbox-legacy-web` runs 1. The existing outbox and feed-frame suites, which still use `%N` workers, are unchanged.

- [ ] **Step 15.15: Run every suite, the type check, the linter and the web check**

Run each on its own:
```bash
npx vitest run apps/hub packages apps/web
MORNDO_HUB_MODES=fleet npx vitest run apps/hub packages apps/web
MORNDO_HUB_MODES=fleet npx vitest run apps/hub/test/steering-durable.test.ts apps/hub/test/observation-waiting-on.test.ts apps/hub/test/remote-service.test.ts apps/hub/test/observation-nodes.test.ts apps/hub/test/observation-attachments.test.ts apps/hub/test/steering-keys.test.ts apps/hub/test/escalation-answer-keys.test.ts apps/hub/test/steering-inflight-duplicate.test.ts apps/hub/test/steering-throw-retry.test.ts apps/hub/test/http-older.test.ts
npm run check
npm run lint
```
Expected:
- **First vitest run:** every file PASSES but `packages/node-ops/test/pane-lock.test.ts` on macOS (no `flock(1)`; 2 tests, as before): 147 files, 1155 tests, 2 failed. The run includes the five files this task created, and the ten both-mode suites in both modes. No test is skipped.
- **Second (fleet only):** the same files, with the ten suites once: 1113 tests, the same 2 failed.
- **Third (the ten suites, fleet only):** PASS, 10 files, 44 tests.
- **`npm run check`:** exits 0. It covers `tsc` for domain, protocol, node-ops, hub, the tests and web (`npm run check -w @morndo/web`, which type-checks the Svelte components that read `RosterEntry`).
- **`npm run lint`:** reports nothing after its command line.

- [ ] **Step 15.16: Commit**

```bash
git add apps/web/test/outbox-legacy-id.test.ts apps/web/test/outbox-legacy-web.test.ts
git commit -m "test(web): fleet worker ids, and legacy outbox entries failing as no_pane"
```

---

## Gaps and notes for the integrator

The offline marker on the roster and the app's way to resolve an uncertain send ("Check again") are Task 15b's ("web: offline marker and 'Check again' for uncertain sends"). What is left:

- **Round 2 (2026-10-06).** The fake fleet now models the real lane registry (one row per name, the first claimant its owner, `conflict` while two windows claim it, `workerId: null` when both are on the owner) and routes `{ lane }` with `lane_conflict`; each node has a store that every answer carries (`resetStore()` stands for a lost agent database); and it hashes a key's effect only (`pane.send`: `workerId` and `text`; never `expect`), a different hash being `uncertain`, as the agent does (Task 8, round 2 item 6). It records each request's `x-morndo-client`.
- **Old `menu-N` decision rows are never pruned.** `retention.ts:2-4` calls decisions provenance and keeps them. `Store.decisions()` (`store.ts:69`) only loads the last 7 days. Spec §4 now says so (corrected during the reconciliation; spec §15).
- **Failed outbox records are never dropped.** Only Sent ones go, after a day (`outbox.ts:68`). A legacy `%N` entry therefore stays in IndexedDB until Discard. If its worker is not in the roster, no channel shows it.
- **The fake fleet is the hub side's reference for Tasks 8 and 12.** `apps/hub/test/helpers/fake-fleet.ts` speaks plan.md's "Client API" table (file refusals with their statuses, `GET /v1/alerts`, the `alert` event) and keeps keys as "Behaviour the agent and the fleet agree on" says (`op.status` answers a done key with the op's stored result, for `pane.send` `{ problem, typedAt }`). It models the lane registry and `lane_conflict` routing as Task 12 does (round 2). Tasks 17 and 18 can reuse it.
