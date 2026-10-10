### Task 1: Protocol: worker IDs and the agent channel

**Files:**
- Create: `packages/protocol/src/worker-id.ts`
- Create: `packages/protocol/src/fleet.ts`
- Modify: `packages/protocol/src/index.ts:1-7`: a new header comment and two more exports.
- Modify (Steps 14–16; the wiring of the two apps wave 1 creates, so its lanes share no lines): `vitest.config.ts:25` (the `units` include), `tsconfig.tests.json` (include), `package.json:14` (`check`), `.oxlintrc.json:40-42` (the `no-console` override)
- Test: `packages/protocol/test/architecture.test.ts` (new), `packages/protocol/test/worker-id.test.ts` (new), `packages/protocol/test/fleet.test.ts` (new)

**Interfaces:**
- Consumes (existing, in `packages/protocol/src`):
  - `z.ts` (`export * from "zod/mini"`);
  - `decode.ts`: `decode<M extends Schemas>(schemas: M, raw: unknown): Decoded<M>` and `decodeValue`.
- Produces (all exported from `@morndo/protocol`):
  - `worker-id.ts`:
    - `NODE_NAME`, `WORKER_ID` and `LEGACY_PANE_ID` (RegExp);
    - `type WorkerRef = { node: string; server: string; pane: number }`;
    - `formatWorkerId(ref: WorkerRef): string`, which throws `TypeError` on a ref that can't form a worker ID;
    - `parseWorkerId(id: string): WorkerRef | null`;
    - `isWorkerOrLegacyId(id: string): boolean`;
    - `menuEscalationId(workerId: string): string`.
  - `fleet.ts`, everything in the Contracts:
    - versions and limits: `FLEET_PROTO = 1`, `CLIENT_API = 1`, `LIMITS` (as const, with `maxNeedle`), `CLOSE`;
    - error handling: `ERROR_EXECUTED`, `KEYED_OPS`;
    - op schemas: `OP_NAMES`, `OP_ARGS`, `OP_RESULTS`;
    - types: `Expect`, `ErrorCode` (with `lane_conflict`), `Executed`, `OpError`, `Pane`, `OpName`, `OpArgs`, `OpResult`, `Health`, `HookEvent`, `AlertKind`, `Alert`, `JoinString`;
    - message schemas: `Join`, `Hello`, `Proof`, `Res` (with `store`, the answering agent database's stream id), `EvHook`, `EvInventory`, `EvHealth`, `Challenge`, `Welcome`, `Req`, `Ack`;
    - message unions: `AgentMessage` and `FleetMessage` (a schema and a type each), plus the maps `AgentFrames` and `FleetFrames`;
    - signing payloads: `fleetSigPayload(node: string, clientNonce: string): string` and `nodeSigPayload(node: string, nonce: string): string`. Both throw `TypeError` unless `node` matches `NODE_NAME` and the nonce is base64url of 22 to 86 characters;
    - join strings: `formatJoinString(j: JoinString): string`, which throws `TypeError` on input it couldn't parse back, and `parseJoinString(s: string): JoinString | null`;
    - where an agent may dial: `fleetUrlOk(url: string): boolean`, true for `wss://…` and for `ws://` only to `127.x.x.x`, `localhost` or `[::1]`. A join string's `url` must pass it.

- [ ] **Step 1: Write the architecture test**

It guards a rule the package already keeps, so it passes from the start. Its negative controls show that it fails on a `node:` import, a bare built-in, `zod/mini` outside `z.ts`, an app path and a Node global.

```ts
// The protocol imports no node:* (docs/design/fleet-core/README.md §12): the app runs it in the browser, and the agent
// channel's format must not lean on Node either. Its files import their siblings and the domain, and zod only through
// z.ts (ADR-0008 A2), and touch no Node global.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "../src");
const importsOf = (code: string) => [...code.matchAll(/(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map(m => m[1] ?? m[2] ?? "");

export const offending = (file: string, code: string) => importsOf(code).filter(spec =>
  !(/^\.\/[\w-]+\.ts$/.test(spec) || spec === "@morndo/domain" || (file === "z.ts" && spec === "zod/mini")));
const NODE_GLOBALS = /\b(?:Buffer|process)\.\w|\bnew Buffer\b|\brequire\(|\b__dirname\b|\bimport\.meta\.dirname\b/;

describe("protocol architecture", () => {
  const files = readdirSync(SRC).filter(f => f.endsWith(".ts"));
  it("every protocol file imports only siblings, the domain, and zod through z.ts", () => {
    expect(files.length).toBeGreaterThan(0);
    const bad = files.flatMap(f => offending(f, readFileSync(join(SRC, f), "utf8")).map(spec => `${f} -> ${spec}`));
    expect(bad).toEqual([]);
  });
  it("uses no Node global", () => {
    for (const f of files) expect(readFileSync(join(SRC, f), "utf8"), f).not.toMatch(NODE_GLOBALS);
  });
  it("the checks catch what they forbid (negative controls)", () => {
    expect(offending("fleet.ts", `import { createHash } from "node:crypto";`)).toEqual(["node:crypto"]);
    expect(offending("fleet.ts", `import { readFileSync } from "fs";`)).toEqual(["fs"]);
    expect(offending("fleet.ts", `const m = await import("node:fs");`)).toEqual(["node:fs"]);
    expect(offending("fleet.ts", `import * as z from "zod/mini";`)).toEqual(["zod/mini"]);
    expect(offending("fleet.ts", `import type { X } from "../../../apps/hub/src/x.ts";`)).toEqual(["../../../apps/hub/src/x.ts"]);
    expect(offending("z.ts", `export * from "zod/mini";`)).toEqual([]);
    expect(offending("index.ts", `export * from "./fleet.ts";`)).toEqual([]);
    expect(`const b = Buffer.from(s, "base64url");`).toMatch(NODE_GLOBALS);
    expect(`if (process.env.X) {}`).toMatch(NODE_GLOBALS);
    expect(`// its types include neither Buffer nor TextEncoder`).not.toMatch(NODE_GLOBALS);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run packages/protocol/test/architecture.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 3: Write the failing worker-ID test**

```ts
// Worker IDs across a fleet (docs/design/fleet-core/README.md §4): `<node>.<server>.<pane>`, parsed and formatted in
// one place. Synthetic IDs only.
import { describe, expect, it } from "vitest";
import { formatWorkerId, isWorkerOrLegacyId, menuEscalationId, parseWorkerId } from "../src/index.ts";

describe("worker IDs", () => {
  it("format and parse are each other's inverse", () => {
    expect(formatWorkerId({ node: "pc", server: "3fa2c1d0", pane: 12 })).toBe("pc.3fa2c1d0.12");
    expect(parseWorkerId("pc.3fa2c1d0.12")).toEqual({ node: "pc", server: "3fa2c1d0", pane: 12 });
    for (const ref of [{ node: "control-plane", server: "00000000", pane: 0 }, { node: "a".repeat(32), server: "ffffffff", pane: 999_999_999 }]) {
      expect(parseWorkerId(formatWorkerId(ref))).toEqual(ref);
    }
  });
  it("are URL-safe as they are", () => {
    const id = formatWorkerId({ node: "mac-studio", server: "0a1b2c3d", pane: 7 });
    expect(encodeURIComponent(id)).toBe(id);
  });
  it("parse refuses anything else, a legacy pane ID included (negative controls)", () => {
    for (const id of ["%3", "pc.3fa2c1d0", "PC.3fa2c1d0.1", "pc.3FA2C1D0.1", "pc.3fa2c1d.1", "pc.3fa2c1d0.1234567890", "pc.3fa2c1d0.-1",
      "pc.3fa2c1d0.1.5", `${"a".repeat(33)}.3fa2c1d0.1`, "pc.3fa2c1d0.12 ", " pc.3fa2c1d0.12", "pc_3fa2c1d0_12", "", "main:0.%1"]) {
      expect(parseWorkerId(id), id).toBeNull();
    }
  });
  it("one pane has one ID: the pane number has no leading zeros (the server's 8 hex digits keep theirs)", () => {
    for (const id of ["pc.3fa2c1d0.012", "pc.3fa2c1d0.00", "pc.3fa2c1d0.0000000001"]) expect(parseWorkerId(id), id).toBeNull();
    expect(parseWorkerId("pc.3fa2c1d0.0")).toEqual({ node: "pc", server: "3fa2c1d0", pane: 0 });
    expect(parseWorkerId("pc.00a2c1d0.10")).toEqual({ node: "pc", server: "00a2c1d0", pane: 10 });
    expect(formatWorkerId({ node: "pc", server: "3fa2c1d0", pane: 12 })).toBe("pc.3fa2c1d0.12");
  });
  it("format throws rather than build a wrong ID", () => {
    for (const ref of [{ node: "PC", server: "3fa2c1d0", pane: 1 }, { node: "pc", server: "xyz", pane: 1 }, { node: "pc", server: "3fa2c1d0", pane: 1.5 },
      { node: "pc", server: "3fa2c1d0", pane: -1 }, { node: "pc", server: "3fa2c1d0", pane: Number.NaN }, { node: "", server: "3fa2c1d0", pane: 1 },
      { node: "a.b", server: "3fa2c1d0", pane: 1 }]) {
      expect(() => formatWorkerId(ref), JSON.stringify(ref)).toThrow(TypeError);
    }
  });
  it("a worker ID or a legacy pane ID is either; nothing else is", () => {
    expect(isWorkerOrLegacyId("pc.3fa2c1d0.12")).toBe(true);
    expect(isWorkerOrLegacyId("%12")).toBe(true);
    for (const id of ["%", "12", "main:0", "%1;kill-server", "pc.3fa2c1d0.12\n"]) expect(isWorkerOrLegacyId(id), id).toBe(false);
  });
});

describe("menu escalation IDs", () => {
  it("dots become underscores; a legacy pane gives the ID the hub always gave it (menu-N)", () => {
    expect(menuEscalationId("pc.3fa2c1d0.12")).toBe("menu-pc_3fa2c1d0_12");
    const legacy = (pane: string) => `menu-${pane.replace(/^%/, "")}`;      // escalation-service.ts until now
    expect(menuEscalationId("%3")).toBe(legacy("%3"));
  });
});
```

- [ ] **Step 4: Run it to see it fail**

Run: `npx vitest run packages/protocol/test/worker-id.test.ts`
Expected: FAIL with `TypeError: formatWorkerId is not a function`, because `index.ts` doesn't export it yet.

- [ ] **Step 5: Write `packages/protocol/src/worker-id.ts`**

```ts
// Worker IDs across a fleet (docs/design/fleet-core/README.md §4, ADR-0012 decision 6): `<node>.<server>.<pane>`.
// - `node` names the machine;
// - `server` is the first 8 hex digits of the UUID its agent stamps on its tmux server (`@morndo-server`), so a
//   restarted server, which hands out `%0` and `%1` again, gives new IDs and an old one never reaches a reused pane;
// - `pane` is the number of tmux's own pane ID (`%N`), without leading zeros, so one pane has exactly one worker ID.
// URL-safe, and opaque to the app. The legacy single-host hub keeps tmux's `%N` (LEGACY_PANE_ID).
export const NODE_NAME = /^[a-z0-9-]{1,32}$/;
export const WORKER_ID = /^([a-z0-9-]{1,32})\.([0-9a-f]{8})\.(0|[1-9]\d{0,8})$/;
export const LEGACY_PANE_ID = /^%\d{1,9}$/;

export type WorkerRef = { node: string; server: string; pane: number };

// "pc.3fa2c1d0.12". A ref that can't make a worker ID is a bug in the caller: it throws, never builds a wrong ID.
export function formatWorkerId(ref: WorkerRef): string {
  const id = `${ref.node}.${ref.server}.${ref.pane}`;
  if (!Number.isSafeInteger(ref.pane) || !WORKER_ID.test(id)) throw new TypeError(`not a worker ID: ${JSON.stringify(ref)}`);
  return id;
}

// null for anything that isn't a worker ID, a legacy `%N` included.
export function parseWorkerId(id: string): WorkerRef | null {
  const m = WORKER_ID.exec(id);
  return m ? { node: m[1] as string, server: m[2] as string, pane: Number(m[3]) } : null;
}

export function isWorkerOrLegacyId(id: string): boolean {
  return WORKER_ID.test(id) || LEGACY_PANE_ID.test(id);
}

// The escalation for a menu on a worker's screen: "menu-pc_3fa2c1d0_12". A legacy `%3` gives "menu-3", the ID the hub
// has always given it, so the rows already kept in `decisions` keep their meaning.
export function menuEscalationId(workerId: string): string {
  return `menu-${workerId.replaceAll(".", "_").replaceAll("%", "")}`;
}
```

- [ ] **Step 6: Export it from `packages/protocol/src/index.ts`**

Replace lines 1–2 (the header comment) with:

```ts
// The wire protocol between the hub and the app (ADR-0008, A2): one schema per WebSocket frame type, both directions,
// and per HTTP JSON body; and the fleet's agent channel with its worker IDs (ADR-0012). Every end decodes with these;
// the domain never imports this package, and it imports no node:* (it runs in the browser too).
```

Append after the last line (`export * from "./push.ts";`):

```ts
export * from "./worker-id.ts";
```

- [ ] **Step 7: Run the worker-ID test**

Run: `npx vitest run packages/protocol/test/worker-id.test.ts`
Expected: PASS (7 tests).

Then check that the pane number's rule bites: in `worker-id.ts`, change `\.(0|[1-9]\d{0,8})$/` to `\.(\d{1,9})$/` and run the test again. Expected: 1 failure, `pc.3fa2c1d0.012: expected { Object (node, server, ...) } to be null`. Restore the line.

- [ ] **Step 8: Write the failing fleet test**

```ts
// The fleet's agent channel (docs/design/fleet-core/README.md §5): what each end accepts, the limits, the handshake's
// signing payloads and the join string. Synthetic messages and throwaway keys only.
import { generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AgentFrames, AgentMessage, CLOSE, ERROR_EXECUTED, FleetFrames, FleetMessage, KEYED_OPS, LIMITS, OP_ARGS, OP_NAMES, OP_RESULTS,
  decode, fleetSigPayload, fleetUrlOk, formatJoinString, nodeSigPayload, parseJoinString, type ErrorCode, type JoinString, type OpName,
} from "../src/index.ts";
import * as z from "../src/z.ts";

const UUID = "3f1c2d4e-5b6a-4c7d-8e9f-0a1b2c3d4e5f";
const W = "pc.3fa2c1d0.12";
const keys = () => generateKeyPairSync("ed25519");
const spki = (k: ReturnType<typeof keys>) => k.publicKey.export({ format: "der", type: "spki" }).toString("base64");
const NONCE = randomBytes(32).toString("base64url");
const SIG = Buffer.alloc(64, 7).toString("base64");
const kind = (d: { kind: string }) => d.kind;
const expectArgs = { server: "3fa2c1d0", window: "fix: a/b ü.2", sessionId: UUID };
const health = { memTotal: 1, memAvailable: 1, psiSome10: null, psiFull10: 0.5, diskFreeHome: 1, load1: 0.1, tmuxOk: true, wallClock: 1, spoolDepth: 0, drops: 0 };

describe("limits", () => {
  it("are the spec's numbers", () => {
    expect(LIMITS).toMatchObject({
      maxMessageBytes: 512 << 10, maxPayload: 1 << 20, chunkBytes: 256 << 10, maxFileBytes: 25 << 20, maxSendText: 8000, maxKeys: 4096,
      captureManyMax: 64, captureBytesPerPane: 6 << 10, replayWindow: 256, pingMs: 15_000, agentPingTimeoutMs: 35_000, healthMs: 30_000,
      inventoryPollMs: 2000, instancePongMs: 3000, conflictRetryMs: 5 * 60_000, inventoryWaitMs: 300, bulkQueueMax: 8, eventsBufferBytes: 8 << 20,
      handshakeBurst: 10, handshakeRefillMs: 6000, joinCodeTtlMs: 10 * 60_000, doneKeyTtlMs: 7 * 86_400_000, outboxKeepMs: 86_400_000,
      deadLetterAttempts: 20, subscriberBacklog: 50_000, auditKeepMs: 90 * 86_400_000,
    });
    expect(LIMITS.agentPingTimeoutMs).toBeGreaterThan(2 * LIMITS.pingMs);    // two pings may be late before the agent gives up
    expect(CLOSE).toEqual({ badProof: 4401, forbidden: 4403, conflict: 4409, unsupported: 4426 });
  });
  it("a full captureMany and a full bulk chunk each fit one message", () => {
    const captures = Array.from({ length: LIMITS.captureManyMax }, (_, i) => ({ workerId: `pc.3fa2c1d0.${i}`, text: "x".repeat(LIMITS.captureBytesPerPane), truncated: true }));
    const many = JSON.stringify({ v: 1, t: "res", id: "r1", invVersion: 1, store: UUID, ok: true, result: { captures } });
    expect(Buffer.byteLength(many)).toBeLessThanOrEqual(LIMITS.maxMessageBytes);
    const chunk = JSON.stringify({ v: 1, t: "res", id: "r1", invVersion: 1, store: UUID, ok: true, result: { bytes: Buffer.alloc(LIMITS.chunkBytes, 0xff).toString("base64"), size: LIMITS.maxFileBytes, eof: false } });
    expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(LIMITS.maxMessageBytes);
  });
});

describe("errors and keys", () => {
  it("only uncertain and internal may have run", () => {
    const maybe = Object.entries(ERROR_EXECUTED).filter(([, e]) => e === "maybe").map(([c]) => c);
    expect(maybe.sort()).toEqual(["internal", "uncertain"]);
    expect(Object.keys(ERROR_EXECUTED)).toHaveLength(15);
  });
  it("the side-effecting ops carry keys, keystrokes don't", () => {
    expect([...KEYED_OPS].sort()).toEqual(["file.put", "lane.start", "lane.stop", "pane.send", "worktree.add"]);
    expect(KEYED_OPS.has("pane.keys")).toBe(false);
    expect(OP_NAMES).toHaveLength(16);
    expect(Object.keys(OP_ARGS).sort()).toEqual([...OP_NAMES].sort());
    expect(Object.keys(OP_RESULTS).sort()).toEqual([...OP_NAMES].sort());
  });
});

describe("messages, agent → fleet", () => {
  const k = keys();
  const msgs = [
    { v: 1, t: "join", node: "pc", code: randomBytes(16).toString("base64url"), publicKey: spki(k), agent: { version: "0.1.0" }, proto: [1] },
    { v: 1, t: "hello", node: "pc", instanceId: UUID, streamId: UUID, proto: [1], agent: { version: "0.1.0" }, claude: { version: null }, caps: ["pane.send"], clientNonce: NONCE },
    { v: 1, t: "proof", sig: sign(null, Buffer.from("x"), k.privateKey).toString("base64") },
    { v: 1, t: "res", id: "r1", invVersion: 3, store: UUID, ok: true, result: { ok: true } },
    { v: 1, t: "res", id: "r1", invVersion: 3, store: UUID, ok: false, error: { code: "no_pane", executed: "no", message: "expectation mismatch" } },
    { v: 1, t: "ev.hook", event: { streamId: UUID, seq: 1, at: 1, path: "/hook/stop", node: "pc", window: "fix: a/b ü.2", body: { any: "thing" } } },
    { v: 1, t: "ev.hook", event: { streamId: UUID, seq: 9, at: 1, path: "/cc", node: "pc", window: null, late: true, body: null } },
    { v: 1, t: "ev.inventory", panes: [{ workerId: W, window: "fix: a/b ü.2", cwd: "/w", sessionId: UUID, claudeVersion: "2.1.287" }], invVersion: 4 },
    { v: 1, t: "ev.health", health },
  ];
  it("accepts every message an agent sends, by t and as the union", () => {
    for (const m of msgs) {
      expect(kind(decode(AgentFrames, JSON.stringify(m))), m.t).toBe("ok");
      expect(z.safeParse(AgentMessage, m).success, m.t).toBe(true);
    }
  });
  it("tells a t it doesn't know from a malformed message, so the first can be answered with an error", () => {
    expect(decode(AgentFrames, JSON.stringify({ v: 1, t: "ev.desktop", x: 1 }))).toEqual({ kind: "unknown", t: "ev.desktop" });
    expect(kind(decode(AgentFrames, '{"t":"toString"}'))).toBe("unknown");
    for (const bad of [{ ...msgs[1], v: 2 }, { ...msgs[1], node: "PC" }, { ...msgs[1], clientNonce: "short" }, { ...msgs[0], publicKey: "AAAA" },
      { ...msgs[0], code: "x".repeat(21) }, { ...msgs[2], sig: "AAAA" }, { ...msgs[3], id: "" }, { v: 1, t: "res", id: "r1", invVersion: 3, store: UUID, ok: false },
      { v: 1, t: "res", id: "r1", invVersion: 3, ok: true, result: {} }, { ...msgs[3], store: "store-1" },
      { v: 1, t: "ev.hook", event: { ...(msgs[5] as { event: object }).event, seq: 0 } }, { v: 1, t: "ev.inventory", panes: [{ workerId: "%1", window: "w", cwd: "/" }], invVersion: 1 }]) {
      expect(kind(decode(AgentFrames, JSON.stringify(bad))), JSON.stringify(bad).slice(0, 80)).toBe("malformed");
    }
  });
  it("reads an error code from a newer agent as internal, which may have run", () => {
    const d = decode(AgentFrames, JSON.stringify({ v: 1, t: "res", id: "r1", invVersion: 1, store: UUID, ok: false, error: { code: "from_the_future", executed: "no", message: "" } }));
    expect(d.kind === "ok" && d.frame.t === "res" && !d.frame.ok ? d.frame.error.code : null).toBe("internal");
  });
});

describe("messages, fleet → agent", () => {
  const msgs = [
    { v: 1, t: "challenge", nonce: NONCE, fleetSig: SIG },
    { v: 1, t: "welcome", connEpoch: 1, ackSeq: 0, streamKnown: false },
    { v: 1, t: "req", id: "r1", op: "pane.send", args: { workerId: W, text: "hi", expect: expectArgs }, timeoutMs: 10_000, key: "hub:ep1:req-1" },
    { v: 1, t: "req", id: "r2", op: "inventory.get", args: {}, timeoutMs: 5000 },
    { v: 1, t: "ack", streamId: UUID, seq: 12 },
  ];
  it("accepts every message the fleet sends, by t and as the union", () => {
    for (const m of msgs) {
      expect(kind(decode(FleetFrames, JSON.stringify(m))), m.t).toBe("ok");
      expect(z.safeParse(FleetMessage, m).success, m.t).toBe(true);
    }
  });
  it("a req for an op the agent doesn't know is still a req, so it can be answered unknown_op", () => {
    expect(kind(decode(FleetFrames, JSON.stringify({ ...msgs[3], op: "desktop.stream" })))).toBe("ok");
    expect((OP_NAMES as readonly string[]).includes("desktop.stream")).toBe(false);
  });
  it("refuses what doesn't fit (negative controls)", () => {
    for (const bad of [{ ...msgs[1], connEpoch: 0 }, { ...msgs[2], timeoutMs: 0 }, { ...msgs[2], key: "no-namespace" }, { ...msgs[4], streamId: "x" }, { ...msgs[0], fleetSig: "x" }]) {
      expect(kind(decode(FleetFrames, JSON.stringify(bad))), JSON.stringify(bad).slice(0, 80)).toBe("malformed");
    }
  });
});

describe("op arguments (what the agent acts on: strict)", () => {
  const ok = (op: OpName, args: unknown) => z.safeParse(OP_ARGS[op], args).success;
  it("accepts each op's arguments, window names with spaces, unicode, dots and slashes included", () => {
    expect(ok("inventory.get", {})).toBe(true);
    expect(ok("pane.captureMany", { workerIds: Array.from({ length: 64 }, (_, i) => `pc.3fa2c1d0.${i}`) })).toBe(true);
    expect(ok("pane.keys", { workerId: W, data: "\x1b[A", expect: { server: "3fa2c1d0", window: "w" } })).toBe(true);
    expect(ok("pane.send", { workerId: W, text: "x".repeat(8000), expect: expectArgs })).toBe(true);
    expect(ok("transcript.read", { sessionId: UUID, offset: 0, max: LIMITS.chunkBytes })).toBe(true);
    expect(ok("transcript.locate", { sessionId: UUID, needle: `"uuid":"${UUID}"` })).toBe(true);
    expect(ok("file.stat", { path: "/home/u/a.png" })).toBe(true);
    expect(ok("file.get", { ref: "r1", offset: 0, max: 1 })).toBe(true);
    expect(ok("file.put", { upload: "u1", offset: 0, bytes: Buffer.from("png").toString("base64"), final: true, name: "shot ü.png" })).toBe(true);
    expect(ok("lane.start", { name: "fix: a/b ü.2", cwd: "/w/repo", account: "acct2", resume: UUID })).toBe(true);
    expect(ok("worktree.add", { repo: "/w/repo", name: "fix/login", base: "main" })).toBe(true);
  });
  it("refuses what is too long, not a path, or could escape (negative controls)", () => {
    expect(ok("inventory.get", { all: true })).toBe(false);
    expect(ok("pane.captureMany", { workerIds: Array.from({ length: 65 }, (_, i) => `pc.3fa2c1d0.${i}`) })).toBe(false);
    expect(ok("pane.captureMany", { workerIds: ["%1"] })).toBe(false);
    expect(ok("pane.keys", { workerId: W, data: "x".repeat(4097), expect: expectArgs })).toBe(false);
    expect(ok("pane.send", { workerId: W, text: "x".repeat(8001), expect: expectArgs })).toBe(false);
    expect(ok("pane.send", { workerId: W, text: "hi" })).toBe(false);                                  // no expectation
    expect(ok("pane.send", { workerId: W, text: "hi", expect: { ...expectArgs, window: "a\nb" } })).toBe(false);
    for (const sessionId of ["../../.ssh/id_rsa", "a/b", "a.b", ""]) expect(ok("transcript.size", { sessionId }), sessionId).toBe(false);
    expect(ok("transcript.read", { sessionId: UUID, offset: 0, max: LIMITS.chunkBytes + 1 })).toBe(false);
    expect(ok("transcript.locate", { sessionId: UUID, needle: "x".repeat(201) })).toBe(false);
    expect(ok("file.stat", {})).toBe(false);
    expect(ok("file.stat", { path: "/a", ref: "r1" })).toBe(false);
    expect(ok("file.stat", { path: "relative/a.png" })).toBe(false);
    expect(ok("file.get", { ref: "../x", offset: 0, max: 1 })).toBe(false);
    expect(ok("file.put", { upload: "u1", offset: 0, bytes: "not base64!", final: true, name: "a.png" })).toBe(false);
    expect(ok("file.put", { upload: "u1", offset: 0, bytes: "", final: true, name: "../a.png" })).toBe(false);
    expect(ok("lane.start", { name: "x", cwd: "/w", flags: "--dangerously-skip-permissions" })).toBe(true);   // unknown keys are dropped, never passed on
    expect(z.parse(OP_ARGS["lane.start"], { name: "x", cwd: "/w", flags: "--x" })).toEqual({ name: "x", cwd: "/w" });
    expect(ok("worktree.add", { repo: "/w", name: "../../etc", base: "main" })).toBe(false);
  });
  it("worktree.add: branch names as git takes them, slashes included (negative controls)", () => {
    const add = (name: string, base = "main") => ok("worktree.add", { repo: "/w/repo", name, base });
    for (const name of ["fix/login", "feat/fleet-core-hub", "release/1.2.3", "v1.0", "a_b", "x".repeat(200)]) expect(add(name), name).toBe(true);
    for (const name of ["../../etc", "a..b", "a//b", "a/", "/a", "-x", ".a", "a/.b", "a.", "a.lock", "a/b.lock/c", "a b", "a~1", "a^", "a:b",
      "a?", "a*", "a[b", "a\\b", "a@{1}", "ü", "HEAD", "", "x".repeat(201)]) {
      expect(add(name), name).toBe(false);
    }
    expect(add("fix/x", "a//b")).toBe(false);
  });
  it("lane.start: an account or resume id never passes as a flag (negative controls)", () => {
    const start = (o: Record<string, unknown>) => ok("lane.start", { name: "x", cwd: "/w", ...o });
    for (const account of ["acct2", "a", "pc-2", "a".repeat(32)]) expect(start({ account }), account).toBe(true);
    for (const account of ["--dangerously-skip-permissions", "-x", "-", "Acct", "acct_2", "a b", "a".repeat(33), ""]) expect(start({ account }), account).toBe(false);
    expect(start({ resume: UUID })).toBe(true);
    for (const resume of ["--fork-session", "-r", "abc", "3f1c2d4e5b6a4c7d8e9f0a1b2c3d4e5f", `${UUID}x`, "abc; rm -rf ~", ""]) expect(start({ resume }), resume).toBe(false);
  });
});

describe("op results (what a node reports: shape)", () => {
  it("accepts each op's result", () => {
    const results: { [O in OpName]: unknown } = {
      "inventory.get": { panes: [], invVersion: 0 }, "pane.captureMany": { captures: [{ workerId: W, text: null, truncated: false }] },
      "pane.frame": { frame: null }, "pane.keys": { ok: false }, "pane.send": { problem: null, typedAt: 1 }, "op.status": { state: "done", outcome: { problem: null } },
      "transcript.size": { size: null }, "transcript.read": { bytes: "", eof: true }, "transcript.locate": { offset: 12 },
      "file.stat": { size: 1, mtime: 1 }, "file.get": { bytes: "AAAA", size: 3, eof: true }, "file.put": { path: "/inbox/a.png" },
      "lane.start": { workerId: W }, "lane.stop": { ok: true }, "worktree.list": { worktrees: [{ path: "/w", branch: null }] }, "worktree.add": { path: "/w/x" },
    };
    for (const op of OP_NAMES) expect(z.safeParse(OP_RESULTS[op], results[op]).success, op).toBe(true);
    expect(z.safeParse(OP_RESULTS["pane.send"], { problem: "exploded", typedAt: 1 }).success).toBe(false);
  });
});

describe("the handshake's signing payloads", () => {
  it("are the spec's strings", () => {
    expect(fleetSigPayload("pc", NONCE)).toBe(`morndo-fleet/1/fleet\npc\n${NONCE}`);
    expect(nodeSigPayload("pc", NONCE)).toBe(`morndo-fleet/1/node\npc\n${NONCE}`);
  });
  it("sign and verify in both directions; one side's signature never passes as the other's", () => {
    const fleet = keys(), node = keys();
    const fleetSig = sign(null, Buffer.from(fleetSigPayload("pc", NONCE)), fleet.privateKey);
    const nodeSig = sign(null, Buffer.from(nodeSigPayload("pc", NONCE)), node.privateKey);
    expect(verify(null, Buffer.from(fleetSigPayload("pc", NONCE)), fleet.publicKey, fleetSig)).toBe(true);
    expect(verify(null, Buffer.from(nodeSigPayload("pc", NONCE)), node.publicKey, nodeSig)).toBe(true);
    // negative controls: the other side's payload, another node's name, a tampered signature
    expect(verify(null, Buffer.from(nodeSigPayload("pc", NONCE)), fleet.publicKey, fleetSig)).toBe(false);
    expect(verify(null, Buffer.from(fleetSigPayload("mac", NONCE)), fleet.publicKey, fleetSig)).toBe(false);
    const tampered = Buffer.from(fleetSig); tampered[0] = (tampered[0] ?? 0) ^ 1;
    expect(verify(null, Buffer.from(fleetSigPayload("pc", NONCE)), fleet.publicKey, tampered)).toBe(false);
  });
  it("refuse a node name or nonce that could change the payload's lines", () => {
    expect(() => fleetSigPayload("pc\nmac", NONCE)).toThrow(TypeError);
    expect(() => nodeSigPayload("pc", `${NONCE}\nx`)).toThrow(TypeError);
  });
});

describe("the join string", () => {
  const join: JoinString = { url: "wss://cp.tail1234.ts.net/agent", fleetKey: spki(keys()), code: randomBytes(16).toString("base64url"), node: "pc" };
  const s = formatJoinString(join);
  it("parses back to what was formatted", () => {
    expect(s.startsWith("morndo-join:1:")).toBe(true);
    expect(parseJoinString(s)).toEqual(join);
    expect(parseJoinString(formatJoinString({ ...join, url: "ws://127.0.0.1:8791/agent" }))?.url).toBe("ws://127.0.0.1:8791/agent");
  });
  it("ws:// only to this machine's loopback; wss:// anywhere (negative controls)", () => {
    for (const url of ["ws://127.0.0.1:8791/agent", "ws://127.8.9.10/agent", "ws://localhost:8791/agent", "ws://[::1]:8791/agent", "ws://127.0.0.1",
      "wss://100.64.0.1:443/agent", "wss://cp.tail1234.ts.net/agent"]) {
      expect(fleetUrlOk(url), url).toBe(true);
      expect(parseJoinString(formatJoinString({ ...join, url }))?.url, url).toBe(url);
    }
    for (const url of ["ws://100.64.0.1:8791/agent", "ws://cp.tail1234.ts.net/agent", "ws://127.0.0.1.nip.io/agent", "ws://127.0.0.1@evil.example/agent",
      "ws://127.0.0.1:8791@evil.example/", "ws://localhost.evil.example/agent", "ws://[::2]/agent", "ws://128.0.0.1/agent", "ws://127.0.0.256/agent",
      "http://127.0.0.1/agent", "ws:/127.0.0.1", "WS://127.0.0.1/agent", "wss://"]) {
      expect(fleetUrlOk(url), url).toBe(false);
      expect(() => formatJoinString({ ...join, url }), url).toThrow(TypeError);
      expect(parseJoinString(`morndo-join:1:${Buffer.from(JSON.stringify({ ...join, url })).toString("base64url")}`), url).toBeNull();
    }
  });
  it("as pasted: whitespace, quotes, a trailing newline, a wrapped line (Review Focus 5)", () => {
    const wrapped = `${s.slice(0, 40)}\n${s.slice(40, 90)}\r\n${s.slice(90)}`;
    for (const pasted of [`${s}\n`, `${s}\r\n`, `  ${s}  `, `'${s}'`, `"${s}"\n`, ` '${s}'\n`, `“${s}”`, `‘${s}’`, `\`${s}\``, wrapped, `"${wrapped}"\n`]) {
      expect(parseJoinString(pasted), JSON.stringify(pasted.slice(0, 20))).toEqual(join);
    }
  });
  it("a truncated string, cut anywhere, is null: never a partial join", () => {
    for (let n = 0; n < s.length; n++) expect(parseJoinString(s.slice(0, n)), `cut at ${n}`).toBeNull();
  });
  it("anything else is null (negative controls)", () => {
    for (const bad of ["", "morndo-join:1:", s.replace("morndo-join:1:", "morndo-join:2:"), s.replace("morndo-join:1:", ""), `${s}!`, `${s.slice(0, 30)}*${s.slice(31)}`,
      `morndo-join:1:${Buffer.from(JSON.stringify({ ...join, url: "http://x" })).toString("base64url")}`,
      `morndo-join:1:${Buffer.from(JSON.stringify({ ...join, node: "PC" })).toString("base64url")}`,
      `morndo-join:1:${Buffer.from(JSON.stringify({ ...join, code: "short" })).toString("base64url")}`,
      `morndo-join:1:${Buffer.from("[1,2]").toString("base64url")}`, `morndo-join:1:${Buffer.from([0xff, 0xfe]).toString("base64url")}`]) {
      expect(parseJoinString(bad), bad.slice(0, 40)).toBeNull();
    }
  });
  it("is the same base64url Node writes (the agent and the fleet may use Buffer on their side)", () => {
    const json = JSON.stringify({ url: join.url, fleetKey: join.fleetKey, code: join.code, node: join.node });
    expect(s).toBe(`morndo-join:1:${Buffer.from(json).toString("base64url")}`);
    const unicode = Buffer.from(JSON.stringify({ ...join, url: "wss://x/ä" })).toString("base64url");
    expect(parseJoinString(`morndo-join:1:${unicode}`)).toBeNull();                 // the URL is ASCII; the decode itself is UTF-8
  });
  it("format refuses what it couldn't parse back", () => {
    for (const bad of [{ ...join, url: "https://x" }, { ...join, fleetKey: "AAAA" }, { ...join, code: "x" }, { ...join, node: "a.b" }]) {
      expect(() => formatJoinString(bad), JSON.stringify(bad).slice(0, 60)).toThrow(TypeError);
    }
  });
});

describe("error codes", () => {
  it("cover the spec's table", () => {
    const codes: ErrorCode[] = ["bad_args", "unknown_op", "denied", "no_pane", "menu_open", "no_input_box", "draft_present", "busy", "name_taken", "lane_conflict", "too_large", "timeout", "node_offline", "uncertain", "internal"];
    expect(Object.keys(ERROR_EXECUTED).sort()).toEqual([...codes].sort());
  });
});
```

Run: `npx vitest run packages/protocol/test/fleet.test.ts`
Expected: FAIL with `TypeError: formatJoinString is not a function`. The file errors while loading, so it reports no tests.

- [ ] **Step 9: Write `packages/protocol/src/fleet.ts`, and export it**

Append to `packages/protocol/src/index.ts`, after `export * from "./worker-id.ts";`:

```ts
export * from "./fleet.ts";
```

Then create `fleet.ts`. The `check<Same<…>>` lines at the end fail `tsc` if any schema decodes to a type other than the declared one. That is the repo's existing pattern (`feed.ts:206-214`). `orElse` stands in for `z.catch` because oxlint's `promise/valid-params` reads `z.catch(a, b)` as `Promise.catch` (as in `feed.ts:15-16`).

```ts
// The fleet's agent channel (docs/design/fleet-core/README.md §5, ADR-0012): one WebSocket per node between its agent
// and the fleet service, JSON messages `{ v: 1, t, … }`, both directions, validated with zod/mini on both sides. Here:
// the protocol versions, every limit the spec sets (LIMITS, the one place they live), the typed operations with their
// arguments and results, the events, the handshake's signing payloads and the join string.
// What a node is asked to do (op arguments) is strict, with limits: the agent acts on it. What a node reports (results,
// events) is checked for shape; each message is bounded by maxMessageBytes anyway.
import * as z from "./z.ts";
import { NODE_NAME, WORKER_ID } from "./worker-id.ts";

export const FLEET_PROTO = 1;            // the agent channel; accepted: [FLEET_PROTO - 1, FLEET_PROTO] ∩ ≥ 1
export const CLIENT_API = 1;             // the client API's routes: /v1/

export const LIMITS = {
  // messages: each at most 512 KiB; both ends set `maxPayload` to 1 MiB; bulk data in chunks of 256 KiB before base64
  maxMessageBytes: 524_288, maxPayload: 1_048_576, chunkBytes: 262_144,
  // content: files 25 MiB (as the hub's own copies, MAX_FILE_BYTES), typed text, keystrokes, panes per capture, a needle
  maxFileBytes: 26_214_400, maxSendText: 8000, maxKeys: 4096, captureManyMax: 64, captureBytesPerPane: 6144, maxNeedle: 200,
  // streaming: hook events unacknowledged in flight
  replayWindow: 256,
  // timing: pings, liveness (the agent's timeout is two missed pings plus slack), health and inventory, and what an
  // agent keeps back from a deadline
  pingMs: 15_000, agentPingTimeoutMs: 35_000, healthMs: 30_000, inventoryPollMs: 2000, deadlineMarginMs: 250,
  // instances (§5.2): how long the fleet waits for the live connection's pong before it admits another instance, and how
  // often a refused (4409) agent tries again (±20 % jitter); how long the hub's listing waits for one node's inventory
  instancePongMs: 3000, conflictRetryMs: 300_000, inventoryWaitMs: 300,
  // queues and buffers: bulk ops waiting per node (one more is busy), unsent events before a client's events socket is
  // closed (1013), and joins and hellos per source address before any key work (10 at once, one more every 6 s)
  bulkQueueMax: 8, eventsBufferBytes: 8_388_608, handshakeBurst: 10, handshakeRefillMs: 6000,
  // lifetimes and caps of what is kept (the spool's bytes count the relay's copies and the upload inbox too); audit
  // rows, alerts included, 90 days
  joinCodeTtlMs: 600_000, doneKeyTtlMs: 604_800_000, outboxKeepMs: 86_400_000, deadLetterAttempts: 20,
  subscriberBacklog: 50_000, spoolMaxEvents: 100_000, spoolMaxBytes: 268_435_456, relayFileKeepMs: 86_400_000, auditKeepMs: 7_776_000_000,
} as const;

// Close codes on the agent channel (§5.2).
export const CLOSE = { badProof: 4401, forbidden: 4403, conflict: 4409, unsupported: 4426 } as const;

// Where an agent may dial (§8): TLS (wss://) anywhere, and plain ws:// only to this machine's loopback, where nothing
// crosses a network (Tailscale Serve terminates TLS in front of the fleet, so a node elsewhere dials wss://). The host is
// read without URL(), which this package's types don't have: 127.x.x.x, localhost or [::1], then a port, a path or the
// end, so "ws://127.0.0.1.nip.io" and "ws://127.0.0.1@evil.example" are refused.
const LOOPBACK_WS = /^ws:\/\/(?:127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}|localhost|\[::1\])(?::\d{1,5})?(?:\/[!-~]*)?$/;
export function fleetUrlOk(url: string): boolean {
  return /^wss:\/\/[!-~]+$/.test(url) || LOOPBACK_WS.test(url);
}

export type Expect = { server: string; window: string; sessionId?: string };
export type ErrorCode = "bad_args" | "unknown_op" | "denied" | "no_pane" | "menu_open" | "no_input_box"
  | "draft_present" | "busy" | "name_taken" | "lane_conflict" | "too_large" | "timeout" | "node_offline" | "uncertain" | "internal";
export type Executed = "no" | "maybe";
// Whether the side effect may have happened (§5.3): "no" is safe to retry. Only an answer that may have come after the
// side effect started is "maybe".
export const ERROR_EXECUTED: Record<ErrorCode, Executed> = {
  bad_args: "no", unknown_op: "no", denied: "no", no_pane: "no", menu_open: "no", no_input_box: "no", draft_present: "no",
  busy: "no", name_taken: "no", lane_conflict: "no", too_large: "no", timeout: "no", node_offline: "no", uncertain: "maybe", internal: "maybe",
};
export type OpError = { code: ErrorCode; executed: Executed; message: string };

export type Pane = { workerId: string; window: string; cwd: string; sessionId?: string; title?: string; claudeVersion?: string };
export type OpName = "inventory.get" | "pane.captureMany" | "pane.frame" | "pane.keys" | "pane.send" | "op.status"
  | "transcript.size" | "transcript.read" | "transcript.locate" | "file.stat" | "file.get" | "file.put"
  | "lane.start" | "lane.stop" | "worktree.list" | "worktree.add";
export type OpArgs = {
  "inventory.get": Record<string, never>;
  "pane.captureMany": { workerIds: string[] };
  "pane.frame": { workerId: string };
  "pane.keys": { workerId: string; data: string; expect: Expect };
  "pane.send": { workerId: string; text: string; expect: Expect };
  "op.status": { key: string };
  "transcript.size": { sessionId: string };
  "transcript.read": { sessionId: string; offset: number; max: number };
  "transcript.locate": { sessionId: string; needle: string };
  "file.stat": { path?: string; ref?: string };
  "file.get": { path?: string; ref?: string; offset: number; max: number };
  "file.put": { upload: string; offset: number; bytes: string /* base64 */; final: boolean; name: string };
  "lane.start": { name: string; cwd: string; account?: string; resume?: string };
  "lane.stop": { name: string };
  "worktree.list": { repo: string };
  "worktree.add": { repo: string; name: string; base: string };
};
export type OpResult = {
  "inventory.get": { panes: Pane[]; invVersion: number };
  "pane.captureMany": { captures: { workerId: string; text: string | null; truncated: boolean }[] };
  "pane.frame": { frame: { cols: number; rows: number; x: number; y: number; cursor: boolean; lines: string[] } | null };
  "pane.keys": { ok: boolean };
  "pane.send": { problem: "menu_open" | "draft_present" | "no_input_box" | "not_submitted" | "no_pane" | "busy" | null; typedAt: number };
  "op.status": { state: "unknown" | "started" | "done"; outcome?: unknown };
  "transcript.size": { size: number | null };
  "transcript.read": { bytes: string /* base64 */; eof: boolean };
  "transcript.locate": { offset: number | null };
  "file.stat": { size: number; mtime: number };
  "file.get": { bytes: string; size: number; eof: boolean };
  "file.put": { path: string | null };
  "lane.start": { workerId: string };
  "lane.stop": { ok: true };
  "worktree.list": { worktrees: { path: string; branch: string | null }[] };
  "worktree.add": { path: string };
};
// Ops with a side effect, which carry a caller's idempotency key (§5.3). Keystrokes carry none: they are never retried.
export const KEYED_OPS: ReadonlySet<OpName> = new Set<OpName>(["pane.send", "file.put", "lane.start", "lane.stop", "worktree.add"]);

export type Health = { memTotal: number; memAvailable: number; psiSome10: number | null; psiFull10: number | null;
  diskFreeHome: number; load1: number; tmuxOk: boolean; wallClock: number; spoolDepth: number; drops: number };
export type HookEvent = { streamId: string; seq: number; at: number; path: "/cc" | "/sl" | "/hook/stop" | "/hook/failure" | "/notify" | "/file";
  node: string; window: string | null; late?: true; body: unknown };

// What the fleet service raises for the owner (spec §5.2, §5.4, §5.6, §7, §8): kept as audit rows, served oldest first by
// the client API's GET /v1/alerts and sent as the "alert" event. `detail` is per kind (plan Contracts, "Alerts").
export type AlertKind = "instance_conflict" | "source_changed" | "clock_offset" | "rate_limited" | "lane_conflict" | "dead_letter" | "backlog_full";
export type Alert = { id: number; at: number; node: string | null; kind: AlertKind; detail: Record<string, unknown> };

// ---- the pieces messages are made of

const v = z.literal(1);
const text = () => z.string();                                              // node → fleet: shape only
const label = () => z.string().check(z.maxLength(200));
const count = () => z.int().check(z.gte(0));
const nodeName = () => z.string().check(z.regex(NODE_NAME));
const workerId = () => z.string().check(z.regex(WORKER_ID));
// A Claude Code session ID names a transcript file on the node (`<id>.jsonl`): no dot, no slash, so never a path.
const sessionId = () => z.string().check(z.regex(/^[A-Za-z0-9_-]{1,128}$/));
const absolutePath = () => z.string().check(z.maxLength(4096), z.refine(p => p.startsWith("/") && !p.includes("\0"), "an absolute path"));
// A token an agent hands out (a relay file's ref, an upload's id): URL-safe, never a path.
const token = () => z.string().check(z.regex(/^[A-Za-z0-9_-]{1,64}$/));
// lane.start's typed fields become arguments of `claude-as <account> --resume <id>` on the node: neither may start with
// "-", so no value can pass as a flag (--dangerously-skip-permissions, --fork-session). An account is a short name of
// lower-case letters, digits and "-"; a resume id is a Claude Code session ID, a UUID.
const account = () => z.string().check(z.regex(/^[a-z0-9][a-z0-9-]{0,31}$/));
// A lane is a tmux window: its name may hold spaces, unicode, dots and slashes, never a control character.
const windowName = () => z.string().check(z.regex(/^[^\p{Cc}]{1,200}$/u));
const offset = () => z.int().check(z.gte(0), z.lte(Number.MAX_SAFE_INTEGER));
const chunkMax = () => z.int().check(z.gte(1), z.lte(LIMITS.chunkBytes));
const base64Chunk = () => z.base64().check(z.maxLength(4 * Math.ceil(LIMITS.chunkBytes / 3)));
// 16 to 64 random bytes, base64url: the handshake's nonces.
const nonce = () => z.string().check(z.regex(/^[A-Za-z0-9_-]{22,86}$/));
// An Ed25519 signature (64 bytes) and an Ed25519 public key as SPKI DER (44 bytes), base64 (Node's `sign(null, …)`,
// `export({ format: "der", type: "spki" })`; https://nodejs.org/docs/latest-v24.x/api/crypto.html, read 2026-10-06).
const signature = () => z.string().check(z.regex(/^[A-Za-z0-9+/]{86}==$/));
const ed25519Spki = () => z.string().check(z.regex(/^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$/));
const joinCode = () => z.string().check(z.regex(/^[A-Za-z0-9_-]{22}$/));   // 128 bits, base64url
// An idempotency key, namespaced by its client ("hub:…", "kira:…", "lanes:…").
const opKey = () => z.string().check(z.regex(/^[a-z]+:/), z.maxLength(512));
const reqId = () => z.string().check(z.minLength(1), z.maxLength(64));
const protoList = () => z.array(z.int().check(z.gte(1))).check(z.minLength(1), z.maxLength(8));

const ExpectSchema = z.object({
  server: z.string().check(z.regex(/^[0-9a-f]{8}$/)), window: windowName(), sessionId: z.exactOptional(sessionId()),
});
// One of a path or a ref (a file the hook relay copied), never both.
const oneFile = (a: { path?: string; ref?: string }) => (a.path === undefined) !== (a.ref === undefined);
// A worktree's name or base: a git branch name (git-check-ref-format(1), --branch), in a form never laxer than git's:
// ASCII letters, digits, ".", "_", "-" and "/"; not starting with "-", "." or "/"; no "..", "//", "/." or "@{"; no
// component ending in ".lock"; not ending in "/" or "."; not "HEAD"; at most 200 characters. The agent asks git itself
// as well (`git check-ref-format --branch`).
const refName = () => z.string().check(z.regex(/^(?![-/.]|HEAD$)(?!.*(?:\.\.|\/\/|\/\.|@\{|\.lock(?:\/|$)))(?!.*[/.]$)[A-Za-z0-9._/-]{1,200}$/));

export const OP_NAMES = [
  "inventory.get", "pane.captureMany", "pane.frame", "pane.keys", "pane.send", "op.status",
  "transcript.size", "transcript.read", "transcript.locate", "file.stat", "file.get", "file.put",
  "lane.start", "lane.stop", "worktree.list", "worktree.add",
] as const satisfies readonly OpName[];

// Each op's arguments, as the agent accepts them (fleet → agent: strict).
export const OP_ARGS = {
  "inventory.get": z.record(z.string(), z.never()),
  "pane.captureMany": z.object({ workerIds: z.array(workerId()).check(z.maxLength(LIMITS.captureManyMax)) }),
  "pane.frame": z.object({ workerId: workerId() }),
  "pane.keys": z.object({ workerId: workerId(), data: z.string().check(z.minLength(1), z.maxLength(LIMITS.maxKeys)), expect: ExpectSchema }),
  "pane.send": z.object({ workerId: workerId(), text: z.string().check(z.minLength(1), z.maxLength(LIMITS.maxSendText)), expect: ExpectSchema }),
  "op.status": z.object({ key: opKey() }),
  "transcript.size": z.object({ sessionId: sessionId() }),
  "transcript.read": z.object({ sessionId: sessionId(), offset: offset(), max: chunkMax() }),
  "transcript.locate": z.object({ sessionId: sessionId(), needle: z.string().check(z.minLength(1), z.maxLength(LIMITS.maxNeedle)) }),
  "file.stat": z.object({ path: z.exactOptional(absolutePath()), ref: z.exactOptional(token()) }).check(z.refine(oneFile, "a path or a ref")),
  "file.get": z.object({ path: z.exactOptional(absolutePath()), ref: z.exactOptional(token()), offset: offset(), max: chunkMax() })
    .check(z.refine(oneFile, "a path or a ref")),
  "file.put": z.object({
    upload: token(), offset: z.int().check(z.gte(0), z.lte(LIMITS.maxFileBytes)), bytes: base64Chunk(), final: z.boolean(),
    name: z.string().check(z.minLength(1), z.maxLength(255), z.refine(n => !n.includes("/") && !n.includes("\0"), "a file name")),
  }),
  "lane.start": z.object({ name: windowName(), cwd: absolutePath(), account: z.exactOptional(account()), resume: z.exactOptional(z.uuid()) }),
  "lane.stop": z.object({ name: windowName() }),
  "worktree.list": z.object({ repo: absolutePath() }),
  "worktree.add": z.object({ repo: absolutePath(), name: refName(), base: refName() }),
} satisfies Record<OpName, z.ZodMiniType>;

const PaneSchema = z.object({
  workerId: workerId(), window: text(), cwd: text(),
  sessionId: z.exactOptional(text()), title: z.exactOptional(text()), claudeVersion: z.exactOptional(text()),
});
const SEND_PROBLEMS = ["menu_open", "draft_present", "no_input_box", "not_submitted", "no_pane", "busy"] as const;

// Each op's result, as the fleet accepts it (agent → fleet: shape).
export const OP_RESULTS = {
  "inventory.get": z.object({ panes: z.array(PaneSchema), invVersion: count() }),
  "pane.captureMany": z.object({ captures: z.array(z.object({ workerId: workerId(), text: z.nullable(text()), truncated: z.boolean() })) }),
  "pane.frame": z.object({
    frame: z.nullable(z.object({ cols: count(), rows: count(), x: count(), y: count(), cursor: z.boolean(), lines: z.array(text()) })),
  }),
  "pane.keys": z.object({ ok: z.boolean() }),
  "pane.send": z.object({ problem: z.nullable(z.enum(SEND_PROBLEMS)), typedAt: z.number() }),
  "op.status": z.object({ state: z.enum(["unknown", "started", "done"]), outcome: z.exactOptional(z.unknown()) }),
  "transcript.size": z.object({ size: z.nullable(count()) }),
  "transcript.read": z.object({ bytes: base64Chunk(), eof: z.boolean() }),
  "transcript.locate": z.object({ offset: z.nullable(count()) }),
  "file.stat": z.object({ size: count(), mtime: z.number() }),
  "file.get": z.object({ bytes: base64Chunk(), size: count(), eof: z.boolean() }),
  "file.put": z.object({ path: z.nullable(text()) }),
  "lane.start": z.object({ workerId: workerId() }),
  "lane.stop": z.object({ ok: z.literal(true) }),
  "worktree.list": z.object({ worktrees: z.array(z.object({ path: text(), branch: z.nullable(text()) })) }),
  "worktree.add": z.object({ path: text() }),
} satisfies Record<OpName, z.ZodMiniType>;

const ERROR_CODES = Object.keys(ERROR_EXECUTED) as ErrorCode[];
// zod's catch: a schema that reads a value it doesn't know as the fallback (named so it isn't taken for Promise.catch).
const orElse = z.catch;
// A code a newer agent adds reads as "internal": it may have run (§5.3), so nothing is retried on a guess.
const OpErrorSchema = z.object({ code: orElse(z.enum(ERROR_CODES), "internal"), executed: z.enum(["no", "maybe"]), message: text() });

const HealthSchema = z.object({
  memTotal: z.number(), memAvailable: z.number(), psiSome10: z.nullable(z.number()), psiFull10: z.nullable(z.number()),
  diskFreeHome: z.number(), load1: z.number(), tmuxOk: z.boolean(), wallClock: z.number(), spoolDepth: count(), drops: count(),
});
const HookEventSchema = z.object({
  streamId: z.uuid(), seq: z.int().check(z.gte(1)), at: z.number(),
  path: z.enum(["/cc", "/sl", "/hook/stop", "/hook/failure", "/notify", "/file"]),
  node: nodeName(), window: z.nullable(text()), late: z.exactOptional(z.literal(true)), body: z.unknown(),
});

// ---- messages, agent → fleet

// Once per node (§5.1): the code from the join string, bound to `node`, and the key the node made.
export const Join = z.object({
  v, t: z.literal("join"), node: nodeName(), code: joinCode(), publicKey: ed25519Spki(), agent: z.object({ version: label() }), proto: protoList(),
});
// Every connection (§5.2). `caps`: the ops this node's policy allows (strings: a newer agent's are ignored, not refused).
export const Hello = z.object({
  v, t: z.literal("hello"), node: nodeName(), instanceId: z.uuid(), streamId: z.uuid(), proto: protoList(),
  agent: z.object({ version: label() }), claude: z.object({ version: z.nullable(label()) }),
  caps: z.array(label()).check(z.maxLength(64)), clientNonce: nonce(),
});
export const Proof = z.object({ v, t: z.literal("proof"), sig: signature() });
// An op's answer: `result` is checked against OP_RESULTS by whoever knows which op `id` asked for. `store`: the stream
// id of the agent database that answers, where its done keys live (a new or restored database is a new store), so a
// caller asking op.status can tell that the keys it asks about may be gone.
export const Res = z.discriminatedUnion("ok", [
  z.object({ v, t: z.literal("res"), id: reqId(), invVersion: count(), store: z.uuid(), ok: z.literal(true), result: z.unknown() }),
  z.object({ v, t: z.literal("res"), id: reqId(), invVersion: count(), store: z.uuid(), ok: z.literal(false), error: OpErrorSchema }),
]);
export const EvHook = z.object({ v, t: z.literal("ev.hook"), event: HookEventSchema });
export const EvInventory = z.object({ v, t: z.literal("ev.inventory"), panes: z.array(PaneSchema), invVersion: count() });
export const EvHealth = z.object({ v, t: z.literal("ev.health"), health: HealthSchema });

// ---- messages, fleet → agent

export const Challenge = z.object({ v, t: z.literal("challenge"), nonce: nonce(), fleetSig: signature() });
export const Welcome = z.object({ v, t: z.literal("welcome"), connEpoch: z.int().check(z.gte(1)), ackSeq: count(), streamKnown: z.boolean() });
// `op` is any name here: one the agent doesn't know is answered `unknown_op`, and arguments that don't fit OP_ARGS
// `bad_args`, never dropped as a malformed message.
export const Req = z.object({
  v, t: z.literal("req"), id: reqId(), op: z.string().check(z.minLength(1), z.maxLength(64)), args: z.unknown(),
  timeoutMs: z.int().check(z.gte(1), z.lte(600_000)), key: z.exactOptional(opKey()),
});
// Hook events up to `seq` of `streamId` are stored (cumulative).
export const Ack = z.object({ v, t: z.literal("ack"), streamId: z.uuid(), seq: count() });

export const AgentMessage = z.discriminatedUnion("t", [Join, Hello, Proof, Res, EvHook, EvInventory, EvHealth]);
export const FleetMessage = z.discriminatedUnion("t", [Challenge, Welcome, Req, Ack]);
export type AgentMessage = z.output<typeof AgentMessage>;
export type FleetMessage = z.output<typeof FleetMessage>;
// The same messages by `t`, for decode() (decode.ts): a `t` nobody knows is told apart from a malformed message, so
// it is answered with an error (§5), never ignored.
export const AgentFrames = { join: Join, hello: Hello, proof: Proof, res: Res, "ev.hook": EvHook, "ev.inventory": EvInventory, "ev.health": EvHealth };
export const FleetFrames = { challenge: Challenge, welcome: Welcome, req: Req, ack: Ack };

// ---- the handshake (§5.2): what each side signs. The prefix keeps one side's signature from passing as the other's.

const NONCE = /^[A-Za-z0-9_-]{22,86}$/;
function payload(side: "fleet" | "node", node: string, nonceValue: string): string {
  if (!NODE_NAME.test(node) || !NONCE.test(nonceValue)) throw new TypeError("a signing payload needs a node name and a base64url nonce");
  return `morndo-fleet/1/${side}\n${node}\n${nonceValue}`;
}
export function fleetSigPayload(node: string, clientNonce: string): string { return payload("fleet", node, clientNonce); }
export function nodeSigPayload(node: string, nonce: string): string { return payload("node", node, nonce); }

// ---- the join string (§5.1): what `morndo-fleet node add <name>` prints and `morndo-node join` takes.

export type JoinString = { url: string; fleetKey: string /* spki DER base64 */; code: string /* base64url, 16 bytes */; node: string };
const JOIN_PREFIX = "morndo-join:1:";
const JoinStringSchema = z.object({
  url: z.string().check(z.maxLength(2048), z.refine(fleetUrlOk, "wss://, or ws:// to this machine")), fleetKey: ed25519Spki(), code: joinCode(), node: nodeName(),
});

// base64url and UTF-8 with only what ECMAScript itself has: this package also runs in the browser, and its types
// include neither Buffer nor TextEncoder (tsconfig: lib esnext, no types).
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function toBase64url(bytes: readonly number[]): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64URL.charAt((n >> 18) & 63) + B64URL.charAt((n >> 12) & 63);
    if (i + 1 < bytes.length) out += B64URL.charAt((n >> 6) & 63);
    if (i + 2 < bytes.length) out += B64URL.charAt(n & 63);
  }
  return out;
}
function fromBase64url(s: string): number[] | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) return null;
  const out: number[] = [];
  let acc = 0, bits = 0;
  for (const c of s) {
    acc = ((acc << 6) | B64URL.indexOf(c)) & 0xffffff;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  return out;
}
// encodeURIComponent writes a string's UTF-8 bytes as %XX (all but a few ASCII characters, which stay as they are).
const utf8 = (s: string) => (encodeURIComponent(s).match(/%[0-9A-F]{2}|[^%]/g) ?? []).map(p => (p.length === 3 ? parseInt(p.slice(1), 16) : p.charCodeAt(0)));
const fromUtf8 = (bytes: readonly number[]) => decodeURIComponent(bytes.map(b => `%${b.toString(16).padStart(2, "0")}`).join(""));

// "morndo-join:1:" + base64url(JSON). A JoinString that couldn't be parsed back is a bug in the caller: it throws.
export function formatJoinString(j: JoinString): string {
  const r = z.safeParse(JoinStringSchema, j);
  if (!r.success) throw new TypeError("not a join string: a wss:// URL (ws:// only to this machine), an Ed25519 key, a 16-byte code and a node name");
  return JOIN_PREFIX + toBase64url(utf8(JSON.stringify({ url: j.url, fleetKey: j.fleetKey, code: j.code, node: j.node })));
}

// As the owner pastes it: whitespace anywhere (a trailing newline, a line a terminal wrapped) and quotes around it,
// straight or typographic, are dropped; none of them can be part of the string itself. Anything else that doesn't
// decode to a whole join string, a truncated one above all, is null.
export function parseJoinString(s: string): JoinString | null {
  const t = s.replace(/\s+/g, "").replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "");
  if (!t.startsWith(JOIN_PREFIX)) return null;
  const bytes = fromBase64url(t.slice(JOIN_PREFIX.length));
  if (!bytes) return null;
  let value: unknown;
  try { value = JSON.parse(fromUtf8(bytes)); } catch { return null; }
  const r = z.safeParse(JoinStringSchema, value);
  return r.success ? r.data : null;
}

// The schemas decode to exactly the types above (checked at compile time), so a decoded value needs no cast.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const check = <T extends true>(t: T) => t;
check<Same<(typeof OP_NAMES)[number], OpName>>(true);
check<Same<{ [O in OpName]: z.output<(typeof OP_ARGS)[O]> }, OpArgs>>(true);
check<Same<{ [O in OpName]: z.output<(typeof OP_RESULTS)[O]> }, OpResult>>(true);
check<Same<z.output<typeof ExpectSchema>, Expect>>(true);
check<Same<z.output<typeof PaneSchema>, Pane>>(true);
check<Same<z.output<typeof OpErrorSchema>, OpError>>(true);
check<Same<z.output<typeof HealthSchema>, Health>>(true);
check<Same<z.output<typeof HookEventSchema>, HookEvent>>(true);
check<Same<z.output<typeof JoinStringSchema>, JoinString>>(true);
```

- [ ] **Step 10: Run the protocol tests**

Run: `npx vitest run packages/protocol`
Expected: PASS, 4 files, 57 tests (protocol.test.ts' 21 plus 36 new).

Then check that each new rule bites. Make each change alone, run `npx vitest run packages/protocol/test/fleet.test.ts`, see the one failure, and restore the line before the next:
- the `lane.start` rule: change `account: z.exactOptional(account()), resume: z.exactOptional(z.uuid())` back to `account: z.exactOptional(token()), resume: z.exactOptional(sessionId())`. Expected: `--dangerously-skip-permissions: expected true to be false`.
- `ws://` only to loopback: in `fleetUrlOk`, change `|| LOOPBACK_WS.test(url)` to `|| /^ws:\/\/[!-~]+$/.test(url)`. Expected: `ws://100.64.0.1:8791/agent: expected true to be false`, in "ws:// only to this machine's loopback; wss:// anywhere".
- branch names: change `refName`'s pattern to the laxer `/^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/`. Expected: `a//b: expected true to be false`, in "worktree.add: branch names as git takes them".
- `store` on every answer: in the first branch of `Res`, change `store: z.uuid(),` to `store: z.exactOptional(z.uuid()),`. Expected: `{"v":1,"t":"res","id":"r1","invVersion":3,"ok":true,"result":{}}: expected 'ok' to be 'malformed'`.

The branch-name pattern was compared with `git check-ref-format --branch` (git 2.50.1) on every name in its test: it accepts none that git refuses (`HEAD` was the one it let through before it was excluded), and it refuses a few that git takes (`ü`, `@`), which is the safe side.

- [ ] **Step 11: Check that the compile-time type checks bite**

In `fleet.ts`, change `"pane.keys": { ok: boolean };` in `OpResult` to `"pane.keys": { ok: string };`.

Run: `npx tsc -p packages/protocol`
Expected: FAIL with `error TS2344: Type 'false' does not satisfy the constraint 'true'.` on the `OP_RESULTS` check line.

Change it back to `"pane.keys": { ok: boolean };` and run `npx tsc -p packages/protocol` again.
Expected: no output, exit 0.

- [ ] **Step 12: Run the repo's checks**

Run each in turn, from the repo root:
- `npm run check`. Expected: exit 0; svelte-check ends with `0 ERRORS 0 WARNINGS`.
- `npm run lint`. Expected: no problems reported.
- `npx vitest run --project units packages apps/hub`. Expected: everything passes. On a machine without `flock(1)` (macOS), the two `pane-lock.test.ts` tests fail exactly as they did before this task.
- `npm run build`. Expected: exit 0.
- `npm run check:build`. Expected: three `PASS` lines. The web app imports `@morndo/protocol`, so this checks the bundle budget. Measured on 2026-10-06, all client JS went from 299.9 KB to 301.5 KB gzipped (+9.6% against the recorded 275.0 KB; the limit is +15%).

- [ ] **Step 13: Commit**

```bash
git add packages/protocol/src/worker-id.ts packages/protocol/src/fleet.ts packages/protocol/src/index.ts packages/protocol/test/architecture.test.ts packages/protocol/test/worker-id.test.ts packages/protocol/test/fleet.test.ts
git commit -m "feat(protocol): fleet agent channel, worker IDs and join string"
```

- [ ] **Step 14: Wire the two apps that wave 1 creates into the tests, the type check and the linter**

Wave 1 runs three lanes at once. Tasks 6 (`apps/node-agent`) and 10 (`apps/fleet`) would otherwise both edit the same lines of four shared files, so both apps are wired here, before either exists:
- `vitest.config.ts:25`, the `units` include: replace `"apps/hub/test/**/*.test.ts", "apps/web/test/**/*.test.ts"]` with `"apps/hub/test/**/*.test.ts", "apps/node-agent/test/**/*.test.ts", "apps/fleet/test/**/*.test.ts", "apps/web/test/**/*.test.ts"]`.
- `tsconfig.tests.json`: after the line `"apps/hub/test",` add the lines `"apps/node-agent/test",` and `"apps/fleet/test",`.
- `.oxlintrc.json`, the second override's `"files"` (`["apps/hub/src/**"]`, lines 40–42): make it `"apps/hub/src/**"`, `"apps/node-agent/src/**"`, `"apps/fleet/src/**"`, one entry per line. Both apps log through their own redacting loggers, never `console`.
- `package.json:14`, the `"check"` script: insert ` && npm run typecheck --workspaces --if-present` right after `tsc -p apps/hub`. Each new app's own `package.json` defines `"typecheck": "tsc -p ."` (Tasks 6 and 10), and npm runs it in every workspace that has one: with `--if-present`, "npm will not exit with an error code when `run` is invoked for a script that isn't defined" (npm 11.19.0, `npm help run`, https://docs.npmjs.com/cli/v11/commands/npm-run, read 2026-10-06). A `tsc -p apps/node-agent` can't be added here: before the app exists it fails with `error TS5058: The specified path does not exist: 'apps/node-agent'`.

The vitest include and `tsconfig.tests.json` may name folders that don't exist yet: both were checked on 2026-10-06 with neither folder present (`tsc -p tsconfig.tests.json` exits 0, and vitest 5.0.3 runs every other file as before).

- [ ] **Step 15: Run the checks again**

- `npm run check`. Expected: exit 0; svelte-check ends with `0 ERRORS 0 WARNINGS`. No workspace defines `typecheck` yet, so that part runs nothing.
- `npm run lint`. Expected: no problems reported.
- `npx vitest run --project units packages/protocol`. Expected: PASS, 4 files, 57 tests, as in Step 10.

- [ ] **Step 16: Commit**

```bash
git add vitest.config.ts tsconfig.tests.json .oxlintrc.json package.json
git commit -m "build: wire apps/node-agent and apps/fleet into the tests, the type check and the linter"
```

---

### Task 2: `packages/node-ops`: the machine-local code, moved out of the hub

A pure move first, in its own commit: nothing moved changes behaviour, and the proof is that the full suite keeps the same tests and results (the only additions are the new package's architecture test). Then three additions, each in its own commit:
- `confine` (Steps 17–20);
- how every caller runs tmux, `tmux-cli.ts` (`-u`, exact session targets, `tmuxLiteral` for every argument tmux reads as a format), with the shared test helper `isolatedTmux` (Steps 21–25);
- the tmux server stamp and the health probe, `stamp.ts` and `health.ts`, which the agent uses (Steps 26–31).

**Files:**
- Create: `packages/node-ops/package.json`, `packages/node-ops/tsconfig.json`, `packages/node-ops/src/index.ts`
- Move (unchanged): `apps/hub/src/adapters/tmux.ts` → `packages/node-ops/src/tmux.ts`
- Move (unchanged): `apps/hub/src/adapters/terminal.ts` → `packages/node-ops/src/terminal.ts`
- Move (unchanged): `apps/hub/src/adapters/pane-lock.ts` → `packages/node-ops/src/pane-lock.ts`
- Create: `packages/node-ops/src/sessions.ts`, from `apps/hub/src/adapters/claude-sessions.ts:17-66` (`CHECKED_VERSION`, `SessionInfo`, `alive`, `sessionRegistry`)
- Create: `packages/node-ops/src/file-rules.ts`, from `apps/hub/src/adapters/files.ts:19,21,23-29` (`MAX_FILE_BYTES`, `SECRET_NAME`, `denyRoots`), then (Steps 17–20) the wider deny list, `deniedBy`, `confine`, `openNoFollow` and `openConfined`; the hub's `files.ts` then judges paths with `deniedBy` (`apps/hub/test/files.test.ts` gains one test)
- Create (Steps 21–25): `packages/node-ops/src/tmux-cli.ts`; the test helper `packages/node-ops/test/isolated-tmux.ts`, shared with the agent's and the drills' tests; `packages/node-ops/test/tmux-cli.test.ts`. Modify `packages/node-ops/src/tmux.ts` and `terminal.ts`: every tmux call through `tmuxArgv` (`-u`)
- Create (Steps 26–31): `packages/node-ops/src/stamp.ts`, `packages/node-ops/src/health.ts`, `packages/node-ops/test/stamp-health.test.ts`
- Modify:
  - `apps/hub/src/adapters/claude-sessions.ts:1-66`
  - `apps/hub/src/adapters/files.ts:10-29`
  - `apps/hub/src/main.ts:16,21,23,25,26,29`
  - `apps/hub/src/application/observation-service.ts:5-6`
  - `apps/hub/src/application/steering-service.ts:12`
  - `apps/hub/src/application/escalation-service.ts:14`
  - `apps/hub/src/application/remote-service.ts:10`
- Modify: `apps/hub/package.json:9-15` (dependencies), `package.json:14` (`check`), `.oxlintrc.json:28-46` (overrides), `package-lock.json` (by `npm install`)
- Move tests (unchanged, import paths only) from `apps/hub/test/` to `packages/node-ops/test/`:
  - `tmux.test.ts`, `tmux-menu-identity.test.ts`, `tmux-real-claude-dialogs.test.ts` and `tmux-real-claude-screens.test.ts`;
  - `terminal.test.ts` and `pane-lock.test.ts`;
  - the fixture folder `fixtures/claude-code-2.1.287/` (11 `.ansi` screen captures).
- Modify hub tests (imports only):
  - `apps/hub/test/steering-inflight-duplicate.test.ts:13`, `steering-durable.test.ts:12`, `steering-throw-retry.test.ts:11` and `steering.test.ts:9`;
  - `escalation-window.test.ts:13` and `escalation-service.test.ts:10`;
  - `observation-waiting-on.test.ts:8-9`, `observation-refollow.test.ts:9` and `observation-loop-errors.fixture.ts:5`;
  - `tmux-menu-prose.test.ts:9`, `tmux-no-input-box.test.ts:10` and `tmux-paste-escape.test.ts:11`;
  - `files.test.ts:6`.
- Modify: `apps/hub/test/claude-sessions.test.ts:2,7,19-32`. The registry test moves; the config test stays.
- Test: `packages/node-ops/test/architecture.test.ts` (new), `packages/node-ops/test/sessions.test.ts` (new, the moved registry test) and `packages/node-ops/test/file-rules.test.ts` (new)

**Interfaces:**
- Consumes:
  - `@morndo/domain`: `workerId` and `Worker` (tmux.ts uses them, as before);
  - `@morndo/protocol`: `LIMITS` (the `file-rules` test, and Task 3's `transcript-bytes.ts`) and the type `Health` (`health.ts`).
- Produces (all exported from `@morndo/node-ops`, signatures unchanged from the hub):
  - `tmux.ts`:
    - `tmuxAdapter(opts: { socket: string | null; session: string | null; historyLines?: number }): Tmux`;
    - `type Tmux = { listWorkers(): Promise<Worker[]>; capture(id: string): Promise<string | null>; send(id: string, text: string): Promise<SendProblem | null> }`;
    - `type SendProblem = "menu_open" | "draft_present" | "no_input_box" | "not_submitted" | "no_pane" | "busy"`;
    - `menuOnScreen(screen: string): boolean`, `menuIdentity(screen: string): string | null`, `inputBoxOnScreen(screen: string): boolean` and `draftOnScreen(screen: string): string | null`.
  - `terminal.ts`:
    - `terminalAdapter(opts: { socket: string | null }): Terminal`;
    - `type Terminal = { frame(id: string): Promise<Frame | null>; keys(id: string, data: string): Promise<boolean> }`;
    - `type Frame = { cols: number; rows: number; x: number; y: number; cursor: boolean; lines: string[] }`;
    - `keyArgs(id: string, data: string): string[]` and `MAX_KEYS = 4096`.
  - `sessions.ts`:
    - `sessionRegistry(configDir: string): { byPane(): Map<string, SessionInfo>; transcriptPath(sessionId: string): string | null }`;
    - `type SessionInfo = { sessionId: string; name: string | null; pane: string; cwd: string; version: string | null; pid: number }`;
    - `CHECKED_VERSION = "2.1.286"`.
  - `pane-lock.ts`: `paneLock(path: string, waitS?: number): PaneLock` and `type PaneLock = <T>(f: () => Promise<T>) => Promise<T | "busy">`.
  - `file-rules.ts`:
    - `MAX_FILE_BYTES = 25 << 20` (equal to `LIMITS.maxFileBytes`);
    - `SECRET_NAME: RegExp`;
    - `denyRoots(home: string, dataDir: string): string[]`;
    - `confine(path: string, opts: { home: string; dataDir: string; roots?: string[] }): { ok: true; real: string; size: number } | { ok: false; reason: "missing" | "denied" | "secret" | "too_large" | "not_file" }`;
    - from Step 18: `SECRET_NAME` also matches `.credentials.json`; `denyRoots` also covers `~/.local/share/morndo*`, `~/.local/state/morndo*`, `~/.config/morndo*` (a root ending in `*` is a prefix), `~/.local/share/kira` and `~/.config/kira`; `deniedBy(path: string, roots: readonly string[]): boolean`; `openNoFollow(real: string): Promise<FileHandle>` (`O_RDONLY | O_NOFOLLOW`); `openConfined(path, opts)`: `confine`, then `openNoFollow` and the checks again on the open file, `Promise<{ ok: true; fh: FileHandle; real: string; size: number } | { ok: false; reason }>`.
  - `tmux-cli.ts` (Step 23): `tmuxArgv(socket: string | null, args: readonly string[]): string[]`, `exactSession(name: string): string` and `tmuxLiteral(s: string): string`. `tmuxAdapter` and `terminalAdapter` keep their signatures and pass `-u` on every call from Step 23 on.
  - `stamp.ts` (Step 28): `stampServer(socket: string | null): Promise<string | null>`.
  - `health.ts` (Step 28): `type HealthProbe = Omit<Health, "wallClock" | "spoolDepth" | "drops">`, `healthProbe(home: string, o?: { tmuxSocket?: string | null }): Promise<HealthProbe>`, `memAvailableFrom(meminfo: string): number | null` and `psiFrom(pressure: string): { some10: number | null; full10: number | null }`.
  - the test helper `packages/node-ops/test/isolated-tmux.ts` (Step 21): `isolatedTmux(): TestTmux` and `type TestTmux = { socket: string; tmux(...args: string[]): string; kill(): void }`.

- [ ] **Step 1: Record the suite before anything moves**

Run: `npx vitest run --project units packages apps/hub`
Expected: all pass. Note the two totals, `Test Files N passed` and `Tests M passed`; Step 15 compares against them. On 2026-10-06, after Task 1, they were 82 files and 713 tests. On macOS, where there is no `flock(1)`, `pane-lock.test.ts` fails with 2 tests; it does so before and after the move.

- [ ] **Step 2: Write the failing architecture test**

```ts
// node-ops imports no app (docs/design/fleet-core/README.md §12): the hub's local adapters and the node agent both run
// it, so it may lean on Node, the domain and the protocol, never on apps/* or another npm package.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "../src");
const importsOf = (code: string) => [...code.matchAll(/(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map(m => m[1] ?? m[2] ?? "");

export const offending = (code: string) => importsOf(code).filter(spec =>
  !(/^\.\/[\w-]+\.ts$/.test(spec) || /^node:[\w/]+$/.test(spec) || spec === "@morndo/domain" || spec === "@morndo/protocol"));

describe("node-ops architecture", () => {
  it("every node-ops file imports only siblings, node:*, the domain and the protocol", () => {
    const files = readdirSync(SRC).filter(f => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    const bad = files.flatMap(f => offending(readFileSync(join(SRC, f), "utf8")).map(spec => `${f} -> ${spec}`));
    expect(bad).toEqual([]);
  });
  it("the check catches an app or a package (negative controls)", () => {
    expect(offending(`import { log } from "../../../apps/hub/src/adapters/log.ts";`)).toEqual(["../../../apps/hub/src/adapters/log.ts"]);
    expect(offending(`import type { Store } from "@morndo/hub";`)).toEqual(["@morndo/hub"]);
    expect(offending(`const ws = await import("ws");`)).toEqual(["ws"]);
    expect(offending(`import { spawn } from "child_process";`)).toEqual(["child_process"]);
    expect(offending(`import { spawn } from "node:child_process";\nexport * from "./tmux.ts";\nimport { LIMITS } from "@morndo/protocol";`)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run packages/node-ops/test/architecture.test.ts`
Expected: FAIL with `ENOENT: no such file or directory, scandir '…/packages/node-ops/src'`. The negative-control test passes.

- [ ] **Step 4: Create the package**

`packages/node-ops/package.json`:

```json
{
  "name": "@morndo/node-ops",
  "version": "0.0.0",
  "private": true,
  "description": "What a machine does to its own tmux and ~/.claude: panes, terminal frames and keys, the session registry, transcript bytes, the pane lock and file confinement. Used by the hub's local adapters and the node agent.",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@morndo/domain": "0.0.0",
    "@morndo/protocol": "0.0.0"
  }
}
```

`packages/node-ops/tsconfig.json`: like `packages/protocol`'s, but with Node's types, since this package is Node code:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["esnext"], "types": ["node"] },
  "include": ["src"]
}
```

- [ ] **Step 5: Move tmux, terminal and the pane lock without changing them**

```bash
mkdir -p packages/node-ops/src packages/node-ops/test/fixtures
git mv apps/hub/src/adapters/tmux.ts packages/node-ops/src/tmux.ts
git mv apps/hub/src/adapters/terminal.ts packages/node-ops/src/terminal.ts
git mv apps/hub/src/adapters/pane-lock.ts packages/node-ops/src/pane-lock.ts
```

Their imports (`node:*` and `@morndo/domain`) work unchanged from the new place.

- [ ] **Step 6: Move the session registry into `packages/node-ops/src/sessions.ts`**

Create `packages/node-ops/src/sessions.ts`. Its code is `claude-sessions.ts:15-66`, unchanged, under a header for the registry alone:

```ts
// Anti-corruption adapter over Claude Code's session registry (ADR-0006), read-only, on this machine:
// - the registry ~/.claude/sessions/<pid>.json: which session runs in which tmux pane ("tmux": "main:@0.%0");
// - transcripts ~/.claude/projects/<dir>/<sessionId>.jsonl: where each session's transcript is.
// Both are internal ("The entry format is internal to Claude Code and changes between versions",
// https://code.claude.com/docs/en/sessions, 2026-10-01). Checked against Claude Code 2.1.286; the contract tests use
// synthetic fixtures of that shape. Moved from the hub's claude-sessions.ts (fleet core, Task 2); the transcript parser
// stays in the hub.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// A field of a vendor file that should be text: itself, else the default (an object never becomes "[object Object]").
const text = (v: unknown, otherwise = "") => (typeof v === "string" ? v : otherwise);

export const CHECKED_VERSION = "2.1.286";

export type SessionInfo = { sessionId: string; name: string | null; pane: string; cwd: string; version: string | null; pid: number };

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

export function sessionRegistry(configDir: string) {
  const dir = join(configDir, "sessions");
  const transcripts = new Map<string, string>();
  return {
    // pane ID ("%3") → the live session in it
    byPane(): Map<string, SessionInfo> {
      const out = new Map<string, SessionInfo>();
      if (!existsSync(dir)) return out;
      let files: string[];
      try { files = readdirSync(dir); } catch { return out; }         // not a directory, or not ours to read: no sessions
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        let d: Record<string, unknown>;
        try { d = JSON.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
        if (d === null || typeof d !== "object") continue;            // e.g. a file holding `null`
        const pane = /(%\d+)$/.exec(text(d.tmux))?.[1];
        const pid = Number(d.pid);
        if (!pane || typeof d.sessionId !== "string" || !Number.isInteger(pid) || !alive(pid)) continue;
        const prev = out.get(pane);
        const info: SessionInfo = {
          sessionId: d.sessionId, name: typeof d.name === "string" ? d.name : null, pane, pid,
          cwd: text(d.cwd), version: typeof d.version === "string" ? d.version : null,
        };
        if (!prev || Number(d.updatedAt ?? 0) > 0) out.set(pane, info);
      }
      return out;
    },
    transcriptPath(sessionId: string): string | null {
      const cached = transcripts.get(sessionId);
      if (cached && existsSync(cached)) return cached;
      const projects = join(configDir, "projects");
      if (!existsSync(projects)) return null;
      let dirs: string[];
      try { dirs = readdirSync(projects); } catch { return null; }
      for (const p of dirs) {
        const candidate = join(projects, p, `${sessionId}.jsonl`);
        if (existsSync(candidate)) { transcripts.set(sessionId, candidate); return candidate; }
      }
      return null;
    },
  };
}
```

In `apps/hub/src/adapters/claude-sessions.ts`, replace lines 1–66 (the header, the imports, `text`, `CHECKED_VERSION`, `SessionInfo`, `alive` and `sessionRegistry`) with the block below. Everything from the line `// ---- transcript → conversation entries` onwards stays as it is.

```ts
// Anti-corruption adapter over Claude Code's transcripts (ADR-0006). Read-only: ~/.claude/projects/<dir>/<sessionId>.jsonl
// holds a session's messages. Which session runs in which pane, and where its transcript is, is the session registry
// (@morndo/node-ops, sessions.ts). The format is internal ("The entry format is internal to Claude Code and changes
// between versions", https://code.claude.com/docs/en/sessions, 2026-10-01). Checked against Claude Code 2.1.286, and the
// prompts it takes into a running turn against 2.1.284 to 2.1.288; the contract tests use synthetic fixtures of those
// shapes. The supported replacement is HTTP hooks.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { Attachment, Author, ConversationEntry, Message, QuestionPart } from "@morndo/domain";
import { describeFile } from "./file-kinds.ts";
import { OWNER_FILE } from "./attachment-note.ts";

// A field of a vendor file that should be text: itself, else the default (an object never becomes "[object Object]").
const text = (v: unknown, otherwise = "") => (typeof v === "string" ? v : otherwise);
```

- [ ] **Step 7: Move the file rules into `packages/node-ops/src/file-rules.ts`**

Create `packages/node-ops/src/file-rules.ts`. Its code is `files.ts:19,21,23-29`, unchanged; `confine` comes in Step 18.

```ts
// Which files may leave this machine's disk (ADR-0006 addendum "Files", ADR-0012 decision 5): anything over the size cap,
// anything that isn't a regular file, and anything where credentials live (the deny list, checked on the resolved real
// path, so a symbolic link doesn't get around it) is refused, whatever asks for it. Moved from the hub's files.ts
// (fleet core, Task 2): the hub's copies and a node's file ops apply the same rules.
import { join } from "node:path";

export const MAX_FILE_BYTES = 25 << 20;
export const SECRET_NAME = /^(id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.+\.(pem|key|p12|pfx|kdbx|keystore|jks)|\.env(\..+)?|\.netrc|\.npmrc|\.pypirc|credentials(\.json)?)$/i;

// Places that hold credentials or the hub's own secrets; nothing under them is ever copied.
export function denyRoots(home: string, dataDir: string): string[] {
  return [
    ...[".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".config/gcloud", ".config/gh", ".password-store", ".local/share/keyrings", ".claude/.credentials.json", ".vnc"].map(p => join(home, p)),
    "/etc", "/proc", "/sys", "/dev", "/root", dataDir,
  ];
}
```

In `apps/hub/src/adapters/files.ts`, replace lines 10–11:

```ts
import type { AttachmentKind } from "@morndo/domain";
import { describeFile } from "./file-kinds.ts";
```

with:

```ts
import type { AttachmentKind } from "@morndo/domain";
import { MAX_FILE_BYTES, SECRET_NAME } from "@morndo/node-ops";
import { describeFile } from "./file-kinds.ts";
```

Then replace the block from `export const MAX_FILE_BYTES = 25 << 20;` through the closing `}` of `denyRoots`. These were lines 19–29 before the import edit, and are now 20–30. The replacement:

```ts
const BUDGET_BYTES = 2 * 1024 ** 3;                    // not 2 << 30: shifts are 32-bit in JavaScript
// The rules themselves (the size cap, secret names, the deny list) are @morndo/node-ops' file-rules.ts.
```

`fileStore` keeps its own `denied` closure over `opts.deny` and `SECRET_NAME`, unchanged.

- [ ] **Step 8: Write `packages/node-ops/src/index.ts`**

```ts
// What one machine does to its own tmux and ~/.claude (docs/design/fleet-core/README.md §3): moved from the hub so the
// hub's local adapters and the node agent run the same code. Imports no app (architecture test).
export * from "./tmux.ts";
export * from "./terminal.ts";
export * from "./sessions.ts";
export * from "./pane-lock.ts";
export * from "./file-rules.ts";
```

- [ ] **Step 9: Make the hub depend on it and link the workspace**

In `apps/hub/package.json`, add `"@morndo/node-ops": "0.0.0",` as the first entry of `"dependencies"`, before `"@morndo/protocol": "0.0.0",`. Then:

Run: `npm install`
Expected: `added 1 package`. `ls -l node_modules/@morndo/node-ops` shows a link to `../../packages/node-ops`. `package-lock.json` gains three things: `"@morndo/node-ops": "0.0.0"` under `apps/hub`, a `node_modules/@morndo/node-ops` link entry, and a `packages/node-ops` entry. No external package is added (Global Constraints: no new dependencies).

- [ ] **Step 10: Point the hub's sources at `@morndo/node-ops`**

Each edit replaces exactly the lines shown. Line numbers are as the files stand before this step.

`apps/hub/src/main.ts`:
- Replace line 16, `import { tmuxAdapter } from "./adapters/tmux.ts";`, with `import { denyRoots, paneLock, sessionRegistry, terminalAdapter, tmuxAdapter, type Tmux } from "@morndo/node-ops";`.
- Delete these four lines:
  - line 21: `import { sessionRegistry } from "./adapters/claude-sessions.ts";`
  - line 23: `import { paneLock } from "./adapters/pane-lock.ts";`
  - line 25: `import type { Tmux } from "./adapters/tmux.ts";`
  - line 26: `import { terminalAdapter } from "./adapters/terminal.ts";`
- Replace line 29, `import { denyRoots, fileStore } from "./adapters/files.ts";`, with `import { fileStore } from "./adapters/files.ts";`.

`apps/hub/src/application/observation-service.ts`, replace lines 5–6:

```ts
import { menuIdentity, menuOnScreen, type Tmux } from "../adapters/tmux.ts";
import { readOlder, readTranscript, type FileRef, type SessionInfo, type TranscriptCursor } from "../adapters/claude-sessions.ts";
```

with:

```ts
import { menuIdentity, menuOnScreen, type SessionInfo, type Tmux } from "@morndo/node-ops";
import { readOlder, readTranscript, type FileRef, type TranscriptCursor } from "../adapters/claude-sessions.ts";
```

Three more import lines change:
- `apps/hub/src/application/steering-service.ts:12`: `import type { SendProblem, Tmux } from "../adapters/tmux.ts";` → `import type { SendProblem, Tmux } from "@morndo/node-ops";`
- `apps/hub/src/application/escalation-service.ts:14`: `import { menuIdentity, menuOnScreen, type SendProblem } from "../adapters/tmux.ts";` → `import { menuIdentity, menuOnScreen, type SendProblem } from "@morndo/node-ops";`
- `apps/hub/src/application/remote-service.ts:10`: `import type { Terminal } from "../adapters/terminal.ts";` → `import type { Terminal } from "@morndo/node-ops";`

Run: `npx tsc -p apps/hub`
Expected: errors only in `apps/hub/test/…` files that still import the moved modules. Step 11 fixes those. `apps/hub/src` has no errors.

- [ ] **Step 11: Move the tests that test only moved code, and re-point the rest**

```bash
for f in tmux.test.ts tmux-menu-identity.test.ts tmux-real-claude-dialogs.test.ts tmux-real-claude-screens.test.ts terminal.test.ts pane-lock.test.ts; do
  git mv "apps/hub/test/$f" "packages/node-ops/test/$f"
done
git mv apps/hub/test/fixtures/claude-code-2.1.287 packages/node-ops/test/fixtures/claude-code-2.1.287
sed -i.bak -e 's#"../src/adapters/tmux.ts"#"../src/tmux.ts"#' -e 's#"../src/adapters/terminal.ts"#"../src/terminal.ts"#' -e 's#"../src/adapters/pane-lock.ts"#"../src/pane-lock.ts"#' packages/node-ops/test/*.test.ts
rm packages/node-ops/test/*.test.ts.bak
```

Expected: `grep -n 'from "../src' packages/node-ops/test/*.test.ts` shows only `../src/tmux.ts`, `../src/terminal.ts` and `../src/pane-lock.ts`. The two real-screen tests read `fixtures/claude-code-2.1.287` relative to `import.meta.dirname`, which now resolves to the moved folder. `apps/hub/test/fixtures` is gone.

Create `packages/node-ops/test/sessions.test.ts`. It is the registry test from `claude-sessions.test.ts:20-32`, unchanged:

```ts
// Contract test for the session registry on synthetic fixtures shaped like Claude Code 2.1.286's files (moved from the
// hub's claude-sessions.test.ts with the registry, fleet core Task 2).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionRegistry } from "../src/sessions.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-claude-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("session registry", () => {
  it("maps live sessions to their tmux pane and finds their transcript", () => {
    mkdirSync(join(dir, "sessions"));
    mkdirSync(join(dir, "projects", "-tmp-demo"), { recursive: true });
    writeFileSync(join(dir, "sessions", "1.json"), JSON.stringify({ pid: process.pid, sessionId: "s-live", tmux: "qa:@0.%3", name: "builder-1a", cwd: "/tmp/demo", version: "2.1.286", updatedAt: 1 }));
    writeFileSync(join(dir, "sessions", "2.json"), JSON.stringify({ pid: 999_999_999, sessionId: "s-dead", tmux: "qa:@1.%4" }));
    writeFileSync(join(dir, "projects", "-tmp-demo", "s-live.jsonl"), "");
    const reg = sessionRegistry(dir);
    const panes = reg.byPane();
    expect([...panes.keys()]).toEqual(["%3"]);                       // the dead process's entry is ignored
    expect(panes.get("%3")?.name).toBe("builder-1a");
    expect(reg.transcriptPath("s-live")).toBe(join(dir, "projects", "-tmp-demo", "s-live.jsonl"));
    expect(reg.transcriptPath("nope")).toBeNull();
  });
});
```

In `apps/hub/test/claude-sessions.test.ts`:
- Replace line 2 with `import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";`. `mkdirSync` is no longer used.
- Replace line 7 with `import { parseLine, readOlder, readTranscript, type TranscriptCursor } from "../src/adapters/claude-sessions.ts";`.
- Replace lines 19–33 with the block below. The test `"maps live sessions to their tmux pane and finds their transcript"` moves; the `loadConfig` test stays.

```ts
// The registry itself moved to @morndo/node-ops (packages/node-ops/test/sessions.test.ts); which one the hub reads is its config.
describe("session registry", () => {
  it("a private tmux server never reads the real sessions unless told to", () => {
```

The hub tests that stay change their imports only. Each line becomes the one after the arrow:
- `apps/hub/test/steering-inflight-duplicate.test.ts:13` and `apps/hub/test/steering-durable.test.ts:12`: `import type { SendProblem, Tmux } from "../src/adapters/tmux.ts";` → `import type { SendProblem, Tmux } from "@morndo/node-ops";`
- `apps/hub/test/escalation-window.test.ts:13` and `apps/hub/test/steering-throw-retry.test.ts:11`: `import type { Tmux } from "../src/adapters/tmux.ts";` → `import type { Tmux } from "@morndo/node-ops";`
- `apps/hub/test/escalation-service.test.ts:10`: `import type { SendProblem } from "../src/adapters/tmux.ts";` → `import type { SendProblem } from "@morndo/node-ops";`
- `apps/hub/test/steering.test.ts:9`: `import { draftOnScreen, inputBoxOnScreen, menuOnScreen, tmuxAdapter } from "../src/adapters/tmux.ts";` → `import { draftOnScreen, inputBoxOnScreen, menuOnScreen, tmuxAdapter } from "@morndo/node-ops";`
- `apps/hub/test/observation-waiting-on.test.ts:8-9`, both lines, `import { sessionRegistry } from "../src/adapters/claude-sessions.ts";` and `import { menuIdentity } from "../src/adapters/tmux.ts";` → the single line `import { menuIdentity, sessionRegistry } from "@morndo/node-ops";`
- `apps/hub/test/observation-refollow.test.ts:9` and `apps/hub/test/observation-loop-errors.fixture.ts:5`: `import { sessionRegistry } from "../src/adapters/claude-sessions.ts";` → `import { sessionRegistry } from "@morndo/node-ops";`
- `apps/hub/test/tmux-menu-prose.test.ts:9`: `import { menuOnScreen, tmuxAdapter } from "../src/adapters/tmux.ts";` → `import { menuOnScreen, tmuxAdapter } from "@morndo/node-ops";`
- `apps/hub/test/tmux-no-input-box.test.ts:10`: `import { draftOnScreen, tmuxAdapter } from "../src/adapters/tmux.ts";` → `import { draftOnScreen, tmuxAdapter } from "@morndo/node-ops";`
- `apps/hub/test/tmux-paste-escape.test.ts:11`: `import { tmuxAdapter } from "../src/adapters/tmux.ts";` → `import { tmuxAdapter } from "@morndo/node-ops";`
- `apps/hub/test/files.test.ts:6`: `import { denyRoots, fileStore, servingHeaders, storedIds } from "../src/adapters/files.ts";` → two lines:

```ts
import { denyRoots } from "@morndo/node-ops";
import { fileStore, servingHeaders, storedIds } from "../src/adapters/files.ts";
```

These tests stay in the hub because they also exercise hub code (`Store`, `SteeringService`, `EscalationService`, `manager-protocol.ts`), and `tmux-fake-claude.fixture.ts` stays with them. The loop-errors fixture runs as a child `node` process. Node resolves `@morndo/node-ops` through the workspace link to the real path under `packages/`, so type stripping applies, as it already does for `@morndo/domain`.

Run: `grep -rn 'adapters/tmux\|adapters/terminal\|adapters/pane-lock\|sessionRegistry } from "../src/adapters' apps/hub`
Expected: no output.

- [ ] **Step 12: Wire the package into the checks**

- `package.json:14`, the `"check"` script: insert ` && tsc -p packages/node-ops` after `tsc -p packages/protocol`. The script then starts `"check": "tsc -p packages/domain && tsc -p packages/protocol && tsc -p packages/node-ops && tsc -p packages/brand && …`; the rest is unchanged.
- `.oxlintrc.json`, the first override's `"files"` (lines 29–34): replace `"apps/hub/src/adapters/tmux.ts",` with these two lines. The moved tmux code and tests keep `no-control-regex` off; the hub's `apps/hub/test/tmux-*.ts` entry stays.

```json
        "packages/node-ops/src/tmux.ts",
        "packages/node-ops/test/tmux*.ts",
```

- `.oxlintrc.json`, the second override's `"files"` (Task 1 Step 14 made it `"apps/hub/src/**"`, `"apps/node-agent/src/**"`, `"apps/fleet/src/**"`): add `"packages/node-ops/src/**"` right after `"apps/hub/src/**"`, on its own line. Logging in node-ops then goes through a logger, as in the hub.
- Nothing to do for the tests' wiring. `vitest.config.ts:24` already includes `packages/*/test/**/*.test.ts`, and `tsconfig.tests.json` already includes `packages/*/test`.

- [ ] **Step 13: Run the node-ops tests**

Run: `npx vitest run packages/node-ops`
Expected: PASS: `architecture`, `sessions`, `tmux` (4 files) and `terminal` (on a private tmux server), and `pane-lock`. On a machine without `flock(1)`, `pane-lock`'s 2 tests fail with `spawn flock ENOENT`, exactly as they did in `apps/hub/test` (Step 1).

- [ ] **Step 14: Run the types, lint and the hub under Node**

- `npm run check`. Expected: exit 0.
- `npm run lint`. Expected: no problems reported.
- `MORNDO_HOME="$(mktemp -d)" node apps/hub/src/main.ts devices`. Expected: exit 0 with no output. This shows the real hub starts with the moved imports under Node's type stripping, not only under Vitest.

- [ ] **Step 15: Prove it is a pure move: run the full hub suite and everything else**

Run: `npx vitest run --project units packages apps/hub`
Expected: `Test Files` = Step 1's N + 2 and `Tests` = Step 1's M + 2, with the same failures as Step 1 (none on Linux). The +2 files are `architecture.test.ts` and `sessions.test.ts` in node-ops. The +2 tests are the architecture test's two; the registry test only changed folders. On 2026-10-06 that was 84 files and 715 tests.

Run: `npx vitest run apps/hub`
Expected: every hub test passes, including `observation-*`, `steering*`, `tmux-menu-prose`, `tmux-no-input-box`, `tmux-paste-escape`, `files` and `claude-sessions*`.

- [ ] **Step 16: Commit the move**

```bash
git add -A packages/node-ops apps/hub package.json package-lock.json .oxlintrc.json
git commit -m "refactor(node-ops): move tmux, terminal, session registry, pane lock and file rules out of the hub"
```

- [ ] **Step 17: Write the failing `confine` test**

```ts
// confine(): which file on this machine may be read for someone else, by the rules the hub's copies use (files.ts),
// plus a node policy's roots. Synthetic files in a temporary directory only.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIMITS } from "@morndo/protocol";
import { MAX_FILE_BYTES, confine, deniedBy, denyRoots, openConfined, openNoFollow } from "../src/file-rules.ts";

let root: string, home: string, data: string, work: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "morndo-confine-"));
  home = join(root, "home"); data = join(root, "data"); work = join(root, "work");
  for (const d of [home, join(home, ".ssh"), data, work]) mkdirSync(d, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const rules = () => ({ home, dataDir: data });

describe("confine", () => {
  it("allows a plain file: its real path and size", () => {
    writeFileSync(join(work, "shot.png"), "png-bytes");
    expect(confine(join(work, "shot.png"), rules())).toEqual({ ok: true, real: realpathSync(join(work, "shot.png")), size: 9 });
  });
  it("refuses what the hub's copies refuse, each with its reason", () => {
    writeFileSync(join(home, ".ssh", "id_ed25519"), "key");
    writeFileSync(join(home, ".ssh", "config"), "Host x");
    writeFileSync(join(work, ".env"), "TOKEN=x");
    writeFileSync(join(work, "server.pem"), "pem");
    writeFileSync(join(data, "agent.db"), "db");
    symlinkSync(join(home, ".ssh", "id_ed25519"), join(work, "innocent.png"));
    writeFileSync(join(work, "big.bin"), "");
    truncateSync(join(work, "big.bin"), MAX_FILE_BYTES + 1);                  // sparse: no 25 MiB written
    const reason = (p: string) => { const r = confine(p, rules()); return r.ok ? "ok" : r.reason; };
    expect(reason(join(home, ".ssh", "id_ed25519"))).toBe("secret");
    expect(reason(join(home, ".ssh", "config"))).toBe("denied");
    expect(reason(join(work, ".env"))).toBe("secret");
    expect(reason(join(work, "server.pem"))).toBe("secret");
    expect(reason(join(data, "agent.db"))).toBe("denied");
    expect(reason(join(work, "innocent.png"))).toBe("secret");                // a link: its target's name counts
    expect(reason(join(work, "big.bin"))).toBe("too_large");
    expect(reason(work)).toBe("not_file");
    expect(reason(join(work, "missing.png"))).toBe("missing");
    expect(reason("work/shot.png")).toBe("denied");                           // a relative path: never resolved against our cwd
    expect(reason("/etc/hosts")).toBe("denied");
    expect(reason(`${home}/x/../.ssh/absent`)).toBe("denied");               // judged before the disk: "missing" would tell
    writeFileSync(join(work, "ok.txt"), "fine");
    expect(reason(join(work, "ok.txt"))).toBe("ok");                         // negative control: a plain file passes
  });
  it("a file exactly at the cap passes; the cap is the fleet's file limit", () => {
    expect(MAX_FILE_BYTES).toBe(LIMITS.maxFileBytes);
    writeFileSync(join(work, "cap.bin"), "");
    truncateSync(join(work, "cap.bin"), MAX_FILE_BYTES);
    expect(confine(join(work, "cap.bin"), rules())).toMatchObject({ ok: true, size: MAX_FILE_BYTES });
  });
  it("a link into a deny root is refused even when the home itself sits behind a link", () => {
    const realHome = join(root, "real-home");
    mkdirSync(join(realHome, ".ssh"), { recursive: true });
    writeFileSync(join(realHome, ".ssh", "config"), "Host x");
    const linkedHome = join(root, "linked-home");
    symlinkSync(realHome, linkedHome);
    symlinkSync(join(realHome, ".ssh", "config"), join(work, "notes.txt"));
    const r = confine(join(work, "notes.txt"), { home: linkedHome, dataDir: data });
    expect(r).toEqual({ ok: false, reason: "denied" });
    // negative control: the deny roots as given don't hold the link's real path; only resolving them catches it
    const real = realpathSync(join(work, "notes.txt"));
    expect(denyRoots(linkedHome, data).some(d => real === d || real.startsWith(d + sep))).toBe(false);
  });
  it("with roots, only files under them; a link out of a root is refused", () => {
    const allowed = join(root, "allowed");
    mkdirSync(allowed);
    writeFileSync(join(allowed, "a.txt"), "a");
    writeFileSync(join(work, "b.txt"), "b");
    symlinkSync(join(work, "b.txt"), join(allowed, "escape.txt"));
    expect(confine(join(allowed, "a.txt"), { ...rules(), roots: [allowed] })).toMatchObject({ ok: true });
    expect(confine(join(work, "b.txt"), { ...rules(), roots: [allowed] })).toEqual({ ok: false, reason: "denied" });
    expect(confine(join(allowed, "escape.txt"), { ...rules(), roots: [allowed] })).toEqual({ ok: false, reason: "denied" });
    expect(confine(join(work, "b.txt"), rules())).toMatchObject({ ok: true });       // negative control: no roots, no limit
  });
  it("refuses the control plane's and every node's own state, and each account's credentials, links into them included", () => {
    const at = (rel: string, content = "x") => { const p = join(home, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, content); return p; };
    const state = [".local/share/morndo/morndo.db", ".local/share/morndo-fleet/fleet.db", ".local/state/morndo-fleet/fleet.sock.lock",
      ".local/state/morndo-node/agent.db", ".config/morndo-node/config.json", ".config/morndo-node/policy.json", ".config/morndo-fleet/config.json",
      ".local/share/kira/state.json", ".config/kira/config.json"].map(rel => at(rel));
    const credentials = [at(".claude/.credentials.json"), at(".claude-accounts/acct2/.credentials.json")];
    symlinkSync(state[0] ?? "", join(work, "notes.txt"));
    const reason = (p: string) => { const r = confine(p, rules()); return r.ok ? "ok" : r.reason; };
    for (const p of state) expect(reason(p), p).toBe("denied");
    for (const p of credentials) expect(reason(p), p).toBe("secret");
    expect(reason(join(work, "notes.txt"))).toBe("denied");                   // a link into the hub's database
    expect(reason(at(".local/share/other/x.txt"))).toBe("ok");                // negative control: a neighbour of theirs passes
    expect(reason(at(".config/morn/x.txt"))).toBe("ok");
  });
});

describe("deniedBy", () => {
  it("a root is itself and what lies under it; a root ending in * is a prefix", () => {
    const roots = ["/h/.ssh", "/h/.config/morndo*"];
    for (const p of ["/h/.ssh", "/h/.ssh/id", "/h/.config/morndo", "/h/.config/morndo-node/key", "/h/.config/morndo-fleet"]) expect(deniedBy(p, roots), p).toBe(true);
    for (const p of ["/h/.sshx", "/h/.config/morn", "/h/.config/other/morndo", "/h/x/.ssh"]) expect(deniedBy(p, roots), p).toBe(false);
  });
});

describe("openConfined", () => {
  it("opens what confine allows, and refuses what it refuses", async () => {
    writeFileSync(join(work, "shot.png"), "png-bytes");
    const r = await openConfined(join(work, "shot.png"), rules());
    expect(r).toMatchObject({ ok: true, real: realpathSync(join(work, "shot.png")), size: 9 });
    if (r.ok) { expect((await r.fh.readFile()).toString()).toBe("png-bytes"); await r.fh.close(); }
    writeFileSync(join(home, ".ssh", "id_ed25519"), "key");
    expect(await openConfined(join(home, ".ssh", "id_ed25519"), rules())).toEqual({ ok: false, reason: "secret" });
    expect(await openConfined(join(work, "missing.png"), rules())).toEqual({ ok: false, reason: "missing" });
  });
  it("never follows a link in the last place (one swapped in after confine looked); a file opens (negative control)", async () => {
    writeFileSync(join(home, ".ssh", "config"), "Host x");
    symlinkSync(join(home, ".ssh", "config"), join(work, "swapped.txt"));
    await expect(openNoFollow(join(work, "swapped.txt"))).rejects.toMatchObject({ code: "ELOOP" });
    writeFileSync(join(work, "plain.txt"), "plain");
    const fh = await openNoFollow(join(work, "plain.txt"));
    expect((await fh.readFile()).toString()).toBe("plain");
    await fh.close();
  });
});
```

Run: `npx vitest run packages/node-ops/test/file-rules.test.ts`
Expected: FAIL, 9 tests: `TypeError: confine is not a function` (6), and `deniedBy is not a function`, `openConfined is not a function` and `openNoFollow is not a function` (1 each).

- [ ] **Step 18: Write `confine` and `openConfined`, and judge the hub's copies by the same list**

Replace `packages/node-ops/src/file-rules.ts` with the following. `MAX_FILE_BYTES` is unchanged from Step 7. `SECRET_NAME` also matches `.credentials.json` (each account's `~/.claude-accounts/<name>/.credentials.json`, wherever it is), and `denyRoots` also covers the state of Morndo's own services and kira's: the hub's `morndo.db`, the fleet's `fleet.db` and key, an agent's database, key, config and policy. A node must never hand those out, and the control plane is itself a node.

```ts
// Which files may leave this machine's disk (ADR-0006 addendum "Files", ADR-0012 decision 5): anything over the size cap,
// anything that isn't a regular file, and anything where credentials or Morndo's own services keep their state (the
// deny list, checked on the resolved real path, so a symbolic link doesn't get around it) is refused, whatever asks for
// it. Moved from the hub's files.ts (fleet core, Task 2): the hub's copies and a node's file ops apply the same rules.
import { constants, realpathSync, statSync, type Stats } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";

export const MAX_FILE_BYTES = 25 << 20;
// Secrets by their name, wherever they are: keys, certificates, .env files and credentials files, Claude Code's own
// .credentials.json among them (~/.claude/.credentials.json, and each ~/.claude-accounts/<name>/.credentials.json).
export const SECRET_NAME = /^(id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.+\.(pem|key|p12|pfx|kdbx|keystore|jks)|\.env(\..+)?|\.netrc|\.npmrc|\.pypirc|\.?credentials(\.json)?)$/i;

// Places that hold credentials, or the state of Morndo's own services: the hub's morndo.db, the fleet's fleet.db and
// key, a node agent's agent.db, key, config and policy (~/.local/share/morndo*, ~/.local/state/morndo*,
// ~/.config/morndo*), kira's state, and the caller's own data directory. Nothing under them is ever read for someone
// else. An entry ending in "*" is a prefix: "~/.config/morndo*" covers morndo, morndo-fleet and morndo-node.
export function denyRoots(home: string, dataDir: string): string[] {
  return [
    ...[".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".config/gcloud", ".config/gh", ".password-store", ".local/share/keyrings", ".claude/.credentials.json", ".vnc",
      ".local/share/morndo*", ".local/state/morndo*", ".config/morndo*", ".local/share/kira", ".config/kira"].map(p => join(home, p)),
    "/etc", "/proc", "/sys", "/dev", "/root", dataDir,
  ];
}

// Whether `path` is one of `roots` or lies under one; a root ending in "*" covers every path that starts with the rest.
export function deniedBy(path: string, roots: readonly string[]): boolean {
  return roots.some(r => (r.endsWith("*") ? path.startsWith(r.slice(0, -1)) : path === r || path.startsWith(r.endsWith(sep) ? r : r + sep)));
}
// Each root as given and resolved: a real path never runs through a symbolic link, so a home behind one (macOS keeps
// its temporary folders under /var, a link to /private/var) is still caught. A "*" root resolves its directory.
const resolved = (roots: readonly string[]) => roots.flatMap(r => {
  const star = r.endsWith("*");
  const base = star ? dirname(r) : r;
  try {
    const real = realpathSync(base);
    return real === base ? [r] : [r, star ? join(real, basename(r)) : real];
  } catch { return [r]; }
});

type Refusal = { ok: false; reason: "missing" | "denied" | "secret" | "too_large" | "not_file" };

// Whether a file on this machine may be read for someone else (a node's file ops, its hook relay's copies), by the
// rules above: an absolute path; no secret's name, asked for or resolved; nothing under a deny root, asked for or
// resolved; a regular file of at most MAX_FILE_BYTES. With `roots` (a node policy's fileRoots), the resolved path must
// also lie under one of them. The path as asked for is judged before the disk is touched, so whether something exists
// under a deny root is never told.
export function confine(path: string, opts: { home: string; dataDir: string; roots?: string[] }): { ok: true; real: string; size: number } | Refusal {
  if (!isAbsolute(path)) return { ok: false, reason: "denied" };
  const deny = resolved(denyRoots(opts.home, opts.dataDir));
  const asked = normalize(path);                                      // "a/../.ssh" judged as ".ssh", before the disk
  if (SECRET_NAME.test(basename(asked))) return { ok: false, reason: "secret" };
  if (deniedBy(asked, deny)) return { ok: false, reason: "denied" };
  let real: string;
  let st: Stats;
  try { real = realpathSync(path); st = statSync(real); } catch { return { ok: false, reason: "missing" }; }
  if (!st.isFile()) return { ok: false, reason: "not_file" };
  if (SECRET_NAME.test(basename(real))) return { ok: false, reason: "secret" };
  if (deniedBy(real, deny)) return { ok: false, reason: "denied" };
  if (opts.roots && !deniedBy(real, resolved(opts.roots))) return { ok: false, reason: "denied" };
  if (st.size > MAX_FILE_BYTES) return { ok: false, reason: "too_large" };
  return { ok: true, real, size: st.size };
}

// Opens a resolved path for reading without following a link in its last component (O_NOFOLLOW, open(2)): a link put
// there after confine() looked fails with ELOOP instead of being followed.
export function openNoFollow(real: string): Promise<FileHandle> {
  return open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
}

// confine(), then the file opened with openNoFollow and checked again on the open file (a regular file, at most
// MAX_FILE_BYTES): something swapped in after confine() looked is refused, never read. Every read a node does for
// someone else goes through here; the caller reads from `fh` and closes it.
export async function openConfined(path: string, opts: { home: string; dataDir: string; roots?: string[] }):
  Promise<{ ok: true; fh: FileHandle; real: string; size: number } | Refusal> {
  const c = confine(path, opts);
  if (!c.ok) return c;
  let fh: FileHandle;
  try { fh = await openNoFollow(c.real); }
  catch (e) { return { ok: false, reason: (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "denied" }; }   // ELOOP: a link now
  const st = await fh.stat();
  const reason = !st.isFile() ? "not_file" : st.size > MAX_FILE_BYTES ? "too_large" : null;
  if (reason) { await fh.close(); return { ok: false, reason }; }
  return { ok: true, fh, real: c.real, size: st.size };
}
```

The hub's copies judge paths by the same list. In `apps/hub/src/adapters/files.ts`:
- replace `import { basename, join, sep } from "node:path";` with `import { basename, join } from "node:path";`;
- replace `import { MAX_FILE_BYTES, SECRET_NAME } from "@morndo/node-ops";` with `import { MAX_FILE_BYTES, SECRET_NAME, deniedBy } from "@morndo/node-ops";`;
- replace `  const denied = (real: string) => SECRET_NAME.test(basename(real)) || opts.deny.some(d => real === d || real.startsWith(d.endsWith(sep) ? d : d + sep));` with `  const denied = (real: string) => SECRET_NAME.test(basename(real)) || deniedBy(real, opts.deny);`.

In `apps/hub/test/files.test.ts`, after the test `"refuses credentials, the hub's own data, secrets by name, links into them, directories and big files"`, add:

```ts
  it("refuses the fleet's, the agents' and kira's state and each account's credentials, as a node does (node-ops' deny list)", () => {
    const at = (rel: string) => { const p = join(home, rel); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, "x"); return p; };
    const s = store();
    for (const rel of [".local/share/morndo-fleet/fleet.db", ".local/state/morndo-node/agent.db", ".config/morndo-node/policy.json", ".local/share/kira/state.json",
      ".claude-accounts/acct2/.credentials.json"]) {
      expect(s.register(at(rel)).id, rel).toBeNull();
    }
    expect(s.register(at(".local/share/other/ok.txt")).id).not.toBeNull();  // negative control: a neighbour of theirs is kept
  });
```

- [ ] **Step 19: Run it**

Run: `npx vitest run packages/node-ops/test/file-rules.test.ts`
Expected: PASS (9 tests).

Run: `npx vitest run apps/hub/test/files.test.ts`
Expected: PASS (6 tests).

Then check that each guard is needed. Make each change alone, run the named test file, and restore the line before the next:
- In `file-rules.ts`, change `const asked = normalize(path);` to `const asked = path;` (file-rules test). Expected: 1 failure, `expected 'missing' to be 'denied'` for `${home}/x/../.ssh/absent`.
- Delete the line `  if (deniedBy(real, deny)) return { ok: false, reason: "denied" };` (file-rules test). Expected: 2 failures, in "a link into a deny root is refused even when the home itself sits behind a link" and "refuses the control plane's and every node's own state…" (the link into `morndo.db`).
- In `deniedBy`, change `(r.endsWith("*") ? path.startsWith(r.slice(0, -1)) : path === r` to `(false ? path.startsWith(r.slice(0, -1)) : path === r` (file-rules test). Expected: 2 failures, `…/home/.local/share/morndo/morndo.db: expected 'ok' to be 'denied'` and `/h/.config/morndo: expected false to be true`.
- In `SECRET_NAME`, change `|\.?credentials(\.json)?)$/i` to `|credentials(\.json)?)$/i` (file-rules test). Expected: 1 failure, `…/home/.claude/.credentials.json: expected 'denied' to be 'secret'`.
- In `openNoFollow`, change `constants.O_RDONLY | constants.O_NOFOLLOW` to `constants.O_RDONLY` (file-rules test). Expected: 1 failure, `promise resolved "FileHandle{ … }" instead of rejecting`.
- In `files.ts`, change `|| deniedBy(real, opts.deny);` to ``|| opts.deny.some(d => real === d || real.startsWith(`${d}/`));`` (files test). Expected: 1 failure, `.local/share/morndo-fleet/fleet.db: expected '<32 hex>' to be null`.

Then, each on its own:
- `npx tsc -p packages/node-ops`. Expected: exit 0.
- `npx tsc -p tsconfig.tests.json`. Expected: exit 0.
- `npm run lint`. Expected: no problems.

- [ ] **Step 20: Commit**

```bash
git add packages/node-ops/src/file-rules.ts packages/node-ops/test/file-rules.test.ts apps/hub/src/adapters/files.ts apps/hub/test/files.test.ts
git commit -m "feat(node-ops): confine() and openConfined() apply the file rules on a node; Morndo's and kira's own state denied"
```

- [ ] **Step 21: Write the shared tmux test helper and the failing test of how node-ops calls tmux**

Four rules, each seen on tmux 3.6a on 2026-10-06, become one place every caller uses (the moved adapters here, the agent in Tasks 8–9, the drills in Task 16):
- `-u` on every call. tmux writes UTF-8 only when the first of `LC_ALL`, `LC_CTYPE` and `LANG` that is set says UTF-8. A service started without a locale otherwise gets every non-ASCII character, and even a tab, as `_`: a window `ünï<TAB>tab` lists as `_n__tab`.
- A session target is `=name`. Without `=`, tmux also takes a prefix: `-t mai` finds `main`.
- Some arguments are formats: `new-window -n` (a window name) and `-c` (its directory), `new-session -s`/`-n`/`-c`, `rename-window`. `a#S b` becomes `amain b`, and a directory `a#{session_name}b` starts the pane in `amainb`; a `#(…)` in one expanded to nothing (no job ran within 2 s on tmux 3.6a; older versions are not known to behave the same). `tmuxLiteral` writes `#` as `##` for every such argument that carries outside data.
- A window is never targeted by its name: the window part of a target is a pattern (`-t '=main:f*'` found `f*x`) and is split at `.` (`=main:fix.a` looked for `fix`), and `display-message -p -t` with a target that matched nothing printed the current window with exit 0. Callers target `@N` or `%N`, found by listing. No `-F` or `display-message -p` format is built from outside data.

The test helper `isolatedTmux` is shared: the agent's tests (Task 6, `helpers.ts`) and the drills (Task 16) import it. Its `kill()` waits until the server is really gone, because a server started at once on the same socket can meet the dying one (`server exited unexpectedly`, seen with tmux 3.3a). Then it removes the socket file, which tmux leaves behind (a day of test runs left about 1500 in `/tmp/tmux-<uid>`). Each command takes the environment as it is when it runs (a test may set `PATH` for the server it starts), minus `TMUX` and `TMUX_PANE`: a tmux client that runs inside tmux writes UTF-8 whatever the locale (seen on tmux 3.6a), so a suite run from a lane must not depend on it, and the `-u` test clears both for the same reason.

Create `packages/node-ops/test/isolated-tmux.ts`:

```ts
// An isolated tmux server for tests (`tmux -L test-<uuid>`, never the owner's), shared by node-ops', the agent's and the
// fleet drills' tests. Its commands pass -u (tmux-cli.ts). kill() returns only once the server is gone: kill-server
// returns before the server has exited, and a server started at once on the same socket can meet the dying one ("server
// exited unexpectedly", seen with tmux 3.3a), so it waits until tmux itself says no server runs there; then it removes
// the socket file, which tmux leaves behind. Each command gets the environment as it is at that moment (a test may set
// PATH for the server it starts), minus TMUX and TMUX_PANE, so a test run from inside a tmux pane (a lane running the
// suite) behaves as anywhere else.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";

export type TestTmux = { socket: string; tmux(...args: string[]): string; kill(): void };

export function isolatedTmux(): TestTmux {
  const socket = `test-${randomUUID()}`;
  const env = () => {
    const e = { ...process.env };
    delete e.TMUX;
    delete e.TMUX_PANE;
    return e;
  };
  const tmux = (...args: string[]) => execFileSync("tmux", ["-u", "-L", socket, ...args], { encoding: "utf8", env: env() });
  const gone = () => {
    try { execFileSync("tmux", ["-L", socket, "list-sessions"], { stdio: "pipe", env: env() }); return false; }
    catch (e) { return /no server running|error connecting/.test(String((e as { stderr?: unknown }).stderr)); }
  };
  const kill = () => {
    try { execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore", env: env() }); } catch { /* no server */ }
    for (let i = 0; i < 100 && !gone(); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    // tmux(1): the socket is in TMUX_TMPDIR, else /tmp, under tmux-<uid>.
    rmSync(join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid?.() ?? 0}`, socket), { force: true });
  };
  return { socket, tmux, kill };
}
```

Create `packages/node-ops/test/tmux-cli.test.ts`:

```ts
// How node-ops calls tmux (tmux-cli.ts), on an isolated tmux server: -u keeps names whole without a UTF-8 locale, "=name"
// targets a session exactly, "##" keeps a "#" in a window name or a directory from being read as a format, and the
// shared test helper's kill() waits until the server is gone. Synthetic windows and directories only.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exactSession, tmuxArgv, tmuxLiteral } from "../src/tmux-cli.ts";
import { tmuxAdapter } from "../src/tmux.ts";
import { isolatedTmux, type TestTmux } from "./isolated-tmux.ts";

let t: TestTmux;
beforeEach(() => { t = isolatedTmux(); });
afterEach(() => { t.kill(); });

describe("tmuxArgv", () => {
  it("always passes -u, and -L only for a named socket", () => {
    expect(tmuxArgv(null, ["list-sessions"])).toEqual(["-u", "list-sessions"]);
    expect(tmuxArgv("s1", ["list-sessions"])).toEqual(["-u", "-L", "s1", "list-sessions"]);
  });
  it("keeps a window name whole without a UTF-8 locale; tmux without -u mangles it (negative control)", async () => {
    const name = "ünï ✓ fix: a/b";
    t.tmux("new-session", "-d", "-s", "main", "-n", name, "sleep 600");
    // As a service runs: no UTF-8 locale, and not inside tmux (a client inside tmux, with TMUX set, writes UTF-8 anyway).
    const saved = { LC_ALL: process.env.LC_ALL, LC_CTYPE: process.env.LC_CTYPE, LANG: process.env.LANG, TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
    process.env.LC_ALL = "C";
    for (const k of ["LC_CTYPE", "LANG", "TMUX", "TMUX_PANE"]) delete process.env[k];
    try {
      expect((await tmuxAdapter({ socket: t.socket, session: "main" }).listWorkers()).map(w => w.name)).toEqual([name]);
      const raw = execFileSync("tmux", ["-L", t.socket, "list-windows", "-t", "=main", "-F", "#{window_name}"], { encoding: "utf8" }).trim();
      expect(raw).not.toBe(name);
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
});

describe("exactSession", () => {
  it("targets a session by its whole name; a bare name also matches a prefix (negative control)", () => {
    t.tmux("new-session", "-d", "-s", "main", "sleep 600");
    expect(exactSession("main")).toBe("=main");
    expect(() => t.tmux("has-session", "-t", exactSession("main"))).not.toThrow();
    expect(() => execFileSync("tmux", ["-L", t.socket, "has-session", "-t", exactSession("mai")], { stdio: "pipe" })).toThrow();
    expect(() => t.tmux("has-session", "-t", "mai")).not.toThrow();
  });
});

describe("tmuxLiteral", () => {
  it("doubles #, so a window gets exactly the name asked for, made or renamed; unescaped, tmux expands it (negative control)", () => {
    t.tmux("new-session", "-d", "-s", "main", "-n", "base", "sleep 600");
    const created = (n: string) => t.tmux("new-window", "-d", "-P", "-F", "#{window_id}", "-t", "=main:", "-n", n, "sleep 600").trim();
    const nameOf = (id: string) => t.tmux("display-message", "-p", "-t", id, "#{window_name}").replace(/\n$/, "");
    for (const name of ["a#S b", "#{pane_id}", "c##d", "fix: a/b ü.2 #1"]) expect(nameOf(created(tmuxLiteral(name))), name).toBe(name);
    expect(nameOf(created("a#S b"))).toBe("amain b");
    const w = created("plain");
    t.tmux("rename-window", "-t", w, tmuxLiteral("r#{session_name}"));
    expect(nameOf(w)).toBe("r#{session_name}");
    t.tmux("rename-window", "-t", w, "r#{session_name}");
    expect(nameOf(w)).toBe("rmain");
  });
  it("a directory arrives as asked for, and a #(…) in it runs nothing; unescaped, tmux expands it (negative control)", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "morndo-literal-")));
    const odd = [join(dir, "a#{session_name}b"), join(dir, "#(touch m)")];
    for (const d of odd) mkdirSync(d);
    const home = process.env.HOME;
    try {
      process.env.HOME = dir;                                           // the server's HOME: where a #(…) job would run
      t.tmux("new-session", "-d", "-s", "main", "-n", "base", "-c", dir, "sleep 600");
      if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
      const startIn = (cwd: string) => {
        const pane = t.tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "=main:", "-c", cwd, "sleep 600").trim();
        return t.tmux("display-message", "-p", "-t", pane, "#{pane_start_path}").replace(/\n$/, "");
      };
      for (const d of odd) expect(startIn(tmuxLiteral(d)), d).toBe(d);
      expect(startIn(odd[0] ?? "")).toBe(join(dir, "amainb"));
      expect(startIn(odd[1] ?? "")).not.toBe(odd[1]);
      for (let i = 0; i < 10 && !existsSync(join(dir, "m")); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      expect(existsSync(join(dir, "m"))).toBe(false);
    } finally {
      if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("isolatedTmux (the shared test helper)", () => {
  it("kill() returns once the server is gone, so a new one starts at once on the same socket, and leaves no socket file", () => {
    const file = join(process.env.TMUX_TMPDIR || "/tmp", `tmux-${process.getuid?.() ?? 0}`, t.socket);
    for (let i = 0; i < 5; i++) {
      t.tmux("new-session", "-d", "-s", "main", "sleep 600");
      const pid = Number(t.tmux("display-message", "-p", "-t", "=main", "#{pid}").trim());
      expect(existsSync(file)).toBe(true);
      t.kill();
      expect(() => process.kill(pid, 0), `server ${pid}`).toThrow();    // the server process itself has exited
      expect(() => execFileSync("tmux", ["-L", t.socket, "list-sessions"], { stdio: "pipe" })).toThrow();
      expect(existsSync(file)).toBe(false);
    }
  });
});
```

- [ ] **Step 22: Run it to see it fail**

Run: `npx vitest run packages/node-ops/test/tmux-cli.test.ts`
Expected: FAIL with `Error: Cannot find module '../src/tmux-cli.ts'`, and no tests run.

- [ ] **Step 23: Write `packages/node-ops/src/tmux-cli.ts`, and pass `-u` from the moved adapters**

This is the one behaviour change to moved code, in its own commit: tmux now writes UTF-8 whatever the locale. Under a UTF-8 locale (the owner's machines) nothing changes; a service started without one stops losing non-ASCII window names and the tab between `listWorkers`' fields.

Create `packages/node-ops/src/tmux-cli.ts`:

```ts
// How this machine's code calls tmux (tmux(1), https://man7.org/linux/man-pages/man1/tmux.1.html, read 2026-10-06;
// each rule below seen on tmux 3.6a on 2026-10-06):
// - `-u` on every call: tmux writes UTF-8 only when the first of LC_ALL, LC_CTYPE and LANG that is set says UTF-8. A
//   service started without a locale otherwise gets every non-ASCII character, and even a tab, as "_" ("ünï<TAB>tab"
//   comes out as "_n__tab").
// - A session target is "=name": without "=", tmux also takes a prefix ("-t mai" finds "main").
// - Some arguments are formats: new-window's -n (a window name) and -c (its directory), new-session's -s, -n and -c, and
//   rename-window's name. "a#S b" becomes "amain b", and a directory "a#{session_name}b" starts the pane in "amainb"; a
//   "#(…)" in one expanded to nothing (tmux 3.6a ran no job within 2 s; other versions are not known to behave the
//   same). Every such argument that carries data from outside goes through tmuxLiteral, which writes "#" as "##", so it
//   arrives as it was given. No -F or display-message -p format is ever built from outside data.
// - A window is never targeted by its name: the window part of a target is matched as a pattern ("=main:f*" found
//   "f*x") and split at "." ("=main:fix.a" looked for a window "fix"), and display-message -p -t with a target that
//   matched nothing printed the session's current window, exit 0. Callers target "@N" or "%N", found by listing.
export function tmuxArgv(socket: string | null, args: readonly string[]): string[] {
  return ["-u", ...(socket ? ["-L", socket] : []), ...args];
}

export const exactSession = (name: string): string => `=${name}`;

export const tmuxLiteral = (s: string): string => s.replaceAll("#", "##");
```

In `packages/node-ops/src/tmux.ts`:
- after `import { workerId, type Worker } from "@morndo/domain";` add `import { tmuxArgv } from "./tmux-cli.ts";`;
- in `tmuxAdapter`, delete the line `  const base = opts.socket ? ["-L", opts.socket] : [];`;
- replace `run("tmux", [...base, ...args], { timeout: 5000, maxBuffer: 4 << 20 })` with `run("tmux", tmuxArgv(opts.socket, args), { timeout: 5000, maxBuffer: 4 << 20 })`;
- replace `spawn("tmux", [...base, "load-buffer", "-b", buffer, "-", ";", "paste-buffer", "-p", "-d", "-b", buffer, "-t", id, ";", "send-keys", "-t", id, "Enter"])` with `spawn("tmux", tmuxArgv(opts.socket, ["load-buffer", "-b", buffer, "-", ";", "paste-buffer", "-p", "-d", "-b", buffer, "-t", id, ";", "send-keys", "-t", id, "Enter"]))`.

In `packages/node-ops/src/terminal.ts`:
- after `import { promisify } from "node:util";` add `import { tmuxArgv } from "./tmux-cli.ts";`;
- in `terminalAdapter`, delete the line `  const base = opts.socket ? ["-L", opts.socket] : [];`;
- replace `run("tmux", [...base, "capture-pane", "-p", "-e", "-t", id, ";", "display-message", "-p", "-t", id,` and the format line after it, `"#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{cursor_flag}"], { timeout: 3000, maxBuffer: 4 << 20 })`, with `run("tmux", tmuxArgv(opts.socket, ["capture-pane", "-p", "-e", "-t", id, ";", "display-message", "-p", "-t", id,` and `"#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{cursor_flag}"]), { timeout: 3000, maxBuffer: 4 << 20 })`;
- replace `await run("tmux", [...base, ...keyArgs(id, data)], { timeout: 3000 })` with `await run("tmux", tmuxArgv(opts.socket, keyArgs(id, data)), { timeout: 3000 })`.

Run: `grep -n 'base' packages/node-ops/src/tmux.ts packages/node-ops/src/terminal.ts`
Expected: only `import { basename } from "node:path";` and its use in `tmux.ts`.

Append to `packages/node-ops/src/index.ts`:

```ts
export * from "./tmux-cli.ts";
```

- [ ] **Step 24: Run it, and check that each rule bites**

Run: `npx vitest run packages/node-ops/test/tmux-cli.test.ts`
Expected: PASS (6 tests).

Then, each change restored before the next:
- In `tmux-cli.ts`, change `return ["-u", ...(socket` to `return [...(socket`. Expected: 2 failures, `expected [ 'list-sessions' ] to deeply equal [ '-u', 'list-sessions' ]` and, in "keeps a window name whole…", `expected [] to deeply equal [ 'ünï ✓ fix: a/b' ]` (without `-u` under `LC_ALL=C` the adapter parses nothing).
- In `tmux-cli.ts`, change `s.replaceAll("#", "##")` to `s`. Expected: 2 failures, `a#S b: expected 'amain b' to be 'a#S b'` and, in "a directory arrives as asked for…", `…/a#{session_name}b: expected '…' to be '…'` (the pane started in `…/amainb`).
- In `isolated-tmux.ts`, delete only the wait loop, `    for (let i = 0; i < 100 && !gone(); i++) Atomics.wait(…);` (the `try` around `kill-server` and the socket file's removal stay). Expected: 1 failure, in "kill() returns once the server is gone…": `server <pid>: expected [Function] to throw an error`. The server process outlives `kill-server` (3 of 3 runs, and 40 of 40 probes on 2026-10-06), which is why the test reads the server's `#{pid}` first: without that check this control passed, because the socket file is removed either way.
- In `isolated-tmux.ts`, delete only the line `    rmSync(join(process.env.TMUX_TMPDIR || "/tmp", …), { force: true });`. Expected: 1 failure, in the same test: `expected true to be false` (the socket file is left).

Run: `npx vitest run --project units packages apps/hub`
Expected: the moved tmux and terminal tests and the hub's `tmux-*` and `steering` tests pass as before (on macOS, `pane-lock`'s 2 fail as in Step 1).

- [ ] **Step 25: Commit**

```bash
git add packages/node-ops/src/tmux-cli.ts packages/node-ops/src/tmux.ts packages/node-ops/src/terminal.ts packages/node-ops/src/index.ts packages/node-ops/test/isolated-tmux.ts packages/node-ops/test/tmux-cli.test.ts
git commit -m "fix(node-ops): pass tmux -u on every call; exact session targets; tmuxLiteral for format arguments"
```

- [ ] **Step 26: Write the failing test of the server stamp and the health probe**

Spec §4: worker IDs carry the first 8 hex digits of a UUID stamped on the tmux server (`@morndo-server`), so a restarted server, which hands out `%0` again, gives new IDs. Spec §5.4: the agent reports `health` every 30 s; node-ops measures the machine, and the agent adds `wallClock`, `spoolDepth` and `drops` (Task 9).

Create `packages/node-ops/test/stamp-health.test.ts`:

```ts
// The tmux server stamp and the health probe (docs/design/fleet-core/README.md §4, §5.4), on an isolated tmux server and
// a temporary home.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { healthProbe, memAvailableFrom, psiFrom } from "../src/health.ts";
import { stampServer } from "../src/stamp.ts";
import { isolatedTmux, type TestTmux } from "./isolated-tmux.ts";

let t: TestTmux;
beforeEach(() => { t = isolatedTmux(); });
afterEach(() => { t.kill(); });
const stored = () => t.tmux("show-options", "-gqv", "@morndo-server").trim();

describe("stampServer", () => {
  it("is null without a server, stamps a server once, and a restarted server gets a new stamp", async () => {
    expect(await stampServer(t.socket)).toBeNull();
    t.tmux("new-session", "-d", "-s", "main", "sleep 600");
    const first = await stampServer(t.socket);
    expect(first).toMatch(/^[0-9a-f]{8}$/);
    expect(stored()).toMatch(new RegExp(`^${first}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`));
    expect(await stampServer(t.socket)).toBe(first);
    t.kill();
    t.tmux("new-session", "-d", "-s", "main", "sleep 600");
    expect(await stampServer(t.socket)).not.toBe(first);
  });
  it("two callers on a fresh server agree on one stamp", async () => {
    t.tmux("new-session", "-d", "-s", "main", "sleep 600");
    const [a, b] = await Promise.all([stampServer(t.socket), stampServer(t.socket)]);
    expect(a).toBe(b);
    expect(stored().slice(0, 8)).toBe(a);
  });
  it("keeps a stamp that is already there", async () => {
    t.tmux("new-session", "-d", "-s", "main", "sleep 600");
    t.tmux("set-option", "-g", "@morndo-server", "0a1b2c3d-0000-4000-8000-000000000000");
    expect(await stampServer(t.socket)).toBe("0a1b2c3d");
  });
});

describe("healthProbe", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "morndo-health-")); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));
  it("reports memory, disk and load as numbers, and whether the node's tmux server answers", async () => {
    const h = await healthProbe(home, { tmuxSocket: t.socket });
    expect(Object.keys(h).sort()).toEqual(["diskFreeHome", "load1", "memAvailable", "memTotal", "psiFull10", "psiSome10", "tmuxOk"]);
    expect(h.memTotal).toBeGreaterThan(0);
    expect(h.memAvailable).toBeGreaterThan(0);
    expect(h.memAvailable).toBeLessThanOrEqual(h.memTotal);
    expect(h.diskFreeHome).toBeGreaterThan(0);
    expect(h.load1).toBeGreaterThanOrEqual(0);
    for (const p of [h.psiSome10, h.psiFull10]) expect(p === null || p >= 0).toBe(true);
    expect(h.tmuxOk).toBe(false);                                     // no server on this socket yet
    t.tmux("new-session", "-d", "-s", "main", "sleep 600");
    expect((await healthProbe(home, { tmuxSocket: t.socket })).tmuxOk).toBe(true);
  });
  it("reads /proc's MemAvailable and the PSI 10-second averages", () => {
    expect(memAvailableFrom("MemTotal:       16000000 kB\nMemAvailable:    8000000 kB\n")).toBe(8_000_000 * 1024);
    expect(memAvailableFrom("MemTotal: 1 kB\n")).toBeNull();
    expect(psiFrom("some avg10=1.50 avg60=0.20 avg300=0.00 total=123\nfull avg10=0.25 avg60=0.00 avg300=0.00 total=4\n")).toEqual({ some10: 1.5, full10: 0.25 });
    expect(psiFrom("some avg10=3.00 avg60=0.00 avg300=0.00 total=1\n")).toEqual({ some10: 3, full10: null });
  });
});
```

- [ ] **Step 27: Run it to see it fail**

Run: `npx vitest run packages/node-ops/test/stamp-health.test.ts`
Expected: FAIL with `Error: Cannot find module '../src/health.ts'`, and no tests run.

- [ ] **Step 28: Write `packages/node-ops/src/stamp.ts` and `packages/node-ops/src/health.ts`**

`set-option -o` refuses to overwrite a value that is set (seen on tmux 3.6a: `already set: @morndo-server`, exit 1), so two callers racing on a fresh server read back the one stamp that won. Without a server every tmux command exits 1 (`no server running`), and the stamp is null.

Create `packages/node-ops/src/stamp.ts`:

```ts
// The tmux server's stamp (docs/design/fleet-core/README.md §4): pane IDs (%N) are reused after a tmux server restarts,
// so worker IDs carry the first 8 hex digits of a UUID the agent stores in the server's global user option
// @morndo-server. A restarted server has no stamp until it gets a new one. `set-option -o` refuses to overwrite a value
// that is already set (tmux(1), read 2026-10-06; seen on tmux 3.6a: "already set: @morndo-server"), so two callers that
// race on a fresh server both read back the one stamp that won.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { tmuxArgv } from "./tmux-cli.ts";

const run = promisify(execFile);
const STAMP = /^([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The server's stamp (8 hex digits), set first if it has none; null when no tmux server runs on that socket.
export async function stampServer(socket: string | null): Promise<string | null> {
  const tmux = async (args: string[]) => (await run("tmux", tmuxArgv(socket, args), { timeout: 5000 })).stdout;
  const read = async () => STAMP.exec((await tmux(["show-options", "-gqv", "@morndo-server"])).trim())?.[1] ?? null;
  try {
    const known = await read();
    if (known) return known;
    try { await tmux(["set-option", "-g", "-o", "@morndo-server", randomUUID()]); }
    catch { /* stamped meanwhile by another caller: read back what won */ }
    return await read();
  } catch {
    return null;                                            // no server on this socket
  }
}
```

Create `packages/node-ops/src/health.ts`:

```ts
// What this machine reports about itself (docs/design/fleet-core/README.md §5.4, `health`): memory, memory pressure, the
// free disk under the home directory, the load, and whether its tmux server answers. On Linux, MemAvailable comes from
// /proc/meminfo (proc(5)) and the pressure from /proc/pressure/memory (PSI, "some" and "full" avg10:
// https://docs.kernel.org/accounting/psi.html, read 2026-10-06). Elsewhere (macOS) memAvailable is os.freemem() and
// the pressure fields are null. wallClock, spoolDepth and drops are the agent's own, so they are not here.
import { execFile } from "node:child_process";
import { readFile, statfs } from "node:fs/promises";
import { freemem, loadavg, totalmem } from "node:os";
import { promisify } from "node:util";
import type { Health } from "@morndo/protocol";
import { tmuxArgv } from "./tmux-cli.ts";

const run = promisify(execFile);

export type HealthProbe = Omit<Health, "wallClock" | "spoolDepth" | "drops">;

// "MemAvailable:   123456 kB" → bytes; null without that line.
export function memAvailableFrom(meminfo: string): number | null {
  const m = /^MemAvailable:\s+(\d+) kB$/m.exec(meminfo);
  return m ? Number(m[1]) * 1024 : null;
}

// "some avg10=1.50 avg60=… total=…" and "full avg10=…": the 10-second averages, in percent; null for a missing line.
export function psiFrom(pressure: string): { some10: number | null; full10: number | null } {
  const avg10 = (kind: "some" | "full") => {
    const m = new RegExp(`^${kind} avg10=(\\d+(?:\\.\\d+)?)`, "m").exec(pressure);
    return m ? Number(m[1]) : null;
  };
  return { some10: avg10("some"), full10: avg10("full") };
}

const text = async (path: string) => { try { return await readFile(path, "utf8"); } catch { return null; } };

// `tmuxSocket`: the tmux -L socket the node's lanes run on (its policy's); null or absent, the default server.
// tmuxOk: that server answers list-sessions.
export async function healthProbe(home: string, o: { tmuxSocket?: string | null } = {}): Promise<HealthProbe> {
  const [meminfo, pressure, diskFreeHome, tmuxOk] = await Promise.all([
    text("/proc/meminfo"),
    text("/proc/pressure/memory"),
    statfs(home).then(s => s.bavail * s.bsize, () => 0),
    run("tmux", tmuxArgv(o.tmuxSocket ?? null, ["list-sessions"]), { timeout: 3000 }).then(() => true, () => false),
  ]);
  const psi = pressure === null ? { some10: null, full10: null } : psiFrom(pressure);
  return {
    memTotal: totalmem(), memAvailable: (meminfo === null ? null : memAvailableFrom(meminfo)) ?? freemem(),
    psiSome10: psi.some10, psiFull10: psi.full10, diskFreeHome, load1: loadavg()[0] ?? 0, tmuxOk,
  };
}
```

Append to `packages/node-ops/src/index.ts`:

```ts
export * from "./stamp.ts";
export * from "./health.ts";
```

- [ ] **Step 29: Run it, and check that it bites**

Run: `npx vitest run packages/node-ops/test/stamp-health.test.ts`
Expected: PASS (5 tests).

Then, each change restored before the next:
- In `health.ts`, change `["list-sessions"]` to `["-V"]` (any tmux that runs would count). Expected: 1 failure, `expected true to be false` on `tmuxOk` with no server.
- In `stamp.ts`, delete the two lines `const known = await read();` and `if (known) return known;`, and drop `"-o",` from `set-option`. Expected: 2 failures, in "…a restarted server gets a new stamp" (the second call stamps again) and "keeps a stamp that is already there".

- [ ] **Step 30: Run all checks**

- `npx vitest run --project units packages apps/hub`. Expected: Step 15's totals + 3 files (`file-rules`, `tmux-cli`, `stamp-health`) and + 21 tests (9, 6 and 5, and `files.test.ts`' new one). On 2026-10-06 that was 87 files and 736 tests; on macOS, only `pane-lock`'s 2 failed, as before.
- `npx tsc -p packages/node-ops`. Expected: exit 0.
- `npx tsc -p tsconfig.tests.json`. Expected: exit 0.
- `npm run check`. Expected: exit 0.
- `npm run lint`. Expected: no problems reported. (A path-scoped `npx oxlint packages/node-ops` reports a spurious `no-redundant-type-constituents` on `transcript-bytes.test.ts` once Task 3 lands: this package's `tsconfig.json` includes only `src`. The repository-wide `npm run lint` is the check.)

- [ ] **Step 31: Commit**

```bash
git add packages/node-ops/src/stamp.ts packages/node-ops/src/health.ts packages/node-ops/src/index.ts packages/node-ops/test/stamp-health.test.ts
git commit -m "feat(node-ops): the tmux server stamp and the health probe"
```

---

### Task 3: Transcript bytes and the parser split

Spec §3.1, "Transcripts". A node serves bytes and never parses them. The hub parses bytes from any source, in reads of at most one chunk, and carries a partial line across reads. **ObservationService is not changed in this task.** It keeps calling `readTranscript(cursor, name)` (`observation-service.ts:125`) and `readOlder(path, name, before, { from })` (`:69`). Both stay as synchronous thin wrappers: they run the same reading steps against the local file. Task 4 makes ObservationService call `followTranscript` and `olderPage` over a `TranscriptSource` and deletes `readTranscript`, `readOlder`, `runSync`, `onFile` and the cursor's `path` field, which only `readTranscript` reads.

What changes for the live hub already, through the wrappers:
- a follow reads at most 8 MiB per poll, in 256 KiB reads;
- a long line is carried across reads, and a line over 8 MiB becomes one message, "A message too large to show.", with the id `too-large-<byte offset of its start>`;
- an older page finds its message by its uuid with `locate`, then parses one window of at most 4 MiB before it, instead of scanning back up to 64 MiB.

The follow over a `TranscriptBytes` (what Task 4's fleet source will be) keeps its place when the source throws: the cursor is put back as it was before the call, so a node that can't answer for a moment costs a poll, never a message. Without that, the lines parsed from the reads that had come back are dropped with the error while the cursor has moved past them.

Pages hold the same messages as before, with three exceptions:
- A page that would need more than the window holds fewer messages, with `done: false`, and the next page goes on from there.
- If the window holds no message at all, the page is a single message too large to show, so the reader moves on instead of asking for the same page again.
- `resume.end` is now the start of the first message's line. `ObservationService` treats it as opaque.

A known limit, from the spec's two numbers: a line between 4 and 8 MiB shows in the live follow but as "too large" in an older page.

**Files:**
- Create: `packages/node-ops/src/transcript-bytes.ts`
- Modify: `packages/node-ops/src/index.ts` (one export line at the end)
- Modify:
  - `apps/hub/src/adapters/claude-sessions.ts:8`: two imports added after it;
  - `apps/hub/src/adapters/claude-sessions.ts:202-334`: from the line ``// `latest`: the latest time among the lines read so far (parseLine's `notBefore`).`` to the end of the file, replaced. Line numbers are after Task 2.
- Modify: `apps/hub/test/claude-sessions-older.test.ts:1-2,7,23,76-85,86`: the header, new imports, a counting source, and two tests replacing the one that tested the 64 MiB backward scan.
- Test: `packages/node-ops/test/transcript-bytes.test.ts` (new), `apps/hub/test/transcript-long-lines.test.ts` (new)
- Unchanged and still passing:
  - `apps/hub/test/claude-sessions.test.ts`, `claude-sessions-utf8-cursor.test.ts` and `protocol-contract.test.ts`;
  - `observation-refollow.test.ts`, `observation-waiting-on.test.ts` and `observation-loop-errors.test.ts`;
  - `http-reading.test.ts`.

**Interfaces:**
- Consumes:
  - `LIMITS.chunkBytes` from `@morndo/protocol` (Task 1);
  - `@morndo/node-ops` from Task 2;
  - existing `claude-sessions.ts` internals: `parseLine`, `reached`, `lineId`, `ts`, `Line`, `Parsed`, `FileRef`.
- Produces:
  - `packages/node-ops/src/transcript-bytes.ts`:
    - `type TranscriptBytes = { size(): Promise<number | null>; read(offset: number, max: number): Promise<{ bytes: Uint8Array; eof: boolean } | null>; locate(needle: string): Promise<number | null> }`;
    - `localTranscriptBytes(path: string): TranscriptBytes`.

    Semantics:
    - `size` is null when there is no regular file;
    - `read` returns at most `min(max, LIMITS.chunkBytes)` bytes, `eof` when nothing lies past them, null without a file, and throws `RangeError` on a negative or fractional `offset`/`max`;
    - `locate` returns the start of the last line holding `needle` (searched from the end, in 1 MiB windows, also across a window's edge), or null; also null for an empty needle.
  - `apps/hub/src/adapters/claude-sessions.ts`:
    - `MAX_LINE_BYTES = 8 << 20` and `OLDER_WINDOW_BYTES = 4 << 20`;
    - `type TranscriptCursor = { path: string; offset: number; pending: Set<string>; sends?: Map<string, (string | null)[]>; latest?: number; carry?: Uint8Array[]; skip?: { from: number; shown: boolean } }` (Task 4 drops `path`);
    - `feedTranscript(cursor: TranscriptCursor, bytes: Uint8Array, agent: string, maxLine?: number): Parsed`, which is pure;
    - `type FollowOptions = { tailBytes?: number; chunk?: number; budget?: number; maxLine?: number }`;
    - `followTranscript(src: TranscriptBytes, cursor: TranscriptCursor, agent: string, o?: FollowOptions): Promise<Parsed>`; when the source throws, it rethrows with the cursor exactly as it was before the call;
    - `type OlderPage = { messages: Message[]; done: boolean; files: FileRef[]; missing?: true; resume?: { id: string; end: number } }`;
    - `type OlderOptions = { limit?: number; from?: number | undefined; window?: number; chunk?: number; maxLine?: number }`;
    - `olderPage(src: TranscriptBytes, agent: string, beforeId: string, o?: OlderOptions): Promise<OlderPage>`;
    - until Task 4: `readTranscript(cursor: TranscriptCursor, agent: string, tailBytes?: number): Parsed` and `readOlder(path: string, agent: string, beforeId: string, o?: OlderOptions): OlderPage`. Both throw when the file is gone, as before.

- [ ] **Step 1: Write the failing transcript-bytes test**

```ts
// A transcript's bytes on this machine (docs/design/fleet-core/README.md §3.1): its size, bounded reads, and where the
// last line holding a needle starts. Synthetic files in a temporary directory only.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIMITS } from "@morndo/protocol";
import { localTranscriptBytes } from "../src/transcript-bytes.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-bytes-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const file = (content: string | Buffer) => { const p = join(dir, "t.jsonl"); writeFileSync(p, content); return p; };
const line = (uuid: string, pad = 0) => `${JSON.stringify({ type: "assistant", uuid, message: { content: [{ type: "text", text: "x".repeat(pad) }] } })}\n`;
// Where the last line holding `needle` starts, the slow and obvious way.
const reference = (content: Buffer, needle: string) => {
  const hit = content.lastIndexOf(Buffer.from(needle));
  return hit === -1 ? null : hit === 0 ? 0 : content.lastIndexOf(0x0a, hit - 1) + 1;
};

describe("size", () => {
  it("is the file's size; null when there is no file to read", async () => {
    expect(await localTranscriptBytes(file("abc\n")).size()).toBe(4);
    expect(await localTranscriptBytes(join(dir, "missing.jsonl")).size()).toBeNull();
    expect(await localTranscriptBytes(dir).size()).toBeNull();                           // a directory
  });
});

describe("read", () => {
  it("reads at an offset, at most max bytes, and says when nothing lies past them", async () => {
    const b = localTranscriptBytes(file("0123456789"));
    const read = async (offset: number, max: number) => { const r = await b.read(offset, max); return r && { text: Buffer.from(r.bytes).toString(), eof: r.eof }; };
    expect(await read(2, 3)).toEqual({ text: "234", eof: false });
    expect(await read(7, 100)).toEqual({ text: "789", eof: true });
    expect(await read(10, 5)).toEqual({ text: "", eof: true });
    expect(await read(50, 5)).toEqual({ text: "", eof: true });
  });
  it("never returns more than one chunk, however much is asked for", async () => {
    const b = localTranscriptBytes(file(Buffer.alloc(LIMITS.chunkBytes * 2 + 5, 0x61)));
    const r = await b.read(0, 10 << 20);
    expect(r?.bytes.length).toBe(LIMITS.chunkBytes);
    expect(r?.eof).toBe(false);
  });
  it("is null without a file; a negative offset or size is refused", async () => {
    expect(await localTranscriptBytes(join(dir, "missing.jsonl")).read(0, 10)).toBeNull();
    await expect(localTranscriptBytes(file("x")).read(-1, 10)).rejects.toThrow(RangeError);
    await expect(localTranscriptBytes(file("x")).read(0, 1.5)).rejects.toThrow(RangeError);
  });
});

describe("locate", () => {
  it("finds the start of the line holding the needle", async () => {
    const content = line("a1") + line("a2") + line("a3");
    const b = localTranscriptBytes(file(content));
    expect(await b.locate('"uuid":"a2"')).toBe(Buffer.byteLength(line("a1")));
    expect(await b.locate('"uuid":"a1"')).toBe(0);
    expect(await b.locate('"uuid":"a9"')).toBeNull();
    expect(await b.locate("")).toBeNull();
    expect(await localTranscriptBytes(join(dir, "missing.jsonl")).locate("x")).toBeNull();
  });
  it("the last line that holds it", async () => {
    const content = line("a1") + line("a2") + line("a1");
    expect(await localTranscriptBytes(file(content)).locate('"uuid":"a1"')).toBe(Buffer.byteLength(line("a1") + line("a2")));
  });
  it("a needle across the edge of the 1 MiB windows it reads backwards, and a line that starts windows earlier", async () => {
    const needle = '"uuid":"ü-edge"';
    const n = Buffer.byteLength(needle);
    for (let k = -2; k <= n + 2; k++) {
      // the needle ends k bytes after the edge one window back from the end
      const tail = (1 << 20) - k;
      const content = Buffer.concat([Buffer.from(line("a0")), Buffer.from("x".repeat(1_500_000)), Buffer.from(needle), Buffer.from(`${"y".repeat(Math.max(0, tail - 1))}\n`)]);
      const p = file(content);
      expect(await localTranscriptBytes(p).locate(needle), `k=${k}`).toBe(reference(content, needle));
    }
  });
  it("agrees with the obvious search on a file of many windows", async () => {
    const p = file("");
    for (let i = 0; i < 400; i++) appendFileSync(p, line(`a${i}`, (i * 7919) % 20_000));
    const content = readFileSync(p);
    const b = localTranscriptBytes(p);
    for (const i of [0, 1, 57, 199, 200, 333, 398, 399]) expect(await b.locate(`"uuid":"a${i}"`), `a${i}`).toBe(reference(content, `"uuid":"a${i}"`));
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run packages/node-ops/test/transcript-bytes.test.ts`
Expected: FAIL with `Error: Cannot find module '../src/transcript-bytes.ts'`.

- [ ] **Step 3: Write `packages/node-ops/src/transcript-bytes.ts`**

```ts
// A transcript's bytes on this machine (docs/design/fleet-core/README.md §3.1): its size, a bounded read at an offset,
// and where the last line holding a needle starts. The hub's reader parses them (a pure parser over bytes); a node only
// serves them (`transcript.size`, `transcript.read`, `transcript.locate`), so it never interprets a transcript. Reads
// are at most one chunk (LIMITS.chunkBytes), what one fleet message carries.
import { open, stat, type FileHandle } from "node:fs/promises";
import { LIMITS } from "@morndo/protocol";

export type TranscriptBytes = {
  size(): Promise<number | null>;
  read(offset: number, max: number): Promise<{ bytes: Uint8Array; eof: boolean } | null>;
  locate(needle: string): Promise<number | null>;
};

const LOCATE_STEP = 1 << 20;                                 // locate reads backwards this much at a time

async function openFile(path: string): Promise<FileHandle | null> {
  let fh: FileHandle;
  try { fh = await open(path, "r"); } catch { return null; }   // gone, or not ours to read
  if ((await fh.stat()).isFile()) return fh;
  await fh.close();
  return null;
}

// `length` bytes at `position`, fewer only where the file ends.
async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const { bytesRead } = await fh.read(buf, got, length - got, position + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return got === length ? buf : buf.subarray(0, got);
}

// Where the line that runs through `pos` starts: just after the last newline before it, or 0.
async function lineStart(fh: FileHandle, pos: number): Promise<number> {
  while (pos > 0) {
    const start = Math.max(0, pos - LOCATE_STEP);
    const nl = (await readAt(fh, start, pos - start)).lastIndexOf(0x0a);
    if (nl !== -1) return start + nl + 1;
    pos = start;
  }
  return 0;
}

export function localTranscriptBytes(path: string): TranscriptBytes {
  return {
    // null: no file there to read
    async size() {
      try { const st = await stat(path); return st.isFile() ? st.size : null; } catch { return null; }
    },
    // At most `max` bytes from `offset`, and never more than one chunk; `eof`: nothing lies past them.
    async read(offset, max) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(max) || max < 0) throw new RangeError(`read(${offset}, ${max})`);
      const fh = await openFile(path);
      if (!fh) return null;
      try {
        const size = (await fh.stat()).size;
        const bytes = await readAt(fh, offset, Math.max(0, Math.min(max, LIMITS.chunkBytes, size - offset)));
        return { bytes, eof: offset + bytes.length >= size };
      } finally { await fh.close(); }
    },
    // The byte offset where the last line holding `needle` starts, or null. The search runs from the end backwards,
    // where the pages a reader asks for usually are, one window at a time; a needle across a window's edge is found.
    async locate(needle) {
      const n = Buffer.from(needle, "utf8");
      if (!n.length) return null;
      const fh = await openFile(path);
      if (!fh) return null;
      try {
        let end = (await fh.stat()).size;
        let after = Buffer.alloc(0);                         // the first bytes of the window after this one
        while (end > 0) {
          const start = Math.max(0, end - LOCATE_STEP);
          const buf = Buffer.concat([await readAt(fh, start, end - start), after]);
          const hit = buf.lastIndexOf(n);
          if (hit !== -1) {
            const nl = hit > 0 ? buf.lastIndexOf(0x0a, hit - 1) : -1;
            return nl !== -1 ? start + nl + 1 : await lineStart(fh, start);
          }
          after = buf.subarray(0, n.length - 1);
          end = start;
        }
        return null;
      } finally { await fh.close(); }
    },
  };
}
```

Append this line to `packages/node-ops/src/index.ts`:

```ts
export * from "./transcript-bytes.ts";
```

- [ ] **Step 4: Run it**

Run: `npx vitest run packages/node-ops/test/transcript-bytes.test.ts`
Expected: PASS (8 tests).

Then check that the edge test bites. In `transcript-bytes.ts`, change `after = buf.subarray(0, n.length - 1);` to `after = Buffer.alloc(0);` and rerun. Expected: 1 failure, in "a needle across the edge of the 1 MiB windows it reads backwards, and a line that starts windows earlier". Restore the line.

- [ ] **Step 5: Write the failing long-line test**

This includes the negative control. `oldFollow` is a copy of `readTranscript` as it was at 38ea4be, fed through the same bounded reads, and it shows the bug: it stalls on the 3 MB line. The copy lives in the test, so the bug stays reproducible after the fix.

```ts
// Long transcript lines (docs/design/fleet-core/README.md §3.1, §9 "Long lines"; real transcripts have lines up to
// 3.7 MB). The follow reads in bounded pieces, at most one chunk (LIMITS.chunkBytes) each, as a node serves them through
// the fleet, and carries a line across them: a 3 MB line arrives whole, a 10 MB one is skipped as one message too large
// to show, and the follow goes on past both. Negative control: the old reader, without the carry, stalls on the 3 MB
// line. Synthetic transcripts only.
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEntry } from "@morndo/domain";
import { localTranscriptBytes, type TranscriptBytes } from "@morndo/node-ops";
import { LIMITS } from "@morndo/protocol";
import { MAX_LINE_BYTES, followTranscript, olderPage, type TranscriptCursor } from "../src/adapters/claude-sessions.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "morndo-long-lines-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const T = "2026-10-06T08:00:00.000Z";
const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;
const user = (uuid: string, content: string) => line({ type: "user", uuid, timestamp: T, message: { role: "user", content }, origin: { kind: "human" } });
const assistant = (uuid: string, text: string) => line({ type: "assistant", uuid, timestamp: T, message: { role: "assistant", content: [{ type: "text", text }] } });

// The bytes, checking that no read asks for or gets more than one chunk.
function bounded(path: string): TranscriptBytes {
  const b = localTranscriptBytes(path);
  return {
    size: () => b.size(),
    read: async (offset, max) => {
      expect(max).toBeLessThanOrEqual(LIMITS.chunkBytes);
      const r = await b.read(offset, max);
      expect(r?.bytes.length ?? 0).toBeLessThanOrEqual(LIMITS.chunkBytes);
      return r;
    },
    locate: needle => b.locate(needle),
  };
}
const carried = (c: TranscriptCursor) => (c.carry ?? []).reduce((n, part) => n + part.length, 0);
// Polls the follow `polls` times, one chunk per poll, so the carry is checked after every read: it never holds more
// than one line's limit. What the follow returned, in order.
async function follow(src: TranscriptBytes, cursor: TranscriptCursor, polls: number): Promise<ConversationEntry[]> {
  const out: ConversationEntry[] = [];
  for (let i = 0; i < polls; i++) {
    out.push(...(await followTranscript(src, cursor, "builder", { budget: LIMITS.chunkBytes })).entries);
    expect(carried(cursor)).toBeLessThanOrEqual(MAX_LINE_BYTES);
  }
  return out;
}

// readTranscript as it was before the carry (claude-sessions.ts at 38ea4be, lines 259-298): the same rules, but its
// bytes come through the same bounded reads, at most one chunk per poll. It can only take the complete lines inside
// what one read returns; with none there it returns nothing and doesn't move.
async function oldFollow(src: TranscriptBytes, cursor: { offset: number }, tailBytes = 2 << 20): Promise<string[]> {
  const size = (await src.size()) ?? 0;
  if (size < cursor.offset) cursor.offset = 0;
  const start = cursor.offset === 0 && size > tailBytes ? size - tailBytes : cursor.offset;
  if (start >= size) return [];
  const r = await src.read(start, Math.min(size - start, LIMITS.chunkBytes));
  if (!r) return [];
  const buf = Buffer.from(r.bytes);
  let from = 0;
  if (start > cursor.offset) {
    const nl = buf.indexOf(0x0a);
    if (nl === -1) return [];
    from = nl + 1;
  }
  const end = buf.lastIndexOf(0x0a);
  if (end < from) return [];                                          // no complete line yet
  cursor.offset = start + end + 1;
  return buf.toString("utf8", from, end).split("\n").filter(l => l.trim()).map(l => String((JSON.parse(l) as { uuid?: unknown }).uuid));
}

describe("the follow over bounded reads", () => {
  it("a 3 MB line arrives whole, and the follow goes on past it", async () => {
    const path = join(dir, "s.jsonl");
    writeFileSync(path, user("u1", "first") + assistant("a1", "reply one"));
    const src = bounded(path);
    const cursor: TranscriptCursor = { path, offset: 0, pending: new Set() };
    expect((await follow(src, cursor, 1)).map(e => e.id)).toEqual(["u1", "a1:0"]);
    appendFileSync(path, user("u2", "x".repeat(3_000_000)) + assistant("a2", "after the long one"));
    const got = await follow(src, cursor, 15);                       // 3 MB in 256 KiB reads: 12
    expect(got.map(e => e.id)).toEqual(["u2", "a2:0"]);
    expect(got[0]?.kind === "text" ? got[0].text.length : 0).toBe(3_000_000);
    expect(cursor.offset).toBe(statSync(path).size);
  });

  it("a 10 MB line is one message too large to show, and the follow goes on past it", async () => {
    const path = join(dir, "s.jsonl");
    writeFileSync(path, user("u1", "first"));
    const src = bounded(path);
    const cursor: TranscriptCursor = { path, offset: 0, pending: new Set() };
    await follow(src, cursor, 1);
    const start = statSync(path).size;
    appendFileSync(path, user("u3", "y".repeat(10_000_000)) + assistant("a3", "after the huge one"));
    const got = await follow(src, cursor, 45);                       // 10 MB in 256 KiB reads: 39
    expect(got.map(e => e.id)).toEqual([`too-large-${start}`, "a3:0"]);
    expect(got[0]).toMatchObject({ kind: "event", author: { kind: "system", name: "Morndo" }, text: "A message too large to show." });
    appendFileSync(path, assistant("a4", "and on"));
    expect((await follow(src, cursor, 1)).map(e => e.id)).toEqual(["a4:0"]);
  });

  it("the old reader, without the carry, stalls on the 3 MB line (negative control)", async () => {
    const path = join(dir, "s.jsonl");
    writeFileSync(path, user("u1", "first") + assistant("a1", "reply one"));
    const src = bounded(path);
    const cursor = { offset: 0 };
    expect(await oldFollow(src, cursor)).toEqual(["u1", "a1"]);
    const stuckAt = statSync(path).size;
    appendFileSync(path, user("u2", "x".repeat(3_000_000)) + assistant("a2", "after the long one"));
    const seen: string[] = [];
    for (let i = 0; i < 20; i++) seen.push(...(await oldFollow(src, cursor)));
    expect(seen).toEqual([]);                                         // neither the long line nor anything after it
    expect(cursor.offset).toBe(stuckAt);
  });
});

describe("a source that fails mid-follow", () => {
  it("leaves the cursor as it was, and the next follow reads every line once", async () => {
    const path = join(dir, "s.jsonl");
    writeFileSync(path, user("u1", "first"));
    const cursor: TranscriptCursor = { path, offset: 0, pending: new Set() };
    expect((await follow(bounded(path), cursor, 1)).map(e => e.id)).toEqual(["u1"]);
    const ids = Array.from({ length: 2000 }, (_, i) => `a${i}`);
    appendFileSync(path, ids.map(id => assistant(id, "x".repeat(150))).join(""));   // ~0.5 MB: more than one read
    const before = structuredClone(cursor);
    const local = localTranscriptBytes(path);
    let reads = 0;
    const flaky: TranscriptBytes = {
      size: () => local.size(),
      read: async (offset, max) => { if (++reads === 2) throw new Error("node offline"); return local.read(offset, max); },
      locate: needle => local.locate(needle),
    };
    await expect(followTranscript(flaky, cursor, "builder", { budget: MAX_LINE_BYTES })).rejects.toThrow("node offline");
    expect(reads).toBe(2);                                             // the first read had come back, and was parsed
    expect(cursor).toEqual(before);
    const got = (await followTranscript(bounded(path), cursor, "builder", { budget: MAX_LINE_BYTES })).entries.map(e => e.id);
    expect(got).toEqual(ids.map(id => `${id}:0`));
  });
});

describe("older pages past a long line", () => {
  it("from a message after the 10 MB line, paging moves on past it to the beginning, never asking twice", async () => {
    const path = join(dir, "s.jsonl");
    writeFileSync(path, user("u1", "first") + user("u3", "y".repeat(10_000_000)) + assistant("a3", "after the huge one"));
    const src = bounded(path);
    const asked: string[] = [];
    let before = "a3:0";
    let page = await olderPage(src, "builder", before);
    for (let i = 0; i < 5 && !page.done; i++) {
      expect(page.missing).toBeUndefined();
      expect(asked).not.toContain(page.messages[0]?.id);
      asked.push(page.messages[0]?.id ?? "");
      before = page.messages[0]?.id ?? "";
      page = await olderPage(src, "builder", before, page.resume ? { from: page.resume.end } : {});
    }
    expect(page.done).toBe(true);
    expect(page.messages.map(m => m.id)).toEqual(["u1"]);
    expect(asked.every(id => id.startsWith("too-large-"))).toBe(true);
  });
  it("from the follow's message too large to show, the page before it is the messages before the line", async () => {
    const path = join(dir, "s.jsonl");
    writeFileSync(path, user("u1", "first"));
    const start = statSync(path).size;
    appendFileSync(path, user("u3", "y".repeat(10_000_000)) + assistant("a3", "after"));
    const page = await olderPage(bounded(path), "builder", `too-large-${start}`);
    expect(page).toMatchObject({ done: true, messages: [{ id: "u1" }] });
  });
  it("a 3 MB line fits a page's window: an older page holds it whole", async () => {
    const path = join(dir, "s.jsonl");
    writeFileSync(path, user("u1", "first") + user("u2", "x".repeat(3_000_000)) + assistant("a2", "after the long one"));
    const page = await olderPage(bounded(path), "builder", "a2:0");
    expect(page.messages.map(m => m.id)).toEqual(["u1", "u2"]);
    expect(page.done).toBe(true);
  });
});
```

- [ ] **Step 6: Adapt the older-page test to the new reader**

The old test at lines 76–85 checked a mechanism this task removes: a 64 MiB backward scan limit (`maxScan`) that only a hint got past. In `apps/hub/test/claude-sessions-older.test.ts`, apply the edits below. Each is named by its content; the line numbers are as the file stands before this step. The other nine tests stay as they are. They still pass through the synchronous `readOlder`: 100 messages before one, near the start, the beginning, chunk edges, missing, multibyte, a page inside one line, parsing each line once, and a stale hint.

Replace lines 1–2 (the header comment) with:

```ts
// Older pages (ADR-0008 phase D, O9): up to 100 messages from before a given one, in time order: its line is found by its
// uuid, then one bounded window before it is parsed, each line once; an empty page means the beginning. Synthetic
// transcripts only.
```

Replace line 7, `import { readOlder } from "../src/adapters/claude-sessions.ts";`, with:

```ts
import { localTranscriptBytes, type TranscriptBytes } from "@morndo/node-ops";
import { olderPage, readOlder } from "../src/adapters/claude-sessions.ts";
```

After line 23 (`const texts = …`), insert:

```ts
// A transcript's bytes that count what is asked of them.
function counting(b: TranscriptBytes) {
  const c = {
    bytesRead: 0, locates: 0,
    size: () => b.size(),
    read: async (offset: number, max: number) => { const r = await b.read(offset, max); c.bytesRead += r?.bytes.length ?? 0; return r; },
    locate: (needle: string) => { c.locates++; return b.locate(needle); },
  };
  return c;
}
```

Replace the test at lines 76–85, `it("the next page starts where the last one began, reading only what lies before it", …)`, with:

```ts
  it("the next page ends where the last one began: found without a search, the same page as with one", async () => {
    const bytes = counting(localTranscriptBytes(transcript(3000, 200)));
    const first = await olderPage(bytes, "builder", "a2900:0");
    expect(first.resume?.id).toBe("a2800:0");
    expect(bytes.locates).toBe(1);
    const next = await olderPage(bytes, "builder", "a2800:0", { from: first.resume?.end });
    expect(bytes.locates).toBe(1);                                          // the hint held: no second search
    expect(texts(next)[0]).toBe("reply 2700");
    expect(texts(next).at(-1)).toBe("reply 2799");
    expect(await olderPage(bytes, "builder", "a2800:0")).toEqual(next);   // negative control: no hint, a search, the same page
    expect(bytes.locates).toBe(2);
  });
  it("reads one window before the message: a small one holds fewer messages, and the pages still join up", async () => {
    const bytes = counting(localTranscriptBytes(transcript(3000, 200)));   // ~270-byte lines: 10 KiB holds ~37
    const page = await olderPage(bytes, "builder", "a2900:0", { window: 10 << 10 });
    expect(page.messages.length).toBeGreaterThan(20);
    expect(page.messages.length).toBeLessThan(100);
    expect(page.done).toBe(false);
    expect(bytes.bytesRead).toBeLessThanOrEqual((10 << 10) + 4096);       // the window and the message's own short line
    const oldest = Number(texts(page)[0]?.replace("reply ", ""));
    const next = await olderPage(bytes, "builder", page.messages[0]?.id ?? "", { window: 10 << 10, from: page.resume?.end });
    expect(texts(next).at(-1)).toBe(`reply ${oldest - 1}`);               // nothing between the two pages lost
  });
```

On the next line, rename the test `"a hint that no longer fits (the transcript changed) falls back to the whole file"` to `"a hint that no longer fits (the transcript changed) falls back to the search"`. Its body is unchanged.

- [ ] **Step 7: Run both to see them fail**

Run: `npx vitest run apps/hub/test/transcript-long-lines.test.ts apps/hub/test/claude-sessions-older.test.ts`
Expected: FAIL, 8 failed and 10 passed. The failures are `TypeError: followTranscript is not a function` (3) and `TypeError: olderPage is not a function` (5).

Two tests already pass, as they should:
- "the old reader, without the carry, stalls on the 3 MB line (negative control)": it pins the bug in the copy of the old logic;
- the older-page tests that call the synchronous `readOlder`.

- [ ] **Step 8: Split the reader into steps over bytes**

In `apps/hub/src/adapters/claude-sessions.ts` (as Task 2 left it), after line 8 (`import type { Attachment, Author, ConversationEntry, Message, QuestionPart } from "@morndo/domain";`), insert:

```ts
import type { TranscriptBytes } from "@morndo/node-ops";
import { LIMITS } from "@morndo/protocol";
```

Then replace everything from the line ``// `latest`: the latest time among the lines read so far (parseLine's `notBefore`).`` (line 202) to the end of the file with the block below. It covers:
- `TranscriptCursor`, `readTranscript`, `OlderPage`, `OLDER_SCAN_LIMIT` and `readOlder` as they were, now replaced;
- `parseLine` and everything above it, unchanged;
- the reading rules, kept: complete lines only, a byte cursor, the first read's tail from a line boundary, fresh state per older window, `done`, `missing`, `resume`, and messages counted only when they are not answers.

```ts
// ---- reading a transcript: the follow and older pages (design §3.1)
// The bytes come from a TranscriptBytes (@morndo/node-ops): this machine's file, or a node's through the fleet, in
// reads of at most one chunk (LIMITS.chunkBytes). What to read next is decided once, as steps that ask for bytes and
// parse what comes back (no I/O of their own): followTranscript and olderPage answer them from any TranscriptBytes;
// readTranscript and readOlder answer them from the local file, synchronously, for ObservationService until it reads
// asynchronously (fleet core Task 4, which removes them).

// A line longer than this is never parsed: it shows as one message too large to show, and reading goes on past it
// (real transcripts have lines up to 3.7 MB).
export const MAX_LINE_BYTES = 8 << 20;
// An older page reads one window of at most this much before the message it ends at, plus that message's own line.
export const OLDER_WINDOW_BYTES = 4 << 20;

// A message that stands for text too large to show, named by the byte offset where it starts: older pages before it
// end there.
const TOO_LARGE = /^too-large-(\d+)$/;
const tooLarge = (start: number, at: number): Message => ({
  id: `too-large-${start}`, at, author: { kind: "system", name: "Morndo" }, kind: "event", text: "A message too large to show.",
});

type Chunk = { bytes: Uint8Array; eof: boolean };
type Ask = { t: "size" } | { t: "read"; offset: number; max: number } | { t: "locate"; needle: string };
type Steps<T> = Generator<Ask, T, unknown>;
function* askSize(): Steps<number | null> { return (yield { t: "size" }) as number | null; }
function* askRead(offset: number, max: number): Steps<Chunk | null> { return (yield { t: "read", offset, max }) as Chunk | null; }
function* askLocate(needle: string): Steps<number | null> { return (yield { t: "locate", needle }) as number | null; }

async function runAsync<T>(steps: Steps<T>, src: TranscriptBytes): Promise<T> {
  let s = steps.next();
  while (!s.done) {
    const a = s.value;
    s = steps.next(await (a.t === "size" ? src.size() : a.t === "read" ? src.read(a.offset, a.max) : src.locate(a.needle)));
  }
  return s.value;
}

const utf8 = new TextDecoder();
// One line's bytes (without its newline) → its JSON, or null for an empty, torn or foreign line.
function lineJson(bytes: Uint8Array): Line | null {
  const raw = utf8.decode(bytes);
  if (!raw.trim()) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  return v !== null && typeof v === "object" ? (v as Line) : null;
}
const gone = () => new Error("the transcript is gone");
const merge = (into: Parsed, p: Parsed) => { into.entries.push(...p.entries); into.files.push(...p.files); if (p.title) into.title = p.title; };

// `offset`: the next byte to read. `carry`: what was read of a line whose end hasn't come yet (it ends at `offset`).
// `skip`: inside a line dropped up to its end, from its start `from`: one the first read jumped into, or one over
// MAX_LINE_BYTES (`shown`: it becomes a message too large to show). `latest`: the latest time among the lines read so
// far (parseLine's `notBefore`).
export type TranscriptCursor = {
  path: string; offset: number; pending: Set<string>; sends?: Map<string, (string | null)[]>; latest?: number;
  carry?: Uint8Array[]; skip?: { from: number; shown: boolean };
};

// Bytes read at the cursor's offset → what they add to the conversation (pure). Complete lines are parsed in file
// order, the first joined to what earlier reads carried; what follows the last newline is carried to the next read. A
// line over `maxLine` is dropped as it arrives and shows as one message too large to show once its end is read.
export function feedTranscript(cursor: TranscriptCursor, bytes: Uint8Array, agent: string, maxLine = MAX_LINE_BYTES): Parsed {
  const out: Parsed = { entries: [], title: null, files: [] };
  const at = cursor.offset;                                          // where `bytes` start in the file
  cursor.offset += bytes.length;
  cursor.sends ??= new Map();
  let from = 0;
  for (let nl = bytes.indexOf(0x0a); nl !== -1; from = nl + 1, nl = bytes.indexOf(0x0a, from)) {
    const carried = cursor.carry ?? [];
    delete cursor.carry;
    const before = carried.reduce((n, c) => n + c.length, 0);
    if (cursor.skip) {
      if (cursor.skip.shown) out.entries.push(tooLarge(cursor.skip.from, cursor.latest ?? 0));
      delete cursor.skip;
    } else if (before + nl - from > maxLine) {
      out.entries.push(tooLarge(at + from - before, cursor.latest ?? 0));
    } else {
      const line = lineJson(carried.length ? Buffer.concat([...carried, bytes.subarray(from, nl)]) : bytes.subarray(from, nl));
      if (!line) continue;
      merge(out, parseLine(line, agent, cursor.pending, cursor.sends, cursor.latest ?? 0));
      cursor.latest = Math.max(cursor.latest ?? 0, reached(line));
    }
  }
  if (from < bytes.length && !cursor.skip) {
    const carried = [...(cursor.carry ?? []), bytes.slice(from)];  // a copy: the source may reuse its buffer
    const length = carried.reduce((n, c) => n + c.length, 0);
    if (length > maxLine) { cursor.skip = { from: cursor.offset - length, shown: true }; delete cursor.carry; }
    else cursor.carry = carried;
  }
  return out;
}

// `tailBytes`: the most the first read takes, from the end; `chunk`: one read; `budget`: the most one call reads (the
// rest comes on the next call, from the cursor); `maxLine`: the longest line parsed.
export type FollowOptions = { tailBytes?: number; chunk?: number; budget?: number; maxLine?: number };

// The follow (O5): what the transcript added since the cursor. The first read takes at most the last `tailBytes`,
// from a line boundary (the line it starts in is skipped). A line arrives over as many reads as it takes, so a follow
// never stalls on a long one.
function* followSteps(cursor: TranscriptCursor, agent: string, o: FollowOptions): Steps<Parsed> {
  const tail = o.tailBytes ?? 2 << 20, chunk = o.chunk ?? LIMITS.chunkBytes, budget = o.budget ?? MAX_LINE_BYTES, maxLine = o.maxLine ?? MAX_LINE_BYTES;
  const out: Parsed = { entries: [], title: null, files: [] };
  const size = yield* askSize();
  if (size === null) throw gone();
  if (size < cursor.offset) { cursor.offset = 0; cursor.latest = 0; delete cursor.carry; delete cursor.skip; }   // truncated or replaced
  if (cursor.offset === 0 && size > tail) { cursor.offset = size - tail; cursor.skip = { from: cursor.offset, shown: false }; }
  for (let got = 0; cursor.offset < size && got < budget;) {
    const r = yield* askRead(cursor.offset, Math.min(chunk, budget - got));
    if (r === null) throw gone();
    if (!r.bytes.length) break;
    merge(out, feedTranscript(cursor, r.bytes, agent, maxLine));
    got += r.bytes.length;
    if (r.eof) break;
  }
  return out;
}

// A source that throws (a node that can't answer now, the fleet down) leaves the cursor exactly as it was: what this
// call had read and parsed is dropped with the error, and the next follow reads the same bytes again, so no line is
// lost and none is parsed twice.
export async function followTranscript(src: TranscriptBytes, cursor: TranscriptCursor, agent: string, o: FollowOptions = {}): Promise<Parsed> {
  const before: TranscriptCursor = {
    ...cursor, pending: new Set(cursor.pending),
    ...(cursor.sends ? { sends: new Map([...cursor.sends].map(([k, v]) => [k, [...v]])) } : {}),
    ...(cursor.carry ? { carry: [...cursor.carry] } : {}),
    ...(cursor.skip ? { skip: { ...cursor.skip } } : {}),
  };
  try {
    return await runAsync(followSteps(cursor, agent, o), src);
  } catch (e) {
    delete cursor.sends; delete cursor.latest; delete cursor.carry; delete cursor.skip;
    Object.assign(cursor, before);
    throw e;
  }
}

// An older page (ADR-0008 phase D, O9): up to `limit` messages from before the message `beforeId`, oldest first. Its
// line is found with `locate` (its uuid), then one window of at most `window` bytes before that line is read, with the
// line itself (a page that ends inside a line keeps that line's earlier blocks). The window is parsed in file order with
// fresh question and file state, so a `sendfile` result whose call lies just outside it shows without its files.
// `done`: nothing older is left. `missing`: the message isn't in the transcript: not the beginning (review L1).
// `resume`: where the next page, before this page's first message, ends: the start of that message's line (a hint that
// saves the search). A window that holds no message at all (a line longer than the window lies there) gives one
// message too large to show, so a reader moves on past it instead of asking for the same page again.
export type OlderPage = { messages: Message[]; done: boolean; files: FileRef[]; missing?: true; resume?: { id: string; end: number } };
export type OlderOptions = { limit?: number; from?: number | undefined; window?: number; chunk?: number; maxLine?: number };
const missing = (): OlderPage => ({ messages: [], done: false, files: [], missing: true });

function* readRange(from: number, to: number, chunk: number): Steps<Uint8Array> {
  const parts: Uint8Array[] = [];
  for (let at = from; at < to;) {
    const r = yield* askRead(at, Math.min(chunk, to - at));
    if (r === null) throw gone();
    if (!r.bytes.length) break;
    parts.push(r.bytes);
    at += r.bytes.length;
  }
  return Buffer.concat(parts);
}

// The line that starts at `start`, with its newline; null when it is longer than `maxLine` or hasn't ended. Reads
// grow from 4 KiB to a chunk, so a short line costs a short read.
function* readLine(start: number, chunk: number, maxLine: number): Steps<Uint8Array | null> {
  const parts: Uint8Array[] = [];
  for (let at = start, ask = Math.min(4096, chunk); at - start <= maxLine; ask = Math.min(ask * 2, chunk)) {
    const r = yield* askRead(at, ask);
    if (r === null) throw gone();
    const nl = r.bytes.indexOf(0x0a);
    if (nl !== -1) return Buffer.concat([...parts, r.bytes.subarray(0, nl + 1)]);
    if (!r.bytes.length || r.eof) return null;
    parts.push(r.bytes);
    at += r.bytes.length;
  }
  return null;
}

// A page from one window (pure): `bytes` were read at byte `at`. A line the window's start cuts into is dropped (the
// next page's window holds it), and so is a last line without its newline. `anchored`: the page ends before
// `beforeId`, whose line is the window's last; else it ends at the window's end (a message too large to show asked
// for it). null: that line isn't there, or the message isn't in it.
function pageOf(bytes: Uint8Array, at: number, agent: string, beforeId: string, limit: number, anchored: boolean): OlderPage | null {
  const lines: { line: Line; start: number; end: number }[] = [];
  let from = 0;
  if (at > 0) { const nl = bytes.indexOf(0x0a); from = nl === -1 ? bytes.length : nl + 1; }
  const firstWhole = at + from;
  for (let nl = bytes.indexOf(0x0a, from); nl !== -1; from = nl + 1, nl = bytes.indexOf(0x0a, from)) {
    const line = lineJson(bytes.subarray(from, nl));
    if (line) lines.push({ line, start: at + from, end: at + nl + 1 });
  }
  const cut = beforeId.lastIndexOf(":");
  const wanted = cut === -1 ? beforeId : beforeId.slice(0, cut);      // ids are `<line id>:<block index>`
  const target = anchored ? lines.length - 1 : lines.length;
  if (anchored && lineId(lines[target]?.line ?? {}) !== wanted) return null;
  const messages: Message[] = [];
  const files: FileRef[] = [];
  const lineOf = new Map<string, number>();
  const pending = new Set<string>();
  const sends = new Map<string, (string | null)[]>();
  let latest = 0;                                                     // as the live read keeps it, from this window's start
  for (let i = 0; i <= target && i < lines.length; i++) {
    const p = parseLine(lines[i]?.line ?? {}, agent, pending, sends, latest);
    latest = Math.max(latest, reached(lines[i]?.line ?? {}));
    for (const e of p.entries) if (e.kind !== "answer") { messages.push(e); lineOf.set(e.id, i); }
    files.push(...p.files);
  }
  const index = anchored ? messages.findIndex(m => m.id === beforeId) : messages.length;
  if (index === -1) return null;
  const page = messages.slice(Math.max(0, index - limit), index);
  const ends = anchored ? (lines[target]?.start ?? at + bytes.length) : at + bytes.length;
  if (!page.length && at > 0) {
    // Nothing to show in the whole window: the next page ends where its first whole line starts, or, when one line
    // fills the window, where the window starts.
    const next = firstWhole < ends ? firstWhole : at;
    return { messages: [tooLarge(next, latest || (anchored ? ts(lines[target]?.line ?? {}) : 0))], done: false, files: [] };
  }
  const ids = new Set(page.map(m => m.id));
  const first = page[0];
  const resume = first ? { id: first.id, end: lines[lineOf.get(first.id) ?? 0]?.start ?? at } : undefined;
  return { messages: page, done: at === 0 && index <= limit, files: files.filter(f => ids.has(f.messageId)), ...(resume ? { resume } : {}) };
}

function* olderSteps(agent: string, beforeId: string, o: OlderOptions): Steps<OlderPage> {
  const limit = o.limit ?? 100, window = o.window ?? OLDER_WINDOW_BYTES, chunk = o.chunk ?? LIMITS.chunkBytes, maxLine = o.maxLine ?? MAX_LINE_BYTES;
  const size = yield* askSize();
  if (size === null) throw gone();
  const big = TOO_LARGE.exec(beforeId);
  if (big) {                                                          // the page ends where the text too large to show starts
    const end = Number(big[1]);
    if (end > size) return missing();
    const start = Math.max(0, end - window);
    return pageOf(yield* readRange(start, end, chunk), start, agent, beforeId, limit, false) ?? missing();
  }
  const cut = beforeId.lastIndexOf(":");
  const wanted = cut === -1 ? beforeId : beforeId.slice(0, cut);
  const isWanted = (l: Uint8Array | null) => l !== null && lineId(lineJson(l.subarray(0, l.length - 1)) ?? {}) === wanted;
  // A hint from the last page (where this message's line starts) saves the search, while it still holds.
  let start: number | null = o.from !== undefined && o.from >= 0 && o.from < size ? o.from : null;
  let line = start === null ? null : yield* readLine(start, chunk, maxLine);
  if (start === null || !isWanted(line)) {
    start = yield* askLocate(`"uuid":${JSON.stringify(wanted)}`);
    if (start === null) return missing();
    line = yield* readLine(start, chunk, maxLine);
    if (!isWanted(line)) return missing();
  }
  const from = Math.max(0, start - window);
  const before = yield* readRange(from, start, chunk);
  return pageOf(Buffer.concat([before, line ?? new Uint8Array(0)]), from, agent, beforeId, limit, true) ?? missing();
}

export function olderPage(src: TranscriptBytes, agent: string, beforeId: string, o: OlderOptions = {}): Promise<OlderPage> {
  return runAsync(olderSteps(agent, beforeId, o), src);
}

// ---- until Task 4: the same steps over the local file, synchronously, for ObservationService

type SyncBytes = { size(): number | null; read(offset: number, max: number): Chunk | null; locate(needle: string): number | null };
function runSync<T>(steps: Steps<T>, src: SyncBytes): T {
  let s = steps.next();
  while (!s.done) {
    const a = s.value;
    s = steps.next(a.t === "size" ? src.size() : a.t === "read" ? src.read(a.offset, a.max) : src.locate(a.needle));
  }
  return s.value;
}

const LOCATE_STEP = 1 << 20;
// The file at `path`, open for one call (it throws when the transcript is gone, as the readers always did). Its
// `locate` is node-ops' localTranscriptBytes' search, synchronously.
function onFile<T>(path: string, run: (src: SyncBytes) => T): T {
  const fd = openSync(path, "r");
  const at = (start: number, end: number) => { const b = Buffer.alloc(end - start); return b.subarray(0, readSync(fd, b, 0, b.length, start)); };
  try {
    return run({
      size: () => fstatSync(fd).size,
      read: (offset, max) => {
        const size = fstatSync(fd).size;
        const bytes = at(offset, Math.max(offset, Math.min(offset + max, size)));
        return { bytes, eof: offset + bytes.length >= size };
      },
      locate: needle => {
        const n = Buffer.from(needle, "utf8");
        if (!n.length) return null;
        let after = Buffer.alloc(0);
        for (let end = fstatSync(fd).size; end > 0;) {
          const start = Math.max(0, end - LOCATE_STEP);
          const buf = Buffer.concat([at(start, end), after]);
          const hit = buf.lastIndexOf(n);
          if (hit !== -1) {
            const nl = hit > 0 ? buf.lastIndexOf(0x0a, hit - 1) : -1;
            if (nl !== -1) return start + nl + 1;
            for (let pos = start; pos > 0;) {
              const s = Math.max(0, pos - LOCATE_STEP);
              const k = at(s, pos).lastIndexOf(0x0a);
              if (k !== -1) return s + k + 1;
              pos = s;
            }
            return 0;
          }
          after = buf.subarray(0, n.length - 1);
          end = start;
        }
        return null;
      },
    });
  } finally {
    closeSync(fd);
  }
}

// The follow over the local file (at most the last `tailBytes` on the first read).
export function readTranscript(cursor: TranscriptCursor, agent: string, tailBytes = 2 << 20): Parsed {
  return onFile(cursor.path, src => runSync(followSteps(cursor, agent, { tailBytes }), src));
}

// An older page from the local file. `o.from`: a page's `resume.end` for this message.
export function readOlder(path: string, agent: string, beforeId: string, o: OlderOptions = {}): OlderPage {
  return onFile(path, src => runSync(olderSteps(agent, beforeId, o), src));
}
```

- [ ] **Step 9: Run the new tests and the existing transcript tests**

Run: `npx vitest run apps/hub/test/transcript-long-lines.test.ts apps/hub/test/claude-sessions-older.test.ts`
Expected: PASS (7 + 11 tests).

Run: `npx vitest run apps/hub/test/claude-sessions.test.ts apps/hub/test/claude-sessions-utf8-cursor.test.ts apps/hub/test/protocol-contract.test.ts apps/hub/test/observation-refollow.test.ts apps/hub/test/observation-waiting-on.test.ts apps/hub/test/observation-loop-errors.test.ts apps/hub/test/http-reading.test.ts`
Expected: PASS, unchanged. They go through the synchronous wrappers, which run the new steps.

- [ ] **Step 10: Show that the long-line tests can fail**

Spec §12: each negative control demonstrably fails when its guard is removed.

In `claude-sessions.ts`, replace `    else cursor.carry = carried;` with `    else { /* no carry */ }`.

Run: `npx vitest run apps/hub/test/transcript-long-lines.test.ts`
Expected: FAIL in "a 3 MB line arrives whole, and the follow goes on past it" and "a 10 MB line is one message too large to show, and the follow goes on past it". Restore the line.

Replace `    if (length > maxLine) { cursor.skip = { from: cursor.offset - length, shown: true }; delete cursor.carry; }` with `    if (false) { cursor.skip = { from: cursor.offset - length, shown: true }; delete cursor.carry; }`.

Run it again.
Expected: FAIL in "a 10 MB line is one message too large to show, and the follow goes on past it". The carry grows past `MAX_LINE_BYTES`, which `follow()` checks after every read. Restore the line.

Replace `  if (!page.length && at > 0) {` with `  if (false) {`.

Run it again.
Expected: FAIL in "from a message after the 10 MB line, paging moves on past it to the beginning, never asking twice". Restore the line.

In `followTranscript`, delete the two lines `    delete cursor.sends; delete cursor.latest; delete cursor.carry; delete cursor.skip;` and `    Object.assign(cursor, before);`.

Run it again.
Expected: FAIL in "leaves the cursor as it was, and the next follow reads every line once": `expected { …(6) } to deeply equal { …(5) }` (the cursor moved past the first read's lines, whose messages were dropped with the error: without the restore they are lost for good). Restore the lines, then run once more. Expected: PASS (7 tests).

- [ ] **Step 11: Run all checks**

- `npx vitest run --project units packages apps/hub`. Expected: everything passes, with Task 2's totals (Step 30) +2 files (`transcript-bytes`, `transcript-long-lines`) and +16 tests (8 + 7 + 1). On 2026-10-06 that was 89 files and 752 tests; on macOS without `flock(1)`, only `pane-lock`'s 2 failed, as before.
- `npm run check`. Expected: exit 0.
- `npm run lint`. Expected: no problems reported.
- `MORNDO_HOME="$(mktemp -d)" node apps/hub/src/main.ts devices`. Expected: exit 0.

- [ ] **Step 12: Commit**

```bash
git add packages/node-ops/src/transcript-bytes.ts packages/node-ops/src/index.ts packages/node-ops/test/transcript-bytes.test.ts apps/hub/src/adapters/claude-sessions.ts apps/hub/test/transcript-long-lines.test.ts apps/hub/test/claude-sessions-older.test.ts
git commit -m "feat(hub): read transcripts as bounded bytes, carrying long lines across reads"
```
