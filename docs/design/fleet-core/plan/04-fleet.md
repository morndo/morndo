## Lane notes (fleet)

Tasks 10–13 are written against the Contracts as reconciled: the `Join` message names its node, `Welcome` has no
`node` and a `connEpoch` of at least 1, `Req.op` is any string, keys match `^[a-z]+:`, `ErrorCode` has `lane_conflict`,
and `Alert`/`AlertKind` are protocol types. Task 1 already wires `apps/fleet` into the vitest units include,
`tsconfig.tests.json` and the `.oxlintrc.json` `no-console` override, and `npm run check` runs every workspace's
`typecheck` script; Task 10 adds only the workspace (its `typecheck` is `tsc -p .`), a root `fleet` script, and its
`package-lock.json` entries through `npm install`.

**Review round 2** (2026-10-06; RECONCILIATION.md, "Review round 2", has each item with its test and control). On the
foundation as round 2 left it (`Res.store`, `fleetUrlOk`, the new `LIMITS`):
- **Instances:** a hello from another instance while one is live pings the live connection; no pong within
  `LIMITS.instancePongMs` (3 s) and the old one is terminated, the newcomer admitted; a pong, and 4409 as before. The
  wait holds no other node (Task 11).
- **Store:** every op answer carries the store it comes from: the agent's `res.store`, the connection's stream id for
  the fleet's own answer after sending, null before sending (Tasks 11, 12).
- **Queues and buffers:** at most 8 bulk ops wait per node (`busy` past that), each one's deadline counted from when it
  was queued (Task 11); an events client more than 8 MiB behind is closed with 1013 (Task 12).
- **Exposure:** `listen.host` must be loopback and `publicUrl` must pass `fleetUrlOk` (Task 10); joins and hellos are
  rate-limited per source address before any key work, closing 1013 (Task 11).
- **Audit:** every side-effecting op (`op.<name>`, with the client from `x-morndo-client`), every admission and refused
  hello; security alerts capped apart from the others; rows kept 90 days (Tasks 10–12); one `dead_letter` alert per
  subscriber episode (Task 13).
- **Names:** `lane.start` reserves its name while in flight (Task 12); a worker ID is routed whatever the registry says
  of its name, every route by a name in conflict is refused (Task 12, tests added).
- **Revocation:** by any path (the route, the console, a revocation written to fleet.db while the node is offline), the
  node's lanes go within one interval (Tasks 11, 12).
- **Console:** `status` prints each subscriber's waiting events and dead letters (Task 13); `main.ts` is executable
  before its first commit (Task 10).

### Decisions beyond the brief (for the reviewer)

**fleet.db**
- **`nodes.conn_epoch`** is a column in migration 1. connEpoch persists and only grows, across restarts too, so it works as a
  fencing token (ADR-0012 cites Kleppmann).
- **`synchronous=FULL`.** An acked hook must survive a power cut, and in WAL mode NORMAL "does lose durability"
  (https://www.sqlite.org/pragma.html#pragma_synchronous, read 2026-10-06).

**Joining**
- **A code redeems only for the name it was issued for.** `NodesStore.redeem(code, node, publicKey)` refuses a code bound to
  another name than the join's `node` (`wrong_node`, close 4403, audited as `join.refused`), and the code stays unused:
  nothing is stored, and the right name can still use it.
- **The join's welcome carries placeholder values,** `{ connEpoch: 1, ackSeq: 0, streamKnown: false }`. It takes no epoch
  from fleet.db, so the node's first `hello` is welcomed with epoch 1 and its request ids start at `1.1`.
- **`publicUrl` must be printable ASCII** (`ws://` or `wss://`): it goes into every join string, and `formatJoinString`
  refuses anything else, so `loadConfig` refuses it first. It must also pass `fleetUrlOk`: `wss://`, or `ws://` only to
  this machine (127.x.x.x, `localhost`, `[::1]`), since a node sends its proof and every op over it.
- **`listen.host` must be a loopback address** (127.x.x.x, `localhost`, `::1`): the agent endpoint never listens on the
  network itself; Tailscale Serve terminates TLS in front of it (spec 8).
- **The home directory is `HOME || os.homedir()`** (`homeOf`), as the Contracts have it: a `HOME` set but empty counts as
  unset (`os.homedir()` alone returns `""` then, which would make every default path relative). Nothing reads `XDG_*`.

**Requests to agents**
- **Side-effecting ops** are `KEYED_OPS` plus `pane.keys`. A connection dropped during `pane.keys` answers `uncertain`,
  not `node_offline`, because keys may have been typed.
- **A same-instance reconnect** keeps waiting requests until their deadline, so a late result is still delivered. Once
  another instance is admitted, those requests answer at once (`uncertain` for side effects, `node_offline` for reads).
  A result for an id nobody waits for, or from another instance, is dropped and never closes the connection.
- **Another instance's hello while one is live** pings the live connection and waits at most `LIMITS.instancePongMs`
  (3 s) for its pong, in its own promise, so no other node waits. No pong: the old connection is terminated (audited as
  `conn.replaced`) and the newcomer admitted. A pong: 4409 and one `instance_conflict` alert per refused instance for
  as long as that live connection lasts. A newcomer whose own socket closed while it waited is never admitted.
- **Every answer carries `store`:** the agent's `res.store` on its own answers (op.status's included); on the fleet's
  own answer to a request it sent (a deadline, a dropped connection, a misfit result) the stream id of the connection
  it went out on; `null` for a refusal before anything was sent (`node_offline`, `too_large`, `busy`, and the router's
  own: `bad_args`, `no_pane`, `lane_conflict`, `name_taken`). For a misfit result the fleet passes the agent's own
  `res.store`, the same id on a normal connection.
- **Results are checked against `OP_RESULTS[op]`** once their id is matched. One that doesn't fit is `internal`
  (`executed: "maybe"`: the node said it ran) and is never handed on. `op.status`'s `outcome` is `unknown` in that
  schema, so the stored result passes through exactly as the node keeps it.
- **Keys** must look like `<client>:<printable ASCII>`, the client in `a-z` (the protocol's `^[a-z]+:`), at most 256
  characters. A keyed op without one is `bad_args`, and so is a key on any other op (keystrokes are never retried).
- **Op timeout:** 15 s by default, 120 s at most.
- **Requests over 512 KiB** are refused `too_large` and never sent: past the agent's 1 MiB `maxPayload` one would close the
  node's whole connection.
- **Bulk ops** (`transcript.read`, `file.get`, `file.put`) go one at a time per node, and control ops are sent at once
  (spec 5.2: at most one bulk transfer in flight, control first). At most `LIMITS.bulkQueueMax` (8) wait behind the one
  in flight; one more is `busy` (`executed: "no"`, `store: null`). A waiting op's `timeoutMs` runs from when it was
  queued: if its turn doesn't come in time it answers `timeout` without being sent, and when it is sent it carries only
  what is left of it (less than the 250 ms deadline margin left: `timeout`, not sent).
- **Lane names.** Routing by a name more than one window claims is `lane_conflict`; `lane.start` of a name registered
  anywhere in the fleet (in conflict or not) is `name_taken`, from the router (spec 4): only the fleet sees every node.
  So is a name whose own `lane.start` is in flight: the router reserves it from the request until the node refused it
  (`executed: "no"`), or, after any other answer, until the registry holds it (at most 10 s). A route by worker ID is
  never refused for its window's name: the caller picked that pane, and the node checks the expectation.
- **The audit of ops.** Every side-effecting op (`KEYED_OPS` and `pane.keys`) is an audit row `op.<name>` with
  `{ target, keyNs, outcome, client }` (`outcome`: `ok` or the error code, refusals before routing included), never its
  text, keystrokes or bytes; reads are not audited.
- **An expectation travels inside `args`**, as `OpArgs` has it. For a lane target the router fills in
  `args.expect = { server, window: lane }` for `pane.send` and `pane.keys` unless the caller gave one; an `expect` on any
  other op is `bad_args`.

**Client API**
- **`POST /v1/op` answers in the op's shape,** whatever the status: 400 `bad_args` for a body that doesn't fit (`args` is
  required; a top-level `expect` or any other unknown field is refused), 415 `bad_args` when the body isn't JSON, by its
  content type or its content (RFC 9110 §15.5.16 allows either), 413 `too_large` over 1 MiB; each with `store: null`.
- **The client names itself** in the `x-morndo-client` header (`^[a-z]{1,16}$`, else `"unknown"`): it goes into the audit
  of side-effecting ops and of revocations. Anyone who can reach the socket is the owner's user anyway (spec 8).
- **`WS /v1/events`** starts with every registered node's `status`, then each online node's latest `inventory` and
  `health` (an offline node's last inventory is not sent). A client whose unsent events pass `LIMITS.eventsBufferBytes`
  (8 MiB, `bufferedAmount`) is unsubscribed and closed with 1013; it reconnects and gets the current state first.
- **Revocation by any path** (`POST /v1/nodes/<name>/revoke`, which `node revoke` calls, or a revocation the console
  wrote to fleet.db while the service didn't answer) closes the node's connection with 4403 and drops its latest
  reports and its lanes: `Connections.revoke` does all of it, and the ping sweep acts on every revocation in fleet.db
  it hasn't acted on, offline nodes included.
- **A `conflict` event** is `{ name, nodes }`: the nodes whose windows claim the name while it is in conflict (a node with
  two such windows counts once), and `[]` when the conflict ends. It goes out before the `lane_conflict` alert it causes.

**Alerts**
- An alert is an audit row whose action is `alert.<kind>`, plus a log warning. As an `Alert` (`id`: the row's `seq`;
  `kind`: the action without `alert.`) it is emitted as the event `{ t: "alert", node: alert.node ?? "", body: alert }`
  when raised, and `GET /v1/alerts` serves the latest 500 of the security kinds (`instance_conflict`, `source_changed`,
  `clock_offset`) and the latest 500 of the others, merged oldest first, so no flood of other kinds pushes a security
  alert out.
- Audit rows, alerts included, are deleted after 90 days (`LIMITS.auditKeepMs`), when the service starts and daily.
  The audit also keeps every admission (`conn.admitted`, with the source address), every refused hello
  (`conn.refused`, with its reason and source), every instance replaced after a missed instance check
  (`conn.replaced`), every join and refused join, every revocation and every side-effecting op.
- Joins and hellos are counted per source address before any key work (`LIMITS.handshakeBurst` at once, one more every
  `LIMITS.handshakeRefillMs`); over that the connection is closed 1013 and the source is logged once, with no audit row
  and no alert: an address that hasn't authenticated names no node, and nothing outside may fill the alerts.
- `clock_offset` (spec 5.4 and the section 9 "Clock" row) is in Task 11, because health arrives there.

| Kind | Raised | When, and how often | `detail` | The alert's `node` |
|---|---|---|---|---|
| `instance_conflict` | Task 11, `Connections.admit` | another instance is refused (4409) because the live one answered the instance check's ping; once per refused `instanceId` for as long as that live connection lasts | `{ live, refused, source }`: the two instance IDs and the refused connection's source address | the node |
| `source_changed` | Task 11, `Connections.admit` | a node is admitted from another source address than its last one (never on its first connection); each change | `{ from, to }` | the node |
| `clock_offset` | Task 11, `Connections.health` | `|health.wallClock − fleet clock|` exceeds 2000 ms plus the last ping's round trip; once, until a report back within that re-arms it (a new connection re-arms it too) | `{ offsetMs }`: the node's clock minus the fleet's, rounded | the node |
| `rate_limited` | Task 11, `runSession` | a node's inventory or health messages exceed its token bucket (60 at once, 2 a second); the connection closes 1008, so once per connection | `{}` | the node |
| `lane_conflict` | Task 12, `LaneRegistry` | a name goes from one claiming window to more than one (on two nodes or on one); each time it goes into conflict | `{ name, claims: { node, workerId }[] }` | the name's owner |
| `dead_letter` | Task 13, `DeliveryWorker` | a delivery is dead-lettered: a 4xx other than 408 and 429, or the 20th failed attempt; once per subscriber episode: the first since that subscriber's last successful delivery (or since start); later ones are counted (`status`), not alerted | `{ subscriber, streamId, seq, path, reason, attempts }` of the first; `reason` is `"HTTP <status>"` or `"no answer (<error name>)"` | the event's node |
| `backlog_full` | Task 13, `HookIntake` | a subscriber's pending deliveries are at the cap (50,000) and a new event finds no `/cc` or `/sl` left to drop, so it is dead-lettered (reason `backlog_full`, no `dead_letter` alert); once per subscriber until its backlog is below the cap again | `{ subscriber, cap, droppedProgress, deadLettered }`: that batch's counts | the batch's node |

**Hook bus**
- **408 and 429 are retried**, not dead-lettered: RFC 9110 §15.5.9 and RFC 6585 §4 both invite a retry. Every other 4xx
  is dead-lettered at once.
- **A full backlog** first drops the oldest pending `/cc` or `/sl` for that subscriber. With nothing left to drop, the new
  event becomes a dead letter (`backlog_full`) rather than a silent drop, with one alert per episode.
- **Unsubscribed events** are not stored in the outbox, but the stream's mark still moves past them.
- **Dead letters are kept 24 h**, like delivered events. Spec 8 keeps hook bodies "only until delivery plus 24 h".
- **Delivery POSTs exactly one `HookEvent`** as JSON to the subscriber's `url`, with `content-type: application/json` and
  `idempotency-key: <node>:<streamId>:<seq>`.

### Fleet lane file map (Tasks 10–13)

| File | Responsibility | Task |
|---|---|---|
| `apps/fleet/package.json`, `apps/fleet/tsconfig.json` | the `@morndo/fleet` workspace, bin `morndo-fleet`, its `typecheck` | 10 |
| `apps/fleet/src/config.ts` | `FleetConfig`: the JSON file, defaults, validation | 10 |
| `apps/fleet/src/adapters/log.ts`, `crash.ts` | redacting logger; crash handlers | 10 |
| `apps/fleet/src/adapters/keys.ts` | the fleet's Ed25519 key; node signature checks | 10 |
| `apps/fleet/src/adapters/migrations.ts`, `db.ts` | numbered migrations; opening fleet.db | 10 |
| `apps/fleet/src/adapters/nodes-store.ts` | nodes and join codes | 10 |
| `apps/fleet/src/adapters/audit.ts` | audit rows, alerts as `Alert` (security kinds capped apart), 90-day retention | 10 |
| `apps/fleet/src/adapters/socket-request.ts` | one JSON request over the Unix socket (console, tests) | 10 |
| `apps/fleet/src/main.ts` | the CLI | 10, 11, 12, 13 |
| `apps/fleet/src/adapters/rate-limit.ts` | token buckets: per node (messages), per source address (handshakes) | 11 |
| `apps/fleet/src/application/events.ts` | the event hub (causal order) | 11 |
| `apps/fleet/src/application/hook-sink.ts` | the port the hook bus implements | 11 |
| `apps/fleet/src/application/requests.ts` | waiting requests, deadlines, result checks, disconnect mapping | 11 |
| `apps/fleet/src/application/connections.ts` | live connections, instance rules, liveness, status | 11 |
| `apps/fleet/src/adapters/agent-session.ts` | one agent socket: join, hello/challenge/proof, live messages | 11 |
| `apps/fleet/src/adapters/agent-endpoint.ts` | the HTTP server and `/agent` upgrade | 11 |
| `apps/fleet/src/serve.ts` | wiring | 11, 12, 13 |
| `apps/fleet/src/adapters/socket-dir.ts` | socket directory owner and mode check | 12 |
| `apps/fleet/src/adapters/lanes-store.ts`, `application/lane-registry.ts` | lanes table; the registry rules | 12 |
| `apps/fleet/src/application/router.ts` | routing an op by worker ID, node or lane | 12 |
| `apps/fleet/src/adapters/op-body.ts`, `files-route.ts`, `client-api.ts` | `/v1/` on the Unix socket | 12 |
| `apps/fleet/src/adapters/outbox-store.ts` | stream marks, outbox, deliveries, dead letters | 13 |
| `apps/fleet/src/application/hook-intake.ts`, `delivery.ts` | intake before the ack; the delivery worker | 13 |

Tests are in `apps/fleet/test/`, with helpers in `apps/fleet/test/helpers/`. They use real sockets, temp dirs and port 0,
and never touch the owner's system.

**Verification of this plan part.** This document was replayed step by step by a script on Node 24.21.0 in a fresh copy
of the reconciled Tasks 1–3 as review round 2 left them (`wave0-r2`: `Res.store`, `fleetUrlOk`, the new `LIMITS`): every
Create, Replace and Edit applied in order, every `Run:` (and every command of a "Run each in turn" list) executed, and
every commit block run. Each FAIL step failed for the reason stated, each PASS step passed with the count stated, all
14 commits went in, the working tree ended clean, and `apps/fleet/src/main.ts` was committed with mode 100755.
- Results (round 2, 2026-10-06, macOS, tmux not used by this lane): 136 of 136 fleet tests pass in 22 files (Task 10: 32
  in 7, Task 11: 78 in 14, Task 12: 118 in 18, Task 13: 136 in 22). `npx tsc -p apps/fleet`, `npx tsc -p
  tsconfig.tests.json` and `npx oxlint apps/fleet` print nothing and exit 0; `npm run lint` is clean; `npm run check`
  exits 0 and runs the fleet's `typecheck` through the workspaces.
- Each new guard of round 2 was removed in turn on a tree built from this text, its test went red, and the suite was
  green again after (23 controls; the steps name each one): the listen and `publicUrl` checks, the separate cap
  for security alerts, the audit's retention (on start too), the instance check, the handshake bucket, the 512 KiB
  close, a waiting bulk op's own deadline, what is left of it when sent, the queue's cap, the store passed on, the
  audit of admissions and of ops, the name reservation, routing by a name in conflict, a worker ID never held back by
  its name, the events cap, revocation of an offline node, `store: null` on a refused body, the dead-letter episode
  (both ways), and `status`'s hook bus lines.
- The guards of round 1 were checked then, as follows: the join's name binding, the result check against `OP_RESULTS`,
  `lane_conflict` for a lane in conflict, conflict blocking, the fleet-wide `lane.start` name check, alerts as events,
  the start of the events socket (statuses first, online nodes only), the conflict event's `{ name, nodes }` and its
  place before its alert, the file refusal's `{ ok: false, error }`, the op-shaped 415, `args` required, the protocol's
  key namespace, no top-level `expect`, a `publicUrl` a join string can carry, `HOME || os.homedir()` for the home,
  alerts oldest first, the alert dedupes (`instance_conflict`, `clock_offset`, `backlog_full`), and the fake agent's
  protocol check. Their code and tests are unchanged by round 2 except where a step above says so.

---

### Task 10: Fleet service skeleton: config, key, fleet.db, join codes, console

**Files:**
- Create: `apps/fleet/package.json`, `apps/fleet/tsconfig.json`
- Create: `apps/fleet/src/config.ts`, `apps/fleet/src/main.ts`
- Create: `apps/fleet/src/adapters/log.ts`, `apps/fleet/src/adapters/crash.ts`, `apps/fleet/src/adapters/keys.ts`
- Create: `apps/fleet/src/adapters/migrations.ts`, `apps/fleet/src/adapters/db.ts`, `apps/fleet/src/adapters/nodes-store.ts`
- Create: `apps/fleet/src/adapters/audit.ts`, `apps/fleet/src/adapters/socket-request.ts`
- Modify: `package.json` (a `fleet` script), `package-lock.json` (via `npm install`)
- Test: `apps/fleet/test/helpers/temp.ts`, `apps/fleet/test/config.test.ts`, `apps/fleet/test/log.test.ts`,
  `apps/fleet/test/keys.test.ts`, `apps/fleet/test/migrations.test.ts`, `apps/fleet/test/join-codes.test.ts`,
  `apps/fleet/test/audit.test.ts`, `apps/fleet/test/cli.test.ts`

**Interfaces:**
- Consumes (Task 1, `@morndo/protocol`): `NODE_NAME`, `LIMITS.joinCodeTtlMs`, `LIMITS.auditKeepMs`,
  `formatJoinString(j: JoinString): string` (`JoinString` = `{ url, fleetKey, code, node }`), `parseJoinString(s):
  JoinString | null`, `fleetUrlOk(url): boolean`, `fleetSigPayload`, `nodeSigPayload`, `type HookEvent`, `type Alert`,
  `type AlertKind`.
- Produces:
  - `config.ts`:
    - `type HookPath = HookEvent["path"]`
    - `type Subscriber = { name: string; url: string; paths: HookPath[] }`
    - `type FleetConfig = { listen: { host: string; port: number }; socketPath: string; dbPath: string; keyPath: string; publicUrl: string; subscribers: Subscriber[] }`
    - `HOOK_PATHS: HookPath[]`, `class ConfigError extends Error`
    - `homeOf(env?): string` (`env.HOME || os.homedir()`), `configPath(env?, home = homeOf(env)): string`,
      `defaults(home: string): FleetConfig`
    - `loadConfig(o?: { env?: NodeJS.ProcessEnv; home?: string }): FleetConfig`; it refuses a `publicUrl` a join
      string can't carry (`formatJoinString` takes `ws://` or `wss://` and printable ASCII only) or that fails
      `fleetUrlOk` (`ws://` only to this machine), and a `listen.host` that isn't loopback (127.x.x.x, `localhost`, `::1`)
  - `adapters/log.ts`: `type Logger = Record<"debug" | "info" | "warn" | "error", (message: string, error?: unknown) => void>`,
    `createLogger(o?: { level?; home?; sink? }): Logger`, `log: Logger`, `redact(text, home?): string`.
  - `adapters/crash.ts`: `exitOnCrash(log: Logger, exit?): void`.
  - `adapters/keys.ts`:
    - `type FleetKey = { publicKey: string /* SPKI DER base64 */; sign(payload: string): string /* base64 */ }`
    - `loadOrCreateFleetKey(path: string): FleetKey`, `class KeyFileUnsafe extends Error`
    - `parsePublicKey(spkiBase64: string): KeyObject | null`
    - `verifySig(spkiBase64: string, payload: string, sigBase64: string): boolean`
  - `adapters/migrations.ts`: `MIGRATIONS`, `migrate(db, migrations?): { from: number; to: number }`,
    `class DatabaseFromFuture`.
  - `adapters/db.ts`: `openFleetDb(path: string): Database.Database` (WAL, synchronous=FULL, foreign keys, migrated).
  - `adapters/nodes-store.ts`:
    - `class NodesStore`: `constructor(db, now?: () => number)`
      - `issueCode(name: string): Issued`, `redeem(code: string, node: string, publicKey: string): Redeemed`: a code
        issued for another name than `node` is refused (`wrong_node`) and stays unused
      - `node(name): NodeRow | null`, `active(name): NodeRow | null`, `list(): NodeRow[]`, `revoke(name): boolean`
      - `nextEpoch(name): number`, `seen(name, agentVersion?): void`, `recordSource(name, source): string | null`
    - `type Issued = { ok: true; code: string; expiresAt: number } | { ok: false; refused: "bad_name" | "exists" }`
    - `type Redeemed = { ok: true; node: string } | { ok: false; refused: "unknown" | "expired" | "used" | "wrong_node" | "exists" | "bad_key" }`
  - `adapters/audit.ts`:
    - `class Audit`: `constructor(db, o?: { now?; log?; onAlert?: (a: Alert) => void })`
      - `record(actor: string, action: string, node: string | null, detail?: Record<string, unknown>): void`
      - `alert(kind: AlertKind, node: string | null, detail?): Alert` writes the action `"alert.<kind>"`, logs a
        warning, and hands the `Alert` (`id` = the row's `seq`) to `onAlert`
      - `recent(limit?): AuditEntry[]`, `alerts(since: number): AuditEntry[]`, `of(action: string): AuditEntry[]`
      - `recentAlerts(limit = ALERTS_SERVED): Alert[]`: the latest 500 of the security kinds (`SECURITY_ALERTS`:
        `instance_conflict`, `source_changed`, `clock_offset`) and the latest 500 of the others, merged oldest first
        (Task 12 serves them)
      - `prune(): number`: deletes rows older than `LIMITS.auditKeepMs` (90 days), alerts included (Task 11 runs it on
        start and daily)
  - `adapters/socket-request.ts`: `socketRequest(socketPath, method, path, body?, timeoutMs?): Promise<{ status: number; body: unknown } | null>`.
  - The CLI: `morndo-fleet node add <name> | node list | node revoke <name> | status`.
    - Exit codes: 2 for usage, 1 for a refusal, 78 for config, key or database trouble.
    - `node revoke` calls `POST /v1/nodes/<name>/revoke` when the service answers; Task 12 serves that route.
  - Test helper `test/helpers/temp.ts`: `tempDir(): string` (removed after each test).

- [ ] **Step 1: Add the workspace**

Create `apps/fleet/package.json`:

```json
{
  "name": "@morndo/fleet",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": {
    "morndo-fleet": "./src/main.ts"
  },
  "scripts": {
    "typecheck": "tsc -p ."
  },
  "dependencies": {
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

Create `apps/fleet/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["esnext"], "types": ["node"] },
  "include": ["src", "test"]
}
```

Task 1 already lists `apps/fleet` in the vitest units include, in `tsconfig.tests.json` and in the `.oxlintrc.json`
`no-console` override, and `npm run check` runs every workspace's `typecheck` script, so the workspace's own
`typecheck` (`tsc -p .`) is all `check` needs. (`tsc -p apps/fleet` can't be in `check` before this task: it fails
with TS5058.)

In `package.json`, replace:

```text
"hub": "node apps/hub/src/main.ts",
```

with:

```text
"hub": "node apps/hub/src/main.ts",
    "fleet": "node apps/fleet/src/main.ts",
```

Run: `npm install`
Expected: exit 0; `package-lock.json` gains the `apps/fleet` workspace and the `node_modules/@morndo/fleet` link, and nothing else

- [ ] **Step 2: Write the failing config test (with the temp-dir helper)**

Create `apps/fleet/test/helpers/temp.ts`:

```ts
// Temporary directories for the fleet's tests, removed after each test. Short names: a Unix socket path must stay
// under 104 bytes on macOS (108 on Linux), and the client API's socket lives inside one of these.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

const dirs: string[] = [];
export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "mf-"));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
```

Create `apps/fleet/test/config.test.ts`:

```ts
// The fleet's settings: defaults without a file, the file over the defaults, and a clear refusal for a file that
// doesn't fit (a typo never falls back to a default silently).
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, HOOK_PATHS, configPath, homeOf, loadConfig } from "../src/config.ts";
import { tempDir } from "./helpers/temp.ts";

const withFile = (content: unknown) => {
  const home = tempDir();
  const file = join(home, "fleet.json");
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return { home, env: { MORNDO_FLEET_CONFIG: file } };
};

describe("fleet config", () => {
  it("runs on defaults when there is no file", () => {
    const home = tempDir();
    expect(configPath({}, home)).toBe(join(home, ".config/morndo-fleet/config.json"));
    expect(loadConfig({ env: {}, home })).toEqual({
      listen: { host: "127.0.0.1", port: 8791 },
      socketPath: join(home, ".local/state/morndo-fleet/fleet.sock"),
      dbPath: join(home, ".local/share/morndo-fleet/fleet.db"),
      keyPath: join(home, ".local/share/morndo-fleet/fleet-key.pem"),
      publicUrl: "ws://127.0.0.1:8791/agent",
      subscribers: [],
    });
  });

  it("takes its home from HOME, a HOME set but empty counting as unset, and never from XDG_*", () => {
    const home = tempDir();
    expect(configPath({ HOME: home, XDG_CONFIG_HOME: "/elsewhere" })).toBe(join(home, ".config/morndo-fleet/config.json"));
    expect(homeOf({ HOME: "" })).toBe(homedir());                                     // never "" (a relative path)
    expect(loadConfig({ env: { HOME: home, XDG_STATE_HOME: "/elsewhere", XDG_DATA_HOME: "/elsewhere" } }).dbPath).toBe(join(home, ".local/share/morndo-fleet/fleet.db"));
  });

  it("takes the file's settings over the defaults and expands ~/", () => {
    const { home, env } = withFile({
      listen: { host: "127.0.0.1", port: 0 }, socketPath: "~/run/f.sock", publicUrl: "wss://fleet.example.test/agent",
      subscribers: [{ name: "kira", url: "http://127.0.0.1:8788/hooks", paths: ["/hook/stop", "/cc", "/cc"] }],
    });
    const c = loadConfig({ env, home });
    expect(c.listen).toEqual({ host: "127.0.0.1", port: 0 });
    expect(c.socketPath).toBe(join(home, "run/f.sock"));
    expect(c.dbPath).toBe(join(home, ".local/share/morndo-fleet/fleet.db"));
    expect(c.publicUrl).toBe("wss://fleet.example.test/agent");
    expect(c.subscribers).toEqual([{ name: "kira", url: "http://127.0.0.1:8788/hooks", paths: ["/hook/stop", "/cc"] }]);
    expect(HOOK_PATHS).toEqual(["/cc", "/sl", "/hook/stop", "/hook/failure", "/notify", "/file"]);
  });

  it("takes a loopback listen address and a ws:// URL to this machine, or any wss:// URL", () => {
    for (const host of ["127.0.0.1", "127.0.0.2", "::1", "localhost"]) {
      const { home, env } = withFile({ listen: { host, port: 8791 } });
      expect(loadConfig({ env, home }).listen.host).toBe(host);
    }
    for (const publicUrl of ["ws://127.0.0.1:8791/agent", "ws://localhost:8791/agent", "ws://[::1]:8791/agent", "wss://fleet.tail1234.ts.net/agent"]) {
      const { home, env } = withFile({ publicUrl });
      expect(loadConfig({ env, home }).publicUrl).toBe(publicUrl);
    }
  });

  it("refuses a file that doesn't fit, naming the setting", () => {
    const cases: [unknown, RegExp][] = [
      ["{not json", /not valid JSON/],
      [[1, 2], /JSON object/],
      [{ lisen: {} }, /unknown settings: lisen/],
      [{ listen: { host: "127.0.0.1", port: 70000 } }, /listen/],
      [{ listen: { host: "0.0.0.0", port: 8791 } }, /listen.host must be a loopback address/],             // negative control: plain on the network
      [{ listen: { host: "100.64.0.7", port: 8791 } }, /listen.host must be a loopback address/],
      [{ publicUrl: "ws://100.64.0.7:8791/agent" }, /publicUrl must be wss:\/\/, or ws:\/\/ to this machine/],   // negative control: clear text off the machine
      [{ publicUrl: "ws://localhost.example.test/agent" }, /publicUrl must be wss:\/\/, or ws:\/\/ to this machine/],
      [{ dbPath: "relative/fleet.db" }, /dbPath must be absolute/],
      [{ publicUrl: "http://x/agent" }, /publicUrl must start with ws: or wss:/],
      [{ publicUrl: "wss://flëet.example.test/agent" }, /publicUrl must be printable ASCII/],
      [{ subscribers: {} }, /subscribers must be a list/],
      [{ subscribers: [{ name: "Kira", url: "http://x/", paths: ["/cc"] }] }, /name must match/],
      [{ subscribers: [{ name: "kira", url: "ftp://x/", paths: ["/cc"] }] }, /url must start with http: or https:/],
      [{ subscribers: [{ name: "kira", url: "http://x/", paths: [] }] }, /paths must list at least one/],
      [{ subscribers: [{ name: "kira", url: "http://x/", paths: ["/everything"] }] }, /"\/everything" is not one of/],
      [{ subscribers: [{ name: "kira", url: "http://x/", paths: ["/cc"], secret: "x" }] }, /unknown settings: secret/],
      [{ subscribers: [{ name: "a", url: "http://x/", paths: ["/cc"] }, { name: "a", url: "http://y/", paths: ["/cc"] }] }, /used twice/],
    ];
    for (const [content, message] of cases) {
      const { home, env } = withFile(content);
      expect(() => loadConfig({ env, home }), JSON.stringify(content)).toThrow(ConfigError);
      expect(() => loadConfig({ env, home }), JSON.stringify(content)).toThrow(message);
    }
  });
});
```

- [ ] **Step 3: Run it and see it fail**

Run: `npx vitest run apps/fleet/test/config.test.ts`
Expected: FAIL: `Error: Cannot find module '../src/config.ts'`

- [ ] **Step 4: Implement the config**

Create `apps/fleet/src/config.ts`:

```ts
// The fleet service's settings (ADR-0012; spec section 5.6): one JSON file, ~/.config/morndo-fleet/config.json, or the
// file MORNDO_FLEET_CONFIG names. Every setting has a default, so a missing file runs the single-host setup. A file
// that doesn't fit is refused with one sentence naming the setting: a typo never silently falls back to a default.
// Every default path derives from HOME (`HOME || os.homedir()`: a HOME set but empty counts as unset, never as a
// relative path), never from XDG_*, so a test or a QA run gives each process its own HOME.
// The agent endpoint never listens on the network itself (spec 8): `listen.host` must be a loopback address, and
// Tailscale Serve terminates TLS in front of it; `publicUrl`, which every node dials, must be wss://, or ws:// only to
// this machine (fleetUrlOk), so no proof or op ever crosses a network in clear text.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fleetUrlOk, type HookEvent } from "@morndo/protocol";

export type HookPath = HookEvent["path"];
export type Subscriber = { name: string; url: string; paths: HookPath[] };
export type FleetConfig = {
  listen: { host: string; port: number };   // the agent endpoint, /agent
  socketPath: string;                         // the client API's Unix socket; its directory must be 0700 and ours
  dbPath: string;
  keyPath: string;                            // the fleet's Ed25519 private key (PKCS#8 PEM, mode 0600)
  publicUrl: string;                          // the agent endpoint as nodes dial it; goes into every join string
  subscribers: Subscriber[];                  // the hook bus's static subscribers
};

export class ConfigError extends Error {
  constructor(message: string) { super(message); this.name = "ConfigError"; }
}

// Every hook path, once: a Record over the union, so a path the protocol adds fails to compile here until listed.
const PATHS: Record<HookPath, true> = { "/cc": true, "/sl": true, "/hook/stop": true, "/hook/failure": true, "/notify": true, "/file": true };
export const HOOK_PATHS = Object.keys(PATHS) as HookPath[];
const SUBSCRIBER_NAME = /^[a-z0-9-]{1,32}$/;
// The public URL goes into every join string, which carries printable ASCII only (formatJoinString refuses the rest).
const JOIN_URL = /^wss?:\/\/[!-~]{1,2040}$/;
// The loopback names and addresses the agent endpoint may listen on.
const LOOPBACK_HOST = /^(?:127(?:\.\d{1,3}){3}|localhost|::1)$/;
const KEYS = new Set(["listen", "socketPath", "dbPath", "keyPath", "publicUrl", "subscribers"]);

export const homeOf = (env: NodeJS.ProcessEnv = process.env): string => env.HOME || homedir();

export const configPath = (env: NodeJS.ProcessEnv = process.env, home: string = homeOf(env)) =>
  env.MORNDO_FLEET_CONFIG || join(home, ".config/morndo-fleet/config.json");

export function defaults(home: string): FleetConfig {
  return {
    listen: { host: "127.0.0.1", port: 8791 },
    socketPath: join(home, ".local/state/morndo-fleet/fleet.sock"),
    dbPath: join(home, ".local/share/morndo-fleet/fleet.db"),
    keyPath: join(home, ".local/share/morndo-fleet/fleet-key.pem"),
    publicUrl: "ws://127.0.0.1:8791/agent",
    subscribers: [],
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function path(v: unknown, name: string, home: string): string {
  if (typeof v !== "string" || v === "") throw new ConfigError(`${name} must be a path`);
  const p = v === "~" ? home : v.startsWith("~/") ? join(home, v.slice(2)) : v;
  if (!isAbsolute(p)) throw new ConfigError(`${name} must be absolute or start with ~/: ${JSON.stringify(v)}`);
  return p;
}

function url(v: unknown, name: string, protocols: string[]): string {
  if (typeof v !== "string") throw new ConfigError(`${name} must be a URL`);
  let u: URL;
  try { u = new URL(v); } catch { throw new ConfigError(`${name} is not a URL: ${JSON.stringify(v)}`); }
  if (!protocols.includes(u.protocol)) throw new ConfigError(`${name} must start with ${protocols.join(" or ")}//: ${JSON.stringify(v)}`);
  return v;
}

function publicUrl(v: unknown): string {
  const u = url(v, "publicUrl", ["ws:", "wss:"]);
  if (!JOIN_URL.test(u)) throw new ConfigError(`publicUrl must be printable ASCII without spaces (a join string carries it): ${JSON.stringify(u)}`);
  if (!fleetUrlOk(u)) throw new ConfigError(`publicUrl must be wss://, or ws:// to this machine (127.0.0.1, localhost, [::1]): a node sends its proof and every op over it: ${JSON.stringify(u)}`);
  return u;
}

function subscribers(v: unknown): Subscriber[] {
  if (!Array.isArray(v)) throw new ConfigError("subscribers must be a list");
  const seen = new Set<string>();
  return v.map((s, i) => {
    const at = `subscribers[${i}]`;
    if (!isObject(s)) throw new ConfigError(`${at} must be an object with name, url and paths`);
    const extra = Object.keys(s).filter(k => k !== "name" && k !== "url" && k !== "paths");
    if (extra.length) throw new ConfigError(`${at} has unknown settings: ${extra.join(", ")}`);
    if (typeof s.name !== "string" || !SUBSCRIBER_NAME.test(s.name)) throw new ConfigError(`${at}.name must match ${SUBSCRIBER_NAME}`);
    if (seen.has(s.name)) throw new ConfigError(`${at}.name "${s.name}" is used twice`);
    seen.add(s.name);
    if (!Array.isArray(s.paths) || s.paths.length === 0) throw new ConfigError(`${at}.paths must list at least one of ${HOOK_PATHS.join(", ")}`);
    const paths = s.paths.map(p => {
      if (typeof p !== "string" || !Object.hasOwn(PATHS, p)) throw new ConfigError(`${at}.paths: ${JSON.stringify(p)} is not one of ${HOOK_PATHS.join(", ")}`);
      return p as HookPath;
    });
    return { name: s.name, url: url(s.url, `${at}.url`, ["http:", "https:"]), paths: [...new Set(paths)] };
  });
}

// The file's settings over the defaults. Throws ConfigError for a file that isn't JSON or doesn't fit.
export function loadConfig(o: { env?: NodeJS.ProcessEnv; home?: string } = {}): FleetConfig {
  const env = o.env ?? process.env;
  const home = o.home ?? homeOf(env);
  const file = configPath(env, home);
  const base = defaults(home);
  if (!existsSync(file)) return base;
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new ConfigError(`${file} is not valid JSON: ${(e as Error).message}`); }
  if (!isObject(raw)) throw new ConfigError(`${file} must hold a JSON object`);
  const unknown = Object.keys(raw).filter(k => !KEYS.has(k));
  if (unknown.length) throw new ConfigError(`${file} has unknown settings: ${unknown.join(", ")}`);
  let listen = base.listen;
  if (raw.listen !== undefined) {
    const l = raw.listen;
    if (!isObject(l) || typeof l.host !== "string" || l.host === "" || !Number.isInteger(l.port) || (l.port as number) < 0 || (l.port as number) > 65535) {
      throw new ConfigError("listen must be { host, port } with a port from 0 to 65535");
    }
    if (!LOOPBACK_HOST.test(l.host)) {
      throw new ConfigError(`listen.host must be a loopback address (127.0.0.1, ::1 or localhost); Tailscale Serve terminates TLS in front of it: ${JSON.stringify(l.host)}`);
    }
    listen = { host: l.host, port: l.port as number };
  }
  return {
    listen,
    socketPath: raw.socketPath === undefined ? base.socketPath : path(raw.socketPath, "socketPath", home),
    dbPath: raw.dbPath === undefined ? base.dbPath : path(raw.dbPath, "dbPath", home),
    keyPath: raw.keyPath === undefined ? base.keyPath : path(raw.keyPath, "keyPath", home),
    publicUrl: raw.publicUrl === undefined ? base.publicUrl : publicUrl(raw.publicUrl),
    subscribers: raw.subscribers === undefined ? base.subscribers : subscribers(raw.subscribers),
  };
}
```

- [ ] **Step 5: Run it and see it pass**

Run: `npx vitest run apps/fleet/test/config.test.ts`
Expected: PASS (5 tests)

Then check that the two network rules bite, each change restored before the next:
- In `config.ts`, change `    if (!LOOPBACK_HOST.test(l.host)) {` to `    if (!LOOPBACK_HOST.test(l.host) && false) {`. Expected: 1 failure, in "refuses a file that doesn't fit", for `{"listen":{"host":"0.0.0.0","port":8791}}`.
- In `config.ts`, change `  if (!fleetUrlOk(u)) throw` to `  if (!fleetUrlOk(u) && false) throw`. Expected: 1 failure, in the same test, for `{"publicUrl":"ws://100.64.0.7:8791/agent"}`.

- [ ] **Step 6: Commit**

```bash
git add apps/fleet/package.json apps/fleet/tsconfig.json apps/fleet/src/config.ts apps/fleet/test/helpers/temp.ts apps/fleet/test/config.test.ts package.json package-lock.json
git commit -m "feat(fleet): add the morndo-fleet workspace and its settings file"
```

- [ ] **Step 7: Write the failing logger test**

Create `apps/fleet/test/log.test.ts`:

```ts
// The fleet's logger redacts every line (Global Constraints: never log typed text, hook bodies, keys or codes), with
// error stacks and causes included.
import { describe, expect, it } from "vitest";
import { createLogger, redact } from "../src/adapters/log.ts";

describe("the fleet logger", () => {
  it("redacts join strings, key files, secret fields, tailnet names and addresses, and the home directory", () => {
    const line = [
      "join morndo-join:1:eyJ1cmwiOiJ3c3M6Ly9mbGVldC9hZ2VudCJ9 failed",
      "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIA==\n-----END PRIVATE KEY-----",
      `{"code":"q3J0-abc","sig":"AAAA","publicKey":"MCowBQ","body":"secret words","text":"typed"}`,
      "from pc.tail1234.ts.net at 100.101.102.103 and fd7a:115c:a1e0::1, mail me@example.test",
      "/home/owner/.local/share/morndo-fleet/fleet.db",
    ].join("\n");
    const out = redact(line, "/home/owner");
    expect(out).toContain("morndo-join:1:[redacted]");
    expect(out).toContain("[pem redacted]");
    expect(out).toContain(`{"code":"[redacted]","sig":"[redacted]","publicKey":"[redacted]","body":"[redacted]","text":"[redacted]"}`);
    expect(out).toContain("[tailnet-host]");
    expect(out).not.toMatch(/100\.101\.102\.103|fd7a:115c|me@example|q3J0|MC4CAQ|secret words|typed"/);
    expect(out).toContain("~/.local/share/morndo-fleet/fleet.db");
  });

  it("logs levels at or above its own, through one sink, error causes included and redacted", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "info", home: "/home/owner", sink: line => lines.push(line) });
    log.debug("not shown");
    log.warn("join failed", new Error("bad code morndo-join:1:abcdef", { cause: new Error("at /home/owner/x") }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[fleet\] warn: join failed\nError: bad code morndo-join:1:\[redacted\]/);
    expect(lines[0]).toContain("Caused by: Error: at ~/x");
  });
});
```

- [ ] **Step 8: Run it and see it fail**

Run: `npx vitest run apps/fleet/test/log.test.ts`
Expected: FAIL: `Error: Cannot find module '../src/adapters/log.ts'`

- [ ] **Step 9: Implement the logger and the crash handlers**

Create `apps/fleet/src/adapters/log.ts`:

```ts
// The fleet service's logger, in the style of the hub's (apps/hub/src/adapters/log.ts, ADR-0008 A4): levels, and one
// sink that redacts every line, error stacks included. Hook bodies, typed text, keys and join codes are never passed
// to it in the first place; the redactions are the backstop for what slips through an error message.
import { homedir } from "node:os";

export type Level = "debug" | "info" | "warn" | "error";
export type Sink = (line: string, level: Level) => void;
export type Logger = Record<Level, (message: string, error?: unknown) => void>;

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_CAUSES = 5;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const REDACTIONS: [RegExp, string][] = [
  [/(morndo-join:1:)[A-Za-z0-9_-]+/g, "$1[redacted]"],                                    // join strings carry a code
  [/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, "[pem redacted]"],             // a key file's contents
  [/("(?:code|sig|fleetSig|nonce|clientNonce|publicKey|fleetKey|text|data|bytes|body)"\s*:\s*")(?:[^"\\]|\\.)*(")/g, "$1[redacted]$2"],
  [/\b(Bearer\s+)[\w.~+/=-]+/gi, "$1[redacted]"],
  [/[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*/g, "[email]"],
  [/\b(?:[A-Za-z0-9-]+\.)+ts\.net\b/gi, "[tailnet-host]"],                                  // MagicDNS names
  [/(?<![\d.])100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}(?!\d)/g, "[tailnet-ip]"],   // 100.64.0.0/10
  [/\bfd7a:115c:a1e0(?::[0-9a-f]{0,4})*/gi, "[tailnet-ip]"],                               // fd7a:115c:a1e0::/48
];

export function redact(text: string, home: string = homedir()): string {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  if (home && home !== "/") out = out.replace(new RegExp(`${escape(home.replace(/\/+$/, ""))}(?=$|[^\\w-])`, "g"), "~");
  return out;
}

// An error's stack and its causes, never its other fields (a response body an error carries stays out).
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
    sink(redact(`[fleet] ${level}: ${message}${error === undefined ? "" : `\n${toLogFormat(error)}`}`, home), level);
  };
  return { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

// The service's one logger; MORNDO_FLEET_LOG_LEVEL picks the level (default info).
export const log: Logger = createLogger({ level: levelFrom(process.env.MORNDO_FLEET_LOG_LEVEL) });
```

Create `apps/fleet/src/adapters/crash.ts`:

```ts
// Process-level crash handlers, as in the hub (apps/hub/src/adapters/crash.ts, ADR-0008 A5): an unhandled rejection or
// an uncaught exception is logged (redacted, with its causes) and the process exits 1, for the service manager to
// restart it. Agents reconnect with backoff and spool their hooks meanwhile (spec section 7).
import type { Logger } from "./log.ts";

export function exitOnCrash(log: Logger, exit: (code: number) => never = code => process.exit(code)) {
  process.on("unhandledRejection", reason => { log.error("unhandled promise rejection; exiting", reason); exit(1); });
  process.on("uncaughtException", error => { log.error("uncaught exception; exiting", error); exit(1); });
}
```

- [ ] **Step 10: Run it and see it pass**

Run: `npx vitest run apps/fleet/test/log.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 11: Commit**

```bash
git add apps/fleet/src/adapters/log.ts apps/fleet/src/adapters/crash.ts apps/fleet/test/log.test.ts
git commit -m "feat(fleet): redacting logger and crash handlers"
```

- [ ] **Step 12: Write the failing key test**

Create `apps/fleet/test/keys.test.ts`:

```ts
// The fleet's Ed25519 key: created once at mode 0600 in a 0700 directory, the same key on every later start, refused
// when others can read it; and the check of a node's signature, both ways round.
import { createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fleetSigPayload, nodeSigPayload } from "@morndo/protocol";
import { KeyFileUnsafe, loadOrCreateFleetKey, parsePublicKey, verifySig } from "../src/adapters/keys.ts";
import { tempDir } from "./helpers/temp.ts";

// The handshake's nonces are 22 to 86 characters of base64url (the protocol refuses to sign anything else).
const N1 = "nonce-1".padEnd(22, "0");
const N2 = "nonce-2".padEnd(22, "0");

const nodeKey = () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { spki: publicKey.export({ type: "spki", format: "der" }).toString("base64"), sign: (p: string) => sign(null, Buffer.from(p), privateKey).toString("base64") };
};

describe("the fleet key", () => {
  it("is created on first use with mode 0600 in a 0700 directory, and is the same key afterwards", () => {
    const path = join(tempDir(), "state", "fleet-key.pem");
    const first = loadOrCreateFleetKey(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    expect(loadOrCreateFleetKey(path).publicKey).toBe(first.publicKey);
    expect(parsePublicKey(first.publicKey)?.asymmetricKeyType).toBe("ed25519");
  });

  it("signs what a node can verify against the pinned public key, and nothing else verifies", () => {
    const key = loadOrCreateFleetKey(join(tempDir(), "k.pem"));
    const sig = key.sign(fleetSigPayload("pc", N1));
    const pinned = createPublicKey({ key: Buffer.from(key.publicKey, "base64"), format: "der", type: "spki" });
    expect(verify(null, Buffer.from(fleetSigPayload("pc", N1)), pinned, Buffer.from(sig, "base64"))).toBe(true);
    expect(verify(null, Buffer.from(fleetSigPayload("pc", N2)), pinned, Buffer.from(sig, "base64"))).toBe(false);
    expect(verify(null, Buffer.from(fleetSigPayload("mac", N1)), pinned, Buffer.from(sig, "base64"))).toBe(false);
  });

  it("refuses a key file that others can read", () => {
    const path = join(tempDir(), "k.pem");
    loadOrCreateFleetKey(path);
    chmodSync(path, 0o644);
    expect(() => loadOrCreateFleetKey(path)).toThrow(KeyFileUnsafe);
    expect(() => loadOrCreateFleetKey(path)).toThrow(/chmod 600/);
  });
});

describe("a node's proof", () => {
  it("verifies only with the node's key, over the node payload, untampered", () => {
    const n = nodeKey();
    const other = nodeKey();
    const sig = n.sign(nodeSigPayload("pc", N1));
    expect(verifySig(n.spki, nodeSigPayload("pc", N1), sig)).toBe(true);
    expect(verifySig(other.spki, nodeSigPayload("pc", N1), sig)).toBe(false);             // another node's key
    expect(verifySig(n.spki, nodeSigPayload("pc", N2), sig)).toBe(false);                  // another nonce
    expect(verifySig(n.spki, fleetSigPayload("pc", N1), n.sign(fleetSigPayload("pc", N1)))).toBe(true);
    expect(verifySig(n.spki, nodeSigPayload("pc", N1), n.sign(fleetSigPayload("pc", N1)))).toBe(false);   // domain separated
    const tampered = Buffer.from(sig, "base64");
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    expect(verifySig(n.spki, nodeSigPayload("pc", N1), tampered.toString("base64"))).toBe(false);
    expect(verifySig("not a key", nodeSigPayload("pc", N1), sig)).toBe(false);
    expect(verifySig(n.spki, nodeSigPayload("pc", N1), "%%%")).toBe(false);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
    expect(parsePublicKey(rsa)).toBeNull();                                              // only Ed25519 keys are node keys
  });
});
```

- [ ] **Step 13: Run it and see it fail**

Run: `npx vitest run apps/fleet/test/keys.test.ts`
Expected: FAIL: `Error: Cannot find module '../src/adapters/keys.ts'`

- [ ] **Step 14: Implement the fleet key**

Create `apps/fleet/src/adapters/keys.ts`:

```ts
// The fleet's own Ed25519 key (spec 5.1, 5.2), pinned by every node from its join string, and the check of a node's
// proof. Node.js 24 crypto: generateKeyPairSync('ed25519'), sign(null, …) and verify(null, …) take no digest for
// Ed25519; public keys travel as SPKI DER in base64. https://nodejs.org/docs/latest-v24.x/api/crypto.html (read
// 2026-10-06).
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type FleetKey = { publicKey: string /* SPKI DER, base64 */; sign(payload: string): string /* base64 */ };

export class KeyFileUnsafe extends Error {
  constructor(message: string) { super(message); this.name = "KeyFileUnsafe"; }
}

function create(path: string): KeyObject | null {
  const key = generateKeyPairSync("ed25519").privateKey;
  try {
    writeFileSync(path, key.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
    return key;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return null;   // another process created it first: use that one
    throw e;
  }
}

// The key at `path`, created on first use (mode 0600, its directory 0700). A key file anyone but its owner can read is
// refused, never used: a node trusts whatever holds it.
export function loadOrCreateFleetKey(path: string): FleetKey {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let privateKey = existsSync(path) ? null : create(path);
  if (!privateKey) {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) throw new KeyFileUnsafe(`${path} has mode ${mode.toString(8)}; it must be readable by its owner only (chmod 600)`);
    privateKey = createPrivateKey(readFileSync(path));
  }
  if (privateKey.asymmetricKeyType !== "ed25519") throw new KeyFileUnsafe(`${path} holds a ${privateKey.asymmetricKeyType ?? "unknown"} key, not Ed25519`);
  const key = privateKey;
  return {
    publicKey: createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64"),
    sign: payload => sign(null, Buffer.from(payload, "utf8"), key).toString("base64"),
  };
}

// A node's public key as it arrives in `join`: an Ed25519 SPKI DER key in base64, or null.
export function parsePublicKey(spkiBase64: string): KeyObject | null {
  try {
    const key = createPublicKey({ key: Buffer.from(spkiBase64, "base64"), format: "der", type: "spki" });
    return key.asymmetricKeyType === "ed25519" ? key : null;
  } catch { return null; }
}

// Whether `sigBase64` is the holder of `spkiBase64`'s signature over `payload`. Anything malformed is false, never a throw.
export function verifySig(spkiBase64: string, payload: string, sigBase64: string): boolean {
  const key = parsePublicKey(spkiBase64);
  if (!key) return false;
  try { return verify(null, Buffer.from(payload, "utf8"), key, Buffer.from(sigBase64, "base64")); } catch { return false; }
}
```

- [ ] **Step 15: Run it and see it pass**

Run: `npx vitest run apps/fleet/test/keys.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 16: Commit**

```bash
git add apps/fleet/src/adapters/keys.ts apps/fleet/test/keys.test.ts
git commit -m "feat(fleet): the fleet's own Ed25519 key, created once at mode 0600"
```

- [ ] **Step 17: Write the failing database test**

Create `apps/fleet/test/migrations.test.ts`:

```ts
// fleet.db's numbered migrations (Global Constraints: in the style of the hub's): a fresh database gets every table,
// WAL and synchronous=FULL; a database from a newer fleet service is refused and left untouched.
import Database from "better-sqlite3";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openFleetDb } from "../src/adapters/db.ts";
import { DatabaseFromFuture, MIGRATIONS, migrate, type Migration } from "../src/adapters/migrations.ts";
import { tempDir } from "./helpers/temp.ts";

const LATEST = MIGRATIONS.length;
const tables = (db: Database.Database) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(r => r.name);
const columns = (db: Database.Database, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name);

describe("fleet.db migrations", () => {
  it("a fresh database gets every table, WAL, synchronous=FULL and foreign keys", () => {
    const db = openFleetDb(join(tempDir(), "data", "fleet.db"));
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST);
    expect(tables(db)).toEqual(["audit", "dead_letters", "deliveries", "join_codes", "lanes", "nodes", "outbox", "stream_hwm"]);
    expect(columns(db, "nodes")).toEqual(["name", "public_key", "created_at", "revoked_at", "last_seen_at", "last_source", "agent_version", "conn_epoch"]);
    expect(columns(db, "join_codes")).toEqual(["hash", "node", "expires_at", "used_at"]);
    expect(columns(db, "stream_hwm")).toEqual(["node", "stream_id", "seq"]);
    expect(columns(db, "lanes")).toEqual(["name", "node", "worker_id", "registered_at", "conflict"]);
    expect(columns(db, "outbox")).toEqual(["id", "node", "stream_id", "seq", "path", "body", "created_at"]);
    expect(columns(db, "deliveries")).toEqual(["outbox_id", "subscriber", "state", "attempts", "next_at", "delivered_at"]);
    expect(columns(db, "audit")).toEqual(["seq", "at", "actor", "action", "node", "detail"]);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("synchronous", { simple: true })).toBe(2);                      // 2 = FULL
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(migrate(db)).toEqual({ from: LATEST, to: LATEST });
    db.close();
  });

  it("numbers migrations 1, 2, 3 … with no gaps", () => {
    expect(MIGRATIONS.map(m => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
  });

  it("refuses a database from a newer fleet service, and leaves it untouched", () => {
    const path = join(tempDir(), "fleet.db");
    const db = new Database(path);
    db.exec("CREATE TABLE future_thing (x)");
    db.pragma(`user_version = ${LATEST + 3}`);
    db.close();
    expect(() => openFleetDb(path)).toThrow(DatabaseFromFuture);
    const again = new Database(path);
    expect(again.pragma("user_version", { simple: true })).toBe(LATEST + 3);
    expect(tables(again)).toEqual(["future_thing"]);
    again.close();
  });

  it("a failing migration rolls back the whole run", () => {
    const db = new Database(join(tempDir(), "fleet.db"));
    const failing: Migration[] = [...MIGRATIONS, { version: LATEST + 1, name: "fails", up: d => { d.exec("CREATE TABLE half (x)"); throw new Error("boom"); } }];
    expect(() => migrate(db, failing)).toThrow(/boom/);
    expect(db.pragma("user_version", { simple: true })).toBe(0);
    expect(tables(db)).toEqual([]);
    db.close();
  });
});
```

- [ ] **Step 18: Run it and see it fail**

Run: `npx vitest run apps/fleet/test/migrations.test.ts`
Expected: FAIL: `Error: Cannot find module '../src/adapters/db.ts'`

- [ ] **Step 19: Implement the migrations and opening fleet.db**

Create `apps/fleet/src/adapters/migrations.ts`:

```ts
// Numbered schema migrations for fleet.db, in the style of the hub's (apps/hub/src/adapters/migrations.ts, ADR-0008
// A1): the version is SQLite's user_version; every pending migration runs in one IMMEDIATE transaction that also sets
// the version, so a failure leaves the database as it was; a database written by a newer fleet service is refused.
import type Database from "better-sqlite3";

export type Migration = { version: number; name: string; up(db: Database.Database): void };

export class DatabaseFromFuture extends Error {
  readonly found: number;
  readonly known: number;
  constructor(found: number, known: number) {
    super(`The database is at schema version ${found}, but this fleet service knows migrations only up to ${known}.`);
    this.name = "DatabaseFromFuture";
    this.found = found;
    this.known = known;
  }
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "the fleet schema: nodes, join codes, stream marks, lanes, the hook outbox, dead letters, audit (ADR-0012)",
    up: db => db.exec(`
      -- conn_epoch: the number of the node's latest welcome, a fencing token that only grows, across restarts too.
      CREATE TABLE nodes (
        name TEXT PRIMARY KEY, public_key TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER,
        last_seen_at INTEGER, last_source TEXT, agent_version TEXT, conn_epoch INTEGER NOT NULL DEFAULT 0);
      -- Only the SHA-256 of a code is kept (spec 5.1).
      CREATE TABLE join_codes (hash TEXT PRIMARY KEY, node TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
      CREATE TABLE stream_hwm (node TEXT NOT NULL, stream_id TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (node, stream_id));
      CREATE TABLE lanes (
        name TEXT PRIMARY KEY, node TEXT NOT NULL, worker_id TEXT, registered_at INTEGER NOT NULL, conflict INTEGER NOT NULL DEFAULT 0);
      -- body: the whole hook event as JSON, exactly what each subscriber is sent.
      CREATE TABLE outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT, node TEXT NOT NULL, stream_id TEXT NOT NULL, seq INTEGER NOT NULL,
        path TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (node, stream_id, seq));
      CREATE TABLE deliveries (
        outbox_id INTEGER NOT NULL REFERENCES outbox(id) ON DELETE CASCADE, subscriber TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'delivered', 'dead', 'dropped')), attempts INTEGER NOT NULL DEFAULT 0,
        next_at INTEGER NOT NULL, delivered_at INTEGER, PRIMARY KEY (outbox_id, subscriber));
      CREATE INDEX deliveries_by_subscriber ON deliveries (subscriber, state);
      CREATE TABLE dead_letters (
        id INTEGER PRIMARY KEY AUTOINCREMENT, subscriber TEXT NOT NULL, node TEXT NOT NULL, stream_id TEXT NOT NULL,
        seq INTEGER NOT NULL, path TEXT NOT NULL, body TEXT NOT NULL, reason TEXT NOT NULL, attempts INTEGER NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, node TEXT, detail TEXT NOT NULL);
      -- alerts by kind (GET /v1/alerts) and the 90-day retention, without a scan of every op the audit keeps
      CREATE INDEX audit_by_action ON audit (action, seq);
      CREATE INDEX audit_by_at ON audit (at);
    `),
  },
];

// Runs every migration newer than the database's user_version, in order, in one IMMEDIATE transaction that ends by
// setting user_version to the newest one. Throws DatabaseFromFuture, changing nothing, if the database is newer.
export function migrate(db: Database.Database, migrations: readonly Migration[] = MIGRATIONS): { from: number; to: number } {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`migration ${m.name} is numbered ${m.version}, expected ${i + 1}`);
  });
  const known = migrations.length;
  const version = () => db.pragma("user_version", { simple: true }) as number;
  const first = version();
  if (first > known) throw new DatabaseFromFuture(first, known);
  if (first === known) return { from: first, to: first };
  // Read again under the write lock IMMEDIATE takes: the service and a console command opening an old database at once
  // must not both run the same migrations.
  return db.transaction(() => {
    const from = version();
    if (from > known) throw new DatabaseFromFuture(from, known);
    for (const m of migrations.slice(from)) m.up(db);
    db.pragma(`user_version = ${known}`);
    return { from, to: known };
  }).immediate();
}
```

Create `apps/fleet/src/adapters/db.ts`:

```ts
// Opens fleet.db: WAL, and synchronous=FULL, because a hook event is acknowledged to its node only after its outbox row
// commits (spec 5.6), and in WAL mode NORMAL may lose the last commits on a power cut
// (https://www.sqlite.org/pragma.html#pragma_synchronous, read 2026-10-06). The service and its console commands both
// open it; better-sqlite3 waits up to 5 s on a lock by default.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrate } from "./migrations.ts";

export function openFleetDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = ON");
    migrate(db);                                         // refuses a database from a newer fleet service
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}
```

- [ ] **Step 20: Run it and see it pass**

Run: `npx vitest run apps/fleet/test/migrations.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 21: Commit**

```bash
git add apps/fleet/src/adapters/migrations.ts apps/fleet/src/adapters/db.ts apps/fleet/test/migrations.test.ts
git commit -m "feat(fleet): fleet.db with numbered migrations, WAL and synchronous=FULL"
```

- [ ] **Step 22: Write the failing join-code lifecycle test**

Create `apps/fleet/test/join-codes.test.ts`:

```ts
// The join-code lifecycle (spec 5.1, 9 "Unit"): single use, 10 minutes on the fleet's wall clock, bound to the name
// it was issued for, only its hash stored. Negative controls: a reused code, an expired code and a code used with
// another name are each refused.
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIMITS } from "@morndo/protocol";
import { openFleetDb } from "../src/adapters/db.ts";
import { NodesStore } from "../src/adapters/nodes-store.ts";
import { tempDir } from "./helpers/temp.ts";

const spki = () => generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
const setup = () => {
  let now = 1_800_000_000_000;
  const db = openFleetDb(join(tempDir(), "fleet.db"));
  return { db, nodes: new NodesStore(db, () => now), tick: (ms: number) => { now += ms; } };
};
const codeOf = (r: ReturnType<NodesStore["issueCode"]>) => { if (!r.ok) throw new Error(r.refused); return r.code; };

describe("join codes", () => {
  it("a code registers its node with the joining key, once", () => {
    const { nodes } = setup();
    const key = spki();
    const code = codeOf(nodes.issueCode("pc"));
    expect(Buffer.from(code, "base64url")).toHaveLength(16);                        // 128 bits
    expect(nodes.redeem(code, "pc", key)).toEqual({ ok: true, node: "pc" });
    expect(nodes.active("pc")?.publicKey).toBe(key);
    expect(nodes.redeem(code, "pc", spki())).toEqual({ ok: false, refused: "used" });     // negative control: reuse
    expect(nodes.active("pc")?.publicKey).toBe(key);                                // the first key stays
  });

  it("expires after 10 minutes on the fleet's clock", () => {
    const { nodes, tick } = setup();
    const late = codeOf(nodes.issueCode("pc"));
    const inTime = codeOf(nodes.issueCode("pc"));
    tick(LIMITS.joinCodeTtlMs - 1);
    expect(nodes.redeem(inTime, "pc", spki())).toEqual({ ok: true, node: "pc" });
    const other = codeOf(nodes.issueCode("mac"));
    tick(LIMITS.joinCodeTtlMs);
    expect(nodes.redeem(other, "mac", spki())).toEqual({ ok: false, refused: "expired" });   // negative control: expired
    expect(nodes.redeem(late, "pc", spki())).toEqual({ ok: false, refused: "expired" });
    expect(nodes.active("mac")).toBeNull();
  });

  it("a code issued for one name can never register another", () => {
    const { nodes } = setup();
    const forA = codeOf(nodes.issueCode("node-a"));
    const forB = codeOf(nodes.issueCode("node-b"));
    expect(nodes.redeem(forA, "node-b", spki())).toEqual({ ok: false, refused: "wrong_node" });   // negative control: wrong name
    expect(nodes.list()).toEqual([]);                                                 // nothing stored
    expect(nodes.redeem(forA, "node-a", spki())).toEqual({ ok: true, node: "node-a" });   // the code stayed unused
    expect(nodes.redeem(forB, "node-b", spki())).toEqual({ ok: true, node: "node-b" });   // B's own code still works for B
    expect(nodes.list().map(n => n.name)).toEqual(["node-a", "node-b"]);
  });

  it("keeps only the code's hash", () => {
    const { db, nodes } = setup();
    const code = codeOf(nodes.issueCode("pc"));
    const rows = JSON.stringify(db.prepare("SELECT * FROM join_codes").all());
    expect(rows).not.toContain(code);
    expect(rows).not.toContain(Buffer.from(code, "base64url").toString("hex"));
    expect(rows).toMatch(/"hash":"[0-9a-f]{64}"/);
  });

  it("refuses unknown and malformed codes, bad keys and bad names", () => {
    const { nodes } = setup();
    expect(nodes.redeem(Buffer.alloc(16, 7).toString("base64url"), "pc", spki())).toEqual({ ok: false, refused: "unknown" });
    expect(nodes.redeem("short", "pc", spki())).toEqual({ ok: false, refused: "unknown" });
    expect(nodes.redeem(`${codeOf(nodes.issueCode("pc"))}=`, "pc", spki())).toEqual({ ok: false, refused: "unknown" });
    expect(nodes.redeem(codeOf(nodes.issueCode("pc")), "pc", "not-a-key")).toEqual({ ok: false, refused: "bad_key" });
    for (const name of ["PC", "", "a".repeat(33), "pc.1", "pc/x", "pc ü"]) expect(nodes.issueCode(name)).toEqual({ ok: false, refused: "bad_name" });
  });

  it("an active node gets no new code until it is revoked; a revoked node joins again with a new key", () => {
    const { nodes } = setup();
    const first = codeOf(nodes.issueCode("pc"));
    const second = codeOf(nodes.issueCode("pc"));
    expect(nodes.redeem(first, "pc", spki())).toEqual({ ok: true, node: "pc" });
    expect(nodes.redeem(second, "pc", spki())).toEqual({ ok: false, refused: "exists" });   // a second code can't swap the key
    expect(nodes.issueCode("pc")).toEqual({ ok: false, refused: "exists" });
    expect(nodes.revoke("pc")).toBe(true);
    expect(nodes.revoke("pc")).toBe(false);
    expect(nodes.active("pc")).toBeNull();
    const fresh = spki();
    expect(nodes.redeem(codeOf(nodes.issueCode("pc")), "pc", fresh)).toEqual({ ok: true, node: "pc" });
    expect(nodes.active("pc")?.publicKey).toBe(fresh);
  });

  it("revoking withdraws the node's unused codes", () => {
    const { nodes } = setup();
    expect(nodes.redeem(codeOf(nodes.issueCode("pc")), "pc", spki())).toEqual({ ok: true, node: "pc" });
    nodes.revoke("pc");
    const pending = codeOf(nodes.issueCode("pc"));
    nodes.revoke("pc");                                                              // nothing active to revoke, but the code goes
    expect(nodes.redeem(pending, "pc", spki())).toEqual({ ok: false, refused: "unknown" });
  });

  it("connection epochs only grow", () => {
    const { nodes } = setup();
    nodes.redeem(codeOf(nodes.issueCode("pc")), "pc", spki());
    expect([nodes.nextEpoch("pc"), nodes.nextEpoch("pc"), nodes.nextEpoch("pc")]).toEqual([1, 2, 3]);
    expect(() => nodes.nextEpoch("nobody")).toThrow(/no node/);
  });
});
```

- [ ] **Step 23: Run it and see it fail**

Run: `npx vitest run apps/fleet/test/join-codes.test.ts`
Expected: FAIL: `Error: Cannot find module '../src/adapters/nodes-store.ts'`

- [ ] **Step 24: Implement the node registry and its join codes**

Create `apps/fleet/src/adapters/nodes-store.ts`:

```ts
// The node registry and its join codes (spec 5.1, 6). A code is 16 random bytes, shown once in the join string, bound
// to one node name, single use, and valid for LIMITS.joinCodeTtlMs on the fleet's wall clock (the only clock in this
// rule, Review Focus 4). Only its SHA-256 is stored. A join names its node, and a code redeems only for the name it was
// issued for. A join is matched by comparing the hash against every stored one with timingSafeEqual, without stopping
// at the first match.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { LIMITS, NODE_NAME } from "@morndo/protocol";
import { parsePublicKey } from "./keys.ts";

export type NodeRow = {
  name: string; publicKey: string; createdAt: number; revokedAt: number | null; lastSeenAt: number | null;
  lastSource: string | null; agentVersion: string | null; connEpoch: number;
};
export type Issued = { ok: true; code: string; expiresAt: number } | { ok: false; refused: "bad_name" | "exists" };
export type Redeemed = { ok: true; node: string } | { ok: false; refused: "unknown" | "expired" | "used" | "wrong_node" | "exists" | "bad_key" };

type Row = {
  name: string; public_key: string; created_at: number; revoked_at: number | null; last_seen_at: number | null;
  last_source: string | null; agent_version: string | null; conn_epoch: number;
};
const nodeFrom = (r: Row): NodeRow => ({
  name: r.name, publicKey: r.public_key, createdAt: r.created_at, revokedAt: r.revoked_at, lastSeenAt: r.last_seen_at,
  lastSource: r.last_source, agentVersion: r.agent_version, connEpoch: r.conn_epoch,
});

type CodeRow = { hash: string; node: string; expires_at: number; used_at: number | null };

const CODE_BYTES = 16;
const KEEP_USED_CODES_MS = 24 * 3_600_000;
const hashOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest();

export class NodesStore {
  #db: Database.Database;
  #now: () => number;

  constructor(db: Database.Database, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  // A code for `name`: refused for a name that isn't NODE_NAME or a node that is registered and not revoked (revoke
  // it first). A revoked name can be joined again, with a new key.
  issueCode(name: string): Issued {
    if (!NODE_NAME.test(name)) return { ok: false, refused: "bad_name" };
    if (this.active(name)) return { ok: false, refused: "exists" };
    const now = this.#now();
    const bytes = randomBytes(CODE_BYTES);
    const expiresAt = now + LIMITS.joinCodeTtlMs;
    this.#db.transaction(() => {
      this.#db.prepare("DELETE FROM join_codes WHERE expires_at < ?").run(now - KEEP_USED_CODES_MS);
      this.#db.prepare("INSERT INTO join_codes (hash, node, expires_at, used_at) VALUES (?, ?, ?, NULL)").run(hashOf(bytes).toString("hex"), name, expiresAt);
    })();
    return { ok: true, code: bytes.toString("base64url"), expiresAt };
  }

  // A join by `node`: the code's node takes `publicKey`. Single use: the code is marked used in the same transaction.
  // A code issued for another name is refused and stays unused (nothing is stored).
  redeem(code: string, node: string, publicKey: string): Redeemed {
    const bytes = Buffer.from(code, "base64url");
    if (bytes.length !== CODE_BYTES || bytes.toString("base64url") !== code) return { ok: false, refused: "unknown" };
    if (!parsePublicKey(publicKey)) return { ok: false, refused: "bad_key" };
    const hash = hashOf(bytes);
    return this.#db.transaction((): Redeemed => {
      const now = this.#now();
      const rows = this.#db.prepare("SELECT hash, node, expires_at, used_at FROM join_codes").all() as CodeRow[];
      const matches = rows.filter(row => timingSafeEqual(Buffer.from(row.hash, "hex"), hash));   // every row compared
      const match = matches[0];
      if (!match) return { ok: false, refused: "unknown" };
      if (match.used_at !== null) return { ok: false, refused: "used" };
      if (now >= match.expires_at) return { ok: false, refused: "expired" };
      if (match.node !== node) return { ok: false, refused: "wrong_node" };
      if (this.active(match.node)) return { ok: false, refused: "exists" };
      this.#db.prepare("UPDATE join_codes SET used_at = ? WHERE hash = ?").run(now, match.hash);
      this.#db.prepare(`INSERT INTO nodes (name, public_key, created_at) VALUES (?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET public_key = excluded.public_key, revoked_at = NULL, last_source = NULL`).run(match.node, publicKey, now);
      return { ok: true, node: match.node };
    }).immediate();
  }

  node(name: string): NodeRow | null {
    const r = this.#db.prepare("SELECT * FROM nodes WHERE name = ?").get(name) as Row | undefined;
    return r ? nodeFrom(r) : null;
  }

  active(name: string): NodeRow | null {
    const n = this.node(name);
    return n && n.revokedAt === null ? n : null;
  }

  list(): NodeRow[] {
    return (this.#db.prepare("SELECT * FROM nodes ORDER BY name").all() as Row[]).map(nodeFrom);
  }

  // Revokes a registered node and withdraws its unused codes. False when there was no active node of that name.
  revoke(name: string): boolean {
    return this.#db.transaction(() => {
      const changed = this.#db.prepare("UPDATE nodes SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL").run(this.#now(), name).changes > 0;
      this.#db.prepare("DELETE FROM join_codes WHERE node = ? AND used_at IS NULL").run(name);
      return changed;
    })();
  }

  // The next connection epoch of a node (a fencing token: it only grows, across restarts too).
  nextEpoch(name: string): number {
    const r = this.#db.prepare("UPDATE nodes SET conn_epoch = conn_epoch + 1 WHERE name = ? RETURNING conn_epoch").get(name) as { conn_epoch: number } | undefined;
    if (!r) throw new Error(`no node ${name}`);
    return r.conn_epoch;
  }

  seen(name: string, agentVersion?: string): void {
    if (agentVersion === undefined) this.#db.prepare("UPDATE nodes SET last_seen_at = ? WHERE name = ?").run(this.#now(), name);
    else this.#db.prepare("UPDATE nodes SET last_seen_at = ?, agent_version = ? WHERE name = ?").run(this.#now(), agentVersion, name);
  }

  // Records where a node connected from; returns the previous source when it was a different one (an alert, spec 8).
  recordSource(name: string, source: string): string | null {
    const before = this.node(name)?.lastSource ?? null;
    this.#db.prepare("UPDATE nodes SET last_source = ? WHERE name = ?").run(source, name);
    return before !== null && before !== source ? before : null;
  }
}
```

- [ ] **Step 25: Run it and see it pass**

Run: `npx vitest run apps/fleet/test/join-codes.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 26: Commit**

```bash
git add apps/fleet/src/adapters/nodes-store.ts apps/fleet/test/join-codes.test.ts
git commit -m "feat(fleet): node registry with single-use, name-bound join codes"
```

- [ ] **Step 27: Write the failing audit and console tests**

Create `apps/fleet/test/audit.test.ts`:

```ts
// Alerts (Contracts, "Alerts"): an audit row whose action is alert.<kind>, plus a log warning; served as an Alert (id:
// the row's seq; kind: the action without "alert."), the latest 500 of the security kinds and the latest 500 of the
// others, oldest first; and handed to the listener as raised. Audit rows go after 90 days.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIMITS, type Alert } from "@morndo/protocol";
import { Audit } from "../src/adapters/audit.ts";
import { openFleetDb } from "../src/adapters/db.ts";
import { createLogger } from "../src/adapters/log.ts";
import { tempDir } from "./helpers/temp.ts";

describe("alerts", () => {
  it("are audit rows, served as Alerts (the latest 500 of each class, oldest first) and handed to the listener as they are raised", () => {
    let now = 1_800_000_000_000;
    const db = openFleetDb(join(tempDir(), "fleet.db"));
    const heard: Alert[] = [];
    const warned: string[] = [];
    const audit = new Audit(db, { now: () => now, log: createLogger({ level: "warn", sink: line => warned.push(line) }), onAlert: a => heard.push(a) });
    audit.record("cli", "node.add", "pc", { expiresAt: 1 });                           // not an alert
    const first = audit.alert("clock_offset", "pc", { offsetMs: 10_000 });
    expect(first).toEqual({ id: 2, at: now, node: "pc", kind: "clock_offset", detail: { offsetMs: 10_000 } });
    expect(audit.of("alert.clock_offset").map(e => [e.actor, e.node, e.detail])).toEqual([["fleet", "pc", { offsetMs: 10_000 }]]);
    expect(warned).toEqual(["[fleet] warn: alert: clock_offset on node pc"]);
    expect(audit.recentAlerts()).toEqual([first]);
    for (let i = 0; i < 501; i++) { now++; audit.alert("dead_letter", null, { seq: i }); }
    const served = audit.recentAlerts();
    expect(served).toHaveLength(501);
    // The security alert stays, though 501 others came after it; of the others, the oldest went.
    expect(served[0]).toEqual(first);
    expect(served[1]).toEqual({ id: 4, at: 1_800_000_000_002, node: null, kind: "dead_letter", detail: { seq: 1 } });
    expect(served.at(-1)).toMatchObject({ id: 503, detail: { seq: 500 } });
    expect(heard).toHaveLength(502);
    expect(heard.at(-1)).toEqual(served.at(-1));
    db.close();
  });

  it("no number of other alerts pushes a security alert out; each class keeps its own latest 500", () => {
    const db = openFleetDb(join(tempDir(), "fleet.db"));
    const audit = new Audit(db);
    const security = [audit.alert("instance_conflict", "pc", {}), audit.alert("source_changed", "pc", {}), audit.alert("clock_offset", "pc", {})];
    for (let i = 0; i < 1200; i++) audit.alert(i % 2 ? "lane_conflict" : "dead_letter", "pc", { i });
    const served = audit.recentAlerts();
    expect(served.slice(0, 3)).toEqual(security);                                    // negative control: one shared cap of 500 drops all three
    expect(served).toHaveLength(503);
    expect(served.map(a => a.id)).toEqual([...served.map(a => a.id)].sort((a, b) => a - b));   // oldest first, merged
    for (let i = 0; i < 600; i++) audit.alert("clock_offset", "pc", { i });
    expect(audit.recentAlerts().filter(a => a.kind === "clock_offset" || a.kind === "instance_conflict" || a.kind === "source_changed")).toHaveLength(500);
    db.close();
  });
});

describe("retention", () => {
  it("prune() deletes audit rows older than 90 days, alerts included, and keeps the rest", () => {
    let now = 1_800_000_000_000;
    const db = openFleetDb(join(tempDir(), "fleet.db"));
    const audit = new Audit(db, { now: () => now });
    audit.record("cli", "node.add", "pc");
    audit.alert("instance_conflict", "pc", {});
    now += LIMITS.auditKeepMs - 1;
    audit.record("cli", "node.revoke", "pc");
    expect(audit.prune()).toBe(0);                                                   // 90 days less a millisecond: kept
    now += 2;
    expect(audit.prune()).toBe(2);
    expect(audit.recent().map(e => e.action)).toEqual(["node.revoke"]);
    expect(audit.recentAlerts()).toEqual([]);
    db.close();
  });
});
```

Create `apps/fleet/test/cli.test.ts`:

```ts
// The console: `node add` prints a join string that carries the configured URL, the fleet's public key, the node's
// name and a code that registers exactly that node; `node list`, `node revoke` and `status` work with no service
// running. Real processes, a temp HOME and config, no service.
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseJoinString } from "@morndo/protocol";
import { openFleetDb } from "../src/adapters/db.ts";
import { loadOrCreateFleetKey } from "../src/adapters/keys.ts";
import { NodesStore } from "../src/adapters/nodes-store.ts";
import { Audit } from "../src/adapters/audit.ts";
import { tempDir } from "./helpers/temp.ts";

const MAIN = join(import.meta.dirname, "../src/main.ts");

function setup() {
  const home = tempDir();
  const config = join(home, "fleet.json");
  writeFileSync(config, JSON.stringify({ publicUrl: "wss://fleet.example.test/agent", socketPath: join(home, "run", "f.sock") }));
  const run = (...args: string[]) => spawnSync(process.execPath, ["--no-warnings", MAIN, ...args], {
    env: { ...process.env, HOME: home, MORNDO_FLEET_CONFIG: config }, encoding: "utf8", timeout: 20_000,
  });
  const dbPath = join(home, ".local/share/morndo-fleet/fleet.db");
  return { home, run, dbPath, keyPath: join(home, ".local/share/morndo-fleet/fleet-key.pem") };
}
const spki = () => generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");

describe("morndo-fleet console", { timeout: 30_000 }, () => {
  it("node add: a join string with the public URL, the fleet's key and a code bound to the name", () => {
    const { run, dbPath, keyPath } = setup();
    const r = run("node", "add", "pc");
    expect(r.status, r.stderr).toBe(0);
    const line = r.stdout.split("\n").find(l => l.startsWith("morndo-join:1:")) ?? "";
    const j = parseJoinString(line);
    expect(j).not.toBeNull();
    expect(j?.url).toBe("wss://fleet.example.test/agent");
    expect(j?.node).toBe("pc");
    expect(j?.fleetKey).toBe(loadOrCreateFleetKey(keyPath).publicKey);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    const db = openFleetDb(dbPath);
    const nodes = new NodesStore(db);
    expect(nodes.redeem(j?.code ?? "", "pc", spki())).toEqual({ ok: true, node: "pc" });
    expect(new Audit(db).of("node.add").map(a => [a.actor, a.node])).toEqual([["cli", "pc"]]);
    expect(JSON.stringify(new Audit(db).recent())).not.toContain(j?.code ?? "");   // the code is never audited
    db.close();
  });

  it("node add refuses a bad name with exit 2 and writes nothing", () => {
    const { run, dbPath } = setup();
    const r = run("node", "add", "My PC");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/a node name is 1 to 32/);
    expect(() => statSync(dbPath)).toThrow();
  });

  it("node add refuses a registered node until it is revoked", () => {
    const { run, dbPath } = setup();
    const first = parseJoinString(run("node", "add", "pc").stdout.split("\n").find(l => l.startsWith("morndo-join:")) ?? "");
    const db = openFleetDb(dbPath);
    new NodesStore(db).redeem(first?.code ?? "", "pc", spki());
    db.close();
    const again = run("node", "add", "pc");
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/revoke it first/);
  });

  it("node list and node revoke work without the service, and say when the revocation applies", () => {
    const { run, dbPath } = setup();
    const j = parseJoinString(run("node", "add", "pc").stdout.split("\n").find(l => l.startsWith("morndo-join:")) ?? "");
    const db = openFleetDb(dbPath);
    new NodesStore(db).redeem(j?.code ?? "", "pc", spki());
    db.close();
    expect(run("node", "list").stdout).toMatch(/^pc\s+active /m);
    const r = run("node", "revoke", "pc");
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/revoked pc; the fleet service did not answer/);
    expect(run("node", "list").stdout).toMatch(/^pc\s+REVOKED /m);
    expect(run("node", "revoke", "pc").status).toBe(1);
    const after = openFleetDb(dbPath);
    expect(new Audit(after).of("node.revoke").map(a => a.node)).toEqual(["pc"]);
    after.close();
  });

  it("status says the service is not reachable, with exit 1", () => {
    const { run } = setup();
    const r = run("status");
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/NOT REACHABLE/);
    expect(r.stdout).toMatch(/alerts in the last 24 h: none/);
  });

  it("help for no command, exit 2 for an unknown one", () => {
    const { run } = setup();
    expect(run().status).toBe(0);
    expect(run().stdout).toMatch(/node add <name>/);
    expect(run("frobnicate").status).toBe(2);
  });
});
```

- [ ] **Step 28: Run it and see it fail**

Run: `npx vitest run apps/fleet/test/audit.test.ts apps/fleet/test/cli.test.ts`
Expected: FAIL: both files with `Error: Cannot find module '../src/adapters/audit.ts'`

- [ ] **Step 29: Implement the audit, the socket request and the console**

Create `apps/fleet/src/adapters/audit.ts`:

```ts
// The fleet's audit trail (spec 6, 8): who did what to which node, append-only, in fleet.db. An alert is an audit row
// whose action is "alert.<kind>" and a warning in the log; as an Alert (the Contracts' type: id is the row's seq, kind
// is the action without "alert.") it goes to `onAlert` as it is raised (the service sends it to /v1/events) and is
// served by GET /v1/alerts; `morndo-fleet status` lists the last day's. The detail never holds a hook body, typed
// text, keystrokes, a key or a code.
// GET /v1/alerts serves the latest ALERTS_SERVED of the security kinds and, apart, the latest ALERTS_SERVED of the
// others, so no number of dead letters or lane conflicts can push an instance conflict, a changed source address or a
// clock offset out of view. Rows go after LIMITS.auditKeepMs (90 days), alerts included: prune() runs on start and
// daily (serve.ts).
import type Database from "better-sqlite3";
import { LIMITS, type Alert, type AlertKind } from "@morndo/protocol";
import type { Logger } from "./log.ts";

export type AuditEntry = { seq: number; at: number; actor: string; action: string; node: string | null; detail: Record<string, unknown> };
type Row = { seq: number; at: number; actor: string; action: string; node: string | null; detail: string };

const entry = (r: Row): AuditEntry => ({ ...r, detail: JSON.parse(r.detail) as Record<string, unknown> });
const alertOf = (e: AuditEntry): Alert => ({ id: e.seq, at: e.at, node: e.node, kind: e.action.slice("alert.".length) as AlertKind, detail: e.detail });

export const ALERTS_SERVED = 500;                        // GET /v1/alerts: the latest 500 of each class, oldest first
// The kinds that say someone may be posing as a node or a node's clock can't be trusted: capped apart from the others.
export const SECURITY_ALERTS: readonly AlertKind[] = ["instance_conflict", "source_changed", "clock_offset"];
const SECURITY_ACTIONS = SECURITY_ALERTS.map(k => `alert.${k}`);
// Every "alert.*" action, as a range the (action, seq) index can scan: "/" is the character after ".".
const ALERT_RANGE = "action >= 'alert.' AND action < 'alert/'";
const IN_SECURITY = `action IN (${SECURITY_ACTIONS.map(() => "?").join(", ")})`;

export class Audit {
  #db: Database.Database;
  #now: () => number;
  #log: Logger | null;
  #onAlert: (a: Alert) => void;

  constructor(db: Database.Database, o: { now?: () => number; log?: Logger; onAlert?: (a: Alert) => void } = {}) {
    this.#db = db;
    this.#now = o.now ?? Date.now;
    this.#log = o.log ?? null;
    this.#onAlert = o.onAlert ?? (() => {});
  }

  record(actor: string, action: string, node: string | null, detail: Record<string, unknown> = {}): void {
    this.#insert(actor, action, node, detail);
  }

  // e.g. alert("instance_conflict", "pc", { … }): the row's action is "alert.instance_conflict".
  alert(kind: AlertKind, node: string | null, detail: Record<string, unknown> = {}): Alert {
    const a = alertOf(this.#insert("fleet", `alert.${kind}`, node, detail));
    this.#log?.warn(`alert: ${kind}${node ? ` on node ${node}` : ""}`);
    this.#onAlert(a);
    return a;
  }

  recent(limit = 50): AuditEntry[] {
    return (this.#db.prepare("SELECT * FROM audit ORDER BY seq DESC LIMIT ?").all(limit) as Row[]).map(entry);
  }

  alerts(since: number): AuditEntry[] {
    return (this.#db.prepare(`SELECT * FROM audit WHERE ${ALERT_RANGE} AND at >= ? ORDER BY seq`).all(since) as Row[]).map(entry);
  }

  // The latest `limit` security alerts and the latest `limit` others, merged, oldest first.
  recentAlerts(limit = ALERTS_SERVED): Alert[] {
    const security = this.#db.prepare(`SELECT * FROM audit WHERE ${IN_SECURITY} ORDER BY seq DESC LIMIT ?`).all(...SECURITY_ACTIONS, limit) as Row[];
    const others = this.#db.prepare(`SELECT * FROM audit WHERE ${ALERT_RANGE} AND NOT ${IN_SECURITY} ORDER BY seq DESC LIMIT ?`).all(...SECURITY_ACTIONS, limit) as Row[];
    return [...security, ...others].sort((a, b) => a.seq - b.seq).map(r => alertOf(entry(r)));
  }

  // Deletes every row older than LIMITS.auditKeepMs, alerts included; returns how many went.
  prune(): number {
    return this.#db.prepare("DELETE FROM audit WHERE at < ?").run(this.#now() - LIMITS.auditKeepMs).changes;
  }

  of(action: string): AuditEntry[] {
    return (this.#db.prepare("SELECT * FROM audit WHERE action = ? ORDER BY seq").all(action) as Row[]).map(entry);
  }

  #insert(actor: string, action: string, node: string | null, detail: Record<string, unknown>): AuditEntry {
    const at = this.#now();
    const r = this.#db.prepare("INSERT INTO audit (at, actor, action, node, detail) VALUES (?, ?, ?, ?, ?)").run(at, actor, action, node, JSON.stringify(detail));
    return { seq: Number(r.lastInsertRowid), at, actor, action, node, detail };
  }
}
```

Create `apps/fleet/src/adapters/socket-request.ts`:

```ts
// One JSON request to the running fleet service over its Unix socket (node:http `socketPath`,
// https://nodejs.org/docs/latest-v24.x/api/http.html#httprequestoptions-callback, read 2026-10-06). The console uses it
// to reach the service; null means nothing answered there (no socket, nobody listening, or no answer in time).
import { request } from "node:http";

export type SocketAnswer = { status: number; body: unknown };

export function socketRequest(socketPath: string, method: string, path: string, body?: unknown, timeoutMs = 3000): Promise<SocketAnswer | null> {
  return new Promise(resolve => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      socketPath, method, path, timeout: timeoutMs,
      headers: payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
    }, res => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", () => resolve(null));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown = text;
        try { parsed = JSON.parse(text); } catch { /* not JSON: the text as it is */ }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end(payload);
  });
}
```

Create `apps/fleet/src/main.ts`:

```ts
#!/usr/bin/env node
// morndo-fleet: the fleet service (ADR-0012). `node add|list|revoke` and `status` are its console; they open fleet.db
// themselves (better-sqlite3 waits on the service's locks) and reach the running service through its Unix socket.
import type Database from "better-sqlite3";
import { LIMITS, NODE_NAME, formatJoinString } from "@morndo/protocol";
import { ConfigError, loadConfig, type FleetConfig } from "./config.ts";
import { openFleetDb } from "./adapters/db.ts";
import { DatabaseFromFuture } from "./adapters/migrations.ts";
import { KeyFileUnsafe, loadOrCreateFleetKey, type FleetKey } from "./adapters/keys.ts";
import { NodesStore } from "./adapters/nodes-store.ts";
import { Audit } from "./adapters/audit.ts";
import { socketRequest } from "./adapters/socket-request.ts";

const HELP = `morndo-fleet: the fleet service. Nodes dial in; the hub, kira and lanes talk to it over a Unix socket.

  morndo-fleet node add <name>      a one-time join string for a new node (valid 10 minutes, single use)
  morndo-fleet node list            registered nodes
  morndo-fleet node revoke <name>   cut a node off; its live connection closes at once if the service runs
  morndo-fleet status               whether the service runs, its nodes, and the alerts of the last day

Settings: ~/.config/morndo-fleet/config.json, or the file MORNDO_FLEET_CONFIG names.`;

const EXIT_USAGE = 2;
const EXIT_CONFIG = 78;                                  // EX_CONFIG (sysexits.h): fix a setting or the data, don't restart
// The console's own output for the person at the box (a join string must show as it is): not a log.
const print = (text: string) => process.stdout.write(`${text}\n`);
const fail = (text: string, code: number): never => { process.stderr.write(`${text}\n`); process.exit(code); };
const when = (t: number | null) => (t === null ? "-" : new Date(t).toISOString());

function config(): FleetConfig {
  try { return loadConfig(); }
  catch (e) { if (e instanceof ConfigError) return fail(e.message, EXIT_CONFIG); throw e; }
}

function openDb(path: string): Database.Database {
  try { return openFleetDb(path); }
  catch (e) {
    if (!(e instanceof DatabaseFromFuture)) throw e;
    return fail(`${path} was written by a newer morndo-fleet (schema version ${e.found}); this one knows migrations only up to ${e.known}. Run the newer one, or restore a backup.`, EXIT_CONFIG);
  }
}

function fleetKey(path: string): FleetKey {
  try { return loadOrCreateFleetKey(path); }
  catch (e) { if (e instanceof KeyFileUnsafe) return fail(e.message, EXIT_CONFIG); throw e; }
}

const [cmd, sub, ...args] = process.argv.slice(2);

if (cmd === "node" && sub === "add") {
  const name = args[0] ?? "";
  if (!NODE_NAME.test(name)) fail(`a node name is 1 to 32 of a-z, 0-9 and "-": ${JSON.stringify(name)}`, EXIT_USAGE);
  const cfg = config();
  const key = fleetKey(cfg.keyPath);
  const db = openDb(cfg.dbPath);
  const issued = new NodesStore(db).issueCode(name);
  if (!issued.ok) { db.close(); fail(`node ${name} is registered; revoke it first to join it again`, 1); }
  else {
    new Audit(db).record("cli", "node.add", name, { expiresAt: issued.expiresAt });
    db.close();
    print(`Join string for node ${name}, single use, valid until ${when(issued.expiresAt)}:\n`);
    print(formatJoinString({ url: cfg.publicUrl, fleetKey: key.publicKey, code: issued.code, node: name }));
    print(`\nOn that machine run: morndo-node join '<the join string>'`);
  }
} else if (cmd === "node" && sub === "list") {
  const db = openDb(config().dbPath);
  const nodes = new NodesStore(db).list();
  db.close();
  if (nodes.length === 0) print("no nodes; add one with: morndo-fleet node add <name>");
  for (const n of nodes) {
    print(`${n.name.padEnd(32)}  ${n.revokedAt === null ? "active " : "REVOKED"}  joined ${when(n.createdAt)}  last seen ${when(n.lastSeenAt)}  from ${n.lastSource ?? "-"}  agent ${n.agentVersion ?? "-"}`);
  }
} else if (cmd === "node" && sub === "revoke") {
  const name = args[0] ?? "";
  if (!NODE_NAME.test(name)) fail(`a node name is 1 to 32 of a-z, 0-9 and "-": ${JSON.stringify(name)}`, EXIT_USAGE);
  const cfg = config();
  const db = openDb(cfg.dbPath);
  const revoked = new NodesStore(db).revoke(name);
  if (revoked) new Audit(db).record("cli", "node.revoke", name);
  db.close();
  if (!revoked) fail(`no active node ${name}`, 1);
  // The running service closes the node's connection and drops its lanes at once; it re-checks every node it holds
  // each ping interval anyway, and refuses a revoked node at its next hello.
  const told = await socketRequest(cfg.socketPath, "POST", `/v1/nodes/${encodeURIComponent(name)}/revoke`);
  if (told?.status === 200) print(`revoked ${name}; its connection, if any, is closed`);
  else print(`revoked ${name}; the fleet service did not answer at ${cfg.socketPath}, so it applies within ${LIMITS.pingMs / 1000} s if it runs, else when it starts`);
} else if (cmd === "status") {
  const cfg = config();
  const live = await socketRequest(cfg.socketPath, "GET", "/v1/nodes");
  const db = openDb(cfg.dbPath);
  const registered = new NodesStore(db).list().filter(n => n.revokedAt === null);
  const alerts = new Audit(db).alerts(Date.now() - 24 * 3_600_000);
  db.close();
  if (live?.status === 200 && Array.isArray(live.body)) {
    print(`fleet service: running (${cfg.socketPath})`);
    for (const n of live.body as { name: string; status: string; agent: string | null }[]) print(`  ${n.name.padEnd(32)}  ${n.status.padEnd(7)}  agent ${n.agent ?? "-"}`);
  } else {
    print(`fleet service: NOT REACHABLE at ${cfg.socketPath}`);
    for (const n of registered) print(`  ${n.name.padEnd(32)}  last seen ${when(n.lastSeenAt)}`);
  }
  print(alerts.length === 0 ? "alerts in the last 24 h: none" : `alerts in the last 24 h: ${alerts.length}`);
  for (const a of alerts) print(`  ${when(a.at)}  ${a.action}${a.node ? `  ${a.node}` : ""}  ${JSON.stringify(a.detail)}`);
  if (live?.status !== 200) process.exitCode = 1;
} else {
  print(HELP);
  if (cmd !== undefined && cmd !== "help") process.exitCode = EXIT_USAGE;
}
```

- [ ] **Step 30: Run it and see it pass**

Run: `npx vitest run apps/fleet/test/audit.test.ts apps/fleet/test/cli.test.ts`
Expected: PASS (9 tests)

Then check that the two audit rules bite, each change restored before the next:
- In `audit.ts`, add the line `    security.length = 0;` above `    return [...security, ...others].sort(` (one cap for every kind, as before). Expected: 2 failures in `audit.test.ts`: the security alert is pushed out by the 501 dead letters, and "no number of other alerts pushes a security alert out".
- In `audit.ts`, change `"DELETE FROM audit WHERE at < ?"` to `"DELETE FROM audit WHERE at < ? AND 0"`. Expected: 1 failure, "prune() deletes audit rows older than 90 days, alerts included, and keeps the rest".

- [ ] **Step 31: Run the whole fleet suite, the types and the lint**

Run each in turn, from the repository root:
- `npx tsc -p apps/fleet`. Expected: no output, exit 0.
- `npx tsc -p tsconfig.tests.json`. Expected: no output, exit 0.
- `npx oxlint apps/fleet`. Expected: no output, exit 0.
- `npx vitest run apps/fleet/test`. Expected: PASS (32 tests in 7 files).

- [ ] **Step 32: Commit**

`apps/fleet/src/main.ts` starts with `#!/usr/bin/env node` and is the workspace's `bin`: make it executable before it is first committed, so git records mode 100755.

```bash
chmod +x apps/fleet/src/main.ts
git add apps/fleet/src/adapters/audit.ts apps/fleet/src/adapters/socket-request.ts apps/fleet/src/main.ts apps/fleet/test/audit.test.ts apps/fleet/test/cli.test.ts
git commit -m "feat(fleet): node add, list, revoke and status console"
```

### Task 11: The agent endpoint: join, mutual authentication, instance rules, liveness

**Files:**
- Create: `apps/fleet/src/adapters/rate-limit.ts`, `apps/fleet/src/adapters/agent-session.ts`, `apps/fleet/src/adapters/agent-endpoint.ts`
- Create: `apps/fleet/src/application/events.ts`, `apps/fleet/src/application/hook-sink.ts`, `apps/fleet/src/application/requests.ts`,
  `apps/fleet/src/application/connections.ts`, `apps/fleet/src/serve.ts`
- Modify: `apps/fleet/src/main.ts` (the `serve` command)
- Test: `apps/fleet/test/helpers/fake-agent.ts`, `apps/fleet/test/helpers/fleet.ts`, `apps/fleet/test/helpers/until.ts`,
  `apps/fleet/test/events.test.ts`, `apps/fleet/test/rate-limit.test.ts`, `apps/fleet/test/requests.test.ts`,
  `apps/fleet/test/agent-auth.test.ts`, `apps/fleet/test/instances.test.ts`, `apps/fleet/test/liveness.test.ts`,
  `apps/fleet/test/serve.test.ts`

**Interfaces:**
- Consumes:
  - **Task 1, `@morndo/protocol`:**
    - the message schemas and types of the Contracts' "Messages": `AgentMessage`, `type FleetMessage`, `FleetFrames`;
    - constants: `CLOSE`, `FLEET_PROTO`, `LIMITS`, `ERROR_EXECUTED`, `KEYED_OPS`, `OP_RESULTS`;
    - functions: `fleetSigPayload`, `nodeSigPayload`, and `parseBody` and `decodeValue` (in `decode.ts`);
    - types: `OpName`, `OpError`, `OpResult`, `ErrorCode`, `Health`, `HookEvent`, `Pane`, `Alert`.
  - **Task 10:** `NodesStore`, `Audit`, `FleetKey`, `verifySig`, `Logger`, `openFleetDb`, `loadOrCreateFleetKey`,
    `FleetConfig`, `tempDir`.
- Produces:
  - `application/events.ts`:
    - `type FleetEvent = { t: "inventory" | "health" | "status" | "conflict" | "alert"; node: string; body: unknown }`
    - `class EventHub { constructor(onError?); subscribe(fn): () => void; emit(e): void }`. A nested emit goes out after
      the current event.
  - `application/hook-sink.ts`:
    - `type HookSink = { known(node, streamId): { seq: number; known: boolean }; accept(node, streamId, events: HookEvent[]): number }`
  - `application/requests.ts`:
    - `type Outcome = { ok: true; result: unknown; invVersion: number; store: string } | { ok: false; error: OpError; store: string | null }`:
      the agent's `res.store`, or for the fleet's own answer after sending the connection's stream id, or null when
      nothing was sent
    - `type Channel = { node; instanceId; id; store; send }`
    - `opError(code, message): OpError`, `failed(code, message, store = null): Outcome`
    - `SIDE_EFFECT_OPS`, `BULK_OPS`, `RESULT_SLACK_MS = 1000`, `class Requests`. A request over
      `LIMITS.maxMessageBytes` is answered `too_large` and never sent. A result is checked against `OP_RESULTS[op]`
      once its id is matched; one that doesn't fit is `internal` (`executed: "maybe"`).
  - `application/connections.ts`:
    - `type NodeStatus = "online" | "stale" | "offline"`
    - `type NodeView = { name; status; health: Health | null; agent: string | null }`
    - `type Peer = { send; ping; close; terminate; open(): boolean }`, `type Admission = { node; instanceId; streamId; peer; source; agentVersion; claudeVersion; caps }`
    - `class Connections`:
      - `constructor({ nodes, audit, events, log, now?, mono?, pingMs?, resultSlackMs?, instancePongMs?, onRevoked? })`, `start()`, `stop()`
      - `admit(a, welcome): Promise<{ ok: true; epoch } | { ok: false }>`: another instance's live connection is pinged
        and given `instancePongMs` (3 s) to answer; `closed`, `pong`, `sweep`
      - `revoke(node)`: closes it (4403), ends its requests, forgets its latest reports and calls `onRevoked(node)`; the
        sweep calls it for every revocation in fleet.db not yet acted on, offline nodes included
      - `status(node): NodeStatus`
      - `request(node, op, args, { key?, timeoutMs }): Promise<Outcome>`, with bulk ops one at a time per node, at most
        `LIMITS.bulkQueueMax` waiting (`busy` past that), each one's deadline counted from when it was queued
      - `result`, `inventory(node, panes, invVersion)`, `health(node, h)`
      - `latest(node): { inventory: { panes; invVersion } | null; health: Health | null }`, `list(): NodeView[]`
      - `liveInstance(node): { instanceId; epoch } | null`, `forget(node)`, and the `requests: Requests` field
  - `adapters/agent-endpoint.ts`:
    - `startAgentEndpoint({ host, port, deps, limits?, handshakeLimits?, handshakeMs? }): { ready; port(); close() }`
    - `sourceOf(req): string`, `AGENT_MESSAGES: BucketConfig`, `HANDSHAKES: BucketConfig` (per source address:
      `LIMITS.handshakeBurst` at once, one more every `LIMITS.handshakeRefillMs`; over it, close 1013)
  - `adapters/rate-limit.ts`: `class RateLimiter { constructor(config, now?); take(key): boolean }`, `type BucketConfig`.
  - `serve.ts`:
    - `type FleetOptions = { log?; now?; pingMs?; agentLimits?; handshakeLimits?; handshakeMs?; resultSlackMs?; instancePongMs? }`
    - `AUDIT_PRUNE_EVERY_MS` (a day): `audit.prune()` runs on start and then this often
    - `type Fleet = { config; db; key; nodes; audit; events; connections; agentPort: number; close(): Promise<void> }`
    - `startFleet(config: FleetConfig, o?: FleetOptions): Promise<Fleet>`; every alert the audit records is emitted as
      `{ t: "alert", node: alert.node ?? "", body: alert }`
  - The CLI's `morndo-fleet serve` logs `agents on ws://<host>:<port>/agent` once it listens, and stops with exit 0 on
    SIGTERM.
  - Test helpers, used by Tasks 12 and 13:
    - `startTestFleet(o?: FleetOptions & { dir?; config?: Partial<FleetConfig> }): Promise<TestFleet>`;
      `TestFleet` adds `dir`, `agentUrl`, `code(name)`, `agent(o?)`, `joined(name, o?)` and `online(name, o?)`.
    - `testConfig(dir, over?)` and `quiet`.
    - `class FakeAgent`, with `join(node, code, o?)`, `connect`, `send`, `next`, `hook`, `inventory`, `health`,
      `acked`, `close`, `terminate`, `answer` (by default `validResult(op, node)`), `store` (each `res`'s, by default its
      `streamId`), `reqs` and `refused`, plus `health(over?)`, `newKey()`, `validResult(op, node)` and
      `parseFrame(raw)`. Like the real agent it decodes every message from the fleet with the protocol's schemas and
      closes with 1008 on one that doesn't fit.
    - `WIDE: BucketConfig`: `startTestFleet` passes it as `handshakeLimits` unless a test gives its own, since every
      test connects from 127.0.0.1.
    - `until(cond, ms?)`.

- [ ] **Step 1: Write the failing event-hub test**

Create `apps/fleet/test/events.test.ts`:

```ts
// The event hub (spec 5.6): every subscriber hears every event, in causal order (an event a subscriber emits goes out
// after the one that caused it), and one subscriber that throws never silences the others.
import { describe, expect, it } from "vitest";
import { EventHub, type FleetEvent } from "../src/application/events.ts";

const ev = (t: FleetEvent["t"], node: string): FleetEvent => ({ t, node, body: null });

describe("the event hub", () => {
  it("delivers an event a subscriber emits after the event that caused it, to everyone in the same order", () => {
    const errors: unknown[] = [];
    const hub = new EventHub(e => errors.push(e));
    const first: string[] = [];
    const second: string[] = [];
    hub.subscribe(e => { first.push(`${e.t}:${e.node}`); if (e.t === "inventory") hub.emit(ev("conflict", e.node)); });
    hub.subscribe(e => { second.push(`${e.t}:${e.node}`); });
    hub.emit(ev("inventory", "pc"));
    expect(first).toEqual(["inventory:pc", "conflict:pc"]);
    expect(second).toEqual(["inventory:pc", "conflict:pc"]);
    expect(errors).toEqual([]);
  });

  it("a subscriber that throws is reported and the others still hear the event; unsubscribe stops delivery", () => {
    const errors: unknown[] = [];
    const hub = new EventHub(e => errors.push(e));
    const heard: string[] = [];
    hub.subscribe(() => { throw new Error("boom"); });
    const stop = hub.subscribe(e => heard.push(e.node));
    hub.emit(ev("status", "pc"));
    stop();
    hub.emit(ev("status", "mac"));
    expect(heard).toEqual(["pc"]);
    expect(errors).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run apps/fleet/test/events.test.ts`
Expected: FAIL: `Error: Cannot find module '../src/application/events.ts'`

- [ ] **Step 3: Implement the event hub**

Create `apps/fleet/src/application/events.ts`:

```ts
// What the fleet tells its clients as it happens (spec 5.6, WS /v1/events): a node's inventory and health, its status,
// lane-name conflicts and alerts. One subscriber that throws never keeps the others from hearing an event.
export type FleetEvent = { t: "inventory" | "health" | "status" | "conflict" | "alert"; node: string; body: unknown };

export class EventHub {
  #subscribers = new Set<(e: FleetEvent) => void>();
  #onError: (e: unknown) => void;
  #queue: FleetEvent[] = [];
  #emitting = false;

  constructor(onError: (e: unknown) => void = () => {}) { this.#onError = onError; }

  subscribe(fn: (e: FleetEvent) => void): () => void {
    this.#subscribers.add(fn);
    return () => { this.#subscribers.delete(fn); };
  }

  // An event emitted by a subscriber (the lane registry's conflict, on an inventory) goes out after the event that
  // caused it has reached everyone, so every subscriber hears them in the same, causal order.
  emit(e: FleetEvent): void {
    this.#queue.push(e);
    if (this.#emitting) return;
    this.#emitting = true;
    try {
      for (let next = this.#queue.shift(); next !== undefined; next = this.#queue.shift()) {
        for (const fn of this.#subscribers) {
          try { fn(next); } catch (err) { this.#onError(err); }
        }
      }
    } finally { this.#emitting = false; }
  }
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `npx vitest run apps/fleet/test/events.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/fleet/src/application/events.ts apps/fleet/test/events.test.ts
git commit -m "feat(fleet): event hub that keeps causal order"
```

- [ ] **Step 6: Write the failing rate-limit test**

Create `apps/fleet/test/rate-limit.test.ts`:

```ts
// The per-node token bucket (the hub's pattern): a full bucket's capacity at once, then refills continuously; on the
// monotonic clock, so a wall-clock jump changes nothing (Review Focus 4).
import { describe, expect, it, vi } from "vitest";
import { RateLimiter } from "../src/adapters/rate-limit.ts";

describe("RateLimiter", () => {
  it("lets the capacity through at once, then one token per refill interval, per key", () => {
    let t = 1000;
    const rl = new RateLimiter({ capacity: 3, refillPerSecond: 2 }, () => t);
    expect([rl.take("pc"), rl.take("pc"), rl.take("pc"), rl.take("pc")]).toEqual([true, true, true, false]);
    expect(rl.take("mac")).toBe(true);                                               // another key, its own bucket
    t += 500;
    expect([rl.take("pc"), rl.take("pc")]).toEqual([true, false]);
    t += 10_000;
    expect([rl.take("pc"), rl.take("pc"), rl.take("pc"), rl.take("pc")]).toEqual([true, true, true, false]);   // never above capacity
  });

  it("uses the monotonic clock by default: a wall-clock jump neither refills nor drains", () => {
    vi.useFakeTimers({ toFake: ["Date"] });                                          // only the wall clock is faked
    try {
      const rl = new RateLimiter({ capacity: 1, refillPerSecond: 0.001 });
      expect(rl.take("pc")).toBe(true);
      vi.setSystemTime(Date.now() + 3_600_000);                                        // an NTP step or a laptop resume
      expect(rl.take("pc")).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it("refuses a bad configuration", () => {
    expect(() => new RateLimiter({ capacity: 0, refillPerSecond: 1 })).toThrow(/bad rate limit/);
  });
});
```

- [ ] **Step 7: Run it and see it fail**

Run: `npx vitest run apps/fleet/test/rate-limit.test.ts`
Expected: FAIL: `Error: Cannot find module '../src/adapters/rate-limit.ts'`

- [ ] **Step 8: Implement the token bucket**

Create `apps/fleet/src/adapters/rate-limit.ts`:

```ts
// A token bucket per key, the hub's pattern (apps/hub/src/adapters/rate-limit.ts, ADR-0008 A6; design reference:
// Signal-Server limits/). Each key's bucket holds up to `capacity` tokens and refills continuously at
// `refillPerSecond`; a message takes one. On the monotonic clock by default, so a wall-clock jump neither drains nor
// fills a bucket (Review Focus 4).
export type BucketConfig = { capacity: number; refillPerSecond: number };

export class RateLimiter {
  readonly config: BucketConfig;
  #now: () => number;
  #buckets = new Map<string, { tokens: number; at: number }>();
  #takes = 0;

  constructor(config: BucketConfig, now: () => number = () => performance.now()) {
    if (!(config.capacity > 0) || !(config.refillPerSecond > 0)) throw new Error(`bad rate limit: ${JSON.stringify(config)}`);
    this.config = config;
    this.#now = now;
  }

  #level(key: string, now: number): number {
    const b = this.#buckets.get(key);
    if (!b) return this.config.capacity;
    return Math.min(this.config.capacity, b.tokens + ((now - b.at) / 1000) * this.config.refillPerSecond);
  }

  take(key: string): boolean {
    const now = this.#now();
    if (++this.#takes % 1000 === 0) this.prune();
    const tokens = this.#level(key, now);
    if (tokens < 1) return false;
    this.#buckets.set(key, { tokens: tokens - 1, at: now });
    return true;
  }

  // Drops every bucket that has refilled completely: it behaves exactly like a key never seen.
  prune() {
    const now = this.#now();
    for (const key of this.#buckets.keys()) if (this.#level(key, now) >= this.config.capacity) this.#buckets.delete(key);
  }
}
```

- [ ] **Step 9: Run it and see it pass**

Run: `npx vitest run apps/fleet/test/rate-limit.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 10: Commit**

```bash
git add apps/fleet/src/adapters/rate-limit.ts apps/fleet/test/rate-limit.test.ts
git commit -m "feat(fleet): per-node token bucket on the monotonic clock"
```

- [ ] **Step 11: Write the scripted agent and the test-fleet helpers**

Create `apps/fleet/test/helpers/fake-agent.ts`:

```ts
// A scripted agent for the fleet's tests (spec 9, "Contract": the real fleet against a scripted fake agent). It joins
// with its name and a code, says hello, checks the fleet's signature against the pinned key, proves its own key,
// answers requests with `answer` (by default a minimal valid result of the op), each with its `store` (by default its
// stream id, as the real agent's database), and sends events. Like the real agent, it decodes every message from the
// fleet with the protocol's schemas and closes with 1008 on one that doesn't fit.
// Real WebSockets, synthetic data only.
import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import { WebSocket, type RawData } from "ws";
import {
  FLEET_PROTO, FleetFrames, decodeValue, fleetSigPayload, nodeSigPayload,
  type FleetMessage, type Health, type HookEvent, type OpError, type OpResult, type Pane,
} from "@morndo/protocol";

export type Closed = { code: number; reason: string };
export type Req = Extract<FleetMessage, { t: "req" }>;
export type Welcome = Extract<FleetMessage, { t: "welcome" }>;
export type Answer = { ok: true; result: unknown } | { ok: false; error: OpError } | "never";
export type AgentKey = { publicKey: string; privateKey: KeyObject };
export type Connected = { ok: true; welcome: Welcome } | { ok: false; closed: Closed; fleetSigOk: boolean | null };

// A text frame's JSON, whatever buffer shape ws hands it in.
export const parseFrame = <T>(raw: RawData): T =>
  JSON.parse((Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw)).toString("utf8")) as T;

export const newKey = (): AgentKey => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"), privateKey };
};
const sig = (key: AgentKey, payload: string) => sign(null, Buffer.from(payload), key.privateKey).toString("base64");

// A minimal result of each op that fits OP_RESULTS, for an agent whose test doesn't care what it answers.
export const validResult = (op: string, node: string): unknown => {
  const results: { [O in keyof OpResult]: OpResult[O] } = {
    "inventory.get": { panes: [], invVersion: 1 }, "pane.captureMany": { captures: [] }, "pane.frame": { frame: null },
    "pane.keys": { ok: true }, "pane.send": { problem: null, typedAt: 1 }, "op.status": { state: "unknown" },
    "transcript.size": { size: null }, "transcript.read": { bytes: "", eof: true }, "transcript.locate": { offset: null },
    "file.stat": { size: 0, mtime: 0 }, "file.get": { bytes: "", size: 0, eof: true }, "file.put": { path: null },
    "lane.start": { workerId: `${node || "node"}.3fa2c1d0.0` }, "lane.stop": { ok: true }, "worktree.list": { worktrees: [] },
    "worktree.add": { path: "/work" },
  };
  return Object.hasOwn(results, op) ? results[op as keyof OpResult] : {};
};

export const health = (over: Partial<Health> = {}): Health => ({
  memTotal: 8e9, memAvailable: 4e9, psiSome10: 0, psiFull10: 0, diskFreeHome: 1e11, load1: 0.5, tmuxOk: true,
  wallClock: Date.now(), spoolDepth: 0, drops: 0, ...over,
});

export class FakeAgent {
  readonly url: string;
  readonly fleetKey: string;
  key: AgentKey;
  node: string;
  instanceId: string;
  streamId: string;
  store: string;                               // what each res says its done keys live in (the real agent: its stream id)
  ws: WebSocket | null = null;
  welcome: Welcome | null = null;
  inbox: FleetMessage[] = [];                  // every message of the current connection, in order, as sent
  reqs: Req[] = [];                            // every request this agent was sent, across connections
  refused: unknown[] = [];                     // messages from the fleet that don't fit the protocol (closed with 1008)
  invVersion = 1;
  answer: (req: Req) => Answer = req => ({ ok: true, result: validResult(req.op, this.node) });
  #waiters = new Set<() => void>();
  #closed: Promise<Closed> = Promise.resolve({ code: 0, reason: "never connected" });

  constructor(o: { url: string; fleetKey: string; node?: string; key?: AgentKey; instanceId?: string; streamId?: string }) {
    this.url = o.url;
    this.fleetKey = o.fleetKey;
    this.node = o.node ?? "";
    this.key = o.key ?? newKey();
    this.instanceId = o.instanceId ?? randomUUID();
    this.streamId = o.streamId ?? randomUUID();
    this.store = this.streamId;
  }

  get closed(): Promise<Closed> { return this.#closed; }
  get open(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  // Opens a socket; resolves once open (true) or refused before opening (false).
  #open(o: { autoPong?: boolean; headers?: Record<string, string> }): Promise<boolean> {
    this.inbox = [];
    this.welcome = null;
    const ws = new WebSocket(this.url, { autoPong: o.autoPong ?? true, headers: o.headers ?? {} });
    this.ws = ws;
    this.#closed = new Promise<Closed>(resolve => ws.on("close", (code, reason) => { this.#wake(); resolve({ code, reason: reason.toString() }); }));
    ws.on("error", () => {});
    ws.on("message", raw => {
      const value = parseFrame<unknown>(raw);
      if (decodeValue(FleetFrames, value).kind !== "ok") {
        this.refused.push(value);
        ws.close(1008, "a malformed or unknown message");
        return;
      }
      const m = value as FleetMessage;                         // as the fleet sent it: a field too many would show
      this.inbox.push(m);
      if (m.t === "req") this.#onReq(m);
      this.#wake();
    });
    return new Promise<boolean>(resolve => {
      ws.once("open", () => resolve(true));
      ws.once("close", () => resolve(false));
    });
  }

  #onReq(req: Req) {
    this.reqs.push(req);
    const a = this.answer(req);
    if (a === "never") return;
    this.send(a.ok ? { v: 1, t: "res", id: req.id, invVersion: this.invVersion, store: this.store, ok: true, result: a.result }
      : { v: 1, t: "res", id: req.id, invVersion: this.invVersion, store: this.store, ok: false, error: a.error });
  }

  #wake() { for (const w of [...this.#waiters]) w(); }

  // The first message of this connection that `pick` maps to a value, or null once the socket closes or `ms` pass.
  next<T>(pick: (m: FleetMessage) => T | undefined, ms = 5000): Promise<T | null> {
    return new Promise<T | null>(resolve => {
      const check = () => {
        for (const m of this.inbox) { const v = pick(m); if (v !== undefined) { done(v); return; } }
        if (this.ws?.readyState === WebSocket.CLOSED) done(null);
      };
      const done = (v: T | null) => { clearTimeout(timer); this.#waiters.delete(check); resolve(v); };
      const timer = setTimeout(() => done(null), ms);
      this.#waiters.add(check);
      check();
    });
  }

  send(m: unknown): void { this.ws?.send(typeof m === "string" ? m : JSON.stringify(m)); }

  // `join { node, code, publicKey, agent, proto }`, with the name and the code from the join string. The agent takes
  // that name as its own; the welcome only says it was accepted.
  async join(node: string, code: string, o: { proto?: number[] } = {}): Promise<{ welcome: Welcome | null; closed: Closed }> {
    this.node = node;
    if (!(await this.#open({}))) return { welcome: null, closed: await this.#closed };
    this.send({ v: 1, t: "join", node, code, publicKey: this.key.publicKey, agent: { version: "test-agent/1" }, proto: o.proto ?? [FLEET_PROTO] });
    const welcome = await this.next(m => (m.t === "welcome" ? m : undefined));
    return { welcome, closed: await this.#closed };
  }

  // hello → challenge (the fleet's signature checked against the pinned key) → proof → welcome.
  async connect(o: {
    proto?: number[]; autoPong?: boolean; headers?: Record<string, string>; proof?: "good" | "tampered" | "other-key"; pinned?: string; node?: string;
  } = {}): Promise<Connected> {
    const node = o.node ?? this.node;
    if (!(await this.#open(o))) return { ok: false, closed: await this.#closed, fleetSigOk: null };
    const clientNonce = randomBytes(32).toString("base64url");
    this.send({
      v: 1, t: "hello", node, instanceId: this.instanceId, streamId: this.streamId, proto: o.proto ?? [FLEET_PROTO],
      agent: { version: "test-agent/1" }, claude: { version: null }, caps: ["inventory.get"], clientNonce,
    });
    const challenge = await this.next(m => (m.t === "challenge" ? m : undefined));
    if (!challenge) return { ok: false, closed: await this.#closed, fleetSigOk: null };
    const pinned = createPublicKey({ key: Buffer.from(o.pinned ?? this.fleetKey, "base64"), format: "der", type: "spki" });
    const fleetSigOk = verify(null, Buffer.from(fleetSigPayload(node, clientNonce)), pinned, Buffer.from(challenge.fleetSig, "base64"));
    if (!fleetSigOk) { this.ws?.close(); return { ok: false, closed: { code: -1, reason: "the fleet's signature does not verify" }, fleetSigOk }; }
    let proof = sig(o.proof === "other-key" ? newKey() : this.key, nodeSigPayload(node, challenge.nonce));
    if (o.proof === "tampered") { const b = Buffer.from(proof, "base64"); b[5] = (b[5] ?? 0) ^ 0xff; proof = b.toString("base64"); }
    this.send({ v: 1, t: "proof", sig: proof });
    const welcome = await this.next(m => (m.t === "welcome" ? m : undefined));
    if (!welcome) return { ok: false, closed: await this.#closed, fleetSigOk };
    this.welcome = welcome;
    return { ok: true, welcome };
  }

  inventory(panes: Pane[]): void { this.send({ v: 1, t: "ev.inventory", panes, invVersion: ++this.invVersion }); }
  health(h: Health = health()): void { this.send({ v: 1, t: "ev.health", health: h }); }

  hook(seq: number, path: HookEvent["path"] = "/hook/stop", body: unknown = { n: seq }, over: Partial<HookEvent> = {}): void {
    const event: HookEvent = { streamId: this.streamId, seq, at: 1_700_000_000_000 + seq, path, node: this.node, window: "lane", body, ...over };
    this.send({ v: 1, t: "ev.hook", event });
  }

  // The highest cumulative ack for this agent's stream on the current connection, waiting until it reaches `seq`.
  acked(seq: number, ms = 5000): Promise<number | null> {
    return this.next(m => (m.t === "ack" && m.streamId === this.streamId && m.seq >= seq ? m.seq : undefined), ms);
  }

  async close(): Promise<void> {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) { this.ws.close(); await this.#closed; }
  }

  terminate(): void { this.ws?.terminate(); }
}
```

Create `apps/fleet/test/helpers/fleet.ts`:

```ts
// A real fleet service in this process for the tests: port 0, its key, database and socket in a temporary directory,
// stopped after each test. `joined(name)` registers a node through a real join and returns its fake agent. Every test
// connects from 127.0.0.1, many times: the handshake bucket is wide here unless a test passes its own
// (handshakeLimits; agent-auth.test.ts tests the real one).
import { join } from "node:path";
import { afterEach } from "vitest";
import type { FleetConfig } from "../../src/config.ts";
import { createLogger } from "../../src/adapters/log.ts";
import type { BucketConfig } from "../../src/adapters/rate-limit.ts";
import { startFleet, type Fleet, type FleetOptions } from "../../src/serve.ts";
import { FakeAgent, type AgentKey } from "./fake-agent.ts";
import { tempDir } from "./temp.ts";

export type TestFleet = Fleet & {
  dir: string;
  agentUrl: string;
  code(name: string): string;
  agent(o?: { node?: string; key?: AgentKey; instanceId?: string; streamId?: string }): FakeAgent;
  joined(name: string, o?: { instanceId?: string; streamId?: string }): Promise<FakeAgent>;
  online(name: string, o?: { instanceId?: string; streamId?: string }): Promise<FakeAgent>;
};

const running = new Set<Fleet>();
const agents = new Set<FakeAgent>();
afterEach(async () => {
  for (const a of agents) a.terminate();
  agents.clear();
  for (const f of running) await f.close();
  running.clear();
});

export const quiet = createLogger({ level: "error", sink: () => {} });
export const WIDE: BucketConfig = { capacity: 100_000, refillPerSecond: 100_000 };

export function testConfig(dir: string, over: Partial<FleetConfig> = {}): FleetConfig {
  return {
    listen: { host: "127.0.0.1", port: 0 }, socketPath: join(dir, "s", "f.sock"), dbPath: join(dir, "fleet.db"),
    keyPath: join(dir, "key.pem"), publicUrl: "ws://127.0.0.1:8791/agent", subscribers: [], ...over,
  };
}

export async function startTestFleet(o: FleetOptions & { dir?: string; config?: Partial<FleetConfig> } = {}): Promise<TestFleet> {
  const dir = o.dir ?? tempDir();
  const fleet = await startFleet(testConfig(dir, o.config), { log: quiet, handshakeLimits: WIDE, ...o });
  running.add(fleet);
  const close = () => fleet.close();
  const agentUrl = `ws://127.0.0.1:${fleet.agentPort}/agent`;
  const t: TestFleet = {
    ...fleet,
    close: async () => { if (running.delete(fleet)) await close(); },
    dir,
    agentUrl,
    code: name => { const r = fleet.nodes.issueCode(name); if (!r.ok) throw new Error(r.refused); return r.code; },
    agent: (a = {}) => { const fa = new FakeAgent({ url: agentUrl, fleetKey: fleet.key.publicKey, ...a }); agents.add(fa); return fa; },
    joined: async (name, a = {}) => {
      const fa = t.agent(a);
      const r = await fa.join(name, t.code(name));
      if (!r.welcome) throw new Error(`join refused: ${r.closed.code} ${r.closed.reason}`);
      return fa;
    },
    online: async (name, a = {}) => {
      const fa = await t.joined(name, a);
      const r = await fa.connect();
      if (!r.ok) throw new Error(`connect refused: ${r.closed.code} ${r.closed.reason}`);
      return fa;
    },
  };
  return t;
}
```

Create `apps/fleet/test/helpers/until.ts`:

```ts
// Waits in real time until `cond` holds. For tests that fake only setInterval: vi.waitFor would advance the fake clock
// on every check and fire the ping sweep early.
export async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`condition not met within ${ms} ms`);
    await new Promise(r => setTimeout(r, 5));
  }
}
```

- [ ] **Step 12: Write the failing endpoint tests: requests, join and authentication, instances and the flap test, liveness, and the serve process**

Create `apps/fleet/test/requests.test.ts`:

```ts
// Requests to an agent (spec 5.2, 5.3): req { id, op, args, timeoutMs, key? } and its res, matched by id, its result
// checked against OP_RESULTS; deadlines the agent never answered: timeout (executed: no) for a read, uncertain
// (executed: maybe) for a side-effecting op; no message over 512 KiB; one bulk transfer at a time per node, with
// control ops never queued behind it, at most 8 waiting, each waiting op's deadline counted from when it was queued.
// Every outcome carries the store its answer comes from: the agent's, the connection's for the fleet's own answer
// after sending, null when nothing was sent.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { LIMITS } from "@morndo/protocol";
import type { Req } from "./helpers/fake-agent.ts";
import { startTestFleet } from "./helpers/fleet.ts";

describe("requests to an agent", () => {
  it("a request reaches the agent with its args, key and timeout, and its result comes back with invVersion", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    a.answer = req => (req.op === "pane.send" ? { ok: true, result: { problem: null, typedAt: 42 } } : { ok: true, result: {} });
    const args = { workerId: "pc.3fa2c1d0.1", text: "hello", expect: { server: "3fa2c1d0", window: "api" } };
    const r = await fleet.connections.request("pc", "pane.send", args, { key: "hub:e1:r1", timeoutMs: 4000 });
    expect(r).toEqual({ ok: true, result: { problem: null, typedAt: 42 }, invVersion: 1, store: a.streamId });
    expect(a.reqs).toEqual([{ v: 1, t: "req", id: "1.1", op: "pane.send", args, timeoutMs: 4000, key: "hub:e1:r1" }]);
  });

  it("passes the agent's refusal through as it is", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    a.answer = () => ({ ok: false, error: { code: "menu_open", executed: "no", message: "a menu is open" } });
    expect(await fleet.connections.request("pc", "pane.send", {}, { key: "hub:k", timeoutMs: 1000 }))
      .toEqual({ ok: false, error: { code: "menu_open", executed: "no", message: "a menu is open" }, store: a.streamId });
  });

  it("a result that doesn't fit its op's shape is internal (executed: maybe), never handed on; op.status's outcome passes as stored", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    a.answer = req => ({ ok: true, result: req.op === "pane.send" ? { problem: "exploded", typedAt: 1 } : { panes: "none" } });
    expect(await fleet.connections.request("pc", "pane.send", {}, { key: "hub:k", timeoutMs: 1000 }))
      .toMatchObject({ ok: false, error: { code: "internal", executed: "maybe" } });
    expect(await fleet.connections.request("pc", "inventory.get", {}, { timeoutMs: 1000 }))
      .toMatchObject({ ok: false, error: { code: "internal", executed: "maybe" } });
    const outcome = { problem: null, typedAt: 5, more: [1] };
    a.answer = () => ({ ok: true, result: { state: "done", outcome } });
    expect(await fleet.connections.request("pc", "op.status", { key: "hub:k" }, { timeoutMs: 1000 }))
      .toEqual({ ok: true, result: { state: "done", outcome }, invVersion: 1, store: a.streamId });
  });

  it("every answer carries its store: the agent's own on its answers, the connection's on the fleet's after sending, null before", async () => {
    const fleet = await startTestFleet({ resultSlackMs: 20 });
    const a = await fleet.online("pc");
    a.store = randomUUID();                                                        // the agent says where its keys are
    a.answer = req => (req.op === "pane.send" ? { ok: false, error: { code: "busy", executed: "no", message: "locked" } }
      : req.op === "inventory.get" ? { ok: true, result: { panes: "none" } } : req.op === "op.status" ? { ok: true, result: { state: "unknown" } } : "never");
    expect(await fleet.connections.request("pc", "op.status", { key: "hub:k" }, { timeoutMs: 1000 })).toMatchObject({ ok: true, store: a.store });
    expect(await fleet.connections.request("pc", "pane.send", {}, { key: "hub:k", timeoutMs: 1000 })).toMatchObject({ ok: false, store: a.store });
    expect(await fleet.connections.request("pc", "inventory.get", {}, { timeoutMs: 1000 })).toMatchObject({ error: { code: "internal" }, store: a.store });
    // The fleet's own answers to a request it sent: the store of the connection it went out on (the hello's stream id).
    expect(await fleet.connections.request("pc", "transcript.size", { sessionId: "s" }, { timeoutMs: 50 })).toMatchObject({ error: { code: "timeout" }, store: a.streamId });
    expect(await fleet.connections.request("pc", "lane.stop", { name: "x" }, { key: "hub:k2", timeoutMs: 50 })).toMatchObject({ error: { code: "uncertain" }, store: a.streamId });
    // Nothing sent: no store.
    expect(await fleet.connections.request("pc", "pane.send", { text: "x".repeat(LIMITS.maxMessageBytes) }, { key: "hub:k3", timeoutMs: 1000 })).toMatchObject({ error: { code: "too_large" }, store: null });
    expect(await fleet.connections.request("mac", "inventory.get", {}, { timeoutMs: 1000 })).toMatchObject({ error: { code: "node_offline" }, store: null });
  });

  it("an unanswered read times out (executed: no); an unanswered side effect is uncertain (executed: maybe)", async () => {
    const fleet = await startTestFleet({ resultSlackMs: 20 });
    const a = await fleet.online("pc");
    a.answer = () => "never";
    expect(await fleet.connections.request("pc", "transcript.size", { sessionId: "s" }, { timeoutMs: 50 }))
      .toMatchObject({ ok: false, error: { code: "timeout", executed: "no" } });
    expect(await fleet.connections.request("pc", "pane.send", {}, { key: "hub:k", timeoutMs: 50 }))
      .toMatchObject({ ok: false, error: { code: "uncertain", executed: "maybe" } });
    expect(await fleet.connections.request("pc", "pane.keys", {}, { timeoutMs: 50 }))
      .toMatchObject({ ok: false, error: { code: "uncertain", executed: "maybe" } });     // keystrokes: a side effect
    expect(fleet.connections.requests.size).toBe(0);
  });

  it("a request over 512 KiB is refused too_large (executed: no) and never sent: it would close the node's connection", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    expect(await fleet.connections.request("pc", "pane.send", { text: "x".repeat(LIMITS.maxMessageBytes) }, { key: "hub:k", timeoutMs: 1000 }))
      .toMatchObject({ ok: false, error: { code: "too_large", executed: "no" } });
    expect(a.reqs).toEqual([]);
    expect(a.open).toBe(true);
  });

  it("bulk transfers go one at a time per node, and control ops never wait behind them (spec 5.2)", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    const held: Req[] = [];
    a.answer = req => {
      if (req.op !== "file.get") return { ok: true, result: { panes: [], invVersion: 1 } };
      held.push(req);
      return "never";
    };
    const first = fleet.connections.request("pc", "file.get", { path: "/a", offset: 0, max: 10 }, { timeoutMs: 5000 });
    const second = fleet.connections.request("pc", "file.get", { path: "/b", offset: 0, max: 10 }, { timeoutMs: 5000 });
    expect(await fleet.connections.request("pc", "inventory.get", {}, { timeoutMs: 5000 })).toMatchObject({ ok: true });
    expect(a.reqs.map(r => r.op)).toEqual(["file.get", "inventory.get"]);            // the second file.get waits
    const reply = (req: Req | undefined) => a.send({ v: 1, t: "res", id: req?.id, invVersion: 1, store: a.store, ok: true, result: { bytes: "", size: 0, eof: true } });
    reply(held[0]);
    expect(await first).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(held).toHaveLength(2));
    expect(held[1]?.args).toMatchObject({ path: "/b" });
    reply(held[1]);
    expect(await second).toMatchObject({ ok: true });
  });

  it("a waiting bulk op's deadline counts from when it was queued: behind a hung transfer it answers timeout, never sent", async () => {
    const fleet = await startTestFleet({ resultSlackMs: 20 });
    const a = await fleet.online("pc");
    a.answer = () => "never";
    const hung = fleet.connections.request("pc", "file.get", { path: "/a", offset: 0, max: 10 }, { timeoutMs: 3000 });
    const started = performance.now();
    const waiting = await fleet.connections.request("pc", "file.get", { path: "/b", offset: 0, max: 10 }, { timeoutMs: 300 });
    expect(waiting).toEqual({ ok: false, error: expect.objectContaining({ code: "timeout", executed: "no" }), store: null });
    expect(performance.now() - started).toBeLessThan(1500);                        // its own 300 ms, not the hung one's 3 s
    expect(a.reqs.map(r => (r.args as { path: string }).path)).toEqual(["/a"]);
    expect(await hung).toMatchObject({ ok: false, error: { code: "timeout" } });
  });

  it("a slow node that answers: each waiting bulk op goes with what is left of its own timeout, and all of them land", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    a.answer = req => {
      setTimeout(() => a.send({ v: 1, t: "res", id: req.id, invVersion: 1, store: a.store, ok: true, result: { bytes: "", size: 0, eof: true } }), 150);
      return "never";
    };
    const all = await Promise.all([1, 2, 3, 4].map(n => fleet.connections.request("pc", "file.get", { path: `/${n}`, offset: 0, max: 10 }, { timeoutMs: 5000 })));
    expect(all.every(o => o.ok)).toBe(true);
    const sent = a.reqs.map(r => r.timeoutMs);
    expect(sent[0]).toBe(5000);
    for (let i = 1; i < sent.length; i++) expect(sent[i], `transfer ${i + 1}`).toBeLessThan((sent[i - 1] ?? 0) - 100);   // ~150 ms less each
  });

  it("at most 8 bulk ops wait per node: the next one is busy (executed: no), never sent", async () => {
    const fleet = await startTestFleet({ resultSlackMs: 20 });
    const a = await fleet.online("pc");
    a.answer = () => "never";
    const get = (n: number) => fleet.connections.request("pc", "file.get", { path: `/${n}`, offset: 0, max: 10 }, { timeoutMs: 400 });
    const inFlight = [0, ...Array.from({ length: LIMITS.bulkQueueMax }, (_, i) => i + 1)].map(get);   // one sent, 8 waiting
    expect(await get(99)).toEqual({ ok: false, error: expect.objectContaining({ code: "busy", executed: "no" }), store: null });
    await vi.waitFor(() => expect(a.reqs).toHaveLength(1));
    expect((await Promise.all(inFlight)).every(o => !o.ok)).toBe(true);           // the hung one and those behind it time out
    expect(a.reqs).toHaveLength(1);                                                 // none of those waiting was ever sent
  });

  it("a node that is not online answers node_offline (executed: no) without sending anything", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.joined("pc");
    expect(await fleet.connections.request("pc", "inventory.get", {}, { timeoutMs: 1000 }))
      .toEqual({ ok: false, error: { code: "node_offline", executed: "no", message: "node pc is offline" }, store: null });
    expect(await fleet.connections.request("nobody", "inventory.get", {}, { timeoutMs: 1000 })).toMatchObject({ ok: false, error: { code: "node_offline" } });
    expect(a.reqs).toEqual([]);
  });
});
```

Create `apps/fleet/test/agent-auth.test.ts`:

```ts
// The agent endpoint's join and mutual authentication (spec 5.1, 5.2) against a real fleet and scripted agents:
// close codes 4401 (bad proof), 4403 (unknown, revoked, refused join), 4426 (no common protocol version), 1009 (a
// message too big), 1013 (too many joins and hellos from one address, before any key work). Admissions and refusals
// are audited with their source address.
// Negative controls: a tampered proof, a proof by another key, a reused code, an expired code and a code used with
// another name are each refused.
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { CLOSE, FLEET_PROTO, LIMITS } from "@morndo/protocol";
import { HANDSHAKES } from "../src/adapters/agent-endpoint.ts";
import { newKey } from "./helpers/fake-agent.ts";
import { startTestFleet } from "./helpers/fleet.ts";

describe("join", () => {
  it("a code registers the node the join names: a placeholder welcome, then the fleet closes the join connection", async () => {
    const fleet = await startTestFleet();
    const a = fleet.agent();
    const r = await a.join("pc", fleet.code("pc"));
    expect(r.welcome).toEqual({ v: 1, t: "welcome", connEpoch: 1, ackSeq: 0, streamKnown: false });
    expect(r.closed.code).toBe(1000);
    expect(fleet.nodes.active("pc")?.publicKey).toBe(a.key.publicKey);
    expect(fleet.audit.of("node.joined").map(e => e.node)).toEqual(["pc"]);
  });

  it("refuses an unknown, used or expired code with 4403, and audits it without the code", async () => {
    let now = 1_800_000_000_000;
    const fleet = await startTestFleet({ now: () => now });
    expect((await fleet.agent().join("pc", Buffer.alloc(16, 1).toString("base64url"))).closed.code).toBe(CLOSE.forbidden);
    const used = fleet.code("pc");
    expect((await fleet.agent().join("pc", used)).welcome).not.toBeNull();
    expect((await fleet.agent().join("pc", used)).closed.code).toBe(CLOSE.forbidden);   // negative control: reuse
    const late = fleet.code("mac");
    now += LIMITS.joinCodeTtlMs;
    expect((await fleet.agent().join("mac", late)).closed.code).toBe(CLOSE.forbidden);  // negative control: expired
    expect(fleet.audit.of("join.refused").map(e => e.detail.reason)).toEqual(["unknown", "used", "expired"]);
    expect(JSON.stringify(fleet.audit.recent())).not.toContain(used);
  });

  it("a code used with another node's name is refused with 4403 and stores nothing; with its own name it joins", async () => {
    const fleet = await startTestFleet();
    const code = fleet.code("node-a");
    const asB = await fleet.agent().join("node-b", code);                             // negative control: wrong name
    expect(asB).toMatchObject({ welcome: null, closed: { code: CLOSE.forbidden } });
    expect(fleet.nodes.list()).toEqual([]);
    expect(fleet.audit.of("join.refused").map(e => [e.detail.reason, e.detail.node])).toEqual([["wrong_node", "node-b"]]);
    const a = fleet.agent();
    expect((await a.join("node-a", code)).welcome).toEqual({ v: 1, t: "welcome", connEpoch: 1, ackSeq: 0, streamKnown: false });
    expect(fleet.nodes.list().map(n => n.name)).toEqual(["node-a"]);
    expect(await a.connect({ node: "node-b" })).toMatchObject({ ok: false, closed: { code: CLOSE.forbidden } });   // A's key is not B's
    expect((await a.connect()).ok).toBe(true);
  });

  it("refuses a join without a common protocol version with 4426", async () => {
    const fleet = await startTestFleet();
    const r = await fleet.agent().join("pc", fleet.code("pc"), { proto: [FLEET_PROTO + 1] });
    expect(r.closed.code).toBe(CLOSE.unsupported);
    expect(fleet.nodes.active("pc")).toBeNull();
  });
});

describe("hello, challenge, proof", () => {
  it("a joined node authenticates both ways: the fleet's signature verifies against the pinned key, then welcome", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.joined("pc");
    const r = await a.connect();
    expect(r).toEqual({ ok: true, welcome: { v: 1, t: "welcome", connEpoch: 1, ackSeq: 0, streamKnown: false } });
    expect(fleet.connections.status("pc")).toBe("online");
    expect(fleet.nodes.active("pc")?.agentVersion).toBe("test-agent/1");
    expect(fleet.nodes.active("pc")?.lastSeenAt).not.toBeNull();
    expect(fleet.audit.of("conn.admitted").map(e => [e.node, e.detail])).toEqual([["pc", { instanceId: a.instanceId, epoch: 1, source: "127.0.0.1" }]]);
  });

  it("an agent pinned to another fleet key rejects the challenge (the fleet's signature is bound to its key)", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.joined("pc");
    expect(await a.connect({ pinned: newKey().publicKey })).toMatchObject({ ok: false, fleetSigOk: false });
  });

  it("refuses a tampered proof and a proof by another key with 4401", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.joined("pc");
    expect(await a.connect({ proof: "tampered" })).toMatchObject({ ok: false, closed: { code: CLOSE.badProof }, fleetSigOk: true });
    expect(await a.connect({ proof: "other-key" })).toMatchObject({ ok: false, closed: { code: CLOSE.badProof } });
    expect(fleet.connections.status("pc")).toBe("offline");
    expect(fleet.audit.of("auth.bad_proof")).toHaveLength(2);
    expect((await a.connect()).ok).toBe(true);                                         // the real key still works
  });

  it("refuses an unknown node and a revoked node with 4403", async () => {
    const fleet = await startTestFleet();
    const stranger = fleet.agent({ node: "stranger" });
    expect(await stranger.connect()).toMatchObject({ ok: false, closed: { code: CLOSE.forbidden } });
    const a = await fleet.joined("pc");
    fleet.nodes.revoke("pc");
    expect(await a.connect()).toMatchObject({ ok: false, closed: { code: CLOSE.forbidden } });
    expect(fleet.audit.of("conn.refused").map(e => [e.node, e.detail])).toEqual([
      ["stranger", { reason: "unknown_node", source: "127.0.0.1" }], ["pc", { reason: "unknown_node", source: "127.0.0.1" }],
    ]);
  });

  it("refuses a hello without a common protocol version with 4426, and takes the previous or current one", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.joined("pc");
    expect(await a.connect({ proto: [FLEET_PROTO + 1] })).toMatchObject({ ok: false, closed: { code: CLOSE.unsupported } });
    expect(await a.connect({ proto: [0] })).toMatchObject({ ok: false, closed: { code: 1003 } });          // no version at all: malformed
    expect((await a.connect({ proto: [FLEET_PROTO, FLEET_PROTO + 1] })).ok).toBe(true);
  });
});

describe("what the endpoint refuses outright", () => {
  it("malformed or binary messages close with 1003; a message out of order with 1008; a slow handshake with 1008", async () => {
    const fleet = await startTestFleet({ handshakeMs: 300 });
    const sockets: WebSocket[] = [];
    // Sends `data` (nothing, if undefined) on a fresh connection and returns the close code the fleet answers with.
    const closeCodeAfter = async (data?: string | Buffer) => {
      const ws = new WebSocket(fleet.agentUrl);
      sockets.push(ws);
      const closed = new Promise<number>(r => ws.once("close", code => r(code)));
      await new Promise(r => ws.once("open", r));
      if (data !== undefined) ws.send(data, { binary: Buffer.isBuffer(data) });
      return closed;
    };
    try {
      expect(await closeCodeAfter("not json")).toBe(1003);
      expect(await closeCodeAfter(JSON.stringify({ v: 1, t: "from-the-future" }))).toBe(1003);
      expect(await closeCodeAfter(Buffer.from([1, 2, 3]))).toBe(1003);
      expect(await closeCodeAfter(JSON.stringify({ v: 1, t: "proof", sig: "AAAA" }))).toBe(1003);              // not a signature
      expect(await closeCodeAfter(JSON.stringify({ v: 1, t: "proof", sig: `${"A".repeat(86)}==` }))).toBe(1008);   // before a hello
      expect(await closeCodeAfter()).toBe(1008);                                        // says nothing: handshake timeout
    } finally { for (const ws of sockets) ws.terminate(); }
  });

  it("a message over 512 KiB closes with 1009, and so does one over the 1 MiB maxPayload (ws itself)", async () => {
    const fleet = await startTestFleet();
    const closeCode = async (bytes: number) => {
      const ws = new WebSocket(fleet.agentUrl);
      const closed = new Promise<number>(r => ws.once("close", code => r(code)));
      ws.on("error", () => {});
      await new Promise(r => ws.once("open", r));
      ws.send(JSON.stringify({ v: 1, t: "hello", pad: "x".repeat(bytes) }));
      return closed;
    };
    expect(await closeCode(LIMITS.maxMessageBytes + 1)).toBe(1009);                 // the fleet's own 512 KiB limit
    expect(await closeCode(LIMITS.maxPayload + 1)).toBe(1009);                      // ws: past maxPayload, never buffered whole
    expect(await closeCode(1000)).toBe(1003);                                       // negative control: small, it is read (and malformed)
  });

  it("joins and hellos from one address past its bucket close with 1013 before any key work, and audit nothing", async () => {
    const fleet = await startTestFleet({ handshakeLimits: HANDSHAKES });           // the real bucket: 10 at once
    const challenged: boolean[] = [];
    for (let i = 0; i < LIMITS.handshakeBurst + 2; i++) {
      const s = fleet.agent({ node: "stranger" });
      const r = await s.connect();
      expect(r.ok).toBe(false);
      challenged.push(s.inbox.some(m => m.t === "challenge"));
      expect(r.ok ? 0 : r.closed.code, `hello ${i + 1}`).toBe(i < LIMITS.handshakeBurst ? CLOSE.forbidden : 1013);
    }
    expect(challenged.filter(Boolean)).toEqual([]);                                 // an unknown node is never challenged anyway
    expect(fleet.audit.of("conn.refused")).toHaveLength(LIMITS.handshakeBurst);     // the two over the bucket: not audited
    const code = fleet.code("pc");
    expect((await fleet.agent().join("pc", code)).closed.code).toBe(1013);          // a join counts too: its code isn't touched
    expect(fleet.nodes.list()).toEqual([]);
    expect(fleet.audit.of("join.refused")).toEqual([]);
    expect(fleet.audit.alerts(0)).toEqual([]);                                      // no alert from outside
    // Another address (Tailscale Serve's X-Forwarded-For from this machine) has its own bucket.
    const other = fleet.agent({ node: "stranger" });
    expect(await other.connect({ headers: { "x-forwarded-for": "100.64.0.9" } })).toMatchObject({ ok: false, closed: { code: CLOSE.forbidden } });
  });

  it("an upgrade elsewhere gets 404 and plain HTTP gets 426", async () => {
    const fleet = await startTestFleet();
    const status = await new Promise<number>(resolve => {
      const ws = new WebSocket(`ws://127.0.0.1:${fleet.agentPort}/elsewhere`);
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      ws.on("error", () => {});
    });
    expect(status).toBe(404);
    const plain = await new Promise<number>(resolve => request(`http://127.0.0.1:${fleet.agentPort}/agent`, res => { res.resume(); resolve(res.statusCode ?? 0); }).end());
    expect(plain).toBe(426);
  });

  it("an event naming another node or stream closes the connection with 1008", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    a.hook(1, "/hook/stop", {}, { node: "someone-else" });
    expect((await a.closed).code).toBe(1008);
    const b = await fleet.online("mac");
    b.hook(1, "/hook/stop", {}, { streamId: randomUUID() });
    expect((await b.closed).code).toBe(1008);
  });
});
```

Create `apps/fleet/test/instances.test.ts`:

```ts
// The instance rules (spec 5.2): one live instance per node. The same instanceId replaces its older connection; a
// different one while the old is live makes the fleet ping the old one: a pong refuses the newcomer with 4409 and one
// alert, no pong within 3 s (LIMITS.instancePongMs) lets it in and terminates the old one (a half-open socket or a hung
// agent can't lock its node out), and the wait never holds another node. A different one is accepted at once once the
// old closed or missed its sweep pong. The flap test (spec 9): two instances with one key for 5 minutes. The ping
// interval runs on fake timers (setInterval only); sockets, the instance check and everything else run for real.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLOSE, LIMITS } from "@morndo/protocol";
import type { FleetEvent } from "../src/application/events.ts";
import { startTestFleet } from "./helpers/fleet.ts";
import { until } from "./helpers/until.ts";

afterEach(() => { vi.useRealTimers(); });
const settle = () => new Promise(r => setTimeout(r, 5));       // real time for the sockets between fake ticks
const statuses = (events: FleetEvent[], node: string) => events.filter(e => e.t === "status" && e.node === node).map(e => (e.body as { status: string }).status);

describe("one live instance per node", () => {
  it("the same instance reconnecting replaces its older connection, with the next epoch and no alert", async () => {
    const fleet = await startTestFleet();
    const first = await fleet.online("pc");
    const again = fleet.agent({ node: "pc", key: first.key, instanceId: first.instanceId, streamId: first.streamId });
    const r = await again.connect();
    expect(r).toMatchObject({ ok: true, welcome: { connEpoch: 2 } });
    expect((await first.closed).code).toBe(1000);
    expect(fleet.connections.liveInstance("pc")).toEqual({ instanceId: first.instanceId, epoch: 2 });
    expect(fleet.connections.status("pc")).toBe("online");
    expect(fleet.audit.alerts(0)).toEqual([]);
  });

  it("a different instance while one is live is refused with 4409 and one alert (also an event); the live one keeps serving", async () => {
    const fleet = await startTestFleet();
    const alerts: FleetEvent[] = [];
    fleet.events.subscribe(e => { if (e.t === "alert") alerts.push(e); });
    const a = await fleet.online("pc");
    const b = fleet.agent({ node: "pc", key: a.key });          // a cloned VM: the same key, its own instance
    const started = performance.now();
    expect(await b.connect()).toMatchObject({ ok: false, closed: { code: CLOSE.conflict } });
    expect(performance.now() - started).toBeLessThan(LIMITS.instancePongMs);   // a answered the check's ping: no 3 s wait
    expect(await b.connect()).toMatchObject({ ok: false, closed: { code: CLOSE.conflict } });
    expect(fleet.audit.of("alert.instance_conflict")).toHaveLength(1);
    expect(fleet.audit.of("alert.instance_conflict")[0]?.detail).toEqual({ live: a.instanceId, refused: b.instanceId, source: "127.0.0.1" });
    expect(alerts).toEqual([{ t: "alert", node: "pc", body: fleet.audit.recentAlerts()[0] }]);
    expect(alerts[0]?.body).toMatchObject({ node: "pc", kind: "instance_conflict", detail: { live: a.instanceId, refused: b.instanceId } });
    expect(a.open).toBe(true);
    expect(await fleet.connections.request("pc", "inventory.get", {}, { timeoutMs: 2000 })).toMatchObject({ ok: true });
  });

  it("an old connection that misses the instance check's ping (half-open) gives way: the new instance is in within about 3 s", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.joined("pc");
    expect((await a.connect({ autoPong: false })).ok).toBe(true);   // the old process hung, or its socket is half-open
    const b = fleet.agent({ node: "pc", key: a.key });
    const started = performance.now();
    expect(await b.connect()).toMatchObject({ ok: true, welcome: { connEpoch: 2 } });   // negative control: without the check, 4409
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(LIMITS.instancePongMs - 50);
    expect(waited).toBeLessThan(LIMITS.instancePongMs + 1500);
    expect((await a.closed).code).toBe(1006);                                        // terminated, not closed politely
    expect(fleet.connections.liveInstance("pc")).toEqual({ instanceId: b.instanceId, epoch: 2 });
    expect(fleet.audit.of("alert.instance_conflict")).toEqual([]);
    expect(fleet.audit.of("conn.replaced").map(e => e.detail)).toEqual([{ old: a.instanceId, new: b.instanceId, source: "127.0.0.1" }]);
    expect(await fleet.connections.request("pc", "inventory.get", {}, { timeoutMs: 2000 })).toMatchObject({ ok: true, store: b.streamId });
  });

  it("waiting for one node's instance check holds no other node", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.joined("pc");
    expect((await a.connect({ autoPong: false })).ok).toBe(true);
    const b = fleet.agent({ node: "pc", key: a.key });
    const checking = b.connect();                                                   // waits up to 3 s for a's pong
    await new Promise(r => setTimeout(r, 200));
    const started = performance.now();
    const mac = await fleet.online("mac");
    expect(await fleet.connections.request("mac", "inventory.get", {}, { timeoutMs: 2000 })).toMatchObject({ ok: true });
    expect(performance.now() - started).toBeLessThan(1500);
    expect(mac.open).toBe(true);
    expect((await checking).ok).toBe(true);
  });

  it("a different instance is accepted once the old connection closed", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    const b = fleet.agent({ node: "pc", key: a.key });
    expect((await b.connect()).ok).toBe(false);
    await a.close();
    await vi.waitFor(() => expect(fleet.connections.status("pc")).toBe("offline"));
    expect(await b.connect()).toMatchObject({ ok: true, welcome: { connEpoch: 2 } });
    expect(fleet.connections.liveInstance("pc")?.instanceId).toBe(b.instanceId);
  });

  it("a different instance is accepted once the old one missed its pong: online, stale, offline", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fleet = await startTestFleet();
    const seen: FleetEvent[] = [];
    fleet.events.subscribe(e => seen.push(e));
    const a = await fleet.joined("pc");
    expect((await a.connect({ autoPong: false })).ok).toBe(true);   // a frozen process: the socket stays, pongs stop
    vi.advanceTimersByTime(LIMITS.pingMs);                          // ping
    await settle();
    expect(fleet.connections.status("pc")).toBe("online");
    vi.advanceTimersByTime(LIMITS.pingMs);                          // no pong: stale, terminated
    expect((await a.closed).code).toBe(1006);
    // The agent may see its socket close before the fleet's close handler runs: wait for the fleet's view.
    await until(() => statuses(seen, "pc").length === 3);
    expect(statuses(seen, "pc")).toEqual(["online", "stale", "offline"]);
    const b = fleet.agent({ node: "pc", key: a.key });
    expect((await b.connect()).ok).toBe(true);
  });
});

describe("flapping (spec 9)", () => {
  it("two instances with one key for 5 minutes: exactly one connected, one alert, no op failures on the connected one", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    const b = fleet.agent({ node: "pc", key: a.key });
    const pongs = vi.spyOn(fleet.connections, "pong");
    const refusals: number[] = [];
    const failures: unknown[] = [];
    let ops = 0;
    // a answers every ping: the sweep's every 15 s, and each instance check b's hello causes.
    const answered = (second: number) => Math.floor(second / (LIMITS.pingMs / 1000)) + refusals.length;
    for (let second = 1; second <= 300; second++) {
      vi.advanceTimersByTime(1000);
      if (second % (LIMITS.pingMs / 1000) === 0) await until(() => pongs.mock.calls.length === answered(second));
      if (second % 10 === 0) { const r = await b.connect(); refusals.push(r.ok ? 0 : r.closed.code); }   // b retries every 10 s
      if (second % 5 === 0) {
        const o = await fleet.connections.request("pc", "inventory.get", {}, { timeoutMs: 2000 });
        ops++;
        if (!o.ok) failures.push(o.error);
      }
      await settle();
    }
    expect(refusals).toEqual(Array.from({ length: 30 }, () => CLOSE.conflict));
    expect({ ops, failures }).toEqual({ ops: 60, failures: [] });
    expect(a.open).toBe(true);
    expect(a.inbox.filter(m => m.t === "welcome")).toHaveLength(1);       // never replaced, never reconnected
    expect(fleet.connections.liveInstance("pc")).toEqual({ instanceId: a.instanceId, epoch: 1 });
    expect(fleet.audit.of("alert.instance_conflict")).toHaveLength(1);
    expect(pongs).toHaveBeenCalledTimes(20 + 30);                    // every sweep ping and every instance check, answered
  });
});
```

Create `apps/fleet/test/liveness.test.ts`:

```ts
// Liveness and what the fleet watches on a live connection (spec 5.2, 5.4, 8): pings, the revocation re-check, the
// per-node rate limit (hook events exempt), the source-address alert and the clock-offset alert; and the audit's
// 90-day retention, on start and daily.
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLOSE, LIMITS } from "@morndo/protocol";
import { sourceOf } from "../src/adapters/agent-endpoint.ts";
import { Audit } from "../src/adapters/audit.ts";
import { openFleetDb } from "../src/adapters/db.ts";
import { AUDIT_PRUNE_EVERY_MS } from "../src/serve.ts";
import type { FleetEvent } from "../src/application/events.ts";
import { health } from "./helpers/fake-agent.ts";
import { startTestFleet } from "./helpers/fleet.ts";
import { tempDir } from "./helpers/temp.ts";
import { until } from "./helpers/until.ts";

afterEach(() => { vi.useRealTimers(); });

describe("liveness", () => {
  it("an agent that answers pings stays online for 5 minutes, and last_seen moves", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fleet = await startTestFleet();
    const seen: FleetEvent[] = [];
    fleet.events.subscribe(e => seen.push(e));
    const a = await fleet.online("pc");
    const firstSeen = fleet.nodes.active("pc")?.lastSeenAt ?? 0;
    const pongs = vi.spyOn(fleet.connections, "pong");
    for (let i = 1; i <= 20; i++) {
      vi.advanceTimersByTime(LIMITS.pingMs);
      await until(() => pongs.mock.calls.length === i);              // each ping answered before the next sweep
    }
    expect(a.open).toBe(true);
    expect(seen.filter(e => e.t === "status").map(e => (e.body as { status: string }).status)).toEqual(["online"]);
    expect(fleet.nodes.active("pc")?.lastSeenAt).toBeGreaterThanOrEqual(firstSeen);
  });

  it("a revocation written to fleet.db while connected closes the connection with 4403 within one interval", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    fleet.nodes.revoke("pc");                                       // what `morndo-fleet node revoke` writes
    vi.advanceTimersByTime(LIMITS.pingMs);
    expect((await a.closed).code).toBe(CLOSE.forbidden);
    expect(fleet.connections.status("pc")).toBe("offline");
    expect(await fleet.connections.request("pc", "inventory.get", {}, { timeoutMs: 1000 })).toMatchObject({ ok: false, error: { code: "node_offline" } });
  });

  it("reports inventory and health as events and in the node list", async () => {
    const fleet = await startTestFleet();
    const seen: FleetEvent[] = [];
    fleet.events.subscribe(e => seen.push(e));
    const a = await fleet.online("pc");
    a.inventory([{ workerId: "pc.3fa2c1d0.1", window: "api", cwd: "/work/api" }]);
    a.health(health({ load1: 1.25 }));
    await vi.waitFor(() => expect(seen.map(e => e.t)).toEqual(["status", "inventory", "health"]));
    expect(seen[1]).toEqual({ t: "inventory", node: "pc", body: { panes: [{ workerId: "pc.3fa2c1d0.1", window: "api", cwd: "/work/api" }], invVersion: 2 } });
    expect(fleet.connections.list()).toEqual([{ name: "pc", status: "online", health: expect.objectContaining({ load1: 1.25 }), agent: "test-agent/1" }]);
  });
});

describe("per-node rate limit", () => {
  it("a flood of inventory or health closes with 1008 and an alert; a flood of hook events does not (replay is exempt)", async () => {
    const fleet = await startTestFleet({ agentLimits: { capacity: 20, refillPerSecond: 1 } });
    const hooks = await fleet.online("pc");
    for (let seq = 1; seq <= 300; seq++) hooks.hook(seq);
    hooks.health();
    await vi.waitFor(() => expect(fleet.connections.latest("pc").health).not.toBeNull());
    expect(hooks.open).toBe(true);
    const flood = await fleet.online("mac");
    for (let i = 0; i < 50; i++) flood.health();                     // negative control: the limit does bite
    expect((await flood.closed).code).toBe(1008);
    expect(fleet.audit.of("alert.rate_limited").map(e => e.node)).toEqual(["mac"]);
    await vi.waitFor(() => expect(fleet.connections.status("mac")).toBe("offline"));
  });
});

describe("the source address (spec 8)", () => {
  it("is the TCP peer, or the X-Forwarded-For Tailscale Serve sets when the peer is this machine", () => {
    const req = (remoteAddress: string, xff?: string) => ({ socket: { remoteAddress }, headers: xff === undefined ? {} : { "x-forwarded-for": xff } });
    expect(sourceOf(req("127.0.0.1"))).toBe("127.0.0.1");
    expect(sourceOf(req("127.0.0.1", "100.64.0.7"))).toBe("100.64.0.7");
    expect(sourceOf(req("::1", "100.64.0.7, 10.0.0.1"))).toBe("100.64.0.7");
    expect(sourceOf(req("100.64.0.9", "1.2.3.4"))).toBe("100.64.0.9");            // only a local proxy is believed
  });

  it("alerts when a node's source changes, not on its first connection or the same source again", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    expect(fleet.nodes.active("pc")?.lastSource).toBe("127.0.0.1");
    await a.close();
    expect((await a.connect()).ok).toBe(true);
    expect(fleet.audit.of("alert.source_changed")).toEqual([]);
    await a.close();
    expect((await a.connect({ headers: { "x-forwarded-for": "100.64.0.7" } })).ok).toBe(true);
    expect(fleet.audit.of("alert.source_changed").map(e => e.detail)).toEqual([{ from: "127.0.0.1", to: "100.64.0.7" }]);
  });
});

describe("audit retention (90 days)", () => {
  it("rows older than 90 days go when the service starts, and once a day while it runs", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let now = 1_800_000_000_000;
    const dir = tempDir();
    const db = openFleetDb(join(dir, "fleet.db"));
    const before = new Audit(db, { now: () => now });
    before.record("cli", "node.add", "old");
    before.alert("dead_letter", "old", {});
    db.close();
    now += LIMITS.auditKeepMs + 1;
    const fleet = await startTestFleet({ dir, now: () => now });
    expect(fleet.audit.recent()).toEqual([]);                                       // on start
    fleet.audit.record("cli", "node.add", "pc");
    now += LIMITS.auditKeepMs + 1;
    expect(fleet.audit.recent()).toHaveLength(1);
    vi.advanceTimersByTime(AUDIT_PRUNE_EVERY_MS);                                    // daily
    expect(fleet.audit.recent()).toEqual([]);
  });
});

describe("the node's clock (spec 5.4)", () => {
  it("an agent 10 s off raises one alert; back in step re-arms it", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    const healthSeen = (n: number) => vi.waitFor(() => expect(fleet.connections.latest("pc").health?.drops).toBe(n));
    a.health(health({ wallClock: Date.now() + 10_000, drops: 1 }));
    await healthSeen(1);
    a.health(health({ wallClock: Date.now() + 10_000, drops: 2 }));
    await healthSeen(2);
    expect(fleet.audit.of("alert.clock_offset")).toHaveLength(1);
    expect(fleet.audit.of("alert.clock_offset")[0]?.detail.offsetMs).toBeGreaterThan(9000);
    a.health(health({ wallClock: Date.now(), drops: 3 }));
    await healthSeen(3);
    a.health(health({ wallClock: Date.now() - 10_000, drops: 4 }));
    await healthSeen(4);
    expect(fleet.audit.of("alert.clock_offset")).toHaveLength(2);
  });
});
```

Create `apps/fleet/test/serve.test.ts`:

```ts
// `morndo-fleet serve` as a process: it reports where agents connect only once it listens, a node joined with
// `node add` connects to it, and SIGTERM stops it cleanly (exit 0). Temp HOME and config; port 0.
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseJoinString } from "@morndo/protocol";
import { FakeAgent } from "./helpers/fake-agent.ts";
import { tempDir } from "./helpers/temp.ts";

const MAIN = join(import.meta.dirname, "../src/main.ts");

describe("morndo-fleet serve", () => {
  it("listens, takes a joined node, and stops on SIGTERM with exit 0", async () => {
    const home = tempDir();
    const config = join(home, "fleet.json");
    writeFileSync(config, JSON.stringify({ listen: { host: "127.0.0.1", port: 0 }, socketPath: join(home, "s", "f.sock") }));
    const env = { ...process.env, HOME: home, MORNDO_FLEET_CONFIG: config };
    const added = spawnSync(process.execPath, ["--no-warnings", MAIN, "node", "add", "pc"], { env, encoding: "utf8", timeout: 20_000 });
    const joinString = parseJoinString(added.stdout.split("\n").find(l => l.startsWith("morndo-join:")) ?? "");
    expect(joinString).not.toBeNull();
    const child = spawn(process.execPath, ["--no-warnings", MAIN, "serve"], { env, stdio: ["ignore", "pipe", "pipe"] });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let out = "";
        child.stdout.on("data", (d: Buffer) => { out += d.toString(); const m = /agents on (ws:\/\/127\.0\.0\.1:\d+\/agent)/.exec(out); if (m?.[1]) resolve(m[1]); });
        child.once("exit", code => reject(new Error(`serve exited with ${code}`)));
      });
      const agent = new FakeAgent({ url, fleetKey: joinString?.fleetKey ?? "" });
      expect(joinString?.node).toBe("pc");
      expect((await agent.join(joinString?.node ?? "", joinString?.code ?? "")).welcome).toMatchObject({ t: "welcome" });
      expect((await agent.connect()).ok).toBe(true);
      const exited = new Promise<number | null>(r => child.once("exit", code => r(code)));
      child.kill("SIGTERM");
      expect(await exited).toBe(0);
      expect((await agent.closed).code).toBe(1001);                                    // "fleet service stopping"
    } finally { child.kill("SIGKILL"); }
  }, 30_000);
});
```

- [ ] **Step 13: Run them and see them fail**

Run: `npx vitest run apps/fleet/test/requests.test.ts apps/fleet/test/agent-auth.test.ts apps/fleet/test/instances.test.ts apps/fleet/test/liveness.test.ts apps/fleet/test/serve.test.ts`
Expected: FAIL, 5 files: `requests.test.ts` and `instances.test.ts` with `Error: Cannot find module '../../src/serve.ts' imported from …/apps/fleet/test/helpers/fleet.ts`; `agent-auth.test.ts` and `liveness.test.ts` with `Error: Cannot find module '../src/adapters/agent-endpoint.ts'` (each imports it itself); `serve.test.ts` runs its one test, which fails with `Error: serve exited with 2` (`main.ts` has no `serve` command yet and prints its help)

- [ ] **Step 14: Implement the hook-sink port, requests and connections**

Create `apps/fleet/src/application/hook-sink.ts`:

```ts
// Where an agent connection hands the hook events it receives (spec 5.4): the hook bus (Task 13) implements it.
// `known` answers the welcome's ackSeq and streamKnown; `accept` stores a batch durably and returns the highest seq
// now accepted for that stream, which the connection acknowledges (cumulative). Both run synchronously, so nothing
// is acknowledged before its commit.
import type { HookEvent } from "@morndo/protocol";

export type HookSink = {
  known(node: string, streamId: string): { seq: number; known: boolean };
  accept(node: string, streamId: string, events: HookEvent[]): number;
};
```

Create `apps/fleet/src/application/requests.ts`:

```ts
// Requests the fleet sends to agents and the results it waits for (spec 5.2, 5.3, 7). Each request id is
// "<connEpoch>.<n>", unique per node, and a result is matched by (node, id) and by the agent instance it was sent to:
//   - a result from the same instance is accepted, even on a newer connection of that instance (a reconnect), until
//     the request's deadline (spec 5.2: "Results arriving late from the same instance are still accepted");
//   - a result for an id that is no longer waiting, or from another instance (an older connEpoch of another agent
//     process), is dropped and never closes the connection (spec 9, contract: "an old connEpoch is ignored");
//   - a result is checked against OP_RESULTS[op] once its id is matched: one that doesn't fit is internal (executed:
//     maybe; the node said it ran), never handed on;
//   - when the connection drops, a read fails at once with node_offline (executed: no); a side-effecting op waits for
//     the same instance until its deadline, then answers uncertain (executed: maybe); another instance taking over
//     answers it uncertain at once, since the process that held it is gone;
//   - a deadline the agent never answered: timeout (executed: no) for a read, uncertain for a side-effecting op;
//   - a request over LIMITS.maxMessageBytes is refused too_large and never sent: past the agent's maxPayload it would
//     close the node's whole connection (spec 5.2).
// Every outcome carries `store` (plan Contracts, "Behaviour"): the agent's res.store on its answers; on the fleet's own
// answer to a request it sent (a deadline, a dropped connection, a result that doesn't fit), the store of the
// connection the request went out on (its hello.streamId); null for a refusal before anything was sent.
// Deadlines run on setTimeout, which is monotonic in Node.js, so a wall-clock jump never fires or delays one.
import {
  ERROR_EXECUTED, KEYED_OPS, LIMITS, OP_RESULTS, parseBody, type AgentMessage, type ErrorCode, type FleetMessage, type OpError, type OpName,
} from "@morndo/protocol";

export type Outcome = { ok: true; result: unknown; invVersion: number; store: string } | { ok: false; error: OpError; store: string | null };
export type Res = Extract<AgentMessage, { t: "res" }>;
// `store`: the stream id the connection's hello named, the agent database the request goes to.
export type Channel = { node: string; instanceId: string; id: string; store: string; send(m: FleetMessage): void };

export const opError = (code: ErrorCode, message: string): OpError => ({ code, executed: ERROR_EXECUTED[code], message });
// A refusal; `store` only when the request was sent to a node (null: nothing was sent).
export const failed = (code: ErrorCode, message: string, store: string | null = null): Outcome => ({ ok: false, error: opError(code, message), store });

// Keyed ops, and pane.keys: keystrokes have no key (they are never retried) but are a side effect all the same.
export const SIDE_EFFECT_OPS: ReadonlySet<OpName> = new Set<OpName>([...KEYED_OPS, "pane.keys"]);
// The ops that move bulk data (up to LIMITS.chunkBytes each): one at a time per connection (spec 5.2).
export const BULK_OPS: ReadonlySet<OpName> = new Set<OpName>(["transcript.read", "file.get", "file.put"]);

// How long past its own deadline the fleet still waits for the agent's answer (network and queueing slack).
export const RESULT_SLACK_MS = 1000;

type Pending = { node: string; instanceId: string; store: string; op: OpName; sideEffect: boolean; resolve(o: Outcome): void; timer: ReturnType<typeof setTimeout> };

export class Requests {
  #pending = new Map<string, Pending>();
  #isLive: (node: string, instanceId: string) => boolean;
  #slackMs: number;

  constructor(isLive: (node: string, instanceId: string) => boolean, slackMs = RESULT_SLACK_MS) {
    this.#isLive = isLive;
    this.#slackMs = slackMs;
  }

  get size() { return this.#pending.size; }

  send(ch: Channel, op: OpName, args: unknown, o: { key?: string; timeoutMs: number }): Promise<Outcome> {
    const req: FleetMessage = { v: 1, t: "req", id: ch.id, op, args, timeoutMs: o.timeoutMs, ...(o.key === undefined ? {} : { key: o.key }) };
    const size = Buffer.byteLength(JSON.stringify(req));
    if (size > LIMITS.maxMessageBytes) return Promise.resolve(failed("too_large", `${op} to ${ch.node} is ${size} bytes, over the ${LIMITS.maxMessageBytes}-byte message limit`));
    return new Promise<Outcome>(resolve => {
      const k = `${ch.node}\n${ch.id}`;
      const sideEffect = SIDE_EFFECT_OPS.has(op);
      const timer = setTimeout(() => {
        if (!this.#pending.delete(k)) return;
        if (sideEffect) resolve(failed("uncertain", `${op} on ${ch.node}: no answer before the deadline; ask op.status`, ch.store));
        else if (this.#isLive(ch.node, ch.instanceId)) resolve(failed("timeout", `${op} on ${ch.node}: no answer before the deadline`, ch.store));
        else resolve(failed("node_offline", `${op} on ${ch.node}: the node went offline`, ch.store));
      }, o.timeoutMs + this.#slackMs);
      this.#pending.set(k, { node: ch.node, instanceId: ch.instanceId, store: ch.store, op, sideEffect, resolve, timer });
      ch.send(req);
    });
  }

  // A result from `instanceId` of `node`: "accepted" when it answered a waiting request of that instance.
  result(node: string, instanceId: string, res: Res): "accepted" | "unknown" | "foreign" {
    const k = `${node}\n${res.id}`;
    const p = this.#pending.get(k);
    if (!p) return "unknown";
    if (p.instanceId !== instanceId) return "foreign";
    this.#pending.delete(k);
    clearTimeout(p.timer);
    if (!res.ok) p.resolve({ ok: false, error: res.error, store: res.store });
    else {
      const result = parseBody(OP_RESULTS[p.op], res.result);
      if (result === null) p.resolve(failed("internal", `${p.op} on ${node}: the node's result does not fit the op's shape`, res.store));
      else p.resolve({ ok: true, result, invVersion: res.invVersion, store: res.store });
    }
    return "accepted";
  }

  // The instance's connection closed and no newer one of it is live: reads fail now, side effects wait.
  connectionLost(node: string, instanceId: string): void {
    this.#settle(p => p.node === node && p.instanceId === instanceId && !p.sideEffect, p => failed("node_offline", `${p.op} on ${node}: the connection closed`, p.store));
  }

  // Another instance of `node` was admitted: whatever the old instances held can no longer be answered.
  admitted(node: string, instanceId: string): void {
    this.#settle(p => p.node === node && p.instanceId !== instanceId, p => this.#gone(p));
  }

  // The node was revoked, or the service stops: every waiting request of it (or of all nodes) ends now.
  drop(node: string | null): void {
    this.#settle(p => node === null || p.node === node, p => this.#gone(p));
  }

  #gone(p: Pending): Outcome {
    return p.sideEffect ? failed("uncertain", `${p.op} on ${p.node}: the agent went away before answering; ask op.status`, p.store)
      : failed("node_offline", `${p.op} on ${p.node}: the agent went away`, p.store);
  }

  #settle(match: (p: Pending) => boolean, outcome: (p: Pending) => Outcome): void {
    for (const [k, p] of this.#pending) {
      if (!match(p)) continue;
      this.#pending.delete(k);
      clearTimeout(p.timer);
      p.resolve(outcome(p));
    }
  }
}
```

Create `apps/fleet/src/application/connections.ts`:

```ts
// The live agent connections (spec 5.2): one per node, the instance rules, liveness and node status, and the latest
// inventory and health each node reported.
//   - The same instanceId replaces its older connection (a reconnect); its waiting requests carry over.
//   - A different instanceId while one is live: the live connection is pinged, and the newcomer waits up to
//     LIMITS.instancePongMs for its pong, without holding up any other node. No pong: the old connection is half-open
//     or its agent hung, so it is terminated and the newcomer admitted (a crash can't lock a node out). A pong: the
//     newcomer is refused (4409), with one alert per refused instance for as long as that live connection lasts, so two
//     agents with one key never flap.
//   - A different instance is accepted at once once the old connection closed or missed its pong (stale).
//   - Every admission takes the next connEpoch from fleet.db: a fencing token that only grows.
// Requests: control ops go out at once; bulk ops (transcript.read, file.get, file.put) one at a time per node, so a
// control message never waits behind more than one bulk chunk (spec 5.2). At most LIMITS.bulkQueueMax wait behind the
// one in flight (one more is `busy`, executed: no), and a waiting op's timeoutMs runs from when it was queued: it
// answers `timeout` (executed: no) if its turn doesn't come in time, and is sent with what is left of it.
// Liveness: a ping every LIMITS.pingMs; a connection that hasn't answered the previous ping is stale and terminated.
// Status: online after a welcome, stale from the first missed pong until terminated, offline once closed. The same
// sweep re-checks that each node is still registered, so a revocation made while the service runs (the console writes
// fleet.db directly) takes effect within one interval, for a node that is offline too (its lanes go: `onRevoked`).
import { LIMITS, type FleetMessage, type Health, type OpName, type Pane } from "@morndo/protocol";
import type { Audit } from "../adapters/audit.ts";
import type { Logger } from "../adapters/log.ts";
import type { NodesStore } from "../adapters/nodes-store.ts";
import type { EventHub } from "./events.ts";
import { BULK_OPS, Requests, failed, type Outcome, type Res } from "./requests.ts";

export type NodeStatus = "online" | "stale" | "offline";
export type NodeView = { name: string; status: NodeStatus; health: Health | null; agent: string | null };

// What the transport gives for one authenticated socket.
export type Peer = { send(m: FleetMessage): void; ping(): void; close(code: number, reason: string): void; terminate(): void; open(): boolean };
export type Admission = {
  node: string; instanceId: string; streamId: string; peer: Peer; source: string; agentVersion: string; claudeVersion: string | null; caps: string[];
};

type Live = Admission & {
  epoch: number; alive: boolean; stale: boolean; nextReq: number; pingAt: number | null; rttMs: number | null;
  clockAlerted: boolean; refusedAlerted: Set<string>; pongWaiters: Set<(answered: boolean) => void>;
};
type Latest = { inventory: { panes: Pane[]; invVersion: number } | null; health: Health | null };
type Queued = { op: OpName; args: unknown; o: { key?: string; timeoutMs: number }; at: number; resolve(o: Outcome): void; timer: ReturnType<typeof setTimeout> };
type BulkQueue = { running: boolean; waiting: Queued[] };

export const CLOCK_ALERT_MS = 2000;                      // spec 5.4: alert when the offset exceeds 2 s
export const REPLACED = 1000;                            // a normal close: the same instance opened a newer connection
const INSTANCE_ROUNDS = 3;                               // instance checks for one hello, if the live connection keeps changing

export class Connections {
  #live = new Map<string, Live>();
  #latest = new Map<string, Latest>();
  #nodes: NodesStore;
  #audit: Audit;
  #events: EventHub;
  #log: Logger;
  #now: () => number;
  #mono: () => number;
  #pingMs: number;
  #instancePongMs: number;
  #onRevoked: (node: string) => void;
  #revocations = new Map<string, number>();             // node → the revokedAt already acted on
  #sweep: ReturnType<typeof setInterval> | null = null;
  #bulk = new Map<string, BulkQueue>();
  readonly requests: Requests;

  constructor(p: {
    nodes: NodesStore; audit: Audit; events: EventHub; log: Logger; now?: () => number; mono?: () => number; pingMs?: number;
    resultSlackMs?: number; instancePongMs?: number; onRevoked?: (node: string) => void;
  }) {
    this.#nodes = p.nodes;
    this.#audit = p.audit;
    this.#events = p.events;
    this.#log = p.log;
    this.#now = p.now ?? Date.now;
    this.#mono = p.mono ?? (() => performance.now());
    this.#pingMs = p.pingMs ?? LIMITS.pingMs;
    this.#instancePongMs = p.instancePongMs ?? LIMITS.instancePongMs;
    this.#onRevoked = p.onRevoked ?? (() => {});
    for (const n of this.#nodes.list()) if (n.revokedAt !== null) this.#revocations.set(n.name, n.revokedAt);   // done at start
    this.requests = new Requests((node, instanceId) => this.#live.get(node)?.instanceId === instanceId, p.resultSlackMs);
  }

  start(): void {
    this.#sweep ??= setInterval(() => this.sweep(), this.#pingMs);
  }

  stop(): void {
    if (this.#sweep) clearInterval(this.#sweep);
    this.#sweep = null;
    for (const c of this.#live.values()) { c.peer.close(1001, "fleet service stopping"); this.#answered(c, false); }
    this.#live.clear();
    for (const [node, q] of this.#bulk) for (const w of q.waiting.splice(0)) { clearTimeout(w.timer); w.resolve(failed("node_offline", `${w.op} on ${node}: the fleet service is stopping`)); }
    this.requests.drop(null);
  }

  // Applies the instance rules. On admission `welcome(epoch)` runs before anyone hears the node is online, so the
  // welcome is the first message on the new connection. Waits (at most instancePongMs per round) only when another
  // instance's connection is live and has to show that it still answers.
  async admit(a: Admission, welcome: (epoch: number) => void): Promise<{ ok: true; epoch: number } | { ok: false }> {
    for (let round = 0; round < INSTANCE_ROUNDS; round++) {
      const cur = this.#live.get(a.node);
      if (!cur || cur.instanceId === a.instanceId || cur.stale) return this.#admitNow(a, welcome);
      const answered = await this.#check(cur);
      if (!a.peer.open()) return { ok: false };           // the newcomer went away while it waited
      if (this.#live.get(a.node) !== cur) continue;        // the live one closed or was replaced meanwhile: look again
      if (!answered) {
        this.#log.warn(`node ${a.node}: instance ${cur.instanceId.slice(0, 8)} missed the instance check; ${a.instanceId.slice(0, 8)} takes over`);
        this.#audit.record("fleet", "conn.replaced", a.node, { old: cur.instanceId, new: a.instanceId, source: a.source });
        this.#live.delete(a.node);                         // its close is then not taken for the node going offline
        cur.peer.terminate();
        continue;
      }
      if (!cur.refusedAlerted.has(a.instanceId)) {
        cur.refusedAlerted.add(a.instanceId);
        this.#audit.alert("instance_conflict", a.node, { live: cur.instanceId, refused: a.instanceId, source: a.source });
      }
      return { ok: false };
    }
    return { ok: false };
  }

  // Pings a live connection outside the sweep: true when it answers within instancePongMs, false when it doesn't or
  // closes first.
  #check(c: Live): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      const done = (answered: boolean) => { clearTimeout(timer); c.pongWaiters.delete(done); resolve(answered); };
      const timer = setTimeout(() => done(false), this.#instancePongMs);
      c.pongWaiters.add(done);
      c.peer.ping();
    });
  }

  #answered(c: Live, answered: boolean): void { for (const w of [...c.pongWaiters]) w(answered); }

  #admitNow(a: Admission, welcome: (epoch: number) => void): { ok: true; epoch: number } | { ok: false } {
    if (!a.peer.open()) return { ok: false };
    const cur = this.#live.get(a.node);
    if (cur) {
      this.#live.delete(a.node);                         // its close is then not taken for the node going offline
      this.#answered(cur, false);
      if (cur.instanceId === a.instanceId) cur.peer.close(REPLACED, "replaced by a newer connection of this instance");
      else cur.peer.terminate();
    }
    this.requests.admitted(a.node, a.instanceId);
    const epoch = this.#nodes.nextEpoch(a.node);
    const previous = this.#nodes.recordSource(a.node, a.source);
    if (previous !== null) this.#audit.alert("source_changed", a.node, { from: previous, to: a.source });
    this.#nodes.seen(a.node, a.agentVersion);
    this.#audit.record("agent", "conn.admitted", a.node, { instanceId: a.instanceId, epoch, source: a.source });
    this.#live.set(a.node, {
      ...a, epoch, alive: true, stale: false, nextReq: 0, pingAt: null, rttMs: null, clockAlerted: false, refusedAlerted: new Set(), pongWaiters: new Set(),
    });
    welcome(epoch);
    this.#log.info(`node ${a.node} online (instance ${a.instanceId.slice(0, 8)}, epoch ${epoch})`);
    this.#status(a.node, "online");
    return { ok: true, epoch };
  }

  closed(node: string, peer: Peer): void {
    const c = this.#live.get(node);
    if (!c || c.peer !== peer) return;                   // a replaced or refused connection
    this.#live.delete(node);
    this.#answered(c, false);
    this.requests.connectionLost(node, c.instanceId);
    this.#log.info(`node ${node} offline`);
    this.#status(node, "offline");
  }

  pong(node: string, peer: Peer): void {
    const c = this.#live.get(node);
    if (!c || c.peer !== peer) return;
    c.alive = true;
    if (c.pingAt !== null) { c.rttMs = this.#mono() - c.pingAt; c.pingAt = null; }   // the sweep's ping, once
    this.#answered(c, true);
  }

  sweep(): void {
    for (const [node, c] of [...this.#live]) {
      if (!this.#nodes.active(node)) { this.revoke(node); continue; }
      if (!c.alive) {
        c.stale = true;
        this.#status(node, "stale");
        c.peer.terminate();                              // its close follows and marks the node offline
        continue;
      }
      c.alive = false;
      c.pingAt = this.#mono();
      c.peer.ping();
      this.#nodes.seen(node);
    }
    // Revocations written to fleet.db while the service runs, of nodes that aren't connected (the console's `node
    // revoke` when the service didn't answer it): their lanes and latest reports go too.
    for (const n of this.#nodes.list()) if (n.revokedAt !== null && this.#revocations.get(n.name) !== n.revokedAt) this.revoke(n.name);
  }

  // A revoked node: its connection closes (4403), its waiting requests end, and what is known of it goes (its latest
  // inventory and health here, its lanes through onRevoked).
  revoke(node: string): void {
    const row = this.#nodes.node(node);
    if (row?.revokedAt !== null && row?.revokedAt !== undefined) this.#revocations.set(node, row.revokedAt);
    const c = this.#live.get(node);
    this.requests.drop(node);
    if (c) {
      this.#live.delete(node);
      this.#answered(c, false);
      c.peer.close(4403, "revoked");
      this.#status(node, "offline");
    }
    this.forget(node);
    this.#onRevoked(node);
  }

  status(node: string): NodeStatus {
    const c = this.#live.get(node);
    return !c ? "offline" : c.stale ? "stale" : "online";
  }

  request(node: string, op: OpName, args: unknown, o: { key?: string; timeoutMs: number }): Promise<Outcome> {
    if (!BULK_OPS.has(op)) return this.#send(node, op, args, o);
    const q = this.#bulk.get(node) ?? { running: false, waiting: [] };
    this.#bulk.set(node, q);
    if (!q.running) {
      q.running = true;
      return this.#runBulk(node, q, this.#send(node, op, args, o));
    }
    if (q.waiting.length >= LIMITS.bulkQueueMax) {
      return Promise.resolve(failed("busy", `${op} on ${node}: ${q.waiting.length} bulk transfers already wait for this node; not sent`));
    }
    return new Promise<Outcome>(resolve => {
      const w: Queued = {
        op, args, o, at: this.#mono(), resolve,
        timer: setTimeout(() => {
          const i = q.waiting.indexOf(w);
          if (i === -1) return;
          q.waiting.splice(i, 1);
          resolve(failed("timeout", `${op} on ${node}: its turn didn't come within ${o.timeoutMs} ms; not sent`));
        }, o.timeoutMs),
      };
      q.waiting.push(w);
    });
  }

  // When the bulk op in flight ends, the next one waiting goes, with what is left of its own timeout.
  #runBulk(node: string, q: BulkQueue, run: Promise<Outcome>): Promise<Outcome> {
    void run.finally(() => {
      for (let w = q.waiting.shift(); w !== undefined; w = q.waiting.shift()) {
        clearTimeout(w.timer);
        const left = Math.floor(w.o.timeoutMs - (this.#mono() - w.at));
        if (left <= LIMITS.deadlineMarginMs) { w.resolve(failed("timeout", `${w.op} on ${node}: too little of its ${w.o.timeoutMs} ms left when its turn came; not sent`)); continue; }
        const next = this.#send(node, w.op, w.args, { ...w.o, timeoutMs: left });
        void next.then(o => w.resolve(o));
        void this.#runBulk(node, q, next);
        return;
      }
      q.running = false;
      if (this.#bulk.get(node) === q) this.#bulk.delete(node);
    });
    return run;
  }

  #send(node: string, op: OpName, args: unknown, o: { key?: string; timeoutMs: number }): Promise<Outcome> {
    const c = this.#live.get(node);
    if (!c || c.stale) return Promise.resolve(failed("node_offline", `node ${node} is ${this.status(node)}`));
    const ch = { node, instanceId: c.instanceId, store: c.streamId, id: `${c.epoch}.${++c.nextReq}`, send: (m: FleetMessage) => c.peer.send(m) };
    return this.requests.send(ch, op, args, o);
  }

  result(node: string, instanceId: string, res: Res): void {
    const r = this.requests.result(node, instanceId, res);
    if (r === "unknown") this.#log.debug(`node ${node}: a result for ${res.id}, which no longer waits; dropped`);
    if (r === "foreign") this.#log.warn(`node ${node}: a result for ${res.id} from another instance; dropped`);
  }

  inventory(node: string, panes: Pane[], invVersion: number): void {
    this.#latestOf(node).inventory = { panes, invVersion };
    this.#events.emit({ t: "inventory", node, body: { panes, invVersion } });
  }

  // Stores the latest health and compares the node's clock with ours, allowing for the last ping's round trip.
  health(node: string, h: Health): void {
    this.#latestOf(node).health = h;
    this.#events.emit({ t: "health", node, body: h });
    const c = this.#live.get(node);
    if (!c) return;
    const offsetMs = h.wallClock - this.#now();
    const off = Math.abs(offsetMs) > CLOCK_ALERT_MS + (c.rttMs ?? 0);
    if (off && !c.clockAlerted) this.#audit.alert("clock_offset", node, { offsetMs: Math.round(offsetMs) });
    c.clockAlerted = off;
  }

  latest(node: string): Latest {
    return this.#latest.get(node) ?? { inventory: null, health: null };
  }

  // Every registered (not revoked) node, with its status, latest health and agent version.
  list(): NodeView[] {
    return this.#nodes.list().filter(n => n.revokedAt === null).map(n => ({
      name: n.name, status: this.status(n.name), health: this.latest(n.name).health, agent: this.#live.get(n.name)?.agentVersion ?? n.agentVersion,
    }));
  }

  // The live instance of a node, for tests and status: null when offline.
  liveInstance(node: string): { instanceId: string; epoch: number } | null {
    const c = this.#live.get(node);
    return c ? { instanceId: c.instanceId, epoch: c.epoch } : null;
  }

  forget(node: string): void { this.#latest.delete(node); }

  #latestOf(node: string): Latest {
    let l = this.#latest.get(node);
    if (!l) { l = { inventory: null, health: null }; this.#latest.set(node, l); }
    return l;
  }

  #status(node: string, status: NodeStatus): void {
    this.#events.emit({ t: "status", node, body: { status } });
  }
}
```

- [ ] **Step 15: Implement the agent session and endpoint**

Create `apps/fleet/src/adapters/agent-session.ts`:

```ts
// One agent's WebSocket, from its first message to its close (spec 5.1, 5.2, 5.4):
//   join  → the code is redeemed for the node the join names (constant-time hash compare, bound to the name it was
//           issued for, single use) → welcome (placeholder values) → close 1000
//   hello → challenge { nonce, fleetSig over fleetSigPayload(node, clientNonce) } → proof (checked against the stored
//           key) → the instance rules (which may wait for another instance's pong) → welcome { connEpoch, ackSeq,
//           streamKnown } → live
// A join or a hello first takes a token from its source address's bucket (LIMITS.handshakeBurst at once, one more every
// LIMITS.handshakeRefillMs), before any key work: no code is hashed and nothing is signed for a source over it.
// Close codes: 4401 bad proof, 4403 unknown, revoked or refused join (a code unknown, expired, used or issued for
// another name), 4409 another instance is live, 4426 no protocol version in common; 1003 a message that isn't one of
// ours or is binary; 1008 a message out of order, a handshake not finished in time, an event for another node or
// stream, or too many messages; 1009 a message over 512 KiB (ws itself closes 1009 over maxPayload, 1 MiB); 1013 too
// many joins or hellos from that address. Every admission (in Connections) and every refused hello is audited with
// its source address; a refused join is audited as before; a source over its bucket is only logged, so no one outside
// can fill the audit or the alerts.
// Once live: results go to the requests, inventory and health to the connection registry (rate limited per node),
// hook events to the hook sink in batches, acknowledged after their commit. Hook events are exempt from the rate
// limit: the agent's replay window paces them (spec 5.4).
import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import {
  AgentMessage, CLOSE, FLEET_PROTO, LIMITS, fleetSigPayload, nodeSigPayload, parseBody,
  type FleetMessage, type HookEvent,
} from "@morndo/protocol";
import type { Connections, Peer } from "../application/connections.ts";
import type { HookSink } from "../application/hook-sink.ts";
import type { Audit } from "./audit.ts";
import type { FleetKey } from "./keys.ts";
import { verifySig } from "./keys.ts";
import type { Logger } from "./log.ts";
import type { NodesStore } from "./nodes-store.ts";
import type { RateLimiter } from "./rate-limit.ts";

export type SessionDeps = {
  connections: Connections; nodes: NodesStore; audit: Audit; fleetKey: FleetKey; hooks: HookSink | null; log: Logger;
  limiter: RateLimiter; handshakes: { take(source: string): boolean }; handshakeMs: number; source: string;
};

type Hello = Extract<AgentMessage, { t: "hello" }>;
type State =
  | { kind: "new" }
  | { kind: "challenged"; hello: Hello; nonce: string }
  | { kind: "admitting" }
  | { kind: "live"; node: string; instanceId: string; streamId: string }
  | { kind: "done" };

// The protocol versions this fleet speaks: the current one and the one before (spec 5, ADR-0012 decision 10).
export const ACCEPTED_PROTO = [FLEET_PROTO - 1, FLEET_PROTO].filter(v => v >= 1);
const speaks = (proto: number[]) => proto.some(v => ACCEPTED_PROTO.includes(v));
export const HANDSHAKE_MS = 10_000;

export function runSession(ws: WebSocket, d: SessionDeps): void {
  let state: State = { kind: "new" };
  let batch: HookEvent[] = [];
  let flushQueued = false;
  let closing = false;                                   // closed by us: later messages are ignored
  const send = (m: FleetMessage) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };
  const close = (code: number, reason: string) => { closing = true; ws.close(code, reason); };
  const peer: Peer = {
    send, ping: () => ws.ping(), close: (code, reason) => ws.close(code, reason), terminate: () => ws.terminate(), open: () => ws.readyState === ws.OPEN,
  };
  const refused = (node: string | null, reason: string, extra: Record<string, unknown> = {}) =>
    d.audit.record("agent", "conn.refused", node, { reason, source: d.source, ...extra });
  const tooMany = () => close(1013, "too many joins or hellos from this address; try again later");
  const handshake = setTimeout(() => { if (state.kind !== "live") close(1008, "handshake timeout"); }, d.handshakeMs);

  // Stores the batch (one transaction), then acknowledges the highest accepted seq if the connection is still ours.
  const flush = () => {
    flushQueued = false;
    if (state.kind !== "live" && state.kind !== "done") return;
    const events = batch;
    batch = [];
    if (events.length === 0 || !d.hooks) return;
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

  function onMessage(raw: Buffer, isBinary: boolean) {
    if (closing || state.kind === "done") return;
    if (isBinary) return close(1003, "text frames only");
    if (raw.length > LIMITS.maxMessageBytes) return close(1009, "message too big");
    let value: unknown;
    try { value = JSON.parse(raw.toString("utf8")); } catch { return close(1003, "bad message"); }
    const m = parseBody(AgentMessage, value);
    if (m === null) return close(1003, "bad message");
    switch (m.t) {
      case "join": {
        if (state.kind !== "new") return close(1008, "unexpected join");
        if (!d.handshakes.take(d.source)) return tooMany();
        if (!speaks(m.proto)) {
          d.audit.record("agent", "join.refused", null, { reason: "unsupported", node: m.node, source: d.source });
          return close(CLOSE.unsupported, "unsupported protocol");
        }
        const r = d.nodes.redeem(m.code, m.node, m.publicKey);
        if (!r.ok) {
          d.audit.record("agent", "join.refused", null, { reason: r.refused, node: m.node, source: d.source });
          return close(CLOSE.forbidden, "join refused");
        }
        d.audit.record("agent", "node.joined", r.node, { source: d.source, agent: m.agent.version });
        // Placeholder values (connEpoch is at least 1 on the wire): the agent reads only that it was welcomed.
        send({ v: 1, t: "welcome", connEpoch: 1, ackSeq: 0, streamKnown: false });
        return close(1000, "joined");
      }
      case "hello": {
        if (state.kind !== "new") return close(1008, "unexpected hello");
        if (!d.handshakes.take(d.source)) return tooMany();
        if (!speaks(m.proto)) { refused(m.node, "unsupported", { proto: m.proto }); return close(CLOSE.unsupported, "unsupported protocol"); }
        if (!d.nodes.active(m.node)) { refused(m.node, "unknown_node"); return close(CLOSE.forbidden, "unknown or revoked node"); }
        const nonce = randomBytes(32).toString("base64url");
        state = { kind: "challenged", hello: m, nonce };
        return send({ v: 1, t: "challenge", nonce, fleetSig: d.fleetKey.sign(fleetSigPayload(m.node, m.clientNonce)) });
      }
      case "proof": {
        if (state.kind !== "challenged") return close(1008, "unexpected proof");
        const { hello, nonce } = state;
        const row = d.nodes.active(hello.node);
        if (!row) { refused(hello.node, "unknown_node"); return close(CLOSE.forbidden, "unknown or revoked node"); }
        if (!verifySig(row.publicKey, nodeSigPayload(hello.node, nonce), m.sig)) {
          d.audit.record("agent", "auth.bad_proof", hello.node, { source: d.source });
          return close(CLOSE.badProof, "bad proof");
        }
        // The instance rules may wait for another instance's pong; until the answer, anything the agent sends is out of
        // order (it waits for its welcome).
        state = { kind: "admitting" };
        d.connections.admit({
          node: hello.node, instanceId: hello.instanceId, streamId: hello.streamId, peer, source: d.source, agentVersion: hello.agent.version,
          claudeVersion: hello.claude.version, caps: hello.caps,
        }, epoch => {
          clearTimeout(handshake);
          state = { kind: "live", node: hello.node, instanceId: hello.instanceId, streamId: hello.streamId };
          const mark = d.hooks?.known(hello.node, hello.streamId) ?? { seq: 0, known: false };
          send({ v: 1, t: "welcome", connEpoch: epoch, ackSeq: mark.seq, streamKnown: mark.known });
        }).then(admitted => {
          if (admitted.ok || closing || state.kind === "done") return;
          refused(hello.node, "instance_conflict", { instanceId: hello.instanceId });
          close(CLOSE.conflict, "another instance of this node is connected");
        }, (e: unknown) => {
          d.log.error(`node ${hello.node}: admitting a connection failed`, e);
          close(1011, "internal error");
        });
        return;
      }
      case "res":
        if (state.kind !== "live") return close(1008, "unexpected result");
        return d.connections.result(state.node, state.instanceId, m);
      case "ev.hook": {
        if (state.kind !== "live") return close(1008, "unexpected event");
        if (m.event.node !== state.node || m.event.streamId !== state.streamId) return close(1008, "an event for another node or stream");
        batch.push(m.event);
        if (!flushQueued) { flushQueued = true; setImmediate(flush); }
        return;
      }
      case "ev.inventory":
        if (state.kind !== "live") return close(1008, "unexpected event");
        if (!d.limiter.take(state.node)) return rateLimited(state.node);
        return d.connections.inventory(state.node, m.panes, m.invVersion);
      case "ev.health":
        if (state.kind !== "live") return close(1008, "unexpected event");
        if (!d.limiter.take(state.node)) return rateLimited(state.node);
        return d.connections.health(state.node, m.health);
    }
  }

  const rateLimited = (node: string) => {
    d.audit.alert("rate_limited", node, {});
    close(1008, "too many messages");
  };

  ws.on("message", (raw, isBinary) => {
    const bytes = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
    try { onMessage(bytes, isBinary); }
    catch (e) { d.log.error("agent socket: a message failed, closing", e); close(1011, "internal error"); }
  });
  ws.on("pong", () => { if (state.kind === "live") d.connections.pong(state.node, peer); });
  ws.on("error", e => d.log.warn(`agent socket: ${e.message}`));     // ws closes the socket itself; never the payload
  ws.on("close", () => {
    clearTimeout(handshake);
    const live = state.kind === "live" ? state : null;
    state = { kind: "done" };
    flush();                                                          // events received are stored, unacknowledged
    if (live) d.connections.closed(live.node, peer);
  });
}
```

Create `apps/fleet/src/adapters/agent-endpoint.ts`:

```ts
// The agent endpoint, ws://<listen>/agent (spec 5): an HTTP server that takes only WebSocket upgrades on /agent.
// `ws` in noServer mode with the upgrade handled here, and maxPayload of LIMITS.maxPayload on every connection
// (https://github.com/websockets/ws/blob/master/doc/ws.md, read 2026-10-06). Authentication happens inside the
// connection (agent-session.ts), since a node proves its key by signing the fleet's challenge.
// Where a node connects from: the TCP peer, or, when the peer is this machine (Tailscale Serve proxies the tailnet to
// localhost), the X-Forwarded-For that Serve sets to the tailnet source address with Header.Set
// (tailscale/tailscale ipn/ipnlocal/serve.go, addProxyForwardedHeaders, read 2026-10-06).
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { LIMITS } from "@morndo/protocol";
import { RateLimiter, type BucketConfig } from "./rate-limit.ts";
import { HANDSHAKE_MS, runSession, type SessionDeps } from "./agent-session.ts";

// Per node, for inventory and health (hook events and results are exempt): inventory comes at most every 2 s and
// health every 30 s, so 60 at once and 2 a second leave room for a reconnect's full inventory and any burst.
export const AGENT_MESSAGES: BucketConfig = { capacity: 60, refillPerSecond: 2 };
// Per source address, joins and hellos together, before any key work (plan Contracts, "Instances"): an agent dials at
// most every second after a failure, backing off to a minute, so 10 at once and one more every 6 s never refuse one.
export const HANDSHAKES: BucketConfig = { capacity: LIMITS.handshakeBurst, refillPerSecond: 1000 / LIMITS.handshakeRefillMs };

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function sourceOf(req: Pick<IncomingMessage, "headers"> & { socket: { remoteAddress?: string | undefined } }): string {
  const peer = req.socket.remoteAddress ?? "unknown";
  const forwarded = req.headers["x-forwarded-for"];
  if (LOOPBACK.has(peer) && typeof forwarded === "string" && forwarded.trim() !== "") return forwarded.split(",")[0]?.trim() ?? peer;
  return peer;
}

export type AgentEndpoint = { ready: Promise<void>; port(): number; close(): Promise<void> };

export function startAgentEndpoint(p: {
  host: string; port: number; deps: Omit<SessionDeps, "limiter" | "handshakes" | "handshakeMs" | "source">; limits?: BucketConfig;
  handshakeLimits?: BucketConfig; handshakeMs?: number;
}): AgentEndpoint {
  const limiter = new RateLimiter(p.limits ?? AGENT_MESSAGES);
  const bucket = new RateLimiter(p.handshakeLimits ?? HANDSHAKES);
  const warned = new Set<string>();                      // sources told about once, until their bucket lets one through
  const handshakes = {
    take: (source: string) => {
      if (bucket.take(source)) { warned.delete(source); return true; }
      if (!warned.has(source)) { warned.add(source); p.deps.log.warn(`agent endpoint: too many joins or hellos from ${source}; closing them with 1013`); }
      return false;
    },
  };
  const server = createServer((_req, res) => {
    res.writeHead(426, { "content-type": "text/plain; charset=utf-8", upgrade: "websocket" });
    res.end("the agent endpoint takes WebSocket connections at /agent\n");
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxPayload });
  const sockets = new Set<WebSocket>();

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    let path: string;
    try { path = new URL(req.url ?? "/", "http://fleet").pathname; } catch { path = ""; }
    if (path !== "/agent") { socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
    const source = sourceOf(req);
    wss.handleUpgrade(req, socket, head, ws => {
      sockets.add(ws);
      ws.on("close", () => sockets.delete(ws));
      runSession(ws, { ...p.deps, limiter, handshakes, handshakeMs: p.handshakeMs ?? HANDSHAKE_MS, source });
    });
  });

  const ready = new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", reject);
  });
  server.listen(p.port, p.host);
  return {
    ready,
    port: () => (server.address() as AddressInfo).port,
    close: () => new Promise<void>(resolve => {
      for (const ws of sockets) ws.terminate();
      wss.close();
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}
```

- [ ] **Step 16: Wire the service, and add the `serve` command**

Create `apps/fleet/src/serve.ts`:

```ts
// The fleet service, wired (ADR-0012): its key, fleet.db, the node registry, the audit, the live connections and the
// agent endpoint. `morndo-fleet serve` runs it; tests start it on port 0 with temporary paths. Every alert the audit
// records is also an `alert` event. Audit rows older than 90 days go on start and daily.
import type Database from "better-sqlite3";
import type { FleetConfig } from "./config.ts";
import { Audit } from "./adapters/audit.ts";
import { openFleetDb } from "./adapters/db.ts";
import { loadOrCreateFleetKey, type FleetKey } from "./adapters/keys.ts";
import { log as defaultLog, type Logger } from "./adapters/log.ts";
import { NodesStore } from "./adapters/nodes-store.ts";
import type { BucketConfig } from "./adapters/rate-limit.ts";
import { startAgentEndpoint } from "./adapters/agent-endpoint.ts";
import { Connections } from "./application/connections.ts";
import { EventHub } from "./application/events.ts";

export const AUDIT_PRUNE_EVERY_MS = 86_400_000;

export type FleetOptions = {
  log?: Logger; now?: () => number; pingMs?: number; agentLimits?: BucketConfig; handshakeLimits?: BucketConfig; handshakeMs?: number;
  resultSlackMs?: number; instancePongMs?: number;
};

export type Fleet = {
  config: FleetConfig; db: Database.Database; key: FleetKey; nodes: NodesStore; audit: Audit; events: EventHub;
  connections: Connections; agentPort: number; close(): Promise<void>;
};

export async function startFleet(config: FleetConfig, o: FleetOptions = {}): Promise<Fleet> {
  const log = o.log ?? defaultLog;
  const now = o.now ?? Date.now;
  const key = loadOrCreateFleetKey(config.keyPath);
  const db = openFleetDb(config.dbPath);
  const nodes = new NodesStore(db, now);
  const events = new EventHub(e => log.error("an event subscriber failed", e));
  const audit = new Audit(db, { now, log, onAlert: a => events.emit({ t: "alert", node: a.node ?? "", body: a }) });
  const pruneAudit = () => { const n = audit.prune(); if (n > 0) log.info(`audit: removed ${n} rows older than 90 days`); };
  pruneAudit();
  const connections = new Connections({
    nodes, audit, events, log, now, ...(o.pingMs === undefined ? {} : { pingMs: o.pingMs }),
    ...(o.resultSlackMs === undefined ? {} : { resultSlackMs: o.resultSlackMs }), ...(o.instancePongMs === undefined ? {} : { instancePongMs: o.instancePongMs }),
  });
  const agents = startAgentEndpoint({
    host: config.listen.host, port: config.listen.port, deps: { connections, nodes, audit, fleetKey: key, hooks: null, log },
    ...(o.agentLimits ? { limits: o.agentLimits } : {}), ...(o.handshakeLimits ? { handshakeLimits: o.handshakeLimits } : {}),
    ...(o.handshakeMs === undefined ? {} : { handshakeMs: o.handshakeMs }),
  });
  try { await agents.ready; }
  catch (e) { db.close(); throw e; }
  connections.start();
  const retention = setInterval(pruneAudit, AUDIT_PRUNE_EVERY_MS);
  return {
    config, db, key, nodes, audit, events, connections, agentPort: agents.port(),
    close: async () => {
      clearInterval(retention);
      connections.stop();
      await agents.close();
      db.close();
    },
  };
}
```

In `apps/fleet/src/main.ts`, replace:

```ts
import { socketRequest } from "./adapters/socket-request.ts";
```

with:

```ts
import { socketRequest } from "./adapters/socket-request.ts";
import { exitOnCrash } from "./adapters/crash.ts";
import { log } from "./adapters/log.ts";
import { startFleet } from "./serve.ts";
```

In `apps/fleet/src/main.ts`, replace:

```ts
  morndo-fleet node add <name>      a one-time join string
```

with:

```ts
  morndo-fleet serve                run the service: agents on 127.0.0.1:8791/agent, clients on the socket
  morndo-fleet node add <name>      a one-time join string
```

In `apps/fleet/src/main.ts`, replace:

```ts
if (cmd === "node" && sub === "add") {
```

with:

```ts
if (cmd === "serve") {
  exitOnCrash(log);
  const cfg = config();
  const fleet = await startFleet(cfg).catch((e: unknown) => {
    if (e instanceof DatabaseFromFuture) return fail(`${cfg.dbPath} was written by a newer morndo-fleet (schema version ${e.found}); this one knows migrations only up to ${e.known}.`, EXIT_CONFIG);
    if (e instanceof KeyFileUnsafe) return fail(e.message, EXIT_CONFIG);
    throw e;
  });
  log.info(`morndo-fleet: agents on ws://${cfg.listen.host}:${fleet.agentPort}/agent`);
  const stop = async () => { await fleet.close(); process.exit(0); };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
} else if (cmd === "node" && sub === "add") {
```

- [ ] **Step 17: Run the endpoint tests and see them pass**

Run: `npx vitest run apps/fleet/test/requests.test.ts apps/fleet/test/agent-auth.test.ts apps/fleet/test/instances.test.ts apps/fleet/test/liveness.test.ts apps/fleet/test/serve.test.ts`
Expected: PASS (41 tests). The flap test runs 5 fake minutes, with 20 sweep pings and 30 refused reconnects (each answered instance check is a pong too), in about 2 s; the half-open test waits its real 3 s.

Then check that each new rule bites, each change restored before the next (`npx vitest run` on the file named):
- The instance check: in `connections.ts`, change `      const answered = await this.#check(cur);` to `      const answered = true;`. Expected: 3 failures in `instances.test.ts`, "an old connection that misses the instance check's ping (half-open)…" among them, with `expected { ok: false, closed: { code: 4409, … } } to match object { ok: true, … }`.
- The handshake bucket: in `agent-session.ts`, delete the line `        if (!d.handshakes.take(d.source)) return tooMany();` in `case "hello"`. Expected: 1 failure in `agent-auth.test.ts`, "joins and hellos from one address past its bucket…" (`hello 11: expected 4403 to be 1013`).
- The 512 KiB limit: in `agent-session.ts`, delete the line `    if (raw.length > LIMITS.maxMessageBytes) return close(1009, "message too big");`. Expected: 1 failure in `agent-auth.test.ts` (`expected 1003 to be 1009`).
- A waiting bulk op's own deadline: in `connections.ts`, change `        }, o.timeoutMs),` to `        }, o.timeoutMs + 600_000),`. Expected: 1 failure in `requests.test.ts`, "a waiting bulk op's deadline counts from when it was queued…" (it waits for the hung transfer). Then change `        const left = Math.floor(w.o.timeoutMs - (this.#mono() - w.at));` to `        const left = w.o.timeoutMs;`: 1 failure, "a slow node that answers…" (each one sent with the full 5000 ms).
- The queue's cap: in `connections.ts`, change `    if (q.waiting.length >= LIMITS.bulkQueueMax) {` to `    if (q.waiting.length >= Infinity) {`. Expected: 1 failure, "at most 8 bulk ops wait per node…".
- The store: in `requests.ts`, change `invVersion: res.invVersion, store: res.store });` to `invVersion: res.invVersion, store: p.store });`. Expected: 1 failure, "every answer carries its store…".
- The audit of admissions: in `connections.ts`, delete the line `    this.#audit.record("agent", "conn.admitted", …);`. Expected: 1 failure in `agent-auth.test.ts`.
- Retention on start: in `serve.ts`, delete the line `  pruneAudit();`. Expected: 1 failure in `liveness.test.ts`, "rows older than 90 days go when the service starts, and once a day while it runs".

- [ ] **Step 18: Run the whole fleet suite, the types and the lint**

Run each in turn, from the repository root:
- `npx tsc -p apps/fleet`. Expected: no output, exit 0.
- `npx tsc -p tsconfig.tests.json`. Expected: no output, exit 0.
- `npx oxlint apps/fleet`. Expected: no output, exit 0.
- `npx vitest run apps/fleet/test`. Expected: PASS (78 tests in 14 files).

- [ ] **Step 19: Commit**

```bash
git add apps/fleet/src/application/hook-sink.ts apps/fleet/src/application/requests.ts apps/fleet/src/application/connections.ts apps/fleet/src/adapters/agent-session.ts apps/fleet/src/adapters/agent-endpoint.ts apps/fleet/src/serve.ts apps/fleet/src/main.ts apps/fleet/test/helpers/fake-agent.ts apps/fleet/test/helpers/fleet.ts apps/fleet/test/helpers/until.ts apps/fleet/test/requests.test.ts apps/fleet/test/agent-auth.test.ts apps/fleet/test/instances.test.ts apps/fleet/test/liveness.test.ts apps/fleet/test/serve.test.ts
git commit -m "feat(fleet): agent endpoint with join, mutual auth, instance rules and liveness"
```

### Task 12: Router, lane registry and the client API on the Unix socket

**Files:**
- Create: `apps/fleet/src/adapters/socket-dir.ts`, `apps/fleet/src/adapters/lanes-store.ts`, `apps/fleet/src/adapters/op-body.ts`,
  `apps/fleet/src/adapters/files-route.ts`, `apps/fleet/src/adapters/client-api.ts`
- Create: `apps/fleet/src/application/lane-registry.ts`, `apps/fleet/src/application/router.ts`
- Modify: `apps/fleet/src/serve.ts` (whole file), `apps/fleet/src/main.ts` (exit 78 for an unsafe or busy socket)
- Test: `apps/fleet/test/helpers/socket-client.ts`, `apps/fleet/test/helpers/odd-names.ts`, `apps/fleet/test/socket-dir.test.ts`,
  `apps/fleet/test/lane-registry.test.ts`, `apps/fleet/test/router.test.ts`, `apps/fleet/test/client-api.test.ts`

**Interfaces:**
- Consumes:
  - **Task 1:** `CLIENT_API`, `LIMITS`, `KEYED_OPS`, `NODE_NAME`, `parseWorkerId(id): WorkerRef | null`, and the types
    `OpName`, `Pane`, `ErrorCode`, `OpError`, `Alert` (the `lane_conflict` error code included).
  - **Task 10:** `Audit` (`alert`, `recentAlerts`).
  - **Task 11:** `Connections` (`request`, `list`, `latest`, `revoke`, `forget`, `status`, the `onRevoked` option),
    `EventHub`, `FleetEvent`, `failed`, `opError`, `Outcome`, `SIDE_EFFECT_OPS`, `startFleet`, and the test helpers.
- Produces:
  - `adapters/socket-dir.ts`:
    - `prepareSocketDir(socketPath, uid?): void`, `clearStaleSocket(socketPath): Promise<void>`
    - `class SocketDirUnsafe`, `class SocketInUse`
  - `application/lane-registry.ts`:
    - `type Lane = { name: string; node: string; workerId: string | null; conflict: boolean }`
    - `type Resolved = { kind: "ok"; node; workerId } | { kind: "none" } | { kind: "conflict"; claims: { node; workerId }[] }`
    - `class LaneRegistry`:
      - `constructor({ store, events, audit, activeNodes, now? })`
      - `inventory(node, panes)`, `dropNode(node)`
      - `list(): Lane[]`, `get(name): Lane | null`, `resolve(name): Resolved`
  - `application/router.ts`:
    - `type Target = { workerId: string } | { node: string } | { lane: string }`
    - `type OpOptions = { key?: string; timeoutMs?: number; client?: string }`; an expectation travels in `args.expect`
    - `class Router { constructor({ connections, lanes, audit?, mono? }); op(target, op, args: Record<string, unknown>, o?: OpOptions): Promise<Outcome> }`.
      A lane in conflict is `lane_conflict` for every route by its name, while a worker ID is routed whatever its
      name; `lane.start` of a name the registry holds, or whose start is in flight, is `name_taken`. Every
      side-effecting op is audited (`op.<name>`).
    - `DEFAULT_TIMEOUT_MS = 15000`, `MAX_TIMEOUT_MS = 120000`, `RESERVE_AFTER_START_MS = 10000`
  - `adapters/client-api.ts`: `startClientApi(socketPath, deps): Promise<{ close(): Promise<void> }>` (`deps` takes
    `eventsBufferBytes?`, default `LIMITS.eventsBufferBytes`) and `API_VERSIONS: number[]`. The routes and wire shapes
    are the Contracts' "Client API" table, `GET /v1/alerts` and `store` on every op answer included. Task 14 builds
    `FleetClient` on them.
  - `serve.ts`: `Fleet` gains `lanes: LaneRegistry` and `router: Router`; `FleetOptions` gains `eventsBufferBytes?`.
    `startFleet` checks the socket directory first, then serves the client API at `config.socketPath`; a revoked
    node's lanes go through `Connections`' `onRevoked`.
  - Test helpers:
    - `client(socketPath)` returns `get`, `post`, `raw` and `events()`; `events()` connects with `ws+unix:<socket>:/v1/events`.
    - `ODD_NAMES: string[]`.

- [ ] **Step 1: Write the failing lane-registry test**

Create `apps/fleet/test/helpers/odd-names.ts`:

```ts
// Window names that break naive code (Review Focus 1): spaces, unicode, dots, slashes, a literal "%41", a leading dash.
export const ODD_NAMES = ["fix: a/b ü.2", "with space", "dots.in.name", "slash/es/../x", "emoji 🚀 lane", "%41 not-encoded", "-leading-dash"];
```

Create `apps/fleet/test/lane-registry.test.ts`:

```ts
// The lane registry (spec 4): the first registrant keeps a name; a duplicate name from another node or window puts it
// in conflict for both and blocks routing by it (a conflict event { name, nodes }, then a lane_conflict alert); a
// node's claims survive it going offline and a restart; window names with spaces, unicode, dots and slashes survive
// exactly (Review Focus 1).
import type Database from "better-sqlite3";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Pane } from "@morndo/protocol";
import { Audit } from "../src/adapters/audit.ts";
import { openFleetDb } from "../src/adapters/db.ts";
import { LanesStore } from "../src/adapters/lanes-store.ts";
import { EventHub, type FleetEvent } from "../src/application/events.ts";
import { LaneRegistry } from "../src/application/lane-registry.ts";
import { ODD_NAMES } from "./helpers/odd-names.ts";
import { tempDir } from "./helpers/temp.ts";

const pane = (node: string, n: number, window: string): Pane => ({ workerId: `${node}.3fa2c1d0.${n}`, window, cwd: `/work/${n}` });

function setup(db: Database.Database = openFleetDb(join(tempDir(), "fleet.db")), active = ["pc", "mac"]) {
  const events = new EventHub();
  const seen: FleetEvent[] = [];
  events.subscribe(e => seen.push(e));
  const audit = new Audit(db, { onAlert: a => events.emit({ t: "alert", node: a.node ?? "", body: a }) });   // as serve.ts wires it
  return { db, audit, seen, lanes: new LaneRegistry({ store: new LanesStore(db), events, audit, activeNodes: active }) };
}

describe("the lane registry", () => {
  it("registers each window name to its node and worker", () => {
    const { lanes } = setup();
    lanes.inventory("pc", [pane("pc", 1, "api"), pane("pc", 2, "web")]);
    expect(lanes.list()).toEqual([
      { name: "api", node: "pc", workerId: "pc.3fa2c1d0.1", conflict: false },
      { name: "web", node: "pc", workerId: "pc.3fa2c1d0.2", conflict: false },
    ]);
    expect(lanes.resolve("api")).toEqual({ kind: "ok", node: "pc", workerId: "pc.3fa2c1d0.1" });
    expect(lanes.resolve("nope")).toEqual({ kind: "none" });
  });

  it("the first registrant keeps a name; a second node claiming it puts it in conflict and blocks routing", () => {
    const { lanes, seen, audit } = setup();
    lanes.inventory("pc", [pane("pc", 1, "api")]);
    lanes.inventory("mac", [pane("mac", 7, "api")]);
    expect(lanes.list()).toEqual([{ name: "api", node: "pc", workerId: "pc.3fa2c1d0.1", conflict: true }]);
    expect(lanes.resolve("api")).toEqual({ kind: "conflict", claims: [{ node: "pc", workerId: "pc.3fa2c1d0.1" }, { node: "mac", workerId: "mac.3fa2c1d0.7" }] });
    expect(seen.filter(e => e.t === "conflict" || e.t === "alert")).toEqual([
      { t: "conflict", node: "pc", body: { name: "api", nodes: ["pc", "mac"] } },
      { t: "alert", node: "pc", body: expect.objectContaining({ kind: "lane_conflict", detail: { name: "api", claims: [{ node: "pc", workerId: "pc.3fa2c1d0.1" }, { node: "mac", workerId: "mac.3fa2c1d0.7" }] } }) },
    ]);
    expect(audit.of("alert.lane_conflict")).toHaveLength(1);
    lanes.inventory("mac", [pane("mac", 7, "api-2")]);                               // the owner renamed one window
    expect(lanes.resolve("api")).toEqual({ kind: "ok", node: "pc", workerId: "pc.3fa2c1d0.1" });
    expect(lanes.resolve("api-2")).toEqual({ kind: "ok", node: "mac", workerId: "mac.3fa2c1d0.7" });
    expect(seen.filter(e => e.t === "conflict").map(e => e.body)).toEqual([{ name: "api", nodes: ["pc", "mac"] }, { name: "api", nodes: [] }]);
  });

  it("two windows of one name on one node are a conflict too", () => {
    const { lanes, seen } = setup();
    lanes.inventory("pc", [pane("pc", 1, "api"), pane("pc", 2, "api")]);
    expect(lanes.list()).toEqual([{ name: "api", node: "pc", workerId: null, conflict: true }]);
    expect(lanes.resolve("api").kind).toBe("conflict");
    expect(seen.filter(e => e.t === "conflict").map(e => e.body)).toEqual([{ name: "api", nodes: ["pc"] }]);
  });

  it("when the owner lets a name go, the earliest other claimant takes it", () => {
    const { lanes } = setup();
    lanes.inventory("pc", [pane("pc", 1, "api")]);
    lanes.inventory("mac", [pane("mac", 7, "api")]);
    lanes.inventory("pc", []);
    expect(lanes.list()).toEqual([{ name: "api", node: "mac", workerId: "mac.3fa2c1d0.7", conflict: false }]);
    lanes.inventory("mac", []);
    expect(lanes.list()).toEqual([]);
  });

  it("a node's worker ID for a name follows its inventory (a restarted tmux server stamps new IDs)", () => {
    const { lanes } = setup();
    lanes.inventory("pc", [pane("pc", 1, "api")]);
    lanes.inventory("pc", [{ workerId: "pc.0badcafe.0", window: "api", cwd: "/work" }]);
    expect(lanes.resolve("api")).toEqual({ kind: "ok", node: "pc", workerId: "pc.0badcafe.0" });
  });

  it("keeps names with spaces, unicode, dots and slashes exactly, and resolves each to its worker", () => {
    const { lanes } = setup();
    lanes.inventory("pc", ODD_NAMES.map((name, i) => pane("pc", i, name)));
    expect(lanes.list().map(l => l.name).sort()).toEqual([...ODD_NAMES].sort());
    ODD_NAMES.forEach((name, i) => expect(lanes.resolve(name)).toEqual({ kind: "ok", node: "pc", workerId: `pc.3fa2c1d0.${i}` }));
    expect(lanes.resolve("fix: a")).toEqual({ kind: "none" });                       // never split on a separator
    expect(lanes.resolve("fix: a/b ü")).toEqual({ kind: "none" });
  });

  it("after a restart a persisted owner keeps its name until it reports: another node's claim is a conflict, not a takeover", () => {
    const first = setup();
    first.lanes.inventory("pc", [pane("pc", 1, "api")]);
    const after = setup(first.db);
    after.lanes.inventory("mac", [pane("mac", 7, "api")]);
    expect(after.lanes.list()).toEqual([{ name: "api", node: "pc", workerId: "pc.3fa2c1d0.1", conflict: true }]);
    after.lanes.inventory("pc", [pane("pc", 1, "web")]);
    expect(after.lanes.resolve("api")).toEqual({ kind: "ok", node: "mac", workerId: "mac.3fa2c1d0.7" });
  });

  it("revoking a node drops its lanes, clears the conflict, and hands its names to the other claimant", () => {
    const { lanes, seen } = setup();
    lanes.inventory("pc", [pane("pc", 1, "api"), pane("pc", 2, "solo")]);
    lanes.inventory("mac", [pane("mac", 7, "api")]);
    lanes.dropNode("pc");
    expect(lanes.list()).toEqual([{ name: "api", node: "mac", workerId: "mac.3fa2c1d0.7", conflict: false }]);
    expect(seen.filter(e => e.t === "conflict").map(e => e.body)).toEqual([{ name: "api", nodes: ["pc", "mac"] }, { name: "api", nodes: [] }]);
  });

  it("drops the lanes of nodes that are no longer registered when it starts", () => {
    const first = setup();
    first.lanes.inventory("pc", [pane("pc", 1, "api")]);
    first.lanes.inventory("old", [pane("old", 1, "legacy")]);
    const after = setup(first.db, ["pc"]);
    expect(after.lanes.list().map(l => l.name)).toEqual(["api"]);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run apps/fleet/test/lane-registry.test.ts`
Expected: FAIL: `Error: Cannot find module '../src/adapters/lanes-store.ts'`

- [ ] **Step 3: Implement the lanes table and the registry**

Create `apps/fleet/src/adapters/lanes-store.ts`:

```ts
// The lanes table: one row per lane name, its owning node and worker, and whether its name is in conflict (spec 4,
// 6). The lane registry (application/lane-registry.ts) decides; this only reads and writes rows.
import type Database from "better-sqlite3";

export type LaneRow = { name: string; node: string; workerId: string | null; registeredAt: number; conflict: boolean };
type Row = { name: string; node: string; worker_id: string | null; registered_at: number; conflict: number };
const laneFrom = (r: Row): LaneRow => ({ name: r.name, node: r.node, workerId: r.worker_id, registeredAt: r.registered_at, conflict: r.conflict === 1 });

export class LanesStore {
  #db: Database.Database;
  constructor(db: Database.Database) { this.#db = db; }

  get(name: string): LaneRow | null {
    const r = this.#db.prepare("SELECT * FROM lanes WHERE name = ?").get(name) as Row | undefined;
    return r ? laneFrom(r) : null;
  }

  all(): LaneRow[] {
    return (this.#db.prepare("SELECT * FROM lanes ORDER BY name").all() as Row[]).map(laneFrom);
  }

  namesOf(node: string): string[] {
    return (this.#db.prepare("SELECT name FROM lanes WHERE node = ?").all(node) as { name: string }[]).map(r => r.name);
  }

  upsert(l: LaneRow): void {
    this.#db.prepare(`INSERT INTO lanes (name, node, worker_id, registered_at, conflict) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET node = excluded.node, worker_id = excluded.worker_id, registered_at = excluded.registered_at, conflict = excluded.conflict`)
      .run(l.name, l.node, l.workerId, l.registeredAt, l.conflict ? 1 : 0);
  }

  delete(name: string): void { this.#db.prepare("DELETE FROM lanes WHERE name = ?").run(name); }

  // Removes the lanes of every node not in `nodes` (revoked or unknown), e.g. a revocation made while stopped.
  keepOnly(nodes: string[]): number {
    const keep = new Set(nodes);
    let removed = 0;
    for (const l of this.all()) if (!keep.has(l.node)) { this.delete(l.name); removed++; }
    return removed;
  }
}
```

Create `apps/fleet/src/application/lane-registry.ts`:

```ts
// The fleet-wide lane registry (spec 4, ADR-0012 decision 11), built from each node's inventory (window names are
// lane names). A name belongs to the first node that registered it. When more than one window claims a name, on two
// nodes or on one, the name is in conflict for all of them and routing by it stops until only one window claims it.
// A node that goes offline keeps its claims (its lanes show offline through the node's status); only its own next
// inventory, or its revocation, releases them. After a restart, a persisted owner keeps its name until it reports.
// Names are stored and compared exactly as tmux reports them (spaces, unicode, dots, slashes); routing to a pane always
// goes by its worker ID, never by splitting a name (Review Focus 1).
// A name going into conflict, or out of it, is a `conflict` event { name, nodes }: the nodes whose windows claim it
// while it is in conflict, [] once it is not; going into conflict is also a lane_conflict alert, after the event.
import type { Pane } from "@morndo/protocol";
import type { Audit } from "../adapters/audit.ts";
import type { LaneRow, LanesStore } from "../adapters/lanes-store.ts";
import type { EventHub } from "./events.ts";

export type Lane = { name: string; node: string; workerId: string | null; conflict: boolean };
export type Claim = { node: string; workerId: string };
export type Resolved = { kind: "ok"; node: string; workerId: string } | { kind: "none" } | { kind: "conflict"; claims: Claim[] };

const laneOf = (r: LaneRow): Lane => ({ name: r.name, node: r.node, workerId: r.workerId, conflict: r.conflict });

export class LaneRegistry {
  #store: LanesStore;
  #events: EventHub;
  #audit: Audit;
  #now: () => number;
  #claims = new Map<string, Map<string, string[]>>();    // node → lane name → worker IDs, from its latest inventory
  #since = new Map<string, number>();                     // `${node}\n${name}` → the order its claim was first seen
  #order = 0;

  constructor(p: { store: LanesStore; events: EventHub; audit: Audit; activeNodes: string[]; now?: () => number }) {
    this.#store = p.store;
    this.#events = p.events;
    this.#audit = p.audit;
    this.#now = p.now ?? Date.now;
    this.#store.keepOnly(p.activeNodes);
  }

  inventory(node: string, panes: Pane[]): void {
    const next = new Map<string, string[]>();
    for (const pane of panes) next.set(pane.window, [...(next.get(pane.window) ?? []), pane.workerId]);
    const before = this.#claims.get(node) ?? new Map<string, string[]>();
    this.#claims.set(node, next);
    for (const name of before.keys()) if (!next.has(name)) this.#since.delete(`${node}\n${name}`);
    for (const name of next.keys()) if (!this.#since.has(`${node}\n${name}`)) this.#since.set(`${node}\n${name}`, ++this.#order);
    // The names it held before, those it holds now, and those stored as its own (its first report after a restart).
    for (const name of new Set([...before.keys(), ...next.keys(), ...this.#store.namesOf(node)])) this.#recompute(name);
  }

  // A revoked node: its claims and its lanes go; another claimant of one of its names becomes the owner.
  dropNode(node: string): void {
    const names = new Set([...(this.#claims.get(node)?.keys() ?? []), ...this.#store.namesOf(node)]);
    this.#claims.delete(node);
    for (const name of names) {
      this.#since.delete(`${node}\n${name}`);
      const row = this.#store.get(name);
      if (row?.node === node) this.#store.delete(name);
      this.#recompute(name, row);
    }
  }

  list(): Lane[] { return this.#store.all().map(laneOf); }

  get(name: string): Lane | null {
    const r = this.#store.get(name);
    return r ? laneOf(r) : null;
  }

  resolve(name: string): Resolved {
    const r = this.#store.get(name);
    if (!r) return { kind: "none" };
    if (r.conflict || r.workerId === null) return { kind: "conflict", claims: this.#claimsOf(name, r) };
    return { kind: "ok", node: r.node, workerId: r.workerId };
  }

  #claimsOf(name: string, row: LaneRow | null): Claim[] {
    const claims: Claim[] = [];
    for (const [node, names] of this.#claims) for (const workerId of names.get(name) ?? []) claims.push({ node, workerId });
    if (row && !this.#claims.has(row.node)) claims.unshift({ node: row.node, workerId: row.workerId ?? "" });   // not reported yet
    return claims;
  }

  // `before`: the name's row before the change, when it was already removed (a revocation); else the stored one.
  #recompute(name: string, before?: LaneRow | null): void {
    const row = this.#store.get(name);
    const prev = before === undefined ? row : before;
    const was = prev?.conflict ?? false;
    const claims = this.#claimsOf(name, row);
    if (claims.length === 0) {
      if (row) this.#store.delete(name);
      if (was && prev) this.#conflict(name, prev.node, false, []);
      return;
    }
    const keeps = row !== null && claims.some(c => c.node === row.node);
    const owner = keeps && row ? row.node : this.#earliest(name, claims);
    const mine = claims.filter(c => c.node === owner);
    const unreported = row !== null && row.node === owner && !this.#claims.has(owner);
    const next: LaneRow = {
      name, node: owner,
      workerId: unreported ? row.workerId : mine.length === 1 ? (mine[0]?.workerId ?? null) : null,
      registeredAt: keeps && row ? row.registeredAt : this.#now(),
      conflict: claims.length > 1,
    };
    if (!row || row.node !== next.node || row.workerId !== next.workerId || row.conflict !== next.conflict || row.registeredAt !== next.registeredAt) this.#store.upsert(next);
    if (next.conflict !== was) this.#conflict(name, owner, next.conflict, claims);
  }

  #earliest(name: string, claims: Claim[]): string {
    const order = (node: string) => this.#since.get(`${node}\n${name}`) ?? Number.MAX_SAFE_INTEGER;
    return [...claims].sort((a, b) => order(a.node) - order(b.node))[0]?.node ?? "";
  }

  #conflict(name: string, owner: string, conflict: boolean, claims: Claim[]): void {
    this.#events.emit({ t: "conflict", node: owner, body: { name, nodes: conflict ? [...new Set(claims.map(c => c.node))] : [] } });
    if (conflict) this.#audit.alert("lane_conflict", owner, { name, claims });
  }
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `npx vitest run apps/fleet/test/lane-registry.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/fleet/src/adapters/lanes-store.ts apps/fleet/src/application/lane-registry.ts apps/fleet/test/helpers/odd-names.ts apps/fleet/test/lane-registry.test.ts
git commit -m "feat(fleet): lane registry from node inventories, first registrant keeps a name"
```

- [ ] **Step 6: Write the failing socket-directory, router and client-API tests (with the socket client)**

Create `apps/fleet/test/helpers/socket-client.ts`:

```ts
// A client of the fleet's Unix-socket API for tests: JSON requests, raw bodies (files) and the events WebSocket.
// ws connects over a Unix socket with a ws+unix: URL, "ws+unix:/absolute/path:/pathname"
// (https://github.com/websockets/ws/blob/master/doc/ws.md, read 2026-10-06).
import { request } from "node:http";
import { WebSocket } from "ws";
import { socketRequest } from "../../src/adapters/socket-request.ts";
import type { FleetEvent } from "../../src/application/events.ts";
import { parseFrame } from "./fake-agent.ts";

export type Raw = { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer; complete: boolean };

export function client(socketPath: string) {
  return {
    get: (path: string) => socketRequest(socketPath, "GET", path),
    post: (path: string, body?: unknown) => socketRequest(socketPath, "POST", path, body, 10_000),
    raw: (path: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}) => new Promise<Raw>((resolve, reject) => {
      const req = request({ socketPath, path, method: o.method ?? "GET", headers: o.headers ?? {} }, res => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("error", () => {});
        res.on("close", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), complete: res.complete }));
      });
      req.on("error", reject);
      req.end(o.body);
    }),
    events: async (path = "/v1/events") => {
      const ws = new WebSocket(`ws+unix:${socketPath}:${path}`);
      const received: FleetEvent[] = [];
      ws.on("message", raw => received.push(parseFrame<FleetEvent>(raw)));
      ws.on("error", () => {});
      await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("unexpected-response", (_q, r) => reject(new Error(`upgrade refused: ${r.statusCode}`))); });
      return { ws, received, close: () => ws.terminate() };
    },
  };
}
```

Create `apps/fleet/test/socket-dir.test.ts`:

```ts
// The client API's socket (spec 5.6, 8): the service refuses to start unless the socket's directory is a real
// directory owned by this user with mode 0700; a stale socket is cleared, a live one is never taken over, and
// anything else at the path is left alone.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SocketDirUnsafe, SocketInUse, clearStaleSocket, prepareSocketDir } from "../src/adapters/socket-dir.ts";
import { startTestFleet } from "./helpers/fleet.ts";
import { client } from "./helpers/socket-client.ts";
import { tempDir } from "./helpers/temp.ts";

describe("the socket directory", () => {
  it("is created with mode 0700 when missing; the socket is 0600 and answers", async () => {
    const fleet = await startTestFleet();
    expect(statSync(join(fleet.dir, "s")).mode & 0o777).toBe(0o700);
    expect(statSync(fleet.config.socketPath).mode & 0o777).toBe(0o600);
    expect(await client(fleet.config.socketPath).get("/v1/caps")).toEqual({ status: 200, body: { api: [1] } });
  });

  it("a directory others can enter stops the service before it opens anything", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "s"), { mode: 0o755 });
    chmodSync(join(dir, "s"), 0o755);
    await expect(startTestFleet({ dir })).rejects.toThrow(SocketDirUnsafe);
    await expect(startTestFleet({ dir })).rejects.toThrow(/mode 700, not 755/);
    expect(existsSync(join(dir, "s", "f.sock"))).toBe(false);
    expect(existsSync(join(dir, "fleet.db"))).toBe(false);                          // refused before the database
  });

  it("`morndo-fleet serve` exits 78 (EX_CONFIG) with one sentence, not a crash to restart into", () => {
    const home = tempDir();
    mkdirSync(join(home, "open"), { mode: 0o755 });
    chmodSync(join(home, "open"), 0o755);
    const config = join(home, "fleet.json");
    writeFileSync(config, JSON.stringify({ listen: { host: "127.0.0.1", port: 0 }, socketPath: join(home, "open", "f.sock") }));
    const main = join(import.meta.dirname, "../src/main.ts");
    const r = spawnSync(process.execPath, ["--no-warnings", main, "serve"], { env: { ...process.env, HOME: home, MORNDO_FLEET_CONFIG: config }, encoding: "utf8", timeout: 20_000 });
    expect(r.status).toBe(78);
    expect(r.stderr).toMatch(/must have mode 700, not 755/);
    expect(r.stderr).not.toMatch(/\n\s+at /);                                        // a sentence, not a stack trace
  });

  it("refuses a symlinked directory and another user's directory", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "real"), { mode: 0o700 });
    symlinkSync(join(dir, "real"), join(dir, "link"));
    expect(() => prepareSocketDir(join(dir, "link", "f.sock"))).toThrow(/must be a directory/);
    const uid = process.getuid?.() ?? 0;
    expect(() => prepareSocketDir(join(dir, "real", "f.sock"), uid + 1)).toThrow(/must belong to this user/);
    expect(() => prepareSocketDir(join(dir, "real", "f.sock"), uid)).not.toThrow();
  });

  it("clears a stale socket, refuses a live one, and never deletes a file that isn't a socket", async () => {
    const dir = tempDir();
    const path = join(dir, "x.sock");
    const live = createServer();
    await new Promise<void>(r => live.listen(path, r));
    await expect(clearStaleSocket(path)).rejects.toThrow(SocketInUse);
    await new Promise<void>(r => { live.close(() => r()); });
    // A service killed outright leaves its socket file behind, with nobody listening.
    const killed = spawnSync(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(path)}, () => process.kill(process.pid, "SIGKILL"))`]);
    expect(killed.signal).toBe("SIGKILL");
    expect(statSync(path).isSocket()).toBe(true);
    await clearStaleSocket(path);
    expect(existsSync(path)).toBe(false);
    const file = join(dir, "not-a-socket");
    writeFileSync(file, "keep me");
    await expect(clearStaleSocket(file)).rejects.toThrow(/is not a socket/);
    expect(readFileSync(file, "utf8")).toBe("keep me");
  });

  it("a second service on the same socket refuses to start, and the first keeps serving", async () => {
    const first = await startTestFleet();
    await expect(startTestFleet({ dir: first.dir, config: { dbPath: join(first.dir, "other.db") } })).rejects.toThrow(SocketInUse);
    expect((await client(first.config.socketPath).get("/v1/caps"))?.status).toBe(200);
  });
});
```

Create `apps/fleet/test/router.test.ts`:

```ts
// Routing an op (spec 5.3, 5.6, 7): by worker ID, node or lane; node_offline (executed: no) for a node that isn't
// online; key, timeout and args (the expectation among them) passed through; a lane in conflict is lane_conflict for
// every route by its name, while a worker ID is still routed; lane.start of a name registered anywhere, or being
// started, is name_taken; a dropped connection mapped to uncertain for side effects and node_offline for reads; late
// results from the same instance accepted, results for another instance's requests dropped (spec 9, contract: "a fake
// agent answering the wrong id or an old connEpoch is ignored"); every side-effecting op audited.
import { describe, expect, it, vi } from "vitest";
import { startTestFleet, type TestFleet } from "./helpers/fleet.ts";
import { validResult, type FakeAgent } from "./helpers/fake-agent.ts";

const W = "pc.3fa2c1d0.4";
async function withLane(fleet: TestFleet, node: string, name: string, workerId = W): Promise<FakeAgent> {
  const a = await fleet.online(node);
  a.inventory([{ workerId, window: name, cwd: "/work" }]);
  await vi.waitFor(() => expect(fleet.lanes.get(name)?.workerId).toBe(workerId));
  return a;
}
const lastReq = (a: FakeAgent) => a.reqs.at(-1);

describe("routing", () => {
  it("by worker ID, by node and by lane; a lane fills in its worker and the expectation", async () => {
    const fleet = await startTestFleet();
    const a = await withLane(fleet, "pc", "fix: a/b ü.2");
    expect(await fleet.router.op({ workerId: W }, "pane.frame", { workerId: W })).toMatchObject({ ok: true });
    expect(await fleet.router.op({ node: "pc" }, "inventory.get", {})).toMatchObject({ ok: true });
    expect(await fleet.router.op({ lane: "fix: a/b ü.2" }, "pane.send", { text: "hi" }, { key: "kira:1" })).toMatchObject({ ok: true });
    expect(lastReq(a)).toMatchObject({ op: "pane.send", key: "kira:1", args: { workerId: W, text: "hi", expect: { server: "3fa2c1d0", window: "fix: a/b ü.2" } } });
    expect(await fleet.router.op({ lane: "fix: a/b ü.2" }, "transcript.size", { sessionId: "s1" })).toMatchObject({ ok: true });
    expect(lastReq(a)?.args).toEqual({ sessionId: "s1" });                         // only pane ops get a worker
  });

  it("passes key, timeout and the expectation in args through unchanged", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    const expectation = { server: "3fa2c1d0", window: "api", sessionId: "abc" };
    await fleet.router.op({ workerId: W }, "pane.send", { workerId: W, text: "x", expect: expectation }, { key: "hub:e:r", timeoutMs: 7000 });
    expect(lastReq(a)).toEqual({ v: 1, t: "req", id: "1.1", op: "pane.send", args: { workerId: W, text: "x", expect: expectation }, timeoutMs: 7000, key: "hub:e:r" });
    await fleet.router.op({ workerId: W }, "pane.keys", { workerId: W, data: "q", expect: expectation });
    expect(lastReq(a)).toMatchObject({ op: "pane.keys", timeoutMs: 15_000 });
    expect(lastReq(a)).not.toHaveProperty("key");
    await fleet.router.op({ node: "pc" }, "inventory.get", {}, { timeoutMs: 999_999 });
    expect(lastReq(a)?.timeoutMs).toBe(120_000);                                    // clamped
  });

  it("refuses what can't be routed safely, before sending anything", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    const e = { server: "3fa2c1d0", window: "api" };
    const cases = [
      fleet.router.op({ workerId: "%3" }, "pane.frame", {}),
      fleet.router.op({ node: "PC!" }, "inventory.get", {}),
      fleet.router.op({ workerId: W }, "pane.send", { workerId: W, text: "x", expect: e }),                  // no key
      fleet.router.op({ workerId: W }, "pane.keys", { workerId: W, data: "x", expect: e }, { key: "hub:k" }), // a key on keys
      fleet.router.op({ workerId: W }, "pane.frame", { workerId: "pc.3fa2c1d0.5" }),                         // another worker
      fleet.router.op({ node: "pc" }, "inventory.get", { expect: e }),                                       // takes none
      fleet.router.op({ workerId: W }, "pane.frame", { workerId: W, expect: e }),
    ];
    for (const r of await Promise.all(cases)) expect(r).toMatchObject({ ok: false, error: { code: "bad_args", executed: "no" } });
    expect(a.reqs).toEqual([]);
  });

  it("an unknown lane is no_pane; a lane in conflict is lane_conflict, and neither node is sent anything", async () => {
    const fleet = await startTestFleet();
    const pc = await withLane(fleet, "pc", "api", "pc.3fa2c1d0.1");
    const mac = await withLane(fleet, "mac", "solo", "mac.3fa2c1d0.2");
    mac.inventory([{ workerId: "mac.3fa2c1d0.2", window: "api", cwd: "/w" }]);
    await vi.waitFor(() => expect(fleet.lanes.get("api")?.conflict).toBe(true));
    pc.reqs.length = 0;
    expect(await fleet.router.op({ lane: "nope" }, "pane.frame", {})).toMatchObject({ ok: false, error: { code: "no_pane", executed: "no" } });
    expect(await fleet.router.op({ lane: "api" }, "pane.send", { text: "x" }, { key: "kira:1" })).toMatchObject({ ok: false, error: { code: "lane_conflict", executed: "no" }, store: null });
    expect(await fleet.router.op({ lane: "api" }, "pane.keys", { data: "q" })).toMatchObject({ ok: false, error: { code: "lane_conflict" } });
    expect([...pc.reqs, ...mac.reqs]).toEqual([]);
    expect(await fleet.router.op({ node: "mac" }, "lane.start", { name: "api", cwd: "/w" }, { key: "lanes:1" }))
      .toMatchObject({ ok: false, error: { code: "name_taken", executed: "no" } });                       // starting one: taken
    // By worker ID the caller picked one pane: it is routed, conflict or not (the node checks the expectation).
    const e = { server: "3fa2c1d0", window: "api" };
    expect(await fleet.router.op({ workerId: "mac.3fa2c1d0.2" }, "pane.send", { workerId: "mac.3fa2c1d0.2", text: "x", expect: e }, { key: "hub:1" })).toMatchObject({ ok: true, store: mac.store });
    expect(await fleet.router.op({ workerId: "pc.3fa2c1d0.1" }, "pane.frame", { workerId: "pc.3fa2c1d0.1" })).toMatchObject({ ok: true });
    expect([pc.reqs.map(r => r.op), mac.reqs.map(r => r.op)]).toEqual([["pane.frame"], ["pane.send"]]);
  });

  it("lane.start reserves its name until the node answers and reports it: a second start of it is name_taken, never sent", async () => {
    const fleet = await startTestFleet();
    const pc = await fleet.online("pc");
    const mac = await fleet.online("mac");
    let release = () => {};
    pc.answer = req => {
      if (req.op !== "lane.start") return { ok: true, result: validResult(req.op, "pc") };
      release = () => pc.send({ v: 1, t: "res", id: req.id, invVersion: 2, store: pc.store, ok: true, result: { workerId: "pc.3fa2c1d0.9" } });
      return "never";
    };
    const first = fleet.router.op({ node: "pc" }, "lane.start", { name: "new-lane", cwd: "/w" }, { key: "lanes:1" });
    await vi.waitFor(() => expect(pc.reqs.filter(r => r.op === "lane.start")).toHaveLength(1));
    expect(await fleet.router.op({ node: "mac" }, "lane.start", { name: "new-lane", cwd: "/w" }, { key: "lanes:2" }))
      .toMatchObject({ ok: false, error: { code: "name_taken", executed: "no" }, store: null });          // negative control: without the reservation, sent to mac
    expect(mac.reqs).toEqual([]);
    release();
    expect(await first).toMatchObject({ ok: true });
    expect(await fleet.router.op({ node: "mac" }, "lane.start", { name: "new-lane", cwd: "/w" }, { key: "lanes:3" }))
      .toMatchObject({ ok: false, error: { code: "name_taken" } });                                        // answered, not reported yet
    pc.inventory([{ workerId: "pc.3fa2c1d0.9", window: "new-lane", cwd: "/w" }]);
    await vi.waitFor(() => expect(fleet.lanes.get("new-lane")?.node).toBe("pc"));
    // A start the node refused before doing anything frees its name at once.
    pc.answer = () => ({ ok: false, error: { code: "bad_args", executed: "no", message: "no such directory" } });
    expect(await fleet.router.op({ node: "pc" }, "lane.start", { name: "other", cwd: "/nope" }, { key: "lanes:4" })).toMatchObject({ ok: false, error: { code: "bad_args" } });
    expect(await fleet.router.op({ node: "mac" }, "lane.start", { name: "other", cwd: "/w" }, { key: "lanes:5" })).toMatchObject({ ok: true });
    expect(mac.reqs.map(r => (r.args as { name: string }).name)).toEqual(["other"]);
  });

  it("audits every side-effecting op with its target, key namespace, outcome and client, never its text; reads not at all", async () => {
    const fleet = await startTestFleet();
    await fleet.online("pc");
    const e = { server: "3fa2c1d0", window: "api" };
    await fleet.router.op({ workerId: W }, "pane.send", { workerId: W, text: "the secret words", expect: e }, { key: "hub:e1:r1", client: "hub" });
    await fleet.router.op({ workerId: W }, "pane.keys", { workerId: W, data: "rm -rf", expect: e });
    await fleet.router.op({ lane: "nope" }, "pane.send", { text: "x" }, { key: "kira:1", client: "kira" });
    await fleet.router.op({ node: "pc" }, "inventory.get", {}, { client: "hub" });                        // a read: not audited
    expect(fleet.audit.of("op.pane.send").map(r => [r.actor, r.node, r.detail])).toEqual([
      ["client", "pc", { target: { workerId: W }, keyNs: "hub", outcome: "ok", client: "hub" }],
      ["client", null, { target: { lane: "nope" }, keyNs: "kira", outcome: "no_pane", client: "kira" }],
    ]);
    expect(fleet.audit.of("op.pane.keys").map(r => r.detail)).toEqual([{ target: { workerId: W }, keyNs: null, outcome: "ok", client: "unknown" }]);
    expect(fleet.audit.of("op.inventory.get")).toEqual([]);
    expect(JSON.stringify(fleet.audit.recent())).not.toMatch(/secret words|rm -rf/);
  });

  it("lane.start refuses a name already registered anywhere in the fleet (name_taken), before sending anything", async () => {
    const fleet = await startTestFleet();
    await withLane(fleet, "pc", "api");
    const mac = await fleet.online("mac");
    expect(await fleet.router.op({ node: "mac" }, "lane.start", { name: "api", cwd: "/work" }, { key: "lanes:1" }))
      .toMatchObject({ ok: false, error: { code: "name_taken", executed: "no" } });
    expect(mac.reqs).toEqual([]);
    expect(await fleet.router.op({ node: "mac" }, "lane.start", { name: "api-2", cwd: "/work" }, { key: "lanes:2" })).toMatchObject({ ok: true });
  });

  it("node_offline (executed: no) for a node that is not online, and for the lanes it keeps while offline", async () => {
    const fleet = await startTestFleet();
    const a = await withLane(fleet, "pc", "api");
    await a.close();
    await vi.waitFor(() => expect(fleet.connections.status("pc")).toBe("offline"));
    expect(fleet.lanes.get("api")).toEqual({ name: "api", node: "pc", workerId: W, conflict: false });   // kept, offline
    expect(await fleet.router.op({ lane: "api" }, "pane.send", { text: "x" }, { key: "kira:1" })).toMatchObject({ ok: false, error: { code: "node_offline", executed: "no" } });
    expect(await fleet.router.op({ node: "never-joined" }, "inventory.get", {})).toMatchObject({ ok: false, error: { code: "node_offline" } });
  });
});

describe("a connection that drops during a request", () => {
  it("a read fails at once with node_offline; a side effect waits for its deadline, then is uncertain", async () => {
    const fleet = await startTestFleet({ resultSlackMs: 50 });
    const a = await fleet.online("pc");
    a.answer = () => "never";
    const read = fleet.router.op({ node: "pc" }, "transcript.size", { sessionId: "s" }, { timeoutMs: 30_000 });
    const send = fleet.router.op({ workerId: W }, "pane.send", { workerId: W, text: "x", expect: { server: "3fa2c1d0", window: "api" } }, { key: "hub:k1", timeoutMs: 300 });
    await vi.waitFor(() => expect(a.reqs).toHaveLength(2));
    const started = performance.now();
    a.terminate();
    expect(await read).toMatchObject({ ok: false, error: { code: "node_offline", executed: "no" } });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(await send).toMatchObject({ ok: false, error: { code: "uncertain", executed: "maybe" } });
  });

  it("a late result from the same instance on its new connection is accepted", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    a.answer = () => "never";
    const send = fleet.router.op({ workerId: W }, "pane.send", { workerId: W, text: "x", expect: { server: "3fa2c1d0", window: "api" } }, { key: "hub:k1", timeoutMs: 10_000 });
    await vi.waitFor(() => expect(a.reqs).toHaveLength(1));
    const id = a.reqs[0]?.id ?? "";
    a.terminate();                                                                  // dropped after the paste
    await vi.waitFor(() => expect(fleet.connections.status("pc")).toBe("offline"));
    expect((await a.connect()).ok).toBe(true);                                       // the same process reconnects
    a.send({ v: 1, t: "res", id, invVersion: 9, store: a.store, ok: true, result: { problem: null, typedAt: 5 } });
    expect(await send).toEqual({ ok: true, result: { problem: null, typedAt: 5 }, invVersion: 9, store: a.store });
  });

  it("a result for another instance's request (an old connEpoch) is dropped, and the connection stays", async () => {
    const fleet = await startTestFleet();
    const old = await fleet.online("pc");
    old.answer = () => "never";
    const send = fleet.router.op({ workerId: W }, "pane.send", { workerId: W, text: "x", expect: { server: "3fa2c1d0", window: "api" } }, { key: "hub:k1", timeoutMs: 10_000 });
    await vi.waitFor(() => expect(old.reqs).toHaveLength(1));
    const id = old.reqs[0]?.id ?? "";
    expect(id).toBe("1.1");
    old.terminate();
    await vi.waitFor(() => expect(fleet.connections.status("pc")).toBe("offline"));
    const restarted = fleet.agent({ node: "pc", key: old.key });                    // a new agent process: a new instance
    expect(await restarted.connect()).toMatchObject({ ok: true, welcome: { connEpoch: 2 } });
    expect(await send).toMatchObject({ ok: false, error: { code: "uncertain", executed: "maybe" }, store: old.streamId });   // at once
    restarted.send({ v: 1, t: "res", id, invVersion: 1, store: restarted.store, ok: true, result: { problem: null, typedAt: 1 } });
    expect(await fleet.router.op({ node: "pc" }, "inventory.get", {})).toMatchObject({ ok: true });      // still serving
    expect(restarted.open).toBe(true);
  });

  it("a result with an id nobody waits for is ignored; the right one still lands", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    a.answer = req => {
      a.send({ v: 1, t: "res", id: `999.${req.id}`, invVersion: 1, store: a.store, ok: true, result: { panes: [], invVersion: 999 } });
      return { ok: true, result: { panes: [], invVersion: 7 } };
    };
    expect(await fleet.router.op({ node: "pc" }, "inventory.get", {})).toEqual({ ok: true, result: { panes: [], invVersion: 7 }, invVersion: 1, store: a.store });
    expect(a.open).toBe(true);
  });
});
```

Create `apps/fleet/test/client-api.test.ts`:

```ts
// The client API over its Unix socket (spec 5.6): versions and caps, nodes, lanes (odd names survive the URLs, one
// path segment each, Review Focus 1; a name in conflict is reported and never routed by), alerts, ops (each answer
// with its store; side-effecting ones audited with the client that asked), files streamed in chunks, the events
// WebSocket (a client that falls too far behind is closed with 1013), and revocation, from the console too: whichever
// way a node is revoked, its lanes go.
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLOSE, LIMITS, type Alert } from "@morndo/protocol";
import { startTestFleet, type TestFleet } from "./helpers/fleet.ts";
import { health, type FakeAgent } from "./helpers/fake-agent.ts";
import { ODD_NAMES } from "./helpers/odd-names.ts";
import { client } from "./helpers/socket-client.ts";

const MAIN = join(import.meta.dirname, "../src/main.ts");
afterEach(() => { vi.useRealTimers(); });

async function withLanes(fleet: TestFleet, node: string, names: string[]): Promise<FakeAgent> {
  const a = await fleet.online(node);
  a.inventory(names.map((window, i) => ({ workerId: `${node}.3fa2c1d0.${i}`, window, cwd: "/work" })));
  await vi.waitFor(() => expect(fleet.lanes.list()).toHaveLength(names.length));
  return a;
}

// Serves file.stat and file.get from memory, as a node would after its confinement checks.
function serveFiles(a: FakeAgent, files: Map<string, Buffer>) {
  a.answer = req => {
    const args = req.args as { path?: string; ref?: string; offset?: number; max?: number };
    const file = files.get(args.path ?? args.ref ?? "");
    if (req.op === "file.stat") return file ? { ok: true, result: { size: file.length, mtime: 1 } } : { ok: false, error: { code: "denied", executed: "no", message: "denied" } };
    if (req.op === "file.get" && file) {
      const bytes = file.subarray(args.offset ?? 0, (args.offset ?? 0) + (args.max ?? 0));
      return { ok: true, result: { bytes: bytes.toString("base64"), size: file.length, eof: (args.offset ?? 0) + bytes.length >= file.length } };
    }
    return { ok: true, result: {} };
  };
}

describe("the client API", () => {
  it("speaks /v1/ and lists its versions; another version or route is a 404", async () => {
    const fleet = await startTestFleet();
    const api = client(fleet.config.socketPath);
    expect(await api.get("/v1/caps")).toEqual({ status: 200, body: { api: [1] } });
    expect(await api.get("/v9/caps")).toEqual({ status: 404, body: { error: "unsupported_api", api: [1] } });
    expect(await api.get("/caps")).toMatchObject({ status: 404 });
    expect(await api.get("/v1/nothing-here")).toEqual({ status: 404, body: { error: "no such route" } });
  });

  it("lists nodes with status, health and agent version", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    a.health(health({ load1: 2 }));
    await fleet.joined("mac");
    await vi.waitFor(() => expect(fleet.connections.latest("pc").health).not.toBeNull());
    expect((await client(fleet.config.socketPath).get("/v1/nodes"))?.body).toEqual([
      { name: "mac", status: "offline", health: null, agent: null },
      { name: "pc", status: "online", health: expect.objectContaining({ load1: 2 }), agent: "test-agent/1" },
    ]);
  });

  it("lane names with spaces, unicode, dots and slashes survive the list, their own URL and an op by lane", async () => {
    const fleet = await startTestFleet();
    const a = await withLanes(fleet, "pc", ODD_NAMES);
    const api = client(fleet.config.socketPath);
    const listed = (await api.get("/v1/lanes"))?.body as { name: string }[];
    expect(listed.map(l => l.name).sort()).toEqual([...ODD_NAMES].sort());
    for (const [i, name] of ODD_NAMES.entries()) {
      expect(await api.get(`/v1/lanes/${encodeURIComponent(name)}`), name).toEqual({ status: 200, body: { name, node: "pc", workerId: `pc.3fa2c1d0.${i}`, conflict: false } });
      const r = await api.post("/v1/op", { lane: name, op: "pane.frame", args: {} });
      expect(r?.status, name).toBe(200);
      expect(a.reqs.at(-1)?.args, name).toEqual({ workerId: `pc.3fa2c1d0.${i}` });
    }
    expect(await api.get(`/v1/lanes/${encodeURIComponent("fix: a")}`)).toEqual({ status: 404, body: { error: "no_such_lane" } });
    expect((await api.get("/v1/lanes/fix%3A%20a/b%20%C3%BC.2"))?.status).toBe(404);    // unencoded "/" is another segment
  });

  it("POST /v1/op answers the outcome; a body that doesn't fit is 400 bad_args, and not JSON is 415, both in the op's shape", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    a.answer = () => ({ ok: true, result: { panes: [], invVersion: 3 } });
    const api = client(fleet.config.socketPath);
    expect(await api.post("/v1/op", { node: "pc", op: "inventory.get", args: {} })).toEqual({ status: 200, body: { ok: true, result: { panes: [], invVersion: 3 }, invVersion: 1, store: a.store } });
    for (const body of [{ op: "inventory.get", args: {} }, { node: "pc", lane: "x", op: "inventory.get", args: {} }, { node: "pc", op: "exec", args: {} },
      { node: "pc", op: "inventory.get" }, { node: "pc", op: "inventory.get", args: [] },
      { node: "pc", op: "pane.send", args: {}, key: "no namespace" }, { node: "pc", op: "pane.send", args: {}, key: "kira-2:1" },
      { node: "pc", op: "inventory.get", args: {}, timeoutMs: 0 }, { node: "pc", op: "inventory.get", args: {}, extra: 1 },
      { node: "pc", op: "pane.send", args: {}, expect: { server: "3fa2c1d0", window: "w" } }]) {   // expect goes inside args
      expect(await api.post("/v1/op", body), JSON.stringify(body)).toMatchObject({ status: 400, body: { ok: false, error: { code: "bad_args", executed: "no" }, store: null } });
    }
    for (const o of [{ body: "{}" }, { body: "{not json", headers: { "content-type": "application/json" } }]) {
      const r = await api.raw("/v1/op", { method: "POST", ...o });
      expect(r.status).toBe(415);
      expect(JSON.parse(r.body.toString())).toMatchObject({ ok: false, error: { code: "bad_args", executed: "no" }, store: null });
    }
    expect(await api.post("/v1/op", { node: "mac", op: "inventory.get", args: {} })).toMatchObject({ status: 200, body: { ok: false, error: { code: "node_offline", executed: "no" }, store: null } });
  });

  it("two windows of one name on one node: the lane reads as in conflict with no worker, every route by the name is refused, and each pane is still reachable by its worker ID", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    a.inventory([{ workerId: "pc.3fa2c1d0.1", window: "claude", cwd: "/a" }, { workerId: "pc.3fa2c1d0.2", window: "claude", cwd: "/b" }]);
    await vi.waitFor(() => expect(fleet.lanes.get("claude")?.conflict).toBe(true));
    const api = client(fleet.config.socketPath);
    expect(await api.get("/v1/lanes/claude")).toEqual({ status: 200, body: { name: "claude", node: "pc", workerId: null, conflict: true } });
    expect((await api.post("/v1/op", { lane: "claude", op: "pane.send", args: { text: "x" }, key: "lanes:1" }))?.body)
      .toMatchObject({ ok: false, error: { code: "lane_conflict", executed: "no" }, store: null });
    expect(a.reqs).toEqual([]);
    for (const workerId of ["pc.3fa2c1d0.1", "pc.3fa2c1d0.2"]) {
      expect((await api.post("/v1/op", { workerId, op: "pane.frame", args: {} }))?.body, workerId).toMatchObject({ ok: true, store: a.store });
    }
    expect(a.reqs.map(r => r.args)).toEqual([{ workerId: "pc.3fa2c1d0.1" }, { workerId: "pc.3fa2c1d0.2" }]);
  });

  it("audits a side-effecting op with the client named in x-morndo-client (unknown when it names none or a bad one)", async () => {
    const fleet = await startTestFleet();
    await fleet.online("pc");
    const api = client(fleet.config.socketPath);
    const W = "pc.3fa2c1d0.4";
    const body = (key: string) => JSON.stringify({ workerId: W, op: "pane.send", args: { workerId: W, text: "words", expect: { server: "3fa2c1d0", window: "api" } }, key });
    for (const [key, header] of [["hub:r1", "hub"], ["hub:r2", undefined], ["hub:r3", "Hub!"]] as const) {
      const r = await api.raw("/v1/op", { method: "POST", body: body(key), headers: { "content-type": "application/json", ...(header ? { "x-morndo-client": header } : {}) } });
      expect(r.status).toBe(200);
    }
    expect(fleet.audit.of("op.pane.send").map(e => e.detail.client)).toEqual(["hub", "unknown", "unknown"]);
  });

  it("streams a file in chunks of at most 256 KiB, its path one URL-encoded segment, spaces, unicode and slashes intact", async () => {
    const fleet = await startTestFleet();
    const a = await fleet.online("pc");
    const path = "/home/u/my files/ü.2/a b.bin";
    const content = Buffer.from(Array.from({ length: 2 * LIMITS.chunkBytes + 1000 }, (_, i) => i % 251));
    serveFiles(a, new Map([[path, content], ["r0123456789abcdef", Buffer.from("relay copy")]]));
    const api = client(fleet.config.socketPath);
    const r = await api.raw(`/v1/files/pc/${encodeURIComponent(path)}`);
    expect(r.status).toBe(200);
    expect(r.headers["x-file-size"]).toBe(String(content.length));
    expect(r.body.equals(content)).toBe(true);
    expect(a.reqs.map(q => [q.op, (q.args as { offset?: number }).offset])).toEqual([["file.stat", undefined], ["file.get", 0], ["file.get", 262144], ["file.get", 524288]]);
    expect(a.reqs[0]?.args).toEqual({ path });
    expect((await api.raw("/v1/files/pc/r0123456789abcdef")).body.toString()).toBe("relay copy");
    expect(a.reqs.at(-1)?.args).toMatchObject({ ref: "r0123456789abcdef" });
    const denied = await api.raw(`/v1/files/pc/${encodeURIComponent("/etc/shadow")}`);
    expect(denied.status).toBe(403);
    expect(JSON.parse(denied.body.toString())).toEqual({ ok: false, error: { code: "denied", executed: "no", message: "denied" } });
    const offline = await api.raw(`/v1/files/mac/${encodeURIComponent(path)}`);
    expect(offline.status).toBe(503);
    expect(JSON.parse(offline.body.toString())).toMatchObject({ ok: false, error: { code: "node_offline", executed: "no" } });
  });

  it("the events socket starts with every node's status, then each online node's inventory and health, then each change", async () => {
    const fleet = await startTestFleet();
    const gone = await fleet.online("gone");
    gone.inventory([{ workerId: "gone.3fa2c1d0.1", window: "old", cwd: "/w" }]);
    await vi.waitFor(() => expect(fleet.connections.latest("gone").inventory).not.toBeNull());
    await gone.close();                                                                // offline: its latest inventory is not sent
    await vi.waitFor(() => expect(fleet.connections.status("gone")).toBe("offline"));
    const a = await fleet.online("pc");
    a.inventory([{ workerId: "pc.3fa2c1d0.1", window: "api", cwd: "/w" }]);
    a.health(health({ load1: 3 }));
    await vi.waitFor(() => expect(fleet.connections.latest("pc").health).not.toBeNull());
    const ev = await client(fleet.config.socketPath).events();
    await vi.waitFor(() => expect(ev.received.map(e => `${e.t}:${e.node}`)).toEqual(["status:gone", "status:pc", "inventory:pc", "health:pc"]));
    expect(ev.received.slice(0, 3).map(e => e.body)).toEqual([
      { status: "offline" }, { status: "online" }, { panes: [{ workerId: "pc.3fa2c1d0.1", window: "api", cwd: "/w" }], invVersion: 2 },
    ]);
    const b = await fleet.online("mac");
    b.inventory([{ workerId: "mac.3fa2c1d0.1", window: "api", cwd: "/w" }]);
    await vi.waitFor(() => expect(ev.received.slice(4).map(e => `${e.t}:${e.node}`)).toEqual(["status:mac", "inventory:mac", "conflict:pc", "alert:pc"]));
    expect(ev.received.at(-2)?.body).toEqual({ name: "api", nodes: ["pc", "mac"] });
    expect([ev.received.at(-1)?.body]).toEqual((await client(fleet.config.socketPath).get("/v1/alerts"))?.body);
    ev.close();
  });

  it("GET /v1/alerts serves every alert as an Alert, oldest first, and each one is an alert event as it is raised", async () => {
    const fleet = await startTestFleet();
    const api = client(fleet.config.socketPath);
    expect(await api.get("/v1/alerts")).toEqual({ status: 200, body: [] });
    const ev = await api.events();
    const a = await fleet.online("pc");
    const clone = fleet.agent({ node: "pc", key: a.key });
    expect((await clone.connect()).ok).toBe(false);                                   // instance_conflict
    a.health(health({ wallClock: Date.now() + 60_000 }));                              // clock_offset
    await vi.waitFor(() => expect(fleet.audit.of("alert.clock_offset")).toHaveLength(1));
    const alerts = (await api.get("/v1/alerts"))?.body as Alert[];
    expect(alerts.map(x => [x.kind, x.node])).toEqual([["instance_conflict", "pc"], ["clock_offset", "pc"]]);
    expect(alerts[0]).toEqual({ id: expect.any(Number), at: expect.any(Number), node: "pc", kind: "instance_conflict", detail: { live: a.instanceId, refused: clone.instanceId, source: "127.0.0.1" } });
    expect(alerts[1]?.detail).toEqual({ offsetMs: expect.any(Number) });
    expect(alerts[0]?.id).toBeLessThan(alerts[1]?.id ?? 0);
    await vi.waitFor(() => expect(ev.received.filter(e => e.t === "alert").map(e => e.body)).toEqual(alerts));
    expect(ev.received.filter(e => e.t === "alert").map(e => e.node)).toEqual(["pc", "pc"]);
    ev.close();
  });

  it("an events client that falls too far behind is closed with 1013 and gets no more events", async () => {
    const fleet = await startTestFleet({ eventsBufferBytes: 64 << 10 });
    const ev = await client(fleet.config.socketPath).events();
    const closed = new Promise<number>(r => ev.ws.once("close", code => r(code)));
    ev.ws.pause();                                                                    // it stops reading
    const pad = "x".repeat(32 << 10);
    for (let i = 0; i < 400; i++) fleet.events.emit({ t: "health", node: "pc", body: { pad, i } });   // 12.8 MB
    ev.ws.resume();
    expect(await closed).toBe(1013);                                                 // negative control: without the cap, all 400 and no close
    expect(ev.received.length).toBeLessThan(400);
  });

  it("revoking through the socket closes the node's connection with 4403 and drops its lanes", async () => {
    const fleet = await startTestFleet();
    const a = await withLanes(fleet, "pc", ["api"]);
    const api = client(fleet.config.socketPath);
    expect(await api.post("/v1/nodes/pc/revoke")).toEqual({ status: 200, body: { ok: true, revoked: true } });
    expect((await a.closed).code).toBe(CLOSE.forbidden);
    expect((await api.get("/v1/lanes"))?.body).toEqual([]);
    expect((await api.get("/v1/nodes"))?.body).toEqual([]);
    expect(fleet.audit.of("node.revoke").map(e => [e.actor, e.node])).toEqual([["client", "pc"]]);
    expect(await api.post("/v1/nodes/Not%20A%20Name/revoke")).toMatchObject({ status: 400 });
  });

  it("the console's `node revoke` and `status` reach the running service, and the node's lanes go", async () => {
    const fleet = await startTestFleet();
    const a = await withLanes(fleet, "pc", ["api"]);
    const config = join(fleet.dir, "fleet.json");
    writeFileSync(config, JSON.stringify({ socketPath: fleet.config.socketPath, dbPath: fleet.config.dbPath, keyPath: fleet.config.keyPath }));
    // Asynchronously: the service runs in this process, and a synchronous spawn would stop it from answering.
    const run = (...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
      execFile(process.execPath, ["--no-warnings", MAIN, ...args], { env: { ...process.env, MORNDO_FLEET_CONFIG: config }, encoding: "utf8", timeout: 20_000 },
        (error, stdout, stderr) => resolve({ code: typeof error?.code === "number" ? error.code : error ? -1 : 0, stdout, stderr }));
    });
    const status = await run("status");
    expect(status.code, status.stderr).toBe(0);
    expect(status.stdout).toMatch(/fleet service: running/);
    expect(status.stdout).toMatch(/^\s+pc\s+online\s+agent test-agent\/1$/m);
    const revoked = await run("node", "revoke", "pc");
    expect(revoked.stdout).toMatch(/revoked pc; its connection, if any, is closed/);
    expect((await a.closed).code).toBe(CLOSE.forbidden);
    expect((await client(fleet.config.socketPath).get("/v1/lanes"))?.body).toEqual([]);
  }, 30_000);

  it("a revocation written to fleet.db while the node is offline (the console, when the service didn't answer): its lanes go within one interval", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const fleet = await startTestFleet();
    const a = await withLanes(fleet, "pc", ["api"]);
    await a.close();
    await vi.waitFor(() => expect(fleet.connections.status("pc")).toBe("offline"));
    expect(fleet.lanes.list().map(l => l.name)).toEqual(["api"]);                     // kept while offline
    fleet.nodes.revoke("pc");                                                         // what `node revoke` writes
    vi.advanceTimersByTime(LIMITS.pingMs);
    expect((await client(fleet.config.socketPath).get("/v1/lanes"))?.body).toEqual([]);   // negative control: kept until a restart
  });
});
```

- [ ] **Step 7: Run them and see them fail**

Run: `npx vitest run apps/fleet/test/socket-dir.test.ts apps/fleet/test/router.test.ts apps/fleet/test/client-api.test.ts`
Expected: FAIL, 3 files, 25 tests: `socket-dir.test.ts` with `Error: Cannot find module '../src/adapters/socket-dir.ts'` (no tests run); in `router.test.ts`, every test, with `TypeError: Cannot read properties of undefined (reading 'op')` (no `fleet.router` yet), or `… (reading 'get')` in the four that first wait for `fleet.lanes`; in `client-api.test.ts`, every test, because nothing serves the socket yet: `expected null to deeply equal …` (or `expected undefined …` for its `?.body`) where a request answers `null`, `Error: connect ENOENT …/s/f.sock` for the raw requests, `TypeError: Cannot read properties of undefined (reading 'list')` or `(reading 'get')` where a test waits for `fleet.lanes`, and `Error: Test timed out in 20000ms.` for the two events tests

- [ ] **Step 8: Implement the socket-directory check**

Create `apps/fleet/src/adapters/socket-dir.ts`:

```ts
// The client API's Unix socket (spec 5.6, 8): its directory must be a real directory (not a symlink) owned by this
// user with mode 0700, or the service refuses to start, since anyone who can reach the socket can steer every node.
// A socket file left by a service that died is removed; one that answers belongs to a running service and is never
// taken over; anything else at that path is left alone and refused.
import { lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import { dirname } from "node:path";

export class SocketDirUnsafe extends Error {
  constructor(message: string) { super(message); this.name = "SocketDirUnsafe"; }
}

export class SocketInUse extends Error {
  constructor(message: string) { super(message); this.name = "SocketInUse"; }
}

export function prepareSocketDir(socketPath: string, uid: number = process.getuid?.() ?? -1): void {
  const dir = dirname(socketPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new SocketDirUnsafe(`${dir} must be a directory, not a link or a file`);
  if (st.uid !== uid) throw new SocketDirUnsafe(`${dir} must belong to this user (uid ${uid}); it belongs to uid ${st.uid}`);
  const mode = st.mode & 0o777;
  if (mode !== 0o700) throw new SocketDirUnsafe(`${dir} must have mode 700, not ${mode.toString(8)} (chmod 700 ${dir})`);
}

export async function clearStaleSocket(socketPath: string): Promise<void> {
  let st;
  try { st = lstatSync(socketPath); } catch { return; }
  if (!st.isSocket()) throw new SocketDirUnsafe(`${socketPath} exists and is not a socket; move it away`);
  const answers = await new Promise<boolean>(resolve => {
    const s = connect(socketPath);
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  });
  if (answers) throw new SocketInUse(`another fleet service is listening on ${socketPath}`);
  unlinkSync(socketPath);
}
```

- [ ] **Step 9: Implement the router**

Create `apps/fleet/src/application/router.ts`:

```ts
// Routing a client's op to a node (spec 5.3, 5.6): by worker ID (its node is in the ID), by node, or by lane name
// (through the registry; a name in conflict is never routed: lane_conflict). A worker ID is routed whatever the
// registry says of its window's name: the caller picked that pane, and the node checks the expectation. For a lane,
// the pane ops get the lane's worker ID, and pane.send and pane.keys get the expectation args.expect = { server,
// window: lane } unless the caller gave one, so a reused or renamed pane refuses with no_pane instead of receiving the
// text. The caller's key, timeout and args (an expectation travels inside them, as OpArgs has it) pass through
// unchanged; a keyed op without a key, a key on an op that takes none, an expectation on an op that takes none, and
// lane.start of a name registered anywhere in the fleet, or whose own lane.start is still in flight (name_taken), are
// refused before anything is sent. The name stays reserved from a lane.start until the node refused it (executed:
// no), or, once it answered, until the registry holds the name (at most RESERVE_AFTER_START_MS).
// Every side-effecting op (KEYED_OPS and pane.keys) is audited as op.<name>: the target, the key's namespace, the
// outcome and the client that asked; never its text, keystrokes or bytes.
import { KEYED_OPS, NODE_NAME, parseWorkerId, type OpName } from "@morndo/protocol";
import type { Audit } from "../adapters/audit.ts";
import type { Connections } from "./connections.ts";
import type { LaneRegistry } from "./lane-registry.ts";
import { SIDE_EFFECT_OPS, failed, type Outcome } from "./requests.ts";

export type Target = { workerId: string } | { node: string } | { lane: string };
// client: the client that asks (the client API's x-morndo-client header), for the audit.
export type OpOptions = { key?: string; timeoutMs?: number; client?: string };

export const DEFAULT_TIMEOUT_MS = 15_000;
export const MAX_TIMEOUT_MS = 120_000;
// How long a name stays reserved after its lane.start was answered, for the node's next inventory to report it.
export const RESERVE_AFTER_START_MS = 10_000;
const PANE_OPS: ReadonlySet<OpName> = new Set<OpName>(["pane.frame", "pane.keys", "pane.send"]);
const EXPECT_OPS: ReadonlySet<OpName> = new Set<OpName>(["pane.keys", "pane.send"]);

export class Router {
  #connections: Connections;
  #lanes: LaneRegistry;
  #audit: Audit | null;
  #mono: () => number;
  #starting = new Map<string, number | null>();          // lane name → reserved until (mono); null while in flight

  constructor(p: { connections: Connections; lanes: LaneRegistry; audit?: Audit; mono?: () => number }) {
    this.#connections = p.connections;
    this.#lanes = p.lanes;
    this.#audit = p.audit ?? null;
    this.#mono = p.mono ?? (() => performance.now());
  }

  async op(target: Target, op: OpName, args: Record<string, unknown>, o: OpOptions = {}): Promise<Outcome> {
    const routed = this.#route(target, op, args, o);
    const out = await routed.outcome;
    if (SIDE_EFFECT_OPS.has(op)) {
      this.#audit?.record("client", `op.${op}`, routed.node, {
        target, keyNs: o.key === undefined ? null : o.key.slice(0, o.key.indexOf(":")), outcome: out.ok ? "ok" : out.error.code, client: o.client ?? "unknown",
      });
    }
    return out;
  }

  #route(target: Target, op: OpName, args: Record<string, unknown>, o: OpOptions): { node: string | null; outcome: Promise<Outcome> } {
    const refuse = (o2: Outcome, node: string | null = null) => ({ node, outcome: Promise.resolve(o2) });
    let node: string;
    let workerId: string | null = null;
    let lane: string | null = null;
    if ("workerId" in target) {
      const ref = parseWorkerId(target.workerId);
      if (!ref) return refuse(failed("bad_args", `not a worker ID: ${JSON.stringify(target.workerId)}`));
      node = ref.node;
      workerId = target.workerId;
    } else if ("node" in target) {
      if (!NODE_NAME.test(target.node)) return refuse(failed("bad_args", `not a node name: ${JSON.stringify(target.node)}`));
      node = target.node;
    } else {
      const r = this.#lanes.resolve(target.lane);
      if (r.kind === "none") return refuse(failed("no_pane", `no lane named ${JSON.stringify(target.lane)}`));
      if (r.kind === "conflict") return refuse(failed("lane_conflict", `more than one window is named ${JSON.stringify(target.lane)}; rename one, or address it by worker ID`));
      node = r.node;
      workerId = r.workerId;
      lane = target.lane;
    }
    const a: Record<string, unknown> = { ...args };
    if (workerId !== null && PANE_OPS.has(op)) {
      if (a.workerId === undefined) a.workerId = workerId;
      else if (a.workerId !== workerId) return refuse(failed("bad_args", "args.workerId is not the target's worker"), node);
    }
    if (a.expect !== undefined && !EXPECT_OPS.has(op)) return refuse(failed("bad_args", "expect applies to pane.send and pane.keys only"), node);
    if (lane !== null && workerId !== null && EXPECT_OPS.has(op) && a.expect === undefined) {
      a.expect = { server: parseWorkerId(workerId)?.server ?? "", window: lane };
    }
    if (KEYED_OPS.has(op) && o.key === undefined) return refuse(failed("bad_args", `${op} needs a key, so a retry can never act twice`), node);
    if (!KEYED_OPS.has(op) && o.key !== undefined) return refuse(failed("bad_args", `${op} takes no key`), node);
    const timeoutMs = Math.min(o.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const send = () => this.#connections.request(node, op, a, { timeoutMs, ...(o.key === undefined ? {} : { key: o.key }) });
    if (op !== "lane.start" || typeof a.name !== "string") return { node, outcome: send() };
    // Lane names are fleet-wide (spec 4): only the fleet sees every node's names, so it refuses a taken one here, and
    // one whose start is under way (two starts of one name on two nodes would both be sent otherwise).
    const name = a.name;
    const taken = this.#lanes.get(name);
    if (taken) return refuse(failed("name_taken", `a lane named ${JSON.stringify(taken.name)} is registered on node ${taken.node}`), node);
    if (this.#reserved(name)) return refuse(failed("name_taken", `a lane named ${JSON.stringify(name)} is being started`), node);
    this.#starting.set(name, null);
    return {
      node,
      outcome: send().then(out => {
        if (!out.ok && out.error.executed === "no") this.#starting.delete(name);
        else this.#starting.set(name, this.#mono() + RESERVE_AFTER_START_MS);
        return out;
      }),
    };
  }

  #reserved(name: string): boolean {
    const until = this.#starting.get(name);
    if (until === undefined) return false;
    if (until === null || this.#mono() < until) return true;
    this.#starting.delete(name);
    return false;
  }
}
```

- [ ] **Step 10: Implement the client API: the op body, the files route and the server**

Create `apps/fleet/src/adapters/op-body.ts`:

```ts
// The body of POST /v1/op (spec 5.6, the Contracts' client API): { workerId | node | lane (exactly one), op, args,
// key?, timeoutMs? }; an expectation travels inside args, as OpArgs has it. Checked here for shape only; the op's own
// arguments are the agent's to check (it answers bad_args). Unknown fields, a top-level `expect` among them, are
// refused, so a client's typo never routes somewhere unintended.
import type { OpName } from "@morndo/protocol";
import type { Target } from "../application/router.ts";
import { MAX_TIMEOUT_MS } from "../application/router.ts";

export type OpBody = { target: Target; op: OpName; args: Record<string, unknown>; key?: string; timeoutMs?: number };

// Every op once: a Record over the union, so an op the protocol adds fails to compile here until listed.
const OPS: Record<OpName, true> = {
  "inventory.get": true, "pane.captureMany": true, "pane.frame": true, "pane.keys": true, "pane.send": true, "op.status": true,
  "transcript.size": true, "transcript.read": true, "transcript.locate": true, "file.stat": true, "file.get": true, "file.put": true,
  "lane.start": true, "lane.stop": true, "worktree.list": true, "worktree.add": true,
};
const FIELDS = new Set(["node", "workerId", "lane", "op", "args", "key", "timeoutMs"]);
// A client's namespace, a colon, then printable ASCII (spec 5.3: keys are namespaced by client, e.g. "hub:", "kira:"):
// the protocol's key (^[a-z]+:, at most 512 characters), narrowed to at most 256.
const KEY = /^[a-z]{1,16}:[\x21-\x7e]{1,239}$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseOpBody(v: unknown): { ok: true; body: OpBody } | { ok: false; message: string } {
  const no = (message: string) => ({ ok: false as const, message });
  if (!isObject(v)) return no("the body must be a JSON object");
  const extra = Object.keys(v).filter(k => !FIELDS.has(k));
  if (extra.length) return no(`unknown fields: ${extra.join(", ")}`);
  const targets = (["node", "workerId", "lane"] as const).filter(k => v[k] !== undefined);
  if (targets.length !== 1) return no("name exactly one of node, workerId or lane");
  const t = targets[0] ?? "node";
  const value = v[t];
  if (typeof value !== "string" || value === "" || value.length > 1000) return no(`${t} must be a non-empty string`);
  const target: Target = t === "node" ? { node: value } : t === "workerId" ? { workerId: value } : { lane: value };
  if (typeof v.op !== "string" || !Object.hasOwn(OPS, v.op)) return no(`unknown op: ${JSON.stringify(v.op)}`);
  if (!isObject(v.args)) return no("args must be an object");
  if (v.key !== undefined && (typeof v.key !== "string" || !KEY.test(v.key))) return no("key must be <client>:<printable ASCII>, the client a-z, at most 256 characters");
  if (v.timeoutMs !== undefined && (!Number.isInteger(v.timeoutMs) || (v.timeoutMs as number) < 1 || (v.timeoutMs as number) > MAX_TIMEOUT_MS)) {
    return no(`timeoutMs must be a whole number from 1 to ${MAX_TIMEOUT_MS}`);
  }
  return {
    ok: true,
    body: {
      target, op: v.op as OpName, args: v.args,
      ...(v.key === undefined ? {} : { key: v.key as string }),
      ...(v.timeoutMs === undefined ? {} : { timeoutMs: v.timeoutMs as number }),
    },
  };
}
```

Create `apps/fleet/src/adapters/files-route.ts`:

```ts
// GET /v1/files/<node>/<ref|path> (spec 5.6): a node's file streamed to the client, read through file.stat and then
// chunked file.get (at most LIMITS.chunkBytes per request, at most LIMITS.maxFileBytes in all). The node applies
// today's confinement rules (spec 3.1); a refusal before the first byte is an HTTP status with { ok: false, error:
// OpError }, a failure after it ends the response early (the client sees a truncated body, never a wrong one). A value
// that starts with "/" or "~" is a path; anything else is a relay file's ref.
import type { ServerResponse } from "node:http";
import { LIMITS, type ErrorCode, type OpError } from "@morndo/protocol";
import type { Router } from "../application/router.ts";

const STATUS: Partial<Record<ErrorCode, number>> = {
  bad_args: 400, denied: 403, too_large: 413, node_offline: 503, timeout: 504, uncertain: 502, internal: 502,
};

function refuse(res: ServerResponse, error: OpError) {
  res.writeHead(STATUS[error.code] ?? 404, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ ok: false, error }));
}

const drained = (res: ServerResponse) => new Promise<void>(resolve => { res.once("drain", resolve); res.once("close", resolve); });

export async function streamFile(res: ServerResponse, router: Router, node: string, refOrPath: string): Promise<void> {
  const sel = refOrPath.startsWith("/") || refOrPath.startsWith("~") ? { path: refOrPath } : { ref: refOrPath };
  const stat = await router.op({ node }, "file.stat", sel);
  if (!stat.ok) return refuse(res, stat.error);
  const { size } = stat.result as { size: number };
  res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store", "x-file-size": String(size) });
  for (let offset = 0; ;) {
    const got = await router.op({ node }, "file.get", { ...sel, offset, max: LIMITS.chunkBytes });
    if (res.destroyed) return;                                       // the client left
    if (!got.ok) { res.destroy(new Error(`file.get failed: ${got.error.code}`)); return; }
    const r = got.result as { bytes: string; eof: boolean };
    const chunk = Buffer.from(r.bytes, "base64");
    offset += chunk.length;
    if (offset > LIMITS.maxFileBytes) { res.destroy(new Error("file over the limit")); return; }
    if (chunk.length > 0 && !res.write(chunk)) await drained(res);
    if (r.eof) break;
    if (chunk.length === 0) { res.destroy(new Error("file.get made no progress")); return; }
  }
  res.end();
}
```

Create `apps/fleet/src/adapters/client-api.ts`:

```ts
// The client API (spec 5.6): HTTP and WebSocket on a Unix socket only, for the hub, kira and `lanes`. Every route is
// under /v<N>/ with N the current or the previous API version; GET /v1/caps lists them.
//   GET  /v1/caps                      { api: number[] }
//   GET  /v1/nodes                     [{ name, status, health, agent }]
//   POST /v1/nodes/<name>/revoke       closes the node's connection, drops its lanes (the console's `node revoke`)
//   GET  /v1/lanes                     [{ name, node, workerId, conflict }]
//   GET  /v1/lanes/<lane name>         one lane; the name URL-encoded as one path segment
//   GET  /v1/alerts                    Alert[]: the latest 500, oldest first
//   POST /v1/op                        { workerId | node | lane, op, args, key?, timeoutMs? } → the outcome, always as
//                                      { ok, result, invVersion, store } or { ok: false, error: OpError, store }
//                                      (store null when nothing was sent; 415: not JSON). The client names itself in
//                                      x-morndo-client (a-z, at most 16), for the audit of side-effecting ops.
//   GET  /v1/files/<node>/<ref|path>   the file, streamed; the ref or path URL-encoded as one path segment
//   WS   /v1/events                    { t: "inventory" | "health" | "status" | "conflict" | "alert", node, body }; a
//                                      client more than eventsBufferBytes behind is closed with 1013 (it reconnects
//                                      and gets the current state first)
// The path is split on "/" before any segment is decoded, so a name or path holding "/" (as %2F) stays one segment
// (Review Focus 1). Over a Unix socket the server listens with node:http's listen(path)
// (https://nodejs.org/docs/latest-v24.x/api/net.html#serverlistenpath-backlog-callback, read 2026-10-06).
import { chmodSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { CLIENT_API, LIMITS, NODE_NAME } from "@morndo/protocol";
import type { Connections } from "../application/connections.ts";
import type { EventHub, FleetEvent } from "../application/events.ts";
import type { LaneRegistry } from "../application/lane-registry.ts";
import { opError } from "../application/requests.ts";
import type { Router } from "../application/router.ts";
import type { Audit } from "./audit.ts";
import { streamFile } from "./files-route.ts";
import type { Logger } from "./log.ts";
import type { NodesStore } from "./nodes-store.ts";
import { parseOpBody } from "./op-body.ts";
import { clearStaleSocket, prepareSocketDir } from "./socket-dir.ts";

export const API_VERSIONS = [CLIENT_API - 1, CLIENT_API].filter(v => v >= 1);

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export type ClientApiDeps = {
  router: Router; connections: Connections; lanes: LaneRegistry; nodes: NodesStore; audit: Audit; events: EventHub; log: Logger;
  eventsBufferBytes?: number;
};
export type ClientApi = { close(): Promise<void> };

const CLIENT = /^[a-z]{1,16}$/;
// The client that asks, as it names itself; anything else is "unknown" (the socket is the owner's anyway, spec 8).
const clientOf = (req: IncomingMessage): string => {
  const h = req.headers["x-morndo-client"];
  return typeof h === "string" && CLIENT.test(h) ? h : "unknown";
};

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

// A body that isn't JSON, by its content type or its content, is 415 (RFC 9110 §15.5.16: the format problem "might be
// due to the request's indicated Content-Type ... or as a result of inspecting the data directly", read 2026-10-06);
// one over LIMITS.maxPayload is 413.
async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "send the body as JSON, with content-type application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > LIMITS.maxPayload) throw new HttpError(413, `the body is over ${LIMITS.maxPayload} bytes`);
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; } catch { throw new HttpError(415, "the body is not JSON"); }
}

// The route's segments after the version, each decoded once; null when the version isn't one this service speaks.
function segments(url: string | undefined): string[] | null {
  const raw = (url ?? "/").split("?")[0] ?? "/";
  let parts: string[];
  try { parts = raw.split("/").slice(1).map(s => decodeURIComponent(s)); } catch { throw new HttpError(400, "bad URL encoding"); }
  const version = /^v(\d+)$/.exec(parts[0] ?? "");
  if (!version || !API_VERSIONS.includes(Number(version[1]))) return null;
  return parts.slice(1);
}

export async function startClientApi(socketPath: string, d: ClientApiDeps): Promise<ClientApi> {
  prepareSocketDir(socketPath);
  await clearStaleSocket(socketPath);
  const eventsBufferBytes = d.eventsBufferBytes ?? LIMITS.eventsBufferBytes;

  async function route(req: IncomingMessage, res: ServerResponse, s: string[]): Promise<void> {
    const method = req.method ?? "GET";
    const [first, second, third] = s;
    if (method === "GET" && s.length === 1 && first === "caps") return json(res, 200, { api: API_VERSIONS });
    if (method === "GET" && s.length === 1 && first === "nodes") return json(res, 200, d.connections.list());
    if (method === "POST" && s.length === 3 && first === "nodes" && third === "revoke") {
      const name = second ?? "";
      if (!NODE_NAME.test(name)) throw new HttpError(400, "not a node name");
      const revoked = d.nodes.revoke(name);
      if (revoked) d.audit.record("client", "node.revoke", name, { client: clientOf(req) });
      d.connections.revoke(name);                                     // closes it, and its lanes go (serve.ts)
      return json(res, 200, { ok: true, revoked });
    }
    if (method === "GET" && s.length === 1 && first === "lanes") return json(res, 200, d.lanes.list());
    if (method === "GET" && s.length === 2 && first === "lanes") {
      const lane = d.lanes.get(second ?? "");
      return lane ? json(res, 200, lane) : json(res, 404, { error: "no_such_lane" });
    }
    if (method === "GET" && s.length === 1 && first === "alerts") return json(res, 200, d.audit.recentAlerts());
    if (method === "POST" && s.length === 1 && first === "op") {
      // Every answer here has the op's shape, refusals of the body included: clients read the body, not the status.
      let body: unknown;
      try { body = await readJson(req); }
      catch (e) {
        if (!(e instanceof HttpError)) throw e;
        return json(res, e.status, { ok: false, error: opError(e.status === 413 ? "too_large" : "bad_args", e.message), store: null });
      }
      const parsed = parseOpBody(body);
      if (!parsed.ok) return json(res, 400, { ok: false, error: opError("bad_args", parsed.message), store: null });
      const b = parsed.body;
      const outcome = await d.router.op(b.target, b.op, b.args, {
        client: clientOf(req), ...(b.key === undefined ? {} : { key: b.key }), ...(b.timeoutMs === undefined ? {} : { timeoutMs: b.timeoutMs }),
      });
      return json(res, 200, outcome);
    }
    if (method === "GET" && s.length === 3 && first === "files") return streamFile(res, d.router, second ?? "", third ?? "");
    throw new HttpError(404, "no such route");
  }

  // Each request is handled to its end here, with its own catch, so the promise is dropped on purpose.
  const server = createServer((req, res) => void handle(req, res));
  async function handle(req: IncomingMessage, res: ServerResponse) {
    try {
      const s = segments(req.url);
      if (s === null) return json(res, 404, { error: "unsupported_api", api: API_VERSIONS });
      await route(req, res, s);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) d.log.error(`client API: ${req.method ?? "?"} failed`, e);
      if (!res.headersSent) json(res, status, { error: status === 500 ? "internal error" : (e as Error).message });
      else res.destroy();
    }
  }

  // WS /v1/events: every registered node's status first, then each online node's latest inventory and health, then
  // each event as it happens. A client that doesn't read keeps its events in our memory (ws's bufferedAmount): past
  // eventsBufferBytes it is closed with 1013 and unsubscribed, and gets the current state again when it reconnects.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  const clients = new Set<WebSocket>();
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());
    let s: string[] | null;
    try { s = segments(req.url); } catch { s = null; }
    if (!s || s.length !== 1 || s[0] !== "events") { socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      clients.add(ws);
      let unsubscribe = () => {};
      const send = (e: FleetEvent) => {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > eventsBufferBytes) {
          unsubscribe();
          d.log.warn(`events socket: a client is ${ws.bufferedAmount} bytes behind; closing it (1013)`);
          ws.close(1013, "too far behind; reconnect for the current state");
          return;
        }
        ws.send(JSON.stringify(e));
      };
      const nodes = d.connections.list();
      for (const n of nodes) send({ t: "status", node: n.name, body: { status: n.status } });
      for (const n of nodes.filter(x => x.status === "online")) {
        const latest = d.connections.latest(n.name);
        if (latest.inventory) send({ t: "inventory", node: n.name, body: latest.inventory });
        if (latest.health) send({ t: "health", node: n.name, body: latest.health });
      }
      unsubscribe = d.events.subscribe(send);
      ws.on("error", e => d.log.warn(`events socket: ${e.message}`));
      ws.on("close", () => { clients.delete(ws); unsubscribe(); });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => { server.off("error", reject); resolve(); });
  });
  chmodSync(socketPath, 0o600);
  return {
    close: () => new Promise<void>(resolve => {
      for (const ws of clients) ws.terminate();
      wss.close();
      server.close(() => {
        try { unlinkSync(socketPath); } catch { /* already gone */ }
        resolve();
      });
      server.closeAllConnections();
    }),
  };
}
```

- [ ] **Step 11: Wire the registry, the router and the client API into the service; exit 78 for an unsafe or busy socket**

Replace the whole of `apps/fleet/src/serve.ts` with:

```ts
// The fleet service, wired (ADR-0012): its key, fleet.db, the node registry, the audit, the live connections, the
// lane registry and router, the agent endpoint and the client API. `morndo-fleet serve` runs it; tests start it on
// port 0 with temporary paths. The socket directory is checked first, so an unsafe one stops the service before it
// opens anything. Every alert the audit records is also an `alert` event. Audit rows older than 90 days go on start
// and daily. A revoked node's lanes go whichever way it was revoked (the client API, or the console writing fleet.db).
import type Database from "better-sqlite3";
import type { Pane } from "@morndo/protocol";
import type { FleetConfig } from "./config.ts";
import { Audit } from "./adapters/audit.ts";
import { startClientApi } from "./adapters/client-api.ts";
import { openFleetDb } from "./adapters/db.ts";
import { loadOrCreateFleetKey, type FleetKey } from "./adapters/keys.ts";
import { LanesStore } from "./adapters/lanes-store.ts";
import { log as defaultLog, type Logger } from "./adapters/log.ts";
import { NodesStore } from "./adapters/nodes-store.ts";
import type { BucketConfig } from "./adapters/rate-limit.ts";
import { prepareSocketDir } from "./adapters/socket-dir.ts";
import { startAgentEndpoint } from "./adapters/agent-endpoint.ts";
import { Connections } from "./application/connections.ts";
import { EventHub } from "./application/events.ts";
import { LaneRegistry } from "./application/lane-registry.ts";
import { Router } from "./application/router.ts";

export const AUDIT_PRUNE_EVERY_MS = 86_400_000;

export type FleetOptions = {
  log?: Logger; now?: () => number; pingMs?: number; agentLimits?: BucketConfig; handshakeLimits?: BucketConfig; handshakeMs?: number;
  resultSlackMs?: number; instancePongMs?: number; eventsBufferBytes?: number;
};

export type Fleet = {
  config: FleetConfig; db: Database.Database; key: FleetKey; nodes: NodesStore; audit: Audit; events: EventHub;
  connections: Connections; lanes: LaneRegistry; router: Router; agentPort: number; close(): Promise<void>;
};

export async function startFleet(config: FleetConfig, o: FleetOptions = {}): Promise<Fleet> {
  const log = o.log ?? defaultLog;
  const now = o.now ?? Date.now;
  prepareSocketDir(config.socketPath);
  const key = loadOrCreateFleetKey(config.keyPath);
  const db = openFleetDb(config.dbPath);
  const nodes = new NodesStore(db, now);
  const events = new EventHub(e => log.error("an event subscriber failed", e));
  const audit = new Audit(db, { now, log, onAlert: a => events.emit({ t: "alert", node: a.node ?? "", body: a }) });
  const pruneAudit = () => { const n = audit.prune(); if (n > 0) log.info(`audit: removed ${n} rows older than 90 days`); };
  pruneAudit();
  const active = nodes.list().filter(n => n.revokedAt === null).map(n => n.name);
  const lanes = new LaneRegistry({ store: new LanesStore(db), events, audit, activeNodes: active, now });
  const connections = new Connections({
    nodes, audit, events, log, now, onRevoked: node => lanes.dropNode(node), ...(o.pingMs === undefined ? {} : { pingMs: o.pingMs }),
    ...(o.resultSlackMs === undefined ? {} : { resultSlackMs: o.resultSlackMs }), ...(o.instancePongMs === undefined ? {} : { instancePongMs: o.instancePongMs }),
  });
  events.subscribe(e => { if (e.t === "inventory") lanes.inventory(e.node, (e.body as { panes: Pane[] }).panes); });
  const router = new Router({ connections, lanes, audit });
  const agents = startAgentEndpoint({
    host: config.listen.host, port: config.listen.port, deps: { connections, nodes, audit, fleetKey: key, hooks: null, log },
    ...(o.agentLimits ? { limits: o.agentLimits } : {}), ...(o.handshakeLimits ? { handshakeLimits: o.handshakeLimits } : {}),
    ...(o.handshakeMs === undefined ? {} : { handshakeMs: o.handshakeMs }),
  });
  let api;
  try {
    await agents.ready;
    api = await startClientApi(config.socketPath, {
      router, connections, lanes, nodes, audit, events, log, ...(o.eventsBufferBytes === undefined ? {} : { eventsBufferBytes: o.eventsBufferBytes }),
    });
  } catch (e) {
    await agents.close();
    db.close();
    throw e;
  }
  connections.start();
  const retention = setInterval(pruneAudit, AUDIT_PRUNE_EVERY_MS);
  const clientApi = api;
  return {
    config, db, key, nodes, audit, events, connections, lanes, router, agentPort: agents.port(),
    close: async () => {
      clearInterval(retention);
      connections.stop();
      await clientApi.close();
      await agents.close();
      db.close();
    },
  };
}
```

In `apps/fleet/src/main.ts`, replace:

```ts
import { socketRequest } from "./adapters/socket-request.ts";
```

with:

```ts
import { socketRequest } from "./adapters/socket-request.ts";
import { SocketDirUnsafe, SocketInUse } from "./adapters/socket-dir.ts";
```

In `apps/fleet/src/main.ts`, replace:

```ts
    if (e instanceof KeyFileUnsafe) return fail(e.message, EXIT_CONFIG);
    throw e;
  });
```

with:

```ts
    if (e instanceof KeyFileUnsafe || e instanceof SocketDirUnsafe || e instanceof SocketInUse) return fail(e.message, EXIT_CONFIG);
    throw e;
  });
```

- [ ] **Step 12: Run them and see them pass**

Run: `npx vitest run apps/fleet/test/socket-dir.test.ts apps/fleet/test/router.test.ts apps/fleet/test/client-api.test.ts`
Expected: PASS (31 tests)

Then check that each new rule bites, each change restored before the next:
- The name reservation: in `router.ts`, change `    if (this.#reserved(name)) return refuse(` to `    if (false && this.#reserved(name)) return refuse(`. Expected: 1 failure in `router.test.ts`, "lane.start reserves its name…" (the second start is sent to `mac`).
- The audit of ops: in `router.ts`, change `    if (SIDE_EFFECT_OPS.has(op)) {` to `    if (false) {`. Expected: 1 failure in `router.test.ts` and 1 in `client-api.test.ts`.
- Routing by a name in conflict: in `router.ts`, change `      if (r.kind === "conflict") return refuse(` to `      if (r.kind === "conflict" && false) return refuse(`. Expected: 1 failure in each of `router.test.ts` and `client-api.test.ts`.
- A worker ID held back by its name's conflict: in `router.ts`, after `      workerId = target.workerId;` add `      if (this.#lanes.list().some(l => l.conflict)) return refuse(failed("lane_conflict", "a name is in conflict"));`. Expected: 1 failure in each of `router.test.ts` and `client-api.test.ts` ("…each pane is still reachable by its worker ID").
- The events cap: in `client-api.ts`, change `        if (ws.bufferedAmount > eventsBufferBytes) {` to `        if (false) {`. Expected: 1 failure, "an events client that falls too far behind is closed with 1013…" (it times out waiting for the close).
- A revocation of an offline node: in `connections.ts`, delete the line `    for (const n of this.#nodes.list()) if (n.revokedAt !== null && …) this.revoke(n.name);`. Expected: 1 failure, "a revocation written to fleet.db while the node is offline…" (its lane is still listed).
- `store: null` on a refused body: in `client-api.ts`, drop `, store: null` from the 400 answer. Expected: 1 failure, "POST /v1/op answers the outcome…".

- [ ] **Step 13: Run the whole fleet suite, the types and the lint**

Run each in turn, from the repository root:
- `npx tsc -p apps/fleet`. Expected: no output, exit 0.
- `npx tsc -p tsconfig.tests.json`. Expected: no output, exit 0.
- `npx oxlint apps/fleet`. Expected: no output, exit 0.
- `npx vitest run apps/fleet/test`. Expected: PASS (118 tests in 18 files).

- [ ] **Step 14: Commit**

```bash
git add apps/fleet/src/adapters/socket-dir.ts apps/fleet/src/application/router.ts apps/fleet/src/adapters/op-body.ts apps/fleet/src/adapters/files-route.ts apps/fleet/src/adapters/client-api.ts apps/fleet/src/serve.ts apps/fleet/src/main.ts apps/fleet/test/helpers/socket-client.ts apps/fleet/test/socket-dir.test.ts apps/fleet/test/router.test.ts apps/fleet/test/client-api.test.ts
git commit -m "feat(fleet): op router and the /v1 client API on an owner-checked Unix socket"
```

### Task 13: The hook bus: intake before the ack, ordered delivery, dead letters

**Files:**
- Create: `apps/fleet/src/adapters/outbox-store.ts`, `apps/fleet/src/application/hook-intake.ts`, `apps/fleet/src/application/delivery.ts`
- Modify: `apps/fleet/src/serve.ts` (whole file)
- Modify: `apps/fleet/src/main.ts` (`status` prints the hook bus per subscriber)
- Test: `apps/fleet/test/helpers/subscriber.ts`, `apps/fleet/test/helpers/spool.ts`, `apps/fleet/test/hook-intake.test.ts`,
  `apps/fleet/test/delivery.test.ts`, `apps/fleet/test/hook-stream.test.ts`, `apps/fleet/test/status.test.ts`

**Interfaces:**
- Consumes:
  - **Task 1:** `LIMITS` (`outboxKeepMs`, `deadLetterAttempts`, `subscriberBacklog`, `replayWindow`) and `HookEvent`.
  - **Task 10:** `Subscriber`, `HOOK_PATHS`, `Audit`, `Logger`.
  - **Task 11:** `HookSink`, which `runSession` calls. `known()` answers the welcome's `ackSeq` and `streamKnown`;
    `accept()` commits a batch, and its return is acked.
  - **Tasks 11 and 12:** `startFleet` and the test helpers.
- Produces:
  - `adapters/outbox-store.ts`:
    - `type Delivery = { outboxId; subscriber; node; streamId; seq; path; body: string; attempts; nextAt }`
    - `class OutboxStore`:
      - `hwm(node, streamId): { seq; known }`
      - `accept(node, streamId, events, route, { now, cap }): { seq; stored; duplicates; overflow }`
      - `heads(subscriber)`, `next(subscriber, node, streamId)`
      - `delivered`, `retry`, `deadLetter`
      - `pendingCount`, `states(subscriber): Record<string, number>`, `deadLetters(subscriber?)`,
        `summary(subscriber): { pending; dead; latest: { at; reason } | null }` (for `status`)
      - `forgetSubscribersExcept(names)`, `gc(now, keepMs)`, `pruneDeadLetters(before)`
  - `application/hook-intake.ts`:
    - `class HookIntake implements HookSink { constructor({ store, subscribers, audit, now?, cap?, onStored? }) }`
  - `application/delivery.ts`:
    - `class DeliveryWorker`: one `dead_letter` alert per subscriber episode (until a delivery to it succeeds)
      - `constructor({ store, subscribers, audit, log, post?, now?, random?, backoff?, tickMs? })`
      - `start()`, `stop(): Promise<void>`, `kick()`, `runOnce(): number`, `gc()`
    - `type Post`, `httpPost`, `BACKOFF`, `POST_TIMEOUT_MS`, `DEAD_LETTER_KEEP_MS`
  - `serve.ts`:
    - `Fleet` gains `outbox: OutboxStore` and `delivery: DeliveryWorker`.
    - `FleetOptions` gains `hookBacklog?` and `delivery?: { post?; backoff?; tickMs?; random? }`.
    - The agent endpoint now acks hook events.
  - The wire format to subscribers: `POST <subscriber url>` with the body `JSON.stringify(HookEvent)` and the headers
    `content-type: application/json` and `idempotency-key: <node>:<streamId>:<seq>`. kira consumes this in sub-project 2.
  - `morndo-fleet status` (Steps 15–18) prints, per configured subscriber, `<name>  <n> waiting  <n> dead letters`, with
    the latest dead letter's time and reason.
  - Test helpers:
    - `startSubscriber(respond?): Promise<TestSubscriber>`, with `url`, `received`, `handled` (deduplicated by key) and
      `respond`.
    - `class Spool { constructor(last, pathOf?); replay(agent, { upTo?, window?, ms? }): Promise<number> }`.

- [ ] **Step 1: Write the failing intake test**

Create `apps/fleet/test/hook-intake.test.ts`:

```ts
// The hook bus's intake (spec 5.4, 5.6, 9 "Stream"): events above the stream's mark are stored for the subscribers
// whose paths take them, in the one transaction that raises the mark; duplicates are skipped; seqs may skip; a new
// streamId starts fresh. Negative control: without streamId tracking, a reset agent's events are dropped. Backlog
// cap: progress events (/cc, /sl) give way first, then dead letters and one alert.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HookEvent } from "@morndo/protocol";
import type { Subscriber } from "../src/config.ts";
import { Audit } from "../src/adapters/audit.ts";
import { openFleetDb } from "../src/adapters/db.ts";
import { OutboxStore } from "../src/adapters/outbox-store.ts";
import { HookIntake } from "../src/application/hook-intake.ts";
import { tempDir } from "./helpers/temp.ts";

const ev = (streamId: string, seq: number, path: HookEvent["path"] = "/hook/stop"): HookEvent =>
  ({ streamId, seq, at: 1_700_000_000_000 + seq, path, node: "pc", window: "api", body: { seq } });
const ALL: Subscriber = { name: "kira", url: "http://127.0.0.1:1/hooks", paths: ["/cc", "/sl", "/hook/stop", "/hook/failure", "/notify", "/file"] };
const STOPS: Subscriber = { name: "stops", url: "http://127.0.0.1:2/hooks", paths: ["/hook/stop"] };

function setup(subscribers: Subscriber[] = [ALL, STOPS], cap?: number) {
  const db = openFleetDb(join(tempDir(), "fleet.db"));
  const store = new OutboxStore(db);
  const audit = new Audit(db);
  let stored = 0;
  const intake = new HookIntake({ store, subscribers, audit, onStored: () => { stored++; }, ...(cap === undefined ? {} : { cap }) });
  const outbox = () => (db.prepare("SELECT stream_id, seq, path FROM outbox ORDER BY id").all() as { stream_id: string; seq: number; path: string }[]).map(r => `${r.stream_id}:${r.seq}${r.path}`);
  return { db, store, audit, intake, outbox, kicks: () => stored };
}

describe("hook intake", () => {
  it("stores each event once for the subscribers whose paths take it, and returns the stream's mark", () => {
    const { intake, store, outbox, kicks } = setup();
    expect(intake.known("pc", "s1")).toEqual({ seq: 0, known: false });
    expect(intake.accept("pc", "s1", [ev("s1", 1), ev("s1", 2, "/cc")])).toBe(2);
    expect(intake.accept("pc", "s1", [ev("s1", 2, "/cc"), ev("s1", 3)])).toBe(3);    // 2 again: a replay after a lost ack
    expect(intake.known("pc", "s1")).toEqual({ seq: 3, known: true });
    expect(outbox()).toEqual(["s1:1/hook/stop", "s1:2/cc", "s1:3/hook/stop"]);
    expect(store.states("kira")).toEqual({ pending: 3 });
    expect(store.states("stops")).toEqual({ pending: 2 });                            // /cc isn't one of its paths
    expect(kicks()).toBe(2);
  });

  it("takes a stream whose seqs skip (the agent coalesced progress events) and moves the mark past unsubscribed events", () => {
    const { intake, outbox } = setup([STOPS]);
    expect(intake.accept("pc", "s1", [ev("s1", 1), ev("s1", 4, "/cc"), ev("s1", 9)])).toBe(9);
    expect(outbox()).toEqual(["s1:1/hook/stop", "s1:9/hook/stop"]);
    expect(intake.accept("pc", "s1", [ev("s1", 5)])).toBe(9);                          // below the mark: a duplicate
    expect(outbox()).toHaveLength(2);
  });

  it("a reset agent's new stream is delivered from seq 1; without streamId tracking it would be dropped", () => {
    const { intake, outbox } = setup([STOPS]);
    intake.accept("pc", "old", [1, 2, 3, 4, 5].map(n => ev("old", n)));
    expect(intake.known("pc", "new")).toEqual({ seq: 0, known: false });
    expect(intake.accept("pc", "new", [1, 2, 3].map(n => ev("new", n)))).toBe(3);
    expect(outbox().filter(r => r.startsWith("new:"))).toEqual(["new:1/hook/stop", "new:2/hook/stop", "new:3/hook/stop"]);
    // Negative control: one mark per node (the stream ignored) takes the reset's seqs 1..3 for duplicates of 1..5.
    const control = setup([STOPS]);
    control.intake.accept("pc", "node-wide", [1, 2, 3, 4, 5].map(n => ev("old", n)));
    control.intake.accept("pc", "node-wide", [1, 2, 3].map(n => ev("new", n)));
    expect(control.outbox().filter(r => r.startsWith("node-wide:")).map(r => r.split(":")[1])).toEqual(["1/hook/stop", "2/hook/stop", "3/hook/stop", "4/hook/stop", "5/hook/stop"]);
    expect(control.db.prepare("SELECT COUNT(*) AS n FROM outbox").get()).toEqual({ n: 5 });   // the 3 new events: dropped
  });

  it("stores a batch and raises the mark in one transaction: a failure part way keeps neither", () => {
    const { store, outbox } = setup();
    let calls = 0;
    const route = () => { if (++calls === 3) throw new Error("disk full"); return ["kira"]; };
    expect(() => store.accept("pc", "s1", [1, 2, 3].map(n => ev("s1", n)), route, { now: 1, cap: 100 })).toThrow(/disk full/);
    expect(store.hwm("pc", "s1")).toEqual({ seq: 0, known: false });
    expect(outbox()).toEqual([]);
  });

  it("a full backlog drops the oldest progress events first, then dead-letters new ones with one alert", () => {
    const NOTES: Subscriber = { name: "notes", url: "http://127.0.0.1:3/hooks", paths: ["/notify"] };
    const { intake, store, audit } = setup([ALL, NOTES], 4);
    intake.accept("pc", "s1", [ev("s1", 1, "/cc"), ev("s1", 2, "/sl"), ev("s1", 3), ev("s1", 4)]);
    expect(store.pendingCount("kira")).toBe(4);
    intake.accept("pc", "s1", [ev("s1", 5)]);                                          // drops /cc 1
    intake.accept("pc", "s1", [ev("s1", 6)]);                                          // drops /sl 2
    expect(store.states("kira")).toEqual({ pending: 4, dropped: 2 });
    expect(audit.of("alert.backlog_full")).toEqual([]);
    intake.accept("pc", "s1", [ev("s1", 7), ev("s1", 8, "/notify")]);                 // nothing left to drop
    expect(store.states("kira")).toEqual({ pending: 4, dropped: 2, dead: 2 });
    expect(store.deadLetters("kira").map(d => [d.seq, d.reason])).toEqual([[7, "backlog_full"], [8, "backlog_full"]]);
    intake.accept("pc", "s1", [ev("s1", 9)]);
    expect(audit.of("alert.backlog_full")).toHaveLength(1);                             // one alert while it stays full
    expect(store.states("notes")).toEqual({ pending: 1 });                              // another subscriber's own backlog
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `npx vitest run apps/fleet/test/hook-intake.test.ts`
Expected: FAIL: `Error: Cannot find module '../src/adapters/outbox-store.ts'`

- [ ] **Step 3: Implement the outbox store and the intake**

Create `apps/fleet/src/adapters/outbox-store.ts`:

```ts
// The hook bus's tables (spec 5.4, 5.6, 6): the highest accepted seq per (node, streamId), the outbox of events,
// one delivery row per subscriber, and dead letters. A delivery's delivered_at is when it reached a final state
// (delivered, dead or dropped); an outbox row goes LIMITS.outboxKeepMs after its last delivery's final state.
import type Database from "better-sqlite3";
import type { HookEvent } from "@morndo/protocol";

export type Delivery = {
  outboxId: number; subscriber: string; node: string; streamId: string; seq: number; path: string; body: string; attempts: number; nextAt: number;
};
export type DeadLetter = { subscriber: string; node: string; streamId: string; seq: number; path: string; body: string; reason: string; attempts: number; at: number };
export type Accepted = { seq: number; stored: number; duplicates: number; overflow: Map<string, { dropped: number; deadLettered: number }> };

const COALESCIBLE = ["/cc", "/sl"];                      // progress events: only the latest per session matters
type Row = { outbox_id: number; subscriber: string; node: string; stream_id: string; seq: number; path: string; body: string; attempts: number; next_at: number };
const deliveryFrom = (r: Row): Delivery => ({
  outboxId: r.outbox_id, subscriber: r.subscriber, node: r.node, streamId: r.stream_id, seq: r.seq, path: r.path, body: r.body, attempts: r.attempts, nextAt: r.next_at,
});
const SELECT = `SELECT d.outbox_id, d.subscriber, d.attempts, d.next_at, o.node, o.stream_id, o.seq, o.path, o.body
  FROM deliveries d JOIN outbox o ON o.id = d.outbox_id`;

export class OutboxStore {
  #db: Database.Database;
  constructor(db: Database.Database) { this.#db = db; }

  hwm(node: string, streamId: string): { seq: number; known: boolean } {
    const r = this.#db.prepare("SELECT seq FROM stream_hwm WHERE node = ? AND stream_id = ?").get(node, streamId) as { seq: number } | undefined;
    return r ? { seq: r.seq, known: true } : { seq: 0, known: false };
  }

  // One transaction: every event above the stream's mark is stored for the subscribers `route` names, and the mark
  // rises to the last one. Seqs may skip (the agent coalesces progress events); an event at or below the mark is a
  // duplicate. A subscriber at `cap` pending deliveries loses its oldest pending progress event; with none to lose,
  // the new event goes straight to its dead letters (reason backlog_full).
  accept(node: string, streamId: string, events: HookEvent[], route: (e: HookEvent) => string[], o: { now: number; cap: number }): Accepted {
    return this.#db.transaction((): Accepted => {
      let seq = this.hwm(node, streamId).seq;
      let stored = 0;
      let duplicates = 0;
      const overflow = new Map<string, { dropped: number; deadLettered: number }>();
      const insertOutbox = this.#db.prepare("INSERT INTO outbox (node, stream_id, seq, path, body, created_at) VALUES (?, ?, ?, ?, ?, ?)");
      const insertDelivery = this.#db.prepare("INSERT INTO deliveries (outbox_id, subscriber, state, attempts, next_at, delivered_at) VALUES (?, ?, ?, 0, ?, ?)");
      for (const e of events) {
        if (e.seq <= seq) { duplicates++; continue; }
        seq = e.seq;
        const subscribers = route(e);
        if (subscribers.length === 0) continue;
        const body = JSON.stringify(e);
        const id = Number(insertOutbox.run(node, streamId, e.seq, e.path, body, o.now).lastInsertRowid);
        for (const s of subscribers) {
          if (this.pendingCount(s) >= o.cap) {
            const over = overflow.get(s) ?? { dropped: 0, deadLettered: 0 };
            overflow.set(s, over);
            if (this.#dropOldestCoalescible(s, o.now)) over.dropped++;
            else {
              over.deadLettered++;
              insertDelivery.run(id, s, "dead", o.now, o.now);
              this.#insertDead({ subscriber: s, node, streamId, seq: e.seq, path: e.path, body, reason: "backlog_full", attempts: 0, at: o.now });
              continue;
            }
          }
          insertDelivery.run(id, s, "pending", o.now, null);
        }
        stored++;
      }
      this.#db.prepare(`INSERT INTO stream_hwm (node, stream_id, seq) VALUES (?, ?, ?)
        ON CONFLICT(node, stream_id) DO UPDATE SET seq = excluded.seq`).run(node, streamId, seq);
      return { seq, stored, duplicates, overflow };
    }).immediate();
  }

  pendingCount(subscriber: string): number {
    return (this.#db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE subscriber = ? AND state = 'pending'").get(subscriber) as { n: number }).n;
  }

  #dropOldestCoalescible(subscriber: string, now: number): boolean {
    return this.#db.prepare(`UPDATE deliveries SET state = 'dropped', delivered_at = ? WHERE rowid = (
      SELECT d.rowid FROM deliveries d JOIN outbox o ON o.id = d.outbox_id
      WHERE d.subscriber = ? AND d.state = 'pending' AND o.path IN (${COALESCIBLE.map(() => "?").join(", ")}) ORDER BY d.outbox_id LIMIT 1)`)
      .run(now, subscriber, ...COALESCIBLE).changes > 0;
  }

  // The first pending delivery of each (node, stream) for a subscriber: SQLite takes a bare column's value from the
  // row that holds the min() (https://www.sqlite.org/lang_select.html#bareagg, read 2026-10-06).
  heads(subscriber: string): Delivery[] {
    return (this.#db.prepare(`SELECT d.outbox_id, d.subscriber, d.attempts, d.next_at, o.node, o.stream_id, MIN(o.seq) AS seq, o.path, o.body
      FROM deliveries d JOIN outbox o ON o.id = d.outbox_id
      WHERE d.subscriber = ? AND d.state = 'pending' GROUP BY o.node, o.stream_id`).all(subscriber) as Row[]).map(deliveryFrom);
  }

  // The next pending delivery of one stream for a subscriber, in seq order.
  next(subscriber: string, node: string, streamId: string): Delivery | null {
    const r = this.#db.prepare(`${SELECT} WHERE d.subscriber = ? AND o.node = ? AND o.stream_id = ? AND d.state = 'pending' ORDER BY o.seq LIMIT 1`)
      .get(subscriber, node, streamId) as Row | undefined;
    return r ? deliveryFrom(r) : null;
  }

  delivered(outboxId: number, subscriber: string, at: number): void {
    this.#db.prepare("UPDATE deliveries SET state = 'delivered', delivered_at = ? WHERE outbox_id = ? AND subscriber = ? AND state = 'pending'").run(at, outboxId, subscriber);
  }

  retry(outboxId: number, subscriber: string, attempts: number, nextAt: number): void {
    this.#db.prepare("UPDATE deliveries SET attempts = ?, next_at = ? WHERE outbox_id = ? AND subscriber = ? AND state = 'pending'").run(attempts, nextAt, outboxId, subscriber);
  }

  deadLetter(d: Delivery, reason: string, attempts: number, at: number): void {
    this.#db.transaction(() => {
      const changed = this.#db.prepare("UPDATE deliveries SET state = 'dead', attempts = ?, delivered_at = ? WHERE outbox_id = ? AND subscriber = ? AND state = 'pending'")
        .run(attempts, at, d.outboxId, d.subscriber).changes;
      if (changed) this.#insertDead({ subscriber: d.subscriber, node: d.node, streamId: d.streamId, seq: d.seq, path: d.path, body: d.body, reason, attempts, at });
    })();
  }

  #insertDead(x: DeadLetter): void {
    this.#db.prepare("INSERT INTO dead_letters (subscriber, node, stream_id, seq, path, body, reason, attempts, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(x.subscriber, x.node, x.streamId, x.seq, x.path, x.body, x.reason, x.attempts, x.at);
  }

  deadLetters(subscriber?: string): DeadLetter[] {
    const rows = (subscriber === undefined ? this.#db.prepare("SELECT * FROM dead_letters ORDER BY id").all()
      : this.#db.prepare("SELECT * FROM dead_letters WHERE subscriber = ? ORDER BY id").all(subscriber)) as (Omit<DeadLetter, "streamId"> & { stream_id: string })[];
    return rows.map(r => ({ subscriber: r.subscriber, node: r.node, streamId: r.stream_id, seq: r.seq, path: r.path, body: r.body, reason: r.reason, attempts: r.attempts, at: r.at }));
  }

  // A subscriber removed from the config: its deliveries and dead letters go.
  forgetSubscribersExcept(names: string[]): number {
    const list = JSON.stringify(names);
    return this.#db.transaction(() =>
      this.#db.prepare("DELETE FROM deliveries WHERE subscriber NOT IN (SELECT value FROM json_each(?))").run(list).changes
      + this.#db.prepare("DELETE FROM dead_letters WHERE subscriber NOT IN (SELECT value FROM json_each(?))").run(list).changes)();
  }

  // Outbox rows with nothing pending whose last delivery ended (or, with no deliveries left, which were stored)
  // before now - keepMs; their deliveries go with them (ON DELETE CASCADE).
  gc(now: number, keepMs: number): number {
    return this.#db.prepare(`DELETE FROM outbox WHERE id IN (
      SELECT o.id FROM outbox o
      WHERE NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.outbox_id = o.id AND d.state = 'pending')
        AND COALESCE((SELECT MAX(d.delivered_at) FROM deliveries d WHERE d.outbox_id = o.id), o.created_at) < ?)`).run(now - keepMs).changes;
  }

  pruneDeadLetters(before: number): number {
    return this.#db.prepare("DELETE FROM dead_letters WHERE at < ?").run(before).changes;
  }

  // For `morndo-fleet status`: what waits for a subscriber, its dead letters, and the latest one.
  summary(subscriber: string): { pending: number; dead: number; latest: { at: number; reason: string } | null } {
    const dead = (this.#db.prepare("SELECT COUNT(*) AS n FROM dead_letters WHERE subscriber = ?").get(subscriber) as { n: number }).n;
    const latest = this.#db.prepare("SELECT at, reason FROM dead_letters WHERE subscriber = ? ORDER BY id DESC LIMIT 1").get(subscriber) as { at: number; reason: string } | undefined;
    return { pending: this.pendingCount(subscriber), dead, latest: latest ?? null };
  }

  states(subscriber: string): Record<string, number> {
    const rows = this.#db.prepare("SELECT state, COUNT(*) AS n FROM deliveries WHERE subscriber = ? GROUP BY state").all(subscriber) as { state: string; n: number }[];
    return Object.fromEntries(rows.map(r => [r.state, r.n]));
  }
}
```

Create `apps/fleet/src/application/hook-intake.ts`:

```ts
// The hook bus's intake (spec 5.4, 5.6): an agent's hook events, deduplicated by (node, streamId, seq) against the
// stream's mark and stored in the outbox, for the subscribers whose `paths` take them, in the same transaction that
// raises the mark. The connection acknowledges the returned mark only after that commit, so an acknowledged event is
// never lost. A new streamId (a reset or reinstalled agent) starts at nothing, so its events are never taken for
// duplicates. A subscriber whose backlog is full raises one alert until it drains below the cap again.
import { LIMITS, type HookEvent } from "@morndo/protocol";
import type { Subscriber } from "../config.ts";
import type { Audit } from "../adapters/audit.ts";
import type { OutboxStore } from "../adapters/outbox-store.ts";
import type { HookSink } from "./hook-sink.ts";

export class HookIntake implements HookSink {
  #store: OutboxStore;
  #subscribers: Subscriber[];
  #audit: Audit;
  #now: () => number;
  #cap: number;
  #onStored: () => void;
  #overflowing = new Set<string>();

  constructor(p: { store: OutboxStore; subscribers: Subscriber[]; audit: Audit; now?: () => number; cap?: number; onStored?: () => void }) {
    this.#store = p.store;
    this.#subscribers = p.subscribers;
    this.#audit = p.audit;
    this.#now = p.now ?? Date.now;
    this.#cap = p.cap ?? LIMITS.subscriberBacklog;
    this.#onStored = p.onStored ?? (() => {});
  }

  known(node: string, streamId: string): { seq: number; known: boolean } {
    return this.#store.hwm(node, streamId);
  }

  accept(node: string, streamId: string, events: HookEvent[]): number {
    const route = (e: HookEvent) => this.#subscribers.filter(s => s.paths.includes(e.path)).map(s => s.name);
    const r = this.#store.accept(node, streamId, events, route, { now: this.#now(), cap: this.#cap });
    for (const name of this.#overflowing) if (this.#store.pendingCount(name) < this.#cap) this.#overflowing.delete(name);
    for (const [name, over] of r.overflow) {
      if (over.deadLettered === 0 || this.#overflowing.has(name)) continue;
      this.#overflowing.add(name);
      this.#audit.alert("backlog_full", node, { subscriber: name, cap: this.#cap, droppedProgress: over.dropped, deadLettered: over.deadLettered });
    }
    if (r.stored > 0) this.#onStored();
    return r.seq;
  }
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `npx vitest run apps/fleet/test/hook-intake.test.ts`
Expected: PASS (5 tests, including the negative control: one mark per node drops a reset agent's events)

- [ ] **Step 5: Commit**

```bash
git add apps/fleet/src/adapters/outbox-store.ts apps/fleet/src/application/hook-intake.ts apps/fleet/test/hook-intake.test.ts
git commit -m "feat(fleet): hook intake that stores before the ack, deduplicated per stream"
```

- [ ] **Step 6: Write the failing delivery test (with the test subscriber)**

Create `apps/fleet/test/helpers/subscriber.ts`:

```ts
// A hook-bus subscriber for tests: a real HTTP server on a random port that records every POST and deduplicates on
// the Idempotency-Key, as a real subscriber must (spec 5.6: at least once; subscribers deduplicate). `respond` picks
// each answer's status (and may hold it back).
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach } from "vitest";

export type Received = { key: string; body: { node: string; streamId: string; seq: number; path: string; body: unknown; late?: true }; contentType: string };
export type TestSubscriber = {
  url: string;
  received: Received[];                                  // every POST, duplicates included
  handled: Map<string, Received>;                         // the first of each key: what the subscriber acts on
  respond: (r: Received, attempt: number) => number | Promise<number>;
  close(): Promise<void>;
};

const open = new Set<TestSubscriber>();
afterEach(async () => { for (const s of open) await s.close(); open.clear(); });

const readAll = async (req: IncomingMessage) => { const c: Buffer[] = []; for await (const x of req) c.push(x as Buffer); return Buffer.concat(c).toString("utf8"); };

export async function startSubscriber(respond: TestSubscriber["respond"] = () => 200): Promise<TestSubscriber> {
  const attempts = new Map<string, number>();
  const server = createServer((req, res) => {
    void (async () => {
      const r: Received = {
        key: String(req.headers["idempotency-key"] ?? ""), body: JSON.parse(await readAll(req)) as Received["body"],
        contentType: String(req.headers["content-type"] ?? ""),
      };
      s.received.push(r);
      if (!s.handled.has(r.key)) s.handled.set(r.key, r);
      const n = (attempts.get(r.key) ?? 0) + 1;
      attempts.set(r.key, n);
      const status = await s.respond(r, n);
      res.writeHead(status).end();
    })().catch(() => res.destroy());
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const s: TestSubscriber = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks`,
    received: [], handled: new Map(), respond,
    close: () => new Promise<void>(r => { server.close(() => r()); server.closeAllConnections(); }),
  };
  open.add(s);
  return s;
}
```

Create `apps/fleet/test/delivery.test.ts`:

```ts
// Hook delivery (spec 5.6): a JSON POST per subscriber with Idempotency-Key <node>:<streamId>:<seq>; seq order per
// stream; exponential backoff on 408, 429, 5xx and no answer; any other 4xx or the 20th failure is a dead letter while
// the other subscribers continue, with one alert per subscriber episode; removed subscribers' rows go; rows go 24 h
// after delivery.
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LIMITS, type HookEvent } from "@morndo/protocol";
import type { Subscriber } from "../src/config.ts";
import { Audit } from "../src/adapters/audit.ts";
import { openFleetDb } from "../src/adapters/db.ts";
import { OutboxStore } from "../src/adapters/outbox-store.ts";
import { DeliveryWorker, type Post } from "../src/application/delivery.ts";
import { HookIntake } from "../src/application/hook-intake.ts";
import { quiet } from "./helpers/fleet.ts";
import { startSubscriber } from "./helpers/subscriber.ts";
import { tempDir } from "./helpers/temp.ts";

const ev = (streamId: string, seq: number, path: HookEvent["path"] = "/hook/stop"): HookEvent =>
  ({ streamId, seq, at: 1_700_000_000_000 + seq, path, node: "pc", window: "api", body: { seq } });
const FAST = { baseMs: 5, maxMs: 40 };

function bus(subscribers: Subscriber[], o: { post?: Post; now?: () => number; db?: ReturnType<typeof openFleetDb> } = {}) {
  const db = o.db ?? openFleetDb(join(tempDir(), "fleet.db"));
  const store = new OutboxStore(db);
  const audit = new Audit(db);
  const worker = new DeliveryWorker({ store, subscribers, audit, log: quiet, backoff: FAST, random: () => 1, tickMs: 10, ...(o.post ? { post: o.post } : {}), ...(o.now ? { now: o.now } : {}) });
  const intake = new HookIntake({ store, subscribers, audit, onStored: () => worker.kick(), ...(o.now ? { now: o.now } : {}) });
  return { db, store, audit, worker, intake };
}
const sub = (name: string, url: string): Subscriber => ({ name, url, paths: ["/cc", "/hook/stop"] });

describe("hook delivery", () => {
  it("POSTs each event as JSON with its idempotency key, and marks it delivered", async () => {
    const kira = await startSubscriber();
    const { intake, worker, store } = bus([sub("kira", kira.url)]);
    worker.start();
    intake.accept("pc", "s1", [ev("s1", 1), ev("s1", 2, "/cc")]);
    await vi.waitFor(() => expect(store.states("kira")).toEqual({ delivered: 2 }));
    expect(kira.received.map(r => [r.key, r.contentType, r.body.seq, r.body.path])).toEqual([
      ["pc:s1:1", "application/json", 1, "/hook/stop"], ["pc:s1:2", "application/json", 2, "/cc"],
    ]);
    expect(kira.received[0]?.body).toEqual(ev("s1", 1));
    await worker.stop();
  });

  it("keeps seq order per stream through retries: 3 waits until 2 is delivered", async () => {
    const kira = await startSubscriber((r, attempt) => (r.body.seq === 2 && attempt < 3 ? 503 : 200));
    const { intake, worker, store } = bus([sub("kira", kira.url)]);
    worker.start();
    intake.accept("pc", "s1", [1, 2, 3, 4].map(n => ev("s1", n)));
    intake.accept("pc", "s2", [1, 2].map(n => ev("s2", n)));
    await vi.waitFor(() => expect(store.states("kira")).toEqual({ delivered: 6 }));
    const order = kira.received.filter(r => r.body.streamId === "s1").map(r => r.body.seq);
    expect(order).toEqual([1, 2, 2, 2, 3, 4]);                                        // never 3 before the last 2
    await worker.stop();
  });

  it("a 400 is a dead letter with an alert at once; that subscriber's next event and the other subscriber continue", async () => {
    const picky = await startSubscriber(r => (r.body.seq === 2 ? 400 : 200));
    const other = await startSubscriber();
    const { intake, worker, store, audit } = bus([sub("picky", picky.url), sub("other", other.url)]);
    worker.start();
    intake.accept("pc", "s1", [1, 2, 3].map(n => ev("s1", n)));
    await vi.waitFor(() => expect(store.states("picky")).toEqual({ delivered: 2, dead: 1 }));
    await vi.waitFor(() => expect(store.states("other")).toEqual({ delivered: 3 }));
    expect(picky.received.filter(r => r.body.seq === 2)).toHaveLength(1);              // never retried
    expect(store.deadLetters("picky").map(d => [d.seq, d.reason, d.attempts])).toEqual([[2, "HTTP 400", 1]]);
    expect(audit.of("alert.dead_letter").map(a => a.detail)).toEqual([expect.objectContaining({ subscriber: "picky", seq: 2, reason: "HTTP 400" })]);
    await worker.stop();
  });

  it("one dead_letter alert per subscriber episode: the first dead letter after a successful delivery raises the next one", async () => {
    const picky = await startSubscriber(r => ([2, 3, 4, 6].includes(r.body.seq) ? 400 : 200));
    const { intake, worker, store, audit } = bus([sub("picky", picky.url)]);
    worker.start();
    intake.accept("pc", "s1", [2, 3, 4].map(n => ev("s1", n)));                       // three dead letters in a row
    await vi.waitFor(() => expect(store.states("picky")).toEqual({ dead: 3 }));
    expect(audit.of("alert.dead_letter").map(a => a.detail.seq)).toEqual([2]);       // negative control: one per dead letter gives 3
    intake.accept("pc", "s1", [5, 6].map(n => ev("s1", n)));                          // 5 is delivered, so 6 starts a new episode
    await vi.waitFor(() => expect(store.states("picky")).toEqual({ dead: 4, delivered: 1 }));
    expect(audit.of("alert.dead_letter").map(a => a.detail.seq)).toEqual([2, 6]);
    expect(store.deadLetters("picky").map(d => d.seq)).toEqual([2, 3, 4, 6]);        // every dead letter is kept
    await worker.stop();
  });

  it("retries 408, 429, 5xx and no answer; the 20th failure is a dead letter", async () => {
    const statuses = [408, 429, 500, 503];
    const flaky = await startSubscriber((_r, attempt) => statuses[attempt - 1] ?? 200);
    const down = await startSubscriber(() => 503);
    const { intake, worker, store } = bus([sub("flaky", flaky.url), sub("down", down.url), sub("gone", "http://127.0.0.1:9/hooks")]);
    worker.start();
    intake.accept("pc", "s1", [ev("s1", 1)]);
    await vi.waitFor(() => expect(store.states("flaky")).toEqual({ delivered: 1 }));
    await vi.waitFor(() => expect(store.states("down")).toEqual({ dead: 1 }), { timeout: 10_000 });
    await vi.waitFor(() => expect(store.states("gone")).toEqual({ dead: 1 }), { timeout: 10_000 });
    expect(down.received).toHaveLength(LIMITS.deadLetterAttempts);
    expect(store.deadLetters("down")[0]).toMatchObject({ reason: "HTTP 503", attempts: 20 });
    expect(store.deadLetters("gone")[0]?.reason).toMatch(/^no answer/);
    await worker.stop();
  });

  it("a retry time beyond the longest backoff (a clock that jumped back) is due at once", async () => {
    let now = 1_800_000_000_000;
    const kira = await startSubscriber();
    const { intake, worker, store } = bus([sub("kira", kira.url)], { now: () => now });
    intake.accept("pc", "s1", [ev("s1", 1)]);
    const d = store.next("kira", "pc", "s1");
    store.retry(d?.outboxId ?? 0, "kira", 1, now + 30);                               // due in 30 ms: not yet
    expect(worker.runOnce()).toBe(0);
    now -= 3_600_000;                                                                  // the clock steps back an hour
    expect(worker.runOnce()).toBe(1);
    await vi.waitFor(() => expect(store.states("kira")).toEqual({ delivered: 1 }));
    await worker.stop();
  });

  it("a subscriber removed from the config has its rows deleted on start", async () => {
    const kira = await startSubscriber(() => 503);
    const first = bus([sub("kira", kira.url), sub("old", "http://127.0.0.1:9/hooks")]);
    first.intake.accept("pc", "s1", [ev("s1", 1)]);
    expect(first.store.states("old")).toEqual({ pending: 1 });
    const after = bus([sub("kira", kira.url)], { db: first.db });
    after.worker.start();
    expect(after.store.states("old")).toEqual({});
    expect(after.audit.of("subscriber.removed").map(a => a.detail)).toEqual([{ rows: 1 }]);
    await after.worker.stop();
  });

  it("deletes an event 24 h after its last delivery, and never one still pending", async () => {
    let now = 1_800_000_000_000;
    const kira = await startSubscriber();
    const { intake, worker, store, db } = bus([sub("kira", kira.url), sub("down", "http://127.0.0.1:9/hooks")], { now: () => now });
    intake.accept("pc", "s1", [ev("s1", 1)]);
    intake.accept("pc", "s2", [ev("s2", 1, "/sl")]);                                   // nobody takes /sl: never stored
    const d = store.next("kira", "pc", "s1");
    store.delivered(d?.outboxId ?? 0, "kira", now);
    now += LIMITS.outboxKeepMs + 1;
    worker.gc();
    expect(db.prepare("SELECT COUNT(*) AS n FROM outbox").get()).toEqual({ n: 1 });    // "down" still has it pending
    const dd = store.next("down", "pc", "s1");
    if (!dd) throw new Error("no delivery for down");
    store.deadLetter(dd, "HTTP 410", 1, now);
    now += LIMITS.outboxKeepMs + 1;
    worker.gc();
    expect(db.prepare("SELECT COUNT(*) AS n FROM outbox").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM deliveries").get()).toEqual({ n: 0 });
    await worker.stop();
  });

  it("stopping aborts a delivery in flight and leaves it pending for the next start", async () => {
    let release: (s: number) => void = () => {};
    const slow = await startSubscriber(() => new Promise<number>(r => { release = r; }));
    const { intake, worker, store } = bus([sub("slow", slow.url)]);
    worker.start();
    intake.accept("pc", "s1", [ev("s1", 1)]);
    await vi.waitFor(() => expect(slow.received).toHaveLength(1));
    await worker.stop();
    release(200);
    expect(store.states("slow")).toEqual({ pending: 1 });
  });
});
```

- [ ] **Step 7: Run it and see it fail**

Run: `npx vitest run apps/fleet/test/delivery.test.ts`
Expected: FAIL: `Error: Cannot find module '../src/application/delivery.ts'`

- [ ] **Step 8: Implement the delivery worker**

Create `apps/fleet/src/application/delivery.ts`:

```ts
// The hook bus's delivery (spec 5.6): each stored event is POSTed as JSON to each of its subscribers with
// `Idempotency-Key: <node>:<streamId>:<seq>`, at least once, in seq order per (subscriber, node, streamId): one request
// in flight per stream and subscriber, the next only after the previous one is delivered or dead. Streams and
// subscribers don't wait for each other.
//   - 2xx: delivered.
//   - 408, 429, 5xx, no answer: retried with exponential backoff (base·2^(n-1), capped, halved by jitter at most);
//     after LIMITS.deadLetterAttempts attempts, a dead letter.
//   - any other 4xx: a dead letter at once (the subscriber refused it; a retry would be refused too).
//   - A dead letter raises a dead_letter alert once per subscriber episode: the first since that subscriber's last
//     successful delivery (or since start); later ones are kept and counted (`morndo-fleet status`), not alerted, so a
//     subscriber that refuses everything can't bury the other alerts.
// A retry time is stored on the wall clock; one further away than the longest backoff can only come from a clock that
// jumped back, and is due at once (Review Focus 4). On start: rows of subscribers no longer configured are deleted;
// every hour: outbox rows LIMITS.outboxKeepMs after their last delivery, and dead letters as long after they died
// (spec 8: hook bodies are kept only until delivery plus 24 h).
// fetch is Node's built-in (undici): https://nodejs.org/docs/latest-v24.x/api/globals.html#fetch;
// AbortSignal.any/timeout: https://nodejs.org/docs/latest-v24.x/api/globals.html#class-abortsignal (read 2026-10-06).
import { LIMITS } from "@morndo/protocol";
import type { Subscriber } from "../config.ts";
import type { Audit } from "../adapters/audit.ts";
import type { Logger } from "../adapters/log.ts";
import type { Delivery, OutboxStore } from "../adapters/outbox-store.ts";

export type Post = (url: string, body: string, headers: Record<string, string>, signal: AbortSignal) => Promise<number>;
export type Backoff = { baseMs: number; maxMs: number };

export const BACKOFF: Backoff = { baseMs: 1000, maxMs: 600_000 };
export const POST_TIMEOUT_MS = 10_000;
export const DEAD_LETTER_KEEP_MS = LIMITS.outboxKeepMs;
const GC_EVERY_MS = 3_600_000;

export const httpPost: Post = async (url, body, headers, signal) => {
  const r = await fetch(url, { method: "POST", body, headers, redirect: "manual", signal });
  await r.body?.cancel();
  return r.status;
};

const ok = (status: number) => status >= 200 && status < 300;
const permanent = (status: number) => status >= 400 && status < 500 && status !== 408 && status !== 429;

export class DeliveryWorker {
  #store: OutboxStore;
  #subscribers: Subscriber[];
  #audit: Audit;
  #log: Logger;
  #post: Post;
  #now: () => number;
  #random: () => number;
  #backoff: Backoff;
  #tickMs: number;
  #inflight = new Map<string, Promise<void>>();
  #abort = new AbortController();
  #timers: ReturnType<typeof setInterval>[] = [];
  #deadEpisodes = new Set<string>();                    // subscribers alerted since their last successful delivery
  #kicked = false;
  #stopped = false;

  constructor(p: {
    store: OutboxStore; subscribers: Subscriber[]; audit: Audit; log: Logger; post?: Post; now?: () => number; random?: () => number;
    backoff?: Backoff; tickMs?: number;
  }) {
    this.#store = p.store;
    this.#subscribers = p.subscribers;
    this.#audit = p.audit;
    this.#log = p.log;
    this.#post = p.post ?? httpPost;
    this.#now = p.now ?? Date.now;
    this.#random = p.random ?? Math.random;
    this.#backoff = p.backoff ?? BACKOFF;
    this.#tickMs = p.tickMs ?? 1000;
  }

  start(): void {
    const removed = this.#store.forgetSubscribersExcept(this.#subscribers.map(s => s.name));
    if (removed > 0) this.#audit.record("fleet", "subscriber.removed", null, { rows: removed });
    this.gc();
    this.#timers.push(setInterval(() => this.runOnce(), this.#tickMs), setInterval(() => this.gc(), GC_EVERY_MS));
    this.runOnce();
  }

  // Aborts what is in flight (those rows stay pending and go again after a restart) and waits for it to settle.
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const t of this.#timers) clearInterval(t);
    this.#abort.abort();
    await Promise.all(this.#inflight.values());
  }

  // Soon, once, however often it is asked (new events were stored).
  kick(): void {
    if (this.#kicked || this.#stopped) return;
    this.#kicked = true;
    setImmediate(() => { this.#kicked = false; this.runOnce(); });
  }

  // Starts every due head of every stream that has nothing in flight; returns how many started.
  runOnce(): number {
    if (this.#stopped) return 0;
    let started = 0;
    for (const s of this.#subscribers) for (const d of this.#store.heads(s.name)) if (this.#start(s, d)) started++;
    return started;
  }

  get inflight(): number { return this.#inflight.size; }

  gc(): void {
    const now = this.#now();
    const rows = this.#store.gc(now, LIMITS.outboxKeepMs);
    const dead = this.#store.pruneDeadLetters(now - DEAD_LETTER_KEEP_MS);
    if (rows || dead) this.#log.info(`hook bus: removed ${rows} delivered events and ${dead} old dead letters`);
  }

  #due(d: Delivery): boolean {
    const wait = d.nextAt - this.#now();
    return wait <= 0 || wait > this.#backoff.maxMs;
  }

  #start(s: Subscriber, d: Delivery): boolean {
    const k = `${s.name}\n${d.node}\n${d.streamId}`;
    if (this.#stopped || this.#inflight.has(k) || !this.#due(d)) return false;
    const run = this.#deliver(s, d)
      .catch((e: unknown) => this.#log.error(`hook bus: delivering to ${s.name} failed`, e))
      .finally(() => {
        this.#inflight.delete(k);
        const next = this.#stopped ? null : this.#store.next(s.name, d.node, d.streamId);
        if (next) this.#start(s, next);
      });
    this.#inflight.set(k, run);
    return true;
  }

  async #deliver(s: Subscriber, d: Delivery): Promise<void> {
    let status: number | null = null;
    let failure = "";
    try {
      const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(POST_TIMEOUT_MS)]);
      status = await this.#post(s.url, d.body, { "content-type": "application/json", "idempotency-key": `${d.node}:${d.streamId}:${d.seq}` }, signal);
    } catch (e) {
      if (this.#abort.signal.aborted) return;                // stopping: stays pending, goes again after the restart
      failure = e instanceof Error ? e.name : "error";
    }
    const now = this.#now();
    if (status !== null && ok(status)) { this.#store.delivered(d.outboxId, s.name, now); this.#deadEpisodes.delete(s.name); return; }
    const attempts = d.attempts + 1;
    const reason = status === null ? `no answer (${failure})` : `HTTP ${status}`;
    if ((status !== null && permanent(status)) || attempts >= LIMITS.deadLetterAttempts) {
      this.#store.deadLetter(d, reason, attempts, now);
      if (!this.#deadEpisodes.has(s.name)) {
        this.#deadEpisodes.add(s.name);
        this.#audit.alert("dead_letter", d.node, { subscriber: s.name, streamId: d.streamId, seq: d.seq, path: d.path, reason, attempts });
      }
      return;
    }
    const delay = Math.min(this.#backoff.maxMs, this.#backoff.baseMs * 2 ** (attempts - 1)) * (0.5 + this.#random() / 2);
    this.#store.retry(d.outboxId, s.name, attempts, now + Math.round(delay));
  }
}
```

- [ ] **Step 9: Run it and see it pass**

Run: `npx vitest run apps/fleet/test/delivery.test.ts`
Expected: PASS (9 tests)

Then check that the episode rule bites: in `delivery.ts`, change `      if (!this.#deadEpisodes.has(s.name)) {` to `      if (true) {`. Expected: 1 failure, in "one dead_letter alert per subscriber episode…" (`[2, 3, 4]` alerted, not `[2]`). Restore the line. Then delete ` this.#deadEpisodes.delete(s.name);` from the delivered line: the same test fails (`[2]`, not `[2, 6]`: the episode never ends). Restore it.

- [ ] **Step 10: Commit**

```bash
git add apps/fleet/src/application/delivery.ts apps/fleet/test/helpers/subscriber.ts apps/fleet/test/delivery.test.ts
git commit -m "feat(fleet): hook delivery in seq order with backoff and dead letters"
```

- [ ] **Step 11: Write the failing end-to-end stream test (with the agent's spool)**

Create `apps/fleet/test/helpers/spool.ts`:

```ts
// The agent side of the hook stream, for tests (spec 5.4): events 1..n of the agent's stream, replayed from the
// welcome's ackSeq + 1, in order, with at most `window` unacknowledged in flight; acknowledgements are cumulative.
import { LIMITS, type HookEvent } from "@morndo/protocol";
import type { FakeAgent } from "./fake-agent.ts";

export class Spool {
  readonly last: number;
  readonly pathOf: (seq: number) => HookEvent["path"];

  constructor(last: number, pathOf: (seq: number) => HookEvent["path"] = seq => (seq % 3 === 0 ? "/cc" : "/hook/stop")) {
    this.last = last;
    this.pathOf = pathOf;
  }

  // Sends until `upTo` (default: the last event) is acknowledged; returns the highest acknowledgement seen, which is
  // lower when the connection closed or nothing was acknowledged for `ms`.
  async replay(agent: FakeAgent, o: { upTo?: number; window?: number; ms?: number } = {}): Promise<number> {
    const upTo = Math.min(o.upTo ?? this.last, this.last);
    const window = o.window ?? LIMITS.replayWindow;
    let acked = agent.welcome?.ackSeq ?? 0;
    let sent = acked;
    while (acked < upTo) {
      while (sent < upTo && sent - acked < window) { sent++; agent.hook(sent, this.pathOf(sent)); }
      const a = await agent.acked(acked + 1, o.ms ?? 5000);
      if (a === null) return acked;
      acked = a;
    }
    return acked;
  }
}
```

Create `apps/fleet/test/hook-stream.test.ts`:

```ts
// The hook stream end to end (spec 9, "Stream"): a real fleet, a scripted agent with its spool, real subscribers.
// A fleet restart mid-stream: each event reaches the subscriber at least once, and the subscriber's idempotency key
// makes its handling exactly once. An agent database reset (a new streamId) is delivered, not taken for duplicates.
// A subscriber answering 400 gets a dead letter while another subscriber receives everything.
import { describe, expect, it, vi } from "vitest";
import type { Subscriber } from "../src/config.ts";
import { HOOK_PATHS } from "../src/config.ts";
import { startTestFleet } from "./helpers/fleet.ts";
import { Spool } from "./helpers/spool.ts";
import { startSubscriber } from "./helpers/subscriber.ts";
import { tempDir } from "./helpers/temp.ts";

const FAST = { backoff: { baseMs: 5, maxMs: 40 }, tickMs: 20, random: () => 1 };
const all = (name: string, url: string): Subscriber => ({ name, url, paths: HOOK_PATHS });

describe("the hook stream end to end", () => {
  it("a fleet restart mid-stream: every event at least once, handled exactly once by its idempotency key", async () => {
    let release: () => void = () => {};
    const released = new Promise<void>(r => { release = r; });
    // Event 10's first delivery reaches the subscriber, but its answer is held until the fleet is gone.
    const kira = await startSubscriber(async (r, attempt) => { if (r.body.seq === 10 && attempt === 1) await released; return 200; });
    const dir = tempDir();
    const config = { subscribers: [all("kira", kira.url)] };
    const before = await startTestFleet({ dir, config, delivery: FAST });
    const agent = await before.online("pc");
    const spool = new Spool(40);
    expect(await spool.replay(agent, { upTo: 20 })).toBe(20);                          // stored and acknowledged
    await vi.waitFor(() => expect(kira.received.map(r => r.body.seq)).toContain(10));
    expect(kira.received.map(r => r.body.seq)).not.toContain(11);                        // 11 waits for 10 (seq order)
    await before.close();                                                              // the fleet stops mid-stream
    release();
    const after = await startTestFleet({ dir, config, delivery: FAST });
    const same = after.agent({ node: "pc", key: agent.key, instanceId: agent.instanceId, streamId: agent.streamId });
    expect(await same.connect()).toMatchObject({ ok: true, welcome: { ackSeq: 20, streamKnown: true } });
    expect(await spool.replay(same)).toBe(40);                                          // 21..40, never 1..20 again
    await vi.waitFor(() => expect(kira.handled.size).toBe(40), { timeout: 10_000 });
    const keys = Array.from({ length: 40 }, (_, i) => `pc:${agent.streamId}:${i + 1}`);
    expect([...kira.handled.keys()].sort()).toEqual([...keys].sort());                  // each event, handled once
    for (const key of keys) expect(kira.received.filter(r => r.key === key).length, key).toBeGreaterThanOrEqual(1);
    expect(kira.received.filter(r => r.body.seq === 10)).toHaveLength(2);               // at least once: 10 came again
    expect(kira.received.length).toBe(41);
  });

  it("an agent whose database was reset starts a new stream, and its events are delivered", async () => {
    const kira = await startSubscriber();
    const fleet = await startTestFleet({ config: { subscribers: [all("kira", kira.url)] }, delivery: FAST });
    const old = await fleet.online("pc");
    expect(await new Spool(5).replay(old)).toBe(5);
    await old.close();
    const reinstalled = fleet.agent({ node: "pc", key: old.key });                      // new instance, new streamId
    expect(await reinstalled.connect()).toMatchObject({ ok: true, welcome: { ackSeq: 0, streamKnown: false } });
    expect(await new Spool(3).replay(reinstalled)).toBe(3);
    await vi.waitFor(() => expect(kira.handled.size).toBe(8));
    expect([...kira.handled.keys()].filter(k => k.startsWith(`pc:${reinstalled.streamId}:`)).sort()).toEqual([1, 2, 3].map(n => `pc:${reinstalled.streamId}:${n}`));
  });

  it("a subscriber answering 400 gets a dead letter and an alert; the other subscriber receives everything", async () => {
    const picky = await startSubscriber(r => (r.body.seq === 2 ? 400 : 200));
    const other = await startSubscriber();
    const fleet = await startTestFleet({ config: { subscribers: [all("picky", picky.url), all("other", other.url)] }, delivery: FAST });
    const agent = await fleet.online("pc");
    expect(await new Spool(5).replay(agent)).toBe(5);
    await vi.waitFor(() => expect(other.handled.size).toBe(5));
    await vi.waitFor(() => expect(fleet.outbox.states("picky")).toEqual({ delivered: 4, dead: 1 }));
    expect(fleet.outbox.deadLetters("picky").map(d => d.seq)).toEqual([2]);
    expect(fleet.audit.of("alert.dead_letter")).toHaveLength(1);
  });
});
```

- [ ] **Step 12: Run it and see it fail**

Run: `npx vitest run apps/fleet/test/hook-stream.test.ts`
Expected: FAIL: `AssertionError: expected +0 to be 20` (and `expected +0 to be 5` twice): nothing acknowledges hook events yet, because the endpoint has no hook sink

- [ ] **Step 13: Wire the hook bus into the service**

Replace the whole of `apps/fleet/src/serve.ts` with:

```ts
// The fleet service, wired (ADR-0012): its key, fleet.db, the node registry, the audit, the live connections, the
// lane registry and router, the hook bus, the agent endpoint and the client API. `morndo-fleet serve` runs it; tests
// start it on port 0 with temporary paths. The socket directory is checked first, so an unsafe one stops the service
// before it opens anything. Every alert the audit records is also an `alert` event. Audit rows older than 90 days go on start
// and daily. A revoked node's lanes go whichever way it was revoked (the client API, or the console writing fleet.db).
import type Database from "better-sqlite3";
import type { Pane } from "@morndo/protocol";
import type { FleetConfig } from "./config.ts";
import { Audit } from "./adapters/audit.ts";
import { startClientApi } from "./adapters/client-api.ts";
import { openFleetDb } from "./adapters/db.ts";
import { loadOrCreateFleetKey, type FleetKey } from "./adapters/keys.ts";
import { LanesStore } from "./adapters/lanes-store.ts";
import { log as defaultLog, type Logger } from "./adapters/log.ts";
import { NodesStore } from "./adapters/nodes-store.ts";
import { OutboxStore } from "./adapters/outbox-store.ts";
import type { BucketConfig } from "./adapters/rate-limit.ts";
import { prepareSocketDir } from "./adapters/socket-dir.ts";
import { startAgentEndpoint } from "./adapters/agent-endpoint.ts";
import { Connections } from "./application/connections.ts";
import { DeliveryWorker, type Backoff, type Post } from "./application/delivery.ts";
import { EventHub } from "./application/events.ts";
import { HookIntake } from "./application/hook-intake.ts";
import { LaneRegistry } from "./application/lane-registry.ts";
import { Router } from "./application/router.ts";

export const AUDIT_PRUNE_EVERY_MS = 86_400_000;

export type FleetOptions = {
  log?: Logger; now?: () => number; pingMs?: number; agentLimits?: BucketConfig; handshakeLimits?: BucketConfig; handshakeMs?: number;
  resultSlackMs?: number; instancePongMs?: number; eventsBufferBytes?: number;
  hookBacklog?: number; delivery?: { post?: Post; backoff?: Backoff; tickMs?: number; random?: () => number };
};

export type Fleet = {
  config: FleetConfig; db: Database.Database; key: FleetKey; nodes: NodesStore; audit: Audit; events: EventHub;
  connections: Connections; lanes: LaneRegistry; router: Router; outbox: OutboxStore; delivery: DeliveryWorker; agentPort: number;
  close(): Promise<void>;
};

export async function startFleet(config: FleetConfig, o: FleetOptions = {}): Promise<Fleet> {
  const log = o.log ?? defaultLog;
  const now = o.now ?? Date.now;
  prepareSocketDir(config.socketPath);
  const key = loadOrCreateFleetKey(config.keyPath);
  const db = openFleetDb(config.dbPath);
  const nodes = new NodesStore(db, now);
  const events = new EventHub(e => log.error("an event subscriber failed", e));
  const audit = new Audit(db, { now, log, onAlert: a => events.emit({ t: "alert", node: a.node ?? "", body: a }) });
  const pruneAudit = () => { const n = audit.prune(); if (n > 0) log.info(`audit: removed ${n} rows older than 90 days`); };
  pruneAudit();
  const active = nodes.list().filter(n => n.revokedAt === null).map(n => n.name);
  const lanes = new LaneRegistry({ store: new LanesStore(db), events, audit, activeNodes: active, now });
  const connections = new Connections({
    nodes, audit, events, log, now, onRevoked: node => lanes.dropNode(node), ...(o.pingMs === undefined ? {} : { pingMs: o.pingMs }),
    ...(o.resultSlackMs === undefined ? {} : { resultSlackMs: o.resultSlackMs }), ...(o.instancePongMs === undefined ? {} : { instancePongMs: o.instancePongMs }),
  });
  events.subscribe(e => { if (e.t === "inventory") lanes.inventory(e.node, (e.body as { panes: Pane[] }).panes); });
  const router = new Router({ connections, lanes, audit });
  const outbox = new OutboxStore(db);
  const delivery = new DeliveryWorker({ store: outbox, subscribers: config.subscribers, audit, log, now, ...o.delivery });
  const hooks = new HookIntake({
    store: outbox, subscribers: config.subscribers, audit, now, onStored: () => delivery.kick(),
    ...(o.hookBacklog === undefined ? {} : { cap: o.hookBacklog }),
  });
  const agents = startAgentEndpoint({
    host: config.listen.host, port: config.listen.port, deps: { connections, nodes, audit, fleetKey: key, hooks, log },
    ...(o.agentLimits ? { limits: o.agentLimits } : {}), ...(o.handshakeLimits ? { handshakeLimits: o.handshakeLimits } : {}),
    ...(o.handshakeMs === undefined ? {} : { handshakeMs: o.handshakeMs }),
  });
  let api;
  try {
    await agents.ready;
    api = await startClientApi(config.socketPath, {
      router, connections, lanes, nodes, audit, events, log, ...(o.eventsBufferBytes === undefined ? {} : { eventsBufferBytes: o.eventsBufferBytes }),
    });
  } catch (e) {
    await agents.close();
    db.close();
    throw e;
  }
  connections.start();
  delivery.start();
  const retention = setInterval(pruneAudit, AUDIT_PRUNE_EVERY_MS);
  const clientApi = api;
  return {
    config, db, key, nodes, audit, events, connections, lanes, router, outbox, delivery, agentPort: agents.port(),
    close: async () => {
      clearInterval(retention);
      connections.stop();
      await clientApi.close();
      await agents.close();
      await delivery.stop();
      db.close();
    },
  };
}
```

- [ ] **Step 14: Run it and see it pass**

Run: `npx vitest run apps/fleet/test/hook-stream.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 15: Write the failing `status` test (the hook bus per subscriber)**

`morndo-fleet status` is what the owner runs when something looks stuck (Task 19's docs say so): it shows, per
configured subscriber, how many events wait for it and its dead letters, the latest with its time and reason.

Create `apps/fleet/test/status.test.ts`:

```ts
// `morndo-fleet status` and the hook bus: what waits for each configured subscriber, how many dead letters it has, and
// the latest one's time and reason, read from fleet.db, with or without the service running. A real process, a temp
// HOME and config, a fleet.db the test fills.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HookEvent } from "@morndo/protocol";
import type { Subscriber } from "../src/config.ts";
import { Audit } from "../src/adapters/audit.ts";
import { openFleetDb } from "../src/adapters/db.ts";
import { OutboxStore } from "../src/adapters/outbox-store.ts";
import { HookIntake } from "../src/application/hook-intake.ts";
import { tempDir } from "./helpers/temp.ts";

const MAIN = join(import.meta.dirname, "../src/main.ts");
const ev = (seq: number): HookEvent => ({ streamId: "s1", seq, at: 1_700_000_000_000 + seq, path: "/hook/stop", node: "pc", window: "api", body: {} });

describe("morndo-fleet status", () => {
  it("prints each subscriber's waiting events and dead letters, the latest with its time and reason", () => {
    const home = tempDir();
    const subscribers: Subscriber[] = [
      { name: "kira", url: "http://127.0.0.1:9/hooks", paths: ["/hook/stop"] }, { name: "quiet", url: "http://127.0.0.1:9/q", paths: ["/notify"] },
    ];
    const config = join(home, "fleet.json");
    writeFileSync(config, JSON.stringify({ socketPath: join(home, "s", "f.sock"), subscribers }));
    const db = openFleetDb(join(home, ".local/share/morndo-fleet/fleet.db"));
    const store = new OutboxStore(db);
    new HookIntake({ store, subscribers, audit: new Audit(db) }).accept("pc", "s1", [ev(1), ev(2), ev(3)]);
    const first = store.next("kira", "pc", "s1");
    if (!first) throw new Error("nothing pending for kira");
    store.deadLetter(first, "HTTP 400", 1, Date.UTC(2026, 9, 6, 12));
    db.close();
    const r = spawnSync(process.execPath, ["--no-warnings", MAIN, "status"], { env: { ...process.env, HOME: home, MORNDO_FLEET_CONFIG: config }, encoding: "utf8", timeout: 20_000 });
    expect(r.status).toBe(1);                                                         // no service running
    expect(r.stdout).toMatch(/^hook bus, per subscriber:$/m);
    expect(r.stdout).toMatch(/^ {2}kira\s+2 waiting {2}1 dead letters \(latest 2026-10-06T12:00:00\.000Z: HTTP 400\)$/m);
    expect(r.stdout).toMatch(/^ {2}quiet\s+0 waiting {2}0 dead letters$/m);
  });
});
```

- [ ] **Step 16: Run it and see it fail**

Run: `npx vitest run apps/fleet/test/status.test.ts`
Expected: FAIL: `AssertionError: expected '…' to match /^hook bus, per subscriber:$/m` (the status prints no hook bus yet)

- [ ] **Step 17: Print the hook bus in `status`**

In `apps/fleet/src/main.ts`, replace:

```ts
import { NodesStore } from "./adapters/nodes-store.ts";
```

with:

```ts
import { NodesStore } from "./adapters/nodes-store.ts";
import { OutboxStore } from "./adapters/outbox-store.ts";
```

In `apps/fleet/src/main.ts`, replace:

```ts
  const alerts = new Audit(db).alerts(Date.now() - 24 * 3_600_000);
  db.close();
```

with:

```ts
  const alerts = new Audit(db).alerts(Date.now() - 24 * 3_600_000);
  const outbox = new OutboxStore(db);
  const bus = cfg.subscribers.map(s => ({ name: s.name, ...outbox.summary(s.name) }));
  db.close();
```

In `apps/fleet/src/main.ts`, replace:

```ts
  print(alerts.length === 0 ? "alerts in the last 24 h: none" : `alerts in the last 24 h: ${alerts.length}`);
```

with:

```ts
  print(bus.length === 0 ? "hook bus: no subscribers" : "hook bus, per subscriber:");
  for (const b of bus) {
    print(`  ${b.name.padEnd(32)}  ${b.pending} waiting  ${b.dead} dead letters${b.latest ? ` (latest ${when(b.latest.at)}: ${b.latest.reason})` : ""}`);
  }
  print(alerts.length === 0 ? "alerts in the last 24 h: none" : `alerts in the last 24 h: ${alerts.length}`);
```

- [ ] **Step 18: Run it and see it pass**

Run: `npx vitest run apps/fleet/test/status.test.ts`
Expected: PASS (1 test)

Then check that it bites: in `main.ts`, change `  for (const b of bus) {` to `  for (const b of bus.slice(0, 0)) {` and run it again. Expected: 1 failure, on the `kira … 2 waiting  1 dead letters (latest …: HTTP 400)` line. Restore the line.

- [ ] **Step 19: Run the whole fleet suite, the repository's checks and the lint**

Run each in turn, from the repository root:
- `npx tsc -p apps/fleet`. Expected: no output, exit 0.
- `npx tsc -p tsconfig.tests.json`. Expected: no output, exit 0.
- `npx oxlint apps/fleet`. Expected: no output, exit 0.
- `npx vitest run apps/fleet/test`. Expected: PASS (136 tests in 22 files).
- `npm run check`. Expected: exit 0 (it runs the fleet's `typecheck` through the workspaces).

- [ ] **Step 20: Commit**

```bash
git add apps/fleet/src/serve.ts apps/fleet/src/main.ts apps/fleet/test/helpers/spool.ts apps/fleet/test/hook-stream.test.ts apps/fleet/test/status.test.ts
git commit -m "feat(fleet): wire the hook bus into the agent endpoint; status shows each subscriber's backlog and dead letters"
```
