# ADR-0030: Engine lanes are found where their engine records them, and take briefs like any lane

- **Status:** Accepted, 2026-10-16.
- **Number:** 0028 and 0029 belong to other pull requests.
- **Builds on:** ADR-0006 (the Claude Code session registry as an anti-corruption adapter), ADR-0013 (Roles, Engines, Chains), ADR-0014 (the delivery queue), ADR-0027 (lanes start on a Role's engine).

## Context

ADR-0027 lets `lane.start` run a lane on another engine (Codex, Cursor, ...): the window runs the engine layer's `engine-lane`, which turns each message typed into it into one headless turn of the engine. The delivery queue (`lanes send`, `lanes start --prompt`) types only into a pane with a live session, and the node agent found sessions in Claude Code's registry alone. So every brief to an engine lane waited `no_session` until it expired, and a lane could not be stopped with `/exit` either. Three more things stood in the way once the lane was found:

1. The engine lane's registry file (`$ENGINES_SESSIONS/<pid>.json`, default `~/.local/share/engines/sessions`) names no tmux pane.
2. Its `sessionId` is the lane's own id until the engine names a session, then the engine's, and the lane's again after `/clear`. The queue binds a delivery to the session it was queued for and gives it up when another session takes the lane's name, so a brief sent while a turn ran would have been given up.
3. Its input line is `❯ ` and the text as the last line on screen, with no rule above it and no menus. The send checks look for Claude Code's box (a `❯` line under a rule) and refused it (`no_input_box`). Its transcript stamps its `user` lines in whole seconds, so a line written in the second a text was typed in looked older than the typing.

## Decision

1. **A second adapter, `engineSessionRegistry` (node-ops), reads the engine layer's registry**, read-only, beside the Claude Code one. `combineSessions` offers both as one source: Claude Code's session for a pane it holds, else the engine lane in it. Inventory, the guard, transcripts and the deliverer all read that source.
2. **A lane is found by being the foreground job of a pane's terminal**: its process group is the foreground group (`tpgid`) of the pane's process (`#{pane_pid}`), read from `/proc`. A lane stopped with Ctrl-Z or sent to the background is not, so the pane is the shell's again and nothing is typed into it as if it were the lane. The file must be a live lane's: its `pidStartTicks` and `bootId` are required and must match the process now, so a file anyone wrote, or one left by a killed lane, claims nothing. No `ps` is spawned; where `/proc` has no entry the process is gone, which means engine lanes are found on Linux only for now. The engine layer's file is not changed (it could record `TMUX_PANE`, but the foreground check already ties a lane to its pane, so the field would only repeat it).
3. **The session id the node reports for an engine lane is the lane's process** (`engine-<pid>-<start ticks>`), not the file's `sessionId`. It is the same for the life of the `engine-lane` and different for a lane started in its place, which is what a delivery's binding means. The file's ids (the lane's own, the engine's) are kept as `aliases`, which is what the lane's own hooks name it by, so the relay maps a hook to its window. `status` (busy, idle) comes from the file. The lane's transcript is served only when its real path is a `.jsonl` file inside the engine layer's transcript directory (`ENGINES_TRANSCRIPTS`, default `~/.local/share/engines/transcripts`), looked up on each read.
4. **Send types into an engine lane's input line only when the caller knows the pane is one**: `pane.send` passes `engineLane` when the pane's session came from the engine registry. The last line of a shell can be `❯ ` as well, so the line alone never opens a pane to typing. An engine lane draws no menu, so the menu check is skipped for it; the draft check stays.
5. **A receipt is a transcript line that starts after the typing began.** The deliverer keeps the transcript's size from just before each typing, and `readReceipts` accepts only lines that start at or after it (a time with a fraction must agree too). An engine lane times its lines in whole seconds, so the time alone can't say a line came after a typing in the same second; the offset can. After an agent restart the size is lost, and a whole-second line then counts only from the next second on. The engine lane records a `user` line when it takes a message, so that line is the receipt: delivered. A message typed while a turn runs is queued by the lane in order, and its line is written when it is taken.
6. `lane.stop` needs no change: `/exit` is typed like any text, and the lane ends and drops its file.

## Consequences

- `lanes send` and `lanes start --prompt` reach an engine lane and end `delivered`; one sent while a turn runs is kept. Engine lanes stop without `--kill`. Panes of engine lanes now report a `sessionId`, `sessionName` and `status` in the inventory, and the hub can read their transcripts (lines of other types are ignored by the hub's parser).
- The node depends on the engine layer's file shape (its `lane.py`, commit 683a7c9). `test/fixtures/engine-lane` pins it with made-up values; a change shows as a failing test.
- A lane's pane is found through `/proc`: a few small reads per inventory poll for each live engine lane and pane.
- Not done here: the hub's legacy single-host mode still reads Claude Code's registry only.

## Sources (checked 2026-10-16)

- `/proc/<pid>/stat` fields 5 (pgrp), 8 (tpgid, "the ID of the foreground process group of the controlling terminal of the process") and 22 (starttime): https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html
- tmux `pane_pid` format variable and `paste-buffer -p` (bracketed paste): https://man7.org/linux/man-pages/man1/tmux.1.html
- The engine layer's `lane.py` (registry file, input line, transcript records) at commit 683a7c9, read on this machine.
