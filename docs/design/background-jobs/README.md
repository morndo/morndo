# Background jobs that report back

**Phase: building, from step 1.** This document and [ADR-0017](../../adr/0017-background-jobs-that-report-back.md). The owner accepted section 9 on 2026-10-09 (ny-318).

A job is a command one agent starts on one node, which keeps running after that agent's turn, and which reports its end once. It is a Morndo primitive: class names, limits and lane names come from config, and nothing in it is one person's inbox, machine or command.

It fits the fleet as it stands.

| Already decided | What a job uses |
|---|---|
| ADR-0012, FL14 | The command never crosses the fleet. There is still no generic exec on the fleet. |
| ADR-0014, the delivery queue | A completion aimed at a lane is one delivery, with that queue's states. |
| ADR-0014, `/v1/events` | Subscribers read a job event on the stream they already have. |
| ADR-0008 | One id, two-phase durability, `uncertain` rather than a second send. The shared redactor. |
| ADR-0015 | Agent tokens say which lane is acting. A comment does not move a task and grants nothing (B3, B8). |
| Open-source constraint (fleet clients) | Modest machines: a laptop, a small VPS, an HDD, WSL. No always-on extra daemon. |

## 1. Terms

Added to `docs/domain.md` when this ADR is accepted. The domain module holds the states, the queue order and the notice text. It imports nothing about processes, systemd or disks.

| Term | Means | Is not |
|---|---|---|
| Job | One command started on one node, with an id, a name, a class, a lane, a notify target and a state. | A lane, a pane, a board task, a cron. |
| Class | A name in the node policy with a concurrency limit. Callers pick it. Morndo ships only `default`. | A built-in kind of work ("review", "CI"). |
| Outcome | How a job ended: `exited`, `timed_out`, `cancelled`, `lost`. | A Verdict. |
| Notice | The one completion handed to whoever asked: a delivery, a board comment, or the fleet event alone. | A second run of the command. |
| Tail | The last lines of the log, redacted and cut to the delivery size, carried in the notice. | The log file, and the command line. |

| # | Invariant |
|---|---|
| J1 | A job runs only on the node where it was started, as that node's user. Its command line, working directory and log file never cross the fleet. |
| J2 | A job becomes terminal exactly once (`exited`, `timed_out`, `cancelled`, `lost`). It is never started again, including after a reboot or an agent restart. |
| J3 | A terminal job produces one notice. A lane notice is one delivery whose id is `node:job:<jobId>:done`. A task notice is one board comment keyed by the job id. A repeat finds that notice and does not create another. |
| J4 | A job whose process is gone and whose exit was never recorded becomes `lost`. The row stays, and the notice still goes out. A job is never deleted to hide a missing result. |
| J5 | A class runs at most its configured limit. Further jobs of that class stay queued, in the order they were accepted, each with a visible position. |
| J6 | A notice is redacted and at most 8000 characters before it leaves the node. Another lane sees the tail, not the log file and not the command. |
| J7 | A job grants nothing: no Mandate, Decision, Acknowledgement or Verdict, and no board status change. |

States: `queued` (with `position` and `reason`: `class`, `load`, `memory`) and `running`, then one outcome. The notice has its own state, the delivery's (`queued`, `typed`, `held`, `delivered`, `uncertain`, `given_up`) or `commented` for a task.

## 2. Interface

**Choice.** A local CLI, plus a read and cancel API on the fleet. Starting is local.

```
morndo job start --notify <target> [--name <name>] [--timeout <seconds>] [--class <name>] [--id <id>] -- <command...>
morndo job list [--json] [--state <state>]
morndo job show <id> [--json]
morndo job logs <id> [--lines N]
morndo job cancel <id>
```

The program is the node agent's. `morndo job` is the spelling agents use; a node install that has no hub binary still has the same subcommand on the node agent. The `--` is required. The command is an argument vector, never a shell string. A pipeline is the caller's explicit `sh -c`.

`--notify` is one of:

| Target | Notice |
|---|---|
| `lane:<name>` | One delivery to that lane. A sticky name (the configured manager lane included) follows ADR-0014's sticky rules. Any other name is bound to the session, as deliveries are. |
| `task:T-<n>` | One comment on that task, in the notice text. The task's status does not change. |
| `fleet` | No delivery and no comment. The fleet event is the notice. |

The fleet event is published for every target, not only `fleet`. `--notify` is required, so a job always has a recipient even when that recipient is "whoever reads the event stream."

`--class` defaults to `default`. An unknown class is refused before anything runs. `--timeout` is seconds; `0` means no limit. Omitted, the class's `timeoutSec` applies, and a class with none waits until the command exits or someone cancels it. `--name` defaults to the basename of the first argument, cut to 64 characters. `--id`, when omitted, is assigned by the node (`job:` plus 16 random hex characters).

The same id, lane, command hash, working directory, class and notify target returns the current job and starts nothing. The same id from another lane, or the same id with a different body, is `id_conflict` and starts nothing.

**How the agent learns the result.** The notice is plain text:

```
[morndo-job] <name> <outcome>
id: <id>
class: <class>
exit: <code or ->
duration: <seconds, one decimal>
log: <path, home written as ~>
---
<tail>
```

`exited` uses the process exit code. `timed_out` and `cancelled` use the signal's conventional code when the supervisor has one (`143` for SIGTERM, `137` for SIGKILL), otherwise `-`. `lost` uses `-`. A command that never began (the binary could not be invoked) is `exited` with `exit: -` and a line `error: did_not_start` before the tail.

Each log line is redacted first (section 6), including a PEM block, a lone `BEGIN` or `END` line, and a base64 key body. Control characters and ANSI escapes are removed; only a newline and a tab remain. The tail is then the last 40 of those lines, each cut to 200 characters. If the notice is still over 8000 characters, the delivery maximum (`maxSendText` in `packages/protocol`), lines are dropped from the top of the tail until it fits. A dropped tail starts with `[truncated]`.

`morndo job show` prints the same text plus the state, the queue position and reason while queued, and the notice state. `list --json` is one object per job: `id`, `name`, `class`, `state`, `position`, `reason`, `lane`, `notify`, `outcome`, `exit`, `durationSec`, `notice`. No command line.

Exit codes, in words an agent can act on, one line on stderr for a refusal:

| Code | Meaning |
|---|---|
| 0 | Accepted, or the requested view was printed. `start` of an id that already exists returns that job. |
| 1 | Refused: unknown class, `id_conflict`, not this lane's job, policy off, working directory not allowed, disk cap. Nothing was started. |
| 2 | Usage. |
| 3 | The node agent could not be reached. Nothing was started. |
| 4 | The hub refused the token, or it is unreachable and this lane has no matching token hash from the last 24 hours. Nothing was started. |

**Why this, and not the alternatives.**

| Option | Verdict |
|---|---|
| **A shell string** (`bash -lc` around the command) | Rejected. The node would be interpreting a script it did not have to, and quoting would be part of the security boundary. The caller can pass `sh` itself when it wants a shell. |
| **Start through the fleet** (`POST /v1/jobs` carrying the command) | Rejected. FL14: the fleet runs typed operations only, never a command line. |
| **A new binary with its own config** | Rejected. One node agent already survives the lane. A second always-on process is another thing to install on a small machine. |
| **Block the CLI until the command exits** | Rejected. The point is that the agent's turn ends. `show` and the notice are how it learns. |

## 3. Where a job runs, and who supervises it

**Choice.** The node agent accepts the job on a Unix socket at `~/.local/state/morndo-node/job.sock` (mode 0600). It stores the row in `agent.db`, then runs the command under whichever supervisor the probe picked. The working directory is the CLI's current directory, resolved to an absolute path, and refused when it lies under a deny root (the node agent's file rules).

**Probe, once per agent process.** `systemd-run --user --collect --wait --quiet --property=Type=exec --expand-environment=no true`. Exit 0 means the user service manager is usable: later jobs are transient units. Any failure (no systemd, no user bus, a systemd that rejects those flags) means the child supervisor. The probe unit uses `--collect`, so it does not stay loaded. systemd 255's and 256's `systemd-run(1)` document every flag in that probe; `--expand-environment=no` arrived in 254.

**systemd path.** For each job, a transient user service `morndo-job-<id>`:

- `--property=Type=exec`, so a missing binary is a failed start and not a reported success (`systemd-run(1)`: with the default `simple` type, start is reported once `fork` succeeds, before `exec`).
- `--expand-environment=no`, so a `$` in an argument is not expanded by the manager.
- `--working-directory=` the resolved directory.
- `--remain-after-exit`, so the unit stays after the process exits until the agent has read `ExecMainCode`, `ExecMainStatus` and `Result` (`systemctl show`; observed on systemd 255) and synced the terminal row. Then the agent stops the unit. `--collect` is not used on the job: it unloads the unit as soon as it finishes, including while the agent is down, and the exit would be gone.
- `StandardOutput=append:` and `StandardError=append:` to the log file (`systemd.exec(5)`).
- `RuntimeMaxSec=` when the job has a timeout (`systemd.service(5)`: past it, the service is terminated and marked failed; the default is `infinity`).
- `TimeoutStopSec=10` on cancel, so SIGKILL follows SIGTERM after 10 seconds (`systemd.kill(5)` describes that delay).

The unit's parent is the user manager, not the node agent (`systemd-run(1)`). Restarting the node agent does not stop it. `KillMode=control-group` (the default, `systemd.kill(5)`) kills every process in a unit's control group when *that* unit stops: a child of the node-agent unit would die on an agent restart, which is why jobs are not children of it when this path is available.

Transient units cannot be enabled (`systemctl(1)`), and they are not unit files. A reboot does not bring them back. Logout stops `user@.service` and everything under it unless the operator has enabled lingering (`systemd-run(1)`, `loginctl enable-linger`). The node agent does not turn lingering on. After a reboot, or after the user manager has gone, the unit is absent and the job is `lost`.

**Child path.** Used when the probe fails (macOS, a host without systemd, WSL with systemd disabled, a container with no user bus). The node agent spawns its own helper, detached, with stdio on the log file and `unref()`, so the helper is a new session and the agent can exit without waiting (Node.js 24 `child_process`: on non-Windows, `detached` makes the child the leader of a new process group and session; a child with inherited stdio stays tied to the terminal). The helper spawns the command vector, waits, and writes the exit to `<id>.exit` atomically. It applies the timeout itself, so a timeout still fires while the agent is down. SIGTERM to the helper means cancel: it kills the command's process group, writes `cancelled`, and exits. The helper is not a shell.

On this path a node-agent restart does not, by itself, kill the helper. If the agent is later stopped by a service manager whose `KillMode` is `control-group`, the helper dies with it. The next agent start then finds no live pid and no exit file and marks the job `lost`. That is the honest limit of a host with no user manager. Installing the node agent as a user service, so the probe succeeds, is what removes it. Install stays with the fleet's install sub-project; this design does not add a unit.

**Restart of the node agent.** For every `running` row:

| What it finds | Result |
|---|---|
| systemd unit still active, or helper pid still alive | Reattach. Do not start a second process. |
| Unit inactive with `RemainAfterExit`, or an exit file present | Take that exit. One terminal transition. |
| Unit gone, or pid dead, and no exit recorded | `lost`. |

**Reboot and crash.** The command is not started again (J2). `lost` is a result, and the notice goes out (J4). Its duration is the time from when the job started until it was found lost. A cancel of a job that is still queued has no exit code and no running time. A disk failure while syncing the terminal row leaves the unit or the exit file in place; the next loop retries the write. The notice is not handed off until that write has synced (`FULL` for that transaction, the same rule as a done key's `started` and a delivery's store).

The environment is a clean set: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `TMPDIR`, plus `MORNDO_JOB_ID` and `MORNDO_LANE`. The agent token and the rest of the caller's environment are not copied.

**Why this, and not the alternatives.**

| Option | Verdict |
|---|---|
| **Always a child of the node agent** | Rejected when systemd is present. The default `KillMode=control-group` kills that child on an agent restart, so the job would not survive the supervisor that is supposed to own it. |
| **launchd on macOS, a third supervisor** | Rejected. The child path already covers non-Windows hosts without systemd. A third implementation is a second place for the exit to get lost. |
| **Restart the command after a reboot** | Rejected. A deploy, an export or a migration must not run twice because a machine rebooted. `lost` is visible; the caller starts a new id if it still wants the work. |
| **A persistent systemd unit on disk** | Rejected. It would come back on boot and run the command again, and it would leave unit files for the operator to clean up. Transient plus `lost` matches "report it, don't repeat it." |
| **The node agent turns on lingering** | Rejected. Lingering changes how the whole user session behaves on the machine. The operator opts in. Jobs that die at logout are `lost` and reported. |

## 4. Delivery

**Choice.** The terminal transition and the notice row commit together. The notice id is `node:job:<jobId>:done`.

- **`lane:<name>`.** The node hands the notice text to its delivery queue as one `lane.deliver` with that id. ADR-0014 applies unchanged: stored synced before the sender may stop worrying; typed once; a busy lane waits (`menu_open`, `draft_present`, `busy`, `earlier`, …); a sticky name waits through `no_pane`; any other name whose session is gone is `given_up` (`gone`); a typed notice never seen taken is `uncertain` and is not typed again. The fleet keeps the delivery's state and not a second copy of the rules. If the lane is on another node, the fleet routes that delivery as it routes any other: the text is stored on the node that types it, not in the fleet's table of delivery state.
- **`task:T-<n>`.** The hub, on the terminal `ev.job`, posts one board comment whose idempotency key is the job id. The actor is the lane that started the job (the attribution checked at start). A replay posts nothing. The comment's words are the notice, shortened so it fits the board's comment limit and character rules. The task is not moved. A missing task, or a board that refuses the comment, sets the notice to `given_up` with `task_gone`. The job stays terminal.
- **Every target, `fleet` included.** The agent sends `ev.job` on each state change. After a reconnect it sends every job that is not terminal, plus terminal jobs of the last hour (latest wins, as deliveries do). The fleet keeps the row 7 days and publishes it on `/v1/events`. Shape: `{ v: 1, t: "job", id, node, lane, name, class, state, position, reason, outcome, exit, durationSec, error, notify, task, notice, at }` plus the redacted tail on the terminal event. Subscribers dedupe on `job:<id>:terminal`. The hook bus stays at-least-once (FL11); the single notice id is what makes the lane and the comment once.

A job is terminal whether or not the notice has been seen. The caller that misses a `given_up` or an `uncertain` reads `morndo job show` or `GET /v1/jobs/<id>`. There is no automatic second notice (J3).

While the fleet is down, a lane notice that was already stored on the node keeps being tried, as queued deliveries already do. A new job starts while the hub is unreachable only when the node still holds that lane's token hash from the last 24 hours (section 6). Once the process is running, it keeps running if the fleet drops, and the notice waits on the node until the queue can deliver it.

A notice still `queued`, `typed` or `held` uses the delivery queue's existing alerts. A notice that reaches `given_up` raises `job_unnoticed` once.

**Why this, and not the alternatives.**

| Option | Verdict |
|---|---|
| **A new socket, inbox directory or wake channel** | Rejected. ADR-0014 already delivers to a lane once, and already fans events out to subscribers. A second channel would split "did it arrive?" into two answers. |
| **Retry the notice until the lane replies** | Rejected. ADR-0008: a send that was typed and not seen is `uncertain`, never typed again, because a late repeat can land in the wrong turn. The job row is the record that does not depend on the lane having read it. |
| **The completion types the command's full log into the lane** | Rejected. Delivery text is at most 8000 characters, and a log is the wrong thing to put in a conversation. The tail plus the log path (on that node) is enough to go and look. |
| **A board comment that marks the task done or blocked** | Rejected. B3: a lane does not mark done, and a process exit is not the manager's acceptance. B8: the board grants nothing. |

## 5. Resource fairness

**Choice.** Limits live in the node policy (`policy.json`), under `jobs`. Names match `[a-z0-9-]{1,32}`. The shipped policy is:

```json
{ "jobs": { "enabled": true, "classes": { "default": { "limit": 2 } } } }
```

A class may also set `timeoutSec`. There is no global timeout and no second built-in class. An operator who wants a single slot for heavy work adds a class and passes `--class` ; Morndo does not name that work.

Admission, when a job is accepted:

1. If `jobs.enabled` is false, refuse.
2. If the class is not an own property of the policy, refuse. A name that only exists on the object prototype is not a class, and a class removed from the policy is not left queued.
3. If its class already has `limit` jobs in `running`, the job stays `queued` with `reason: class` and a position. Position 1 is the next to run. Order is the order accepted. A job does not jump the queue.
4. If `jobs.guard` is set and the reading says the machine is over the line, the job stays `queued` with `reason: load` or `memory`, still in its class order. The guard is not a kill. It delays the start.

`jobs.guard`, absent by default:

```json
{ "load1": 4, "memAvailableMiB": 512 }
```

Either field may be omitted. On Linux, `load1` is compared to the first field of `/proc/loadavg` (`proc_loadavg(5)`: the 1-minute average of jobs running or waiting on disk) and `memAvailableMiB` to `MemAvailable` (`proc_meminfo(5)`: an estimate of memory available for new applications without swapping). The check runs when a slot is about to be taken, and at least every 5 seconds while something is queued, the same cadence as a delivery retry. When the guard is set and the reading cannot be done, the job stays queued with `reason: guard_unknown` (a configured guard that cannot see the machine does not start work). When the guard is absent, nothing is read, so macOS and a host without `/proc` behave as the class limit alone.

Cancel removes a queued job from the line and reports `cancelled` without it ever having run. Cancel of a running job is section 3. A timeout moves a running job to `timed_out` and frees the slot. The next queued job of that class starts.

Per job, the log is capped at 8 MiB, keeping the tail. Across jobs, logs are capped at 256 MiB (the relay's existing disk budget is the model, not a shared pool with it). A start that cannot create a log inside that cap is refused `disk`, not queued.

**When a log reaches its cap.** One rule, the same on both backends (`apps/node-agent/src/ops/job-cap.ts`):

- **One owner decides.** On the helper backend the helper decides, because it is the only process that runs while the agent is down. The supervisor's sweep never stops a helper's command; it writes `<id>.cap` to say it saw the log at the cap, and the helper treats that file like its own sighting. On the systemd backend the supervisor decides, in the sweep that sees the cap (it also writes `<id>.cap`, so a later sweep, or a restarted agent, still knows). During the grace that sweep watches the log and the unit's main process, and asks systemd how the unit ended once that process is gone.
- **The grace.** From the owner's first sighting, the command has 1 second to end on its own, as long as the log does not grow. If the log grows again, the owner stops the command at once, so a command that keeps writing gets past the cap only what it writes between two looks (the helper looks every 30 ms; on systemd the sweep that saw the cap looks every 50 ms until it decides). The grace runs on that owner's clock only, inside one look loop, so the 1-second sweep does not stretch it. Stopping is SIGTERM to the process group, then SIGKILL.
- **The exit code.** A command whose main process ended before the owner sent the stop keeps its own code (`exited`, the code, or 128 plus the signal when someone else killed it). This holds when the log is at the cap, and when processes it left behind keep its group alive: those are stopped, and the code stays. A command still running when the stop is sent is `exited` with no code (`exit: -`), whatever it does after the signal: a SIGTERM handler that exits 0 is still `-`. "Before" is checked, not guessed: the helper first handles every child exit already queued for it, then decides; after a stop, the systemd path keeps a code only for a normal exit (`ExecMainCode` 1) whose `ExecMainExitTimestampMonotonic` is before the CLOCK_MONOTONIC time the stop was sent; a main process found killed by a signal after the stop was stopped by it.
- **Restart.** The result is written once, by the owner: the helper's `<id>.exit`, or the supervisor's terminal row. A supervisor that starts later takes `<id>.exit` as written, so a code the helper kept while no supervisor ran stays, and a `<id>.cap` on disk changes nothing. A systemd unit that ended while the agent was down is read from systemd, with its own code; one still running starts the grace again.

**Why this, and not the alternatives.**

| Option | Verdict |
|---|---|
| **Hard-coded slots for "reviews" and "CI"** | Rejected. Those are one setup's names. A class is a name the operator chooses. |
| **A global default timeout of a few hours** | Offered in section 9. The proposal is no global timeout: a long export is a valid job, and a silent kill is a result the caller did not ask for. A class or `--timeout` sets a limit when one is wanted. Forgotten jobs stay visible and cancellable. |
| **Kill the heaviest job when memory is low** | Rejected. The guard only refuses to start another one. Killing a running export to make room is a surprise. |
| **Priority across classes** | Not now. FIFO inside a class is explainable. Weights can be added later without changing the CLI. |
| **The guard on by default** | Rejected. A wrong default line on a small VPS or a laptop would queue every job, and the reading is Linux-specific. Off until configured. |

## 6. Security

**Choice.** The board's agent tokens (ADR-0015), checked at the hub before a start.

| Actor | Start | See | Cancel | Logs |
|---|---|---|---|---|
| Worker token, as its lane (`MORNDO_LANE`, `X-Morndo-Lane`) | Jobs attributed to that lane | Its own jobs | Its own jobs | Its own, through the redactor when printed |
| Manager token | Jobs attributed to the manager lane | Every job | Every job | The tail, through the hub. On the node, `morndo job logs` still passes the redactor. |
| Principal, from the hub | No (agents start jobs) | Every job | Any, as a Command (AC7) | The tail in the UI |

The CLI asks the hub, with the token, for a permit: job id, lane, class, notify target, working-directory hash. No command line. The hub checks the token the way it checks a board call, draws a nonce, and returns the nonce to the CLI only. It then asks the fleet, as a fleet client, to deliver the permit to that node: the same fields plus the hash of the nonce, still no command. The fleet pushes it over the agent connection the node already trusts. The CLI presents the nonce and the command vector on the local socket. The node stores the job only when the permit is for this id, the hash matches, and the class, target and directory hash match. A submit that arrives before the permit gets `permit_pending`; the CLI retries until the permit shows up or the 2 minutes run out, then exits 4 with nothing started. The permit is single-use. The token and the nonce are not written to the job row, the log or the fleet. After a check that succeeds, the node keeps that lane's token hash, and only the hash, for 24 hours.

The node's hub address is the `hub` field of its own `config.json` (an `http://` or `https://` URL). It is not the lane variable `MORNDO_HUB`. A start while that field is absent is refused with a clear error; the offline cache is not consulted, because the hub was never configured.

A worker token that names another lane is refused. The manager token does not start work in some other lane's name. When the hub answers, its answer wins: a refusal starts nothing, even if a cached hash would have matched, so a revocation applies as soon as the hub is back. When the hub cannot be reached, the node may start the job if the caller presents the cached hash for that same lane and the check that stored it was within the last 24 hours. No cache, a different lane or hash, or a cache older than 24 hours: exit 4, nothing runs.

On the node, the socket mode is the same boundary as the fleet's client socket: the user the agent runs as can open it. ADR-0012 already says that user is not an isolation boundary. The grant is what stops a process that merely knows the socket from attributing a job to a lane the hub did not allow. The command still runs as that user, with that user's files, because that is the node.

Notices and any log bytes printed by `logs`, shown in the hub, or stored as the tail pass `redactText` (`packages/protocol`, ADR-0008 A4: bearer tokens, cookies, join strings, PEM blocks, emails, tailnet names and addresses, the home directory as `~`). The notice builder adds patterns in front of that, because command output is not the hub's JSON: an `AKIA` access-key shape, and any `NAME=value` or `NAME: value` whose name contains `key`, `secret`, `token`, `password`, `pass`, `credential` or `auth` (any case, a quoted value included). The value is replaced. This is best-effort. A command that prints a secret in a shape nobody listed can still put it in the tail. The full log file is mode 0600, removed 7 days after the terminal row, along with the exit file. The fleet row keeps the redacted tail for those 7 days and then drops it. The fleet row never has the command, the environment or the working directory.

A revoked token does not un-run a job that already started. The comment and the delivery still go out under the lane recorded at start. Cancel after revocation fails for that worker; the manager and the principal can still cancel.

`job.cancel` is a fleet operation the node policy can omit (`denied`, not executed). It carries the id and no command. Local starts are refused entirely when `jobs.enabled` is false.

**Why this, and not the alternatives.**

| Option | Verdict |
|---|---|
| **The node agent trusts `MORNDO_LANE` and skips the hub** | Rejected. Any same-user process can set that variable. The board already went to tokens for that reason. |
| **Send the command to the hub so the hub can authorize it** | Rejected. The command would leave the node, and the hub would be holding scripts it does not run. The grant covers the id and the lane only. |
| **Run the job as another Unix user** | Rejected. The node has no such boundary today (ADR-0012). A `--uid` flag would pretend otherwise. |
| **Hide the tail from the manager** | Rejected. The manager is who the report is for. The tail is redacted and short; the log file stays on the node. |

## 7. Observability

**Choice.** Jobs are visible where the fleet's nodes are already visible, and on the board when a job names a task.

- The hub lists each node's jobs: name, class, state, lane, outcome, exit, duration, notice state. Counts next to the node: running, queued, and failed in the last 24 hours (`exited` with a non-zero code, `timed_out`, `lost`). `cancelled` and a zero exit are not failures.
- A non-zero exit, a timeout or a `lost` raises one fleet alert, `job_failed`, with the id, the name, the class and the outcome. No command, no tail. Success raises no alert; the notice is the success. Cancel raises no alert; an actor asked for it.
- `GET /v1/jobs?node=&lane=&state=` and `GET /v1/jobs/<id>` answer from the fleet's table, `stale` while the node is offline. `/v1/events` carries `job`.
- A job started with `task:T-<n>` shows on that card as a chip (name and state). The chip opens the job. The completion comment is the notice text. The card's column does not change because of it.
- The node agent's `status` file gains `jobs: { running, queued }` so a local operator can see the count without the hub.

Home (ADR-0016) stays the usage view. Jobs do not become a second board.

## 8. Migration

Later, and not part of building this. No one's current machine is changed by this design.

A stopgap that starts a command under the user service manager and writes a completion line into an inbox becomes `morndo job start --notify lane:<that-lane> --name <name> -- <command…>`. The completion arrives as a delivery, through the same queue as every other message to that lane, in the notice text of section 2. A habit of polling "is it done?" becomes `morndo job show <id>`, or reading the delivery. One command moves at a time, after this primitive is in, with that setup's own rollout. Class names for that setup are chosen there, in its node policy, not in Morndo.

## 9. Choices for the owner

The owner accepted these on 2026-10-09 (ny-318). Choices 1–6 stand as proposed. Choice 7 is the offline rule: a cached token hash, not a refusal of every start the hub cannot check.

| # | Decision | Accepted |
|---|---|---|
| 1 | A job starts only on the node where it runs. The command never crosses the fleet. Remote start stays out of scope. | **Yes.** |
| 2 | After a reboot or a crash with no recorded exit, the job is `lost` and reported. The command is not run again. | **Yes.** |
| 3 | No global timeout, unless the class or `--timeout` sets one. | **Yes.** |
| 4 | One shipped class, `default`, limit 2. The load/memory guard stays off until the policy sets it. | **Yes.** |
| 5 | One `--notify` target (`lane:<name>`, `task:T-<n>`, or `fleet`). The fleet event always fires as well. A task notice is one comment and does not move the task. | **Yes.** |
| 6 | If that delivery is `given_up` or `uncertain`, the job stays readable and no second notice is sent. | **Yes.** |
| 7 | When the hub cannot be reached, the node may start a job if it holds that lane's token hash from a check that succeeded within the last 24 hours and the caller presents the same hash. A live refusal wins over the cache. Revocation applies the next time the hub answers. The cache stores the hash only. | **Yes.** |

## 10. Out of scope

| Not in this design | Why |
|---|---|
| Cron, timers, "run again at 06:00" | A job is one command, one result. Schedules are a later primitive. |
| Restart-on-failure, retries of the command | J2. The caller starts a new id. |
| Starting a job on another node | The command would cross the fleet (FL14). |
| A PTY, an interactive job, a job that is a lane | Lanes already exist. A job has no screen. |
| Another Unix user, a container, an image | Same user as the node agent, on purpose. |
| Windows services | The fleet's nodes are the machines it already runs on. The child path covers non-Windows without systemd. |
| Replacing a CI system, or naming classes for one | Config holds whatever names an operator wants. |
| Moving a board task when a job ends | B3, B8. |
| Push, mail, or a chat-bot message as a new channel | A subscriber that already reads `/v1/events` can do that outside Morndo. |
| The agent CLI's own background tasks | Those stay lane events (ADR-0014). A job is a command Morndo started. |
| Turning on lingering, or installing the node-agent unit | The operator's machine, and the fleet's install sub-project. |
| An MCP server | As with the board: a CLI works from any engine that can run a command. A wrapper can follow. |

## 11. Test plan

What the build has to prove. Isolated resources only: a temporary `HOME`, a temporary `XDG_RUNTIME_DIR` when a user manager is started for the drill, never a live node.

| Claim | Proof | Negative control |
|---|---|---|
| Exactly one notice | Two observations of the same exit create one terminal row and one delivery id. A second `lane.deliver` with that id returns the current delivery and types nothing again. A second hub delivery of `ev.job` posts no second comment. | A test double that omits the id check types the notice twice, and that test must fail. |
| Survives a node-agent restart | Kill the agent while the command sleeps. The process is still running (systemd unit, or helper pid). The new agent reattaches and reports the real exit once. | A child started inside the agent unit's control group dies on the restart; the systemd path's drill fails if the job is gone. |
| Finished while the agent was down | Exit the command after the agent is killed, before it returns. The new agent reads the unit or the exit file and notices once. It does not start the command again. | Without `RemainAfterExit` / the exit file, the result becomes `lost`. That fixture must not be the implementation. |
| Reboot or a vanished process | A `running` row whose unit is gone and whose exit file is absent becomes `lost`, and the notice says `lost`. | A row deleted instead of marked `lost` fails the assertion that the id is still listed. |
| Timeout | A command that sleeps past `--timeout` ends `timed_out`, the process group is gone, and the notice went out. | A timeout that only sets a flag and leaves the process running fails. |
| Cancel | Cancel while queued never runs the command and notices `cancelled`. Cancel while running stops the process group and notices `cancelled` once. | A second cancel starts a second notice. |
| Queue fairness | Class limit 2: the third job stays `queued` at position 1, starts when one finishes, and a job of another class is not blocked by the first class being full. | A scheduler that starts the third job of a full class fails. |
| Guard | With the guard set and a fake reading over the line, the job stays queued `load` or `memory`. With the guard absent, no reading is required and the job starts. A configured guard whose reading throws stays queued `guard_unknown`. | A guard that kills a running job fails. |
| Redaction | A log containing a bearer token, a PEM block, a home path, an `AKIA…` key and `token=…` produces a notice with those values replaced, at most 8000 characters. The fleet row has no argv. | A notice that still contains the fixture secret fails. |
| Token | A worker token starting as another lane is refused and no process exists. Offline, a matching hash from the last 24 hours allows a start; an older hash, another lane or hash, or a live refusal does not. The same id with a different command is `id_conflict`. | A start that proceeds with no live check and no fresh cache fails. |
| Gone and busy targets | A notice to a lane with a menu open stays queued on the delivery, then types once. A notice to a non-sticky lane whose session is gone is `given_up`, the job remains `show`-able, and no second delivery appears. | A `given_up` that requeues the notice fails. |

Manual QA, when a step is built: start a short command and a command that outlives the CLI, read the notice in the target lane, cancel one, and confirm the hub list matches `morndo job list`. Record it in `qa/<date>.md` with the command output. A systemd drill runs only where the probe succeeds, and says so when it was skipped.

## 12. Build plan

Each step is one PR, green on its own, on this branch's line. No step installs a unit on a live machine or edits another worktree.

| Step | PR | Proves |
|---|---|---|
| 1 | Domain and protocol: states, J1–J7 as pure checks, the notice text, the extra redaction patterns, queue position. Schemas for `ev.job` and `GET /v1/jobs`. | Section 11's redaction, fairness math, and notice size, with no I/O. |
| 2 | Node store: the jobs table, the synced terminal transition, the 7-day prune, the 8 MiB / 256 MiB log caps. | A failed sync does not hand off a notice. |
| 3 | Child supervisor and the local socket. Timeout, cancel, exit file, reattach, `lost`. | The restart and timeout rows that do not need systemd. |
| 4 | systemd supervisor behind the probe, same port as step 3. | The control-group drill and `RemainAfterExit`. Skipped, with a printed reason, where the probe fails. |
| 5 | The notice: one `lane.deliver`, the grant check against the hub, the 24-hour token-hash cache, `morndo job`. | Exactly-once, `id_conflict`, exit codes, the offline cache. |
| 6 | Fleet mirror: `ev.job`, `GET /v1/jobs`, `job.cancel`. No argv column. | A routed delivery to a lane on another node is still one id. |
| 7 | Hub list, counts, `job_failed`, the board chip and the one comment. | A replayed event does not comment twice. A comment does not change status. |
| 8 | Class limits, positions, the optional guard, domain.md, the API examples run as tests, manual QA notes. | The fairness and guard rows against the real scheduler. |

Step 5 is the first a caller can use. Steps 6–8 make it visible to everyone else. The owner's stopgap is not moved in any of these steps (section 8).

## 13. Sources

Checked 2026-10-09. Cited in ADR-0017: `systemd-run(1)`, `systemd.kill(5)`, `systemd.service(5)`, `systemd.exec(5)`, `systemctl(1)`, Node.js 24 `child_process` `detached`, `proc_meminfo(5)`, `proc_loadavg(5)`. Local versions the same day: systemd 255.4, user manager `running`, Node v24.5.0. Delivery text cap: `maxSendText` 8000 in `packages/protocol/src/fleet.ts`. Redactor: `packages/protocol/src/redact.ts`.
