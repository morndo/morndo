# Morndo node agent (`morndo-node`)

One per machine that hosts lanes ([ADR-0012](../../docs/adr/0012-fleet-pull-agents-and-a-separate-fleet-service.md); design: [`docs/design/fleet-core`](../../docs/design/fleet-core/README.md)). It keeps one authenticated WebSocket to the fleet service, dialed from here, so the machine needs no inbound port. Over it, the agent runs typed operations on this machine's own tmux server and `~/.claude`: inventory, captures, frames, keys and sends, transcripts, files, lanes and worktrees. It also serves the hook relay on `127.0.0.1:8787`, so `~/.claude/settings.json` can be the same on every machine.

Installing it as a user service is sub-project 3. Until then it runs by hand, and nothing in this sub-project is installed on a live system.

## Run it

Needs Node 24 (`>=24.12`) and tmux (the commands are those of tmux 3.4; the agent doesn't check the version).

```sh
# 1. On the control plane: a join string for this machine's name, single use, valid 10 minutes
node apps/fleet/src/main.ts node add pc
# 2. Here: make this node's key, pin the fleet's key, and join (quotes, spaces and a trailing newline are fine)
node apps/node-agent/src/main.ts join 'morndo-join:1:…'
# 3. Here: connect, and keep connecting (backoff from 1 s up to 60 s, with full jitter)
node apps/node-agent/src/main.ts run
# What it is doing: connection state, last close, retry time, instance id, spool depth and drops
node apps/node-agent/src/main.ts status
```

`join` runs once: if `config.json` exists it refuses, and to join again you remove that file and `node-key.pem` first. It gives the fleet 15 s to answer. A truncated join string is refused with a clear error, and nothing is written. So is one whose fleet URL is plain `ws://` to anything but this machine (`127.x.x.x`, `localhost`, `[::1]`): over the network the agent speaks only `wss://` (TLS through Tailscale Serve). It refuses such a URL in `config.json` too, and checks it again at every connect.

`run` exits 78 (setup to fix, a restart won't help), with one sentence, for a config or policy that doesn't fit, a node key that is missing (a link to nothing included), corrupt or half written, or not Ed25519, an `agent.db` that isn't SQLite, a database from a newer agent (refused before anything is written to it), a taken relay port, or test hooks outside a test. `MORNDO_NODE_LOG_LEVEL` sets the log level (default `info`).

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
| `~/.local/state/morndo-node/agent.db` | Done keys and the hook stream (the spool). It and its `-wal` and `-shm` are mode 0600, set explicitly. SQLite in WAL mode with `synchronous=NORMAL` (design §16.4): no hook waits for the disk, and a crash of the agent loses nothing. Two commits are synced (`FULL` for that transaction). The first is a done key's `started`, before its side effect: a retry may go to another pane than the first attempt, so it must survive a power loss or a failing disk, and if the sync fails, nothing is typed. The second is storing a delivery, before its sender is told it is queued: if that sync fails, the delivery is refused, never silently lost. The database also holds the delivery queue (migration 3): each delivery's text, target, state, and the session it is bound to or was typed into. Final ones are pruned after 7 days, with the done keys. It must be on this machine's own disk: on a network file system the agent refuses to start (exit 78). Numbered migrations; a database from a newer agent is refused. Its stream id names this node's **store**: every answer carries it. A new database is a new store; so is a copied or restored one. The database records its file's identity (device and inode) with its stream id, and a file opened under another identity (a copy with `cp`, a backup put back as a new file, a move to another file system) starts a new stream, so a new store, before the first hello, and says so in the log: a send in doubt then reads `unknown` from another store and stays uncertain. Not detected that way: a block-level clone of a VM or disk image, a copy written over the same file in place (`cp` onto the existing `agent.db` keeps its inode), and a restore that gets the freed inode number back (ext4 may reuse one). Those keep the store, and the **store sequence** tells instead: the database counts the keyed ops it has started (`store_seq`, one more in the transaction that commits each `started`, never lowered), every answer carries it (`storeSeq`), the fleet keeps the highest it has seen per store and sends it in the welcome (`storeSeqSeen`): a database holding less starts a new store before the connection goes online, says so in the log, and runs nothing under the old one. The hub also keeps it with a send or an answer in doubt; `op.status` answering `unknown` from the same store at a lower sequence leaves that one uncertain. The agent itself also notices, once the stream has had traffic, when the fleet has acknowledged more of its stream than the database holds, and then starts a new stream (once per process; never under the `fixedStreamId` test hook). Events a copy still holds are sent again under the new stream (at least once). What remains open is listed below the table. |
| `~/.local/state/morndo-node/relay-files/` | Copies of the files hooks sent to `/file`, deleted 24 h after the fleet acknowledged them. The spool, these copies and the inbox share one disk budget of 256 MiB; a `/file` that doesn't fit is answered 503 (so the hook script's fallback runs). |
| `~/.local/state/morndo-node/inbox/` | Images the hub put here for a lane (`file.put`); a partial upload (under `.partial/`) is deleted after 10 minutes, a finished one after 7 days. A chunk that doesn't fit the shared budget is refused `too_large`, nothing written. |
| `~/.local/state/morndo-node/memory/` | Memory's skills (`memory.sync`, below): each version's parts under `staging/<version>/`, and the committed skills under `skills/<name>/SKILL.md`, the node's own copy of what it writes into the skill directories. |
| `~/.local/state/morndo-node/drafts/` | A copy of each draft the deliverer stashed (`draftStash`, below), as `<time>-<lane>.txt`, readable by this user only. The last 50 are kept. |
| `~/.local/state/morndo-node/status.json` | What the running agent reports, for `morndo-node status`. |

**A restored `agent.db`: what is still not caught** (after the file's identity, the `ackSeq` check and the store sequence; final review I2 and its follow-up). The fleet keeps the highest store sequence each store has shown (fleet.db, across its restarts) and sends it in the welcome as `storeSeqSeen`. An agent whose database holds less was put back from an older copy: it starts a new store before the connection goes online, so no op runs under the old store and a send in doubt reads `unknown` from another store, however many keyed ops it runs afterwards. What remains, where a send or an answer in doubt can be typed a second time on its repeat:

- **A copy taken just before a send whose answer never reached the fleet.** The fleet only knows the sequences that answers showed it. If the send's `started` was the database's last keyed op and its answer was lost (the connection dropped after `started`, and no later answer from that database reached the fleet before the restore), a copy taken after the previous keyed op is level with everything the fleet and the hub saw: nothing tells it from the original.
- **No sequence on either side.** An agent, a fleet or a hub from before the store sequence gives nothing to compare: the stores alone decide, as before. (A fleet without `storeSeqSeen` leaves the agent's store as it is.)
- **A clone that takes over.** A cloned VM is refused while the original is connected (4409); one that answers instead (the original gone) is a copy as of the clone, so a restore, caught or not as above.

Not open any more: a restored database catching up (running keyed ops until its count is level with what the hub kept), a fleet restart in between, a send in doubt with no store recorded (the fleet took it and never answered, or the hub stopped while typing it), and a database lost or reinstalled (a new store).

## Config

| Field | Default | Meaning |
|---|---|---|
| `node` | from the join code | This node's name, `[a-z0-9-]{1,32}`. |
| `fleetUrl` | from the join string | Where the agent dials: `ws://127.0.0.1:8791/agent` on the control plane, the fleet's `wss://` tailnet address elsewhere (sub-project 3). Plain `ws://` only to a loopback host; the agent refuses any other. |
| `fleetKey` | from the join string | The fleet's public key (SPKI DER, base64), pinned. A fleet that can't sign with it is refused. |
| `keyPath` | `~/.config/morndo-node/node-key.pem` | This node's private key. |
| `dbPath` | `~/.local/state/morndo-node/agent.db` | The agent's database. |
| `relayPort` | `8787` | The hook relay, on 127.0.0.1 only. A test agent beside a live one takes another port. |
| `hub` | none | This node's hub, an `https://` URL, or `http://` to this machine (`127.0.0.1`, `localhost` or `[::1]`): the node sends tokens there. The agent reads it from this file. `MORNDO_HUB` is a lane's variable and is not used here. A job start while `hub` is absent is refused; it is not treated as the hub being down. |

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
| `launch` | `{ "command": ["claude"], "via": "shell" }` | How `lane.start` runs Claude Code. `{account}` in `command` is the op's `account`: a command without it refuses an op that names one, and a command with it refuses an op that names none. `resume` adds `--resume <session>`; an op adds nothing else. `via: "shell"` starts the user's shell and pastes the command once its prompt shows, so the window outlives Claude Code and `claude-pool` can still move the lane. `direct` runs the command as the window's own. The owner's PC: `{ "command": ["claude-as", "{account}"], "via": "shell" }`. |
| `protected` | `["manager"]` | Lane names `lane.stop` refuses (`denied`). |
| `statusContract` | `{ "mode": "ask", "exempt": ["manager"] }` | Whether the relay asks a lane, once per turn, for the status line its answer lacks, or for a waker when it says WAITING with nothing to wake it (Hook relay, below). `"off"` never asks; `exempt` names lanes never asked (the orchestrator). |
| `memory` | `{ "skillDirs": ["~/.claude/skills", "~/.agents/skills"] }` | Where `memory.sync` writes Memory's skills (ADR-0031): at most 8 directories, each absolute or starting with `~/` (this user's `HOME`), without a `..` segment. A missing directory is made. |
| `draftStash` | `{ "lanes": ["manager"], "afterMin": 60 }` | Lanes whose unsent draft the deliverer stashes once it has held a delivery and stayed the same for `afterMin` minutes (1 to 1440): it saves a copy under `drafts/`, presses Claude Code's `Ctrl+S` and checks the box is empty, then delivers what waited (#64; fleet API §4). Claude Code puts the draft back after the message is submitted, and the node stashes that same text again for the next delivery, so the draft ends in the box as it was. `"lanes": []` turns it off. |
| `engines` | none | Lanes on an engine of the engine layer (ADR-0013, ADR-0027). `cli`: the absolute path of its CLI (`engines`), which `lane.start` asks `resolve <role> --json` and `option enabled`. `launch`: a launch command per provider, `{ command, via }` as `launch` above, where `{model}`, `{effort}`, `{account}` and `{lane}` are filled from the pick and the op; a word that is only a placeholder with no value is left out, with the option just before it. A start by role gives its `account` only to a command that takes one (the caller can't know the pick); a named engine refuses an account its command can't take. `defaultRole`: the role of a start that names neither a role nor an engine (not a resume, not a protected lane); needs `cli`. Example: `{ "cli": "/opt/engines/bin/engines", "defaultRole": "implement", "launch": { "acme": { "command": ["acme-lane", "--model", "{model}", "--effort", "{effort}", "--window", "{lane}"] }, "claude": { "command": ["claude", "--model", "{model}"] } } }`. The resolver runs with this service's environment: a provider whose program isn't on its `PATH` is skipped as not installed, and the start says so. |

## Operations

The full table is in the design, section 5.3. What a caller relies on:

- **Arguments.** Each op's arguments are decoded with the protocol's own schema (`OP_ARGS`, the one the fleet checked; a field it doesn't know is dropped, never passed on), then judged by what only this node can: paths against its policy's roots, a branch name by `git check-ref-format --branch` (`/` allowed), an account and a resume id once more before `claude-as`, a `file.put` name with no `/`. Anything that fails is `bad_args`, not executed. A key on an op that takes none is `bad_args`, as is a keyed op without one.
- **Expectations.** Every side-effecting pane op carries an expectation: `{ server, window, sessionId? }`. It is checked inside that pane's queue immediately before acting, and a mismatch is `no_pane`, not executed. A restarted tmux server gets a new stamp (`@morndo-server`), so its old worker IDs answer `no_pane`.
- **Keys, in two phases.** `pane.send`, `file.put`, `lane.start`, `lane.stop`, `worktree.add`, `job.notice` and `memory.sync` take a key. `job.cancel` does not: the node cancels by id, and a second cancel is the same terminal row.
  - before the side effect, `key → started` is committed, with a hash of the op and the fields that decide its effect (`pane.send`: worker ID and text; `lane.start`: name, cwd, account, resume; `lane.stop`: name; `worktree.add`: repo, name, base; `file.put`: upload and offset; `job.notice`: id, lane and text; `memory.sync`: version and part; never the expectation, the token or the timeout);
  - after it, `key → done` with its outcome;
  - a refusal with `executed: "no"` deletes the key, so a retry may act;
  - a repeat returns the stored outcome (done) or `uncertain` (started); a repeat with a different hash is `uncertain` too (`executed: "maybe"`);
  - `op.status { key }` answers `unknown`, `started` or `done`, and, like every answer, names this node's store;
  - keys are kept 7 days.
- **Deadlines.** A request's deadline runs on a monotonic clock (`timeoutMs` − 250 ms). If the side effect hasn't started by then, the answer is `timeout`, not executed. A pane lock that is free only after the deadline never types.
- **tmux.** Every call passes `-u`; a session is named `=name`; every argument tmux reads as a format and that carries outside data (a window name, a lane's directory) has its `#` doubled (`tmuxLiteral`), so a directory named `#{session_name}` or `#(…)` is taken as it is; panes and windows are targeted by their IDs, never by name.
- **Limits.** Messages are at most 512 KiB; bulk data moves in chunks of at most 256 KiB; files are at most 25 MiB; sends at most 8000 characters; keys at most 4096; `captureMany` at most 64 panes, each capped at 6 KiB with `truncated: true`.

## Deliveries (`lane.deliver`, `delivery.cancel`)

The node's delivery queue (design: [fleet clients](../../docs/design/fleet-clients/README.md) §4). Clients use the fleet's `/v1/deliveries` ([`docs/fleet-api.md`](../../docs/fleet-api.md) §6), never these ops directly.
- **Storing.** `lane.deliver { id, target, text, ttlMs? }` stores the delivery in `agent.db`, synced, then answers `queued`. `notAfter` is set on this node's clock. The same id with the same target and text answers its current state; with other content, `id_conflict`.
- **Only lanes with a live Claude Code session** take deliveries, whatever its `status` (`shell` means a shell command is running under it). A pane with no live session (no session file, or its process gone) makes a delivery wait (`no_session`) when its lane is sticky or the pane's process started in the last 2 minutes, and refuses it otherwise.
- **Typing:**
  - one at a time per lane, in the order queued;
  - tried at once, on each change of the session's status, of a hook of its session, or of the inventory, and at least every 5 s;
  - a delivery typed or held and still waiting for its receipt holds the next one back (`earlier`) for at most 60 s;
  - each try is a `pane.send` under the delivery's id as its done key, with all of its checks (menu, draft, input box, the pane lock). A refusal leaves the delivery `queued`, with that reason;
  - a line still in the box after Enter gets Enter again while the box shows exactly that line, at most twice more;
  - a `started` key found after a restart moves the delivery to `typed`, never typed again.
- **Confirming,** from the transcript of the session it was typed into, by the receipt rules in `packages/node-ops` (`receipt.ts`):
  - a prompt that holds the text, or a queued line taken into a turn: `delivered`;
  - an `enqueue`: `held`;
  - a `dequeue`: no verdict;
  - a line Claude Code dropped on an interrupt (`cleared_on_cancel`): typed once more under `<id>#2` if the box is clear and the session idle, else `uncertain`;
  - a slash command that starts a new session (`/clear`, `/new`): the pane's session changing to a new id after the typing.

  Each receipt confirms one delivery.
- **Expiring.** Past `notAfter`, a `queued` delivery is given up (`expired`). A `typed` or `held` one is `uncertain`, and never typed again.
- **Cancelling.** `delivery.cancel { id }` gives up a `queued` delivery. Past that it answers `already_typed`.
- **Events.** `ev.delivery` on every change. After each (re)connect it also sends the state of each delivery not final, and the final ones of the last hour.

## Lanes, keys, captures and session state

- **`lane.start { name, cwd, account?, resume?, prompt?, role?, engine?, reason? }`** runs the policy's `launch`, or an engine (ADR-0027):
  - `role` asks the engine layer what runs it now; `engine` (`provider:model[@effort]`) names one, and needs a `reason` where `engines.defaultRole` is set; a start with neither runs `engines.defaultRole` when there is one.
  - Fail closed: no `engines`, no `cli` for a role, nothing in the role's chain available, a provider without a launch command, or the engine layer switched off is `denied`; an unknown role is `bad_args`. Nothing starts, and `launch` is never used instead.
  - The answer's `engine` (`{ entry, role?, skipped? }`) says what ran and what the resolver passed over first.
  - It answers `{ workerId, waiting: "trust" }` when Claude Code asks whether to trust the folder. Accepting stays the client's decision.
  - `prompt` becomes a delivery to the new pane, with id `<client>:prompt:<the first 16 hex digits of the SHA-256 of the start's key>`. It waits for Claude Code to start, then is typed once.
- **`lane.stop { name, mode? }`.**
  - `exit`, the default, types `/exit` as a delivery is typed, answers Claude Code's exit prompt, then answers once the window has closed or is back at its shell, or `uncertain` after 30 s.
  - `kill` closes the window.
  - Names in `protected` are refused with `denied`.
- **`pane.capture { workerId, lines (at most 2000), attributes?, join? }`** returns up to 256 KiB (as JSON) of the screen's last lines, with tmux's attribute escapes when asked, and wrapped lines joined unless `join` is false. `pane.captureMany` keeps its 6 KiB per pane.
- **`pane.keys`** takes `names`, tmux key names from an allow-list (`Enter`, `Escape`, `Tab`, `BSpace`, the arrows, `Home`, `End`, `PageUp`, `PageDown`, `C-c`, `C-d`, `C-u`, `Space`, digits, letters), or `data`, literal text. Never both.
- **Session state.** The inventory gives each pane, from its live session, the `status` as Claude Code writes it in `~/.claude/sessions/<pid>.json` (`busy`, `idle`, `waiting`, or `shell`: a shell command running under it), `pid` (Claude Code's process), and `topic` and `lastPrompt` (the session's latest `ai-title` and `last-prompt` entries, from a tail scan of its transcript, cached per session). `status` and `pid` are null without a live session; `topic` and `lastPrompt` are absent when unknown.
- **Lane state events.** When a session's status turns `waiting`, the node reads the menu's question from the screen and sends a `needs_input` lane state event. When it leaves `waiting`, it sends `answered`. Both go through the hook stream as `/lane`, kept and replayed like hooks.
- **Health** (`ev.health`, every 30 s and after every welcome): memory, pressure, free disk in the home, load, whether tmux answers, `wallClock`, the spool's depth and drops, a jobs config problem when there is one, and `tzOffsetMin`: this node's UTC offset in minutes now, east positive (UTC+2 is 120; `-new Date().getTimezoneOffset()`). Lanes' wake-ups are written in the node's local time, so the fleet reads their fire times with it (ADR-0032, R3). It is read at every health, so a daylight-saving change shows at the next one.

## Memory's skills (`memory.sync`)

What the lanes learned, as Agent Skills (ADR-0031; design: [Memory](../../docs/design/memory/README.md)). The hub sends them; nothing on the node asks for them.
- **`memory.sync { version, part, parts, files }`**, keyed (the hub's key: `hub:memory:<version>:<part>`). Each file is `{ name, content }`. Every name matches `MEMORY_SKILL_NAME` (`morndo-mem-…`, the Agent Skills name rule), so it is one folder name and never a path.
- **Staging.** Each part is kept as `memory/staging/<version>/part-<n>.json` and answered `committed: false` until every part of its version is there. A part whose `parts` differs from the parts already staged of its version, or that names a skill another part has, is `bad_args`, not executed.
- **Committing** the last part: each skill goes to `memory/skills/<name>/SKILL.md`, then to `<dir>/<name>/SKILL.md` in every directory of the policy's `memory.skillDirs`, beside a marker file `.morndo-memory` holding the version. Every `morndo-mem-*` folder in those directories that carries the marker and is not in the version is removed. Then only the committed version's staging is kept; a version still missing parts is kept 8 days, as long as its done keys may be.
- **What is not the node's is left as it is.** A folder of a skill's name without the marker is someone else's: untouched and named in `conflicts` (an empty folder is taken). Nothing follows a symbolic link: a link where a skill folder would be is a conflict, a link is never removed through, and a file is replaced by a rename that replaces a link instead of writing through it.
- **The answer:** `{ committed, written, removed, skillDirs, conflicts }`. `written` and `removed` count skill folders in `skillDirs` (absolute); a skill whose file already holds the same text is not written again, so the same version committed twice writes nothing.
- A node whose `ops` leaves out `memory.sync` refuses it with `denied`. The hub tries such a node again an hour later.

## Hook relay (`127.0.0.1:8787`)

It answers after the event is in the durable stream, and before any network I/O.

| Path | Answer | Kept | When the spool can't be written |
|---|---|---|---|
| `/cc`, `/sl` | 204, empty | the latest per session | still 204 (a session never stalls); counted in `health.drops` |
| `/hook/stop` | 200 `{ ok: true, queued: true }`, or an ask (the status ask, the waker ask or the reply style ask): 200 `{ decision: "block", reason }` | every event (an asked one marked `statusAsked`) | 503, so the hook script's fallback runs |
| `/hook/failure`, `/notify` | 202 | every event | 503 |
| `/file` | 202 (413 over 25 MiB; 400 for a path that isn't absolute; 403 where files are never shared; 404 when missing) | a copy under `relay-files/`, by today's file rules | 503 |

**The status ask** (reliable lanes §3.1). A lane's answer starts with one status line: `STATUS: DONE`, `STATUS: BLOCKED`, `STATUS: NEEDS DECISION` or `STATUS: WAITING <on what> [for <N> min|h]`. When Claude Code's own `Stop` body comes from a placed window whose answer has none, with `stop_hook_active` false and no background task or wake-up pending, the relay answers `{ "decision": "block", "reason": … }` and keeps the Stop with `statusAsked: true` in its body (subscribers get its answer; the fleet makes no lane event of it): Claude Code writes the line and stops again, and that Stop (now `stop_hook_active`) is the turn's end. So it asks at most once per turn. Off with `statusContract.mode: "off"`; never for `statusContract.exempt`.

**The waker ask** (ADR-0032, W1: [`docs/design/agent-board`](../../docs/design/agent-board/README.md) §5). A `Stop` that passes the same rules, whose status line is `STATUS: WAITING`, is asked once for a waker when nothing will end the wait: its `background_tasks` and `session_crons` are both empty arrays, and no job of that lane is queued, starting or running on this node (one it started, or one whose notice goes to it). The reason names what it said it waits on and gives three ways out: a one-time wake-up (Claude Code's `ScheduleWakeup` or `CronCreate`), the wait as a job (`morndo job start --notify lane:<this lane> -- <command>`), or a settled `STATUS: DONE`, `BLOCKED` or `NEEDS DECISION`; then the status line again. It is answered and kept as the status ask is (`statusAsked: true`), and the Stop after it (`stop_hook_active`) is the turn's end. A Stop without either array, or with one that isn't an array, means Claude Code couldn't read its task registry: not asked. Nor is a lane whose jobs the node can't read (the job store not open yet, or a read that failed, which is logged). A Stop with no status line at all gets the status ask, as before.

**The reply style ask** (T-308). For the lanes in `statusContract.exempt` (the manager), a `## Digest` or `### Digest` or a card (an answer whose last line is a `[buttons …]` line, read as kira reads it) whose visible part (outside `<details>` and code fences) is over 8 lines or 120 words, carries ticket numbers, hashes or ask ids, or lists a task as done whose merge the hub's board has not live (unless "not live" is said of that task) is asked once, with the reason. It reads the board for up to one second with the token in `~/.config/morndo-node/board-token` (a plain file, mode 600, read when used; never `MORNDO_AGENT_TOKEN` in the node's environment, which the tmux server and every lane would inherit: `run` removes it from its environment first, with a warning); without the file only the first two rules run.

Anything but POST on the four kept paths is 405 and an unknown path 404. A request with an `Origin` header comes from a web page, not a hook: the kept paths answer it 403, progress paths drop it (204). A body over 448 KiB is 413 (dropped, for progress). A write the spool refuses changes nothing and counts one drop.

Each event gets this node's name and the window it finds through `TMUX_PANE` or `session_id`, else the body's own `window` (a `notify` sent from outside any pane), then flows in order to the fleet (`streamId`, `seq`) and is replayed after a reconnect, before anything new. A spool write that fails while the fleet acknowledges events (a full disk) is logged; it never takes the agent down. Hook entries in `settings.json` get `"timeout": 5` (sub-project 3): an HTTP hook failure doesn't block Claude Code, but a slow hook stalls the session.

## The Stop hook script

The script is `hooks/lane-notify-stop` in the release. `settings.json`'s Stop hook command points at its installed path. It starts the tmux window and git lookups in the background and polls them for at most 2 s, then cuts them off without waiting (killing their process groups). The post then goes out with whatever was found. The post is bound to 8 s and the fallback `lanes notify` to 4 s, so the hook always ends in under 15 s, well inside Claude Code's 20 s. A fact that missed its bound is left out of the post. Working files live in a per-user directory under `$XDG_RUNTIME_DIR` (else `$TMPDIR`, else `/tmp`); a directory left by a hook killed outright is removed an hour later. The directory is used only when it is a real directory (not a symlink), owned by the user, with mode 700; otherwise the hook posts the turn end without the window and git facts.

`MORNDO_RELAY_PORT` (default 8787), `MORNDO_RELAY_URL` and `MORNDO_LANES` choose the relay and the fallback. `MORNDO_HOOK_LOOKUP_S`, `MORNDO_HOOK_POST_S` and `MORNDO_HOOK_NOTIFY_S` shorten those bounds (tests only).

## Security model

What it protects:
- The agent dials out; there is no inbound port.
- Both ends prove themselves on every connection: this node signs the fleet's challenge, and the fleet signs this node's with the key pinned at join.
- Operations are typed. There is no generic exec, `lane.start` takes typed fields and never free flags, and file and worktree paths are confined here with today's rules: symlinks resolved, deny roots, secret file names, 25 MiB. The deny roots include the state of every Morndo service and of kira (`~/.local/share/morndo*`, `~/.local/state/morndo*`, `~/.config/morndo*`, `~/.local/share/kira`, `~/.config/kira`: the hub's `morndo.db`, the fleet's `fleet.db` and key, this agent's own key and database), and secret file names are refused wherever they are (keys and certificates, `.env` files, `.netrc`, and every `.credentials.json`, in `~/.claude/` and in each `~/.claude-accounts/<name>/`). A file is opened without following a link in its last place (`O_NOFOLLOW`), so one swapped in after the check is refused.
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
| `noDoneKeys: true` | Keys are neither recorded nor consulted, the delivery queue's included (negative control) |
| `noExpect: true` | Worker IDs resolve by pane number alone; expectations are not checked (negative control) |
| `clockOffsetMs: <n>` | Every wall-clock time this agent reports is shifted by n ms |
| `spoolFail: true` | Every spool write fails, the deletion of acknowledged events included |
| `fixedStreamId: "<uuid>"` | This stream id instead of the database's own, and so this store in every answer; kept even where a restored database would start a new stream (negative control) |
| `killAfterEffect: "<substring>"` | For a keyed op whose key contains it: right after its side effect returns, before `done` is committed, the agent kills itself (SIGKILL). Once per process. |
| `noSessionBinding: true` | A delivery to a lane name that isn't sticky follows the name as a sticky one does (negative control) |
| `retypeUnderFirstKey: true` | The one retype after `cleared_on_cancel` runs under the delivery's own id instead of `<id>#2` (negative control) |
| `deliveryStartGraceMs: <n>` | A new pane with no session makes a delivery wait n ms instead of 2 minutes |

## Checks

```sh
npx vitest run --project units apps/node-agent     # the agent's own tests
npx vitest run --project fleet                     # real fleet + real agents (+ the hub), isolated tmux servers
```

## Sources (each entry says whether it was re-checked; re-check when upgrading)

- Node.js 24 `crypto` (Ed25519 `generateKeyPairSync('ed25519')`, `sign(null, …)`, `verify(null, …)`): https://nodejs.org/docs/latest-v24.x/api/crypto.html. Checked 2026-10-07.
- Node.js 24 `net`, Unix socket path lengths (107 bytes on Linux, 103 on macOS): https://nodejs.org/docs/latest-v24.x/api/net.html#identifying-paths-for-ipc-connections. Checked 2026-10-07.
- `ws` 8: ping/pong liveness and `terminate()` (README, "How to detect and close broken connections?"), `maxPayload` and client options (doc/ws.md). https://github.com/websockets/ws. Checked 2026-10-07.
- SQLite: `PRAGMA synchronous=NORMAL` in WAL mode is "safe from corruption" and durable across application crashes, but "might roll back following a power loss or system crash"; `FULL` syncs the WAL after each commit. "WAL does not work over a network filesystem." https://www.sqlite.org/pragma.html#pragma_synchronous, https://www.sqlite.org/wal.html. Checked 2026-10-08.
- better-sqlite3 (`pragma()`, `transaction()`): https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md. Checked 2026-10-07.
- tmux(1), 3.4: `-L`, user options (`@…`), `show-options -gqv`, `capture-pane`, `send-keys -H/-l`, `paste-buffer -p`; formats (`#{…}`, `#(…)`, `##` for a literal `#`) in `new-window -n/-c` and `rename-window`. https://man7.org/linux/man-pages/man1/tmux.1.html. Cited, not re-checked (a 2026-10-07 fetch confirmed only `-L` and `capture-pane`; the page was truncated).
- git-check-ref-format(1), `--branch`: https://git-scm.com/docs/git-check-ref-format. Checked 2026-10-07 (the option exists; that `/` is allowed was confirmed by running `git check-ref-format --branch feature/x`).
- open(2), `O_NOFOLLOW`: https://man7.org/linux/man-pages/man2/open.2.html. Checked 2026-10-07 (a link as the last component fails with ELOOP). Node.js `fs.constants`: https://nodejs.org/docs/latest-v24.x/api/fs.html#file-open-constants. Cited, not re-checked.
- Claude Code hooks: HTTP hook failures are non-blocking, the default timeout is 600 s, the per-hook `timeout` is in seconds, and the common input fields include `session_id`. https://code.claude.com/docs/en/hooks. Checked 2026-10-07.
- Claude Code hooks, `Stop` (for the waker ask): the input's `background_tasks` and `session_crons` "are present when the task registry is reachable and are empty when nothing is in flight or scheduled"; `stop_hook_active` is true while a Stop hook's continuation runs; `{"decision":"block","reason"}` "prevents Claude from stopping", and Claude Code overrides the block after eight continuations in a row. A 2xx HTTP answer with a JSON body is read as a command hook's output. https://code.claude.com/docs/en/hooks. Checked 2026-10-20.
- Claude Code scheduled tasks: `CronCreate` takes a cron expression and whether it recurs or fires once, `ScheduleWakeup` is the self-paced loop's wake-up, and cron times are local time. https://code.claude.com/docs/en/scheduled-tasks. Checked 2026-10-20.
