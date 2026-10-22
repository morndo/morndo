# Releases and updates: one command, automatic at a safe point, signed and reversible (design v1, 2026-10-11)

**Phase: design only.** This document and [ADR-0019](../../adr/0019-releases-and-updates.md). No product code yet.

**v1 review.** A fresh-context review of the first draft found seventeen problems, each checked against the code or the sources and folded in:
- **No apply lock.** Recovery could act during a live apply (RL4).
- **The boot-time apply skipped the fleet's rules.** It ignored skew, halts and holds, so a node now applies only once connected (section 6.7).
- **A restore could bring back a revoked device, agent token or node,** because console commands write the databases directly. Now there are revocation journals (RL10).
- **A crash between the two link swaps left an older `previous`,** and the first update had no recovery. Now `previous` is swapped first, and recovery runs from `good`.
- **Unknown record steps.** An older updater met steps it didn't know (section 6.6).
- **The keys helper names a Version's own path,** which `prune` would delete (section 5).
- **Key sets couldn't be walked across a root change** (RL3).
- **The hub's restore guard used the device's clock.** It now uses a store id (RL10).
- **Crash leftovers blocked safe points for days** (section 6.3).
- **One sleeping laptop could roll back the control plane** (section 6.4).
- **Smaller fixes:** the connections helper's exit code and its missing service; 0.x version bumps; the promotion job's environment; size caps on metadata; state names; the first install's Channel; the `updating` status code.

**The request:** when a new version is released, users should be able to update Morndo easily, and by default it should update itself the way Claude Code's CLI does: the update installs on its own, and the next start runs the new version. It may ship, with careful QA, strict DDD, and proof that each choice follows current best practice.

**Builds on:** ADR-0005 (stack), ADR-0008 (numbered migrations, the protocol package, send states), ADR-0012 (roles, version skew: current and previous protocol, exit 78), ADR-0013 (a CLI as the only way in, behind an adapter), ADR-0017 (systemd user units, transient units, what dies with a unit), ADR-0018 (the design's shape: a context, invariants, ports, a stacked plan).

Facts carry a source and the date checked. **[U*n*]** points to section 17. UNVERIFIED marks what no primary source settled. **Q*n*** is decision *n* for the owner, at the end.

## 1. What we looked at first

Read in this tree on 2026-10-11.

- **No release exists.** Every workspace package is `0.0.0`. `SECURITY.md` says there are no versioned releases. The README says Morndo is not installable by anyone else yet, and install by role is the fleet's sub-project 3 ([ADR-0012](../../adr/0012-fleet-pull-agents-and-a-separate-fleet-service.md), consequences).
- **How it runs today.** From a checkout: `npm ci`, `npm run build`, then the TypeScript sources run directly under Node (`>=24.12`). Six programs: `morndo` (the hub), `morndo-fleet`, `morndo-node`, `morndo-job`, `morndo-board`, `morndo-keys`. One native module, `better-sqlite3` (`^13.0.3`).
- **Four SQLite databases, each with numbered migrations** through one runner (`packages/service-kit/src/migrate.ts`): the version is `user_version`, every pending migration runs in one `IMMEDIATE` transaction, and a database from a newer service is refused (`DatabaseFromFuture`, exit 78). There are no down migrations. The hub's database is `~/.local/share/morndo/morndo.db`, the fleet's `~/.local/share/morndo-fleet/fleet.db`, the node agent's `~/.local/state/morndo-node/agent.db`, plus the connections store (ADR-0018).
- **Not every migration is additive.** Fleet migration 7 rebuilds two tables (`DROP TABLE jobs`, `ALTER TABLE jobs_keyed RENAME TO jobs`). An older fleet couldn't read the result, even if the runner let it try.
- **Version skew is already part of the fleet.** The agent channel and the client API accept the current and the previous version (`FLEET_PROTO = 1`, `CLIENT_API = 1` in `packages/protocol/src/fleet.ts`). The agent's `hello` carries its own version and Claude Code's. An agent the fleet refuses for its protocol (4426) keeps its lanes running and retries hourly.
- **Exit 78 means "fix the setup, don't restart"**, in all three services. The hand-written units on the owner's machine don't restart on it (fleet core §16).
- **A hazard for any agent restart, update or not.** `lane.start` runs `tmux new-session -d` from the agent when the session doesn't exist (`apps/node-agent/src/ops/lane-ops.ts`). On a fresh machine the tmux server, and with it every lane, then lives in the agent unit's control group, and systemd's default `KillMode=control-group` kills "all remaining processes in the control group of this unit … on unit stop" [U18]. Restarting the agent would end every lane. PR 0 fixes this before anything restarts the agent on its own.
- **Jobs under the child supervisor die with the agent unit** (ADR-0017, consequences). Transient-unit jobs survive.
- **The web app** is a static SvelteKit app with a service worker that caches the shell per build `version`, calls `skipWaiting()` and claims clients (`apps/web/src/service-worker.ts`). An open tab keeps running the old code after the hub is updated, until it reloads.
- **Health.** The hub has no health endpoint. The fleet has `GET /v1/caps` and `morndo-fleet status`. The agent writes `status.json`.
- **Sends and restores.** The hub types a request id at most once within 24 hours (S5), and a device retries on its own only within 2 minutes (S7). A node database put back from an older copy is detected by the store sequence and starts a new store (FL7). A restore of the hub's database has no such guard yet (section 11.5). The web app's outbox takes a 409 (other than `uncertain` and `not_submitted`) as a final refusal and a 5xx as saying nothing (`apps/web/src/lib/outbox.ts`), so a temporary refusal must be a 503.
- **Revocations bypass the services.** `morndo revoke`, `morndo agent-token revoke` (`apps/hub/src/main.ts`) and `morndo-fleet node revoke` (`apps/fleet/src/main.ts`) write their databases directly from the console. A restored database would bring a revoked device, token or node back (section 11.5).
- **The keys helper names its own Version.** `morndo-keys` writes `process.execPath` and the absolute path of its `main.ts` into the helper command it gives Claude Code and Codex (`apps/connections/src/cli.ts`). Lanes keep calling that path after an update, and nothing running would show that Version as in use.
- **The connections store has no service.** Its helper runs whenever an agent CLI needs a key, migrates the store on open, and exits 78, like the services, on a database from a newer version (`apps/connections/src/cli.ts`).

## 2. Goals and non-goals

**Goals.**
- One command: `morndo update`.
- Automatic updates on by default, with an opt-out: download and verify in the background, apply at a safe point, and on the next start or boot the new version runs.
- Two channels, `stable` and `latest`.
- Five rules that are not choices: never install an unverified artifact; never downgrade unless asked; back up before a migration the old version can't read; apply only at a safe point; roll back automatically when a health check fails.
- One machine and a fleet: who updates first, how far apart the control plane and nodes may be, and what happens when one of them fails.
- A release pipeline from a tag to signed artifacts, checksums, build provenance, release notes and a channel pointer.
- Every rule pinned by a test, every failure mode injected, and a manual QA run on a throwaway machine.

**Non-goals.**
- Native Windows. The services need tmux; WSL counts as Linux.
- OS packages (apt, Homebrew) in v1. The Installer port allows them later, and such an install is never changed by Morndo's own updater (RL14).
- Delta updates.
- Telemetry. An update check sends only the HTTPS request for the feed.
- Remote control by the maintainers. The feed can withdraw a release. It can never force an install or a downgrade.
- Updating the agent CLIs. Claude Code updates itself [U1]. Morndo reports each node's Claude Code version, as it does today.

## 3. What Claude Code does, and what we take

All from Claude Code's setup page [U1] unless marked.

| Claude Code | Morndo |
|---|---|
| "the native installer manages the launcher at `~/.local/bin/claude` as a symlink into `~/.local/share/claude/versions/`"; it "keeps the two newest versions", plus the one the launcher points to and any a running session uses. | The same shape (section 5): versioned directories, a `current` link swapped atomically, `previous` kept, and no version deleted while a process runs it. |
| "checks for updates on startup and periodically while running. Updates download and install in the background, then take effect the next time you start Claude Code." | Checked at boot and every 6 hours. Downloaded, verified and unpacked in the background (staged). A CLI restarts when the user starts it again; services don't, so a staged version applies at a safe point, or at the next boot (section 6.7). |
| `autoUpdatesChannel`: `"latest"`, the default, or `"stable"`, "typically about one week old, skipping releases with major regressions". | `stable` and `latest`. A release reaches `stable` after at least 7 days on `latest` with no withdrawal. The default is Q2. |
| `minimumVersion`: updates "refuse to install any version below this value, so moving to the `"stable"` channel does not downgrade you". | RL2: nothing from a feed ever moves a machine down, a channel switch included. |
| `DISABLE_AUTOUPDATER` "only stops the background check; `claude update` and `claude install` still work"; `DISABLE_UPDATES` blocks every path. | `MORNDO_DISABLE_AUTOUPDATE=1` and `MORNDO_DISABLE_UPDATES=1`, with the same split (RL14). |
| `claude update`, `claude install [version\|stable\|latest]`, `claude doctor` [U2]. | `morndo update`, `morndo update --to <version>`, `morndo doctor`. |
| "Homebrew installations do not auto-update." | An install that Morndo's updater didn't make is never changed by it (RL14). |
| A `manifest.json` with SHA-256 for every binary, "signed with an Anthropic GPG key", from 2.1.89. | A signed manifest from the first release, verified by the updater and by the first install. |

Where Morndo goes further:
- **Signature before anything runs, at first install too.** Claude Code's `install.sh` checks a binary's SHA-256 against the manifest. Read on 2026-10-11, it had no signature check of the manifest itself; that is our reading of the script, and no page documents it [U2]. Morndo's first install verifies the manifest's signature with a tool already on the machine (section 10.3).
- **Services, not a CLI.** A failed Claude Code update costs one restart. A failed Morndo update could cut the principal off from every lane, so Morndo adds what a CLI doesn't need: safe points, health checks, automatic rollback, backups, and rollout order across machines.

## 4. The model: the Releases context

### 4.1 Ubiquitous language

| Term | Means | Is not |
|---|---|---|
| Version | A SemVer 2.0.0 version of the whole product, compared by SemVer precedence [U4]. | A package's own version; a git commit. |
| Release | One Version, published once, with its Artifacts, Manifest and notes. Immutable once published. | A tag alone; a build. |
| Channel | A named stream of Releases: `stable` or `latest`. | A branch; a pre-release tag. |
| Feed | The signed, dated, numbered pointer that says which Releases a Channel offers and which are withdrawn. | The Release itself; an HTTP listing. |
| Manifest | The signed list of a Release's Artifacts with their sizes and digests, its database schemas and protocol range. | The Feed; a checksum file without a signature. |
| Artifact | One archive for one platform (`linux-x64`, `linux-arm64`, `darwin-arm64`) holding the runtime, the program and a list of every file in it. | The source tarball GitHub makes for a tag. |
| Signature | An Ed25519 signature in the SSH signature format, made under a namespace that names its role [U13]. | A checksum; a TLS connection. |
| Key set | The pinned public keys for each role (root, release, feed), with a version and an expiry, signed by root. | Any key a download offers. |
| Installation | One machine's install: current, previous and staged Versions, how it was installed, its Channel, mode, pin and trust state. | A database; a node in the fleet. |
| Update | One attempt to move one machine from one Version to another, step by recorded step. | A Release; a Rollout. |
| Rollout | One Version moving across the fleet: the control plane first, then the nodes. | An Update; a percentage. |
| Safe point | A moment when every Morndo service on the machine has nothing in flight that a restart would break. | A quiet hour; a lane being idle. |
| Probation | From the new Version's start until the Update commits: health is judged, and writes a rollback would lose are held. | A canary; a soak across days. |
| Health check | A named check a service passes at a given Version, read from outside the service. | The service saying it is fine; the process being alive. |
| Migration plan | Per database: its schema now, after the target's migrations, and whether the current Version could still open it. | The migrations themselves. |
| Schema floor | The lowest schema version whose code can safely open a database. Additive migrations leave it; breaking ones raise it. | `user_version`. |
| Backup | A copy of one database taken after its service stopped, checked for integrity and schema, kept until the Update is well past. | A file copy of a live database. |
| Withdrawn | A Release the maintainers no longer offer. Machines on it stay on it and are told. | A downgrade order. |

### 4.2 Invariants

| # | Invariant | Attack or failure it stops |
|---|---|---|
| RL1 | **Verified before unpacked.** An Artifact reaches the install only after, in this order: the Feed verifies with a feed key of the current Key set under the feed namespace, names this Channel, is unexpired, and its number is at least the highest seen; the Manifest's bytes hash to the Feed entry's digest and verify with a release key under the release namespace; the download's size and SHA-256 equal the Manifest's; and, unpacked into a staging directory, every file matches the signed file list with nothing extra. Any failure deletes the download and the staging directory, raises VerificationFailed, and changes nothing else. No flag skips a check, and every install goes through a Feed entry, `--to` included. | arbitrary installation, mix-and-match, endless data [U3] |
| RL2 | **Never downgrade unless asked.** A Version is installed automatically only if it is higher than every Version this machine has committed. A lower one needs the principal's command naming it (`--to <version> --allow-downgrade`, or `--rollback`). A Channel switch, a withdrawal or a lower "latest" never moves a machine down. | rollback attack [U3] |
| RL3 | **The trust state only moves forward, and goes stale loudly.** A Feed numbered lower than one already seen for its Channel is refused. Key sets are taken one version at a time, from the machine's own to the newest, each signed by the root keys of the one before it (and, when root changes, by the new root too), as TUF does for root [U3]; a lower version is never taken. An expired Feed or Key set stages nothing and raises FeedStale or KeysExpired. | rollback of metadata, indefinite freeze, key compromise [U3] |
| RL4 | **One Update at a time, each step recorded first.** A machine runs at most one Update: the process applying it holds an exclusive lock for its whole life, which the operating system drops when the process dies. Recovery, the tick and `morndo update` act on a record only when they can take that lock, so a live apply is never mistaken for a crashed one. Each step that changes something (stop, back up, swap, start, restore) is recorded as started, durably, before it runs, and as done after. After a crash the next run resumes from the record (section 6.6). | a half-applied update after a crash or power loss; two processes acting on one Update |
| RL5 | **Back up before a migration.** Every database the target will migrate is backed up first, after its service stopped. The Backup must pass an integrity check at the expected schema version. Otherwise the Update stops before the swap and the old Version starts again. | data lost to a failed migration |
| RL6 | **Only at a safe point.** Services stop only when every service on the machine reports a safe point (section 6.3). An automatic Update of the machine that runs the hub also waits until the principal is not attending (N3's Attending, on any Endpoint), and every automatic Update waits for the configured window, if one is set. A safe point is never forced; `--now` skips only the attending check and the window. | a restart that breaks a send, a job or a lane |
| RL7 | **A failed health check rolls back automatically.** After the swap, each service must pass its health checks at the target Version within 90 seconds and stay up for 60 more. A check that passed before the Update must pass after it. Otherwise the machine returns to the previous Version: swap back, restore each Backup the previous Version needs (RL8), start, and check that the previous Version is healthy. The target is marked bad on this machine and is not tried again automatically. | a broken release left running |
| RL8 | **No Version runs on a database it can't read.** A service refuses a database whose Schema floor is above the schema it knows (exit 78, as today). The updater never swaps to a Version that would meet that refusal: going back below a floor always goes with that Backup's restore, and the principal is told which writes the restore drops. If that Backup is gone, the downgrade is refused. | a rollback that can't start |
| RL9 | **Probation holds what a restore would lose.** If rolling back would restore a service's database, that service accepts, from start until commit, no write at all except a revocation (RL10): the hub refuses Commands, Decisions, board writes and pairings; the fleet refuses operations and doesn't acknowledge hook events (the agents keep them spooled); the node refuses keyed operations. Each is refused as `updating` with nothing run: HTTP 503 with `Retry-After`, which the web app's outbox retries, and `executed: "no"` on the fleet. Console commands that write, other than revocations, refuse with exit 75 meanwhile. A hold usually lasts about a minute; a Command still held after its device's 2 minutes of retries waits for the principal's Retry (S7). | a rollback that silently drops what was done |
| RL10 | **A restore never undoes what is done.** The hub's database gets a store id, as a node's has (FL7), and a restore makes a new one. A device stamps each Command with the hub store it saw before its first attempt, and the hub answers a Command stamped with another store, whose request id it doesn't hold, as `uncertain` and never types it (S5). No clock decides it (FL13). A restored node database starts a new store (FL7). Every revocation (a device, an agent token, a node) is also appended to a journal beside its database, synced, and each service applies the journal at every start, so a restored database can't bring a revoked one back (AC4, FL4). | a Command typed twice, or a revoked device or node back, after a restore |
| RL11 | **Skew stays inside the window.** A node applies a Version only once its control plane runs that Version or a newer one. The control plane doesn't apply a Release that drops an agent protocol a joined, non-revoked node still depends on; it defers and names those nodes. The agent channel and the client API keep accepting the current and the previous version (ADR-0012 §10). | a node cut off by an update |
| RL12 | **A halted rollout stays halted.** When any machine rolls back a Version, no other machine applies that Version automatically until the principal resumes the Rollout or a newer Release supersedes it. | one bad release spreading across the fleet |
| RL13 | **Morndo updates only itself, and grants nothing.** An Update stops, swaps and starts only Morndo's own services and files. It never stops a lane, restarts tmux, or touches an agent CLI, a repository, a key or a credential. Before every stop of the node agent, a rollback's included, it checks that the tmux server is not inside the agent's unit. It creates no Mandate, Decision or Verdict. | an update that ends the work it serves |
| RL14 | **The principal's switches win.** A pinned machine stays at its pin. `MORNDO_DISABLE_UPDATES=1` blocks every path. `auto off` or `MORNDO_DISABLE_AUTOUPDATE=1` stops background checks and applies, and `morndo update` still works. An install the updater didn't make (a git checkout, a package manager) is never changed by it; it says what to run instead. | an update the principal didn't want |

### 4.3 Aggregates and value objects

- **Installation** (one per machine). Holds the current, previous and staged Versions, the bad Versions, the highest committed Version, the trust state (Key set version, highest Feed number per Channel), the install method, and the settings (Channel, mode, pin, window). Guards RL2, RL3 and RL14.
- **Update** (one per attempt). Holds the target, the pre-update pair (current, previous), the Migration plan, the Backups, the health baseline, and the step record. Guards RL1 and RL4 to RL10.
- **Rollout** (one per Version, on the control plane). Holds when the control plane committed, the soak, each node's state, and whether it is halted. Guards RL11 and RL12.

Value objects: Version, Channel, Feed and its entries, Manifest, Artifact reference (platform, name, size, SHA-256, file-list digest), Key set, Migration plan, Safe-point report (per service, a list of blockers), Health report (per service, its Version and named checks).

Domain services, all pure: `admit` (may this Version be staged here?), `plan` (the Migration plan from the Manifest's schemas and what the databases say), `safeToApply`, `judgeHealth` (baseline against after, within the deadline), `recover` (what the record says to do next), `skew` (may this machine apply this Version, given the control plane and the nodes?).

### 4.4 States of an Update

```
checked ─► staged ─► draining ─► stopping ─► backing_up ─► swapping ─► starting ─► probation ─► committed
   │          │          │           │            │            │           │           │
   ▼          ▼          ▼           ▼            ▼            └───────────┴───────────┴──► rolling_back ─► rolled_back
skipped   abandoned ◄────┴───────────┴────────────┘                                              │
(reason)  (nothing swapped; the old Version runs)                                                └──► rollback_failed
```

The names after `staged` are the marks the step record holds (section 6.2).

- Before `swapping` is done, any failure abandons: the services start again on the old Version, and nothing on disk changed except the staged directory and the Backups.
- From then on, a failure rolls back (RL7).
- `rollback_failed`: the previous Version also fails its health checks. The updater stops, leaves the services to the service manager, and raises a critical Alert. It never loops.

### 4.5 Events

UpdateChecked, UpdateAvailable, UpdateSkipped (reason: not newer, pinned, disabled, withdrawn, bad here, skew, halted), UpdateStaged, VerificationFailed (which check), FeedRollbackRefused, FeedStale, KeySetRotated, KeysExpired, DowngradeRefused, UpdateDeferred (blockers), ServicesStopped, BackupTaken, BackupFailed, VersionSwapped, ServicesStarted, HealthPassed, HealthFailed (service, check), UpdateCommitted, RollbackStarted, BackupRestored, RolledBack, RollbackFailed, RolloutHalted, RolloutResumed, SkewBlocked.

### 4.6 Ports and adapters

| Port | Application side | Adapters |
|---|---|---|
| `ReleaseFeed` | `keySet()`, `channel(name)`, `manifest(ref)`: bytes and their signature, nothing parsed | `feed-https` (the hosted feed and GitHub Releases), `feed-file` (tests, an offline mirror) |
| `ArtifactStore` | `fetch(ref, dest, { maxBytes, timeout })`, which stops at `maxBytes` | `artifacts-https`, `artifacts-file` |
| `Verifier` | `verify(bytes, signature, keys, namespace)`, `sha256(path)` | `verifier-sshsig` (`node:crypto` Ed25519 and SHA-512, no dependency) |
| `Installer` | `method()`, `unpack(artifact, staging, fileList)`, `selftest(dir)`, `promote(staging)`, `swap(to)`, `inUse()`, `prune(keep)`, `renderUnits(version)` | `installer-dirs` (versioned directories and `rename(2)`); read-only `installer-checkout` and, later, `installer-brew`, which only say what to run |
| `ServiceManager` | `services()`, `stop(s)`, `start(s)`, `active(s)`, `restarts(s)`, `runApply(version)` (outside every service it may stop) | `services-systemd-user`, `services-launchd`, `services-none` (stages only, and says so) |
| `RoleProbe` | `safePoint(s)`, `health(s)` | `probe-hub` (`GET /api/health`), `probe-fleet` (`GET /v1/health` on its socket), `probe-node` (`status.json`) |
| `SchemaInspector` | `read(db)`: schema version and floor, opened read-only | `schema-sqlite` |
| `Backup` | `take(db, dest)`, `check(dest, schema)`, `restore(dest, db)` | `backup-sqlite` (the online backup API through better-sqlite3, `quick_check`, and a restore that removes a stale `-wal` and `-shm` first) [U20] |
| `FleetView` | `controlPlane()`: its Version and Rollout state; `nodes()`: each joined node's Version, protocols and status | `fleet-socket` (the client API, on the control plane), `fleet-status` (on a node, from what the agent's welcome said) |
| `UpdateStore` | load and save the Installation and an Update's step record, one transaction per step; take and hold the apply lock | `store-sqlite` (`update.db`, `synchronous=FULL`; its migrations are additive forever, so any older updater can open it; `apply.lock`) |
| `Clock` | `now()` | the system clock; a fake in tests |
| `AlertSink` | `raise(alert)`, `notice(kind, detail)` | fleet Alerts (new kinds, section 12), the hub's notice, a log line |

### 4.7 Where the code lives, and the tests that hold the layers

```
packages/domain/src/releases.ts       Version, Channel, Key set rules, Feed rules, Installation, Update, Rollout,
                                      Migration plan, the gates and RL1–RL14. Pure.
packages/protocol/src/releases.ts     zod schemas: key set, feed, manifest, file list, health and safe-point shapes,
                                      the update operation; the words the CLI and the web app share.
apps/updater/src/application/         UpdateService, RecoveryService, RolloutService, DoctorService; ports.ts.
apps/updater/src/adapters/            the adapters above.
apps/updater/src/cli.ts               `morndo update`, `morndo doctor`: the composition root.
.github/workflows/release.yml         build, sign, attest, publish, feed (section 9).
scripts/release/                      the manifest, file-list and feed tools CI and the e2e both use.
install.sh                            the first install, POSIX sh, signed per release.
```

Architecture tests, each with negative controls, in the style of the existing ones:
1. `packages/domain/test/architecture.test.ts`, unchanged: `releases.ts` imports only siblings, and uses no `crypto`, `process` or `Date.now`.
2. New `apps/updater/test/architecture.test.ts`: the application layer imports only the domain, the protocol and its siblings, and uses no Node global. Only `verifier-sshsig.ts` imports `node:crypto`. **Nothing in `apps/updater` imports `@morndo/node-ops`**, which holds the tmux code, so the updater can't touch tmux itself; the `tmux_in_unit` check before every stop (RL13) covers what a stop could do to it. No other app imports `apps/updater`: the hub runs the program, as it runs the engines CLI.
3. New `packages/protocol/test/releases-wire.test.ts`: every schema validates the files the release tools write, and an unknown field is refused.

### 4.8 Context map

- **Releases stands beside the Fleet** (customer and supplier). It reads the control plane's Version and each node's Version and protocols through the client API, and raises its Alerts there. The Fleet carries one new typed operation, `update.apply { version }`, with a key and no command line (FL14). A node's policy may deny it.
- **Access decides who may ask.** "Update now", "Roll back", a Channel change and turning automatic updates on or off from the web app are principal Commands (AC7, with step-up).
- **How the hub asks.** On the control plane the hub runs `morndo update` with an argument list and no shell (`execFile`), as it runs the engines CLI (ADR-0013), and reads `--status --json` the same way. For a node it sends `update.apply` through the fleet. Either way the apply runs in its own unit, never inside the hub.
- **Releases grants nothing** (RL13): no Mandate, Decision, Acknowledgement or Verdict.
- **Steering and the Fleet keep RL9 and RL10.** The `updating` refusal and the hub's store id are Steering's (amending S5 and S7); the revocation journal is Access's and the Fleet's (AC4, FL4). Releases decides when they apply; those contexts enforce them.
- `docs/domain.md` gets a Releases section, these amendments and this context map entry in PR 1.

## 5. Install layout

Every path derives from `HOME` and follows the XDG base directories: data under `~/.local/share`, state under `~/.local/state`, configuration under `~/.config`, and "user-specific executable files may be stored in `$HOME/.local/bin`" [U25]. No root is needed.

| Path | What |
|---|---|
| `~/.local/share/morndo-releases/<version>/` | One installed Version: `node/` (the bundled runtime), `app/` (the program, the built web app and its production dependencies), `bin/` (the launchers), `units/` (service templates), `trust/` (the Key set it shipped with), `files.json` (every file with its mode and SHA-256) and `install.json` (how and when it was installed). Read-only once promoted: directories 0555, files 0444 or 0555. |
| `~/.local/share/morndo-releases/current` | A link to the running Version. Replaced only by `rename(2)`, which is atomic: "there is no point at which another process attempting to access newpath will find it missing" [U16]. |
| `~/.local/share/morndo-releases/previous` | A link to the Version before `current`: the one `--rollback` returns to. |
| `~/.local/share/morndo-releases/good` | A link to the last committed Version: set at install and at each commit, never during an apply. Recovery runs this code (section 6.6). |
| `~/.local/share/morndo-releases/.staging-<version>/` | A Version being unpacked and checked. Never run, and removed on any failure. |
| `~/.local/bin/morndo`, `morndo-fleet`, `morndo-node`, `morndo-job`, `morndo-board`, `morndo-keys` | Links to `../share/morndo-releases/current/bin/<name>`. |
| `~/.config/morndo-update/config.json` | The update settings (section 8.3). |
| `~/.local/state/morndo-update/update.db` | The Installation and each Update's step record, with a format number. |
| `~/.local/state/morndo-update/apply.lock` | The lock an apply holds for its whole life (RL4): an exclusive SQLite lock, which the operating system releases when the process dies. |
| `~/.local/state/morndo-update/downloads/` | Artifacts being fetched. Removed after staging or on failure. |
| `~/.local/state/morndo-update/backups/<update-id>/` | Backups, mode 0600 in a 0700 directory. |
| `~/.local/state/morndo-update/applying` | Present from the drain until the Update commits or is abandoned. The recovery unit runs only while it exists. |
| `~/.local/state/morndo-update/hold.json` | Present while services must refuse writes: during the drain before a stop, and during a probation that holds writes (RL9). Names the services, the reason, the Version and since when. Each service reads it every second, and reports what it still has in flight in its health answer. A hold older than 10 minutes is ignored, with an Alert, so a dead updater can't hold a service forever. |

Data stays where it is today: the hub's `~/.local/share/morndo`, the fleet's `~/.local/share/morndo-fleet`, the agent's `~/.local/state/morndo-node`, the connections store and vault. An Update never moves them, and never touches a key file: the hub identity, the fleet key, a node key, the vault and its identity (RL13). All of these, the releases and the update state included, are already under the node's deny roots (`~/.local/share/morndo*`, `~/.local/state/morndo*`, `~/.config/morndo*`), so no file operation through the fleet can read or write them.

**Launchers resolve `current` once, at start.** `bin/<name>` takes the real path of its own directory and runs that Version's `node/bin/node` on that Version's `app/`. Node resolves modules by real path, so a running process never mixes two Versions, even when `current` changes under it. `prune` never deletes a Version a running Morndo process uses.

**Nothing outside the install names a Version's own path.** The keys helper that Claude Code and Codex call (ADR-0018) is written as the stable launcher `~/.local/bin/morndo-keys`, not as a Version's runtime and `main.ts` (PR 0). Otherwise a lane started before an update would keep calling a directory that `prune` later deletes, and lose its key.

**Which Version's updater runs what.** The tick, `morndo update` and the boot unit run from `current`, resolved once; an apply runs from the `current` it started with, so the old Version applies the new one. Recovery runs from `good`.

**Services** (rendered from the Version's `units/` at install and at every swap):

| Linux (systemd user units) | macOS (launchd agents) | Runs |
|---|---|---|
| `morndo-hub.service`, `morndo-fleet.service`, `morndo-node.service` | `com.morndo.hub`, `com.morndo.fleet`, `com.morndo.node` | the services of this machine's roles, from `current`. `Restart=on-failure` with `RestartPreventExitStatus=78` [U18]. On macOS `KeepAlive` with `SuccessfulExit` false restarts a job that exits non-zero, at most once every 10 seconds [U19], and launchd has no equivalent of `RestartPreventExitStatus`: the launcher there turns an exit 78 into a status file and exit 0, so a setup to fix isn't restarted forever. |
| `morndo-update.timer` and `morndo-update.service` | `com.morndo.update` | `morndo update tick` at boot and every 6 hours, with a random delay of up to an hour: check, stage, and apply at a safe point. |
| `morndo-update-boot.service`, ordered before the services | none (launchd has no ordering) | applies a staged Version before the services start (section 6.7). |
| `morndo-update-recover.service`, at boot after the services, and from `morndo-update-recover.timer` every 5 minutes | `com.morndo.update-recover` (`RunAtLoad`, every 5 minutes) | `morndo update recover`, run from `good` (section 6.6). On Linux it runs only while `applying` exists (`ConditionPathExists=`); on macOS it is a quick no-op otherwise. |
| `morndo-update-apply@<version>.service` | `com.morndo.update-apply` | one apply, started by the tick, by `morndo update`, or by the `update.apply` operation, so that no service it stops is its parent. |

`loginctl enable-linger` keeps the user manager up after logout [U18], as ADR-0017 already requires for jobs.

## 6. One machine: how an update runs

### 6.1 Check and stage (any time, in the background)

1. **Check.** Fetch the Key set, then the Channel's Feed. Verify both (RL3). Decide with `admit` (RL2, RL12, RL14, and the bad Versions). Nothing on disk changes.
2. **Download.** The Artifact for this platform, at most the Manifest's size, with a timeout. Free space must cover the download, the unpacked tree and every database that will migrate, with a margin; otherwise the Update is deferred with an Alert.
3. **Verify** (RL1, in the order of section 10.2).
4. **Unpack** into `.staging-<version>`, check every file against the signed list, and refuse anything extra, any path outside the directory, any link pointing outside, and any device file. Modes are masked; no setuid bit survives.
5. **Self-test** with the staged runtime: every entry point loads, the native module opens a database in memory, and each program prints the staged Version.
6. **Promote**: rename `.staging-<version>` to `<version>` and make it read-only. UpdateStaged.

### 6.2 Apply (at a safe point)

| Step | Recorded before | What happens |
|---|---|---|
| 1. Plan | | Take the apply lock (RL4). Read each database's schema and floor, read-only. Compute the Migration plan from the Manifest. Run `admit` and `skew` again on fresh data. |
| 2. Wait | | Until `safeToApply` (RL6, section 6.3). A wait that outlasts the window defers to the next one. |
| 3. Drain | `draining` | Write `hold.json` (reason: drain). Each service refuses new side-effecting requests as `updating` (nothing ran) and finishes what is in flight. When every service reports nothing in flight, check the safe point again and read each service's health: the baseline. Not drained within 30 seconds: remove the hold, and defer. |
| 4. Stop | `stopping` | Stop the services in the order hub, node, fleet. Each stops on SIGTERM, closes its database and exits 0 (PR 0). |
| 5. Back up | `backing_up` | Every database the target will migrate (RL5). A failure abandons: start the services again on the old Version. |
| 6. Swap | `swapping` (with the pre-update `current` and `previous`) | Render the target's units and reload the service manager. Point `previous` at the old Version first, then `current` at the target: each time write a new link beside it, rename it over the old one, and sync the directory. A crash between the two renames leaves both links on the old Version. |
| 7. Start | `starting` | Rewrite `hold.json` for probation if RL9 applies, or remove it. Start fleet, node, hub. Each runs its own migrations at start, as today. |
| 8. Health | | Each service must pass its checks at the target Version within 90 seconds (section 6.4). |
| 9. Probation | | The services must stay up for 60 more seconds, with no restart. |
| 10. Commit | `committing` | Remove `hold.json` and `applying`, point `good` at the target, record the commit, prune old Versions (keep `current`, `previous`, `good`, and any in use), and prune Backups older than the last three committed Updates. Release the lock. |

A rollback (section 6.5) replaces steps 9 and 10 when step 8 or 9 fails.

### 6.3 Safe point, per service

A service reports blockers. The machine is at a safe point when no service on it reports one. A blocker is work in flight in the running process, never a row a crash left behind: S5 and FL7 already answer those `uncertain`, and counting them would block updates for days.

| Service | Blockers | Why |
|---|---|---|
| hub | a Command or Decision being typed right now; a pairing being redeemed right now | a restart in the middle would leave it `uncertain` (S5) |
| fleet | an operation in flight on the client API | the caller would see `uncertain` |
| node | a keyed operation in flight; a bulk transfer; a job running under the child supervisor (it would die and be reported `lost`); the tmux server inside the agent's unit (`tmux_in_unit`; every Release includes PR 0, so this is a second guard) | FL7; ADR-0017; RL13 |
| hub, automatic Updates only | the principal is attending on some Endpoint (N3); the hub already keeps the last activity per Endpoint (H4) | a hub restart while the principal is steering interrupts them; a node's restart doesn't reach the app |
| all, automatic Updates only | outside the window, if one is set | the principal's own choice |

Activity-based timing has a precedent: Tailscale's automatic updates are "automatically scheduled around each node's activity to minimize disruption" [U23]. A lane that is merely busy is not a blocker. Restarting the agent leaves tmux and the agents running; for the few seconds the relay is down, Claude Code's HTTP hooks fail without blocking the session (fleet core §5.5), progress events are coalesced anyway, and the script hooks' fallbacks run.

### 6.4 Health, per service

Read from outside the service, never taken from its own word alone:

| Service | Checks |
|---|---|
| hub | `GET /api/health` on 127.0.0.1 answers 200 with `{ version, schema, ready: true }`; the version is the target's; the schema is the target's for its database; the fleet socket answers, if it did before. A request that came through the network proxy (it carries the proxy's headers) gets `ready` only, without the version, unless it has a session. |
| fleet | `GET /v1/health` on its socket answers with the target's version and schema; the control plane's own node reconnects, and so do most of the nodes connected at the baseline, within the deadline (agents retry from 1 second with jitter). One laptop that went to sleep must not roll back the control plane. |
| node | `status.json` names the target's version; the relay answers on its port; the fleet handshake ends in `welcome` if it did before. A close with 4426 fails the check (the Version caused it); an unreachable fleet fails it only if the fleet was reachable before. |

A check that failed before the Update is not held against the target (RL7: only checks that passed before must pass after). Each failure names its service and check in HealthFailed.

### 6.5 Rollback

1. Record `rolling_back`. Stop the target's services. If the tmux server sits inside the agent's unit, the agent is not stopped: that node's rollback waits, with a critical Alert (RL13).
2. Swap back to the recorded pre-update pair, `current` first, then `previous` (so a crash in between leaves both on the known-good Version), and render that Version's units.
3. For each database the previous Version can't open (its floor is now above what that Version knows, RL8), restore the Backup: copy it beside the database, sync, delete the database's `-wal` and `-shm`, and rename the copy over it. A database the previous Version can still open is left alone, with everything written since.
4. Start, and run the previous Version's health checks against the same baseline.
5. Healthy: RolledBack, an Alert, the target marked bad on this machine, and the Rollout halted (RL12). Not healthy: RollbackFailed, a critical Alert, and the updater stops.

### 6.6 After a crash or a power loss

The record says where the Update stood (RL4). Whatever runs next (the recovery unit at boot or every 5 minutes, the next tick, or `morndo update`) first takes the apply lock; while an apply holds it, nothing else acts. Then it takes this table:

| Last record | What happens |
|---|---|
| nothing started, or `draining`, `stopping` or `backing_up` | Abandon: remove the hold, start the services on the old Version. Keep the staged Version and drop the partial Backup. |
| `swapping` | Read `current`. Still the old Version: abandon. The target: carry on as `starting`. |
| `starting`, no commit | The services start (they may already be running). Judge health against a fresh deadline: healthy through probation, commit; otherwise roll back. |
| `rolling_back` | Carry on with the rollback. Every step can be repeated safely: the swap writes the recorded pair, and a restore renames a checked copy. |
| `committing` or later | Finish the commit. |
| a record format or step this Version doesn't know | Act on nothing. Raise a critical Alert naming the step, and leave the services to the service manager. |

Recovery runs from `good`, the last committed Version, because that code has passed its health checks on this machine, and the target's might be what is broken. `good` exists from the first install, so a crash during the first update is recovered too. The record carries a format number and its step names only grow; `update.db`'s migrations are additive, so `good` can always open it, and a step it doesn't know stops it rather than letting it guess. This is the pattern of systemd's automatic boot assessment: a new entry has a number of tries, is marked good once boot completes, and otherwise is "considered 'bad'" and the previous one is used [U18].

### 6.7 On the next start

Claude Code's promise is that the next start runs the new Version [U1]. For services the next start is usually a reboot. On Linux, `morndo-update-boot.service` runs before the services when a Version is staged, automatic updates are on and there is no pin:
- It takes the apply lock, fetches the Feed again and runs `admit` (withdrawn, halted, bad here). Without a network it doesn't apply.
- **Only on a machine that is its own control plane.** A node can't know at boot whether its control plane still runs the target or has halted the Rollout (RL11, RL12): its agent isn't connected yet. So a node applies through the tick, once its agent has connected and the fleet's view is less than 10 minutes old.
- It records the same marks as section 6.2 (`backing_up`, `swapping`, `starting`), writes `hold.json` when RL9 applies, then backs up and swaps while nothing runs: a safe point by construction.
- The services then start on the new Version. The recovery unit, ordered after them, judges health and commits or rolls back as in section 6.6. With nothing running to read a baseline from, the baseline is the health recorded at the last commit.

launchd has no ordering, so on macOS the staged Version applies at the first safe point after login.

## 7. A fleet: order, skew and the protocol window

**Order: the control plane first, then the nodes.** Kubernetes' version skew policy is the precedent: "`kubelet` must not be newer than `kube-apiserver`", and the API server is upgraded first [U21].

1. The control plane machine updates first, as one Install: fleet, hub, and its own node together.
2. Its commit starts the soak: 30 minutes by default.
3. Each node applies once the control plane runs the target or newer (RL11), the Rollout isn't halted (RL12), the soak has passed, and after a random delay of up to 15 minutes, so two nodes rarely restart at once.

A node learns the control plane's Version and the Rollout's state from the fleet's `welcome` and a new `rollout` event (optional fields: protocol 1 still parses). It reports its own update state in its `health` message (optional fields too).

**Skew rules.**

| Pair | Allowed | Outside it |
|---|---|---|
| node and control plane | node ≤ control plane. The agent protocol: the current and the previous version, as today. | A node never applies a Version newer than its control plane. A node two protocol versions behind is refused with 4426, keeps its lanes running and retries hourly; the hub marks it "needs update". |
| hub and fleet | One Install on one machine (the hub reaches the fleet over a Unix socket), so one Version. The client API also accepts the previous version, which covers the seconds between their restarts. | none |
| web app and hub | The same Release. The hub accepts the previous Release's web app: the protocol package only adds optional fields from one Release to the next, and removing one takes two Releases, as the agent protocol does. | An open tab sees `updated` and offers a reload (below). |

**Changing the agent protocol takes two Releases.** Release A speaks N and N+1. Release B drops N. The control plane defers B, naming the nodes, until every joined, non-revoked node reports A or newer (RL11). `manifest.protocol` carries each Release's range, so the check needs no knowledge of what changed.

**A bad Release.** When one machine rolls back, the Rollout halts and no other machine takes that Version automatically (RL12). The hub shows which machine failed and which check. `morndo update --resume-rollout <version>` or a newer Release continues. The maintainers can withdraw a Release in the Feed: machines stop being offered it, and machines already on it are told and stay (RL2). The fix goes out as a new Release.

**The web app.** The build sets SvelteKit's `version.name` to the Release. SvelteKit "polls for new versions on an interval and sets `updated.current` to true when it detects one", and also checks when the tab regains focus [U22]. The app then shows "Morndo was updated · Reload" and does a full-page load on the next navigation, as SvelteKit documents. Commands waiting in the outbox survive the reload (S4).

## 8. What the user sees

### 8.1 One command

```
$ morndo update
Morndo 0.4.3 → 0.5.0 (stable, published 2026-11-02)
  Notes: https://github.com/morndo/morndo/releases/tag/v0.5.0
  Verified: feed 42 (expires 2026-11-16), manifest signed by release key SHA256:Qm…, artifact digest matches
  Databases: hub 17 → 19 (the old version can still read it); fleet 14 → 15 (backup first: the old version can't read it)
  Safe point: yes
Apply now? Morndo's services restart for a few seconds; lanes keep running. [y/N] y
  stopped hub, node, fleet · backed up fleet.db (quick_check ok) · switched to 0.5.0
  started fleet, node, hub · healthy after 6 s · probation 60 s · committed
Morndo is on 0.5.0. 0.4.3 stays installed for `morndo update --rollback`.
```

| Command | Does |
|---|---|
| `morndo update` | Check, show what would change, and apply after a yes (`--yes` for scripts). Waits for a safe point, up to `--wait <minutes>`. |
| `morndo update --check` | Check and stage only. Prints what is available. |
| `morndo update --now` | Apply without waiting for the principal to stop attending or for the window. Still waits for in-flight work (RL6). |
| `morndo update --to <version>` | A named Version that a verified Feed lists, on either Channel or among its pre-releases (RL1). Lower than the current one only with `--allow-downgrade`, which shows the Backup it would restore and what that drops (RL2, RL8). |
| `morndo update --rollback` | Back to `previous`, the same way (RL8). |
| `morndo update --channel stable\|latest` | Switch the Channel. Never downgrades: on a newer `latest` build, the machine waits until `stable` catches up (RL2). |
| `morndo update auto apply\|stage\|off` | Set the mode (section 8.3). |
| `morndo update pin <version>`, `unpin` | Hold this machine at a Version. |
| `morndo update --status [--json]` | Channel, mode, pin, current, previous, staged, the last check and its result, the Feed's number and expiry, the Key set's version and expiry, and the last ten Updates with their steps and times. |
| `morndo update --resume-rollout <version>` | Lift a halt (RL12). |
| `morndo doctor` | Re-verify the installed tree against its signed file list, and check the layout, the units, lingering, the tmux placement, the Feed's freshness and free space. |

### 8.2 Notices

- **Before.** Home, on the phone and the desktop: "Morndo 0.5.0 is ready. It installs at the next quiet moment. Notes · Update now". On a fleet, one line per machine that waits, with its reason ("waiting for the control plane", "a job is running").
- **After.** "Updated to 0.5.0 · What's new", once.
- **On failure.** A rollback, a failed verification, a stale Feed or an expired Key set is a fleet Alert, so it shows in Activity like any other ("The update to 0.5.0 was rolled back on node-b: node health (fleet connection) failed. Still on 0.4.3.").
- **No push.** An update is not a Decision. N1 and N2 are unchanged.
- **Settings → Updates** (phone and desktop): each machine's Version, Channel, mode and state (up to date, staged, waiting and why, rolled back, needs update), with "Update now", "Roll back", the Channel and the mode. Each is a principal Command with step-up (AC7), carried to a node as `update.apply`.

### 8.3 Settings and switches

`~/.config/morndo-update/config.json`, written by the commands above:

| Field | Default | Meaning |
|---|---|---|
| `mode` | `apply` (Q1) | `apply`: stage in the background and apply at a safe point. `stage`: stage in the background; apply with `morndo update` or at the next boot. `off`: no background checks. |
| `channel` | `stable` (Q2) | `stable` or `latest`. |
| `window` | none | Local hours for automatic applies, such as `"02:00-06:00"`. Without one, any safe point. |
| `pin` | none | A Version this machine stays at. |
| `soakMinutes` | 30 | On the control plane: how long nodes wait after it commits. |

| Variable | Effect |
|---|---|
| `MORNDO_DISABLE_AUTOUPDATE=1` | As `mode: off`, whatever the file says. `morndo update` still works. |
| `MORNDO_DISABLE_UPDATES=1` | Every update path refuses, `morndo update` included. For installs managed by other tooling. |
| `MORNDO_UPDATE_FEED` | Another feed address, such as a mirror. Signatures, not the address, decide what is trusted, so a mirror can't change what installs. |

### 8.4 Exit codes

As in the rest of Morndo (sysexits.h): 0 updated or already current; 1 failed and rolled back; 70 the rollback failed too (EX_SOFTWARE); 65 a verification failed (EX_DATAERR); 75 deferred: no safe point, skew, halted, or low disk (EX_TEMPFAIL, try later); 78 nothing to do here: an install the updater didn't make, updates disabled, no service manager (EX_CONFIG).

## 9. Release pipeline

### 9.1 Versions

- **SemVer 2.0.0, one Version for the whole product** [U4]. The root `package.json` holds it. The workspace packages stay private and unversioned, and every program reports the root Version (today the agent reads its own `package.json`).
- **The build stamp.** The Release build writes `app/build.json` (`{ version, commit }`, the Release's Version and the commit it was built from) into the tree before `files.json` is made, so it is signed with the rest. Every service reads it at start and reports it: the node agent's `hello` (`agent.commit`), the fleet's `/v1/nodes` (`commit`, from the live connection, `null` while offline or for an older agent), `/api/health` and `/v1/health`, and `--version` (`0.1.0+<12 characters of the commit>`). An unstamped checkout reports the root `package.json` version and its git `HEAD`; a tree with neither reports the Version alone. A stamp that is not a SemVer Version and a 40-character commit is ignored.
- **Before 1.0.** The first Release is 0.1.0. "Anything MAY change at any time" under 0.y.z [U4]. While 0.x, a breaking change bumps the minor, as a feature does, and a fix the patch (Release Please's `bump-minor-pre-major` [U5]). Release notes name every breaking change, whatever the number says.
- **What counts as breaking:** a CLI command or flag removed; a configuration field that changes meaning; an agent protocol or client API version dropped (only after the two-Release step of section 7); anything that needs a manual step on an existing install. A raised Schema floor is not breaking for users: it limits downgrades and always comes with a Backup.
- **Pre-release versions** (`0.5.0-rc.1`) are offered on no Channel. `latest.json` lists them under `prereleases`, so `--to` can install one by name.

### 9.2 Release PR and tag

Release Please, in manifest mode [U5]:
- It "maintains Release PRs" from Conventional Commits, which this repo already uses: `fix:` bumps the patch, `feat:` the minor, `feat!:` the major, with `bump-minor-pre-major` while 0.x.
- One component at the root, with a `CHANGELOG.md`. The action's current major is v5 [U5]; pinned by commit like every action here.
- Merging the Release PR tags the commit and creates the GitHub Release as a draft (`"draft": true`). GitHub's guidance for immutable releases is to create a draft, attach the assets, then publish [U8]. GitHub creates no tag for a draft until it is published, which would hide the previous release from Release Please, so `"force-tag-creation": true` creates the tag at once [U5].
- A tag or PR made with the workflow's `GITHUB_TOKEN` starts no new workflow run [U5, U9], so the build, sign and publish jobs run in the same workflow, after the Release Please job, when its `release_created` output is true. CI on the Release PR itself waits for an approval, which is how GitHub treats a PR opened by that token [U9].
- Merging the Release PR publishes something public, so it stays the owner's.

Changesets was considered: contributors write a changeset file per change, and its action opens a "Version Packages" PR and publishes to npm [U6]. It fits a set of npm packages. Morndo is one product with one Version and already writes Conventional Commits, so Release Please fits with nothing new for contributors.

### 9.3 Build

A matrix job per platform (`linux-x64`, `linux-arm64`, `darwin-arm64`) on that platform's runner (the exact runner labels are pinned in PR 3):
1. Check out the tag with `persist-credentials: false`.
2. Fetch the pinned Node 24 LTS release for the platform and verify it the way Node documents: `SHASUMS256.txt.asc`, checked with `gpgv` against the `nodejs/release-keys` keyring pinned by commit, then `shasum --check` [U15]. Node 24 is supported until 2028-04-30 [U15].
3. `npm ci` with that runtime, run the unit tests with it, build the web app, then keep production dependencies only. The native module is built or fetched for that platform and that Node.
4. Assemble `node/`, `app/`, `bin/`, `units/`, `trust/`, the licences and third-party notices; write `files.json`.
5. Self-test the assembled tree, as on the user's machine (section 6.1, step 5).
6. Pack with a fixed file order, owner and timestamp (from the tag's commit time), so a rebuild can be compared.

The bundled runtime adds about 27 to 32 MB per platform, compressed (Node 24.21.0's archives [U15]). Morndo then chooses its own Node, the native module always matches it, and a Node security release becomes a Morndo patch Release (a scheduled job compares the pinned Node with Node's release index). Q5 asks whether to bundle it.

### 9.4 Sign, attest, publish

A job in the GitHub environment `release`. With required reviewers, "a job cannot access environment secrets until one of the required reviewers approves it", and on the free plan that is available for public repositories [U10].

1. Compute each Artifact's size and SHA-256, and write `manifest.json` (section 9.6) and a plain `SHA256SUMS`.
2. Sign `manifest.json` and `install.sh` with the release key: `ssh-keygen -Y sign -n release@morndo.github.io` [U13]. The key comes from the environment secret, lives in a 0600 file on the runner for the length of the step, and is deleted after it.
3. Attest build provenance for every Artifact, the Manifest and `install.sh` with `actions/attest` (v4.2.2 on 2026-10-11; `attest-build-provenance` is now a wrapper on it) [U7]. The job needs `id-token: write`, `attestations: write` and `contents: read`. On its own this gives SLSA v1.0 Build Level 2, and a reusable workflow can reach Level 3; public repositories sign through Sigstore's public-good instance [U7].
4. Upload the assets to the draft, then publish it. Immutable releases are turned on for the repository: "the assets and associated Git tag cannot be changed after publication", and a deleted release's tag can't be reused [U8].
5. Check what was published, from outside: download the assets again, `ssh-keygen -Y verify` the Manifest and `install.sh`, `gh attestation verify <file> --repo morndo/morndo --signer-workflow <release workflow>` [U7], and `gh release verify-asset` [U8].

Release notes are the Release Please changelog, plus an upgrade section generated from the Manifest: which databases migrate, which raise their floor (so a later rollback restores a Backup), and the protocol range.

### 9.5 Channels: the feed, promotion, withdrawal

- **Publishing.** After a Release publishes, a job in the environment `feed` adds it to `latest.json`, raises the Feed's number, sets its expiry 14 days ahead, signs it with the feed key, and publishes it to the feed host (Q4).
- **Re-signing.** A weekly scheduled job re-signs both Feeds with a new number and expiry, and nothing else, so a machine that keeps seeing an old Feed knows within 14 days that something holds updates back (RL3).
- **Promotion to `stable`.** A manual workflow adds a Release to `stable.json` once it has been on `latest` for at least 7 days and isn't withdrawn. A job gets one environment, and signing needs the feed key, so the workflow has two jobs: an approval job in `release` (it uses no secret; it is the owner's gate), then the signing job in `feed`, which runs only after it.
- **Withdrawal.** The same workflow can mark a Release withdrawn in both Feeds.
- **Token permissions.** The workflow token stays read-only by default, as `docs/public-repo.md` sets it. Only the jobs that need more ask for it, at job level: Release Please (`contents: write`, `pull-requests: write`), the publish job (`contents: write`, `id-token: write`, `attestations: write`) and the Pages deploy.
- **Why not GitHub's "latest release".** `/releases/latest/download/<asset>` follows "the most recent non-prerelease, non-draft release" [U9]: one stream, no channels, no expiry, nothing signed about freshness. The REST API's unauthenticated limit is 60 requests an hour per address [U9]. The bootstrap uses the `latest/download` link to find `install.sh`; the updater uses the signed Feeds.

### 9.6 Formats

Three signed documents, each a JSON file with an SSH signature beside it (`.sig`), each signature under its own namespace. They map onto TUF's top-level roles [U3]:

| Document | Signed by, namespace | TUF role it stands for | Expiry |
|---|---|---|---|
| `keys.json`: `{ schema: 1, version, expiresAt, root: [keys], release: [keys], feed: [keys] }` | root, `keys@morndo.github.io` | root: "delegates trust to specific keys trusted for all other top-level roles" | 1 year |
| `manifest.json`, per Release | release, `release@morndo.github.io` | targets: "signs metadata that describes these files" | none (immutable Release) |
| `stable.json`, `latest.json` | feed, `feed@morndo.github.io` | snapshot and timestamp, merged: the current set and its freshness | 14 days |

```json
{
  "schema": 1, "product": "morndo", "version": "0.5.0", "commit": "<40 hex>",
  "publishedAt": "2026-11-02T10:00:00Z",
  "notes": "https://github.com/morndo/morndo/releases/tag/v0.5.0",
  "protocol": { "agent": [1, 2], "clientApi": [1] },
  "schemas": { "hub": { "version": 19, "floor": 17 }, "fleet": { "version": 15, "floor": 15 },
               "node": { "version": 6, "floor": 3 }, "connections": { "version": 1, "floor": 1 } },
  "artifacts": [
    { "platform": "linux-x64", "name": "morndo-0.5.0-linux-x64.tar.gz",
      "size": 48210944, "sha256": "<64 hex>", "filesSha256": "<64 hex>", "node": "24.21.0" }
  ]
}
```

```json
{
  "schema": 1, "channel": "stable", "seq": 42,
  "issuedAt": "2026-11-02T10:05:00Z", "expiresAt": "2026-11-16T10:05:00Z", "keySetVersion": 1,
  "releases": [
    { "version": "0.5.0", "manifest": "https://github.com/morndo/morndo/releases/download/v0.5.0/manifest.json",
      "manifestSize": 2048, "manifestSha256": "<64 hex>" }
  ],
  "withdrawn": ["0.4.1"]
}
```

All values above are made up for the example.

Where this is lighter than full TUF, and why: one key per role (one maintainer, so no threshold above 1); no delegations; snapshot and timestamp merged into the Feed, because each Channel has one targets file per Release and nothing else to snapshot. `tuf-js` (6.0.0, MIT, from the TUF project [U24]) was considered and is the step if a second maintainer or a mirror network arrives: it brings real thresholds and delegations, at the cost of a dependency tree and metadata tools for every release, and a first install that can't be checked with tools already on the machine.

## 10. Security

### 10.1 Keys

| Key | Where it lives | Signs | If it leaks |
|---|---|---|---|
| root | Offline, with the owner (Q3) | the Key set, once at the start, then on rotation and before it expires | Full compromise. A new install with new pins, announced. The one key that must never be online. |
| release | The `release` environment's secret; used only after the owner approves the job (Q3) | each Release's Manifest and `install.sh` | Alone, it installs nothing: every install goes through a Feed entry signed by the feed key (RL1). With the feed key too, an attacker could ship a malicious Release. Mitigations: the approval gate, provenance attestations anyone can check against the workflow, and a new Key set (signed by root) that drops the key, which every machine fetches before it stages anything. A stolen release key can still fool a first install, which checks `install.sh` against it. |
| feed | The `feed` environment's secret; online, for the weekly re-sign | the Channel Feeds | An attacker can withhold updates or point a Feed only at Manifests the release key signed. RL1 stops anything unsigned, RL2 and RL3 stop a rollback, and expiry makes a freeze visible. Rotated by a new Key set. |

Both environments accept jobs only from `main` and `v*` tags ("Deployment branches and tags", available for every public repository [U10]), so a workflow changed on another branch can't reach either secret.

**Why SSH signatures.** All three formats considered use Ed25519. SSH signatures add two things for Morndo:
- **A first install checked with tools already on the machine.** `ssh-keygen -Y verify` ships with OpenSSH. It arrived in OpenSSH 8.1 (2019-10-09), then marked experimental [U13], and git's SSH commit signing runs it (`gpg.ssh.program` defaults to `ssh-keygen`) [U13]. minisign and cosign need their own install first [U11, U12].
- **A namespace in what is signed.** It "prevents cross-protocol attacks caused by signatures intended for one intended domain being accepted in another" [U13]: a feed signature can never pass as a release signature.

Checked on 2026-10-11 with OpenSSH 9.6p1 on this machine: a signature verifies (exit 0), and the same signature under another namespace, or over changed content, fails (exit 255) [U13].

**In the updater** the check is `node:crypto` alone: parse the armored blob (`SSHSIG`, version 1, public key, namespace, reserved, hash algorithm, signature), rebuild the signed data (`SSHSIG`, namespace, reserved, hash algorithm, H(message)), and verify Ed25519 with `crypto.verify(null, …)` [U13, U15]. Only `ssh-ed25519` keys and `sha512` are accepted. A contract test checks it against signatures made by the real `ssh-keygen`, in both directions.

**Provenance is separate.** GitHub's attestations (Sigstore, keyless, bound to the workflow) are for anyone who wants to check how an Artifact was built, and the release job checks its own [U7]. The updater doesn't depend on them: verifying a Sigstore bundle in Node means `sigstore-js` and, by default, network access to Sigstore's TUF repository [U11]. It is a candidate for a second, independent check later.

### 10.2 Order of checks before anything is unpacked

1. TLS with Node's default certificate checks. The updater refuses to run if `NODE_TLS_REJECT_UNAUTHORIZED=0` is set in its environment. TLS is a second layer; signatures decide.
2. The Key set: every version is published (`keys/<n>.json`), and the machine walks from its own version to the newest, one at a time, each signed by the previous version's root keys (and the new ones, if root changes); never a lower version. An expired Key set may still vouch for the next one; only the newest must be unexpired, as in TUF's client workflow for root [U3] (RL3).
3. The Feed: signature, namespace, Channel, expiry, number (RL3).
4. The Manifest: size and SHA-256 equal to the Feed entry's, signature, namespace, the Version equal to the Feed entry's (RL1).

Every download is capped before it starts: a Key set and a Feed at 64 KiB, a Manifest at the size its Feed entry names, an Artifact at the size its Manifest names.
5. The Artifact: the download stops at the Manifest's size; then size and SHA-256 (RL1). The TUF specification asks clients to cap downloads against endless-data attacks [U3].
6. Unpack into staging and match the signed file list (section 6.1, step 4).

Only after step 6 does anything from the Artifact run (the self-test).

### 10.3 First install without `curl | sh`

The README will say:

```sh
curl -fsSLO https://github.com/morndo/morndo/releases/latest/download/install.sh
curl -fsSLO https://github.com/morndo/morndo/releases/latest/download/install.sh.sig
echo 'release@morndo.github.io namespaces="release@morndo.github.io" ssh-ed25519 AAAA…' > morndo.allowed_signers
ssh-keygen -Y verify -f morndo.allowed_signers -I release@morndo.github.io -n release@morndo.github.io -s install.sh.sig < install.sh \
  && sh install.sh --role control-plane     # or --role node
```

- Nothing runs before it is checked, and a truncated download fails the check instead of running half a script.
- `install.sh` is only a bootstrap. It fetches the Manifest and its signature for its own Release and checks them with `ssh-keygen` and the same key. It then downloads that Artifact into a temporary directory, checks its size and SHA-256 (`sha256sum` or `shasum -a 256`), and only then runs the Artifact's own `morndo install`.
- `morndo install` reads the chosen Channel's Feed (`stable` unless `--channel latest`) and installs that Channel's Version through the full chain of section 10.2, fetching it if it isn't the bootstrap's own. A first install therefore lands on the Channel, not on whatever `/releases/latest` points to. It checks the file list, lays out section 5, writes the units, starts the services and runs the health checks.
- With the GitHub CLI there is a second, independent check: `gh attestation verify install.sh --repo morndo/morndo` [U7].
- The key line comes over HTTPS from GitHub, like the code itself. It is printed in the README, in every release's notes and in `SECURITY.md`, so a mismatch between them shows.

### 10.4 Threats and defences

| Threat | Defence |
|---|---|
| Arbitrary installation: a forged artifact or manifest | RL1, pinned Key set |
| Rollback: an old, vulnerable Release offered as new | RL2 (Version), RL3 (Feed number) |
| Indefinite freeze: an old Feed served forever | 14-day expiry, weekly re-sign, FeedStale (RL3) |
| Mix-and-match: a manifest from one Release with another's artifact | The Feed pins the Manifest's digest; the Manifest pins the Artifact's digest and file list |
| Endless data | The download stops at the Manifest's size |
| A key leaks | Section 10.1 |
| A malicious workflow change | The `release` environment's approval gate; actions pinned by commit (already done in this repo); no `pull_request_target`, no self-hosted runner (`docs/public-repo.md`) |
| A maintainer account taken over | Can approve the gate. Mitigated by the account's own two-factor sign-in; root stays offline. A stated limit. |
| Network attacker | TLS and signatures |
| A crafted archive (paths with `..`, absolute paths, links outside, devices, setuid) | Section 6.1, step 4; and only after RL1 |
| A same-user process edits the installed tree | Not prevented: the node is not an isolation boundary (ADR-0012). `morndo doctor` detects it against the signed file list. Read-only modes stop accidents only. |
| A same-user process adds or cuts lines in `revoked.log` | Accepted, the same residual: the journal is not signed. Such a process can revoke or un-revoke in the database itself as well. |
| A same-user process writes `rollback-confirmed` itself | Accepted, the same residual: it lets the rollback unit run without the typed word, which that process could have typed itself (`morndo update --rollback` takes it from any process of the user). The file is consumed on use, valid 10 minutes, for the running Version only, and voided when the unit fails to start. |
| A downgrade through the Channel or a withdrawal | RL2 |
| "Update now" used to push something | It is a principal Command with step-up; the operation names a Version only; the node still applies RL1 and RL2; a node's policy can deny `update.apply`. |

## 11. Migrations and data safety

### 11.1 Schema floors

- Each migration declares `compat: "additive"` or `"breaking"`. The floor of a database at schema N is the highest breaking migration at or below N.
- The runner keeps the floor in a one-row table (`_morndo_schema`), written in the same transaction as `user_version`. SQLite "makes no use of the user-version itself" [U20], so the meaning is ours.
- **Opening a newer database.** A service that knows schema K opens a database at schema N > K only if its floor is ≤ K. It then runs no migration and leaves alone what it doesn't know. Otherwise it refuses with exit 78, as now (RL8). The connections helper takes 78 on the same refusal (PR 2), so the code means one thing wherever a store is opened; its launcher maps a child's 78 to 1, keeping 78 its own.
- A database written before floors existed has no floor table, and counts as floor = its version: the old refusal, unchanged.
- **The one-time line.** Floors protect only builds that know them. Every build from before floors refuses a database above its list whatever the floor row says — the version alone is its rule — so the first floor-aware build opens databases those builds cannot, and a rollback that crosses from a floor-aware build to an older one restores a Backup instead of opening (RL8). The downgrade-contract tests hold the real previous build to this: the runner as it is on the branch's base, loaded from git.
- **The connections store stays additive.** It has no service to stop: its helper runs whenever an agent CLI needs a key, and migrates the store on open. A breaking migration there would leave lanes on the previous Version without keys after a rollback, so a test refuses one, and its Backup is taken with the online backup API while it may be in use; better-sqlite3 restarts such a backup when another connection writes meanwhile [U20].

### 11.2 What counts as additive

Additive: `CREATE TABLE` or `CREATE INDEX` (`IF NOT EXISTS`); `ALTER TABLE … ADD COLUMN` that is nullable or has a default. Every other change is breaking: `DROP`, `RENAME`, a table rebuild, a new `NOT NULL` without a default, a changed `CHECK`, and a column whose meaning changes. One more rule makes additive safe in both directions: new code must accept rows the old code wrote without the new column or table, since a rollback and a later update can put such rows there.

A test reads every migration marked additive and fails on a forbidden statement, with a planted `DROP` as its negative control. Review covers the meaning of a column, which no linter can see. Today's migrations are declared in PR 2; fleet migration 7 is breaking.

Capistrano, the common shape for versioned releases with a `current` link, keeps the old release on a failure and can flip back, but its docs say rollback "does nothing special with database migrations" [U17]. Floors and Backups are that missing part.

### 11.3 Backups

- Taken after the service stopped (RL5), with SQLite's online backup API through better-sqlite3, which makes "a bit-wise identical copy of the source database as it was when the copying commenced" [U20]. Then `PRAGMA quick_check` and the schema version are read from the copy, and the file and its directory are synced. (`VACUUM INTO` also makes "a consistent snapshot", but its copy "might be incomplete and corrupt" after a power loss unless `synchronous` is NORMAL or FULL [U20]; the backup API with an explicit sync is simpler to reason about.)
- Mode 0600, under `~/.local/state/morndo-update/backups/` (a deny root of the node's file rules). Key files are never copied: they don't change in an Update.
- A database the machine never made (no connections store yet, say) is backed up as absent: a marker, not a copy. Restoring it removes what the newer Version made since, so the Version that never had the file starts without it; every revocation in the removed file counts as one the restore would drop (RL10).
- Kept for the last three committed Updates, then deleted. Free space is checked first (section 6.1).

### 11.4 Restore

Only in a rollback that needs it (RL8), or by the principal's `--allow-downgrade`. The `-wal` and `-shm` beside the database are deleted before the checked copy is renamed into place: a restored main file next to a stale write-ahead log would be corrupt. After a restore of a Backup whose writes the target had already acknowledged (a rollback after commit), the command lists what is dropped (the time span, and counts per table where the service can tell) and asks for a typed confirmation.

### 11.5 Restores and things already done

- **Hub.** A restored database forgets the sends it typed after the Backup. So the hub's database gets a store id, renewed by every restore, and every answer names it. A device keeps the store it last saw and stamps each Command with it before the first attempt. The hub answers a Command stamped with another store, whose request id it doesn't hold, as `uncertain` and never types it (RL10). The device's clock plays no part (FL13). The one false `uncertain` is a Command first sent in the moments before the device heard of the new store, which errs the safe way: the principal checks and sends again.
- **Node.** A restored database starts a new store, and anything in doubt stays `uncertain` (FL7, the store sequence).
- **Fleet.** During a probation that may restore, the fleet acknowledges no hook events, so the agents keep them and send them again (RL9). After a manual restore post-commit, hook events acknowledged since the Backup are gone; the confirmation says so.
- **Revocations, in the hub and the fleet.** A revocation (`morndo revoke`, `morndo agent-token revoke`, `morndo-fleet node revoke`, or the same from the app) is appended, synced, to a journal beside its database (`revoked.log`) before the database write. Each service applies the journal at every start, idempotently. A restored database therefore can't bring back a revoked device, agent token or node (AC4, FL4), whoever restored it and however old the Backup. Details:
  - A node keeps its name across a revoke and a join again, so a node's entry names the enrolment it revoked (the join that made its key). A later enrolment under the same name is never revoked by an older entry.
  - A line the journal cannot read is skipped and reported (the fleet raises a `journal_unreadable` Alert; the hub logs it). The rest still applies, and the service starts. A last line cut short by a crash is skipped quietly, and the next append cuts it off.
  - Past 1 MiB, a start rewrites the journal with one entry per thing revoked.
  - The updater lets a restore drop only the revocations the journal will apply again: those the Version going back in applies journals for (a Version from before the journals applies none), and for a node, only the enrolment the Backup brings back.
  - The connections store has no journal: its revoked secrets and Connections still refuse a restore.
- **The hub's store id after a restore.** The updater's restore removes the store row from the copy before it renames it in, so the hub's next start makes a new store id even when the file lands on the inode it had. A file found under another inode (a restore by hand) gets one too.

### 11.6 Configuration files

The same rule as additive migrations: a new field is optional and has a default. An Update never rewrites a user's `config.json` or `policy.json`. The service units are the product's files, rendered from the Version at every swap and every rollback.

## 12. Observability

- `morndo update --status` and `--json` (section 8.1). `update.db` keeps every step with its start and end.
- Every service logs its Version at start and reports it in its health answer. The fleet already lists each node's agent and Claude Code versions.
- New fleet Alert kinds: `update_rolled_back`, `update_rollback_failed`, `update_verification_failed`, `update_feed_stale`, `update_keys_expiring` (30 days before), `update_skew_blocked`, `update_deferred` (no safe point for 3 days), `update_disk_low`, `rollout_halted`. They are audit rows, kept 90 days like every Alert.
- `update.started` and `update.committed` are audit rows, not Alerts.
- Logs go through the shared redacting logger. Keys appear only as fingerprints.
- Nothing is sent to the maintainers.

## 13. Test plan

**Unit (the domain, with a fake clock).**
- Version precedence over the SemVer specification's own examples, pre-releases and build metadata included [U4].
- One negative-control history per invariant, RL1 to RL14 (each turns off one guard and expects its test to fail), kept as data in `scripts/negative-controls.ts`.
- The Update's state machine: every state and event, allowed or refused.
- The recovery table of section 6.6: every last record, healthy or not.
- The skew table: node ahead, node behind, the two-Release protocol change, a halted Rollout.

**Contract (adapters against the real thing).**
- `verifier-sshsig` against real `ssh-keygen -Y sign` output made in the test with throwaway keys: good; wrong key; wrong namespace; changed message; cut armor; `sha256` hash refused; a key not in the set; a Key set rotation; a root change signed by only one of old and new root; a machine three Key set versions behind, across a root change, walking each one.
- `installer-dirs`: 10,000 swaps while another process resolves `current` in a loop and never finds it missing; `prune` never removes `current`, `previous`, `good` or a Version in use; staging leaves nothing after a failure.
- The apply lock: recovery started during a live apply (its probation included) acts on nothing; after the apply is killed, recovery takes the lock and acts.
- The keys helper after a swap and a prune: a lane started on A still gets its key through the stable launcher.
- `backup-sqlite`: a copy under a busy writer; `quick_check`; a restore with a stale `-wal` present.
- Schema floors on all four databases: a newer, compatible database opens without migrating; a breaking one is refused with exit 78.
- **Downgrade contract:** the previous Release opens a database migrated by the current code when the floor allows, and refuses it otherwise. Until the first Release exists, "previous" is a build of the parent commit.
- `feed-https` against a local HTTPS server with a test certificate authority; without it, the fetch fails.
- The role probes against the real services, in the existing fleet drill harness (`test/fleet`).

**End to end, upgrade and downgrade on a throwaway machine** (`e2e/update.e2e.ts` and a VM script):
1. Build Versions A, B (an additive migration) and C (a breaking one) from one tree, signed with test keys. Test keys are accepted only under `NODE_ENV=test` and a `HOME` that is not the account's own, as the agent's test hooks are.
2. Serve a local Feed. Install A by role: a control plane with its node, and a second node in another `HOME` and tmux socket. Start lanes; send Commands.
3. Publish B. The control plane updates first, the node after the soak (shortened for the test).
4. Lanes keep their pane process ids; each Command is typed once across the update; the data is there; the versions table is right.
5. `--rollback` to A: nothing restored, nothing lost.
6. Publish C with a health failure planted in it: an automatic rollback with restore. The databases equal their pre-update copies, no Command was typed during probation, and the Rollout is halted for the second node.
7. Revoke a device and a node while C is in probation, then let it roll back with restore: both stay revoked. A Command first sent before the restore and retried after it is answered `uncertain`.

**Fault injection** (each one a negative control too):
- A bad signature: an unknown key; the right key under the wrong namespace; a Feed signed with the release key.
- A truncated download: the server closes early; a size smaller or larger than the Manifest's (the download stops at the limit).
- A digest mismatch at the right size.
- An expired Feed; a lower Feed number; a lower Key set version; a Manifest digest that doesn't match the Feed entry.
- An archive with `../`, an absolute path, a link outside, a device file, or a file not in the list.
- A failed migration: B's migration throws, the service exits 78, health fails, rollback. The database is unchanged, since the migration ran in one transaction.
- A failed health check: B exits 1 at start; B reports the old version; B is ready and then crashes inside probation; B's node can't reconnect.
- **Power loss mid-swap:** kill the apply process with SIGKILL at every recorded mark (each step's started and done, from `draining` to `committing`, and the same through a rollback), then run recovery. The end state is A healthy or B committed, never a mix, and every database passes `quick_check`. On real hardware semantics, a VM hard reset during the swap (manual QA).
- The first update ever, killed at `stopping`: recovery from `good` starts the services again within 5 minutes.
- A full disk during the Backup (a small file system): abandoned before the swap, services back on A.
- Blockers: an operation in flight, a child-supervised job, tmux in the agent's unit. Each defers. A leftover `started` row from a crash blocks nothing. A drain that doesn't finish in 30 seconds lifts the hold and defers.
- Skew: a node whose control plane is older defers; a Release that drops a protocol an old node needs is deferred on the control plane, naming the node; a halted Rollout defers the other node; a node rebooting with B staged after its control plane halted B doesn't apply it.
- Health: one of three nodes asleep during the control plane's update doesn't roll it back; the control plane's own node not reconnecting does.
- A record format or step the recovering Version doesn't know: nothing acts, and a critical Alert names it.
- TLS: an untrusted certificate is refused; `NODE_TLS_REJECT_UNAUTHORIZED=0` stops the updater.

**The pipeline.** A tag in a private scratch repository produces assets that pass `ssh-keygen -Y verify`, `gh attestation verify --signer-workflow` and `gh release verify-asset`. The workflow logs pass gitleaks. Two builds of one tag produce the same file list, with the same digest for every file outside the native module; byte-identical archives are a goal, not a gate (native builds may differ, UNVERIFIED).

## 14. Manual QA checklist

Records go in the private QA notes, never in this tree.

1. A fresh throwaway VM (Linux x64): the verify-first install of section 10.3, by role; pair a phone; start two lanes.
2. Publish the next Version to a test Feed. Watch the notice; stop using the app; watch the automatic apply; compare `tmux list-panes -a -F '#{pane_pid}'` before and after; time the restart gap.
3. `morndo update` by hand: the prompt, `--check`, `--status`, `--json`.
4. `--rollback`, then update again.
5. A breaking Release with a planted health failure: the Backup, the automatic rollback, the Alert on the phone, the data unchanged.
6. Hard-reset the VM during the swap, three times at different points. After each boot: one Version, healthy, and the record shows the recovery.
7. Switch `latest` to `stable` while ahead: no downgrade; `--status` says it waits for `stable`.
8. Pin and unpin; `auto off`; `MORNDO_DISABLE_UPDATES=1` blocks `morndo update`.
9. Two machines: the control plane first; the node waits for the soak; a planted rollback on one node halts the other.
10. An old node at the previous protocol keeps working; a Release that drops that protocol is deferred on the control plane, naming the node.
11. Phone, Settings → Updates: the versions table; "Update now" asks for the passkey; "Roll back" lists what a restore drops.
12. By hand: `ssh-keygen -Y verify` and `gh attestation verify` on the real release assets; `morndo doctor` finds one changed file.
13. Uninstall: units and releases go, data directories stay, as documented.
14. macOS on Apple silicon (launchd): install, update, rollback, recovery after a forced logout.
15. Linux arm64: install and update.

## 15. Build plan: small stacked PRs

Each PR has its own tests and negative controls, and none changes a running system. A PR that changes a service also runs the fleet drills.

| PR | What | Done when |
|---|---|---|
| 0 | **Preconditions in the services.** The agent starts the tmux server outside its own unit when the user manager is usable (`systemd-run --user --scope` [U18]). The keys helper is written as the stable launcher, not a Version's own path. All three services read `hold.json`: they refuse new side-effecting requests as `updating` (503 with `Retry-After`; `executed: "no"` on the fleet) and report what they have in flight; on SIGTERM they finish it and exit 0. One Version, from the root `package.json`, in every program's `--version` and health. `GET /api/health` on the hub, `GET /v1/health` on the fleet, `version`, `ready` and the fleet state in the agent's `status.json`. | On a VM with a user manager: stopping `morndo-node.service` after the agent started tmux leaves every pane running, and the control (no scope) kills them. A hold refuses a send with 503 and the web app's outbox retries it. SIGTERM during a keyed operation finishes it and records `done`. The health shapes validate against the protocol schemas. Existing suites green. |
| 1 | **Domain and protocol.** `releases.ts` with RL1–RL14, the state machine, recovery, rollout and skew; `packages/protocol/src/releases.ts`; in `docs/domain.md` the Releases section, the context map entry, and the amendments to S5, S7, AC4 and FL4 that RL9 and RL10 need. | A negative-control history per invariant; the state, recovery and skew tables; the architecture tests, including "no `@morndo/node-ops` in `apps/updater`". |
| 2 | **Schema floors.** `compat` on every migration and the floor table in `service-kit`; every existing migration declared; the additive linter, with "additive only" for the connections store; the connections helper exits 78 on a newer database; the downgrade contract harness. | A newer, compatible database opens and a breaking one is refused, on all four databases; a planted `DROP` fails the linter; fleet migration 7 is breaking. |
| 3 | **The pipeline.** Release Please config and `CHANGELOG.md`; `release.yml` (the matrix with the verified bundled Node, deterministic archives, file lists, the Manifest, signing in `release`, attestations, draft then publish, the outside check); the Feed job and the weekly re-sign; `install.sh` and its signature; `scripts/release/`. | A tag in a private scratch repository yields assets that pass `ssh-keygen -Y verify` and `gh attestation verify --signer-workflow`; the logs pass gitleaks; the Feed number rises; the re-sign changes only number and expiry. |
| 4 | **Check and stage.** `apps/updater` with the feed, artifact, verifier, installer and store adapters; `morndo update --check`, `--status`, `--json`; `morndo doctor`. No service is restarted yet. | Every verification fault of section 13; RL1–RL3 end to end against a local HTTPS Feed; a failed staging leaves nothing; `doctor` finds a changed file. |
| 5 | **Apply on one machine.** The service manager adapters (systemd user units, launchd), the apply lock, the role probes, the safe point, drain, stop, back up, swap, start, health, probation, commit, rollback; the boot and recovery units; the hub's store id and the revocation journals (RL10); `morndo install` by role writing the units (the layout sub-project 3 installs). | The end-to-end run of section 13 on a throwaway VM; every crash mark; the first-update crash; the full disk; the failed migration; the failed health checks; revocations kept across a restore; a hard reset during the swap (manual QA). |
| 6 | **The fleet.** Control plane version and Rollout state in `welcome` and a `rollout` event; node update state in `health`; the node waits for its control plane; the protocol check; the halt; `update.apply` with step-up; Settings → Updates and the notices in the web app; the Alert kinds. | `fleet-two-node` extended: order, soak, halt, skew deferral; a web e2e for the Updates page; step-up required for every update Command. |
| 7 | **Defaults and the first Release.** The owner's answers to Q1–Q5; the promotion and withdrawal workflows; the install and update section of the README; the manual QA checklist on Linux x64, Linux arm64 and macOS. | The checklist done, with evidence in the private QA notes. The owner publishes the first Release. |

## 16. Limits, risks, and what would change this

- **One maintainer.** Every role has one key and a threshold of 1. A stolen root key is a full compromise. A second maintainer is the moment for thresholds and `tuf-js`.
- **Same-user trust.** Any process of the user can change the installed tree. `morndo doctor` detects it; nothing prevents it (ADR-0012's threat model).
- **The relay gap.** While the agent restarts, its hook relay is down for a few seconds. Progress events are coalesced anyway and script hooks fall back. Socket activation (systemd `.socket`, launchd `Sockets`) could hold the port across restarts; measured first in PR 5, adopted only if the gap matters.
- **A restore after commit drops writes.** Named and confirmed (section 11.4); avoided whenever floors allow.
- **macOS has no boot ordering.** The staged Version applies at the first safe point after login.
- **The bundled runtime is ours to patch.** Each Node security release means a Morndo patch Release.
- **GitHub hosts everything.** Signatures make a mirror safe (`MORNDO_UPDATE_FEED`), but availability depends on GitHub.
- **What would change this:** `node:sqlite` leaving "release candidate" (it is "Stability: 1.2" in Node 24 [U15]) would remove the native module and make the program the same on every platform; a package-manager channel would add a read-only installer adapter; a hosted mirror or second maintainer would move the metadata to full TUF.

## 17. Sources (checked 2026-10-11)

- [U1] Claude Code, advanced setup: auto-updates, the launcher and `versions/`, versions kept, release channels, `minimumVersion`, `DISABLE_AUTOUPDATER` and `DISABLE_UPDATES`, Homebrew and WinGet, the signed `manifest.json` (from 2.1.89), platform code signatures. https://code.claude.com/docs/en/setup
- [U2] Claude Code settings reference (`autoUpdatesChannel`, `requiredMinimumVersion`, `requiredMaximumVersion`): https://code.claude.com/docs/en/settings-reference. Environment variables (`DISABLE_UPDATES`): https://code.claude.com/docs/en/env-vars. CLI reference (`claude install [version]`, `claude update`, `claude doctor`): https://code.claude.com/docs/en/cli-reference. The install script (`https://claude.ai/install.sh`) was read, not run: it checks the binary's SHA-256 against `manifest.json` and has no signature check; undocumented, our reading.
- [U3] The Update Framework specification, version 1.0.37 (2026-10-08): attacks (arbitrary installation, endless data, indefinite freeze, mix-and-match, rollback, key compromise), the four top-level roles, "Clients MUST NOT replace a metadata file with a version number less than the one currently trusted", "Clients MUST NOT trust an expired file." https://theupdateframework.github.io/specification/latest/
- [U4] Semantic Versioning 2.0.0: MAJOR, MINOR, PATCH; pre-release precedence; build metadata ignored; 0.y.z. https://semver.org/
- [U5] Release Please: Release PRs, Conventional Commits bumps, manifest config, `bump-minor-pre-major`, `linked-versions`, `draft`, and `force-tag-creation` ("By default, GitHub does not create a Git tag for draft releases until they are published"). https://github.com/googleapis/release-please (library 17.11.2), https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md. The action: https://github.com/googleapis/release-please-action (v5.0.0, 2026-04-22, "upgrade to node24"; its README: resources it creates with `GITHUB_TOKEN` "will not trigger future GitHub actions workflows"; the `release_created` output).
- [U6] Changesets: https://changesets.dev/guide/getting-started, https://changesets.dev/guide/fixed-packages, https://changesets.dev/guide/beyond-npm, https://github.com/changesets/changesets (`@changesets/cli` 3.0.3; `changesets/action` v2.1.2).
- [U7] GitHub artifact attestations: https://docs.github.com/en/actions/concepts/security/artifact-attestations (SLSA v1.0 Build Level 2, Level 3 with reusable workflows, Sigstore public-good for public repositories); https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations (permissions); https://github.com/actions/attest (v4.2.2) and https://github.com/actions/attest-build-provenance (a wrapper since v4); `gh attestation verify`: https://cli.github.com/manual/gh_attestation_verify
- [U8] Immutable releases: https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases; generally available 2025-10-28: https://github.blog/changelog/2025-10-28-immutable-releases-are-now-generally-available/; verifying: https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/verifying-the-integrity-of-a-release
- [U9] Linking to releases (`/releases/latest/download/`): https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases. "Latest" in the REST API: https://docs.github.com/en/rest/releases/releases. Rate limits (60 an hour unauthenticated): https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api. `GITHUB_TOKEN`: "events triggered by the `GITHUB_TOKEN` will not create a new workflow run", except `workflow_dispatch`, `repository_dispatch`, and PR runs that wait for approval: https://docs.github.com/en/actions/concepts/security/github_token
- [U10] Deployment environments, required reviewers, environment secrets on the free plan, deployment branches and tags: https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments
- [U11] Sigstore: signing blobs, https://docs.sigstore.dev/cosign/signing/signing_with_blobs/; CI quickstart, https://docs.sigstore.dev/quickstart/quickstart-ci/; cosign v3.1.3 (2026-08-06), https://github.com/sigstore/cosign/releases; sigstore-js 5.0.0 and its TUF trust root, https://github.com/sigstore/sigstore-js
- [U12] minisign 0.12 (2025-01-15): format, prehashed `ED` signatures, trusted comments. https://jedisct1.github.io/minisign/
- [U13] SSH signatures: ssh-keygen(1), `-Y sign`, `-Y verify`, ALLOWED SIGNERS, https://man.openbsd.org/ssh-keygen.1; PROTOCOL.sshsig, https://github.com/openssh/openssh-portable/blob/master/PROTOCOL.sshsig; OpenSSH 8.1 release notes (2019-10-09), https://www.openssh.org/txt/release-8.1; git-config(1), `gpg.format`, `gpg.ssh.program`, `gpg.ssh.allowedSignersFile` (local git 2.43.0), https://git-scm.com/docs/git-config. Run locally with OpenSSH 9.6p1: sign, verify (exit 0), wrong namespace and changed content (exit 255).
- [U14] npm provenance and trusted publishing (npm 11.5.1 or later; not chosen as a channel in v1): https://docs.npmjs.com/generating-provenance-statements, https://docs.npmjs.com/trusted-publishers
- [U15] Node.js 24: `crypto.verify` with `null` for Ed25519, https://nodejs.org/docs/latest-v24.x/api/crypto.html; `node:sqlite` "Stability: 1.2 - Release candidate", https://nodejs.org/docs/latest-v24.x/api/sqlite.html; verifying binaries, https://github.com/nodejs/node#verifying-binaries; v24.21.0, the latest 24.x, https://nodejs.org/dist/index.json, with archive sizes from https://nodejs.org/dist/v24.21.0/; supported until 2028-04-30, https://endoflife.date/nodejs (secondary).
- [U16] rename(2), Linux man-pages 6.7 (local): "If newpath already exists, it will be atomically replaced". https://man7.org/linux/man-pages/man2/rename.2.html
- [U17] Capistrano: structure, https://capistranorb.com/documentation/getting-started/structure/; rollbacks, https://capistranorb.com/documentation/getting-started/rollbacks/
- [U18] systemd: systemd.kill(5) `KillMode=` and systemd-run(1) `--scope` (local, systemd 255); systemd.service(5) `Restart=`, `RestartPreventExitStatus=`; systemd.unit(5) `OnFailure=`; loginctl(1) `enable-linger`: https://www.freedesktop.org/software/systemd/man/latest/. Automatic boot assessment: https://systemd.io/AUTOMATIC_BOOT_ASSESSMENT/
- [U19] launchd: launchctl `kickstart -k`, `bootstrap`, `bootout`, https://ss64.com/mac/launchctl.html (mirror); launchd.plist(5) `KeepAlive`, `SuccessfulExit`, https://keith.github.io/xcode-man-pages/launchd.plist.5.html (a mirror of Xcode's man pages). Apple's own online copies: UNVERIFIED.
- [U20] SQLite: the online backup API, https://www.sqlite.org/backup.html; `VACUUM INTO`, https://www.sqlite.org/lang_vacuum.html#vacuuminto; `user_version`, `quick_check`, https://www.sqlite.org/pragma.html; better-sqlite3 `backup()`, https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md
- [U21] Kubernetes version skew policy: https://kubernetes.io/releases/version-skew-policy/
- [U22] SvelteKit configuration, `version` and `updated`: https://svelte.dev/docs/kit/configuration#version
- [U23] Tailscale: auto-updates, https://tailscale.com/kb/1067/update; CLI `update --track` and `--version`, https://tailscale.com/kb/1080/cli. Caddy `caddy upgrade` keeps a backup of the binary and restores it on failure, https://caddyserver.com/docs/command-line
- [U24] tuf-js 6.0.0, MIT, from the TUF project: https://github.com/theupdateframework/tuf-js. node-tar 7.5.22, no known advisories for that version (OSV, via `fresh`): https://www.npmjs.com/package/tar
- [U25] XDG Base Directory Specification 0.8: https://specifications.freedesktop.org/basedir/latest/

## Decisions for the owner

1. **Automatic updates: apply on their own, or only stage?** Default: **apply**. A new version downloads and is checked in the background, then installs at the first safe point (nothing in flight, and you're not using the app), or at the next boot. A failed health check rolls back on its own and tells you. The alternative, **stage**, downloads and checks only, and installs when you run `morndo update` or reboot.
2. **Default channel.** Default: **stable**, a release that has been on `latest` for at least 7 days without being withdrawn. The alternative is `latest`, every release as soon as it ships.
3. **Who holds the signing keys.** Default: the **release key in GitHub, usable only after you approve each release job** (you tap Approve on GitHub); the **feed key online in CI** for the weekly re-sign; and a **root key offline with you**, used once at the start and on rotation (yearly at most). The alternative signs each release on your own machine.
4. **Where the update feed lives.** Default: **GitHub Pages of the public repository**: free, no new account, TLS from GitHub. A domain of the project's own can come later; signatures, not the address, decide what is trusted. Moving it needs DNS work and possibly hosting cost, so it is yours.
5. **Bundle Node in each download.** Default: **yes**. Morndo picks its own Node 24, the native SQLite module always matches it, and installing needs no Node at all, for about 27 to 32 MB more per download. The alternative requires Node 24 on the machine, as today.

Publishing the first release is public. It waits for you either way (PR 7).
