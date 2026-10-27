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

That file is on branch `docs/c4-c6-plan` and not on `main`, so the edit belongs there (or in its pull request). Four changes:

- **Step 2 (backup):** the backup also takes the three wrappers out of `~/.local/bin` (`backup.sh` already copies them);
  after the backup they are moved away, because step 3's install refuses a real file in their place.
- **Step 3 (install):** stop `morndo-hub`, `morndo-fleet` and `morndo-node` before `install`; run it; `install` starts them
  and waits for health. Without the stop it takes about 276 s and leaves them on the old code.
- **Step 2 (dead-man's switch):** the timer stays longer than the worst install and its checks; the 60 minutes hold with
  the stop in step 3 (the rehearsal needed 480 s only for the case without it).
- **Step 6 (rollback):** after `restore.sh`, a second install first needs `~/.local/share/morndo-releases` and the
  updater's state and config removed (`restore.sh` leaves them; it never touches data).
