## Lane notes (hub-async)

**How this part was checked.** Tasks 4 and 5 were applied, from this text, onto a copy of the executed and reconciled Tasks 1–3 (the real `followTranscript`, `olderPage`, `TranscriptCursor` and `@morndo/node-ops`, not stand-ins), Node 24.21.0, macOS. A script took every created file and every replacement from this document's code blocks and stopped on any old text that wasn't in its file exactly once; afterwards, every code block here was found in the tree, or is old text that a later step replaces. Each part was committed as its step says.

**What passed** (`npx vitest run apps/hub packages apps/web`, which includes the Chromium tests; Playwright 1.63 with its headless Chromium). Round 2 (2026-10-06) replayed both tasks from this text on Tasks 1–3 as round 2 left them (`wave0-r2`, with the follow that keeps its cursor when its source throws):
- Tasks 1–3 as left: 127 files, 1006 tests. After Task 4: 131 and 1021. After Task 5: 133 and 1031 (part A), 135 and 1041 (B), 135 and 1043 (C).
- The only failures, before and after: `packages/node-ops/test/pane-lock.test.ts`, 2 tests (macOS has no `flock(1)`; Linux CI has it).
- `npm run check` exited 0 and `npm run lint` reported nothing after each part.
- Every "see it fail" step was run before its implementation, with the messages written below; so was every negative control (Task 4 Step 15, Task 5 Step 7 (A), both of them).

**Round 2** (items 3, 15, 18 of the second review): `answerKey` names the ask (its message, or its time), so a question asked again is a new answer (Task 5); a `TranscriptSource` that can't answer now throws `SourceUnavailable` and the follow keeps its place, null still meaning gone (Task 4, with a new test and control); the ports carry from Task 4 on the shapes Task 14 gives a meaning (`store`, `conflict`, `SendInDoubt`, `unknown` with its store); no step chains `vitest && check && lint` any more. Every changed "see it fail" step and every control was run again; the messages below are those runs'.

**Decided while reconciling** (plan.md's Contracts hold the shapes): the ports have their final form from Task 4 on (`offline` on listed workers, `"node_offline"` in `SendOutcome`, `SendStatus` answering an object); a node that isn't online is in `BEFORE_PASTE` from Task 5 on (with its own test and control); EscalationService's `send` still answers a problem, widened by `"node_offline"`. ObservationService passes `olderPage` no `from` hint: each older page costs one `locate`.

---

### Task 4: Hub async ports and per-node observation (legacy single-host mode)

**Files:**
- Create: `apps/hub/src/application/ports.ts`
- Create: `apps/hub/src/adapters/local-node.ts`
- Modify: `apps/hub/src/application/observation-service.ts` (whole file, 1-197)
- Modify: `apps/hub/src/adapters/http.ts:15`, `:427`, `:468-472`
- Modify: `apps/hub/src/main.ts:77-79`, plus one import after `:26`
- Modify: `apps/hub/src/adapters/claude-sessions.ts` (as Task 3 left it): delete Task 3's synchronous wrappers, from `// ---- until Task 4: the same steps over the local file, synchronously, for ObservationService` (`:441`) to the end of the file (`SyncBytes`, `runSync`, its `LOCATE_STEP`, `onFile`, `readTranscript`, `readOlder`); the `node:fs` import only they used (`:7`); the header sentence naming them (`:207-209`); and `path` from `TranscriptCursor` (`:257`), which only `readTranscript` read
- Test (create): `apps/hub/test/local-node.test.ts`, `apps/hub/test/observation-nodes.test.ts`, `apps/hub/test/http-older.test.ts`, `apps/hub/test/observation-unavailable.test.ts`
- Test (modify):
  - fakes: `apps/hub/test/inprocess-hub.ts:36-37,57,74`, `http.test.ts:44`, `http-crash-fixture.ts:114`, `desktop-control-idle.test.ts:159`, `access-idle-sweep.test.ts:103`, `access-policy-http.test.ts:67`, `remote-revoke.test.ts:200`;
  - observation: `observation-waiting-on.test.ts:7-10,22-24,56-61`, `observation-refollow.test.ts:7-10,31-34,38,119`, `observation-loop-errors.fixture.ts:4-6,10-12,27`, `escalation-window.test.ts:10,13,126-134`;
  - transcript readers: `protocol-contract.test.ts:9-11,23-27,33,42`, `claude-sessions.test.ts:7,115-170`, `claude-sessions-utf8-cursor.test.ts:1-8,14,58-92`, `claude-sessions-older.test.ts:1-9,36-114` (every `readOlder` call, Task 3's tests kept), `transcript-long-lines.test.ts:78,91,121` (the three cursor literals; Task 3's round-2 test of a source that fails mid-follow added the third).

  Line numbers are as Tasks 1–3 left the files (the reconciled `recon:` commit); each edit below quotes the exact text it replaces.

**Interfaces:**
- Consumes:
  - from Task 2: `@morndo/node-ops`
    - `tmuxAdapter(opts): Tmux`, where node-ops' `Tmux` is `{ listWorkers(): Promise<Worker[]>; capture(id): Promise<string | null>; send(id, text): Promise<SendProblem | null> }`;
    - `SendProblem`, `SessionInfo`;
    - `sessionRegistry(configDir): { byPane(): Map<string, SessionInfo>; transcriptPath(sessionId: string): string | null }`;
    - `menuOnScreen`, `menuIdentity`;
  - from Task 3: `localTranscriptBytes(path)`, and `followTranscript(src, cursor, agent, o?)`, `olderPage(src, agent, beforeId, o?)`, `TranscriptCursor`, `FileRef`, `Parsed` (plan.md, "The hub's transcript reader"). A new cursor is the literal `{ offset: 0, pending: new Set() }`.
- Produces:
  - `apps/hub/src/application/ports.ts`: `SendOutcome`, `Tmux`, `SendStatus`, `SendInDoubt`, `Sessions`, `TranscriptSource`, `SourceUnavailable`, `RemoteFiles`, `UploadSink`, `NodeState` and `NodeStates`, exactly as plan.md's Hub ports (`HubPorts` and the hub's `Terminal` are Task 14's). `listWorkers` items carry `offline` (always `false` here) and may carry `conflict`, `SendOutcome.problem` may be `"node_offline"` and it may carry the answering node's `store`, `SendStatus` answers an object (`unknown` with the store that answered), and a send whose node may have typed it throws `SendInDoubt`: their fleet meanings come with Task 14. A `TranscriptSource` that can't answer now throws `SourceUnavailable`; null still means the transcript is gone (round 2, item 15).
  - `apps/hub/src/adapters/local-node.ts`:
    ```ts
    export const LOCAL_NODE = "local";
    export function localTmux(tmux: PaneTmux): Tmux;      // PaneTmux = node-ops' Tmux (imported `type Tmux as PaneTmux`)
    export const localSessions: (registry: Pick<Registry, "byPane">) => Sessions;
    export function localTranscripts(registry: Pick<Registry, "transcriptPath">): TranscriptSource;
    ```
  - `ObservationService`:
    ```ts
    constructor(tmux: Pick<Tmux, "listWorkers" | "captureMany">, quietAfterMs: number, now?: () => number, o?: ObservationSources);
    export type ObservationSources = { sessions?: Sessions | null; transcripts?: TranscriptSource | null; files?: Pick<Files, "register"> | null; nodeStates?: NodeStates | null; nodeWaitMs?: number };
    older(id: string, before: string): Promise<OlderResult>;   // OlderResult = { messages: Message[]; done: boolean; missing?: true }
    ```
  - the test helper `startInProcessHub({ observation?: ObservationService })`.

- [ ] **Step 1: Write the failing test for the local adapters**

Create `apps/hub/test/local-node.test.ts`:

```ts
// This machine as the hub's one node, "local" (fleet core §3.1, legacy mode): the ports over node-ops' tmux adapter,
// the session registry and transcript files. A fake pane adapter and a temp Claude config dir; no real tmux.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workerId } from "@morndo/domain";
import { localTranscriptBytes, sessionRegistry, type SendProblem, type Tmux as PaneTmux } from "@morndo/node-ops";
import { LOCAL_NODE, localSessions, localTmux, localTranscripts } from "../src/adapters/local-node.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-local-node-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function panes(problem: SendProblem | null = null) {
  const captured: string[] = [];
  const typed: { id: string; text: string; at: number }[] = [];
  const tmux: PaneTmux = {
    listWorkers: async () => [{ id: workerId("%1"), name: "builder", location: "w" }, { id: workerId("%2"), name: "fix: a/b ü.2", location: "x" }],
    capture: async id => { captured.push(id); return id === "%9" ? null : `screen of ${id}`; },
    send: async (id, text) => { typed.push({ id, text, at: Date.now() }); await new Promise(r => setTimeout(r, 30)); return problem; },
  };
  return { tmux, captured, typed };
}

describe("localTmux", () => {
  it("lists every worker on the node \"local\", names untouched, never offline", async () => {
    expect(await localTmux(panes().tmux).listWorkers()).toEqual([
      { id: "%1", name: "builder", location: "w", node: LOCAL_NODE, offline: false },
      { id: "%2", name: "fix: a/b ü.2", location: "x", node: LOCAL_NODE, offline: false },
    ]);
  });
  it("captures many panes in one call: each once, a gone pane as null", async () => {
    const p = panes();
    const got = await localTmux(p.tmux).captureMany(["%1", "%9", "%2"]);
    expect([...got]).toEqual([["%1", "screen of %1"], ["%9", null], ["%2", "screen of %2"]]);
    expect(p.captured).toEqual(["%1", "%9", "%2"]);
  });
  it("send answers the problem and the time the typing started, on this machine's clock", async () => {
    const p = panes();
    const before = Date.now();
    const r = await localTmux(p.tmux).send("%1", "ship it", "ep1:r1");
    expect(r.problem).toBeNull();
    expect(r.typedAt).toBeGreaterThanOrEqual(before);
    expect(r.typedAt).toBeLessThanOrEqual(p.typed[0]?.at ?? 0);             // taken before the paste, not after the check
    expect(p.typed.map(t => [t.id, t.text])).toEqual([["%1", "ship it"]]);
    expect((await localTmux(panes("menu_open").tmux).send("%1", "y", "ep1:r2")).problem).toBe("menu_open");
  });
});

describe("localSessions and localTranscripts", () => {
  beforeEach(() => {
    mkdirSync(join(dir, "sessions"));
    mkdirSync(join(dir, "projects", "-w"), { recursive: true });
    writeFileSync(join(dir, "sessions", "1.json"), JSON.stringify({ pid: process.pid, sessionId: "s1", tmux: "qa:@0.%1", name: "builder", cwd: "/w", version: "2.1.286", updatedAt: 1 }));
    writeFileSync(join(dir, "projects", "-w", "s1.jsonl"), '{"type":"user","uuid":"u1"}\n{"type":"assistant","uuid":"a1"}\n');
  });
  it("byPane: the registry's live sessions by pane, asynchronously", async () => {
    const byPane = await localSessions(sessionRegistry(dir)).byPane();
    expect([...byPane.keys()]).toEqual(["%1"]);
    expect(byPane.get("%1")?.sessionId).toBe("s1");
  });
  it("a session's transcript bytes by its id: size, a read window, and locate, as node-ops reads that file", async () => {
    const t = localTranscripts(sessionRegistry(dir));
    const all = '{"type":"user","uuid":"u1"}\n{"type":"assistant","uuid":"a1"}\n';
    expect(await t.size("s1")).toBe(Buffer.byteLength(all));
    const r = await t.read("s1", 0, 10);
    expect(Buffer.from(r?.bytes ?? []).toString()).toBe(all.slice(0, 10));
    expect(r?.eof).toBe(false);
    const file = join(dir, "projects", "-w", "s1.jsonl");
    expect(await t.locate("s1", '"uuid":"a1"')).toBe(await localTranscriptBytes(file).locate('"uuid":"a1"'));
    expect(await t.locate("s1", '"uuid":"a1"')).not.toBeNull();
  });
  it("an unknown session answers null everywhere (negative control: the known one doesn't)", async () => {
    const t = localTranscripts(sessionRegistry(dir));
    expect([await t.size("nope"), await t.read("nope", 0, 10), await t.locate("nope", "u1")]).toEqual([null, null, null]);
    expect(await t.size("s1")).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run apps/hub/test/local-node.test.ts`
Expected: FAIL with `Error: Cannot find module '../src/adapters/local-node.ts' imported from …/apps/hub/test/local-node.test.ts`

- [ ] **Step 3: Write the ports and the local adapters**

Create `apps/hub/src/application/ports.ts`:

```ts
// The hub's ports onto the machines its workers run on (fleet core §3.1, ADR-0012). Each has a local implementation,
// this machine as the one node "local" (adapters/local-node.ts), and a fleet one (Task 14), chosen in main.ts by
// MORNDO_FLEET_SOCKET. Worker IDs are opaque here: "%N" locally, "<node>.<server>.<pane>" in a fleet.
import type { Upload } from "@morndo/domain";
import type { SendProblem, SessionInfo } from "@morndo/node-ops";

// `typedAt`: when the node typed it, on the node's own clock, which that node's transcript times are on (echo matching).
// "node_offline": the fleet refused it before anything was typed (fleet core §5.3, §7; never from this machine's tmux).
// `store` (fleet, Task 14): the store of the node that answered, the agent database its keys are kept in (fleet core §3.1).
export type SendOutcome = { problem: SendProblem | "node_offline" | null; typedAt: number; store?: string | null };
export type Tmux = {            // replaces the port of the same name; the adapters implement it
  // `offline`: its node is not online now; it stays listed with its last screen (fleet core §3.1, §7). Legacy: false.
  // `conflict` (fleet, Task 14): the lane registry has this name in conflict (two windows claim it); legacy never says.
  listWorkers(): Promise<{ id: string; name: string; location: string; node: string; offline: boolean; conflict?: boolean }[]>;
  capture(id: string): Promise<string | null>;
  captureMany(ids: string[]): Promise<Map<string, string | null>>;
  // `key`: the caller's idempotency key. A node that already typed it answers the stored outcome instead of typing again.
  send(id: string, text: string, key: string): Promise<SendOutcome>;
};
// What the worker's node knows of a key (op.status, Task 14): "done" with the node's own typedAt, or not (yet), or the
// node can't be asked. "unknown" names the store that answered: only the store that took the send can say it never
// started (a new or restored agent database has lost its keys, fleet core §3.1).
export type SendStatus = (id: string, key: string) =>
  Promise<{ state: "unknown"; store: string } | { state: "started" | "offline" } | { state: "done"; typedAt: number }>;
// A send whose node may have typed it (executed "maybe": the connection dropped, or the fleet took it and never
// answered). `store`: the store it went to, null when no answer came; the caller keeps it with its row in doubt (Task 14).
export class SendInDoubt extends Error {
  readonly store: string | null;
  constructor(store: string | null, message: string, options?: ErrorOptions) { super(message, options); this.name = "SendInDoubt"; this.store = store; }
}
export type Sessions = { byPane(): Promise<Map<string, SessionInfo>> };   // pane = worker ID
export type TranscriptSource = {
  size(sessionId: string): Promise<number | null>;
  read(sessionId: string, offset: number, max: number): Promise<{ bytes: Uint8Array; eof: boolean } | null>;
  locate(sessionId: string, needle: string): Promise<number | null>;
};
// A transcript source that can't answer now (its node offline, the fleet down or slow: Task 14's fleet source) throws
// this; null from size or read means the transcript is gone. Observation keeps a follow's place through it and reads on
// from there on the next poll; it starts a follow over only on null (fleet core §3.1).
export class SourceUnavailable extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "SourceUnavailable"; }
}
export type RemoteFiles = { register(workerId: string, path: string): Promise<{ id: string | null; size: number | null }> };
export type UploadSink = { stage(upload: Upload, workerId: string): Promise<{ ok: true; path: string } | { ok: false; problem: "no_pane" | "too_large" | "node_offline" }> };
// Which nodes answer now (fleet core §3.1: a node that is not online is skipped at once). A node missing from the map is
// not online. Unset (legacy single-host mode), every node counts as online.
export type NodeState = "online" | "stale" | "offline";
export type NodeStates = () => Promise<ReadonlyMap<string, NodeState>>;
```

Create `apps/hub/src/adapters/local-node.ts`:

```ts
// This machine as the hub's one node, "local" (fleet core §3.1, §10): the ports of application/ports.ts over node-ops'
// tmux adapter, Claude Code's session registry and its transcript files. The hub runs on these while MORNDO_FLEET_SOCKET
// is unset; they go with the legacy mode after the cutover (sub-project 4).
import { localTranscriptBytes, type SessionInfo, type Tmux as PaneTmux } from "@morndo/node-ops";
import type { Sessions, Tmux, TranscriptSource } from "../application/ports.ts";

export const LOCAL_NODE = "local";

// Typing has no key store here: the hub's own `sends` table keeps a request from being typed twice (steering-service.ts).
// `typedAt` is taken as the typing starts, on this machine's clock, which its transcripts' times are on.
export function localTmux(tmux: PaneTmux): Tmux {
  return {
    async listWorkers() {
      return (await tmux.listWorkers()).map(w => ({ id: w.id as string, name: w.name, location: w.location, node: LOCAL_NODE, offline: false }));
    },
    capture: id => tmux.capture(id),
    async captureMany(ids) {
      const out = new Map<string, string | null>();
      for (const id of ids) out.set(id, await tmux.capture(id));
      return out;
    },
    async send(id, text) {
      const typedAt = Date.now();
      return { problem: await tmux.send(id, text), typedAt };
    },
  };
}

type Registry = { byPane(): Map<string, SessionInfo>; transcriptPath(sessionId: string): string | null };

export const localSessions = (registry: Pick<Registry, "byPane">): Sessions => ({ byPane: async () => registry.byPane() });

// A session's transcript by its id: the registry finds the file, node-ops reads its bytes. An unknown session, or a
// file that went away, answers null.
export function localTranscripts(registry: Pick<Registry, "transcriptPath">): TranscriptSource {
  const bytes = (sessionId: string) => {
    const path = registry.transcriptPath(sessionId);
    return path === null ? null : localTranscriptBytes(path);
  };
  return {
    size: async sessionId => (await bytes(sessionId)?.size()) ?? null,
    read: async (sessionId, offset, max) => (await bytes(sessionId)?.read(offset, max)) ?? null,
    locate: async (sessionId, needle) => (await bytes(sessionId)?.locate(needle)) ?? null,
  };
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `npx vitest run apps/hub/test/local-node.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Write the failing tests for per-node polling and the async older page**

Create `apps/hub/test/observation-nodes.test.ts`. Its first test is the spec §9 "Isolation" test: a node whose `captureMany` never resolves does not delay another node's screens beyond one poll interval.

```ts
// Polling per node, in parallel (fleet core §3.1, §9 "Isolation"): one captureMany per node and poll, a node that never
// answers doesn't hold up another's screens beyond one poll interval, and a node that isn't online is skipped at once.
// Fake nodes; no tmux, no transcripts.
import { afterEach, describe, expect, it } from "vitest";
import type { FeedEvent } from "@morndo/domain";
import { ObservationService, type Listener } from "../src/application/observation-service.ts";
import type { NodeState, Tmux } from "../src/application/ports.ts";

const SLOW = "a.00000001.1";
const FAST = "b.00000002.1";
const workers = [
  { id: SLOW, name: "slow-lane", location: "x", node: "a", offline: false },
  { id: FAST, name: "fast-lane", location: "y", node: "b", offline: false },
];
const until = async (ok: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise(r => setTimeout(r, 5));
  return ok();
};

// Node "a" never answers a captureMany; node "b" answers at once with its current screen.
function fleet() {
  let fastScreen = "b: first";
  const calls: { node: string; ids: string[] }[] = [];
  const tmux: Pick<Tmux, "listWorkers" | "captureMany"> = {
    listWorkers: async () => workers,
    captureMany: async ids => {
      const node = ids[0]?.split(".")[0] ?? "";
      calls.push({ node, ids });
      if (node === "a") return new Promise<Map<string, string | null>>(() => {});
      return new Map(ids.map(id => [id, fastScreen]));
    },
  };
  return { tmux, calls, show: (s: string) => { fastScreen = s; } };
}
const watcher = (watching: string, seen: { text: string; at: number }[], events: FeedEvent[] = []): Listener => ({
  events: e => { events.push(...e); },
  screen: (w, text) => { if (w === watching) seen.push({ text, at: Date.now() }); },
  messages: () => {}, history: () => {}, watching: () => watching,
});

let svc: ObservationService | null = null;
afterEach(() => { svc?.stop(); svc = null; });

describe("a node that never answers", () => {
  it("doesn't hold up another node's screens beyond one poll interval, and gets no second captureMany meanwhile", async () => {
    const POLL = 300;
    const f = fleet();
    svc = new ObservationService(f.tmux, 60_000, Date.now, { nodeWaitMs: POLL });
    const seen: { text: string; at: number }[] = [];
    svc.subscribe(watcher(FAST, seen));
    svc.start(POLL);
    expect(await until(() => svc?.screen(FAST) === "b: first", 5 * POLL)).toBe(true);
    const changedAt = Date.now();
    f.show("b: second");
    expect(await until(() => seen.some(s => s.text === "b: second"), 10 * POLL)).toBe(true);
    const delay = (seen.find(s => s.text === "b: second")?.at ?? Infinity) - changedAt;
    expect(delay).toBeLessThanOrEqual(POLL + 150);                     // one poll interval, plus scheduling slack
    expect(f.calls.filter(c => c.node === "a")).toHaveLength(1);        // still waiting on the first: not asked again
    expect(f.calls.filter(c => c.node === "b").length).toBeGreaterThanOrEqual(2);
  });
  it("one poll returns after at most nodeWaitMs, with the answering node's screens applied", async () => {
    const f = fleet();
    svc = new ObservationService(f.tmux, 60_000, Date.now, { nodeWaitMs: 200 });
    const t0 = Date.now();
    await svc.poll();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(svc.screen(FAST)).toBe("b: first");
    expect(svc.screen(SLOW)).toBeUndefined();
  });
});

describe("node states", () => {
  it("a node that is not online gets no captureMany; one that is online does (negative control)", async () => {
    const f = fleet();
    let states = new Map<string, NodeState>([["a", "stale"], ["b", "online"]]);
    svc = new ObservationService(f.tmux, 60_000, Date.now, { nodeStates: async () => states, nodeWaitMs: 5_000 });
    const t0 = Date.now();
    await svc.poll();
    expect(Date.now() - t0).toBeLessThan(1000);                        // skipped at once: no wait for node "a"
    expect(f.calls.map(c => c.node)).toEqual(["b"]);
    states = new Map([["b", "offline"]]);                              // "a" is unknown now: not online either
    await svc.poll();
    expect(f.calls.map(c => c.node)).toEqual(["b"]);
    expect(svc.snapshot().workers.map(w => w.id)).toEqual([SLOW, FAST]);   // still listed; only their screens wait
  });
});

describe("one captureMany per node and poll", () => {
  it("each node is asked once, for its own workers only, and a late round is applied by the next poll", async () => {
    const calls: { node: string; ids: string[] }[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    const tmux: Pick<Tmux, "listWorkers" | "captureMany"> = {
      listWorkers: async () => [
        { id: "a.00000001.1", name: "a1", location: "", node: "a", offline: false }, { id: "b.00000002.3", name: "b3", location: "", node: "b", offline: false },
        { id: "a.00000001.2", name: "a2", location: "", node: "a", offline: false },
      ],
      captureMany: async ids => {
        const node = ids[0]?.split(".")[0] ?? "";
        calls.push({ node, ids });
        if (node === "a") await gate;
        return new Map(ids.map(id => [id, `screen ${id}`]));
      },
    };
    svc = new ObservationService(tmux, 60_000, Date.now, { nodeWaitMs: 50 });
    await svc.poll();
    expect(calls).toEqual([{ node: "a", ids: ["a.00000001.1", "a.00000001.2"] }, { node: "b", ids: ["b.00000002.3"] }]);
    expect(svc.screen("a.00000001.1")).toBeUndefined();                 // node "a" hadn't answered within 50 ms
    release();
    await new Promise(r => setTimeout(r, 10));
    await svc.poll();
    expect(svc.screen("a.00000001.1")).toBe("screen a.00000001.1");     // its round, applied by the next poll
    expect(svc.screen("a.00000001.2")).toBe("screen a.00000001.2");
  });
});
```

Give the in-process hub an `observation` option. In `apps/hub/test/inprocess-hub.ts`, replace:

```ts
// `now`: the hub's clock for access and rate limits (a test moves it to expire tokens, requests and verifications).
export async function startInProcessHub(o: { limits?: Limits; heartbeatMs?: number; now?: () => number } = {}): Promise<InProcessHub> {
```
with:
```ts
// `now`: the hub's clock for access and rate limits (a test moves it to expire tokens, requests and verifications).
// `observation`: the service the feed reads from, when a test needs its own (default: one over an empty tmux).
export async function startInProcessHub(o: { limits?: Limits; heartbeatMs?: number; now?: () => number; observation?: ObservationService } = {}): Promise<InProcessHub> {
```
Then replace
```ts
  const tmux = { listWorkers: async () => [], capture: async () => null, send: async () => null };
```
with
```ts
  const tmux = { listWorkers: async () => [], capture: async () => null, captureMany: async () => new Map<string, string | null>(), send: async () => null };
```
and replace
```ts
    config, identity: loadOrCreateIdentity(dir), access, observation: new ObservationService(tmux, 1000),
```
with
```ts
    config, identity: loadOrCreateIdentity(dir), access, observation: o.observation ?? new ObservationService(tmux, 1000),
```

Create `apps/hub/test/http-older.test.ts`:

```ts
// An older page over the feed (fleet core §3.1): older() is async now, and its transcript may be on another node. A
// page that fails is answered as missing, never an unhandled rejection (exitOnCrash would end the hub; vitest fails the
// run on one), and one connection's older pages run one at a time. Fake observation; no tmux.
import type { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObservationService, type OlderResult } from "../src/application/observation-service.ts";
import { startInProcessHub, type InProcessHub } from "./inprocess-hub.ts";
import { frameText } from "./http-crash-fixture.ts";

let hub: InProcessHub | null = null;
afterEach(async () => { await hub?.close(); hub = null; });

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

describe("older pages on the feed", () => {
  it("a page whose read fails is answered missing, and the feed goes on", async () => {
    const observation = new ObservationService({ listWorkers: async () => [], captureMany: async () => new Map() }, 1000);
    vi.spyOn(observation, "older").mockImplementation(async (_w, before) => {
      if (before === "boom") throw new Error("fleet: node_offline");
      return { messages: [], done: true };
    });
    hub = await startInProcessHub({ observation });
    const ws = await hub.socket("/api/feed", await hub.cookie());
    const f = olderFrames(ws);
    ws.send(JSON.stringify({ t: "older", worker: "%1", before: "boom" }));
    ws.send(JSON.stringify({ t: "older", worker: "%1", before: "m1" }));
    expect(await f.count(2)).toEqual([
      { t: "older", worker: "%1", before: "boom", messages: [], done: false, missing: true },
      { t: "older", worker: "%1", before: "m1", messages: [], done: true },
    ]);
  });
  it("one connection's pages run one at a time, in the order asked", async () => {
    const observation = new ObservationService({ listWorkers: async () => [], captureMany: async () => new Map() }, 1000);
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
    ws.send(JSON.stringify({ t: "older", worker: "%1", before: "slow" }));
    ws.send(JSON.stringify({ t: "older", worker: "%1", before: "fast" }));
    await new Promise(r => setTimeout(r, 100));
    expect(log).toEqual(["start slow"]);                                // the second waits for the first
    release();
    expect((await f.count(2)).map(m => m.before)).toEqual(["slow", "fast"]);
    expect(log).toEqual(["start slow", "end slow", "start fast", "end fast"]);
  });
});
```

Create `apps/hub/test/observation-unavailable.test.ts`. A transcript that can't be read now is not one that is gone (round 2, item 15): the follow keeps its place through `SourceUnavailable`, and only null starts it over. Its second test also needs Task 3's guarantee that a follow whose source throws leaves the cursor as it was.

```ts
// A transcript source that can't answer now (fleet core §3.1: the fleet's source throws SourceUnavailable while the node
// is offline or slow) is not a transcript that is gone (null). The follow keeps its place and its conversation through
// it, and the next poll reads on from there, nothing lost or repeated; only null starts the follow over, with a whole
// history again. A source in memory that a test makes unavailable; no tmux.
import { describe, expect, it } from "vitest";
import type { Message } from "@morndo/domain";
import { ObservationService, type Listener } from "../src/application/observation-service.ts";
import { SourceUnavailable, type Sessions, type TranscriptSource } from "../src/application/ports.ts";

const T = "2026-10-06T08:00:00.000Z";
const line = (uuid: string, text: string) => `${JSON.stringify({ type: "assistant", uuid, timestamp: T, message: { role: "assistant", content: [{ type: "text", text }] } })}\n`;

// One session's transcript: "ok", "unavailable" (every call throws SourceUnavailable) or "gone" (null). `failRead(n)`:
// the n-th read from now throws SourceUnavailable once, as a node that drops in the middle of a follow.
function transcript() {
  let bytes = Buffer.from(line("a1", "first"));
  let state: "ok" | "unavailable" | "gone" = "ok";
  let reads = 0;
  let failAt: number | null = null;
  const check = () => { if (state === "unavailable") throw new SourceUnavailable("the node is offline"); };
  const source: TranscriptSource = {
    size: async () => { check(); return state === "gone" ? null : bytes.length; },
    read: async (_s, offset, max) => {
      check();
      if (state === "gone") return null;
      if (++reads === failAt) { failAt = null; throw new SourceUnavailable("dropped in the middle of a follow"); }
      const b = bytes.subarray(offset, offset + max);
      return { bytes: b, eof: offset + b.length >= bytes.length };
    },
    locate: async () => { check(); return null; },
  };
  return {
    source,
    append: (s: string) => { bytes = Buffer.concat([bytes, Buffer.from(s)]); },
    set: (s: typeof state) => { state = s; },
    failRead: (n: number) => { reads = 0; failAt = n; },
  };
}

function watched(source: TranscriptSource) {
  const sessions: Sessions = { byPane: async () => new Map([["%1", { sessionId: "s1", name: null, pane: "%1", cwd: "/w", version: null, pid: 1 }]]) };
  const svc = new ObservationService(
    { listWorkers: async () => [{ id: "%1", name: "builder", location: "w", node: "local", offline: false }], captureMany: async ids => new Map(ids.map(id => [id, "❯ "])) },
    60_000, Date.now, { sessions, transcripts: source },
  );
  const sent: [string, string[]][] = [];
  const ids = (ms: Message[]) => ms.map(m => m.id);
  const listener: Listener = {
    events: () => {}, screen: () => {}, watching: () => "%1",
    history: (_w, ms) => { sent.push(["history", ids(ms)]); },
    messages: (_w, ms) => { sent.push(["messages", ids(ms)]); },
  };
  svc.subscribe(listener);
  return { svc, sent };
}

describe("a transcript that can't be read now", () => {
  it("keeps the follow's place: nothing rebuilt, nothing lost or repeated, and what came meanwhile arrives as new", async () => {
    const t = transcript();
    const { svc, sent } = watched(t.source);
    await svc.poll();
    t.set("unavailable");
    await svc.poll();
    await svc.poll();
    expect(svc.history("%1").map(m => m.id)).toEqual(["a1:0"]);        // the conversation is kept meanwhile
    t.append(line("a2", "second"));
    t.set("ok");
    await svc.poll();
    expect(sent).toEqual([["history", ["a1:0"]], ["messages", ["a2:0"]]]);
  });
  it("one that fails in the middle of a follow (a later read of the same poll): nothing read before it is lost", async () => {
    const t = transcript();
    const { svc, sent } = watched(t.source);
    await svc.poll();
    t.append(line("a2", "short") + line("a3", "x".repeat(300_000)));  // two reads of one chunk each (256 KiB)
    t.failRead(2);
    await svc.poll();
    await svc.poll();
    expect(sent).toEqual([["history", ["a1:0"]], ["messages", ["a2:0", "a3:0"]]]);
  });
  it("gone (null) starts the follow over, with a whole history again (negative control: not kept as unavailable is)", async () => {
    const t = transcript();
    const { svc, sent } = watched(t.source);
    await svc.poll();
    t.set("gone");
    await svc.poll();
    t.append(line("a2", "second"));
    t.set("ok");
    await svc.poll();
    expect(sent).toEqual([["history", ["a1:0"]], ["history", ["a1:0", "a2:0"]]]);
  });
});
```

- [ ] **Step 6: Run them and see them fail**

Run: `npx vitest run apps/hub/test/observation-nodes.test.ts apps/hub/test/http-older.test.ts apps/hub/test/observation-unavailable.test.ts`
Expected: FAIL, 9 of 9:
- `TypeError: this[#tmux].capture is not a function` (observation-nodes, three tests; observation-unavailable, all three: the old service still captures one pane at a time);
- `AssertionError: expected false to be true` for "doesn't hold up another node's screens beyond one poll interval";
- http-older: `AssertionError: expected [ 'start slow', 'start fast', …(1) ] to deeply equal [ 'start slow' ]` (the old handler answers each page at once) and `AssertionError: expected [ …(2) ] to deeply equal [ …(2) ]` on the missing page.

- [ ] **Step 7: Rewrite ObservationService over the ports**

Replace the whole of `apps/hub/src/application/observation-service.ts` with the code below. What changes:
- **Polling per node.** It lists workers once, then runs one round per node at once (`Promise.allSettled`): `captureMany`, then that node's transcripts. It waits at most `nodeWaitMs`. A node still in its round, or not online, gets no new round, and a late round is applied by the next poll.
- **Transcripts** are read through `TranscriptSource` and Task 3's reader (`followTranscript`, `olderPage`). The service no longer remembers page starts: it passes no `from` hint, and `olderPage` finds each page's anchor with one `locate`.
- **`older()` is async.**
- **A transcript that can't be read now** (`SourceUnavailable`) keeps its follow's place and conversation; the next poll reads on from there. Only null (gone), or another error, starts a follow over. An older page asked meanwhile is `missing`, which the app shows as "Couldn't load older messages" with Try again (`feed.svelte.ts` sets `failed`, never `done`), so paging works again once the node answers.
- **`stop()` during a poll now ends the loop.** With more awaits per poll, the old loop rescheduled itself after `stop()`, and `observation-loop-errors.fixture.ts` never exited. Without `#stopped`, that suite's first test fails with `exit: null`.

```ts
// Application service for the Observation context: polls the multiplexer, feeds the domain Roster and Feed,
// and tells subscribers what changed. Screens go only to the endpoints that watch that worker (latest state only).
// Workers live on nodes (fleet core §3.1). Each poll lists them once, then works through every node at the same time:
// one captureMany for its screens, then its followed transcripts. It waits at most `nodeWaitMs` for them. A node still
// busy from an earlier poll, or not online, is skipped, so a slow node never holds up the others; what a node brings
// after the poll stopped waiting is applied by the next poll.
import { randomUUID } from "node:crypto";
import { Conversation, Feed, Roster, needsYou, waitingOn, workerId, type FeedBody, type FeedEvent, type Message, type RosterEntry } from "@morndo/domain";
import { menuIdentity, menuOnScreen, type SessionInfo } from "@morndo/node-ops";
import { followTranscript, olderPage, type FileRef, type TranscriptCursor } from "../adapters/claude-sessions.ts";
import type { Files } from "../adapters/files.ts";
import { log } from "../adapters/log.ts";
import { SourceUnavailable, type NodeStates, type Sessions, type Tmux, type TranscriptSource } from "./ports.ts";

type Followed = { sessionId: string; cursor: TranscriptCursor; conversation: Conversation; title: string | null };

// What one node's round brought: its screens, the messages its transcripts added (with the follow they went into, so a
// follow rebuilt meanwhile doesn't take another's), and the follows that are new this round.
type NodeRound = { screens: Map<string, string | null>; added: Map<string, { follow: Followed; messages: Message[] }>; rebuilt: Set<string> };

export type Snapshot = { epoch: string; seq: number; workers: RosterEntry[] };
export type OlderResult = { messages: Message[]; done: boolean; missing?: true };
const MISSING: OlderResult = { messages: [], done: false, missing: true };

export type Listener = {
  events(events: FeedEvent[]): void;
  screen(workerId: string, text: string, at: number): void;
  messages(workerId: string, messages: Message[]): void;   // new messages, appended to what the watcher holds
  history(workerId: string, messages: Message[]): void;    // replaces what the watcher holds (a follow was rebuilt)
  watching(): string | null;
};

// Where the service reads from besides tmux. Each is optional: a hub without a Claude config dir follows no transcripts.
// `nodeWaitMs`: how long a poll waits for its nodes before it goes on without the slow ones (main.ts: the poll interval).
export type ObservationSources = {
  sessions?: Sessions | null;
  transcripts?: TranscriptSource | null;
  files?: Pick<Files, "register"> | null;
  nodeStates?: NodeStates | null;
  nodeWaitMs?: number;
};

export class ObservationService {
  readonly feed = new Feed(randomUUID(), 2000);
  #roster: Roster;
  #tmux: Pick<Tmux, "listWorkers" | "captureMany">;
  #listeners = new Set<Listener>();
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  #busy = false;
  #now: () => number;
  #sessions: Sessions | null;
  #transcripts: TranscriptSource | null;
  #files: Pick<Files, "register"> | null;
  #nodeStates: NodeStates | null;
  #nodeWaitMs: number;
  #followed = new Map<string, Followed>();             // worker ID → its session's conversation
  #panes = new Map<string, SessionInfo>();
  #panesAt = 0;
  #nodeOf = new Map<string, string>();                 // worker ID → its node, from the last listing
  #working = new Set<string>();                        // nodes whose round is still running
  #arrived: NodeRound[] = [];                          // rounds done and not yet applied

  constructor(tmux: Pick<Tmux, "listWorkers" | "captureMany">, quietAfterMs: number, now: () => number = Date.now, o: ObservationSources = {}) {
    this.#tmux = tmux;
    this.#roster = new Roster(quietAfterMs);
    this.#now = now;
    this.#sessions = o.sessions ?? null;
    this.#transcripts = o.transcripts ?? null;
    this.#files = o.files ?? null;
    this.#nodeStates = o.nodeStates ?? null;
    this.#nodeWaitMs = o.nodeWaitMs ?? 1000;
  }

  history(id: string, n = 150): Message[] { return this.#followed.get(id)?.conversation.latest(n) ?? []; }
  openQuestions(id: string): Message[] { return this.#followed.get(id)?.conversation.openQuestionMessages() ?? []; }
  session(id: string): SessionInfo | undefined { return this.#panes.get(id); }

  // An older page of a worker's conversation (ADR-0008 phase D, O9): read from its transcript on demand for the
  // Endpoint that asked, never kept here (O5's 300 is unchanged). The files those messages carry get the hub's copies.
  // The source finds the message asked for itself (locate), so no page starts are remembered here. `missing`: an
  // unknown worker, a message not in its transcript, or a transcript that can't be read now: not the beginning (L1).
  // A source that can't answer now (SourceUnavailable) is `missing` too: the app says it couldn't load the page and
  // offers Try again, and the follow is untouched, so paging works again once the node answers.
  async older(id: string, before: string): Promise<OlderResult> {
    const f = this.#followed.get(id);
    const name = this.nameOf(id);
    if (!f || name === null || !this.#transcripts) return MISSING;
    try {
      const page = await olderPage(this.#bytes(this.#transcripts, f.sessionId), name, before);
      this.#attachCopies(page.messages, page.files);
      return page.missing ? MISSING : { messages: page.messages, done: page.done };
    } catch (e) {
      log.warn(`older page of ${id} unreadable: ${(e as Error).message}`);
      return MISSING;                                           // the transcript went away, or its node didn't answer
    }
  }

  // Files a message carries: the hub keeps its own copy (files.ts); the message names it by id, never by path.
  #attachCopies(entries: readonly { id: string; kind: string; attachments?: { id: string | null; size: number | null }[] }[], refs: readonly FileRef[]) {
    for (const ref of refs) {
      const m = entries.find(e => e.id === ref.messageId);
      if (!m || m.kind === "answer" || !m.attachments) continue;
      ref.paths.forEach((p, i) => {
        const a = m.attachments?.[i];
        if (!a) return;
        const r = this.#files ? this.#files.register(p) : { id: null, size: null };
        a.id = r.id;
        a.size = r.size;
      });
    }
  }

  // One session's transcript as the byte source the transcript reader takes.
  #bytes(t: TranscriptSource, sessionId: string) {
    return {
      size: () => t.size(sessionId),
      read: (offset: number, max: number) => t.read(sessionId, offset, max),
      locate: (needle: string) => t.locate(sessionId, needle),
    };
  }

  snapshot(): Snapshot { return { epoch: this.feed.epoch, seq: this.feed.head, workers: this.#roster.entries() }; }
  // What a worker waits for now (S6), as a Command carries it: "none", or the question or menu identity.
  waitingOn(id: string): string { return this.#roster.entries().find(w => w.id === id)?.waitingOn ?? "none"; }
  nameOf(id: string): string | null { return this.#roster.entries().find(w => w.id === id)?.name ?? null; }
  screen(id: string) { return this.#roster.screen(workerId(id)); }

  subscribe(l: Listener) { this.#listeners.add(l); return () => this.#listeners.delete(l); }

  // stop() during a poll also ends the loop: that poll, which now awaits its nodes, schedules no next one.
  start(pollMs: number) {
    this.#stopped = false;
    const loop = async () => {
      try { await this.poll(); }
      catch (e) { log.error(`observation poll failed, polling again: ${(e as Error).message}`); }
      if (!this.#stopped) this.#timer = setTimeout(() => void loop(), pollMs);
    };
    void loop();
  }
  stop() { this.#stopped = true; if (this.#timer) clearTimeout(this.#timer); }

  async poll() {
    if (this.#busy) return;
    this.#busy = true;
    try {
      const now = this.#now();
      const listing = await this.#tmux.listWorkers();
      this.#nodeOf = new Map(listing.map(w => [w.id, w.node]));
      const bodies = this.#roster.observeListing(listing.map(w => ({ id: workerId(w.id), name: w.name, location: w.location })), now);
      await this.#refreshSessions(now);
      this.#dropFollows();
      await this.#pollNodes();
      const changedScreens = new Map<string, string>();
      const newMessages = new Map<string, Message[]>();
      const rebuilt = new Set<string>();
      for (const round of this.#arrived.splice(0)) this.#apply(round, bodies, changedScreens, newMessages, rebuilt);
      bodies.push(...this.#roster.tick(this.#now()));
      for (const w of this.#roster.entries()) {
        const f = this.#followed.get(w.id);
        const screen = this.#roster.screen(w.id) ?? "";
        const open = f?.conversation.openQuestionMessages().map(m => m.questionId ?? m.id) ?? [];
        bodies.push(...this.#roster.observeDetails(w.id, {
          title: f?.title ?? null,
          lastMessageAt: f?.conversation.lastAt ?? null,
          needsYou: needsYou({ openQuestions: f?.conversation.openQuestions ?? 0, menuOnScreen: menuOnScreen(screen) }),
          waitingOn: waitingOn({ openQuestionIds: open, menu: menuIdentity(screen) }),
        }));
      }
      const events = bodies.map(b => this.feed.append(b, now));
      for (const l of this.#listeners) {
        if (events.length) l.events(events);
        const watching = l.watching();
        const s = watching === null ? undefined : changedScreens.get(watching);
        if (watching !== null && s !== undefined) l.screen(watching, s, now);
        if (watching !== null && rebuilt.has(watching)) { l.history(watching, this.history(watching)); continue; }
        const m = watching === null ? undefined : newMessages.get(watching);
        if (watching !== null && m?.length) l.messages(watching, m);
      }
    } finally {
      this.#busy = false;
    }
  }

  // Which agent session runs in which pane, read again every 10 s.
  async #refreshSessions(now: number) {
    if (!this.#sessions || (now - this.#panesAt < 10_000 && this.#panesAt !== 0)) return;
    this.#panes = await this.#sessions.byPane();
    this.#panesAt = now;
  }

  // A follow ends when its worker is gone or its pane runs another session now.
  #dropFollows() {
    const alive = new Set(this.#roster.entries().map(w => w.id as string));
    for (const [id, f] of this.#followed) {
      if (!alive.has(id) || this.#panes.get(id)?.sessionId !== f.sessionId) this.#followed.delete(id);
    }
  }

  // Every node with workers, at the same time (Promise.allSettled), waited for at most `nodeWaitMs`.
  async #pollNodes() {
    const states = this.#nodeStates ? await this.#nodeStates() : null;
    const byNode = new Map<string, string[]>();
    for (const w of this.#roster.entries()) {
      const node = this.#nodeOf.get(w.id) ?? "";
      byNode.set(node, [...(byNode.get(node) ?? []), w.id]);
    }
    const rounds: Promise<void>[] = [];
    for (const [node, ids] of byNode) {
      if (states && states.get(node) !== "online") continue;      // not online: skipped at once
      if (this.#working.has(node)) continue;                       // its last round still runs: no second one on top
      this.#working.add(node);
      rounds.push(this.#pollNode(ids).then(
        r => { this.#arrived.push(r); },
        (e: unknown) => { log.warn(`observation: node ${node} failed this round: ${(e as Error).message}`); },
      ).finally(() => { this.#working.delete(node); }));
    }
    if (!rounds.length) return;
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<void>(resolve => { timer = setTimeout(resolve, this.#nodeWaitMs); });
    try { await Promise.race([Promise.allSettled(rounds), waited]); }
    finally { clearTimeout(timer); }
  }

  // One node's round: its screens in one captureMany, then each of its followed transcripts, in turn. The roster is not
  // touched here; whichever poll finds the round arrived applies it.
  async #pollNode(ids: string[]): Promise<NodeRound> {
    const round: NodeRound = { screens: await this.#tmux.captureMany(ids), added: new Map(), rebuilt: new Set() };
    const transcripts = this.#transcripts;
    if (!this.#sessions || !transcripts) return round;
    for (const id of ids) {
      const info = this.#panes.get(id);
      const name = this.nameOf(id);
      if (!info || name === null) continue;
      let f = this.#followed.get(id);
      if (!f) {
        let size: number | null;
        try { size = await transcripts.size(info.sessionId); }
        catch { continue; }                       // can't be asked now: try again next poll
        if (size === null) continue;              // no transcript (yet): try again next poll
        f = { sessionId: info.sessionId, cursor: { offset: 0, pending: new Set() }, conversation: new Conversation(), title: null };
        this.#followed.set(id, f);
        round.rebuilt.add(id);                    // its first read is the whole tail again, never new messages (O5)
      }
      try {
        const parsed = await followTranscript(this.#bytes(transcripts, f.sessionId), f.cursor, name);
        if (parsed.title) f.title = parsed.title;
        this.#attachCopies(parsed.entries, parsed.files);
        const fresh = f.conversation.add(parsed.entries);
        if (fresh.length) round.added.set(id, { follow: f, messages: fresh });
      } catch (e) {
        // Can't be read now (SourceUnavailable: its node offline, the fleet slow): the follow keeps its place and its
        // conversation, and the next poll reads on from there. One made this round starts over, so that its first read
        // stays a whole history (O5).
        if (e instanceof SourceUnavailable && !round.rebuilt.has(id)) continue;
        if (this.#followed.get(id) === f) this.#followed.delete(id);   // gone, moved or unreadable: start over next poll
        round.rebuilt.delete(id);
      }
    }
    return round;
  }

  #apply(round: NodeRound, bodies: FeedBody[], changedScreens: Map<string, string>, newMessages: Map<string, Message[]>, rebuilt: Set<string>) {
    for (const [id, text] of round.screens) {
      if (text === null) continue;                              // the pane went away between list and capture
      const r = this.#roster.observeScreen(workerId(id), text, this.#now());
      bodies.push(...r.events);
      if (r.changed) changedScreens.set(id, text);
    }
    for (const [id, a] of round.added) {
      if (this.#followed.get(id) !== a.follow) continue;        // that follow was dropped meanwhile
      newMessages.set(id, [...(newMessages.get(id) ?? []), ...a.messages]);
    }
    for (const id of round.rebuilt) if (this.#followed.has(id)) rebuilt.add(id);
  }
}
```

- [ ] **Step 8: Await the older page in the feed handler, one at a time per connection**

In `apps/hub/src/adapters/http.ts`, replace (`:15`)
```ts
import type { ObservationService } from "../application/observation-service.ts";
```
with
```ts
import type { ObservationService, OlderResult } from "../application/observation-service.ts";
```
Replace (`:427`)
```ts
      const unsubscribeBoard = escalations.subscribe(board => send({ t: "decisions", ...board }));
```
with
```ts
      const unsubscribeBoard = escalations.subscribe(board => send({ t: "decisions", ...board }));
      // Older pages, one at a time per connection (fleet core §3.1): each waits for the one before it.
      let olderDone: Promise<void> = Promise.resolve();
```
Replace (`:468-472`)
```ts
          case "older": {
            const page = observation.older(m.worker, m.before);
            send({ t: "older", worker: m.worker, before: m.before, messages: page.messages, done: page.done, ...(page.missing ? { missing: true } : {}) });
            break;
          }
```
with
```ts
          case "older": {
            // Read from the transcript, which may be on another node: async, so outside this handler's try. A page that
            // fails is answered as missing (the app says it couldn't load it), and nothing here may reject unhandled:
            // exitOnCrash would end the hub (ADR-0008, A5).
            const { worker, before } = m;
            olderDone = olderDone
              .then(() => observation.older(worker, before))
              .catch((e: unknown): OlderResult => {
                log.warn(`feed socket: older page of ${worker} failed`, e);
                return { messages: [], done: false, missing: true };
              })
              .then(page => send({ t: "older", worker, before, messages: page.messages, done: page.done, ...(page.missing ? { missing: true } : {}) }))
              .catch((e: unknown) => { log.error("feed socket: answering an older page failed, closing", e); ws.close(1011, "internal error"); });
            break;
          }
```

- [ ] **Step 9: Wire the local node in main.ts**

In `apps/hub/src/main.ts`, after the `uploadInbox` import (`:26`), add:
```ts
import { localSessions, localTmux, localTranscripts } from "./adapters/local-node.ts";
```
Replace (`:77-79`)
```ts
    const sessions = config.claudeDir ? sessionRegistry(config.claudeDir) : null;
    const files = fileStore({ dir: config.filesDir, deny: denyRoots(homedir(), config.dataDir) });
    const observation = new ObservationService(tmux, config.quietAfterMs, Date.now, sessions, files);
```
with
```ts
    const registry = config.claudeDir ? sessionRegistry(config.claudeDir) : null;
    const files = fileStore({ dir: config.filesDir, deny: denyRoots(homedir(), config.dataDir) });
    // Legacy single-host mode (fleet core §10): this machine is the one node, "local". A poll waits for its nodes at
    // most one poll interval.
    const observation = new ObservationService(localTmux(tmux), config.quietAfterMs, Date.now, {
      sessions: registry ? localSessions(registry) : null, transcripts: registry ? localTranscripts(registry) : null,
      files, nodeWaitMs: config.pollMs,
    });
```
`tmux` (the node-ops adapter) still goes to `typist`, SteeringService and EscalationService unchanged; Task 5 moves them to the port.

- [ ] **Step 10: Run the new tests and see them pass**

Run: `npx vitest run apps/hub/test/observation-nodes.test.ts apps/hub/test/http-older.test.ts apps/hub/test/local-node.test.ts apps/hub/test/observation-unavailable.test.ts`
Expected: PASS (15 tests)

- [ ] **Step 11: Adapt the fakes and the observation tests to the ports**

In each of `apps/hub/test/http.test.ts:44`, `http-crash-fixture.ts:114`, `desktop-control-idle.test.ts:159`, `access-idle-sweep.test.ts:103`, `access-policy-http.test.ts:67` and `remote-revoke.test.ts:200`, replace
```ts
  const tmux = { listWorkers: async () => [], capture: async () => null, send: async () => null };
```
with
```ts
  const tmux = { listWorkers: async () => [], capture: async () => null, captureMany: async () => new Map<string, string | null>(), send: async () => null };
```

`apps/hub/test/observation-waiting-on.test.ts`: replace the imports
```ts
import { workerId, type Worker } from "@morndo/domain";
import { menuIdentity, sessionRegistry } from "@morndo/node-ops";
import { ObservationService } from "../src/application/observation-service.ts";
```
with
```ts
import { menuIdentity, sessionRegistry } from "@morndo/node-ops";
import { localSessions, localTranscripts } from "../src/adapters/local-node.ts";
import { ObservationService } from "../src/application/observation-service.ts";
```
replace
```ts
  const listing: Worker[] = [{ id: workerId("%1"), name: "builder", location: "w" }];
  let shown = screen;
  const svc = new ObservationService({ listWorkers: async () => listing, capture: async () => shown, send: async () => null }, 60_000, Date.now, sessionRegistry(dir));
```
with
```ts
  const listing = [{ id: "%1", name: "builder", location: "w", node: "local", offline: false }];
  let shown = screen;
  const registry = sessionRegistry(dir);
  const svc = new ObservationService({ listWorkers: async () => listing, captureMany: async ids => new Map(ids.map(id => [id, shown])) }, 60_000, Date.now,
    { sessions: localSessions(registry), transcripts: localTranscripts(registry) });
```
and replace the synchronous `older()` assertions
```ts
    const page = svc.older("%1", "r120:0");
    expect(page.messages.map(m => m.text)).toEqual(Array.from({ length: 100 }, (_, i) => `reply ${20 + i}`));
    expect(page.done).toBe(false);
    expect(svc.older("%1", "r20:0")).toMatchObject({ done: true });       // the page before r20: where r120's page began
    expect(svc.older("%9", "r1:0")).toEqual({ messages: [], done: false, missing: true });   // not a followed worker (L1)
    expect(svc.older("%1", "gone:0")).toEqual({ messages: [], done: false, missing: true }); // not in its transcript
```
with
```ts
    const page = await svc.older("%1", "r120:0");
    expect(page.messages.map(m => m.text)).toEqual(Array.from({ length: 100 }, (_, i) => `reply ${20 + i}`));
    expect(page.done).toBe(false);
    expect(await svc.older("%1", "r20:0")).toMatchObject({ done: true });       // the page before r20: where r120's page began
    expect(await svc.older("%9", "r1:0")).toEqual({ messages: [], done: false, missing: true });   // not a followed worker (L1)
    expect(await svc.older("%1", "gone:0")).toEqual({ messages: [], done: false, missing: true }); // not in its transcript
```

`apps/hub/test/observation-refollow.test.ts`: replace
```ts
import type { Message, Worker } from "@morndo/domain";
import { workerId } from "@morndo/domain";
import { sessionRegistry } from "@morndo/node-ops";
import { ObservationService, type Listener } from "../src/application/observation-service.ts";
```
with
```ts
import type { Message } from "@morndo/domain";
import { sessionRegistry } from "@morndo/node-ops";
import { localSessions, localTranscripts } from "../src/adapters/local-node.ts";
import { ObservationService, type Listener } from "../src/application/observation-service.ts";
import type { Tmux } from "../src/application/ports.ts";

type Listing = Awaited<ReturnType<Tmux["listWorkers"]>>;
```
replace
```ts
  let listing: Worker[] = [{ id: workerId("%1"), name: "builder", location: "demo" }];
  const tmux = { listWorkers: async () => listing, capture: async () => "❯ ", send: async () => null };
  let now = START + 1_000_000;
  const service = new ObservationService(tmux, 60_000, () => now, sessionRegistry(dir));
```
with
```ts
  let listing: Listing = [{ id: "%1", name: "builder", location: "demo", node: "local", offline: false }];
  const tmux = { listWorkers: async () => listing, captureMany: async (ids: string[]) => new Map(ids.map(id => [id, "❯ "])) };
  let now = START + 1_000_000;
  const registry = sessionRegistry(dir);
  const service = new ObservationService(tmux, 60_000, () => now, { sessions: localSessions(registry), transcripts: localTranscripts(registry) });
```
replace `    setListing: (l: Worker[]) => { listing = l; },` with `    setListing: (l: Listing) => { listing = l; },`, and replace `    f.setListing([{ id: workerId("%1"), name: "builder", location: "demo" }]);` with `    f.setListing([{ id: "%1", name: "builder", location: "demo", node: "local", offline: false }]);`.

`apps/hub/test/observation-loop-errors.fixture.ts`: replace
```ts
import { workerId, type FeedEvent, type Worker } from "@morndo/domain";
import { sessionRegistry } from "@morndo/node-ops";
import { ObservationService } from "../src/application/observation-service.ts";
```
with
```ts
import type { FeedEvent } from "@morndo/domain";
import { sessionRegistry } from "@morndo/node-ops";
import { localSessions, localTranscripts } from "../src/adapters/local-node.ts";
import { ObservationService } from "../src/application/observation-service.ts";
```
replace
```ts
let listing: Worker[] = [{ id: workerId("%1"), name: "builder", location: "demo" }];
const tmux = { listWorkers: async () => { polls++; return listing; }, capture: async () => "❯ ", send: async () => null };
const service = new ObservationService(tmux, 60_000, Date.now, sessionRegistry(dir));
```
with
```ts
let listing = [{ id: "%1", name: "builder", location: "demo", node: "local", offline: false }];
const tmux = { listWorkers: async () => { polls++; return listing; }, captureMany: async (ids: string[]) => new Map(ids.map(id => [id, "❯ "])) };
const registry = sessionRegistry(dir);
const service = new ObservationService(tmux, 60_000, Date.now, { sessions: localSessions(registry), transcripts: localTranscripts(registry) });
```
and replace `listing = [...listing, { id: workerId("%2"), name: "reviewer", location: "demo" }];` with `listing = [...listing, { id: "%2", name: "reviewer", location: "demo", node: "local", offline: false }];`.

`apps/hub/test/escalation-window.test.ts`: replace
```ts
import { CONVERSATION_CAP, Conversation, TAP_TTL_MS, endpointId, sessionId, workerId, type Message } from "@morndo/domain";
```
with
```ts
import { CONVERSATION_CAP, Conversation, TAP_TTL_MS, endpointId, sessionId, type Message } from "@morndo/domain";
```
replace
```ts
import type { Tmux } from "@morndo/node-ops";
```
with
```ts
import { localTranscripts } from "../src/adapters/local-node.ts";
import type { Tmux } from "../src/application/ports.ts";
```
and in `liveHub()` replace
```ts
  const tmux = { fails: false } as Tmux & { fails: boolean };
  tmux.listWorkers = async () => (tmux.fails ? [] : [{ id: workerId("%0"), name: "manager", location: "manager" }]);
  tmux.capture = async () => "❯ \n";
  tmux.send = async () => null;
  const sessions = {
    byPane: () => new Map([["%0", { sessionId: "sess-1", name: null, pane: "%0", cwd: dir, version: "2.1.286", pid: process.pid }]]),
    transcriptPath: () => transcript,
  };
  const observation = new ObservationService(tmux, 15_000, () => now, sessions);
```
with
```ts
  const tmux: Pick<Tmux, "listWorkers" | "captureMany"> & { fails: boolean } = {
    fails: false,
    listWorkers: async () => (tmux.fails ? [] : [{ id: "%0", name: "manager", location: "manager", node: "local", offline: false }]),
    captureMany: async ids => new Map(ids.map(id => [id, "❯ \n"])),
  };
  const sessions = {
    byPane: async () => new Map([["%0", { sessionId: "sess-1", name: null, pane: "%0", cwd: dir, version: "2.1.286", pid: process.pid }]]),
  };
  const observation = new ObservationService(tmux, 15_000, () => now, { sessions, transcripts: localTranscripts({ transcriptPath: () => transcript }) });
```

- [ ] **Step 12: Move the transcript readers' callers to the new reader, and delete the old readers**

`apps/hub/test/protocol-contract.test.ts`: replace
```ts
import { Conversation, workerId, type Worker } from "@morndo/domain";
import { ServerFeedFrames, decode } from "@morndo/protocol";
import { readTranscript } from "../src/adapters/claude-sessions.ts";
```
with
```ts
import { Conversation } from "@morndo/domain";
import { localTranscriptBytes } from "@morndo/node-ops";
import { ServerFeedFrames, decode } from "@morndo/protocol";
import { followTranscript } from "../src/adapters/claude-sessions.ts";
```
replace
```ts
    const workers: Worker[] = [
      { id: workerId("%1"), name: "w".repeat(300), location: "/work/" + "deep/".repeat(200) },
      { id: workerId("%2"), name: "review·ü·中文·🚀", location: "/tmp" },
    ];
    const obs = new ObservationService({ listWorkers: async () => workers, capture: async () => "$ ", send: async () => null }, 1000);
```
with
```ts
    const workers = [
      { id: "%1", name: "w".repeat(300), location: "/work/" + "deep/".repeat(200), node: "local", offline: false },
      { id: "%2", name: "review·ü·中文·🚀", location: "/tmp", node: "local", offline: false },
    ];
    const obs = new ObservationService({ listWorkers: async () => workers, captureMany: async ids => new Map(ids.map(id => [id, "$ "])) }, 1000);
```
replace `  it("a history read from a transcript, with a 3-million-character paste", () => {` with `  it("a history read from a transcript, with a 3-million-character paste", async () => {`, and replace
```ts
    c.add(readTranscript({ path, offset: 0, pending: new Set() }, "builder", 8 << 20).entries);
```
with
```ts
    c.add((await followTranscript(localTranscriptBytes(path), { offset: 0, pending: new Set() }, "builder", { tailBytes: 8 << 20 })).entries);
```

`apps/hub/test/claude-sessions.test.ts`: in the import from `../src/adapters/claude-sessions.ts` (`:7`), replace the names `readOlder, readTranscript, type TranscriptCursor` with `followTranscript, olderPage, type TranscriptCursor` (keep `parseLine`), and add `import { localTranscriptBytes } from "@morndo/node-ops";` before it. Then replace the block from `describe("reading a growing transcript", () => {` (`:115`) through the end of `parseAll` (`:170`) with:
```ts
describe("reading a growing transcript", () => {
  it("an absorbed prompt is placed where the agent took it in, in every read, so older pages lose none (review M2)", async () => {
    const at = (s: number) => new Date(Date.parse(T) + s * 1000).toISOString();
    const said = (uuid: string, s: number) => line({ type: "assistant", uuid, timestamp: at(s), message: { role: "assistant", content: [{ type: "text", text: uuid }] } });
    const taken = (uuid: string, sent: number) => line({ type: "attachment", uuid, timestamp: at(sent), isSidechain: false,
      attachment: { type: "queued_command", prompt: uuid, commandMode: "prompt", origin: { kind: "human" }, timestamp: at(sent), humanTurn: true } });
    const path = join(dir, "s.jsonl");
    // Written in this order: a1 at 0 s, a2 at 50 s, then q9 (sent at 10 s, taken in after a2), then a3 at 60 s.
    writeFileSync(path, said("a1", 0) + said("a2", 50) + taken("q9", 10) + said("a3", 60));
    const cursor: TranscriptCursor = { offset: 0, pending: new Set() };
    const c = new Conversation();
    c.add((await followTranscript(localTranscriptBytes(path), cursor, "builder")).entries);
    const ms = (s: number) => Date.parse(T) + s * 1000;
    expect(c.latest().map(m => [m.id, m.at])).toEqual([["a1:0", ms(0)], ["a2:0", ms(50)], ["q9", ms(50)], ["a3:0", ms(60)]]);
    // The next read remembers how far the conversation had come.
    appendFileSync(path, taken("q10", 20));
    c.add((await followTranscript(localTranscriptBytes(path), cursor, "builder")).entries);
    expect(c.latest().map(m => [m.id, m.at]).at(-1)).toEqual(["q10", ms(60)]);
    // Only the conversation's own lines say how far it had come: a bookkeeping line stamped an hour ahead moves nothing.
    const ahead = join(dir, "ahead.jsonl");
    writeFileSync(ahead, said("b1", 0) + line({ type: "file-history-delta", timestamp: at(3600) }) + taken("q1", 5) + said("b2", 20) + said("b3", 30));
    const c2 = new Conversation();
    c2.add((await followTranscript(localTranscriptBytes(ahead), { offset: 0, pending: new Set() }, "builder")).entries);
    expect(c2.latest().map(m => m.id)).toEqual(["b1:0", "q1", "b2:0", "b3:0"]);
    expect((await olderPage(localTranscriptBytes(ahead), "builder", "b3:0", { limit: 5 })).messages.map(m => m.id)).toEqual(["b1:0", "q1", "b2:0"]);
    // Older pages go by the file's order and agree: nothing between two pages is lost.
    const page = await olderPage(localTranscriptBytes(path), "builder", "a3:0", { limit: 2 });
    expect(page.messages.map(m => [m.id, m.at])).toEqual([["a2:0", ms(50)], ["q9", ms(50)]]);
    const first = await olderPage(localTranscriptBytes(path), "builder", "a2:0", { limit: 2 });
    expect(first.messages.map(m => m.id)).toEqual(["a1:0"]);
    expect(first.done).toBe(true);
  });
  it("reads only complete new lines, and starts mid-file at a line boundary", async () => {
    const path = join(dir, "t.jsonl");
    const read = async (cursor: TranscriptCursor, tailBytes?: number) =>
      (await followTranscript(localTranscriptBytes(path), cursor, "builder", tailBytes === undefined ? {} : { tailBytes })).entries;
    writeFileSync(path, user("u1", "first") + assistant("a1", [{ type: "text", text: "reply one" }]));
    const cursor: TranscriptCursor = { offset: 0, pending: new Set() };
    expect((await read(cursor)).map(e => e.id)).toEqual(["u1", "a1:0"]);
    appendFileSync(path, user("u2", "second").slice(0, 20));           // half a line: not read yet
    expect(await read(cursor)).toEqual([]);
    appendFileSync(path, user("u2", "second").slice(20));
    expect((await read(cursor)).map(e => e.id)).toEqual(["u2"]);
    const tailBytes = Buffer.byteLength(user("u2", "second")) + 5;                        // starts inside the line before u2
    expect((await read({ offset: 0, pending: new Set() }, tailBytes)).map(e => e.id)).toEqual(["u2"]);
  });
});

describe("files sent and received", () => {
  const tool = (id: string, command: string) => ({ type: "tool_use", id, name: "Bash", input: { command } });
  const result = (id: string, content: unknown) => ({ type: "tool_result", tool_use_id: id, content });
  const parseAll = async (lines: string[]) => {
    const path = join(dir, "t.jsonl");
    writeFileSync(path, lines.join(""));
    return followTranscript(localTranscriptBytes(path), { offset: 0, pending: new Set() }, "builder");
  };
```
In the four tests that call `parseAll` (`:183`, `:196`, `:204`, `:212`), make the test `async () =>` and replace `const p = parseAll([` with `const p = await parseAll([`.

Replace the whole of `apps/hub/test/claude-sessions-utf8-cursor.test.ts` from its first line through its import of `claude-sessions.ts` (`:1-8`) with
```ts
// The transcript cursor is a byte offset. On the first read of a transcript longer than the window, followTranscript
// skips the partial line it jumped into; multibyte text on that line must not move the cursor off the line ends,
// or a line appended later is lost (or old lines come back).
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localTranscriptBytes } from "@morndo/node-ops";
import { followTranscript, type TranscriptCursor } from "../src/adapters/claude-sessions.ts";
```
replace (`:14`) `const WINDOW = 2 << 20;                                   // readTranscript's default first-read window (tailBytes)` with `const WINDOW = 2 << 20;                                   // followTranscript's default first-read window (tailBytes)`, and replace everything from `const ids = (cursor: TranscriptCursor)` (`:58`) to the end of the file with
```ts
const ids = async (path: string, cursor: TranscriptCursor) => (await followTranscript(localTranscriptBytes(path), cursor, "builder")).entries.map(e => e.id);

for (const layout of LAYOUTS) {
  describe(`a transcript longer than the read window, ${layout.name}`, () => {
    it("the first read starts at a line boundary", async () => {
      const first = await ids(writeTranscript(layout), { offset: 0, pending: new Set() });
      expect(first).not.toContain("s1");
      expect(first.at(-1)).toBe("t1:0");
    });

    it("idle polls return nothing", async () => {
      const path = writeTranscript(layout);
      const cursor: TranscriptCursor = { offset: 0, pending: new Set() };
      await ids(path, cursor);
      for (let poll = 1; poll <= 3; poll++) expect((await ids(path, cursor)).length, `entries returned by idle poll ${poll}`).toBe(0);
    });

    it("a question appended after an idle poll is returned exactly once", async () => {
      const path = writeTranscript(layout);
      const cursor: TranscriptCursor = { offset: 0, pending: new Set() };
      await ids(path, cursor);
      expect(await ids(path, cursor)).toEqual([]);                       // nothing new yet
      appendFileSync(path, ask("q1"));
      expect(await ids(path, cursor)).toEqual(["q1"]);
    });

    it("lines appended between polls are each returned exactly once", async () => {
      const path = writeTranscript(layout);
      const cursor: TranscriptCursor = { offset: 0, pending: new Set() };
      await ids(path, cursor);
      appendFileSync(path, ask("q1"));
      expect(await ids(path, cursor)).toEqual(["q1"]);
      appendFileSync(path, user("u2", "And the docs too, please."));
      expect(await ids(path, cursor)).toEqual(["u2"]);
    });
  });
}
```

`apps/hub/test/claude-sessions-older.test.ts`: every test Task 3 left is kept; the ones still on the synchronous `readOlder` read through `olderPage` over the file's bytes now, and become async (the `from`, `window` and `chunk` options they pass are `OlderOptions`' own). Replace the import
```ts
import { olderPage, readOlder } from "../src/adapters/claude-sessions.ts";
```
with
```ts
import { olderPage } from "../src/adapters/claude-sessions.ts";
```
then replace everything from `describe("readOlder", () => {` (`:37`) through the end of the test "parses each line once, however far back the page is (review M1: it was quadratic)" (`:87`) with
```ts
describe("olderPage", () => {
  it("returns the 100 messages before the given one, oldest first", async () => {
    const r = await olderPage(localTranscriptBytes(transcript(500)), "builder", "a400:0");
    expect(r.messages).toHaveLength(100);
    expect(texts(r)[0]).toBe("reply 300");
    expect(texts(r).at(-1)).toBe("reply 399");
    expect(r.done).toBe(false);
  });
  it("near the start: fewer, and done", async () => {
    const r = await olderPage(localTranscriptBytes(transcript(500)), "builder", "a30:0");
    expect(texts(r)).toEqual(Array.from({ length: 30 }, (_, i) => `reply ${i}`));
    expect(r.done).toBe(true);
  });
  it("before the first message: an empty page, the beginning of the conversation", async () => {
    expect(await olderPage(localTranscriptBytes(transcript(10)), "builder", "a0:0")).toMatchObject({ messages: [], done: true });
  });
  it("reads across many small chunks, without losing or doubling a line at a chunk's edge", async () => {
    const r = await olderPage(localTranscriptBytes(transcript(400, 300)), "builder", "a250:0", { chunk: 1024 });   // ~350-byte lines, 1 KB chunks
    expect(texts(r)).toEqual(Array.from({ length: 100 }, (_, i) => `reply ${150 + i}`));
  });
  it("a message it can't find (the transcript was replaced) gives nothing and says so: not the beginning (review L1)", async () => {
    expect(await olderPage(localTranscriptBytes(transcript(10)), "builder", "nope")).toMatchObject({ messages: [], done: false, missing: true });
    expect(await olderPage(localTranscriptBytes(transcript(10)), "builder", "a99:0")).toMatchObject({ messages: [], done: false, missing: true });
  });
  it("keeps multibyte characters whole across chunk edges", async () => {
    const path = join(dir, "u.jsonl");
    writeFileSync(path, Array.from({ length: 50 }, (_, i) => JSON.stringify({
      type: "assistant", uuid: `u${i}`, timestamp: new Date(T0 + i * 1000).toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: `ü中🚀 ${i}` }] },
    })).join("\n") + "\n");
    const r = await olderPage(localTranscriptBytes(path), "builder", "u40:0", { chunk: 97 });
    expect(texts(r).at(-1)).toBe("ü中🚀 39");
    expect(r.messages).toHaveLength(40);
  });
  it("a page that ends inside one line keeps that line's earlier blocks", async () => {
    const path = join(dir, "b.jsonl");
    writeFileSync(path, [reply(0), JSON.stringify({
      type: "assistant", uuid: "two", timestamp: new Date(T0 + 5000).toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: "first block" }, { type: "text", text: "second block" }] },
    })].join("\n") + "\n");
    expect(texts(await olderPage(localTranscriptBytes(path), "builder", "two:1"))).toEqual(["reply 0", "first block"]);
  });
  it("parses each line once, however far back the page is (review M1: it was quadratic)", async () => {
    const path = transcript(3000, 200);                                     // ~270-byte lines, 1 KB chunks: ~800 chunks
    const parse = vi.spyOn(JSON, "parse");
    try {
      const r = await olderPage(localTranscriptBytes(path), "builder", "a150:0", { chunk: 1024 });
      expect(texts(r)[0]).toBe("reply 50");
      expect(parse.mock.calls.length).toBeLessThan(2 * 3000);
    } finally { parse.mockRestore(); }
  });
```
and replace the last test (`:111-114`)
```ts
  it("a hint that no longer fits (the transcript changed) falls back to the search", () => {
    const path = transcript(500);
    expect(texts(readOlder(path, "builder", "a400:0", { from: 10 }))[0]).toBe("reply 300");
  });
```
with
```ts
  it("a hint that no longer fits (the transcript changed) falls back to the search", async () => {
    const path = transcript(500);
    expect(texts(await olderPage(localTranscriptBytes(path), "builder", "a400:0", { from: 10 }))[0]).toBe("reply 300");
  });
```

`apps/hub/test/transcript-long-lines.test.ts`: in all three places (`:78`, `:91`, `:121`) replace `    const cursor: TranscriptCursor = { path, offset: 0, pending: new Set() };` with `    const cursor: TranscriptCursor = { offset: 0, pending: new Set() };`.

`apps/hub/src/adapters/claude-sessions.ts` (as Task 3 left it). Delete Task 3's synchronous wrappers: everything from
```ts
// ---- until Task 4: the same steps over the local file, synchronously, for ObservationService
```
(`:441`) to the end of the file, so the file ends with `olderPage`. Delete the import only they used (`:7`):
```ts
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
```
In the section's header comment, replace (`:207-209`)
```ts
// parse what comes back (no I/O of their own): followTranscript and olderPage answer them from any TranscriptBytes;
// readTranscript and readOlder answer them from the local file, synchronously, for ObservationService until it reads
// asynchronously (fleet core Task 4, which removes them).
```
with
```ts
// parse what comes back (no I/O of their own): followTranscript and olderPage answer them from any TranscriptBytes.
```
and in `TranscriptCursor` (`:257`) replace
```ts
  path: string; offset: number; pending: Set<string>; sends?: Map<string, (string | null)[]>; latest?: number;
```
with
```ts
  offset: number; pending: Set<string>; sends?: Map<string, (string | null)[]>; latest?: number;
```
(Only `readTranscript` read `path`: a cursor no longer knows where its bytes come from.)

Check that no caller of the wrappers is left:
Run: `grep -rnE "\b(readTranscript|readOlder|runSync|onFile|SyncBytes|OLDER_SCAN_LIMIT)\b|\{ path[,:].*offset: 0" apps/hub`
Expected: one line, the comment in `apps/hub/test/transcript-long-lines.test.ts` that names the old reader its negative control copies (`// readTranscript as it was before the carry (claude-sessions.ts at 38ea4be, lines 259-298): …`). Before this step the same command prints 54 lines (round 2: Task 3's test of a follow whose source fails added one cursor literal).

- [ ] **Step 13: Run the full hub suite and the checks**

Run each on its own (a chain such as `vitest && check` stops at the first failure, and on macOS the `pane-lock` failures would stop it before `check`):
- `npx vitest run apps/hub packages apps/web`
- `npm run check`
- `npm run lint`

Expected:
- vitest: every test file PASSES but `packages/node-ops/test/pane-lock.test.ts`, which needs `flock(1)`: on macOS it fails before and after this task (2 tests), and passes on Linux CI. On macOS: 131 files, 1021 tests, 2 failed (Tasks 1–3 left 127 and 1006). Linux: not yet observed (plan.md, Global Constraints);
- `npm run check` exits 0;
- `npm run lint` reports nothing.

- [ ] **Step 14: Commit**

```bash
git add apps/hub/src/application/ports.ts apps/hub/src/adapters/local-node.ts apps/hub/src/application/observation-service.ts \
  apps/hub/src/adapters/http.ts apps/hub/src/main.ts apps/hub/src/adapters/claude-sessions.ts apps/hub/test
git commit -m "feat(hub): async node ports and per-node parallel observation"
```

- [ ] **Step 15: Negative controls: the sequential poll fails the isolation bound, and a source that can't answer now drops the follow**

In `apps/hub/src/application/observation-service.ts`, in `#pollNodes`, temporarily replace everything from `    const rounds: Promise<void>[] = [];` through `    finally { clearTimeout(timer); }` with:
```ts
    for (const [node, ids] of byNode) {                            // NEGATIVE CONTROL: one node after the other
      if (states && states.get(node) !== "online") continue;
      this.#arrived.push(await this.#pollNode(ids));
    }
```
Run: `npx vitest run apps/hub/test/observation-nodes.test.ts -t "beyond one poll interval"`
Expected: FAIL with `AssertionError: expected false to be true` (node "b"'s first screen never arrives).
Then restore it: `git checkout -- apps/hub/src/application/observation-service.ts`. `git status` shows a clean tree.

Then the follow's place (round 2, item 15): in `#pollNode`, temporarily delete the line `        if (e instanceof SourceUnavailable && !round.rebuilt.has(id)) continue;` (every error starts the follow over, as before).
Run: `npx vitest run apps/hub/test/observation-unavailable.test.ts`
Expected: FAIL, 2 of 3: "keeps the follow's place …" with `AssertionError: expected [] to deeply equal [ 'a1:0' ]` (the conversation went with the follow), and "one that fails in the middle of a follow …" with `AssertionError: expected [ [ 'history', [ 'a1:0' ] ], …(1) ] to deeply equal [ [ 'history', [ 'a1:0' ] ], …(1) ]` (rebuilt: a whole history instead of the new messages). "gone (null) starts the follow over …" passes either way.
Then restore it: `git checkout -- apps/hub/src/application/observation-service.ts`. `git status` shows a clean tree.

---

### Task 5: Files, uploads, keys and the node's typing time

Task 5 lands in three commits: A, keys, `typedAt` and staged uploads; B, background file copies shown as pending; C, the web outbox matching echoes by `typedAt`.

**Files:**
- Part A (hub):
  - Modify: `apps/hub/src/adapters/migrations.ts:87` (append migration 8), `apps/hub/src/adapters/store.ts:85-93`, `apps/hub/src/adapters/local-node.ts` (append `localUploads`), `apps/hub/src/application/steering-service.ts` (whole file), `apps/hub/src/application/escalation-service.ts:31,36,49,67,259,269`, `apps/hub/src/main.ts:16,27,77,82-83,89,92,101` (as Task 4 left it).
  - Test (create): `apps/hub/test/steering-keys.test.ts`, `apps/hub/test/escalation-answer-keys.test.ts`.
  - Test (modify): `steering-durable.test.ts:12,30-46,55`, `steering-inflight-duplicate.test.ts:13,36-46`, `steering-throw-retry.test.ts:11,29-37,53`, `steering.test.ts:10,14` and the 8 `new SteeringService(` lines, `tmux-no-input-box.test.ts:11,48,55`, and the seven fakes edited in Task 4. (Task 2 moved these tests' `SendProblem`/`Tmux` imports to `@morndo/node-ops`; the edits below quote them so.)
- Part B (hub, protocol, domain, web):
  - Modify: `packages/domain/src/conversation.ts:7-9`, `packages/protocol/src/feed.ts:76-80,176`, `apps/hub/src/adapters/files.ts:7-9,16,50-66`, `apps/hub/src/adapters/local-node.ts` (append `localFiles`), `apps/hub/src/application/observation-service.ts`, `apps/hub/src/adapters/http.ts:424`, `apps/hub/src/main.ts`, `apps/web/src/lib/feed.svelte.ts:384`, `apps/web/src/lib/desktop/Attachments.svelte:2-4,13,52`, `apps/web/src/lib/phone/Chat.svelte:60`, `apps/web/src/lib/phone/UpdateCard.svelte:88-89`.
  - Test (create): `apps/hub/test/observation-attachments.test.ts`, `apps/web/test/attachments-web.test.ts`.
  - Test (modify): `apps/hub/test/files.test.ts`, `apps/hub/test/local-node.test.ts`, `packages/protocol/test/protocol.test.ts` (append).
- Part C (web):
  - Modify: `apps/web/src/lib/outbox/state.ts:22-23,55-56,66`, `apps/web/src/lib/outbox/outbox.ts:9,92,214`, `apps/web/src/lib/gallery/data.ts:62,67,68`, `apps/web/src/lib/outbox/words.ts:19`.
  - Test (modify): `apps/web/test/outbox-state.test.ts:7` (plus an appended block), `apps/web/test/outbox-words.test.ts:7,15`, `apps/web/test/signout-web.test.ts:29`.

**Interfaces:**
- Consumes: Task 4's `ports.ts` (`Tmux`, `SendOutcome`, `UploadSink`, `RemoteFiles`), `local-node.ts` and `ObservationService`/`ObservationSources`/`Listener`. From node-ops: `SendProblem`, `PaneLock` (`<T>(f: () => Promise<T>) => Promise<T | "busy">`).
- Produces:
  - **Steering:**
    ```ts
    SteeringService(store, tmux: Pick<Tmux, "send">, now?, policy?, inbox?, waitingOn?, nameOf?, uploads?: UploadSink)
    ```
    `SendResult.at` is the node's `typedAt`, and the problem union adds `"too_large" | "node_offline"`. `BEFORE_PASTE` (the refusals whose row is released, so a retry types) is a `Set<SendOutcome["problem"]>`: `no_pane`, `menu_open`, `no_input_box`, `draft_present`, `busy` and `node_offline`.
  - **Escalations:** `answerKey(id: string, ask: { messageId: string | null; askedAt: number }, choice: Choice): string`, which gives `answer:<id>:<ask>:option:<key>` or `answer:<id>:<ask>:words:<16 hex>`, `<ask>` being the asking message's id, or `t<askedAt>` when it has none. EscalationService's `send` becomes `(pane, text, key) => Promise<SendProblem | "node_offline" | null>` (a problem, not an outcome: main.ts maps the port's `.problem`), and `AnswerResult.problem` gains `"node_offline"`.
  - **Store:** `Store.send(key): { state; at; typedAt: number | null } | null` and `Store.finishSend(key, typedAt)`, with migration 8.
  - **Files:**
    ```ts
    Files.register(path): Promise<{ id: string | null; size: number | null }>
    localUploads(): UploadSink
    localFiles(files: Pick<Files, "register">): RemoteFiles
    ```
  - **Observation:** `ObservationSources.files` is a `RemoteFiles | null`, and the new `Listener.attachments?(workerId, messageId, attachments)`.
  - **Protocol:** `Attachment.pending?: true`, and the `ServerFeedFrames.attachments` frame.
  - **Web:** `OutboxRecord.typedAt` (with `hubAt?` read for records kept from before).

- [ ] **Step 1 (A): Write the failing tests for keys, the node's typing time and staged uploads**

Create `apps/hub/test/steering-keys.test.ts`:

```ts
// Sends carry keys and come back with the node's time (fleet core §3.1): the key is the request's own
// (<endpoint>:<request>), a refusal before the paste (a node that isn't online among them) still lets the retry type,
// the time the app matches the echo by is the node's typedAt (a node clock 10 s behind the hub's here), and an attached
// image that can't be put on the worker's machine refuses the send before anything is typed. A fake node that keeps
// keys as the agent does: a key it typed answers its stored outcome; a refusal before the paste keeps nothing (spec
// §5.3). Real SQLite in a temp dir.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId, type Upload } from "@morndo/domain";
import { Store } from "../src/adapters/store.ts";
import { localUploads } from "../src/adapters/local-node.ts";
import { SteeringService } from "../src/application/steering-service.ts";
import type { SendOutcome, Tmux, UploadSink } from "../src/application/ports.ts";
import type { Authenticated } from "../src/application/access-service.ts";

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

// The node: answers the next scripted problems first (then types), keeps the outcome of what it typed by key.
function node(script: SendOutcome["problem"][] = []) {
  const typed: { text: string; key: string }[] = [];
  const keys: string[] = [];
  const done = new Map<string, SendOutcome>();
  const tmux: Pick<Tmux, "send"> = {
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
const steering = (tmux: Pick<Tmux, "send">, o: { inbox?: { get(id: string): Upload | undefined }; uploads?: UploadSink } = {}) =>
  new SteeringService(store, tmux, () => HUB_NOW, undefined, o.inbox ?? null, () => "none", () => null, o.uploads ?? localUploads());

describe("keys", () => {
  it("the node gets the request's own key, <endpoint>:<request>", async () => {
    const n = node();
    expect(await steering(n.tmux).send(A, "%1", "ship it", RID)).toMatchObject({ ok: true });
    expect(n.keys).toEqual([`ep1:${RID}`]);
  });
  it("draft_present, then the retry with the same request: typed, once, with the same key", async () => {
    const n = node(["draft_present"]);
    const s = steering(n.tmux);
    expect(await s.send(A, "%1", "ship it", RID)).toEqual({ ok: false, problem: "draft_present" });
    expect(await s.send(A, "%1", "ship it", RID)).toMatchObject({ ok: true });
    expect(n.typed).toEqual([{ text: "ship it", key: `ep1:${RID}` }]);
    expect(n.keys).toEqual([`ep1:${RID}`, `ep1:${RID}`]);
  });
  it("a node that isn't online refuses before the paste: no row is kept, and the retry types, once", async () => {
    const n = node(["node_offline"]);
    const s = steering(n.tmux);
    expect(await s.send(A, "pc.3fa2c1d0.12", "ship it", RID)).toEqual({ ok: false, problem: "node_offline" });
    expect(store.send(`ep1:${RID}`)).toBeNull();
    expect(await s.send(A, "pc.3fa2c1d0.12", "ship it", RID)).toMatchObject({ ok: true });
    expect(n.typed).toEqual([{ text: "ship it", key: `ep1:${RID}` }]);
  });
});

describe("echo time on the node's clock", () => {
  it("a send answers the node's typedAt, 10 s behind the hub, and a repeat after a restart answers the same", async () => {
    const n = node();
    expect(await steering(n.tmux).send(A, "%1", "ship it", RID)).toEqual({ ok: true, at: HUB_NOW - NODE_BEHIND_MS });
    const restarted = steering(node().tmux);                             // a new service on the same database
    expect(await restarted.send(A, "%1", "ship it", RID)).toEqual({ ok: false, problem: "duplicate", at: HUB_NOW - NODE_BEHIND_MS });
  });
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
    const s = steering(n.tmux, { inbox, uploads });
    expect(await s.send(A, "pc.3fa2c1d0.12", "look", RID, ["u1"])).toEqual({ ok: false, problem: "node_offline" });
    expect(n.keys).toEqual([]);
    expect(store.send(`ep1:${RID}`)).toBeNull();
    offline = false;
    expect(await s.send(A, "pc.3fa2c1d0.12", "look", RID, ["u1"])).toMatchObject({ ok: true });
    expect(n.typed.map(t => t.text)).toEqual(["look\n\n[The owner attached a file: /node/inbox/pasted-1.png]"]);   // the path there
    expect(staged).toEqual(["u1@pc.3fa2c1d0.12", "u1@pc.3fa2c1d0.12"]);
  });
  it("on this machine (the local sink) the note names the inbox path", async () => {
    const n = node();
    expect(await steering(n.tmux, { inbox }).send(A, "%1", "look", RID, ["u1"])).toMatchObject({ ok: true });
    expect(n.typed.map(t => t.text)).toEqual(["look\n\n[The owner attached a file: /hub/inbox/pasted-1.png]"]);
  });
  it("a repeat that comes while the first is still staging waits for it: typed once", async () => {
    const n = node();
    let release: () => void = () => {};
    const gate = new Promise<void>(r => { release = r; });
    const uploads: UploadSink = { stage: async u => { await gate; return { ok: true, path: u.path }; } };
    const s = steering(n.tmux, { inbox, uploads });
    const first = s.send(A, "%1", "look", RID, ["u1"]);
    const repeat = s.send(A, "%1", "look", RID, ["u1"]);
    release();
    expect({ first: await first, repeat: await repeat }).toEqual({
      first: { ok: true, at: HUB_NOW - NODE_BEHIND_MS }, repeat: { ok: false, problem: "duplicate", at: HUB_NOW - NODE_BEHIND_MS },
    });
    expect(n.typed).toHaveLength(1);
  });
});
```

Create `apps/hub/test/escalation-answer-keys.test.ts`. It is spec §9 "Retry and duplicates" (c): the fake node keeps keys the way the agent does. Its last test is round 2's item 3: the key names the ask (the message that asked it), so a question asked again is a new answer, typed again, never swallowed by the first ask's key.

```ts
// An answer carries a key to the asker's node (fleet core §3.1, §9 "Retry and duplicates" (c)): answer:<id>:<ask>:<choice>.
// The node keeps what it typed by key, as the agent does, so an answer retried after the connection dropped once the
// line was pasted is typed once; and a question asked again is a new ask, so the same choice for it is typed again.
// Synthetic list and conversation; a fake node that types, keeps the key, then throws on its first call (the drop).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { endpointId, sessionId, type Message } from "@morndo/domain";
import type { SendProblem } from "@morndo/node-ops";
import { Store } from "../src/adapters/store.ts";
import { ledgerReader } from "../src/adapters/ledger.ts";
import { EscalationService, answerKey } from "../src/application/escalation-service.ts";
import type { Authenticated } from "../src/application/access-service.ts";

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
let manager: Message[] = [];
beforeEach(() => { manager = [asked("m1", T0 - 60_000)]; });

// The node: types, keeps the key's outcome, and on its first `drops` calls drops the connection after the paste (throws).
function node(drops = 1) {
  const typed: { pane: string; text: string; key: string }[] = [];
  const done = new Map<string, SendProblem | null>();
  const send = async (pane: string, text: string, key: string): Promise<SendProblem | null> => {
    if (done.has(key)) return done.get(key) ?? null;                    // typed before: its outcome, not typed again
    typed.push({ pane, text, key });
    done.set(key, null);
    if (drops-- > 0) throw new Error("fleet: connection lost after the paste");
    return null;
  };
  return { send, typed };
}
const service = (send: (pane: string, text: string, key: string) => Promise<SendProblem | null>) => new EscalationService({
  watch: { workers: () => [{ id: "%0", name: "manager" }], history: id => (id === "%0" ? manager : []), openQuestions: () => [], screen: () => undefined },
  ledger: ledgerReader(ledgerPath, () => T0), store, managerName: "manager", now: () => T0, send,
});

describe("an answer retried after the connection dropped", () => {
  it("is typed once: the retry carries the same key and gets the node's outcome; the Decision is recorded once", async () => {
    const n = node();
    const s = service(n.send);
    s.poll();
    await expect(s.answer(auth, "ny-7", { kind: "option", key: "ship" }, "r1")).rejects.toThrow(/connection lost/);
    expect(await s.answer(auth, "ny-7", { kind: "option", key: "ship" }, "r1")).toMatchObject({ ok: true });
    expect(n.typed).toEqual([{ pane: "%0", text: "[tap ny-7] ship (Ship it)", key: "answer:ny-7:m1:option:ship" }]);
    expect(store.audit(10).filter(a => a.type === "EscalationAnswered")).toHaveLength(1);
  });
  it("the key names the ask and the choice; words go by their digest, never as they are", () => {
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

describe("a question asked again", () => {
  it("is a new ask: the same tap is typed once for each ask, never lost to the first one's key", async () => {
    const n = node(0);
    const s = service(n.send);
    s.poll();
    expect(await s.answer(auth, "ny-7", { kind: "option", key: "ship" }, "r1")).toMatchObject({ ok: true });
    manager = [...manager, asked("m2", T0 - 30_000)];                  // the manager asks ny-7 again, a newer message
    s.poll();
    expect(await s.answer(auth, "ny-7", { kind: "option", key: "ship" }, "r2")).toMatchObject({ ok: true });
    expect(n.typed.map(t => t.key)).toEqual(["answer:ny-7:m1:option:ship", "answer:ny-7:m2:option:ship"]);
  });
});
```

- [ ] **Step 2 (A): Run them and see them fail**

Run: `npx vitest run apps/hub/test/steering-keys.test.ts apps/hub/test/escalation-answer-keys.test.ts`
Expected: FAIL, 10 of 10:
- `TypeError: localUploads is not a function` (steering-keys, the five tests on the default sink);
- steering-keys' two tests with a sink of their own: "a stage that fails …" with `AssertionError: expected { ok: false, problem: { …(2) } } to deeply equal { ok: false, problem: 'node_offline' }` (the old service ignores the sink, and takes the port's outcome object for a problem), and "a repeat that comes while the first is still staging …" with `AssertionError: expected { first: { ok: false, …(1) }, …(1) } to deeply equal { first: { ok: true, …(1) }, …(1) }`;
- `TypeError: answerKey is not a function`;
- for "is typed once …": `AssertionError: expected [ { pane: '%0', …(2) } ] to deeply equal [ { pane: '%0', …(2) } ]`, because the key is `undefined`;
- for "is a new ask …": `AssertionError: expected [ undefined ] to deeply equal [ 'answer:ny-7:m1:option:ship', …(1) ]`: without keys the fake node takes the second ask's tap for the first one's and types it once.

- [ ] **Step 3 (A): Implement keys, typedAt and staging**

`apps/hub/src/adapters/migrations.ts`: add as the last element of `MIGRATIONS`, after the `version: 7` entry and before the closing `];` (`:88`):
```ts
  {
    version: 8,
    name: "sends.typed_at: when the node typed it, on its own clock, for matching the echo (fleet core §3.1)",
    up: db => { if (!hasColumn(db, "sends", "typed_at")) db.exec("ALTER TABLE sends ADD COLUMN typed_at INTEGER"); },
  },
```

`apps/hub/src/adapters/store.ts`: replace (`:85-89`)
```ts
  // S5: a request id's record, written "started" before typing and "done" after; kept 24 hours.
  send(key: string): { state: "started" | "done"; at: number } | null {
    const r = this.db.prepare("SELECT state, at FROM sends WHERE key = ?").get(key) as { state: "started" | "done"; at: number } | undefined;
    return r ?? null;
  }
```
with
```ts
  // S5: a request id's record, written "started" before typing and "done" after; kept 24 hours. `typedAt`: the node's
  // own time of the typing (fleet core §3.1), null for a row from before it was kept.
  send(key: string): { state: "started" | "done"; at: number; typedAt: number | null } | null {
    const r = this.db.prepare("SELECT state, at, typed_at FROM sends WHERE key = ?").get(key) as { state: "started" | "done"; at: number; typed_at: number | null } | undefined;
    return r ? { state: r.state, at: r.at, typedAt: r.typed_at } : null;
  }
```
and replace (`:93`)
```ts
  finishSend(key: string) { this.db.prepare("UPDATE sends SET state = 'done', outcome = 'typed' WHERE key = ?").run(key); }
```
with
```ts
  finishSend(key: string, typedAt: number) { this.db.prepare("UPDATE sends SET state = 'done', outcome = 'typed', typed_at = ? WHERE key = ?").run(typedAt, key); }
```

`apps/hub/src/adapters/local-node.ts`: replace `import type { Sessions, Tmux, TranscriptSource } from "../application/ports.ts";` with `import type { Sessions, Tmux, TranscriptSource, UploadSink } from "../application/ports.ts";` and append:
```ts

// An image the principal attached is already on this machine (uploads.ts wrote it to the inbox): its path is the one
// the note names.
export const localUploads = (): UploadSink => ({ stage: async upload => ({ ok: true, path: upload.path }) });
```

Replace the whole of `apps/hub/src/application/steering-service.ts`. `BEFORE_PASTE` and its release (`dropSend`) work as before; the set is of the port's problems now and holds `node_offline` too.
- The `#typing` entry is now set before the first await, so a repeat that arrives while images are being staged waits for that send.
- Images are staged before the text is composed, and a failed stage returns before `startSend`: no row is written and nothing is typed.

```ts
// Sending text into a worker (ADR-0006, AC7): a recently verified session, no menu open, an empty input line,
// each request once, and an audit entry with the text's length and a hash, never the text itself. Images the
// principal attached (S1–S3) travel as notes naming their files after his text: each is first put on the worker's own
// machine (UploadSink, fleet core §3.1), and one that can't be is a refusal before anything is typed.
// ADR-0008 phase C: the dedupe is durable (S5): a request id is recorded "started" before it is typed and "done" after,
// so after a restart a repeat is "duplicate" (done) or "uncertain" (the hub stopped while typing it), never typed twice.
// The same key goes with the text to the node (fleet core §3.1), so a node that typed it already doesn't type it again.
// And a Command is judged on arrival against the needs-you state it was written for (S6): "stale" if that changed.
import { createHash } from "node:crypto";
import { DEFAULT_POLICY, attachable, commandText, mayCommand, type AccessEvent, type AccessPolicy, type AttachRefusal, type Upload } from "@morndo/domain";
import type { SendProblem } from "@morndo/node-ops";
import { ownerFileNote } from "../adapters/attachment-note.ts";
import { localUploads } from "../adapters/local-node.ts";
import type { Inbox } from "../adapters/uploads.ts";
import type { Store } from "../adapters/store.ts";
import type { Authenticated } from "./access-service.ts";
import type { SendOutcome, Tmux, UploadSink } from "./ports.ts";
import { log } from "../adapters/log.ts";

// `at`: when the node typed it, on that node's clock, which its transcript's times are on: the app matches the echo by
// it (fleet core §3.1; before, the hub's own clock, review M2).
export type SendResult =
  | { ok: true; at: number }
  | { ok: false; problem: "duplicate"; at: number }
  | { ok: false; problem: SendProblem | AttachRefusal | "step_up" | "empty" | "too_long" | "uncertain" | "stale" | "too_large" | "node_offline" };

// Refusals that come before anything is pasted (tmux.ts, and a fleet's "node_offline", executed "no"): nothing reached
// the pane, so a retry may type it. A "not_submitted" comes after the paste, and a throw can't tell: those keep their
// row, and a repeat is "uncertain".
const BEFORE_PASTE = new Set<SendOutcome["problem"]>(["no_pane", "menu_open", "no_input_box", "draft_present", "busy", "node_offline"]);

const MAX_TEXT = 8000;

export class SteeringService {
  #store: Store;
  #tmux: Pick<Tmux, "send">;
  #now: () => number;
  #typing = new Map<string, Promise<SendResult>>();          // sends being staged or typed by this process, by request key
  #policy: () => AccessPolicy;
  #inbox: Pick<Inbox, "get"> | null;
  #waitingOn: (workerId: string) => string;
  #nameOf: (workerId: string) => string | null;
  #uploads: UploadSink;

  constructor(
    store: Store, tmux: Pick<Tmux, "send">, now: () => number = Date.now, policy: () => AccessPolicy = () => DEFAULT_POLICY,
    inbox: Pick<Inbox, "get"> | null = null, waitingOn: (workerId: string) => string = () => "none",
    nameOf: (workerId: string) => string | null = () => null, uploads: UploadSink = localUploads(),
  ) {
    this.#nameOf = nameOf;
    this.#inbox = inbox;
    this.#store = store;
    this.#tmux = tmux;
    this.#now = now;
    this.#policy = policy;
    this.#waitingOn = waitingOn;
    this.#uploads = uploads;
  }

  // `seen`: the needs-you state the principal wrote it for ("none", or a question or menu id); absent, no check.
  // `name`: the worker it was written to; a pane that now runs another agent is no longer that worker (review M2).
  async send(a: Authenticated, workerId: string, text: string, requestId: string, uploads: string[] = [], seen?: string, name?: string): Promise<SendResult> {
    const now = this.#now();
    const key = `${a.endpoint.id}:${requestId}`;
    // A repeat first: it may come after the window or the worker moved on, and must still learn what became of it.
    // While this process is still staging or typing it, the repeat waits for the outcome (the web client counts
    // "duplicate" as delivered, so it may only come once the text is in; a refusal is passed on as it is).
    const typing = this.#typing.get(key);
    if (typing) {
      const first = await typing;
      return first.ok ? { ok: false, problem: "duplicate", at: first.at } : first;
    }
    const known = this.#store.send(key);
    if (known?.state === "done") return { ok: false, problem: "duplicate", at: known.typedAt ?? known.at };
    if (known?.state === "started") return { ok: false, problem: "uncertain" };   // the hub stopped while typing it

    if (!mayCommand(a.session, now, this.#policy())) return { ok: false, problem: "step_up" };
    if (seen !== undefined && seen !== this.#waitingOn(workerId)) {
      log.info(`send to ${workerId} refused: stale (written for ${seen === "none" ? "no question" : "another question"})`);
      return { ok: false, problem: "stale" };
    }
    const current = name === undefined ? null : this.#nameOf(workerId);
    if (current !== null && current !== name) {
      log.info(`send to ${workerId} refused: written to another worker than the one there now`);
      return { ok: false, problem: "no_pane" };
    }
    const attached = attachable(uploads, id => this.#inbox?.get(id), a.endpoint.id, now);
    if (!attached.ok) return { ok: false, problem: attached.error };
    // Registered before the first await, so a repeat arriving while the images are staged waits for this one.
    const job = this.#stageAndType(a, key, workerId, text, attached.value, now);
    this.#typing.set(key, job);
    try { return await job; }
    finally { this.#typing.delete(key); }
  }

  // The images go onto the worker's machine first; one that can't be put there is a refusal before anything is typed,
  // with no row written, so a retry may type it.
  async #stageAndType(a: Authenticated, key: string, workerId: string, text: string, uploads: readonly Upload[], now: number): Promise<SendResult> {
    const notes: string[] = [];
    for (const u of uploads) {
      const staged = await this.#uploads.stage(u, workerId);
      if (!staged.ok) {
        log.warn(`send to ${workerId} refused: ${staged.problem} (an attached image couldn't be put on its machine)`);
        return { ok: false, problem: staged.problem };
      }
      notes.push(ownerFileNote(staged.path));
    }
    const body = commandText(text.replace(/\r\n/g, "\n"), notes);
    if (!body) return { ok: false, problem: "empty" };
    if (body.length > MAX_TEXT) return { ok: false, problem: "too_long" };

    if (!this.#store.startSend(key, now)) return { ok: false, problem: "uncertain" };
    const audit = (): AccessEvent => ({
      type: "CommandSent", sessionId: a.session.id, endpointId: a.endpoint.id, workerId,
      length: body.length, digest: createHash("sha256").update(body).digest("hex").slice(0, 16),
      ...(uploads.length ? { attachments: uploads.length } : {}), at: now,
    });
    return this.#type(key, workerId, body, audit);
  }

  async #type(key: string, workerId: string, body: string, audit: () => AccessEvent): Promise<SendResult> {
    let outcome: SendOutcome;
    // A throw may come after the paste: the row stays "started", so a repeat (here, or after a restart) is uncertain
    // and nothing is typed twice. A repeat that was waiting gets the same error.
    try { outcome = await this.#tmux.send(workerId, body, key); }
    catch (e) { log.warn(`send to ${workerId} failed while typing; a repeat will be uncertain`, e); throw e; }
    if (outcome.problem) {
      if (BEFORE_PASTE.has(outcome.problem)) this.#store.dropSend(key);       // nothing reached the pane: a retry may type it
      log.warn(`send to ${workerId} refused: ${outcome.problem}`);             // never the text
      return { ok: false, problem: outcome.problem };
    }
    this.#store.finishSend(key, outcome.typedAt);
    this.#store.record([audit()]);
    return { ok: true, at: outcome.typedAt };
  }
}
```

`apps/hub/src/application/escalation-service.ts`: after `const SETTLED_LEDGER_MS = 3 * 24 * 3_600_000;        // closed list items shown under "Decided" for three days` (`:36`), insert:
```ts

const digest = (words: string) => createHash("sha256").update(words.trim()).digest("hex").slice(0, 16);
// The key an answer carries to the asker's node (fleet core §3.1): one choice for one ask is one key, so a repeat after a
// dropped connection gets the node's outcome of the first instead of the line typed again. The ask is the message that
// asked it (its time when it has none): the same choice for a question asked again is a new answer, typed again. Words
// go by their digest.
export const answerKey = (id: string, ask: { messageId: string | null; askedAt: number }, choice: Choice) =>
  `answer:${id}:${ask.messageId ?? `t${ask.askedAt}`}:${choice.kind === "option" ? `option:${choice.key}` : `words:${digest(choice.text)}`}`;
```
Replace (`:31`) `  | { ok: false; problem: AnswerRefusal | SendProblem | "step_up" | "in_progress" | "too_long" | "changed"; item: EscalationView | null };` with `  | { ok: false; problem: AnswerRefusal | SendProblem | "node_offline" | "step_up" | "in_progress" | "too_long" | "changed"; item: EscalationView | null };` (an answer to a worker on a node that isn't online is refused before anything is typed; http.ts answers it 409, as every other refusal but `step_up`, `unknown` and `no_pane`).
Replace (`:49`) `  #send: (pane: string, text: string) => Promise<SendProblem | null>;` with `  #send: (pane: string, text: string, key: string) => Promise<SendProblem | "node_offline" | null>;`.
Replace (`:67`) `    send: (pane: string, text: string) => Promise<SendProblem | null>; now?: () => number; policy?: () => AccessPolicy;` with `    send: (pane: string, text: string, key: string) => Promise<SendProblem | "node_offline" | null>; now?: () => number; policy?: () => AccessPolicy;`.
Replace (`:259`) `      const problem = await this.#send(e.asker.workerId, line);` with `      const problem = await this.#send(e.asker.workerId, line, answerKey(e.id, e, choice));` (the escalation is its ask: it carries `messageId` and `askedAt`).
Replace (`:269`) `        const words = choice.kind === "words" ? { length: choice.text.trim().length, digest: createHash("sha256").update(choice.text.trim()).digest("hex").slice(0, 16) } : {};` with `        const words = choice.kind === "words" ? { length: choice.text.trim().length, digest: digest(choice.text) } : {};`.

`apps/hub/src/main.ts`:
- Replace the node-ops import (`:16`) `import { denyRoots, paneLock, sessionRegistry, terminalAdapter, tmuxAdapter, type Tmux } from "@morndo/node-ops";` with `import { denyRoots, paneLock, sessionRegistry, terminalAdapter, tmuxAdapter } from "@morndo/node-ops";`, and add `import type { Tmux } from "./application/ports.ts";` after it.
- Replace `import { localSessions, localTmux, localTranscripts } from "./adapters/local-node.ts";` with `import { localSessions, localTmux, localTranscripts, localUploads } from "./adapters/local-node.ts";`.
- Replace
  ```ts
      const tmux = tmuxAdapter({ socket: config.tmuxSocket, session: config.tmuxSession });
  ```
  with
  ```ts
      // Legacy single-host mode (fleet core §10): this machine is the one node, "local".
      const tmux = localTmux(tmuxAdapter({ socket: config.tmuxSocket, session: config.tmuxSession }));
  ```
- Replace
  ```ts
      // Legacy single-host mode (fleet core §10): this machine is the one node, "local". A poll waits for its nodes at
      // most one poll interval.
      const observation = new ObservationService(localTmux(tmux), config.quietAfterMs, Date.now, {
  ```
  with
  ```ts
      // A poll waits for its nodes at most one poll interval.
      const observation = new ObservationService(tmux, config.quietAfterMs, Date.now, {
  ```
- Replace
  ```ts
      const typist: Tmux = !lock ? tmux : { ...tmux, send: (id, text) => (id === managerPane() ? lock(() => tmux.send(id, text)) : tmux.send(id, text)) };
  ```
  with
  ```ts
      const typist: Tmux = !lock ? tmux : {
        ...tmux,
        send: async (id, text, key) => {
          if (id !== managerPane()) return tmux.send(id, text, key);
          const r = await lock(() => tmux.send(id, text, key));
          return r === "busy" ? { problem: "busy", typedAt: Date.now() } : r;
        },
      };
  ```
- Replace
  ```ts
      const steering = new SteeringService(store, typist, Date.now, () => access.policy(), inbox, id => observation.waitingOn(id), id => observation.nameOf(id));
  ```
  with
  ```ts
      const steering = new SteeringService(store, typist, Date.now, () => access.policy(), inbox, id => observation.waitingOn(id), id => observation.nameOf(id), localUploads());
  ```
- Replace
  ```ts
        store, managerName: config.managerWindow, send: (pane, text) => typist.send(pane, text), policy: () => access.policy(),
  ```
  with
  ```ts
        store, managerName: config.managerWindow, send: async (pane, text, key) => (await typist.send(pane, text, key)).problem, policy: () => access.policy(),
  ```

- [ ] **Step 4 (A): Adapt the steering fakes to the keyed send**

In each of `apps/hub/test/inprocess-hub.ts`, `http.test.ts`, `http-crash-fixture.ts`, `desktop-control-idle.test.ts`, `access-idle-sweep.test.ts`, `access-policy-http.test.ts` and `remote-revoke.test.ts`, replace
```ts
captureMany: async () => new Map<string, string | null>(), send: async () => null };
```
with
```ts
captureMany: async () => new Map<string, string | null>(), send: async () => ({ problem: null, typedAt: Date.now() }) };
```
The EscalationService fakes (`send: async () => null`) stay as they are: that dependency still answers a problem or null (its type only widened to `SendProblem | "node_offline" | null`).

`apps/hub/test/steering-durable.test.ts`: replace `import type { SendProblem, Tmux } from "@morndo/node-ops";` with
```ts
import type { SendProblem } from "@morndo/node-ops";
import type { SendOutcome, Tmux } from "../src/application/ports.ts";
```
replace
```ts
  const tmux: Tmux = {
    listWorkers: async () => [],
    capture: async () => "──────\n❯ ",
    send: async (_id, text) => {
      typed.push(text);
      if (outcome === "hang") return new Promise<SendProblem | null>(() => {});   // the hub dies while typing
      if (outcome === "throw") throw new Error("tmux: server exited");
      return outcome;
    },
  };
```
with
```ts
  const tmux: Pick<Tmux, "send"> = {
    send: async (_id, text) => {
      typed.push(text);
      if (outcome === "hang") return new Promise<SendOutcome>(() => {});   // the hub dies while typing
      if (outcome === "throw") throw new Error("tmux: server exited");
      return { problem: outcome, typedAt: now };
    },
  };
```
replace `const steering = (tmux: Tmux, waitingOn: (w: string) => string = () => "none") =>` with `const steering = (tmux: Pick<Tmux, "send">, waitingOn: (w: string) => string = () => "none") =>`, and replace the comment `    // The hub's own time of the first typing comes back, for matching the echo on the hub's clock (review M2).` with `    // The node's own time of the first typing comes back, for matching the echo on its clock (fleet core §3.1).`.

`apps/hub/test/steering-inflight-duplicate.test.ts`: replace `import type { SendProblem, Tmux } from "@morndo/node-ops";` with
```ts
import type { SendProblem } from "@morndo/node-ops";
import type { Tmux } from "../src/application/ports.ts";
```
and replace
```ts
  const tmux: Tmux = {
    listWorkers: async () => [],
    capture: async () => "──────\n❯ ",
    async send(_id, text) {
      typed.push(text);
      if (typed.length > 1) return null;
      started();
      await done;
      return first;
    },
  };
```
with
```ts
  const tmux: Pick<Tmux, "send"> = {
    async send(_id, text) {
      typed.push(text);
      if (typed.length > 1) return { problem: null, typedAt: now };
      started();
      await done;
      return { problem: first, typedAt: now };
    },
  };
```

`apps/hub/test/steering-throw-retry.test.ts`: replace `import type { Tmux } from "@morndo/node-ops";` with `import type { Tmux } from "../src/application/ports.ts";`, replace
```ts
  const tmux: Tmux = {
    listWorkers: async () => [],
    capture: async () => "──────\n❯ ",
    async send(_id, text) {
      typed.push(text);
      if (typed.length === 1) throw new Error("tmux exited 1");
      return null;
    },
  };
```
with
```ts
  const tmux: Pick<Tmux, "send"> = {
    async send(_id, text) {
      typed.push(text);
      if (typed.length === 1) throw new Error("tmux exited 1");
      return { problem: null, typedAt: now };
    },
  };
```
and replace
```ts
    const tmux: Tmux = { listWorkers: async () => [], capture: async () => "──────\n❯ ", async send(_id, text) { typed.push(text); return null; } };
```
with
```ts
    const tmux: Pick<Tmux, "send"> = { async send(_id, text) { typed.push(text); return { problem: null, typedAt: now }; } };
```

`apps/hub/test/steering.test.ts`: before `import { SteeringService } from "../src/application/steering-service.ts";` add `import { localTmux } from "../src/adapters/local-node.ts";`. After `const SOCKET = \`morndo-steer-${process.pid}\`;` add
```ts
// The hub's port onto this machine's tmux, as main.ts builds it in legacy mode.
const typist = () => localTmux(tmuxAdapter({ socket: SOCKET, session: null }));
```
and in all 8 places replace `new SteeringService(store, tmuxAdapter({ socket: SOCKET, session: null }),` with `new SteeringService(store, typist(),`.

`apps/hub/test/tmux-no-input-box.test.ts`: add `import { localTmux } from "../src/adapters/local-node.ts";` among the imports, and in both places (`:48`, `:55`) replace `new SteeringService(store, tmuxAdapter({ socket: SOCKET, session: null }),` with `new SteeringService(store, localTmux(tmuxAdapter({ socket: SOCKET, session: null })),`.

- [ ] **Step 5 (A): Run the tests and see them pass, then the full hub suite**

Run: `npx vitest run apps/hub/test/steering-keys.test.ts apps/hub/test/escalation-answer-keys.test.ts apps/hub/test/steering-durable.test.ts apps/hub/test/steering-inflight-duplicate.test.ts apps/hub/test/steering-throw-retry.test.ts`
Expected: PASS, 5 files, 25 tests.

Then each on its own: `npx vitest run apps/hub packages apps/web`, `npm run check`, `npm run lint`.
Expected: vitest: every file PASSES but `packages/node-ops/test/pane-lock.test.ts` on macOS (as in Task 4): 133 files, 1031 tests, 2 failed. `check` exits 0; `lint` reports nothing.

- [ ] **Step 6 (A): Commit**

```bash
git add apps/hub/src apps/hub/test
git commit -m "feat(hub): keyed sends, the node's typing time and staged uploads"
```

- [ ] **Step 7 (A): Negative controls: an answer without a stable key is typed twice, a key that doesn't name the ask loses the second ask's answer, and a kept `node_offline` row blocks the retry**

In `apps/hub/src/application/escalation-service.ts` temporarily replace `answerKey(e.id, e, choice)` in the `#send` call with `` `${answerKey(e.id, e, choice)}:${Math.random()}` ``.
Run: `npx vitest run apps/hub/test/escalation-answer-keys.test.ts`
Expected: FAIL in "is typed once …" with `AssertionError: expected [ { pane: '%0', …(2) }, …(1) ] to deeply equal [ { pane: '%0', …(2) } ]` (typed twice), and in "is a new ask …" with `AssertionError: expected [ …(2) ] to deeply equal [ 'answer:ny-7:m1:option:ship', …(1) ]` (its keys carry the suffix).
Restore it: `git checkout -- apps/hub/src/application/escalation-service.ts`.

Then the key that names the ask (round 2, item 3): temporarily replace `answerKey(e.id, e, choice)` in the `#send` call with `answerKey(e.id, { messageId: null, askedAt: 0 }, choice)`, a key that is the same for every ask of `ny-7`, as the first version's was.
Run: `npx vitest run apps/hub/test/escalation-answer-keys.test.ts -t "asked again"`
Expected: FAIL with `AssertionError: expected [ 'answer:ny-7:t0:option:ship' ] to deeply equal [ 'answer:ny-7:m1:option:ship', …(1) ]`: the second ask's tap reached the node with the first one's key, and the node answered the stored outcome instead of typing it.
Restore it: `git checkout -- apps/hub/src/application/escalation-service.ts`.

Then the release of a node that isn't online: in `apps/hub/src/application/steering-service.ts` temporarily replace `"busy", "node_offline"]);` (in `BEFORE_PASTE`) with `"busy"]);`.
Run: `npx vitest run apps/hub/test/steering-keys.test.ts`
Expected: FAIL in "a node that isn't online refuses before the paste …" with `AssertionError: expected { state: 'started', …(2) } to be null` (the row kept, so the retry would be "uncertain").
Restore it: `git checkout -- apps/hub/src/application/steering-service.ts`.

- [ ] **Step 8 (B): Write the failing tests for background copies and pending attachments**

`apps/hub/test/files.test.ts`:
- Replace the header and the `node:fs` import
  ```ts
  // The hub's file copies: what is kept, what is refused, and how a copy is served.
  import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
  ```
  with
  ```ts
  // The hub's file copies: what is kept, what is refused, and how a copy is served. Copies are made in the background
  // (fleet core §3.1): register() answers once its copy has landed.
  import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
  ```
- Replace the whole `describe("keeping copies", () => {` block (`:18-68`, with Task 2's test of the deny list in it) with:
```ts
describe("keeping copies", () => {
  it("keeps one content-addressed copy, still served after the original is gone", async () => {
    writeFileSync(join(work, "a.png"), "png-bytes");
    writeFileSync(join(work, "same.png"), "png-bytes");
    const s = store();
    const a = await s.register(join(work, "a.png"));
    expect(a.id).toMatch(/^[0-9a-f]{32}$/);
    expect((await s.register(join(work, "same.png"))).id).toBe(a.id);      // same bytes, one copy
    expect(storedIds(join(data, "files"))).toEqual([a.id]);
    unlinkSync(join(work, "a.png"));
    expect((await store().register(join(work, "a.png"))).id).toBe(a.id);    // after a restart, from the index
    expect(store().get(a.id ?? "")?.meta).toMatchObject({ name: "a.png", mime: "image/png", kind: "image", size: 9 });
  });
  it("copies in the background: register answers a promise, and the event loop goes on while a big file copies", async () => {
    writeFileSync(join(work, "big.bin"), Buffer.alloc(8 << 20, 1));
    const copying = store().register(join(work, "big.bin"));
    expect(copying).toBeInstanceOf(Promise);
    let ticked = false;
    setImmediate(() => { ticked = true; });
    expect((await copying).id).toMatch(/^[0-9a-f]{32}$/);
    expect(ticked).toBe(true);                                             // the loop ran while the copy was made
  });
  it("one path registered twice at once: one copy, both get it, and no temporary file is left", async () => {
    writeFileSync(join(work, "big.bin"), Buffer.alloc(4 << 20, 7));
    const s = store();
    const [one, two] = await Promise.all([s.register(join(work, "big.bin")), s.register(join(work, "big.bin"))]);
    expect(one.id).toMatch(/^[0-9a-f]{32}$/);
    expect(two).toEqual(one);
    expect(one.size).toBe(4 << 20);
    expect(readdirSync(join(data, "files")).filter(f => f !== "index.json")).toEqual([one.id]);
  });
  it("refuses credentials, the hub's own data, secrets by name, links into them, directories and big files", async () => {
    writeFileSync(join(home, ".ssh", "id_ed25519"), "key");
    writeFileSync(join(work, ".env"), "TOKEN=x");
    writeFileSync(join(work, "server.pem"), "pem");
    writeFileSync(join(data, "morndo.db"), "db");
    symlinkSync(join(home, ".ssh", "id_ed25519"), join(work, "innocent.png"));
    writeFileSync(join(work, "big.bin"), Buffer.alloc(2048));
    const s = store({ maxBytes: 1024 });
    for (const p of [join(home, ".ssh", "id_ed25519"), join(work, ".env"), join(work, "server.pem"), join(data, "morndo.db"), join(work, "innocent.png"), work, join(work, "big.bin"), join(work, "missing.png")]) {
      expect((await s.register(p)).id, p).toBeNull();
    }
    expect(storedIds(join(data, "files"))).toEqual([]);
    writeFileSync(join(work, "ok.txt"), "fine");
    expect((await s.register(join(work, "ok.txt"))).id).not.toBeNull();     // negative control: a plain file is kept
  });
  it("refuses the fleet's, the agents' and kira's state and each account's credentials, as a node does (node-ops' deny list)", async () => {
    const at = (rel: string) => { const p = join(home, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, "x"); return p; };
    const s = store();
    for (const rel of [".local/share/morndo-fleet/fleet.db", ".local/state/morndo-node/agent.db", ".config/morndo-node/policy.json", ".local/share/kira/state.json",
      ".claude-accounts/acct2/.credentials.json"]) {
      expect((await s.register(at(rel))).id, rel).toBeNull();
    }
    expect((await s.register(at(".local/share/other/ok.txt"))).id).not.toBeNull();   // negative control: a neighbour of theirs is kept
  });
  it("drops the oldest copies once over its budget", async () => {
    const s = store({ budgetBytes: 10 });
    writeFileSync(join(work, "one.txt"), "123456");
    const one = (await s.register(join(work, "one.txt"))).id;
    writeFileSync(join(work, "two.txt"), "abcdef");
    const two = (await s.register(join(work, "two.txt"))).id;
    expect(s.get(one ?? "")).toBeNull();
    expect(s.get(two ?? "")).not.toBeNull();
  });
  it("serves only ids it holds", () => {
    expect(store().get("../../etc/passwd")).toBeNull();
    expect(store().get("0".repeat(32))).toBeNull();
  });
});
```

Create `apps/hub/test/observation-attachments.test.ts`:

```ts
// Files in a conversation are copied in the background (fleet core §3.1): a message shows its attachment as pending
// until the copy lands, then whoever watches that worker gets the message's attachments again. Synthetic transcript;
// a fake file store whose copies land when the test says.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionRegistry } from "@morndo/node-ops";
import { localSessions, localTranscripts } from "../src/adapters/local-node.ts";
import { ObservationService, type Listener } from "../src/application/observation-service.ts";
import type { RemoteFiles } from "../src/application/ports.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-attach-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const T = "2026-10-06T08:00:00.000Z";
const ID = "a".repeat(32);
const said = (uuid: string, text: string) => JSON.stringify({ type: "user", uuid, timestamp: T, origin: { kind: "human" }, message: { role: "user", content: text } });

// A worker %1 whose transcript holds `lines`; `files` is the hub's copier.
function setup(lines: string[], files: RemoteFiles) {
  mkdirSync(join(dir, "sessions"));
  mkdirSync(join(dir, "projects", "-w"), { recursive: true });
  writeFileSync(join(dir, "sessions", "1.json"), JSON.stringify({ pid: process.pid, sessionId: "s1", tmux: "qa:@0.%1", name: "builder", cwd: "/w", version: "2.1.286", updatedAt: 1 }));
  writeFileSync(join(dir, "projects", "-w", "s1.jsonl"), lines.join("\n") + "\n");
  const registry = sessionRegistry(dir);
  const svc = new ObservationService(
    { listWorkers: async () => [{ id: "%1", name: "builder", location: "w", node: "local", offline: false }], captureMany: async ids => new Map(ids.map(id => [id, "❯ "])) },
    60_000, Date.now, { sessions: localSessions(registry), transcripts: localTranscripts(registry), files },
  );
  // What the watcher was sent, as it was at that moment (the messages are the service's own objects, changed later).
  const sent: { t: string; body: unknown }[] = [];
  const keep = (t: string, body: unknown) => sent.push({ t, body: JSON.parse(JSON.stringify(body)) as unknown });
  const listener: Listener = {
    events: () => {}, screen: () => {}, watching: () => "%1",
    history: (_w, ms) => keep("history", ms.map(m => m.attachments ?? [])),
    messages: (_w, ms) => keep("messages", ms.map(m => m.attachments ?? [])),
    attachments: (w, message, attachments) => keep("attachments", { w, message, attachments }),
  };
  svc.subscribe(listener);
  return { svc, sent };
}
// A copier whose copies land when release() is called; the paths it was asked for, with their worker.
function slowFiles(result: { id: string | null; size: number | null } | Error) {
  const asked: string[] = [];
  let release: () => void = () => {};
  const landed = new Promise<void>(r => { release = r; });
  const files: RemoteFiles = {
    register: async (workerId, path) => {
      asked.push(`${workerId}:${path}`);
      await landed;
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { files, asked, release };
}
const settle = () => new Promise(r => setTimeout(r, 20));
const photo = { name: "pasted-1.png", mime: "image/png", kind: "image", caption: null };

describe("a file in a message is copied in the background", () => {
  it("pending until the copy lands, then the watcher gets the message's attachments with the copy's id", async () => {
    const f = slowFiles({ id: ID, size: 9 });
    const { svc, sent } = setup([said("u1", "Look\n\n[The owner attached a file: /inbox/pasted-1.png]")], f.files);
    await svc.poll();
    expect(sent).toEqual([{ t: "history", body: [[{ ...photo, id: null, size: null, pending: true }]] }]);
    expect(f.asked).toEqual(["%1:/inbox/pasted-1.png"]);
    f.release();
    await settle();
    expect(sent.at(-1)).toEqual({ t: "attachments", body: { w: "%1", message: "u1", attachments: [{ ...photo, id: ID, size: 9 }] } });
    expect(svc.history("%1")[0]?.attachments).toEqual([{ ...photo, id: ID, size: 9 }]);   // and the conversation has it
  });
  it("a copy that fails ends pending as not available (id null), and the watcher is told so", async () => {
    const f = slowFiles(new Error("fleet: node_offline"));
    const { svc, sent } = setup([said("u1", "Look\n\n[The owner attached a file: /inbox/pasted-1.png]")], f.files);
    await svc.poll();
    f.release();
    await settle();
    expect(sent.at(-1)).toEqual({ t: "attachments", body: { w: "%1", message: "u1", attachments: [{ ...photo, id: null, size: null }] } });
  });
  it("an older page waits for copies that land at once; one still copying after 1 s goes out pending, and its frame follows", async () => {
    let release: () => void = () => {};
    const landed = new Promise<void>(r => { release = r; });
    const files: RemoteFiles = { register: async (_w, path) => { if (path.endsWith("slow.png")) await landed; return { id: ID, size: 9 }; } };
    const { svc, sent } = setup([
      said("u0", "first\n\n[The owner attached a file: /inbox/p0.png]"), said("u1", "second\n\n[The owner attached a file: /inbox/slow.png]"), said("u2", "latest"),
    ], files);
    await svc.poll();
    await settle();
    sent.length = 0;
    const page = await svc.older("%1", "u2");
    expect(page.messages.map(m => [m.id, m.attachments?.[0]?.id ?? null, m.attachments?.[0]?.pending ?? false])).toEqual([["u0", ID, false], ["u1", null, true]]);
    expect(sent).toEqual([]);
    release();
    await settle();
    const frames = sent.filter(x => x.t === "attachments").map(x => x.body as { message: string; attachments: { id: string | null }[] });
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every(x => x.message === "u1" && x.attachments[0]?.id === ID)).toBe(true);
  });
});
```

`apps/hub/test/local-node.test.ts`: replace `import { workerId } from "@morndo/domain";` with `import { endpointId, workerId } from "@morndo/domain";`, replace `import { LOCAL_NODE, localSessions, localTmux, localTranscripts } from "../src/adapters/local-node.ts";` with `import { LOCAL_NODE, localFiles, localSessions, localTmux, localTranscripts, localUploads } from "../src/adapters/local-node.ts";`, and append:
```ts

describe("localUploads and localFiles", () => {
  it("an image the principal attached is on this machine already: staged, it is its inbox path", async () => {
    const upload = { id: "u1", endpointId: endpointId("ep1"), path: "/home/me/.cache/morndo/inbox/pasted-1.png", mime: "image/png" as const, size: 4, at: 1 };
    expect(await localUploads().stage(upload, "%1")).toEqual({ ok: true, path: upload.path });
  });
  it("a file a worker names is copied by the hub's own store, by its path", async () => {
    const asked: string[] = [];
    const files = localFiles({ register: async path => { asked.push(path); return { id: "a".repeat(32), size: 3 }; } });
    expect(await files.register("%1", "/w/out.png")).toEqual({ id: "a".repeat(32), size: 3 });
    expect(asked).toEqual(["/w/out.png"]);
  });
});
```

Append to `packages/protocol/test/protocol.test.ts`:
```ts

describe("files copied in the background (fleet core §3.1)", () => {
  const photo = { name: "p.png", mime: "image/png", kind: "image", size: null, caption: null };
  it("an attachment may be pending (no id yet); pending is only ever true", () => {
    const d = decode(ServerFeedFrames, JSON.stringify({ t: "messages", worker: "%1", messages: [{ ...message, attachments: [{ ...photo, id: null, pending: true }, { ...photo, id: null, pending: false }] }] }));
    expect(d.kind === "ok" && d.frame.t === "messages" ? d.frame.messages[0]?.attachments : null).toEqual([{ ...photo, id: null, pending: true }]);
  });
  it("the attachments frame: a message's files once their copies landed", () => {
    const f = { t: "attachments", worker: "%1", message: "u1", attachments: [{ ...photo, id: "a".repeat(32), size: 9 }] };
    expect(decode(ServerFeedFrames, JSON.stringify(f))).toEqual({ kind: "ok", frame: f });
    expect(kind(decode(ServerFeedFrames, JSON.stringify({ ...f, message: 7 })))).toBe("malformed");
  });
});
```

Create `apps/web/test/attachments-web.test.ts`:

```ts
// A file still being copied (fleet core §3.1): the message shows it as copying, and the hub's attachments frame turns it
// into the file once the copy landed. The real Desktop in headless Chromium, the fake feed of harness.ts.
import type { Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { fakeFeed, startWeb, type FeedWin, type Web } from "./harness.ts";

const T0 = Date.UTC(2026, 9, 6, 8);
const ID = "a".repeat(32);
const photo = { name: "pasted-1.png", mime: "image/png", kind: "image", caption: null };
const pendingMessage = { id: "u1", at: T0, author: { kind: "principal", name: "You" }, kind: "text", text: "Look at this", attachments: [{ ...photo, id: null, size: null, pending: true }] };

let web: Web;
let tab: Page;
beforeAll(async () => { web = await startWeb(); }, 60_000);
afterAll(async () => { await web?.close(); });
afterEach(async () => { await tab.context().close(); });

const push = (m: unknown) => tab.evaluate(x => (globalThis as unknown as FeedWin).__feedPush(x), m);

describe("a file being copied", () => {
  it("shows as copying, then as the file once the attachments frame comes; a frame for another worker changes nothing", { timeout: 30_000 }, async () => {
    const context = await web.browser.newContext({ viewport: { width: 1600, height: 900 } });
    tab = await context.newPage();
    const errors: string[] = [];
    tab.on("pageerror", e => errors.push(e.message));
    await tab.addInitScript(fakeFeed, { workers: [{ id: "%0", name: "manager" }, { id: "%1", name: "alpha" }], history: { "%1": [pendingMessage] } });
    await tab.goto(web.url);
    await tab.locator("button.row", { hasText: "alpha" }).first().click();
    await tab.getByText("Copying from its machine…").waitFor({ timeout: 5000 });
    expect(await tab.locator(`img[src="/api/files/${ID}"]`).count()).toBe(0);
    await push({ t: "attachments", worker: "%0", message: "u1", attachments: [{ ...photo, id: ID, size: 9 }] });   // not the one watched
    await new Promise(r => setTimeout(r, 200));
    expect(await tab.getByText("Copying from its machine…").count()).toBe(1);
    await push({ t: "attachments", worker: "%1", message: "u1", attachments: [{ ...photo, id: ID, size: 9 }] });
    await tab.locator(`img[src="/api/files/${ID}"]`).waitFor({ timeout: 5000 });
    expect(await tab.getByText("Copying from its machine…").count()).toBe(0);
    expect(errors).toEqual([]);
  });
});
```

- [ ] **Step 9 (B): Run them and see them fail**

Run: `npx vitest run apps/hub/test/files.test.ts apps/hub/test/observation-attachments.test.ts apps/hub/test/local-node.test.ts packages/protocol/test/protocol.test.ts apps/web/test/attachments-web.test.ts`
Expected: FAIL, 8 tests:
- files: `AssertionError: expected { …(2) } to be an instance of Promise`;
- observation-attachments: 3 failures (the history shows `id: null` with no `pending`, and no `attachments` call);
- local-node: `TypeError: localFiles is not a function`;
- protocol: 2 failures;
- attachments-web: `TimeoutError: locator.waitFor: Timeout 5000ms exceeded`, waiting for "Copying from its machine…".

(The old service also logs `TypeError: Cannot read properties of undefined (reading 'endsWith')` for the new register's arguments: noise of the red state.)

- [ ] **Step 10 (B): Implement background copies and pending attachments**

`packages/domain/src/conversation.ts`: replace (`:7-9`)
```ts
// `id` names that copy, and is null when there is none (the file was gone, too big, or in a place never shared).
export type AttachmentKind = "image" | "video" | "audio" | "pdf" | "text" | "file";
export type Attachment = { id: string | null; name: string; mime: string; kind: AttachmentKind; size: number | null; caption: string | null };
```
with
```ts
// `id` names that copy, and is null when there is none (the file was gone, too big, or in a place never shared).
// `pending`: the copy is still being made (fleet core §3.1); `id` is null until it lands.
export type AttachmentKind = "image" | "video" | "audio" | "pdf" | "text" | "file";
export type Attachment = { id: string | null; name: string; mime: string; kind: AttachmentKind; size: number | null; caption: string | null; pending?: true };
```

`packages/protocol/src/feed.ts`: replace (`:76-80`)
```ts
// An attachment's id names the hub's copy and goes into a URL: exactly 32 hex digits, or none.
const AttachmentSchema = z.object({
  id: z.nullable(z.string().check(z.regex(/^[0-9a-f]{32}$/))), name: text(), mime: text(),
  kind: orElse(z.enum(["image", "video", "audio", "pdf", "text", "file"]), "file"), size: z.nullable(count()), caption: z.nullable(text()),
});
```
with
```ts
// An attachment's id names the hub's copy and goes into a URL: exactly 32 hex digits, or none. `pending`: that copy is
// still being made; an app from before it (z.object drops keys it doesn't know) shows "not available" until the
// attachments frame below comes.
const AttachmentSchema = z.object({
  id: z.nullable(z.string().check(z.regex(/^[0-9a-f]{32}$/))), name: text(), mime: text(),
  kind: orElse(z.enum(["image", "video", "audio", "pdf", "text", "file"]), "file"), size: z.nullable(count()), caption: z.nullable(text()),
  pending: z.exactOptional(z.literal(true)),
});
```
and after `  caught_up: z.object({ t: z.literal("caught_up"), at: z.nullable(count()) }),` (`:176`, the last entry of `ServerFeedFrames`) add:
```ts
  // Fleet core §3.1: a message's files, once the hub's copies of them were made (they showed as pending): they replace
  // that message's attachments, wherever the app holds it (the latest messages or an older page). An app from before
  // this frame ignores it, as any frame type it doesn't know.
  attachments: z.object({ t: z.literal("attachments"), worker: workerId, message: text(), attachments: each(AttachmentSchema, "attachment") }),
```
(The `check<Same<z.output<typeof MessageSchema>, Message>>` at `:212` keeps the domain type and the schema equal.)

`apps/hub/src/adapters/files.ts`:
- Replace the two import lines (`:7-8`)
  ```ts
  import { createHash } from "node:crypto";
  import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
  ```
  with
  ```ts
  // A copy is made in the background (fleet core §3.1): register() answers once it has landed, and the event loop is never
  // blocked by a 25 MiB read (stream.pipeline with an async generator: https://nodejs.org/docs/latest-v24.x/api/stream.html#streampipelinesource-transforms-destination-options, read 2026-10-06).
  import { createHash, randomUUID } from "node:crypto";
  import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
  import { realpath, rename, rm, stat } from "node:fs/promises";
  ```
- Add `import { pipeline } from "node:stream/promises";` after the `node:path` import.
- Replace `  register(path: string): { id: string | null; size: number | null };` (`:16`) with `  register(path: string): Promise<{ id: string | null; size: number | null }>;`.
- Replace the `register(path) { … },` member of the returned object (`:50-66`) with `    register,`, and put this function right before that `return {`:
```ts
  // The bytes pass once through SHA-256 on their way into a temporary file, which then becomes the copy named by the
  // hash (or goes, when that copy is there already). A file that grows past the cap while it is read is refused.
  async function register(path: string): Promise<{ id: string | null; size: number | null }> {
    const known = index.byPath[path];
    let real: string;
    let st: Stats;
    try { real = await realpath(path); st = await stat(real); }
    catch { return known && index.meta[known.id] ? { id: known.id, size: known.size } : { id: null, size: null }; }   // gone: the copy, if any
    if (!st.isFile() || st.size > maxBytes || denied(real) || denied(path)) return { id: null, size: st.isFile() ? st.size : null };
    if (known && known.size === st.size && known.mtimeMs === st.mtimeMs && index.meta[known.id]) return { id: known.id, size: known.size };
    const tmp = join(opts.dir, `.incoming-${randomUUID()}`);
    const hash = createHash("sha256");
    let size = 0;
    try {
      await pipeline(createReadStream(real), async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          size += chunk.length;
          if (size > maxBytes) throw new Error("the file grew past the size cap while it was copied");
          hash.update(chunk);
          yield chunk;
        }
      }, createWriteStream(tmp, { mode: 0o600 }));
    } catch {
      await rm(tmp, { force: true });
      return { id: null, size: size > maxBytes ? size : null };
    }
    const id = hash.digest("hex").slice(0, 32);
    const dest = join(opts.dir, id);
    if (existsSync(dest)) await rm(tmp, { force: true });
    else await rename(tmp, dest);
    index.meta[id] ??= { id, size, ...describeFile(path) };
    index.byPath[path] = { id, size, mtimeMs: st.mtimeMs };
    prune();
    save();
    return index.meta[id] ? { id, size } : { id: null, size };
  }
```

`apps/hub/src/adapters/local-node.ts`: replace `import type { Sessions, Tmux, TranscriptSource, UploadSink } from "../application/ports.ts";` with
```ts
import type { RemoteFiles, Sessions, Tmux, TranscriptSource, UploadSink } from "../application/ports.ts";
import type { Files } from "./files.ts";
```
and append:
```ts

// A file a worker here names is on this machine: the hub's file store copies it (files.ts).
export const localFiles = (files: Pick<Files, "register">): RemoteFiles => ({ register: (_workerId, path) => files.register(path) });
```

`apps/hub/src/application/observation-service.ts`. The complete file after this step is shown at the end of this step; the edits are:
- Replace the domain import with `import { Conversation, Feed, Roster, needsYou, waitingOn, workerId, type Attachment, type ConversationEntry, type FeedBody, type FeedEvent, type Message, type RosterEntry } from "@morndo/domain";`.
- Delete `import type { Files } from "../adapters/files.ts";`.
- Replace the ports import with `import { SourceUnavailable, type NodeStates, type RemoteFiles, type Sessions, type Tmux, type TranscriptSource } from "./ports.ts";`.
- After `const MISSING: OlderResult = …;` add `const OLDER_COPY_WAIT_MS = 1000;                       // an older page waits this long for its files' copies, at most`.
- In `Listener`, before `  watching(): string | null;` add:
  ```ts
    // A message's files once their copies were made (they showed as pending): they replace that message's attachments.
    attachments?(workerId: string, messageId: string, attachments: Attachment[]): void;
  ```
- In `ObservationSources` and in the field declarations, replace `Pick<Files, "register">` with `RemoteFiles` (two places).
- In `older()`, replace `      this.#attachCopies(page.messages, page.files);` with:
  ```ts
        // A copy made already comes back at once; one still being made goes out pending, and the watcher is told once it
        // lands (only then: what landed while waiting goes out with the page).
        const shown = { now: false };
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([this.#attachCopies(id, page.messages, page.files, shown), new Promise<void>(r => { timer = setTimeout(r, OLDER_COPY_WAIT_MS); })]);
        clearTimeout(timer);
        shown.now = true;
  ```
- Replace the whole `#attachCopies` method (comment included) with:
  ```ts
    // Files a message carries: the hub keeps its own copy (files.ts); the message names it by id, never by path. Copies are
    // made in the background (fleet core §3.1): until one lands its attachment is `pending`, and once all of a message's
    // copies have landed, whoever watches that worker gets its attachments again, if the message was out by then
    // (`shown`; a live message may be, from the moment it is read). Resolves then; never rejects.
    #attachCopies(workerId: string, entries: readonly ConversationEntry[], refs: readonly FileRef[], shown = { now: true }): Promise<void> {
      const files = this.#files;
      if (!files) return Promise.resolve();
      const messages: Promise<void>[] = [];
      for (const ref of refs) {
        const m = entries.find(e => e.id === ref.messageId);
        if (!m || m.kind === "answer" || !m.attachments) continue;
        const message = m;
        const copies = ref.paths.flatMap((p, i) => {
          const a = message.attachments?.[i];
          if (!a) return [];
          a.pending = true;
          return [files.register(workerId, p)
            .then(r => { a.id = r.id; a.size = r.size; }, (e: unknown) => { log.warn(`a file in ${workerId}'s conversation wasn't copied: ${(e as Error).message}`); })
            .finally(() => { delete a.pending; })];
        });
        if (!copies.length) continue;
        messages.push(Promise.all(copies)
          .then(() => {
            if (!shown.now) return;
            for (const l of this.#listeners) if (l.watching() === workerId) l.attachments?.(workerId, message.id, message.attachments ?? []);
          })
          .catch((e: unknown) => { log.warn(`telling a watcher about ${workerId}'s files failed`, e); }));
      }
      return Promise.all(messages).then(() => {});
    }
  ```
- In `#pollNode`, replace `        this.#attachCopies(parsed.entries, parsed.files);` with `        void this.#attachCopies(id, parsed.entries, parsed.files);      // in the background: the round doesn't wait`.

The whole file after this step:

```ts
// Application service for the Observation context: polls the multiplexer, feeds the domain Roster and Feed,
// and tells subscribers what changed. Screens go only to the endpoints that watch that worker (latest state only).
// Workers live on nodes (fleet core §3.1). Each poll lists them once, then works through every node at the same time:
// one captureMany for its screens, then its followed transcripts. It waits at most `nodeWaitMs` for them. A node still
// busy from an earlier poll, or not online, is skipped, so a slow node never holds up the others; what a node brings
// after the poll stopped waiting is applied by the next poll.
import { randomUUID } from "node:crypto";
import { Conversation, Feed, Roster, needsYou, waitingOn, workerId, type Attachment, type ConversationEntry, type FeedBody, type FeedEvent, type Message, type RosterEntry } from "@morndo/domain";
import { menuIdentity, menuOnScreen, type SessionInfo } from "@morndo/node-ops";
import { followTranscript, olderPage, type FileRef, type TranscriptCursor } from "../adapters/claude-sessions.ts";
import { log } from "../adapters/log.ts";
import { SourceUnavailable, type NodeStates, type RemoteFiles, type Sessions, type Tmux, type TranscriptSource } from "./ports.ts";

type Followed = { sessionId: string; cursor: TranscriptCursor; conversation: Conversation; title: string | null };

// What one node's round brought: its screens, the messages its transcripts added (with the follow they went into, so a
// follow rebuilt meanwhile doesn't take another's), and the follows that are new this round.
type NodeRound = { screens: Map<string, string | null>; added: Map<string, { follow: Followed; messages: Message[] }>; rebuilt: Set<string> };

export type Snapshot = { epoch: string; seq: number; workers: RosterEntry[] };
export type OlderResult = { messages: Message[]; done: boolean; missing?: true };
const MISSING: OlderResult = { messages: [], done: false, missing: true };
const OLDER_COPY_WAIT_MS = 1000;                       // an older page waits this long for its files' copies, at most

export type Listener = {
  events(events: FeedEvent[]): void;
  screen(workerId: string, text: string, at: number): void;
  messages(workerId: string, messages: Message[]): void;   // new messages, appended to what the watcher holds
  history(workerId: string, messages: Message[]): void;    // replaces what the watcher holds (a follow was rebuilt)
  // A message's files once their copies were made (they showed as pending): they replace that message's attachments.
  attachments?(workerId: string, messageId: string, attachments: Attachment[]): void;
  watching(): string | null;
};

// Where the service reads from besides tmux. Each is optional: a hub without a Claude config dir follows no transcripts.
// `nodeWaitMs`: how long a poll waits for its nodes before it goes on without the slow ones (main.ts: the poll interval).
export type ObservationSources = {
  sessions?: Sessions | null;
  transcripts?: TranscriptSource | null;
  files?: RemoteFiles | null;
  nodeStates?: NodeStates | null;
  nodeWaitMs?: number;
};

export class ObservationService {
  readonly feed = new Feed(randomUUID(), 2000);
  #roster: Roster;
  #tmux: Pick<Tmux, "listWorkers" | "captureMany">;
  #listeners = new Set<Listener>();
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  #busy = false;
  #now: () => number;
  #sessions: Sessions | null;
  #transcripts: TranscriptSource | null;
  #files: RemoteFiles | null;
  #nodeStates: NodeStates | null;
  #nodeWaitMs: number;
  #followed = new Map<string, Followed>();             // worker ID → its session's conversation
  #panes = new Map<string, SessionInfo>();
  #panesAt = 0;
  #nodeOf = new Map<string, string>();                 // worker ID → its node, from the last listing
  #working = new Set<string>();                        // nodes whose round is still running
  #arrived: NodeRound[] = [];                          // rounds done and not yet applied

  constructor(tmux: Pick<Tmux, "listWorkers" | "captureMany">, quietAfterMs: number, now: () => number = Date.now, o: ObservationSources = {}) {
    this.#tmux = tmux;
    this.#roster = new Roster(quietAfterMs);
    this.#now = now;
    this.#sessions = o.sessions ?? null;
    this.#transcripts = o.transcripts ?? null;
    this.#files = o.files ?? null;
    this.#nodeStates = o.nodeStates ?? null;
    this.#nodeWaitMs = o.nodeWaitMs ?? 1000;
  }

  history(id: string, n = 150): Message[] { return this.#followed.get(id)?.conversation.latest(n) ?? []; }
  openQuestions(id: string): Message[] { return this.#followed.get(id)?.conversation.openQuestionMessages() ?? []; }
  session(id: string): SessionInfo | undefined { return this.#panes.get(id); }

  // An older page of a worker's conversation (ADR-0008 phase D, O9): read from its transcript on demand for the
  // Endpoint that asked, never kept here (O5's 300 is unchanged). The files those messages carry get the hub's copies.
  // The source finds the message asked for itself (locate), so no page starts are remembered here. `missing`: an
  // unknown worker, a message not in its transcript, or a transcript that can't be read now: not the beginning (L1).
  // A source that can't answer now (SourceUnavailable) is `missing` too: the app says it couldn't load the page and
  // offers Try again, and the follow is untouched, so paging works again once the node answers.
  async older(id: string, before: string): Promise<OlderResult> {
    const f = this.#followed.get(id);
    const name = this.nameOf(id);
    if (!f || name === null || !this.#transcripts) return MISSING;
    try {
      const page = await olderPage(this.#bytes(this.#transcripts, f.sessionId), name, before);
      // A copy made already comes back at once; one still being made goes out pending, and the watcher is told once it
      // lands (only then: what landed while waiting goes out with the page).
      const shown = { now: false };
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([this.#attachCopies(id, page.messages, page.files, shown), new Promise<void>(r => { timer = setTimeout(r, OLDER_COPY_WAIT_MS); })]);
      clearTimeout(timer);
      shown.now = true;
      return page.missing ? MISSING : { messages: page.messages, done: page.done };
    } catch (e) {
      log.warn(`older page of ${id} unreadable: ${(e as Error).message}`);
      return MISSING;                                           // the transcript went away, or its node didn't answer
    }
  }

  // Files a message carries: the hub keeps its own copy (files.ts); the message names it by id, never by path. Copies are
  // made in the background (fleet core §3.1): until one lands its attachment is `pending`, and once all of a message's
  // copies have landed, whoever watches that worker gets its attachments again, if the message was out by then
  // (`shown`; a live message may be, from the moment it is read). Resolves then; never rejects.
  #attachCopies(workerId: string, entries: readonly ConversationEntry[], refs: readonly FileRef[], shown = { now: true }): Promise<void> {
    const files = this.#files;
    if (!files) return Promise.resolve();
    const messages: Promise<void>[] = [];
    for (const ref of refs) {
      const m = entries.find(e => e.id === ref.messageId);
      if (!m || m.kind === "answer" || !m.attachments) continue;
      const message = m;
      const copies = ref.paths.flatMap((p, i) => {
        const a = message.attachments?.[i];
        if (!a) return [];
        a.pending = true;
        return [files.register(workerId, p)
          .then(r => { a.id = r.id; a.size = r.size; }, (e: unknown) => { log.warn(`a file in ${workerId}'s conversation wasn't copied: ${(e as Error).message}`); })
          .finally(() => { delete a.pending; })];
      });
      if (!copies.length) continue;
      messages.push(Promise.all(copies)
        .then(() => {
          if (!shown.now) return;
          for (const l of this.#listeners) if (l.watching() === workerId) l.attachments?.(workerId, message.id, message.attachments ?? []);
        })
        .catch((e: unknown) => { log.warn(`telling a watcher about ${workerId}'s files failed`, e); }));
    }
    return Promise.all(messages).then(() => {});
  }

  // One session's transcript as the byte source the transcript reader takes.
  #bytes(t: TranscriptSource, sessionId: string) {
    return {
      size: () => t.size(sessionId),
      read: (offset: number, max: number) => t.read(sessionId, offset, max),
      locate: (needle: string) => t.locate(sessionId, needle),
    };
  }

  snapshot(): Snapshot { return { epoch: this.feed.epoch, seq: this.feed.head, workers: this.#roster.entries() }; }
  // What a worker waits for now (S6), as a Command carries it: "none", or the question or menu identity.
  waitingOn(id: string): string { return this.#roster.entries().find(w => w.id === id)?.waitingOn ?? "none"; }
  nameOf(id: string): string | null { return this.#roster.entries().find(w => w.id === id)?.name ?? null; }
  screen(id: string) { return this.#roster.screen(workerId(id)); }

  subscribe(l: Listener) { this.#listeners.add(l); return () => this.#listeners.delete(l); }

  // stop() during a poll also ends the loop: that poll, which now awaits its nodes, schedules no next one.
  start(pollMs: number) {
    this.#stopped = false;
    const loop = async () => {
      try { await this.poll(); }
      catch (e) { log.error(`observation poll failed, polling again: ${(e as Error).message}`); }
      if (!this.#stopped) this.#timer = setTimeout(() => void loop(), pollMs);
    };
    void loop();
  }
  stop() { this.#stopped = true; if (this.#timer) clearTimeout(this.#timer); }

  async poll() {
    if (this.#busy) return;
    this.#busy = true;
    try {
      const now = this.#now();
      const listing = await this.#tmux.listWorkers();
      this.#nodeOf = new Map(listing.map(w => [w.id, w.node]));
      const bodies = this.#roster.observeListing(listing.map(w => ({ id: workerId(w.id), name: w.name, location: w.location })), now);
      await this.#refreshSessions(now);
      this.#dropFollows();
      await this.#pollNodes();
      const changedScreens = new Map<string, string>();
      const newMessages = new Map<string, Message[]>();
      const rebuilt = new Set<string>();
      for (const round of this.#arrived.splice(0)) this.#apply(round, bodies, changedScreens, newMessages, rebuilt);
      bodies.push(...this.#roster.tick(this.#now()));
      for (const w of this.#roster.entries()) {
        const f = this.#followed.get(w.id);
        const screen = this.#roster.screen(w.id) ?? "";
        const open = f?.conversation.openQuestionMessages().map(m => m.questionId ?? m.id) ?? [];
        bodies.push(...this.#roster.observeDetails(w.id, {
          title: f?.title ?? null,
          lastMessageAt: f?.conversation.lastAt ?? null,
          needsYou: needsYou({ openQuestions: f?.conversation.openQuestions ?? 0, menuOnScreen: menuOnScreen(screen) }),
          waitingOn: waitingOn({ openQuestionIds: open, menu: menuIdentity(screen) }),
        }));
      }
      const events = bodies.map(b => this.feed.append(b, now));
      for (const l of this.#listeners) {
        if (events.length) l.events(events);
        const watching = l.watching();
        const s = watching === null ? undefined : changedScreens.get(watching);
        if (watching !== null && s !== undefined) l.screen(watching, s, now);
        if (watching !== null && rebuilt.has(watching)) { l.history(watching, this.history(watching)); continue; }
        const m = watching === null ? undefined : newMessages.get(watching);
        if (watching !== null && m?.length) l.messages(watching, m);
      }
    } finally {
      this.#busy = false;
    }
  }

  // Which agent session runs in which pane, read again every 10 s.
  async #refreshSessions(now: number) {
    if (!this.#sessions || (now - this.#panesAt < 10_000 && this.#panesAt !== 0)) return;
    this.#panes = await this.#sessions.byPane();
    this.#panesAt = now;
  }

  // A follow ends when its worker is gone or its pane runs another session now.
  #dropFollows() {
    const alive = new Set(this.#roster.entries().map(w => w.id as string));
    for (const [id, f] of this.#followed) {
      if (!alive.has(id) || this.#panes.get(id)?.sessionId !== f.sessionId) this.#followed.delete(id);
    }
  }

  // Every node with workers, at the same time (Promise.allSettled), waited for at most `nodeWaitMs`.
  async #pollNodes() {
    const states = this.#nodeStates ? await this.#nodeStates() : null;
    const byNode = new Map<string, string[]>();
    for (const w of this.#roster.entries()) {
      const node = this.#nodeOf.get(w.id) ?? "";
      byNode.set(node, [...(byNode.get(node) ?? []), w.id]);
    }
    const rounds: Promise<void>[] = [];
    for (const [node, ids] of byNode) {
      if (states && states.get(node) !== "online") continue;      // not online: skipped at once
      if (this.#working.has(node)) continue;                       // its last round still runs: no second one on top
      this.#working.add(node);
      rounds.push(this.#pollNode(ids).then(
        r => { this.#arrived.push(r); },
        (e: unknown) => { log.warn(`observation: node ${node} failed this round: ${(e as Error).message}`); },
      ).finally(() => { this.#working.delete(node); }));
    }
    if (!rounds.length) return;
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<void>(resolve => { timer = setTimeout(resolve, this.#nodeWaitMs); });
    try { await Promise.race([Promise.allSettled(rounds), waited]); }
    finally { clearTimeout(timer); }
  }

  // One node's round: its screens in one captureMany, then each of its followed transcripts, in turn. The roster is not
  // touched here; whichever poll finds the round arrived applies it.
  async #pollNode(ids: string[]): Promise<NodeRound> {
    const round: NodeRound = { screens: await this.#tmux.captureMany(ids), added: new Map(), rebuilt: new Set() };
    const transcripts = this.#transcripts;
    if (!this.#sessions || !transcripts) return round;
    for (const id of ids) {
      const info = this.#panes.get(id);
      const name = this.nameOf(id);
      if (!info || name === null) continue;
      let f = this.#followed.get(id);
      if (!f) {
        let size: number | null;
        try { size = await transcripts.size(info.sessionId); }
        catch { continue; }                       // can't be asked now: try again next poll
        if (size === null) continue;              // no transcript (yet): try again next poll
        f = { sessionId: info.sessionId, cursor: { offset: 0, pending: new Set() }, conversation: new Conversation(), title: null };
        this.#followed.set(id, f);
        round.rebuilt.add(id);                    // its first read is the whole tail again, never new messages (O5)
      }
      try {
        const parsed = await followTranscript(this.#bytes(transcripts, f.sessionId), f.cursor, name);
        if (parsed.title) f.title = parsed.title;
        void this.#attachCopies(id, parsed.entries, parsed.files);      // in the background: the round doesn't wait
        const fresh = f.conversation.add(parsed.entries);
        if (fresh.length) round.added.set(id, { follow: f, messages: fresh });
      } catch (e) {
        // Can't be read now (SourceUnavailable: its node offline, the fleet slow): the follow keeps its place and its
        // conversation, and the next poll reads on from there. One made this round starts over, so that its first read
        // stays a whole history (O5).
        if (e instanceof SourceUnavailable && !round.rebuilt.has(id)) continue;
        if (this.#followed.get(id) === f) this.#followed.delete(id);   // gone, moved or unreadable: start over next poll
        round.rebuilt.delete(id);
      }
    }
    return round;
  }

  #apply(round: NodeRound, bodies: FeedBody[], changedScreens: Map<string, string>, newMessages: Map<string, Message[]>, rebuilt: Set<string>) {
    for (const [id, text] of round.screens) {
      if (text === null) continue;                              // the pane went away between list and capture
      const r = this.#roster.observeScreen(workerId(id), text, this.#now());
      bodies.push(...r.events);
      if (r.changed) changedScreens.set(id, text);
    }
    for (const [id, a] of round.added) {
      if (this.#followed.get(id) !== a.follow) continue;        // that follow was dropped meanwhile
      newMessages.set(id, [...(newMessages.get(id) ?? []), ...a.messages]);
    }
    for (const id of round.rebuilt) if (this.#followed.has(id)) rebuilt.add(id);
  }
}
```

`apps/hub/src/adapters/http.ts`: after `        history: (worker, messages) => sendHistory(worker, messages),` (`:424`) add
```ts
        attachments: (worker, message, attachments) => send({ t: "attachments", worker, message, attachments }),
```

`apps/hub/src/main.ts`: replace `import { localSessions, localTmux, localTranscripts, localUploads } from "./adapters/local-node.ts";` with `import { localFiles, localSessions, localTmux, localTranscripts, localUploads } from "./adapters/local-node.ts";`, and in the ObservationService options replace `      files, nodeWaitMs: config.pollMs,` with `      files: localFiles(files), nodeWaitMs: config.pollMs,`.

`apps/web/src/lib/feed.svelte.ts`: before `      case "older": {` (`:384`) add
```ts
      // A message's files once the hub's copies of them landed (fleet core §3.1): they showed as pending until now.
      case "attachments": {
        if (m.worker !== this.#watching) break;
        const i = this.messages.findIndex(x => x.id === m.message);
        const held = this.messages[i];
        if (held) this.messages[i] = { ...held, attachments: m.attachments };
        break;
      }
```
(The switch ends in `unreachable(m)`, so `npm run check` fails until this case exists.)

`apps/web/src/lib/desktop/Attachments.svelte`:
- Replace the comment lines
  ```
    // text and Markdown with a preview, PDFs to open, anything else as a file card to download. Each comes from the hub's
    // own copy (/api/files/<id>); a file the hub couldn't keep shows as not available.
  ```
  with
  ```
    // text and Markdown with a preview, PDFs to open, anything else as a file card to download. Each comes from the hub's
    // own copy (/api/files/<id>); one still being copied shows as copying, and a file the hub couldn't keep as not available.
  ```
- After `  import ImageOff from "@lucide/svelte/icons/image-off";` add `  import LoaderCircle from "@lucide/svelte/icons/loader-circle";`.
- Replace
  ```svelte
        {#if !a.id}
          <div class="card">
  ```
  (the first one, `:52-53`) with
  ```svelte
        {#if a.pending}
          <div class="card">
            <span class="ico muted"><LoaderCircle size={20} /></span>
            <span class="meta"><strong>{a.name}</strong><small>Copying from its machine…</small></span>
          </div>
        {:else if !a.id}
          <div class="card">
  ```

`apps/web/src/lib/phone/Chat.svelte`: replace (`:60`)
```svelte
              {#if a.id}<a class="file" href="/api/files/{a.id}" target="_blank" rel="noopener">{a.name}</a>{:else}<span class="note">{a.name}: not available</span>{/if}
```
with
```svelte
              {#if a.id}<a class="file" href="/api/files/{a.id}" target="_blank" rel="noopener">{a.name}</a>{:else if a.pending}<span class="note">{a.name}: copying…</span>{:else}<span class="note">{a.name}: not available</span>{/if}
```

`apps/web/src/lib/phone/UpdateCard.svelte`: replace (`:88-89`)
```svelte
                {:else}
                  <span class="file gone"><i><FileIcon size={16} /></i><span>{a.name}<small>Not available</small></span></span>
```
with
```svelte
                {:else if a.pending}
                  <span class="file gone"><i><FileIcon size={16} /></i><span>{a.name}<small>Copying…</small></span></span>
                {:else}
                  <span class="file gone"><i><FileIcon size={16} /></i><span>{a.name}<small>Not available</small></span></span>
```

- [ ] **Step 11 (B): Run the tests and see them pass, then the suites**

Run: `npx vitest run apps/hub/test/files.test.ts apps/hub/test/observation-attachments.test.ts apps/hub/test/local-node.test.ts packages/protocol/test/protocol.test.ts apps/web/test/attachments-web.test.ts`
Expected: PASS, 5 files, 43 tests (`files.test.ts` keeps Task 2's deny-list test, made async).
Then each on its own: `npx vitest run apps/hub packages apps/web`, `npm run check`, `npm run lint`.
Expected: vitest: every file PASSES but `pane-lock.test.ts` on macOS: 135 files, 1041 tests, 2 failed. `check` exits 0; `lint` reports nothing.

- [ ] **Step 12 (B): Commit**

```bash
git add packages/domain/src/conversation.ts packages/protocol apps/hub apps/web/src apps/web/test/attachments-web.test.ts
git commit -m "feat(hub): copy conversation files in the background and show them pending"
```

- [ ] **Step 13 (C): Write the failing tests for echo matching on the node's clock**

In `apps/web/test/outbox-state.test.ts` (`:7`), in `rec`, replace `sentAt: createdAt, hubAt: null });` with `sentAt: createdAt, typedAt: null });`, and append:
```ts

describe("echo matching on the clock of the machine that typed it (fleet core §3.1)", () => {
  it("that machine's clock 10 s behind the hub's: the echo matches by its typedAt; by the hub's time it doesn't (negative control)", () => {
    const hub = 100_000;                                                 // when the hub answered, on the hub's clock
    const node = hub - 10_000;                                           // the same moment on the node that typed it
    const echo = { id: "m1", at: node + 300, text: "ship it" };         // the transcript line, on the node's clock
    expect(matchEchoes([{ ...rec("a", hub, "ship it"), typedAt: node }], [echo]).get("a")).toBe("m1");
    expect(matchEchoes([{ ...rec("a", hub, "ship it"), hubAt: hub }], [echo]).size).toBe(0);
  });
  it("a record kept from before typedAt (hubAt only) is still matched by it", () => {
    expect(matchEchoes([{ ...rec("a", 100_000, "ship it"), hubAt: 90_000 }], [{ id: "m1", at: 90_200, text: "ship it" }]).get("a")).toBe("m1");
  });
});
```
In `apps/web/test/outbox-words.test.ts`, replace `seen: "none", sentAt: null, hubAt: null, ...o,` (`:7`) with `seen: "none", sentAt: null, typedAt: null, ...o,`, and replace (`:15`)
```ts
    for (const code of ["no_pane", "busy", "draft_present", "no_input_box", "not_submitted", "too_long", "stale", "step_up", "timeout", "uncertain"]) {
```
with
```ts
    for (const code of ["no_pane", "busy", "draft_present", "no_input_box", "not_submitted", "too_long", "stale", "step_up", "timeout", "uncertain", "too_large", "node_offline"]) {
```
In `apps/web/test/signout-web.test.ts` (`:29`) replace `sentAt: null, hubAt: null });` with `sentAt: null, typedAt: null });`.

- [ ] **Step 14 (C): Run them and see them fail**

Run: `npx vitest run apps/web/test/outbox-state.test.ts apps/web/test/outbox-words.test.ts`
Expected: FAIL, 2 of 18:
- "that machine's clock 10 s behind …": `AssertionError: expected undefined to be 'm1'`, because `matchEchoes` ignores `typedAt`;
- outbox-words: `AssertionError: expected 'Not sent: the hub answered "too_large…' not to contain 'too_large'`.

- [ ] **Step 15 (C): Implement typedAt in the outbox, and words for the new refusals**

`apps/web/src/lib/outbox/state.ts`:
- Replace (`:22-24`)
  ```ts
    sentAt: number | null;          // when the hub said it typed it, on this device's clock (for "not seen yet")
    hubAt: number | null;           // the same moment on the hub's clock, which the transcript's times are on (review M2)
  };
  ```
  with
  ```ts
    sentAt: number | null;          // when the hub said it typed it, on this device's clock (for "not seen yet")
    // The same moment on the clock of the machine that typed it, which its transcript's times are on (fleet core §3.1;
    // the hub's clock before, review M2). A record kept from before has `hubAt` instead: read as the same.
    typedAt: number | null;
    hubAt?: number | null;
  };
  ```
- Replace (`:55-56`)
  ```ts
  // Which Sent records the conversation has echoed (S8): only principal messages no older than a record's typing minus
  // 5 s count, on the hub's clock when known (the transcript's times are the hub machine's; review M2), else createdAt.
  ```
  with
  ```ts
  // Which Sent records the conversation has echoed (S8): only principal messages no older than a record's typing minus
  // 5 s count, on the typing machine's clock when known (its transcript's times are on it; fleet core §3.1), else createdAt.
  ```
- Replace (`:66`)
  ```ts
      const e = byTime.find(x => !used.has(x.id) && x.at >= (r.hubAt ?? r.createdAt) - ECHO_SLACK_MS && x.text.trim() === want);
  ```
  with
  ```ts
      const e = byTime.find(x => !used.has(x.id) && x.at >= (r.typedAt ?? r.hubAt ?? r.createdAt) - ECHO_SLACK_MS && x.text.trim() === want);
  ```

`apps/web/src/lib/outbox/outbox.ts`:
- Replace (`:9`) `// What one POST came to. "typed": ok, or "duplicate" (typed before), with the hub's time of the typing when it says;` with `// What one POST came to. "typed": ok, or "duplicate" (typed before), with the typing machine's time of it when it says;`.
- Replace (`:92`) `      id: this.#newId(), ...c, createdAt: now, budgetFrom: now, attempts: 0, sentAt: null, hubAt: null,` with `      id: this.#newId(), ...c, createdAt: now, budgetFrom: now, attempts: 0, sentAt: null, typedAt: null,`.
- Replace (`:214`) `          await this.#save({ ...now, state: advance(now.state, "sent"), sentAt: this.#timers.now(), hubAt: outcome.at ?? null, error: null });` with `          await this.#save({ ...now, state: advance(now.state, "sent"), sentAt: this.#timers.now(), typedAt: outcome.at ?? null, error: null });`.

`apps/web/src/lib/gallery/data.ts`: replace `hubAt: null, ...over });` (`:62`) with `typedAt: null, ...over });`, `hubAt: now - 30_000 }),` (`:67`) with `typedAt: now - 30_000 }),`, and `hubAt: now - 20 * MIN }),` (`:68`) with `typedAt: now - 20 * MIN }),`.

`apps/web/src/lib/outbox/words.ts`: replace (`:19-20`)
```ts
  too_many: "can take at most 6 images per message.",
};
```
with
```ts
  too_many: "can take at most 6 images per message.",
  // Fleet core §3.1: an attached image is put on the worker's machine before anything is typed.
  too_large: "can't take that image: it's too big for its machine. Attach a smaller one.",
  node_offline: "is on a machine that isn't answering right now, so nothing was typed. Try again once it's back.",
};
```

Check that nothing else still uses the old field:
Run: `grep -rn "hubAt" apps/web/src apps/web/test`
Expected: six lines. Three in `apps/web/src/lib/outbox/state.ts`: the comment, the optional `hubAt?` and its read in `matchEchoes`. Three in the new outbox-state tests: the two `hubAt:` uses and one test's name.

- [ ] **Step 16 (C): Run the tests and see them pass, then the web suite**

Run: `npx vitest run apps/web/test/outbox-state.test.ts apps/web/test/outbox-words.test.ts`
Expected: PASS, 18 tests.
Then each on its own: `npx vitest run apps/hub packages apps/web`, `npm run check`, `npm run lint`.
Expected: vitest: every file PASSES but `pane-lock.test.ts` on macOS: 135 files, 1043 tests, 2 failed. `check` exits 0; `lint` reports nothing.

- [ ] **Step 17 (C): Commit**

```bash
git add apps/web/src/lib/outbox apps/web/src/lib/gallery/data.ts apps/web/test/outbox-state.test.ts apps/web/test/outbox-words.test.ts apps/web/test/signout-web.test.ts
git commit -m "feat(web): match echoes on the clock of the node that typed them"
```
