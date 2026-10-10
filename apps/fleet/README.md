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
| `~/.local/share/morndo-fleet/fleet.db` | Nodes, public keys, join-code hashes, accepted `seq` per `(node, streamId)`, the highest store sequence per `(node, store)` (raised only when an answer shows a higher one), lane names, outbox, dead letters, the count per path of hook events no subscriber takes, alerts, audit (kept 90 days, alerts included). Numbered migrations; a database from a newer fleet is refused before anything is written to it. It and its `-wal` and `-shm` are mode 0600, set explicitly whatever the directory's mode. |
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
| `GET /v1/caps` | `{ api: [1] }` |
| `GET /v1/nodes` | `{ name, status, health, agent }[]` |
| `GET /v1/lanes` | `{ name, node, workerId, conflict }[]` |
| `GET /v1/lanes/<name>` | one lane (`conflict: true` while two windows claim it; `workerId: null` when two windows on its owner do), or 404 `{ error: "no_such_lane" }` |
| `GET /v1/alerts` | oldest first, `{ id, at, node, kind, detail }` (kinds below): the latest 500 security alerts (`instance_conflict`, `source_changed`, `clock_offset`) and the latest 500 others, so other alerts never push a security one out |
| `POST /v1/nodes/<name>/revoke` | `{ ok: true, revoked }`; closes the node's connection (4403) and drops its lanes, as `node revoke` does |
| `POST /v1/op` | `{ node? \| workerId? \| lane?, op, args, key?, timeoutMs? }`, with `expect` inside `args`. Sent to the node, which answers `{ ok: true, result, invVersion, store, storeSeq }` or `{ ok: false, error: { code, executed, message }, store, storeSeq }`. `store` names the node's database the answer came from (a caller that sees it change knows the node's keys may be gone); `storeSeq` is that database's store sequence (keyed ops started, never lowered: lower than before, the database was put back from an older copy), the agent's own on its answers, the highest this service saw from that store on its own answers after sending (a dropped connection, a deadline), `null` from an agent that sends none. Both are `null` when nothing was sent: `node_offline` (not executed) when the node isn't online, `lane_conflict` when two windows claim the lane named, `name_taken` for a `lane.start` of a name registered or being started, `busy` when 8 bulk ops already wait. Every side-effecting op is audited (`op.<name>`: the target, the key's namespace, the outcome and the client from the `x-morndo-client` header; never the text, keys typed or file bytes). |
| `GET /v1/files/<node>/<ref\|path>` | a file, chunked, with its size in `x-file-size`; a refusal before the first byte is `{ ok: false, error }` (400 bad args, 403 denied, 413 too large, 503 node offline, 504 timeout, 502 uncertain or internal, else 404). A download that ends short of `x-file-size`, or runs past it, is destroyed, so the client sees an error and never a clean short body. |
| `WS /v1/events` | `status`, `inventory`, `health`, `conflict`, `alert`, the current state first. A client more than 8 MiB of events behind is closed with 1013; on reconnecting it gets the current state first. |

A body that isn't JSON is 415 and one over 1 MiB 413, and an unknown API version is 404 `{ error: "unsupported_api" }`; an op body is answered in the op's own shape even then. From a shell: `curl --unix-socket ~/.local/state/morndo-fleet/fleet.sock http://fleet/v1/nodes`.

## Lane registry

A name belongs to the node that reported it first. Two nodes, or two windows on one node, with the same name stop routing by that name (`lane_conflict`, not executed), and the conflict shows until the owner renames one; each window stays listed, and an op by worker ID still reaches its pane. `lane.start` refuses a name registered anywhere in the fleet, or one whose `lane.start` is still under way (`name_taken`): the name is reserved from the request until the registry holds it, at most 10 s after the node's answer, and at once released when the start was refused before anything ran (`executed: "no"`). A revoked node's lanes are dropped.

## Hook bus

- An event is in the outbox before the agent is acknowledged.
- Each subscriber gets it at least once, in order per `(node, streamId)`, as `POST <url>` with `Idempotency-Key: <node>:<streamId>:<seq>` and the `HookEvent` as the JSON body. It must deduplicate on that key.
- Backoff is exponential, from 1 s up to 10 min, with jitter, and each POST times out after 10 s. A 4xx other than 408 and 429, or 20 failed attempts, sends the event to dead letters with an alert; 408, 429 and 5xx are retried.
- Each subscriber's backlog is capped at 50,000 events; coalesced events (`/cc`, `/sl`) are dropped first, then an alert is raised.
- Rows are deleted 24 h after delivery, dead letters 24 h after they died, and a subscriber removed from the config loses its rows.
- An event whose path no subscriber takes is acknowledged to its node all the same (the relay already told the hook script "queued"), stored for no one, and counted per path (`status`), so it is never lost silently (ADR-0012 decision 8). At startup `serve` logs a warning for each script path no subscriber takes (`/hook/stop`, `/hook/failure`, `/notify`, `/file`; with the default `subscribers: []`, all four), and the first such event of each script path raises an `unrouted_hook` alert, once per path while the service runs. Progress paths (`/cc`, `/sl`) are counted only.

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

## Sources (each entry says whether it was re-checked; re-check when upgrading)

- `ws` 8: `noServer` with authentication in `upgrade`, ping/pong with `terminate()`, `maxPayload`, `ws+unix:` client URLs. https://github.com/websockets/ws (README.md, doc/ws.md). Checked 2026-10-07.
- Node.js 24 `crypto` (Ed25519 sign and verify, `timingSafeEqual`): https://nodejs.org/docs/latest-v24.x/api/crypto.html. Checked 2026-10-07.
- Node.js 24 `http` over a Unix socket (`server.listen(path)`, which is `net.Server.listen`): https://nodejs.org/docs/latest-v24.x/api/http.html. Checked 2026-10-07.
- Node.js 24 Unix socket path lengths: https://nodejs.org/docs/latest-v24.x/api/net.html#identifying-paths-for-ipc-connections. Checked 2026-10-07.
- SQLite WAL and `synchronous`: https://www.sqlite.org/wal.html, https://www.sqlite.org/pragma.html#pragma_synchronous. Checked 2026-10-07.
- Tailscale Serve: identity headers are not set for tagged devices. https://tailscale.com/kb/1312/serve. Checked 2026-10-07.
- Fencing tokens (the lane leases of a later sub-project): https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html. Checked 2026-10-07.
