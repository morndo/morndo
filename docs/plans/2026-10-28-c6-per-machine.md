# C6: the three machines onto the updater, one at a time (a plan, for review)

Status: a plan. Nothing in it has been run on a real machine. Facts say where they were read (2026-10-27 and 28, this repository at
`main`, the published release `v0.1.1` and its feed, the tag `v0.2.0`, and the throwaway-machine rehearsals of `docs/plans/2026-10-27-c6-0-adoption-rehearsal.md`).
It replaces section 3 (C6) and the machine steps of section 4 of `docs/plans/2026-10-23-c4-c6.md` (branch `docs/c4-c6-plan`); the
rehearsal's findings are in section 8 of the rehearsal plan. Machines are named by role: the **control plane** (hub, fleet and a
node agent), the **build PC** and the **third machine** (node agents). Their host names are not in this repository.

## 0. Summary

**C6 goes on 0.2.0, not on 0.1.1.** Two reasons, both read. As of 2026-10-28 `v0.2.0` is tagged (`2331eef9`) but its GitHub release is still a draft with no assets, so nothing below that downloads it can run yet:

1. **0.1.1 cannot be installed.** Its archive stores the folders `trust/` and `units/` as 0755 while `files.json` lists 0555
   (`scripts/release/stage.ts`); `morndo install` checks the tree against its own `files.json` (`verifyTreeAt`,
   `apps/updater/src/adapters/installer-dirs.ts`) and refuses with exit 65, nothing installed. Reproduced in the published-feed
   rehearsal (`d-installed`: `the tree does not check out against its own files.json (trust: mode); nothing was installed`) and
   by unpacking the archive on the host: exactly those two mismatches. A workaround on a real node is out of the question.
   0.1.1's `install.sh` also ran the unpacked tree from `mktemp -d`, so a `noexec` `/tmp` failed with exit 126 (the rehearsal container has one).
   Both are fixed in main by #191, which 0.2.0 contains: the archive packs the listed folders 0555, and `install.sh` unpacks under
   `~/.local/share` first and only falls back to `mktemp`'s default (which honours `$TMPDIR`) when that cannot be written. The preflight
   (section 3) checks that `~/.local/share` is writable and not `noexec` instead of `/tmp`.
2. **The doctor fix (T-486, #185) is not in 0.1.1** (0.1.1 is `b85f25fd`; #185 merged as `794062ab`, later; it is in 0.2.0). On a release without it a fresh
   install leaves no `files.json` in the installed tree, and `morndo doctor` exits 1 right after it (rehearsal, local build before the
   fix: `tree: files.json: unreadable`, no provenance record, no first feed check). The question was whether C6 needs the fix or can go
   on a release that has it as a known issue. **Answer: it needs it.** Doctor is the one command that tells a half-installed tree
   from a good one, and the checks of every machine (section 4, step 5) and the later ones rest on it exiting 0; with the known
   exit 1 it would be a check nobody can use on exactly the three machines where it matters, and a real finding would hide among
   the known lines. (Whether anything else reads `files.json` of the installed tree is not known; the updater's own update story
   passed in the earlier rehearsals without it.) Because the mode fix forces a new release anyway, waiting for the next one costs no
   extra release. **That release is 0.2.0, which carries (a) the archive modes fixed (#191) and (b) #185** (both are ancestors of its tag). If it also changes the schema of the hub, fleet
   or node database, the rollback section says what that changes (a changed schema makes a manual `restore.sh` choose between
   `--with-db` and `--keep-data`).

**Gate before any real machine (G1): the published-feed rehearsal passes on 0.2.0.** `npm run e2e:update-adopt-published -- --published 0.2.0`
(about 12 minutes, one container; the version is never defaulted, a repeated `--published` is refused) must end `PASSED` with every check ok.
Before it runs anything from the archive it verifies `manifest.json.sig` against the README's signer line and takes the archive's
size and sha256 from that signed manifest, as `install.sh` does (`SHA256SUMS` is not signed and is not read). Doctor is a real check
in this mode: `e-doctor` and `g-doctor` are ok only when `morndo doctor` exits 0 with `ok: the install checks out` right after the install.
(In the local-build rehearsal, `npm run e2e:update-adopt`, `finding-doctor-*` stays a finding whatever the word: whether its fresh-install
doctor is clean since #185 has not been run, so it is not claimed.) Until G1 passes nothing below starts. The scripts it exercises (`scripts/c6`) are the
ones the machines use.

**What this plan asks the owner for:** the fresh approval to move the three machines (the manager's note of 2026-10-26 asks for it
again once 0.2.0 is published), and for 0.2.0 itself the same taps as any release. No new tap per machine.

## 1. What is read, and what is not

**Read in the rehearsals (throwaway machine, local build, not the published archive):** the install over the old state; the
four things it surfaced (section 2 of the steps below); the backup, the restore and the dead-man's switch, through six review
rounds; 65 checks pass, about 11.5 minutes a run.

**Not read:** any run of a *published* archive past `d-installed` (blocked by the modes above); the real feed's first check at
install; `morndo update --check` against the real feed; anything on a real node. Everything marked "to check" below is something
the first real machine will tell, and the plan stops there if it is not as written.

**Assumptions about the machines, each checked by the preflight (section 3):** all three run the same release-tool build; each has a user
manager with lingering; `curl`, `ssh-keygen` and `node` exist in a non-login shell; `~/.local/share` is writable and not `noexec`; the database
files are the ones the backup finds by itself (`morndo.db`, `fleet.db`, `agent.db`) plus the hub's `memory.db`; the node agent's
jobs run as transient `morndo-job-<id>.service` units in `morndo-jobs.slice` and its lanes in `tmux-spawn-*.scope` scopes, which the
backup and the restore leave alone (a bug found while writing this plan: the restore used to treat the job units as its own;
fixed in `scripts/c6/backup.sh`, with a test).

## 2. What the rehearsals showed that the old steps did not know

1. `morndo install` refuses a real file where it wants to link a launcher (`<path> exists and is not a link; remove it first; nothing was installed`, exit 78). The release links **eleven** launchers into `~/.local/bin`:
   `morndo morndo-fleet morndo-node morndo-update morndo-job morndo-board morndo-decide morndo-keys morndo-secrets morndo-usage-claude morndo-memory`
   (recompute at the tag: `node -e 'import("./scripts/release/launchers.ts").then(m=>console.log(Object.keys(m.launchersFrom(".")).join(" ")))'`). Today's machines have real files for some of them (`morndo`, `morndo-fleet`, `morndo-node`, `morndo-board`, `morndo-memory`, ...). Each real file is moved into the backup folder before the install. The lanes' own tools (`morndo-board`, `morndo-memory`) are absent from `~/.local/bin` for the seconds between that move and the install's links; nothing should be started in that gap.
2. An install over **running** legacy units exits 0 after about 276 s, printing `hub: no answer within 90 s` (and so on), and leaves them on the old code. The services are stopped first; then it takes about 6 s and the three answer at the new version.
3. After a `restore.sh`, a second install is refused (`already installed: use morndo update`, exit 78) until `~/.local/share/morndo-releases`, `~/.local/state/morndo-update` and `~/.config/morndo-update` are removed. `restore.sh` never touches data and does not remove them. A retry is a deliberate step (section 5).
4. The dead-man's switch must be a persistent timer (it survives a reboot or a user-manager restart), must refuse another host, and must not stop the node agent's job units (all in `scripts/c6` now).
5. Doctor after a fresh install: unclean on 0.1.1, fixed in 0.2.0 (#185); see section 0.

## 3. Preflight (read-only; each machine, the evening before or the same day)

Run as the machine's own user. Stop at the first line that is not as written and tell the manager.

```sh
hostname; id -un; loginctl show-user "$(id -un)" -p Linger            # Linger=yes
findmnt -no OPTIONS --target ~/.local/share | tr ',' '\n' | grep -x noexec && echo "noexec ~/.local/share: stop"
command -v curl ssh-keygen node sqlite3                               # curl, ssh-keygen, node must print a path
df -h "$HOME" | tail -1                                               # at least 5 GB free
systemctl --user list-units 'morndo-*' --all --no-legend             # the units, and any morndo-job-* running
systemctl --user list-timers --all --no-legend | grep morndo         # timers of ours, if any
ls -l ~/.local/bin | grep -E ' morndo'                                # which launchers are real files
find ~/.local/share/morndo* ~/.local/state/morndo* -name '*.db' 2>/dev/null   # the databases the backup will find
```

Also: nothing is releasing (no deploy, no rollout in progress); for the control plane, the manager is told; the machine runs the build
the other two run (`git -C ~/morndo/releases/<sha> rev-parse HEAD` or the folder's name); the node agent's `status.json` shows no
work in flight and nothing typed (`~/.local/state/morndo-node/status.json`); if a lane is mid-answer, wait or choose another time.
The ten minutes of "healthy" between machines (section 4, step 7) are measured from the previous machine's marker.

**The scripts**, from the tag, with the digests the lane recorded from its checkout (fetched once per machine into a scratch folder, not into any release folder):

```sh
T=v0.2.0; B=https://raw.githubusercontent.com/morndo/morndo/$T/scripts/c6; D=$HOME/c6-scripts; mkdir -p "$D"
for f in backup.sh arm-deadman.sh db-backup.ts; do curl -fsSL -o "$D/$f" "$B/$f"; done
sha256sum "$D"/*                                                     # compare with the digests in the card
```

The digests come from `git show $T:scripts/c6/<file> | sha256sum` on the lane's checkout and are written on the card, so the machine
never trusts the network alone.

## 4. The procedure, per machine

**Roles:** the control plane `--role control-plane` (hub, fleet, node); the build PC and the third machine `--role node`. Order: control plane, build PC, third
machine (a node must never be newer than its control plane; `skew()` / `node_ahead`). A step that does not give the expected output stops the run; the rollback section decides what happens next.

**Rollback first (read it now): section 5.** The dead-man's switch is armed at step 3, before anything changes.

1. **Hold.** Tell the manager the machine's name and the start time. On the control plane also: the owner's app will be unreachable for the length of the restarts (about a minute with the checks); the manager pane lives in tmux and stays.
2. **Download and verify the installer** (the README's commands, exact Version `v0.2.0`; nothing runs before the signature check passes):
   ```sh
   V=0.2.0; W=$HOME/c6-install; mkdir -p "$W" && cd "$W"
   curl -fsSLO "https://github.com/morndo/morndo/releases/download/v$V/install.sh"
   curl -fsSLO "https://github.com/morndo/morndo/releases/download/v$V/install.sh.sig"
   echo '<the key line from README.md, "Install, verifying first">' > morndo.allowed_signers
   ssh-keygen -Y verify -f morndo.allowed_signers -I release@morndo.github.io -n release@morndo.github.io -s install.sh.sig < install.sh
   gh attestation verify install.sh --repo morndo/morndo --signer-workflow morndo/morndo/.github/workflows/release.yml@refs/heads/main
   ```
   (`gh` runs where it is logged in, usually the lane's machine; the file is the same bytes: compare `sha256sum install.sh` on both.)
3. **Backup, and arm the dead-man's switch.**
   ```sh
   BK=$HOME/.local/share/morndo-backups/$(date +%F)-c6-<role>
   sh "$D/backup.sh" "$BK"                                  # control plane: add --db memory=$HOME/.local/share/morndo/memory.db
   ls "$BK" "$BK/units" "$BK/wrappers" "$BK/dbs"; cat "$BK/machine.txt" "$BK/state.txt"
   sh "$D/arm-deadman.sh" <machine> "$BK"                   # 60 minutes
   systemctl --user list-timers c6-deadman-<machine>.timer
   ```
   Read `ROLLBACK.md` in the backup folder now; it carries the commands of section 5 with the real paths. `backup.sh` refuses a database it
   finds but was not told about, and a machine with no database; it takes the databases by SQLite's online backup, records each schema signature and
   each unit's active and enabled state.
4. **Stop, move the launchers aside, install.**
   ```sh
   systemctl --user stop morndo-hub.service morndo-fleet.service morndo-node.service     # the ones this role has; control plane: all three
   cd ~/.local/bin && for n in morndo morndo-fleet morndo-node morndo-update morndo-job morndo-board morndo-decide morndo-keys morndo-secrets morndo-usage-claude morndo-memory; do
     if [ -e "$n" ] && [ ! -L "$n" ]; then mv -- "$n" "$BK/moved-$n"; fi; done      # they are also in $BK/wrappers
   cd "$W" && sh install.sh --role <control-plane|node> --channel latest --signers morndo.allowed_signers
   ```
   Expected: `Morndo 0.2.0 installed (<role>, channel latest).` then `hub: healthy at 0.2.0` / `fleet: ...` / `node: ...` for the services of the role, in
   seconds. Anything else (a refusal, `no answer within 90 s`): stop; section 5.
   The lanes' tmux servers are not in the units' cgroups (`tmux-spawn-*.scope`), and the node agent's job units (`morndo-job-*`) are not stopped by this step.
5. **Checks** (every one; copy the output to the card):
   - `morndo update --status`: `install: updater`, `channel: latest`, `current: 0.2.0 · previous: none · good: 0.2.0`.
   - `morndo update --check`: `Up to date: 0.2.0.` (reads the real feed; a feed that cannot be reached is printed, not a failure of the install).
   - `morndo doctor`: exit 0, `ok: the install checks out` (the 0.2.0 contract, T-486). If it exits 1, the lines it prints decide: a finding about the *feed* only (never checked, unreachable) is recorded and the run goes on; anything about the tree or provenance stops the run.
   - The units: `systemctl --user cat morndo-<service>.service | head -1` is Morndo's mark; the old file sits beside it as `*.before-morndo`; `morndo-<service>.service.d/before-morndo.conf` carries the old `Environment=`.
   - Databases: `sqlite3 <db> 'PRAGMA quick_check'` says `ok` for each; the schema signature (`node "$D/db-backup.ts" signature <db>` against `$BK/dbs/schema.txt`) is the same, or its change is written on the card (section 5 changes with it).
   - The lanes: the same tmux server pid as before step 4 (`pgrep -a 'tmux: server'` noted in step 1); `morndo-job-*` units unchanged (count and names); `systemctl --user --failed` empty.
   - The old release folder (`~/morndo/releases/<sha>`) is still there, byte for byte (`find ... | wc -l` as before).
   - Fleet: the machine is `online` on the release's commit in the fleet list; its lanes are online; a long message (about 28,000 characters) sent to a scratch lane arrives and is answered.
   - Control plane only: `/api/health` shows the new commit and schema; the app is served (not 503); https is ready; the manager answers through the hub. `MORNDO_ORIGIN` is set in the control plane's updater unit (note N-448: the units do not carry it, so the https check would be unnamed) before the window step.
6. **Close the switch.** Only when step 5 is complete:
   ```sh
   touch "$BK/ok"; sh "$D/arm-deadman.sh" --disarm <machine>
   ```
   (Arm refuses while `ok` exists, so the order is arm, `touch ok`, `--disarm`.) The machine now belongs to the updater. On the control plane, set the window: `morndo update window 03:30-05:00`, and `morndo update --status` shows it; without it the control plane would apply an update at any hour.
7. **Wait ten minutes healthy** before the next machine: the same checks, shorter (`--status`, `doctor`, units, fleet row, one lane answer).

## 5. Rollback (written before the install; the commands are in `$BK/ROLLBACK.md` with the real paths)

| Situation | What to do |
| --- | --- |
| Anything in steps 2 to 5 is not as written, and the machine still runs the old units | `sh "$BK/restore.sh"`: units, drop-ins and launchers back, `daemon-reload`, each unit to the state recorded at backup. Exit 0 and the old folder runs again. |
| `restore.sh` exits 4 | The schema of a database changed since the backup (the new hub migrated it). Choose: `--with-db` (puts the old data back, loses every write since the backup) or `--keep-data` (old code on the newer schema anyway; only if the notes of 0.2.0 say it is additive). Not a default. |
| `restore.sh` exits 3 | Not this machine or not this `HOME`: nothing changed. Use the folder on its own machine. |
| `restore.sh` exits 1 | A line `FAILED:` says what (a file or database that could not be put back, a unit that would not stop). A database that could not be put back leaves its service **stopped** with the copy command in the message; run it by hand, then start the unit. Never start a service on a half-restored database. |
| Nobody there / the hub is dead / the checks cannot run | The dead-man fires at 60 minutes: `restore.sh --deadman`. With the schema unchanged it only restores units and launchers and exits 0. With a changed schema it copies each changed database aside to `$BK/aside-<UTC time>/` (never deleted), puts the backed-up one back, starts the units, and writes `$BK/deadman-report.txt` and the same text to the journal; the writes made since the backup live only in the aside copy. Any failure ends non-zero with `FAILED:` lines. |
| A retry after a restore | The install is refused (`already installed`). Remove `~/.local/share/morndo-releases`, `~/.local/state/morndo-update` and `~/.config/morndo-update` (deliberately), then step 4 again with a new backup folder. |
| After the switch is closed | The updater's own `morndo update --rollback` is the way back, not `restore.sh` (the first install has no earlier Version; this one has the old folder only). One real `--rollback` is rehearsed on the control plane first (below). |

The updater's rollback after the first install is still unrehearsed on a real tree: **before the control plane's window opens**, run `morndo update --rollback --preview --json` and read it; after the release after 0.2.0 is the first update the machines take by themselves, the real rollback is run once on the control plane in the daytime (the owner's word), because that is the machine whose loss the owner would notice.

## 6. What happens after

- The control plane (mode `apply`, channel `latest`) takes the next release by itself inside its window, restarts fleet, hub and node in order, judges health, and rolls back by itself on failure; the nodes follow after the 30-minute soak and a random delay of up to 15 minutes. **The next release is the proof of the auto-update**; nothing needs to be done by hand.
- The three machines' `previous` link points at the first updater-managed Version: the old release-tool folders can go only after the second release has been taken and the owner agrees (`~/morndo/releases/<sha>` stays until then).
- Every Monday the weekly re-sign waits for one tap; a Feed older than 14 days expires and the updater stops offering.

## 7. Open decisions

1. **0.2.0 or wait for more?** This plan asks for 0.2.0 as soon as its GitHub release is published (it is a draft today) and G1 passes on it. (No other change is needed for C6.)
2. **Who runs steps 2 to 6 on each machine?** The lane on the machine itself (no one connects to a machine from outside); for the control plane, the manager is told and watches the fleet from the hub.
3. **Time of day.** The control plane in the owner's night window, with the manager awake for the first ten minutes; the other two by day if their lanes are idle.

## Sources

`install.sh`; `README.md` (Install, verifying first); `scripts/release/stage.ts`, `launchers.ts`; `apps/updater/src/cli.ts` (`install`, `update window`, `doctor`);
`apps/updater/src/adapters/installer-dirs.ts` (`verifyTreeAt`), `services-systemd.ts`, `paths.ts`; `apps/node-agent/src/ops/job-systemd.ts` (the job units);
`scripts/c6/*` and `docs/plans/2026-10-27-c6-0-adoption-rehearsal.md`.
