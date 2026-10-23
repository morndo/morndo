# Proof of work: a review brief with checkable proof on every task in review. Plan, revision 2

**Issue:** #58 (related: #33, the Home digest). **Status:** design only; no product code in this change.
**Revision 2, 2026-10-23.** Revises the plan of 2026-10-19 (a6a5b93) after the board began to move tasks by itself (ADR-0032, D1 to D4) and after a measurement of how "done" is claimed today. Code references are to `origin/main` at `0635d339` and were read on 2026-10-23; a reference without a commit is to that revision.
**Builds on:** ADR-0015 (the board), ADR-0032 (the board follows the fleet), B11 (merge records and the done gate), ADR-0023 (decision briefs), ADR-0025 (proposed: Claim, Evidence).

---

## Owner summary (one page)

**The problem, measured.** On one team's board, of 101 Dones accepted in three days (2026-10-20 to 10-23), 17 named a check or a commit that was not green at that moment, and about half named a commit or a pull request without its repository, so nothing could fetch them (product baseline 2026-10-23, private; counts only). **Correction, 2026-10-23:** the 17 were mostly one sweep on 10-21, and 15 of the 17 also named a record that held; the team that measured it wrote "Not a rate". Read the figure as "it happens", not as a frequency; the warn week (section 7) is what measures the rate. A free-text reason cannot be wrong in a way anyone notices. The fix is not more text; it is **references the board fetches itself**: `owner/repo#PR@sha`, and the CI checks of that sha.

**What changed since 10-19.**
1. The board now moves tasks without the lane's help (D1 to D4, `packages/domain/src/board.ts:398-432`). The 10-19 plan refused a worker's move to review without a brief; the board's own move to review cannot be refused, since the DONE has already happened. So the brief is no longer part of the move. It is its own action, filed before or after, and the board *flags* a review without proof and *gates* the Done.
2. A DONE with a wake-up pending did not reach review (T-398, fix in PR #119, open). Nothing in this design reads the lane's run. Verification starts from hub-side facts: a brief filed, a task entering review by anyone, a timer, a Done attempt.

**What each option buys.** Pick one; each is one tap.

| | Option | Cost (one lane, estimate) | Buys | Does not buy |
|---|---|---|---|---|
| **A** | **Verified refs only.** `morndo-board proof T-12 <ref>…`; the hub fetches them; a red or unfetchable ref refuses the Done. | about 3 days | Ends the 17-of-101 class of error and the repo-less reference. Smallest change. | No brief: nothing for the owner to read in the task, no "limits", no "decisions". |
| **B** | **Brief and verified refs** (**recommended**). A is included, plus the brief (summary, decisions, left out, limits, attested checks) shown in `morndo-board show` and in the task panel. | about 1 week (5 working days) | The task opens like an issue with what was done and why, and the proof beside it is checked by the board, not claimed. Works whatever the lane's turn looked like. | Screenshots; a human mark per proof item. UI work shows text and a CI link only. |
| **C** | **Full proof of work.** B, plus screenshots stored on the hub and shown inline, files, and a checked-by mark per item (the 10-19 plan). | about 3 weeks | The owner's own request in full (UI work with before and after images). | Not a v1: three PRs more than B, and the largest surface for leaking data. |

**Recommendation: B**, then C's screenshots as the next step once B has run for a week. The gate ships in *warn* mode for the first week (the Done is accepted, the record says what was not green), then *on*. Both are one setting, so either can be undone.

**Answer with one tap:** `A` · `B` · `C` · `Hold` (no change; the 10-19 plan stays parked).

---

## 1. The flow today (read on `0635d339`)

| Step | Where | What happens |
|---|---|---|
| CLI | `apps/board-cli/src/cli.ts:26`, `:252-257` | `morndo-board review T-12 [--note]` sends `{action:"move",to:"review"}`, then, only with `--note`, a second `{action:"comment"}`. Two events, not atomic. |
| Wire | `packages/protocol/src/board.ts:69-78` | `BoardActionBody`: `move`, `assign`, `edit`, `comment`, `merged`, `unmerged`. `merged` and `comment` carry no `ifRev`. |
| Route | `apps/hub/src/adapters/http.ts:437-465` | `POST /api/agent/board/tasks/T-12` goes to `service.actChecked` (`:465`); `GET` returns `service.task` (`:460-464`). |
| Service | `apps/hub/src/application/board-service.ts:114-135` (`act`), `:142-149` (`actChecked`), `:154-157` (`follow`), `:159-169` (`#write`) | One transaction: judge in the domain, write task and event, `record` the audit row. `actChecked` is where an async check runs before the sync domain call (today: `no_commit` against the hub's checkout). |
| Domain | `packages/domain/src/board.ts:248-360` (`applyAction`), `:133-139` (worker moves), `:142-148` (board moves) | Nothing is required to enter review. `TaskChange` (`:53-60`) has no place for a report. |
| The board's own moves | `board.ts:398-432` (`derivedMove`), `apps/hub/src/application/board-projector.ts:144-175` | D1 `doing→review` needs `run.phase === "ended"` with outcome `done`, or `waiting` on background with outcome `done` (`:409-410`). D2 `doing→blocked` (`:411`), D3 `doing→todo` (`:412`), D4 `todo→doing` (`:424-429`). The reason is the status line, at most `REASON_MAX` = 300 characters (`:94`, `:404`). |
| Done today | `board.ts:263-271`, `:276-293` | The manager's Done needs a free-text reason (B9). B11's gate holds Done for a morndo/morndo merge that is not live, and the principal's click is the recorded override (`:285-286`). |
| Existing typed refs | `board.ts:159-169` (`MORNDO_REPO`, `REPO_NAME`, `MERGE_SHA`, `MergeRecord`), `:334-346` (`merged` action), `board-service.ts:162-167`, `apps/hub/src/adapters/git-ancestry.ts` (`gitHasCommit`) | A lane may record `repo`+`sha` of its PR's merge; the hub checks it against its own checkout. These two shapes are the base of the refs below. |
| Store | `apps/hub/src/adapters/store.ts:555-562` (events), `:565-589` (merges); `apps/hub/src/adapters/migrations.ts:244-250` (v24 `board_merges`), `:252` (v25, the latest) | Next free migration is 26. Re-check when it opens. |
| Status line | `packages/protocol/src/lane-status.ts:14-45` | `STATUS: DONE T-285 …`; the board reads the word and the key. The line is capped at 200 characters (`:21`): it is a reason, not a brief. |
| UI | `apps/web/src/lib/markdown.ts` forbids `img`; `AGENTS.md`: "No QA screenshots, recordings, or evidence notes in the repo." | See §3.7. |

Not on `main` yet: the fix for T-398 (PR #119). On `main`, a DONE with a wake-up or a job pending becomes a `waiting` Run with no outcome (PR #119's description), so D1 does not fire. This plan must work in that case and after it.

## 2. Principles

1. **Two kinds of proof, labelled.** *Verified*: a reference the hub fetched from the forge and judged green at a stated time. *Attested*: the lane's words (tests it ran locally, a manual check). Attested proof is shown, never counted as verified, and never opens a gate on its own.
2. **The board verifies; the lane never does.** The lane names a reference. The hub fetches it with its own credentials. A lane's claim of "green" is not an input.
3. **A reference is whole or it is refused**: repository, number or sha, all present, all matching the grammar in §3.3. A bare `abc1234` or `#119` is refused at filing with the reason.
4. **The brief does not depend on the turn.** It is a separate action; verification is started by hub events (§3.6).
5. **No Verdict.** A brief, a green ref and a Done grant nothing (B8) and are not a Verdict Verified (ADR-0025).

## 3. Design

### 3.1 Where it lives

- **Domain** (new `packages/domain/src/proof.ts`; no network, no clock): `ProofRef` and its parser, `Brief`, `RefResult`, and `proofOf(brief, results)` → `ProofState`. Pure and table-tested.
- **Application** (new `apps/hub/src/application/proof-service.ts`): files a brief, runs verifications through a `ForgeChecks` port, stores results.
- **Adapter** (new `apps/hub/src/adapters/github-checks.ts`): the one implementation of `ForgeChecks`, over `fetch` to `api.github.com`. Replaceable; no other forge in v1.
- The board stays the owner of the task. The proof service never writes a task; it writes its own rows and asks `BoardService` for nothing except reading.

### 3.2 What a lane writes on DONE

One action, `brief`, on the task. Filed while the task is in progress *or* in review, by its assignee, or by the manager, the principal or the console (B2's hands). Never by the board itself (D5 stands). No `ifRev`: like a comment, it changes no state, so it races with nothing (`protocol/src/board.ts:74-76` gives the same reason for `merged`).

| Field | Kind | Size | Rule |
|---|---|---|---|
| `summary` | text | 1 to 500 chars | What changed, for whom. |
| `decisions` | text | 0 to 500 | Choices made and why. |
| `leftOut` | text | 1 to 300 | `nothing` is a value; empty is refused. |
| `limits` | text | 1 to 300 | Known limits and risks; `none known` is a value. |
| `refs` | list of `ProofRef` | 0 to 8 | Verified proof (§3.3). |
| `attested` | list of `{ kind, how }` | 0 to 6; `how` ≤ 300 | `kind` ∈ `tests`, `manual`, `ui`, `data`, `infra`; "what was run or looked at, and what it showed". |
| `noCode` | text | 0 to 200 | Set instead of `refs` for a task with no change in a repository (a memo, an analysis). Makes the Done gate accept attested proof only, visibly. |

Text fields: no control characters (`bad_text` as `board.ts:112-118`), no markdown images or raw HTML (they render as plain text in v1), key material refused (`redactKeyMaterial`, `packages/protocol/src/redact.ts`, used by `board-service.ts:13`). The whole brief is at most 8 KiB as JSON. Compare: a comment is up to 4000 characters (`board.ts:93`), a reason 300 (`:94`).

CLI (`apps/board-cli/src/cli.ts`, new `brief` command; `review` is unchanged):

```
morndo-board brief T-12 \
  --summary "Totals row rounds to cents" --decision "round at display, not at sum" \
  --left-out nothing --limit "locale formats not covered" \
  --pr acme/shop#42@3e9d1a7 \
  --ci acme/shop@3e9d1a7:ci,lint \
  --test "npm test -- totals: 48 passed, 0 failed, 2 skipped"
morndo-board brief T-12 --json brief.json      # the wire shape, for longer briefs
morndo-board brief T-12 --show [--json]        # what the hub holds, with each ref's state
```

The worker prompt block (`apps/board-cli/src/prompt.ts`, mirrored in `docs/agents/board.md`) says: file the brief *before* you end the turn when you can, and in any case file it when the task is in review.

### 3.3 Proof references

A ref is a typed, whole value. Parsed by one function in the domain, used by the CLI, the route and the verifier.

| Kind | Form | Parts | Checks |
|---|---|---|---|
| `pr` | `owner/repo#42@3e9d1a7` | repo (`REPO_NAME`, `board.ts:160`), PR number 1 to 9 digits, sha 7 to 40 hex (`MERGE_SHA`, `:161`) | the PR exists; its head sha starts with the sha, or it is merged and `merge_commit_sha` does |
| `ci` | `owner/repo@3e9d1a7:ci,lint` or `…:*` | repo, sha, 1 to 10 check names (each ≤ 100 chars) or `*`; `id=<digits>` may stand for a name | the named check runs at that sha, all green (§3.4) |

Rules:
- **A `ci` ref hangs off a `pr` ref**: its sha must equal the `pr` ref's sha (its head, or its merge commit once merged), or a merge record of the task (`board_merges`, B11). Otherwise the lane could name any green commit of any repository. Refused at filing as `ref_unrelated`. What this does *not* prove is that the PR contains the work; see §7, risk 1.
- **Repository allowlist.** Only repositories in `MORNDO_PROOF_REPOS` (default: `morndo/morndo`, plus the repositories of the task's merge records) are fetched; any other is refused as `ref_repo`. Why: the hub holds a credential that may see private repositories, and a lane must not use it to ask whether a repository exists.
- **Private repositories (decided 2026-10-23, in step 3).** About 45 of 106 recent Dones name a private repository. The repositories the hub may read are those of `MORNDO_PROOF_REPOS` (default `morndo/morndo`). The credential is optional and read-only: `MORNDO_GITHUB_TOKEN_FILE` names a file (absolute path, mode 600) the hub reads once at start; the token is never an environment value, a setting or a word in any log. Without it, a not-found answer for an allowed repository reads `private repo: not checked` (state `not_checked`, mark `○`): not red, not unfetchable, not retried, and not verified either, so the Done gate treats it like any reference that is not green (held in `on` mode, overridable, recorded in `warn` mode). With it, a not-found is a plain `unfetchable`. The warn week records the override reasons in each Done event's `proofSeen`, which names every reference with its repository, so overrides can be counted per repository.
- The 7-character form is accepted (the check-runs endpoint answered 200 for a 7-character sha on 2026-10-23) and the full sha is stored once resolved.
- Not in v1: statuses (the legacy commit status API), other forges, deployment refs, URLs. A URL in a ref field is refused; the hub never fetches an address a lane wrote.

### 3.4 How refs are verified: who, when, against what

**Who.** The hub's `ProofService` through the `ForgeChecks` adapter, with the hub's own read-only credential. Never the lane, never the manager's text.

**Against what.** GitHub REST, API version `2022-11-28` (header `X-GitHub-Api-Version`), read on 2026-10-23:
- `GET /repos/{owner}/{repo}/pulls/{n}` for `state`, `merged`, `head.sha`, `merge_commit_sha` ([Get a pull request](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#get-a-pull-request)). `merge_commit_sha` is the test merge before merging, the merge commit after a merge commit, the squashed commit after a squash, the base's new tip after a rebase; so for an open PR only `head.sha` is compared.
- `GET /repos/{owner}/{repo}/commits/{sha}/check-runs?per_page=100` (default `filter=latest`) for each run's `id`, `name`, `status`, `conclusion`, `head_sha` ([List check runs for a Git reference](https://docs.github.com/en/rest/checks/runs?apiVersion=2022-11-28#list-check-runs-for-a-git-reference)). The page documents `status` ∈ `queued, in_progress, completed, waiting, requested, pending` and `conclusion` ∈ `success, failure, neutral, cancelled, skipped, timed_out, action_required`. For a reference with more than 1000 check suites only the 1000 most recent are returned (same page); a result at that bound is treated as `unfetchable`, not green.
- Authentication: the docs say private repositories need the `repo` scope for classic tokens and do not state the permission for fine-grained tokens or public repositories. Observed on 2026-10-23: the public `morndo/morndo` answers both endpoints without a token (200), a repository that does not exist answers 404, and an unknown sha answers 422. Design consequence: no token means public repositories only; a token is optional (`MORNDO_GITHUB_TOKEN_FILE`, read-only, fine-grained). **Permissions, checked 2026-10-23** against [permissions required for fine-grained personal access tokens](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens): `GET /repos/{owner}/{repo}/pulls/{pull_number}` is listed under `Pull requests` (read) and under `Contents` (read), both with PAT supported. `GET /repos/{owner}/{repo}/commits/{ref}/check-runs` is **not listed there at all**: a `Checks` permission exists only for GitHub Apps ([permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps): `Checks` read, user and installation tokens, not PAT). So a fine-grained PAT with `Pull requests: read` reads pull requests, and whether it can read check runs is not established by the docs; it needs a test with the real token. Documented alternatives: a GitHub App installation token with `Checks: read` and `Pull requests: read`; or, for a PAT, `Actions: read` (`GET /repos/{owner}/{repo}/actions/runs`, workflow runs by head sha) in place of check runs. Neither is built; the owner decides after the first real try. A 404 is `unfetchable` whether the repository is missing or private.
- Limits ([rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2022-11-28), read 2026-10-23): 60 requests an hour per IP without a token, 5,000 with one. The adapter reads `x-ratelimit-remaining`, `x-ratelimit-reset` and `retry-after`; on 403 or 429 it stops until the stated time. This sets the re-check cadence below.

**The result of one ref** (`RefResult`, stored; never an event, because an event bumps the task's `rev` and would make a lane's own `ifRev` move fail as `changed`, `board.ts:249`):

| State | Means | Shown as |
|---|---|---|
| `green` | `pr`: open or merged, sha matches. `ci`: every named run `completed` with `success`; for `*`, at least one run, none red or pending. | ✓ |
| `pending` | a named run is queued, in progress or absent *and* the sha is young (under 15 minutes since the brief); `*` with a run not completed. | … |
| `red` | any named run `failure`, `cancelled`, `timed_out`, `action_required`; a PR closed without merge. | ✗ with the run's name |
| `mismatch` | the PR's head moved on from the sha in the ref (the proof is for older code). | ≠ with both shas |
| `missing` | a named check does not exist at that sha after the young period; `neutral` or `skipped` when named explicitly (a check that did not run is not evidence). | ? |
| `unfetchable` | 404, 422, 401/403, rate-limited, timeout (8 s), network error, the 1000-suite bound. The reason is kept. | ! with the reason |

Each result keeps `checkedAt`, the full sha, and for `red` the first failing run's name and `html_url` (a link to show, never fetched by the hub).

**When.** All four start from the hub's own events; none reads a Run:
1. **A brief is filed** (`ProofService.file`, after the transaction).
2. **A task enters review**, by any actor, including the board's D1 or a lane's explicit `review` (`BoardService.#write` sees a `moved` change `to: "review"` and calls the proof service after commit). This also verifies the task's merge records' shas.
3. **A timer** re-checks refs in `pending`, `unfetchable` (rate limit or timeout only) while the task is in review: every 2 minutes with a token, every 10 minutes without (the 60-an-hour limit), for the first hour, then every 30 minutes, at most 12 tasks per pass.
4. **A Done attempt**: `BoardService.actChecked` first refreshes any result older than 30 seconds (8 s timeout each, all refs in parallel), then calls the domain with the fresh results in the gate, the way it asks the checkout about a merge record today (`board-service.ts:142-149`). The check and the judgement are separate steps; the judgement stays synchronous and pure.

### 3.5 When a ref is not green or cannot be fetched

- **The task stays in review.** The board does not move it back (BOARD_MOVES `review→doing` exists, `board.ts:147`, and no rule uses it for this; D4 leaves review alone, `:424-429`). A red CI on a task in review is often a flaky run or another PR's problem; the manager decides.
- **The card shows why**, in one line from `ProofState`: `proof: 2 of 3 green · ✗ acme/shop@3e9d1a7 ci "lint" failed · ! acme/shop#42 unfetchable (rate limit, retry 14:10)`. `morndo-board list` and `show` print the same line. The states: `no brief`, `unchecked` (nothing verifiable), `pending`, `failing`, `unfetchable`, `verified`, `attested only`.
- **A Done is refused** as `proof_not_green` (new `BoardProblem`, `board.ts:72-86`) with `detail` the same line, unless the Done carries an override reason: `done T-12 --why "…" --proof-override "<reason>"` (≤ 300). The principal's click is the override, recorded, as for `not_live` (`board.ts:282-286`). The Done event records what the board saw (`proofSeen`, a short line), so the record says "accepted with `lint` red".
- **Gate modes**, one setting `MORNDO_PROOF_GATE` = `off` | `warn` | `on`. In `warn` the Done is accepted and the event's `proofSeen` carries the problems; this is the rollout week. A task already in review when `on` starts is judged like any other (it has no brief; an override reason accepts it).
- **No brief at all** on a Done in `on` mode is `proof_not_green` too, unless `noCode` or `--proof-override`.
- **The manager's own reason is linted, not parsed.** If the `--why` text holds a 7 to 40 hex token or a `#<n>` that is not among the task's verified refs, the CLI prints a warning ("names a commit the board did not verify") and the hub records nothing. It never refuses on prose.

### 3.6 Independent of the lane's turn (the T-398 case)

| Situation | What happens |
|---|---|
| Lane ends `STATUS: DONE T-12`, D1 moves the task, brief filed *before* | Review entry (trigger 2) verifies the brief's refs at once. |
| D1 does not fire (wake-up pending; T-398) and the manager or the lane moves the task by hand | Trigger 2 fires on the explicit move; same result. |
| Task reaches review, no brief ever filed | Card says `no brief`. `morndo-board list --status review` lists it. The Done is gated (§3.5). Nobody has to wake the lane for the board to know. |
| Brief filed after the move, in review | Accepted (§3.2); trigger 1 verifies. |
| The task goes back to doing and returns | The brief of the earlier round is *stale*: a brief counts only if no `review→doing` move has a higher `rev` than the brief's event. A new entry into review needs a new brief; `brief --show --from-last` prints the old one to edit. |
| The hub restarts with refs `pending` | Results are rows, not memory; the timer resumes from the table. |

### 3.7 UI proof (screenshots) without real data in a public repository

The repository is public and `AGENTS.md` bans QA screenshots, recordings and evidence notes in the tree; fixtures use made-up names, hosts, paths and ids. So:
- **Screenshots never enter git.** Not the product's repository, not a user's pull request description by default. They live in the hub's data directory (content-addressed, SHA-256, mode 0700), beside `files.ts` and not inside its eviction budget, and the brief names them by id.
- **Where they come from.** Bytes over HTTPS from the lane (`--shot after.png`), never a path on the hub's machine; an image is sniffed from its bytes (PNG, JPEG, WebP, GIF; never SVG), stripped of metadata (`stripMetadata`, `uploads.ts:33`), capped at 10 MiB, at most 6 per brief and 40 MiB per task. Served only to a signed-in session or an agent token, with the sandbox headers `servingHeaders` sets (`apps/hub/src/adapters/files.ts:122`). No public or signed links. Rendered by the app from its own origin; `markdown.ts` keeps forbidding `img`.
- **What cannot be checked.** Images are not scanned for secrets or personal data. The panel labels them "not scanned", the prompt tells lanes to crop to the change, and the owner decides what a UI task may show.
- **For the project's own tests and docs:** images are generated in test code (a few synthetic pixels), never committed as files; the docs describe the flow in words. Real QA evidence stays in the owner's private QA record, as `AGENTS.md` requires.
- **v1 (option B) has no screenshots.** A UI task's proof is `ci` plus an `attested` `ui` item in words. The card shows `ui task: no images (planned)`. This is the main thing option B does not buy.

### 3.8 Security and privacy

- The hub fetches only `api.github.com` endpoints built from validated parts (`REPO_NAME`, a hex sha, a number). It never fetches an address from a brief.
- Repository allowlist (§3.3) so a lane cannot probe private repositories through the hub's credential.
- The credential is configuration of the hub, never stored in a task, brief or audit row. The audit records `BoardChanged` with `briefed` and the actor, never the brief's text (B6; `boardChanged`, `board.ts:381`).
- Paths in a user's home folder and e-mail addresses in brief text are redacted at filing by the existing redactor; the CLI prints what will be stored.
- Verification calls are bounded: 8 s each, at most 10 requests in flight, rate-limit headers honoured.

## 4. Rules to add (`docs/domain.md`)

`domain.md` lists B1 to B11 (`docs/domain.md:523-534`); B12 is cited in code (`board.ts:389`, `:406`) and in ADR-0032's amendment but has no row. New rules start at **B13**, which no remote branch uses on 2026-10-23; re-check when the PR opens.

- **B13 A brief is the assignee's word, filed as its own action.** Any time the task is in progress or in review; never by the board (D5); history is append-only; the latest counts; one from before a `review→doing` is stale.
- **B14 Proof is verified by the hub or it is attested.** A ref is whole (repository, number or sha); the hub fetches it with its own credential; a result is `green`, `pending`, `red`, `mismatch`, `missing` or `unfetchable`; attested text never counts as verified.
- **B15 Not green stays in review.** No rule moves a task because of a ref's state; the card says why; the board's moves (D1 to D4) are unchanged.
- **B16 The Done is gated on the proof, with an override that is recorded.** `proof_not_green` unless every verifiable ref is green and at least one exists (or `noCode`); the override reason (the manager's) or the principal's click is recorded in the Done event with what the board saw. Mode `off|warn|on`.
- **B8 still holds:** none of this is a Mandate, a Decision, Evidence in ADR-0025's sense, or a Verdict.

## 5. Smallest v1 (option B) and what is deferred

Five working days, one lane, in this order; each step ends with its tests green.

| Day | Work | Done when |
|---|---|---|
| 1 | `proof.ts` in the domain: ref grammar, brief limits, `proofOf`; `TaskAction`/`TaskChange` `brief`/`briefed`, `proofSeen` on `moved`; protocol schemas; `proof_not_green`, `ref_unrelated`, `ref_repo`. | Domain tests (§6) pass; `npm run check` green. |
| 2 | Migration 26 (additive): `board_briefs` is not needed (the brief is the `briefed` event's JSON); table `board_proofs (key, brief_rev, ref, state, detail, checked_at, PRIMARY KEY (key, brief_rev, ref))`. Store methods. `ProofService.file`. | Hub tests for filing, staleness, restart. |
| 3 | `github-checks.ts` adapter against a recorded-response fake server (no network in tests); verification triggers 1, 2 and 4; the timer (trigger 3); the Done gate with the three modes; **private repositories** (the token file, the `not_checked` state, the allowlist from `MORNDO_PROOF_REPOS`). | Hub tests for every state in §3.4 and the gate; a private ref without a token is not checked, with a token the fake forge answers, the token never appears in a log (a control). |
| 4 | CLI `brief`; `show` and `list` print the proof line; prompt block and `docs/agents/board.md`; `--why` lint. ADR and `docs/domain.md` rows. | CLI tests; docs agree with the prompt (the existing equality test). |
| 5 | Task panel: the brief and the per-ref line (text only); manual QA from a clean install against a scratch hub and a scratch repository; fix what it finds. | e2e test; QA record kept in the private QA record, not in this tree. |
| 6 | **The assigner's proof list** (added 2026-10-23, same PR, after step 5): see below. | Domain and hub tests; the card and the Done line show `not covered`. |

**Step 6: the assigner's proof list.** When a task is assigned, its assigner (the manager or the principal) may file a proof list: the kinds of proof the work needs, in words ("PR in owner/repo with CI green", "data sample of 30 rows", "UI screenshot"). The brief's refs and attested items are matched to the list; an item with nothing against it shows `not covered` on the card and in the Done gate's line. The lane can add items to the list and cannot remove the assigner's. Why: a checker of the worker's own list cannot catch what the worker left off (team decision 2026-10-20, section 6.2); `docs/domain.md:31` (the Check) is the vocabulary. Design to be written at the start of the step (where the list is stored, the matching rule, whether a `not covered` item holds the Done in `on` mode); it follows the same pattern as the brief: its own action, no change of the task's state, results as rows.

**Deferred (each is a later PR, named so it is not forgotten):** screenshots and files (§3.7, option C); a human "checked" mark per item and "nobody checks their own work" (10-19 plan B11); a markdown brief parser; rounds as their own table; retention and eviction of attachments; the engine-lane environment check (PR #49 is merged; `apps/node-agent/src/ops/lane-engine.ts` does not mention `MORNDO_AGENT_TOKEN` or `MORNDO_HUB`, while `apps/node-agent/src/relay/board-token.ts` and `agent.ts` do; whether an engine lane's shell gets them is not verified); legacy commit statuses; other forges; a nudge comment from the board to a lane whose review has no brief; moving a task back to doing on a red ref; feeding briefs into the Home digest (#33); secret scanning of images.

## 6. Acceptance tests (named; written red first)

`packages/domain/test/proof.test.ts`
- "a ref without its repository is refused"
- "a bare sha and a bare pull request number are refused"
- "a 7-character sha is accepted and a 6-character one is not"
- "a ci ref whose sha is not its pr ref's sha or a merge record is refused as ref_unrelated"
- "a url in a ref field is refused"
- "proofOf: one red ref makes the task failing whatever else is green"
- "proofOf: attested items never make a task verified"
- "proofOf: noCode alone is attested only, and the gate accepts it"
- "a brief older than the last review to doing move is stale"

`packages/domain/test/board.test.ts` (added)
- "a done with a red ref is refused as proof_not_green naming the ref"
- "a done with no brief is refused in on mode and accepted in warn mode with proofSeen"
- "the principal's accept is recorded as the override"
- "the manager's override reason is recorded in the done event"
- "the board's D1 move to review is made with no brief and the card says no brief" (the board's move cannot be refused)
- "a brief filed by the board actor is refused"

`apps/hub/test/proof-service.test.ts`
- "a brief filed in review is verified at once"
- "a task moved to review by the board's D1 has its refs verified" (replay of the move, no Run read)
- "a task moved to review by hand with a wake-up pending has its refs verified" (the T-398 shape)
- "a pending ref turns green at the next timer pass without any lane action"
- "a ref that stays unfetchable keeps the task in review with the reason on the card"
- "a rate-limited answer stops calls until the reset time"
- "a repository outside the allowlist is never fetched" (fetch spy)
- "the hub fetches nothing for a url in a brief" (fetch spy)
- "results survive a hub restart"
- "re-checking never changes the task's rev" (a lane's ifRev move after a re-check still succeeds)
- "a pr whose head moved reports mismatch with both shas"
- "a skipped named check is missing, not green"

`apps/board-cli/test/cli.test.ts` (added)
- "brief T-12 --pr … --ci … files one action and prints the ref states"
- "a ref missing its repository exits 1 with the grammar"
- "--why naming an unverified sha prints the warning and still sends"
- "prompt blocks still equal docs/agents/board.md"

`e2e/board-proof.e2e.ts`: "a task in review shows the brief and one line per ref, with a red one marked and the Done refused" (scratch hub, recorded forge responses).

Negative controls for the two tests that matter most (the Done gate and the D1-independent trigger) are added with them: the test must fail when the gate or the trigger is removed.

## 7. Assumptions, risks and what would prove this wrong

Assumptions, each with where it was checked:

| # | Assumption | Evidence |
|---|---|---|
| 1 | The board's own move to review cannot be refused or conditioned on a brief. | `BOARD_MOVES`, `board.ts:142-148`; `derivedMove` returns a move from the Run alone (`:398-413`); `follow` passes only a reason (`board-service.ts:154-157`). |
| 2 | D1 does not read comments or briefs, so filing a brief cannot move the task. | `derivedMove` reads `task.stateChangedAt`, which a comment leaves alone (`next(…, false)`, `board.ts:332`); the brief's change is written the same way. |
| 3 | A brief and a merge record share the pattern "an action that changes no state, allowed to the assignee or the board's hands". | `board.ts:334-346`. |
| 4 | An async check before the sync domain call is an existing pattern. | `board-service.ts:142-149`. |
| 5 | A Done can carry a recorded override the principal gives by clicking. | `board.ts:282-286`. |
| 6 | Repeated re-checks must not touch `rev`. | `board.ts:249` (`ifRev` compares `rev`), `:253`. |
| 7 | Public-repository reads work without a token; unauthenticated limit 60/h. | Probe and docs, 2026-10-23 (§3.4). |
| 8 | The next migration is 26, the next ADR 0035, the next rule B13. | `migrations.ts:252`; `ls docs/adr` (0034 last); `domain.md`. Re-check before committing. |

Risks, honestly:
1. **A green CI proves the commit passed, not that the commit holds the work.** A lane can name a real, green, unrelated PR. The `ci`-hangs-off-`pr` rule and the allowlist narrow it; the reviewer still reads the diff. If forged-but-green refs appear in practice, add a check that the PR's changed files intersect what the task describes, or that the PR links the task key.
2. **Gate fatigue.** If overrides become routine, the gate is noise. Measure overrides per Done during the `warn` week; if more than 20% need an override, tune before `on`.
3. **Rate limits without a token** (60 an hour per IP) make the timer slow for a small team on a shared address. The cadence in §3.4 (about 12 requests an hour for a task with a pending pull request and CI ref) stays within it for about 4 tasks in review; more needs the token.
4. **The model vendors or the forge could ship this.** GitHub shows check results on a pull request already; what it does not hold is *which task* and *which lane* claimed what. The brief is the join. If a forge ships a task-to-check link, this plan shrinks to the brief.

**What would prove this wrong:** in the `warn` week, (a) the hub finds a red, mismatching or unfetchable ref on almost no Done (the baseline's 17 of 101 was then not about proof, or the lanes already check), or (b) more than 20% of Dones need an override, or (c) the owner never opens a brief. Then the lane's word was never the problem and the effort belongs in the review pipeline instead.

## 8. What stays from the 10-19 plan, and what does not

| 10-19 element | Now |
|---|---|
| Review brief with implemented and proof parts | Kept, smaller: §3.2. |
| Refuse a worker's move to review without a brief (B9) | Dropped. The board's own move cannot be refused (assumption 1); the gate moves to the Done (B16). |
| Proof kinds ui/backend/infra/data with per-kind lint | Dropped for v1: `attested.kind` is a label; only `pr` and `ci` are verified. |
| Screenshots, attachments store, retention | Deferred to C (§3.7). |
| Per-item checked-by marks, "nobody checks their own work" | Deferred. |
| Rounds as tables, `brief template`, markdown parser | Deferred. |
| Migration 23, rules B9 to B13, ADR-0030 | Renumbered: migration 26, rules B13 to B16, ADR-0035 (draft in `docs/adr/0035-proof-refs-on-review.md`). The numbers in the old plan are taken. |
| Hub never fetches a URL from a brief | Kept, and narrowed: it fetches fixed `api.github.com` endpoints built from validated parts (§3.8). |
