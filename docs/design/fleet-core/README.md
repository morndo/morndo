# Fleet core: one Morndo across one or many machines (design v2, 2026-10-06)

**Phase: design only.** This document and [ADR-0012](../../adr/0012-fleet-pull-agents-and-a-separate-fleet-service.md). No app code yet.

**v2** folds in a review of v1 against the code. Fifteen findings came back, and each one was checked against the code before it was accepted. Two were reproduced: pane IDs reused after a tmux restart, and transcript lines up to 3.7 MB. Section 14 lists what changed. Section 15 lists the corrections made when the implementation plan was reconciled ([`plan.md`](plan.md)), also 2026-10-06, and those of the plan's second review round (two independent reviews: executability and coverage).

**The request:** move the control-plane pieces onto a rented server, and make the same architecture run on one PC or split across machines.

**Scope:** sub-project 1 of 4.

| # | Sub-project | Spec |
|---|---|---|
| 1 | Fleet core: node agent, protocol, fleet service, the hub on fleet ports | this document |
| 2 | Clients: kira, the `lanes` CLI and the manager's scripts go through the fleet service | separate |
| 3 | Roles and install: `morndo setup control-plane` / `morndo setup node`, units, topology | separate |
| 4 | Cutover: control plane to `cp.example` on a rented server; the PC becomes a node | separate runbook |

## 1. What we looked at first

All of this was observed on 2026-10-06, read-only. The hub was read at 38ea4be and kira at 7f7f118.

- **The hub's ports.** The hub injects `Tmux` (`listWorkers`, `capture`, `send`), `Terminal` (`frame`, `keys`) and `Sessions` (`byPane`, `transcriptPath`) in `apps/hub/src/main.ts`. Six other places touch the machine directly:
  - `ObservationService` calls `readTranscript` and `readOlder` on file paths (`observation-service.ts:69,125`). Both are synchronous (`openSync`, `readSync`).
  - `older()` is synchronous and is called from the feed's WebSocket handler (`observation-service.ts:63`, `http.ts:457-468`).
  - `files.ts` copies lane attachments synchronously. It allows any path except credential locations, after resolving symlinks, and skips secret file names, up to `MAX_FILE_BYTES` = 25 MiB (`files.ts:19-29,58-68`).
  - `steering-service.ts:81` types `ownerFileNote(u.path)`, a path on the hub's own disk.
  - `pane-lock.ts` spawns `flock`.
  - `rfb.ts` connects to a local VNC, and `ledger.ts` reads a local file.
- **Worker IDs are tmux pane IDs (`%N`), and they leak into:**
  - the protocol's `PANE = /^%\d{1,9}$/` (`feed.ts:12`);
  - the send route `(%\d+)` (`http.ts:302`);
  - menu escalation IDs `menu-${pane}`, persisted in `decisions` (`escalation-service.ts:220`);
  - the app's IndexedDB outbox.
- **Pane IDs are reused after a tmux server restart.** Reproduced: two restarts of an isolated server both gave `%0` and `%1`, and `#{start_time}` (whole seconds) matched.
- **Read marks and preferences are keyed by lane name** (`read_marks.conversation` = `lane-a` and so on). `sends` is keyed by `<endpoint>:<request uuid>`.
- **Retry rules.** Refusals before the paste (`no_pane`, `menu_open`, `no_input_box`, `draft_present`, `busy`) release the send so a retry may type (`steering-service.ts:24,104`). The app's Retry reuses the request ID. A local `started` row makes a repeat `uncertain` (`:67`). `EscalationService.answer` deduplicates only in memory (`escalation-service.ts:245-264`).
- **Transcripts.** `readTranscript` reads from the cursor to the end of the file, with no cap. If no complete line has arrived yet, it returns nothing and doesn't move (`claude-sessions.ts:262-279`). Real transcripts have lines up to 3.7 MB.
- **The app compares transcript times to the hub's clock.** `outbox/state.ts:23,66`: "the same moment on the hub's clock, which the transcript's times are on".
- **kira's hook answers.**
  - `/cc` and `/sl` return 204 at once ("a body could steer Claude", `kira.ts:1167`).
  - `/hook/stop` returns 200, `/hook/failure` returns 202.
  - `/file` reads `b.path` from kira's own disk (`kira.ts:1196`).
- **The stop hook script** treats any 2xx as delivered and falls back to a DM only on failure.
- **Claude Code hooks.** An HTTP hook failure is a non-blocking error. The default timeout is 600 s, and a slow hook stalls the session (hooks docs, checked 2026-10-06).
- **The repo.**
  - The vitest `units` project picks up `packages/*/test` by glob, but lists the `apps/*` folders by name (`vitest.config.ts:24`).
  - `npm run check` lists every `tsconfig` by name, and `tsc -p <dir>` fails on a folder that doesn't exist yet (TS5058).
  - `packages/domain/test/architecture.test.ts` keeps the domain pure.
  - CI on ubuntu-24.04 already installs tmux.

## 2. Roles

| Role | Services | Where |
|---|---|---|
| control plane | `morndo-fleet` (new), `morndo-hub`, kira (sub-project 2), the manager's timers | `cp.example` after the cutover; the PC before it |
| node | `morndo-node` (new): agent plus hook relay, and the node's own tmux | every machine that hosts lanes, including the control plane, for the manager's window |

**One machine holds both roles** with the same code. Its agent dials `ws://127.0.0.1:8791/agent` and authenticates the same way, and the hub talks to the fleet service over the same socket. The hub's legacy local adapters stay behind configuration until the cutover (section 10).

## 3. Components

| Unit | Does | Depends on |
|---|---|---|
| `packages/protocol` (extended: `fleet.ts`, `worker-id.ts`) | the zod/mini schemas for the agent channel and the client API; protocol versions; the worker-ID format | zod/mini (ADR-0008 A2) |
| `packages/node-ops` (new) | the tmux, terminal, session registry, transcript byte source, pane lock, file confinement (`denyRoots`, `SECRET_NAME`, `MAX_FILE_BYTES`, `confine`, `openConfined`) and health probe code, moved from the hub (tests move with it); plus the tmux server stamp and `tmuxLiteral` | tmux and `~/.claude` on its own machine |
| `apps/node-agent` (new, `morndo-node`) | `join`, `run`, `status`; one connection; typed operations; the hook relay; its own SQLite (WAL, `synchronous=NORMAL`: section 16.4) for done keys and the hook stream | node-ops, better-sqlite3, ws |
| `apps/fleet` (new, `morndo-fleet`) | agent endpoint; node registry; request router; lane registry; hook bus with outbox; versioned client API; `node add`, `node list`, `node revoke`, `status` | better-sqlite3, ws |
| `apps/hub` (changed) | async ports for transcripts, files and uploads; fleet adapters; per-node polling; worker IDs from `packages/protocol` | fleet client |
| `packages/domain` (small change) | `Worker` gains `node: string` | none |
| `apps/web` (changed) | accepts the new worker IDs; legacy `%N` entries in an old outbox fail as `no_pane`; marks an offline node's workers; offers "Check again" for a send in doubt | protocol |

### 3.1 What changes inside the hub

- **Transcripts.** `readTranscript` and `readOlder` split into:
  - a pure parser over bytes;
  - an async `TranscriptSource`: `size(sid)`, `read(sid, offset, max)` and `locate(sid, needle)`, from a local file or from the fleet.

  The cursor carries a **partial line** across reads, so a long line arrives over several reads. A single line over 8 MiB is skipped and shown as "a message too large to show", with the cursor moving past it. A follow never stalls.

  **Unavailable is not gone.** A source that can't answer now (its node offline, the fleet down or slow) throws `SourceUnavailable`; `null` from `size` or `read` means the transcript is gone. The follow keeps its place through unavailable: the cursor is put back exactly as it was before the failed call, so the next poll reads the same bytes again and no line is lost or parsed twice. Only a gone transcript resets a follow.

  `readOlder` asks the source to `locate` the anchor message's uuid instead of scanning 64 MiB backwards. It then reads one bounded window, at most 4 MiB, before that offset.
- **`older()` becomes async.** The feed handler awaits it with an explicit `catch` that answers `{ missing: true }`, so a fleet error cannot become an unhandled rejection that `exitOnCrash` turns into a hub exit. Only one `older` runs at a time per connection.
- **Polling, per node and in parallel.** `ObservationService.poll()` polls each node in parallel (`Promise.allSettled`). Each node gets one `inventory`, plus one `pane.captureMany` for the panes the hub watches. Nodes that are not `online` are skipped at once and their workers marked offline, so a slow node never delays the others.
  - The roster is built from each node's inventory: every window of every node, with its node. Two windows of one name are both listed. The fleet's lane registry adds which names are in conflict (section 4).
  - Listing waits at most 300 ms per node for a fresh inventory. A slower node is refreshed in the background, and its answer is applied when it lands; a hung `inventory.get` never holds the listing.
  - **Fleet unavailable.** When the listing or the fleet socket fails, the hub keeps the last roster, marks every worker as not online (its state is unknown), and tells the app, which shows a "Fleet unavailable" banner in both layouts until the fleet answers again.
- **Attachments.** `Files.register` becomes async and copies in the background. A message shows its attachment as pending until the copy lands. A remote copy uses chunked `file.get`. The node applies the same rules as today: symlinks resolved, `denyRoots`, `SECRET_NAME`, 25 MiB.
- **Uploads.** `UploadSink.stage(upload, workerId)` puts the image onto the target node with `file.put`, then the note names the path there. A failed stage is a refusal before anything is typed.
- **Sends and answers carry keys.**
  - `Tmux.send(id, text, key)` takes the caller's key. `Terminal.keys(id, data)` takes none, because keystrokes are never retried.
  - `SteeringService` passes its `<endpoint>:<request>` key.
  - `EscalationService.answer` passes `answer:<escalation id>:<ask>:<choice>`, where `<ask>` is the id of the message that asked (or its time, when it has none). A retry after a dropped connection can't type twice, and a question asked again is a new ask, so the same tap on it is typed again rather than taken for a duplicate.
  - The manager is resolved by name only while its name is not in conflict. With two windows named `manager` (on one node or two), there is no manager to answer: an answer is refused `lane_conflict` and nothing is typed. A send to a worker by its worker ID stays allowed whatever its name: the owner picked that pane.
- **Uncertain becomes resolvable.** Every answer from a node carries its **store**: the stream id of the agent database where its done keys live (section 5.3). A send in doubt keeps the store it went to with its `started` row (a hub migration). On a repeat with a local `started` row, `SteeringService` asks `op.status { key }`:
  - `done` → `duplicate`;
  - `unknown` from the same store → the agent never started it, so it is safe to type;
  - `unknown` from another store, or with no store recorded → `uncertain`: the agent's database was replaced or restored, and the key that would tell may be gone with the old one;
  - `unknown` from the same store, but at a lower **store sequence** than the one kept with the send (section 5.3) → `uncertain`: that database went backwards (an older copy put back in place keeps its store), so it can't vouch either;
  - `started` → `uncertain`;
  - node offline → `uncertain`.

  Two repeats of one key at once type at most once: the second waits for the first's answer.

  The hub answers an `uncertain` send with 409 `{ error: "uncertain" }`, as it answers every refusal but `step_up` (403) and `no_pane` (404). The app shows it as "may have been sent" and offers **Check again**, which sends the same request ID again, so the hub asks `op.status`: `done` turns it into Sent, `unknown` (same store) types it, a definite refusal (one that says nothing was typed) turns it into Not sent, and anything else leaves it in doubt. A first attempt whose node answered "maybe" (the connection dropped after `started`) is that same 409 `uncertain`, so the app says "may have been sent" from the start, never Not sent, and its Check again resolves the same way. An escalation answer in doubt is a 409 `uncertain` too: it keeps a `started` row as a send does (written before it is typed), and its repeat is settled through `op.status` the same way.
- **Keystrokes in doubt.** A keystroke whose node may have typed it (the connection dropped) is answered "uncertain", and the terminal view says "Those keys may have been typed.", never that the pane refused them.
- **Echo matching uses the node's clock.** `pane.send` returns the node's own `typedAt`, and the hub hands it to the app as `at`. That replaces `hubAt` for transcript matching (`outbox/state.ts:66`).
- **Pane lock.** The hub no longer takes `flock`. The agent locks the panes its policy names. On the control plane, the policy maps the window `manager` to `~/.local/share/kira/manager-pane.lock`, the file kira, manager-inbox and lane-events-push lock there.
- **Ledger and desktop.** The manager's ledger stays a local read, because the manager runs on the control plane. The desktop view stays local-only until the desktop op (section 11): the hub shows the desktop `MORNDO_VNC` names, a VNC server it connects to itself, with or without the fleet, and "no desktop" when it is unset. A control plane apart from its nodes leaves it unset (section 16.1).

## 4. Identity of panes and lanes

- **Worker ID** = `<node>.<server>.<pane>`. It is URL-safe and opaque to the app. Example: `pc.3fa2c1d0.12`.
  - `node` matches `[a-z0-9-]{1,32}`.
  - `server` is the first 8 hex digits of a UUID that the agent stamps on its tmux server on first contact (`tmux set -g @morndo-server <uuid>`). A restarted tmux server gets a new stamp.
  - `pane` is the number from `%N`, without leading zeros, so one pane has exactly one ID.
- **The protocol and routes** use this format, defined once in `packages/protocol/src/worker-id.ts`. The legacy hub keeps `%N`.
- **Menu escalation IDs** become `menu-<workerId with "." → "_">`. A legacy `%N` keeps `menu-N`. Old `menu-N` rows stay in `decisions`: decisions are provenance and are never pruned. A fleet hub never reaches them again, and they drop out of view once older than the 7 days `Store.decisions()` loads.
- **The expectation check.** Every side-effecting pane op carries `expect: { server, window, sessionId? }`. The agent checks it immediately before acting, inside the per-pane queue, and refuses with `no_pane` (not executed) on any mismatch. A tmux restart or a renamed or reused pane can therefore never receive text meant for another lane.
- **Inventory versions.** Inventory carries `invVersion`, which grows within an agent instance. Every op result returns the agent's current `invVersion`, so a caller can tell whether the inventory it holds already reflects its own change (for example, the pane `lane.start` returned).
- **Lane names.**
  - The agent reports only the tmux session its policy names (default `main`), and only windows with one pane.
  - A name belongs to the node that registered it first.
  - If two nodes, or two windows on one node, report the same name, routing to that name stops for both (`lane_conflict`, not executed) and the conflict is shown until the owner resolves it. Every route by name stops: an op addressed to the lane, and the hub's answers to the manager. A send to one of those windows by its worker ID still goes through: the owner picked that pane, and the node checks the expectation.
  - The hub lists every window of every node, both windows of a name in conflict included, each marked as in conflict.
  - `lane.start` refuses a name that is already registered anywhere in the fleet, or whose `lane.start` is still in flight (`name_taken`): the fleet holds the name from the request until its registry holds it: at once released if the node answers that nothing ran, at most 10 s after any other answer.
  - Names reach tmux only as literals: every argument tmux would read as a format (a window name, a start directory) has its `#` doubled, and windows are targeted by their ID, never by name (section 9).

## 5. Protocol (version 1)

Messages are JSON over WebSocket, validated with zod/mini on both sides. Every message is `{ v: 1, t: <type>, … }`, and an unknown `t` is answered with an error, never ignored. The agent endpoint is `/agent`: locally on port 8791, and over the tailnet as HTTPS through Tailscale Serve (the exact mapping is sub-project 3). The fleet listens on a loopback address only (it refuses any other `listen.host`), and an agent dials `wss://`, or plain `ws://` only to its own loopback (`127.x.x.x`, `localhost`, `[::1]`): it refuses any other URL at join and at every connect, and the fleet refuses to print one in a join string.

### 5.1 Join, once per node

1. **The owner issues a code.** On the control plane, `morndo-fleet node add <name>` prints a join string: the fleet URL, the fleet's **public key**, a 128-bit code **bound to that name**, and the name itself. The code is single use and expires after 10 minutes. The fleet service stores only its SHA-256 hash.
2. **The node joins.** `morndo-node join '<join string>'`:
   - creates an Ed25519 key pair (`generateKeyPairSync('ed25519')`);
   - writes the private key at mode 0600;
   - pins the fleet's public key;
   - sends `join { node, code, publicKey, agent, proto }`.
3. **The fleet service accepts it.** It compares the code's hash in constant time and checks that the code was issued for that `node`. It stores `(node, publicKey)`, answers `welcome` (placeholder values; the agent reads only that it was welcomed) and closes the connection. It refuses an unknown, expired or used code, or a code issued for another name, with 4403, and a protocol it doesn't speak with 4426.
4. **The node writes its files.** Only after the welcome does the agent write its private key, a default policy and its config. `morndo-node run` then dials again and opens with `hello` (section 5.2). A refused or unreachable join leaves nothing on disk.

### 5.2 Every connection: mutual authentication

1. agent → `hello { node, instanceId, streamId, proto: [1], agent: { version }, claude: { version | null }, caps, clientNonce }`. `streamId` names the agent's hook stream (section 5.4), so that the welcome can answer for it.
2. fleet → `challenge { nonce, fleetSig }`, where `fleetSig` is the fleet's Ed25519 signature over `"morndo-fleet/1/fleet\n" + node + "\n" + clientNonce`. The agent checks it against the pinned key and closes on a mismatch.
3. agent → `proof { sig }`, where `sig` is over `"morndo-fleet/1/node\n" + node + "\n" + nonce`.
4. fleet → `welcome { connEpoch, ackSeq, streamKnown, storeSeqSeen? }` (`ackSeq` and `streamKnown` for the hello's `streamId`; `storeSeqSeen` the highest store sequence the fleet has seen from that store, section 5.3, which fleet.db keeps per node and store; omitted when it has seen none), or close: 4401 bad proof, 4403 revoked or unknown, 4426 unsupported protocol, 4409 conflict, 1013 too many handshakes from that address. The agent stops dialing after 4401 and 4403 (a retry would be refused the same way), retries 4409 every 5 minutes (jittered), retries 4426 hourly, and backs off as usual after anything else.

**Handshakes are rate-limited per source address** before any key work: 10 at once, one more every 6 s. Over that, the connection is closed with 1013 and logged; no alert is raised, because an address that hasn't authenticated names no node, and the owner's alerts must not be fillable from outside.

**Instances.** `instanceId` is random per agent process.
- A new connection with the **same** `instanceId` replaces that instance's older connection. That covers a reconnect.
- A **different** `instanceId` while another instance of the node is live makes the fleet ping the live connection and wait 3 s, without holding up any other node.
  - No pong: the old connection is dead or half-open (an agent restarted uncleanly, a laptop that slept). It is terminated and the newcomer admitted, so an unclean restart can't lock the node out.
  - A pong: the newcomer is refused (4409), and the fleet raises one alert per refused instance for as long as the live connection lasts.
- The refused agent keeps its lanes running, shows the conflict in `status`, and tries again every 5 minutes (jittered); its retries raise no new alert. Once the other instance is gone, the next try is admitted.
- That avoids two agents with one key, for example a cloned VM, endlessly replacing each other.
- Results arriving late from the same instance are still accepted.

**Liveness.** The fleet service pings every 15 s and terminates a connection that missed a pong. The agent terminates when no ping arrives for 35 s: two pings may be late before it gives up (`ws` README). It reconnects with exponential backoff, 1 s up to 60 s, with full jitter.

**Node status.** `online` after a welcome; `stale` from the first missed pong until the connection is terminated; `offline` once it is closed.

**Frames.**
- Every message is at most 512 KiB, and both ends set `maxPayload` to 1 MiB.
- Bulk data (transcripts, files) moves in chunks of at most 256 KiB before base64.
- Each side keeps two send queues: control messages (op requests and results, pings, events) go before bulk chunks. At most one bulk transfer per connection is in flight, and at most 8 more wait behind it; one more is refused `busy` (not executed). An op's deadline runs from when the fleet queued it, so an op that waited too long answers `timeout` without reaching the node.

### 5.3 Operations (fleet → agent)

`req { id, op, args, timeoutMs, key? }` → `res { id, invVersion, store, storeSeq, ok: true, result }` or `res { id, invVersion, store, storeSeq, ok: false, error: { code, executed, message } }`. `store` is the stream id of the agent's database, where its done keys live (section 5.4): a new or restored database is a new store. The fleet passes it on with every answer to an op it sent to a node, and its own answers after sending (a dropped connection, a timeout) carry the store of the connection the request went out on.

`storeSeq` is that database's **store sequence**: how many keyed ops it has started, one more in the transaction that commits each `started`, never lowered, read when the answer is made (so `op.status`'s says where the database is now). An older copy of the database put back in place (`cp` over the file, a VM snapshot) keeps its file identity and its store id, but answers a lower `storeSeq` than its callers saw before. The fleet passes the agent's own on unchanged; its own answers after sending carry the highest `storeSeq` any answer from that store has shown it (a number that database reached, so never one it hasn't: no false "went backwards"), and a refusal before sending carries none. The fleet keeps that highest value per node and store in fleet.db and sends it in the `welcome` (`storeSeqSeen`, section 5.2): an agent whose own `storeSeq` is lower was put back from an older copy, and starts a new store (a new stream) before the connection goes online, so no op runs under the old one and a send in doubt reads `unknown` from another store. That holds however many keyed ops the restored database runs afterwards, and across a fleet restart. It is optional: from an agent (or a fleet) that sends none, callers compare stores only, and a fleet without `storeSeqSeen` leaves the agent's store as it is.

`executed` is `"no"`, which is safe to retry, or `"maybe"`.

| Error code | `executed` | Meaning |
|---|---|---|
| `bad_args`, `unknown_op`, `denied` | no | |
| `no_pane` | no | includes an expectation mismatch |
| `menu_open`, `no_input_box`, `draft_present` | no | |
| `busy` | no | pane lock |
| `name_taken` | no | `lane.start` of a name registered anywhere in the fleet |
| `lane_conflict` | no | the fleet's refusal: two windows claim the lane name addressed |
| `too_large` | no | |
| `timeout` | no | the deadline passed before any side effect |
| `node_offline` | no | the fleet service's own refusal |
| `uncertain` | maybe | |
| `internal` | maybe | |
| `updating` | no | the service is holding new work while it updates |

**Deadlines.** The agent starts a monotonic deadline (`timeoutMs` − 250 ms) when a request arrives. If the side effect hasn't started by then, the answer is `timeout` with `executed: no`. A late pane lock never types.

| Op | Args | Result | Key |
|---|---|---|---|
| `inventory.get` | none | panes `{ workerId, window, cwd, sessionId?, title?, claudeVersion? }[]`, `invVersion` | no |
| `pane.captureMany` | `workerIds` (≤ 64) | `{ workerId, text \| null }[]` | no |
| `pane.frame` | `workerId` | `Frame` | no |
| `pane.keys` | `workerId, data` (≤ 4096), `expect` | `true`/`false` | no; keystrokes are never retried |
| `pane.send` | `workerId, text` (≤ 8000), `expect` | `{ problem: SendProblem \| null, typedAt }` | yes |
| `op.status` | `key` | `unknown` \| `started` \| `done` + outcome | n/a |
| `transcript.size` / `transcript.read` / `transcript.locate` | `sessionId`; `offset, max` (≤ 256 KiB); `needle` (≤ 200 chars) | size; `{ bytes, eof }`; offset or `null` | no |
| `file.stat` / `file.get` | `path` or `ref`; `offset, max` (≤ 256 KiB) | `{ size, mtime }`; `{ bytes, eof }`; today's confinement rules, up to 25 MiB | no |
| `file.put` | `upload, offset, bytes` (≤ 256 KiB), `final` | after `final`, the path in the node's inbox (which `file.stat` and `file.get` may read, so the hub can copy the owner's image; the rest of the state directory stays denied); a partial upload expires after 10 minutes; up to 25 MiB | yes |
| `lane.start` | `name, cwd, account?, resume?` (typed fields, no free flags: `account` matches `^[a-z0-9][a-z0-9-]{0,31}$` and `resume` is a UUID, so neither can pass as a flag) | `{ workerId }` | yes |
| `lane.stop` | `name` | `true` | yes |
| `worktree.list` / `worktree.add` | `repo`; `repo, name, base` (branch names: `/` allowed; checked by the schema, then by `git check-ref-format --branch` on the node) | worktrees; path (under policy `repoRoots`) | add: yes |
| `memory.sync` (ADR-0031, docs/design/memory) | `version, part, parts, files` (names `morndo-mem-…`, no path) | `committed, written, removed, skillDirs, conflicts`; the skills in the policy's `memory.skillDirs` | yes |

The agent decodes every op's arguments with the same schemas the fleet checked, then applies what only the node can judge (its policy's roots, git's branch rules). A key on an op that takes none, or a keyed op without one, is `bad_args` at both ends. A file is read for someone else only after `confine` and then opened with `O_NOFOLLOW`, so a link swapped in between is refused. The deny list covers credentials and the state of Morndo's own services and kira (`~/.local/share/morndo*`, `~/.local/state/morndo*`, `~/.config/morndo*`, `~/.local/share/kira`, `~/.config/kira`, every `.credentials.json`).

**Idempotency, two phases.**
1. **Before the side effect**, the agent writes `key → started` (with a hash of what decides the effect: the op and its target and content, such as `pane.send`'s worker ID and text; never `expect` or the timeout, so a retry with a refreshed expectation is the same request) and commits it (without a sync to the disk: section 16.4).
2. **After it**, the agent writes `key → done, outcome` and answers.
3. **Refusals with `executed: no` delete the key,** so a retry after you close a menu types, as today.
4. **A repeat:**
   - with a `done` key returns the stored outcome;
   - with a `started` key and no outcome answers `uncertain`;
   - with the same key but a different hash answers `uncertain` (`executed: maybe`): that key's op may have run.
5. **Retention:** keys are kept 7 days. Keys are namespaced by client (`hub:`, `kira:`, `lanes:`).

**Concurrency.**
- Side-effecting ops on the same pane or lane run one at a time, in arrival order, with the expectation check inside that queue.
- Reads never wait for writes.
- One node's ops never wait for another node's.

### 5.4 Events (agent → fleet)

| Kind | Delivery |
|---|---|
| `hook` | a durable stream: `{ streamId, seq, at, path, body }` |
| `inventory` | latest wins; sent when a 2 s tmux poll sees a change, and in full after every (re)connect |
| `health` | latest wins, every 30 s: `{ memTotal, memAvailable, psiSome10, psiFull10, diskFreeHome, load1, tmuxOk, wallClock, spoolDepth, drops }` |

**The hook stream.**
- `streamId` is a UUID created together with the agent's database.
- `seq` starts at 1 within that stream.
- The fleet service records the highest accepted `seq` per `(node, streamId)`. A reset or reinstalled agent therefore starts a new stream, and nothing is mistaken for a duplicate.
- After a welcome (`ackSeq`, `streamKnown`), the agent replays from `ackSeq + 1` **before** any new event, with at most 256 events unacknowledged in flight.
- A restored agent database (from a backup, its stream behind what the fleet already acknowledged: a welcome whose `ackSeq` is above the highest `seq` this database ever issued) starts a new stream with a new `streamId` and dials again, so its events are not taken for duplicates, and its store changes with it. It does so at most once per agent process, so a fleet that keeps claiming a higher `ackSeq` can't keep it redialing.
- Acknowledgements are cumulative.
- Replay is exempt from the request rate limit and is paced by that window, never by disconnecting.

**Clock.** The fleet service compares each `health.wallClock` with its own clock, allowing for the round trip, and alerts when the offset exceeds 2 s. Nothing in the design depends on the clocks agreeing: echo matching uses the node's `typedAt`.

### 5.5 Hook relay (every node, `127.0.0.1:8787`)

**When it answers:** after the event is in the durable stream, and before any network I/O.

| Path | Answer | Spool policy | When the spool can't be written |
|---|---|---|---|
| `/cc` | 204, empty | coalesced: the latest per session | still 204 (never stall a session); counted |
| `/sl` | 204, empty | coalesced: the latest per session | still 204 (never stall a session); counted |
| `/hook/stop` | 200 `{ ok: true, queued: true }` | kept | 503, so the script's fallback runs |
| `/hook/failure` | 202 | kept | 503, so the script's fallback runs |
| `/notify` | 202 | kept | 503, so the script's fallback runs |
| `/file` | 202 | kept | 503, so the script's fallback runs |

- **Late events:** replayed coalesced events carry `late: true` and their original `at`.
- **A full disk:** the spool's byte budget (256 MiB) is one budget shared with the relay's copies and the upload inbox (a copy that doesn't fit is 503; an upload that doesn't fit is `too_large`), and a write that fails is answered as the table says without crashing the agent: deleting acknowledged events that fails is logged and tried again at a later acknowledgement, and the connection stays up.
- **`/file`:**
  - the relay copies the file into `~/.local/state/morndo-node/relay-files/` under today's confinement rules and spools `{ ref, name, size }`;
  - it answers 413 over 25 MiB;
  - copies are deleted 24 h after acknowledgement.
- **Identity in each event:** the relay adds the node, and the window it finds through `TMUX_PANE` or `session_id` → pane.
- **Hook entries** in `settings.json` get `"timeout": 5` (sub-project 3).

### 5.6 Client API (fleet service ↔ hub, kira, `lanes`)

**Where.**
- HTTP and WebSocket over a Unix socket at a configured fixed path. The default is `~/.local/state/morndo-fleet/fleet.sock`, with no dependence on `XDG_RUNTIME_DIR`.
- At startup the fleet service refuses to run unless the socket's directory belongs to its user and has mode 0700.
- Every route is under `/v1/`, and `GET /v1/caps` lists capabilities. As on the agent channel, the current and the previous API version are accepted.

**Routes.**
- `GET /v1/nodes`, `GET /v1/lanes`, `GET /v1/lanes/<name>`;
- `GET /v1/alerts` (oldest first): instance conflicts, source changes, clock offsets, rate limits, lane conflicts, dead letters, full backlogs. The security kinds (instance conflicts, source changes, clock offsets) are kept apart from the others, 500 each, so a flood of other alerts never pushes one out; a dead letter raises one alert per subscriber episode (until a delivery to it succeeds again);
- `POST /v1/op { node? | workerId? | lane?, op, args, key?, timeoutMs? }`, with `expect` inside `args`; the answer is always the JSON op result or `{ ok: false, error }`, with the node's `store` (null when nothing was sent);
- `POST /v1/nodes/<name>/revoke` (what `morndo-fleet node revoke` calls); the node's lanes leave the registry at once;
- `GET /v1/files/<node>/<ref|path>` (chunked);
- `WS /v1/events` (inventory, health, node status, conflicts, alerts), the current state first. A client that falls 8 MiB behind is closed with 1013; it reconnects and gets the current state again.

Clients put their own namespace in front of their keys (`hub:`, `kira:`, `lanes:`) and name themselves in a header (`x-morndo-client`). The exact shapes are in the plan's Contracts.

**Audit.** The fleet audits every side-effecting op (the op, its target, the key's namespace, the outcome, the client; never the text, keystrokes or bytes), every join, admission, refused hello and revocation (a source over its handshake limit is only logged), and keeps audit rows, alerts included, for 90 days.

**Hook bus.**
- **Subscribers** are static config (`~/.config/morndo-fleet/config.json`: `subscribers: [{ name, url, paths }]`).
- **Storage:** an event is stored in an outbox table before the agent is acknowledged.
- **Delivery:**
  - each event is POSTed per subscriber, in order per `(node, streamId)`, as exactly one `HookEvent` JSON body with `Idempotency-Key: <node>:<streamId>:<seq>`;
  - delivery is **at least once**, and subscribers deduplicate on that key;
  - backoff is exponential;
  - a 4xx other than 408 and 429, or 20 failed attempts, sends the event to a dead-letter table with an alert (408, 429 and 5xx are retried);
  - each subscriber's backlog is capped at 50,000 events: coalesced events are dropped first, then an alert;
  - a subscriber removed from config has its rows deleted;
  - rows are deleted 24 h after delivery.

## 6. State and ownership

| State | Owner (only writer) | Store |
|---|---|---|
| Panes, sessions, transcripts, worktrees, the tmux stamp | that node's agent | none; reported |
| Done keys, hook stream (spool), relay files | agent | `~/.local/state/morndo-node/agent.db` (WAL, `synchronous=NORMAL`, section 16.4) |
| Nodes, public keys, join codes, accepted `seq` per `(node, streamId)`, lane names, outbox, dead letters, audit | fleet service | `~/.local/share/morndo-fleet/fleet.db` |
| Principal, devices, sends, read marks, decisions | hub | `~/.local/share/morndo/morndo.db` (unchanged) |

## 7. Failures

| Failure | What happens | Seen by the owner |
|---|---|---|
| Fleet service down or restarting | Lanes keep running and hooks spool; agents reconnect with backoff. The hub keeps the last roster, marks every worker as not online (their state is unknown), and says the fleet is unavailable; `lanes` fails fast. | "Fleet unavailable" banner in both layouts; offline markers; outside watcher (sub-project 3) |
| Node down or partitioned | `stale` → `offline`. Its workers stay listed as offline and ops fail with `node_offline` (not executed). Other nodes are unaffected. | offline marker on its workers, in both layouts |
| Node slow (answers, but late) | The listing waits at most 300 ms for it and refreshes it in the background; its bulk ops queue (8 at most, then `busy`), each timing out from when it was queued. Other nodes are unaffected. | its lanes update late |
| tmux server restarted on a node | new stamp → new worker IDs; old IDs answer `no_pane`; nothing is typed into a reused `%N` | lanes reappear |
| Connection lost during `pane.send` | `uncertain`. On a repeat, `op.status` resolves it once the node is back: `done` → duplicate, `unknown` from the store the send went to → safe to type. | "may have been sent", with Check again, until resolved |
| Connection lost during `pane.keys` | `uncertain` (keystrokes are never retried) | "Those keys may have been typed." |
| Retry after a refusal before the paste | the key was released, so the retry types | as today |
| Two agent instances with one key | the live one answers the fleet's ping, so the second is refused (4409) with one alert per episode, and tries again every 5 minutes | alert (`GET /v1/alerts`); `status: conflict` on the refused node |
| Agent restarted uncleanly (old connection half-open) | the old connection misses the 3 s ping; the new instance is admitted and the old connection terminated | none |
| Agent database lost or reinstalled | new `streamId`, so a new store; nothing is mistaken for a duplicate. A send in doubt from before stays `uncertain`: `op.status` now answers from another store, which can't vouch for the old keys | "may have been sent" until Discarded |
| Agent database restored from a backup | a copy opened as another file (another inode) starts a new stream, so a new store, at once; the welcome's `ackSeq` above its highest `seq` does the same once the stream has had traffic. A copy put back in place (`cp` over the file, a VM snapshot) keeps its store id, but the welcome's `storeSeqSeen` is above its `storeSeq`, so it starts a new store before running anything; and its `storeSeq` is below the one the hub kept with a send or an answer in doubt. Either way that one stays `uncertain`. Not caught: a copy taken just before a send whose answer never reached the fleet | "may have been sent" until Discarded, for what was in doubt |
| Lane name claimed twice | routing by that name stops (`lane_conflict`), the manager's answers are refused, sends by worker ID still go | both windows listed, marked |
| Long outage | coalesced events keep only the latest per session; the rest replay in order, paced; replayed late events are marked | late markers |
| Subscriber failing | backoff, then dead letters; other subscribers continue | alert |
| Spool cannot be written (full disk) | `/cc` and `/sl` still answer 204; the script paths answer 503 so their fallbacks run; the agent keeps running | health counter |
| Clock offset > 2 s | an alert; correctness unaffected | alert |
| Protocol unsupported | 4426; the agent keeps running its lanes and retries hourly | "needs update" |
| Hub down | the fleet service, agents and kira are unaffected | phone app down |

## 8. Security: the real threat model

**What the design protects.**
- **Exposure:** the agent endpoint listens on loopback only, and is reachable on the tailnet only through Serve's TLS. No agent sends its handshake over plain `ws://` except to its own loopback. The client API is only a 0700 Unix socket with an owner check.
- **Before authentication:** joins and hellos are rate-limited per source address before any signature is checked (10 at once, one every 6 s), so an unauthenticated peer can't make the fleet do key work in a loop.
- **Mutual authentication:**
  - the node proves its key, and the fleet proves its pinned key;
  - join codes are single use, expire after 10 minutes and are bound to a name;
  - the fleet service stores no reusable secret.
- **Typed operations:**
  - no generic exec;
  - `lane.start` takes typed fields, never free CLI flags;
  - file and worktree paths are confined, with today's rules applied on the node, plus the state of Morndo's own services (the hub's and fleet's databases, the fleet's key, every agent's key, config and policy) and kira's, and every `.credentials.json`; a file is opened with `O_NOFOLLOW` after it was judged;
  - nothing from outside reaches tmux as a format: names and directories pass as literals, and windows are targeted by ID.
- **No credential crosses the wire.** No Claude Code credential or token is ever sent: each node logs in to its own accounts.
- **Logs and retention:** logs go through the redacting logger, and hook bodies are kept only until delivery plus 24 h. The audit (every side-effecting op, every join, admission and revocation; never content) is kept 90 days, and security alerts can't be pushed out by other alerts.

**What it doesn't protect.**
- **A compromised control plane can do what an owner can.** Text sent into a Claude Code pane, `pane.send` or `pane.keys`, can run commands (for example in its `!` bash mode). So a compromised control plane can act on every node about as well as SSH would.
  - **Mitigations:** the node policy can turn off `pane.keys`, which is on by default for the hub's terminal view, and the audit records who did what.
- **The node key is a device credential, not an isolation boundary.** Lanes run as the same user and can read it. A lane that steals it could pose as its node from elsewhere on the tailnet.
  - **Mitigations:** the fleet service alerts when a node's tailnet source address changes, and `node revoke` cuts it off. A second instance is refused while the live one answers pings (section 5.2), with an alert.
- **The owner's user can run admin actions.** `node add` and `node revoke` work through the socket, so any process of that user, including the manager, can run them. Accepted. They are audited and announced to the owner once kira subscribes.

## 9. Testing

All tests run against fakes or isolated resources and never touch the owner's running system (repo rule).

Every tmux call, in the code and in the tests, passes `-u` (without it, a locale that isn't UTF-8 turns non-ASCII text into `_`), names a session as `=name` (a bare name also matches a longer one), doubles `#` in every argument tmux reads as a format and that carries outside data (`tmuxLiteral`: a window name, a start directory; tmux expands `#S`, `#{…}` and `#(…)` there), and targets windows by ID, never by name (a target's window part is a pattern, and is split at `.`). Tests use isolated servers (`tmux -L test-<uuid>`) and wait until a killed server is gone.

A negative control that needs a fault placed exactly inside the agent (the drop between `started` and the paste, keys off, the expectation check off, a shifted clock, a failing spool, a fixed stream id) uses the agent's test hooks (`MORNDO_NODE_TEST_HOOKS`). The agent refuses to start with them unless `NODE_ENV=test` and its `HOME` is not the account's own home, so a production agent can't run with them.

| Level | What | Negative control |
|---|---|---|
| Unit | schemas; sign and verify in both directions; the join-code lifecycle, including a code used for another name; worker-ID parse and format; done keys, including key release on `executed: no`; the stream and its acknowledgements; coalescing; the outbox and dead letters | a tampered fleet signature, a reused code and a wrong-name code are each refused |
| Contract | real fleet against a scripted fake agent, real agent against a scripted fake fleet, for every op, event and close code | a fake agent answering the wrong `id` or an old `connEpoch` is ignored |
| Integration | real agent on an isolated tmux server (`-L test-<uuid>`) with a throwaway `~/.claude` | send to a missing pane → `no_pane`, never success |
| Pane reuse | restart the isolated tmux server so `%N` is reused, then send to the old worker ID → `no_pane`, and the new pane receives nothing | the same test without the expectation check types into the new pane |
| Retry and duplicates | (a) `draft_present`, then retry with the same key → types once; (b) drop the connection after the paste → repeat → `op.status` `done` → duplicate, typed once; (c) an escalation answer retried after a drop → typed once | (b) and (c) without keys type twice |
| Long lines | a transcript with a 3 MB line, and one with a 10 MB line; the follow continues past both | the old reader (no partial-line carry) stalls on the 3 MB line |
| Stream | an agent database reset → the new stream's events are delivered; a fleet restart mid-stream → each event reaches the subscriber at least once, and the subscriber's idempotency key deduplicates it | the same reset without `streamId` drops the new events |
| Isolation | one node that never answers: the other node's lanes keep updating within one poll interval | sequential polling (v1) misses that bound |
| Flapping | two instances with one key for 5 minutes → exactly one connected, one alert, no op failures on the connected one | none |
| Instance takeover | the live connection is half-open (it never answers a ping) → a new instance of the node is admitted within about 3 s | without the ping check, the new instance is refused (4409) |
| Store change | drop the connection after the paste, reset the agent's database, repeat → 409 `uncertain` and exactly one paste | without the store check, the repeat types again |
| Literal names | `lane.start` in directories named `#{session_name}` and `#(touch m)` → the pane starts in exactly that directory, and no `m` appears | unescaped, the pane starts elsewhere |
| Duplicate names | two windows of one name on one node → both listed; a `manager` window on each of two nodes → the manager's answers are refused, nothing typed | none |
| Clock | an agent 10 s off → alert raised, echo matching still correct | none |
| Hub | the existing suites, **adapted** where this spec changes types: async transcript sources (33 call sites), async `older()`, worker IDs. Every suite that touches a port runs in both legacy and fleet configuration against a fake fleet that mirrors the real lane registry | none |
| Two nodes (CI) | one fleet service, two agents on two isolated tmux servers; the hub lists and steers both | a revoked node never appears |
| Manual QA (repo rule) | on `cp.example`: fleet, hub and a local agent; plus a PC test agent with its own tmux server (`-L morndo-test`), relay on `127.0.0.1:18787` (live kira keeps 8787) and a scratch lane. No live lane touched; evidence recorded. | stopping the PC test agent marks only its lanes offline |

## 10. Rollout (within sub-project 1)

- **Hub configuration:** with `MORNDO_FLEET_SOCKET` set, the hub uses the fleet adapters. Without it, the hub runs on the legacy local adapters exactly as today. They are removed after the cutover (sub-project 4).
- **Nothing in this sub-project is installed on the PC's live system.** Superseded on 2026-10-08: the owner chose to run the fleet in production on the PC, holding both roles, before sub-projects 2–4 (section 16).

## 11. Out of scope (the protocol already carries what they need)

| Later | What it builds on |
|---|---|
| Memory-aware placer and admission queue | `health`, lane registry |
| Staggered restore after a reboot | `inventory`, `lane.start` |
| Moving a lane between nodes | lease epochs on the lane registry, transcript sync |
| Desktop view through the agent | a stream op, protocol version 2 |
| One account arbiter across nodes | `/sl` events on the hook bus |
| macOS node | node-ops on macOS (no `flock(1)`: a native lock); the agent under launchd |

## 12. Done criteria

1. Every test in section 9 passes in CI, and each negative control demonstrably fails when its guard is removed: every control the plan describes is an entry in `scripts/negative-controls.ts`, which applies it in a temporary worktree and asserts that the named test fails; CI runs it weekly and on demand.
2. The hub's suites, adapted as section 9 says, pass in both configurations: every suite that touches a port, listed in the plan (Task 14), with its counts in each mode.
3. Manual QA on `cp.example` with a PC test agent, with evidence: the hub listing both nodes, a send, a frame, the drop-after-paste drill and the tmux-restart drill.
4. Every library and version is checked against primary docs and cited with URL and date. No new dependencies are expected: `ws`, `better-sqlite3` and zod/mini are already in the stack.
5. `docs/domain.md` gains the Fleet context (Node, Worker ID, Lane registry, Join, Hook stream, Hook bus).
6. **Wiring:**
   - `apps/node-agent/test` and `apps/fleet/test` are added to the vitest `units` include and to `tsconfig.tests.json`, both before either app exists (plan Task 1); `packages/*/test` is already picked up by glob.
   - `packages/node-ops` is added to `npm run check` by name; each new app is type-checked through its own `typecheck` script, which `npm run check` runs in every workspace that has one.
   - Architecture tests: `packages/protocol` imports no `node:*`, and `packages/node-ops` imports no `apps/*`.

## 13. Rough size

Five parallel lanes after the protocol and node-ops tasks land:

1. the hub's async ports;
2. the agent;
3. the fleet service;
4. the hub fleet adapters and worker IDs (hub and web), then the web's offline marker and Check again;
5. cross-cutting tests.

About 5–7 working days of lane time, plus review.

## 14. Changes from v1 (review of 2026-10-06)

1. **Pane reuse:** a tmux server stamp in worker IDs, an expectation check before acting, and `invVersion`.
2. **Retries:** keys released on refusals before any side effect; keys threaded through send, answer and keys; `op.status`; error codes carry `executed`.
3. **Worker IDs:** opaque `<node>.<server>.<pane>` IDs; protocol, routes and menu escalation IDs updated.
4. **Transcripts:** partial-line carry, `locate`, 256 KiB chunks, control messages before bulk data.
5. **Hook stream:** `streamId` plus `seq` for hooks only; replay before anything new.
6. **Hub:** per-node parallel polling, async `older()` with a catch, background attachment copies.
7. **Outages:** coalescing, a replay window, dead letters and backlog caps, 503 on script paths, at least once with deduplication.
8. **Duplicate agents:** `instanceId`; a second instance is refused, not swapped in.
9. **Deadlines:** set on the agent; no durable keys for keystrokes.
10. **Clocks:** echo matching uses the node's `typedAt`, and the clock offset raises an alert.
11. **Lane names:** the first node to register keeps a name; conflicts block routing; only the policy's session is reported.
12. **Security:** an honest threat model; mutual authentication; name-bound join codes; typed `lane.start`.
13. **Client API:** a fixed socket path with an owner check; `/v1/` and capabilities.
14. **Tests:** adapted, not "unchanged", plus the missing tests; corrected wiring claims.
15. **Files:** today's confinement rules on the node, and 25 MiB.

## 15. Corrections from the plan reconciliation (2026-10-06)

The six parts of the implementation plan were written in parallel and then reconciled ([`plan.md`](plan.md), [`plan/RECONCILIATION.md`](plan/RECONCILIATION.md)). These corrections to this document came out of it:

1. **Join:** the join string carries the node's name and the `join` message names it; the fleet refuses a code issued for another name (4403), answers `welcome`, closes, and the agent writes its files only then (section 5.1).
2. **`hello.streamId`:** the welcome's `ackSeq` and `streamKnown` belong to one stream, so the hello names it (section 5.2).
3. **Close codes:** the agent stops dialing after 4401 as well as 4403 and 4409 (section 5.2).
4. **`lane_conflict`:** routing by a lane name in conflict is its own error, not executed; `name_taken` stays for `lane.start` (sections 4, 5.3).
5. **Client API:** `GET /v1/lanes/<name>`, `GET /v1/alerts`, `POST /v1/nodes/<name>/revoke`, the `alert` event, `expect` inside `args`, keys namespaced by the client (section 5.6).
6. **Hook bus:** the body of a delivery is one `HookEvent`; 408 and 429 are retried, not dead-lettered (section 5.6).
7. **Old `menu-N` decisions** are never pruned; they stay as provenance and drop out of the 7-day view (section 4).
8. **The app:** an offline node's workers are marked offline, and a send in doubt offers Check again; the hub answers `uncertain` with 409 (sections 3, 3.1, 7).
9. **Test hooks:** negative controls inside the agent use test hooks that a production agent refuses (section 9).
10. **Wiring:** a new app can't be added to `npm run check` by name before it exists; each app has a `typecheck` script instead (sections 1, 12).
11. **`lane.start` arguments:** `account` and `resume` have strict formats, so neither can start with `-` and reach `claude-as` as a flag; the agent keeps its own check as well (section 5.3).
12. **tmux:** every call passes `-u`, names a session exactly (`=name`) and doubles `#` in a window name it creates (section 9; Global Constraints of the plan).

### Second review round (2026-10-06)

Two independent reviews of the plan, one asking whether it can be executed as written and one whether it covers this document, found the following. Each is now in the section named and in the plan ([`plan/RECONCILIATION.md`](plan/RECONCILIATION.md), "Review round 2").

13. **An unclean restart can't lock a node out.** A conflicting hello makes the fleet ping the live connection: no pong within 3 s, and the newcomer is admitted and the old connection terminated. A refused agent tries again every 5 minutes instead of stopping (sections 5.2, 7).
14. **Names reach tmux as literals.** A start directory is a format too (`a#{session_name}b` started a pane in `amainb`); every such argument has its `#` doubled, and windows are targeted by ID (sections 4, 9).
15. **A question asked again gets its own answer.** The answer key names the asking message (section 3.1).
16. **The roster lists every window,** from each node's inventory; conflicts are marked; every route by name refuses a conflict, while a send by worker ID goes through (sections 3.1, 4, 7).
17. **Stores.** Every answer carries the agent database's store; a send in doubt keeps it, and an `unknown` from another store stays `uncertain`, so a lost agent database can't make the hub type twice (sections 3.1, 5.3, 7).
18. **The idempotency hash covers only what decides the effect,** never the expectation or the timeout; a different hash under one key is `uncertain` (section 5.3).
19. **The deny list** covers the state of Morndo's own services and kira's, and every `.credentials.json`; a file is opened with `O_NOFOLLOW` after it was judged (sections 5.3, 8).
20. **Audit and alerts.** Every side-effecting op is audited; a dead letter alerts once per subscriber episode; security alerts are kept apart from the others; audit rows are kept 90 days; joins and hellos are rate-limited per address before any key work (sections 5.2, 5.6, 8).
21. **Fleet unavailable** marks every worker as not online and shows a banner (sections 3.1, 7).
22. **A slow node stays isolated.** The listing waits at most 300 ms per node; the bulk queue is capped at 8 waiting per node, and deadlines run from when an op was queued (sections 3.1, 5.2, 7).
23. **Plain `ws://` only to loopback,** and the fleet listens on loopback only (sections 5, 8).
24. **Unavailable is not gone** for a transcript, and a follow keeps its place through it (section 3.1).
25. **A full disk doesn't stop the agent;** the relay's copies and the upload inbox count toward the spool's budget (sections 5.5, 7).
26. **Done criteria:** every negative control is runnable as data, on a schedule; every hub suite that touches a port runs in both configurations (section 12).
27. **Smaller ones:** the agent's ping timeout is 35 s (section 5.2); `lane.start` holds its name while in flight (section 4); a restored agent database starts a new stream (sections 5.4, 7); the events socket closes a client 8 MiB behind (section 5.6); keystrokes in doubt read "may have been typed" (sections 3.1, 7); Check again shows a definite refusal as Not sent (section 3.1); a worker ID's pane number has no leading zeros (section 4); branch names may hold `/` (section 5.3); with the fleet configured the hub has no desktop (section 3.1).

### Changes during execution (2026-10-07)

The final review of the implementation, its fix wave and a follow-up changed these behaviours. Each is in the section named.

28. **A first attempt in doubt is 409 `uncertain`,** not a 500: the app shows "may have been sent" with Check again from the start, for a send and for an escalation answer (sections 3.1, 7).
29. **Escalation answers keep a row as sends do:** `started` before typing, the store and store sequence once the node answers, settled through `op.status` on a repeat (section 3.1).
30. **A refusal that says nothing ran releases the send.** Any error with `executed: "no"` (`denied`, `bad_args`, `too_large`, `unknown_op`, an agent's `internal` before `started`) is a refusal the app words, not a send held in doubt (sections 3.1, 5.3).
31. **The store sequence.** Every `res` carries `storeSeq`, and the hub keeps it with what is in doubt, so a database put back in place from an older copy can't vouch for a key it no longer has. A copy opened as another file is a new store at once. The fleet's own answers after sending carry the highest `storeSeq` it has seen from that store, rather than none (a deviation accepted during execution: without it the commonest case in doubt, a connection lost after the paste, would carry nothing to compare; the value is one the database reached, so it can't make the hub think a database went backwards). The fleet also keeps that highest value per node and store in fleet.db and sends it in the welcome (`storeSeqSeen`): an agent behind it starts a new store before it runs anything, which closes the gap a count alone leaves (a restored database running keyed ops until it is level again) (sections 5.2, 5.3, 7).
32. **Hook events no subscriber takes** are counted per path, logged at startup and alerted (`unrouted_hook`) once per script path, never dropped silently (sections 5.5, 5.6).
33. **The fleet checks op arguments** with the shared schemas before routing (`bad_args`, nothing sent), as section 5.3 said.
34. **The terminal view stays open** while a frame is only unavailable (the node offline, the fleet unreachable) and asks less often meanwhile, up to every 2 s; a pane gone still closes it (section 3.1).

## 16. The rollout to the PC (2026-10-08)

The owner asked to get the fleet live in production without regressions, and chose the PC holding both roles (section 2) before sub-projects 2–4: first the new code with the hub on its legacy adapters, then the fleet service and a node agent live beside it, then the hub on the fleet. Each step has its own rollback.

1. **The desktop with a fleet.** Section 3.1 first said that with the fleet configured the hub has no desktop target, whatever `MORNDO_VNC` says. On the PC that would have taken away the Desktop tab the owner has today, a regression. `MORNDO_VNC` names a VNC server the hub connects to itself, so the fleet changes nothing about it: the hub offers that desktop with or without the fleet, and none when it is unset. A control plane apart from its nodes (the cutover, sub-project 4) leaves `MORNDO_VNC` unset until the desktop op exists (section 11). Pinned by `test/fleet/desktop.test.ts` (the real hub in fleet mode) and `apps/hub/test/local-ports.test.ts`, with the negative controls `rollout-fleet-desktop` and `rollout-desktop-unset`.
2. **How it runs on the PC** (live since 2026-10-08, record: a private QA record, not in this tree). Until sub-project 3 installs by role, the units are written by hand, all three running one worktree (`~/morndo/.worktrees/live-fleet`):
   - `morndo-fleet.service`: the defaults (no config file), agents on 127.0.0.1:8791, the client socket at `~/.local/state/morndo-fleet/fleet.sock`;
   - `morndo-node.service`: node `pc`, session `main`. Its relay listens on 127.0.0.1:8789, not 8787: kira keeps 8787 and every hook until sub-project 2, so the relay gets nothing yet. The policy allows the 12 ops the hub uses (`lane.*` and `worktree.*` off until a client needs them) and locks the `manager` window with the lock file kira takes;
   - `morndo-hub.service`: `MORNDO_FLEET_SOCKET` set, `MORNDO_VNC` kept (16.1).

   Both new units restart on failure but not on exit 78 (EX_CONFIG: a setting to fix, which a restart can't). The rollback, one section per step, is in the PC's backup folder (`~/.local/share/morndo-backups/2026-10-08-fleet-live/ROLLBACK.md`).
3. **What the rollout found.** Two `fsync`s per keyed op (the done key, then `synchronous=FULL`, section 5.3) cost 1–4 s per send while the PC's disk, a WSL disk on an HDD, is saturated (median 848 ms per `fsync`). Section 16.4 removes them. Separately, and as before the fleet, the hub restores only the last 7 days of answers at a start (`Store.decisions()`), so an answered question still open in the manager's ledger after 7 days shows as "to decide" again after a restart.
4. **Durability by failure domain** (2026-10-08). The owner wants Morndo to run for many people on modest machines (a laptop, a small VPS, an HDD, WSL), so the cost of a hook can't depend on the disk. Until now the agent synced its database to the disk on every commit (`synchronous=FULL`): every hook a lane sends (each tool call's `PreToolUse`, a blocking HTTP hook with a 2 s timeout) and every keyed op waited for an `fsync`, on the agent's one thread (better-sqlite3 is synchronous).
   - **The rule.** A commit is synced to the disk only when what it guards must outlive the machine it is on. In the node agent's database (`synchronous=NORMAL`) that is one commit: a done key's `started`, written before its side effect, which runs under `FULL` for its transaction (`done-keys.ts`, `synced`). Everything else there is not synced: the hook spool (a hook taken back came from a lane that went down with it, which kira's in-memory handling loses today as well), a `done` (one taken back leaves `started`, so a repeat stays uncertain), a released key, the acknowledgements. A crash of the agent alone loses nothing ("Transactions are durable across application crashes regardless of the synchronous setting", https://www.sqlite.org/pragma.html#pragma_synchronous).
   - **Why `started` must be synced, and the panes can't stand in for it** (an adversarial review of the first version, which synced nothing, reproduced this): the hub sends an answer to whichever pane is the manager now, by name. After a power loss with an answer in flight, its retry goes to the new manager pane, where no expectation check can tell, and with the answer lost the store sequence the hub kept doesn't reach the `started` that was taken back: the answer was typed twice. A disk that fails while the machine runs on (the host disk under a WSL disk full, thin storage) would lose a `started` the same way, with the same tmux server still up. With `started` synced, the retry finds it (`uncertain`), and a sync that fails fails the commit, so nothing is typed (the executor answers `internal`, not executed). The tmux stamp and the store sequence stay as defence in depth. The fleet's (`FULL`, unchanged) does: a node deletes an event once the fleet has acknowledged it, and on a control plane apart from its nodes those nodes' lanes run on. The hub's runs `NORMAL`, as it always has (better-sqlite3 builds SQLite with `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1`), now set explicitly.
   - **Its condition.** All three databases must be on their machine's own disk, which SQLite's WAL mode needs anyway ("WAL does not work over a network filesystem", https://www.sqlite.org/wal.html). Each service refuses one on NFS, SMB/CIFS, 9P (WSL's `/mnt/c`), AFS or Coda (Linux, by `statfs(2)`'s file system type), with exit 78 (`packages/service-kit`, `assertLocalDisk`).
   - **Tests.** `test/fleet/drills-retry.test.ts`:
     - (f) a power loss with an answer to the manager in flight: its `started` survives, the retry stays uncertain, and the restarted manager receives nothing; its control takes `started` back and the answer is typed into the new manager;
     - (e) the database put back to before a send's commits, `started` included (more than a power loss can take), with the tmux server gone: the retried send finds no pane, the store turns over, the send in doubt stays uncertain; its control (no expectation check) types into the new lane;
     - the "older copy put back" drills (b″) to (b⁗), the same rollback without the tmux restart.

     (f) shows what a `started` that survives does, not the sync that makes it survive: its kept case is a killed agent, which `NORMAL` survives too. The sync is pinned by `done-keys.test.ts` (`FULL` around `started` alone, `NORMAL` after it whatever happened, and never nested in another transaction) and `db.test.ts` (`NORMAL`, and `fullfsync` for macOS, whose plain `fsync()` leaves data in the drive's cache); negative controls `durability-*`.
   - **What it gives up, in the safe direction.** A `release` (a refusal before anything was typed) isn't synced: if a power loss takes it back, its `started` returns, and a retry of that send stays uncertain instead of typing. The fleet's `FULL` commits don't use `fullfsync`, so on a Mac control plane they can still be lost on a power cut (older than this change; part of the fleet's hook path in sub-project 2).
   - **Measured** with `scripts/bench-relay.ts` (a real fleet and agent, one subscriber, `PreToolUse`-sized hooks at 2 a second, three times the busiest minute seen on the PC) on the PC's WSL disk on an HDD, the two settings run back to back on the same code:

     | | `FULL` | `NORMAL` |
     |---|---|---|
     | a hook answered (p50 / p95 / max) | 911 ms / 28.9 s / 31.7 s | 1.8 ms / 4.6 ms / 1.4 s |
     | an op through the fleet meanwhile (p95; over 7 s) | 855 ms; 6 | 196 ms; 0 |
     | hook to subscriber (p95) | 6.6 s | 0.9 s |

     On an SSD (the owner's Mac) a hook is answered in 2.5 ms (p50). A keyed op now waits for one sync (`started`) instead of two. What `NORMAL` still shows at the tail (about 1–2 s) is the fleet's own `FULL` commits on the same busy disk and the operating system holding back writes to it; the hook path through the fleet (sub-project 2) has to measure and batch those. A `/file` hook still syncs its copy of the file (`relay-files.ts`), which is rare.

