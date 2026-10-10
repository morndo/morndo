# ADR-0017: Background jobs that report back

- **Status:** Accepted, 2026-10-09. The owner approved the defaults (ny-318). Decision 7 is the offline cache below, in place of refusing every start the hub cannot check. Design: [`docs/design/background-jobs/README.md`](../design/background-jobs/README.md).
- **Number:** 0010, 0011 and 0013 belong to open pull requests (manager inbox, phone chat app, engines settings). 0016 is Home and usage.
- **Builds on:** ADR-0012 (the fleet; typed operations; no command line crosses it), ADR-0014 (the per-node delivery queue and fleet events), ADR-0015 (the board, agent tokens), ADR-0008 (send states, idempotency, the redacting logger).

## Context

An agent starts work that outlives its turn: a test suite, a review run, a CI watch, a deploy, an export. When that work ends, nothing tells the agent. The result sits unread until a person asks why everything is idle.

The fleet already has the missing piece for *telling* someone. ADR-0014 puts a delivery queue on each node: a message to a lane is stored, typed once, and confirmed from the conversation, with the send states of ADR-0008 (`queued`, `typed`, `uncertain`, `given_up`). Lane events and client subscribers already read the fleet's event stream. ADR-0012 forbids a generic exec through the fleet: a command line never crosses it, and the node is not an isolation boundary (lanes run as the same user as the agent).

What does not exist is a universal way to *run* a detached command on a node, keep its state across the agent's turn and a node-agent restart, and hand one completion to that queue. A one-user, one-machine inbox script is the shape of the need. It is not the design.

Morndo is for many people on modest machines (a laptop, a small VPS, an HDD, WSL), with nothing specific to one setup. Class names, limits and the manager's lane name come from config.

## Decision

1. **A job is a node primitive.** Any agent starts it with `morndo job` on the node where it runs. The command, the working directory and the log stay on that node. The fleet stores the job's state and a redacted, size-capped tail. It never stores the command line (FL14).
2. **The node agent supervises it.** A user transient unit (`systemd-run --user`) when the user service manager is usable; otherwise a detached child of a small helper, outside the agent's turn and the lane's session. A node-agent restart reattaches. A reboot or a crash with no recorded exit marks the job `lost` and reports that. The command is not started again.
3. **One completion, through the delivery queue.** The job becomes terminal once. A lane target, including a sticky lane such as the configured manager, is one delivery (`id` `node:job:<id>:done`) with ADR-0014's states. A board target is one comment on that task, keyed by the job id, and does not move the task (B3, B8). Every terminal job is also a fleet event subscribers already know how to read. A busy lane waits in the queue. A gone target becomes `given_up`. Nothing is sent a second time, and the job is not dropped.
4. **Fairness is config.** Named concurrency classes, each with a limit, live in the node policy. The shipped policy has one class, `default`, limit 2. An optional load and memory guard is off until set. A job can carry a timeout. Cancel is a terminal outcome and is reported.
5. **The board's tokens say who.** A worker token starts, sees and cancels jobs for its own lane. The manager token and the principal see and cancel any. When the hub can be reached it checks the token, and a refusal stands. When it cannot, the node may start the job if it holds that lane's token hash from a check that succeeded within the last 24 hours and the caller presents the same hash. Otherwise nothing starts. Revocation applies the next time the hub answers. The cache stores the hash only. The process runs as the node's user, in the agent's working directory. Notices and logs shown to anyone else pass the shared redactor and a size cap. Logs are removed 7 days after the job ends.

The design records the alternatives for each point, the test plan and the build steps.

## Consequences

- The domain gains a Job context (terms and invariants J1–J7 in the design). It imports no systemd, no file system and no socket. Supervisors are adapters in the node agent.
- `job.cancel` is a typed fleet operation with no command line. Starting a job is not a fleet operation.
- A completion uses the delivery queue's contract after the hand-off: typed once, `uncertain` if never seen, never typed again. "Exactly once" is the terminal record and the single delivery id, not a second channel that retries forever.
- A machine whose user manager is absent (macOS, a host without systemd, a WSL install with systemd disabled) still runs jobs, through the child supervisor. Those jobs die if a service manager later kills the agent unit's whole control group; the next start marks them `lost`.
- The hub gains a job list, failure counts, one alert on failure, and the optional board comment. Home (ADR-0016) is unchanged.

## Sources (checked 2026-10-09)

- **systemd 255** on this machine (`systemctl --version`: 255.4-1ubuntu8.17; `systemctl --user is-system-running`: `running`). The man pages below are that install's, and they match the upstream pages fetched the same day.
- **`systemd-run(1)`** (upstream, systemd 256): a transient service "run[s] in a clean and detached execution environment, with the service manager as its parent"; `--user` talks to the user manager; `--property=Type=exec` so start succeeds only if the command was invoked; `--expand-environment=no` disables `$` expansion (also: escape `$` as `$$`); `--remain-after-exit` keeps the unit "until it is explicitly stopped" so the exit can be read afterwards; `--collect` unloads the unit when it finishes, which is too early for that read. Without lingering, `user@.service` "and all services underneath it are terminated" at logout; `loginctl enable-linger` keeps the user manager up. https://www.freedesktop.org/software/systemd/man/latest/systemd-run.html
- **`systemd.kill(5)`** (local man, systemd 255): `KillMode=` defaults to `control-group`: "all remaining processes in the control group of this unit will be killed on unit stop." A child of the node-agent unit therefore dies when that unit restarts. A separate transient unit does not.
- **`systemd.service(5)`** (local man): `RuntimeMaxSec=` "configures a maximum time for the service to run"; past it, the service "is terminated and put into a failure state." Default `infinity`.
- **`systemd.exec(5)`** (local man): `StandardOutput=` accepts `append:path`.
- **`systemctl(1)`** (local man): "Transient units may not be enabled," so a reboot does not restore them. Observed the same day: `systemctl --user show` exposes `ExecMainCode`, `ExecMainStatus` and `Result` (read on `dbus.service`).
- **Node.js 24 `child_process`:** on non-Windows, `detached: true` "makes the child the leader of a new process group and session." The child continues after the parent exits only if its stdio is not connected to the parent; `unref()` lets the parent exit without waiting. https://nodejs.org/docs/latest-v24.x/api/child_process.html (page fetched 2026-10-09; this machine's `node -v` is v24.5.0, below the repo's `>=24.12` engine, so the build pins the same option against the engine's Node).
- **`proc_meminfo(5)`, `proc_loadavg(5)`** (local man): `MemAvailable` is "an estimate of how much memory is available for starting new applications, without swapping" (since Linux 3.14). The first field of `/proc/loadavg` is the 1-minute load average.
