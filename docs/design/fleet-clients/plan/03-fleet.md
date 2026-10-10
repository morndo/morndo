## Lane notes (fleet: Tasks 7 to 10)

Tasks 7 to 10, on `feat/fleet-clients-fleet`, in wave 1. They are written against [plan.md](../plan.md)'s Contracts
as they stand: Task 1's protocol and Task 3's client come first; the agent's Tasks 4 to 6 run beside these, so this part
relies on the agent only through the protocol (`lane.deliver`, `delivery.cancel`, `ev.delivery`, the `/lane` hook path).
The rulings of [RECONCILIATION.md](RECONCILIATION.md) that name this part (1 to 6, 8, 18, 21 to 23, 25) are applied;
["Reconciled"](#reconciled) lists where. Ruling 2 changes a name in the Contracts' table of databases: the fleet already
has a `deliveries` table (the hook bus's, migration 1), so the mirror is `lane_deliveries`.

### Decisions beyond the brief (for the reviewer)

**fleet.db (Task 7)**
- **The epoch is synced too** (ruling 62; §6's synced list gains it). Besides the intake, joins and revocations,
  `NodesStore.nextEpoch` commits under `FULL`: the connection epoch is a fencing token that must only grow (ADR-0012), and
  after a power loss a reused epoch could let a stale result be taken as current. One sync per admission; pinned by
  `db-sync.test.ts` and `fc7-epoch-synced`.
- **`synced()` is the agent's, copied** into `adapters/db.ts` rather than moved to `packages/service-kit`: the only agent
  file this part changes is `window-of.ts`. Merging the two is a later cleanup.
- **The window is fleet-wide.** Every connection's events within 25 ms of the first share one transaction, each
  connection's in a savepoint of its own: one that fleet.db refuses rolls back alone (its connection closes 1011 and the
  node replays), the others commit. A commit that fails as a whole acknowledges no one. What a batch announces (alerts,
  the delivery worker's kick, lane events) runs after the commit. A connection the fleet closes cancels its events still
  in the window; one the node closes has them stored, unacknowledged.
- **`revoke` becomes IMMEDIATE**, like `redeem`, inside `synced()`.

**Deliveries (Task 8)**
- **A known id goes back to the node that stored it**, whatever its lane's name resolves to now: that node answers the
  delivery's state, or `id_conflict`, so a retry after a lane moved never queues it twice. An id the fleet doesn't know
  is 404 `{ error: "no_such_delivery" }`, for a cancel as for a `GET`.
- **A body that fails `lane.deliver`'s own rules is 400** (a body that doesn't fit, ruling 3), checked in the route as
  the agent will; routing refusals after that are 200.
- **The mirror:** an op's answer never replaces a newer event's state (both can arrive in one read of the socket, and the
  answer's continuation runs after the event's handler); a final state is never replaced. `ev.delivery` is exempt from the
  per-node rate limit (a reconnect sends every open delivery at once), and one naming another node closes the connection
  1008, as a hook for another node does.
- **`delivery_waiting`** counts from `queuedAt` on the node's clock (an offset over 2 s raises `clock_offset` already),
  persists what it raised (`alerted`), skips a stale row until its node reports, and raises only the highest threshold a
  scan finds crossed. Its `detail` (ruling 25): `{ id, lane | workerId, state, reason, minutes }`.
- **`POST /v1/op` refuses `lane.deliver` and `delivery.cancel`** (400 `bad_args`, "use /v1/deliveries"; ruling 4):
  every delivery goes through `/v1/deliveries`, which routes sticky names, mirrors and audits.
- **`pane.capture` and `lane.stop` through `/v1/op`** (spec §8 lists them; no other task owns the fleet's routing):
  `pane.capture` by lane gets the lane's worker ID and is a bulk op (its answer is up to 256 KiB, one chunk); `lane.stop`'s
  default deadline is `LIMITS.laneStopWaitMs` plus 15 s, since its "exit" may wait 30 s.
- **The audit's actions:** `delivery.post`, `delivery.cancel` (`{ id, target, client, outcome }`) and `delivery.final`
  (`{ id, state, why? }`), never the text.

**Lane events (Task 9)**
- **The manager's own lane** is the lane `laneEvents.deliverTo` names; with `deliverTo: null` no lane is skipped on that
  ground. **A hook without a window makes none** (kira's `if (!win) return`), so `LaneEvent.window` is never null in
  practice.
- **A node's `/lane` events are the fleet's own:** never counted as unrouted, and not a path a subscriber lists (Task 1
  keeps them out of `HOOK_PATHS`).
- **Kept 7 days by the node's clock** (`at`), like their `ts`.
- **Delivery ids** (ruling 6): `fleet:lane-events:<node>:<ms>`, the node and `at` of the batch's first event; the parts
  of a split batch get `-1`, `-2` …; an id already used takes `.2`, `.3` … after that, since a part given up comes back
  first in the next batch and the node would otherwise answer the given-up delivery, or `id_conflict` for the longer text.
- **A repeated `needs_input`** (ruling 18): one for a session whose latest lane event is a `needs_input` is dropped, so an
  agent restart that reports the same menu again doesn't ask the manager twice. A session's latest event is one indexed
  seek (`lane_events_by_session`, migration 5).
- **Stored while `deliverTo` is null, never delivered later** (ruling 23): such events have `to_manager` NULL for good.
- **A part whose answer was lost** (`uncertain`) waits again and goes under a new id: at least once.
- **The test fleet and the drills' harness set `deliverTo: null`**, so no batch lands in a lane a test counts.

**The hook bus and the relay (Task 10)**
- **`subscriber_lagging`** is measured by the time the fleet stored the event (its own clock), checked on every tick (1 s)
  with one seek on `deliveries_pending`, and alerted once per episode with `{ subscriber, oldestAgeMs, streams }` (ruling
  25).
- **`outcomeOf`** keeps today's classification exactly (a 3xx or 1xx is retried, as now).
- **The relay's fallback** takes the body's `window` only when neither `TMUX_PANE` nor the session finds one, and only a
  window name; a `TMUX_PANE` naming no pane the inventory knows still gives null, as today.

### Fleet lane file map (Tasks 7–10)

| File | Responsibility | Task |
|---|---|---|
| `apps/fleet/src/adapters/db.ts` | `NORMAL` with `fullfsync`; `synced()`; `fleetTransactions()` | 7 |
| `apps/fleet/src/adapters/migrations.ts` | migration 5: `lane_deliveries`, `sticky_lanes`, `lane_events` | 7 |
| `apps/fleet/src/adapters/nodes-store.ts` | joins, revocations and epochs synced | 7 |
| `apps/fleet/src/application/hook-sink.ts` | the port an agent connection hands its hook events to; `Transactions` | 7 |
| `apps/fleet/src/application/hook-intake.ts` | `store` inside the intake's commit, `after` it; lane events (Task 9) | 7, 9 |
| `apps/fleet/src/application/intake-window.ts` | 25 ms windows, one synced commit, acks after it | 7 |
| `apps/fleet/src/adapters/agent-session.ts` | a connection's intake handle; `ev.delivery` | 7, 8 |
| `apps/fleet/src/config.ts` | `stickyLanes`, `laneEvents` | 8, 9 |
| `apps/fleet/src/adapters/lane-deliveries-store.ts`, `sticky-lanes-store.ts` | the mirror's and the sticky names' rows | 8 |
| `apps/fleet/src/adapters/delivery-body.ts` | the shape of `POST /v1/deliveries` | 8 |
| `apps/fleet/src/application/deliveries.ts` | routing, the mirror, `delivery_waiting`, the audit | 8 |
| `apps/fleet/src/application/requests.ts`, `router.ts` | side effects and bulk ops; `pane.capture`, `lane.stop` | 8 |
| `apps/fleet/src/adapters/client-api.ts` | `/v1/deliveries…`, `/v1/lane-events`, caps | 8, 9 |
| `apps/fleet/src/application/events.ts` | `delivery` and `lane` events | 8, 9 |
| `apps/fleet/src/adapters/lane-events-store.ts`, `application/lane-events.ts` | lane events built, kept, published; the manager's message | 9 |
| `apps/fleet/src/application/lane-events-push.ts` | batches to the manager | 9 |
| `apps/fleet/src/adapters/outbox-store.ts` | `taken` (Task 9); `oldestPending` (Task 10) | 9, 10 |
| `apps/fleet/src/application/delivery.ts` | `outcomeOf`; `subscriber_lagging` | 10 |
| `apps/fleet/src/serve.ts` | wiring | 7, 8, 9 |
| `apps/node-agent/src/relay/window-of.ts` | the body's `window` as the last resort (the one agent file) | 10 |
| `test/fleet-harness.ts` | its `FleetConfig` literal gains the two settings (Task 16 replaces the literal later) | 8, 9 |
| `scripts/negative-controls.ts` | 65 entries `fc7-…` to `fc10-…`; `fw-i3-unrouted-not-counted` follows its line | 7–10 |

Tests are in `apps/fleet/test/` (helpers in `apps/fleet/test/helpers/`) and `apps/node-agent/test/window-of.test.ts`: real
sockets, temporary directories, port 0, fake agents; no tmux, no real agent, never the owner's system.

### How this part was checked

**Replayed, step by step.** The code was written and checked in a scratch copy of this repository (`6c7d4b9`: `main` at
`849759c` plus docs). The steps below are generated from a script that holds each step's edits, and the same script
replayed them on a fresh copy, in order: every Create written, every Replace's old text found exactly once, every `Run:`
executed (each "see it fail" failed as stated, each "see it pass" passed with the count stated), every commit made. The
replay ended with a clean tree identical, file for file, to the copy where the code was checked.
- **The base is Task 1 as 01-foundation.md writes it** (after the review round): its Steps 2, 4, 8 and 10 applied to a
  copy of `main` by a script, each "Replace line(s)" checked against the file as it was (42 edits, none mismatched), then
  committed. On that base Task 1's own checks hold: `packages/protocol` 104 tests in 9 files, `tsc` (`tsconfig.tests.json`
  included), lint and `negative-controls.ts --check` clean, the fleet's 178 tests. Tasks 2 and 3 were not applied: they
  change `packages/node-ops`, the new client package, the hub and the drills' harness's import line, none of which these
  steps quote or import; and this part's control entries go at the end of `CONTROLS`, before its `];`, wherever earlier
  entries end.
- Node 26.3.1 on macOS (the services run 24.21.0; CI runs 24 on Linux, not replayed here), vitest 5.0.3, better-sqlite3
  13.0.3.

**Results** (2026-10-08; replayed again after the reconciliation's rulings and after its review round, same day):
- The fleet's suite: 178 tests in 35 files before, 241 in 46 after (Task 7: 193 in 38; Task 8: 215 in 41; Task 9: 238 in
  44; Task 10: 241 in 46). `npx tsc -p apps/fleet`, `npx tsc -p tsconfig.tests.json` and `npx oxlint apps/fleet` print
  nothing at every task's end. Task 10's `window-of.test.ts` (3) and the relay's own tests pass.
- **Every negative control bites**, through the repo's runner (`node scripts/negative-controls.ts --only …`): this part's
  65 (13, 19, 24, 9), each run after its task's commit (ruling 50), and, re-run on the final tree, all 63 older controls on `apps/fleet` and the relay. One of those,
  `b6-s1-close-all-at-once`, had stopped biting when `close` awaited the lane-event batches between settling the requests
  and closing the client API; Task 9's `close` order is the fix, and the replay shows 63 of 63.
- **The fleet core's cross-process drills** (real fleet, agent and hub processes, an isolated tmux server, temporary HOMEs)
  pass on the final tree: `drills-stream`, `integration` and `harness` (21 tests), and `drills-retry` (18 tests, twice).
  Once, run beside the other three files, `drills-retry`'s (b‴) failed with `op.status on n1: node_offline`: a restored
  agent is welcomed, turns the welcome down and redials (`connection.ts`, `admit`), and the harness's `waitOnline` can see
  the first connection's "online", so the next op lands in the gap. (b‴) then passed 4 times of 4 alone on this tree and
  on the base. The race is the harness's; each admission's synced epoch (Task 7) makes the gap a few milliseconds wider.
- Flakiness: the fleet suite was run 6 times in a row on the final tree, all green. Three races found on the way (tests
  reading or closing on a batch before the node's answer marked it sent; a lag test on a frozen clock) were the tests',
  not the code's, and are fixed in the tests as written below.

**Not checked here:** the real agent (Tasks 4 to 6; only fake agents answer `lane.deliver` and send `ev.delivery`), Linux,
Node 24, and the PC's HDD (the bench gate of spec §6 is Task 17's, before the hook swap).

---

### Task 7: Fleet: migration 5, the commit rule, the intake window, `fullfsync`

The fleet core's §16.4 rule in `fleet.db` (spec §6, issue #21). Today `openFleetDb` sets `synchronous = FULL` for every
commit, and each agent connection commits its own hook batch once per event-loop turn (`agent-session.ts`, `flush`).
After this task `fleet.db` runs `NORMAL` with `fullfsync`, and only these commits are synced, each as its own
transaction through `synced()`:
- the intake: every connection's hook events (lane events too, Task 9) that arrive within `LIMITS.intakeWindowMs` (25 ms)
  of the first share one IMMEDIATE transaction, synced once; each connection is acknowledged only after it;
- a join and a revocation (`NodesStore.redeem`, `revoke`: a node's key given or taken);
- a node's next connection epoch (`NodesStore.nextEpoch`), on §6's synced list (reconciliation ruling 62). The epoch is a
  fencing token that must only grow (ADR-0012): request ids are `<epoch>.<n>`, and the fleet takes a late result from
  the same agent instance on a newer connection. After a power loss took back the last epoch, the fleet would number its
  next connection's requests with it again, so an answer to a request from before the loss could be taken as the
  current answer to a new request of the same id. `db-sync.test.ts` pins it (a new epoch commits under `FULL`, Step 1),
  with the control `fc7-epoch-synced`.

Delivered marks, the deliveries' mirror, sticky names, the audit and alerts stay `NORMAL` (spec §6); Task 10 pins that side.

**The window** (reconciliation ruling 21: never shorter than one event-loop turn, never longer than 25 ms): it opens at
a connection's first event and closes 25 ms later, whatever follows. So the events of one event-loop turn are never
split (a turn is at most one window), and a steady stream is still committed every 25 ms. With `windowMs: 0` the window
is one event-loop turn (`setImmediate`), as today.

**Files:**
- Modify: `apps/fleet/src/adapters/db.ts` (`NORMAL`, `fullfsync`, `synced`, `fleetTransactions`),
  `apps/fleet/src/adapters/migrations.ts` (migration 5), `apps/fleet/src/adapters/nodes-store.ts` (three synced commits)
- Modify: `apps/fleet/src/application/hook-sink.ts` (the port: `open` instead of `accept`; `Transactions`),
  `apps/fleet/src/application/hook-intake.ts` (`store` in the caller's transaction, announcing after it; `accept` kept)
- Create: `apps/fleet/src/application/intake-window.ts`
- Modify: `apps/fleet/src/adapters/agent-session.ts` (a connection's hook events go to its intake handle),
  `apps/fleet/src/serve.ts` (wiring; `FleetOptions.intakeWindowMs`; `Fleet.intake`)
- Test: `apps/fleet/test/helpers/syncs.ts`, `apps/fleet/test/db-sync.test.ts`, `apps/fleet/test/migrations.test.ts`
  (modified), `apps/fleet/test/intake-window.test.ts`, `apps/fleet/test/intake-commits.test.ts`,
  `apps/fleet/test/agent-auth.test.ts` (its hand-made sink takes the new port)
- Modify: `scripts/negative-controls.ts` (13 entries)

**Interfaces:**
- Consumes (Task 1, `@morndo/protocol`): `LIMITS.intakeWindowMs`, `type HookEvent` (its `path` union with `"/lane"`).
- Produces:
  - `adapters/db.ts`: `synced<T>(db, transaction: () => T): T`; `fleetTransactions(db): Transactions`.
  - `adapters/migrations.ts`: migration 5, the `fleet.db` tables of plan.md's Databases as reconciliation ruling 2 has
    them: `lane_deliveries (id PK, node, target, state, body, updated_at, alerted)`, `sticky_lanes (name PK, node, at)`,
    `lane_events (seq PK autoincrement, node, window, lane, session_id, event, at, body, to_manager, delivery_id)`, with
    an index for a session's latest lane event (ruling 18, Task 9).
  - `application/hook-sink.ts`: `type IntakeConn = { node; streamId; acked(seq: number): void; failed(error: unknown): void }`,
    `type IntakeHandle = { add(e: HookEvent): void; cancel(): void }`, `type HookSink = { known(node, streamId);
    open(conn: IntakeConn): IntakeHandle }`, `type Transactions = { synced<T>(fn: () => T): T; savepoint<T>(fn: () => T): T }`.
  - `application/hook-intake.ts`: `type Stored = { seq: number; after: () => void }`; `HookIntake.store(node, streamId,
    events): Stored` (inside the caller's transaction); `HookIntake.accept(node, streamId, events): number` (one batch,
    synced when constructed with `tx`).
  - `application/intake-window.ts`: `class IntakeWindow implements HookSink` with `constructor({ intake, tx, log,
    windowMs? })`, `flush()`, `stop()`.
  - `serve.ts`: `FleetOptions.intakeWindowMs?: number`; `Fleet.intake: IntakeWindow`.
  - Test helpers: `test/helpers/syncs.ts`: `watchSyncs(db): string[]`, `FULL_THEN_NORMAL`.

- [ ] **Step 1: Write the failing tests for the commit rule and migration 5**

The commits are observed the way the agent's `done-keys.test.ts` observes its own: every change of the connection's
`synchronous` setting is recorded, so a synced commit shows as `synchronous = FULL` then `synchronous = NORMAL`.

Create `apps/fleet/test/helpers/syncs.ts`:

```ts
// Every change of a fleet.db connection's synchronous setting, in order (spec §6: what is synced runs its own
// transaction under FULL, between a "synchronous = FULL" and a "synchronous = NORMAL").
import type Database from "better-sqlite3";

export const FULL_THEN_NORMAL = ["synchronous = FULL", "synchronous = NORMAL"];

export function watchSyncs(db: Database.Database): string[] {
  const seen: string[] = [];
  const pragma = db.pragma.bind(db);
  db.pragma = ((source: string, options?: { simple?: boolean }) => {
    if (/^synchronous\s*=/.test(source)) seen.push(source);
    return pragma(source, options as never);
  }) as typeof db.pragma;
  return seen;
}
```

Create `apps/fleet/test/db-sync.test.ts`:

```ts
// The fleet core's §16.4 rule in fleet.db (fleet clients spec §6, issue #21): the database runs synchronous=NORMAL, with
// macOS's full flush for what is synced, and only what must outlive the machine is committed under FULL, each as its own
// transaction: a join and a revocation (a node's key), a node's next connection epoch (a fencing token), and the intake
// (intake-window.test.ts). Issuing a code, `seen` and the source are not synced.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openFleetDb, synced } from "../src/adapters/db.ts";
import { NodesStore } from "../src/adapters/nodes-store.ts";
import { newKey } from "./helpers/fake-agent.ts";
import { FULL_THEN_NORMAL, watchSyncs } from "./helpers/syncs.ts";
import { tempDir } from "./helpers/temp.ts";


describe("fleet.db's commits (spec §6)", () => {
  it("runs NORMAL, with fullfsync", () => {
    const db = openFleetDb(join(tempDir(), "fleet.db"));
    expect(db.pragma("synchronous", { simple: true })).toBe(1);
    expect(db.pragma("fullfsync", { simple: true })).toBe(1);
    db.close();
  });

  it("synced() runs its transaction under FULL and the connection is NORMAL after it, committed or failed", () => {
    const db = openFleetDb(join(tempDir(), "fleet.db"));
    const seen = watchSyncs(db);
    expect(synced(db, () => db.transaction(() => db.prepare("INSERT INTO sticky_lanes (name, node, at) VALUES ('m', 'pc', 1)").run().changes)())).toBe(1);
    expect(seen).toEqual(FULL_THEN_NORMAL);
    expect(() => synced(db, () => db.transaction(() => { db.prepare("INSERT INTO sticky_lanes (name, node, at) VALUES ('n', 'pc', 1)").run(); throw new Error("boom"); })())).toThrow("boom");
    expect(seen).toEqual([...FULL_THEN_NORMAL, ...FULL_THEN_NORMAL]);
    expect(db.pragma("synchronous", { simple: true })).toBe(1);
    expect(db.prepare("SELECT name FROM sticky_lanes").all()).toEqual([{ name: "m" }]);   // the failed one rolled back
    db.close();
  });

  it("synced() refuses to run inside another transaction, and leaves that one as it was", () => {
    const db = openFleetDb(join(tempDir(), "fleet.db"));
    const outer = db.transaction(() => synced(db, () => 1));
    expect(() => outer()).toThrow("can't be nested");
    expect(db.inTransaction).toBe(false);
    expect(db.pragma("synchronous", { simple: true })).toBe(1);
    db.close();
  });

  it("a join, a revocation and a new connection epoch are synced; a code, `seen` and the source are not", () => {
    const db = openFleetDb(join(tempDir(), "fleet.db"));
    const nodes = new NodesStore(db);
    const seen = watchSyncs(db);
    const issued = nodes.issueCode("pc");
    if (!issued.ok) throw new Error("no code");
    expect(seen).toEqual([]);                                                        // a lost code is issued again
    expect(nodes.redeem(issued.code, "pc", newKey().publicKey)).toEqual({ ok: true, node: "pc" });
    expect(seen).toEqual(FULL_THEN_NORMAL);
    expect(nodes.nextEpoch("pc")).toBe(1);
    expect(seen).toEqual([...FULL_THEN_NORMAL, ...FULL_THEN_NORMAL]);
    nodes.seen("pc", "agent/1");
    nodes.recordSource("pc", "100.64.0.7");
    expect(seen).toHaveLength(4);
    expect(nodes.revoke("pc")).toBe(true);
    expect(seen).toEqual([...FULL_THEN_NORMAL, ...FULL_THEN_NORMAL, ...FULL_THEN_NORMAL]);
    expect(db.pragma("synchronous", { simple: true })).toBe(1);
    db.close();
  });
});
```

In `apps/fleet/test/migrations.test.ts`, replace:

```ts
// fleet.db's numbered migrations (Global Constraints: in the style of the hub's): a fresh database gets every table,
// WAL and synchronous=FULL; a database from a newer fleet service is refused and left untouched.
```

with:

```ts
// fleet.db's numbered migrations (Global Constraints: in the style of the hub's): a fresh database gets every table,
// WAL, synchronous=NORMAL and fullfsync (fleet clients spec §6: only the intake, joins, revocations and epochs are
// synced, db-sync.test.ts); a database from a newer fleet service is refused and left untouched.
```

Then replace:

```ts
  it("a fresh database gets every table, WAL, synchronous=FULL and foreign keys", () => {
```

with:

```ts
  it("a fresh database gets every table, WAL, synchronous=NORMAL, fullfsync and foreign keys", () => {
```

Then replace:

```ts
    expect(tables(db)).toEqual(["audit", "dead_letters", "deliveries", "hook_unrouted", "join_codes", "lanes", "nodes", "outbox", "store_seqs", "stream_hwm"]);
```

with:

```ts
    expect(tables(db)).toEqual([
      "audit", "dead_letters", "deliveries", "hook_unrouted", "join_codes", "lane_deliveries", "lane_events", "lanes", "nodes", "outbox",
      "sticky_lanes", "store_seqs", "stream_hwm",
    ]);
```

Then replace:

```ts
    expect(columns(db, "store_seqs")).toEqual(["node", "store", "seq", "at"]);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("synchronous", { simple: true })).toBe(2);                      // 2 = FULL
```

with:

```ts
    expect(columns(db, "store_seqs")).toEqual(["node", "store", "seq", "at"]);
    expect(columns(db, "lane_deliveries")).toEqual(["id", "node", "target", "state", "body", "updated_at", "alerted"]);
    expect(columns(db, "sticky_lanes")).toEqual(["name", "node", "at"]);
    expect(columns(db, "lane_events")).toEqual(["seq", "node", "window", "lane", "session_id", "event", "at", "body", "to_manager", "delivery_id"]);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("synchronous", { simple: true })).toBe(1);                      // 1 = NORMAL: a commit isn't synced unless synced()
    expect(db.pragma("fullfsync", { simple: true })).toBe(1);                        // macOS's full flush for what is synced
```

Then replace:

```ts
  it("numbers migrations 1, 2, 3 … with no gaps", () => {
```

with:

```ts
  it("a version 4 database (before the fleet clients' tables) is migrated to the latest, keeping its rows; migration 5 run again changes nothing", () => {
    const path = join(tempDir(), "fleet.db");
    const old = new Database(path);
    migrate(old, MIGRATIONS.slice(0, 4));
    old.prepare("INSERT INTO lanes (name, node, worker_id, registered_at, conflict) VALUES ('manager', 'pc', 'pc.3fa2c1d0.1', 1, 0)").run();
    old.close();
    const db = openFleetDb(path);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST);
    expect(db.prepare("SELECT name, node FROM lanes").all()).toEqual([{ name: "manager", node: "pc" }]);
    expect(tables(db)).toEqual(expect.arrayContaining(["lane_deliveries", "lane_events", "sticky_lanes"]));
    expect(() => MIGRATIONS[4]?.up(db)).not.toThrow();                               // guarded: IF NOT EXISTS
    db.close();
  });

  it("lane_events takes to_manager 0, 1 or NULL, and nothing else", () => {
    const db = openFleetDb(join(tempDir(), "fleet.db"));
    const insert = db.prepare("INSERT INTO lane_events (node, window, lane, event, at, body, to_manager) VALUES ('pc', 'api', 'api', 'finished', 1, '{}', ?)");
    for (const v of [0, 1, null]) expect(() => insert.run(v)).not.toThrow();
    expect(() => insert.run(2)).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it("numbers migrations 1, 2, 3 … with no gaps", () => {
```

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run apps/fleet/test/db-sync.test.ts apps/fleet/test/migrations.test.ts`
Expected: FAIL, 7 of 12: in `db-sync.test.ts` all 4 (`expected 2 to be 1`, `TypeError: synced is not a function`, and the syncs `expected [] to deeply equal [ 'synchronous = FULL', …(1) ]`); in `migrations.test.ts` 3 (the tables, `expected 2 to be 1` for `synchronous`, and `no such table: lane_events`)

- [ ] **Step 3: Implement migration 5, `NORMAL` with `fullfsync`, `synced()`, and the synced node commits**

In `apps/fleet/src/adapters/migrations.ts`, replace:

```ts
      CREATE INDEX IF NOT EXISTS deliveries_pending ON deliveries (subscriber, outbox_id) WHERE state = 'pending';
    `),
  },
];
```

with:

```ts
      CREATE INDEX IF NOT EXISTS deliveries_pending ON deliveries (subscriber, outbox_id) WHERE state = 'pending';
    `),
  },
  {
    version: 5,
    name: "fleet clients: the deliveries' mirror, sticky lane names, lane events (fleet clients spec §4.6, §7)",
    up: db => db.exec(`
      -- The latest state of each delivery its node reported (ev.delivery, or the answer to lane.deliver and
      -- delivery.cancel): never its text. target: {"lane":…} or {"workerId":…} as JSON; body: the Delivery as JSON.
      -- alerted: how many of LIMITS.deliveryAlertMs's thresholds raised delivery_waiting for it (0 to 3).
      -- Not synced (spec §6). Named lane_deliveries: the hook bus's own table is deliveries (migration 1).
      CREATE TABLE IF NOT EXISTS lane_deliveries (
        id TEXT PRIMARY KEY, node TEXT NOT NULL, target TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL,
        updated_at INTEGER NOT NULL, alerted INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS lane_deliveries_by_updated ON lane_deliveries (updated_at);
      -- The node that last reported a window of each sticky lane name (stickyLanes). Not synced.
      CREATE TABLE IF NOT EXISTS sticky_lanes (name TEXT PRIMARY KEY, node TEXT NOT NULL, at INTEGER NOT NULL);
      -- Lane events (spec §7), written in the synced intake with the hooks they come from. at: the hook's time on its
      -- node; body: the event's own fields as JSON. to_manager: 0 waiting for the manager, 1 in a delivery its node
      -- stored, NULL not for the manager. delivery_id: the delivery that carries it while to_manager is 1.
      CREATE TABLE IF NOT EXISTS lane_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, node TEXT NOT NULL, window TEXT, lane TEXT, session_id TEXT, event TEXT NOT NULL,
        at INTEGER NOT NULL, body TEXT NOT NULL, to_manager INTEGER CHECK (to_manager IN (0, 1)), delivery_id TEXT);
      CREATE INDEX IF NOT EXISTS lane_events_waiting ON lane_events (seq) WHERE to_manager = 0;
      CREATE INDEX IF NOT EXISTS lane_events_by_delivery ON lane_events (delivery_id) WHERE delivery_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS lane_events_by_at ON lane_events (at);
      -- A session's latest lane event (a needs_input repeated after an agent restart is dropped).
      CREATE INDEX IF NOT EXISTS lane_events_by_session ON lane_events (session_id, seq) WHERE session_id IS NOT NULL;
    `),
  },
];
```

In `apps/fleet/src/adapters/db.ts`, replace:

```ts
// Opens fleet.db: WAL, and synchronous=FULL, because a hook event is acknowledged to its node only after its outbox row
// commits (spec 5.6), and in WAL mode NORMAL may lose the last commits on a power cut
// (https://www.sqlite.org/pragma.html#pragma_synchronous, read 2026-10-06). Unlike the node agent's (§16.4), what this
// database would lose is not lost with it: on a control plane apart from its nodes, a node deletes an event once the
// fleet has acknowledged it, while its lanes run on. Only on this machine's own disk (assertLocalDisk: WAL needs it).
// The service and its console commands both open it; better-sqlite3 waits up to 5 s on a lock by default.
```

with:

```ts
// Opens fleet.db: WAL with synchronous=NORMAL, and the fleet core's §16.4 rule for what is synced (fleet clients spec
// §6; issue #21). A commit is synced to the disk only when what it guards must outlive the machine:
// - synced (`synced()`, synchronous=FULL for that one transaction): the intake that precedes acknowledging hook events to
//   a node, lane events included (the node deletes its copy once acknowledged, and on a control plane apart from its
//   nodes those nodes' lanes run on: application/intake-window.ts); a join, a revocation (a node's key, given or taken),
//   and a node's next connection epoch (a fencing token that must only grow, across a power loss too);
// - not synced: the delivered marks of the hook bus and of the manager's lane events (a lost mark means one more
//   delivery, which the receiver skips by its key or id), the deliveries' mirror, sticky lane names, the audit, alerts.
// "WAL mode is always consistent with synchronous=NORMAL, but WAL mode does lose durability. A transaction committed in
// WAL mode with synchronous=NORMAL might roll back following a power loss or system crash"; with FULL "an additional sync
// operation of the WAL file happens after each transaction commit" (https://www.sqlite.org/pragma.html#pragma_synchronous,
// read 2026-10-08). On macOS a plain fsync() leaves the data in the drive's cache; F_FULLFSYNC flushes it ("Only Mac OS X
// supports F_FULLFSYNC"; with the fullfsync flag set "the F_FULLFSYNC syncing method is used for all sync operations and
// the checkpoint_fullfsync setting is irrelevant", https://www.sqlite.org/pragma.html#pragma_fullfsync, read 2026-10-08).
// Elsewhere it does nothing. Only on this machine's own disk (assertLocalDisk: WAL needs it).
// The service and its console commands both open it; better-sqlite3 waits up to 5 s on a lock by default.
```

Then replace:

```ts
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = ON");
```

with:

```ts
    db.pragma("synchronous = NORMAL");
    db.pragma("fullfsync = ON");
    db.pragma("foreign_keys = ON");
```

and at the end of the file add `synced()`, after `openFleetDb`: replace

```ts
  return db;
}
```

with:

```ts
  return db;
}

// Runs one transaction with synchronous=FULL, then sets the connection back to NORMAL (as the agent's done keys do,
// apps/node-agent/src/ops/done-keys.ts). Its own transaction only: SQLite refuses to change the setting inside one ("Safety
// level may not be changed inside a transaction"). A transaction left open (a rollback that failed) keeps FULL, slower but
// safe, rather than hiding the error behind the setting's.
export function synced<T>(db: Database.Database, transaction: () => T): T {
  if (db.inTransaction) throw new Error("synced() runs its own transaction; it can't be nested in another");
  db.pragma("synchronous = FULL");
  try { return transaction(); } finally { if (!db.inTransaction) db.pragma("synchronous = NORMAL"); }
}
```

In `apps/fleet/src/adapters/nodes-store.ts`, replace:

```ts
// at the first match.
import
```

with:

```ts
// at the first match.
// A join and a revocation (the node's key, given or taken) and the next connection epoch (a fencing token: it only grows)
// are synced to the disk (db.ts `synced`, spec §6): each must outlive the machine. Issuing a code, `seen` and the source
// are not: a lost code is issued again, and the others are refreshed on the next connection.
import
```

Then replace:

```ts
import { parsePublicKey } from "./keys.ts";
```

with:

```ts
import { synced } from "./db.ts";
import { parsePublicKey } from "./keys.ts";
```

In `redeem`, replace:

```ts
    const hash = hashOf(bytes);
    return this.#db.transaction((): Redeemed => {
```

with:

```ts
    const hash = hashOf(bytes);
    return synced(this.#db, () => this.#db.transaction((): Redeemed => {
```

and its end:

```ts
      return { ok: true, node: match.node };
    }).immediate();
  }
```

with:

```ts
      return { ok: true, node: match.node };
    }).immediate());
  }
```

Replace `revoke`:

```ts
  revoke(name: string): boolean {
    return this.#db.transaction(() => {
      const changed = this.#db.prepare("UPDATE nodes SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL").run(this.#now(), name).changes > 0;
      this.#db.prepare("DELETE FROM join_codes WHERE node = ? AND used_at IS NULL").run(name);
      return changed;
    })();
  }
```

with:

```ts
  revoke(name: string): boolean {
    return synced(this.#db, () => this.#db.transaction(() => {
      const changed = this.#db.prepare("UPDATE nodes SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL").run(this.#now(), name).changes > 0;
      this.#db.prepare("DELETE FROM join_codes WHERE node = ? AND used_at IS NULL").run(name);
      return changed;
    }).immediate());
  }
```

In `nextEpoch`, replace:

```ts
    const r = this.#db.prepare("UPDATE nodes SET conn_epoch = conn_epoch + 1 WHERE name = ? RETURNING conn_epoch").get(name) as { conn_epoch: number } | undefined;
```

with:

```ts
    const r = synced(this.#db, () => this.#db.prepare("UPDATE nodes SET conn_epoch = conn_epoch + 1 WHERE name = ? RETURNING conn_epoch").get(name)) as { conn_epoch: number } | undefined;
```

`redeem` and `revoke` keep their own transactions inside `synced()`; `revoke` becomes IMMEDIATE like `redeem`, so the
console and the service never upgrade a read lock into a write. `nextEpoch` is one statement, its own transaction.

- [ ] **Step 4: Run them and see them pass**

Run: `npx vitest run apps/fleet/test/db-sync.test.ts apps/fleet/test/migrations.test.ts`
Expected: PASS (12 tests in 2 files)

Run: `npx vitest run apps/fleet`
Expected: PASS (184 tests in 36 files): §16.4's rule changes no other answer

- [ ] **Step 5: Commit**

```bash
git add apps/fleet/src/adapters/db.ts apps/fleet/src/adapters/migrations.ts apps/fleet/src/adapters/nodes-store.ts apps/fleet/test/helpers/syncs.ts apps/fleet/test/db-sync.test.ts apps/fleet/test/migrations.test.ts
git commit -m "feat(fleet): fleet.db on NORMAL with fullfsync, joins, revocations and epochs synced, migration 5"
```

- [ ] **Step 6: Write the failing tests for the intake window**

`intake-window.test.ts` drives the window over a real `fleet.db` and a second, read-only connection to it, which sees
only what is committed: each acknowledgement records how many of its stream's rows that connection could read when it
was sent. `intake-commits.test.ts` drives it through the real fleet with fake agents. Neither tmux nor a real agent is
involved.

Create `apps/fleet/test/intake-window.test.ts`:

```ts
// The intake window (spec §6, issue #21): hook events of every connection that arrive within 25 ms of the first share
// one commit, synced once; each connection is acknowledged its own stream's mark only once that commit is on the disk
// (another connection to fleet.db sees the rows when the ack is sent); a turn's events are never split, and a steady
// stream is still committed every 25 ms; one connection's failing events roll back alone; a failed commit acknowledges
// no one; a cancelled connection's events are never stored.
import Database from "better-sqlite3";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HookEvent } from "@morndo/protocol";
import type { Subscriber } from "../src/config.ts";
import { Audit } from "../src/adapters/audit.ts";
import { fleetTransactions, openFleetDb, synced } from "../src/adapters/db.ts";
import { OutboxStore } from "../src/adapters/outbox-store.ts";
import { HookIntake } from "../src/application/hook-intake.ts";
import type { IntakeConn } from "../src/application/hook-sink.ts";
import { IntakeWindow, type Intake } from "../src/application/intake-window.ts";
import { quiet } from "./helpers/fleet.ts";
import { FULL_THEN_NORMAL, watchSyncs } from "./helpers/syncs.ts";
import { tempDir } from "./helpers/temp.ts";
import { until } from "./helpers/until.ts";

const ALL: Subscriber = { name: "kira", url: "http://127.0.0.1:1/hooks", paths: ["/cc", "/hook/stop"] };
const ev = (node: string, streamId: string, seq: number): HookEvent =>
  ({ streamId, seq, at: 1_700_000_000_000 + seq, path: "/hook/stop", node, window: "api", body: { seq } });

function setup(o: { windowMs?: number; intake?: (real: HookIntake) => Intake; tx?: (db: Database.Database) => ReturnType<typeof fleetTransactions> } = {}) {
  const path = join(tempDir(), "fleet.db");
  const db = openFleetDb(path);
  const syncs = watchSyncs(db);
  const real = new HookIntake({ store: new OutboxStore(db), subscribers: [ALL], audit: new Audit(db) });
  const window = new IntakeWindow({
    intake: o.intake ? o.intake(real) : real, tx: o.tx ? o.tx(db) : fleetTransactions(db), log: quiet, ...(o.windowMs === undefined ? {} : { windowMs: o.windowMs }),
  });
  const reader = new Database(path, { readonly: true });                             // sees only what is committed
  const committed = () => (reader.prepare("SELECT node, stream_id, seq FROM outbox ORDER BY id").all() as { node: string; stream_id: string; seq: number }[])
    .map(r => `${r.node}/${r.stream_id}:${r.seq}`);
  const said: string[] = [];
  const conn = (node: string, streamId: string): IntakeConn => ({
    node, streamId,
    acked: seq => said.push(`acked ${node}/${streamId}:${seq} (${committed().filter(c => c.startsWith(`${node}/${streamId}:`)).length} committed)`),
    failed: () => said.push(`failed ${node}/${streamId}`),
  });
  return { db, syncs, window, committed, said, conn, close: () => { reader.close(); db.close(); } };
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("the intake window", () => {
  it("events of two nodes within 25 ms share one commit, synced once, and each is acknowledged its own mark after it", async () => {
    const t = setup();
    const pc = t.window.open(t.conn("pc", "s1"));
    const mac = t.window.open(t.conn("mac", "s2"));
    pc.add(ev("pc", "s1", 1));
    mac.add(ev("mac", "s2", 1));
    await sleep(5);
    pc.add(ev("pc", "s1", 2));                                                       // later, in the same window
    await until(() => t.said.length === 2);
    expect(t.syncs).toEqual(FULL_THEN_NORMAL);                                       // negative control: windowMs 0 commits twice
    expect(t.said).toEqual(["acked pc/s1:2 (2 committed)", "acked mac/s2:1 (1 committed)"]);
    expect(t.committed()).toEqual(["pc/s1:1", "pc/s1:2", "mac/s2:1"]);
    t.close();
  });

  it("closes 25 ms after its first event however many follow, and never splits one turn's events", async () => {
    const t = setup();
    const pc = t.window.open(t.conn("pc", "s1"));
    const start = performance.now();
    for (let seq = 1; seq <= 300; seq++) pc.add(ev("pc", "s1", seq));                // one turn: one commit
    await until(() => t.said.length === 1);
    expect(performance.now() - start).toBeGreaterThanOrEqual(20);
    expect(t.said).toEqual(["acked pc/s1:300 (300 committed)"]);
    for (let seq = 301; seq <= 320; seq++) { pc.add(ev("pc", "s1", seq)); await sleep(5); }   // a steady stream for ~100 ms
    await until(() => t.said.at(-1)?.startsWith("acked pc/s1:320") === true);
    expect(t.syncs.length / 2).toBeGreaterThanOrEqual(3);                              // committed every 25 ms, not held open
    t.close();
  });

  it("with windowMs 0 the window is one event-loop turn", async () => {
    const t = setup({ windowMs: 0 });
    const pc = t.window.open(t.conn("pc", "s1"));
    pc.add(ev("pc", "s1", 1));
    pc.add(ev("pc", "s1", 2));
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));
    expect(t.said).toEqual(["acked pc/s1:2 (2 committed)"]);
    t.close();
  });

  it("a cancelled connection's events are never stored nor acknowledged; the others' are", async () => {
    const t = setup();
    const pc = t.window.open(t.conn("pc", "s1"));
    const mac = t.window.open(t.conn("mac", "s2"));
    pc.add(ev("pc", "s1", 1));
    mac.add(ev("mac", "s2", 1));
    pc.cancel();                                                                      // the fleet closed pc's connection
    await until(() => t.said.length > 0);
    await sleep(40);
    expect(t.said).toEqual(["acked mac/s2:1 (1 committed)"]);
    expect(t.committed()).toEqual(["mac/s2:1"]);
    t.close();
  });

  it("one connection's events that fail roll back alone: it is told, the others commit and are acknowledged", async () => {
    const t = setup({
      intake: real => ({
        known: (n, s) => real.known(n, s),
        store: (n, s, events) => { const r = real.store(n, s, events); if (s === "bad") throw new Error("fleet.db refused it"); return r; },
      }),
    });
    t.window.open(t.conn("pc", "bad")).add(ev("pc", "bad", 1));
    t.window.open(t.conn("mac", "s2")).add(ev("mac", "s2", 1));
    await until(() => t.said.length === 2);
    expect(t.said).toEqual(["failed pc/bad", "acked mac/s2:1 (1 committed)"]);
    expect(t.committed()).toEqual(["mac/s2:1"]);                                     // negative control: no savepoint keeps pc/bad:1
    expect(t.syncs).toEqual(FULL_THEN_NORMAL);
    t.close();
  });

  it("a commit that fails as a whole (its sync) stores nothing and acknowledges no one", async () => {
    const t = setup({
      tx: db => ({
        synced: fn => synced(db, () => db.transaction(() => { fn(); throw new Error("disk I/O error"); }).immediate()),
        savepoint: fn => db.transaction(fn)(),
      }),
    });
    t.window.open(t.conn("pc", "s1")).add(ev("pc", "s1", 1));
    t.window.open(t.conn("mac", "s2")).add(ev("mac", "s2", 1));
    await until(() => t.said.length === 2);
    expect(t.said).toEqual(["failed pc/s1", "failed mac/s2"]);
    expect(t.committed()).toEqual([]);
    expect(t.db.pragma("synchronous", { simple: true })).toBe(1);
    t.close();
  });

  it("stop() commits what the window holds at once", () => {
    const t = setup();
    t.window.open(t.conn("pc", "s1")).add(ev("pc", "s1", 1));
    t.window.stop();
    expect(t.said).toEqual(["acked pc/s1:1 (1 committed)"]);
    t.close();
  });
});
```

Create `apps/fleet/test/intake-commits.test.ts`:

```ts
// The intake window inside the real fleet (spec §6): two nodes' hooks sent within the window are acknowledged after one
// synced commit; a connection the fleet closes (a revoked node) loses what it sent in the window, never stored; one the
// node closes has it stored, unacknowledged, and its next welcome says so (ackSeq).
import { describe, expect, it } from "vitest";
import { startTestFleet } from "./helpers/fleet.ts";
import { FULL_THEN_NORMAL, watchSyncs } from "./helpers/syncs.ts";
import { until } from "./helpers/until.ts";

// What fleet.db holds of each stream: its mark (the test fleet has no subscribers, so events are counted, not kept).
const marks = (db: { prepare(sql: string): { all(): unknown[] } }) => (db.prepare("SELECT node, seq FROM stream_hwm ORDER BY node").all() as { node: string; seq: number }[]).map(r => `${r.node}:${r.seq}`);

describe("hook events through the intake window", () => {
  it("two nodes' hooks in one window: one synced commit, then each node's ack", async () => {
    const fleet = await startTestFleet({ intakeWindowMs: 100 });
    const pc = await fleet.online("pc");
    const mac = await fleet.online("mac");
    const syncs = watchSyncs(fleet.db);                                               // after the admissions (their epochs are synced)
    pc.hook(1);
    mac.hook(1);
    pc.hook(2);
    expect(await pc.acked(2)).toBe(2);
    expect(await mac.acked(1)).toBe(1);
    expect(syncs).toEqual(FULL_THEN_NORMAL);
    expect(marks(fleet.db)).toEqual(["mac:1", "pc:2"]);
  });

  it("a revoked node's hooks still in the window are never stored; a node that hangs up has its hooks stored, unacknowledged", async () => {
    const fleet = await startTestFleet({ intakeWindowMs: 200 });
    const pc = await fleet.online("pc");
    pc.hook(1);
    await until(() => pc.inbox.length > 0 && pc.inbox.some(m => m.t === "ack"));      // 1 is stored and acknowledged
    pc.hook(2);
    await new Promise(r => setTimeout(r, 50));                                        // 2 has reached the window (200 ms)
    fleet.nodes.revoke("pc");
    fleet.connections.revoke("pc");                                                   // inside 2's window
    await new Promise(r => setTimeout(r, 300));
    expect(marks(fleet.db)).toEqual(["pc:1"]);                                        // negative control: without cancel(), pc:2

    const mac = await fleet.online("mac");
    mac.hook(1);
    mac.terminate();                                                                   // the node hangs up inside the window
    await until(() => marks(fleet.db).includes("mac:1"));
    const again = fleet.agent({ node: "mac", key: mac.key, instanceId: mac.instanceId, streamId: mac.streamId });
    expect(await again.connect()).toMatchObject({ ok: true, welcome: { ackSeq: 1, streamKnown: true } });
  });
});
```

- [ ] **Step 7: Run them and see them fail**

Run: `npx vitest run apps/fleet/test/intake-window.test.ts apps/fleet/test/intake-commits.test.ts`
Expected: FAIL: `intake-window.test.ts` doesn't load (`Error: Cannot find module '../src/application/intake-window.ts'`); `intake-commits.test.ts` fails both: `expected [] to deeply equal [ 'synchronous = FULL', …(1) ]` (the intake isn't synced yet) and `expected [ 'pc:2' ] to deeply equal [ 'pc:1' ]` (a batch committed before the revocation reached it)

- [ ] **Step 8: Implement the port, the window, and the intake's two halves**

Replace the whole of `apps/fleet/src/application/hook-sink.ts` with:

```ts
// Where an agent connection hands the hook events it receives (spec 5.4): the intake window (intake-window.ts)
// implements it. `known` answers the welcome's ackSeq and streamKnown. `open` gives one connection its handle: `add`
// queues an event for the next intake commit, and once that commit is synced to the disk the connection hears
// `acked(seq)`, the highest seq now accepted for its stream (cumulative), or `failed(error)` when its events could not
// be stored (nothing of them is acknowledged). `cancel` drops what the connection queued and not yet committed (the
// fleet closed it: a revoked node, a replaced connection).
import type { HookEvent } from "@morndo/protocol";

export type IntakeConn = { node: string; streamId: string; acked(seq: number): void; failed(error: unknown): void };
export type IntakeHandle = { add(e: HookEvent): void; cancel(): void };
export type HookSink = {
  known(node: string, streamId: string): { seq: number; known: boolean };
  open(conn: IntakeConn): IntakeHandle;
};
// fleet.db's transactions as the intake needs them (adapters/db.ts fleetTransactions): one transaction synced to the
// disk, and a savepoint inside it.
export type Transactions = { synced<T>(fn: () => T): T; savepoint<T>(fn: () => T): T };
```

In `apps/fleet/src/adapters/db.ts`, replace:

```ts
import { DatabaseFromFuture, MIGRATIONS, migrate } from "./migrations.ts";
```

with:

```ts
import type { Transactions } from "../application/hook-sink.ts";
import { DatabaseFromFuture, MIGRATIONS, migrate } from "./migrations.ts";
```

and add `fleetTransactions` after `synced`: replace

```ts
  try { return transaction(); } finally { if (!db.inTransaction) db.pragma("synchronous = NORMAL"); }
}
```

with:

```ts
  try { return transaction(); } finally { if (!db.inTransaction) db.pragma("synchronous = NORMAL"); }
}

// fleet.db's transactions for the intake (application/intake-window.ts): one IMMEDIATE transaction synced to the disk,
// and a savepoint inside it, so one connection's events that fail roll back alone.
export function fleetTransactions(db: Database.Database): Transactions {
  return {
    synced: fn => synced(db, () => db.transaction(fn).immediate()),
    savepoint: fn => db.transaction(fn)(),
  };
}
```

better-sqlite3 runs a transaction function called inside another as a savepoint (`SAVEPOINT`, `RELEASE`, `ROLLBACK
TO` in `lib/methods/transaction.js`, v13.0.3), so `OutboxStore.accept`'s own `.immediate()` transaction becomes a savepoint
of the window's commit, and a throw inside it rolls back only its own rows.

In `apps/fleet/src/application/hook-intake.ts`, replace:

```ts
// only. The service also logs, at startup, each script path no subscriber takes (serve.ts, unsubscribedScriptPaths).
import { LIMITS, type HookEvent } from "@morndo/protocol";
```

with:

```ts
// only. The service also logs, at startup, each script path no subscriber takes (serve.ts, unsubscribedScriptPaths).
// `store` runs inside the caller's transaction (the intake window's synced commit) and hands back what to do once that
// commit is on the disk: the alerts and the delivery worker's kick, so nothing is announced that a failed commit took
// back. `accept` is store and commit in one, for a caller with a single batch.
import { LIMITS, type HookEvent } from "@morndo/protocol";
```

Then replace:

```ts
import type { HookSink } from "./hook-sink.ts";
```

with:

```ts
import type { Transactions } from "./hook-sink.ts";

// One connection's batch, stored in the caller's transaction: the stream's mark, and what to do once it committed.
export type Stored = { seq: number; after: () => void };
```

Then replace:

```ts
export class HookIntake implements HookSink {
```

with:

```ts
export class HookIntake {
```

Then replace:

```ts
  #onStored: () => void;
  #overflowing
```

with:

```ts
  #onStored: () => void;
  #tx: Transactions | null;
  #overflowing
```

Then replace:

```ts
  constructor(p: { store: OutboxStore; subscribers: Subscriber[]; audit: Audit; now?: () => number; cap?: number; onStored?: () => void }) {
```

with:

```ts
  constructor(p: {
    store: OutboxStore; subscribers: Subscriber[]; audit: Audit; now?: () => number; cap?: number; onStored?: () => void; tx?: Transactions;
  }) {
```

Then replace:

```ts
    this.#onStored = p.onStored ?? (() => {});
  }
```

with:

```ts
    this.#onStored = p.onStored ?? (() => {});
    this.#tx = p.tx ?? null;
  }
```

Then replace `accept` with `store` and `accept`:

```ts
  accept(node: string, streamId: string, events: HookEvent[]): number {
    const route = (e: HookEvent) => this.#subscribers.filter(s => s.paths.includes(e.path)).map(s => s.name);
    const r = this.#store.accept(node, streamId, events, route, { now: this.#now(), cap: this.#cap });
    for (const name of this.#overflowing) if (this.#store.pendingCount(name) < this.#cap) this.#overflowing.delete(name);
    for (const [name, over] of r.overflow) {
      if (over.deadLettered === 0 || this.#overflowing.has(name)) continue;
      this.#overflowing.add(name);
      this.#audit.alert("backlog_full", node, { subscriber: name, cap: this.#cap, droppedProgress: over.dropped, deadLettered: over.deadLettered });
    }
    for (const [path, events] of r.unrouted) {
      if (!(SCRIPT_PATHS as readonly string[]).includes(path) || this.#unroutedAlerted.has(path)) continue;
      this.#audit.alert("unrouted_hook", node, { path, events });
      this.#unroutedAlerted.add(path);
    }
    if (r.stored > 0) this.#onStored();
    return r.seq;
  }
```

with:

```ts
  // Stores one connection's batch in the caller's transaction (OutboxStore.accept: a savepoint inside it).
  store(node: string, streamId: string, events: HookEvent[]): Stored {
    const route = (e: HookEvent) => this.#subscribers.filter(s => s.paths.includes(e.path)).map(s => s.name);
    const r = this.#store.accept(node, streamId, events, route, { now: this.#now(), cap: this.#cap });
    return {
      seq: r.seq,
      after: () => {
        for (const name of this.#overflowing) if (this.#store.pendingCount(name) < this.#cap) this.#overflowing.delete(name);
        for (const [name, over] of r.overflow) {
          if (over.deadLettered === 0 || this.#overflowing.has(name)) continue;
          this.#overflowing.add(name);
          this.#audit.alert("backlog_full", node, { subscriber: name, cap: this.#cap, droppedProgress: over.dropped, deadLettered: over.deadLettered });
        }
        for (const [path, n] of r.unrouted) {
          if (!(SCRIPT_PATHS as readonly string[]).includes(path) || this.#unroutedAlerted.has(path)) continue;
          this.#audit.alert("unrouted_hook", node, { path, events: n });
          this.#unroutedAlerted.add(path);
        }
        if (r.stored > 0) this.#onStored();
      },
    };
  }

  // One batch stored and committed on its own (synced, when the intake has fleet.db's transactions), then announced.
  accept(node: string, streamId: string, events: HookEvent[]): number {
    const r = this.#tx ? this.#tx.synced(() => this.store(node, streamId, events)) : this.store(node, streamId, events);
    r.after();
    return r.seq;
  }
```

Create `apps/fleet/src/application/intake-window.ts`:

```ts
// The intake window (fleet clients spec §6; issue #21): hook events from every agent connection that arrive within
// LIMITS.intakeWindowMs (25 ms) of the first one share one transaction, synced to the disk once (fleet core §16.4: the
// node deletes an event once the fleet acknowledged it). Only after that commit is each connection acknowledged its own
// stream's mark. The window opens at the first event and closes 25 ms later whatever follows, so a steady stream is
// committed at least every 25 ms; the events of one event-loop turn always fall into one window. With windowMs 0 the
// window is one event-loop turn (setImmediate), as the fleet committed before this change.
// Each connection's events are stored in a savepoint of their own: one that fails (fleet.db refuses its rows) is
// rolled back alone and that connection is told (`failed`, it closes 1011 and the node replays), while the others
// commit. A commit that fails as a whole (its sync: a full or failing disk) acknowledges no one. What each stored batch
// announces (alerts, the delivery worker's kick, lane events) runs after the commit, never before.
// A connection the fleet closes (a revoked node, a replaced connection) cancels its events not yet committed; one the
// node closes keeps them: they are stored at the window's end and acknowledged to no one (the node replays them, and
// the stream's mark skips them).
import { LIMITS, type HookEvent } from "@morndo/protocol";
import type { Logger } from "../adapters/log.ts";
import type { Stored } from "./hook-intake.ts";
import type { HookSink, IntakeConn, IntakeHandle, Transactions } from "./hook-sink.ts";

export type Intake = {
  known(node: string, streamId: string): { seq: number; known: boolean };
  store(node: string, streamId: string, events: HookEvent[]): Stored;
};
type Group = { conn: IntakeConn; events: HookEvent[] };
type Result = ({ ok: true } & Stored) | { ok: false; error: unknown };

export class IntakeWindow implements HookSink {
  #intake: Intake;
  #tx: Transactions;
  #log: Logger;
  #windowMs: number;
  #open = new Map<IntakeHandle, Group>();               // each connection's events, in the order they came
  #timer: { cancel(): void } | null = null;

  constructor(p: { intake: Intake; tx: Transactions; log: Logger; windowMs?: number }) {
    this.#intake = p.intake;
    this.#tx = p.tx;
    this.#log = p.log;
    this.#windowMs = p.windowMs ?? LIMITS.intakeWindowMs;
  }

  known(node: string, streamId: string): { seq: number; known: boolean } { return this.#intake.known(node, streamId); }

  open(conn: IntakeConn): IntakeHandle {
    const handle: IntakeHandle = {
      add: e => {
        const g = this.#open.get(handle);
        if (g) g.events.push(e);
        else this.#open.set(handle, { conn, events: [e] });
        this.#arm();
      },
      cancel: () => { this.#open.delete(handle); },
    };
    return handle;
  }

  #arm(): void {
    if (this.#timer !== null) return;
    if (this.#windowMs > 0) {
      const t = setTimeout(() => this.flush(), this.#windowMs);
      this.#timer = { cancel: () => clearTimeout(t) };
    } else {
      const t = setImmediate(() => this.flush());
      this.#timer = { cancel: () => clearImmediate(t) };
    }
  }

  // Commits what the window holds now (the timer's end, or the service stopping), then acknowledges.
  flush(): void {
    this.#timer?.cancel();
    this.#timer = null;
    const groups = [...this.#open.values()];
    this.#open.clear();
    if (groups.length === 0) return;
    const results: Result[] = [];
    try {
      this.#tx.synced(() => {
        for (const g of groups) {
          try {
            const stored = this.#tx.savepoint(() => this.#intake.store(g.conn.node, g.conn.streamId, g.events));
            results.push({ ok: true, ...stored });
          } catch (error) { results.push({ ok: false, error }); }
        }
      });
    } catch (error) {
      const n = groups.reduce((sum, g) => sum + g.events.length, 0);
      this.#log.error(`hook intake: committing ${n} events of ${groups.length} connections failed (fleet.db full, or its disk failing?); none acknowledged`, error);
      for (const g of groups) this.#safely(() => g.conn.failed(error));
      return;
    }
    groups.forEach((g, i) => {
      const r = results[i];
      if (!r) return;
      if (!r.ok) { this.#safely(() => g.conn.failed(r.error)); return; }
      this.#safely(r.after);
      this.#safely(() => g.conn.acked(r.seq));
    });
  }

  // The service stops: what the window holds is stored (and acknowledged to the connections still open).
  stop(): void { this.flush(); }

  #safely(f: () => void): void {
    try { f(); } catch (e) { this.#log.error("hook intake: after a commit, announcing it failed", e); }
  }
}
```

Each agent connection takes a handle when it goes live, adds its hook events to it, and cancels it when the fleet closes
the connection. In `apps/fleet/src/adapters/agent-session.ts`, replace:

```ts
// Once live: results go to the requests, inventory and health to the connection registry (rate limited per node),
// hook events to the hook sink in batches, acknowledged after their commit. Hook events are exempt from the rate
// limit: the agent's replay window paces them (spec 5.4).
```

with:

```ts
// Once live: results go to the requests, inventory and health to the connection registry (rate limited per node),
// hook events to the hook sink (the intake window), each acknowledged once the commit that holds it is synced to the
// disk. Hook events are exempt from the rate limit: the agent's replay window paces them (spec 5.4).
```

Then replace:

```ts
  type FleetMessage, type HookEvent,
} from "@morndo/protocol";
```

with:

```ts
  type FleetMessage,
} from "@morndo/protocol";
```

Then replace:

```ts
import type { HookSink } from "../application/hook-sink.ts";
```

with:

```ts
import type { HookSink, IntakeHandle } from "../application/hook-sink.ts";
```

Then replace:

```ts
  let state: State = { kind: "new" };
  let batch: HookEvent[] = [];
  let flushQueued = false;
  let closing = false;
```

with:

```ts
  let state: State = { kind: "new" };
  let intake: IntakeHandle | null = null;                // the intake's handle for this connection's hook events, once live
  let closing = false;
```

Then replace:

```ts
  const closeFromFleet = (code: number, reason: string) => {
    closing = true;
    state = { kind: "done" };
    batch = [];
    closeWithGrace(code, reason);
  };
```

with:

```ts
  const closeFromFleet = (code: number, reason: string) => {
    closing = true;
    state = { kind: "done" };
    intake?.cancel();                                    // its events not yet committed are dropped, never acknowledged
    intake = null;
    closeWithGrace(code, reason);
  };
```

Then replace the `flush` function:

```ts
  // Stores the batch (one transaction), then acknowledges the highest accepted seq if the connection is still ours.
  const flush = () => {
    flushQueued = false;
    if (state.kind !== "live" && state.kind !== "done") return;
    const events = batch;
    batch = [];
    if (events.length === 0) return;
    const first = events[0];
    if (!first) return;
    try {
      const seq = d.hooks.accept(first.node, first.streamId, events);
      if (state.kind === "live") send({ v: 1, t: "ack", streamId: first.streamId, seq });
    } catch (e) {
      d.log.error(`node ${first.node}: storing ${events.length} hook events failed; not acknowledged`, e);
      if (state.kind === "live") close(1011, "internal error");
    }
  };
```

with:

```ts
  // The intake acknowledges the highest accepted seq once its commit is on the disk, if the connection is still live.
  const openIntake = (node: string, streamId: string): IntakeHandle => d.hooks.open({
    node, streamId,
    acked: seq => { if (state.kind === "live") send({ v: 1, t: "ack", streamId, seq }); },
    failed: e => {
      d.log.error(`node ${node}: storing hook events failed; not acknowledged`, e);
      if (state.kind === "live") close(1011, "internal error");
    },
  });
```

Then replace, in the admission's welcome:

```ts
          state = { kind: "live", node: hello.node, instanceId: hello.instanceId, streamId: hello.streamId };
```

with:

```ts
          state = { kind: "live", node: hello.node, instanceId: hello.instanceId, streamId: hello.streamId };
          intake = openIntake(hello.node, hello.streamId);
```

Then replace, in `ev.hook`:

```ts
        batch.push(m.event);
        if (!flushQueued) { flushQueued = true; setImmediate(flush); }
        return;
```

with:

```ts
        intake?.add(m.event);
        return;
```

and in the close handler:

```ts
    state = { kind: "done" };
    flush();                                                          // events received are stored, unacknowledged
    if (live) d.connections.closed(live.node, peer);
```

with:

```ts
    state = { kind: "done" };                                         // events received are stored, unacknowledged
    if (live) d.connections.closed(live.node, peer);
```

The close handler no longer flushes: what the node sent is already in the window, which stores it at its end and
acknowledges it to no one (the node replays it, and the stream's mark skips it).

In `apps/fleet/src/serve.ts`, replace:

```ts
import { openFleetDb } from "./adapters/db.ts";
```

with:

```ts
import { fleetTransactions, openFleetDb } from "./adapters/db.ts";
```

Then replace:

```ts
import { HookIntake, unsubscribedScriptPaths } from "./application/hook-intake.ts";
```

with:

```ts
import { HookIntake, unsubscribedScriptPaths } from "./application/hook-intake.ts";
import { IntakeWindow } from "./application/intake-window.ts";
```

Then replace:

```ts
  resultSlackMs?: number; instancePongMs?: number; eventsBufferBytes?: number;
```

with:

```ts
  resultSlackMs?: number; instancePongMs?: number; eventsBufferBytes?: number; intakeWindowMs?: number;
```

Then replace:

```ts
  connections: Connections; lanes: LaneRegistry; router: Router; outbox: OutboxStore; delivery: DeliveryWorker; agentPort: number;
```

with:

```ts
  connections: Connections; lanes: LaneRegistry; router: Router; outbox: OutboxStore; delivery: DeliveryWorker; intake: IntakeWindow; agentPort: number;
```

Then replace:

```ts
  const hooks = new HookIntake({
    store: outbox, subscribers: config.subscribers, audit, now, onStored: () => delivery.kick(),
    ...(o.hookBacklog === undefined ? {} : { cap: o.hookBacklog }),
  });
  const agents = startAgentEndpoint({
    host: config.listen.host, port: config.listen.port, deps: { connections, nodes, audit, fleetKey: key, hooks, log },
```

with:

```ts
  const tx = fleetTransactions(db);
  const hooks = new HookIntake({
    store: outbox, subscribers: config.subscribers, audit, now, onStored: () => delivery.kick(), tx,
    ...(o.hookBacklog === undefined ? {} : { cap: o.hookBacklog }),
  });
  const intake = new IntakeWindow({ intake: hooks, tx, log, ...(o.intakeWindowMs === undefined ? {} : { windowMs: o.intakeWindowMs }) });
  const agents = startAgentEndpoint({
    host: config.listen.host, port: config.listen.port, deps: { connections, nodes, audit, fleetKey: key, hooks: intake, log },
```

Then replace:

```ts
  } catch (e) {
    await agents.close();
    db.close();
    throw e;
  }
```

with:

```ts
  } catch (e) {
    await agents.close();
    intake.stop();
    db.close();
    throw e;
  }
```

Then replace:

```ts
    config, db, key, nodes, audit, events, connections, lanes, router, outbox, delivery, agentPort: agents.port(),
```

with:

```ts
    config, db, key, nodes, audit, events, connections, lanes, router, outbox, delivery, intake, agentPort: agents.port(),
```

and in `close`:

```ts
      await agents.close();
      await delivery.stop();
      db.close();
```

with:

```ts
      await agents.close();
      intake.stop();                                   // events received and not yet committed are stored, unacknowledged
      await delivery.stop();
      db.close();
```

`agent-auth.test.ts` builds an agent endpoint with a hand-made sink; it takes the new port. In
`apps/fleet/test/agent-auth.test.ts`, replace:

```ts
import { CLOSE_GRACE_MS } from "../src/adapters/agent-session.ts";
```

with:

```ts
import { CLOSE_GRACE_MS } from "../src/adapters/agent-session.ts";
import type { HookSink } from "../src/application/hook-sink.ts";
```

and:

```ts
    const hooks = { known: () => ({ seq: 0, known: false }), accept: (_n: string, _s: string, events: HookEvent[]) => { stored.push(...events); return events.at(-1)?.seq ?? 0; } };
```

with:

```ts
    const hooks: HookSink = {
      known: () => ({ seq: 0, known: false }),
      open: conn => ({ add: (e: HookEvent) => { stored.push(e); setImmediate(() => conn.acked(e.seq)); }, cancel: () => {} }),
    };
```

- [ ] **Step 9: Run them and see them pass**

Run: `npx vitest run apps/fleet/test/intake-window.test.ts apps/fleet/test/intake-commits.test.ts`
Expected: PASS (9 tests in 2 files)

Run: `npx vitest run apps/fleet`
Expected: PASS (193 tests in 38 files), the end-to-end hook stream (`hook-stream.test.ts`) through the window included

Run: `npx tsc -p apps/fleet && npx oxlint apps/fleet`
Expected: exit 0, nothing printed by either

- [ ] **Step 10: Commit**

```bash
git add apps/fleet/src/application/hook-sink.ts apps/fleet/src/application/hook-intake.ts apps/fleet/src/application/intake-window.ts apps/fleet/src/adapters/db.ts apps/fleet/src/adapters/agent-session.ts apps/fleet/src/serve.ts apps/fleet/test/intake-window.test.ts apps/fleet/test/intake-commits.test.ts apps/fleet/test/agent-auth.test.ts
git commit -m "feat(fleet): hook events within 25 ms share one synced intake commit"
```

- [ ] **Step 11: Add this task's negative controls to `scripts/negative-controls.ts`**

Each entry removes or breaks one guard of this task and names the tests that must then fail (fleet core §12.1). Ids are
`fc<task>-…`, as the agent part's: the fleet core's fleet tasks were 10 to 13, so `t10-…` is taken.

In `scripts/negative-controls.ts`, insert this task's entries at the end of `CONTROLS`, before its closing `];` (the line before `// ---- the runner`), after whatever entries earlier tasks and lanes added there:

```ts
  // ---- fleet clients, Tasks 7-10: the fleet (docs/design/fleet-clients/plan/03-fleet.md). Ids "fc<task>-…": the fleet
  // core's fleet tasks were 10-13, so "t10-…" is taken.
  { id: "fc7-fleet-normal", task: "fc7", file: "apps/fleet/src/adapters/db.ts",
    find: "    db.pragma(\"synchronous = NORMAL\");\n    db.pragma(\"fullfsync = ON\");",
    replace: "    db.pragma(\"synchronous = FULL\");\n    db.pragma(\"fullfsync = ON\");",
    run: ["apps/fleet/test/db-sync.test.ts"], expect: "expected 2 to be 1" },
  { id: "fc7-fleet-fullfsync", task: "fc7", file: "apps/fleet/src/adapters/db.ts",
    find: "    db.pragma(\"fullfsync = ON\");\n",
    replace: "",
    run: ["apps/fleet/test/db-sync.test.ts"], expect: "to be 1" },
  { id: "fc7-synced-full", task: "fc7", file: "apps/fleet/src/adapters/db.ts",
    find: "  db.pragma(\"synchronous = FULL\");\n  try { return transaction(); }",
    replace: "  try { return transaction(); }",
    run: ["apps/fleet/test/db-sync.test.ts"], expect: "to deeply equal" },
  { id: "fc7-synced-not-nested", task: "fc7", file: "apps/fleet/src/adapters/db.ts",
    find: "  if (db.inTransaction) throw new Error(\"synced() runs its own transaction; it can't be nested in another\");\n",
    replace: "",
    run: ["apps/fleet/test/db-sync.test.ts"], expect: "can't be nested" },
  { id: "fc7-join-synced", task: "fc7", file: "apps/fleet/src/adapters/nodes-store.ts",
    find: "    return synced(this.#db, () => this.#db.transaction((): Redeemed => {",
    replace: "    return ((f: () => Redeemed) => f())(() => this.#db.transaction((): Redeemed => {",
    run: ["apps/fleet/test/db-sync.test.ts"], expect: "to deeply equal" },
  { id: "fc7-revoke-synced", task: "fc7", file: "apps/fleet/src/adapters/nodes-store.ts",
    find: "    return synced(this.#db, () => this.#db.transaction(() => {",
    replace: "    return ((f: () => boolean) => f())(() => this.#db.transaction(() => {",
    run: ["apps/fleet/test/db-sync.test.ts"], expect: "to deeply equal" },
  { id: "fc7-epoch-synced", task: "fc7", file: "apps/fleet/src/adapters/nodes-store.ts",
    find: "    const r = synced(this.#db, () => this.#db.prepare(",
    replace: "    const r = ((f: () => unknown) => f())(() => this.#db.prepare(",
    run: ["apps/fleet/test/db-sync.test.ts"], expect: "to deeply equal" },
  { id: "fc7-intake-synced", task: "fc7", file: "apps/fleet/src/adapters/db.ts",
    find: "    synced: fn => synced(db, () => db.transaction(fn).immediate()),",
    replace: "    synced: fn => db.transaction(fn).immediate(),",
    run: ["apps/fleet/test/intake-window.test.ts"], expect: "to deeply equal" },
  { id: "fc7-intake-window", task: "fc7", file: "apps/fleet/src/application/intake-window.ts",
    find: "    this.#windowMs = p.windowMs ?? LIMITS.intakeWindowMs;",
    replace: "    this.#windowMs = 0;",
    run: ["apps/fleet/test/intake-window.test.ts"], expect: "closes 25 ms after its first event" },
  { id: "fc7-intake-cancel", task: "fc7", file: "apps/fleet/src/application/intake-window.ts",
    find: "      cancel: () => { this.#open.delete(handle); },",
    replace: "      cancel: () => {},",
    run: ["apps/fleet/test/intake-window.test.ts"], expect: "acked pc/s1:1" },
  { id: "fc7-ack-after-commit", task: "fc7", file: "apps/fleet/src/application/intake-window.ts",
    find: "            results.push({ ok: true, ...stored });",
    replace: "            results.push({ ok: true, ...stored });\n            g.conn.acked(stored.seq);",
    run: ["apps/fleet/test/intake-window.test.ts"], expect: "0 committed" },
  { id: "fc7-intake-savepoint", task: "fc7", file: "apps/fleet/src/application/intake-window.ts",
    find: "            const stored = this.#tx.savepoint(() => this.#intake.store(g.conn.node, g.conn.streamId, g.events));",
    replace: "            const stored = this.#intake.store(g.conn.node, g.conn.streamId, g.events);",
    run: ["apps/fleet/test/intake-window.test.ts"], expect: "pc/bad:1" },
  { id: "fc7-session-cancel", task: "fc7", file: "apps/fleet/src/adapters/agent-session.ts",
    find: "    intake?.cancel();                                    // its events not yet committed are dropped, never acknowledged\n",
    replace: "",
    run: ["apps/fleet/test/intake-commits.test.ts"], expect: "pc:2" },
```

Run: `node scripts/negative-controls.ts --check`
Expected: exit 0; an `ok` line for each entry, among them `ok    fc7-session-cancel: found 1 time in apps/fleet/src/adapters/agent-session.ts`

- [ ] **Step 12: Commit**

```bash
git add scripts/negative-controls.ts
git commit -m "test(fleet): negative controls for the commit rule and the intake window"
```

- [ ] **Step 13: Run the controls (the runner tests the code at HEAD, so after the commit)**

Run: `node scripts/negative-controls.ts --only fc7-fleet-normal --only fc7-fleet-fullfsync --only fc7-synced-full --only fc7-synced-not-nested --only fc7-join-synced --only fc7-revoke-synced --only fc7-epoch-synced --only fc7-intake-synced --only fc7-intake-window --only fc7-intake-cancel --only fc7-ack-after-commit --only fc7-intake-savepoint --only fc7-session-cancel`
Expected: `13/13 controls bit; still pass 0, broke 0, timed out 0, skipped 0` (about a minute: one worktree, one `npm ci --offline`)

---

### Task 8: Fleet: delivery routes, sticky names, the mirror, `delivery_waiting` alerts

The fleet's part of the delivery queue (spec §4.6, §8): `POST /v1/deliveries` routes a delivery to the node of its lane
and sends `lane.deliver`; the fleet mirrors each delivery's latest state (`lane_deliveries`), answers `GET` and the list
from it, cancels through the node that stored it, publishes each change as `delivery` on `/v1/events`, raises
`delivery_waiting` at 2, 15 and 60 minutes, remembers the node of each sticky name (`sticky_lanes`), and lists the sticky
names in `GET /v1/caps` (Review Focus 5). It also routes the ops clients use through `POST /v1/op` (spec §8):
`pane.capture` by lane, as a bulk op; `lane.stop` with a deadline that covers its "exit" wait.

**Routing** (`application/deliveries.ts`), in this order:
1. An id the mirror knows goes to the node that stored it. That node answers the delivery's state, or `id_conflict` for
   other content, so a retry after a lane moved never queues a second delivery on another node.
2. A worker ID goes to its node, as `{ workerId }`.
3. A lane name through the lane registry: in conflict, `lane_conflict`; found, its node, as `{ lane, sticky }` (`sticky`:
   the name is in `stickyLanes`). The node binds a non-sticky name to the lane's session itself (§4.1).
4. A sticky name the registry doesn't hold (its window is gone: a manager restarting) goes to the node that last reported
   it (`sticky_lanes`), where it waits (`no_pane`). Any other name: `no_pane`. `sticky_lanes` is in `fleet.db`, so a
   fleet restart keeps it (ruling 60; tested with the fleet reopened on the same database).

A node not online answers `node_offline` (`Requests`, as for every op). All of these are refused with `executed: "no"`,
and nothing is sent. `POST /v1/op` refuses `lane.deliver` and `delivery.cancel` (400 `bad_args`, "use /v1/deliveries";
ruling 4), so every delivery is routed, mirrored and audited here. `lane.deliver` and `delivery.cancel` count as side effects (`SIDE_EFFECT_OPS`): an answer lost after
sending is `uncertain`, never `node_offline`.

**The mirror.** `ev.delivery`'s latest state wins (one connection's messages arrive in order). An op's answer may be
older than an event handled before it: both can arrive in one read of the socket, and the answer's continuation runs
after the event's handler. So an answer only fills a row the mirror lacks or brings a final state, and a final state is
never replaced. `stale` while the node isn't online. `ev.delivery` is exempt from the per-node rate limit: after every
reconnect a node sends each open delivery at once (§4.4). One that names another node closes the connection 1008, as a
hook for another node does.

**`delivery_waiting`** at 2, 15 and 60 minutes after `queuedAt` (the node's clock: an offset over 2 s is a
`clock_offset` alert already), once each, counted in the row (`alerted`) so a restart doesn't raise one again; a scan
every 10 s; a stale row waits until its node reports; a scan that finds several thresholds crossed raises the highest.
Its detail (ruling 25): `{ id, lane | workerId, state, reason, minutes }`.

**The status of an answer** (reconciliation ruling 3) is the mapping `POST /v1/op` uses: 400 (`bad_args`) for a body
that doesn't fit, `lane.deliver`'s own rules included (an id without its client's name, over 200 characters or ending in
`#` and digits; a text of 0 or over 8000 characters; a `ttlMs` over 7 days), 415 not JSON, 413 over the limit, each
`{ ok: false, error }`; 200 for every outcome after that, a refusal included (`{ ok: false, error }`). An id the fleet
doesn't know is 404 `{ error: "no_such_delivery" }`, for `GET /v1/deliveries/<id>` and its cancel alike.

**Audit**, never the text: `delivery.post` and `delivery.cancel` (`{ id, target, client, outcome }`), and each
delivery's first final state (`delivery.final`, `{ id, state, why? }`).

**Files:**
- Modify: `apps/fleet/src/config.ts` (`stickyLanes`)
- Create: `apps/fleet/src/adapters/lane-deliveries-store.ts`, `apps/fleet/src/adapters/sticky-lanes-store.ts`,
  `apps/fleet/src/adapters/delivery-body.ts`, `apps/fleet/src/application/deliveries.ts`
- Modify: `apps/fleet/src/application/events.ts` (`delivery`), `apps/fleet/src/application/requests.ts`
  (`SIDE_EFFECT_OPS`, `BULK_OPS`), `apps/fleet/src/application/router.ts` (`pane.capture`, `lane.stop`'s deadline),
  `apps/fleet/src/adapters/client-api.ts` (the routes, caps), `apps/fleet/src/adapters/agent-session.ts` (`ev.delivery`),
  `apps/fleet/src/serve.ts`
- Test: `apps/fleet/test/config.test.ts`, `apps/fleet/test/helpers/fleet.ts`, `apps/fleet/test/helpers/fake-agent.ts`
  (`delivery()`), `apps/fleet/test/helpers/node-queue.ts`, `apps/fleet/test/deliveries.test.ts`,
  `apps/fleet/test/delivery-mirror.test.ts`, `apps/fleet/test/op-routing-clients.test.ts`, `apps/fleet/test/client-api.test.ts`
  and `apps/fleet/test/socket-dir.test.ts` (caps), `apps/fleet/test/agent-auth.test.ts` (the session's new dependency)
- Modify: `test/fleet-harness.ts` (its `FleetConfig` literal gains `stickyLanes`; Task 16 later replaces the literal)
- Modify: `scripts/negative-controls.ts` (19 entries)

**Interfaces:**
- Consumes:
  - Task 1 (`@morndo/protocol`): `type Delivery`, `DeliveryState`, `DeliveryTarget`, `OpArgs["lane.deliver"]`,
    `OpResult["lane.deliver"]`, `OpResult["delivery.cancel"]`, `OP_ARGS["lane.deliver"]` (the id's, the text's and
    `ttlMs`'s limits are its), `EvDelivery` in `AgentMessage`, error codes `id_conflict`, `no_session`, `already_typed`,
    `AlertKind` `delivery_waiting`, `LIMITS.deliveryAlertMs`, `LIMITS.deliveryKeepMs`, `LIMITS.laneStopWaitMs`,
    `LIMITS.captureMaxBytes`, `parseWorkerId`; and what Task 1 left in `apps/fleet` to keep it compiling (01-foundation.md,
    Step 8): the `ev.delivery` case in `agent-session.ts`, the new ops in `op-body.ts`'s `OPS`, `PATHS` without `/lane`,
    and `FakeAgent`'s `validResult` and `inventory`.
  - Task 7: `lane_deliveries`, `sticky_lanes`; `Fleet`.
  - Agent (Tasks 4 to 6), over the protocol only: `lane.deliver` answers `{ delivery }` once stored; `delivery.cancel`
    answers `{ delivery }` or `already_typed`; `ev.delivery` on every change and after every reconnect.
- Produces:
  - Client API (plan.md, "Client API routes"): `POST /v1/deliveries`, `GET /v1/deliveries/<id>`, `GET
    /v1/deliveries?lane=&state=`, `POST /v1/deliveries/<id>/cancel`, `{ t: "delivery", node, body: Delivery & { stale } }`
    on `/v1/events`, `GET /v1/caps` → `{ api, stickyLanes }`.
  - `config.ts`: `FleetConfig.stickyLanes: string[]` (default `["manager"]`).
  - `application/deliveries.ts`: `type DeliveryRequest = { id; text; ttlMs? } & ({ lane } | { workerId })`, `type Answer =
    { ok: true; delivery } | { ok: false; error: OpError }`, `class Deliveries` with `post(req, client): Promise<Answer>`,
    `cancel(id, client): Promise<Answer | null>`, `get(id)`, `list(q)`, `fromNode(node, d)`, `inventory(node, panes)`,
    `scanAlerts()`, `prune()`, `stickyLanes`, `start()`, `stop()` (Task 9 posts lane-event batches through `post`).
  - `serve.ts`: `Fleet.deliveries`.
  - Test helpers: `FakeAgent.delivery(d)`; `test/helpers/node-queue.ts`: `nodeQueue(agent)`, `deliveryOf(node, id, over?)`, `T0`.

- [ ] **Step 1: Write the failing config test for `stickyLanes`**

In `apps/fleet/test/config.test.ts`, replace:

```ts
      subscribers: [],
    });
```

with:

```ts
      subscribers: [],
      stickyLanes: ["manager"],
    });
```

Then replace:

```ts
  it("refuses a file that doesn't fit, naming the setting", () => {
```

with:

```ts
  it("takes the sticky lane names from the file, each once; none at all is allowed", () => {
    for (const [stickyLanes, expected] of [[["manager", "ops lead", "manager"], ["manager", "ops lead"]], [[], []]] as const) {
      const { home, env } = withFile({ stickyLanes });
      expect(loadConfig({ env, home }).stickyLanes).toEqual(expected);
    }
  });

  it("refuses a file that doesn't fit, naming the setting", () => {
```

and add three refusals: replace

```ts
      [{ subscribers: [{ name: "a", url: "http://x/", paths: ["/cc"] }, { name: "a", url: "http://y/", paths: ["/cc"] }] }, /used twice/],
```

with:

```ts
      [{ subscribers: [{ name: "a", url: "http://x/", paths: ["/cc"] }, { name: "a", url: "http://y/", paths: ["/cc"] }] }, /used twice/],
      [{ stickyLanes: "manager" }, /stickyLanes must be a list of lane names/],
      [{ stickyLanes: [""] }, /stickyLanes must be a list of lane names/],
      [{ stickyLanes: ["man\nager"] }, /stickyLanes must be a list of lane names/],
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run apps/fleet/test/config.test.ts`
Expected: FAIL, 3 of 6: the defaults lack `stickyLanes`, the file's are ignored, and `["stickyLanes","manager"]` is refused as an unknown setting instead (`/stickyLanes must be a list of lane names/`)

- [ ] **Step 3: Implement `stickyLanes`**

In `apps/fleet/src/config.ts`, replace:

```ts
// this machine (fleetUrlOk), so no proof or op ever crosses a network in clear text.
import
```

with:

```ts
// this machine (fleetUrlOk), so no proof or op ever crosses a network in clear text.
// `stickyLanes` (fleet clients spec §4.1, §4.6): lane names a delivery follows wherever their node runs them; while such a
// name's window is gone (the manager restarting), a delivery still goes to the node that last reported it.
import
```

Then replace:

```ts
  subscribers: Subscriber[];                  // the hook bus's static subscribers
};
```

with:

```ts
  subscribers: Subscriber[];                  // the hook bus's static subscribers
  stickyLanes: string[];                      // lane names deliveries follow across restarts (spec §4.6)
};
```

Then replace:

```ts
const KEYS = new Set(["listen", "socketPath", "dbPath", "keyPath", "publicUrl", "subscribers"]);
```

with:

```ts
const KEYS = new Set(["listen", "socketPath", "dbPath", "keyPath", "publicUrl", "subscribers", "stickyLanes"]);
// A lane name as tmux reports it (the protocol's window name): 1 to 200 characters, none a control character.
const LANE_NAME = /^[^\p{Cc}]{1,200}$/u;
```

Then replace:

```ts
    subscribers: [],
  };
}
```

with:

```ts
    subscribers: [],
    stickyLanes: ["manager"],
  };
}
```

Then replace:

```ts
// The file's settings over the defaults. Throws ConfigError for a file that isn't JSON or doesn't fit.
```

with:

```ts
function laneNames(v: unknown, name: string): string[] {
  if (!Array.isArray(v) || !v.every(n => typeof n === "string" && LANE_NAME.test(n))) {
    throw new ConfigError(`${name} must be a list of lane names (1 to 200 characters, no control characters)`);
  }
  return [...new Set(v as string[])];
}

// The file's settings over the defaults. Throws ConfigError for a file that isn't JSON or doesn't fit.
```

Then replace:

```ts
    subscribers: raw.subscribers === undefined ? base.subscribers : subscribers(raw.subscribers),
  };
```

with:

```ts
    subscribers: raw.subscribers === undefined ? base.subscribers : subscribers(raw.subscribers),
    stickyLanes: raw.stickyLanes === undefined ? base.stickyLanes : laneNames(raw.stickyLanes, "stickyLanes"),
  };
```

The tests' fleet and the drills' harness build a whole `FleetConfig`. In `apps/fleet/test/helpers/fleet.ts`, replace:

```ts
    keyPath: join(dir, "key.pem"), publicUrl: "ws://127.0.0.1:8791/agent", subscribers: [], ...over,
```

with:

```ts
    keyPath: join(dir, "key.pem"), publicUrl: "ws://127.0.0.1:8791/agent", subscribers: [], stickyLanes: ["manager"], ...over,
```

In `test/fleet-harness.ts` (`startFleet`), replace:

```ts
    publicUrl: `ws://127.0.0.1:${port}/agent`, subscribers: o.subscribers ?? [],
  };
```

with:

```ts
    publicUrl: `ws://127.0.0.1:${port}/agent`, subscribers: o.subscribers ?? [], stickyLanes: ["manager"],
  };
```

- [ ] **Step 4: Run it and see it pass**

Run: `npx vitest run apps/fleet/test/config.test.ts`
Expected: PASS (6 tests)

Run: `npx tsc -p apps/fleet && npx tsc -p tsconfig.tests.json`
Expected: exit 0, nothing printed

- [ ] **Step 5: Commit**

```bash
git add apps/fleet/src/config.ts apps/fleet/test/config.test.ts apps/fleet/test/helpers/fleet.ts test/fleet-harness.ts
git commit -m "feat(fleet): sticky lane names in the fleet's config"
```

- [ ] **Step 6: Write the failing tests for deliveries**

A fake agent answers `lane.deliver` and `delivery.cancel` the way a node's queue would (`helpers/node-queue.ts`: stored
`queued` on the node's clock; the same id answers what is stored; a typed delivery refuses `already_typed`), and sends
`ev.delivery` with a new `FakeAgent.delivery()`.

Create `apps/fleet/test/helpers/node-queue.ts`:

```ts
// A node's delivery queue as a fake agent answers it (fleet clients spec §4.3; the real one is the agent's, Tasks 4 to 6):
// lane.deliver stores a delivery `queued` on the node's clock and answers it, the same id again answers what is stored;
// delivery.cancel gives up a queued one and refuses a typed one (already_typed). Every other op gets a minimal valid
// result. `deliveryOf` builds a Delivery for ev.delivery.
import type { Delivery, OpArgs } from "@morndo/protocol";
import { validResult, type FakeAgent } from "./fake-agent.ts";

export const T0 = 1_800_000_000_000;

export const deliveryOf = (node: string, id: string, over: Partial<Delivery> = {}): Delivery =>
  ({ id, node, target: { lane: "api" }, state: "queued", queuedAt: T0, notAfter: T0 + 86_400_000, ...over });

export function nodeQueue(a: FakeAgent, o: { queuedAt?: () => number } = {}): Map<string, Delivery> {
  const stored = new Map<string, Delivery>();
  a.answer = req => {
    if (req.op === "lane.deliver") {
      const args = req.args as OpArgs["lane.deliver"];
      const at = o.queuedAt?.() ?? T0;
      const target = "lane" in args.target ? { lane: args.target.lane } : { workerId: args.target.workerId };
      const d = stored.get(args.id) ?? deliveryOf(a.node, args.id, { target, queuedAt: at, notAfter: at + (args.ttlMs ?? 86_400_000) });
      stored.set(args.id, d);
      return { ok: true, result: { delivery: d } };
    }
    if (req.op === "delivery.cancel") {
      const d = stored.get((req.args as OpArgs["delivery.cancel"]).id);
      if (!d) return { ok: false, error: { code: "bad_args", executed: "no", message: "no such delivery" } };
      if (d.state !== "queued") return { ok: false, error: { code: "already_typed", executed: "no", message: "already typed" } };
      const cancelled: Delivery = { ...d, state: "given_up", why: "cancelled" };
      stored.set(d.id, cancelled);
      return { ok: true, result: { delivery: cancelled } };
    }
    return { ok: true, result: validResult(req.op, a.node) };
  };
  return stored;
}
```

In `apps/fleet/test/helpers/fake-agent.ts`, replace:

```ts
  type FleetMessage, type Health, type HookEvent, type OpError, type OpResult, type Pane,
```

with:

```ts
  type Delivery, type FleetMessage, type Health, type HookEvent, type OpError, type OpResult, type Pane,
```

and, after `inventory` (as Task 1 left it):

```ts
  inventory(panes: (Omit<Pane, "status" | "pid"> & Partial<Pick<Pane, "status" | "pid">>)[]): void { this.send({ v: 1, t: "ev.inventory", panes, invVersion: ++this.invVersion }); }
```

with:

```ts
  inventory(panes: (Omit<Pane, "status" | "pid"> & Partial<Pick<Pane, "status" | "pid">>)[]): void { this.send({ v: 1, t: "ev.inventory", panes, invVersion: ++this.invVersion }); }
  // A delivery's latest state, as the node's queue reports it (fleet clients spec §4.4).
  delivery(d: Delivery): void { this.send({ v: 1, t: "ev.delivery", delivery: d }); }
```

Create `apps/fleet/test/deliveries.test.ts`:

```ts
// Deliveries through the fleet (fleet clients spec §4.6, §8): POST /v1/deliveries routes a lane name through the lane
// registry, a sticky name whose window is gone to the node that last reported it, a worker ID to its node, and a known
// id back to the node that stored it; it sends lane.deliver with { lane, sticky } or { workerId }; lane_conflict,
// no_pane and node_offline are refused and nothing is sent. The answer is mirrored and audited, never the text.
import { describe, expect, it, vi } from "vitest";
import type { Pane } from "@morndo/protocol";
import { startTestFleet, type TestFleet } from "./helpers/fleet.ts";
import type { FakeAgent } from "./helpers/fake-agent.ts";
import { nodeQueue } from "./helpers/node-queue.ts";
import { client } from "./helpers/socket-client.ts";
import { tempDir } from "./helpers/temp.ts";

const W = (node: string, n: number) => `${node}.3fa2c1d0.${n}`;
const pane = (node: string, n: number, window: string): Pane => ({ workerId: W(node, n), window, cwd: "/work", status: "idle", pid: 100 + n });
const post = (fleet: TestFleet, body: unknown, who = "kira") => client(fleet.config.socketPath).raw("/v1/deliveries", {
  method: "POST", headers: { "content-type": "application/json", "x-morndo-client": who }, body: JSON.stringify(body),
}).then(r => ({ status: r.status, body: JSON.parse(r.body.toString()) as Record<string, unknown> }));
const sent = (a: FakeAgent) => a.reqs.filter(r => r.op === "lane.deliver").map(r => r.args);

async function nodeWith(fleet: TestFleet, node: string, windows: string[]): Promise<FakeAgent> {
  const a = await fleet.online(node);
  nodeQueue(a);
  a.inventory(windows.map((w, i) => pane(node, i, w)));
  await vi.waitFor(() => expect(fleet.lanes.list().filter(l => l.node === node).map(l => l.name).sort()).toEqual([...new Set(windows)].sort()));
  return a;
}

describe("POST /v1/deliveries", () => {
  it("sends lane.deliver to the lane's node with { lane, sticky: false }; the answer is mirrored, and audited without the text", async () => {
    const fleet = await startTestFleet();
    const pc = await nodeWith(fleet, "pc", ["api"]);
    const r = await post(fleet, { id: "kira:tap-1", lane: "api", text: "the secret words", ttlMs: 60_000 });
    expect(r).toEqual({ status: 200, body: { ok: true, delivery: expect.objectContaining({ id: "kira:tap-1", node: "pc", state: "queued", target: { lane: "api" } }) } });
    expect(sent(pc)).toEqual([{ id: "kira:tap-1", target: { lane: "api", sticky: false }, text: "the secret words", ttlMs: 60_000 }]);
    expect(await client(fleet.config.socketPath).get(`/v1/deliveries/${encodeURIComponent("kira:tap-1")}`))
      .toEqual({ status: 200, body: { delivery: expect.objectContaining({ id: "kira:tap-1", state: "queued" }), stale: false } });
    expect(fleet.audit.of("delivery.post").map(e => [e.node, e.detail])).toEqual([["pc", { id: "kira:tap-1", target: { lane: "api" }, client: "kira", outcome: "queued" }]]);
    expect(JSON.stringify(fleet.audit.recent(100))).not.toContain("secret");
  });

  it("a sticky name whose window is gone goes to the node that last reported it, as { lane, sticky: true }; another unknown name is no_pane", async () => {
    const fleet = await startTestFleet();
    const pc = await nodeWith(fleet, "pc", ["manager", "api"]);
    pc.inventory([pane("pc", 1, "api")]);                                             // the manager restarts: its window is gone
    await vi.waitFor(() => expect(fleet.lanes.get("manager")).toBeNull());
    expect((await post(fleet, { id: "hub:answer:e1:a1:c1", lane: "manager", text: "yes" })).body).toMatchObject({ ok: true, delivery: { state: "queued" } });
    expect(sent(pc)).toEqual([{ id: "hub:answer:e1:a1:c1", target: { lane: "manager", sticky: true }, text: "yes" }]);
    expect((await post(fleet, { id: "kira:2", lane: "gone-lane", text: "x" })).body)
      .toEqual({ ok: false, error: { code: "no_pane", executed: "no", message: expect.stringContaining("gone-lane") } });
    expect(sent(pc)).toHaveLength(1);                                                 // negative control: no sticky fallback refuses manager too
  });

  it("without stickyLanes the manager is an ordinary name: { sticky: false }, and no_pane once its window is gone", async () => {
    const fleet = await startTestFleet({ config: { stickyLanes: [] } });
    const pc = await nodeWith(fleet, "pc", ["manager"]);
    await post(fleet, { id: "hub:1", lane: "manager", text: "x" });
    expect(sent(pc)).toEqual([{ id: "hub:1", target: { lane: "manager", sticky: false }, text: "x" }]);
    pc.inventory([]);
    await vi.waitFor(() => expect(fleet.lanes.get("manager")).toBeNull());
    expect((await post(fleet, { id: "hub:2", lane: "manager", text: "x" })).body).toMatchObject({ ok: false, error: { code: "no_pane" } });
  });

  it("sticky_lanes follows the node that last reported the name", async () => {
    const fleet = await startTestFleet();
    const pc = await nodeWith(fleet, "pc", ["manager"]);
    pc.inventory([]);
    const mac = await nodeWith(fleet, "mac", ["manager"]);
    mac.inventory([]);
    await vi.waitFor(() => expect(fleet.lanes.get("manager")).toBeNull());
    await post(fleet, { id: "hub:moved", lane: "manager", text: "x" });
    expect([sent(pc).length, sent(mac).length]).toEqual([0, 1]);
  });

  it("a sticky name survives a fleet restart: with fleet.db reopened, it still goes to the node that last had it", async () => {
    const dir = tempDir();
    const before = await startTestFleet({ dir });
    const pc = await nodeWith(before, "pc", ["manager"]);
    await before.close();
    const after = await startTestFleet({ dir });                                      // the same fleet.db, reopened
    const back = after.agent({ node: "pc", key: pc.key, instanceId: pc.instanceId, streamId: pc.streamId });
    expect((await back.connect()).ok).toBe(true);
    nodeQueue(back);
    back.inventory([]);                                                               // the manager restarting: its window is gone
    await vi.waitFor(() => expect(after.lanes.get("manager")).toBeNull());
    expect((await post(after, { id: "hub:after-restart", lane: "manager", text: "yes" })).body).toMatchObject({ ok: true, delivery: { node: "pc" } });
    expect(sent(back)).toEqual([{ id: "hub:after-restart", target: { lane: "manager", sticky: true }, text: "yes" }]);   // negative control: no_pane
    back.inventory([pane("pc", 0, "manager")]);                                      // the same pane, back
    await vi.waitFor(() => expect(after.lanes.get("manager")).toMatchObject({ node: "pc", workerId: W("pc", 0) }));
  });

  it("refuses a name in conflict (lane_conflict) and a node offline (node_offline); neither sends anything", async () => {
    const fleet = await startTestFleet();
    const pc = await nodeWith(fleet, "pc", ["api", "api", "manager"]);
    expect((await post(fleet, { id: "kira:c", lane: "api", text: "x" })).body).toMatchObject({ ok: false, error: { code: "lane_conflict", executed: "no" } });
    await pc.close();
    await vi.waitFor(() => expect(fleet.connections.status("pc")).toBe("offline"));
    expect((await post(fleet, { id: "hub:off", lane: "manager", text: "x" })).body).toMatchObject({ ok: false, error: { code: "node_offline", executed: "no" } });
    expect(sent(pc)).toEqual([]);
  });

  it("a worker ID goes to its node as { workerId }; an id the fleet knows goes back to the node that stored it", async () => {
    const fleet = await startTestFleet();
    const pc = await nodeWith(fleet, "pc", ["api"]);
    await post(fleet, { id: "lanes:w", workerId: W("pc", 0), text: "x" });
    expect(sent(pc)).toEqual([{ id: "lanes:w", target: { workerId: W("pc", 0) }, text: "x" }]);
    await post(fleet, { id: "hub:k", lane: "api", text: "y" });
    pc.inventory([]);                                                                 // the lane moves to another node
    const mac = await nodeWith(fleet, "mac", ["api"]);
    expect((await post(fleet, { id: "hub:k", lane: "api", text: "y" })).body).toMatchObject({ ok: true, delivery: { node: "pc" } });
    expect(sent(pc)).toHaveLength(3);                                                 // negative control: routed by name, mac gets it twice over
    expect(sent(mac)).toEqual([]);
  });

  it("a body that doesn't fit, lane.deliver's own rules included, is 400 bad_args, and not JSON 415; nothing is sent", async () => {
    const fleet = await startTestFleet();
    const pc = await nodeWith(fleet, "pc", ["api"]);
    for (const body of [{}, { id: "k:1", lane: "api", workerId: W("pc", 0), text: "x" }, { id: "k:1", lane: "api", text: "x", expect: {} },
      { id: 1, lane: "api", text: "x" }, { id: "k:1", lane: "api" }, { id: "k:1", lane: "api", text: "x", ttlMs: 1.5 }, { id: "k:1", lane: "", text: "x" }]) {
      expect(await post(fleet, body), JSON.stringify(body)).toMatchObject({ status: 400, body: { ok: false, error: { code: "bad_args", executed: "no" } } });
    }
    for (const body of [{ id: "no-namespace", lane: "api", text: "x" }, { id: `k:${"a".repeat(200)}`, lane: "api", text: "x" },
      { id: "k:1", lane: "api", text: "" }, { id: "k:1", lane: "api", text: "x".repeat(8001) }, { id: "k:1#2", lane: "api", text: "x" }]) {
      expect(await post(fleet, body), JSON.stringify(body).slice(0, 60)).toMatchObject({ status: 400, body: { ok: false, error: { code: "bad_args", executed: "no" } } });
    }
    const r = await client(fleet.config.socketPath).raw("/v1/deliveries", { method: "POST", body: "{}" });
    expect([r.status, JSON.parse(r.body.toString())]).toMatchObject([415, { ok: false, error: { code: "bad_args" } }]);
    expect(sent(pc)).toEqual([]);
  });

  it("POST /v1/op refuses lane.deliver and delivery.cancel: deliveries go through /v1/deliveries", async () => {
    const fleet = await startTestFleet();
    const pc = await nodeWith(fleet, "pc", ["api"]);
    for (const [op, args] of [["lane.deliver", { id: "k:1", target: { lane: "api", sticky: false }, text: "x" }], ["delivery.cancel", { id: "k:1" }]] as const) {
      expect(await client(fleet.config.socketPath).post("/v1/op", { node: "pc", op, args }))
        .toMatchObject({ status: 400, body: { ok: false, error: { code: "bad_args", message: expect.stringContaining("use /v1/deliveries") } } });
    }
    expect(pc.reqs).toEqual([]);
  });

  it("an answer lost after lane.deliver was sent is uncertain (executed maybe), never node_offline", async () => {
    const fleet = await startTestFleet();
    const pc = await nodeWith(fleet, "pc", ["api"]);
    pc.answer = () => "never";
    const answer = post(fleet, { id: "hub:lost", lane: "api", text: "x" });
    await vi.waitFor(() => expect(sent(pc)).toHaveLength(1));
    await fleet.close();
    expect((await answer).body).toMatchObject({ ok: false, error: { code: "uncertain", executed: "maybe" } });
  });
});
```

Create `apps/fleet/test/delivery-mirror.test.ts`:

```ts
// The deliveries' mirror (fleet clients spec §4.4, §4.5, §4.6): ev.delivery's latest state wins; a final state stays; an
// answer never replaces a newer event's state; `stale` while the node is offline; a `delivery` event per change; the
// list by lane and state, the newest of the last 7 days; cancel through the node that stored it; delivery_waiting at
// 2, 15 and 60 minutes, once each, across a restart, never for a final or stale delivery.
import { describe, expect, it, vi } from "vitest";
import { LIMITS, type Delivery } from "@morndo/protocol";
import { startTestFleet, type TestFleet } from "./helpers/fleet.ts";
import { deliveryOf, nodeQueue, T0 } from "./helpers/node-queue.ts";
import { client } from "./helpers/socket-client.ts";
import { tempDir } from "./helpers/temp.ts";

const api = (fleet: TestFleet) => client(fleet.config.socketPath);
const one = (fleet: TestFleet, id: string) => api(fleet).get(`/v1/deliveries/${encodeURIComponent(id)}`);
const stateOf = async (fleet: TestFleet, id: string) => ((await one(fleet, id))?.body as { delivery?: Delivery } | undefined)?.delivery?.state;
const MIN = 60_000;

describe("the deliveries' mirror", () => {
  it("takes each ev.delivery, latest wins; a final state stays; each change is a delivery event", async () => {
    const fleet = await startTestFleet();
    const pc = await fleet.online("pc");
    const events = await api(fleet).events();
    pc.delivery(deliveryOf("pc", "hub:a", { waiting: { reason: "menu_open", since: T0 } }));
    pc.delivery(deliveryOf("pc", "hub:a", { state: "typed", typedAt: T0 + 5, sessionId: "s1" }));
    pc.delivery(deliveryOf("pc", "hub:a", { state: "delivered", typedAt: T0 + 5, deliveredAt: T0 + 9, sessionId: "s1" }));
    pc.delivery(deliveryOf("pc", "hub:a", { state: "typed", typedAt: T0 + 5, sessionId: "s1" }));     // late: never over a final state
    pc.delivery(deliveryOf("pc", "hub:a", { state: "delivered", typedAt: T0 + 5, deliveredAt: T0 + 9, sessionId: "s1" }));   // the same again
    await vi.waitFor(() => expect(events.received.filter(e => e.t === "delivery")).toHaveLength(3));
    await new Promise(r => setTimeout(r, 50));
    expect(events.received.filter(e => e.t === "delivery").map(e => [e.node, (e.body as Delivery & { stale: boolean }).state, (e.body as { stale: boolean }).stale]))
      .toEqual([["pc", "queued", false], ["pc", "typed", false], ["pc", "delivered", false]]);
    expect(await stateOf(fleet, "hub:a")).toBe("delivered");                          // negative control: no final guard leaves "typed"
    expect(fleet.audit.of("delivery.final").map(e => e.detail)).toEqual([{ id: "hub:a", state: "delivered" }]);
    events.close();
  });

  it("marks the mirror stale while the node is offline", async () => {
    const fleet = await startTestFleet();
    const pc = await fleet.online("pc");
    pc.delivery(deliveryOf("pc", "hub:s"));
    await vi.waitFor(async () => expect(await one(fleet, "hub:s")).toMatchObject({ status: 200, body: { stale: false } }));
    await pc.close();
    await vi.waitFor(async () => expect(await one(fleet, "hub:s")).toMatchObject({ status: 200, body: { stale: true } }));
    expect(await api(fleet).get("/v1/deliveries/nothing%3Ahere")).toEqual({ status: 404, body: { error: "no_such_delivery" } });
  });

  it("closes a connection that reports another node's delivery (1008)", async () => {
    const fleet = await startTestFleet();
    const pc = await fleet.online("pc");
    pc.delivery(deliveryOf("mac", "hub:x"));
    expect((await pc.closed).code).toBe(1008);
  });

  it("an answer fills a row the mirror lacks, but never replaces a newer event's state", async () => {
    const fleet = await startTestFleet();
    const pc = await fleet.online("pc");
    nodeQueue(pc);                                                                    // answers the stored state: queued
    pc.inventory([{ workerId: "pc.3fa2c1d0.1", window: "api", cwd: "/w", status: "idle", pid: 1 }]);
    await vi.waitFor(() => expect(fleet.lanes.get("api")).not.toBeNull());
    await api(fleet).post("/v1/deliveries", { id: "kira:r", lane: "api", text: "x" });
    expect(await stateOf(fleet, "kira:r")).toBe("queued");
    pc.delivery(deliveryOf("pc", "kira:r", { state: "typed", typedAt: T0 + 1 }));
    await vi.waitFor(async () => expect(await stateOf(fleet, "kira:r")).toBe("typed"));
    await api(fleet).post("/v1/deliveries", { id: "kira:r", lane: "api", text: "x" });   // a retry: the node answers "queued" (older)
    expect(await stateOf(fleet, "kira:r")).toBe("typed");
  });

  it("lists by lane and state, the newest of the last 7 days, oldest first; a state that isn't one is 400", async () => {
    let now = T0;
    const fleet = await startTestFleet({ now: () => now });
    const pc = await fleet.online("pc");
    pc.delivery(deliveryOf("pc", "hub:old"));
    await vi.waitFor(async () => expect(await stateOf(fleet, "hub:old")).toBe("queued"));
    now += LIMITS.deliveryKeepMs + 1;
    pc.delivery(deliveryOf("pc", "hub:1"));
    pc.delivery(deliveryOf("pc", "hub:2", { target: { lane: "manager" } }));
    pc.delivery(deliveryOf("pc", "hub:3", { target: { lane: "manager" }, state: "given_up", why: "expired" }));
    await vi.waitFor(async () => expect(await stateOf(fleet, "hub:3")).toBe("given_up"));
    const ids = async (q: string) => (((await api(fleet).get(`/v1/deliveries${q}`))?.body as { deliveries?: Delivery[] } | undefined)?.deliveries ?? []).map(d => d.id);
    expect(await ids("")).toEqual(["hub:1", "hub:2", "hub:3"]);                        // hub:old is past 7 days
    expect(await ids("?lane=manager")).toEqual(["hub:2", "hub:3"]);
    expect(await ids("?lane=manager&state=queued")).toEqual(["hub:2"]);
    expect(await api(fleet).get("/v1/deliveries?state=lost")).toMatchObject({ status: 400 });
    expect(fleet.deliveries.prune()).toBe(1);                                         // the hourly prune takes hub:old
  });

  it("cancel goes to the node that stored the delivery; already_typed passes through; an id the fleet doesn't know is 404 no_such_delivery", async () => {
    const fleet = await startTestFleet();
    const pc = await fleet.online("pc");
    const stored = nodeQueue(pc);
    pc.inventory([{ workerId: "pc.3fa2c1d0.1", window: "api", cwd: "/w", status: "idle", pid: 1 }]);
    await vi.waitFor(() => expect(fleet.lanes.get("api")).not.toBeNull());
    await api(fleet).post("/v1/deliveries", { id: "kira:c1", lane: "api", text: "x" });
    await api(fleet).post("/v1/deliveries", { id: "kira:c2", lane: "api", text: "y" });
    const typed = stored.get("kira:c2");
    if (typed) stored.set("kira:c2", { ...typed, state: "typed" });
    expect(await api(fleet).post(`/v1/deliveries/${encodeURIComponent("kira:c1")}/cancel`))
      .toEqual({ status: 200, body: { ok: true, delivery: expect.objectContaining({ state: "given_up", why: "cancelled" }) } });
    expect(await stateOf(fleet, "kira:c1")).toBe("given_up");
    expect(await api(fleet).post(`/v1/deliveries/${encodeURIComponent("kira:c2")}/cancel`)).toMatchObject({ status: 200, body: { ok: false, error: { code: "already_typed" } } });
    expect(await api(fleet).post("/v1/deliveries/kira%3Anever/cancel")).toEqual({ status: 404, body: { error: "no_such_delivery" } });
    expect(pc.reqs.filter(r => r.op === "delivery.cancel").map(r => r.args)).toEqual([{ id: "kira:c1" }, { id: "kira:c2" }]);
    expect(fleet.audit.of("delivery.cancel").map(e => e.detail.outcome)).toEqual(["given_up", "already_typed"]);
  });
});

describe("delivery_waiting", () => {
  it("at 2, 15 and 60 minutes, once each, and not again after a restart; never for a final delivery", async () => {
    let now = T0;
    const dir = tempDir();
    const first = await startTestFleet({ dir, now: () => now });
    const pc = await first.online("pc");
    pc.delivery(deliveryOf("pc", "hub:w", { waiting: { reason: "menu_open", since: T0 } }));
    pc.delivery(deliveryOf("pc", "hub:done", { state: "delivered", deliveredAt: T0 + 1 }));
    await vi.waitFor(async () => expect(await stateOf(first, "hub:done")).toBe("delivered"));
    const alerts = (f: TestFleet) => f.audit.of("alert.delivery_waiting").map(e => [e.node, e.detail.id, e.detail.minutes, e.detail.state, e.detail.reason]);
    now = T0 + 2 * MIN - 1;
    first.deliveries.scanAlerts();
    expect(alerts(first)).toEqual([]);
    now = T0 + 2 * MIN;
    first.deliveries.scanAlerts();
    first.deliveries.scanAlerts();
    expect(alerts(first)).toEqual([["pc", "hub:w", 2, "queued", "menu_open"]]);       // negative control: no `alerted` raises it twice
    expect(first.audit.of("alert.delivery_waiting")[0]?.detail).toEqual({ id: "hub:w", lane: "api", state: "queued", reason: "menu_open", minutes: 2 });
    now = T0 + 15 * MIN;
    first.deliveries.scanAlerts();
    expect(alerts(first).map(a => a[2])).toEqual([2, 15]);
    await first.close();
    const again = await startTestFleet({ dir, now: () => now });                      // a restart: `alerted` is kept in fleet.db
    const back = again.agent({ node: "pc", key: pc.key, instanceId: pc.instanceId, streamId: pc.streamId });
    expect((await back.connect()).ok).toBe(true);
    again.deliveries.scanAlerts();
    expect(alerts(again).map(a => a[2])).toEqual([2, 15]);
    now = T0 + 60 * MIN;
    again.deliveries.scanAlerts();
    expect(alerts(again).map(a => a[2])).toEqual([2, 15, 60]);
  });

  it("skips a stale delivery until its node reports, and raises only the highest threshold a scan finds crossed", async () => {
    let now = T0;
    const fleet = await startTestFleet({ now: () => now });
    const pc = await fleet.online("pc");
    pc.delivery(deliveryOf("pc", "hub:late", { state: "held", typedAt: T0 + 1 }));
    await vi.waitFor(async () => expect(await stateOf(fleet, "hub:late")).toBe("held"));
    await pc.close();
    await vi.waitFor(() => expect(fleet.connections.status("pc")).toBe("offline"));
    now = T0 + 20 * MIN;
    fleet.deliveries.scanAlerts();
    expect(fleet.audit.of("alert.delivery_waiting")).toEqual([]);                    // offline: its state may be old
    const back = fleet.agent({ node: "pc", key: pc.key, instanceId: pc.instanceId, streamId: pc.streamId });
    expect((await back.connect()).ok).toBe(true);
    fleet.deliveries.scanAlerts();
    expect(fleet.audit.of("alert.delivery_waiting").map(e => e.detail.minutes)).toEqual([15]);
  });
});

describe("ev.delivery and the per-node rate limit", () => {
  it("a node replaying 200 delivery states at once after a reconnect is not closed (inventory and health are)", async () => {
    const fleet = await startTestFleet({ agentLimits: { capacity: 20, refillPerSecond: 1 } });
    const pc = await fleet.online("pc");
    for (let i = 0; i < 200; i++) pc.delivery(deliveryOf("pc", `hub:${i}`));
    await vi.waitFor(async () => expect(await stateOf(fleet, "hub:199")).toBe("queued"));
    expect(pc.open).toBe(true);                                                       // negative control: rate limited, closed 1008
  });
});
```

`GET /v1/caps` gains `stickyLanes` (Review Focus 5: the hub compares it with its manager window). In `apps/fleet/test/client-api.test.ts`, replace:

```ts
  it("speaks /v1/ and lists its versions; another version or route is a 404", async () => {
    const fleet = await startTestFleet();
    const api = client(fleet.config.socketPath);
    expect(await api.get("/v1/caps")).toEqual({ status: 200, body: { api: [1] } });
```

with:

```ts
  it("speaks /v1/ and lists its versions and sticky lane names; another version or route is a 404", async () => {
    const fleet = await startTestFleet({ config: { stickyLanes: ["manager", "ops lead"] } });
    const api = client(fleet.config.socketPath);
    expect(await api.get("/v1/caps")).toEqual({ status: 200, body: { api: [1], stickyLanes: ["manager", "ops lead"] } });
```

and in `apps/fleet/test/socket-dir.test.ts`:

```ts
    expect(await client(fleet.config.socketPath).get("/v1/caps")).toEqual({ status: 200, body: { api: [1] } });
```

with:

```ts
    expect(await client(fleet.config.socketPath).get("/v1/caps")).toEqual({ status: 200, body: { api: [1], stickyLanes: ["manager"] } });
```

- [ ] **Step 7: Run them and see them fail**

Run: `npx vitest run apps/fleet/test/deliveries.test.ts apps/fleet/test/delivery-mirror.test.ts apps/fleet/test/client-api.test.ts apps/fleet/test/socket-dir.test.ts`
Expected: FAIL, 21 of 42: every delivery test (`/v1/deliveries` is `404 { error: "no such route" }`, `fleet.deliveries` is undefined, and `ev.delivery` reaches the placeholder case only), and both caps tests (no `stickyLanes`)

- [ ] **Step 8: Implement the stores, the routes, the mirror and the alerts**

Create `apps/fleet/src/adapters/lane-deliveries-store.ts`:

```ts
// The deliveries' mirror (fleet clients spec §4.6): the latest state of each delivery its node reported, in fleet.db's
// lane_deliveries (migration 5), never its text. Not synced (spec §6): a state lost to a power loss comes back with the
// node's next report (ev.delivery after every reconnect). `alerted` counts the delivery_waiting thresholds raised for it.
// The application decides what replaces what (application/deliveries.ts); this only reads and writes rows.
import type Database from "better-sqlite3";
import type { Delivery, DeliveryState } from "@morndo/protocol";

export type DeliveryRow = { id: string; node: string; delivery: Delivery; updatedAt: number; alerted: number };
type Row = { id: string; node: string; body: string; updated_at: number; alerted: number };
const rowOf = (r: Row): DeliveryRow => ({ id: r.id, node: r.node, delivery: JSON.parse(r.body) as Delivery, updatedAt: r.updated_at, alerted: r.alerted });

export class LaneDeliveriesStore {
  #db: Database.Database;
  constructor(db: Database.Database) { this.#db = db; }

  get(id: string): DeliveryRow | null {
    const r = this.#db.prepare("SELECT id, node, body, updated_at, alerted FROM lane_deliveries WHERE id = ?").get(id) as Row | undefined;
    return r ? rowOf(r) : null;
  }

  // `alerted` stays as it is for a row already there.
  upsert(node: string, d: Delivery, at: number): void {
    this.#db.prepare(`INSERT INTO lane_deliveries (id, node, target, state, body, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET node = excluded.node, target = excluded.target, state = excluded.state, body = excluded.body,
        updated_at = excluded.updated_at`).run(d.id, node, JSON.stringify(d.target), d.state, JSON.stringify(d), at);
  }

  // The newest `limit` rows changed at or after `since`, of a lane (its name as the target) and a state when given,
  // oldest first.
  list(o: { since: number; lane?: string; state?: DeliveryState; limit: number }): DeliveryRow[] {
    const rows = this.#db.prepare(`SELECT id, node, body, updated_at, alerted FROM lane_deliveries
      WHERE updated_at >= ? AND (? IS NULL OR json_extract(target, '$.lane') = ?) AND (? IS NULL OR state = ?)
      ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(o.since, o.lane ?? null, o.lane ?? null, o.state ?? null, o.state ?? null, o.limit) as Row[];
    return rows.reverse().map(rowOf);
  }

  // Every delivery still waiting (queued, typed or held) with a delivery_waiting threshold not yet raised.
  open(thresholds: number): DeliveryRow[] {
    return (this.#db.prepare(`SELECT id, node, body, updated_at, alerted FROM lane_deliveries
      WHERE state IN ('queued', 'typed', 'held') AND alerted < ? ORDER BY updated_at`).all(thresholds) as Row[]).map(rowOf);
  }

  setAlerted(id: string, alerted: number): void {
    this.#db.prepare("UPDATE lane_deliveries SET alerted = ? WHERE id = ?").run(alerted, id);
  }

  prune(before: number): number {
    return this.#db.prepare("DELETE FROM lane_deliveries WHERE updated_at < ?").run(before).changes;
  }
}
```

Create `apps/fleet/src/adapters/sticky-lanes-store.ts`:

```ts
// The node that last reported a window of each sticky lane name (fleet clients spec §4.6), in fleet.db's sticky_lanes
// (migration 5). Not synced (spec §6): after a power loss the next inventory writes it again.
import type Database from "better-sqlite3";

export type StickyRow = { name: string; node: string; at: number };

export class StickyLanesStore {
  #db: Database.Database;
  constructor(db: Database.Database) { this.#db = db; }

  get(name: string): StickyRow | null {
    return (this.#db.prepare("SELECT name, node, at FROM sticky_lanes WHERE name = ?").get(name) as StickyRow | undefined) ?? null;
  }

  set(name: string, node: string, at: number): void {
    this.#db.prepare(`INSERT INTO sticky_lanes (name, node, at) VALUES (?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET node = excluded.node, at = excluded.at`).run(name, node, at);
  }
}
```

Create `apps/fleet/src/adapters/delivery-body.ts`:

```ts
// The body of POST /v1/deliveries (fleet clients spec §8; plan Contracts, "Client API routes"): { id, lane | workerId
// (exactly one), text, ttlMs? }, its id, target, text and ttlMs checked against OP_ARGS["lane.deliver"] as the agent will
// (the id namespaced, at most 200 characters, no trailing "#<digits>"; the text 1 to 8000 characters): what doesn't fit
// is a body that doesn't fit, 400 (reconciliation ruling 3). Unknown fields are refused, so a client's typo never routes
// somewhere unintended. A deadline travels as a duration (ttlMs), never as a clock time (Review Focus 3): the node turns
// it into notAfter on its own clock.
import { OP_ARGS, parseBody } from "@morndo/protocol";
import type { DeliveryRequest } from "../application/deliveries.ts";

const FIELDS = new Set(["id", "lane", "workerId", "text", "ttlMs"]);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseDeliveryBody(v: unknown): { ok: true; body: DeliveryRequest } | { ok: false; message: string } {
  const no = (message: string) => ({ ok: false as const, message });
  if (!isObject(v)) return no("the body must be a JSON object");
  const extra = Object.keys(v).filter(k => !FIELDS.has(k));
  if (extra.length) return no(`unknown fields: ${extra.join(", ")}`);
  const targets = (["lane", "workerId"] as const).filter(k => v[k] !== undefined);
  if (targets.length !== 1) return no("name exactly one of lane or workerId");
  const t = targets[0] ?? "lane";
  const value = v[t];
  if (typeof value !== "string" || value === "" || value.length > 1000) return no(`${t} must be a non-empty string`);
  if (typeof v.id !== "string") return no("id must be a string");
  if (typeof v.text !== "string") return no("text must be a string");
  if (v.ttlMs !== undefined && !Number.isInteger(v.ttlMs)) return no("ttlMs must be a whole number of milliseconds");
  const base = { id: v.id, text: v.text, ...(v.ttlMs === undefined ? {} : { ttlMs: v.ttlMs as number }) };
  const target = t === "lane" ? { lane: value, sticky: false } : { workerId: value };
  if (parseBody(OP_ARGS["lane.deliver"], { ...base, target }) === null) return no("an id, a target, a text or a ttlMs that doesn't fit lane.deliver");
  return { ok: true, body: t === "lane" ? { ...base, lane: value } : { ...base, workerId: value } };
}
```

Create `apps/fleet/src/application/deliveries.ts`:

```ts
// Deliveries through the fleet (fleet clients spec §4.6, §8): a client's message to a lane, stored on the lane's node
// (its delivery queue, op lane.deliver) and typed there once the lane can take it. The fleet routes, mirrors and alerts;
// it never keeps the text.
// - Routing. An id the mirror knows goes to the node that stored it, which answers its current state, or id_conflict
//   for other content (a lane that moved to another node never gets the same delivery twice). Otherwise a worker ID goes
//   to its node; a lane name through the lane registry: a name in conflict is refused lane_conflict; a sticky name
//   (config stickyLanes) whose window is gone goes to the node that last reported it (sticky_lanes), where it waits
//   (no_pane); any other unknown name is refused no_pane. The node is sent { lane, sticky } or { workerId }: it binds a
//   non-sticky name to the lane's current session itself (§4.1). A node offline refuses node_offline (Requests): nothing
//   is queued where it can't be stored. All of these are executed: no.
// - The mirror (lane_deliveries): the latest state each node reported, from ev.delivery (latest wins: the messages of one
//   connection arrive in order) and from the answers to lane.deliver and delivery.cancel. An answer can be older than an
//   event processed before it (both may come in one read of the socket), so an answer only fills a row that isn't there
//   yet or brings a final state; and a final state is never replaced by another. `stale` while the node isn't online.
//   Each change is a `delivery` event on /v1/events; a delivery's first final state is audited (delivery.final).
// - delivery_waiting: a delivery still queued, typed or held after 2, 15 and 60 minutes (LIMITS.deliveryAlertMs, from
//   its queuedAt on the node's clock; a node's offset beyond 2 s raises clock_offset) raises one alert per threshold,
//   counted in the row (`alerted`) so a restart doesn't raise one again. A stale row is skipped until its node reports.
//   A scan that finds several thresholds crossed at once raises the highest only. Its detail: { id, lane | workerId, state,
//   reason, minutes } (reconciliation ruling 25).
// - The audit: every POST and cancel (delivery.post, delivery.cancel: the id, the target, the client, the outcome) and
//   each delivery's first final state; never the text.
// - Rows go LIMITS.deliveryKeepMs (7 days) after their last change, on start and hourly.
import {
  LIMITS, OP_ARGS, parseBody, parseWorkerId,
  type Delivery, type DeliveryState, type DeliveryTarget, type OpError, type OpResult, type Pane,
} from "@morndo/protocol";
import type { Audit } from "../adapters/audit.ts";
import type { LaneDeliveriesStore } from "../adapters/lane-deliveries-store.ts";
import type { Logger } from "../adapters/log.ts";
import type { StickyLanesStore } from "../adapters/sticky-lanes-store.ts";
import type { Connections } from "./connections.ts";
import type { EventHub } from "./events.ts";
import type { LaneRegistry } from "./lane-registry.ts";
import { opError } from "./requests.ts";

export type DeliveryRequest = { id: string; text: string; ttlMs?: number } & ({ lane: string } | { workerId: string });
export type Answer = { ok: true; delivery: Delivery } | { ok: false; error: OpError };
export type Mirrored = Delivery & { stale: boolean };

export const FINAL: ReadonlySet<DeliveryState> = new Set<DeliveryState>(["delivered", "uncertain", "given_up"]);
export const ALERT_SCAN_MS = 10_000;
export const LIST_MAX = 1000;                             // GET /v1/deliveries: the newest 1000 of the last 7 days
export const DELIVERY_OP_TIMEOUT_MS = 15_000;
const PRUNE_EVERY_MS = 3_600_000;

export class Deliveries {
  #store: LaneDeliveriesStore;
  #sticky: StickyLanesStore;
  #stickyLanes: readonly string[];
  #lanes: LaneRegistry;
  #connections: Connections;
  #audit: Audit;
  #events: EventHub;
  #log: Logger;
  #now: () => number;
  #stickySeen = new Map<string, string>();               // sticky name → the node last written to sticky_lanes
  #timers: ReturnType<typeof setInterval>[] = [];

  constructor(p: {
    store: LaneDeliveriesStore; sticky: StickyLanesStore; stickyLanes: readonly string[]; lanes: LaneRegistry; connections: Connections;
    audit: Audit; events: EventHub; log: Logger; now?: () => number;
  }) {
    this.#store = p.store;
    this.#sticky = p.sticky;
    this.#stickyLanes = p.stickyLanes;
    this.#lanes = p.lanes;
    this.#connections = p.connections;
    this.#audit = p.audit;
    this.#events = p.events;
    this.#log = p.log;
    this.#now = p.now ?? Date.now;
  }

  get stickyLanes(): readonly string[] { return this.#stickyLanes; }

  start(): void {
    this.#safely("removing old deliveries", () => this.prune());
    this.#timers.push(
      setInterval(() => this.#safely("the delivery_waiting scan", () => this.scanAlerts()), ALERT_SCAN_MS),
      setInterval(() => this.#safely("removing old deliveries", () => this.prune()), PRUNE_EVERY_MS),
    );
  }

  stop(): void { for (const t of this.#timers.splice(0)) clearInterval(t); }

  async post(req: DeliveryRequest, client: string): Promise<Answer> {
    const target: DeliveryTarget = "lane" in req ? { lane: req.lane, sticky: this.#stickyLanes.includes(req.lane) } : { workerId: req.workerId };
    const args = { id: req.id, target, text: req.text, ...(req.ttlMs === undefined ? {} : { ttlMs: req.ttlMs }) };
    let node: string | null = null;
    let answer: Answer;
    if (parseBody(OP_ARGS["lane.deliver"], args) === null) answer = { ok: false, error: opError("bad_args", "an id, a target or a text that doesn't fit lane.deliver") };
    else {
      const routed = this.#route(req);
      if ("error" in routed) answer = { ok: false, error: routed.error };
      else {
        node = routed.node;
        const out = await this.#connections.request(node, "lane.deliver", args, { timeoutMs: DELIVERY_OP_TIMEOUT_MS });
        if (!out.ok) answer = { ok: false, error: out.error };
        else {
          const { delivery } = out.result as OpResult["lane.deliver"];
          this.#mirror(node, delivery, "answer");
          answer = { ok: true, delivery };
        }
      }
    }
    this.#audited("delivery.post", node, { id: req.id, target: "lane" in req ? { lane: req.lane } : { workerId: req.workerId }, client, outcome: answer.ok ? answer.delivery.state : answer.error.code });
    return answer;
  }

  // null: no delivery of that id is known to the fleet (GET /v1/deliveries/<id> would be 404 too).
  async cancel(id: string, client: string): Promise<Answer | null> {
    const row = this.#store.get(id);
    if (!row) return null;
    const out = await this.#connections.request(row.node, "delivery.cancel", { id }, { timeoutMs: DELIVERY_OP_TIMEOUT_MS });
    let answer: Answer;
    if (!out.ok) answer = { ok: false, error: out.error };
    else {
      const { delivery } = out.result as OpResult["delivery.cancel"];
      this.#mirror(row.node, delivery, "answer");
      answer = { ok: true, delivery };
    }
    this.#audited("delivery.cancel", row.node, { id, client, outcome: answer.ok ? answer.delivery.state : answer.error.code });
    return answer;
  }

  get(id: string): { delivery: Delivery; stale: boolean } | null {
    const row = this.#store.get(id);
    return row ? { delivery: row.delivery, stale: this.#stale(row.node) } : null;
  }

  list(q: { lane?: string; state?: DeliveryState } = {}): Mirrored[] {
    return this.#store.list({ since: this.#now() - LIMITS.deliveryKeepMs, limit: LIST_MAX, ...q }).map(r => ({ ...r.delivery, stale: this.#stale(r.node) }));
  }

  // ev.delivery from `node` (agent-session.ts: the delivery's own node, checked).
  fromNode(node: string, d: Delivery): void { this.#mirror(node, d, "event"); }

  // Each inventory: the sticky names this node reports a window of are now its own (sticky_lanes).
  inventory(node: string, panes: Pane[]): void {
    for (const name of new Set(panes.map(p => p.window))) {
      if (!this.#stickyLanes.includes(name) || this.#stickySeen.get(name) === node) continue;
      this.#sticky.set(name, node, this.#now());
      this.#stickySeen.set(name, node);
    }
  }

  scanAlerts(): void {
    const now = this.#now();
    const thresholds = LIMITS.deliveryAlertMs;
    for (const row of this.#store.open(thresholds.length)) {
      if (this.#stale(row.node)) continue;
      const age = now - row.delivery.queuedAt;
      let level = row.alerted;
      while (level < thresholds.length && age >= (thresholds[level] ?? Infinity)) level++;
      if (level === row.alerted) continue;
      this.#store.setAlerted(row.id, level);
      const d = row.delivery;
      this.#audit.alert("delivery_waiting", row.node, {
        id: d.id, ...d.target, state: d.state, reason: d.waiting?.reason ?? null, minutes: (thresholds[level - 1] ?? 0) / 60_000,
      });
    }
  }

  prune(): number { return this.#store.prune(this.#now() - LIMITS.deliveryKeepMs); }

  #route(req: DeliveryRequest): { node: string } | { error: OpError } {
    const known = this.#store.get(req.id);
    if (known) return { node: known.node };
    if ("workerId" in req) {
      const ref = parseWorkerId(req.workerId);
      return ref ? { node: ref.node } : { error: opError("bad_args", `not a worker ID: ${JSON.stringify(req.workerId)}`) };
    }
    const r = this.#lanes.resolve(req.lane);
    if (r.kind === "ok") return { node: r.node };
    if (r.kind === "conflict") return { error: opError("lane_conflict", `more than one window is named ${JSON.stringify(req.lane)}; rename one, or address it by worker ID`) };
    const last = this.#stickyLanes.includes(req.lane) ? this.#sticky.get(req.lane) : null;
    if (last) return { node: last.node };
    return { error: opError("no_pane", `no lane named ${JSON.stringify(req.lane)}`) };
  }

  #mirror(node: string, d: Delivery, from: "event" | "answer"): void {
    const before = this.#store.get(d.id);
    const final = FINAL.has(d.state);
    if (before) {
      if (FINAL.has(before.delivery.state) && (!final || before.node !== node)) return;   // a final state stays
      if (from === "answer" && !final) return;                                         // an event may have said more since
      if (before.node === node && JSON.stringify(before.delivery) === JSON.stringify(d)) return;
    }
    this.#store.upsert(node, d, this.#now());
    if (final && !(before && FINAL.has(before.delivery.state))) {
      this.#audited("delivery.final", node, { id: d.id, state: d.state, ...(d.why === undefined ? {} : { why: d.why }) });
    }
    this.#events.emit({ t: "delivery", node, body: { ...d, stale: this.#stale(node) } satisfies Mirrored });
  }

  #stale(node: string): boolean { return this.#connections.status(node) !== "online"; }

  // The outcome is the client's whatever the audit can take (fleet.db busy or full): logged instead, never the text.
  #audited(action: string, node: string | null, detail: Record<string, unknown>): void {
    try { this.#audit.record("client", action, node, detail); }
    catch (e) { this.#log.error(`audit: ${action} could not be recorded (fleet.db busy or full?): ${JSON.stringify(detail)}`, e); }
  }

  #safely(what: string, f: () => void): void {
    try { f(); } catch (e) { this.#log.error(`deliveries: ${what} failed (fleet.db busy or full?); trying again later`, e); }
  }
}
```

In `apps/fleet/src/application/events.ts`, replace:

```ts
// What the fleet tells its clients as it happens (spec 5.6, WS /v1/events): a node's inventory and health, its status,
// lane-name conflicts and alerts. One subscriber that throws never keeps the others from hearing an event.
export type FleetEvent = { t: "inventory" | "health" | "status" | "conflict" | "alert"; node: string; body: unknown };
```

with:

```ts
// What the fleet tells its clients as it happens (spec 5.6, WS /v1/events): a node's inventory and health, its status,
// lane-name conflicts, alerts, and a delivery's latest state (fleet clients spec §4.6; body: Delivery & { stale }). One
// subscriber that throws never keeps the others from hearing an event.
export type FleetEvent = { t: "inventory" | "health" | "status" | "conflict" | "alert" | "delivery"; node: string; body: unknown };
```

In `apps/fleet/src/application/requests.ts`, replace:

```ts
// Keyed ops, and pane.keys: keystrokes have no key (they are never retried) but are a side effect all the same.
export const SIDE_EFFECT_OPS: ReadonlySet<OpName> = new Set<OpName>([...KEYED_OPS, "pane.keys"]);
```

with:

```ts
// Keyed ops, and pane.keys: keystrokes have no key (they are never retried) but are a side effect all the same. So are
// lane.deliver and delivery.cancel (fleet clients spec §4): a delivery's id is its idempotency, and an answer lost after
// sending may come after the node stored or cancelled it, so it is uncertain, never node_offline.
export const SIDE_EFFECT_OPS: ReadonlySet<OpName> = new Set<OpName>([...KEYED_OPS, "pane.keys", "lane.deliver", "delivery.cancel"]);
```

The client API: in `apps/fleet/src/adapters/client-api.ts`, replace the route list's first line:

```ts
//   GET  /v1/caps                      { api: number[] }
```

with:

```ts
//   GET  /v1/caps                      { api: number[], stickyLanes: string[] }
```

Then replace:

```ts
//   GET  /v1/files/<node>/<ref|path>   the file, streamed; the ref or path URL-encoded as one path segment
//   WS   /v1/events                    { t: "inventory" | "health" | "status" | "conflict" | "alert", node, body }; a
```

with:

```ts
//                                      lane.deliver and delivery.cancel are refused here (400 bad_args): a delivery goes
//                                      through /v1/deliveries, which routes sticky names and keeps the mirror.
//   GET  /v1/files/<node>/<ref|path>   the file, streamed; the ref or path URL-encoded as one path segment
//   POST /v1/deliveries                { id, lane | workerId, text, ttlMs? } → { ok: true, delivery } or { ok: false, error }:
//                                      200 for every outcome, a refusal included, as /v1/op; 400 (bad_args) for a body
//                                      that doesn't fit, lane.deliver's own rules included; 415 not JSON, 413 over the
//                                      limit (fleet clients spec §8; reconciliation ruling 3)
//   GET  /v1/deliveries/<id>           { delivery, stale } from the mirror, or 404; the id URL-encoded as one segment
//   GET  /v1/deliveries?lane=&state=   { deliveries: (Delivery & { stale })[] }: the newest 1000 of the last 7 days, oldest first
//   POST /v1/deliveries/<id>/cancel    { ok: true, delivery } or { ok: false, error }; 404 { error: "no_such_delivery" } for
//                                      an id the fleet doesn't know
//   WS   /v1/events                    { t: "inventory" | "health" | "status" | "conflict" | "alert" | "delivery", node, body }; a
```

Then replace:

```ts
import { CLIENT_API, LIMITS, NODE_NAME } from "@morndo/protocol";
```

with:

```ts
import { CLIENT_API, LIMITS, NODE_NAME, type DeliveryState } from "@morndo/protocol";
```

Then replace:

```ts
import type { Connections } from "../application/connections.ts";
```

with:

```ts
import type { Connections } from "../application/connections.ts";
import type { Deliveries } from "../application/deliveries.ts";
```

Then replace:

```ts
import { streamFile } from "./files-route.ts";
```

with:

```ts
import { parseDeliveryBody } from "./delivery-body.ts";
import { streamFile } from "./files-route.ts";
```

Then replace:

```ts
  router: Router; connections: Connections; lanes: LaneRegistry; nodes: NodesStore; audit: Audit; events: EventHub; log: Logger;
```

with:

```ts
  router: Router; connections: Connections; lanes: LaneRegistry; nodes: NodesStore; audit: Audit; events: EventHub; log: Logger;
  deliveries: Deliveries;
```

Then replace:

```ts
const json = (res: ServerResponse, status: number, body: unknown) => {
```

with:

```ts
const STATES: ReadonlySet<string> = new Set<DeliveryState>(["queued", "typed", "held", "delivered", "uncertain", "given_up"]);
// The query of a request's URL (after "?"), decoded.
const queryOf = (url: string | undefined): URLSearchParams => new URL(url ?? "/", "http://fleet").searchParams;

const json = (res: ServerResponse, status: number, body: unknown) => {
```

Then replace:

```ts
    if (method === "GET" && s.length === 1 && first === "caps") return json(res, 200, { api: API_VERSIONS });
```

with:

```ts
    if (method === "GET" && s.length === 1 && first === "caps") return json(res, 200, { api: API_VERSIONS, stickyLanes: d.deliveries.stickyLanes });
```

Then, in `POST /v1/op`, replace:

```ts
      const b = parsed.body;
      const outcome
```

with:

```ts
      const b = parsed.body;
      if (b.op === "lane.deliver" || b.op === "delivery.cancel") {
        return json(res, 400, { ok: false, error: opError("bad_args", `${b.op} is not sent as an op: use /v1/deliveries`), store: null, storeSeq: null });
      }
      const outcome
```

and add the routes after `files`: replace

```ts
    if (method === "GET" && s.length === 3 && first === "files") return streamFile(res, d.router, second ?? "", third ?? "");
```

with:

```ts
    if (method === "GET" && s.length === 3 && first === "files") return streamFile(res, d.router, second ?? "", third ?? "");
    if (method === "POST" && s.length === 1 && first === "deliveries") {
      let body: unknown;
      try { body = await readJson(req); }
      catch (e) {
        if (!(e instanceof HttpError)) throw e;
        return json(res, e.status, { ok: false, error: opError(e.status === 413 ? "too_large" : "bad_args", e.message) });
      }
      const parsed = parseDeliveryBody(body);
      if (!parsed.ok) return json(res, 400, { ok: false, error: opError("bad_args", parsed.message) });
      return json(res, 200, await d.deliveries.post(parsed.body, clientOf(req)));
    }
    if (method === "GET" && s.length === 1 && first === "deliveries") {
      const q = queryOf(req.url);
      const lane = q.get("lane") || undefined;
      const state = q.get("state") || undefined;
      if (state !== undefined && !STATES.has(state)) throw new HttpError(400, `state must be one of ${[...STATES].join(", ")}`);
      return json(res, 200, { deliveries: d.deliveries.list({ ...(lane === undefined ? {} : { lane }), ...(state === undefined ? {} : { state: state as DeliveryState }) }) });
    }
    if (method === "GET" && s.length === 2 && first === "deliveries") {
      const one = d.deliveries.get(second ?? "");
      return one ? json(res, 200, one) : json(res, 404, { error: "no_such_delivery" });
    }
    if (method === "POST" && s.length === 3 && first === "deliveries" && third === "cancel") {
      const answer = await d.deliveries.cancel(second ?? "", clientOf(req));
      return answer ? json(res, 200, answer) : json(res, 404, { error: "no_such_delivery" });
    }
```

The agent session hands `ev.delivery` to the mirror. In `apps/fleet/src/adapters/agent-session.ts`, replace:

```ts
// disk. Hook events are exempt from the rate limit: the agent's replay window paces them (spec 5.4).
```

with:

```ts
// disk. Hook events are exempt from the rate limit: the agent's replay window paces them (spec 5.4). So are delivery
// states (ev.delivery, to the deliveries' mirror): after every reconnect a node sends each open delivery's state at
// once (fleet clients spec §4.4), and its own store bounds them.
```

Then replace:

```ts
import type { HookSink, IntakeHandle } from "../application/hook-sink.ts";
```

with:

```ts
import type { Deliveries } from "../application/deliveries.ts";
import type { HookSink, IntakeHandle } from "../application/hook-sink.ts";
```

Then replace:

```ts
  connections: Connections; nodes: NodesStore; audit: Audit; fleetKey: FleetKey; hooks: HookSink; log: Logger;
```

with:

```ts
  connections: Connections; nodes: NodesStore; audit: Audit; fleetKey: FleetKey; hooks: HookSink; log: Logger;
  deliveries: Pick<Deliveries, "fromNode">;
```

and the `ev.delivery` case Task 1 left for this task (01-foundation.md, Step 8):

```ts
      case "ev.delivery":
        // A delivery's latest state (fleet clients §4.4): read and left until the fleet keeps a mirror of deliveries (§4.6).
        if (state.kind !== "live") return close(1008, "unexpected event");
        return;
```

with:

```ts
      case "ev.delivery":
        if (state.kind !== "live") return close(1008, "unexpected event");
        if (m.delivery.node !== state.node) return close(1008, "an event for another node or stream");
        return d.deliveries.fromNode(state.node, m.delivery);
```

In `apps/fleet/src/serve.ts`, replace:

```ts
import { LanesStore } from "./adapters/lanes-store.ts";
```

with:

```ts
import { LaneDeliveriesStore } from "./adapters/lane-deliveries-store.ts";
import { LanesStore } from "./adapters/lanes-store.ts";
```

Then replace:

```ts
import { StoreSeqsStore } from "./adapters/store-seqs.ts";
```

with:

```ts
import { StickyLanesStore } from "./adapters/sticky-lanes-store.ts";
import { StoreSeqsStore } from "./adapters/store-seqs.ts";
```

Then replace:

```ts
import { Connections } from "./application/connections.ts";
```

with:

```ts
import { Connections } from "./application/connections.ts";
import { Deliveries } from "./application/deliveries.ts";
```

Then replace:

```ts
  connections: Connections; lanes: LaneRegistry; router: Router; outbox: OutboxStore; delivery: DeliveryWorker; intake: IntakeWindow; agentPort: number;
```

with:

```ts
  connections: Connections; lanes: LaneRegistry; router: Router; outbox: OutboxStore; delivery: DeliveryWorker; intake: IntakeWindow;
  deliveries: Deliveries; agentPort: number;
```

Then replace:

```ts
  events.subscribe(e => { if (e.t === "inventory") lanes.inventory(e.node, (e.body as { panes: Pane[] }).panes); });
```

with:

```ts
  const deliveries = new Deliveries({
    store: new LaneDeliveriesStore(db), sticky: new StickyLanesStore(db), stickyLanes: config.stickyLanes, lanes, connections, audit, events, log, now,
  });
  events.subscribe(e => {
    if (e.t !== "inventory") return;
    const panes = (e.body as { panes: Pane[] }).panes;
    lanes.inventory(e.node, panes);
    deliveries.inventory(e.node, panes);
  });
```

Then replace:

```ts
deps: { connections, nodes, audit, fleetKey: key, hooks: intake, log },
```

with:

```ts
deps: { connections, nodes, audit, fleetKey: key, hooks: intake, deliveries, log },
```

Then replace:

```ts
      router, connections, lanes, nodes, audit, events, log, ...(o.eventsBufferBytes === undefined ? {} : { eventsBufferBytes: o.eventsBufferBytes }),
```

with:

```ts
      router, connections, lanes, nodes, audit, events, deliveries, log, ...(o.eventsBufferBytes === undefined ? {} : { eventsBufferBytes: o.eventsBufferBytes }),
```

Then replace:

```ts
  connections.start();
  delivery.start();
```

with:

```ts
  connections.start();
  delivery.start();
  deliveries.start();
```

Then replace:

```ts
    config, db, key, nodes, audit, events, connections, lanes, router, outbox, delivery, intake, agentPort: agents.port(),
```

with:

```ts
    config, db, key, nodes, audit, events, connections, lanes, router, outbox, delivery, intake, deliveries, agentPort: agents.port(),
```

and in `close`:

```ts
      clearInterval(retention);
      connections.stop();
```

with:

```ts
      clearInterval(retention);
      deliveries.stop();
      connections.stop();
```

The hand-made endpoint in `apps/fleet/test/agent-auth.test.ts` takes the session's new dependency: replace

```ts
      deps: { connections: fleet.connections, nodes: fleet.nodes, audit: fleet.audit, fleetKey: fleet.key, hooks, log: quiet },
```

with:

```ts
      deps: { connections: fleet.connections, nodes: fleet.nodes, audit: fleet.audit, fleetKey: fleet.key, hooks, deliveries: fleet.deliveries, log: quiet },
```

- [ ] **Step 9: Run them and see them pass**

Run: `npx vitest run apps/fleet/test/deliveries.test.ts apps/fleet/test/delivery-mirror.test.ts apps/fleet/test/client-api.test.ts apps/fleet/test/socket-dir.test.ts`
Expected: PASS (42 tests in 4 files)

Run: `npx vitest run apps/fleet`
Expected: PASS (213 tests in 40 files)

Run: `npx tsc -p apps/fleet && npx tsc -p tsconfig.tests.json && npx oxlint apps/fleet`
Expected: exit 0, nothing printed

- [ ] **Step 10: Commit**

```bash
git add apps/fleet/src/adapters/lane-deliveries-store.ts apps/fleet/src/adapters/sticky-lanes-store.ts apps/fleet/src/adapters/delivery-body.ts apps/fleet/src/application/deliveries.ts apps/fleet/src/application/events.ts apps/fleet/src/application/requests.ts apps/fleet/src/adapters/client-api.ts apps/fleet/src/adapters/agent-session.ts apps/fleet/src/serve.ts apps/fleet/test/helpers/node-queue.ts apps/fleet/test/helpers/fake-agent.ts apps/fleet/test/deliveries.test.ts apps/fleet/test/delivery-mirror.test.ts apps/fleet/test/client-api.test.ts apps/fleet/test/socket-dir.test.ts apps/fleet/test/agent-auth.test.ts
git commit -m "feat(fleet): deliveries routed to their node, mirrored, listed, cancelled and alerted"
```

- [ ] **Step 11: Write the failing test for the ops clients send through `/v1/op`**

Create `apps/fleet/test/op-routing-clients.test.ts`:

```ts
// The ops fleet clients use through POST /v1/op (spec §5, §8): pane.capture by lane gets the lane's worker and waits its
// turn with the other bulk ops (up to 256 KiB, one chunk); lane.stop's default deadline leaves its "exit" mode the 30 s
// it may wait for the window to close.
import { describe, expect, it, vi } from "vitest";
import { LIMITS } from "@morndo/protocol";
import { startTestFleet } from "./helpers/fleet.ts";
import { client } from "./helpers/socket-client.ts";

describe("ops for fleet clients", () => {
  it("pane.capture by lane gets the lane's worker ID, and goes one at a time with the bulk ops", async () => {
    const fleet = await startTestFleet();
    const pc = await fleet.online("pc");
    pc.inventory([{ workerId: "pc.3fa2c1d0.4", window: "api", cwd: "/w", status: "idle", pid: 1 }]);
    await vi.waitFor(() => expect(fleet.lanes.get("api")).not.toBeNull());
    let release: () => void = () => {};
    pc.answer = req => {
      if (req.op === "transcript.read") { const id = req.id; release = () => pc.send({ v: 1, t: "res", id, invVersion: 1, store: pc.store, ok: true, result: { bytes: "", eof: true } }); return "never"; }
      if (req.op === "pane.capture") return { ok: true, result: { text: "screen", truncated: false } };
      return { ok: true, result: {} };
    };
    const api = client(fleet.config.socketPath);
    const read = api.post("/v1/op", { node: "pc", op: "transcript.read", args: { sessionId: "s1", offset: 0, max: 1024 } });
    await vi.waitFor(() => expect(pc.reqs.map(r => r.op)).toEqual(["transcript.read"]));
    const capture = api.post("/v1/op", { lane: "api", op: "pane.capture", args: { lines: 200, attributes: true } });
    await new Promise(r => setTimeout(r, 100));
    expect(pc.reqs.map(r => r.op)).toEqual(["transcript.read"]);                      // negative control: not bulk, sent at once
    release();
    expect((await capture)?.body).toMatchObject({ ok: true, result: { text: "screen", truncated: false } });
    expect(pc.reqs.at(-1)?.args).toEqual({ workerId: "pc.3fa2c1d0.4", lines: 200, attributes: true });
    await read;
  });

  it("lane.stop's default deadline is the 30 s its exit may wait plus 15 s; a client's own timeoutMs still wins", async () => {
    const fleet = await startTestFleet();
    const pc = await fleet.online("pc");
    const api = client(fleet.config.socketPath);
    await api.post("/v1/op", { node: "pc", op: "lane.stop", args: { name: "api" }, key: "lanes:stop-1" });
    await api.post("/v1/op", { node: "pc", op: "lane.stop", args: { name: "api" }, key: "lanes:stop-2", timeoutMs: 5000 });
    expect(pc.reqs.map(r => r.timeoutMs)).toEqual([LIMITS.laneStopWaitMs + 15_000, 5000]);
  });
});
```

- [ ] **Step 12: Run it and see it fail**

Run: `npx vitest run apps/fleet/test/op-routing-clients.test.ts`
Expected: FAIL, both: `pane.capture` by lane is `bad_args` (no worker ID filled in) and is sent at once beside the read in flight; `lane.stop` gets `15000`, not `45000`

- [ ] **Step 13: Route `pane.capture` and give `lane.stop` its deadline**

In `apps/fleet/src/application/requests.ts`, replace:

```ts
// The ops that move bulk data (up to LIMITS.chunkBytes each): one at a time per connection (spec 5.2).
export const BULK_OPS: ReadonlySet<OpName> = new Set<OpName>(["transcript.read", "file.get", "file.put"]);
```

with:

```ts
// The ops that move bulk data (up to LIMITS.chunkBytes each): one at a time per connection (spec 5.2). pane.capture
// answers up to LIMITS.captureMaxBytes (256 KiB, one chunk; fleet clients spec §5).
export const BULK_OPS: ReadonlySet<OpName> = new Set<OpName>(["transcript.read", "file.get", "file.put", "pane.capture"]);
```

In `apps/fleet/src/application/router.ts`, replace:

```ts
import { KEYED_OPS, NODE_NAME, OP_ARGS, parseBody, parseWorkerId, type OpName } from "@morndo/protocol";
```

with:

```ts
import { KEYED_OPS, LIMITS, NODE_NAME, OP_ARGS, parseBody, parseWorkerId, type OpName } from "@morndo/protocol";
```

Then replace:

```ts
const PANE_OPS: ReadonlySet<OpName> = new Set<OpName>(["pane.frame", "pane.keys", "pane.send"]);
```

with:

```ts
const PANE_OPS: ReadonlySet<OpName> = new Set<OpName>(["pane.frame", "pane.keys", "pane.send", "pane.capture"]);
// lane.stop's "exit" waits up to LIMITS.laneStopWaitMs for the window to close (fleet clients spec §5): its default
// deadline leaves it that long plus the usual 15 s.
const DEFAULT_TIMEOUT_OF: { readonly [O in OpName]?: number } = { "lane.stop": LIMITS.laneStopWaitMs + DEFAULT_TIMEOUT_MS };
```

and:

```ts
    const timeoutMs = Math.min(o.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
```

with:

```ts
    const timeoutMs = Math.min(o.timeoutMs ?? DEFAULT_TIMEOUT_OF[op] ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
```

- [ ] **Step 14: Run it and see it pass**

Run: `npx vitest run apps/fleet/test/op-routing-clients.test.ts`
Expected: PASS (2 tests)

Run: `npx vitest run apps/fleet && npx tsc -p apps/fleet && npx oxlint apps/fleet`
Expected: PASS (215 tests in 41 files); tsc and oxlint print nothing

- [ ] **Step 15: Commit**

```bash
git add apps/fleet/src/application/requests.ts apps/fleet/src/application/router.ts apps/fleet/test/op-routing-clients.test.ts
git commit -m "feat(fleet): pane.capture routed by lane as a bulk op, lane.stop given time to exit"
```

- [ ] **Step 16: Add this task's negative controls to `scripts/negative-controls.ts`**

In `scripts/negative-controls.ts`, insert this task's entries at the end of `CONTROLS`, before its closing `];` (the line before `// ---- the runner`), after whatever entries earlier tasks and lanes added there:

```ts
  // Task 8: deliveries routed, mirrored and alerted; pane.capture and lane.stop through /v1/op.
  { id: "fc8-sticky-fallback", task: "fc8", file: "apps/fleet/src/application/deliveries.ts",
    find: "    const last = this.#stickyLanes.includes(req.lane) ? this.#sticky.get(req.lane) : null;",
    replace: "    const last = null as { node: string } | null;",
    run: ["apps/fleet/test/deliveries.test.ts"], expect: "no_pane" },
  { id: "fc8-sticky-flag", task: "fc8", file: "apps/fleet/src/application/deliveries.ts",
    find: "{ lane: req.lane, sticky: this.#stickyLanes.includes(req.lane) }",
    replace: "{ lane: req.lane, sticky: false }",
    run: ["apps/fleet/test/deliveries.test.ts"], expect: "sticky" },
  { id: "fc8-known-id-node", task: "fc8", file: "apps/fleet/src/application/deliveries.ts",
    find: "    if (known) return { node: known.node };\n",
    replace: "",
    run: ["apps/fleet/test/deliveries.test.ts"], expect: "an id the fleet knows goes back to the node that stored it" },
  { id: "fc8-conflict-refused", task: "fc8", file: "apps/fleet/src/application/deliveries.ts",
    find: "    if (r.kind === \"conflict\") return",
    replace: "    if (r.kind === \"conflict\" && false) return",
    run: ["apps/fleet/test/deliveries.test.ts"], expect: "lane_conflict" },
  { id: "fc8-no-text-in-audit", task: "fc8", file: "apps/fleet/src/application/deliveries.ts",
    find: "    this.#audited(\"delivery.post\", node, { id: req.id,",
    replace: "    this.#audited(\"delivery.post\", node, { text: req.text, id: req.id,",
    run: ["apps/fleet/test/deliveries.test.ts"], expect: "audited without the text" },
  { id: "fc8-op-refuses-deliver", task: "fc8", file: "apps/fleet/src/adapters/client-api.ts",
    find: "      if (b.op === \"lane.deliver\" || b.op === \"delivery.cancel\") {",
    replace: "      if (false) {",
    run: ["apps/fleet/test/deliveries.test.ts"], expect: "/v1/deliveries" },
  { id: "fc8-deliver-side-effect", task: "fc8", file: "apps/fleet/src/application/requests.ts",
    find: "[...KEYED_OPS, \"pane.keys\", \"lane.deliver\", \"delivery.cancel\"]",
    replace: "[...KEYED_OPS, \"pane.keys\"]",
    run: ["apps/fleet/test/deliveries.test.ts"], expect: "uncertain" },
  { id: "fc8-final-stays", task: "fc8", file: "apps/fleet/src/application/deliveries.ts",
    find: "      if (FINAL.has(before.delivery.state) && (!final || before.node !== node)) return;   // a final state stays\n",
    replace: "",
    run: ["apps/fleet/test/delivery-mirror.test.ts"], expect: "typed" },
  { id: "fc8-answer-older", task: "fc8", file: "apps/fleet/src/application/deliveries.ts",
    find: "      if (from === \"answer\" && !final) return;",
    replace: "",
    run: ["apps/fleet/test/delivery-mirror.test.ts"], expect: "queued" },
  { id: "fc8-alerted-once", task: "fc8", file: "apps/fleet/src/application/deliveries.ts",
    find: "      this.#store.setAlerted(row.id, level);\n",
    replace: "",
    run: ["apps/fleet/test/delivery-mirror.test.ts"], expect: "not again after a restart" },
  { id: "fc8-alert-skips-stale", task: "fc8", file: "apps/fleet/src/application/deliveries.ts",
    find: "      if (this.#stale(row.node)) continue;\n",
    replace: "",
    run: ["apps/fleet/test/delivery-mirror.test.ts"], expect: "skips a stale delivery until its node reports" },
  { id: "fc8-delivery-node", task: "fc8", file: "apps/fleet/src/adapters/agent-session.ts",
    find: "        if (m.delivery.node !== state.node) return close(1008, \"an event for another node or stream\");\n",
    replace: "",
    run: ["apps/fleet/test/delivery-mirror.test.ts"], expect: "1008" },
  { id: "fc8-delivery-unlimited", task: "fc8", file: "apps/fleet/src/adapters/agent-session.ts",
    find: "        return d.deliveries.fromNode(state.node, m.delivery);",
    replace: "        if (!d.limiter.take(state.node)) return rateLimited(state.node);\n        return d.deliveries.fromNode(state.node, m.delivery);",
    run: ["apps/fleet/test/delivery-mirror.test.ts"], expect: "200 delivery states at once after a reconnect is not closed" },
  { id: "fc8-capture-bulk", task: "fc8", file: "apps/fleet/src/application/requests.ts",
    find: "[\"transcript.read\", \"file.get\", \"file.put\", \"pane.capture\"]",
    replace: "[\"transcript.read\", \"file.get\", \"file.put\"]",
    run: ["apps/fleet/test/op-routing-clients.test.ts"], expect: "expected [ 'transcript.read', 'pane.capture' ]" },
  { id: "fc8-capture-worker", task: "fc8", file: "apps/fleet/src/application/router.ts",
    find: "[\"pane.frame\", \"pane.keys\", \"pane.send\", \"pane.capture\"]",
    replace: "[\"pane.frame\", \"pane.keys\", \"pane.send\"]",
    run: ["apps/fleet/test/op-routing-clients.test.ts"], expect: "pane.capture by lane gets the lane's worker ID" },
  { id: "fc8-stop-deadline", task: "fc8", file: "apps/fleet/src/application/router.ts",
    find: "{ \"lane.stop\": LIMITS.laneStopWaitMs + DEFAULT_TIMEOUT_MS }",
    replace: "{}",
    run: ["apps/fleet/test/op-routing-clients.test.ts"], expect: "45000" },
  { id: "fc8-schema-in-body", task: "fc8", file: "apps/fleet/src/adapters/delivery-body.ts",
    find: "  if (parseBody(OP_ARGS[\"lane.deliver\"], { ...base, target }) === null) return no(\"an id, a target, a text or a ttlMs that doesn't fit lane.deliver\");\n",
    replace: "",
    run: ["apps/fleet/test/deliveries.test.ts"], expect: "status: 400" },
  { id: "fc8-sticky-kept-restart", task: "fc8", file: "apps/fleet/src/adapters/sticky-lanes-store.ts",
    find: "  constructor(db: Database.Database) { this.#db = db; }",
    replace: "  constructor(db: Database.Database) { this.#db = db; db.exec(\"DELETE FROM sticky_lanes\"); }",
    run: ["apps/fleet/test/deliveries.test.ts"], expect: "\"ok\": false" },
  { id: "fc8-caps-sticky", task: "fc8", file: "apps/fleet/src/adapters/client-api.ts",
    find: "{ api: API_VERSIONS, stickyLanes: d.deliveries.stickyLanes }",
    replace: "{ api: API_VERSIONS }",
    run: ["apps/fleet/test/client-api.test.ts"], expect: "stickyLanes" },
```

Run: `node scripts/negative-controls.ts --check`
Expected: exit 0; an `ok` line for each entry

- [ ] **Step 17: Commit**

```bash
git add scripts/negative-controls.ts
git commit -m "test(fleet): negative controls for deliveries through the fleet"
```

- [ ] **Step 18: Run the controls (the runner tests the code at HEAD, so after the commit)**

Run: `node scripts/negative-controls.ts --only fc8-sticky-fallback --only fc8-sticky-flag --only fc8-known-id-node --only fc8-conflict-refused --only fc8-no-text-in-audit --only fc8-op-refuses-deliver --only fc8-deliver-side-effect --only fc8-final-stays --only fc8-answer-older --only fc8-alerted-once --only fc8-alert-skips-stale --only fc8-delivery-node --only fc8-delivery-unlimited --only fc8-capture-bulk --only fc8-capture-worker --only fc8-stop-deadline --only fc8-schema-in-body --only fc8-sticky-kept-restart --only fc8-caps-sticky`
Expected: `19/19 controls bit; still pass 0, broke 0, timed out 0, skipped 0`

---

### Task 9: Fleet: lane events, published and delivered to the manager

Lane events (spec §7), built by the fleet from the hook stream, kept and published, and delivered to the manager in
`lane-events-push`'s place.

**Built** (`application/lane-events.ts`), per node and window:

| Event | From | Fields, by the chat bot's rules (read 2026-10-08) |
|---|---|---|
| `finished` | `/hook/stop` | `firstLine`: the answer's first non-blank line, trimmed, at most 200 characters (`last_assistant_message`, else `text`); `status`: kira's STATUS rule on it, verbatim, else null; `bg`, `crons`: `background_tasks`/`session_crons` counted (Claude Code's arrays), else `background`/`crons` (the owner's numbers) |
| `stop_failure` | `/hook/failure` | `error`: `error_type`, else `error`, else `"unknown"`, at most 60 characters |
| `needs_input` | `/lane` with `event: "needs_input"` | `question`, at most 200 characters |
| `answered` | `/lane` with `event: "answered"` | none |

`sessionId` comes from the body (`session_id`, or `/lane`'s `sessionId`). A hook without a window makes none (kira's
`if (!win) return`; reconciliation ruling 22), nor does the manager's own lane (the lane `laneEvents.deliverTo` names), nor a lane whose name
matches a glob of `laneEvents.ignore` (`*` any run, `?` one character). Claude Code's hook fields:
https://code.claude.com/docs/en/hooks (Stop: `last_assistant_message`, `background_tasks` and `session_crons` as arrays;
StopFailure: `error_type`), read 2026-10-08.

**Kept and published.** Each event is written in the intake's synced commit with the hook it comes from (Task 7), only
for a hook above its stream's mark, so a replay never makes a second one. A `needs_input` for a session whose latest lane
event is a `needs_input` (its node restarted and reports the same menu again) is dropped (ruling 18). `to_manager` is 0
(waiting) unless the event is `answered` or `deliverTo` is null; an event stored while `deliverTo` is null is never
delivered later, so turning delivery on (rollout step 3b) sends only what comes after (ruling 23). A node's `/lane`
events are the fleet's own: never a subscriber's path, never counted as unrouted (ruling 5). Once the commit
is on the disk, each is published as `{ t: "lane", node, body: LaneEvent }` on `/v1/events`; nothing a failed commit took
back is published. `GET /v1/lane-events?since=<seq>` answers after `since` (0 when absent), oldest first, at most 1000.
Kept 7 days by their time on the node (`LIMITS.laneEventKeepMs`), pruned at start and hourly.

**Delivered to the manager** (`application/lane-events-push.ts`, the retired script's rules): `batchMs` after the first
waiting event, everything waiting goes as deliveries to `deliverTo` through Task 8's `Deliveries.post`, as the client
`fleet`:
- the text: the header, then one JSON line per event in today's shape and key order, `{ ts, lane, sessionId, event,
  status, firstLine, bg, crons }` for `finished`, `{ ts, lane, sessionId, event, question }` and `{ ts, lane, sessionId,
  event, error }` for the others (`lineOf`);
- **split** at 8000 characters (Review Focus 4): a batch longer than `LIMITS.maxSendText` goes as several deliveries, in
  order, each with the header, so none is refused `too_large`;
- the id (ruling 6): `fleet:lane-events:<node>:<time>`, the node and the time (ms on that node's clock) of the batch's
  first event; the parts of a split batch get `-1`, `-2` …; an id already used (one this process sent, or one the mirror
  knows: a part given up comes back first in the next batch) takes `.2`, `.3` … after that;
- a part the node stored is marked sent (`to_manager = 1`, `delivery_id`); a refused part (no manager yet, its node
  offline) leaves it and every later part waiting, tried again after `batchMs`, with one warning per episode;
- a part given up (`ev.delivery` with `given_up`) waits again and goes in the next batch, under a new id; at start, the
  same for every part the mirror says was given up while the fleet was down; unsent events after a restart go then.

**Files:**
- Modify: `apps/fleet/src/config.ts` (`laneEvents`)
- Create: `apps/fleet/src/adapters/lane-events-store.ts`, `apps/fleet/src/application/lane-events.ts`,
  `apps/fleet/src/application/lane-events-push.ts`
- Modify: `apps/fleet/src/adapters/outbox-store.ts` (`taken`), `apps/fleet/src/application/hook-intake.ts` (`lanes`),
  `apps/fleet/src/application/events.ts` (`lane`), `apps/fleet/src/adapters/client-api.ts` (`GET /v1/lane-events`),
  `apps/fleet/src/serve.ts`
- Test: `apps/fleet/test/config.test.ts`, `apps/fleet/test/helpers/fleet.ts`, `apps/fleet/test/lane-events.test.ts`,
  `apps/fleet/test/lane-events-intake.test.ts`, `apps/fleet/test/lane-events-push.test.ts`
- Modify: `test/fleet-harness.ts` (`laneEvents`, off)
- Modify: `scripts/negative-controls.ts` (24 entries)

**Interfaces:**
- Consumes:
  - Task 1: `type LaneEvent`, `LaneEventName`, `HookEvent` (`"/lane"`), `LIMITS.laneEventKeepMs`, `LIMITS.maxSendText`,
    `type Delivery`.
  - Task 7: `lane_events`; `HookIntake.store` inside the intake's synced commit, its `after()` after it.
  - Task 8: `Deliveries.post(req, "fleet")`, `Deliveries.get(id)`, the `delivery` events of the mirror.
  - Agent (Task 6), over the protocol only: `/lane` hook events with `{ event, sessionId, question? }`.
- Produces:
  - `config.ts`: `type LaneEventsConfig = { deliverTo: string | null; header: string; ignore: string[]; batchMs: number }`,
    `FleetConfig.laneEvents` (defaults: `"manager"`, `"[lane-event] Lane events (handle them as your instructions say):"`,
    `[]`, `3000`).
  - Client API: `GET /v1/lane-events?since=` → `{ events: LaneEvent[] }`; `{ t: "lane", node, body }` on `/v1/events`.
  - `application/lane-events.ts`: `STATUS_RULE`, `firstLineOf`, `statusOf`, `globMatcher`, `laneEventOf(e, rules)`,
    `lineOf(e)`, `partsOf(events, header, max?)`, `class LaneEvents` (`take`, `committed`, `since`, `prune`, `start`, `stop`).
  - `application/lane-events-push.ts`: `class LaneEventsPush` (`kick`, `delivery(d)`, `flush()`, `start()`, `stop()`), `ID_PREFIX`.
  - `adapters/outbox-store.ts`: `accept(…, o: { now; cap; taken? })`.
  - `adapters/lane-events-store.ts`: `class LaneEventsStore` (`insert`, `since`, `lastOf(sessionId)`, `waiting`, `markSent`,
    `requeue`, `sentIn`, `prune`), `type LaneEventDraft`.
  - `serve.ts`: `Fleet.laneEvents`, `Fleet.laneEventsPush`.

- [ ] **Step 1: Write the failing config test for `laneEvents`**

In `apps/fleet/test/config.test.ts`, replace:

```ts
      stickyLanes: ["manager"],
    });
```

with:

```ts
      stickyLanes: ["manager"],
      laneEvents: { deliverTo: "manager", header: "[lane-event] Lane events (handle them as your instructions say):", ignore: [], batchMs: 3000 },
    });
```

Then replace:

```ts
  it("refuses a file that doesn't fit, naming the setting", () => {
```

with:

```ts
  it("takes laneEvents' settings one by one over their defaults; the owner's header and globs as they are", () => {
    const header = "[lane-event] Lane events from kira (handle them as the Dispatching work section says):";
    const { home, env } = withFile({ laneEvents: { header, ignore: ["pooltest*", "pool-probe*"] } });
    expect(loadConfig({ env, home }).laneEvents).toEqual({ deliverTo: "manager", header, ignore: ["pooltest*", "pool-probe*"], batchMs: 3000 });
    const off = withFile({ laneEvents: { deliverTo: null, batchMs: 100 } });
    expect(loadConfig(off).laneEvents).toMatchObject({ deliverTo: null, batchMs: 100 });
  });

  it("refuses a file that doesn't fit, naming the setting", () => {
```

and add the refusals: replace

```ts
      [{ stickyLanes: ["man\nager"] }, /stickyLanes must be a list of lane names/],
```

with:

```ts
      [{ stickyLanes: ["man\nager"] }, /stickyLanes must be a list of lane names/],
      [{ laneEvents: [] }, /laneEvents must be an object/],
      [{ laneEvents: { deliver: "manager" } }, /laneEvents has unknown settings: deliver/],
      [{ laneEvents: { deliverTo: "" } }, /laneEvents.deliverTo must be a lane name, or null/],
      [{ laneEvents: { header: "two\nlines" } }, /laneEvents.header must be one line/],
      [{ laneEvents: { ignore: "pooltest*" } }, /laneEvents.ignore must be a list of lane names/],
      [{ laneEvents: { batchMs: 10 } }, /laneEvents.batchMs must be a whole number of milliseconds from 100 to 60000/],
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run apps/fleet/test/config.test.ts`
Expected: FAIL, 3 of 7: the defaults lack `laneEvents`, the file's are refused as an unknown setting, and so are the refusals' (the wrong message)

- [ ] **Step 3: Implement `laneEvents`**

In `apps/fleet/src/config.ts`, replace:

```ts
// name's window is gone (the manager restarting), a delivery still goes to the node that last reported it.
import
```

with:

```ts
// name's window is gone (the manager restarting), a delivery still goes to the node that last reported it.
// `laneEvents` (spec §7): lane events delivered to the lane `deliverTo` (null: not delivered, still published), batched
// for `batchMs`, as one message whose first line is `header`; lanes whose name matches a glob of `ignore` emit none.
import
```

Then replace:

```ts
  stickyLanes: string[];                      // lane names deliveries follow across restarts (spec §4.6)
};
```

with:

```ts
  stickyLanes: string[];                      // lane names deliveries follow across restarts (spec §4.6)
  laneEvents: LaneEventsConfig;               // lane events to the manager (spec §7)
};
export type LaneEventsConfig = { deliverTo: string | null; header: string; ignore: string[]; batchMs: number };
```

Then replace:

```ts
const KEYS = new Set(["listen", "socketPath", "dbPath", "keyPath", "publicUrl", "subscribers", "stickyLanes"]);
```

with:

```ts
const KEYS = new Set(["listen", "socketPath", "dbPath", "keyPath", "publicUrl", "subscribers", "stickyLanes", "laneEvents"]);
const LANE_EVENT_KEYS = new Set(["deliverTo", "header", "ignore", "batchMs"]);
// The header is the message's first line: printable, no line break; the batch window from 0.1 to 60 s.
const HEADER = /^[^\p{Cc}]{1,1000}$/u;
```

Then replace:

```ts
    stickyLanes: ["manager"],
  };
}
```

with:

```ts
    stickyLanes: ["manager"],
    laneEvents: { deliverTo: "manager", header: "[lane-event] Lane events (handle them as your instructions say):", ignore: [], batchMs: 3000 },
  };
}
```

Then replace:

```ts
// The file's settings over the defaults. Throws ConfigError for a file that isn't JSON or doesn't fit.
```

with:

```ts
// Each setting of laneEvents over its default; a key it doesn't know is refused.
function laneEvents(v: unknown, base: LaneEventsConfig): LaneEventsConfig {
  if (!isObject(v)) throw new ConfigError("laneEvents must be an object with deliverTo, header, ignore and batchMs");
  const extra = Object.keys(v).filter(k => !LANE_EVENT_KEYS.has(k));
  if (extra.length) throw new ConfigError(`laneEvents has unknown settings: ${extra.join(", ")}`);
  if (v.deliverTo !== undefined && v.deliverTo !== null && (typeof v.deliverTo !== "string" || !LANE_NAME.test(v.deliverTo))) {
    throw new ConfigError("laneEvents.deliverTo must be a lane name, or null to deliver lane events to no lane");
  }
  if (v.header !== undefined && (typeof v.header !== "string" || !HEADER.test(v.header))) {
    throw new ConfigError("laneEvents.header must be one line of 1 to 1000 characters");
  }
  if (v.batchMs !== undefined && (!Number.isInteger(v.batchMs) || (v.batchMs as number) < 100 || (v.batchMs as number) > 60_000)) {
    throw new ConfigError("laneEvents.batchMs must be a whole number of milliseconds from 100 to 60000");
  }
  return {
    deliverTo: v.deliverTo === undefined ? base.deliverTo : (v.deliverTo as string | null),
    header: v.header === undefined ? base.header : (v.header as string),
    ignore: v.ignore === undefined ? base.ignore : laneNames(v.ignore, "laneEvents.ignore"),
    batchMs: v.batchMs === undefined ? base.batchMs : (v.batchMs as number),
  };
}

// The file's settings over the defaults. Throws ConfigError for a file that isn't JSON or doesn't fit.
```

Then replace:

```ts
    stickyLanes: raw.stickyLanes === undefined ? base.stickyLanes : laneNames(raw.stickyLanes, "stickyLanes"),
  };
```

with:

```ts
    stickyLanes: raw.stickyLanes === undefined ? base.stickyLanes : laneNames(raw.stickyLanes, "stickyLanes"),
    laneEvents: raw.laneEvents === undefined ? base.laneEvents : laneEvents(raw.laneEvents, base.laneEvents),
  };
```

The tests' fleet and the drills' harness deliver lane events to no lane unless a test asks: a batch typed into a lane
named "manager" would be a message those tests didn't send. In `apps/fleet/test/helpers/fleet.ts`, replace:

```ts
subscribers: [], stickyLanes: ["manager"], ...over,
```

with:

```ts
subscribers: [], stickyLanes: ["manager"],
    laneEvents: { deliverTo: null, header: "[lane-event] Lane events (handle them as your instructions say):", ignore: [], batchMs: 3000 }, ...over,
```

and in `test/fleet-harness.ts`:

```ts
    publicUrl: `ws://127.0.0.1:${port}/agent`, subscribers: o.subscribers ?? [], stickyLanes: ["manager"],
  };
```

with:

```ts
    publicUrl: `ws://127.0.0.1:${port}/agent`, subscribers: o.subscribers ?? [], stickyLanes: ["manager"],
    // No lane events to a lane unless a drill asks: one typed into a drill's manager would be a message it didn't send.
    laneEvents: { deliverTo: null, header: "[lane-event] Lane events (handle them as your instructions say):", ignore: [], batchMs: 3000 },
  };
```

- [ ] **Step 4: Run it and see it pass**

Run: `npx vitest run apps/fleet/test/config.test.ts`
Expected: PASS (7 tests)

Run: `npx tsc -p apps/fleet && npx tsc -p tsconfig.tests.json`
Expected: exit 0, nothing printed

- [ ] **Step 5: Commit**

```bash
git add apps/fleet/src/config.ts apps/fleet/test/config.test.ts apps/fleet/test/helpers/fleet.ts test/fleet-harness.ts
git commit -m "feat(fleet): lane events' settings in the fleet's config"
```

- [ ] **Step 6: Write the failing tests for building lane events and the manager's message**

Create `apps/fleet/test/lane-events.test.ts`:

```ts
// Lane events from hooks (fleet clients spec §6, §7): both body forms (Claude Code's and the owner's scripts'), kira's
// STATUS rule, first line, error and question rules, verbatim; none without a window, for the manager's own lane or an
// ignored one; today's JSON line shape, key order included; a batch split at 8000 characters (Review Focus 4).
import { describe, expect, it } from "vitest";
import type { HookEvent, LaneEvent } from "@morndo/protocol";
import { firstLineOf, globMatcher, laneEventOf, lineOf, partsOf, rulesOf, statusOf } from "../src/application/lane-events.ts";

const AT = Date.parse("2026-10-08T17:17:06.086Z");
const SID = "45460920-67e6-4bea-8c1d-2f3a4b5c6d7e";
const hook = (path: HookEvent["path"], body: unknown, window: string | null = "studio"): HookEvent =>
  ({ streamId: "3f0c1d2e-1111-4222-8333-444455556666", seq: 1, at: AT, path, node: "pc", window, body });
const RULES = rulesOf({ deliverTo: "manager", header: "h", ignore: ["pooltest*", "pool-probe*"], batchMs: 3000 });
const base = { v: 1, t: "lane", node: "pc", window: "studio", lane: "studio", at: AT, sessionId: SID };

describe("lane events from hooks", () => {
  it("finished from Claude Code's Stop body: the first line, its status, background tasks and crons counted", () => {
    const body = { session_id: SID, hook_event_name: "Stop", last_assistant_message: "\n  \n  STATUS: DONE — the parser ships\nmore", background_tasks: [{}, {}], session_crons: [{}] };
    expect(laneEventOf(hook("/hook/stop", body), RULES)).toEqual({ ...base, event: "finished", status: "done", firstLine: "STATUS: DONE — the parser ships", bg: 2, crons: 1 });
  });

  it("finished from the owner's Stop script body: text, background and crons as numbers", () => {
    const body = { window: "studio", cwd: "/w", session_id: SID, branch: "main", changed: 1, ahead: 0, text: "Plain answer.", background: 1, crons: 0 };
    expect(laneEventOf(hook("/hook/stop", body), RULES)).toEqual({ ...base, event: "finished", status: null, firstLine: "Plain answer.", bg: 1, crons: 0 });
    expect(laneEventOf(hook("/hook/stop", { session_id: SID }), RULES)).toEqual({ ...base, event: "finished", status: null, firstLine: "", bg: 0, crons: 0 });
  });

  it("kira's STATUS rule, verbatim, on the first line", () => {
    const cases: [string, string | null][] = [
      ["STATUS: DONE", "done"], ["status: done.", "done"], ["**STATUS: BLOCKED** on review", "blocked"], ["> STATUS - NEEDS DECISION", "needs_decision"],
      ["_STATUS_:needs decision", "needs_decision"], ["STATUS:DONE", "done"], ["STATUS: DONEish", null], ["The STATUS: DONE", null],
      ["STATUS: NEEDS  DECISION", null], ["STATUS: blocked, waiting", "blocked"], ["", null],
    ];
    for (const [line, status] of cases) expect(statusOf(line), line).toBe(status);
    expect(firstLineOf("\n\n   first  \nsecond")).toBe("first");
    expect(firstLineOf(`${"x".repeat(250)}\nsecond`)).toHaveLength(200);
  });

  it("stop_failure from either form: error_type, else error, else unknown, at most 60 characters", () => {
    expect(laneEventOf(hook("/hook/failure", { session_id: SID, hook_event_name: "StopFailure", error_type: "rate_limit" }), RULES)).toEqual({ ...base, event: "stop_failure", error: "rate_limit" });
    expect(laneEventOf(hook("/hook/failure", { window: "studio", session_id: SID, error: "overloaded" }), RULES)).toMatchObject({ error: "overloaded" });
    expect(laneEventOf(hook("/hook/failure", { session_id: SID }), RULES)).toMatchObject({ error: "unknown" });
    expect(laneEventOf(hook("/hook/failure", { error: "e".repeat(90) }), RULES)).toMatchObject({ error: "e".repeat(60) });
  });

  it("needs_input and answered from a node's /lane event; the question at most 200 characters; another event name makes none", () => {
    expect(laneEventOf(hook("/lane", { event: "needs_input", sessionId: SID, question: "Which branch?" }), RULES)).toEqual({ ...base, event: "needs_input", question: "Which branch?" });
    expect(laneEventOf(hook("/lane", { event: "needs_input", sessionId: null, question: "q".repeat(300) }), RULES)).toEqual({ v: 1, t: "lane", node: "pc", window: "studio", lane: "studio", at: AT, event: "needs_input", question: "q".repeat(200) });
    expect(laneEventOf(hook("/lane", { event: "answered", sessionId: SID }), RULES)).toEqual({ ...base, event: "answered" });
    expect(laneEventOf(hook("/lane", { event: "exploded", sessionId: SID }), RULES)).toBeNull();
  });

  it("none for a hook without a window, the manager's own lane, an ignored lane, or another path", () => {
    expect(laneEventOf(hook("/hook/stop", { text: "x" }, null), RULES)).toBeNull();
    expect(laneEventOf(hook("/hook/stop", { text: "x" }, "manager"), RULES)).toBeNull();
    expect(laneEventOf(hook("/hook/stop", { text: "x" }, "pooltest-3"), RULES)).toBeNull();
    expect(laneEventOf(hook("/hook/stop", { text: "x" }, "pool-probe"), RULES)).toBeNull();
    expect(laneEventOf(hook("/hook/stop", { text: "x" }, "pool"), RULES)).not.toBeNull();
    expect(laneEventOf(hook("/cc", { session_id: SID }), RULES)).toBeNull();
    expect(laneEventOf(hook("/notify", "words"), RULES)).toBeNull();
    expect(laneEventOf(hook("/hook/stop", { text: "x" }, "manager"), rulesOf({ deliverTo: null, header: "h", ignore: [], batchMs: 3000 }))).not.toBeNull();
  });

  it("globs: * any run, ? one character, everything else literal", () => {
    expect(["pooltest", "pooltest-1", "x"].map(n => globMatcher("pooltest*").test(n))).toEqual([true, true, false]);
    expect(["a.b", "axb"].map(n => globMatcher("a.b").test(n))).toEqual([true, false]);
    expect(["lane-1", "lane-12"].map(n => globMatcher("lane-?").test(n))).toEqual([true, false]);
  });
});

describe("the manager's message", () => {
  const ev = (seq: number, over: Partial<LaneEvent> = {}): LaneEvent =>
    ({ v: 1, t: "lane", seq, node: "pc", window: "studio", lane: "studio", sessionId: SID, at: AT, event: "finished", status: "done", firstLine: "STATUS: DONE", bg: 0, crons: 0, ...over });

  it("one JSON line per event in today's shape, key order included", () => {
    expect(lineOf(ev(1))).toBe(`{"ts":"2026-10-08T17:17:06.086Z","lane":"studio","sessionId":"${SID}","event":"finished","status":"done","firstLine":"STATUS: DONE","bg":0,"crons":0}`);
    expect(lineOf(ev(2, { event: "needs_input", question: "Which?", status: undefined as never }))).toBe(`{"ts":"2026-10-08T17:17:06.086Z","lane":"studio","sessionId":"${SID}","event":"needs_input","question":"Which?"}`);
    const { sessionId: _, ...noSession } = ev(3, { event: "stop_failure", error: "rate_limit" });
    expect(lineOf(noSession)).toBe('{"ts":"2026-10-08T17:17:06.086Z","lane":"studio","event":"stop_failure","error":"rate_limit"}');
  });

  it("splits a batch over 8000 characters into parts of at most 8000, each with the header, in order (Review Focus 4)", () => {
    const header = "[lane-event] Lane events (handle them as your instructions say):";
    const events = Array.from({ length: 60 }, (_, i) => ev(i + 1, { firstLine: `${i} ${"w".repeat(195)}` }));
    const parts = partsOf(events, header);
    expect(parts.length).toBeGreaterThan(1);                                          // negative control: one part of ~20,000
    for (const p of parts) {
      expect(p.text.length).toBeLessThanOrEqual(8000);
      expect(p.text.split("\n")[0]).toBe(header);
      expect(p.text.split("\n").slice(1)).toEqual(p.events.map(lineOf));
    }
    expect(parts.flatMap(p => p.events.map(e => e.seq))).toEqual(events.map(e => e.seq));
    expect(partsOf(events.slice(0, 3), header)).toHaveLength(1);
  });
});
```

- [ ] **Step 7: Run them and see them fail**

Run: `npx vitest run apps/fleet/test/lane-events.test.ts`
Expected: FAIL: `Error: Cannot find module '../src/application/lane-events.ts'`

- [ ] **Step 8: Implement the store and the builder**

Create `apps/fleet/src/adapters/lane-events-store.ts`:

```ts
// Lane events (fleet clients spec §7) in fleet.db's lane_events (migration 5): written in the intake's synced commit
// with the hooks they come from (insert), read by GET /v1/lane-events (since) and by the manager's batches (waiting).
// to_manager: 0 waiting for the manager, 1 in a delivery its node stored (delivery_id names it), NULL not for the
// manager. The marks are not synced (spec §6): one a power loss takes back sends those events once more.
import type Database from "better-sqlite3";
import type { LaneEvent, LaneEventName } from "@morndo/protocol";

export type LaneEventDraft = Omit<LaneEvent, "seq">;
type Row = {
  seq: number; node: string; window: string | null; lane: string | null; session_id: string | null; event: LaneEventName; at: number; body: string;
};
// The fields of each event beyond the columns, as the body column keeps them.
const BODY_FIELDS = ["status", "firstLine", "bg", "crons", "question", "error"] as const;
const eventOf = (r: Row): LaneEvent => ({
  v: 1, t: "lane", seq: r.seq, event: r.event, node: r.node, window: r.window, lane: r.lane,
  ...(r.session_id === null ? {} : { sessionId: r.session_id }), at: r.at, ...(JSON.parse(r.body) as Partial<LaneEvent>),
});
const COLUMNS = "seq, node, window, lane, session_id, event, at, body";

export class LaneEventsStore {
  #db: Database.Database;
  constructor(db: Database.Database) { this.#db = db; }

  insert(d: LaneEventDraft, toManager: 0 | null): LaneEvent {
    const body = Object.fromEntries(BODY_FIELDS.filter(k => d[k] !== undefined).map(k => [k, d[k]]));
    const r = this.#db.prepare("INSERT INTO lane_events (node, window, lane, session_id, event, at, body, to_manager) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(d.node, d.window, d.lane, d.sessionId ?? null, d.event, d.at, JSON.stringify(body), toManager);
    return { ...d, seq: Number(r.lastInsertRowid) };
  }

  // Events after `seq`, oldest first, at most `limit`.
  since(seq: number, limit: number): LaneEvent[] {
    return (this.#db.prepare(`SELECT ${COLUMNS} FROM lane_events WHERE seq > ? ORDER BY seq LIMIT ?`).all(seq, limit) as Row[]).map(eventOf);
  }

  // A session's latest lane event, by name; null when it has none (lane_events_by_session: "x=?" lets SQLite use a partial
  // index on "x IS NOT NULL", https://www.sqlite.org/partialindex.html, read 2026-10-08).
  lastOf(sessionId: string): LaneEventName | null {
    const r = this.#db.prepare("SELECT event FROM lane_events WHERE session_id = ? ORDER BY seq DESC LIMIT 1").get(sessionId) as { event: LaneEventName } | undefined;
    return r?.event ?? null;
  }

  // Events waiting for the manager, oldest first, at most `limit`.
  waiting(limit: number): LaneEvent[] {
    return (this.#db.prepare(`SELECT ${COLUMNS} FROM lane_events WHERE to_manager = 0 ORDER BY seq LIMIT ?`).all(limit) as Row[]).map(eventOf);
  }

  markSent(seqs: number[], deliveryId: string): void {
    this.#db.prepare("UPDATE lane_events SET to_manager = 1, delivery_id = ? WHERE seq IN (SELECT value FROM json_each(?)) AND to_manager = 0")
      .run(deliveryId, JSON.stringify(seqs));
  }

  // The events of a delivery that was given up wait for the manager again; returns how many.
  requeue(deliveryId: string): number {
    return this.#db.prepare("UPDATE lane_events SET to_manager = 0, delivery_id = NULL WHERE delivery_id = ? AND to_manager = 1").run(deliveryId).changes;
  }

  // The deliveries that carry events marked sent.
  sentIn(): string[] {
    return (this.#db.prepare("SELECT DISTINCT delivery_id FROM lane_events WHERE to_manager = 1 AND delivery_id IS NOT NULL").all() as { delivery_id: string }[])
      .map(r => r.delivery_id);
  }

  prune(before: number): number {
    return this.#db.prepare("DELETE FROM lane_events WHERE at < ?").run(before).changes;
  }
}
```

Create `apps/fleet/src/application/lane-events.ts`:

```ts
// Lane events (fleet clients spec §7): what a lane did that its manager and its clients act on, built by the fleet per
// node and window from the hook stream:
//   finished      /hook/stop: status (kira's STATUS rule on the answer's first line), firstLine, bg, crons
//   stop_failure  /hook/failure: error
//   needs_input   /lane (the node saw the session's status turn `waiting`): question
//   answered      /lane (it left `waiting`)
// Each hook body is read in either form (spec §6): Claude Code's own (last_assistant_message, background_tasks and
// session_crons as arrays, error_type) or the owner's scripts' (text, background and crons as counts, error). kira's
// rules are kept as they are (emit, firstLine, statusOf, onFailure, read 2026-10-08): the first non-blank
// line, trimmed, at most 200 characters; the status from it; an error at most 60 characters, "unknown" when none; a
// question at most 200. A hook without a window makes none (kira's `if (!win) return`), nor does the manager's own lane
// (laneEvents.deliverTo) or a lane whose name matches a glob of laneEvents.ignore.
// Inside the intake's synced commit (`take`, called for each hook above its stream's mark, so a replayed hook never
// makes a second event) each event is stored, waiting for the manager unless it is `answered` or no lane takes them
// (deliverTo null: never delivered later either, so turning delivery on sends only what comes after; reconciliation ruling
// 23). A `needs_input` for a session whose latest lane event is a `needs_input` (its node restarted and reports the same
// menu again) is dropped (ruling 18). Once that commit is on the disk (`committed`), each is published on /v1/events as `lane`, and the
// manager's batch is kicked. Kept LIMITS.laneEventKeepMs (7 days) by their time on the node, pruned on start and hourly.
// Hook fields: https://code.claude.com/docs/en/hooks (Stop: last_assistant_message, background_tasks [], session_crons [];
// StopFailure: error_type), read 2026-10-08.
import { LIMITS, type HookEvent, type LaneEvent } from "@morndo/protocol";
import type { LaneEventsConfig } from "../config.ts";
import type { LaneEventDraft, LaneEventsStore } from "../adapters/lane-events-store.ts";
import type { Logger } from "../adapters/log.ts";
import type { EventHub } from "./events.ts";

// kira's rule, verbatim (kira.ts statusOf).
export const STATUS_RULE = /^[\W_]*STATUS[\W_]*:?[\W_]*(DONE|BLOCKED|NEEDS DECISION)\b/i;
export const firstLineOf = (text: string): string => (text.split("\n").find(l => l.trim()) ?? "").trim().slice(0, 200);
export const statusOf = (line: string): "done" | "blocked" | "needs_decision" | null =>
  (STATUS_RULE.exec(line)?.[1]?.toLowerCase().replace(" ", "_") ?? null) as "done" | "blocked" | "needs_decision" | null;
// A glob on a lane name: `*` any run of characters, `?` one; everything else as it is.
export const globMatcher = (glob: string): RegExp =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "su");

export type LaneEventRules = { manager: string | null; ignore: RegExp[] };
export const rulesOf = (c: LaneEventsConfig): LaneEventRules => ({ manager: c.deliverTo, ignore: c.ignore.map(globMatcher) });

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// A count from either form: Claude Code's arrays, the owner's numbers.
const countOf = (v: unknown): number => (Array.isArray(v) ? v.length : Number.isFinite(Number(v)) ? Math.max(0, Math.trunc(Number(v))) : 0);
// A text field: a string as it is, a number or a boolean written out, anything else none.
const textOf = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : "");

// The lane event a hook makes, or null.
export function laneEventOf(e: HookEvent, rules: LaneEventRules): LaneEventDraft | null {
  if (e.path !== "/hook/stop" && e.path !== "/hook/failure" && e.path !== "/lane") return null;
  const lane = e.window;
  if (lane === null || lane === "" || lane === rules.manager || rules.ignore.some(g => g.test(lane))) return null;
  const b = isObject(e.body) ? e.body : {};
  const sid = e.path === "/lane" ? b.sessionId : b.session_id;
  const base = { v: 1 as const, t: "lane" as const, node: e.node, window: e.window, lane, at: e.at, ...(typeof sid === "string" && SESSION_ID.test(sid) ? { sessionId: sid } : {}) };
  if (e.path === "/hook/stop") {
    const first = firstLineOf(textOf(b.last_assistant_message ?? b.text).trim());
    return { ...base, event: "finished", status: statusOf(first), firstLine: first, bg: countOf(b.background_tasks ?? b.background), crons: countOf(b.session_crons ?? b.crons) };
  }
  if (e.path === "/hook/failure") return { ...base, event: "stop_failure", error: textOf(b.error_type ?? b.error ?? "unknown").slice(0, 60) || "unknown" };
  if (b.event === "answered") return { ...base, event: "answered" };
  if (b.event === "needs_input") return { ...base, event: "needs_input", ...(typeof b.question === "string" ? { question: b.question.slice(0, 200) } : {}) };
  return null;
}

// One line of the manager's message, in today's shape (lane-events-push and kira's events.jsonl, key order included):
// { ts, lane, sessionId, event, … }, then status, firstLine, bg, crons for `finished`, question or error for the others.
export function lineOf(e: LaneEvent): string {
  return JSON.stringify({
    ts: new Date(e.at).toISOString(), lane: e.lane, ...(e.sessionId === undefined ? {} : { sessionId: e.sessionId }), event: e.event,
    ...(e.event === "finished" ? { status: e.status ?? null, firstLine: e.firstLine ?? "", bg: e.bg ?? 0, crons: e.crons ?? 0 } : {}),
    ...(e.question === undefined ? {} : { question: e.question }), ...(e.error === undefined ? {} : { error: e.error }),
  });
}

// A batch's parts (Review Focus 4): each the header and as many lines as fit in `max` characters, in order.
export function partsOf(events: LaneEvent[], header: string, max: number = LIMITS.maxSendText): { events: LaneEvent[]; text: string }[] {
  const parts: { events: LaneEvent[]; text: string }[] = [];
  let cur: { events: LaneEvent[]; text: string } | null = null;
  for (const e of events) {
    const line = lineOf(e);
    if (cur && cur.text.length + 1 + line.length <= max) { cur.events.push(e); cur.text += `\n${line}`; continue; }
    cur = { events: [e], text: `${header}\n${line}` };
    parts.push(cur);
  }
  return parts;
}

const PRUNE_EVERY_MS = 3_600_000;
export const SINCE_MAX = 1000;                           // GET /v1/lane-events: at most 1000 per answer

export class LaneEvents {
  #store: LaneEventsStore;
  #events: EventHub;
  #rules: LaneEventRules;
  #toManager: boolean;
  #onWaiting: () => void;
  #log: Logger;
  #now: () => number;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(p: { store: LaneEventsStore; events: EventHub; config: LaneEventsConfig; log: Logger; onWaiting?: () => void; now?: () => number }) {
    this.#store = p.store;
    this.#events = p.events;
    this.#rules = rulesOf(p.config);
    this.#toManager = p.config.deliverTo !== null;
    this.#onWaiting = p.onWaiting ?? (() => {});
    this.#log = p.log;
    this.#now = p.now ?? Date.now;
  }

  // Inside the intake's transaction: stores the lane event `e` makes, if any. `own`: the hook is the fleet's own (a
  // node's /lane), so it is never counted as unrouted.
  take(e: HookEvent): { event: LaneEvent | null; own: boolean } {
    const own = e.path === "/lane";
    const d = laneEventOf(e, this.#rules);
    if (!d) return { event: null, own };
    if (d.event === "needs_input" && d.sessionId !== undefined && this.#store.lastOf(d.sessionId) === "needs_input") return { event: null, own };
    return { event: this.#store.insert(d, this.#toManager && d.event !== "answered" ? 0 : null), own };
  }

  // After the commit that stored them.
  committed(fresh: LaneEvent[]): void {
    for (const le of fresh) this.#events.emit({ t: "lane", node: le.node, body: le });
    if (this.#toManager && fresh.some(le => le.event !== "answered")) this.#onWaiting();
  }

  since(seq: number): LaneEvent[] { return this.#store.since(seq, SINCE_MAX); }

  start(): void {
    this.#prune();
    this.#timer = setInterval(() => this.#prune(), PRUNE_EVERY_MS);
  }

  stop(): void { if (this.#timer) clearInterval(this.#timer); this.#timer = null; }

  prune(): number { return this.#store.prune(this.#now() - LIMITS.laneEventKeepMs); }

  #prune(): void {
    try { const n = this.prune(); if (n > 0) this.#log.info(`lane events: removed ${n} older than 7 days`); }
    catch (e) { this.#log.error("lane events: removing old ones failed (fleet.db busy or full?); trying again in an hour", e); }
  }
}
```

- [ ] **Step 9: Run them and see them pass**

Run: `npx vitest run apps/fleet/test/lane-events.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 10: Commit**

```bash
git add apps/fleet/src/adapters/lane-events-store.ts apps/fleet/src/application/lane-events.ts apps/fleet/test/lane-events.test.ts
git commit -m "feat(fleet): lane events built from hooks by kira's rules, and the manager's message"
```

- [ ] **Step 11: Write the failing tests for lane events in the intake**

Create `apps/fleet/test/lane-events-intake.test.ts`:

```ts
// Lane events in the intake (fleet clients spec §6, §7): made in the same synced commit as the hook they come from,
// published as `lane` once it is on the disk, never twice for a replayed hook; a node's /lane events are the fleet's own
// (never counted as unrouted); `answered` and a fleet without deliverTo leave nothing waiting for the manager;
// GET /v1/lane-events?since= pages them; kept 7 days.
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LIMITS, type HookEvent, type LaneEvent } from "@morndo/protocol";
import type { LaneEventsConfig } from "../src/config.ts";
import { Audit } from "../src/adapters/audit.ts";
import { openFleetDb, synced } from "../src/adapters/db.ts";
import { LaneEventsStore } from "../src/adapters/lane-events-store.ts";
import { OutboxStore } from "../src/adapters/outbox-store.ts";
import { EventHub, type FleetEvent } from "../src/application/events.ts";
import { HookIntake } from "../src/application/hook-intake.ts";
import { IntakeWindow } from "../src/application/intake-window.ts";
import { LaneEvents } from "../src/application/lane-events.ts";
import { quiet, startTestFleet } from "./helpers/fleet.ts";
import { tempDir } from "./helpers/temp.ts";
import { client } from "./helpers/socket-client.ts";
import { FULL_THEN_NORMAL, watchSyncs } from "./helpers/syncs.ts";

const HEADER = "[lane-event] Lane events (handle them as your instructions say):";
const TO_MANAGER: LaneEventsConfig = { deliverTo: "manager", header: HEADER, ignore: [], batchMs: 60_000 };
const SID = "45460920-67e6-4bea-8c1d-2f3a4b5c6d7e";
type Row = { seq: number; event: string; lane: string; to_manager: number | null };
const rows = (db: { prepare(sql: string): { all(): unknown[] } }) => db.prepare("SELECT seq, event, lane, to_manager FROM lane_events ORDER BY seq").all() as Row[];

describe("lane events in the intake", () => {
  it("a Stop hook makes its lane event in the hook's own synced commit, published after it; a replayed hook makes none", async () => {
    const fleet = await startTestFleet({ config: { laneEvents: TO_MANAGER } });
    const pc = await fleet.online("pc");
    const events = await client(fleet.config.socketPath).events();
    const syncs = watchSyncs(fleet.db);
    pc.hook(1, "/hook/stop", { session_id: SID, last_assistant_message: "STATUS: BLOCKED on review" }, { window: "api" });
    expect(await pc.acked(1)).toBe(1);
    expect(syncs).toEqual(FULL_THEN_NORMAL);                                          // one commit: the hook and its lane event
    expect(rows(fleet.db)).toEqual([{ seq: 1, event: "finished", lane: "api", to_manager: 0 }]);
    await vi.waitFor(() => expect(events.received.filter(e => e.t === "lane")).toHaveLength(1));
    expect(events.received.find(e => e.t === "lane")).toEqual({ t: "lane", node: "pc", body: {
      v: 1, t: "lane", seq: 1, event: "finished", node: "pc", window: "api", lane: "api", sessionId: SID, at: 1_700_000_000_001,
      status: "blocked", firstLine: "STATUS: BLOCKED on review", bg: 0, crons: 0,
    } });
    pc.hook(1, "/hook/stop", { session_id: SID, text: "again" }, { window: "api" });  // a replay after a lost ack
    pc.hook(2, "/cc", { session_id: SID }, { window: "api" });
    expect(await pc.acked(2)).toBe(2);
    expect(rows(fleet.db)).toHaveLength(1);                                            // negative control: built before the mark, 2
    events.close();
  });

  it("a node's /lane events are the fleet's own, never unrouted; answered is published but never waits for the manager", async () => {
    const fleet = await startTestFleet({ config: { laneEvents: TO_MANAGER } });
    const pc = await fleet.online("pc");
    pc.hook(1, "/lane", { event: "needs_input", sessionId: SID, question: "Which branch?" }, { window: "web" });
    pc.hook(2, "/lane", { event: "answered", sessionId: SID }, { window: "web" });
    expect(await pc.acked(2)).toBe(2);
    expect(rows(fleet.db)).toEqual([{ seq: 1, event: "needs_input", lane: "web", to_manager: 0 }, { seq: 2, event: "answered", lane: "web", to_manager: null }]);
    expect(fleet.outbox.unrouted()).toEqual([]);                                       // negative control: counted as unrouted /lane
  });

  it("a needs_input the session's last lane event already is (an agent restart reports the menu again) is dropped; after answered, the next is kept", async () => {
    const fleet = await startTestFleet({ config: { laneEvents: TO_MANAGER } });
    const pc = await fleet.online("pc");
    const ask = { event: "needs_input", sessionId: SID, question: "Which branch?" };
    pc.hook(1, "/lane", ask, { window: "web" });
    pc.hook(2, "/lane", ask, { window: "web" });                                     // the node restarted: the same menu again
    pc.hook(3, "/lane", { event: "needs_input", sessionId: "other-session", question: "Merge?" }, { window: "api" });
    pc.hook(4, "/lane", { event: "answered", sessionId: SID }, { window: "web" });
    pc.hook(5, "/lane", ask, { window: "web" });                                     // a new menu, after the answer
    expect(await pc.acked(5)).toBe(5);
    expect(rows(fleet.db).map(r => [r.seq, r.event, r.lane])).toEqual([
      [1, "needs_input", "web"], [2, "needs_input", "api"], [3, "answered", "web"], [4, "needs_input", "web"],   // negative control: 5 rows
    ]);
  });

  it("without deliverTo nothing waits for the manager; every event is still published and kept", async () => {
    const fleet = await startTestFleet();                                              // the test fleet's deliverTo is null
    const pc = await fleet.online("pc");
    pc.hook(1, "/hook/failure", { session_id: SID, error_type: "overloaded" }, { window: "api" });
    expect(await pc.acked(1)).toBe(1);
    expect(rows(fleet.db)).toEqual([{ seq: 1, event: "stop_failure", lane: "api", to_manager: null }]);
  });

  it("GET /v1/lane-events?since= answers after a seq, oldest first, at most 1000; a since that isn't a seq is 400", async () => {
    const fleet = await startTestFleet();
    const pc = await fleet.online("pc");
    for (let seq = 1; seq <= 1005; seq++) pc.hook(seq, "/hook/stop", { text: `turn ${seq}` }, { window: "api" });
    expect(await pc.acked(1005, 10_000)).toBe(1005);
    const page = async (q: string) => ((await client(fleet.config.socketPath).get(`/v1/lane-events${q}`))?.body as { events?: LaneEvent[] } | undefined)?.events ?? [];
    const first = await page("");
    expect([first.length, first[0]?.seq, first.at(-1)?.seq]).toEqual([1000, 1, 1000]);
    expect((await page("?since=1000")).map(e => e.firstLine)).toEqual(["turn 1001", "turn 1002", "turn 1003", "turn 1004", "turn 1005"]);
    expect(await page("?since=1005")).toEqual([]);
    for (const q of ["?since=-1", "?since=abc", "?since=1.5"]) expect(await client(fleet.config.socketPath).get(`/v1/lane-events${q}`), q).toMatchObject({ status: 400 });
  });

  it("an intake commit that fails publishes no lane event and leaves none stored", async () => {
    const db = openFleetDb(join(tempDir(), "fleet.db"));
    const hub = new EventHub();
    const published: FleetEvent[] = [];
    hub.subscribe(e => published.push(e));
    const lanes = new LaneEvents({ store: new LaneEventsStore(db), events: hub, config: TO_MANAGER, log: quiet });
    const intake = new HookIntake({ store: new OutboxStore(db), subscribers: [], audit: new Audit(db), lanes });
    const failing = { synced: <T>(fn: () => T): T => synced(db, () => db.transaction(() => { fn(); throw new Error("disk I/O error"); }).immediate()), savepoint: <T>(fn: () => T): T => db.transaction(fn)() };
    const window = new IntakeWindow({ intake, tx: failing, log: quiet, windowMs: 0 });
    const failed: unknown[] = [];
    const stop: HookEvent = { streamId: "3f0c1d2e-1111-4222-8333-444455556666", seq: 1, at: 1, path: "/hook/stop", node: "pc", window: "api", body: { text: "x" } };
    window.open({ node: "pc", streamId: stop.streamId, acked: () => {}, failed: e => failed.push(e) }).add(stop);
    window.flush();
    expect(failed).toHaveLength(1);
    expect(published).toEqual([]);                                                    // negative control: published inside the commit
    expect(rows(db)).toEqual([]);
    db.close();
  });

  it("keeps lane events 7 days by their time on the node", async () => {
    let now = 1_700_000_000_000;
    const fleet = await startTestFleet({ now: () => now });
    const pc = await fleet.online("pc");
    pc.hook(1, "/hook/stop", { text: "a" }, { window: "api" });
    pc.hook(2, "/hook/stop", { text: "b" }, { window: "api", at: 1_700_000_000_000 + LIMITS.laneEventKeepMs });
    expect(await pc.acked(2)).toBe(2);
    now = 1_700_000_000_002 + LIMITS.laneEventKeepMs;
    expect(fleet.laneEvents.prune()).toBe(1);
    expect(rows(fleet.db).map(r => r.seq)).toEqual([2]);
  });
});
```

- [ ] **Step 12: Run them and see them fail**

Run: `npx vitest run apps/fleet/test/lane-events-intake.test.ts`
Expected: FAIL, 6 of 7: no lane event is stored, `/lane` counts as unrouted, `GET /v1/lane-events` is 404, and `fleet.laneEvents` is undefined. The failed-commit test passes already (nothing is built yet to be published); its control, `fc9-published-after-commit`, shows it bites once something is

- [ ] **Step 13: Make lane events in the intake's commit, and publish them after it**

In `apps/fleet/src/adapters/outbox-store.ts`, replace:

```ts
  // one and counted per path in hook_unrouted, in the same transaction.
```

with:

```ts
  // one and counted per path in hook_unrouted, in the same transaction, unless the fleet takes it itself (`o.taken`, called
  // once for each event above the mark: a lane event's source, fleet clients spec §7; true for a node's own /lane).
```

Then replace:

```ts
  accept(node: string, streamId: string, events: HookEvent[], route: (e: HookEvent) => string[], o: { now: number; cap: number }): Accepted {
```

with:

```ts
  accept(
    node: string, streamId: string, events: HookEvent[], route: (e: HookEvent) => string[], o: { now: number; cap: number; taken?: (e: HookEvent) => boolean },
  ): Accepted {
```

and:

```ts
        seq = e.seq;
        const subscribers = route(e);
        if (subscribers.length === 0) { unrouted.set(e.path, (unrouted.get(e.path) ?? 0) + 1); continue; }
```

with:

```ts
        seq = e.seq;
        const own = o.taken?.(e) ?? false;
        const subscribers = route(e);
        if (subscribers.length === 0) { if (!own) unrouted.set(e.path, (unrouted.get(e.path) ?? 0) + 1); continue; }
```

The fleet core's control `fw-i3-unrouted-not-counted` (its review's I3) finds that line; it keeps its replacement, which still drops the count. In `scripts/negative-controls.ts`, replace:

```ts
    find: "        if (subscribers.length === 0) { unrouted.set(e.path, (unrouted.get(e.path) ?? 0) + 1); continue; }",
```

with:

```ts
    find: "        if (subscribers.length === 0) { if (!own) unrouted.set(e.path, (unrouted.get(e.path) ?? 0) + 1); continue; }",
```

In `apps/fleet/src/application/hook-intake.ts`, replace:

```ts
// back. `accept` is store and commit in one, for a caller with a single batch.
```

with:

```ts
// back. `accept` is store and commit in one, for a caller with a single batch. With `lanes`, each event above its stream's
// mark also makes its lane event in the same transaction (fleet clients spec §7), published once the commit is on disk.
```

Then replace:

```ts
import { LIMITS, type HookEvent } from "@morndo/protocol";
```

with:

```ts
import { LIMITS, type HookEvent, type LaneEvent } from "@morndo/protocol";
```

Then replace:

```ts
import type { Transactions } from "./hook-sink.ts";
```

with:

```ts
import type { Transactions } from "./hook-sink.ts";
import type { LaneEvents } from "./lane-events.ts";
```

Then replace:

```ts
  #tx: Transactions | null;
  #overflowing
```

with:

```ts
  #tx: Transactions | null;
  #lanes: Pick<LaneEvents, "take" | "committed"> | null;
  #overflowing
```

Then replace:

```ts
    store: OutboxStore; subscribers: Subscriber[]; audit: Audit; now?: () => number; cap?: number; onStored?: () => void; tx?: Transactions;
  }) {
```

with:

```ts
    store: OutboxStore; subscribers: Subscriber[]; audit: Audit; now?: () => number; cap?: number; onStored?: () => void; tx?: Transactions;
    lanes?: Pick<LaneEvents, "take" | "committed">;
  }) {
```

Then replace:

```ts
    this.#tx = p.tx ?? null;
  }
```

with:

```ts
    this.#tx = p.tx ?? null;
    this.#lanes = p.lanes ?? null;
  }
```

Then, in `store`, replace:

```ts
    const route = (e: HookEvent) => this.#subscribers.filter(s => s.paths.includes(e.path)).map(s => s.name);
    const r = this.#store.accept(node, streamId, events, route, { now: this.#now(), cap: this.#cap });
    return {
```

with:

```ts
    const route = (e: HookEvent) => this.#subscribers.filter(s => s.paths.includes(e.path)).map(s => s.name);
    const fresh: LaneEvent[] = [];
    const lanes = this.#lanes;
    const taken = lanes ? (e: HookEvent) => { const t = lanes.take(e); if (t.event) fresh.push(t.event); return t.own; } : undefined;
    const r = this.#store.accept(node, streamId, events, route, { now: this.#now(), cap: this.#cap, ...(taken ? { taken } : {}) });
    return {
```

and:

```ts
        if (r.stored > 0) this.#onStored();
      },
```

with:

```ts
        if (r.stored > 0) this.#onStored();
        if (fresh.length > 0) lanes?.committed(fresh);
      },
```

In `apps/fleet/src/application/events.ts`, replace:

```ts
// lane-name conflicts, alerts, and a delivery's latest state (fleet clients spec §4.6; body: Delivery & { stale }). One
// subscriber that throws never keeps the others from hearing an event.
export type FleetEvent = { t: "inventory" | "health" | "status" | "conflict" | "alert" | "delivery"; node: string; body: unknown };
```

with:

```ts
// lane-name conflicts, alerts, a delivery's latest state (fleet clients spec §4.6; body: Delivery & { stale }) and lane
// events (§7; body: LaneEvent). One subscriber that throws never keeps the others from hearing an event.
export type FleetEvent = { t: "inventory" | "health" | "status" | "conflict" | "alert" | "delivery" | "lane"; node: string; body: unknown };
```

In `apps/fleet/src/adapters/client-api.ts`, replace:

```ts
//   POST /v1/deliveries/<id>/cancel    { ok: true, delivery } or { ok: false, error }; 404 { error: "no_such_delivery" } for
//                                      an id the fleet doesn't know
//   WS   /v1/events                    { t: "inventory" | "health" | "status" | "conflict" | "alert" | "delivery", node, body }; a
```

with:

```ts
//   POST /v1/deliveries/<id>/cancel    { ok: true, delivery } or { ok: false, error }; 404 { error: "no_such_delivery" } for
//                                      an id the fleet doesn't know
//   GET  /v1/lane-events?since=<seq>   { events: LaneEvent[] }: after seq (0 when absent), oldest first, at most 1000
//   WS   /v1/events                    { t: "inventory" | "health" | "status" | "conflict" | "alert" | "delivery" | "lane", node, body }; a
```

Then replace:

```ts
import type { Deliveries } from "../application/deliveries.ts";
```

with:

```ts
import type { Deliveries } from "../application/deliveries.ts";
import type { LaneEvents } from "../application/lane-events.ts";
```

Then replace:

```ts
  deliveries: Deliveries;
  eventsBufferBytes?: number;
```

with:

```ts
  deliveries: Deliveries; laneEvents: Pick<LaneEvents, "since">;
  eventsBufferBytes?: number;
```

and add the route: replace

```ts
    if (method === "POST" && s.length === 1 && first === "deliveries") {
```

with:

```ts
    if (method === "GET" && s.length === 1 && first === "lane-events") {
      const since = queryOf(req.url).get("since") ?? "0";
      if (!/^\d{1,15}$/.test(since)) throw new HttpError(400, "since must be a lane event's seq (a whole number, 0 for the oldest kept)");
      return json(res, 200, { events: d.laneEvents.since(Number(since)) });
    }
    if (method === "POST" && s.length === 1 && first === "deliveries") {
```

In `apps/fleet/src/serve.ts`, replace:

```ts
import { LaneDeliveriesStore } from "./adapters/lane-deliveries-store.ts";
```

with:

```ts
import { LaneDeliveriesStore } from "./adapters/lane-deliveries-store.ts";
import { LaneEventsStore } from "./adapters/lane-events-store.ts";
```

Then replace:

```ts
import { IntakeWindow } from "./application/intake-window.ts";
```

with:

```ts
import { IntakeWindow } from "./application/intake-window.ts";
import { LaneEvents } from "./application/lane-events.ts";
```

Then replace:

```ts
  deliveries: Deliveries; agentPort: number;
```

with:

```ts
  deliveries: Deliveries; laneEvents: LaneEvents; agentPort: number;
```

Then replace:

```ts
  const router = new Router({ connections, lanes, audit, log });
```

with:

```ts
  const laneEventsStore = new LaneEventsStore(db);
  const laneEvents = new LaneEvents({ store: laneEventsStore, events, config: config.laneEvents, log, now });
  const router = new Router({ connections, lanes, audit, log });
```

Then replace:

```ts
onStored: () => delivery.kick(), tx,
```

with:

```ts
onStored: () => delivery.kick(), tx, lanes: laneEvents,
```

Then replace:

```ts
events, deliveries, log, ...(o.eventsBufferBytes
```

with:

```ts
events, deliveries, laneEvents, log, ...(o.eventsBufferBytes
```

Then replace:

```ts
  deliveries.start();
```

with:

```ts
  deliveries.start();
  laneEvents.start();
```

Then replace:

```ts
delivery, intake, deliveries, agentPort: agents.port(),
```

with:

```ts
delivery, intake, deliveries, laneEvents, agentPort: agents.port(),
```

and in `close`:

```ts
      deliveries.stop();
      connections.stop();
```

with:

```ts
      deliveries.stop();
      laneEvents.stop();
      connections.stop();
```

- [ ] **Step 14: Run them and see them pass**

Run: `npx vitest run apps/fleet/test/lane-events-intake.test.ts`
Expected: PASS (7 tests)

Run: `npx vitest run apps/fleet && npx tsc -p apps/fleet && npx oxlint apps/fleet`
Expected: PASS (232 tests in 43 files); tsc and oxlint print nothing

- [ ] **Step 15: Commit**

```bash
git add apps/fleet/src/adapters/outbox-store.ts apps/fleet/src/application/hook-intake.ts apps/fleet/src/application/events.ts apps/fleet/src/adapters/client-api.ts apps/fleet/src/serve.ts apps/fleet/test/lane-events-intake.test.ts scripts/negative-controls.ts
git commit -m "feat(fleet): lane events stored in the synced intake and published"
```

- [ ] **Step 16: Write the failing tests for lane events to the manager**

Create `apps/fleet/test/lane-events-push.test.ts`:

```ts
// Lane events delivered to the manager (fleet clients spec §7): batched for batchMs, one delivery to deliverTo with the
// header and one JSON line per event; answered, the manager's own lane and ignored lanes left out; a batch given up goes
// again in the next one under a new id; a batch over 8000 characters as several deliveries (Review Focus 4); events not
// yet delivered when the fleet stops go after its restart, and a stored batch is never sent twice.
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpArgs, Pane } from "@morndo/protocol";
import type { LaneEventsConfig } from "../src/config.ts";
import { createLogger } from "../src/adapters/log.ts";
import { startTestFleet, type TestFleet } from "./helpers/fleet.ts";
import type { FakeAgent } from "./helpers/fake-agent.ts";
import { deliveryOf, nodeQueue } from "./helpers/node-queue.ts";
import { openFleetDb } from "../src/adapters/db.ts";
import { tempDir } from "./helpers/temp.ts";

const HEADER = "[lane-event] Lane events from kira (handle them as the Dispatching work section says):";
const CONFIG: LaneEventsConfig = { deliverTo: "manager", header: HEADER, ignore: ["pooltest*"], batchMs: 100 };
const SID = "45460920-67e6-4bea-8c1d-2f3a4b5c6d7e";
const AT = (seq: number) => 1_700_000_000_000 + seq;                                // FakeAgent.hook's time of seq
const pane = (n: number, window: string): Pane => ({ workerId: `pc.3fa2c1d0.${n}`, window, cwd: "/w", status: "idle", pid: n });
const delivered = (a: FakeAgent) => a.reqs.filter(r => r.op === "lane.deliver").map(r => r.args as OpArgs["lane.deliver"]);
const linesOf = (text: string) => text.split("\n").slice(1).map(l => JSON.parse(l) as Record<string, unknown>);
// The fleet marks a part sent once its node's answer is in, a moment after the node got it.
const marks = (fleet: TestFleet) => fleet.db.prepare("SELECT seq, to_manager, delivery_id FROM lane_events ORDER BY seq").all();
const sentCount = (fleet: TestFleet) => (fleet.db.prepare("SELECT COUNT(*) AS n FROM lane_events WHERE to_manager = 1").get() as { n: number }).n;

async function managerNode(fleet: TestFleet, o: { key?: FakeAgent } = {}): Promise<FakeAgent> {
  const pc = o.key ? fleet.agent({ node: "pc", key: o.key.key, instanceId: o.key.instanceId, streamId: o.key.streamId }) : await fleet.joined("pc");
  expect((await pc.connect()).ok).toBe(true);
  nodeQueue(pc);
  pc.inventory([pane(0, "manager"), pane(1, "api"), pane(2, "web")]);
  await vi.waitFor(() => expect(fleet.lanes.get("manager")).not.toBeNull());
  return pc;
}

describe("lane events to the manager", () => {
  it("one delivery per batch to the manager: the header, then today's lines; answered, the manager's own lane and ignored lanes left out", async () => {
    const fleet = await startTestFleet({ config: { laneEvents: CONFIG } });
    const pc = await managerNode(fleet);
    pc.hook(1, "/hook/stop", { session_id: SID, text: "STATUS: DONE", background: 1, crons: 0 }, { window: "api" });
    pc.hook(2, "/lane", { event: "needs_input", sessionId: SID, question: "Which branch?" }, { window: "web" });
    pc.hook(3, "/lane", { event: "answered", sessionId: SID }, { window: "web" });
    pc.hook(4, "/hook/stop", { text: "the manager's own turn" }, { window: "manager" });
    pc.hook(5, "/hook/stop", { text: "a pool probe" }, { window: "pooltest-1" });
    await vi.waitFor(() => expect(delivered(pc)).toHaveLength(1));
    const [d] = delivered(pc);
    expect(d?.id).toBe(`fleet:lane-events:pc:${AT(1)}`);
    expect(d?.target).toEqual({ lane: "manager", sticky: true });
    expect(d?.text.split("\n")[0]).toBe(HEADER);
    expect(d?.text.split("\n").slice(1)).toEqual([
      `{"ts":"${new Date(AT(1)).toISOString()}","lane":"api","sessionId":"${SID}","event":"finished","status":"done","firstLine":"STATUS: DONE","bg":1,"crons":0}`,
      `{"ts":"${new Date(AT(2)).toISOString()}","lane":"web","sessionId":"${SID}","event":"needs_input","question":"Which branch?"}`,
    ]);
    await vi.waitFor(() => expect(marks(fleet)).toEqual([
      { seq: 1, to_manager: 1, delivery_id: d?.id }, { seq: 2, to_manager: 1, delivery_id: d?.id }, { seq: 3, to_manager: null, delivery_id: null },
    ]));
    expect(fleet.audit.of("delivery.post").map(e => e.detail.client)).toEqual(["fleet"]);
  });

  it("a batch given up goes again in the next batch, under a new id", async () => {
    const fleet = await startTestFleet({ config: { laneEvents: CONFIG } });
    const pc = await managerNode(fleet);
    pc.hook(1, "/hook/stop", { text: "one" }, { window: "api" });
    await vi.waitFor(() => expect(sentCount(fleet)).toBe(1));
    const first = `fleet:lane-events:pc:${AT(1)}`;
    pc.delivery(deliveryOf("pc", first, { target: { lane: "manager" }, state: "given_up", why: "expired" }));
    pc.hook(2, "/hook/stop", { text: "two" }, { window: "api" });
    await vi.waitFor(() => expect(delivered(pc)).toHaveLength(2));
    const again = delivered(pc)[1];
    expect(again?.id).toBe(`${first}.2`);                                             // negative control: not put back, only "two"
    expect(again ? linesOf(again.text).map(l => l.firstLine) : []).toEqual(["one", "two"]);
  });

  it("a batch over 8000 characters goes as several deliveries of at most 8000, each with the header, in order; none refused", async () => {
    const fleet = await startTestFleet({ config: { laneEvents: CONFIG } });
    const pc = await managerNode(fleet);
    for (let seq = 1; seq <= 60; seq++) pc.hook(seq, "/hook/stop", { text: `${seq} ${"w".repeat(195)}` }, { window: "api" });
    await vi.waitFor(() => expect(sentCount(fleet)).toBe(60));
    const parts = delivered(pc);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map(p => p.id)).toEqual(parts.map((_, i) => `fleet:lane-events:pc:${AT(1)}-${i + 1}`));   // one batch: -1, -2 …
    for (const p of parts) { expect(p.text.length).toBeLessThanOrEqual(8000); expect(p.text.split("\n")[0]).toBe(HEADER); }
    expect(parts.flatMap(p => linesOf(p.text).map(l => Number(String(l.firstLine).split(" ")[0])))).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(fleet.audit.of("delivery.post").map(e => e.detail.outcome)).toEqual(parts.map(() => "queued"));
  });

  it("events not delivered while the manager's node is offline go after a fleet restart, with one warning; a stored batch never goes twice", async () => {
    const dir = tempDir();
    const warnings: string[] = [];
    const log = createLogger({ level: "warn", sink: line => warnings.push(line) });
    const before = await startTestFleet({ dir, log, config: { laneEvents: CONFIG } });
    const pc = await managerNode(before);
    await pc.close();                                                                  // the manager's node goes offline
    await vi.waitFor(() => expect(before.connections.status("pc")).toBe("offline"));
    const mac = await before.online("mac");
    mac.hook(1, "/hook/stop", { text: "while pc is away" }, { window: "api", at: Date.now() });   // within 7 days: kept at the restart
    expect(await mac.acked(1)).toBe(1);
    await new Promise(r => setTimeout(r, 450));                                        // several batches, each refused node_offline
    expect(warnings.filter(w => w.includes("not delivered yet"))).toHaveLength(1);
    await before.close();
    const after = await startTestFleet({ dir, config: { laneEvents: CONFIG } });
    const back = await managerNode(after, { key: pc });
    await vi.waitFor(() => expect(delivered(back)).toHaveLength(1));
    expect(linesOf(delivered(back)[0]?.text ?? "").map(l => l.firstLine)).toEqual(["while pc is away"]);
    await vi.waitFor(() => expect(sentCount(after)).toBe(1));                        // its answer is in: marked sent
    await after.close();
    const again = await startTestFleet({ dir, config: { laneEvents: CONFIG } });
    const third = await managerNode(again, { key: pc });
    await new Promise(r => setTimeout(r, 300));
    expect(delivered(third)).toEqual([]);                                              // marked sent: not again
  });

  it("lane events stored while deliverTo was null are never delivered later, once it is turned on", async () => {
    const dir = tempDir();
    const off = await startTestFleet({ dir, config: { laneEvents: { ...CONFIG, deliverTo: null } } });
    const pc = await managerNode(off);
    pc.hook(1, "/hook/stop", { text: "before" }, { window: "api", at: Date.now() });
    expect(await pc.acked(1)).toBe(1);
    await off.close();
    const on = await startTestFleet({ dir, config: { laneEvents: CONFIG } });         // rollout step 3b
    const back = await managerNode(on, { key: pc });
    back.hook(2, "/hook/stop", { text: "after" }, { window: "api", at: Date.now() });
    await vi.waitFor(() => expect(delivered(back)).toHaveLength(1));
    await new Promise(r => setTimeout(r, 300));
    expect(delivered(back).flatMap(d => linesOf(d.text).map(l => l.firstLine))).toEqual(["after"]);   // negative control: "before" too
  });

  it("a batch given up while the fleet was down goes again after its start", async () => {
    const dir = tempDir();
    const before = await startTestFleet({ dir, config: { laneEvents: CONFIG } });
    const pc = await managerNode(before);
    pc.hook(1, "/hook/stop", { text: "one" }, { window: "api", at: Date.now() });
    await vi.waitFor(() => expect(sentCount(before)).toBe(1));
    const id = delivered(pc)[0]?.id ?? "";
    await before.close();
    const db = openFleetDb(join(dir, "fleet.db"));                                    // the mirror says given up; the requeue was lost
    db.prepare("UPDATE lane_deliveries SET state = 'given_up', body = json_set(body, '$.state', 'given_up', '$.why', 'expired') WHERE id = ?").run(id);
    db.close();
    const after = await startTestFleet({ dir, config: { laneEvents: CONFIG } });
    const back = await managerNode(after, { key: pc });
    await vi.waitFor(() => expect(delivered(back)).toHaveLength(1));
    expect(delivered(back)[0]?.id).toBe(`${id}.2`);                                   // negative control: no check at start, nothing
    expect(linesOf(delivered(back)[0]?.text ?? "").map(l => l.firstLine)).toEqual(["one"]);
  });
});
```

- [ ] **Step 17: Run them and see them fail**

Run: `npx vitest run apps/fleet/test/lane-events-push.test.ts`
Expected: FAIL, all 6: nothing is delivered to the manager (`expected [] to have a length of 1 but got +0`)

- [ ] **Step 18: Implement the batches**

Create `apps/fleet/src/application/lane-events-push.ts`:

```ts
// Lane events delivered to the manager (fleet clients spec §7; following ~/.local/bin/lane-events-push, read
// 2026-10-08, which it retires): every laneEvents.batchMs after the first waiting event, everything waiting goes as
// deliveries (application/deliveries.ts) to the lane laneEvents.deliverTo, as the client "fleet":
// - the text: the header line, then one JSON line per event in today's shape (lane-events.ts lineOf), oldest first;
// - split into parts of at most LIMITS.maxSendText (8000) characters, each with the header, in order, when a batch is
//   longer (after a long outage; Review Focus 4): none is refused too_large;
// - the id (reconciliation ruling 6): `fleet:lane-events:<node>:<time>`, the node and the time (ms, the node's clock) of
//   the batch's first event; a batch split into parts gives them `-1`, `-2` … An id already used (one this process sent,
//   or one the mirror knows: a part given up, whose events come again first in the next batch) takes a suffix `.2`, `.3`
//   …, so it is a new delivery. A batch refused before anything was stored goes again under the same ids when nothing
//   came meanwhile; a part whose answer was lost goes again under a new id (at least once);
// - a part the node stored is marked sent with its id (not synced: a mark lost to a power loss sends it once more); a
//   part refused (no manager yet, its node offline) leaves it and every later part waiting, tried again after batchMs,
//   with one warning per episode;
// - a part whose delivery is given up (`expired`, `cancelled`, `gone`, `refused`) waits again and goes in the next
//   batch; at start, the same for every part given up while the fleet was down. `answered` is never delivered.
import type { Delivery } from "@morndo/protocol";
import type { LaneEventsConfig } from "../config.ts";
import type { LaneEventsStore } from "../adapters/lane-events-store.ts";
import type { Logger } from "../adapters/log.ts";
import type { Answer, DeliveryRequest } from "./deliveries.ts";
import { partsOf } from "./lane-events.ts";

export const ID_PREFIX = "fleet:lane-events:";
// What the batches need of the deliveries (application/deliveries.ts).
export type DeliveriesPort = { post(r: DeliveryRequest, client: string): Promise<Answer>; get(id: string): { delivery: Delivery } | null };
const READ_MAX = 5000;                                   // waiting events read per batch; the rest go in the next one

export class LaneEventsPush {
  #store: LaneEventsStore;
  #deliveries: DeliveriesPort;
  #config: LaneEventsConfig;
  #log: Logger;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running: Promise<void> | null = null;
  #used = new Set<string>();                             // ids taken in this process
  #refused = false;                                       // warned for this episode of refusals
  #stopped = false;

  constructor(p: { store: LaneEventsStore; deliveries: DeliveriesPort; config: LaneEventsConfig; log: Logger }) {
    this.#store = p.store;
    this.#deliveries = p.deliveries;
    this.#config = p.config;
    this.#log = p.log;
  }

  start(): void {
    if (this.#config.deliverTo === null) return;
    try {
      for (const id of this.#store.sentIn()) if (this.#deliveries.get(id)?.delivery.state === "given_up") this.#store.requeue(id);
      if (this.#store.waiting(1).length > 0) this.kick();
    } catch (e) { this.#log.error("lane events: looking for batches to send failed (fleet.db busy?); the next lane event tries again", e); }
  }

  // Waits for a batch being sent (the service settles every request first, so its answer comes at once), which marks
  // what its node stored; fleet.db closes after this.
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    await this.#running;
  }

  // New events wait: a batch in batchMs, unless one is due or being sent.
  kick(): void {
    if (this.#stopped || this.#config.deliverTo === null || this.#timer !== null) return;
    this.#timer = setTimeout(() => { this.#timer = null; void this.flush(); }, this.#config.batchMs);
  }

  // A mirror change of one of ours: given up, its events wait again (the next batch).
  delivery(d: Delivery): void {
    if (!d.id.startsWith(ID_PREFIX) || d.state !== "given_up") return;
    try { if (this.#store.requeue(d.id) > 0) this.kick(); }
    catch (e) { this.#log.error(`lane events: putting back the events of ${d.id} failed (fleet.db busy?)`, e); }
  }

  // Sends what waits now (the timer, or a test).
  flush(): Promise<void> {
    this.#running ??= this.#send().finally(() => { this.#running = null; });
    return this.#running;
  }

  async #send(): Promise<void> {
    const to = this.#config.deliverTo;
    if (to === null || this.#stopped) return;
    let left = false;
    try {
      const waiting = this.#store.waiting(READ_MAX);
      left = waiting.length === READ_MAX;
      const first = waiting[0];
      if (!first) return;
      const base = `${ID_PREFIX}${first.node}:${first.at}`;
      const parts = partsOf(waiting, this.#config.header);
      for (const [i, part] of parts.entries()) {
        const id = this.#idFor(parts.length > 1 ? `${base}-${i + 1}` : base);
        const answer = await this.#deliveries.post({ id, lane: to, text: part.text }, "fleet");
        if (!answer.ok) {
          if (answer.error.code === "id_conflict") this.#used.add(id);   // the mirror lost it: the next try takes another
          if (!this.#refused) this.#log.warn(`lane events: ${part.events.length} for ${to} not delivered yet (${answer.error.code}: ${answer.error.message}); trying again every ${this.#config.batchMs} ms`);
          this.#refused = true;
          left = true;
          break;
        }
        this.#refused = false;
        this.#used.add(id);
        this.#store.markSent(part.events.map(e => e.seq), id);
        if (answer.delivery.state === "given_up") { this.#store.requeue(id); left = true; }
        if (this.#stopped) return;                         // stopping: the rest go after the restart
      }
    } catch (e) {
      this.#log.error("lane events: sending a batch to the manager failed (fleet.db busy?); trying again", e);
      left = true;
    }
    if (left) this.kick();
  }

  #idFor(base: string): string {
    let id = base;
    for (let n = 2; this.#used.has(id) || this.#deliveries.get(id) !== null; n++) id = `${base}.${n}`;
    return id;
  }
}
```

In `apps/fleet/src/serve.ts`, wire it: the intake kicks it, the mirror's `delivery` events tell it of a part given up,
and `close` settles every request in flight (`connections.stop()`), so a batch being sent gets its answer at once and marks
what its node stored before `fleet.db` closes. Nothing is awaited between `connections.stop()` and `clientApi.close()`:
an await there lets an op's reply flush before the client API closes, and the fleet core's control
`b6-s1-close-all-at-once` would stop biting (it did, in this part's replay, until this order). Replace:

```ts
import type { Pane } from "@morndo/protocol";
```

with:

```ts
import type { Delivery, Pane } from "@morndo/protocol";
```

Then replace:

```ts
import { LaneEvents } from "./application/lane-events.ts";
```

with:

```ts
import { LaneEvents } from "./application/lane-events.ts";
import { LaneEventsPush } from "./application/lane-events-push.ts";
```

Then replace:

```ts
laneEvents: LaneEvents; agentPort: number;
```

with:

```ts
laneEvents: LaneEvents; laneEventsPush: LaneEventsPush; agentPort: number;
```

Then replace:

```ts
  const laneEventsStore = new LaneEventsStore(db);
  const laneEvents = new LaneEvents({ store: laneEventsStore, events, config: config.laneEvents, log, now });
```

with:

```ts
  const laneEventsStore = new LaneEventsStore(db);
  const laneEventsPush = new LaneEventsPush({ store: laneEventsStore, deliveries, config: config.laneEvents, log });
  const laneEvents = new LaneEvents({ store: laneEventsStore, events, config: config.laneEvents, log, now, onWaiting: () => laneEventsPush.kick() });
  events.subscribe(e => { if (e.t === "delivery") laneEventsPush.delivery(e.body as Delivery); });
```

Then replace:

```ts
  laneEvents.start();
```

with:

```ts
  laneEvents.start();
  laneEventsPush.start();
```

Then replace:

```ts
delivery, intake, deliveries, laneEvents, agentPort: agents.port(),
```

with:

```ts
delivery, intake, deliveries, laneEvents, laneEventsPush,
    agentPort: agents.port(),
```

and in `close`:

```ts
      laneEvents.stop();
      connections.stop();
      await clientApi.close();
```

with:

```ts
      laneEvents.stop();
      connections.stop();                              // settles every request in flight, a lane-event batch's too
      const pushing = laneEventsPush.stop();           // its batch marks what its node stored, before fleet.db closes
      await clientApi.close();
      await pushing;
```

- [ ] **Step 19: Run them and see them pass**

Run: `npx vitest run apps/fleet/test/lane-events-push.test.ts`
Expected: PASS (6 tests)

Run: `npx vitest run apps/fleet && npx tsc -p apps/fleet && npx oxlint apps/fleet`
Expected: PASS (238 tests in 44 files); tsc and oxlint print nothing

- [ ] **Step 20: Commit**

```bash
git add apps/fleet/src/application/lane-events-push.ts apps/fleet/src/serve.ts apps/fleet/test/lane-events-push.test.ts
git commit -m "feat(fleet): lane events delivered to the manager in batches, split at 8000 characters"
```

- [ ] **Step 21: Add this task's negative controls to `scripts/negative-controls.ts`**

In `scripts/negative-controls.ts`, insert this task's entries at the end of `CONTROLS`, before its closing `];` (the line before `// ---- the runner`), after whatever entries earlier tasks and lanes added there:

```ts
  // Task 9: lane events built by kira's rules, kept in the synced intake, published, and delivered to the manager.
  { id: "fc9-status-rule", task: "fc9", file: "apps/fleet/src/application/lane-events.ts",
    find: "(DONE|BLOCKED|NEEDS DECISION)\\b/i;",
    replace: "(DONE|BLOCKED|NEEDS DECISION)/i;",
    run: ["apps/fleet/test/lane-events.test.ts"], expect: "STATUS: DONEish" },
  { id: "fc9-first-line", task: "fc9", file: "apps/fleet/src/application/lane-events.ts",
    find: "(text.split(\"\\n\").find(l => l.trim()) ?? \"\")",
    replace: "(text.split(\"\\n\")[0] ?? \"\")",
    run: ["apps/fleet/test/lane-events.test.ts"], expect: "expected '' to be 'first'" },
  { id: "fc9-stop-text-form", task: "fc9", file: "apps/fleet/src/application/lane-events.ts",
    find: "textOf(b.last_assistant_message ?? b.text)",
    replace: "textOf(b.text)",
    run: ["apps/fleet/test/lane-events.test.ts"], expect: "the first line, its status, background tasks and crons counted" },
  { id: "fc9-array-counts", task: "fc9", file: "apps/fleet/src/application/lane-events.ts",
    find: "(Array.isArray(v) ? v.length : Number.isFinite",
    replace: "(Number.isFinite",
    run: ["apps/fleet/test/lane-events.test.ts"], expect: "background tasks and crons counted" },
  { id: "fc9-error-type", task: "fc9", file: "apps/fleet/src/application/lane-events.ts",
    find: "textOf(b.error_type ?? b.error ?? \"unknown\")",
    replace: "textOf(b.error ?? \"unknown\")",
    run: ["apps/fleet/test/lane-events.test.ts"], expect: "rate_limit" },
  { id: "fc9-no-window", task: "fc9", file: "apps/fleet/src/application/lane-events.ts",
    find: "  if (lane === null || lane === \"\" || lane === rules.manager",
    replace: "  if (lane === rules.manager",
    run: ["apps/fleet/test/lane-events.test.ts"], expect: "none for a hook without a window" },
  { id: "fc9-manager-own", task: "fc9", file: "apps/fleet/src/application/lane-events.ts",
    find: " || lane === rules.manager || ",
    replace: " || ",
    run: ["apps/fleet/test/lane-events.test.ts", "apps/fleet/test/lane-events-push.test.ts"], expect: "the manager's own lane and ignored lanes left out" },
  { id: "fc9-ignore", task: "fc9", file: "apps/fleet/src/application/lane-events.ts",
    find: "rules.ignore.some(g => g.test(lane))",
    replace: "false",
    run: ["apps/fleet/test/lane-events.test.ts", "apps/fleet/test/lane-events-push.test.ts"], expect: "an ignored lane, or another path" },
  { id: "fc9-line-shape", task: "fc9", file: "apps/fleet/src/application/lane-events.ts",
    find: "ts: new Date(e.at).toISOString(), lane: e.lane,",
    replace: "lane: e.lane, ts: new Date(e.at).toISOString(),",
    run: ["apps/fleet/test/lane-events.test.ts"], expect: "one JSON line per event in today's shape, key order included" },
  { id: "fc9-split", task: "fc9", file: "apps/fleet/src/application/lane-events.ts",
    find: "    if (cur && cur.text.length + 1 + line.length <= max) {",
    replace: "    if (cur) {",
    run: ["apps/fleet/test/lane-events.test.ts", "apps/fleet/test/lane-events-push.test.ts"], expect: "splits a batch over 8000 characters into parts of at most 8000" },
  { id: "fc9-above-mark", task: "fc9", file: "apps/fleet/src/adapters/outbox-store.ts",
    find: "        if (e.seq <= seq) { duplicates++; continue; }\n        seq = e.seq;\n        const own = o.taken?.(e) ?? false;",
    replace: "        const own = o.taken?.(e) ?? false;\n        if (e.seq <= seq) { duplicates++; continue; }\n        seq = e.seq;",
    run: ["apps/fleet/test/lane-events-intake.test.ts"], expect: "a replayed hook makes none" },
  { id: "fc9-lane-own", task: "fc9", file: "apps/fleet/src/application/hook-intake.ts",
    find: "if (t.event) fresh.push(t.event); return t.own; }",
    replace: "if (t.event) fresh.push(t.event); return false; }",
    run: ["apps/fleet/test/lane-events-intake.test.ts"], expect: "{ path: '/lane', count: 2" },
  { id: "fc9-published-after-commit", task: "fc9", file: "apps/fleet/src/application/hook-intake.ts",
    find: "if (t.event) fresh.push(t.event); return t.own; }",
    replace: "if (t.event) lanes.committed([t.event]); return t.own; }",
    run: ["apps/fleet/test/lane-events-intake.test.ts"], expect: "an intake commit that fails publishes no lane event" },
  { id: "fc9-answered-not-waiting", task: "fc9", file: "apps/fleet/src/application/lane-events.ts",
    find: "this.#toManager && d.event !== \"answered\" ? 0 : null",
    replace: "this.#toManager ? 0 : null",
    run: ["apps/fleet/test/lane-events-intake.test.ts", "apps/fleet/test/lane-events-push.test.ts"], expect: "answered is published but never waits for the manager" },
  { id: "fc9-requeue-given-up", task: "fc9", file: "apps/fleet/src/application/lane-events-push.ts",
    find: "    try { if (this.#store.requeue(d.id) > 0) this.kick(); }",
    replace: "    try { if (false) this.kick(); }",
    run: ["apps/fleet/test/lane-events-push.test.ts"], expect: "a batch given up goes again in the next batch, under a new id" },
  { id: "fc9-new-id", task: "fc9", file: "apps/fleet/src/application/lane-events-push.ts",
    find: "this.#used.has(id) || this.#deliveries.get(id) !== null",
    replace: "false",
    run: ["apps/fleet/test/lane-events-push.test.ts"], expect: "expected 'fleet:lane-events:pc:1700000000001' to be" },
  { id: "fc9-requeue-at-start", task: "fc9", file: "apps/fleet/src/application/lane-events-push.ts",
    find: "      for (const id of this.#store.sentIn()) if (this.#deliveries.get(id)?.delivery.state === \"given_up\") this.#store.requeue(id);\n",
    replace: "",
    run: ["apps/fleet/test/lane-events-push.test.ts"], expect: "a batch given up while the fleet was down goes again after its start" },
  { id: "fc9-mark-sent", task: "fc9", file: "apps/fleet/src/application/lane-events-push.ts",
    find: "        this.#store.markSent(part.events.map(e => e.seq), id);\n",
    replace: "",
    run: ["apps/fleet/test/lane-events-push.test.ts"], expect: "a stored batch never goes twice" },
  { id: "fc9-warn-once", task: "fc9", file: "apps/fleet/src/application/lane-events-push.ts",
    find: "          this.#refused = true;\n",
    replace: "",
    run: ["apps/fleet/test/lane-events-push.test.ts"], expect: "go after a fleet restart, with one warning" },
  { id: "fc9-since-checked", task: "fc9", file: "apps/fleet/src/adapters/client-api.ts",
    find: "      if (!/^\\d{1,15}$/.test(since)) throw",
    replace: "      if (false) throw",
    run: ["apps/fleet/test/lane-events-intake.test.ts"], expect: "?since=-1" },
  { id: "fc9-drop-repeat-needs-input", task: "fc9", file: "apps/fleet/src/application/lane-events.ts",
    find: "    if (d.event === \"needs_input\" && d.sessionId !== undefined && this.#store.lastOf(d.sessionId) === \"needs_input\") return { event: null, own };\n",
    replace: "",
    run: ["apps/fleet/test/lane-events-intake.test.ts"], expect: "a needs_input the session's last lane event already is" },
  { id: "fc9-null-never-later", task: "fc9", file: "apps/fleet/src/application/lane-events.ts",
    find: "this.#toManager && d.event !== \"answered\" ? 0 : null",
    replace: "d.event !== \"answered\" ? 0 : null",
    run: ["apps/fleet/test/lane-events-push.test.ts"], expect: "before" },
  { id: "fc9-split-ids", task: "fc9", file: "apps/fleet/src/application/lane-events-push.ts",
    find: "this.#idFor(parts.length > 1 ? `${base}-${i + 1}` : base)",
    replace: "this.#idFor(base)",
    run: ["apps/fleet/test/lane-events-push.test.ts"], expect: "goes as several deliveries of at most 8000, each with the header, in order" },
  { id: "fc9-since-max", task: "fc9", file: "apps/fleet/src/application/lane-events.ts",
    find: "export const SINCE_MAX = 1000;",
    replace: "export const SINCE_MAX = 5000;",
    run: ["apps/fleet/test/lane-events-intake.test.ts"], expect: "to deeply equal [ 1000, 1, 1000 ]" },
```

Run: `node scripts/negative-controls.ts --check`
Expected: exit 0; an `ok` line for each entry

- [ ] **Step 22: Commit**

```bash
git add scripts/negative-controls.ts
git commit -m "test(fleet): negative controls for lane events"
```

- [ ] **Step 23: Run the controls (the runner tests the code at HEAD, so after the commit)**

Run: `node scripts/negative-controls.ts --only fc9-status-rule --only fc9-first-line --only fc9-stop-text-form --only fc9-array-counts --only fc9-error-type --only fc9-no-window --only fc9-manager-own --only fc9-ignore --only fc9-line-shape --only fc9-split --only fc9-above-mark --only fc9-lane-own --only fc9-published-after-commit --only fc9-answered-not-waiting --only fc9-requeue-given-up --only fc9-new-id --only fc9-requeue-at-start --only fc9-mark-sent --only fc9-warn-once --only fc9-since-checked --only fc9-drop-repeat-needs-input --only fc9-null-never-later --only fc9-split-ids --only fc9-since-max`
Expected: `24/24 controls bit; still pass 0, broke 0, timed out 0, skipped 0`

---

### Task 10: Fleet: the subscriber contract, `subscriber_lagging`, the relay's window from the body

**The subscriber contract** (spec §6). Its text for subscribers is Task 15's (`docs/fleet-api.md`): answer 2xx once
the event is had, never refuse one for a reason of one's own downstream (a blocked chat service, a failed handler), keep
what can't be acted on yet. The fleet's side, here:
- the bus's classification, one exported function (`outcomeOf`), unchanged in behaviour: 2xx delivered; a 4xx other than
  408 and 429 dead at once; everything else (408, 429, 5xx, no answer, anything unexpected) tried again, up to
  `LIMITS.deadLetterAttempts`;
- each stream in order, one event in flight (as today), so a refused event holds up those behind it;
- **`subscriber_lagging`** when a subscriber's oldest undelivered event is older than `LIMITS.subscriberLagMs` (60 s, by
  the time the fleet stored it), checked on every tick of the delivery worker (1 s), once per episode: the next alert
  only after nothing of that subscriber was that old. Its `detail` (reconciliation ruling 25): `{ subscriber, oldestAgeMs,
  streams }`, `streams` being how many streams have an event waiting for it; its node: the oldest event's.

**The not-synced side of §6, pinned** (rulings 59, 61). Task 7 pins what is synced; this pins what isn't: a hook
delivered to a subscriber, and its lane event delivered to the manager as a batch, make exactly one synced commit, the
intake's. The subscriber's delivered mark, the batch's mirror row, its audit, its sent mark and the mirror's next state
all commit under `NORMAL` (a lost one means one more delivery, which the receiver skips by its key or id). The test
counts `synchronous = FULL` the way `db-sync.test.ts` does (`watchSyncs`); two controls each sync one of those marks.

**The relay's window from the body** (spec §6, "Identity"; spec §16, change 11): when neither `TMUX_PANE` nor the
session registry finds a window (a `lanes notify` from outside a pane; a lane's first turn ending before the registry
lists it), the relay takes the body's own `window`, a window name (1 to 200 characters, no control character), else
null. This is the one agent file this part changes (`apps/node-agent/src/relay/window-of.ts`, its last line), with a
new test of its own; Tasks 4 to 6 don't touch either.

**Files:**
- Modify: `apps/fleet/src/application/delivery.ts` (`outcomeOf`, `checkLag`), `apps/fleet/src/adapters/outbox-store.ts`
  (`oldestPending`)
- Modify: `apps/node-agent/src/relay/window-of.ts` (the only agent file this part touches)
- Test: `apps/fleet/test/subscriber-contract.test.ts`, `apps/fleet/test/commits-not-synced.test.ts`,
  `apps/node-agent/test/window-of.test.ts`
- Modify: `scripts/negative-controls.ts` (9 entries)

**Interfaces:**
- Consumes: Task 1: `AlertKind` `subscriber_lagging`, `LIMITS.subscriberLagMs`. Task 7: the hook bus as it is
  (`deliveries_pending`, migration 4).
- Produces:
  - `application/delivery.ts`: `outcomeOf(status: number | null): "delivered" | "retry" | "dead"`;
    `DeliveryWorker.checkLag(): void` (also run on every tick).
  - `adapters/outbox-store.ts`: `oldestPending(subscriber): { node, streamId, seq, path, createdAt } | null`,
    `pendingStreams(subscriber): number`.
  - `apps/node-agent/src/relay/window-of.ts`: `windowResolver` falls back to the body's `window`.

- [ ] **Step 1: Write the failing test for the bus's side of the subscriber contract**

Create `apps/fleet/test/subscriber-contract.test.ts`:

```ts
// The hook bus's side of the subscriber contract (fleet clients spec §6): how an answer is classified, and
// subscriber_lagging when a subscriber's oldest undelivered event is older than 60 s, once per episode: a subscriber
// that keeps answering 503 (the contract broken: a refusal for a reason of its own) holds its stream, loses nothing,
// and raises one alert until it catches up.
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LIMITS, type HookEvent } from "@morndo/protocol";
import type { Subscriber } from "../src/config.ts";
import { Audit } from "../src/adapters/audit.ts";
import { openFleetDb } from "../src/adapters/db.ts";
import { OutboxStore } from "../src/adapters/outbox-store.ts";
import { DeliveryWorker, outcomeOf } from "../src/application/delivery.ts";
import { HookIntake } from "../src/application/hook-intake.ts";
import { quiet } from "./helpers/fleet.ts";
import { startSubscriber } from "./helpers/subscriber.ts";
import { tempDir } from "./helpers/temp.ts";

const ev = (seq: number, streamId = "s1"): HookEvent => ({ streamId, seq, at: 1_700_000_000_000 + seq, path: "/hook/stop", node: "pc", window: "api", body: { seq } });

describe("the subscriber contract, the bus's side", () => {
  it("classifies every answer: 2xx delivered, a 4xx other than 408 and 429 dead, everything else tried again", () => {
    const cases: [number | null, string][] = [
      [200, "delivered"], [202, "delivered"], [204, "delivered"], [299, "delivered"],
      [400, "dead"], [404, "dead"], [410, "dead"], [499, "dead"],
      [408, "retry"], [429, "retry"], [500, "retry"], [503, "retry"], [302, "retry"], [101, "retry"], [null, "retry"],
    ];
    for (const [status, outcome] of cases) expect(outcomeOf(status), String(status)).toBe(outcome);
  });

  it("a subscriber that keeps refusing raises subscriber_lagging once its oldest event is 60 s old, once per episode, and loses nothing", async () => {
    let offset = 0;                                                                    // a clock that runs, and jumps when a test says so
    const now = () => Date.now() + offset;
    let refuse = true;
    const kira = await startSubscriber(() => (refuse ? 503 : 200));
    const db = openFleetDb(join(tempDir(), "fleet.db"));
    const store = new OutboxStore(db);
    const audit = new Audit(db);
    const subscribers: Subscriber[] = [{ name: "kira", url: kira.url, paths: ["/hook/stop"] }];
    const worker = new DeliveryWorker({ store, subscribers, audit, log: quiet, backoff: { baseMs: 5, maxMs: 20 }, random: () => 1, tickMs: 10, now });
    const intake = new HookIntake({ store, subscribers, audit, now, onStored: () => worker.kick() });
    worker.start();
    intake.accept("pc", "s1", [ev(1), ev(2)]);
    intake.accept("pc", "s2", [ev(1, "s2")]);                                         // a second stream waits as well
    const lagging = () => audit.of("alert.subscriber_lagging").map(a => [a.node, a.detail]);
    offset += LIMITS.subscriberLagMs - 1000;
    await new Promise(r => setTimeout(r, 50));
    expect(lagging()).toEqual([]);                                                    // 59 s: not yet
    offset += 2000;
    await vi.waitFor(() => expect(lagging()).toHaveLength(1));                       // the worker's own tick checks (every 10 ms here)
    await new Promise(r => setTimeout(r, 50));                                        // more ticks: still one
    expect(lagging()).toEqual([["pc", { subscriber: "kira", oldestAgeMs: expect.any(Number), streams: 2 }]]);
    expect((lagging()[0]?.[1] as { oldestAgeMs?: number } | undefined)?.oldestAgeMs).toBeGreaterThan(LIMITS.subscriberLagMs);
    expect(kira.received.filter(r => r.body.streamId === "s1").every(r => r.body.seq === 1)).toBe(true);   // 2 waits behind the refused 1
    refuse = false;                                                                    // it catches up: the episode ends
    await vi.waitFor(() => expect(store.states("kira")).toEqual({ delivered: 3 }));
    await new Promise(r => setTimeout(r, 30));
    refuse = true;
    intake.accept("pc", "s1", [ev(3)]);
    offset += LIMITS.subscriberLagMs + 1000;
    await vi.waitFor(() => expect(lagging()).toHaveLength(2));                       // negative control: no episode ends, one
    expect(lagging().map(([, d]) => (d as { streams: number }).streams)).toEqual([2, 1]);
    await worker.stop();
    db.close();
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run apps/fleet/test/subscriber-contract.test.ts`
Expected: FAIL, both: `TypeError: outcomeOf is not a function`, and no `subscriber_lagging` alert (`expected [] to have a length of 1 but got +0`)

- [ ] **Step 3: Implement `outcomeOf` and `subscriber_lagging`**

In `apps/fleet/src/adapters/outbox-store.ts`, replace:

```ts
  pendingCount(subscriber: string): number {
```

with:

```ts
  // The subscriber's oldest pending delivery (deliveries_pending: its first row in outbox order), with when it was stored.
  oldestPending(subscriber: string): { node: string; streamId: string; seq: number; path: string; createdAt: number } | null {
    const r = this.#db.prepare(`SELECT o.node, o.stream_id, o.seq, o.path, o.created_at FROM deliveries d INDEXED BY deliveries_pending
      JOIN outbox o ON o.id = d.outbox_id WHERE d.subscriber = ? AND d.state = 'pending' ORDER BY d.outbox_id LIMIT 1`)
      .get(subscriber) as { node: string; stream_id: string; seq: number; path: string; created_at: number } | undefined;
    return r ? { node: r.node, streamId: r.stream_id, seq: r.seq, path: r.path, createdAt: r.created_at } : null;
  }

  // How many streams have an event still to deliver to the subscriber.
  pendingStreams(subscriber: string): number {
    return (this.#db.prepare(`SELECT COUNT(*) AS n FROM (SELECT DISTINCT o.node, o.stream_id FROM deliveries d INDEXED BY deliveries_pending
      JOIN outbox o ON o.id = d.outbox_id WHERE d.subscriber = ? AND d.state = 'pending')`).get(subscriber) as { n: number }).n;
  }

  pendingCount(subscriber: string): number {
```

The partial index `deliveries_pending` (migration 4) holds a subscriber's pending rows in outbox order, so the oldest is
its first entry, a seek and no scan, every second; the streams are counted only when the alert is raised. In `apps/fleet/src/application/delivery.ts`, replace:

```ts
// A retry time is stored on the wall clock; one further away than the longest backoff can only come from a clock that
```

with:

```ts
// The subscriber contract (fleet clients spec §6; docs/fleet-api.md): a subscriber answers 2xx once it has the event and
// never refuses one for a reason of its own downstream (a blocked chat service, a failed handler): it keeps what it
// can't act on yet and acts later. The bus's side: each stream in order, one event in flight, so a refused event holds
// up the ones behind it; `outcomeOf` is the whole classification. A subscriber whose oldest undelivered event is older
// than LIMITS.subscriberLagMs (60 s, by the time it was stored) raises subscriber_lagging, once per episode: the next one
// only after nothing of it was that old (checked every tick). Its detail: { subscriber, oldestAgeMs, streams }, streams
// being how many streams have an event waiting for it (reconciliation ruling 25); its node, the oldest event's.
// A retry time is stored on the wall clock; one further away than the longest backoff can only come from a clock that
```

Then replace:

```ts
const ok = (status: number) => status >= 200 && status < 300;
const streamKey = (subscriber: string, node: string, streamId: string) => `${subscriber}\n${node}\n${streamId}`;
const permanent = (status: number) => status >= 400 && status < 500 && status !== 408 && status !== 429;
```

with:

```ts
const streamKey = (subscriber: string, node: string, streamId: string) => `${subscriber}\n${node}\n${streamId}`;

// What an answer means (the subscriber contract): 2xx delivered; any other 4xx than 408 and 429 dead at once (the
// subscriber refused it, and would again); everything else (408, 429, 5xx, no answer, anything unexpected) tried again
// later, up to LIMITS.deadLetterAttempts. RFC 9110 §15.5.9 and RFC 6585 §4 invite a retry of 408 and 429.
export function outcomeOf(status: number | null): "delivered" | "retry" | "dead" {
  if (status !== null && status >= 200 && status < 300) return "delivered";
  if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) return "dead";
  return "retry";
}
```

Then replace:

```ts
  #deadEpisodes = new Set<string>();                    // subscribers alerted since their last successful delivery
```

with:

```ts
  #deadEpisodes = new Set<string>();                    // subscribers alerted since their last successful delivery
  #lagging = new Set<string>();                         // subscribers alerted lagging, until none of theirs is that old
```

Then replace:

```ts
  #tick(): void { this.#safely("a delivery round", () => this.runOnce()); }
```

with:

```ts
  #tick(): void {
    this.#safely("a delivery round", () => this.runOnce());
    this.#safely("the lag check", () => this.checkLag());
  }

  // subscriber_lagging, once per episode per subscriber.
  checkLag(): void {
    const now = this.#now();
    for (const s of this.#subscribers) {
      const oldest = this.#store.oldestPending(s.name);
      const ageMs = oldest === null ? 0 : now - oldest.createdAt;
      if (ageMs <= LIMITS.subscriberLagMs) { this.#lagging.delete(s.name); continue; }
      if (this.#lagging.has(s.name) || oldest === null) continue;
      this.#lagging.add(s.name);
      this.#audit.alert("subscriber_lagging", oldest.node, { subscriber: s.name, oldestAgeMs: ageMs, streams: this.#store.pendingStreams(s.name) });
    }
  }
```

and in `#deliver`:

```ts
    if (status !== null && ok(status)) { this.#store.delivered(d.outboxId, s.name, now); this.#deadEpisodes.delete(s.name); return; }
```

with:

```ts
    const outcome = outcomeOf(status);
    if (outcome === "delivered") { this.#store.delivered(d.outboxId, s.name, now); this.#deadEpisodes.delete(s.name); return; }
```

and:

```ts
    if ((status !== null && permanent(status)) || attempts >= LIMITS.deadLetterAttempts) {
```

with:

```ts
    if (outcome === "dead" || attempts >= LIMITS.deadLetterAttempts) {
```

- [ ] **Step 4: Run it and see it pass**

Run: `npx vitest run apps/fleet/test/subscriber-contract.test.ts apps/fleet/test/delivery.test.ts`
Expected: PASS (11 tests in 2 files: the bus's own tests unchanged)

- [ ] **Step 5: Commit**

```bash
git add apps/fleet/src/application/delivery.ts apps/fleet/src/adapters/outbox-store.ts apps/fleet/test/subscriber-contract.test.ts
git commit -m "feat(fleet): subscriber_lagging once per episode, and the bus's classification in one place"
```

- [ ] **Step 6: Pin the not-synced side of the commit rule**

This pins behaviour Tasks 7 to 9 already have, so it passes as written; its controls show it would catch a synced
bookkeeping commit.

Create `apps/fleet/test/commits-not-synced.test.ts`:

```ts
// The "not synced" side of the fleet core's §16.4 rule in fleet.db (fleet clients spec §6; reconciliation ruling 59): once
// a hook's intake commit is on the disk, what follows it is bookkeeping and commits under NORMAL: the subscriber's
// delivered mark, the lane event's batch to the manager (its mirror row, its audit, its sent mark), and the mirror's next
// state. A lost one means one more delivery, which the receiver skips by its key or id. Only the intake is synced.
import { describe, expect, it, vi } from "vitest";
import type { Pane } from "@morndo/protocol";
import { startTestFleet } from "./helpers/fleet.ts";
import { deliveryOf, nodeQueue } from "./helpers/node-queue.ts";
import { startSubscriber } from "./helpers/subscriber.ts";
import { FULL_THEN_NORMAL, watchSyncs } from "./helpers/syncs.ts";

const HEADER = "[lane-event] Lane events (handle them as your instructions say):";
const pane = (n: number, window: string): Pane => ({ workerId: `pc.3fa2c1d0.${n}`, window, cwd: "/w", status: "idle", pid: n });

describe("fleet.db's bookkeeping is not synced", () => {
  it("a hook delivered to a subscriber and its lane event delivered to the manager: one synced commit, the intake's", async () => {
    const kira = await startSubscriber();
    const fleet = await startTestFleet({
      config: { subscribers: [{ name: "kira", url: kira.url, paths: ["/hook/stop"] }], laneEvents: { deliverTo: "manager", header: HEADER, ignore: [], batchMs: 100 } },
      delivery: { tickMs: 20 },
    });
    const pc = await fleet.online("pc");
    nodeQueue(pc);
    pc.inventory([pane(0, "manager"), pane(1, "api")]);
    await vi.waitFor(() => expect(fleet.lanes.get("manager")).not.toBeNull());
    const syncs = watchSyncs(fleet.db);                                               // after the admission (its epoch is synced)
    pc.hook(1, "/hook/stop", { text: "STATUS: DONE" }, { window: "api" });
    expect(await pc.acked(1)).toBe(1);
    await vi.waitFor(() => expect(fleet.outbox.states("kira")).toEqual({ delivered: 1 }));          // the subscriber's mark
    const id = `fleet:lane-events:pc:${1_700_000_000_001}`;
    await vi.waitFor(() => expect(fleet.db.prepare("SELECT to_manager, delivery_id FROM lane_events").get()).toEqual({ to_manager: 1, delivery_id: id }));
    expect(fleet.deliveries.get(id)?.delivery.state).toBe("queued");                // the batch, mirrored and audited
    pc.delivery(deliveryOf("pc", id, { target: { lane: "manager" }, state: "delivered", deliveredAt: 1 }));   // the node's next state
    await vi.waitFor(() => expect(fleet.deliveries.get(id)?.delivery.state).toBe("delivered"));
    expect(syncs).toEqual(FULL_THEN_NORMAL);                                          // negative control: a synced mark adds a pair
  });
});
```

Run: `npx vitest run apps/fleet/test/commits-not-synced.test.ts`
Expected: PASS (1 test)

- [ ] **Step 7: Commit**

```bash
git add apps/fleet/test/commits-not-synced.test.ts
git commit -m "test(fleet): only the intake's commit is synced when a hook and its lane event are delivered"
```

- [ ] **Step 8: Write the failing test for the relay's window from the body**

Create `apps/node-agent/test/window-of.test.ts`:

```ts
// Which window a hook came from (fleet core §5.5; fleet clients spec §6): TMUX_PANE first, then the session registry,
// and only when neither finds one the body's own `window` (the owner's Stop script and `lanes notify` send it), a
// window name or nothing.
import { describe, expect, it } from "vitest";
import type { SessionInfo } from "@morndo/node-ops";
import { windowResolver } from "../src/relay/window-of.ts";

const resolve = windowResolver({ windowOfPane: p => (p === "%3" ? "api lane" : null), sessions: () => new Map<string, SessionInfo>() });

describe("the window of a hook", () => {
  it("takes the body's window when neither the pane nor the session finds one", () => {
    expect(resolve({ window: "web", text: "a note from outside a pane" })).toBe("web");            // negative control: null
    expect(resolve({ window: "fix: a/b ü.2", session_id: "not-in-the-registry" })).toBe("fix: a/b ü.2");
  });

  it("prefers the pane it finds over the body's window", () => {
    expect(resolve({ TMUX_PANE: "%3", window: "web" })).toBe("api lane");
  });

  it("takes no body window that isn't a window name, and none when there is none", () => {
    for (const window of ["", "a\tb", "x".repeat(201), 7, null]) expect(resolve({ window }), JSON.stringify(window)).toBeNull();
    expect(resolve({ text: "x" })).toBeNull();
    expect(resolve("plain words")).toBeNull();
  });
});
```

- [ ] **Step 9: Run it and see it fail**

Run: `npx vitest run apps/node-agent/test/window-of.test.ts`
Expected: FAIL, 1 of 3: `expected null to be 'web'`

- [ ] **Step 10: Take the body's window when nothing else finds one**

In `apps/node-agent/src/relay/window-of.ts`, replace:

```ts
// pane its session_id runs in (the session registry), and then that pane's window in the latest inventory. Null when
// neither leads anywhere.
```

with:

```ts
// pane its session_id runs in (the session registry), and then that pane's window in the latest inventory. When neither
// leads anywhere (a `lanes notify` from outside a pane, a lane's first turn ending before the registry lists it), the
// body's own `window`, a window name (1 to 200 characters, no control character; fleet clients spec §6), else null.
```

and its last line:

```ts
      for (const [pane, s] of o.sessions()) if (s.sessionId === b.session_id) return o.windowOfPane(pane);
    }
    return null;
```

with:

```ts
      for (const [pane, s] of o.sessions()) if (s.sessionId === b.session_id) return o.windowOfPane(pane);
    }
    return typeof b.window === "string" && /^[^\p{Cc}]{1,200}$/u.test(b.window) ? b.window : null;
```

- [ ] **Step 11: Run it and see it pass**

Run: `npx vitest run apps/node-agent/test/window-of.test.ts apps/node-agent/test/relay-server.test.ts`
Expected: PASS (13 tests in 2 files: the relay's own tests unchanged)

Run: `npx vitest run apps/fleet && npx tsc -p apps/fleet && npx oxlint apps/fleet apps/node-agent/src/relay apps/node-agent/test/window-of.test.ts`
Expected: PASS (241 tests in 46 files); tsc and oxlint print nothing

- [ ] **Step 12: Commit**

```bash
git add apps/node-agent/src/relay/window-of.ts apps/node-agent/test/window-of.test.ts
git commit -m "feat(node-agent): the relay takes a hook body's window when it finds none"
```

- [ ] **Step 13: Add this task's negative controls to `scripts/negative-controls.ts`**

In `scripts/negative-controls.ts`, insert this task's entries at the end of `CONTROLS`, before its closing `];` (the line before `// ---- the runner`), after whatever entries earlier tasks and lanes added there:

```ts
  // Task 10: subscriber_lagging once per episode, the bus's classification, bookkeeping not synced, the relay's window from the body.
  { id: "fc10-lag-once", task: "fc10", file: "apps/fleet/src/application/delivery.ts",
    find: "      if (this.#lagging.has(s.name) || oldest === null) continue;",
    replace: "      if (oldest === null) continue;",
    run: ["apps/fleet/test/subscriber-contract.test.ts"], expect: "raises subscriber_lagging once its oldest event is 60 s old, once per episode" },
  { id: "fc10-lag-episode-ends", task: "fc10", file: "apps/fleet/src/application/delivery.ts",
    find: "{ this.#lagging.delete(s.name); continue; }",
    replace: "{ continue; }",
    run: ["apps/fleet/test/subscriber-contract.test.ts"], expect: "to have a length of 2 but got 1" },
  { id: "fc10-lag-threshold", task: "fc10", file: "apps/fleet/src/application/delivery.ts",
    find: "      if (ageMs <= LIMITS.subscriberLagMs) {",
    replace: "      if (ageMs <= 0) {",
    run: ["apps/fleet/test/subscriber-contract.test.ts"], expect: "expected [ [ 'pc', …(1) ] ] to deeply equal []" },
  { id: "fc10-lag-in-tick", task: "fc10", file: "apps/fleet/src/application/delivery.ts",
    find: "    this.#safely(\"the lag check\", () => this.checkLag());\n",
    replace: "",
    run: ["apps/fleet/test/subscriber-contract.test.ts"], expect: "to have a length of 1 but got +0" },
  { id: "fc10-classify-4xx", task: "fc10", file: "apps/fleet/src/application/delivery.ts",
    find: "  if (status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429) return \"dead\";",
    replace: "  if (status !== null && status >= 400 && status < 500) return \"dead\";",
    run: ["apps/fleet/test/subscriber-contract.test.ts"], expect: "408" },
  { id: "fc10-delivered-mark-unsynced", task: "fc10", file: "apps/fleet/src/adapters/outbox-store.ts",
    find: "    this.#db.prepare(\"UPDATE deliveries SET state = 'delivered', delivered_at = ? WHERE outbox_id = ? AND subscriber = ? AND state = 'pending'\").run(at, outboxId, subscriber);",
    replace: "    this.#db.pragma(\"synchronous = FULL\");\n    this.#db.prepare(\"UPDATE deliveries SET state = 'delivered', delivered_at = ? WHERE outbox_id = ? AND subscriber = ? AND state = 'pending'\").run(at, outboxId, subscriber);\n    this.#db.pragma(\"synchronous = NORMAL\");",
    run: ["apps/fleet/test/commits-not-synced.test.ts"], expect: "synchronous = FULL" },
  { id: "fc10-sent-mark-unsynced", task: "fc10", file: "apps/fleet/src/adapters/lane-events-store.ts",
    find: "    this.#db.prepare(\"UPDATE lane_events SET to_manager = 1, delivery_id = ? WHERE seq IN (SELECT value FROM json_each(?)) AND to_manager = 0\")",
    replace: "    this.#db.pragma(\"synchronous = FULL\"); this.#db.pragma(\"synchronous = NORMAL\");\n    this.#db.prepare(\"UPDATE lane_events SET to_manager = 1, delivery_id = ? WHERE seq IN (SELECT value FROM json_each(?)) AND to_manager = 0\")",
    run: ["apps/fleet/test/commits-not-synced.test.ts"], expect: "synchronous = FULL" },
  { id: "fc10-window-from-body", task: "fc10", file: "apps/node-agent/src/relay/window-of.ts",
    find: "    return typeof b.window === \"string\" && /^[^\\p{Cc}]{1,200}$/u.test(b.window) ? b.window : null;",
    replace: "    return null;",
    run: ["apps/node-agent/test/window-of.test.ts"], expect: "web" },
  { id: "fc10-window-name-checked", task: "fc10", file: "apps/node-agent/src/relay/window-of.ts",
    find: "typeof b.window === \"string\" && /^[^\\p{Cc}]{1,200}$/u.test(b.window)",
    replace: "typeof b.window === \"string\"",
    run: ["apps/node-agent/test/window-of.test.ts"], expect: "expected '' to be null" },
```

Run: `node scripts/negative-controls.ts --check`
Expected: exit 0; an `ok` line for each entry

- [ ] **Step 14: Commit**

```bash
git add scripts/negative-controls.ts
git commit -m "test(fleet): negative controls for the subscriber contract and the relay's window"
```

- [ ] **Step 15: Run the controls (the runner tests the code at HEAD, so after the commit)**

Run: `node scripts/negative-controls.ts --only fc10-lag-once --only fc10-lag-episode-ends --only fc10-lag-threshold --only fc10-lag-in-tick --only fc10-classify-4xx --only fc10-delivered-mark-unsynced --only fc10-sent-mark-unsynced --only fc10-window-from-body --only fc10-window-name-checked`
Expected: `9/9 controls bit; still pass 0, broke 0, timed out 0, skipped 0`

---

## Notes for the other parts

- **Task 3 (`packages/fleet-client`):** `POST /v1/deliveries` and `POST /v1/deliveries/<id>/cancel` answer 200 for
  every outcome, a refusal included, as `/v1/op` does; 400 (a body that doesn't fit, `lane.deliver`'s own rules
  included), 413 and 415 carry `{ ok: false, error }` too. An id the fleet doesn't know is 404 `{ error:
  "no_such_delivery" }`, for `GET /v1/deliveries/<id>` and its cancel alike. `GET /v1/lane-events` without `since` starts at the oldest kept; a `since` that isn't a whole
  number is 400.
- **Tasks 4 to 6 (the agent):** `ev.delivery` must carry the node's own name in `delivery.node` (another closes the
  connection 1008). The fleet takes a whole reconnect's worth at once (no rate limit). `/lane` bodies are read as `{ event:
  "needs_input" | "answered", sessionId: string | null, question?: string }`; another `event` makes no lane event.
- **Task 12 (hub):** `GET /v1/caps` answers `{ api: [1], stickyLanes: [...] }`. The hub's fake fleet
  (`apps/hub/test/helpers/fake-fleet.ts`, `json(200, { api: o.api ?? [CLIENT_API] })`) needs `stickyLanes` for Review
  Focus 5's test.
- **Task 16:** the harness's `waitOnline` gap that let `drills-retry`'s (b‴) fail once under load (see "How this part was
  checked") is Task 16's to fix (ruling 37).
- **Tasks 15 and 16:** the fleet's tests and the drills' harness set `laneEvents.deliverTo: null` (Task 16's harness
  literal does the same, and replaces these two lines). Alert details (ruling 25): `delivery_waiting` `{ id, lane | workerId,
  state, reason, minutes }`, `subscriber_lagging` `{ subscriber, oldestAgeMs, streams }`. Audit actions: `delivery.post`,
  `delivery.cancel`, `delivery.final`. Lane-event batch ids (ruling 6): `fleet:lane-events:<node>:<ms>[-<part>][.<n>]`.
- **Task 17:** `apps/fleet/README.md`'s durability lines (WAL and `synchronous`) now describe `NORMAL` with the synced
  intake; `docs/fleet-api.md` takes the subscriber contract's text (Task 10 left its comment in `delivery.ts`).
- **Task 21 (rollout):** `laneEvents.deliverTo` defaults to `"manager"` (ruling 24). Step 1 deploys this code with
  `lane-events-push` still running, and the node's `/lane` events flow from then on, so the PC's fleet config needs
  `"laneEvents": { "deliverTo": null }` from step 1 until step 3b sets `"manager"`, the owner's header and `"ignore":
  ["pooltest*", "pool-probe*"]`. Without it the manager gets each `needs_input` twice (from kira and from the fleet).
  What the fleet stored before 3b is never delivered (ruling 23).
- **Task 18 (kira):** `delivery_waiting` and `subscriber_lagging` reach it as `alert` events with the details above.

## Reconciled

This part's requests and questions, as [RECONCILIATION.md](RECONCILIATION.md) settled them, and where each ruling that
names part 03 is applied:

| Ruling | What | Here |
|---|---|---|
| 1 | control ids `fc<task>-<what>` | every controls step (`task: "fc7"` … `"fc10"`) |
| 2 | the mirror is `lane_deliveries`, with `alerted`; `lane_events.delivery_id` | Task 7, migration 5 |
| 3 | refusals 200 `{ ok: false, error }`; unknown id 404 `no_such_delivery`; the newest 1000 | Task 8 (a body that fails `lane.deliver`'s rules is a body that doesn't fit: 400; an unknown id's cancel answers as its `GET` does) |
| 4 | `/v1/op` refuses `lane.deliver`, `delivery.cancel` ("use /v1/deliveries") | Task 8, `client-api.ts`; control `fc8-op-refuses-deliver` |
| 5 | `/lane` the node's own: never a subscriber path, never unrouted | Task 9, `outbox-store.ts` `taken`; control `fc9-lane-own` |
| 6 | batch ids `<node>:<ms>`, `-1`, `-2` for parts, `.2` for a batch queued again | Task 9, `lane-events-push.ts`; controls `fc9-split-ids`, `fc9-new-id` |
| 8 | `GET /v1/caps` is `{ api, stickyLanes }` | Task 8; control `fc8-caps-sticky` |
| 18 | a repeated `needs_input` dropped | Task 9, `LaneEvents.take` and `lane_events_by_session`; control `fc9-drop-repeat-needs-input` |
| 21 | the intake window: one turn at least, 25 ms at most | Task 7, as drafted |
| 22 | no lane event without a window | Task 9, as drafted; control `fc9-no-window` |
| 23 | stored while `deliverTo` is null, never delivered later | Task 9, a test and control `fc9-null-never-later` |
| 25 | `delivery_waiting { id, lane \| workerId, state, reason, minutes }`, `subscriber_lagging { subscriber, oldestAgeMs, streams }` | Tasks 8 and 10 |
| 50 | controls run after their task's commit | every controls step: commit, then `--only` |
| 59 | the not-synced side of §6 pinned | Task 10, `commits-not-synced.test.ts` |
| 60 | a sticky name across a fleet restart | Task 8, `deliveries.test.ts`; control `fc8-sticky-kept-restart` |
| 61 | the not-synced commits' control | Task 10, `fc10-delivered-mark-unsynced`, `fc10-sent-mark-unsynced` |
| 62 | the epoch is synced: a reused one after a power loss could pass a stale result as current | Task 7's text; `db-sync.test.ts`, `fc7-epoch-synced` |

No open questions remain for this part: the three it asked are rulings 21, 22 and 24.
