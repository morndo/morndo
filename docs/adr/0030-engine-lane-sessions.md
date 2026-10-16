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
2. **A lane is found by its process being inside a pane's**: the pane's process (`#{pane_pid}`) is the lane or an ancestor of it (a launcher or shell in between is common). The file's `pidStartTicks` and `bootId` must match the live process, so a file left by a killed lane never claims a pid that another process took. The engine layer's file is not changed.
3. **The session id the node reports for an engine lane is the lane's process** (`engine-<pid>-<start ticks>`), not the file's `sessionId`. It is the same for the life of the `engine-lane` and different for a lane started in its place, which is what a delivery's binding means. `status` (busy, idle) and the transcript path come from the file.
4. **Send types into an engine lane's input line only when the caller knows the pane is one**: `pane.send` passes `engineLane` when the pane's session came from the engine registry. The last line of a shell can be `❯ ` as well, so the line alone never opens a pane to typing. An engine lane draws no menu, so the menu check is skipped for it; the draft check stays.
5. **A transcript line timed in whole seconds counts as written by the end of that second** (`readReceipts`). A time with a fraction stays exact. The engine lane records a `user` line when it takes a message, so that line is the receipt: delivered. A message typed while a turn runs is queued by the lane in order, and its line is written when it is taken.
6. `lane.stop` needs no change: `/exit` is typed like any text, and the lane ends and drops its file.

## Consequences

- `lanes send` and `lanes start --prompt` reach an engine lane and end `delivered`; one sent while a turn runs is kept. Engine lanes stop without `--kill`. Panes of engine lanes now report a `sessionId`, `sessionName` and `status` in the inventory, and the hub can read their transcripts (lines of other types are ignored by the hub's parser).
- The node depends on the engine layer's file shape (its `lane.py`, commit 683a7c9). `test/fixtures/engine-lane` pins it with made-up values; a change shows as a failing test.
- A lane's pane is found through `/proc` (or `ps` elsewhere): a few small reads per inventory poll for each live engine lane.
- Not done here: the hub's legacy single-host mode still reads Claude Code's registry only.

## Sources (checked 2026-10-16)

- `/proc/<pid>/stat` fields 4 (ppid) and 22 (starttime): https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html
- tmux `pane_pid` format variable and `paste-buffer -p` (bracketed paste): https://man7.org/linux/man-pages/man1/tmux.1.html
- The engine layer's `lane.py` (registry file, input line, transcript records) at commit 683a7c9, read on this machine.
