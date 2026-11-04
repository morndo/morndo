# ADR-0042: A merged pull request is flagged, never acted on

- **Status:** Accepted, 2026-11-04, decided for the owner while he was away. Built in the pull request that adds this
  file; this is part C of T-805 (ADR-0040 part A's "Later parts" named it: "Reading the merges of a task's pull
  requests itself, so the board stops trusting a lane's word that one merged").
- **Builds on:** ADR-0015 (the board), ADR-0032 and its addendum (merge records, B11), ADR-0035 (the proof of work,
  B14), ADR-0038 and ADR-0040 (the forge wall the waits and the sweeps share).
- **Rules:** B23 in `docs/domain.md`; B11 and B14 are amended with it. No migration: the flag is computed from what
  the board and the briefs already hold, plus what the forge answers.

## Context

The owner's lane stalls when a pull request merges and nobody tells the board: the task sits in review with a brief
naming the pull request, the merge is real on the forge, and the board still shows open work — the cleanup of
2026-11-04 (ADR-0040) found pull requests merged days before that the board still showed as open. B11 made a merge a
record somebody writes, and B14 made Done wait on it; nothing told anybody that the moment had come. The deadlock cut
the other way too: B14 asked a task with a merge record for a brief reference in that repository, but the hub only
fetches the repositories its settings list, so a record in an unread repository could never be answered — such a task
could be briefed only by refusing its briefs.

The hub already reads pull requests for a blocked task's waits (ADR-0038) and for a brief's references (ADR-0035),
through one forge adapter and one rate wall, only in `MORNDO_PROOF_REPOS`.

## Decision

1. **The hub reads the pull requests the open tasks' briefs name** — the references of each task's newest brief,
   whatever round filed it (a lane back in progress keeps the pull request it named), of the tasks in to do, in
   progress, blocked or in review — only in the repositories its settings list (B14: task data never widens the
   list), through the forge the proof checks use, within an hourly budget of its own that mirrors the waits' (60
   reads an hour with a forge credential, 5 without: the anonymous wall is shared with the proof checks and the
   waits). A merged answer is final and never asked again; an open one is asked again no sooner than 14 minutes
   after its last ask — a minute short of the pass, so a pass every quarter hour reads it every time however long
   the forge took to answer — and one the forge reported closed without merging only every 6 hours (it will not
   change on its own, and it must not spend the budget a newly named pull request needs). A pass every 15 minutes,
   the first 90 seconds after start.
2. **A pull request that merged while its task records no merge of it is flagged** (B23): the flag names the task,
   its status, the pull request and the commit it merged as. The facts are the last pass's, kept per pull request;
   the flags are computed live, from those facts against the board as it stands — a task that left the open
   statuses, a merge just recorded, a brief that no longer names the pull request: gone at once, before any pass
   runs, and the status shown is the task's now — and only the tasks the last pass found naming a merged pull
   request are looked at, one board read each, so a board push reads no task without need; a task that names a
   merged pull request only after that pass is seen at the next. They ride the board view (`mergedPrs`), the CLI lists them
   (`morndo-board merged`, a tag in `morndo-board list`), and the manager's lane is told in one message on the stale
   sweep's rhythm (B20): at once when the list changed, at most every 12 hours while it is the same, again at the
   next pass when a message did not go. The sweep follows each of the watch's passes and never goes before it, so it
   always sends the list that pass just read.
3. **A task that already records the merge is not flagged**: a record in the same repository (either's case) of
   the same commit as the merge the forge gave or as the pull request's head (a lane may record the head it worked
   at; either length of sha), or of any commit there when the forge gave none, stands for the merge. And the
   deadlock is gone (B14, amended) at every reading alike — proofOf, in the view and at the done gate, judges the
   rule as checkBrief judged the filing: the "reference in that repository" rule now bites only on merge records in
   a repository the hub reads — one in an unread repository could never be met, so it asks nothing.

The flag never moves a task (D5), never writes a merge record (B11: recording stays the manager's, the principal's,
the console's or the lane's own act), and never assigns or edits anything (B8). The message says so itself:
"Nothing was moved or recorded: record the merge, or finish the task, when it is time."

## Consequences

- The manager's lane learns of a merged pull request within a quarter hour of a pass, without the lane or the owner
  saying a word; the principal sees the tag in `list` and the view.
- The three settings that govern the reading are the owner's to change later and are **not changed here**:
  `MORNDO_PROOF_REPOS` (which repositories are read), `MORNDO_GITHUB_TOKEN_FILE` (the credential, and with it the
  hourly budget) and `MORNDO_FORGE_URL` (a stand-in forge). Unset, the flag reads only `morndo/morndo`.
- The hub's forge reads grow by the briefs' pull requests, bounded by the new budget; a repository outside the
  settings is never asked, whatever a brief names.
- A restart forgets what was final (a merged answer is kept for the life of the process) and reads again; only the
  facts are as of the last pass — the flags are computed against the board as it stands, so a merge recorded or a
  task that moved on is gone at once, and the sweep, following each pass, never names what the pass's list has
  already lost.

## Alternatives considered

| Option | Verdict |
|---|---|
| Write the merge record automatically when the forge says a pull request merged | Refused, by the manager's ruling: a record is somebody's act (B11), and a hub that writes one would make the Done gate judge evidence nobody vouched for. |
| Move the task to review (or done) when its pull request merges | Refused for now, by the same ruling: the board moves a task only by D1 to D7 (B10, D5). Flag first; a move may come later if the flags prove noisy. |
| Trust the lane to report the merge (prompt text only) | Rejected. That is what stalled: nothing watched, and the cleanup of 2026-11-04 found days-old merged pull requests still shown as open work. |
| Read every pull request of every repository the hub settings list | Rejected. Only what a brief of an open task names is read, within a budget, and a merged answer is final — the reading is bounded by the work, not by the forge's size. |
