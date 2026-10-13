# The fleet's client API (version 1)

The fleet service (`morndo-fleet`, [apps/fleet](../apps/fleet/README.md)) is how every client reaches the lanes: the hub, `morndo lanes`, kira, the manager's helpers, and anything you write. This is its reference, version 1. It covers:
- the socket and the version rules;
- every route, and every op you can run through `POST /v1/op`;
- deliveries and lane events;
- every event on `/v1/events` and every error code;
- the hook relay's bodies and the subscriber contract.

**Every example below runs as a test.** `test/fleet/api-doc.test.ts` sends each request to a real fleet with a real node agent, whose lanes stand in for Claude Code, and compares the answer. A change that breaks an example fails CI. For TypeScript there is a client, `@morndo/fleet-client` (`packages/fleet-client`).

The design behind it: [fleet clients](design/fleet-clients/README.md) and [fleet core](design/fleet-core/README.md).

**Contents:**
1. The socket
2. Versions
3. Clients name themselves
4. How to read the examples
5. Nodes, lanes and alerts
6. Deliveries
7. Lane events
8. Ops (`POST /v1/op`)
9. Events (`WS /v1/events`)
10. Errors
11. The hook relay and its bodies
12. Files
13. The subscriber contract
14. Alerts
15. Sources

## 1. The socket

- **Transport.** The API is HTTP/1.1 and one WebSocket over a Unix socket: `~/.local/state/morndo-fleet/fleet.sock` by default (the fleet's `socketPath`). Nothing listens on the network.
- **Access.** The socket has mode 0600, in a directory of mode 0700 that belongs to the fleet's user, and that directory is the only access control. Any process of that user can call every route. Client names (§3) are labels for the audit, not credentials.
- **Bodies.** Requests send JSON (`content-type: application/json`), at most 1 MiB. Answers are JSON with `cache-control: no-store`; a file (§12) is the one exception.
- **Path segments.** Each segment of a path is URL-encoded on its own, so a lane name or a file path that holds `/` stays one segment (`%2F`).
- **From a shell:** `curl --unix-socket ~/.local/state/morndo-fleet/fleet.sock http://fleet/v1/caps`. The host name is ignored.

```example caps
GET /v1/caps
---
200
content-type: application/json

{ "api": [1], "stickyLanes": ["manager"] }
```

- `api` lists the versions this fleet serves.
- `stickyLanes` lists the lane names that deliveries follow across a restart (§6.1). They come from the fleet's config.

## 2. Versions

- **Paths.** Every route is under `/v<N>/`. A fleet serves its current version and the one before it (`api`), so a client one version behind keeps working through an upgrade.
- **What a version may gain.** Within a version, the fleet may add fields to answers, routes, ops, event types (`t`), alert kinds, lane events and error codes. A client ignores fields, events and alert kinds it doesn't know.
- **An unknown error code.** A client reads it as `internal` with `executed: "maybe"`: it may have run, so it is never retried on a guess.
- **What takes a new version:** removing or renaming anything, or changing what a field means.
- **A version the fleet doesn't serve** is answered 404, with the versions it does serve. A WebSocket to one is refused with 404 too.

```example unsupported-version
GET /v2/caps
---
404

{ "error": "unsupported_api", "api": [1] }
```

## 3. Clients name themselves

- **The header.** Every request names its client in `x-morndo-client`: 1 to 16 lower-case letters `a`–`z`, such as `hub`, `lanes`, `kira` or `fleet`. Anything else (a missing header, upper case, digits, more than 16 letters) is recorded as `unknown`, and the request is served all the same.
- **Namespaces.** A client namespaces its delivery ids and operation keys with the same name and a colon, such as `kira:tap:123`. The fleet never checks that a name is honest (§1).
- **The audit.** For every side effect, the fleet's audit records the client that asked, its target and its outcome. That covers every delivery, every keyed op (`pane.send`, `file.put`, `lane.start`, `lane.stop`, `worktree.add`) and every `pane.keys`. It never records the text typed, the keys pressed or a file's bytes.

```example client-name-unknown
GET /v1/lanes/w1
x-morndo-client: Kira-2
---
200

{ "name": "w1", "node": "n1", "workerId": "{{workerId:w1}}", "conflict": false }
```

## 4. How to read the examples

**The format.** Each example is a fenced block whose first line is `example <name>`. It holds the request, then a line `---`, then the answer:
- **The request:** `METHOD path` for the socket, or `METHOD http://127.0.0.1:8787/…` for the node's hook relay (§11). Then header lines, a blank line, and the body.
- **The answer:** the status, then header lines, then a blank line and the body. Only the headers listed are checked.

A word after the name changes how the block reads:
- `poll`: the answer comes once the fleet has acted, a delivery confirmed say. The request is repeated until the answer matches, for up to 20 s.
- `events`: messages the fleet sent on a `/v1/events` subscription that was opened before anything else, in this order. Other messages may come between them.
- `subscriber`: a request the fleet made to a hook subscriber (§13).

**Placeholders.** These stand for values that change from run to run. They are written as JSON strings but match values of their kind:

| Placeholder | Matches |
|---|---|
| `"{{any}}"` | anything |
| `"{{string}}"` | any string |
| `"{{number}}"` | any number |
| `"{{time}}"` | a time in milliseconds since the epoch, within two days of now |
| `"{{uuid}}"` | a UUID |
| `"{{workerId}}"` | a worker id, `<node>.<server>.<pane>` |
| `"{{kind?}}"` | as `{{kind}}`, or the field is absent |
| `"{{kind:name}}"` | as `{{kind}}`, and the same value wherever `name` comes again, in answers and in later requests; in a path, `{{uri:name}}` is that value URL-encoded |
| `["{{unordered}}", …]` | the items that follow, in any order |

Any other value matches only itself. An answer may hold no field that its example doesn't name.

**The setup.** The examples run against one node, `n1`, with these lanes:
- `manager` and `w1`: Claude Code, idle;
- `sh1`: a shell;
- two windows that are both named `dup`.

`n2` and `n3` are nodes that have joined and are offline. On `n1` there are also a file `notes/hello.txt` holding `hello`, a git repository `repos/r1`, and two empty folders for new lanes. Where an example needs `w1` in another state (a menu open, a turn running), the text before it says so.

## 5. Nodes, lanes and alerts

| Route | Answer |
|---|---|
| `GET /v1/caps` | `{ api, stickyLanes }` (§1) |
| `GET /v1/nodes` | every node not revoked, by name: `{ name, status, health, agent }[]` |
| `POST /v1/nodes/<name>/revoke` | `{ ok: true, revoked }`: the node is cut off now and for good |
| `GET /v1/lanes` | every lane name, by name: `{ name, node, workerId, conflict }[]` |
| `GET /v1/lanes/<name>` | one lane, or 404 `{ error: "no_such_lane" }` |
| `GET /v1/alerts` | the latest alerts, oldest first (§14) |
| `POST /v1/op` | an op on a node (§8) |
| `GET /v1/files/<node>/<ref or path>` | a file's bytes (§12) |
| `POST /v1/deliveries`, `GET /v1/deliveries/<id>`, `GET /v1/deliveries?lane=&state=` (the newest 1000 of the last 7 days), `POST /v1/deliveries/<id>/cancel` | deliveries (§6) |
| `GET /v1/lane-events?since=<seq>` | lane events (§7) |
| `GET /v1/lane-watch` | each lane's last turn and its deadline (§7.1) |
| `WS /v1/events` | the fleet's events (§9) |

### 5.1 Nodes

**Fields:**
- `status` is `online`, `stale` (a missed ping) or `offline`.
- `health` is the node's latest report: memory, load, disk, the clock, the depth of its hook spool. It is null until the node has sent one.
- `agent` is the version its agent last reported.

```example nodes
GET /v1/nodes
---
200

[
  { "name": "n1", "status": "online", "health": "{{any}}", "agent": "{{string}}" },
  { "name": "n2", "status": "offline", "health": null, "agent": "{{any}}" },
  { "name": "n3", "status": "offline", "health": null, "agent": "{{any}}" }
]
```

**Revoking a node** closes its connection (code 4403) and drops its lanes. It never connects again; joining again takes a new join code. `revoked` is false for a node that was already revoked.

```example revoke
POST /v1/nodes/n3/revoke
x-morndo-client: lanes
---
200

{ "ok": true, "revoked": true }
```

### 5.2 Lanes

A lane is a tmux window with one pane, in the node's session, and its name is its window's name. Names are unique across the fleet:
- A name belongs to the node that reported it first.
- When two windows claim one name, on two nodes or on one, the name is in conflict (`conflict: true`, and `workerId: null` while two windows of its owner claim it) and nothing is routed by it. Each window can still be reached by its worker id.

```example lanes
GET /v1/lanes
---
200

[
  { "name": "dup", "node": "n1", "workerId": null, "conflict": true },
  { "name": "manager", "node": "n1", "workerId": "{{workerId:manager}}", "conflict": false },
  { "name": "sh1", "node": "n1", "workerId": "{{workerId:sh1}}", "conflict": false },
  { "name": "w1", "node": "n1", "workerId": "{{workerId:w1}}", "conflict": false }
]
```

```example lane-one
GET /v1/lanes/w1
---
200

{ "name": "w1", "node": "n1", "workerId": "{{workerId:w1}}", "conflict": false }
```

```example lane-none
GET /v1/lanes/nobody
---
404

{ "error": "no_such_lane" }
```

A lane's session status (`busy`, `idle`, `waiting`, `shell`), its process and its folder are in its node's inventory (`inventory.get`, §8).

### 5.3 Alerts

The fleet keeps the latest 500 security alerts and the latest 500 others, and serves both oldest first. §14 lists the kinds.

```example alerts
GET /v1/alerts
---
200

[
  { "id": "{{number}}", "at": "{{time}}", "node": "n1", "kind": "lane_conflict",
    "detail": { "name": "dup", "claims": ["{{unordered}}", { "node": "n1", "workerId": "{{workerId}}" }, { "node": "n1", "workerId": "{{workerId}}" }] } }
]
```

## 6. Deliveries

A delivery is a message for one lane running Claude Code. It is queued on the lane's node, typed into the lane once, when the lane can take it, and confirmed from the lane's own conversation. It is how anything reaches the manager, and how a client says something to a Claude Code lane without racing the owner's typing or a menu. A lane with no Claude Code (a shell, an engine) is typed into directly instead, with `pane.send` and `pane.keys` (§8).

### 6.1 Sending one

`POST /v1/deliveries` takes `{ id, lane | workerId, text, ttlMs? }`:

- **`id`.** Chosen by the client, namespaced (`kira:…`), at most 200 characters, never ending in `#<digits>` (kept for the node's retype key). It is the delivery's idempotency:
  - The same id with the same target and text is the same delivery. Sending it again answers its current state and queues nothing.
  - The same id with another target or text is refused with `id_conflict`.
  - The node types the delivery under this id as an operation key, so a crash while typing never types it twice.
- **`lane`, a sticky name.** The fleet's `stickyLanes` (`GET /v1/caps`; default `["manager"]`) follow the name wherever its node runs it:
  - after a restart in a new pane and a new session, the new one gets the delivery;
  - while no window has the name, the delivery goes to the node that last had it and waits there (`no_pane`).
- **`lane`, any other name.** The delivery is bound to the session that lane has when it is queued. If another session takes the name, the delivery is given up (`gone`) and never typed into the other conversation.
- **`workerId`.** Bound to that pane: when the pane is gone, so is the delivery.
- **`text`.** At most 8000 characters.
- **`ttlMs`.** How long it may wait, at most 7 days. The default is 24 hours, turned into `notAfter` on the node's clock when stored, so the clocks of client and node never need to agree.
- **Only a lane with a live Claude Code session takes deliveries,** whatever the session's `status` (`busy`, `idle`, `waiting`, or `shell`: a shell command running under it).
  - A pane with no live session (no session file, or its process gone) makes the delivery wait (`no_session`) when the lane is sticky, or when the pane's process started in the last 2 minutes (Claude Code still starting).
  - Any other such pane refuses it with `no_session`.

A delivery answered `queued` is stored on its node and synced to the disk: the sender may stop retrying. A refusal queued nothing. It is answered 200 `{ ok: false, error }`, as `/v1/op` answers an op's refusal (§10). Only a body that doesn't fit the route is 400, in the same `{ ok: false, error }` shape (`bad_args`). While the node is offline, a new delivery is refused with `node_offline` and is never queued anywhere else.

**No answer: in doubt** (plan/RECONCILIATION.md ruling 49). A request that reached the fleet and got no answer leaves the delivery in doubt: it may be queued. That happens when the connection drops, or the client gives up waiting; `@morndo/fleet-client` then throws `FleetUnavailable` with `reached: true`. A refusal `uncertain` is the same case.
- **What a client does:** it sends the same `id` again. That is safe, since a delivery's id is its idempotency, and the answer is then its current state.
- **What it never does:** it never falls back to typing the text directly, and never tells the owner it wasn't delivered.
- **`morndo lanes`** exits 5 then, and its line names the id to send again. It exits 69 only when the fleet wasn't reached (`reached: false`): nothing was queued.

```example deliver
POST /v1/deliveries
x-morndo-client: kira
content-type: application/json

{ "id": "kira:doc:1", "lane": "w1", "text": "Ship the docs build." }
---
200

{ "ok": true, "delivery": { "id": "kira:doc:1", "node": "n1", "target": { "lane": "w1" }, "state": "queued", "queuedAt": "{{time}}", "notAfter": "{{time}}", "sessionId": "{{uuid:w1-session}}" } }
```

### 6.2 Its state

**The `Delivery` object.** The fleet keeps the latest state of every delivery from the last 7 days, never its text:

| Field | Meaning |
|---|---|
| `id`, `node`, `target` | as sent, and the node it is queued on |
| `state` | below |
| `queuedAt`, `notAfter` | milliseconds on the node's clock |
| `waiting` | `{ reason, since }`, only while `queued`, once a try found the lane not ready |
| `sessionId` | the session it is bound to (a lane name that isn't sticky), or was typed into |
| `typedAt`, `deliveredAt` | milliseconds on the node's clock |
| `why` | for `given_up` |
| `note` | words for a person, such as why it is `uncertain` |

**The states:**

| `state` | Meaning |
|---|---|
| `queued` | stored on the node, not yet taken by the lane |
| `typed` | typed, waiting for Claude Code to take it |
| `held` | in Claude Code's own queue: it was typed while a turn was running |
| `delivered` | in the conversation, at `deliveredAt` |
| `uncertain` | typed, and seen neither taken nor back in the input box before `notAfter`: it may or may not have reached the lane. It is never typed again. |
| `given_up` | `why`: `expired` (never typed before `notAfter`), `cancelled`, `gone` (its pane or its bound session is gone), or `refused` (a definite refusal, such as `too_large`) |

**Why a queued delivery waits** (`waiting.reason`):

| `reason` | Meaning |
|---|---|
| `menu_open` | a menu is on the screen |
| `draft_present` | the owner's own text is in the input box |
| `no_input_box` | no input box on the screen |
| `busy` | another typist holds the pane's lock |
| `no_pane` | no window has the name (a sticky lane mid-restart) |
| `no_session` | Claude Code isn't running there yet |
| `earlier` | an earlier delivery to the same lane goes first: one still queued, or one typed or held and waiting for its receipt, for at most 60 s |
| `unavailable` | the node couldn't read or type the pane just now (tmux didn't answer, a capture failed); it tries again |

**How the node types and confirms it.**
- **One at a time per lane,** in the order queued. A try comes at once, on every change the node sees, and at least every 5 seconds. A delivery typed or held and waiting for its receipt holds the next one back for at most 60 s; then the next one types.
- **The checks of `pane.send`,** each time: never over a menu or a draft, never past the pane's lock.
- **A line that stays in the box after Enter** gets Enter again, but only while the box still shows exactly that line, and at most twice more.
- **`delivered` comes only from Claude Code's transcript** of the session it was typed into, as a prompt that holds the text. Each receipt confirms one delivery, the earliest still waiting.
- **A slash command that starts a new session** (`/clear`, `/new`) is recorded only in the new session's transcript. Its receipt is the pane's session changing to a new id after the typing.
- **A line Claude Code dropped on an interrupt** is typed once more, under its own key, if the box is clear and the session idle. Otherwise the delivery is `uncertain`. There is never a third typing.

**`stale`** is true while the delivery's node is offline: the fleet's copy may be behind the node's. A delivery still `queued`, `typed` or `held` after 2, 15 and 60 minutes raises a `delivery_waiting` alert each time (§14).

```example delivery-delivered poll
GET /v1/deliveries/kira:doc:1
---
200

{ "delivery": { "id": "kira:doc:1", "node": "n1", "target": { "lane": "w1" }, "state": "delivered", "queuedAt": "{{time}}", "notAfter": "{{time}}", "sessionId": "{{uuid:w1-session}}", "typedAt": "{{time}}", "deliveredAt": "{{time}}" }, "stale": false }
```

The same id with the same content again: the same delivery, as it is now.

```example deliver-again
POST /v1/deliveries
x-morndo-client: kira
content-type: application/json

{ "id": "kira:doc:1", "lane": "w1", "text": "Ship the docs build." }
---
200

{ "ok": true, "delivery": { "id": "kira:doc:1", "node": "n1", "target": { "lane": "w1" }, "state": "delivered", "queuedAt": "{{time}}", "notAfter": "{{time}}", "sessionId": "{{uuid:w1-session}}", "typedAt": "{{time}}", "deliveredAt": "{{time}}" } }
```

The same id with other content is refused:

```example deliver-id-conflict
POST /v1/deliveries
x-morndo-client: kira
content-type: application/json

{ "id": "kira:doc:1", "lane": "w1", "text": "Hold the docs build." }
---
200

{ "ok": false, "error": { "code": "id_conflict", "executed": "no", "message": "{{string}}" } }
```

To the manager, a sticky name: no session is bound, and the session it was typed into is known once it is typed.

```example deliver-sticky
POST /v1/deliveries
x-morndo-client: hub
content-type: application/json

{ "id": "hub:doc:2", "lane": "manager", "text": "Answer: ship it." }
---
200

{ "ok": true, "delivery": { "id": "hub:doc:2", "node": "n1", "target": { "lane": "manager" }, "state": "queued", "queuedAt": "{{time}}", "notAfter": "{{time}}" } }
```

```example delivery-sticky-delivered poll
GET /v1/deliveries/hub:doc:2
---
200

{ "delivery": { "id": "hub:doc:2", "node": "n1", "target": { "lane": "manager" }, "state": "delivered", "queuedAt": "{{time}}", "notAfter": "{{time}}", "sessionId": "{{uuid:manager-session}}", "typedAt": "{{time}}", "deliveredAt": "{{time}}" }, "stale": false }
```

While `w1` shows a menu, a delivery waits and says why:

```example deliver-menu
POST /v1/deliveries
x-morndo-client: kira
content-type: application/json

{ "id": "kira:doc:menu", "lane": "w1", "text": "After the menu." }
---
200

{ "ok": true, "delivery": { "id": "kira:doc:menu", "node": "n1", "target": { "lane": "w1" }, "state": "queued", "queuedAt": "{{time}}", "notAfter": "{{time}}", "sessionId": "{{uuid:w1-session}}" } }
```

```example delivery-waiting poll
GET /v1/deliveries/kira:doc:menu
---
200

{ "delivery": { "id": "kira:doc:menu", "node": "n1", "target": { "lane": "w1" }, "state": "queued", "queuedAt": "{{time}}", "notAfter": "{{time}}", "sessionId": "{{uuid:w1-session}}", "waiting": { "reason": "menu_open", "since": "{{time}}" } }, "stale": false }
```

### 6.3 Cancelling one

`POST /v1/deliveries/<id>/cancel` takes no body. It gives up a delivery that is still `queued`. One already typed can't be called back: that is refused with `already_typed`. An id the fleet doesn't know is 404 `{ error: "no_such_delivery" }`, as on `GET`.

```example cancel
POST /v1/deliveries/kira:doc:menu/cancel
x-morndo-client: kira
---
200

{ "ok": true, "delivery": { "id": "kira:doc:menu", "node": "n1", "target": { "lane": "w1" }, "state": "given_up", "queuedAt": "{{time}}", "notAfter": "{{time}}", "sessionId": "{{uuid:w1-session}}", "why": "cancelled" } }
```

```example cancel-typed
POST /v1/deliveries/kira:doc:1/cancel
x-morndo-client: kira
---
200

{ "ok": false, "error": { "code": "already_typed", "executed": "no", "message": "{{string}}" } }
```

```example cancel-unknown
POST /v1/deliveries/kira:doc:nothing/cancel
x-morndo-client: kira
---
404

{ "error": "no_such_delivery" }
```

### 6.4 Listing them

`GET /v1/deliveries` lists the newest 1000 of the last 7 days, oldest first. `lane` and `state` filter the list, each optional; a `state` that isn't one is 400.

```example deliveries-list
GET /v1/deliveries?lane=w1&state=given_up
---
200

{ "deliveries": [ { "id": "kira:doc:menu", "node": "n1", "target": { "lane": "w1" }, "state": "given_up", "queuedAt": "{{time}}", "notAfter": "{{time}}", "sessionId": "{{uuid:w1-session}}", "why": "cancelled", "stale": false } ] }
```

### 6.5 Deadlines, held lines, and lines never seen taken

The menu is still open on `w1`. A delivery that may wait only 2 seconds expires without being typed:

```example deliver-ttl
POST /v1/deliveries
x-morndo-client: kira
content-type: application/json

{ "id": "kira:doc:ttl", "lane": "w1", "text": "Too late for the menu.", "ttlMs": 2000 }
---
200

{ "ok": true, "delivery": { "id": "kira:doc:ttl", "node": "n1", "target": { "lane": "w1" }, "state": "queued", "queuedAt": "{{time}}", "notAfter": "{{time}}", "sessionId": "{{uuid:w1-session}}" } }
```

```example delivery-expired poll
GET /v1/deliveries/kira:doc:ttl
---
200

{ "delivery": { "id": "kira:doc:ttl", "node": "n1", "target": { "lane": "w1" }, "state": "given_up", "queuedAt": "{{time}}", "notAfter": "{{time}}", "sessionId": "{{uuid:w1-session}}", "why": "expired" }, "stale": false }
```

The menu is answered. Now `w1` runs a turn, so a delivery typed into it lands in Claude Code's own queue (`held`):

```example deliver-busy
POST /v1/deliveries
x-morndo-client: kira
content-type: application/json

{ "id": "kira:doc:busy", "lane": "w1", "text": "Queued behind the turn." }
---
200

{ "ok": true, "delivery": { "id": "kira:doc:busy", "node": "n1", "target": { "lane": "w1" }, "state": "queued", "queuedAt": "{{time}}", "notAfter": "{{time}}", "sessionId": "{{uuid:w1-session}}" } }
```

```example delivery-held poll
GET /v1/deliveries/kira:doc:busy
---
200

{ "delivery": { "id": "kira:doc:busy", "node": "n1", "target": { "lane": "w1" }, "state": "held", "queuedAt": "{{time}}", "notAfter": "{{time}}", "sessionId": "{{uuid:w1-session}}", "typedAt": "{{time}}" }, "stale": false }
```

The turn ends and Claude Code takes its queue as the next prompt:

```example delivery-held-delivered poll
GET /v1/deliveries/kira:doc:busy
---
200

{ "delivery": { "id": "kira:doc:busy", "node": "n1", "target": { "lane": "w1" }, "state": "delivered", "queuedAt": "{{time}}", "notAfter": "{{time}}", "sessionId": "{{uuid:w1-session}}", "typedAt": "{{time}}", "deliveredAt": "{{time}}" }, "stale": false }
```

Next, `w1` takes a line but its transcript never shows it. Typed and never seen taken by its deadline, the delivery is `uncertain`: it may or may not have reached the lane, and it is never typed again.

```example deliver-silent
POST /v1/deliveries
x-morndo-client: kira
content-type: application/json

{ "id": "kira:doc:lost", "lane": "w1", "text": "Never seen taken.", "ttlMs": 4000 }
---
200

{ "ok": true, "delivery": { "id": "kira:doc:lost", "node": "n1", "target": { "lane": "w1" }, "state": "queued", "queuedAt": "{{time}}", "notAfter": "{{time}}", "sessionId": "{{uuid:w1-session}}" } }
```

```example delivery-uncertain poll
GET /v1/deliveries/kira:doc:lost
---
200

{ "delivery": { "id": "kira:doc:lost", "node": "n1", "target": { "lane": "w1" }, "state": "uncertain", "queuedAt": "{{time}}", "notAfter": "{{time}}", "sessionId": "{{uuid:w1-session}}", "typedAt": "{{time}}", "note": "{{string?}}" }, "stale": false }
```

### 6.6 Refusals

A shell takes no delivery. Type into it with `pane.send` instead.

```example deliver-no-session
POST /v1/deliveries
x-morndo-client: kira
content-type: application/json

{ "id": "kira:doc:sh", "lane": "sh1", "text": "ls" }
---
200

{ "ok": false, "error": { "code": "no_session", "executed": "no", "message": "{{string}}" } }
```

```example deliver-no-lane
POST /v1/deliveries
x-morndo-client: kira
content-type: application/json

{ "id": "kira:doc:none", "lane": "nobody", "text": "Hello?" }
---
200

{ "ok": false, "error": { "code": "no_pane", "executed": "no", "message": "{{string}}" } }
```

```example deliver-conflict
POST /v1/deliveries
x-morndo-client: kira
content-type: application/json

{ "id": "kira:doc:dup", "lane": "dup", "text": "Which one?" }
---
200

{ "ok": false, "error": { "code": "lane_conflict", "executed": "no", "message": "{{string}}" } }
```

```example deliver-offline
POST /v1/deliveries
x-morndo-client: kira
content-type: application/json

{ "id": "kira:doc:n2", "workerId": "n2.0a1b2c3d.1", "text": "Are you there?" }
---
200

{ "ok": false, "error": { "code": "node_offline", "executed": "no", "message": "{{string}}" } }
```

```example deliver-bad
POST /v1/deliveries
x-morndo-client: kira
content-type: application/json

{ "id": "doc-1", "lane": "w1", "text": "An id without its client's name." }
---
400

{ "ok": false, "error": { "code": "bad_args", "executed": "no", "message": "{{string}}" } }
```

So is a body that doesn't fit the route at all (here both a lane and a worker id): 400, before anything is looked up, in the shape `POST /v1/op` answers a malformed body with:

```example deliver-malformed
POST /v1/deliveries
x-morndo-client: kira
content-type: application/json

{ "id": "kira:doc:both", "lane": "w1", "workerId": "{{workerId:w1}}", "text": "Which target?" }
---
400

{ "ok": false, "error": { "code": "bad_args", "executed": "no", "message": "{{string}}" } }
```

```example delivery-none
GET /v1/deliveries/kira:doc:nothing
---
404

{ "error": "no_such_delivery" }
```

## 7. Lane events

The fleet builds five lane events from three sources: the hooks of each lane, the session state each node reports, and its own lane watch (§7.1).

| `event` | When | Fields |
|---|---|---|
| `finished` | a turn ended (the Stop hook, §11) | `status`, `firstLine`, `bg`, `crons`; for a wait, `waitingOn` and `until` |
| `needs_input` | the session's status turned `waiting`: a menu (a question, a permission prompt, a usage-limit dialog) | `question` |
| `answered` | the session's status left `waiting` | none |
| `stop_failure` | a turn ended on an API error (the StopFailure hook) | `error` |
| `stale` | a lane's last turn passed its deadline with nothing from the lane since (§7.1) | `reason`, `waitingOn`, `since`, `stalls` |

**The fields:**
- `status` is `done`, `blocked`, `needs_decision`, `waiting` or null. It comes from the turn text's first line, its status line: `STATUS: DONE`, `STATUS: BLOCKED`, `STATUS: NEEDS DECISION` or `STATUS: WAITING <on what> [for <N> min|h]`, matched by `/^[\W_]*STATUS[\W_]*:?[\W_]*(DONE|BLOCKED|NEEDS DECISION|WAITING)\b/i`, so decoration around it is allowed (`**STATUS: DONE**`).
- `waitingOn` is what a wait names (at most 120 characters); `until` is when it ends: its `for` (at most 24 h), else `laneWatch.waitingMin` after the turn.
- `firstLine` is that first line.
- `bg` and `crons` count the background tasks and the scheduled wake-ups.
- `question` is the menu's question as the screen shows it: the last line ending in "?", else the line above the options, at most 200 characters.
- `error` is the error's type.
- `reason` is `waiting` (the turn said WAITING, or ended with background work or a wake-up) or `no_status`; `since` is the end of the turn that went stale; `stalls` counts the stale events since the lane last ended DONE, BLOCKED or NEEDS DECISION.

**The shape:** `{ v: 1, t: "lane", seq, event, node, window, lane, sessionId?, at, … }`.
- `seq` is the fleet's own counter, growing by one.
- `lane` is the window's name when it is a lane, and null otherwise.
- `at` is when it happened, on the node's clock.

**Where they go.**
- **Every client:** `/v1/events` (§9) and `GET /v1/lane-events?since=<seq>`. That route answers at most 1000 events, oldest first, from the last 7 days.
- **The manager:** delivered in batches, by the fleet's `laneEvents` config:
  - every `batchMs` (3000), one delivery to the lane `deliverTo` (default `manager`; `null` turns this off), split at 8000 characters;
  - its text is the `header` line, then one JSON line per event: `{ ts, lane, sessionId, event, status, firstLine, bg, crons }`, with `waitingOn` and `until` for a wait, and `{ ts, lane, sessionId, event, reason, waitingOn, since, stalls }` for `stale`;
  - its delivery id is `fleet:lane-events:<node>:<the first event's time, in ms>`. A batch split over 8000 characters gets `-1`, `-2` … after it, and a batch queued again after its delivery was given up gets `.2`, `.3` … after any of those.
- **Not sent:**
  - `answered` is published but not delivered;
  - the manager's own lane, and lanes matching `laneEvents.ignore` (globs), raise none;
  - events stored while `deliverTo` is `null` are never delivered later, so turning delivery on doesn't flood the manager with old ones.
- **Not made at all:** a Stop or StopFailure hook that the relay couldn't place in a window (§11.2) makes no lane event.

Each event is stored in the same synced commit as the hooks it came from, so a fleet restart loses none, and the ones the manager hasn't had are sent then.

While the examples above ran, a menu opened on `w1` and was answered. Now its turn ends, posted the way Claude Code posts its Stop hook (§11):

```example hook-stop
POST http://127.0.0.1:8787/hook/stop
content-type: application/json

{
  "session_id": "{{uuid:w1-session}}",
  "transcript_path": "/home/user/.claude/projects/-home-user-docs/w1.jsonl",
  "cwd": "/home/user/docs",
  "permission_mode": "default",
  "hook_event_name": "Stop",
  "last_assistant_message": "STATUS: DONE\nThe docs build is green.",
  "background_tasks": [{ "id": "task-1", "name": "docs-check", "status": "running" }],
  "session_crons": []
}
---
200
content-type: application/json

{"ok":true,"queued":true}
```

```example lane-events poll
GET /v1/lane-events?since=0
---
200

{ "events": [
  { "v": 1, "t": "lane", "seq": "{{number:le1}}", "event": "needs_input", "node": "n1", "window": "w1", "lane": "w1", "sessionId": "{{uuid:w1-session}}", "at": "{{time}}", "question": "Do you want to proceed?" },
  { "v": 1, "t": "lane", "seq": "{{number:le2}}", "event": "answered", "node": "n1", "window": "w1", "lane": "w1", "sessionId": "{{uuid:w1-session}}", "at": "{{time}}" },
  { "v": 1, "t": "lane", "seq": "{{number:le3}}", "event": "finished", "node": "n1", "window": "w1", "lane": "w1", "sessionId": "{{uuid:w1-session}}", "at": "{{time}}", "status": "done", "firstLine": "STATUS: DONE", "bg": 1, "crons": 0 }
] }
```

The same turn's end in the older body that the owner's Stop script posts (§11.3), after the last event seen:

```example hook-stop-compat
POST http://127.0.0.1:8787/hook/stop
content-type: application/json

{ "window": "w1", "cwd": "/home/user/docs", "session_id": "{{uuid:w1-session}}", "branch": "docs/api", "changed": 3, "ahead": 1, "text": "STATUS: BLOCKED\nThe staging key is missing.", "background": 0, "crons": 1 }
---
200

{"ok":true,"queued":true}
```

```example lane-events-since poll
GET /v1/lane-events?since={{number:le3}}
---
200

{ "events": [
  { "v": 1, "t": "lane", "seq": "{{number:le4}}", "event": "finished", "node": "n1", "window": "w1", "lane": "w1", "sessionId": "{{uuid:w1-session}}", "at": "{{time}}", "status": "blocked", "firstLine": "STATUS: BLOCKED", "bg": 0, "crons": 1 }
] }
```

A turn that ended on an API error, first as Claude Code posts its StopFailure hook, then in the owner's script's body:

```example hook-failure
POST http://127.0.0.1:8787/hook/failure
content-type: application/json

{
  "session_id": "{{uuid:w1-session}}",
  "transcript_path": "/home/user/.claude/projects/-home-user-docs/w1.jsonl",
  "cwd": "/home/user/docs",
  "permission_mode": "default",
  "hook_event_name": "StopFailure",
  "error_type": "rate_limit",
  "error_message": "Rate limit exceeded. Please retry after 60 seconds."
}
---
202
```

```example hook-failure-compat
POST http://127.0.0.1:8787/hook/failure
content-type: application/json

{ "window": "w1", "session_id": "{{uuid:w1-session}}", "error": "rate limited" }
---
202
```

```example lane-events-failures poll
GET /v1/lane-events?since={{number:le4}}
---
200

{ "events": [
  { "v": 1, "t": "lane", "seq": "{{number}}", "event": "stop_failure", "node": "n1", "window": "w1", "lane": "w1", "sessionId": "{{uuid:w1-session}}", "at": "{{time}}", "error": "rate_limit" },
  { "v": 1, "t": "lane", "seq": "{{number}}", "event": "stop_failure", "node": "n1", "window": "w1", "lane": "w1", "sessionId": "{{uuid:w1-session}}", "at": "{{time}}", "error": "rate limited" }
] }
```

### 7.1 The lane watch

The fleet keeps each lane's last turn end and watches for anything after it: a hook from that lane (progress, a new turn, a session state change) is activity. Each kind of turn end has a deadline:

| Last turn | Deadline |
|---|---|
| `STATUS: WAITING` | its `until` |
| no status, background work running or a wake-up scheduled | the turn's end + `laneWatch.waitingMin` (30 min) |
| no status, nothing running | the turn's end + `laneWatch.noStatusMin` (15 min) |
| `DONE`, `BLOCKED`, `NEEDS DECISION` | none: it is the manager's to act on |

- **Past the deadline with no activity,** the fleet makes one `stale` lane event for that turn. It goes where the other lane events go.
- **The nudge.** With `laneWatch.nudge` (on by default), a lane that runs Claude Code (a session in the node's inventory) gets one delivery, id `fleet:nudge:<node>:<the turn's end, in ms>`: when its turn ended, on what it waited, and the status line to start its answer with. From the third stale event since the lane last settled, it isn't nudged again: that lane is for the manager to re-plan.
- **Not watched:** the manager's own lane, lanes matching `laneEvents.ignore`, and a lane whose window is gone. A lane whose node isn't online waits until the node is back: the node's status already says why it is quiet.
- **Restarts.** The watch lives in the fleet's memory and is rebuilt from the last day's lane events at start. A restart counts as activity, so each deadline runs again from it, and no lane is called stale for time the fleet didn't see.

`GET /v1/lane-watch` answers what the watch holds, oldest first: `{ lanes: { node, window, at, status, deadline, reason?, waitingOn?, stale, stalls }[] }`. `deadline` is null for a settled turn; `reason` is there with a deadline.

```example lane-watch
GET /v1/lane-watch
---
200

{ "lanes": [
  { "node": "n1", "window": "w1", "at": "{{time}}", "status": "blocked", "deadline": null, "stale": false, "stalls": 0 }
] }
```

A `stale` event, as `/v1/lane-events` and `/v1/events` carry it:

```json
{ "v": 1, "t": "lane", "seq": 9, "event": "stale", "node": "n1", "window": "w1", "lane": "w1", "sessionId": "…", "at": 1791850022000, "reason": "waiting", "waitingOn": "CI", "since": 1791849122000, "stalls": 1 }
```

## 8. Ops (`POST /v1/op`)

**The body:** `{ node | workerId | lane, op, args, key?, timeoutMs? }`. Exactly one target is named.
- **Lane targets.** For a `lane`, the fleet gives the pane ops (`pane.frame`, `pane.keys`, `pane.send`) the lane's worker id. `pane.send` and `pane.keys` also get the expectation `{ server, window: lane }`, unless `args` has one. A pane renamed or reused meanwhile then refuses with `no_pane` instead of taking the keys.
- **Keys.** A keyed op (`pane.send`, `file.put`, `lane.start`, `lane.stop`, `worktree.add`) needs a `key`: namespaced, at most 256 characters, the same on every retry. Any other op refuses a key.
- **Retries.** A keyed op takes effect at most once per key within 7 days. A repeat answers the stored outcome, or `uncertain` while the first attempt's outcome is unknown. `op.status` says which.
- **Timeouts.** `timeoutMs` runs from 1 to 120000, 15000 by default. A side effect that hasn't started by then answers `timeout`, not executed.

**The answer** is always status 200 and an op's outcome:
- `{ ok: true, result, invVersion, store, storeSeq }`, or
- `{ ok: false, error: { code, executed, message }, store, storeSeq }`.

`store` names the node's database that answered, and `storeSeq` how many keyed ops it has started. Both are null when nothing was sent to a node. Only a body that isn't an op at all gets another status (400, 413, 415, §10).

| Op | Args | Result | Key |
|---|---|---|---|
| `inventory.get` | `{}` | `{ panes, invVersion }`. Each pane is `{ workerId, window, cwd, sessionId?, sessionName?, title?, claudeVersion?, status, pid, topic?, lastPrompt? }`. `status` is the live session's (`busy`, `idle`, `waiting`, or `shell`: a shell command running under it) and `pid` Claude Code's process, each null without a live session; `topic` and `lastPrompt` are the session's latest `ai-title` and `last-prompt` entries, absent when unknown. | none |
| `pane.captureMany` | `{ workerIds }`, at most 64 | `{ captures: { workerId, text \| null, truncated }[] }`, each at most 6 KiB | none |
| `pane.capture` | `{ workerId, lines (1–2000), attributes?, join? }` | `{ text \| null, truncated }`, at most 256 KiB as JSON. `attributes` keeps tmux's colour escapes, so dim text can be told apart; `join` (default true) joins wrapped lines. | none |
| `pane.frame` | `{ workerId }` | `{ frame: { cols, rows, x, y, cursor, lines } \| null }` | none |
| `pane.keys` | `{ workerId, expect }` with exactly one of `data` (literal text, at most 4096) or `names` (key names: `Enter`, `Escape`, `Tab`, `BSpace`, `Up`, `Down`, `Left`, `Right`, `Home`, `End`, `PageUp`, `PageDown`, `C-c`, `C-d`, `C-u`, `Space`, the digits, the letters) | `{ ok }` | none: keys are never retried |
| `pane.send` | `{ workerId, text (at most 8000), expect }` | `{ problem: null \| "not_submitted", typedAt }`. It types at once or refuses (§10). A lane running Claude Code is better reached by a delivery (§6). | yes |
| `op.status` | `{ key }` | `{ state: "unknown" \| "started" \| "done", outcome? }` | none |
| `transcript.size` | `{ sessionId }` | `{ size \| null }` | none |
| `transcript.read` | `{ sessionId, offset, max (at most 256 KiB) }` | `{ bytes (base64), eof }` | none |
| `transcript.locate` | `{ sessionId, needle (at most 200) }` | `{ offset \| null }`: the start of the line that holds it | none |
| `file.stat` | `{ path \| ref }` | `{ size, mtime }` | none |
| `file.get` | `{ path \| ref, offset, max }` | `{ bytes (base64), size, eof }` | none |
| `file.put` | `{ upload, offset, bytes (base64), final, name }` | `{ path \| null }`: the file's place once final | yes |
| `lane.start` | `{ name, cwd, account?, resume?, prompt?, role?, engine?, reason? }` | `{ workerId, waiting?: "trust", prompt?, engine? }` (below) | yes |
| `lane.stop` | `{ name, mode?: "exit" \| "kill" }` | `{ ok: true }` (below) | yes |
| `worktree.list` | `{ repo }` | `{ worktrees: { path, branch \| null }[] }` | none |
| `worktree.add` | `{ repo, name, base }` | `{ path }`: beside the repository, `<repo>-worktrees/<name>` | yes |
| `lane.deliver`, `delivery.cancel` | | refused here with `bad_args`: use `/v1/deliveries` (§6), which records the delivery for every client | |

**`lane.start`** runs the node's launcher, `launch` in its `policy.json`; the default is `{ "command": ["claude"], "via": "shell" }`.
- `{account}` in the command is the op's `account`, and `resume` adds `--resume <session>`. An op can add nothing else to the command.
- With `via: "shell"`, the window starts the user's shell, and the launcher is pasted once the shell's prompt shows. The window then outlives Claude Code.
- `prompt` becomes a delivery to the new pane, whose id the answer carries as `prompt`: `<client>:prompt:<the first 16 hex digits of the SHA-256 of the start's key>`, always within 200 characters. It waits for Claude Code to start, so it never races the startup.
- `waiting: "trust"`: Claude Code is asking whether to trust the folder. Accepting stays the client's decision: send the keys.

**On an engine.** A node whose policy has `engines` (the node agent's README) can start a lane on an engine of the engine layer, `provider:model[@effort]`, with that provider's launch command:
- `role` asks the node's engine layer what runs that Role now, and starts it. `engine` names one; on a node with a default role it needs a `reason`. Both at once are refused (`bad_args`).
- A start that names neither runs the node's `engines.defaultRole` when it has one, except a `resume` and a protected lane.
- It never falls back to `launch` quietly. A node without engines, a role nothing can fill now, a provider with no launch command there, or the engine layer switched off: `denied`, nothing started. An unknown role: `bad_args`.
- The answer's `engine` says what ran: `{ entry, role?, skipped? }`. `skipped` lists what the resolver passed over first, each with its reason; when it isn't empty, the fleet raises `engine_fallback` (§14). The audit row of the start keeps the `role` or `engine`, the `reason` and the entry that ran (`ran`).

**`lane.stop`.** The default, `exit`, types `/exit` the way a delivery is typed and answers Claude Code's exit prompt. It then answers once the window has closed or is back at its shell, or with `uncertain` after 30 s. `kill` closes the window. Names in the policy's `protected` list (default `["manager"]`) are refused with `denied`.

```example op-inventory
POST /v1/op
x-morndo-client: lanes
content-type: application/json

{ "node": "n1", "op": "inventory.get", "args": {} }
---
200

{
  "ok": true,
  "result": {
    "panes": [
      "{{unordered}}",
      { "workerId": "{{workerId:manager}}", "window": "manager", "cwd": "{{string}}", "sessionId": "{{uuid:manager-session}}", "sessionName": "{{string?}}", "title": "{{string?}}", "claudeVersion": "2.1.293", "status": "idle", "pid": "{{number}}", "topic": "{{string?}}", "lastPrompt": "{{string?}}" },
      { "workerId": "{{workerId:w1}}", "window": "w1", "cwd": "{{string}}", "sessionId": "{{uuid:w1-session}}", "sessionName": "{{string?}}", "title": "{{string?}}", "claudeVersion": "2.1.293", "status": "idle", "pid": "{{number}}", "topic": "{{string?}}", "lastPrompt": "{{string?}}" },
      { "workerId": "{{workerId:sh1}}", "window": "sh1", "cwd": "{{string}}", "title": "{{string?}}", "status": null, "pid": null },
      { "workerId": "{{workerId}}", "window": "dup", "cwd": "{{string}}", "title": "{{string?}}", "status": null, "pid": null },
      { "workerId": "{{workerId}}", "window": "dup", "cwd": "{{string}}", "title": "{{string?}}", "status": null, "pid": null }
    ],
    "invVersion": "{{number}}"
  },
  "invVersion": "{{number}}",
  "store": "{{uuid:store}}",
  "storeSeq": "{{number}}"
}
```

```example op-capture-many
POST /v1/op
x-morndo-client: lanes
content-type: application/json

{ "node": "n1", "op": "pane.captureMany", "args": { "workerIds": ["{{workerId:w1}}"] } }
---
200

{ "ok": true, "result": { "captures": [ { "workerId": "{{workerId:w1}}", "text": "{{string}}", "truncated": false } ] }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-capture
POST /v1/op
x-morndo-client: kira
content-type: application/json

{ "workerId": "{{workerId:w1}}", "op": "pane.capture", "args": { "workerId": "{{workerId:w1}}", "lines": 60, "attributes": true } }
---
200

{ "ok": true, "result": { "text": "{{string}}", "truncated": false }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-frame
POST /v1/op
x-morndo-client: hub
content-type: application/json

{ "lane": "w1", "op": "pane.frame", "args": {} }
---
200

{ "ok": true, "result": { "frame": { "cols": "{{number}}", "rows": "{{number}}", "x": "{{number}}", "y": "{{number}}", "cursor": "{{any}}", "lines": "{{any}}" } }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-send
POST /v1/op
x-morndo-client: kira
content-type: application/json

{ "lane": "w1", "op": "pane.send", "args": { "text": "Hello from the docs." }, "key": "kira:doc-send-1" }
---
200

{ "ok": true, "result": { "problem": null, "typedAt": "{{time}}" }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-status
POST /v1/op
x-morndo-client: kira
content-type: application/json

{ "node": "n1", "op": "op.status", "args": { "key": "kira:doc-send-1" } }
---
200

{ "ok": true, "result": { "state": "done", "outcome": { "problem": null, "typedAt": "{{time}}" } }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

Keys, as literal text and then by name. `C-u` clears the line the text left in the input box:

```example op-keys-text
POST /v1/op
x-morndo-client: kira
content-type: application/json

{ "lane": "w1", "op": "pane.keys", "args": { "data": "x" } }
---
200

{ "ok": true, "result": { "ok": true }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-keys-names
POST /v1/op
x-morndo-client: kira
content-type: application/json

{ "lane": "w1", "op": "pane.keys", "args": { "names": ["C-u"] } }
---
200

{ "ok": true, "result": { "ok": true }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-transcript-size
POST /v1/op
x-morndo-client: hub
content-type: application/json

{ "node": "n1", "op": "transcript.size", "args": { "sessionId": "{{uuid:w1-session}}" } }
---
200

{ "ok": true, "result": { "size": "{{number}}" }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-transcript-read
POST /v1/op
x-morndo-client: hub
content-type: application/json

{ "node": "n1", "op": "transcript.read", "args": { "sessionId": "{{uuid:w1-session}}", "offset": 0, "max": 64 } }
---
200

{ "ok": true, "result": { "bytes": "{{string}}", "eof": false }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-transcript-locate
POST /v1/op
x-morndo-client: hub
content-type: application/json

{ "node": "n1", "op": "transcript.locate", "args": { "sessionId": "{{uuid:w1-session}}", "needle": "Hello from the docs." } }
---
200

{ "ok": true, "result": { "offset": "{{number}}" }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-file-stat
POST /v1/op
x-morndo-client: kira
content-type: application/json

{ "node": "n1", "op": "file.stat", "args": { "path": "{{string:notes}}" } }
---
200

{ "ok": true, "result": { "size": 6, "mtime": "{{number}}" }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-file-get
POST /v1/op
x-morndo-client: kira
content-type: application/json

{ "node": "n1", "op": "file.get", "args": { "path": "{{string:notes}}", "offset": 0, "max": 1024 } }
---
200

{ "ok": true, "result": { "bytes": "aGVsbG8K", "size": 6, "eof": true }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-file-put
POST /v1/op
x-morndo-client: hub
content-type: application/json

{ "node": "n1", "op": "file.put", "args": { "upload": "docup1", "offset": 0, "bytes": "aGkK", "final": true, "name": "hi.txt" }, "key": "hub:doc-upload-1" }
---
200

{ "ok": true, "result": { "path": "{{string}}" }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

A lane started with a first prompt, which is delivered once Claude Code can take it:

```example op-lane-start
POST /v1/op
x-morndo-client: lanes
content-type: application/json

{ "node": "n1", "op": "lane.start", "args": { "name": "w2", "cwd": "{{string:w2-dir}}", "prompt": "Start with the README." }, "key": "lanes:doc-start-w2", "timeoutMs": 30000 }
---
200

{ "ok": true, "result": { "workerId": "{{workerId:w2}}", "prompt": "lanes:prompt:052ed21d0f6032a9" }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-lane-start-prompt poll
GET /v1/deliveries/lanes:prompt:052ed21d0f6032a9
---
200

{ "delivery": { "id": "lanes:prompt:052ed21d0f6032a9", "node": "n1", "target": { "workerId": "{{workerId:w2}}" }, "state": "delivered", "queuedAt": "{{time}}", "notAfter": "{{time}}", "sessionId": "{{uuid:w2-session}}", "typedAt": "{{time}}", "deliveredAt": "{{time}}" }, "stale": false }
```

A lane started in a folder Claude Code doesn't trust yet:

```example op-lane-start-trust
POST /v1/op
x-morndo-client: lanes
content-type: application/json

{ "node": "n1", "op": "lane.start", "args": { "name": "w3", "cwd": "{{string:w3-dir}}" }, "key": "lanes:doc-start-w3", "timeoutMs": 30000 }
---
200

{ "ok": true, "result": { "workerId": "{{workerId:w3}}", "waiting": "trust" }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-lane-stop-kill
POST /v1/op
x-morndo-client: lanes
content-type: application/json

{ "node": "n1", "op": "lane.stop", "args": { "name": "w3", "mode": "kill" }, "key": "lanes:doc-stop-w3" }
---
200

{ "ok": true, "result": { "ok": true }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-lane-stop
POST /v1/op
x-morndo-client: lanes
content-type: application/json

{ "node": "n1", "op": "lane.stop", "args": { "name": "w2" }, "key": "lanes:doc-stop-w2", "timeoutMs": 45000 }
---
200

{ "ok": true, "result": { "ok": true }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-lane-stop-protected
POST /v1/op
x-morndo-client: lanes
content-type: application/json

{ "node": "n1", "op": "lane.stop", "args": { "name": "manager" }, "key": "lanes:doc-stop-manager" }
---
200

{ "ok": false, "error": { "code": "denied", "executed": "no", "message": "{{string}}" }, "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-worktree-list
POST /v1/op
x-morndo-client: hub
content-type: application/json

{ "node": "n1", "op": "worktree.list", "args": { "repo": "{{string:repo}}" } }
---
200

{ "ok": true, "result": { "worktrees": [ { "path": "{{string}}", "branch": "main" } ] }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example op-worktree-add
POST /v1/op
x-morndo-client: hub
content-type: application/json

{ "node": "n1", "op": "worktree.add", "args": { "repo": "{{string:repo}}", "name": "doc-wt", "base": "main" }, "key": "hub:doc-worktree-1" }
---
200

{ "ok": true, "result": { "path": "{{string}}" }, "invVersion": "{{number}}", "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

The two delivery ops are the node's own; a client reaches them through `/v1/deliveries`:

```example op-deliver-refused
POST /v1/op
x-morndo-client: kira
content-type: application/json

{ "node": "n1", "op": "lane.deliver", "args": { "id": "kira:doc:op", "target": { "lane": "w1", "sticky": false }, "text": "x" } }
---
400

{ "ok": false, "error": { "code": "bad_args", "executed": "no", "message": "{{string}}" }, "store": null, "storeSeq": null }
```

```example op-cancel-refused
POST /v1/op
x-morndo-client: kira
content-type: application/json

{ "node": "n1", "op": "delivery.cancel", "args": { "id": "kira:doc:1" } }
---
400

{ "ok": false, "error": { "code": "bad_args", "executed": "no", "message": "{{string}}" }, "store": null, "storeSeq": null }
```

**Background jobs and connections.** These ops came with background jobs (`docs/design/background-jobs/README.md`) and the Connections service (`docs/design/secret-store/README.md`). Their requests are shown below but not run by this document's test: a job needs a node with jobs on, and the `connections.*` ops need a node's Connections service. `apps/fleet/test/jobs.test.ts` and the connections tests cover them.
- `job.cancel` `{ id, token }`: cancels a queued or running job. The fleet sends it to the job's own node, whatever the target names, and the token stays in the args that node checks. A job the fleet doesn't know is `denied`.
- `job.noticeResult` `{ id, notice }`: what the hub's board did with a job's notice, `commented` or `given_up`. The fleet and the node keep the same state.
- `job.notice`: the fleet's own (its job mirror sends it to a node). `POST /v1/op` refuses it as an unknown op.
- `connections.priority`, `connections.role`, `connections.revoke` and `connections.narrow` change a node's LLM connections. The first three need a fresh passkey at the hub (`STEP_UP_OPS`); narrowing (off, a lower budget, a deny) doesn't. Each carries the version it was made against.

```json
{ "node": "n1", "op": "job.cancel", "args": { "id": "job-1", "token": "<the job's token>" } }
{ "node": "n1", "op": "job.noticeResult", "args": { "id": "job-1", "notice": "commented" } }
{ "node": "n1", "op": "job.notice", "args": { "id": "node:job:n1:job-1:done", "lane": "w1", "text": "pack finished" } }
{ "node": "n1", "op": "connections.priority", "args": { "version": 3, "mode": "<mode>", "order": ["claude", "codex"] } }
{ "node": "n1", "op": "connections.role", "args": { "version": 3, "role": "builder", "override": "own", "order": ["claude"], "picks": [] } }
{ "node": "n1", "op": "connections.revoke", "args": { "version": 3, "name": "codex" } }
{ "node": "n1", "op": "connections.narrow", "args": { "version": 3, "name": "codex", "action": "lower-budget", "budget": 5 } }
```

**Jobs, read.** `GET /v1/jobs?node=&lane=&state=` answers `{ jobs, stale }` from the fleet's table, `stale` while a named node is offline; `GET /v1/jobs/<node>/<id>` answers `{ job, stale }`, or 404. A job is the pair (node, id), its state, and a redacted tail; never its command (FL14).

## 9. Events (`WS /v1/events`)

A WebSocket on the socket, `ws://fleet/v1/events`, at the path's version. It sends JSON messages `{ t, node, body }`:

| `t` | `body` |
|---|---|
| `status` | `{ status }`: a node went `online`, `stale` or `offline` |
| `inventory` | `{ panes, invVersion }`: a node's lanes changed (the result of `inventory.get`, §8) |
| `health` | the node's health report |
| `conflict` | `{ name, nodes }`: a lane name went into conflict (the nodes whose windows claim it), or out of it (`[]`) |
| `alert` | an alert (§14); `node` is the alert's node, or "" |
| `delivery` | a delivery's new state: the `Delivery` of §6.2 with `stale` |
| `lane` | a lane event (§7) |
| `job` | a background job's state, as `GET /v1/jobs` lists it (§8, Background jobs) |

**On connecting,** a client first gets each node's `status`, then each online node's latest `inventory` and `health`. Every event after that comes as it happens.

**Reconnecting.** Deliveries, lane events, alerts and conflicts that happened while a client was away are not replayed. Read them from `/v1/deliveries`, `/v1/lane-events?since=` and `/v1/alerts` after each reconnect.

**A client that doesn't read** is closed with 1013 once 8 MiB of events wait for it. It gets the current state first when it reconnects.

```example events-connect
WS /v1/events
---
{"t":"status","node":"n1","body":{"status":"online"}}
{"t":"status","node":"n2","body":{"status":"offline"}}
{"t":"inventory","node":"n1","body":{"panes":"{{any}}","invVersion":"{{number}}"}}
{"t":"health","node":"n1","body":"{{any}}"}
```

These were sent while the examples above ran:

```example events-conflict events
{"t":"conflict","node":"n1","body":{"name":"dup","nodes":["n1"]}}
```

```example events-alert events
{"t":"alert","node":"n1","body":{"id":"{{number}}","at":"{{time}}","node":"n1","kind":"lane_conflict","detail":{"name":"dup","claims":["{{unordered}}",{"node":"n1","workerId":"{{workerId}}"},{"node":"n1","workerId":"{{workerId}}"}]}}}
```

```example events-delivery events
{"t":"delivery","node":"n1","body":{"id":"kira:doc:1","node":"n1","target":{"lane":"w1"},"state":"delivered","queuedAt":"{{time}}","notAfter":"{{time}}","sessionId":"{{uuid:w1-session}}","typedAt":"{{time}}","deliveredAt":"{{time}}","stale":false}}
```

```example events-lane events
{"t":"lane","node":"n1","body":{"v":1,"t":"lane","seq":"{{number:le3}}","event":"finished","node":"n1","window":"w1","lane":"w1","sessionId":"{{uuid:w1-session}}","at":"{{time}}","status":"done","firstLine":"STATUS: DONE","bg":1,"crons":0}}
```

## 10. Errors

**Every refusal says whether anything ran.** `executed: "no"` is safe to retry. `executed: "maybe"` means the side effect may have happened: ask `op.status` with the same key, and never retry blindly.

**Statuses** (plan/RECONCILIATION.md rulings 3 and 45):
- On `POST /v1/op`, `POST /v1/deliveries` and `POST /v1/deliveries/<id>/cancel`, every outcome is status 200, refusals included: `{ ok: false, error }` (§6, §8).
- A body that doesn't fit is the exception: 400 for one that doesn't fit the route, 415 for one that isn't JSON, 413 for one over 1 MiB, each `{ ok: false, error }` (`bad_args`, or `too_large` over the limit). On `/v1/op` it also carries `store: null, storeSeq: null`: nothing was sent to a node.
- An unknown delivery id is 404 `{ error: "no_such_delivery" }`, on `GET` and on cancel.
- On `/v1/files`, a refusal before the first byte has the status of §12.

| Code | Executed | Means | Example |
|---|---|---|---|
| `bad_args` | no | The request or the op's arguments don't fit: an unknown op, a missing or extra key, a field of the wrong type, a delivery id without its client's name. | `err-bad-args`, `err-not-json`, `deliver-bad`, `deliver-malformed` |
| `unknown_op` | no | The node doesn't know an op the fleet does: an older agent. | none: needs an older agent |
| `denied` | no | The node's policy refuses it: an op left out of its `ops`, a `protected` lane for `lane.stop`, a folder lanes may not start in. | `op-lane-stop-protected` |
| `no_pane` | no | No such lane, worker or window, or the pane isn't the one expected (another server, window or session). | `err-no-pane`, `deliver-no-lane` |
| `menu_open` | no | `pane.send`: a menu is on the screen. A delivery waits instead. | `err-menu-open` |
| `no_input_box` | no | `pane.send`: no input box on the screen, such as a shell, or Claude Code still starting. | `err-no-input-box` |
| `draft_present` | no | `pane.send`: the owner's own text is in the input box. | `err-draft-present` |
| `busy` | no | Another typist holds the pane's lock (`lockedPanes`), or 8 bulk ops already wait for the node. | none: needs a lock held from outside |
| `name_taken` | no | `lane.start` of a name registered anywhere in the fleet, or being started; `worktree.add` of a branch that exists. | `err-name-taken` |
| `lane_conflict` | no | Two windows claim the lane name: address one by its worker id. | `err-lane-conflict`, `deliver-conflict` |
| `too_large` | no | A body over 1 MiB, a message over 512 KiB, a file over 25 MiB or over the node's disk budget. | none: a body over 1 MiB |
| `timeout` | no | The deadline passed before the side effect started, or a read had no answer in time. | none: needs a stalled node |
| `node_offline` | no | The node isn't connected. Nothing is queued anywhere else. | `err-node-offline`, `deliver-offline` |
| `uncertain` | maybe | The side effect may have happened: the connection dropped after it started, or the key's first attempt never finished. | none: needs a drop in mid-op (the drills have one) |
| `internal` | maybe | The node or the fleet failed while acting, or sent a code this client doesn't know (§2). | none |
| `id_conflict` | no | A delivery id already used with another target or text. | `deliver-id-conflict` |
| `no_session` | no | A delivery to a pane with no live Claude Code session (no session file, or its process gone) that isn't waiting for one to start (§6.1). | `deliver-no-session` |
| `already_typed` | no | `cancel` of a delivery past `queued`. | `cancel-typed` |
| `updating` | no | The fleet or the node holds new work while it updates (503 from the fleet). Narrowing, revoking, `lane.stop`, `job.cancel` and `delivery.cancel` still run; a delivery already queued waits (`unavailable`). | none: needs an update in progress |
| `not_allowed` | no | `file.put`: a file the attachment policy refuses (not an allowed kind, or a text file that isn't UTF-8). | none |

```example err-bad-args
POST /v1/op
x-morndo-client: kira
content-type: application/json

{ "lane": "w1", "op": "pane.paste", "args": {} }
---
400

{ "ok": false, "error": { "code": "bad_args", "executed": "no", "message": "{{string}}" }, "store": null, "storeSeq": null }
```

```example err-not-json
POST /v1/op
x-morndo-client: kira
content-type: text/plain

send hello to w1
---
415

{ "ok": false, "error": { "code": "bad_args", "executed": "no", "message": "{{string}}" }, "store": null, "storeSeq": null }
```

```example err-no-pane
POST /v1/op
x-morndo-client: kira
content-type: application/json

{ "lane": "nobody", "op": "pane.send", "args": { "text": "Hello?" }, "key": "kira:doc-send-nobody" }
---
200

{ "ok": false, "error": { "code": "no_pane", "executed": "no", "message": "{{string}}" }, "store": null, "storeSeq": null }
```

`w1` shows a menu:

```example err-menu-open
POST /v1/op
x-morndo-client: kira
content-type: application/json

{ "lane": "w1", "op": "pane.send", "args": { "text": "Over the menu?" }, "key": "kira:doc-send-menu" }
---
200

{ "ok": false, "error": { "code": "menu_open", "executed": "no", "message": "{{string}}" }, "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

The owner has half a thought typed in `w1`'s box:

```example err-draft-present
POST /v1/op
x-morndo-client: kira
content-type: application/json

{ "lane": "w1", "op": "pane.send", "args": { "text": "Over the draft?" }, "key": "kira:doc-send-draft" }
---
200

{ "ok": false, "error": { "code": "draft_present", "executed": "no", "message": "{{string}}" }, "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example err-no-input-box
POST /v1/op
x-morndo-client: kira
content-type: application/json

{ "lane": "sh1", "op": "pane.send", "args": { "text": "ls" }, "key": "kira:doc-send-shell" }
---
200

{ "ok": false, "error": { "code": "no_input_box", "executed": "no", "message": "{{string}}" }, "store": "{{uuid:store}}", "storeSeq": "{{number}}" }
```

```example err-name-taken
POST /v1/op
x-morndo-client: lanes
content-type: application/json

{ "node": "n1", "op": "lane.start", "args": { "name": "w1", "cwd": "{{string:w2-dir}}" }, "key": "lanes:doc-start-w1-again" }
---
200

{ "ok": false, "error": { "code": "name_taken", "executed": "no", "message": "{{string}}" }, "store": null, "storeSeq": null }
```

```example err-lane-conflict
POST /v1/op
x-morndo-client: kira
content-type: application/json

{ "lane": "dup", "op": "pane.send", "args": { "text": "Which one?" }, "key": "kira:doc-send-dup" }
---
200

{ "ok": false, "error": { "code": "lane_conflict", "executed": "no", "message": "{{string}}" }, "store": null, "storeSeq": null }
```

```example err-node-offline
POST /v1/op
x-morndo-client: hub
content-type: application/json

{ "node": "n2", "op": "inventory.get", "args": {} }
---
200

{ "ok": false, "error": { "code": "node_offline", "executed": "no", "message": "{{string}}" }, "store": null, "storeSeq": null }
```

## 11. The hook relay and its bodies

Each node runs a hook relay on `127.0.0.1:8787` (the agent's `relayPort`). Claude Code's HTTP hooks and the node's hook scripts post there, so `~/.claude/settings.json` can be the same on every machine.
- **Acknowledging.** The relay answers once the event is durable in the node's hook stream, and before any network I/O.
- **On to the fleet.** The node sends the events on, in order, and the fleet keeps each one until every subscriber has it (§13).
- **Web pages are refused.** A request with an `Origin` header comes from a web page, never from a hook, and the relay refuses it.

### 11.1 Paths and answers

| Path | What | Answer | Kept |
|---|---|---|---|
| `/cc` | tool-call progress (`PreToolUse` and the like) | 204, empty, always: a slow answer would stall the session | the latest per session |
| `/sl` | the status line's data | 204, empty, always | the latest per session |
| `/hook/stop` | a turn's end (`Stop`) | 200 `{"ok":true,"queued":true}`, or the status ask (below) | every one, the asked ones not |
| `/hook/failure` | a turn ended on an API error (`StopFailure`) | 202 | every one |
| `/notify` | a message for the owner | 202 | every one |
| `/file` | a file for the owner: `{ path, … }` | 202 (413 over 25 MiB, 400 for a path that isn't absolute, 403 where files are never shared, 404 when missing) | a copy, by the node's file rules |

When the stream can't be written (a full disk), the script paths answer 503 so the calling script's own fallback runs, while `/cc` and `/sl` still answer 204 and count the event as dropped. Claude Code treats an HTTP hook's non-2xx answer, or no answer, as a non-blocking error (§15).

**The status ask.** A lane's answer starts with a status line (§7). When Claude Code's own Stop body comes from a lane whose answer has none, the relay asks for it once: it answers 200 `{"decision":"block","reason":…}`, Claude Code goes on with the reason as its instruction, and the next Stop is the turn's end. The asked Stop isn't kept, so it makes no lane event. It asks only when all of these hold:
- the body is Claude Code's `Stop` (`hook_event_name`), from a window the relay placed (§11.2);
- the Stop wasn't itself caused by a Stop hook (`stop_hook_active` false): so once per turn, far below Claude Code's limit of eight in a row;
- no background task is running and no wake-up is scheduled (`background_tasks`, `session_crons` empty);
- the policy's `statusContract.mode` is `ask` (the default) and the lane isn't in `statusContract.exempt` (default `["manager"]`).

```example hook-stop-asked
POST http://127.0.0.1:8787/hook/stop
content-type: application/json

{
  "session_id": "{{uuid:w1-session}}",
  "transcript_path": "/home/user/.claude/projects/-home-user-docs/w1.jsonl",
  "cwd": "/home/user/docs",
  "permission_mode": "default",
  "hook_event_name": "Stop",
  "stop_hook_active": false,
  "last_assistant_message": "I pushed the branch.",
  "background_tasks": [],
  "session_crons": []
}
---
200
content-type: application/json

{"decision":"block","reason":"Start a short answer with one line saying where this lane stands, then stop: STATUS: DONE, STATUS: BLOCKED, STATUS: NEEDS DECISION, or STATUS: WAITING <on what> for <N> min. Don't redo the work."}
```

### 11.2 Identity

The relay adds the node's name and the window the event came from, found in this order:
1. the pane in the body's `TMUX_PANE`;
2. the pane where the body's `session_id` runs;
3. the body's own `window`, such as a `notify` sent from outside any pane.

### 11.3 The bodies

**The relay accepts Claude Code's own hook JSON on every path** (§15). Every hook carries `session_id`, `transcript_path`, `cwd` and `hook_event_name`.
- **`Stop`** adds `last_assistant_message`, `background_tasks` (a list) and `session_crons` (a list).
- **`StopFailure`** adds `error_type` and `error_message`. `error_type` is one of: `rate_limit`, `overloaded`, `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `billing_error`, `invalid_request`, `model_not_found`, `server_error`, `max_output_tokens`, `cloud_credential_error`, `unknown`.
- **`PreToolUse`** adds `tool_name`, `tool_input` and `tool_use_id`.

**For compatibility it also accepts the bodies of the owner's older hook scripts:**
- Stop: `{ window, cwd, session_id, branch, changed, ahead, text, background, crons }`.
- StopFailure: `{ window, session_id, error }`.
- `/notify` and `/file`: `{ window?, text?, path?, … }`.

**Lane events (§7) read either form:**
- the text from `last_assistant_message` or `text`;
- the counts from the length of `background_tasks` and `session_crons`, or from `background` and `crons`;
- the error from `error_type` or `error`.

Section 7 has a Stop body and a StopFailure body in each form. The other paths:

```example hook-pretooluse
POST http://127.0.0.1:8787/cc
content-type: application/json

{
  "session_id": "{{uuid:w1-session}}",
  "transcript_path": "/home/user/.claude/projects/-home-user-docs/w1.jsonl",
  "cwd": "/home/user/docs",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": { "command": "npm run docs", "description": "Build the docs" },
  "tool_use_id": "toolu_01docs"
}
---
204
```

```example hook-statusline
POST http://127.0.0.1:8787/sl
content-type: application/json

{ "session_id": "{{uuid:w1-session}}", "transcript_path": "/home/user/.claude/projects/-home-user-docs/w1.jsonl", "cwd": "/home/user/docs", "workspace": { "current_dir": "/home/user/docs" }, "version": "2.1.293" }
---
204
```

```example hook-notify
POST http://127.0.0.1:8787/notify
content-type: application/json

{ "window": "w1", "text": "The docs build is green." }
---
202
```

```example hook-file
POST http://127.0.0.1:8787/file
content-type: application/json

{ "window": "w1", "path": "{{string:notes}}", "caption": "the notes" }
---
202
```

### 11.4 What a subscriber receives

Each event reaches every subscriber that takes its path (§13) as `POST <url>`. The body is the event as JSON: `{ streamId, seq, at, path, node, window, late?, body }`. The header `Idempotency-Key: <node>:<streamId>:<seq>` comes with it.
- `body` is the hook's body as posted, except for `/file`. There the file's path is replaced by `ref`, `name` and `size`, and the bytes come from `GET /v1/files/<node>/<ref>` (§12).
- `late` marks an event the node sent after a long time offline.

```example sub-stop subscriber
POST /fleet/hook
idempotency-key: n1:{{uuid:stream}}:{{number}}
content-type: application/json

{ "streamId": "{{uuid:stream}}", "seq": "{{number}}", "at": "{{time}}", "path": "/hook/stop", "node": "n1", "window": "w1",
  "body": { "session_id": "{{uuid:w1-session}}", "transcript_path": "/home/user/.claude/projects/-home-user-docs/w1.jsonl", "cwd": "/home/user/docs", "permission_mode": "default", "hook_event_name": "Stop", "last_assistant_message": "STATUS: DONE\nThe docs build is green.", "background_tasks": [{ "id": "task-1", "name": "docs-check", "status": "running" }], "session_crons": [] } }
```

```example sub-stop-compat subscriber
POST /fleet/hook
idempotency-key: n1:{{uuid:stream}}:{{number}}

{ "streamId": "{{uuid:stream}}", "seq": "{{number}}", "at": "{{time}}", "path": "/hook/stop", "node": "n1", "window": "w1",
  "body": { "window": "w1", "cwd": "/home/user/docs", "session_id": "{{uuid:w1-session}}", "branch": "docs/api", "changed": 3, "ahead": 1, "text": "STATUS: BLOCKED\nThe staging key is missing.", "background": 0, "crons": 1 } }
```

```example sub-failure subscriber
POST /fleet/hook
idempotency-key: n1:{{uuid:stream}}:{{number}}

{ "streamId": "{{uuid:stream}}", "seq": "{{number}}", "at": "{{time}}", "path": "/hook/failure", "node": "n1", "window": "w1",
  "body": { "session_id": "{{uuid:w1-session}}", "transcript_path": "/home/user/.claude/projects/-home-user-docs/w1.jsonl", "cwd": "/home/user/docs", "permission_mode": "default", "hook_event_name": "StopFailure", "error_type": "rate_limit", "error_message": "Rate limit exceeded. Please retry after 60 seconds." } }
```

```example sub-cc subscriber
POST /fleet/hook
idempotency-key: n1:{{uuid:stream}}:{{number}}

{ "streamId": "{{uuid:stream}}", "seq": "{{number}}", "at": "{{time}}", "path": "/cc", "node": "n1", "window": "w1",
  "body": { "session_id": "{{uuid:w1-session}}", "transcript_path": "/home/user/.claude/projects/-home-user-docs/w1.jsonl", "cwd": "/home/user/docs", "permission_mode": "default", "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": { "command": "npm run docs", "description": "Build the docs" }, "tool_use_id": "toolu_01docs" } }
```

The window of a `notify` comes from its body: no pane or session sent it.

```example sub-notify subscriber
POST /fleet/hook
idempotency-key: n1:{{uuid:stream}}:{{number}}

{ "streamId": "{{uuid:stream}}", "seq": "{{number}}", "at": "{{time}}", "path": "/notify", "node": "n1", "window": "w1", "body": { "window": "w1", "text": "The docs build is green." } }
```

```example sub-file subscriber
POST /fleet/hook
idempotency-key: n1:{{uuid:stream}}:{{number}}

{ "streamId": "{{uuid:stream}}", "seq": "{{number}}", "at": "{{time}}", "path": "/file", "node": "n1", "window": "w1",
  "body": { "window": "w1", "caption": "the notes", "ref": "{{string:ref}}", "name": "hello.txt", "size": 6 } }
```

## 12. Files

`GET /v1/files/<node>/<ref or path>` streams a file from a node:
- **The target.** A value that starts with `/` or `~` is a path, read under the node's file rules (never its secrets or Morndo's own state). Anything else is the `ref` of a file sent through the relay's `/file`. Either is URL-encoded as one segment.
- **The answer.** The bytes, with their size in `x-file-size`.
- **A refusal before the first byte** is `{ ok: false, error }` with status 400 (bad args, such as a missing file), 403 (denied), 413 (too large), 503 (node offline), 504 (timeout) or 502 (uncertain or internal), else 404.
- **A download that ends short of `x-file-size`, or runs past it,** is cut off, so a client sees an error and never a clean short file.

```example files-ref
GET /v1/files/n1/{{uri:ref}}
---
200
content-type: application/octet-stream
x-file-size: 6

hello
```

```example files-path
GET /v1/files/n1/{{uri:notes}}
---
200
x-file-size: 6

hello
```

```example files-missing
GET /v1/files/n1/%2Fnowhere%2Fmissing.txt
---
400

{ "ok": false, "error": { "code": "bad_args", "executed": "no", "message": "{{string}}" } }
```

## 13. The subscriber contract

A subscriber is a URL in the fleet's config (`subscribers: [{ name, url, paths }]`) that takes the events of the hook paths it lists. The fleet's hook bus delivers to it this way:
- **In order, one event in flight.** Each `(node, streamId)` stream is delivered in `seq` order, with one request in flight per stream and subscriber. Streams and subscribers don't wait for each other.
- **At least once.** An event can come again (after a fleet restart, a timeout, a lost answer). Skip one whose `Idempotency-Key` you have seen; keep the keys for a day.
- **Retries.** An answer of 408, 429 or 5xx, or no answer within 10 s, is retried with backoff from 1 s up to 10 minutes. After 20 attempts the event goes to dead letters with a `dead_letter` alert. Any other 4xx goes to dead letters at once.

**What a subscriber owes the bus:**
- Answer 2xx once you have the event: stored, or acted on.
- Never refuse an event for a reason of your own downstream: a chat service that blocks you, a handler that failed, a restart under way. Keep what you can't act on yet, durably, and act later.
- An event you keep refusing holds up every later event of its stream, for up to about two hours of retries.

The fleet raises `subscriber_lagging` (§14) when a subscriber's oldest undelivered event is older than 60 seconds.

The `subscriber` examples in §11.4 are what such a subscriber receives. Lane state events travel in each node's stream under the path `/lane`, but they reach clients as lane events (§7): they never go to subscribers, and are never counted as unrouted hooks (`unrouted_hook`).

## 14. Alerts

An alert is something for the owner to look at that changes no state. Each one is an audit row `{ id, at, node, kind, detail }`, kept 90 days, served by `GET /v1/alerts` and sent as the `alert` event. The hub shows them in its app and pushes the urgent ones (the protocol's `urgentAlert`); any other client may take them too.

| Kind | When | `detail` |
|---|---|---|
| `instance_conflict` | a second instance of a node was refused, because the live one answered the instance check | `{ live, refused, source }` |
| `source_changed` | a node's network source address changed: possibly a stolen node key | `{ from, to }` |
| `clock_offset` | a node's clock is more than 2 s off. Nothing depends on the clocks agreeing. | `{ offsetMs }` |
| `rate_limited` | a node sent more messages than its rate allows, and was disconnected | `{}` |
| `lane_conflict` | a lane name got a second claimant | `{ name, claims: { node, workerId }[] }` |
| `dead_letter` | a subscriber refused an event, or the event failed 20 times; once per subscriber until a delivery to it succeeds again | `{ subscriber, streamId, seq, path, reason, attempts }` |
| `backlog_full` | a subscriber's backlog reached 50,000 events | `{ subscriber, cap, droppedProgress, deadLettered }` |
| `unrouted_hook` | the first event of a script path that no subscriber takes | `{ path, events }` |
| `delivery_waiting` | a delivery still `queued`, `typed` or `held` after 2, 15 and 60 minutes, once each | `{ id, lane, state, reason, minutes }` |
| `subscriber_lagging` | a subscriber's oldest undelivered event is older than 60 s | `{ subscriber, oldestAgeMs, streams }`: `streams`, the streams it holds up |
| `job_failed` | a background job exited non-zero, timed out or was lost; once per job (node, id) | `{ id, name, class, outcome }` |
| `job_unnoticed` | a job's notice was given up before its lane took it; once per job | `{ id, name, class, outcome }` |
| `engine_fallback` | a lane started on an engine its role reached only after passing over others (§8, `lane.start`) | `{ lane, role?, entry, skipped }`: `skipped`, `{ entry, reason }[]` |
| `connection` | kept for a node's Connections service (`docs/design/secret-store/README.md`, `AlertSink`); nothing raises it yet | |

## 15. Sources

- Claude Code hooks: the common input fields; the `Stop`, `StopFailure` and `PreToolUse` inputs; an HTTP hook's non-2xx answer or connection failure is a non-blocking error. https://code.claude.com/docs/en/hooks, read 2026-10-08.
- Claude Code hooks: an HTTP hook's 2xx JSON answer is read as a command hook's output; a Stop hook's `decision: "block"` with a `reason` keeps the turn going; `stop_hook_active`; the cap of eight continuations in a row. https://code.claude.com/docs/en/hooks, read 2026-10-13.
- Claude Code status line: the JSON a status line command receives. https://code.claude.com/docs/en/statusline, read 2026-10-08.
- The transcript and session-file shapes the delivery receipt reads are Claude Code internals, undocumented. Each is pinned by a recorded example in `test/fixtures/claude-code/`, from Claude Code 2.1.293, so a change shows as a failing test.
- Node.js `http` over a Unix socket (`socketPath`): https://nodejs.org/docs/latest-v24.x/api/http.html#httprequestoptions-callback, read 2026-10-06.
- `ws` 8, a client over a Unix socket through `createConnection`: https://github.com/websockets/ws/blob/master/doc/ws.md, read 2026-10-07.
