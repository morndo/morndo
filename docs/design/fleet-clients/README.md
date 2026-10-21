# Fleet clients: one way into the lanes, for Morndo and everything around it (design v3, 2026-10-08)

**Phase: design only.** This document and [ADR-0014](../../adr/0014-fleet-clients-delivery-queue-and-lane-events.md). No app code yet.

**v2** folds in an adversarial review of v1 against the code and the owner's PC, the same day: four blocking findings and several smaller ones, each checked against the code before it was accepted. **v3** folds in the same reviewer's re-check of v2: two blocking findings and six smaller ones. Section 16 lists what changed.

**Scope:** sub-project 2 of 4 of the fleet ([fleet core](../fleet-core/README.md), section 0):

| # | Sub-project | Spec |
|---|---|---|
| 1 | Fleet core: node agent, protocol, fleet service, the hub on fleet ports | [`fleet-core`](../fleet-core/README.md), live on the owner's PC since 2026-10-08 |
| 2 | Clients: the hub, kira, the `lanes` command and the manager's scripts go through the fleet | this document |
| 3 | Roles and install: `morndo setup`, units, hook entries, topology | separate |
| 4 | Cutover: the control plane to `cp.example` on a rented server; the PC becomes a node | separate runbook |

**The owner's choices (2026-10-08), each over the alternatives offered:**
- Morndo will be open source and must work for many people on modest machines (a laptop, a small VPS, an HDD, WSL), without anything specific to the owner's setup.
- Morndo ships its own lanes command and a documented client API. kira stays the owner's own Telegram bot, the first client of that API from outside Morndo. The manager's scripts become clients.
- Messages to a lane, the manager above all, go through a **delivery queue built into Morndo** ("Built-in queue"), over keeping kira's manager inbox or typing directly.
- **One spec for all of it** (the client side and moving the owner's setup), over two parts.
- The owner's `lanes` command **keeps its name and its extras** and runs on Morndo underneath.
- The queue lives **in each node agent** (option A), over the fleet service or the hub.

## 1. What we looked at first

Read on 2026-10-08, read-only, on the owner's PC (WSL2) and in this repo at `849759c`.

- **The `lanes` command** (`~/.local/bin/lanes`, bash, 415 lines) reads `~/.claude/sessions/*.json`, the transcripts and `tmux list-panes` directly. It lists lanes (`--json`, `--lite`), peeks, starts (a tmux window, then `claude-as <account>`, the account picked by `claude-pool`, and the folder-trust dialog accepted for known folders), moves a lane to another account (`claude-pool move`), sends (paste, Enter, Enter again while the text is still in the box), sends keys, stops (refusing the manager), and carries the owner's own commands: `pause`, `ledger`, `watch-pr`, `push`, `usage`, `screenshot`, `notify` and `sendfile` (the last two to kira on 127.0.0.1:8787).
- **kira** (the chat bot, outside this tree): the Telegram bot. It receives every hook on 127.0.0.1:8787 (`/cc`, `/sl`, `/hook/stop`, `/hook/failure`, `/notify`, `/file`), reads lanes with `lanes --json`, types into lanes with tmux (`load-buffer`, `paste-buffer`, `send-keys`, `capture-pane`) and into the manager under a pane lock, calls `lanes start|stop|screenshot`, can restore lanes after a reboot, and writes the manager's lane events to a local events file:
  - `finished` from the Stop hook (`status` from a first line matched by `/^[\W_]*STATUS[\W_]*:?[\W_]*(DONE|BLOCKED|NEEDS DECISION)\b/i`, `firstLine`, `bg`, `crons`);
  - `needs_input` when the session's `status` turns `waiting` (any menu: a question, a permission prompt, a usage-limit dialog), with the question read from the screen;
  - `answered` when it stops waiting;
  - `stop_failure` from the StopFailure hook.
  The manager's own lane emits none.
- **The manager's inbox** (`manager-inbox.service`, outside this tree): one queue for the manager's terminal; its deliverer types each message once under the pane lock, never into a menu or over someone's text, and counts it delivered only when the manager's transcript has it. Its receipt rules (`transcript.ts`, from Claude Code's transcripts, undocumented, checked on 2.1.288):
  - a prompt taken at the box: `{"type":"user", …, "promptSource":"typed"|"queued"}`;
  - a line typed while Claude was busy: `queue-operation` `enqueue` (held), then a `queued_command` attachment or a `remove` (taken off the queue, `cleared_on_cancel` when an interrupt dropped it);
  - a pasted text that comes back wrapped in `<pasted_content …>` or as `[Pasted text #N +K lines]`;
  - several queued lines merged into one prompt.

  Seen again on 2026-10-08 in the PC's transcripts of the last two days (Claude Code 2.1.293, all lanes):
  - a line typed while Claude was busy is `queue-operation` `enqueue` with its text;
  - taken as the next prompt, it is a `dequeue` with **no text**, then the `user` prompt itself (with `promptSource`);
  - taken into the running turn, it is a `remove` with reason `absorbed_mid_turn` and its text (205 times), then the attachment that carries it (`queued_command`); the hub already reads these as messages since PR #5 ("absorbed sends");
  - `remove` also comes with `delivered_to_agent` (twice);
  - `cleared_on_cancel` didn't occur in those two days.
- **`lane-events-push`** (Python, 256 lines) follows `events.jsonl` and types batches of them into the manager every 3 s, under the same lock, as one message with the header `[lane-event] Lane events from kira (handle them as the Dispatching work section says):` and one JSON line per event. It skips `answered` and the account-pool test lanes.
- **PR #29 on main** (ADR-0010 rebuilt, 2026-10-09; it replaced the open PR #10): the hub writes the manager's answers into that inbox's files on disk, behind `MORNDO_MANAGER_INBOX`, a contract that only works on one machine. Not live on the PC: no `MORNDO_MANAGER_INBOX` there. Its domain rules stand: an answer counts as given once queued (E8) and is recorded once it reached the manager (E13); the card says "Queued, it will be delivered".
- **Open PR #18:** the hub runs `lanes --json` locally to tell when an engine lane (no transcript) is working.
- **The fleet today** ([fleet core](../fleet-core/README.md), §5): typed ops, among them `pane.send` with two-phase done keys (only `started` synced to the disk, §16.4), `lane.start` and `lane.stop` (off in the PC's policy), and `inventory.get`; the hook relay on each node (§5.5); the hook bus with an outbox and at-least-once delivery to static subscribers (§5.6); the client API on a Unix socket (`/v1/nodes`, `/v1/lanes`, `/v1/op`, `/v1/events`, `/v1/files`, `/v1/alerts`). The fleet already commits the hook events that arrive in one event-loop turn together (`agent-session.ts`, `ev.hook`), each batch with one `FULL` sync.
- **`lane.start`** runs `claude`, or `claude-as <account>` when an account is given, as the pane's own command (`lane-ops.ts`): the owner's launcher, inside Morndo. `claude-pool` refuses to move a lane whose pane has no shell under Claude (`claude-pool:673-677`), so such a lane loses account failover; `lanes start` and kira's restore type the launcher into a shell instead.
- **The hook bus** delivers per stream and subscriber in order, one request in flight, retrying 408, 429 and 5xx with backoff up to 20 times (`delivery.ts`): one event a subscriber keeps refusing holds up every later event of that stream for up to about 2 hours. kira answers `/notify` and `/file` with 503 while Telegram blocks it (`kira.ts:1193-1194`), and 500 on a throw. Each delivered event is marked with a `FULL`-synced commit before the next is sent (`outbox-store.ts`).
- **The lane registry** drops a name while no window claims it (`lane-registry.ts`), so a lane name can't be routed while its window is gone, during a manager restart for one.
- **Session state:** the node reads `~/.claude/sessions/*.json` for pane → session (`packages/node-ops` `sessions.ts`), but not its `status` (`busy`, `idle`, `waiting`, and `lanes` adds `shell` for a pane back at its shell), which `lanes` shows, kira's Overview uses and `claude-pool` reads with each lane's `pid` (`claude-pool:538,646`). The file is Claude Code's own, undocumented; the hub already depends on it.
- **Claude Code hooks** (https://code.claude.com/docs/en/hooks, read 2026-10-08):
  - every hook gets `session_id`, `transcript_path`, `cwd`, `hook_event_name`;
  - `PreToolUse` "fires for every tool call", AskUserQuestion included, with `tool_name`, `tool_input`, `tool_use_id`;
  - Stop carries `last_assistant_message`, `background_tasks`, `session_crons`;
  - StopFailure exists, with `error_type`;
  - an HTTP hook's non-2xx answer or timeout is a non-blocking error;
  - hook changes in settings files "are normally picked up automatically by the file watcher".
- **Load on the PC** (2026-10-08): about 8 blocking hooks a minute across all lanes on average, 38 at the busiest minute, plus about 13 status-line posts a minute; with the agent on `synchronous=NORMAL`, a hook is answered in 1.7–1.8 ms (p50) and reaches a subscriber in 0.65–2.5 s (p95) on the WSL disk on an HDD, the tail being the fleet's own `FULL` commits (issue #21).

## 2. Goals

- Every Morndo program and every client named here reaches a lane through the fleet: the hub, `morndo lanes` (and the owner's `lanes` on top of it), kira, the manager's helpers. Left local by design: the owner's `claude-pool` (account moves and usage probes act inside one machine's lanes), his monitors (`lane-watchdog`, `box-health`) and the manager's timers, which reach the manager's pane or transcripts as a fallback, the status line, and the hook scripts, which run inside a lane's own pane.
- A message to a lane is delivered once, when the lane can take it, and confirmed from the lane's conversation, whoever sends it.
- Lane events ("finished", "needs input", "answered", "stop failure") are a Morndo feature, available to every client and delivered to the manager.
- The client API is documented with examples that run as tests, and a client library ships for TypeScript.
- Nothing in Morndo is specific to the owner: his account launcher, Telegram, ledger and PR watcher plug in from outside.
- The owner's PC keeps working throughout, with no regression, and kira keeps all its behaviour.

**Not goals** (section 14): lanes on a machine without the fleet reaching it (sub-project 4), hook installation (sub-project 3), notifications for users without kira, a staggered restore after a reboot, engine lanes (PR #13, #18).

## 3. Components

| Unit | Changes |
|---|---|
| `apps/node-agent` | the **delivery queue** (§4); ops `lane.deliver`, `delivery.cancel`; event `ev.delivery`; the **launcher** and a lane started from a shell (§5); `lane.stop` that exits gracefully (§5); `pane.capture` with more lines and the screen's attributes, and `pane.keys` by key name (§5); each pane's session `status` and `pid` in the inventory, and **lane state events** from them (§5, §7) |
| `apps/fleet` | routes deliveries, keeps their latest state and the last node of each **sticky** lane name (§4.6); **lane events** (§7); the hook bus's **subscriber contract** and its commits by the fleet core's §16.4 rule (§6); client API additions (§8) |
| `packages/protocol` | the new ops, events, client routes and their schemas |
| `packages/node-ops` | the **transcript receipt**: the manager inbox's rules for "Claude Code has this prompt", ported with their cases (§4.3) |
| `packages/fleet-client` (new) | the TypeScript client of the API, moved out of `apps/hub/src/adapters/fleet-client.ts`; used by the hub and `morndo lanes`, importable by kira |
| `docs/fleet-api.md` (new) | the client API reference, the subscriber contract and the hook bodies; every example request and answer in it runs as a test (§12) |
| `apps/hub` | answers and messages for the manager through the queue, with ADR-0010's domain rules (§9.1); the console gains `morndo lanes` (§9.2) |
| `apps/web` | the manager's "Queued, it will be delivered", "Delivered" and "May have been delivered" states (on #29's decision cards, which are reused) |
| outside Morndo | kira (its repo), the owner's `lanes` wrapper, `manager-inbox` (a shim, then retired), `lane-events-push` (retired) (§9.3 to §9.5) |

## 4. The delivery queue

### 4.1 A delivery

`{ id, target, text, ttlMs? }`, sent by a client.
- **`id`** is chosen by the client, namespaced like keys (`hub:…`, `kira:…`, `lanes:…`), at most 200 characters, and is also the done key its typing runs under (§4.3). The same id with the same target and text is the same delivery: the answer is its current state, and nothing is queued again. The same id with other content is refused `id_conflict` (not executed).
- **`target`** is one of three:
  - **A sticky lane name** (the fleet's `stickyLanes`, default `["manager"]`) follows the lane wherever its node runs it: a manager restarted in a new pane and a new session still gets it, and the fleet routes the name to the node that last had it while its window is gone (§4.6).
  - **Any other lane name** is bound, when queued, to that lane's current session: if the lane's session changes (the lane was stopped and a new one took its name), the delivery is given up (`gone`), never typed into another conversation.
  - **A worker id** is bound to that pane: gone, the delivery is given up.

  A name that two windows claim is refused `lane_conflict`.
- **`text`** is at most 100,000 characters (`LIMITS.maxMessageText`), as for `pane.send` (ADR-0033). Over 8000 it goes only to a node whose hello says it takes it.
- **`ttlMs`** defaults to 24 hours. The node turns it into `notAfter` on its own clock when it stores the delivery: no client sends a clock time, so clocks that differ between machines (the PC ran 1.1 s behind the control plane) don't matter.
- **Only a lane with a live session takes deliveries:** Claude Code's (its session file, and its process alive) or a lane of the engine layer's (its file in the engine registry, its process alive and the foreground job of the pane; [ADR-0030](../../adr/0030-engine-lane-sessions.md)), whatever its `status` (§5). A pane without one waits (`no_session`) when it is a sticky lane (a manager mid-restart) or was started in the last 2 minutes (Claude Code still starting; measured from the pane process's own start time, so an agent restart doesn't reset it). Any other such pane (a shell) refuses the delivery `no_session` (not executed), and clients type into those directly (`pane.send`, `pane.keys`).

### 4.2 States

| State | Meaning |
|---|---|
| `queued` | stored on the node, not yet taken by the lane; with `waiting: { reason, since }` once a try found it not ready: `menu_open`, `draft_present`, `no_input_box`, `busy` (the pane lock), `no_pane` (no window yet), `no_session` (no Claude Code yet, §4.1), `earlier` (an earlier delivery to the lane goes first) |
| `typed` | typed; waiting for Claude Code to take it |
| `held` | Claude Code holds it in its own queue (typed while it was busy) |
| `delivered` | in the conversation: `{ at }`, its time on the node's clock |
| `uncertain` | typed, and neither seen taken nor seen back in the box before `notAfter`: it may or may not have reached the lane. Never typed again |
| `given_up` | `{ why }`: `expired` (queued, never typed, past `notAfter`), `cancelled`, `gone`, `refused` (a definite refusal, such as `too_large`) |

### 4.3 How the agent delivers

The agent follows the manager inbox's deliverer, rule for rule, ported with its tests (the inbox deliverer and its transcript rules, outside this tree).
- **Storing.** `lane.deliver` stores the delivery in `agent.db` in its own transaction, synced to the disk (`synced()`, fleet core §16.4): an answer of `queued` is a promise the sender may stop retrying on. Then it answers.
- **One at a time per lane,** in the order queued. A delivery typed and waiting for its receipt holds the next one back for at most 60 s (`earlier`), then the next one types, so a delivery that never gets a receipt can't block its lane.
- **Trying.** For the delivery at the head of a lane, the agent tries at once, again on each change it sees (the session's status, a hook of that session, the inventory), and at least every 5 seconds. A try:
  - is a `pane.send` under the delivery's own id as its done key, with all of its checks (the pane lock, the menu and draft checks, the expectation);
  - leaves the delivery `queued`, with its reason, on a refusal that typed nothing;
  - when the text stays in the input box after Enter (`not_submitted`), presses Enter again only while the box still shows exactly that text, as the inbox does, and never more than twice;
  - when a `started` key exists already (the agent restarted while typing), moves the delivery to `typed` without typing again.
- **Confirming,** from the transcript of the session the text was typed into (recorded at typing), with the inbox's receipt rules extended to what Claude Code writes now (§1; `packages/node-ops`). After the moment it was typed:
  - a `user` prompt with the text, or one of its wrapped and short forms, or a merged prompt that contains it, whatever its `promptSource`: `delivered`;
  - an `enqueue` with it: `held`;
  - a `dequeue`: no verdict (it carries no text); the prompt after it decides;
  - a `remove` with it and reason `absorbed_mid_turn` or `delivered_to_agent`, or a `queued_command` attachment with it: `delivered`;
  - a `remove` with it and a reason not named here: no verdict. The delivery keeps its state (`held`), the alerts of §4.5 say so, and it is never typed again;
  - a text that starts with `/` is a slash command: Claude Code records the command (`<command-name>/…</command-name>`), not a prompt with the text; that entry is its receipt. A command that starts a new session (`/clear`, `/new`) is recorded only in the new session's transcript: its receipt is the pane's session changing to a new session id after the typing;
  - a `remove` with it and reason `cleared_on_cancel`: Claude Code dropped it (an interrupt). The text is typed once more only if its line is not in the input box and the session is idle, the inbox's one retype, under its own done key `<id>#2` with its own synced `started` (the first key is `done` and would only answer its stored outcome); otherwise `uncertain`. There is never a third typing.
  Each receipt confirms one delivery, the earliest still waiting, so two deliveries of the same text need two receipts.
- **Expiring.** `queued` past `notAfter`: `given_up: expired`. `typed` or `held` past it: `uncertain`, never typed again.
- **Cancelling.** `delivery.cancel { id }` gives up a `queued` delivery; one already typed can't be cancelled (`already_typed`).
- **Keeping.** Final deliveries are kept 7 days, then pruned with the done keys.

### 4.4 Events

The agent sends `ev.delivery { id, state, … }` on every change, and after every (re)connect the state of each delivery that isn't final plus the final ones of the last hour (latest wins, like the inventory).

### 4.5 Alerts

A delivery still `queued`, `typed` or `held` after 2, 15 and 60 minutes raises a fleet alert, once each (`delivery_waiting`, with its state and reason). The hub shows the fleet's alerts in the app, on the desktop's Activity and the phone's Status, and pushes the urgent ones, counts only (the owner, 2026-10-12: kira is one owner's bot, so the open-source app shows them itself). kira may post them too (§9.4).

### 4.6 The fleet's part

The fleet:
- routes `lane.deliver` and `delivery.cancel` to the node;
- keeps the latest state of each delivery from `ev.delivery` in `fleet.db` (`deliveries`: id, node, target, state, reason, timestamps; never the text);
- answers `GET /v1/deliveries/<id>` and `GET /v1/deliveries?lane=&state=` from that table, marked `stale` while the node is offline;
- publishes each change on `/v1/events`.

It also remembers the node that last had each sticky lane name (`sticky_lanes`, `fleet.db`). While that name's window is gone, a delivery to it still goes to that node, where it waits (`no_pane`). While the node is offline, a new delivery is refused `node_offline` (not executed): nothing is queued that can't be stored where it will be typed.

## 5. Starting, stopping, reading and keying lanes

- **The launcher** is a node setting (`policy.json`), no longer code: `launch: { command: string[], via: "shell" | "direct" }`, default `{ command: ["claude"], via: "shell" }`.
  - `{account}` in the command is replaced by the op's `account`. A command without `{account}` refuses an op that names one (`bad_args`); a command with it refuses an op that names none.
  - `resume` adds `--resume <session>`.
  - `via: "shell"` starts the window with the user's shell, waits for its prompt (as `lanes start` does), then pastes the command as a literal and presses Enter: the window outlives Claude Code, and `claude-pool` can move the lane. (`pane.send` can't do it: at a shell it refuses `no_input_box`, which is right for everyone else.)
  - The owner's PC: `{ command: ["claude-as", "{account}"], via: "shell" }`; his `lanes` passes `claude-pool`'s pick, or `auto`.
- **Folder trust.** A lane started in a folder Claude Code doesn't trust yet waits at its trust dialog: `lane.start` answers `{ workerId, waiting: "trust" }` when it sees it. Accepting it stays the client's decision: the owner's `lanes` asks `claude-pool accept-trust` for his known folders, then sends the keys.
- **A first prompt.** `lane.start` takes `prompt?`: it becomes a delivery to the new pane (id `<key>:prompt`), which waits for Claude Code to start (`no_session`, §4.1) and is typed once it can take it. So `lanes start … PROMPT` and kira's `/new` don't race Claude Code's startup.
- **Stopping.** `lane.stop { name, mode? }`:
  - `mode: "exit"`, the default, types `/exit` the way a delivery is typed (never into a menu or over text), answers Claude Code's exit prompt when it asks ("Exit and stop tasks": 1, as `claude-pool` does), then answers once the window has closed or is back at its shell, or `uncertain` after 30 s;
  - `mode: "kill"` closes the window.

  The policy's `protected` names (default `["manager"]`) are refused `denied`.
- **Reading.** `pane.capture { workerId, lines (≤ 2000), attributes? }` returns up to 256 KiB (one bulk chunk): the screen's last lines, with tmux's attribute escapes when asked (kira reads dim text that way). The existing `pane.captureMany` keeps its 6 KiB per pane.
- **Keys by name.** `pane.keys` also takes `names` (tmux key names on an allow-list: `Enter`, `Escape`, `Tab`, `BSpace`, `Up`, `Down`, `Left`, `Right`, `Home`, `End`, `PageUp`, `PageDown`, `C-c`, `C-d`, `C-u`, `Space`, the digits and letters), besides `data` (literal text).
- **Session state** joins each pane in the inventory:
  - `status`, the session file's own value as Claude Code writes it (seen on 2.1.293: `busy`, `idle`, `waiting`, and `shell` while Claude Code runs a shell command), `null` without a live session;
  - `pid`, the session's process (Claude Code's);
  - `topic` and `lastPrompt`, the session's latest `ai-title` and `last-prompt` entries, kept from the agent's transcript reads. kira shows them in the Overview and the Mini App (`kira.ts:520`, `app/index.html:98`), where `lanes` gives them today. Engine lanes have no session file, so their state needs their own report (PR #13, #18); this design doesn't provide it.
- `lane.start` and `lane.stop` go on in the PC's policy (they are off today).

## 6. Hooks through the fleet

- **The relay takes port 8787.** On the owner's PC kira moves to 127.0.0.1:8786, and the fleet delivers every hook path to kira as a subscriber (`subscribers: [{ name: "kira", url: "http://127.0.0.1:8786/fleet/hook", paths: [all six] }]`). The lanes' hook entries keep pointing at 8787, so no lane restarts; Claude Code picks up hook changes by itself anyway. During the swap hooks fail for a few seconds: a non-blocking error for the lane, and the Stop script's direct-message fallback (`lanes notify`) for a turn's end.
- **The subscriber contract** (`docs/fleet-api.md`): a subscriber answers 2xx once it has the event, and never refuses one for a reason of its own downstream (Telegram blocked, a failed handler). It keeps what it can't act on yet and acts later. The bus delivers each stream in order, one event in flight, so a refused event holds up the ones behind it. The fleet raises `subscriber_lagging` when a subscriber's oldest undelivered event is older than 60 s.
- **Identity.** The relay adds the node, and the window it finds through `TMUX_PANE` or the session id; when it finds none (a `lanes notify` from outside a pane), it takes the body's own `window`.
- **Hook bodies.** The relay accepts Claude Code's own hook JSON on every path. For compatibility it also accepts the bodies of the owner's Stop and StopFailure scripts (Stop `{ window, cwd, session_id, branch, changed, ahead, text, background, crons }`, StopFailure `{ window, session_id, error }`) and `lanes notify` and `sendfile` bodies on `/notify` and `/file`. All are documented in `docs/fleet-api.md`. Lane events (§7) read either form: the text from `last_assistant_message` or `text`; the counts from `background_tasks`/`session_crons` or `background`/`crons`; the error from `error_type` (Claude Code's field) or `error`.
- **The fleet's commits, by the fleet core's §16.4 rule** (issue #21). A commit is synced to the disk only when what it guards must outlive the machine:
  - **Synced:** the intake that precedes acknowledging events to a node (the node then deletes its copy), lane events included; a join, a revocation, a node's key; a node's connection epoch (a reused epoch after a power loss could let a stale result count as current).
  - **Not synced** (`NORMAL`): delivered marks, the subscribers' and the manager's (a lost mark means one more delivery, which the receiver skips by its key or id); the deliveries' table; the audit; alerts.

  Events that arrive within 25 ms share one intake commit, and `fleet.db` gets `fullfsync` on macOS.
- **Gate for the swap,** measured with `scripts/bench-relay.ts` on the PC's HDD at 2 hooks a second: a hook reaches a subscriber within 1 s at p95, and no client op through the fleet takes over 2 s while hooks flow. If that isn't met, the intake commits move to a worker thread (better-sqlite3 in `worker_threads`), so the fleet's event loop never waits for a sync.

## 7. Lane events

**Built by the fleet,** per node and window, from two sources: the session state each node reports (§5), and the hook stream.

| Event | From | Fields |
|---|---|---|
| `finished` | `/hook/stop` | `status`: `done`, `blocked` or `needs_decision` from a first line matched by `/^[\W_]*STATUS[\W_]*:?[\W_]*(DONE\|BLOCKED\|NEEDS DECISION)\b/i` (kira's rule), else `null`; `firstLine`; `bg` (background tasks); `crons` (scheduled wake-ups) |
| `needs_input` | the session's `status` turns `waiting` (any menu: a question, a permission prompt, a usage-limit dialog); the node reads the menu's question from the screen with kira's menu parser, ported to `packages/node-ops` (`kira.ts` `parseMenu`) | `question`: the last line ending in "?", else the line above the options, at most 200 characters (kira's rule) |
| `answered` | the session's `status` leaves `waiting` | none |
| `stop_failure` | `/hook/failure` | `error` |

The node sends the two that come from its session state through its durable hook stream (the spool), as `lane` events with a `seq`, so they are kept and replayed like hooks. The fleet writes every lane event in the same synced intake transaction as the hooks, with a mark of whether it has been delivered to the manager yet: after a restart it sends what isn't marked. A lane-event delivery to the manager that is given up is queued again in the next batch.
- **Shape:** each is `{ v: 1, t: "lane", event, node, window, lane, sessionId?, at, … }`.
- **Published:** on `/v1/events`, and kept in `fleet.db` for 7 days (`GET /v1/lane-events?since=`).
- **Delivered to the manager,** following `lane-events-push`, from the fleet's config (`laneEvents`):
  - batched for 3 s and sent as one delivery to the lane `deliverTo` (default `"manager"`; `null` turns it off);
  - one JSON line per event in today's shape (`{ ts, lane, sessionId, event, status, firstLine, bg, crons }`), after the header line `header` (default `[lane-event] Lane events (handle them as your instructions say):`; the owner's PC keeps today's, `[lane-event] Lane events from kira (handle them as the Dispatching work section says):`, so the manager's instructions stay as they are);
  - `answered` is published but not delivered, as today;
  - the delivery id is `fleet:lane-events:<node>:<first event's time>`.
- **Not sent:** the manager's own lane emits none; lanes matching `laneEvents.ignore` (globs; the owner's: `pooltest*`, `pool-probe*`) emit none.

## 8. The client API

New routes (version 1; `GET /v1/caps` answers the API versions and the sticky lane names):
- `POST /v1/deliveries { id, lane | workerId, text, ttlMs? }` → the delivery's state;
- `GET /v1/deliveries/<id>`, `GET /v1/deliveries?lane=&state=`;
- `POST /v1/deliveries/<id>/cancel`;
- `GET /v1/lane-events?since=`;
- `delivery` and `lane` messages on `/v1/events`;
- `lane.start`, `lane.stop`, `pane.capture` and `pane.keys` through `POST /v1/op`, as now.

Clients name themselves (`x-morndo-client`, a-z, at most 16 characters: `hub`, `lanes`, `kira`, `fleet` …) and namespace their ids and keys the same way. The fleet audits every delivery and its outcome (never the text), every lane start and stop, and every key press (never the keys).

`docs/fleet-api.md` documents the socket, the version rules, every route, op, event, error code, the subscriber contract and the hook bodies, each with an example request and answer that a test runs against a real fleet. `packages/fleet-client` is the hub's client moved out, with deliveries added.

## 9. The clients

### 9.1 The hub

- A Decision for the manager and a Command to the manager become deliveries, with ADR-0010's domain rules:
  - the delivery id is the key the hub types under today (`hub:answer:<escalation>:<ask>:<choice>`, `hub:<endpoint>:<request>`), so a repeat is the same delivery, and the switch below never types one twice;
  - queued, the answer counts as given (E8), and the card says "Queued, it will be delivered", with the reason while it waits;
  - `delivered`: it is recorded (`EscalationAnswered`, E13, at its time);
  - `uncertain`: the card says "May have been delivered", like a send in doubt today, and the ask is not opened again;
  - `given_up` (`expired`, `cancelled`, `gone`): nothing reached the manager, so the ask opens again.
- A Command to the manager waits in the queue for up to 24 hours (`ttlMs`), its card showing why it waits, and can be cancelled. #29's two-minute deadline and Retry go (the owner, 2026-10-09).
- Commands to other lanes stay typed directly (`pane.send`), as today.
- **The switch:** `MORNDO_MANAGER_QUEUE`, on by default when the hub has a fleet; `off` types to the manager directly, as before (step 2's rollback, §13). Because the delivery's id and the direct send's key are one key, a direct retry after the switch finds the delivery's key (`done`: a duplicate, already typed; `started`: in doubt) and never types again. A delivery still queued when the switch goes off is cancelled first.
- **Without a fleet** (legacy mode), the hub types to the manager directly, as before.
- **The manager is always on the list** (the owner, 2026-10-12). While it has no window (a restart), the app lists it as not running. With the queue on, a message written to it goes to `POST /api/manager/send`, which queues it for the sticky lane `manager` (§4.1): it waits on the node that last had it and goes in once a window of that name is back. With the queue off, or without a fleet, nothing can hold it, so the app says to start the manager. Files go onto its machine, so none while it isn't running.

### 9.2 `morndo lanes`

A subcommand of the `morndo` console, for any user, over the fleet socket (`MORNDO_FLEET_SOCKET`, default `~/.local/state/morndo-fleet/fleet.sock`):

| Command | What |
|---|---|
| `morndo lanes [--json]` | every lane: name, node, worker id, window, session status, pid, folder, title |
| `morndo lanes peek <lane> [--lines N]` | its screen's last lines (default 40) |
| `morndo lanes send <lane> <text \| ->` | a delivery (`--id` to choose it); waits for `delivered` up to `--wait <s>` (default 0: print the state and return); `--direct` types at once (`pane.send`), for a lane without Claude Code |
| `morndo lanes keys <lane> <key…>` | `pane.keys` by key name |
| `morndo lanes start <name> --cwd <dir> [--account <a>] [--resume <session>] [--prompt <text>]` | `lane.start`, with a first prompt typed once the lane can take it |
| `morndo lanes stop <lane> [--kill]` | `lane.stop` |
| `morndo lanes status <delivery id>` | a delivery's state |
| `morndo lanes events` | lane events as they happen |

Exit codes:

| Code | Meaning |
|---|---|
| 0 | accepted: for `send`, queued, typed, held or delivered; with `--wait`, delivered |
| 3 | with `--wait`, not delivered in time |
| 4 | given up, refused, or uncertain |
| 5 | in doubt: the fleet was reached and didn't answer; the same `--id` may be sent again, and is never typed twice |
| 69 (EX_UNAVAILABLE) | the fleet couldn't be reached: nothing was queued |
| 2 | bad arguments |

### 9.3 The owner's `lanes`

- `~/.local/bin/lanes` keeps its name and its own commands: `pause`, `ledger`, `watch-pr`, `push`, `usage`, `screenshot`, `notify`, `sendfile`, `move`.
- It passes list, peek, send, keys, start and stop to `morndo lanes`.
- Its JSON keeps the fields its callers read. It maps Morndo's fields onto them (`status`, `pid`, `window`, `cwd`, `sessionId`) and adds what it computes itself (git branch, account).
- `--lite`, `claude-pool`'s guard, stays a local read of this machine's sessions, as `claude-pool` itself is local.
- `start --account` still asks `claude-pool pick`. `send` to a lane without Claude Code uses `--direct`.

### 9.4 kira

kira keeps every behaviour: Telegram topics, cards and buttons, the Mini App, screenshots, the Overview, its quiet rules and alerts. Underneath:
- **Hooks** come from the fleet, as a subscriber on 127.0.0.1:8786.
  - Each is one `HookEvent` with its node and window; kira skips duplicates by its `Idempotency-Key`, kept for a day.
  - It keeps the subscriber contract: 2xx once it has the event. It keeps its own queue for Telegram blocks and handler failures, on disk, so a restart of kira loses nothing it has answered 2xx to.
  - `/notify` and `/file` arrive the same way; a file's bytes come from `GET /v1/files/<node>/<ref>`.
  - **For the swap,** kira takes hooks both ways (its old port and the fleet's) in the version deployed first (§13, step 3).
- **Lanes:** `lanes --json`, now on the fleet.
- **Screens:** `pane.capture` (its 60 and 200 lines, with attributes).
- **Typing:**
  - to the manager, through deliveries (its taps and messages), with their states behind its 👀 and its "not sent because" notes;
  - to other lanes, through `lanes send` (`--direct` where there is no Claude Code) and `lanes keys` by name.
  - No more tmux calls and no more `manager-pane.lock`.
- **Stopping and restoring:** `lanes stop` and `lanes start --resume` (restore, when it is switched back on).
- **Alerts:** it follows `/v1/events` and posts the fleet's alerts (§4.5, §6) to the owner's Overview topic.
- The manager's events come from the fleet (§7). kira keeps writing its `events.jsonl`, now from the fleet's lane events (read with a stored cursor, `GET /v1/lane-events?since=`, so a restart or an outage loses none) and in today's format, for the owner's local readers of it: `claude-pool` (account failover) and the manager's `lane-watchdog`. These changes are made in kira's repository on the PC, with its tests.

### 9.5 The manager's helpers

- **`lane-events-push` is retired** once the fleet delivers lane events (§7, step 3).
- **`manager-inbox`** stops taking messages once kira and the hub use deliveries. Its deliverer keeps running until its queue is empty, then is retired. The `manager-inbox` command stays as a thin shim for any caller left:
  - `enqueue` → a delivery to the manager with id `inbox:<sender>:<id>`;
  - `status` and `ls` → `/v1/deliveries`.
- **#29's inbox path is removed with §9.1** (the owner, 2026-10-09). That covers the adapter, `MORNDO_MANAGER_INBOX`, the services' inbox branches, the outbox's inbox fields and `e2e/inbox`. Its domain functions, store helpers and decision cards stay, with the queue's states. Its table `pending_answers` (migration 15) stays, unused.

## 10. Failures

| Failure | What happens | Seen by the owner |
|---|---|---|
| Fleet down | queued deliveries keep being tried and confirmed on their nodes; new ones are refused (the hub leaves the answer open; `morndo lanes` exits 69); hooks wait in each node's spool and replay | "Fleet unavailable" banner |
| Node offline | deliveries to its lanes are refused `node_offline`, never queued elsewhere; its queued ones wait on the node | offline marker |
| Agent restarts while typing | the `started` key (synced) moves the delivery to `typed`: never typed twice | "typed, waiting for the conversation" |
| Agent restarts otherwise | the queue is in `agent.db`; trying resumes | none |
| The manager window missing (a restart) | deliveries to it wait on its node (`no_pane`), routed there by the sticky name | alerts after 2, 15, 60 minutes |
| A menu or a draft in the box | the delivery waits with that reason, never typed over it | the reason on the card |
| Claude Code drops a queued line (an interrupt) | typed once more only when the box is clear and the session idle (the inbox's rule); else `uncertain` | "May have been delivered" |
| A delivery never seen taken before `notAfter` | queued: `given_up`, the ask opens again; typed or held: `uncertain`, never typed again | the card says which |
| kira down, or refusing | the bus retries with backoff; at least once; kira skips duplicates; `subscriber_lagging` after 60 s | late posts, an alert |
| The hook swap (§6) | a few seconds of failed hooks: non-blocking for the lanes; the Stop script falls back to a direct message | maybe one direct message |
| A power loss on the node | queued deliveries survive (synced at storing); `typed` and `held` ones keep their state | none |
| The disk fails while the node runs | storing a delivery or a `started` key fails: nothing is queued or typed, the sender is told | an error, never a silent loss |

## 11. Security

- **Side effects are audited and keyed,** as `pane.send` is:
  - deliveries, lane starts and stops, key presses;
  - the audit records the client, the target and the outcome, never the text or the keys.
- **The launcher is the node owner's setting.** An op can't add arguments: it only fills `{account}` and `--resume`, whose formats are fixed (fleet core §5.3). Key names come from an allow-list.
- **Client names are not credentials.** The socket's 0700 directory is the boundary, as before (fleet core §5.6, §8).

## 12. Testing

All against isolated resources, never the owner's running system (repo rule).

| Level | What | Negative control |
|---|---|---|
| Unit | delivery states and transitions; the same id twice, other content under one id; `notAfter` (`given_up` vs `uncertain`); the launcher template; the transcript receipt with every kind the inbox handles and every kind seen on 2.1.293 (a `user` prompt of each `promptSource`, `enqueue`, `dequeue` without text, `remove` with `absorbed_mid_turn`, `delivered_to_agent`, `cleared_on_cancel` and an unknown reason, `queued_command`, pasted wrapper and short form, merged lines), each from a recorded transcript, the inbox's tests ported; lane events from recorded hook bodies (both forms) and status sequences; the STATUS rule's variants; the subscriber contract's classification | an id conflict accepted; a wrapped echo missed; a `cleared_on_cancel` counted as delivered; a `dequeue` taken as a receipt |
| Contract | every example in `docs/fleet-api.md` runs against a real fleet | an altered example answer |
| Drills (test/fleet, real processes, isolated tmux, the fake input box writing a transcript in Claude Code's shapes) | a delivery waits through a menu and a draft, then types once; Enter again only on its own stuck line; the agent killed while typing never types twice; `delivered` only on a receipt; a delivery to "manager" waits through a manager restart and goes to the new pane; a delivery to another name whose session changed is given up; the manager gets lane events in batches, and the ones not yet delivered after a fleet restart are sent then; a subscriber that answers 503 holds its stream, raises `subscriber_lagging`, and loses nothing; `lane.start` via the shell leaves a shell under the lane, and its first prompt is typed once the lane can take it; a dropped line (`cleared_on_cancel`) is typed once more, and never a third time | without the `started` check, the restarted agent types again; without the session binding, a message lands in the new lane; the retype under the first key types nothing |
| Benchmark gate | `scripts/bench-relay.ts` on the PC's HDD meets §6's gate before the hook swap | none |
| e2e | `morndo lanes` against a real fleet; the web app's Queued, Delivered and May-have-been-delivered states for the manager | none |
| Manual QA (repo rule) | each rollout step on the live PC with a scratch lane, as in a private QA record, not in this tree; kira's Telegram behaviour with the owner's go-ahead, on a scratch topic | none |

## 13. Rollout on the owner's PC

One spec, deployed in steps. Each is checked live and has a written rollback in the PC's backup folder before it starts. Issue #20 (answers older than 7 days forgotten at a hub restart) lands before step 1, since every step restarts the hub.

| Step | What | Rollback |
|---|---|---|
| 1. The new code, nothing switched | before it, the three databases are copied with the services stopped (hub, `fleet.db`, `agent.db`); then hub, fleet and agent on the new commit, which migrates them; the policy gets `launch`, `protected` and the new ops; the fleet gets `stickyLanes` | the previous commit **and** the three copies: each database refuses an older program once migrated. Sends in doubt from after step 1 then read `unknown` from an older store and stay uncertain (fleet core §7) |
| 2. The hub's manager answers through the queue | `MORNDO_MANAGER_QUEUE` on; `lane-events-push` and kira unchanged | `MORNDO_MANAGER_QUEUE=off` (queued deliveries cancelled first, §9.1) |
| 3. Hooks and lane events through the fleet, once §6's gate is met | 3a kira's version that takes hooks both ways, on 8787 and from the fleet on 8786. 3b the fleet's subscriber `kira` and lane events on (`laneEvents.deliverTo: "manager"`), `lane-events-push` stopped, the relay moved to 8787 and kira's old listener off it | 3b back: the relay to 8789, kira's old listener on 8787, `deliverTo: null`, the subscriber removed, `lane-events-push`'s offset set to the end of the events file, then `lane-events-push` started (else it replays everything kira wrote meanwhile); 3a back: kira's previous commit |
| 4. kira and `lanes` on the fleet | kira types, captures, stops and restores through the fleet; the owner's `lanes` wrapper | kira's previous commit; `lanes` from its backup |
| 5. `manager-inbox` retired | once its queue is empty; its command becomes the shim | the service started again, the shim swapped back |

Steps 3 and 4 run on a weekday morning (05:00 to 10:00 is the quietest, from 8 days of lane activity) with the owner reachable.

## 14. Out of scope, and where it goes

| Later | Why not now |
|---|---|
| `morndo lanes` on a machine without the fleet (a lane on a node asking about other lanes, after the cutover) | it needs the node agent to relay client calls, and a policy for what a lane may do to lanes on other machines: sub-project 4, with the cutover that first needs it |
| Installing hook entries, units and policies; Morndo's own Stop and StopFailure hook commands | sub-project 3 (`morndo setup`); until then the owner's scripts' bodies are accepted for compatibility (§6) |
| Several Claude Code config directories per node | the owner's accounts link their sessions into one `~/.claude`; a node setting for more is for when another user needs it |
| Notifications without kira | the hub's push and Activity already cover "needs you"; lane events make more possible later |
| A staggered restore after a reboot | fleet core §11; kira's restore stays off until then, as the owner left it on 2026-10-06 |
| Engine lanes | PR #13 and #18 (their own design), on the session state of §5 |

## 15. Done criteria

1. Every test of §12 passes in CI, and every negative control is an entry in `scripts/negative-controls.ts` that bites.
2. On the owner's PC, after step 5:
   - kira, the hub, the core commands of `lanes` and the manager's helpers reach lanes only through the fleet: a search of their code finds no `tmux` call into a lane (send, paste, keys, capture, new or kill window) and no read of a lane's transcript. The search leaves out what §2 leaves local by design, by name;
   - the manager has received its lane events from the fleet for a day;
   - kira has run on the fleet for a day, with no regression the owner reports.
3. `docs/fleet-api.md` runs as tests; `docs/domain.md` gains Delivery, Receipt and Lane event in the Fleet context.
4. Every library, API and version is checked against primary docs and cited with URL and date (Claude Code hooks above; anything new in the plan). The transcript shapes the receipt reads are Claude Code internals: each is pinned by a recorded example, and a change shows as a failing test.
5. Manual QA evidence for each rollout step in `qa/`.

## 16. Changes from v1 (review of 2026-10-08)

1. **Confirming a delivery:**
   - it follows the manager inbox's receipt rules (held in Claude Code's queue, dropped on an interrupt, pasted wrappers, merged lines, Enter again on a stuck line), not a plain text match;
   - it reads the session the text was typed into;
   - a typed delivery never seen taken becomes `uncertain`, and the hub never opens such an ask again.
2. **The rollout order:**
   - step 2 is the hub's answers only;
   - the manager's lane events move with the hooks in step 3, since they need them;
   - kira's intake takes hooks both ways before the swap;
   - every step has its rollback.
3. **The subscriber contract** (2xx once received): the bus delivers each stream in order, so one refused event held up every later one, and kira refused while Telegram blocked it. A lagging subscriber raises an alert.
4. **Lanes started from a shell** (`via: "shell"`), so `claude-pool` can still move them.
5. **`needs_input` and `answered`** from the session's state, which covers every menu (a question, a permission prompt, a usage-limit dialog), with the question read from the screen. A subagent's question tool and a `/cc` coalesced while the fleet was offline can't fake them. `lane-events-push`'s header and skip rules and kira's STATUS rule are kept as they are.
6. **Sticky names** for the manager across restarts; other names bound to their session, so a message never reaches a new lane that took an old name.
7. **The fleet's commits:** §16.4's rule covers the delivered marks and the new tables too. The serial cost was a synced mark per delivered event.
8. **`status` and `pid` in the inventory** (`claude-pool` reads them); `--lite` stays local.
9. **For kira:** `pane.capture` with more lines and attributes, keys by name, graceful `lane.stop`, deliveries only to Claude Code lanes (`--direct` for the others).
10. **One key for a delivery and a direct send,** so `MORNDO_MANAGER_QUEUE=off` never types twice.
11. **Smaller:** the relay takes the body's `window` when it finds none; §2's scope matches §15.

### Second review round (v3, 2026-10-08)

12. **Step 1's rollback restores the three databases.** Each refuses an older program once migrated, so the previous commit alone would exit 78.
13. **The one retype after an interrupt runs under its own key** (`<id>#2`), since the first key is `done` and would only answer its stored outcome.
14. **`no_session` waits** for a sticky lane and for a pane started in the last 2 minutes, instead of refusing. `lane.start` takes a first prompt, so starting a lane with a message doesn't race Claude Code's startup. A refused lane-event batch is queued again.
15. **The launcher is pasted once the shell's prompt shows,** not typed through `pane.send`, which refuses at a shell.
16. **Lane events are durable:** they are written in the synced intake with a delivered mark, and the node's state events go through its spool.
17. **Step 3b's rollback moves `lane-events-push`'s offset to the end first,** so the manager isn't flooded with what kira wrote meanwhile.
18. **Smaller:**
    - the menu question uses kira's parser, ported (`menuIdentity` is a hash);
    - kira's own queue survives its restart;
    - `lane.stop` answers Claude Code's exit prompt;
    - §9.1 says a direct retry finds the key `done` or `started`.

### Triple-check of v3 (2026-10-08)

The spec's facts checked against the code, the owner's PC and Claude Code 2.1.293's transcripts:
19. **The receipt rules cover what Claude Code writes now:**
    - a `dequeue` (no text: no verdict);
    - `remove` with `absorbed_mid_turn` or `delivered_to_agent` (delivered);
    - an unknown `remove` reason (no verdict, never typed again).

    The inbox's rules were checked on 2.1.288 and knew neither.
20. ~~"Takes deliveries" is defined by the session's `status`; `shell` is written once Claude Code has exited.~~ **Wrong, corrected by the plan's reconciliation:** `shell` is written while Claude Code runs a shell command (seen on a live idle session). A lane takes deliveries while it has a live session, whatever its `status`.
21. **Engine lanes get no state from this design** (they have no session file). The claim that PR #18 could read it from the inventory is withdrawn.
22. **Smaller:**
    - `morndo lanes start --prompt`;
    - "the fleet core's §16.4" wherever the rule is meant;
    - the test list names the new receipt kinds.

Confirmed unchanged:
- the hub's two key formats (`steering-service.ts:86`, `escalation-service.ts:60`, `fleet-adapters.ts:49`);
- a finished key answering only its stored outcome (`executor.ts:95`);
- the 6 KiB capture cap (`LIMITS.captureBytesPerPane`);
- `pane.keys` taking text only;
- the relay's window lookup (`window-of.ts`);
- `lanes start` waiting for the shell's prompt;
- the hook facts against the hooks docs.

### From the implementation plan (2026-10-08)

23. **`ttlMs`, not `notAfter`, from clients.** The node sets `notAfter` on its own clock (plan, Review Focus 3).
24. **A slash command is confirmed by its command entry** (plan, Review Focus 1).
25. **A typed delivery waiting for its receipt holds the next one for at most 60 s,** so one that never gets a receipt can't block its lane for 24 hours (reconciliation ruling 16).
26. **`/clear` and `/new` are confirmed by the pane's session changing** (ruling 17).
27. **The start grace survives an agent restart:** it is measured from the pane process's start time (ruling 14).
28. **The inventory carries `topic` and `lastPrompt`,** which kira shows (ruling 13). `status: "shell"` is Claude Code running a shell command (ruling 11).
29. **kira keeps writing `events.jsonl`, from the fleet,** for `claude-pool` and `lane-watchdog` (ruling 31). The owner's monitors stay local by design (ruling 32).
30. **`GET /v1/caps` answers the API versions and the sticky names** (ruling 8).
31. **A client in doubt asks again under the same id,** never types the text itself and never says "not delivered". `morndo lanes` exits 5 then (plan review, ruling 49).
32. **The fleet syncs a node's connection epoch** (plan review, ruling 62).
33. **#29 (ADR-0010 rebuilt on main) gives way to the fleet's queue:** its inbox path is removed, its domain and cards are reused, and the hub migration is 16 (the plan's refresh, rulings 81–87).

