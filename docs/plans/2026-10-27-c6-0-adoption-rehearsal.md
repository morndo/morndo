# C6-0: the adoption rehearsal (a plan)

Status: a plan for one harness scenario. It continues section 3 of `docs/plans/2026-10-23-c4-c6.md` and section 6 of
`docs/plans/2026-10-27-c4-resume.md`. Facts were read on 2026-10-27, read-only, in this repository at `b9d95505`; the
one thing run is a Docker boot test (below). Machine names are left out on purpose: "the machines" are the three
that run the release-tool setup today.

## 1. What it proves

A throwaway machine in the state of the machines today, and `morndo install` run over it. After the install:

1. **Units adopted.** The three service units (`morndo-hub`, `-fleet`, `-node`) are Morndo's (first line is the mark),
   run from `~/.local/share/morndo-releases/current`, and the old unit text is kept beside them as
   `<unit>.before-morndo`; the old unit's `Environment=` lines live on in the `before-morndo.conf` drop-in.
2. **Databases opened.** The hub, fleet and node databases still pass `PRAGMA quick_check`, the rows written before
   the install are still there, and the services answer health at the installed version.
3. **The lane's processes kept.** A tmux server with a running process, started in its own transient scope the way
   the node agent starts one (`tmux-spawn-<uuid>.scope`), has the same pid and start time after the install.
4. **Health green.** All three units active; hub, fleet and node answer at 0.1.0; `morndo update --status` shows the
   machine updater-managed on the chosen channel; `morndo doctor` is clean.
5. **The old release folder still on disk**, byte for byte (file list and sizes before and after).
6. **The dead-man's switch.** `systemd-run --user --on-active=<n>` on the backup's `restore.sh`:
   - *fires and restores*: with no `ok` marker, `restore.sh` puts the old units, drop-ins and wrappers back, reloads
     and restarts, the machine runs the old folder again, **a row written after the backup is still there** (it
     never touches a database), and the lane is still alive if the node unit was not what held it;
   - *does nothing when the marker exists*: the same timer, marker created first, fires, exits 0 at its first line,
     and the machine is unchanged.
   The rehearsal arms the timer for 90 seconds; the mechanism is the one the run book arms for 60 minutes.
7. **The control plane's window step.** `morndo update window 03:30-05:00` and `morndo update --status` shows it
   (the default shown first: any hour).

Out of this scenario: a real `morndo update --rollback` (c4-resume section 6 lists it for later; it needs a second
Release and the existing `vm` scenario already walks a rollback), the owner-path checks of C4-6, and any real machine.

## 2. How it reaches today's state

The state is read from a real machine of the three (unit text, wrapper text, backup layout), then made up with
invented names. Inside the container, as the `worker` user:

- **The old release folder** `~/morndo/releases/abc1234/`: a copy of the built A tree's `app/` directory (the sources
  with production `node_modules`), with `app/build.json` and `app/VERSION` removed, so the services run as a checkout
  does. A copy of the A tree's Node sits at `~/.nvm/versions/node/v24.0.0/bin/node`, as the units name it.
- **Units** `morndo-hub.service`, `morndo-fleet.service`, `morndo-node.service` in `~/.config/systemd/user/`, without
  Morndo's mark: `ExecStart=%h/.nvm/.../node --no-warnings %h/morndo/releases/abc1234/apps/<service>/src/main.ts run`,
  an `Environment=PATH=...` line, `Restart=on-failure`, the shape of the real node unit (`MemoryMax` included).
- **Wrappers** `~/.local/bin/morndo`, `morndo-fleet`, `morndo-node`: real bash files that `exec` the same node on
  the old folder's `main.ts`, as on the machines.
- **Databases in place** by running the old units once: the hub, fleet and node make their databases at first start;
  the scenario adds marker rows (a made-up lane, a made-up node name) and records them.
- **A lane**: `systemd-run --user --scope` around `tmux new-session -d -s lane-demo 'sleep 100000'`, pid and
  start time kept.
- **The feed**: the harness's own (`feed-server.ts`, a throwaway CA, the container's `127.0.0.1`), with the user
  manager's environment set and *checked* (`MORNDO_UPDATE_FEED` present) before anything runs.
- **Backup and dead-man**: `scripts/c6/backup.sh <dir>` writes the dated folder (unit files and drop-ins, wrappers,
  each database by SQLite's online backup, `restore.sh`, `ROLLBACK.md`) and `scripts/c6/arm-deadman.sh` arms the
  timer. The scenario uses these scripts, so the per-machine run book can use the same ones; the scripts have their
  own unit tests without Docker.

## 3. Three things the scenario must settle, that the plan has not yet read from a run

Read in the code, not yet run; the scenario's outcome decides each and the checkpoint reports it:

1. **Wrappers.** `morndo install` refuses (`exists and is not a link; remove it first`, `apps/updater/src/cli.ts`,
   around line 1175) when `~/.local/bin/morndo*` is a real file. All three machines have real files today. If the run
   confirms it, step 3 of the per-machine procedure needs "move the three wrappers into the backup first", and
   `restore.sh` must put them back (it already lists them).
2. **Running legacy units.** `enable --now` does not restart an active unit, so an install over running services may
   leave them running the old folder while `install` waits 90 s for a health answer at the new version and still
   exits 0. If the run confirms it, the per-machine procedure needs a stop of the three services before the install
   (the node unit's lane processes sit in their own scopes, check 3 above).
3. **Lingering and the user manager** in the container come from the harness's image (`loginctl enable-linger` state is
   the Dockerfile's); nothing to change on the machines.

## 4. The checks, as the scenario reports them

One JSON line per check on stdout, as `scenario.ts` does. New logic with its own tests first: the judgements live
in `e2e/update-vm/adopt-checks.ts` (unit mark and `before-morndo` presence, pid-and-start-time equality, folder
listing equality, rows kept, marker behaviour), tested on fixture strings with no Docker. Then
`e2e/update-vm/adopt-scenario.ts` (inside the machine) and `e2e/update-adopt.e2e.ts` (the host, a copy of
`update.e2e.ts`'s skeleton: build, container, scenario, evidence, cleanup, sweep).

## 5. Time and cost

- Build of one Release (A only: a new `adopt` set in `build.ts`, so not the six of the `vm` set): about 3 to 5 minutes
  on this host, one `npm ci` first (about 2 minutes, once).
- Image: about 20 seconds (measured with the boot test; the base image is cached now).
- Scenario: about 5 minutes (install and starts about 1; the two dead-man runs about 2 plus the 90-second timer).
- One run: **about 10 to 15 minutes**. One container at a time, 12 CPUs and 30 GiB here, the container needs a few
  hundred MiB; removed in the end, with the image.

## 6. What it needs from the host

- Rootless Docker with `--cap-add SYS_ADMIN --cap-drop AUDIT_WRITE --cgroupns=private`, as the existing harness.
  **Found today:** the harness's entrypoint remounts `/sys/fs/cgroup` read-write, and rootless Docker refuses that
  (`permission denied`). A fresh `mount -t cgroup2 none /mnt/cg` plus `mount --bind /mnt/cg /sys/fs/cgroup` works
  under the same capabilities, no `--privileged`, and systemd boots (`running`), the user manager answers, and
  `systemd-run --user --scope` works (measured with a test container, removed). The new `Dockerfile.adopt` has that
  entrypoint, with its own label `morndo-c6-adopt-e2e`.
- Network: the base image (cached) and `npm ci`. No sudo, no apt on the host; `curl` and `openssh-client` are not
  needed (the scenario runs the unpacked tree's `morndo install`, not `install.sh`).
- Nothing of the host in the container: no mounts, no host network, no published ports; files by `docker cp` only.

## 7. Cleanup

Container removed in `finally`, on SIGINT and SIGTERM; the sweep at the start removes a killed run's leftovers by
label and owner; the image is removed by the run's last step (`E2E_KEEP=1` keeps scratch for debugging); a final
`docker ps -a --filter label=morndo-c6-adopt-e2e` and `docker images` check is part of the run's own output.

## 8. What the first runs found (for the per-machine steps)

Measured by the scenario on a throwaway machine, about 10.5 minutes a run:

1. `morndo install` over real-file wrappers exits 78 (`... exists and is not a link; remove it first; nothing was
   installed`). The per-machine step 3 needs "move the wrappers into the backup first"; `restore.sh` puts them back.
2. Over running legacy units the install exits 0 after 276 s with `no answer within 90 s` for each service; they keep
   running the old folder. Stopping the three services first makes it take 6 s and all three are healthy at the new
   version. The step needs "stop the services, then install". The dead-man timer must not be shorter than the
   worst case without that stop (the rehearsal armed 480 s for it).
3. After `restore.sh`, a second install exits 78 (`already installed: use morndo update`): the releases folder and the
   updater's state stay. A retried install needs those removed first (not part of `restore.sh`, which never touches
   data).
4. `morndo doctor` exits 1 right after a fresh install (filed as T-486): `tree: files.json: unreadable` (the installed tree has no
   `files.json`), no provenance record, no feed check yet, and (in the rehearsal) a key set near expiry. The plan's
   check "`morndo doctor` is clean" does not hold at install time; it needs to read "doctor's only findings are the
   feed never having been checked" at best, and the missing `files.json` is a product defect to file.
5. Window: `morndo update window 03:30-05:00` is accepted and `--status` shows it.
6. The fired `restore.sh` leaves the post-backup rows, the lane's processes, and runs the old folder again; with the
   `ok` marker, the timer's run changes nothing.

### 8.1 The changes to section 3 of `docs/plans/2026-10-23-c4-c6.md`, by step

That file is on branch `docs/c4-c6-plan` and not on `main`, so the edit belongs there (or in its pull request). These changes:

- **Step 2 (backup):** the backup also takes the three wrappers out of `~/.local/bin` (`backup.sh` already copies them);
  after the backup they are moved away, because step 3's install refuses a real file in their place.
- **Step 3 (install):** stop `morndo-hub`, `morndo-fleet` and `morndo-node` before `install`; run it; `install` starts them
  and waits for health. Without the stop it takes about 276 s and leaves them on the old code.
- **Step 2 (dead-man's switch):** the timer stays longer than the worst install and its checks; the 60 minutes hold with
  the stop in step 3 (the rehearsal needed 480 s only for the case without it). The switch is now a persistent timer
  unit (`~/.config/systemd/user/c6-deadman-<machine>.timer` and `.service`, `Persistent=true`), so a reboot or a restart
  of the user manager keeps it; it runs `restore.sh --deadman`. The ok step is `touch <backup>/ok`, then
  `arm-deadman.sh --disarm <machine>` (which removes both files and does not write the marker itself).
- **Step 2 (backup):** `backup.sh` finds the hub, fleet and node databases (`morndo.db`, `fleet.db`, `agent.db`) by
  itself, refuses any other `*.db` under `~/.local/share/morndo*` and `~/.local/state/morndo*` unless `--allow-unlisted`,
  (the hub also keeps `memory.db` next to `morndo.db`: name it with `--db memory=<path>`), refuses a machine with no database unless `--no-db`, and records the host, `HOME`, the schema signature of each
  database and which units were active or enabled. A failure after the folder exists removes the folder again.
- **Step 6 (restore refusals):** `restore.sh` refuses another host or `HOME` (exit 3). A manual run refuses (exit 4, before
  it changes anything) when the schema signature of a live database differs from the backup's. The signature covers the
  tables, indexes and triggers (`sqlite_master`), `PRAGMA user_version` and the rows of the one-row `_morndo_schema` table (the compat floor the shared
  migration runner writes, ADR-0019), so it also sees a data-only migration; ordinary new rows do not change it, and
  neither do the rows of a table that merely has "migrat" in its name (a lock, a last-run time). When it changed, the choice is
  `--with-db` (puts the old data back, loses every write since the backup) or `--keep-data` (old code on the newer
  schema anyway). The dead-man's run (`--deadman`) does not stop on a changed schema, because nobody is there to
  choose. Before it touches any database it stops every morndo service running at that moment (whatever was recorded)
  and every one recorded active (`systemctl --user list-units --state=active 'morndo-*.service'`); then for each
  database whose signature changed it takes an online copy into `<backup>/aside-<UTC time>/<name>.db` (no script deletes
  that folder; the writes made since the backup live only there), puts the backed-up database back and starts the units.
  Databases whose schema did not change are left alone and not copied. A manual run ignores a stale `ok` marker (it says
  so); only `--deadman` honours it. The same stop comes before the `--with-db` copy.
  One routine puts every unit of the recorded set back into its recorded state: a service recorded enabled is enabled,
  one recorded disabled is disabled (also when the install enabled it), an active service is restarted, an inactive one
  stopped; a timer recorded enabled gets `enable --now` and then `restart` (a running timer takes the restored schedule),
  one recorded disabled `disable --now`. A unit the install added is stopped and disabled.
  Every file is replaced by copy-then-rename: the new one is written under a temp name in the same folder
  (`<name>.c6-restore.tmp`), then renamed over the old one; a unit folder (drop-ins) is copied beside and swapped (new
  renamed in, old removed after). Nothing is removed first, so a failure leaves the old file whole, removes the temp, is
  named, and the service that file belongs to (the unit, or the services `<wrapper>.*`, `<wrapper>@*`, `<wrapper>-*`) is not
  started. A database is copied from the backup beside the live file, checked with `PRAGMA quick_check`
  (`db-backup.ts check`), its `-wal`/`-shm` moved aside beside the database (`<db>-wal.c6-aside`, `<db>-shm.c6-aside`,
  never deleted first), and renamed in; the aside copies are deleted only after the rename worked, and put back where they
  were if the rename (or the move aside) fails. If any of that fails the live file is as it was, no temp or aside file is
  left, and the services that use it stay stopped (hub and memory: `morndo-hub*`, fleet: `morndo-fleet*`,
  node: `morndo-node*`; an unknown database name keeps every service stopped). The run exits non-zero and stderr (the
  journal) and `deadman-report.txt` say `database <name> was NOT put back; the service ... stays stopped; copy
  <backup>/dbs/<name>.db to <path> by hand and start it`. This covers a missing or corrupt backup copy, a failed aside
  copy of a changed database, and a service that would not stop (a database is never overwritten under a running service).
  Before any database is touched the restore stops every loaded morndo unit in an active-like state (`systemctl --user
  list-units --state=active,activating,reloading,auto-restart 'morndo-*'`: services, timers, sockets and paths, template
  instances included), timers first so none fires in the window, whatever was recorded. It then lists again and stops what is
  still or newly active (a timer can start a unit between the list and the stop), for at most 5 rounds; a unit that is still
  active after that, or whose stop fails, is named in a `FAILED:` line and no database is overwritten. At the end
  `apply_state` puts each recorded unit back exactly, in the order services, then sockets, then paths, then timers (an
  instance recorded active is restarted, one that was not recorded active stays stopped, a socket or path unit likewise
  with `enable`/`disable`, a timer gets `enable --now` and `restart`). `backup.sh` records the same set (services, timers,
  sockets and paths) in `state.txt`, so an instance running at backup time is recorded `active=yes` although only its
  template has a file. Files are moved with `mv -T`, so a destination that is a link to a folder is replaced, never
  entered. A blocked unit is matched by an exact name or a prefix/suffix comparison, never by a shell pattern held in a
  variable (a `*` blocks every service whatever files the working directory holds). `backup.sh`, `arm-deadman.sh` and the
  `restore.sh` it writes are a shellcheck gate: `shellcheck -s sh -S style` prints nothing for them and no
  `# shellcheck disable` appears (`scripts/c6/backup.test.ts` runs it).
  Every failure (a unit, a database copy, an aside copy that fails, a `date` or `mkdir` that fails, a report that cannot
  be written) is carried past: everything else is still done and the units are put back, and then the exit is non-zero,
  with a `FAILED:` line on stderr (the journal) and in `<backup>/deadman-report.txt`. Every dead-man exit leaves a line in
  both: the normal path writes the report; the `ok` marker writes `ok marker present; nothing to do` to stderr and appends
  it to the report; a host or HOME mismatch (exit 3) writes `<backup-folder>.deadman-report.txt` NEXT TO the folder (the
  folder is not this machine's) and prints that path. A database whose aside copy fails is not replaced and its services
  stay stopped. `restore.sh` has no `set -e`: each step is checked on its own. `arm-deadman.sh` writes the restore path into
  `ExecStart=` quoted and escaped for systemd (`%` doubled, `\` and `"` escaped) when it holds anything but plain characters,
  and `restore.sh` builds the same string to find its own unit. The container rehearsal fires the dead-man twice on the same
  machine. First a changed schema (the node database) is rolled back unattended: the unit ends exit 0 (`Result=success`, no
  `FAILED` line in the report), the units, the drop-in, the wrappers and the databases are back, the aside copy is there and
  every service runs again on the old folder with no manual start. Then a failed database copy (the fleet copy is corrupted
  before the firing; the fleet service stays inactive, the report names it, the live file is untouched; then the copy is
  put back by hand as the report says). Unit-tested only
  (`scripts/c6/backup.test.ts`): the failing aside, `date`/`mkdir`, quoting, a timer that would fire in the restore window,
  unit files and wrappers that cannot be copied back, and the host-mismatch report.
- **Step 2 (arming):** `arm-deadman.sh` restarts the timer after enabling it, so arming again moves the time. It refuses
  (exit 1, writes nothing) while `<backup>/ok` exists; remove that file to arm, so the order is arm, then `touch ok`,
  then `--disarm`.
- **Step 6 (rollback):** after `restore.sh`, a second install first needs `~/.local/share/morndo-releases` and the
  updater's state and config removed (`restore.sh` leaves them; it never touches data).

## 9. The published-feed mode (2026-10-27)

`node e2e/update-adopt.e2e.ts --published <version>` (`npm run e2e:update-adopt-published -- --published <version>`) rehearses the
README's own commands on the throwaway machine: it downloads `install.sh` and its signature from the release, verifies them
with the key line it reads out of `README.md`, runs `sh install.sh --role control-plane --channel latest --signers ...`,
and uses the production feed (no local feed, no `MORNDO_UPDATE_FEED`). The host downloads the archive only to get a Node and the old release folder's sources, and
unpacks it only after `manifest.json.sig` verifies against the README's signer line and the archive's size and sha256 match
the signed manifest (`SHA256SUMS` is unsigned and is not read). The container needs network
(`a-network`), and `install.sh` runs under a `TMPDIR` in the worker's home because the container's `/tmp` is `noexec`.

First run against the published `0.1.1`: 13 of 14 checks, stopped at `d-installed`. The install is refused, exit 65:
`the tree does not check out against its own files.json (trust: mode); nothing was installed`. The archive stores `trust/` and
`units/` as 0755 where `files.json` says 0555 (`scripts/release/stage.ts`); reproduced by unpacking the archive on the host,
exactly those two. The signature check of `install.sh` itself passed (`b-install-sh-verified`). No later check ran, so the
real feed's first check, `update --check` against the real feed and the doctor's word on the published tree are still unread.
The per-machine plan (`docs/plans/2026-10-28-c6-per-machine.md`) therefore targets 0.2.0 and gates on this mode passing.

Found while writing that plan: the node agent runs jobs as transient `morndo-job-<id>.service` units (`job-systemd.ts`), which
the backup recorded and the restore would have stopped as if they were ours; `scripts/c6` now leaves them alone (test).
The local mode also assumed the old folder reports version 0.0.0; the repository is at 0.1.1 now, so it reads the root
`package.json` instead.
