# Proof of work: a review brief with evidence on every task in review. Plan

**Issue:** #58 (related: #33, the Home digest). **Status:** design only; no product code in this PR.
**Builds on:** ADR-0015 (the board, B1 to B8), ADR-0023 (decision briefs: one markdown template, one lint shared by CLI and hub), ADR-0025 (proposed: Claim, Evidence, V1 and V2 in `packages/domain/src/verification.ts`), ADR-0006 addendum "Files" (the hub's content-addressed copies).
**Name:** the issue says "brief". The language already has a *Decision brief* (ADR-0023), so this one is a **Review brief**: the worker's account of one review round of one task. In the record and UI it shows as "Brief".

## 1. The current flow (main at c8124a8)

| Step | Where | What happens |
|---|---|---|
| CLI | `apps/board-cli/src/cli.ts:26` (usage), `:216-222` | `morndo-board review T-12 [--note "…"]` sends `{action:"move",to:"review"}`, then, only if `--note` was given, a **second** call `{action:"comment",text}`. Two events, not atomic: a failed comment leaves a task in review with no note. |
| Prompt | `apps/board-cli/src/prompt.ts:17`, `:39` | Tells the worker the review note is "what you ran, the result". Free text, optional. |
| Route | `apps/hub/src/adapters/http.ts:353-371` (bearer token, `X-Morndo-Lane`), `:388-393` | `POST /api/agent/board/tasks/T-12` reads `BoardActionBody`; the app's twin is `/api/board/tasks/T-12` at `:670-680` (a Command, AC7). |
| Service | `apps/hub/src/application/board-service.ts:61-81` | `act()` loads the task, calls the domain in one transaction, writes task + event + audit (`#write`, `:83-87`), pushes the whole board (`#tell`). |
| Domain | `packages/domain/src/board.ts:113-122` (worker moves: doing→review, review→doing), `:162-178` (`move`) | Nothing is required to enter review. `TaskChange` (`:44-49`) has no place for a report. Done is acceptance, not a Verdict (B3, B8; header `:1-7`). |
| Store | `apps/hub/src/adapters/store.ts:430-440` (`saveTask`, `saveTaskEvent`, `taskEvents`), tables from migration 13 (`apps/hub/src/adapters/migrations.ts:132-141`) | `board_tasks`, `board_events`. Latest migration is 22 (`:228`). |
| UI | `apps/web/src/lib/desktop/TaskPanel.svelte:119` (description as plain text), `:142` ("Accept as done" on any task in review), `:159-170` (record: one line per event, comments in full) | A review note is just a comment in the record. No images: `apps/web/src/lib/markdown.ts:16-19` forbids `img` and allows only `https:`/`mailto:` links. |
| Files | `apps/hub/src/adapters/files.ts:1-7`, `:45-51` (oldest evicted past 2 GiB), `:122-134` (`servingHeaders`: CSP sandbox, nosniff, same-origin); route `http.ts:550-560` | Copies are taken from a **path** on the hub's machine. No upload route for agents; `/api/uploads` (`http.ts:562`) is the principal's images for steering, kept a week (`uploads.ts:14`). |
| Evidence | `packages/domain/src/verification.ts:21-44` (`Producer`, `Evidence`, kinds `screenshot`, `tests`, `deploy`, `file`…), `:172-173` (`safeLink`), `:195-214` (`claimantsOf`, `independentOf`) | Domain only; no hub code yet (ADR-0025 is proposed). |

So today a review note is an optional comment; the reviewer digs through terminals and pull requests.

## 2. Design

### 2.1 The Review brief (Board context, `packages/domain/src/review-brief.ts`)

One brief per **round**. A round opens each time the task enters review; the brief is filed in the same action and is immutable.

```ts
type ProofKind = "ui" | "backend" | "infra" | "data";
type ReviewBrief = {
  implemented: {
    summary: Md;              // ≤ 1200: what changed, for whom
    changes: ChangeRef[];     // { kind: "pr", url } | { kind: "commit", repo, sha } ; 0..20, https/sha only
    decisions: Md;            // ≤ 1200: choices made and why
    leftOut: Md;              // ≤ 600; "nothing" is a value, empty is not
    limits: Md;               // ≤ 600: known limits and risks
  };
  proof: ProofItem[];         // 1..12
};
type ProofItem = {
  id: string;                 // p1..p12, stable within the round
  kind: ProofKind;
  title: string;              // ≤ 80, one line: "Totals row rounds to cents"
  how: Md;                    // ≤ 800: what was run or looked at, and what it showed
  shots?: { before?: AttachmentId; after: AttachmentId; caption?: string }[];   // ui: ≥ 1 after
  tests?: { passed: number; failed: number; skipped: number; command: string; failedBefore?: string };
  samples?: { label: string; text: string }[];       // request/response, query result, log lines; ≤ 4 KiB each
  files?: AttachmentId[];     // logs, CSV, diffs
  links?: string[];           // https only, safeLink() rules
};
```

Lint (`lintReviewBrief`, one function used by CLI, hub and a dry run, as DB10 is) requires per kind:
- **ui:** at least one `after` image; `before` strongly advised (warning when missing).
- **backend:** `tests` with `failed === 0`, or a `samples` entry; `failedBefore` advised for a fix.
- **infra:** a sample named `health` and one named `rollback` (the prepared rollback, or "none possible: why").
- **data:** samples `before-counts`, `after-counts` and `rows` (a few changed rows next to the source).
Markdown fields use the decision-brief subset (DB7): no headings, no raw HTML, no images, https links only.

**Examples (made up), one per kind, ship in `docs/agents/review-brief.md`** and as `morndo-board brief template --kind <k>`:
- ui: "Invoice list: empty state", before/after shots of `/invoices` with no rows.
- backend: "Rounding of line totals", `npm test -- totals` 48 passed, `failedBefore: rounds 0.005 down`.
- infra: "Staging worker on new image", health `GET /healthz 200 in 41 ms`, rollback "redeploy tag v1.4.2".
- data: "Backfill of country codes", before 1,204 nulls, after 0, five rows beside the source CSV.

### 2.2 Attachments

- **Store:** a new `boardFiles` store under the hub's data dir (`board-files/`, mode 0700), content-addressed (SHA-256) like `files.ts` but **not** evicted by the transcript budget: a brief must not lose its proof. Kept while the task is open and 180 days after done; then the file goes and the brief shows "removed by retention".
- **Upload:** bytes over HTTPS, never a path. A file is first **staged** against a task (by the assignee while doing, or the manager) and becomes part of a brief only when the brief names it. Staged files no brief named are deleted after 24 h.
- **Types (sniffed from bytes, the name only picks among text kinds):** PNG, JPEG, WebP, GIF (`sniffImage`); text kinds from `file-kinds.ts` served as `text/plain`; PDF. **Refused:** SVG (scriptable), HTML served as anything but text, archives, binaries, video (out of scope, §7).
- **Caps:** image 10 MiB (`MAX_UPLOAD_BYTES`), text 1 MiB (`TEXT_MAX_BYTES`), PDF 10 MiB; ≤ 16 files and ≤ 40 MiB per round; ≤ 200 MiB per task; per-token upload bucket (60/min, as `uploads`).
- **Images lose metadata** on the way in (`stripMetadata`, `uploads.ts`).
- **Serving:** `GET /api/board/files/<id>` (session) and `/api/agent/board/files/<id>` (token), reusing `servingHeaders` (sandbox CSP, nosniff, `Cross-Origin-Resource-Policy: same-origin`). No public or signed links.
- **UI rendering:** images are never markdown. A proof item's `shots` render as a structured "Before | After" pair from `/api/board/files/<id>` (lazy, click for full size, reusing `Attachments.svelte`'s viewer). `markdown.ts` keeps forbidding `img`, so no text can pull in an image, local or remote.

### 2.3 Checks: "checked by" per proof item

`ProofCheck = { key, round, proof: "p2", result: "checked" | "refuted", note (≤ 300), actor: BoardActor, at }`, append-only. A later mark by the same actor on the same item supersedes theirs; every mark stays in the record. In ADR-0025 terms a check is Evidence of kind `review` on the task's round, produced by a non-claimant; the brief's own items are the claimant's Evidence, which never raises a level (DG2). The digest can read both later, unchanged.

### 2.4 Versioning

- `review → doing` (the worker takes it back, or the manager sends it back with a reason) closes round *n*. Its brief and checks stay, read-only, under "Round n" in the panel.
- The next move to review opens round *n+1* with a new brief. Checks never carry over: the code changed. `morndo-board brief template --from-round n` pre-fills the last brief, so a re-submit edits rather than rewrites.
- `TaskChange` gains `{ kind: "briefed"; round; proofs: number }` and `{ kind: "checked"; round; proof; result }`; `Task` gains `round: number` and `brief: { round; proofs; checked; refuted } | null` for cards (counts only, never text).

## 3. Rules (new B9 to B13 in `docs/domain.md`)

- **B9 Refuse, not flag, for workers.** A worker's move to review without a brief that passes lint is refused as `brief_needed` (with the lint's problems). Why refuse: a flag on an optional field is the state today, and proof that can be skipped is skipped; the CLI makes a brief one file and one command; the move and the brief are one action, so a refused brief leaves the task in doing with no event. The manager and the principal may still move a task to review without one (they run the board, B2); the card then carries a "no brief" flag, and B12 still holds.
- **B10 A brief is the round's, filed once.** Only the assignee files it, only on the move to review. It is never edited; a fix is a new round.
- **B11 Nobody checks their own work.** A mark is refused as `own_proof` when the actor is a claimant: the brief's author or any lane ever assigned the task (`claimantsOf` logic, V1). Allowed: the manager, the principal, or a lane never assigned the task (a reviewer lane). A mark names the round it saw; a mark on a closed round is refused as `changed`.
- **B12 The manager's done needs proof.** The manager's move to done is refused unless the current round has a brief, every proof item has a `checked` mark, and none is `refuted` (`unchecked`, `refuted`, `brief_needed`, naming the items). A refuted item means back to doing with a reason. The principal may accept anyway; the event records `accepted with unchecked proof: p2, p4` and the card keeps the mark.
- **B13 Still no Verdict.** A brief, a check and done grant nothing (B8) and are not the Verdict Verified (V1, V4): that needs a Done-means, which does not exist yet.

## 4. CLI and API

```sh
morndo-board brief template [--kind ui|backend|infra|data] [--from-round N T-12]   # prints the markdown template
morndo-board brief lint report.md [--attach before.png ...]                          # checks locally; uploads nothing
morndo-board review T-12 --brief report.md --attach before.png --attach after.png
morndo-board brief show T-12 [--round N] [--json]
morndo-board check T-12 p2 [--refute] [--note "…"]                                   # manager, principal or reviewer lane
```

- The brief file is markdown with fixed headings (`# Implemented` › `## Summary`, `## Changes`, `## Decisions`, `## Left out`, `## Limits`; `# Proof` › `## ui: <title>` …) and keyed lines (`before: before.png`, `after: after.png`, `tests: 48 passed, 0 failed, 2 skipped`, `command: npm test -- totals`). One parser in `@morndo/protocol` (as `parseBriefMarkdown` is for decisions); `-` reads stdin; `--json` takes the wire shape directly.
- `review` order: parse + lint locally (no network on a lint error, exit 1) → upload each `--attach` (names in the brief must match an `--attach`, else exit 2) → one move call carrying the brief with ids. `review --note` without `--brief` is refused for a worker (exit 1, "add --brief"); the manager and the principal keep it.
- **Routes** (agent side; the app's twins under `/api/board/` are Commands, AC7):
  - `POST /api/agent/board/tasks/T-12/files` raw body, `X-Morndo-Name: after.png`, `Content-Length` checked before reading → `{ id, name, mime, size }`.
  - `POST /api/agent/board/tasks/T-12` `{ action: "move", to: "review", brief, ifRev }` (the `brief` field is new on `BoardActionBody`).
  - `POST /api/agent/board/tasks/T-12/checks` `{ round, proof, result, note? }`.
  - `GET /api/agent/board/tasks/T-12` adds `briefs` (every round) and `checks`.
- **Engine lanes (Cursor, Codex, any engine with a shell):** they use the same CLI; nothing is engine-specific. The node agent must put `MORNDO_HUB`, `MORNDO_AGENT_TOKEN` and `MORNDO_LANE` in an engine lane's environment as it does for tmux lanes (to verify against `apps/node-agent/src/ops/lane-engine.ts` once PR #49 lands; add it there if missing). A screenshot is a file the engine wrote (a headless browser run, a test's artifact) passed by `--attach`. The worker prompt block (`prompt.ts`, mirrored in `docs/agents/board.md`) tells every engine how.

## 5. Security and privacy (public product)

- **Secrets refuse, not redact.** Every text field and text attachment goes through the key-material shapes of `redactKeyMaterial` (`packages/protocol/src/redact.ts:115`) and the PEM rule; a hit refuses the upload or brief as `secret_found` with field and line, so the worker removes it at source (a redacted copy would hide that a secret leaked into the worker's output). The CLI runs the same check before upload. Images and PDFs can't be scanned for text in v1; the prompt tells workers to crop to the change and the panel labels images "not scanned".
- **Paths and e-mails are redacted at ingest.** Paths inside a user's home folder (Linux, macOS and Windows forms) become `~`, e-mail addresses become `[email]`, tailnet names and addresses as in `REDACTIONS`. The CLI's lint prints the redacted text, so the author sees what will be stored. Outbound views keep `view-redact.ts` as today.
- **No remote fetches.** The hub never fetches a URL from a brief: no unfurl, no image proxy, no `--attach https://…` (refused by the CLI and by the route, which takes bytes only). Links are stored as text after `safeLink`; images render only from the hub's own origin (`img-src 'self'`).
- **Caps and limits** as §2.2; the body is read only after `Content-Length` passes; a sniffed type that disagrees with the name is refused (`type_mismatch`).
- **Access:** files are readable by the principal's sessions and by agent tokens only; the audit records `BoardChanged` with `briefed`/`checked` and the actor, never the brief's text (B6).

## 6. Tests first, and migration

Written red before code, each named as below.

- `packages/domain/test/review-brief.test.ts`: "a worker's move to review without a brief is refused as brief_needed"; "a refused brief leaves the task in doing with no event"; "the manager's move to review without a brief is kept and flagged"; "a ui proof without an after image is refused"; "a backend proof needs tests with none failed or a sample"; "infra needs health and rollback samples"; "data needs before, after and rows"; "a markdown image or a non-https link is refused"; "key material in any field is refused with its line"; "home paths and e-mails come back redacted".
- `packages/domain/test/board.test.ts` (added): "the brief's author can't mark its own proof"; "a lane ever assigned the task can't mark it"; "a reviewer lane never assigned may mark"; "a mark on a closed round is refused as changed"; "back to doing and to review again opens round 2 with no marks"; "the manager's done is refused while a proof is unchecked or refuted, naming it"; "the principal accepts with unchecked proof and the event says which".
- `apps/hub/test/board-files.test.ts`: "PNG bytes are stored stripped and served with the sandbox CSP"; "an SVG is refused"; "bytes that aren't the named type are refused"; "a file over its cap is refused before the body is read"; "a lane can't stage files on another lane's task"; "staged files no brief names are gone after 24 hours"; "brief files survive the transcript budget's eviction"; "the hub fetches nothing for an https link in a brief" (fetch spy).
- `apps/hub/test/board.test.ts` (added): "move with a brief writes task, brief and event in one transaction"; "checks route enforces own_proof"; "the audit never holds brief text".
- `apps/board-cli/test/cli.test.ts` (added): "review with --brief and --attach uploads then moves once"; "a local lint error uploads nothing and exits 1"; "a brief naming a file not attached exits 2"; "check T-12 p2 --refute sends refuted"; "prompt blocks still equal docs/agents/board.md".
- `apps/web` browser test and `e2e/board-brief.e2e.ts`: "a task in review shows its brief with before and after images inline"; "the principal marks a proof checked and the panel shows who and when"; "the author's lane sees no Mark checked on its own proof"; "an earlier round is shown collapsed".

**Migration 23** (additive): tables `board_briefs (key, round, author_json, body_json, at, PRIMARY KEY (key, round))`, `board_checks (key, round, proof, result, note, actor_json, at)`, `board_files (id, key, round NULL, name, mime, size, sha256, by_token, at)`; columns `board_tasks.round INTEGER NOT NULL DEFAULT 0`. **Tasks already in review** get round 0, no brief, and the card flag "moved to review before briefs". B12 does not apply to round 0: the manager may accept them as today, or send them back to doing, after which the next review needs a brief. No data is rewritten; old comments stay comments.

## 7. PR order, and what is out of scope

1. **Docs:** ADR-0030 (or the next free number when it opens) "Review briefs and proof checks"; `docs/domain.md` terms (Review brief, Round, Proof item, Proof check) and B9 to B13; `docs/agents/review-brief.md` with the four made-up examples. *Done when:* review agrees the rules; no code.
2. **Domain + protocol:** `review-brief.ts` (types, lint, redaction), board changes (round, B9 to B12), wire types and the markdown parser. *Done when:* §6 domain tests pass, `npm test`, `npm run check`, `npm run lint` green.
3. **Hub:** migration 23, store, `boardFiles`, upload and check routes, brief on move, done rule, retention job. *Done when:* hub tests pass; a rebuilt database from migration 22 fixtures keeps every task and flags review ones.
4. **CLI + prompts:** `brief template|lint|show`, `review --brief --attach`, `check`; prompt blocks and `docs/agents/board.md`; the engine-lane env check. *Done when:* CLI tests pass; a scratch hub run files a brief with two images from a temp dir.
5. **Desktop UI:** TaskPanel brief section, Before | After pairs, per-item Mark checked / Refute with who and when, round history, card flags and counts. *Done when:* browser test and e2e pass; manual QA kept in the private QA record, not in this tree.

**Out of scope:** OCR or secret scanning inside images and PDFs; video and terminal recordings; automatic screenshot capture; the phone view; feeding briefs and checks into the Home digest (ADR-0025, once it is built); Done-means and the Verdict Verified (V1, V4); an MCP adapter; editing a filed brief.
