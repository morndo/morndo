# Manual QA checklist

Results go in the private QA notes, never in this tree, and nothing in this file has been run yet.

1. On a fresh throwaway VM (Linux x64), run the verify-first install once per role, pair a phone, and start two lanes. Check the signature before `install.sh` runs, using the release key line from SECURITY.md.

```sh
curl -fsSLO https://github.com/morndo/morndo/releases/latest/download/install.sh
curl -fsSLO https://github.com/morndo/morndo/releases/latest/download/install.sh.sig
ssh-keygen -Y verify -f morndo.allowed_signers -I release@morndo.github.io -n release@morndo.github.io -s install.sh.sig < install.sh
sh install.sh --role control-plane --signers morndo.allowed_signers
sh install.sh --role node --signers morndo.allowed_signers
morndo update --status
```

Record: the versions before and after, the exit code of the signature check and of each `install.sh`, and the time the services became healthy.

2. Publish the next Version to a test feed. Watch the notice, stop using the app, and watch the automatic apply. Compare pane ids before and after, and time the restart gap.

```sh
tmux list-panes -a -F '#{pane_pid}'
morndo update --status
```

Record: the versions before and after, the pane ids before and after the apply, the times the restart started and finished, and the exit code of `morndo update --status`.

3. Run `morndo update` by hand and read the prompt, then check and print status as text and as JSON.

```sh
morndo update
morndo update --check
morndo update --status
morndo update --status --json
```

Record: the versions before and after, each exit code, and the time the prompt was answered.

4. Roll back, look at the read-only preview, then update again.

```sh
morndo update --rollback --preview --json
morndo update --rollback
morndo update
```

Record: the versions before and after, each exit code, and whether the rollback asked for a typed word.

5. Publish a breaking Release with a planted health failure. Watch the backup, the automatic rollback, and the alert on the phone, and check that the data is unchanged.

```sh
morndo update --status
morndo doctor
```

Record: the versions before and after, the exit codes, the times of the rollback, what the phone showed, and what the doctor reported.

6. Hard-reset the VM during the swap, three times at different points. After each boot, confirm one Version, that it is healthy, and that the record shows the recovery.

```sh
morndo update --status
morndo doctor
```

Record: the version after each boot, the exit codes, the times of the three resets, and what the doctor reported.

7. Switch a machine that is ahead on `latest` to `stable`. It does not move down. `--status` says it waits for `stable`.

```sh
morndo update --channel stable
morndo update --status
```

Record: the versions before and after, the exit codes, and the status line that says it waits.

8. Pin a Version, unpin it, turn background updates off, and confirm `MORNDO_DISABLE_UPDATES=1` blocks `morndo update`.

```sh
morndo update pin <version>
morndo update unpin
morndo update auto off
MORNDO_DISABLE_UPDATES=1 morndo update
```

Record: the versions before and after the pin, and each exit code.

9. On two machines, update the control plane first. The node waits for the soak. A planted rollback on one node halts the other.

```sh
morndo update --check
morndo update --status
```

Record: the versions on each machine before and after, the soak times, the exit codes, and what the phone showed when the other node halted.

10. An old node on the previous protocol keeps working. A Release that drops that protocol is deferred on the control plane, and the deferral names the node.

```sh
morndo update --check
morndo update --status
```

Record: the node's version, the control plane's version, the exit codes, and the deferral text that names the node.

11. On the phone, open Settings → Updates. The versions table is there. "Update now" asks for the passkey. "Roll back" lists what a restore drops.

```sh
morndo update --status --json
```

Record: what the phone showed, the versions in the table, and the exit code.

12. On the real release assets, check the signature and the attestation by hand. Change one installed file and run `morndo doctor`, which finds that file.

```sh
ssh-keygen -Y verify -f morndo.allowed_signers -I release@morndo.github.io -n release@morndo.github.io -s install.sh.sig < install.sh
gh attestation verify install.sh --repo morndo/morndo
morndo doctor
```

Record: the exit codes of both checks, and what the doctor reported.

13. Uninstall. The units and the release directories go. The data directories stay. There is no uninstall command in the updater; remove the units and the release directories, then ask the updater what it still sees.

```sh
morndo update --status
```

Record: the paths that went, the data directories that stayed, the version that had been installed, and the exit code.

14. On macOS on Apple silicon (launchd), install, update, roll back, and recover after a forced logout.

```sh
sh install.sh --role control-plane --signers morndo.allowed_signers
morndo update --yes
morndo update --rollback
morndo update --status
morndo doctor
```

Record: the versions before and after, the exit codes, the times of the update and the logout, and what the doctor reported after login.

15. On Linux arm64, install and update.

```sh
sh install.sh --role control-plane --channel stable --signers morndo.allowed_signers
morndo update --check
morndo update
```

Record: the versions before and after, the exit codes, and the time the update finished.

16. `morndo update --to <version>` takes that Version from the machine's own channel. Repeat it against a withdrawn Version, against a lower Version, and against another Version while this machine is pinned. Each of those three is refused.

```sh
morndo update --to <version>
morndo update --to <version>
morndo update pin <version>
morndo update --to <v>
morndo update unpin
```

Record: the running version, each Version that was named, and each exit code.

17. Withdraw a Release on the scratch repository. A machine already on it stays. A machine behind it stops being offered it.

```sh
morndo update --check
morndo update --status
```

Record: the version each machine was on before and after, what `--check` printed on each, and the exit codes.

18. Promote a Release after seven days on `latest`, and check that it appears in `stable.json`.

```sh
morndo update --channel stable
morndo update --check
morndo update --status
```

Record: the version promoted, the time it appeared in `stable.json`, and the exit codes.

19. Set `morndo update window` to a window that excludes the current local hour. An automatic apply waits. `morndo update --yes` does not. `03:30-05:00` is the example; if that range includes now, use another zero-padded window of the same shape. `morndo update window any` is any hour again.

```sh
morndo update window 03:30-05:00
morndo update --yes
morndo update window any
```

Record: the window that was set, the local time, whether the automatic apply waited, the exit code of `morndo update --yes`, and the versions before and after that apply.
