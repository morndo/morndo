# Morndo fleet service (`morndo-fleet`)

The control plane's service ([ADR-0012](../../docs/adr/0012-fleet-pull-agents-and-a-separate-fleet-service.md); design: [`docs/design/fleet-core`](../../docs/design/fleet-core/README.md)). Every node's agent dials it. It knows the nodes and their keys, routes typed operations to them, keeps the lane registry, and delivers hook events to subscribers. The hub, kira and the `lanes` CLI are its clients, over a versioned API on a Unix socket. It is separate from the hub, so a hub deploy or crash never cuts the other clients off from the lanes.

## Run it

Needs Node 24 (`>=24.12`). `npm run fleet -- <command>` runs the same.

```sh
node apps/fleet/src/main.ts serve              # the agent endpoint and the client API
node apps/fleet/src/main.ts node add <name>    # a join string: single use, 10 minutes, bound to <name>
node apps/fleet/src/main.ts node list          # nodes, status, last seen
node apps/fleet/src/main.ts node revoke <name> # cut it off now and for good
node apps/fleet/src/main.ts status             # nodes; per subscriber, its outbox depth and dead letters; events no one takes
```

`serve` checks the socket first: if another live service holds it, it exits 78 (`SocketInUse`) before it opens its key or its database. It also exits 78, with one sentence, for an unsafe socket directory, a key file others can read or that can't be used (corrupt or half written, a link to nothing, not Ed25519), a config that doesn't fit, a fleet.db that isn't SQLite, or a database from a newer fleet. The console commands exit 78 for the same files.

Once running, a busy or full fleet.db (another writer holding its lock, a full disk) never takes the service down from a timer: a round of hook delivery, a liveness sweep's write (agents are still pinged) or the daily audit clean-up that fails is logged and tried again on its next round.

`status` prints whether the service runs (and exits 1 if it doesn't answer), each node and its status, then one line per subscriber: `<name>  <n> waiting  <n> dead letters (latest <time>: <reason>)`, where `waiting` is its outbox (events not yet delivered). Then, per hook path, the events no subscriber takes, counted since fleet.db was made: `hook events no subscriber takes (acknowledged and counted, never delivered):` and `  <path>  <n>  (latest <time>)`, or `hook events no subscriber takes: none`. It ends with the alerts of the last 24 hours.

`node add`, `node list` and `node revoke` open fleet.db themselves and tell the running service through its client socket (a revoke closes the node's connection at once, 4403). Any process of the owner's user can run them (accepted; they are audited). The hub uses the fleet when `MORNDO_FLEET_SOCKET` names its socket (`apps/hub/README.md`).

## Files

Every path derives from `HOME`.

| Path | What |
|---|---|
| `~/.config/morndo-fleet/config.json` | The config (below), or the file `MORNDO_FLEET_CONFIG` names; a missing field takes its default. |
| `~/.local/share/morndo-fleet/fleet.db` | Nodes, public keys, join-code hashes, accepted `seq` per `(node, streamId)`, the highest store sequence per `(node, store)` (raised only when an answer shows a higher one), lane names, outbox, dead letters, the count per path of hook events no subscriber takes, alerts, audit (kept 90 days, alerts included), the latest state of each delivery (`lane_deliveries`, never its text), the node that last had each sticky lane name, and lane events (kept 7 days, each marked once the manager has had it). Commits are synced to the disk only where what they guard must outlive the machine: the intake of hook and lane events, before the node is told they are stored, and joins, revocations and keys. Delivered marks, deliveries, the audit and alerts are not (`synchronous=NORMAL`): a mark lost to a power cut means one more delivery, which its receiver skips by its key or id. Events that arrive within 25 ms share one intake commit, and on macOS the database is opened with `fullfsync`. Numbered migrations; a database from a newer fleet is refused before anything is written to it. It and its `-wal` and `-shm` are mode 0600, set explicitly whatever the directory's mode. |
| the config's `keyPath` | The fleet's Ed25519 private key. Its public half goes into every join string, and every agent pins it. |
| `~/.local/state/morndo-fleet/fleet.sock` | The client API, mode 0600. The fleet refuses to start unless the socket's directory is a real directory that belongs to its user and has mode 0700. |

## Config

| Field | Default | Meaning |
|---|---|---|
| `listen` | `{ "host": "127.0.0.1", "port": 8791 }` | The agent endpoint, `/agent`. The host must be loopback (`127.x.x.x`, `localhost` or `::1`): over the tailnet the endpoint is reached through Tailscale Serve, which terminates TLS in front of it (sub-project 3), so it is never plain on the network. |
| `socketPath` | `~/.local/state/morndo-fleet/fleet.sock` | The client API. Keep the path short: a Unix socket address holds 107 bytes on Linux and 103 on macOS (Node's `net` docs). The fleet doesn't check this itself; a longer path fails when it listens. |
| `dbPath` | `~/.local/share/morndo-fleet/fleet.db` | |
| `keyPath` | `~/.local/share/morndo-fleet/fleet-key.pem` | Made on first use, mode 0600, written whole or not at all (a temporary file, flushed, then linked into place; a key another process made first is never replaced). |
| `publicUrl` | `ws://127.0.0.1:8791/agent` | What join strings tell agents to dial: `wss://…`, or `ws://` to a loopback host only. Anything else is refused at start. |
| `subscribers` | `[]` | `[{ "name", "url", "paths": ["/hook/stop", …] }]`: who gets which hook events. |
| `stickyLanes` | `["manager"]` | Lane names a delivery follows across a restart: while no window has the name, a delivery to it goes to the node that last had it and waits there (`no_pane`). Any other name binds a delivery to the session it had when queued. |
| `laneWatch` | `{ "waitingMin": 30, "noStatusMin": 15, "nudge": true }` | The lane watch (Lane events, below): the deadline of a turn that waits without a `for` or ends with background work (`waitingMin`), and of one that ends with no status (`noStatusMin`), in whole minutes from 1 to 1440; `nudge` sends a lane past its deadline one delivery saying so. |
| `laneEvents` | `{ "deliverTo": "manager", "header": "[lane-event] Lane events (handle them as your instructions say):", "ignore": [], "batchMs": 3000 }` | Lane events delivered to a lane: batched for `batchMs`, one delivery per batch (split at 8000 characters), the `header` line, then one JSON line per event. `deliverTo: null` turns delivery off; the events are still published and kept. `ignore`: globs of lane names that raise none. |
| `workerSocket` | `{ "path": fleet-worker.sock beside socketPath, "protectedLanes": adds to the sticky lanes plus laneEvents.deliverTo, "startNodes": [] }` | A second client socket for a caller that reaches the fleet through a forward. Writes and deliveries only for lanes on `startNodes`, and never a protected lane; peeks of a protected pane are refused and `pane.captureMany` drops those ids; transcripts and `job.noticeResult` are refused; files and `worktree.list` only on `startNodes` (docs/fleet-api.md §1). |

## Agent endpoint

Once per node, the join: the agent sends `join { node, code, publicKey, agent, proto }`; the fleet checks the code (unexpired, unused, issued for that node), keeps the public key, answers `welcome` and closes. A refused code is 4403.

Each connection after that goes through four messages. Every message is JSON, `{ v: 1, t, … }`, checked with zod/mini; an unknown `t` is answered with an error, never ignored.
1. The agent sends `hello { node, instanceId, streamId, proto, agent, claude, caps, clientNonce }`.
2. The fleet sends `challenge { nonce, fleetSig }`. `fleetSig` signs the agent's nonce with the fleet's key.
3. The agent sends `proof { sig }`, signing the fleet's nonce.
4. The fleet sends `welcome { connEpoch, ackSeq, streamKnown, storeSeqSeen? }`, where `ackSeq` and `streamKnown` are for the hello's `streamId`, and `storeSeqSeen` is the highest store sequence any answer from that store has shown (kept in fleet.db; omitted when none). An agent whose database is behind it was put back from an older copy, and starts a new store before going online.

| Close | Why | What the agent does |
|---|---|---|
| 4401 | bad proof | stays off: join again with a new code |
| 4403 | revoked, unknown, or a refused join code | stays off |
| 4409 | another instance of this node is live: it answered the instance check's ping (an alert is raised once per refused instance) | keeps `status: conflict`, tries again every 5 minutes |
| 4426 | unsupported protocol (the current and the previous version are accepted) | keeps its lanes, retries hourly |
| 1013 | too many joins and hellos from that source address (10 at once, one more every 6 s), counted before any key work | backs off as after any drop |
| 1009 | a message over 512 KiB (`ws` itself closes over 1 MiB) | backs off as after any drop |
| 1008 | a protocol violation: a message out of order, a handshake not finished in time, an event for another node or stream, or too many messages (`rate_limited`) | backs off as after any drop |
| 1003 | a message that isn't one of ours, or is binary | backs off as after any drop |

Instances: a hello with another instance ID than the live connection's makes the fleet ping the live connection and wait 3 s, without holding up any other node. No pong: the old connection is closed and the newcomer admitted, so a crashed or half-open agent can't lock its node out. A pong: the newcomer is refused with 4409.

Liveness: the fleet pings every 15 s and terminates a connection that missed a pong. A node is `online` after a welcome, `stale` from a missed pong, and `offline` once closed. Messages are at most 512 KiB (`maxPayload` 1 MiB), and control messages go before bulk chunks. Bulk ops (`transcript.read`, `file.get`, `file.put`) run one at a time per node with at most 8 waiting; one more is `busy`, not executed, and an op's timeout counts from when it was queued.

## Client API (`/v1/`, on the socket)

| Route | What |
|---|---|
| `GET /v1/caps` | `{ api: [1], stickyLanes }`: the API versions served, and the lane names deliveries follow across a restart |
| `GET /v1/nodes` | `{ name, status, health, agent }[]` |
| `GET /v1/lanes` | `{ name, node, workerId, conflict }[]` |
| `GET /v1/lanes/<name>` | one lane (`conflict: true` while two windows claim it; `workerId: null` when two windows on its owner do), or 404 `{ error: "no_such_lane" }` |
| `GET /v1/alerts` | oldest first, `{ id, at, node, kind, detail }` (kinds below): the latest 500 security alerts (`instance_conflict`, `source_changed`, `clock_offset`) and the latest 500 others, so other alerts never push a security one out |
| `POST /v1/nodes/<name>/revoke` | `{ ok: true, revoked }`; closes the node's connection (4403) and drops its lanes, as `node revoke` does |
| `POST /v1/op` | `{ node? \| workerId? \| lane?, op, args, key?, timeoutMs? }`, with `expect` inside `args`. Sent to the node, which answers `{ ok: true, result, invVersion, store, storeSeq }` or `{ ok: false, error: { code, executed, message }, store, storeSeq }`. `store` names the node's database the answer came from (a caller that sees it change knows the node's keys may be gone); `storeSeq` is that database's store sequence (keyed ops started, never lowered: lower than before, the database was put back from an older copy), the agent's own on its answers, the highest this service saw from that store on its own answers after sending (a dropped connection, a deadline), `null` from an agent that sends none. Both are `null` when nothing was sent: `node_offline` (not executed) when the node isn't online, `lane_conflict` when two windows claim the lane named, `name_taken` for a `lane.start` of a name registered or being started, `busy` when 8 bulk ops already wait. Every side-effecting op is audited (`op.<name>`: the target, the key's namespace, the outcome and the client from the `x-morndo-client` header; never the text, keys typed or file bytes). |
| `GET /v1/files/<node>/<ref\|path>` | a file, chunked, with its size in `x-file-size`; a refusal before the first byte is `{ ok: false, error }` (400 bad args, 403 denied, 413 too large, 503 node offline, 504 timeout, 502 uncertain or internal, else 404). A download that ends short of `x-file-size`, or runs past it, is destroyed, so the client sees an error and never a clean short body. |
| `POST /v1/deliveries` | `{ id, lane \| workerId, text, ttlMs? }`: a delivery, queued on the lane's node; 200 `{ ok: true, delivery }`. A refusal is 200 `{ ok: false, error }`, as `/v1/op` answers an op's refusal; a body that doesn't fit is 400 `{ ok: false, error }` (`bad_args`; 415 not JSON, 413 over 1 MiB, in the same shape). The same id with the same content is the same delivery. |
| `GET /v1/deliveries/<id>` | `{ delivery, stale }`, or 404 `{ error: "no_such_delivery" }` |
| `GET /v1/deliveries?lane=&state=` | `{ deliveries }`: the newest 1000 of the last 7 days, oldest first, each with `stale` (true while its node is offline) |
| `POST /v1/deliveries/<id>/cancel` | `{ ok: true, delivery }` for one still `queued`; 200 `{ ok: false, error }` (`already_typed`) past that; 404 `{ error: "no_such_delivery" }` for an id it doesn't know |
| `GET /v1/lane-events?since=<seq>` | `{ events }`: lane events after `seq`, at most 1000, oldest first, from the last 7 days |
| `GET /v1/lane-watch` | `{ lanes }`: each lane's last turn as the lane watch holds it, oldest first: `{ node, window, at, status, deadline, reason?, waitingOn?, stale, stalls }` |
| `GET /v1/runs` | `{ runs }`: each lane's Run (Runs, below), by lane: `{ lane, node, sessionId?, phase, wait?, deadline, overdue, outcome?, line?, question?, since, source }` |
| `WS /v1/events` | `status`, `inventory`, `health`, `conflict`, `alert`, `delivery` (a delivery's new state), `lane` (a lane event), `job` and `run` (a lane's Run, when it changes); the current status, inventory and health first, then the jobs and every Run. A client more than 8 MiB of events behind is closed with 1013; on reconnecting it gets the current state first. |

A body that isn't JSON is 415 and one over 1 MiB 413, and an unknown API version is 404 `{ error: "unsupported_api" }`; an op body is answered in the op's own shape even then. From a shell: `curl --unix-socket ~/.local/state/morndo-fleet/fleet.sock http://fleet/v1/nodes`.

The full reference, with every route, op, event and error code, and an example of each that runs as a test against a real fleet: [`docs/fleet-api.md`](../../docs/fleet-api.md).

## Lane registry

A name belongs to the node that reported it first. Two nodes, or two windows on one node, with the same name stop routing by that name (`lane_conflict`, not executed), and the conflict shows until the owner renames one; each window stays listed, and an op by worker ID still reaches its pane. `lane.start` refuses a name registered anywhere in the fleet, or one whose `lane.start` is still under way (`name_taken`): the name is reserved from the request until the registry holds it, at most 10 s after the node's answer, and at once released when the start was refused before anything ran (`executed: "no"`). A revoked node's lanes are dropped.

## Deliveries

A delivery is a message for one lane running Claude Code. It is queued on the lane's node, typed once when the lane can take it, and confirmed from the lane's transcript (design: [fleet clients](../../docs/design/fleet-clients/README.md) §4; reference: [`docs/fleet-api.md`](../../docs/fleet-api.md) §6). This service:
- routes `POST /v1/deliveries` and its cancel to the lane's node, as `lane.deliver` and `delivery.cancel`: a name in `stickyLanes` to the node that last had it while no window has it, any other name to its owner;
- refuses a new delivery to an offline node (`node_offline`), so nothing is queued where it can't be stored;
- refuses `lane.deliver` and `delivery.cancel` on `POST /v1/op` (400 `bad_args`): a delivery goes through its route, where the fleet resolves its target and keeps its mirror;
- keeps each delivery's latest state from the node's `ev.delivery` in `fleet.db` (never the text), serves it at `GET /v1/deliveries`, marked `stale` while the node is offline, and publishes each change on `/v1/events`;
- raises `delivery_waiting` for a delivery still `queued`, `typed` or `held` after 2, 15 and 60 minutes;
- audits each delivery and its outcome with its client and target, never its text.

## Lane events

Built per node and window, from three sources:
- the hooks: `finished` from `/hook/stop`, `stop_failure` from `/hook/failure`. Either Claude Code's own body or the owner's older script body is read: `docs/fleet-api.md` §11.3. A `finished` event's `status` is read from the answer's status line (`waiting` too, with `waitingOn` and `until`). It also keeps what the turn left pending, `tasks` (type and an 80-character redacted description, never the command) and `wakes` (schedule and whether it recurs, never the prompt), at most 8 of each (ADR-0032).
- the session states the node reports: `needs_input` and `answered`, which the node sends through its hook stream as `/lane`.
- the lane watch: `stale`, for a lane whose last turn passed its deadline with no hook from it since (WAITING: its `until`, the line's own duration times 1.5 plus 10 minutes (`waitLeaseMs`); background work or a wake-up: `laneWatch.waitingMin`, a wake-up at least until its next fire time plus 5 min; no status: `laneWatch.noStatusMin`; DONE, BLOCKED and NEEDS DECISION have none). A turn that ended with background work is not judged while its window's session shows `shell` — its own shell is running — and for 2 min after that, never past 6 h from the turn end. With `laneWatch.nudge`, a lane past its deadline that runs Claude Code first gets one delivery, while its expiry count is at most 2, to its session's pane by worker ID (`fleet:nudge:<worker ID>:<turn end, ms>`), so a window of the same name on another node doesn't stop it. The `stale` event — one per turn, with `reason`, `waitingOn`, `since` and `stalls` (expiries since the lane last settled, the nudged ones included) — is the manager's only when the lane needs it: no answer to the nudge within 10 min, a third expiry, or no nudge to send. A hook counts by its own time on its node, whenever it reaches the fleet. Claude Code's `idle_prompt` notification is not activity. A stale event fleet.db can't store is tried again at the next sweep. A Stop the node's relay asked for its status line makes no lane event but counts as a turn without a status until the next Stop, so a lane that never acts on the ask still goes stale. A lane whose node isn't online isn't called stale until the node is back. The watch is in memory, rebuilt from the last day's lane events at start, the state changes and failed turns after each turn end included; the restart counts as activity, so deadlines run again from it, and a nudge not yet answered is not stored. A lane that ends a turn with no Stop hook arriving, seen as its session going from busy to idle with a hook heard in that busy span (Claude Code's idle compaction fires none), gets one `stale` event with `reason: "no_turn_end"` after 5 minutes. No nudge is sent for this reason (an interrupted lane must not be restarted); the orchestrator decides. This is only for lanes that made at least one turn end the fleet knows of.

Each is stored in the same synced intake commit as the hooks, kept 7 days, served at `GET /v1/lane-events?since=` and published on `/v1/events`.

`laneEvents` delivers them to a lane, the manager:
- batched for `batchMs`, one delivery per batch (split at 8000 characters);
- the `header` line, then one JSON line per event in the shape `lane-events-push` used: `{ ts, lane, sessionId, event, status, firstLine, bg, crons }`, plus `waitingOn` and `until` for a wait, and `{ ts, lane, sessionId, event, reason, waitingOn, since, stalls }` for `stale`;
- the delivery id is `fleet:lane-events:<node>:<first event's time, ms>`, with `-1`, `-2` … for a batch split over 8000 characters, and `.2`, `.3` … for a batch queued again after its delivery was given up.

What is not delivered:
- `answered`;
- anything from the manager's own lane, or from lanes matching `ignore`, which raise none.

A batch whose delivery is given up is queued again with the next one. After a restart, the events the manager hasn't had are sent. Events stored while `deliverTo` is `null` are never delivered later, so turning delivery on doesn't flood the manager. A Stop or StopFailure hook the relay couldn't place in a window makes no lane event.

## Runs

What each lane is doing now (ADR-0032, `src/application/runs.ts`), derived by the domain's `deriveRun` from what the fleet observed: the lane watch's last turn end and the hooks after it, the session state in the node's latest inventory, the lane's jobs not ended (its own, or with their notice to it), whether its window is in that inventory, and whether its node is online and has reported since it came back. One Run per window of every registered node, the manager's included; after a restart, one per lane name the registry holds for a node that hasn't reported, `unknown` from the restart. Recomputed after each intake commit, inventory, health, node status, job and lane event, and every minute; published as a `run` event only when it changes. A `gone` Run is kept a day. The manager's and ignored lanes' Stops make no lane event, so their turn ends are kept in memory only. `docs/fleet-api.md` §7.2 has the phases and fields.

## Hook bus

- An event is in the outbox before the agent is acknowledged.
- Each subscriber gets it at least once, in order per `(node, streamId)`, as `POST <url>` with `Idempotency-Key: <node>:<streamId>:<seq>` and the `HookEvent` as the JSON body. It must deduplicate on that key.
- Backoff is exponential, from 1 s up to 10 min, with jitter, and each POST times out after 10 s. A 4xx other than 408 and 429, or 20 failed attempts, sends the event to dead letters with an alert; 408, 429 and 5xx are retried.
- Each subscriber's backlog is capped at 50,000 events; coalesced events (`/cc`, `/sl`) are dropped first, then an alert is raised.
- Rows are deleted 24 h after delivery, dead letters 24 h after they died, and a subscriber removed from the config loses its rows.
- An event whose path no subscriber takes is acknowledged to its node all the same (the relay already told the hook script "queued"), stored for no one, and counted per path (`status`), so it is never lost silently (ADR-0012 decision 8). At startup `serve` logs a warning for each script path no subscriber takes (`/hook/stop`, `/hook/failure`, `/notify`, `/file`; with the default `subscribers: []`, all four), and the first such event of each script path raises an `unrouted_hook` alert, once per path while the service runs. Progress paths (`/cc`, `/sl`) are counted only.

**The subscriber contract** ([`docs/fleet-api.md`](../../docs/fleet-api.md) §13):
- A subscriber answers 2xx once it has an event, and never refuses one for a reason of its own downstream (a chat service that blocks it, a failed handler). It keeps what it can't act on yet, and acts later.
- An event it keeps refusing holds up every later event of its stream.
- `subscriber_lagging` is raised when a subscriber's oldest undelivered event is older than 60 s.
- Delivered marks are not synced: after a power cut a subscriber may get an event once more, and skips it by its `Idempotency-Key`.
- `/lane` (the node's lane state events) is the node's own path: never a subscriber's, and never counted as an unrouted hook.

## Alerts

Alerts are audit rows, kept 90 days like the rest of the audit (old rows go when the service starts, and daily). The three security kinds (`instance_conflict`, `source_changed`, `clock_offset`) are capped apart from the others: `GET /v1/alerts` keeps the latest 500 of each.

The audit also holds `op.<name>` for every side-effecting op (actor `client`; `{ target, keyNs, outcome, client }`), `conn.admitted`, `conn.refused` (with its reason and source address) and `conn.replaced` (a live instance closed because it missed the instance check), besides joins and revocations.

| Kind | When |
|---|---|
| `instance_conflict` | A second instance of a node was refused (4409) because the live one answered the instance check. One alert per refused instance for as long as the live connection lasts; its retries every 5 minutes raise none. |
| `clock_offset` | A node's health clock is more than 2 s off, after allowing for the round trip. Correctness doesn't depend on it, since echo matching uses the node's own `typedAt`. |
| `dead_letter` | A subscriber refused an event, or the event failed 20 times. Once per episode: the first dead letter after a delivery to that subscriber succeeded (or since start); later ones count into it until a delivery succeeds again. |
| `backlog_full` | A subscriber's backlog reached 50,000 events. |
| `unrouted_hook` | The first event of a script path (`/hook/stop`, `/hook/failure`, `/notify`, `/file`) that no subscriber takes, once per path while the service runs; `detail` `{ path, events }` (that batch's count). The running count is in `status`. |
| `source_changed` | A node's tailnet source address changed: possibly a stolen node key. |
| `rate_limited` | A node sent more than its rate allows (inventory and health: 60 at once, 2 a second; hook events are exempt); its connection was closed (1008). |
| `lane_conflict` | A lane name got a second claimant. |
| `delivery_waiting` | A delivery is still `queued`, `typed` or `held` 2, 15 and 60 minutes after it was queued, once each; `detail` `{ id, lane, state, reason, minutes }`. |
| `subscriber_lagging` | A subscriber's oldest undelivered event is older than 60 s; `detail` `{ subscriber, oldestAgeMs, streams }`. |
| `engine_fallback` | A `lane.start` ran an engine its role reached only after passing over others; `detail` `{ lane, role?, entry, skipped: { entry, reason }[] }`. The start's audit row (`op.lane.start`) keeps the `role` or `engine`, the `reason` and the entry that ran (`ran`). |

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
npx vitest run --project fleet test/fleet/api-doc.test.ts   # docs/fleet-api.md: every example against a real fleet
node scripts/bench-relay.ts --rate 2 --gate                 # the hook swap's gate on the disk TMPDIR points at; exit 1 when it fails
```

## Sources (each entry says whether it was re-checked; re-check when upgrading)

- `ws` 8: `noServer` with authentication in `upgrade`, ping/pong with `terminate()`, `maxPayload`, `ws+unix:` client URLs. https://github.com/websockets/ws (README.md, doc/ws.md). Checked 2026-10-07.
- Node.js 24 `crypto` (Ed25519 sign and verify, `timingSafeEqual`): https://nodejs.org/docs/latest-v24.x/api/crypto.html. Checked 2026-10-07.
- Node.js 24 `http` over a Unix socket (`server.listen(path)`, which is `net.Server.listen`): https://nodejs.org/docs/latest-v24.x/api/http.html. Checked 2026-10-07.
- Node.js 24 Unix socket path lengths: https://nodejs.org/docs/latest-v24.x/api/net.html#identifying-paths-for-ipc-connections. Checked 2026-10-07.
- SQLite WAL and `synchronous`: https://www.sqlite.org/wal.html, https://www.sqlite.org/pragma.html#pragma_synchronous. Checked 2026-10-07.
- Tailscale Serve: identity headers are not set for tagged devices. https://tailscale.com/kb/1312/serve. Checked 2026-10-07.
- Fencing tokens (the lane leases of a later sub-project): https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html. Checked 2026-10-07.
