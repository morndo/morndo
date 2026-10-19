# Codex runtime: connect a Codex account, run lanes on it, show its usage. Implementation plan

> **Executing this plan (any agent or editor):** do the tasks in the order of [§3](#3-tasks-in-order), then the rollout in [§4](#4-going-live-on-this-machine). Do each step literally:
> - create a file with the text given;
> - replace only text found exactly once (if it isn't, stop and report it);
> - run every `Run:` and compare it with its `Expected:`; a count or a message that differs is a finding to report, not to paper over;
> - commit where the step commits.
>
> Steps use checkboxes (`- [ ]`) for tracking.
> - **Tasks M1 to M5** are this repository's work, on `feat/codex-runtime`. They are safe on any machine: tests use temporary homes and fake binaries, never a real Codex sign-in.
> - **Tasks E1 and E2** are the engine layer's work, in its own repository, outside this tree. E2's second half needs the Codex sign-in, so it runs during the rollout (R7).
> - **§4 (R0 to R11)** is the operator's own node. Nothing there is in this tree, and nothing from there (QA notes, screenshots, recordings) comes back into it.
> - **§6 (Codex account pool, addendum of 2026-10-15)** comes after §4. Its tasks P1 to P8 go on a branch of their own once the M1 to M5 PR has merged. Its rollout (S0 to S10) runs after R11. It changes no engine-layer code.

**Goal:** a user connects a Codex CLI account in Morndo, starts lanes on it like Cursor lanes, and sees its 5-hour and weekly usage on Home. Codex stays an adapter at the edges and appears in no domain type.

**Architecture:** most of this already exists (see [What exists](#what-exists-read-2026-10-15)). The work fills four gaps:
- a usage reader for the Connections context, which asks the installed CLI's app server and prints the status-line JSON that Home already takes (ADR-0016);
- the device-code sign-in on the Connections page, for machines without a browser;
- a guard in the engine layer, so a subscription lane never bills an API key;
- the node's launch entry and sign-in, done as rollout steps, not code.

One new ADR (0028) records the decisions.

**Tech stack:** Node 24.21.0 (type stripping, ESM), TypeScript 6.0.3, vitest 5.0.3, zod/mini through `packages/protocol/src/z.ts`. The engine layer: Python 3.12 stdlib, `unittest`. Codex CLI **0.161.0** (`codex --version`, read 2026-10-15). No new dependencies in either repository.

**Spec:** the owner's request (2026-10-15): "add codex as adapter for morndo following ddd so people can also onboard codex cli if they want to. Codex is on par with claude depending on the model. Implement it and get it live so we can connect codex." The plan builds on:
- ADR-0013 (roles, engines, the engine layer's CLI);
- ADR-0016 (Usage, U1 to U4);
- ADR-0018 (Connections, runtime adapters, the secret rules);
- ADR-0024 (usage from other vendors; proposed, open PR #28);
- ADR-0027 (engines by role, `policy.engines`; on `feat/reliable-lanes`, open PR #49).

**Where this file lives:** the brief named `docs/plans/`, a new directory. The repo's earlier plans sit under `docs/design/<topic>/plan.md`; this one follows their layout.

## What exists (read 2026-10-15)

The request reads as if Codex were new. It isn't. Code from both repositories already covers most of it:

| Piece | Where | State |
|---|---|---|
| Codex runtime adapter (sign-in check, gated `morndo-keys run`, permission profiles, keyring refused) | `apps/connections/src/adapters/runtime-codex.ts`, tests `apps/connections/test/runtime-codex.test.ts` | On `main` since the first public release |
| `codex login status` as the subscription check (a ChatGPT login is the subscription) | `acceptsSubscription`, `loginEnv` in `apps/connections/src/adapters/runtime-claude.ts` | On `main` |
| Vendor presets: `codex` (subscription), `openai` and `custom-openai` (keys, runtime `codex`) | `packages/protocol/catalog/vendors.json` | On `main` |
| Connections page: Add → Subscription → Codex shows `codex login` and the `morndo-keys add` line | `apps/web/src/lib/connections/*`, `CONNECTION_WORDS.signIn` | On `main`; browser login only |
| Lanes on any engine: `policy.engines.launch[provider]` with `{model}`, `{effort}`, `{lane}` | `apps/node-agent/src/ops/lane-engine.ts` | On `feat/reliable-lanes` (PR #49), **not on `main`**; the node runs it |
| Lane events from an engine lane's `/hook/stop` (status from the first line) | node relay `apps/node-agent/src/relay/server.ts`, fleet `apps/fleet/src/application/lane-events.ts` | On `feat/reliable-lanes`; engine-agnostic |
| Engine-lane registry for busy and idle | `apps/hub/src/adapters/engine-registry.ts` | On `main`; engine-agnostic |
| Engine layer: `codex` provider, `codex exec --json` adapter, resume, parse, classify, mid-task switch | engine layer `src/engines/adapters/codex.py`, `config/engines.default.json`, `tests/test_lane.py` | Built 2026-10-07; never run signed in (fixtures are a source-built stream and a recorded 401) |
| Roles that name Codex | engine layer settings: `plan`, `validate`, `review`, `research` | Live; skipped today as "not signed in" |

Checked on the node, 2026-10-15:
- **Not signed in.** `~/.codex` holds no `auth.json`. The engine layer's `providers --json` says `codex` is installed, `login: missing`.
- **No launch entry.** The node policy's `engines.launch` has `cursor` and `claude`, no `codex`.
- **`codex` is not on the node agent's service `PATH`** (`~/.local/bin:~/.nvm/versions/node/v24.21.0/bin:/usr/local/bin:/usr/bin:/bin`). It lives under another Node version's `bin`. So `engines resolve` run by the node agent would skip it as "not installed" (node-agent README, `engines` row).
- **No Connections home** (`~/.config/morndo-connections`) on the node yet.
- **The bundled model catalog of 0.161.0** (`codex debug models --bundled`, scratch `CODEX_HOME`) lists `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, the same names as the engine layer's defaults. Every one takes `low` to `max`; `gpt-6-luna` has no `ultra`.

Baselines run 2026-10-15 in this worktree (Node 24.21.0) and in the engine layer:

| Run | Result |
|---|---|
| `npx vitest run apps/connections/test/runtime-codex.test.ts apps/connections/test/runtime-login.test.ts apps/connections/test/runtime-launch.test.ts apps/hub/test/usage.test.ts apps/hub/test/engines.test.ts` | 5 files, 66 tests passed |
| Engine layer: `python3 -m unittest discover -s tests` | 150 tests, OK |

## 1. Goal and done criteria

Each criterion is checked by a named command; R11 collects the results.

1. **Onboarding (connect an account).**
   - On the node, `codex login status` prints `Logged in using ChatGPT` and exits 0 (after the owner's step, R4).
   - `morndo-keys list` shows `codex` with vendor `codex`, runtime `codex`, status `on` (R9). Its terms are acknowledged once the owner answers Q1; that is his act, not a step an agent takes alone.
   - The Connections page's Add → Subscription → Codex shows `codex login --device-auth` and the device-code note (Task M4's tests).
2. **Lanes.** `morndo lanes start <lane> --cwd <scratch repo> --engine codex:gpt-6-astra@high --reason … --prompt …` answers with `engine.entry` `codex:gpt-6-astra@high`. Then, on `morndo lanes events --json`:
   - within 10 minutes, a `finished` event for that lane with status `done`, and the commit it was asked for in the scratch repo;
   - after a second brief through `morndo lanes send`, which goes through `codex exec resume`, a second `finished`/`done` event and a second commit;
   - `morndo lanes stop` closes the lane (R10, the QA script).
3. **Usage.**
   - `morndo-keys usage --connection codex` prints a status-line JSON with at least one window. The node's collector posts it and the hub answers 200 (R9).
   - Home shows an account `codex` with its windows. The QA agent opens Home in its own browser tab; the screenshot stays in the product's QA notes, not in this tree.
4. **Roles.**
   - The engine layer's `resolve plan --json` (and `validate`, `review`, `research`) no longer skips `codex` as "not signed in".
   - On a scratch copy of the settings, `set implement-backend codex:gpt-6-astra@high,…` followed by `resolve implement-backend --json` picks `codex` (R6). Live chains change only on the owner's word (§5, Q2).
5. **No key billed by mistake.** A Codex child started by Morndo or by the engine layer never sees `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN` or `OPENAI_API_KEY`. Tests M2, M3 and E1 check this.
6. **Tests.**
   - Morndo: Task M5's final check: `npm run check`, `npm run lint`, `npx vitest run`, `node scripts/negative-controls.ts --check`, all green, with the new tests listed in each task.
   - Engine layer: the unit suite (152 tests after E1, 153 after E2), `tests/review_run_it.sh`, `tests/git_guard_it.sh` and both citation checks green.
   - Not the gate: `scripts/test-all.sh`, whose `lanes_engine_it.sh` already fails on the unchanged engine layer (E1 Step 4).

## 2. DDD design: where Codex sits

**Codex appears only in adapters, configuration and words.** No domain type names it.
- `packages/domain` gets nothing.
- `packages/protocol` gets only display words (`CONNECTION_WORDS`, which already names Codex).

| Context | Role of Codex | Code |
|---|---|---|
| **Connections** (ADR-0018) | A runtime behind the `Runtime` port (`isolation`, `dialects`, `loginStatus`, `launch`), plus a usage reader for a Codex subscription. Both are adapters in `apps/connections/src/adapters/`. | `runtime-codex.ts` (exists), `usage-codex.ts` (new, M2), `morndo-keys usage` (new, M3) |
| **Usage** (ADR-0016, ADR-0024) | Not part of the context. The Usage read model takes the status-line JSON through the agents' door. The new reader is the anti-corruption layer that turns Codex's `account/rateLimits/read` answer into that shape. When ADR-0024's `UsageSource` runner lands, this reader becomes its Codex source; the translation stays in the adapter. | none in `packages/domain`; `apps/hub` unchanged |
| **Lanes and Fleet** (ADR-0014, ADR-0027) | A provider name in the node policy's `engines.launch`, started by the engine layer's `engine-lane`. Events come through the same `/hook/stop` as Cursor lanes. | node policy only (R8) |
| **Engines** (ADR-0013) | The engine layer's provider `codex`. Availability (installed, signed in, marks) is the engine layer's. | engine layer `adapters/codex.py` (E1, E2) |

**Ports.**
- The Connections `Runtime` port is unchanged.
- The usage reader is a function adapter: `readCodexLimits` spawns the CLI, and `usageReport` translates its answer. Only `cli.ts` calls it, as it calls the runtime adapters today.
- No application service gets a new port: the read decides nothing (U4), so it needs no service or aggregate.

**Credentials, by ADR-0018's rules.**
- **The sign-in is the CLI's own** (ADR-0001, ADR-0018 §1 "Morndo refers to the CLI's own sign-in … and never stores its token").
  - It is a file store under `CODEX_HOME` (default `~/.codex`).
  - Morndo never reads, copies or moves `auth.json`.
  - A keyring or `auto` store is refused, as `runtime-codex.ts` does today: a run home can't find a keyring entry.
- **Headless nodes sign in by device code:** `codex login --device-auth`. It is a beta that must first be enabled in ChatGPT's security settings ([auth docs](https://learn.chatgpt.com/docs/auth), read 2026-10-15).
- **No key reaches a subscription run.**
  - `codex exec` takes an API key from the environment ahead of the stored login: "API key via env var takes precedence over any other auth method" (`codex-rs/login/src/auth/manager.rs`, tag `rust-v0.161.0`; exec turns it on, `codex-rs/exec/src/lib.rs`).
  - So every Codex child gets `childEnv`, which keeps only `PATH HOME LANG LC_ALL TERM TMPDIR TZ`, the product's three variables and `CODEX_HOME`. The engine lane drops the three key variables (E1).
- **Secrets never reach a prompt, argument, log or the fleet** (CN5, FL14).
  - The usage reader passes no credential. It reads only percentages, window lengths, reset times and the plan type.
  - The app server's stderr is discarded, never printed.

**A new ADR: [ADR-0028](../adr/0028-codex-as-an-engine.md)** (Task M1). It records:
- the sign-in on headless nodes;
- the key guard;
- the unattended posture of a Codex lane (`danger-full-access`; exec never asks for approval);
- usage through the app server, with its window mapping;
- why not the alternatives (rollout files, the TUI's `/status`, `workspace-write`, an API key by default).

Its relation to ADR-0024: the status-line mapping is that ADR's accepted "bridge on one machine".

## 3. Tasks in order

### Branches and worktrees

- **Morndo public:** `feat/codex-runtime`, from `origin/main` at `b46fbca`, in `.worktrees/codex-adapter`.
  - M1 to M5 are commits on this branch, one PR.
  - It touches no code that PR #49 changes. It merges to `main` after a clean review (the owner's rule: develop without asking once review is clean; production only with manual QA and proof).
  - A fresh worktree needs `npm ci`, and `npx playwright install chromium` for the page test.
  - In this worktree, `npm ci` set the executable bit on `apps/connections/src/main.ts` and `apps/node-agent/src/job-main.ts`. Restore it with `chmod 644` before any commit, so a commit carries no mode change.
- **Engine layer:** a branch `fix/codex-lane-keys` for E1 and E2, in a worktree of its own: `git -C "$ENG" worktree add .worktrees/codex-lane-keys -b fix/codex-lane-keys`, with `$ENG` set as §4's Gates say.
  - Never switch the branch of `$ENG` itself: the node runs `engine-lane` from that checkout.
  - The branch merges to the engine layer's default branch in `$ENG` after E1 Step 4's gate, and is live from that merge.
  - E1's and E2's paths are relative to that worktree (`$EW` below).
- **The node-agent code is not changed.** Codex lanes need only R8's launch entry, which PR #49's code reads.

### Global constraints

- **Runtime:** `engines.node` `>=24.12`; run as `~/.nvm/versions/node/v24.21.0/bin/node --no-warnings <file>.ts`. Put that directory first on `PATH` for `npm`/`npx`.
- **No new dependencies.** `node:child_process` and `node:readline` only. The engine layer stays stdlib-only.
- **Codex facts are pinned.** Every fact about the CLI is cited in a comment where it is used:
  - flags, the app-server protocol, the event and window shapes, all from codex-cli **0.161.0**: its `--help`, `codex app-server generate-json-schema`, or the source at tag `rust-v0.161.0`;
  - or the docs page with the date read.
- **Codex in the domain:** none. `packages/domain` and the application layer of `apps/connections` gain no Codex name; `apps/connections/test/architecture.test.ts` keeps passing.
- **Tests never touch the owner's running system:**
  - temporary `MORNDO_CONNECTIONS_HOME` and `CODEX_HOME`, and fake `codex` binaries;
  - never `~/.codex`, never a real sign-in, never ports 8786 to 8791.
- **Public-repo rules** (`AGENTS.md`, `CONTRIBUTING.md`):
  - made-up names, hosts, paths and numbers only; synthetic keys look like `sk-synthetic-…`;
  - no QA evidence in the tree;
  - the pre-push hook runs before any push.
- **Commit messages:** Conventional Commits that name **no AI assistant and no AI tool or vendor by product name**: not Codex, not the vendor, not any other. This is stricter than `docs/public-repo.md`. Each step gives its message; keep it.
- **ADR number:** 0028 was free on every branch and worktree on 2026-10-15 (`main` ends at 0026; 0020, 0024 and 0027 are on open PRs). Check again right before M1's commit (M1 Step 3).
- **Words shown to people:**
  - the sign-in line `codex login --device-auth`;
  - the note `Turn on device code sign-in in ChatGPT's security settings first. On a machine with a browser, codex login works too.`;
  - window labels `5-hour window`, `7-day window` (from `CONNECTION_WORDS.windows`), and `<N>-day window`, `<N>-hour window`, `<N>-minute window`, `Window`.

### Review focus

Five inputs that no step's main path covers and that are most likely to bite. Each one has its test in the task named.

1. **A plan with no 5-hour window.** The pricing page says "Pro plans currently have no five-hour limit"; the answer has only a weekly window.
   - Expected: the report carries `seven_day` only.
   - Home keeps a 5-hour figure reported earlier until its reset (U2) and never shows a made-up one.
   - *M2, "reports only the weekly window".*
2. **A window of another length** (daily, or anything but 300 and 10,080 minutes).
   - Expected: every window goes out as a named window (`limits`). Home shows those instead of the two fixed rows (ADR-0016, decision 4); nothing is forced into "5-hour".
   - *M2, "names every window".*
3. **An app server that hangs** (waiting on a token refresh or a slow network).
   - Expected: the read gives up after 15 s, the child's process group is stopped, and nothing is printed, so the collector posts nothing.
   - *M2, "gives up … and stops it".*
4. **A stray `CODEX_API_KEY` in the parent environment.**
   - Expected: neither the lane's `codex exec` nor the usage reader sees it, so a turn never bills the key instead of the plan.
   - *M3 (the CLI's child environment) and E1 (the lane's turns).*
5. **Signed out, or signed in with an API key.** The app server refuses the read, or returns no window.
   - Expected: `morndo-keys usage` exits 1 with the reason on stderr and nothing on stdout.
   - *M2 ("says why", "no window") and M3 ("prints nothing").*

### Contracts (names and types shared across tasks)

```ts
// apps/connections/src/adapters/usage-codex.ts (Task M2)
export const CODEX_USAGE_TIMEOUT_MS = 15_000;
export type CodexWindow = { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null }; // resetsAt: Unix seconds
export type CodexLimits = { primary: CodexWindow | null; secondary: CodexWindow | null; planType: string | null };
export type CodexReading = { ok: true; limits: CodexLimits } | { ok: false; problem: string };
export type CodexUsageBody = {                       // the status-line JSON the hub's POST /api/agent/usage reads
  session_id: string;
  model: { display_name: string };                   // "Codex (<planType>)" or "Codex"
  rate_limits?: { five_hour?: { used_percentage: number; resets_at: number | null }; seven_day?: { used_percentage: number; resets_at: number | null } };
  limits?: { label: string; used_percentage: number; resets_at: number | null }[];
};
export function limitsFromResult(result: unknown): CodexLimits | null;
export function windowLabel(mins: number | null): string;
export function usageReport(limits: CodexLimits, sessionId: string): CodexUsageBody;
export function readCodexLimits(input: { bin: string; env: NodeJS.ProcessEnv; version: string; timeoutMs?: number }): Promise<CodexReading>;

// morndo-keys (Task M3)
//   morndo-keys usage --connection <name>
//   exit 0: one line of CodexUsageBody JSON on stdout, session_id "<name>-limits"
//   exit 1: nothing on stdout, the reason on stderr ("missing", "usage reads a Codex subscription only", or the reading's problem)

// packages/protocol/src/connections.ts (Task M4)
//   CONNECTION_WORDS.signIn.codex       = "codex login --device-auth"
//   CONNECTION_WORDS.signInNotes.codex  = "Turn on device code sign-in in ChatGPT's security settings first. On a machine with a browser, codex login works too."
// apps/web/src/lib/connections/line.ts: export function signInNote(runtime: string): string | null;

// engine layer src/engines/adapters/codex.py (Task E1)
//   KEY_VARS = ("CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_API_KEY")
//   def env(base: dict, providers: dict) -> dict      # base without KEY_VARS; engine-lane already calls ad.env when present
```

---

### Task M1: ADR-0028

**Files:**
- Create: `docs/adr/0028-codex-as-an-engine.md`

**Interfaces:** none (documentation). Every later task cites it.

- [ ] **Step 1: Write the ADR**

```markdown
# ADR-0028: Codex as an engine: its own sign-in, an unattended turn, usage through its app server

- **Status:** Accepted with the pull request that adds it, 2026-10-15.
- **Number:** 0019 to 0027 are taken on `main` or on open pull requests.
- **Builds on:** ADR-0001 (logins stay the CLI's own), ADR-0013 (the engine layer), ADR-0016 (Usage), ADR-0018 (Connections, runtime adapters, CN5), ADR-0024 (usage from other vendors, proposed), ADR-0027 (engines by role).

## Context

1. **Codex is already a runtime.** The Connections context has its adapter (`runtime-codex.ts`), the catalog has a `codex` subscription and two key presets, and the engine layer runs `codex exec` turns in its engine lane. What was missing: a sign-in that works on a machine without a browser, a guard that keeps a subscription turn off an API key, a posture for an unattended turn, and the account's usage on Home.
2. **Sign-in.** `codex login --device-auth` signs in by device code. It is a beta that is first turned on in ChatGPT's security settings (personal account) or by a workspace admin [S1]. Credentials stay under `CODEX_HOME` (default `~/.codex`), in `auth.json` unless `cli_auth_credentials_store` says `keyring` or `auto` [S1].
3. **A key in the environment wins.** `codex exec` reads `CODEX_API_KEY` before any stored login: "API key via env var takes precedence over any other auth method" [S5].
4. **An unattended turn.** `codex exec` never asks for approval ("Default to never ask for approvals in headless mode") [S6]. It runs in a read-only sandbox by default; `--sandbox workspace-write` allows edits; `danger-full-access` is "only in a controlled environment" [S2]. In `workspace-write` the network is off unless `sandbox_workspace_write.network_access` turns it on [S7]. `codex exec resume` takes no `--sandbox`, only `-c sandbox_mode=…` [S8].
5. **Usage.** The `codex exec --json` stream carries token counts, not plan windows [S9]. The CLI's app server answers `account/rateLimits/read` with `rateLimits.primary` and `secondary`, each `{ usedPercent, windowDurationMins, resetsAt }`, `resetsAt` in Unix seconds, plus `planType` [S3]. The app server is experimental: it and its WebSocket transport "aren't supported for production workloads" [S3]. Pro plans "currently have no five-hour limit" [S4].
6. **Terms.** OpenAI recommends API keys for automation: "API keys are the right default for automation", and ChatGPT-managed auth in CI is the "advanced" path, "Do not use this workflow for public or open-source repositories" [S2, S1].

## Decision

1. **Codex stays at the edges.** No domain type names it. The Connections context holds its runtime adapter and a usage reader; lanes run it as an engine of the node's `policy.engines.launch` (ADR-0027) through the engine layer, with no node-agent code; Home takes its usage through ADR-0016's route.
2. **The sign-in is the CLI's own.** Morndo shows `codex login --device-auth` for a subscription, with the note to turn device code on first, and never reads, copies or moves `auth.json`. A keyring login stays refused: a run in its own `CODEX_HOME` can't find the entry.
3. **No key reaches a subscription turn.** Every Codex child Morndo starts gets `childEnv`, which keeps no `OPENAI_*` or `CODEX_*` variable but `CODEX_HOME`. The engine lane drops `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN` and `OPENAI_API_KEY` from its turns.
4. **An unattended lane turn runs with full access.** `-s danger-full-access` on the first turn and `-c sandbox_mode="danger-full-access"` on a resumed one, with approvals never asked: the posture of Claude Code lanes, which run without permission prompts. The Connection's isolation floor stays `none` until a read-deny is verified on Linux (ADR-0018's open check).
5. **Usage through the app server, read on the node.** `morndo-keys usage --connection <name>` starts `codex app-server` on stdio, sends `initialize` and `initialized`, then `account/rateLimits/read`, and prints the status-line JSON:
   - a 300-minute window is the 5-hour window and a 10,080-minute window the 7-day window;
   - any other set of windows goes out as named windows;
   - nothing is printed when the read fails or the answer has a shape this version doesn't know.

   A program on the node posts it under an agent token, as status lines do. This is ADR-0024's bridge on one machine. When that ADR's source runner lands, the reader becomes its Codex source, standing "documented, experimental".

## Alternatives

| Option | Verdict |
|---|---|
| **The session files' `token_count` events** (`$CODEX_HOME/sessions/…`) | Rejected. An internal file format, and fresh only after a turn ran. |
| **The TUI's `/status` screen** | Rejected. ADR-0024 §4: never read a terminal's screen. |
| **`workspace-write` for lane turns** | Not now. The network is off by default there, so a lane can't install or push. Revisit with a permission profile that denies secret paths once it is verified on Linux. |
| **An API key by default** | Rejected as the default for a principal's own subscription. Keys stay available through the `openai` preset. |
| **A Codex lane runner in the node agent** | Not now. The engine layer already runs Codex turns and posts the hooks lanes rely on. |

## Consequences

- **Good:** a Codex account is connected, run and watched the way the other accounts are, and a stray key can't bill a subscription turn.
- **Cost:** one usage reader and one CLI command in Connections; a launch entry and a device-code sign-in per node.
- **Limit:** a Codex lane can read every file its user can; Claude Code and Cursor lanes have deny lists. A permission profile or a `PreToolUse` hook closes this later.
- **Limit:** the app server is experimental. A shape this reader doesn't know shows "unavailable", never a guess, and a Codex update is checked against its JSON schema before it goes live.
- **Limit:** a report invents one session per account (`<name>-limits`), as ADR-0024 notes for every bridge.

## Sources (read 2026-10-15)

- [S1] https://learn.chatgpt.com/docs/auth (from developers.openai.com/codex/auth)
- [S2] https://learn.chatgpt.com/docs/non-interactive-mode (from developers.openai.com/codex/noninteractive)
- [S3] https://learn.chatgpt.com/docs/app-server
- [S4] https://learn.chatgpt.com/docs/pricing
- [S5] https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/login/src/auth/manager.rs
- [S6] https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/exec/src/lib.rs
- [S7] https://learn.chatgpt.com/docs/sandboxing
- [S8] `codex exec resume --help`, codex-cli 0.161.0
- [S9] https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/exec/src/exec_events.rs
```

- [ ] **Step 2: Check the links resolve**

Run: `node -e 'const fs=require("node:fs");const t=fs.readFileSync("docs/adr/0028-codex-as-an-engine.md","utf8");for (const m of t.matchAll(/\]\((\.\.?\/[^)#]+)\)/g)) if(!fs.existsSync(require("node:path").join("docs/adr",m[1]))) console.log("missing",m[1])'`
Expected: no output.

- [ ] **Step 3: Check the number is still free, then commit**

Run: `for r in $(git for-each-ref --format='%(refname)' refs/heads refs/remotes); do git ls-tree --name-only "$r" docs/adr/; done | grep -c '0028-' ; ls .worktrees/*/docs/adr 2>/dev/null | grep -c '^0028-'`
Expected: `1` (this branch only), then `1`. A higher count means the number is taken: take the next free one and rename the file and every `ADR-0028` reference.

```bash
git add docs/adr/0028-codex-as-an-engine.md
git commit -m "docs(adr): record how a second CLI runtime signs in, runs unattended and reports usage"
```

---

### Task M2: the usage reader (Connections adapter)

**Files:**
- Create: `apps/connections/src/adapters/usage-codex.ts`
- Create: `apps/connections/test/fixtures/fake-codex-app-server.mjs`
- Create: `apps/connections/test/fixtures/codex/rate-limits-plus.json`
- Test: `apps/connections/test/usage-codex.test.ts`

**Interfaces:**
- **Consumes:**
  - `CONNECTION_WORDS.windows` from `@morndo/protocol` (exists);
  - `UsageReportBody` from `@morndo/protocol`, in the test only, as the hub's own schema.
- **Produces:** everything in the Contracts block for `usage-codex.ts`.

- [ ] **Step 1: Write the fixture answer** (synthetic numbers; the shape of `v2/GetAccountRateLimitsResponse.json` from `codex app-server generate-json-schema`, codex-cli 0.161.0)

`apps/connections/test/fixtures/codex/rate-limits-plus.json`:
```json
{
  "rateLimits": {
    "limitId": "codex",
    "limitName": null,
    "primary": { "usedPercent": 42, "windowDurationMins": 300, "resetsAt": 1893456000 },
    "secondary": { "usedPercent": 17, "windowDurationMins": 10080, "resetsAt": 1893888000 },
    "credits": { "hasCredits": false, "unlimited": false, "balance": null },
    "planType": "plus",
    "rateLimitReachedType": null
  },
  "rateLimitsByLimitId": null,
  "rateLimitResetCredits": { "availableCount": 0, "credits": null }
}
```

- [ ] **Step 2: Write the fake app server**

`apps/connections/test/fixtures/fake-codex-app-server.mjs`:
```js
// Stands in for `codex app-server` on stdio: JSON-RPC, one object per line, no "jsonrpc" field
// (https://learn.chatgpt.com/docs/app-server, read 2026-10-15). It answers initialize, takes the initialized notification,
// sends one account/rateLimits/updated notification, then answers account/rateLimits/read from limits.json beside it.
// The file `mode` beside it: ok (default), error, silent, garbage. What it saw goes to seen.json beside it: its
// arguments, the names of its environment, CODEX_HOME, its pid and the initialize params.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const here = import.meta.dirname;
const mode = existsSync(join(here, "mode")) ? readFileSync(join(here, "mode"), "utf8").trim() : "ok";
const seen = { argv: process.argv.slice(2), names: Object.keys(process.env).sort(), codexHome: process.env.CODEX_HOME ?? null, pid: process.pid, init: null };
const record = () => writeFileSync(join(here, "seen.json"), JSON.stringify(seen));
record();
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
let initialized = false;
const lines = createInterface({ input: process.stdin });
lines.on("close", () => process.exit(0));
lines.on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    seen.init = message.params;
    record();
    send({ id: message.id, result: { userAgent: "fake/0.0.0" } });
    return;
  }
  if (message.method === "initialized") { initialized = true; return; }
  if (message.method !== "account/rateLimits/read") return;
  if (!initialized) { send({ id: message.id, error: { code: -32600, message: "not initialized" } }); return; }
  send({ method: "account/rateLimits/updated", params: { rateLimits: { limitId: "codex", primary: null, secondary: null } } });
  if (mode === "silent") return;
  if (mode === "error") { send({ id: message.id, error: { code: -32000, message: "not signed in with ChatGPT" } }); return; }
  if (mode === "garbage") {
    process.stdout.write("not json\n");
    send({ id: message.id, result: { rateLimits: { primary: { usedPercent: "high" } } } });
    return;
  }
  send({ id: message.id, result: JSON.parse(readFileSync(join(here, "limits.json"), "utf8")) });
});
```

- [ ] **Step 3: Write the failing tests**

`apps/connections/test/usage-codex.test.ts`:
```ts
// The Codex usage reader (ADR-0028 decision 5): the app server's answer, its translation into the status-line JSON the
// hub's Usage route reads (ADR-0016), and the process it starts. A fake app server stands in; no sign-in is used.
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UsageReportBody } from "@morndo/protocol";
import { limitsFromResult, readCodexLimits, usageReport, windowLabel } from "../src/adapters/usage-codex.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");
const PLUS: unknown = JSON.parse(readFileSync(join(FIXTURES, "codex", "rate-limits-plus.json"), "utf8"));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

type Seen = { argv: string[]; names: string[]; codexHome: string | null; pid: number; init: unknown };

// A copy of the fake in a directory of its own: its answer, its mode and what it saw live beside it.
function server(mode = "ok", limits: unknown = PLUS): { bin: string; dir: string; seen(): Seen } {
  const dir = mkdtempSync(join(tmpdir(), "morndo-codex-usage-"));
  dirs.push(dir);
  const bin = join(dir, "codex.mjs");
  copyFileSync(join(FIXTURES, "fake-codex-app-server.mjs"), bin);
  writeFileSync(join(dir, "limits.json"), JSON.stringify(limits));
  writeFileSync(join(dir, "mode"), mode);
  return { bin, dir, seen: () => JSON.parse(readFileSync(join(dir, "seen.json"), "utf8")) as Seen };
}

const win = (usedPercent: number, windowDurationMins: number | null, resetsAt: number | null = 1_893_456_000) =>
  ({ usedPercent, windowDurationMins, resetsAt });
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ PATH: process.env.PATH ?? "", ...extra });

describe("codex usage: the answer's shape", () => {
  it("reads the 0.161.0 answer and refuses a shape it doesn't know", () => {
    expect(limitsFromResult(PLUS)).toEqual({ primary: win(42, 300, 1_893_456_000), secondary: win(17, 10_080, 1_893_888_000), planType: "plus" });
    expect(limitsFromResult({ rateLimits: { primary: { usedPercent: "42" } } })).toBeNull();
    expect(limitsFromResult({ limits: [] })).toBeNull();
    expect(limitsFromResult({ rateLimits: { primary: null, secondary: null, planType: "Plus Plan!" } }))
      .toEqual({ primary: null, secondary: null, planType: null });
  });
});

describe("codex usage: the status-line report", () => {
  it("turns a 5-hour and a weekly window into the hub's two windows, which the hub's own schema accepts", () => {
    const limits = limitsFromResult(PLUS);
    if (!limits) throw new Error("fixture unread");
    const body = usageReport(limits, "codex-a-limits");
    expect(body).toEqual({
      session_id: "codex-a-limits",
      model: { display_name: "Codex (plus)" },
      rate_limits: { five_hour: { used_percentage: 42, resets_at: 1_893_456_000 }, seven_day: { used_percentage: 17, resets_at: 1_893_888_000 } },
    });
    expect(UsageReportBody.safeParse(body).success).toBe(true);
  });

  it("reports only the weekly window for a plan with no 5-hour limit", () => {
    expect(usageReport({ primary: win(9, 10_080), secondary: null, planType: "pro" }, "s").rate_limits)
      .toEqual({ seven_day: { used_percentage: 9, resets_at: 1_893_456_000 } });
  });

  it("names every window when one isn't 5 hours or 7 days", () => {
    const body = usageReport({ primary: win(30, 300), secondary: win(50, 1440, null), planType: null }, "s");
    expect(body.rate_limits).toBeUndefined();
    expect(body.limits).toEqual([
      { label: "5-hour window", used_percentage: 30, resets_at: 1_893_456_000 },
      { label: "1-day window", used_percentage: 50, resets_at: null },
    ]);
    expect(body.model).toEqual({ display_name: "Codex" });
    expect(UsageReportBody.safeParse(body).success).toBe(true);
    expect([windowLabel(120), windowLabel(45), windowLabel(null)]).toEqual(["2-hour window", "45-minute window", "Window"]);
  });
});

describe("codex usage: the app server", () => {
  it("initializes, asks for the rate limits once, and leaves no process", async () => {
    const s = server();
    const reading = await readCodexLimits({ bin: s.bin, env: env({ CODEX_HOME: s.dir }), version: "9.9.9" });
    expect(reading).toEqual({ ok: true, limits: limitsFromResult(PLUS) });
    const seen = s.seen();
    expect(seen.argv).toEqual(["app-server", "--listen", "stdio://"]);
    expect(seen.init).toEqual({ clientInfo: { name: "morndo", title: "Morndo", version: "9.9.9" } });
    expect(seen.codexHome).toBe(s.dir);
    await expect.poll(() => alive(seen.pid)).toBe(false);
  });

  it("says why when the read is refused", async () => {
    expect(await readCodexLimits({ bin: server("error").bin, env: env(), version: "1" }))
      .toEqual({ ok: false, problem: "codex app-server: not signed in with ChatGPT" });
  });

  it("gives up on an app server that never answers, and stops it", async () => {
    const s = server("silent");
    expect(await readCodexLimits({ bin: s.bin, env: env(), version: "1", timeoutMs: 2_000 }))
      .toEqual({ ok: false, problem: "codex app-server did not answer in time" });
    await expect.poll(() => alive(s.seen().pid)).toBe(false);
  });

  it("refuses an answer in another shape, an answer with no window, and a binary that isn't there", async () => {
    expect(await readCodexLimits({ bin: server("garbage").bin, env: env(), version: "1" }))
      .toEqual({ ok: false, problem: "codex app-server answered in a shape this reader does not know" });
    expect(await readCodexLimits({ bin: server("ok", { rateLimits: { primary: null, secondary: null } }).bin, env: env(), version: "1" }))
      .toEqual({ ok: false, problem: "Codex reported no usage window" });
    expect(await readCodexLimits({ bin: "/nonexistent/codex", env: env(), version: "1" }))
      .toEqual({ ok: false, problem: "/nonexistent/codex is not on PATH" });
  });
});
```

- [ ] **Step 4: Run the tests to see them fail**

Run: `npx vitest run apps/connections/test/usage-codex.test.ts`
Expected: FAIL, the file can't import `../src/adapters/usage-codex.ts` ("Failed to load url" / "Cannot find module").

- [ ] **Step 5: Write the adapter**

`apps/connections/src/adapters/usage-codex.ts`:
```ts
// A Codex subscription's usage windows, read through the installed CLI's app server (ADR-0028 decision 5; ADR-0024's
// bridge on one machine). `codex app-server` speaks JSON-RPC on stdio, one object per line without the "jsonrpc" field; a
// client sends `initialize` (clientInfo) and then the `initialized` notification before anything else. The answer to
// `account/rateLimits/read` is { rateLimits: { primary, secondary, planType, … }, rateLimitsByLimitId, … }; a window is
// { usedPercent, windowDurationMins, resetsAt }, resetsAt in Unix seconds.
// https://learn.chatgpt.com/docs/app-server (read 2026-10-15). The shape is the one `codex app-server
// generate-json-schema` writes for codex-cli 0.161.0 (v2/GetAccountRateLimitsResponse.json, 2026-10-15).
// The app server is experimental, "aren't supported for production workloads" (same page): an answer in any other shape
// is "unavailable", never a guess. Its stderr is never read, and the caller hands it childEnv (no key variable).
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { CONNECTION_WORDS } from "@morndo/protocol";

export const CODEX_USAGE_TIMEOUT_MS = 15_000;
const INITIALIZE_ID = 0;
const READ_ID = 1;
const FIVE_HOURS = 300;
const SEVEN_DAYS = 10_080;

export type CodexWindow = { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null };
export type CodexLimits = { primary: CodexWindow | null; secondary: CodexWindow | null; planType: string | null };
export type CodexReading = { ok: true; limits: CodexLimits } | { ok: false; problem: string };
type Row = { used_percentage: number; resets_at: number | null };
export type CodexUsageBody = {
  session_id: string;
  model: { display_name: string };
  rate_limits?: { five_hour?: Row; seven_day?: Row };
  limits?: (Row & { label: string })[];
};

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

// A window, null when the answer has none, undefined when it is in a shape this reader doesn't know.
function windowOf(v: unknown): CodexWindow | null | undefined {
  if (v === null || v === undefined) return null;
  if (!isObject(v) || typeof v.usedPercent !== "number" || !Number.isFinite(v.usedPercent)) return undefined;
  const mins = v.windowDurationMins;
  const at = v.resetsAt;
  return {
    usedPercent: v.usedPercent,
    windowDurationMins: typeof mins === "number" && Number.isInteger(mins) && mins > 0 ? mins : null,
    resetsAt: typeof at === "number" && Number.isFinite(at) ? at : null,
  };
}

// The read's result as limits, or null when it isn't the 0.161.0 shape.
export function limitsFromResult(result: unknown): CodexLimits | null {
  if (!isObject(result) || !isObject(result.rateLimits)) return null;
  const r = result.rateLimits;
  const primary = windowOf(r.primary);
  const secondary = windowOf(r.secondary);
  if (primary === undefined || secondary === undefined) return null;
  const planType = typeof r.planType === "string" && /^[a-z0-9_]{1,40}$/.test(r.planType) ? r.planType : null;
  return { primary, secondary, planType };
}

export function windowLabel(mins: number | null): string {
  if (mins === FIVE_HOURS) return CONNECTION_WORDS.windows.fiveHour;
  if (mins === SEVEN_DAYS) return CONNECTION_WORDS.windows.sevenDay;
  if (mins === null) return "Window";
  if (mins % 1440 === 0) return `${mins / 1440}-day window`;
  if (mins % 60 === 0) return `${mins / 60}-hour window`;
  return `${mins}-minute window`;
}

// The status-line JSON (ADR-0016): a 5-hour and a 7-day window as rate_limits; any other set as named limits, which Home
// then shows instead of its two fixed rows. Percentages and resets are the CLI's own.
export function usageReport(limits: CodexLimits, sessionId: string): CodexUsageBody {
  const windows = [limits.primary, limits.secondary].filter((w): w is CodexWindow => w !== null);
  const row = (w: CodexWindow): Row => ({ used_percentage: w.usedPercent, resets_at: w.resetsAt });
  const five = windows.filter(w => w.windowDurationMins === FIVE_HOURS);
  const week = windows.filter(w => w.windowDurationMins === SEVEN_DAYS);
  const model = { display_name: limits.planType ? `Codex (${limits.planType})` : "Codex" };
  if (five.length <= 1 && week.length <= 1 && five.length + week.length === windows.length) {
    const [f] = five;
    const [w] = week;
    return { session_id: sessionId, model, rate_limits: { ...(f ? { five_hour: row(f) } : {}), ...(w ? { seven_day: row(w) } : {}) } };
  }
  return { session_id: sessionId, model, limits: windows.map(w => ({ label: windowLabel(w.windowDurationMins), ...row(w) })) };
}

function problemOf(error: unknown): string {
  const text = isObject(error) && typeof error.message === "string" ? error.message.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  return text === "" ? "codex app-server refused the read" : `codex app-server: ${text}`;
}

// Starts the app server in its own process group, reads once, and stops the group whatever happened.
export function readCodexLimits(input: { bin: string; env: NodeJS.ProcessEnv; version: string; timeoutMs?: number }): Promise<CodexReading> {
  const script = input.bin.endsWith(".mjs") || input.bin.endsWith(".js");
  const argv = [...(script ? [input.bin] : []), "app-server", "--listen", "stdio://"];
  return new Promise(resolve => {
    const child = spawn(script ? process.execPath : input.bin, argv, { env: input.env, stdio: ["pipe", "pipe", "ignore"], detached: true });
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    const finish = (reading: CodexReading): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.stdin.end();
      if (child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
      }
      resolve(reading);
    };
    const timer = setTimeout(() => finish({ ok: false, problem: "codex app-server did not answer in time" }), input.timeoutMs ?? CODEX_USAGE_TIMEOUT_MS);
    const send = (message: object): void => { if (!settled) child.stdin.write(`${JSON.stringify(message)}\n`); };
    child.stdin.on("error", () => { /* the child went early; close says so */ });
    child.on("error", error => finish({
      ok: false,
      problem: (error as NodeJS.ErrnoException).code === "ENOENT" ? `${input.bin} is not on PATH` : "codex app-server could not start",
    }));
    child.on("close", () => finish({ ok: false, problem: "codex app-server exited before it answered" }));
    lines.on("line", line => {
      let message: unknown;
      try { message = JSON.parse(line); } catch { return; }
      if (!isObject(message)) return;
      if (message.id === INITIALIZE_ID) {
        if ("error" in message) { finish({ ok: false, problem: problemOf(message.error) }); return; }
        send({ method: "initialized", params: {} });
        send({ method: "account/rateLimits/read", id: READ_ID, params: { excludeResetCreditDetails: true } });
        return;
      }
      if (message.id !== READ_ID) return;   // notifications, and anything else the server says
      if ("error" in message) { finish({ ok: false, problem: problemOf(message.error) }); return; }
      const limits = limitsFromResult(message.result);
      if (!limits) { finish({ ok: false, problem: "codex app-server answered in a shape this reader does not know" }); return; }
      if (!limits.primary && !limits.secondary) { finish({ ok: false, problem: "Codex reported no usage window" }); return; }
      finish({ ok: true, limits });
    });
    send({ method: "initialize", id: INITIALIZE_ID, params: { clientInfo: { name: "morndo", title: "Morndo", version: input.version } } });
  });
}
```

`excludeResetCreditDetails` is in `GetAccountRateLimitsParams` of 0.161.0's schema ("Skip the separate reset-credit detail lookup for background usage polls"). Cite that in the comment if a reviewer asks; it is already in the step's source note.

- [ ] **Step 6: Run the tests to see them pass**

Run: `npx vitest run apps/connections/test/usage-codex.test.ts`
Expected: 1 file, 8 tests passed.

- [ ] **Step 7: Type check and the architecture rule**

Run: `npx tsc -p apps/connections && npx vitest run apps/connections/test/architecture.test.ts`
Expected: tsc prints nothing; the architecture test passes (the adapter is outside `application/`).

- [ ] **Step 8: Commit**

```bash
chmod 644 apps/connections/src/main.ts apps/node-agent/src/job-main.ts
git add apps/connections/src/adapters/usage-codex.ts apps/connections/test/usage-codex.test.ts apps/connections/test/fixtures/fake-codex-app-server.mjs apps/connections/test/fixtures/codex/rate-limits-plus.json
git commit -m "feat(connections): read a subscription's usage windows from its CLI's app server"
```

---

### Task M3: `morndo-keys usage --connection <name>`

**Files:**
- Modify: `apps/connections/src/cli.ts` (imports, the `dispatch` switch, a new `usage` function next to `spend`)
- Modify: `apps/connections/src/main.ts` (no stdin read for `usage`)
- Test: `apps/connections/test/usage-cli.test.ts`

**Interfaces:**
- **Consumes:**
  - `readCodexLimits` and `usageReport` (M2);
  - `childEnv` and `loginEnv` from `./adapters/runtime-claude.ts` (exist);
  - `productVersion` from `@morndo/service-kit` (exists; `main.ts` uses it).
- **Produces:** the command in the Contracts block. R9 and the collector call it.

- [ ] **Step 1: Write the failing tests**

`apps/connections/test/usage-cli.test.ts`:
```ts
// morndo-keys usage (ADR-0028 decision 5): a Codex subscription's windows as one line of status-line JSON, nothing on
// stdout otherwise, and no key variable in the CLI's environment. A fake app server stands in for the CLI.
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.ts";

const catalog = join(import.meta.dirname, "../../../packages/protocol/catalog/vendors.json");
const FIXTURES = join(import.meta.dirname, "fixtures");
const MAIN = join(import.meta.dirname, "../src/main.ts");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function home(): NodeJS.ProcessEnv {
  const dir = scratch("morndo-usage-cli-");
  return { ...process.env, MORNDO_CONNECTIONS_HOME: dir, MORNDO_VAULT: "file", MORNDO_CATALOG: catalog, PWD: dir };
}

function fakeCodex(mode = "ok"): { bin: string; dir: string } {
  const dir = scratch("morndo-usage-codex-");
  const bin = join(dir, "codex.mjs");
  copyFileSync(join(FIXTURES, "fake-codex-app-server.mjs"), bin);
  copyFileSync(join(FIXTURES, "codex", "rate-limits-plus.json"), join(dir, "limits.json"));
  writeFileSync(join(dir, "mode"), mode);
  return { bin, dir };
}

async function cli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await run(args, env, { stdin: "", stdout: text => { stdout += text; }, stderr: text => { stderr += text; } });
  return { code, stdout, stderr };
}

describe("morndo-keys usage", () => {
  it("prints a Codex subscription's windows, with no key in the CLI's environment", async () => {
    const env = home();
    const login = scratch("morndo-usage-login-");
    expect((await cli(["add", "codex-a", "--vendor", "codex", "--runtime", "codex", "--subscription", "true", "--config-dir", login], env)).code).toBe(0);
    const codex = fakeCodex();
    const out = await cli(["usage", "--connection", "codex-a"], {
      ...env, MORNDO_CODEX_BIN: codex.bin,
      CODEX_API_KEY: "sk-synthetic-usage-0001", CODEX_ACCESS_TOKEN: "synthetic-access-0002", OPENAI_API_KEY: "sk-synthetic-usage-0003",
    });
    expect(out.code, out.stderr).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      session_id: "codex-a-limits",
      model: { display_name: "Codex (plus)" },
      rate_limits: { five_hour: { used_percentage: 42, resets_at: 1_893_456_000 }, seven_day: { used_percentage: 17, resets_at: 1_893_888_000 } },
    });
    const seen = JSON.parse(readFileSync(join(codex.dir, "seen.json"), "utf8")) as { names: string[]; codexHome: string };
    expect(seen.names.filter(name => /KEY|TOKEN/.test(name))).toEqual([]);
    expect(seen.codexHome).toBe(login);
  });

  it("refuses another kind of connection and a missing one, printing nothing on stdout", async () => {
    const env = home();
    expect((await cli(["add", "sub-c", "--vendor", "claude", "--runtime", "claude", "--subscription", "true"], env)).code).toBe(0);
    const other = await cli(["usage", "--connection", "sub-c"], env);
    expect([other.code, other.stdout, other.stderr]).toEqual([1, "", "usage reads a Codex subscription only\n"]);
    const missing = await cli(["usage", "--connection", "nope"], env);
    expect([missing.code, missing.stdout, missing.stderr]).toEqual([1, "", "missing\n"]);
  });

  it("prints nothing on stdout and says why when the read fails", async () => {
    const env = home();
    expect((await cli(["add", "codex-a", "--vendor", "codex", "--runtime", "codex", "--subscription", "true", "--config-dir", scratch("morndo-usage-login-")], env)).code).toBe(0);
    const out = await cli(["usage", "--connection", "codex-a"], { ...env, MORNDO_CODEX_BIN: fakeCodex("error").bin });
    expect([out.code, out.stdout, out.stderr]).toEqual([1, "", "codex app-server: not signed in with ChatGPT\n"]);
  });

  it("doesn't wait for input that never comes", async () => {
    const child = spawn(process.execPath, ["--no-warnings", MAIN, "usage", "--connection", "nope"], { env: home(), stdio: ["pipe", "pipe", "pipe"] });
    const killer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const code = await new Promise<number | null>(resolve => child.on("close", resolve));
    clearTimeout(killer);
    expect(code).toBe(1);
    expect(stderr).toContain("missing");
  }, 20_000);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run apps/connections/test/usage-cli.test.ts`
Expected: FAIL, 4 tests:
- the first three: exit 1 with `unknown command` on stderr;
- the last: `expected null to be 1`. The CLI waited for stdin and was killed after 10 s.

- [ ] **Step 3: Wire the command**

In `apps/connections/src/cli.ts`, change the import from `./adapters/runtime-claude.ts` (found once) from:
```ts
import { baseUrlProblem, ClaudeRuntime, isStatusRefusal, isThirdPartyAnthropicBase, keysProgram } from "./adapters/runtime-claude.ts";
```
to:
```ts
import { baseUrlProblem, childEnv, ClaudeRuntime, isStatusRefusal, isThirdPartyAnthropicBase, keysProgram, loginEnv } from "./adapters/runtime-claude.ts";
import { readCodexLimits, usageReport } from "./adapters/usage-codex.ts";
import { productVersion } from "@morndo/service-kit";
```
In `dispatch`, after `case "spend": return spend(home, need(name), io);`, add:
```ts
    case "usage": return usage(home, parsed, io);
```
After the `spend` function, add:
```ts
// A Codex subscription's usage windows, one line of the status-line JSON the hub's Usage route takes (ADR-0028 decision 5).
// Nothing on stdout when they can't be read, so a pipe into a post posts nothing. The child gets childEnv: no key variable,
// and the Connection's own CODEX_HOME.
async function usage(home: Opened, parsed: Parsed, io: Io): Promise<number> {
  const name = need(parsed.get("connection"));
  const connection = findConnection(home.store.load().directory, name);
  if (!connection || connection.status === "revoked") return fail(io, "missing");
  if (connection.custody !== "morndo" || connection.kind !== "subscription" || connection.runtime !== "codex") {
    return fail(io, "usage reads a Codex subscription only");
  }
  const env = childEnv(home.env, loginEnv("codex", connection.configDir));
  const reading = await readCodexLimits({ bin: home.env.MORNDO_CODEX_BIN ?? "codex", env, version: productVersion() });
  if (!reading.ok) return fail(io, reading.problem);
  io.stdout(`${JSON.stringify(usageReport(reading.limits, `${name}-limits`))}\n`);
  return 0;
}
```
If tsc says `configDir` doesn't exist on the narrowed type, narrow as `launch` does: read `connection.kind === "subscription" ? connection.configDir : null` after the custody check. Don't widen the check.

- [ ] **Step 4: No stdin for `usage`**

In `apps/connections/src/main.ts`, change (found once):
```ts
const readStdin = process.stdin.isTTY || process.argv.includes("helper") || process.argv.includes("run");
```
to:
```ts
const readStdin = process.stdin.isTTY || process.argv.includes("helper") || process.argv.includes("run") || process.argv.includes("usage");
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run apps/connections/test/usage-cli.test.ts apps/connections/test/usage-codex.test.ts`
Expected: 2 files, 12 tests passed.

- [ ] **Step 6: The connections project and its types**

Run: `npx tsc -p apps/connections && npx vitest run apps/connections`
Expected:
- tsc prints nothing;
- 50 files and 377 tests passed. The baseline is 48 files and 365 tests.

Both counts were measured on 2026-10-15 in a scratch copy with this plan's code applied. Write the counts that were really printed into the PR.

- [ ] **Step 7: A negative control for the key guard**

Append to `CONTROLS` in `scripts/negative-controls.ts`, before its closing `];`:
```ts
  { id: "cx-usage-env-keys", task: "codex-runtime M3", file: "apps/connections/src/cli.ts",
    find: "const env = childEnv(home.env, loginEnv(\"codex\", connection.configDir));",
    replace: "const env = { ...home.env, ...loginEnv(\"codex\", connection.configDir) };",
    run: ["apps/connections/test/usage-cli.test.ts"], expect: "CODEX_API_KEY" },
```
Run: `node scripts/negative-controls.ts --check | grep cx-usage`
Expected: `ok    cx-usage-env-keys: found 1 time in apps/connections/src/cli.ts`.

- [ ] **Step 8: Commit, then run the control** (the runner tests `HEAD`)

Expected from the last line: the control bites. The test fails and prints `CODEX_API_KEY`; this was seen by hand in the scratch copy on 2026-10-15.

```bash
chmod 644 apps/connections/src/main.ts apps/node-agent/src/job-main.ts
git add apps/connections/src/cli.ts apps/connections/src/main.ts apps/connections/test/usage-cli.test.ts scripts/negative-controls.ts
git commit -m "feat(connections): print a subscription's usage windows as a status-line report"
node scripts/negative-controls.ts --only cx-usage-env-keys
```

---

### Task M4: the device-code sign-in on the Connections page

**Files:**
- Modify: `packages/protocol/src/connections.ts` (`CONNECTION_WORDS.signIn.codex`, new `signInNotes`)
- Modify: `apps/web/src/lib/connections/line.ts` (new `signInNote`)
- Modify: `apps/web/src/lib/connections/ConnectionsBoard.svelte` (show the note)
- Test: `apps/web/test/connections-words.test.ts`, `apps/web/test/connections-page.test.ts`

**Interfaces:**
- **Consumes:** none.
- **Produces:** `CONNECTION_WORDS.signInNotes.codex` and `signInNote(runtime)`, per the Contracts block.

- [ ] **Step 1: Write the failing tests**

In `apps/web/test/connections-words.test.ts`:
- change the import (found once) from `import { expiryMillis, expiryText, keyAddLine, subscriptionAddLine } from "../src/lib/connections/line.ts";` to `import { expiryMillis, expiryText, keyAddLine, signInLine, signInNote, subscriptionAddLine } from "../src/lib/connections/line.ts";`;
- append at the end of the file:
```ts
describe("a Codex subscription signs in by device code", () => {
  it("shows the device-code command and what to turn on first", () => {
    expect(signInLine("codex")).toBe("codex login --device-auth");
    expect(signInNote("codex")).toBe("Turn on device code sign-in in ChatGPT's security settings first. On a machine with a browser, codex login works too.");
    expect(signInNote("claude")).toBeNull();
    expect(board).toContain("signInNote(");
  });
});
```
In `apps/web/test/connections-page.test.ts`, after the line (found once):
```ts
      expect(await page.locator(".dialog code").first().innerText()).toBe(CONNECTION_WORDS.signIn.codex);
```
add:
```ts
      expect(await page.locator(".dialog").getByText(CONNECTION_WORDS.signInNotes.codex).count()).toBe(1);
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `npx vitest run apps/web/test/connections-words.test.ts`
Expected: 1 failed, 2 passed. The failure is `expected 'codex login' to be 'codex login --device-auth'`: the first assertion, before `signInNote`, which isn't exported yet, is called.

- [ ] **Step 3: The words**

In `packages/protocol/src/connections.ts`, replace (found once):
```ts
  // Codex: `codex login` (https://developers.openai.com/codex/auth/, read 2026-10-10).
  // Cursor: `agent login` (https://cursor.com/docs/cli/reference/authentication, read 2026-10-10).
  signIn: { claude: "claude auth login", codex: "codex login", cursor: "agent login" },
```
with:
```ts
  // Codex: `codex login --device-auth` signs in a machine without a browser (a node). Device code sign-in is a beta that is
  // first turned on in ChatGPT's security settings, or by a workspace admin (https://learn.chatgpt.com/docs/auth, read
  // 2026-10-15; developers.openai.com/codex/auth redirects there). `codex login` still works where a browser opens.
  // Cursor: `agent login` (https://cursor.com/docs/cli/reference/authentication, read 2026-10-10).
  signIn: { claude: "claude auth login", codex: "codex login --device-auth", cursor: "agent login" },
  signInNotes: { codex: "Turn on device code sign-in in ChatGPT's security settings first. On a machine with a browser, codex login works too." },
```

- [ ] **Step 4: The helper and the page**

In `apps/web/src/lib/connections/line.ts`, after `signInLine`, add:
```ts
// What to do before the sign-in line, where a runtime needs it (ADR-0028 decision 2).
export function signInNote(runtime: string): string | null {
  return runtime === "codex" ? CONNECTION_WORDS.signInNotes.codex : null;
}
```
In `apps/web/src/lib/connections/ConnectionsBoard.svelte`:
- change the import (found once) `import { EXPIRY_PLACEHOLDER, expiryMillis, expiryText, isolationLine, keyAddLine, signInLine, subscriptionAddLine } from "./line.ts";` to `import { EXPIRY_PLACEHOLDER, expiryMillis, expiryText, isolationLine, keyAddLine, signInLine, signInNote, subscriptionAddLine } from "./line.ts";`;
- after `const signingIn = $derived(kind === "subscription" ? signInLine(runtime) : null);`, add `const signInFirst = $derived(kind === "subscription" ? signInNote(runtime) : null);`;
- replace (found once):
```svelte
      {:else if signingIn}
        <p><code>{signingIn}</code></p>
      {/if}
```
with:
```svelte
      {:else if signingIn}
        {#if signInFirst}<p>{signInFirst}</p>{/if}
        <p><code>{signingIn}</code></p>
      {/if}
```
The note comes before the command, so the page test's `.dialog code` `.first()` is still the sign-in line.

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx vitest run apps/web/test/connections-words.test.ts && npx vitest run --project chromium apps/web/test/connections-page.test.ts`
Expected: the words file passes with its new test; the page test passes. If the second command says Chromium is missing, run `npx playwright install chromium` first.

- [ ] **Step 6: The web check**

Run: `npm run check -w @morndo/web && npx tsc -p packages/protocol`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
chmod 644 apps/connections/src/main.ts apps/node-agent/src/job-main.ts
git add packages/protocol/src/connections.ts apps/web/src/lib/connections/line.ts apps/web/src/lib/connections/ConnectionsBoard.svelte apps/web/test/connections-words.test.ts apps/web/test/connections-page.test.ts
git commit -m "feat(web): show the device-code sign-in for machines without a browser"
```

---

### Task M5: the onboarding guide, then the whole-branch checks

**Files:**
- Create: `docs/agents/codex.md`
- Modify: `docs/agents/usage.md` (one pointer)

**Interfaces:** documents M3's command, M4's sign-in and the node policy's `engines.launch` (ADR-0027).

- [ ] **Step 1: Write the guide**

`docs/agents/codex.md`:
````markdown
# Codex: connect an account, run lanes on it, see its usage

Codex runs in Morndo as it is: the official CLI, signed in with its own login, on the node you choose (ADR-0028).

## 1. Sign in on the node

1. In ChatGPT's security settings, turn on device code sign-in (a workspace admin turns it on for a workspace).
2. On the node, in any terminal (over SSH works): `codex login --device-auth`. Open the address it prints on your phone or laptop and enter the code.
3. Check: `codex login status` prints `Logged in using ChatGPT` and exits 0.

The login stays in `CODEX_HOME` (default `~/.codex`) as a file. Morndo never reads it. A keyring login (`cli_auth_credentials_store = "keyring"` or `"auto"`) is refused, since Morndo runs Codex with a home of its own.

## 2. Register it as a Connection

```sh
morndo-keys add codex --vendor codex --runtime codex --subscription true
morndo-keys ack codex --by you@example.com
morndo-keys list
```

Add `--config-dir <dir>` when the login lives in another `CODEX_HOME`.

## 3. Lanes on Codex

A node starts lanes on an engine through its policy's `engines` (ADR-0027). Give Codex a launch command beside the others, for example:

```json
{ "engines": { "cli": "/opt/engines/bin/engines", "launch": {
  "codex": { "command": ["/opt/engines/bin/engine-lane", "--engine", "codex", "--model", "{model}", "--effort", "{effort}", "--window", "{lane}"], "via": "shell" } } } }
```

- The engine lane runs each brief as one `codex exec --json` turn and resumes the same session for the next one.
- Turns run with full access and never ask for approval, as Claude Code lanes do. Start Codex lanes in a Git repository: Codex refuses to run outside one.
- The engine layer's resolver runs with the node agent's `PATH`. Put `codex` on it (a link in `~/.local/bin` is enough), or a start by role skips Codex as not installed.
- An API key in the environment would win over the sign-in. The engine lane drops `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN` and `OPENAI_API_KEY` from its turns.

Start one: `morndo lanes start codex-a --cwd <repo> --engine codex:gpt-6-astra@high --reason "<why>" --prompt "<brief>"`.

## 4. Usage on Home

`morndo-keys usage --connection codex` prints the account's windows as one line of status-line JSON (see [`usage.md`](usage.md)):

```json
{"session_id":"codex-limits","model":{"display_name":"Codex (plus)"},"rate_limits":{"five_hour":{"used_percentage":42,"resets_at":1893456000},"seven_day":{"used_percentage":17,"resets_at":1893888000}}}
```

- A 5-hour and a weekly window become Home's two windows. Any other windows are shown by name.
- When the windows can't be read (signed out, an API-key login, an app server that doesn't answer in 15 s), it prints nothing and says why on stderr.

Post it every 15 minutes under a worker token, from a timer on the node:

```sh
morndo-keys usage --connection codex | curl -sS -m 10 -o /dev/null -X POST "$MORNDO_HUB/api/agent/usage" \
  -H "Authorization: Bearer $MORNDO_AGENT_TOKEN" -H "X-Morndo-Lane: usage-collector" \
  -H "X-Morndo-Account: codex" -H 'Content-Type: application/json' --data-binary @-
```

## Terms

OpenAI recommends API keys for automation, and its CI guide warns against using a ChatGPT login for public or open-source repositories (https://learn.chatgpt.com/docs/non-interactive-mode, read 2026-10-15). Read your plan's terms before you run lanes on it.
````

- [ ] **Step 2: Point to it from the usage guide**

In `docs/agents/usage.md`, after the paragraph that starts `A lane's first report carries no windows:` add:
```markdown
Codex has no status line. Its windows come from `morndo-keys usage --connection <name>`, posted the same way; see [`codex.md`](codex.md).
```

- [ ] **Step 3: Check the guide's commands against the code**

Run: `grep -c 'case "usage"' apps/connections/src/cli.ts; grep -c 'codex login --device-auth' packages/protocol/src/connections.ts`
Expected: `1`, then `1`.

- [ ] **Step 4: Commit**

```bash
git add docs/agents/codex.md docs/agents/usage.md
git commit -m "docs(agents): connect a subscription runtime on a headless node and post its usage"
```

- [ ] **Step 5: The whole branch, before the PR**

Run, in order:
```bash
npm run check
npm run lint
npx vitest run
node scripts/negative-controls.ts --check
git diff --stat origin/main...HEAD
git log --format='%s%n%b' origin/main..HEAD | grep -i -E 'codex|openai|claude|anthropic|cursor|gpt' || echo "messages clean"
```
Expected:
- `check` and `lint` clean;
- vitest: every project green, with the 12 new connections tests and the new words test;
- the negative controls pass;
- the diff touches only the files of M1 to M5;
- `messages clean`.

Write the counts that were printed into the PR description, with the commands. The PR's review follows the repo's review pipeline; it merges to `main` only after that review is clean.

---

### Task E1 (engine layer): a subscription turn never gets an API key

Repository: the engine layer's, outside this tree. Branch `fix/codex-lane-keys`. Run every step in its worktree `$EW` (Branches and worktrees). E2 runs there too.

**Files:**
- Modify: `src/engines/adapters/codex.py` (an `env` hook)
- Test: `tests/test_lane.py` (the fake binary records the key variables it sees; two tests)

**Interfaces:**
- **Consumes:** `engine-lane` already calls `self.ad.env(env, self.providers)` when the adapter has one (`src/engines/lane.py`, `start_turn`).
- **Produces:** `codex.KEY_VARS` and `codex.env(base, providers)`.

- [ ] **Step 1: Write the failing tests**

In `tests/test_lane.py`, in `FAKE_AGENT`, change the log line's dict (found once) from:
```python
                        "api_key": os.environ.get("CURSOR_API_KEY")}) + "\n")
```
to:
```python
                        "api_key": os.environ.get("CURSOR_API_KEY"),
                        "keys": sorted(k for k in ("CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_API_KEY") if k in os.environ)}) + "\n")
```
In `class CodexAdapter`, after `test_classify_limits`, add:
```python
    def test_env_drops_the_key_variables(self):
        base = {"PATH": "/usr/bin", "CODEX_HOME": "/tmp/codex-home", "CODEX_API_KEY": "sk-synthetic-0001",
                "CODEX_ACCESS_TOKEN": "synthetic-0002", "OPENAI_API_KEY": "sk-synthetic-0003"}
        self.assertEqual(codex.env(base, {}), {"PATH": "/usr/bin", "CODEX_HOME": "/tmp/codex-home"})
        self.assertIn("CODEX_API_KEY", base, "the caller's environment is not changed")
```
In `class Lane`, after `test_codex_lane_recorded_401_is_a_stop_failure_auth`, add:
```python
    def test_codex_lane_never_passes_a_key_to_codex(self):
        r = self.lane("hello\n", engine="codex", model="gpt-6.1-sol", FAKE_STREAM=str(FIX.parent / "codex" / "stream-doc-example.jsonl"),
                      CODEX_API_KEY="sk-synthetic-0001", CODEX_ACCESS_TOKEN="synthetic-0002", OPENAI_API_KEY="sk-synthetic-0003")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.calls()[0]["keys"], [], "a key in the environment would win over the ChatGPT sign-in")
```

- [ ] **Step 2: Run them to see them fail**

Run: `python3 -m unittest tests.test_lane.CodexAdapter.test_env_drops_the_key_variables tests.test_lane.Lane.test_codex_lane_never_passes_a_key_to_codex -v`
Expected: 1 error, `AttributeError: module 'engines.adapters.codex' has no attribute 'env'`; 1 failure, `['CODEX_ACCESS_TOKEN', 'CODEX_API_KEY', 'OPENAI_API_KEY'] != []`.

- [ ] **Step 3: Write the hook**

In `src/engines/adapters/codex.py`, after `DEFAULT_SANDBOX = "danger-full-access"`, add:
```python
# A key in the environment wins over the ChatGPT sign-in: `codex exec` reads CODEX_API_KEY first ("API key via env var
# takes precedence over any other auth method", codex-rs/login/src/auth/manager.rs at rust-v0.161.0, checked 2026-10-15)
# and CODEX_ACCESS_TOKEN as well. A lane runs on the sign-in, so neither reaches its turns; OPENAI_API_KEY is dropped too,
# as Morndo's launcher drops it.
KEY_VARS = ("CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_API_KEY")


def env(base, providers):
    """The environment for `codex`: `base` without the key variables. `providers` is unused (the cursor hook takes it)."""
    return {k: v for k, v in base.items() if k not in KEY_VARS}
```
In the module docstring, after the `Events (…)` paragraph, add one line: `Environment: env() drops CODEX_API_KEY, CODEX_ACCESS_TOKEN and OPENAI_API_KEY, so a turn runs on the sign-in.`

- [ ] **Step 4: Run them to see them pass, then the engine layer's gate**

Run:
```bash
python3 -m unittest tests.test_lane.CodexAdapter tests.test_lane.Lane 2>&1 | tail -1
python3 -m unittest discover -s tests 2>&1 | grep -E '^(Ran|OK|FAILED)'
tests/review_run_it.sh && tests/git_guard_it.sh && python3 -I scripts/check-citations.py && python3 -I scripts/check-refs.py
```
Expected:
- `OK`, then `Ran 152 tests` and `OK` (150 before, plus 2);
- the two integration tests and both checks pass.

All of this was measured in a scratch copy with this task's code on 2026-10-15.

**Not the gate: `scripts/test-all.sh`.** It exits 1 on the unchanged engine layer too (2026-10-15). Nine checks of `tests/lanes_engine_it.sh` fail, because that test drives the `lanes` script as it was before lanes went through Morndo (`--engine` now needs `--model` and `--reason`). That failure is older than this plan. Report it in the review note as a separate item for the engine layer's backlog. Don't fix it here.

**Don't run `test-all.sh` or `lanes_engine_it.sh` at all during this work.** By default they drive the installed `lanes`, which now reaches the live fleet through `morndo lanes`. On 2026-10-15 its start was refused before anything ran, and its `peek`, `send` and `stop` named a lane that didn't exist. A fixed version of that test would start a real lane.

- [ ] **Step 5: Commit**

```bash
git add src/engines/adapters/codex.py tests/test_lane.py
git commit -m "fix(lane): never pass an API key to a subscription turn"
```

---

### Task E2 (engine layer): fixtures from the version that runs

Two parts:
- **Part A** runs any time.
- **Part B** needs the Codex sign-in, so it runs at rollout step R7, after the owner's step. It costs two short turns of plan usage.

**Files:**
- Modify: `research/spike-raw/codex_*.txt` (re-recorded at 0.161.0)
- Create: `tests/fixtures/codex/recorded-first-turn.jsonl`, `tests/fixtures/codex/recorded-resume-turn.jsonl`
- Modify: `tests/fixtures/codex/README.md`
- Test: `tests/test_lane.py`

**Interfaces:**
- **Consumes:** `codex.parse_line`, `codex.classify` (exist).
- **Produces:** recorded fixtures that later Codex updates are checked against.

- [ ] **Step 1 (A): Record the help of 0.161.0 in the sandbox**

The capture script runs the CLIs from a sandbox under `$SB` (default `~/.local/share/agent-engines`), never from the shared `PATH`. This step pins the sandbox to the version the node runs on purpose. Upgrading is its own step (§5).

Run:
```bash
npm install --prefix "${SB:-$HOME/.local/share/agent-engines}/npm" @openai/codex@0.161.0
scripts/spike-capture.sh
git add research/spike-raw/codex_*
git checkout -- research/spike-raw
git status --short research/spike-raw
python3 -m unittest tests.test_lane.RecordedHelp -v 2>&1 | tail -3
```
Expected:
- `codex_--version.txt` reads `codex-cli 0.161.0`;
- only `codex_*` files are staged;
- `RecordedHelp` passes: `exec` has `-s -m -c --json`, `exec resume` has `-m -c --json` and no `-s`, the same as read on 2026-10-15.

- [ ] **Step 2 (B): Write the failing test**

In `class CodexAdapter`, add:
```python
    def test_parse_recorded_logged_in_turns(self):
        first = [e for e in map(codex.parse_line, (FIX.parent / "codex" / "recorded-first-turn.jsonl").read_text().splitlines()) if e]
        again = [e for e in map(codex.parse_line, (FIX.parent / "codex" / "recorded-resume-turn.jsonl").read_text().splitlines()) if e]
        sid = [e for e in first if e["kind"] == "init"][0]["session_id"]
        self.assertTrue(sid)
        for evs in (first, again):
            texts = [e["text"] for e in evs if e["kind"] == "text"]
            self.assertTrue(texts and texts[-1].startswith("STATUS: DONE"), texts[-1:])
            self.assertEqual([e for e in evs if e["kind"] == "error" and e["fatal"]], [])
            self.assertIn("git commit", " ".join(e["input"].get("command", "") for e in evs if e["kind"] == "tool"))
            self.assertEqual(codex.classify(0, "", [e for e in evs if e["kind"] == "result"][-1]), "")
        self.assertIn([e["session_id"] for e in again if e["kind"] == "init"], ([], [sid]), "a resumed turn names no thread or the same one")
```
Run: `python3 -m unittest tests.test_lane.CodexAdapter.test_parse_recorded_logged_in_turns -v`
Expected: ERROR, `FileNotFoundError` for `recorded-first-turn.jsonl`.

- [ ] **Step 3 (B): Record two signed-in turns in a scratch repository**

Run (on the node, after R4):
```bash
S=$(mktemp -d); cd "$S" && git init -q && git commit -q --allow-empty -m "chore: start"
codex exec --json -m gpt-6-astra -c model_reasoning_effort="low" -s danger-full-access \
  "Create a.txt containing the word one, commit it with the message 'chore: add a', then answer with STATUS: DONE as the first line." > first.jsonl
TID=$(jq -r 'select(.type == "thread.started") | .thread_id' first.jsonl | head -1)
codex exec resume "$TID" --json -m gpt-6-astra -c model_reasoning_effort="low" -c sandbox_mode="danger-full-access" \
  "Append the word two to a.txt, commit it with the message 'chore: add two', then answer with STATUS: DONE as the first line." > second.jsonl
git log --oneline | head -3
grep -c -E "$HOME|sk-|Bearer" first.jsonl second.jsonl
```
Expected:
- `git log` shows `chore: add two`, `chore: add a`, `chore: start`. The resumed turn could write `.git`, which checks the old open question "does resume keep full access".
- The last `grep` prints `0` for both files.

If it prints more, replace each home path with `/tmp/scratch` in the copies (never in the originals), and look at what else matched before going on.

Then copy them into E2's worktree (`EW="$ENG/.worktrees/codex-lane-keys"`): `cp first.jsonl "$EW/tests/fixtures/codex/recorded-first-turn.jsonl"; cp second.jsonl "$EW/tests/fixtures/codex/recorded-resume-turn.jsonl"`, and delete `$S`.

- [ ] **Step 4 (B): Pass, the README, commit**

Run: `python3 -m unittest tests.test_lane.CodexAdapter 2>&1 | tail -1 && python3 -m unittest discover -s tests 2>&1 | grep -E '^(Ran|OK|FAILED)'`
Expected:
- `OK`, then `Ran 153 tests` and `OK`. The gate is E1 Step 4's, not `test-all.sh`.
- If the recorded stream differs from what `parse_line` expects, the test says where. That is a finding: fix `parse_line` with a test of its own in this task, and say so in the review note. In particular, 0.162.0 "consolidates command execution output into `aggregated_output`", so check that field on 0.161.0.

Add to `tests/fixtures/codex/README.md`:
```markdown
- `recorded-first-turn.jsonl`, `recorded-resume-turn.jsonl`: **recorded** <date>, codex-cli 0.161.0 signed in with ChatGPT, in a
  scratch repository: `codex exec --json … -s danger-full-access` then `codex exec resume <thread> --json … -c sandbox_mode=…`.
  Each turn commits; each ends with STATUS: DONE. Home paths replaced by `/tmp/scratch` where they appeared.
```
```bash
git add tests/fixtures/codex tests/test_lane.py research/spike-raw
git commit -m "test(lane): recorded help and signed-in turns of the installed CLI"
```

---

## 4. Going live on this machine

### What "live" means here

- **The node** (this machine) runs the node agent as a user service. The service starts from a `.worktrees/live-ship-<sha>` checkout of the reliable-lanes line (`ship/…`, PR #49's code), not from `main`; `systemctl --user cat morndo-node` names it.
  - Its relay on `127.0.0.1:8787` takes the engine lanes' `/hook/stop`.
  - Its policy is `~/.config/morndo-node/policy.json`.
  - The engine layer runs from its checkout on this node: the policy's `engines.cli` and the `engine-lane` path in `engines.launch`.
- **The hub and the fleet** run on the control plane, not on this machine. `morndo lanes …` reaches the fleet through the forwarded socket. Nothing in this plan changes their code.
  - Codex lanes and Codex usage need no deploy there.
  - M4's sign-in words reach the Connections page with the control plane's next ship. The owner signs in at the node's terminal either way.
- **Live** therefore means, on this node:
  - Codex signed in;
  - the engine layer's E1 (and E2) merged;
  - a `codex` launch entry in the node policy;
  - a Connection `codex` registered with M3's command available from a checkout of `main`;
  - the usage collector posting `codex`;
  - the QA script below passing.

### Gates

- **G1:** the Morndo PR (M1 to M5) has merged to `main` after a clean review. Merging to develop/`main` needs no further ask (the owner's rule).
- **G2:** E1 has merged to the engine layer's default branch with E1 Step 4's gate green.
- **G3, production:** the manager's go for R8's node-agent restart, at a quiet moment (no lane mid-turn: `morndo lanes --json`, every lane idle or waiting). The owner's rule: production only with manual QA by the agents and proof. R10 is that QA; R11 is the proof.

Set these once, in the shell that runs the rollout:
```bash
NODE24=~/.nvm/versions/node/v24.21.0/bin/node
ENG=$(jq -r '.engines.cli' ~/.config/morndo-node/policy.json | sed 's#/bin/engines$##')     # the engine layer's checkout
NODE_WT=$(systemctl --user show morndo-node -p ExecStart --value | grep -o '/[^ ;]*/apps/node-agent/src/main.ts' | head -1 | sed 's#/apps/node-agent/src/main.ts##')
DAY=$(date +%Y%m%d)
echo "$ENG"; echo "$NODE_WT"   # both must print a directory; stop if either is empty
```

### Rollout

- [ ] **R0, record where everything stands** (for the rollback):
  `git -C "$ENG" rev-parse HEAD > /tmp/codex-rollout-eng-head; codex --version; systemctl --user is-active morndo-node`
  Expected: a commit; `codex-cli 0.161.0`; `active`.
- [ ] **R1, backups:**
  `cp ~/.config/morndo-node/policy.json ~/.config/morndo-node/policy.json.pre-codex-$DAY; cp ~/.config/engines/engines.json ~/.config/engines/engines.json.pre-codex-$DAY; cp ~/.local/bin/morndo-usage-collect ~/.local/bin/morndo-usage-collect.bak-$DAY-codex`
  Expected: three files, each the same size as its original (`ls -l`).
- [ ] **R2, the engine layer:** merge E1's branch (G2), then confirm with `git -C "$ENG" log --oneline -3`.
  Running engine lanes keep their loaded code. New lanes and new turns of a new lane get the guard.
- [ ] **R3, `codex` on the service's `PATH`:**
  `ln -s "$(command -v codex)" ~/.local/bin/codex`
  Check: `env -i HOME="$HOME" PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/v24.21.0/bin:/usr/local/bin:/usr/bin:/bin" codex --version` prints `codex-cli 0.161.0`. The npm launcher is a Node script; under the service's `PATH` it runs on Node 24.
- [ ] **R4, the owner signs in** (the owner's one step, below). Check:
  `codex login status; echo "exit $?"; grep -E '^[[:space:]]*cli_auth_credentials_store' ~/.codex/config.toml || echo "file store (default)"`
  Expected: `Logged in using ChatGPT`, `exit 0`, `file store (default)` (or a line that says `"file"`).
- [ ] **R5, the engine layer sees it:**
  `"$ENG/bin/engines" probe codex --run; "$ENG/bin/engines" login codex ok; "$ENG/bin/engines" providers --json | jq -c '.[] | select(.provider == "codex") | {installed, login, marks}'`
  Expected: `codex ok …`, then `{"installed":true,"login":"ok","marks":[]}`.
  `login codex ok` keeps it signed in after the probe's hour (`PROBE_TTL_S`). The probe's result alone would fall back to the settings' `missing`.
- [ ] **R6, roles:**
  `for r in plan validate review research; do "$ENG/bin/engines" resolve $r --json | jq -c --arg r $r '{role: $r, picked: .picked.entry, codex: [.skipped[] | select(.entry | startswith("codex")) | .reason]}'; done`
  Expected: no `codex` reason says "not signed in".
  On a scratch copy (live chains untouched):
  `T=$(mktemp -d); cp ~/.config/engines/engines.json "$T/"; ENGINES_CONFIG="$T/engines.json" "$ENG/bin/engines" set implement-backend codex:gpt-6-astra@high,claude:sonnet-5.5@high && ENGINES_CONFIG="$T/engines.json" "$ENG/bin/engines" resolve implement-backend --json | jq -r .picked.entry; rm -r "$T"`
  Expected: `codex:gpt-6-astra@high`.
- [ ] **R7, E2 part B:** record the two turns, pass, commit and merge, as E2 Steps 2 to 4 say.
- [ ] **R8, the launch entry** (G3):
  ```bash
  P=~/.config/morndo-node/policy.json
  jq --arg lane "$ENG/bin/engine-lane" '.engines.launch.codex = {command: [$lane, "--engine", "codex", "--model", "{model}", "--effort", "{effort}", "--window", "{lane}"], via: "shell"}' "$P" > "$P.new"
  "$NODE24" --no-warnings --input-type=module -e 'const m = await import(process.argv[1]); m.loadPolicy(process.argv[2]); console.log("policy ok")' "$NODE_WT/apps/node-agent/src/config.ts" "$P.new"
  diff <(jq -S 'del(.engines.launch.codex)' "$P") <(jq -S 'del(.engines.launch.codex)' "$P.new") && mv "$P.new" "$P"
  systemctl --user restart morndo-node && sleep 5 && systemctl --user is-active morndo-node && morndo lanes --json | jq length
  ```
  Expected:
  - `policy ok`;
  - the `diff` prints nothing (only `codex` was added);
  - `active`, and the same number of lanes as before the restart.

  If `loadPolicy` throws, stop: the old policy is still in place.
- [ ] **R9, the Connection and its usage:**
  `MORNDO` is the Morndo checkout on this node: the parent of `.worktrees/live-ship-*`, which `dirname "$(dirname "$NODE_WT")"` gives.
  ```bash
  MORNDO=$(dirname "$(dirname "$NODE_WT")")
  git -C "$MORNDO" fetch -q origin
  MW="$MORNDO/.worktrees/live-ship-$(git -C "$MORNDO" rev-parse --short origin/main)"
  git -C "$MORNDO" worktree add --detach "$MW" origin/main
  (cd "$MW" && PATH="$(dirname "$NODE24"):$PATH" npm ci --no-audit --no-fund >/dev/null)
  chmod 644 "$MW/apps/connections/src/main.ts" "$MW/apps/node-agent/src/job-main.ts"
  test -e ~/.local/bin/morndo-keys && { echo "morndo-keys exists: look at it before replacing it"; exit 1; }
  printf '#!/bin/sh\nexec %s --no-warnings %s/apps/connections/src/main.ts "$@"\n' "$NODE24" "$MW" > ~/.local/bin/morndo-keys
  chmod 755 ~/.local/bin/morndo-keys
  morndo-keys list
  morndo-keys add codex --vendor codex --runtime codex --subscription true
  morndo-keys list
  morndo-keys usage --connection codex | jq .
  ```
  - `~/.local/bin/morndo-keys` is where an install puts the launcher (`keysLauncher` in `runtime-claude.ts`). It was free on 2026-10-15.
  - The first `list` prints nothing and creates the Connections home.
  - After `add`, `list` shows `{"name":"codex","kind":"subscription","vendor":"codex","runtime":"codex","status":"on",…}`.
  - `usage` prints a body with `rate_limits` or `limits` and a `model.display_name` starting `Codex`. Reading usage needs no terms acknowledgement; a run does.
  - The terms acknowledgement is the owner's act (CN4). Run `morndo-keys ack codex --by owner` only on his answer to Q1, then check that `list` shows the terms revision.

  Then the collector, the owner's script outside both repositories (backed up in R1). Add this provider beside `zai` and `cursor`:
  ```bash
  codex() (
  set -euo pipefail
  MC="$HOME/.config/morndo"
  TOKEN_FILE=${MORNDO_TOKEN_FILE:-$MC/agent-lanes.token}
  PORT=$(sed -n 's/^MORNDO_PORT=//p' "$MC/env" 2>/dev/null | tail -n 1)
  HUB=${MORNDO_HUB:-http://127.0.0.1:${PORT:-8790}}
  token=$(tr -d ' \r\n' < "$TOKEN_FILE")
  body=$("$HOME/.local/bin/morndo-keys" usage --connection "${MORNDO_USAGE_CODEX_CONNECTION:-codex}") || { echo "codex: no reading" >&2; exit 1; }
  posted=$(printf '%s' "$body" | curl -sS -m 10 -o /dev/null -w '%{http_code}' -X POST "$HUB/api/agent/usage" \
    -H @<(printf 'Authorization: Bearer %s\n' "$token") -H "X-Morndo-Lane: ${MORNDO_USAGE_LANE:-usage-collector}" \
    -H "X-Morndo-Account: ${MORNDO_USAGE_CODEX_ACCOUNT:-codex}" -H 'Content-Type: application/json' --data-binary @-) || posted=000
  echo "codex: $(printf '%s' "$body" | jq -c '.rate_limits // .limits') -> hub $posted"
  [ "$posted" = 200 ]
  )
  ```
  - add `codex) codex ;;` to its `case`;
  - add `codex` to the default list (`zai cursor codex`) and to the unknown-provider message;
  - run `morndo-usage-collect codex`.

  Expected: `codex: {…} -> hub 200`. The service's `MORNDO_HUB` (set in its unit) is the control plane's address. Run the line as the service does: `systemctl --user start morndo-usage-collect && journalctl --user -u morndo-usage-collect -n 5`.
- [ ] **R10, the live QA script** (below), then Home (QA check 7).
- [ ] **R11, the record:** write the outputs of R0 to R10 into the product's QA notes for today, outside this tree. Then:
  - `morndo-board review <task> --note "<what ran, the result>"`;
  - if the user asked for a final memo, its first line is `STATUS: DONE …` with the evidence.

### The owner's one step

At a phone or a laptop, about two minutes:

1. ChatGPT → Settings → Security: turn on **device code sign-in** (beta). It is needed once.
2. On the node, run `codex login --device-auth`: over SSH from the laptop, or in the node's desktop terminal. It prints an address and a one-time code. Open the address, sign in to ChatGPT if asked, and enter the code.
3. Optional, recommended: ChatGPT → Settings → Data controls → "Improve the model for everyone" off. It applies to Codex tasks too.
4. Tell the manager "codex signed in". R4 checks it.

A lane can also start step 2 in its own tmux window and send the address and the code to the owner with `lanes notify`, for entry within the code's lifetime. The owner still approves in ChatGPT. The lane never sees the login.

### Live QA script

Save it as `codex-live-qa.sh` beside the product's QA notes (not in this tree). Run it on the node after R1 to R9. It uses only `morndo lanes`, `git` and `jq`. The lane name is new each run; the scratch repository is removed at the end.

```bash
#!/usr/bin/env bash
# Live QA of a Codex lane on this node: start it in a scratch repository, two briefs (a turn and a resumed turn), a STATUS
# line and a lane event for each, a commit for each, then stop. Exit 0 only when every check passed.
set -euo pipefail
LANE="codex-qa-$(date +%H%M%S)"
NODE=$(jq -r .node ~/.config/morndo-node/config.json)
OUT=$(mktemp -d)
QA=$(mktemp -d)
git -C "$QA" init -q
git -C "$QA" commit -q --allow-empty -m "chore: start"
fail() { echo "FAIL: $*"; exit 1; }

# 1. The event stream first, so no event is missed (it streams until stopped).
morndo lanes events --json > "$OUT/events.jsonl" 2> "$OUT/events.err" &
EV=$!
trap 'kill $EV 2>/dev/null || true; rm -rf "$QA"' EXIT
sleep 2

# 2. Start the lane on Codex with the first brief.
morndo lanes start "$LANE" --node "$NODE" --cwd "$QA" --engine codex:gpt-6-astra@high --reason "live QA of the codex engine" \
  --prompt "Create hello.txt containing the word hello and commit it with the message 'chore: add hello'. Then answer with the STATUS line first." \
  --json > "$OUT/start.json"
jq -e '.engine.entry == "codex:gpt-6-astra@high"' "$OUT/start.json" >/dev/null || fail "start: $(cat "$OUT/start.json")"
echo "check 1 ok: started on $(jq -r .engine.entry "$OUT/start.json")"

# 3. Wait for its finished event (10 min at most), with a status.
finished() { jq -c --arg l "$LANE" 'select(.lane == $l and .event == "finished")' "$OUT/events.jsonl" 2>/dev/null | wc -l; }
for _ in $(seq 120); do [ "$(finished)" -ge 1 ] && break; sleep 5; done
[ "$(finished)" -ge 1 ] || fail "no finished event in 10 min; events: $(tail -3 "$OUT/events.jsonl")"
jq -c --arg l "$LANE" 'select(.lane == $l and .event == "finished") | {status, firstLine}' "$OUT/events.jsonl" | head -1
jq -e --arg l "$LANE" 'select(.lane == $l and .event == "finished") | .status == "done"' "$OUT/events.jsonl" >/dev/null || fail "first turn's status is not done"
git -C "$QA" log --oneline | grep -q "chore: add hello" || fail "no commit from the first turn"
echo "check 2 ok: first turn done and committed"

# 4. The screen shows the STATUS line (engine-lane prints "· turn done · STATUS: DONE").
morndo lanes peek "$LANE" --lines 30 | tee "$OUT/peek.txt" | grep -q "STATUS: DONE" || fail "no STATUS line on the lane's screen"
echo "check 3 ok: STATUS line on screen"

# 5. A second, one-line brief: a resumed Codex session.
morndo lanes send "$LANE" "Append the word again to hello.txt and commit it as 'chore: again'. Answer with the STATUS line first." --wait 60 >/dev/null
for _ in $(seq 120); do [ "$(finished)" -ge 2 ] && break; sleep 5; done
[ "$(finished)" -ge 2 ] || fail "no second finished event"
git -C "$QA" log --oneline | grep -q "chore: again" || fail "no commit from the resumed turn"
echo "check 4 ok: resumed turn done and committed"

# 6. Its busy/idle came from the engine-lane registry, and it stops cleanly.
morndo lanes --json | jq -e --arg l "$LANE" '.[] | select(.name == $l)' >/dev/null || fail "lane not listed"
morndo lanes stop "$LANE" || morndo lanes stop "$LANE" --kill
echo "check 5 ok: listed and stopped"

# 7. Usage (run separately, needs R9): the collector posted the codex account.
echo "check 6: run 'morndo-usage-collect codex' and expect '-> hub 200'"
echo "check 7: open Home in your own browser tab; the codex account card shows its windows. Screenshot to the QA notes."
echo "ALL SCRIPTED CHECKS PASSED: $LANE ($OUT)"
```

Expected, in order:
- `check 1 ok` to `check 5 ok`, then `ALL SCRIPTED CHECKS PASSED`.
- Checks 6 and 7 are by hand: `-> hub 200`, then the Home card.

A field name that differs in `morndo lanes events --json` or `morndo lanes --json` stops the script at its `jq`. That is a finding to record and fix in the script, not to skip.

### Rollback

Each line undoes one step. Do them from the last step back to the first one that is to go.

| Step | Undo | Check |
|---|---|---|
| R9 collector | `cp ~/.local/bin/morndo-usage-collect.bak-$DAY-codex ~/.local/bin/morndo-usage-collect` | `morndo-usage-collect` runs `zai cursor` only |
| R9 Connection | `morndo-keys off codex` (or `morndo-keys revoke codex`, which can't be undone) | `morndo-keys list` shows `off` |
| R9 launcher | `rm ~/.local/bin/morndo-keys` | `command -v morndo-keys` prints nothing |
| R9 checkout | `git -C "$MORNDO" worktree remove "$MW"` | gone from `git worktree list` |
| R8 launch entry | `cp ~/.config/morndo-node/policy.json.pre-codex-$DAY ~/.config/morndo-node/policy.json && systemctl --user restart morndo-node` | `active`; a start on `codex:…` is refused "no launch command" |
| R5 sign-in state | `"$ENG/bin/engines" login codex missing` | `providers --json` shows `missing` |
| R4 sign-in | `codex logout` (the owner's choice; Morndo keeps nothing of it) | `codex login status` exits 1 |
| R3 PATH link | `rm ~/.local/bin/codex` | `env -i … codex --version` fails |
| R2/R7 engine layer | `git -C "$ENG" reset --hard $(cat /tmp/codex-rollout-eng-head)` on its default branch only if nothing else landed since; otherwise `git revert` the two merges | E1 Step 4's gate green |
| `main` (M1 to M5) | a revert PR; nothing live depends on it but the R9 checkout | |

## 5. Risks and open questions

### Open questions (need someone else's decision)

- **Q1 (owner: terms). May unattended lanes run on the ChatGPT plan?**
  - OpenAI's docs call API keys "the right default for automation". They treat a ChatGPT login in CI as the "advanced" path, "Do not use this workflow for public or open-source repositories" (non-interactive page, read 2026-10-15).
  - The Terms of Use and the help-center article on using Codex with a ChatGPT plan could not be read: HTTP 403 to every fetch, 2026-10-15. Not verified.
  - **Default:** go ahead on this node, with one Codex lane at a time, as the owner's own interactive use of his plan. The owner reads the plan's terms or says to use an API key (the `openai` preset) instead. Lanes on Morndo's public repository are the case the CI warning names, so the owner says yes or no to those explicitly.
- **Q2 (owner or manager: routing). Should Codex move up in any role chain?** The owner: "Codex is on par with claude depending on the model". Today it is the second or third entry of `plan`, `validate`, `review` and `research`, and absent from `implement-*`.
  - **Default:** no chain changes in this rollout. Lanes on Codex are started by name (`--engine codex:…`) for a week. Then the manager proposes chain changes from the lanes' QA'd results.
- **Q3 (owner: posture). Accept that a Codex lane can read every file its user can?** Claude Code and Cursor lanes have deny lists; a Codex lane in `danger-full-access` has none.
  - The engine layer's design already planned this ("Codex `danger-full-access` + a `PreToolUse` hook with the same deny patterns"). Codex has hooks in 0.161.0 (`PreToolUse` and others, which must be trusted or run with `--dangerously-bypass-hook-trust`).
  - **Default:** accept for this node's private work now. File a follow-up for the hook or a permission profile, verified on WSL2, before Codex lanes work in repositories with secrets in reach.

### Risks (accepted, with what catches them)

- **The app server is experimental** ("aren't supported for production workloads").
  - The reader refuses any shape but 0.161.0's, so Home shows nothing new rather than wrong numbers.
  - Before a Codex upgrade, regenerate the schema (`codex app-server generate-json-schema --out <scratch>`) and compare `v2/GetAccountRateLimitsResponse.json`'s window fields.
- **0.161.0 is not the latest.** 0.162.1 is (2026-10-09). 0.162.0 changed command output (`aggregated_output`) and Linux sandbox start-up.
  - **Decided:** stay on 0.161.0 for this rollout. Upgrade as its own step afterwards, gated by E2's flag test and recorded turns re-run on the new version.
- **One sign-in, several lanes.** The docs don't say whether parallel `codex exec` runs sharing one `auth.json` refresh it safely.
  - With one Codex lane at a time (Q1's default), this can't happen yet.
  - Watch for `auth` failures in lane events when more run.
- **A usage-limit failure marks Codex for one hour, not until the reset** (the engine layer's `set_mark` after `rate_limit`). A lane on a mark waits or switches by `switch_mid_task`; nothing is lost. Follow-up only if the hour proves wrong in use.
- **A lane in a directory that isn't a Git repository fails.** "Codex requires commands to run inside a Git repository". The lane reports `engine_error`. The guide says to start Codex lanes in a repository. No `--skip-git-repo-check` is added: the check is Codex's guard against destructive changes.
- **`gpt-6-luna` has no `ultra` effort.** The engine layer lists efforts per provider, not per model, so `codex:gpt-6-luna@ultra` passes `engines set` and fails at the first turn. No role uses it.
- **The control plane's Engines and Connections pages** read their own `MORNDO_ENGINES` and `MORNDO_CONNECTIONS`. Whether they show this node's Codex was not checked from here. QA check 7 looks at Home only.

## Sources

Read on 2026-10-15 unless noted. `developers.openai.com/codex/*` pages now redirect (308) to `learn.chatgpt.com/docs/*`; the target is cited.

| Source | Used for |
|---|---|
| https://learn.chatgpt.com/docs/non-interactive-mode | `codex exec` read-only default, `--sandbox` values, `--json` events, `exec resume`, the Git repository check, API keys for automation, the CI warning |
| https://learn.chatgpt.com/docs/auth | device code (beta, enable in ChatGPT security settings), `codex login --device-auth`, `CODEX_HOME`, `auth.json`, `cli_auth_credentials_store` values, token refresh, API keys for programmatic workflows |
| https://learn.chatgpt.com/docs/app-server | stdio JSONL without `"jsonrpc"`, `initialize` with `clientInfo` then `initialized`, `account/rateLimits/read` fields and `resetsAt` in Unix seconds, "experimental … aren't supported for production workloads" |
| https://learn.chatgpt.com/docs/pricing | 5-hour and weekly limits, `/status`, "Pro plans currently have no five-hour limit", API key for automation in CI |
| https://learn.chatgpt.com/docs/sandboxing, https://learn.chatgpt.com/docs/permissions | `workspace-write` network default, bubblewrap on Linux and WSL2, permission profiles vs `sandbox_mode` |
| https://learn.chatgpt.com/docs/hooks, https://learn.chatgpt.com/docs/config-file/config-reference | hook events (for Q3), config keys |
| https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/login/src/auth/manager.rs | "API key via env var takes precedence over any other auth method" (around line 1500), `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN` |
| https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/exec/src/lib.rs | exec: `approval_policy: Some(AskForApproval::Never)` ("Default to never ask for approvals in headless mode", around line 591), `enable_codex_api_key_env: true` |
| https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/exec/src/exec_events.rs | the `--json` event and item types; no rate-limit field |
| https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/cli/src/login.rs | `login status` wording on stderr, exit 0 or 1 |
| https://github.com/openai/codex/releases | latest stable rust-v0.162.1 (2026-10-09); 0.161.0 released 2026-10-07; 0.162.0's notes |
| codex-cli 0.161.0, run locally on 2026-10-15 | flags (`--help`, `exec --help`, `exec resume --help`, `login --help`, `app-server --help`); `debug models --bundled` with a scratch `CODEX_HOME` (model ids and efforts); `app-server generate-json-schema` into a scratch directory (`GetAccountRateLimitsResponse`, `GetAccountRateLimitsParams`, `InitializeParams`, the `initialized` notification). No sign-in, no task run. |
| Not readable (HTTP 403, 2026-10-15) | https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan, https://openai.com/policies/row-terms-of-use/ |

---

## 6. Codex account pool (addendum, 2026-10-15)

> **The request** (owner, 2026-10-15 19:30): "I even have 2 codex $20 accounts with a lot of resets left, so get it implemented so it has the same flexibility we currently have with claude. Follow DDD where possible and research how to get the most out of it for an autonomous system and the round robin and automatic account change."
>
> **Order.** This part comes after §3 and §4.
> - Its Morndo tasks (P1 to P8) go on a branch of their own after the M1 to M5 PR has merged: P6 builds on M2's app-server client.
> - Its rollout (S0 to S10) runs after R11. R4's login in `~/.codex` then stays the owner's own, outside the pool; the pool's accounts sign in to homes of their own (S4).
> - No engine-layer code changes in this part.

### 6.1 Decisions in one screen

| # | Decision | Where |
|---|---|---|
| D1 | A new bounded context, **Pool**, in `packages/domain/src/pool.ts`. It holds seat states, one account behind two homes, marks, placement, one writer per session, one turn per sign-in, and reset advice, with no vendor name. The Codex specifics are adapters in `apps/connections`. Claude gets an adapter later; the live `claude-pool` is not touched. | 6.4 |
| D2 | **Pinned by default.** A session runs on the account it was pinned to at lane start (`--account`), or on the pool's default account, and never changes account because of a limit. **Rotate** mode (weighted round robin, a move at the limit) is built but stays off. Only the owner turns it on, as his call on the terms. | 6.3 |
| D3 | One sign-in home per account, `~/.codex-accounts/<name>`, signed in once by device code. A turn runs in a fresh run home. It links `auth.json` from its account and the conversation store from one shared place, so a session can go on under another account and no token is copied. | 6.5 |
| D4 | Each account's usage comes from the CLI's app server (`account/read`, `account/rateLimits/read`), with no model request and no task. The same read gives the reset-credit count and the backend's own `ordinaryUsageAllowed`, which is what ends a mark. | 6.6 |
| D5 | One turn at a time per account, usage reads included. The docs allow "one machine or serialized job stream" per `auth.json`, and the refresh lock lives inside one process. | 6.5, 6.9 |
| D6 | Never two writers on one session: the pool's claim (holder pid, start ticks, boot id), plus Codex's own writer lock, shared across homes by linking its directory. | 6.8 |
| D7 | No code spends a reset credit. The pool says when one would pay off and asks; spending one is the owner's command. | 6.7 |
| D8 | The engine layer's `codex` provider points at a two-line wrapper around `morndo-keys pool exec`. The provider name, the chains and engine-lane stay as they are. | 6.8, S7 |

### 6.2 How the Claude pool works today (read 2026-10-15, read only)

Read from `claude-pool --help` and its source (`~/.local/bin/claude-pool`, 1,290 lines), `~/.config/claude-pool/config.json` and `lanes usage`:

| Claude pool | What it does | Codex pool (this part) |
|---|---|---|
| Accounts | `~/.claude-accounts/<name>` holds only its own login; everything else links into `~/.claude`, so a lane resumes the same conversation on another account. `main` (`~/.claude`) is outside the pool (`outOfPool`, owner 2026-10-02). | `~/.codex-accounts/<name>` holds the login, and links share the conversation store (6.5). `~/.codex` stays the owner's own login, outside the pool. |
| Same subscription | Configs signed in to one subscription (`organizationUuid`) count as one account: they share numbers and mark, only one takes lanes, and nothing moves between them. | The same, keyed by the app server's `accountId` (PL2). |
| Usage | Live, from every lane's status line. An account with no lane is probed from the `/usage` screen in a hidden tmux, with no model request. | The app server, for every account, every 15 minutes and after a failed turn (6.6). No screen reading. |
| Switch points | Low at 97 % of the 5-hour window or 99 % of the week (`fiveMinLeft 3`, `weekMinLeft 1`). New placements want a 10 % / 3 % margin (`pickMarginFive`, `pickMarginWeek`). | The same numbers, under the pool's names (short and long window). |
| Order | The account whose week resets soonest comes first ("use it or lose it", owner 2026-09-29), then the 5-hour reset. `expires` counts as a reset (owner 2026-10-11). `onlyFor` directories; `keep` with `nightReserveWeek 25`. | Weighted round robin by the quota that expires first (6.7). `expires`, `onlyFor`, `keep` and the night reserve stay. claude-pool's order is a setting (`order: soonest-reset`) for the later Claude adapter. |
| Guard | Runs every 2 minutes and on the StopFailure hook. It moves idle lanes off low accounts. A lane cut off by the limit moves at once, told to continue (`CONTINUE_MSG`): `/exit`, then `claude-as <acct> --resume <id>` in the same pane. | No tmux steps. A Codex lane runs each brief as its own `codex exec` process, so the account is chosen at the start of every turn. A turn cut off by the limit continues on the next account within the same turn (6.8, rotate only). |
| Marks | `exhausted.json` says out until a time. A mark is dropped when fresher numbers show 25 % or more left in both windows, unless numbers already cleared one within 12 hours. | Out until the reset the error or the read names. A mark ends only when a later read says `ordinaryUsageAllowed: true`; the schema says "clients must not infer recovery from percentages or reset times". |
| Lapsed plan | An account whose plan is no longer paid is retired. | The same, from the read's plan. |
| By hand | `move LANE ACCOUNT`, `retire`, `activate`, `exhausted`. | `pool move`, `pool retire`, `pool activate`. |
| Notices | `notify_once` posts to `127.0.0.1:8787/notify`: all accounts low, a pinned lane on a low account, guard errors. | The same channel, plus the reset advice (6.7). |

### 6.3 Terms (item 6), read 2026-10-15

This machine gets HTTP 403 from the live `openai.com/policies` and `help.openai.com` pages. They were read from Wayback snapshots (dates below) and through a reader service; the Codex docs were fetched directly. This replaces §5 Q1's "not verified".

**(a) One person with several personal accounts: not forbidden.** No line in the Terms, the Usage Policies or the Service Terms limits a person to one account.
- EU Terms of Use, which apply here ("These Terms of Use apply if you reside in the European Economic Area (EEA), Switzerland, or UK"; "Updated: January 16, 2026"; snapshot 2026-10-11). Registration: "You may not share your account credentials or make your account available to anyone else and are responsible for all activities that occur under your account." https://openai.com/policies/eu-terms-of-use/
- The help article on phone-only sign-ups treats several accounts per person as normal: "I have 2 OpenAI accounts, each with different emails… Can I sign up for a third account using only my phone number? Yes…" (updated 2026-07-31; snapshot 2026-08-01). https://help.openai.com/en/articles/10388702

**(b) Automated use of a ChatGPT plan through Codex: allowed and documented, but recommended against.**
- "API keys are still the recommended default for automation." https://learn.chatgpt.com/docs/auth
- "The right way to authenticate automation is with an API key. Use this guide only if you specifically need to run the workflow as your Codex account." Also: "This is an advanced workflow for enterprise and other trusted private automation." Among its conditions: "only one machine or serialized job stream will use a given `auth.json` copy". https://learn.chatgpt.com/docs/auth/ci-cd-auth
- The EU Terms also forbid "Automatically or programmatically extracting data or Output." The docs support `codex exec` with a ChatGPT login, so OpenAI evidently doesn't count a CLI turn as that. This is an inference, not their words.

**(c) Changing accounts to get past a limit: the Terms forbid circumventing rate limits, and limit-driven rotation does that.**
- EU Terms, "What you cannot do": "Interfering with or disrupting our Services, including circumventing any rate limits or restrictions or bypassing any protective measures or safety mitigations we put on our Services." The US Terms say the same ("circumvent any rate limits or restrictions").
- Usage Policies (effective 2025-10-29; snapshot 2026-10-15): "breaking or circumventing our rules and safeguards may mean you lose access to our systems or experience other penalties." https://openai.com/policies/usage-policies/
- The Codex help article lists what to do at a limit, and another account is not on it: "such as adding credits, applying an available reset, upgrading, or waiting for the limit to reset." (updated 2026-10-12; snapshot 2026-10-14) https://help.openai.com/en/articles/11369540
- No document mentions rotating between one's own paid accounts.
- **Plainly:** moving a lane to the second account because the first hit its limit is, in the ordinary sense of the words, circumventing a rate limit. So the Terms likely forbid it, and the stated penalty is losing access. Whether paying for a second plan changes that is not stated. That is a legal judgement for the owner (Q4).

**(d) Reset credits: earned, banked, and spent by the person.**
- From help article 11369540: "For some Plus and Pro promotions, a successful referral can add a banked Codex rate-limit reset." Also: "Using a full banked reset refreshes your 5-hour and weekly Codex usage windows and changes your weekly reset date."
- From help article 20001271 (updated 2026-08-10; snapshot 2026-10-01): "Duplicate redemptions, self-invites, address aliases used to evade eligibility, device-linked self-referrals, and other suspected fraudulent or abusive activity are not eligible." A banked reset "must be used within 30 days after it is added to your bank, unless the offer says otherwise." So neither of the owner's accounts should refer the other.
- In 0.161.0, the only thing that spends a credit is an explicit `account/rateLimitResetCredit/consume` request. The TUI sends it only when the user picks "Yes, use reset" (`app-server/src/message_processor.rs#L1803-1805`, `tui/src/chatwidget/usage.rs#L249-257`).

**Design consequence.** The pool runs **pinned** unless the owner turns rotation on:
- Every session has one account for life: the lane's `--account` at start, or the pool's default account. "One account per role" is then a start convention, for example review and validate lanes on `codex-a`, plan and research lanes on `codex-b` (Q7).
- At the limit, a pinned session's turn fails as a usage limit. The lane waits, or the engine layer falls back to another provider in the role's chain; nothing moves.
- The weighted placement and the move at the limit run only in **rotate** mode. Only `morndo-keys pool mode rotate --by <who>` turns it on (PL11), after the owner answers Q4.

### 6.4 DDD: the Pool context

**Why a context of its own.** Each neighbouring context is ruled out by its own rules:
- Usage decides nothing (U4: "no Mandate, Decision, Verdict or engine choice follows from it").
- Connections grants nothing, and leaves "which connection runs a role" to the routing policy (CN15). A subscription Connection has no expiry (CN3).
- Engines and routing both list "a rotation" as what a Chain and a Priority are not.

So the Pool is its own context. It decides one thing, which member account the next turn of a session runs on, and owns the rules around that.

**Ubiquitous language** (goes into `docs/domain.md` in Task P1):

| Term | Means | Is not |
|---|---|---|
| Pool | The subscription Connections of one runtime that lanes on this node share, with their settings. One per runtime. | A Chain; a Priority. |
| Member | A Connection in the pool, with `keep`, `expires` and `onlyFor`. | A sign-in token. |
| Identity | Who a member is signed in to, as a digest of the vendor's account id. Members with one identity are one **seat**. | The member's name; an email. |
| Reading | One look at a member: signed in or not, identity, plan (paid or not), windows, whether the vendor allows ordinary use, reset credits, and when it was read. | A Usage Report (that belongs to the read model). |
| Short / long window | The member's shortest and longest window: today the 5-hour and the weekly one. A plan with one window has only a long one. | A quota the pool measures. |
| Switch point | Headroom at or below which a member is **low**: short 3 %, long 1 %. | A pick margin. |
| Pick margin | Headroom a member needs to take a new session ahead of others: short 10 %, long 3 %. | A switch point. |
| Mark | "Out until T", from a usage-limit failure, for the member or for one model on it. | A provider mark in the engine layer. |
| Seat state | Logged out, retired, out, low or ok, checked in that order. | Availability (the engine layer's). |
| Urgency | Long-window headroom divided by the hours until that window resets or the member expires, whichever comes first: the quota that expires first, per hour. | A score of the work. |
| Session | A runtime conversation that turns resume (for Codex, the thread id). | A lane. |
| Placement | The member a session runs on, pinned or not. | A claim. |
| Claim | The one holder (node, pid, start ticks, boot id, lane) allowed to run a turn on a session now, on a given member. | A Connections Lease (which gates the run on that member). |
| Move | A session's placement changing member: between turns, or as the same turn's continuation after a usage limit. Rotate mode only, or the principal's `pool move`. | An engine switch (which starts a new session on another provider). |
| Mode | `pinned` (no automatic choice of account) or `rotate`. | A routing mode. |
| Move by | `resume` (the same session continues on the new member) or `handoff` (a new session with a handoff brief, used when resuming across accounts fails). | |
| Reset credit | A credit the vendor lets an account spend to reset its windows. | Spend; a credit balance. |
| Reset advice | The pool's note that spending a reset credit now would pay off, naming the member and the reason. | A spend. |

**Invariants:**

| # | Invariant |
|---|---|
| PL1 | A member is a subscription Connection in Morndo's custody, of the pool's runtime, with a sign-in home of its own (`configDir`). A key, or a subscription without a `configDir`, is never a member, so no pool turn runs in the default home. A member is in one pool only. Removing a member ends its placements. |
| PL2 | Members with one identity are one seat. They share the freshest reading and every mark. The first by name takes sessions, a move never goes between them, and their claims count together. |
| PL3 | A member's state is checked in this order: logged out (its last reading says so); retired (by hand, on a plan that isn't paid, or past `expires`); out (a live mark); low (a window at or below its switch point); ok. A window whose reset has passed counts as full. |
| PL4 | Rotate placement. Candidates are ok seats that `onlyFor` admits; a member with `onlyFor` serves only those directories, and comes first for them. At night, a `keep` member is a candidate only with at least the night reserve left in its long window. Candidates that clear both pick margins go first. Then the least `(active + 1) / urgency`, then the earlier long reset or expiry, the earlier short reset, fewer active sessions, and the name. With `order: soonest-reset` (claude-pool's), the earlier long reset or expiry comes before the load. With no candidate the answer is "no seat", with the least bad member and when the first seat comes back. |
| PL5 | Urgency is `max(longLeft, 0.5) / max(hours to the earlier of the long reset and expires, 1)`. An unknown long window counts as 100 % left over 168 hours. |
| PL6 | A placed session stays on its member while that seat is ok. In rotate mode, an unpinned session whose seat is not ok moves at its next turn, never to its own identity. A pinned session, and every session in pinned mode, never moves: its turn is refused with the member's state and when the member comes back. Only the principal's `pool move` moves it. |
| PL7 | A session has at most one live claim. A claim held by a live holder refuses a second one and names the holder. A dead holder's claim is dropped (ClaimLost). A claim made before the session is known binds to it once the runtime names it. |
| PL8 | A usage-limit failure marks the member until the reset the failure or the next reading names, else for 60 minutes, and never more than 168 hours. When the limit names one model, only that model is marked on the member. In rotate mode the same turn then continues once on each other free seat. With none left, the turn fails as a usage limit and says when the first seat comes back. |
| PL9 | A mark ends when its time passes, or when a reading taken after it says ordinary use is allowed. Percentages and reset times alone never end it. A reading under another identity drops the member's marks and starts it fresh. |
| PL10 | The pool never spends a reset credit. It advises one in two cases. First: every seat is out or low, at least one session waits, the first seat comes back four hours or more from now, and a blocked member holds a credit; it names the member whose long window resets last. Second: a credit lapses within 72 hours. Spending is the principal's command, recorded with who gave it. |
| PL11 | The mode is pinned until the principal turns rotate on, naming who decided. Anyone may turn it back to pinned. |
| PL12 | The pool decides only placements and claims. It reads no credential and stores no email (CN1, CN5); identities are digests. The Usage read model still gets each member's windows through the agents' door and still decides nothing, so U4 stands. Engine chains and availability stay the engine layer's. |
| PL13 | At most `turnsPerMember` live claims per seat, by default 1: one serialized stream per sign-in. A usage read of a member takes that member's turn slot, or is skipped. Raising the limit is the principal's call. |
| PL14 | `moveBy` stays `resume` until a move's resume fails because the conversation can't be read under the new account. The pool then sets `handoff` itself and says so (MoveByChanged). Only the principal sets it back. |

**Aggregate.** One `Pool` per runtime, holding members, settings, readings, marks, placements, claims and its last 500 events.
- PL2, PL7 and PL13 need claims, identities and placements inside one consistency boundary. Turns are few, so one versioned row per runtime is enough.
- The clock is the `now` argument. Whether a holder is still alive is passed in as a function; the Connections `Processes` port answers it.

**Domain services (pure):** `seats`, `place`, `resetAdvice`.

**Events:** MemberAdded, MemberRemoved, MemberSettingsChanged, MemberRetired, MemberActivated, MemberMarkedOut, MarkCleared, SessionPlaced, SessionMoved, ClaimGranted, ClaimReleased, ClaimLost, TurnRefused, ModeChanged, SettingsChanged, MoveByChanged, ResetAdvised, ResetSpent.

**Where things live:**

| Piece | Where |
|---|---|
| The rules, PL1 to PL14 | `packages/domain/src/pool.ts` (P2 to P4) |
| Load, save (versioned), begin, bind and end of a turn, reads, advice | `apps/connections/src/application/pool-service.ts` (P5) |
| The `pool` table (migration 3) | `apps/connections/src/adapters/store-migrations.ts`, `pool-store-sqlite.ts` (P5) |
| The Codex reader, the run home, the turn's stream and the continuation, the reset spend | `apps/connections/src/adapters/codex-account.ts`, `codex-pool-home.ts`, `codex-turn.ts`, `codex-reset.ts` (P6) |
| `morndo-keys pool …` | `apps/connections/src/pool-cli.ts`, wired in `cli.ts` (P7) |
| Claude: `CLAUDE_CONFIG_DIR` homes, status-line readings (they already reach the hub), `claude --resume` | Later. `claude-pool` stays the live one until the owner moves Claude lanes over. |

**Context map additions:**
- Pool → Connections (customer/supplier): the pool reads its members and takes a Lease per turn through the existing gate (on, terms, repo, isolation).
- Pool → Usage (publisher): readings go out as status-line reports through the agents' door. The read model doesn't change.
- Engine layer → Pool (conformist at the edge): the engine layer runs its `codex` provider through the pool's wrapper. The pool never edits a chain.

### 6.5 One home per account (item 1)

- **One sign-in home per account:** `~/.codex-accounts/<name>`, mode 0700, with a `config.toml` that says `cli_auth_credentials_store = "file"`.
  - `CODEX_HOME` is the documented root: it "Sets the root for Codex state, including config, auth, logs, sessions, skills … the directory must already exist." (https://learn.chatgpt.com/docs/config-file/environment-variables)
  - The login is `codex_home.join("auth.json")`, and the file store is the default (`login/src/auth/storage.rs#L162`, `config/src/types.rs#L116`, tag rust-v0.161.0). No setting moves the login away from `CODEX_HOME`.
- **Sign-in:** the owner runs `CODEX_HOME=~/.codex-accounts/<name> codex login --device-auth` once per account (S4). Device code sign-in must first be turned on in that account's ChatGPT security settings (ADR-0028 [S1]).
  - The command first revokes whatever refresh token that home already held (`cli/src/login.rs#L126-142` calls `logout_with_revoke`). So never sign in again to a home a turn is using: run `pool retire`, sign in, then `pool activate`.
- **No token copying.** Morndo never reads, copies or moves `auth.json` (ADR-0028 decision 2). A turn's run home holds a **link** to the member's `auth.json`, as `subscriptionRunHome` already does. Codex rewrites the file in place (truncate and write, no rename), so a refresh lands in the member's own file (`storage.rs#L214-231`).
- **The shared conversation store**, `~/.local/share/morndo/pool/codex/` (mode 0700). Each run home gets links to:
  - `sessions/`, `archived_sessions/` and `history.jsonl`. Codex follows a linked `sessions` root but skips links inside it (`rollout/src/list.rs#L1456-1463`), so the link must be the whole directory.
  - `thread-writer-locks/`, so Codex's own per-thread lock ("Coordinates writer ownership within one Codex home", `rollout/src/writer_lock.rs`) covers every account's runs.
  - `AGENTS.md`, when present: one global instructions file for all pool turns (6.9).

  The thread index is not shared (changed 2026-10-16, see §6.12): each run keeps its own SQLite index, because a shared one (`sqlite_home`, `config/src/config_toml.rs#L371`) records rollout paths inside the run home that is removed after the turn. The JSONL rollout stays the source of truth. Resume finds a thread through the database first, then by scanning `sessions/` (`thread-store/src/local/thread_rollout_resolver.rs#L67-147`).

  Not shared: `auth.json`, `models_cache.json` (its key "Must change when account, email, plan … change", `models-manager/src/manager.rs#L45`) and `secrets/`.
- **What follows a session from one account to another:**
  - Each request carries the account id of the **current** login (`model-provider/src/bearer_auth_provider.rs#L38-42`).
  - The rollout records only `creator_account_id`, "Never updated on resume" (`protocol/src/protocol.rs#L3127-3129`), and nothing reads it to refuse a resume.
  - The open question is the replayed `reasoning.encrypted_content` (`core/src/client.rs#L965`). A maintainer wrote "The encryption key is based on the account that you used to sign in" (openai/codex#13724, 2026-03-06). A contributor later resumed a thread under a second login on 0.147.0 "with no `invalid_encrypted_content`" (same issue, 2026-08-17).
  - S6 tries it on this machine. If it fails, PL14 falls back to a handoff.

### 6.6 Reading usage without a task (item 2)

What 0.161.0 exposes, checked:

| Way | What it gives | Verdict |
|---|---|---|
| `codex app-server`, `account/rateLimits/read` | `rateLimits.primary/secondary {usedPercent, windowDurationMins, resetsAt}`, `planType`, `rateLimitReachedType`; `accountId`; `ordinaryUsageAllowed` (below); `rateLimitResetCredits {availableCount, credits[{expiresAt, status, …}]}`; `rateLimitsByLimitId`. It calls `GET …/wham/usage` (plus `…/wham/rate-limit-reset-credits` unless `excludeResetCreditDetails` is set) and makes no model request (`backend-client/src/client/rate_limit_resets.rs#L68-78`). | **Used.** M2 reads the windows; P6 adds the rest. Experimental (ADR-0028). |
| `codex app-server`, `account/read` | `account: {type: "chatgpt", email, planType}`, or `null` when signed out. | **Used** for signed in and the plan. The adapter drops the email (PL12). |
| `codex exec --json` | No rate-limit field in the stream (`exec/src/event_processor_with_jsonl_output.rs#L598`). A limit shows as `error{message}` then `turn.failed{error{message}}`, with exit 1 (`#L447-457`, `#L538-556`; `exec/src/lib.rs#L1337-1354`). | Used only to **detect** a limit (6.8). |
| The rollout's `token_count` events | `rate_limits.primary/secondary`, also written when a limit is hit (`core/src/session/turn.rs#L1710-1715`). | Not used: an internal file format (ADR-0028, Alternatives). |
| TUI `/status`, `/usage` | Screens. | Not used (ADR-0024 §4: never read a screen). |

The schema is the one `codex app-server generate-json-schema` writes for 0.161.0 (`v2/GetAccountRateLimitsResponse.json`, `v2/GetAccountResponse.json`). It describes `ordinaryUsageAllowed` as: "Backend permission for ordinary included usage, validated against the active account. Null means unavailable; clients must not infer recovery from percentages or reset times."

How `codex-account.ts` maps the answer to a Reading:
- **identity:** the first 12 hex characters of SHA-256 of `accountId`, or of the email when `accountId` is null. The email itself is never kept.
- **plan:** `planType`.
- **paid:** true for any plan but `free`, `go` and `unknown`.
- **windows:** in milliseconds.
- **allowed:** `ordinaryUsageAllowed`.
- **credits:** `availableCount`, and the earliest `expiresAt` among the `available` ones.

**When.** Reads happen every 15 minutes from the usage collector (S9), and right after a turn that ended on a usage limit.
- Each read holds the member's turn slot (PL13). A member with a running turn is skipped that round, because the app server would load the same `auth.json` and might refresh it.
- The refresh lock is a semaphore inside one process (`login/src/auth/manager.rs#L2057`). Two processes that both refresh end in `refresh_token_reused`, which says "Please log out and sign in again" (`#L207`, `#L1688`).

### 6.7 Choosing an account (item 3)

**Pinned mode (the default):** nothing to choose. The session runs on its pin, else on the pool's `defaultMember`.

**Rotate mode: weighted round robin by the quota that expires first** (PL4, PL5).
- A seat's weight is its urgency: the percent of its long window that must be used per hour so that none is lost at the reset (or at `expires`).
- A new session goes to the seat with the least `(active + 1) / urgency`.
  - Two fresh accounts alternate: a, b, a, …
  - Take one account whose week resets in a day with half left (2.1 %/h), and one with 90 % left over six days (0.6 %/h). The first takes three sessions for each one the second takes.
- `active` counts sessions with a turn in the last 30 minutes or a live claim, so idle lanes carry no weight.
- Seats with less than 10 % of the short window or 3 % of the long one go after the others. Low seats (3 % / 1 % left) take nothing. `onlyFor` and the night reserve work as in claude-pool.
- A placed session stays where it is while its seat is ok (PL6), because a move sends the new account the whole conversation uncached.
- Why not claude-pool's strict "the week that resets soonest first": with several lanes at once it puts them all on one account, and they hit its 5-hour limit together. The weights spread the lanes and still favour the quota that expires first. The strict order stays available as `order: soonest-reset`.

**Reset credits** (PL10). Nothing spends them automatically. After each round of reads, the collector asks `resetAdvice`, which fires in two cases:
- **All blocked:** every seat is out or low, a session waits, the first seat comes back in four hours or more, and a blocked member holds a credit.
  - It names the member whose long window resets last. A full reset "refreshes your 5-hour and weekly Codex usage windows and changes your weekly reset date", so it buys the most where the week has the longest to run.
  - "Waiting" counts the distinct sessions with a TurnRefused in the last hour: refused for want of a seat, or made to wait for a free account.
- **Lapsing:** a credit expires within 72 hours (banked resets "must be used within 30 days"). The advice says how much of the long window a reset would give back now.

The advice reaches the owner once per member and reason per day, with the command and the default answer "wait":

```
Reset credit: codex-b is out until Fri 09:00, 2 lanes wait, it holds 3 resets (the first lapses Oct 30).
Use one now? Default: wait. To use it: morndo-keys pool reset --runtime codex --member codex-b --by <you> --yes
```

`pool reset` calls `account/rateLimitResetCredit/consume` with a fresh idempotency key. It prints the outcome the schema defines: `reset`, `nothingToReset`, `noCredit` or `alreadyRedeemed`. It is the only code that names that method; P7's architecture test checks this.

### 6.8 Changing account automatically (item 4)

**Where the turn runs.** The engine layer's `codex` provider gets `bin: ~/.local/bin/morndo-codex`, a two-line script:

```sh
#!/bin/sh
exec "$HOME/.local/bin/morndo-keys" pool exec --runtime codex ${MORNDO_POOL_ACCOUNT:+--account "$MORNDO_POOL_ACCOUNT"} ${MORNDO_POOL_LANE:+--lane "$MORNDO_POOL_LANE"} -- "$@"
```

- engine-lane builds the same argv as today and reads the same JSONL. `codex.argv` gives `exec … -s <sandbox> <prompt>`, or `exec resume <session> … -c sandbox_mode=… <prompt>`.
- `review.py` takes the same `bin`, so reviews run through the pool too.
- A lane is pinned at start through the node agent's `{account}` placeholder (PR #49, `lane-engine.ts`: `morndo lanes start … --account codex-a`). A small launcher turns it into `MORNDO_POOL_ACCOUNT` (S8). engine-lane passes its environment on to its turns.

**One turn of `pool exec`:**
1. Read the session from the arguments (`exec resume <id>`), or none for a first turn. The prompt must be the last argument; `-` (stdin) is refused.
2. `PoolService.begin` runs `place` (PL4, PL6), then `claim` on that member (PL7, PL13), in one versioned save.
   - A busy member: wait up to 30 minutes, saying so once as a non-fatal `{"type":"error","message":"[pool] waiting: a turn runs on codex-a"}`. engine-lane shows the first two errors of a turn. The wait records one TurnRefused `waiting`, which the reset advice counts.
   - A refused session (`session-busy`): exit 1 with the holder on stderr. No Codex process starts.
   - No seat, or a member that is out or low: print a `turn.failed` whose message starts "You’ve hit your usage limit" and says which accounts and when the first one is back. Exit 1 without starting Codex. engine-lane classifies it `rate_limit`, as before.
   - A member that is logged out: a `turn.failed` saying "codex-a is not signed in: sign it in again" (engine-lane: `auth`). A retired member: "codex-a is retired from the pool" (engine-lane: `engine_error`). Neither starts Codex.
3. Take the member's Connections Lease (the existing gate), build the run home (6.5), and run `codex` with `childEnv`, so no key variable reaches it (ADR-0028 decision 3).
4. Pass stdout through line by line, except a `turn.failed` line, which is held until step 5 decides. Bind the claim when `thread.started` names a new session.
5. Exit 0: release the claim and record the turn. On a failure, `codex-turn.ts` classifies the turn's messages:
   - **Usage limit:** "You’ve hit your usage limit" (with U+2019; a plain `'` is accepted too), with "for <name>" when only one model's limit was hit.
     - The reset comes from "try again at <time>" (`%-I:%M %p` today, else `%b %-d<th>, %Y %-I:%M %p`, in local time; `protocol/src/error.rs#L693-814`), else from an app-server read of that member, else 60 minutes.
     - The failure comes from HTTP 429 `usage_limit_reached`, and Codex does not retry it (`codex-api/src/api_bridge.rs#L181-218`). "rate limit exceeded: …" is the short limit that Codex retries itself; it is not a usage limit.
   - **Auth:** "refresh token was already used", "sign in again", 401. The member counts as logged out until a read says otherwise, and the owner is told to sign it in again.
   - **Conversation not readable here:** `invalid_encrypted_content` or "encrypted content" (PL14).
   - Anything else passes through unchanged.
6. **Usage limit, pinned:** mark the member, pass `turn.failed` through, exit 1.
   - The lane shows "turn failed: rate_limit". The engine layer marks the provider for an hour, and its `switch_mid_task` setting decides: wait, ask, or take the next provider in the role's chain.
7. **Usage limit, rotate:** mark the member, then run `place` again without that seat.
   - **A seat is free:** replace the held `turn.failed` with `{"type":"error","message":"[pool] codex-a reached its usage limit; this turn goes on as the same session on codex-b"}`. Then run the continuation on that seat:
     - `exec resume <session>`, with the turn's own `-m` and `-c` flags, and `-s X` turned into `-c sandbox_mode="X"` (resume has no `-s`);
     - the prompt `[pool] The turn before this one stopped because its account reached its usage limit. This is the same session on another account. Check the working tree and what you already did, then finish that turn. Its request was:`, followed by the original prompt.
     - Its stream follows on stdout, and its exit code is the turn's.
     - engine-lane sees no fatal error and takes the last `agent_message` as the answer. Any `turn.failed` line would make `finish_turn` fail the whole turn, which is why the held line is replaced.
   - **No seat left:** replace the held line with a `turn.failed` of the pool's own: "You’ve hit your usage limit on every pool account (codex-a, codex-b). The first is back at <time>." Exit 1. engine-lane still classifies it `rate_limit`.
   - A usage-limit continuation is tried at most once per seat within a turn.
8. **Handoff.**
   - With `moveBy: handoff`, step 7's continuation is a new `exec` on the new member instead of a resume.
   - When a resume is refused as unreadable, the turn gets one more try on **the same member**, as a new `exec`. That member's account works; only the old conversation can't be read under it.
   - Both use a handoff prompt: it names the old session id, says "start from the repository: `git status`, `git log -5`", and repeats the original request.
   - engine-lane follows the new `thread.started` id.
   - The old session's context is lost and the commits carry the work, as in engine-lane's own engine switch.

**Never two writers on one session**, in three layers:
- the pool's claim (PL7): one live holder per session across all accounts, checked before Codex starts;
- Codex's own writer lock, now in one directory for every run home (6.5): a second writer gets "thread … already has an active writer" (`thread-store/src/local/live_writer.rs#L46`);
- engine-lane itself runs one turn at a time per lane.

The claim of a wrapper that died is taken over, since its holder is no longer alive (PL7). The operating system releases Codex's file lock when the process ends.

### 6.9 Getting the most out of Codex for unattended lanes (item 5)

**Models and effort per role.** The official guidance, read 2026-10-15:
- From https://learn.chatgpt.com/docs/models: "For complex coding and agentic workflows, use GPT-6.1 Sol … Use Luna for focused, repeatable tasks." Also: "Start with **High** for Luna or **Light** for Astra." And: "Most tasks do not need Max or Ultra."
- From https://learn.chatgpt.com/docs/model-selection:
  - Luna at Low: "Fine-grained edits, well-scoped problem-solving, and simple data extraction."
  - GPT-6.1 Sol at Medium: "Complex technical work and coordinated deliverables you expect to revise."
  - Astra at Extra high: "Demanding analysis and complex deliverables with exacting requirements."
- From https://learn.chatgpt.com/docs/pricing, the Plus column of its table of "local messages per five-hour period": GPT-6 Astra 5-45, GPT-6.1 Sol 15-160, GPT-6 Sol 15-150, GPT-6 Luna 350-3,000. The page adds: "These estimates are not fixed message limits".
- `codex debug models --bundled` (0.161.0, scratch home):
  - default efforts: `gpt-6.1-sol` low, `gpt-6-astra` low, `gpt-6-sol` medium, `gpt-6-luna` medium;
  - `ultra` is "Maximum reasoning with automatic task delegation" (sub-agents), and Luna doesn't have it.

Recommended entries for the engine layer. This is a proposal under §5 Q2: no chain changes without that answer.

| Role | Entry | Why |
|---|---|---|
| implement-* | `codex:gpt-6.1-sol@medium` | The docs' workhorse, at the effort they name for complex technical work. |
| plan, review, validate | `codex:gpt-6.1-sol@high` | Depth matters here, and Astra uses up a Plus 5-hour window in 5 to 45 messages. No official review guidance was found; `review_model` "defaults to the current session model". |
| research, read long documents | `codex:gpt-6.1-sol@medium` | |
| small chores, fix-ups | `codex:gpt-6-luna@high` | "Start with High for Luna"; 350 to 3,000 messages per 5 hours. |
| hard design, by name only | `codex:gpt-6-astra@low` | "Light for Astra". The app's scale "ranges from Light to Ultra" and the CLI's from `low` to `ultra`, so Light is read as `low`. That mapping is an inference, not verified. |
| never unattended | `max`, `ultra` | "Most tasks do not need Max or Ultra", and `ultra` delegates to sub-agents. |

**Speed tier.** Fast mode "uses included subscription limits at 2.5x the Standard rate" (https://learn.chatgpt.com/docs/agent-configuration/speed).
- The catalog makes Fast the default for `gpt-6-sol` and `gpt-6-luna`, but only the TUI applies that default. `codex exec` uses a tier only when one is configured (`tui/src/service_tier_resolution.rs`, `core/src/session/mod.rs`).
- So the pool's run config sets no `service_tier`, and no lane passes one.

**No silent model fallback.** "Luna Reserve" (`gpt-reserve`) is a switch the TUI alone makes after ordinary usage runs out (`tui/src/app/backend_banner_fallback.rs#L64-108`); `codex exec` never refers to it. A pool turn runs the model it was given, or fails.

**Sandbox and approvals in a trusted worktree.** Keep ADR-0028 decision 4: `-s danger-full-access`, and approvals never asked, which is exec's default (`exec/src/lib.rs`). The alternatives don't fit a lane that commits:
- **`workspace-write`:** "`<writable_root>/.git` is protected as read-only whether it appears as a directory or file." Also: "If `<writable_root>/.git` is a pointer file (`gitdir: ...`), the resolved Git directory path is also protected as read-only." (https://learn.chatgpt.com/docs/agent-approvals-security) So a lane in a worktree can't commit. The network is also off unless `sandbox_workspace_write.network_access=true` (https://learn.chatgpt.com/docs/sandboxing).
- **`--approve-for-me`:** "Use automatic approval review with `on-request` approvals and the `workspace-write` sandbox." (https://learn.chatgpt.com/docs/cli/reference) Same `.git` limit, and "Auto-review interrupts the turn after `3` consecutive denials" (https://learn.chatgpt.com/docs/sandboxing/auto-review).
- The deny list that Claude lanes have stays §5 Q3's follow-up (a `PreToolUse` hook or a permission profile).

**AGENTS.md.** What the docs say (https://learn.chatgpt.com/docs/agent-configuration/agents-md):
- Codex reads its instructions "once per run".
- Global: "In your Codex home directory (defaults to `~/.codex`, unless you set `CODEX_HOME`), Codex reads `AGENTS.override.md` if it exists. Otherwise, Codex reads `AGENTS.md`."
- Project: "Starting at the project root (typically the Git root), Codex walks down to your current working directory." Also: "Codex includes at most one file per directory."
- Size: Codex "stops adding files once the combined size reaches the limit defined by `project_doc_max_bytes` (32 KiB by default)".

With one home per account, the global file would be per account. The pool links one shared `AGENTS.md` into every run home instead. Keep it short, and keep lane rules where they already live: engine-lane's preamble and the repo's own `AGENTS.md`. Each turn is its own run, so an edit reaches the next turn.

**Context and compaction.**
- Codex compacts automatically at 90 % of the context window by default. `model_auto_compact_token_limit` can only lower that point (`protocol/src/openai_models.rs`, `models-manager/src/model_info.rs`).
- Compaction runs in the core turn loop, so `exec` and `exec resume` compact too ("context compacted" in the stream).
- Every bundled model has a 272k window. Leave the defaults.
- Keep moves rare: a resumed session is sent to the new account whole.

**Parallel lanes per account.** One turn at a time per account (PL13):
- The docs' condition for a ChatGPT login in automation is that "only one machine or serialized job stream will use a given `auth.json` copy", and the refresh lock lives inside one process.
- Two accounts give two turns at once; more lanes queue at the turn boundary.
- Whether parallel sessions on one account share its windows is not documented. The allowance is per plan, though ("Local messages and cloud chats share your plan's usage allowance"), so two lanes on one account would use it up twice as fast anyway.
- `turnsPerMember` goes above 1 only by the owner's decision, once a refresh race has been ruled out (Q6).

### 6.10 Tasks (item 7)

**Branch:** `feat/account-pool`, from `origin/main` after the M1 to M5 PR has merged, in `.worktrees/account-pool`. §3's global constraints all apply:
- Node 24.21.0 and no new dependencies;
- temporary homes and fake binaries only;
- commit messages that name no AI vendor or tool;
- `chmod 644` on the two files that `npm ci` marks executable, before each commit.

Each task writes its tests first, sees them fail, then writes the code.

#### Contracts (shared across P2 to P7)

```ts
// packages/domain/src/pool.ts (P2 to P4). No vendor name in this file (P2 adds it to no-vendor-names.test.ts).
import type { Holder } from "./connections.ts";
import type { Result } from "./shared.ts";

export type PoolMode = "pinned" | "rotate";
export type MoveBy = "resume" | "handoff";
export type PoolOrder = "weighted" | "soonest-reset";
export type PoolSettings = {
  mode: PoolMode; moveBy: MoveBy; order: PoolOrder; defaultMember: string | null;
  shortMinLeft: number; longMinLeft: number; pickMarginShort: number; pickMarginLong: number; nightReserveLong: number;
  turnsPerMember: number; activeMinutes: number; defaultMarkMinutes: number; maxMarkHours: number;
  resetAdviceWaitHours: number; creditAdviceHours: number;
};
export const POOL_DEFAULTS: PoolSettings = {
  mode: "pinned", moveBy: "resume", order: "weighted", defaultMember: null,
  shortMinLeft: 3, longMinLeft: 1, pickMarginShort: 10, pickMarginLong: 3, nightReserveLong: 25,
  turnsPerMember: 1, activeMinutes: 30, defaultMarkMinutes: 60, maxMarkHours: 168,
  resetAdviceWaitHours: 4, creditAdviceHours: 72,
};
export type MemberSettings = { keep: boolean; expires: number | null; onlyFor: readonly string[] };   // expires in ms
export type Member = { name: string; settings: MemberSettings; retired: string | null };
export type QuotaWindow = { usedPercent: number; minutes: number | null; resetsAt: number | null };    // resetsAt in ms
export type Reading = {
  member: string; at: number; signedIn: boolean; identity: string | null; plan: string | null; paid: boolean | null;
  windows: readonly QuotaWindow[]; allowed: boolean | null; credits: { available: number; expiresAt: number | null } | null;
};
export type Mark = { until: number; at: number; reason: string };
export type Placement = { session: string; member: string; pinned: boolean; at: number; lastTurnAt: number };
// Not named Claim: packages/domain/src/verification.ts already exports a Claim, and index.ts re-exports both files.
export type PoolClaim = { id: string; session: string | null; member: string; pinned: boolean; holder: Holder; at: number };
export type PoolEvent =
  | { type: "MemberAdded" | "MemberRemoved" | "MemberSettingsChanged" | "MemberActivated"; member: string; at: number }
  | { type: "MemberRetired"; member: string; why: string; at: number }
  | { type: "MemberMarkedOut"; member: string; model: string | null; until: number; reason: string; at: number }
  | { type: "MarkCleared"; member: string; model: string | null; at: number }
  | { type: "SessionPlaced"; session: string; member: string; pinned: boolean; at: number }
  | { type: "SessionMoved"; session: string; from: string; to: string; why: string; at: number }
  | { type: "ClaimGranted" | "ClaimReleased" | "ClaimLost"; claim: string; member: string; session: string | null; at: number }
  | { type: "TurnRefused"; session: string | null; problem: string; at: number }
  | { type: "ModeChanged"; mode: PoolMode; by: string | null; at: number }
  | { type: "SettingsChanged"; keys: readonly string[]; by: string | null; at: number }
  | { type: "MoveByChanged"; moveBy: MoveBy; by: string; reason: string; at: number }
  | { type: "ResetAdvised"; member: string; reason: Advice["reason"]; at: number }
  | { type: "ResetSpent"; member: string; by: string; outcome: string; at: number };
export type Pool = {
  runtime: string; settings: PoolSettings; members: readonly Member[];
  readings: Readonly<Record<string, Reading>>;
  marks: Readonly<Record<string, Mark>>;          // key "<member>", or "<member> <model>" for one model's limit
  placements: readonly Placement[]; claims: readonly PoolClaim[]; events: readonly PoolEvent[];   // events: the last 500
};
export type SeatState = "logged-out" | "retired" | "out" | "low" | "ok";
export type Seat = {
  member: string; state: SeatState; sameAs: string | null;
  shortLeft: number | null; shortResets: number | null; longLeft: number | null; longResets: number | null;
  urgency: number; active: number; busy: number; credits: number; backAt: number | null;
};
export type PlaceAsk = { session: string | null; pin: string | null; dir: string | null; night: boolean; model: string | null };
export type PlaceAnswer =
  | { ok: true; member: string; moved: { from: string; why: SeatState } | null }
  | { ok: false; problem: "no-seat"; leastBad: string | null; backAt: number | null }
  | { ok: false; problem: "member-unavailable"; member: string; state: SeatState; backAt: number | null }
  | { ok: false; problem: "no-default" | "unknown-member" };
export type ClaimAsk = { id: string; session: string | null; member: string; holder: Holder; pinned?: boolean };   // pinned: false when left out
export type ClaimRefusal = { problem: "session-busy"; holder: Holder } | { problem: "member-busy"; member: string };
export type Advice = { member: string; reason: "all-blocked" | "credit-expiring"; backAt: number | null; creditExpiresAt: number | null; longLeft: number | null };

export function emptyPool(runtime: string): Pool;
export function addMember(p: Pool, name: string, settings: MemberSettings, now: number): Result<Pool, "exists">;
export function removeMember(p: Pool, name: string, now: number): Result<Pool, "missing">;
export function setMemberSettings(p: Pool, name: string, settings: MemberSettings, now: number): Result<Pool, "missing">;
export function retireMember(p: Pool, name: string, why: string, now: number): Result<Pool, "missing">;
export function activateMember(p: Pool, name: string, now: number): Result<Pool, "missing">;
export function setMode(p: Pool, mode: PoolMode, by: string | null, now: number): Result<Pool, "rotate-needs-principal">;
// moveBy "resume" and turnsPerMember above 1 need `by` (PL13, PL14); defaultMember must be a member.
export function setSettings(p: Pool, change: Partial<Omit<PoolSettings, "mode">>, by: string | null, now: number): Result<Pool, "needs-principal" | "unknown-member" | "bad-value">;
export function recordReading(p: Pool, r: Reading, now: number): Pool;
export function markOut(p: Pool, member: string, resetAt: number | null, reason: string, now: number, model?: string | null): Pool;
export function noteMoveBy(p: Pool, moveBy: MoveBy, by: string, reason: string, now: number): Pool;
export function seats(p: Pool, now: number, model?: string | null): Seat[];       // by member name
export function place(p: Pool, ask: PlaceAsk, now: number): PlaceAnswer;
export function placeSession(p: Pool, session: string, member: string, pinned: boolean, now: number): Pool;
export function claim(p: Pool, ask: ClaimAsk, alive: (h: Holder) => boolean, now: number): Result<Pool, ClaimRefusal>;
// bindSession also places the session on the claim's member, pinned as the claim is (SessionPlaced), so a first turn's pin holds.
export function bindSession(p: Pool, claimId: string, session: string, alive: (h: Holder) => boolean, now: number): Result<Pool, ClaimRefusal>;
export function release(p: Pool, claimId: string, now: number): Pool;
export function refuse(p: Pool, session: string | null, problem: string, now: number): Pool;   // TurnRefused, for "waiting"
export function resetAdvice(p: Pool, waiting: number, now: number): Advice | null;
```

```ts
// apps/connections/src/application/ports.ts (P5): the pool's store and its notices
export type PoolStore = { load(runtime: string): { pool: Pool; version: number }; save(pool: Pool, version: number): boolean };
export type PoolNotices = { send(key: string, text: string, everyMs: number): void };

// apps/connections/src/application/pool-service.ts (P5)
export type TurnStart = { runtime: string; claimId: string; session: string | null; pin: string | null; dir: string; night: boolean; model: string | null; holder: Holder };
export type TurnBegun = { member: string; configDir: string; claimId: string; moved: { from: string; why: SeatState } | null; continueBy: MoveBy | null };
export type TurnEnd =
  | { kind: "done" } | { kind: "auth" } | { kind: "unreadable" } | { kind: "other" }
  | { kind: "usage-limit"; resetAt: number | null; model: string | null };
export type PoolRefusal = { problem: string; exit: 1 | 75; holder?: Holder; backAt?: number | null };
// begin: place + claim in one versioned save (8 tries, as LeaseService), refusing a member whose Connection is not on,
// not acknowledged, or not a subscription of the runtime. end: release, mark, and the next member to go on (rotate mode,
// unpinned claims) or the same member again for a handoff.
export class PoolService {
  add(runtime: string, connection: string, settings: MemberSettings): Result<void, PoolRefusal>;   // PL1
  remove(runtime: string, member: string): Result<void, PoolRefusal>;
  retire(runtime: string, member: string, why: string): Result<void, PoolRefusal>;
  activate(runtime: string, member: string): Result<void, PoolRefusal>;
  setSettings(runtime: string, change: Partial<Omit<PoolSettings, "mode">>, by: string | null): Result<void, PoolRefusal>;
  setMode(runtime: string, mode: PoolMode, by: string | null): Result<void, PoolRefusal>;
  move(runtime: string, session: string, to: string, by: string): Result<void, PoolRefusal>;   // the principal's move: placeSession(…, pinned true)
  hold(runtime: string, member: string, claimId: string, holder: Holder): Result<void, PoolRefusal>;   // a claim with no session, for a read (PL13); no place
  release(runtime: string, claimId: string): void;
  spent(runtime: string, member: string, by: string, outcome: string): void;   // ResetSpent
  begin(start: TurnStart): Result<TurnBegun, PoolRefusal>;
  bind(runtime: string, claimId: string, session: string): Result<void, PoolRefusal>;
  end(runtime: string, claimId: string, end: TurnEnd, now?: number): { next: TurnBegun | null; refusal: PoolRefusal | null };
  record(runtime: string, reading: Reading): void;
  list(runtime: string): { settings: PoolSettings; seats: Seat[]; placements: readonly Placement[] };
  advice(runtime: string): Advice | null;      // waiting = distinct sessions with a TurnRefused in the last hour
}
```

```ts
// apps/connections/src/adapters/codex-account.ts (P6). M2's readCodexLimits and this reader share askAppServer:
// one app-server process, initialize + initialized, the calls in order, then the process group is stopped.
export function askAppServer(input: { bin: string; env: NodeJS.ProcessEnv; version: string; timeoutMs?: number },
  calls: readonly { method: string; params: object }[]): Promise<{ ok: true; results: unknown[] } | { ok: false; problem: string }>;
export function readingFromAnswers(account: unknown, limits: unknown): Omit<Reading, "member" | "at"> | null;
export function readCodexAccount(input: { bin: string; env: NodeJS.ProcessEnv; version: string; timeoutMs?: number }):
  Promise<{ ok: true; reading: Omit<Reading, "member" | "at"> } | { ok: false; problem: string }>;

// apps/connections/src/adapters/codex-pool-home.ts (P6)
export const SHARED_LINKS: readonly string[];   // sessions, archived_sessions, history.jsonl, thread-writer-locks, AGENTS.md
export function poolStore(dataDir: string, runtime: string): string;   // <data>/<runtime>, 0700, its directories made
export function poolRunHome(login: string, shared: string, profile: string, deny: readonly string[]): string;

// apps/connections/src/adapters/codex-turn.ts (P6)
export type TurnFailure = { kind: "usage-limit"; model: boolean } | { kind: "auth" } | { kind: "unreadable" } | { kind: "other" };
export function classifyFailure(messages: readonly string[]): TurnFailure;
export function retryAt(message: string, now: number, timeZone: string): number | null;
export function sessionOf(args: readonly string[]): string | null;
export function promptOf(args: readonly string[]): string | null;        // the last argument; null for "-" or a flag
export function continuationArgs(args: readonly string[], session: string, prompt: string): string[];
export function handoffArgs(args: readonly string[], prompt: string): string[];
export function continuePrompt(request: string): string;
export function handoffPrompt(oldSession: string, request: string): string;

// apps/connections/src/adapters/codex-reset.ts (P6): the only module that names account/rateLimitResetCredit/consume.
export function spendResetCredit(input: { bin: string; env: NodeJS.ProcessEnv; version: string; key: string }):
  Promise<{ ok: true; outcome: "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed" } | { ok: false; problem: string }>;
```

`morndo-keys pool` (P7). Exit 0 when done; 1 when refused or failed, with the reason on stderr; 75 on a gate refusal (as `run`).

| Command | What it does |
|---|---|
| `pool add <connection> [--keep] [--expires YYYY-MM-DD] [--only-for DIR]…` | Adds a member to its runtime's pool (PL1). |
| `pool remove\|retire\|activate <connection> [--why TEXT]` | |
| `pool set <setting> <value> [--by WHO]` | `defaultMember`, `order`, `moveBy`, `turnsPerMember`, the margins. `moveBy resume` and `turnsPerMember` above 1 need `--by`. |
| `pool mode pinned\|rotate --runtime R [--by WHO]` | `rotate` needs `--by`, and prints 6.3's terms line first. |
| `pool list --runtime R [--json]` | `{settings, seats, placements}`. |
| `pool read --runtime R (--member M [--report] \| --all)` | Reads through the app server and records the reading. `--report` prints one status-line body (ADR-0016) on stdout, and nothing when the member is busy or the read fails. |
| `pool exec --runtime R [--account M] [--lane L] -- <codex args>` | One turn (6.8). |
| `pool move --runtime R --session ID --to M --by WHO` | The principal's move: pins the session to M. |
| `pool check --runtime R` | Exit 0 when a member's Connection is on and acknowledged, and the member is signed in (its last reading) and not retired. The engine layer's probe. |
| `pool advice --runtime R [--notify]` | Prints the advice. `--notify` posts it once per member, reason and day. |
| `pool reset --runtime R --member M --by WHO --yes` | Spends one reset credit (PL10): the principal's command. |

Environment variables:
- `MORNDO_CODEX_BIN`, as for `run`;
- `MORNDO_POOL_DATA`, default `~/.local/share/morndo/pool`;
- `MORNDO_POOL_WAIT_MS`, default 1,800,000;
- `MORNDO_POOL_NOTIFY_URL`, default unset: notices then go to stderr only.

---

#### Task P1: ADR-0029 and the Pool section of the domain model

**Files:**
- Create: `docs/adr/0029-account-pool.md`
- Modify: `docs/domain.md` (a section after Usage, and the context map)

- [ ] **Step 1: Write the ADR**

```markdown
# ADR-0029: An account pool per runtime: pinned by default, rotation on the principal's word, one writer per session

- **Status:** Accepted with the pull request that adds it, 2026-10-15.
- **Builds on:** ADR-0016 (Usage, U4), ADR-0018 (Connections, CN1, CN3, CN5, CN15), ADR-0027 (engines by role, `{account}`), ADR-0028 (Codex as an engine).
- **Rules:** PL1 to PL14 in `docs/domain.md`.

## Context

1. The owner runs several subscriptions of one CLI and wants Claude's flexibility for Codex too: an account chosen per lane, usage watched, and a lane that goes on when an account is full. On his box, `claude-pool` does that for Claude, outside Morndo.
2. No Morndo context may decide it. Usage decides nothing (U4). A Connection grants nothing and leaves which one runs to routing (CN15). Chains and priorities are "not a rotation".
3. Codex 0.161.0 [S1–S6]:
   - The login lives in `CODEX_HOME/auth.json`.
   - Token refresh is locked only inside one process. The docs allow "one machine or serialized job stream" per `auth.json`.
   - Thread writer locks are per `CODEX_HOME`.
   - Sessions are JSONL under `sessions/`, plus a SQLite index whose place `sqlite_home` sets.
   - A usage limit ends a headless turn with `turn.failed` and exit 1.
   - The app server reads each account's windows, `ordinaryUsageAllowed` and reset credits with no model request.
   - Nothing spends a reset credit without an explicit request.
   - Whether a session resumes under another account is not settled.
4. Terms [S7]: the EU Terms forbid "circumventing any rate limits or restrictions". OpenAI recommends API keys for automation.

## Decision

1. **A Pool context** (`packages/domain/src/pool.ts`) owns one decision: which member account runs a session's next turn. It also owns the rules around that: seat states, one account behind two homes, marks, placement, claims, one turn per sign-in, and reset advice. It has no vendor name. Runtime specifics are adapters in `apps/connections`.
2. **Pinned by default.** A session keeps the account it was pinned to (`--account` at lane start, through ADR-0027's `{account}`), or the pool's default account. **Rotate** (weighted round robin by the quota that expires first, plus a move as the same turn's continuation at a usage limit) is turned on only by the principal, naming who decided.
3. **One sign-in home per account. Run homes link the login and one shared conversation store.** No token is copied. Codex's own writer lock directory is shared too.
4. **One turn at a time per account**, usage reads included. Raising that is the principal's call.
5. **Usage from the app server**, every 15 minutes and after a usage limit. A mark ends only when the backend allows ordinary use again.
6. **Reset credits are only advised.** Spending one is the principal's command, and one module names the method.
7. **No engine-layer code change.** Its provider's binary is a wrapper around `morndo-keys pool exec`.

## Alternatives

| Option | Verdict |
|---|---|
| Rotation on by default | Rejected. The Terms forbid circumventing rate limits; it is the principal's legal call. |
| Copy `auth.json` between homes, or one home with swapped logins | Rejected. Copies die when a refresh rotates the token (and `--device-auth` revokes the old one), and a swap races running turns. |
| Grow `claude-pool` to Codex | Rejected. It is the live system and outside the product, and its tmux steps don't fit turn-per-process lanes. |
| Accounts as separate engine-layer providers | Not possible without engine-layer code: engine-lane only runs providers named after an adapter. |
| Read usage from the rollout's `token_count` | Rejected, as in ADR-0028: an internal format. |

## Consequences

- **Good:** two accounts are watched, placed and shown on Home like one. A session never has two writers, and no reset is spent behind the owner's back.
- **Cost:** a pool table, a service, four Codex adapters, one CLI command, a launcher script and two settings on the node.
- **Limit:** pinned mode can't keep a lane going past its account's limit. That is the point.
- **Limit:** moving across accounts may need a handoff, which loses the session's context (PL14).
- **Limit:** the engine layer still marks the whole `codex` provider for an hour after a usage limit.

## Sources (read 2026-10-15)

- [S1] https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/login/src/auth/storage.rs, `auth/manager.rs`, `cli/src/login.rs`
- [S2] https://learn.chatgpt.com/docs/auth/ci-cd-auth
- [S3] https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/rollout/src/writer_lock.rs, `rollout/src/list.rs`, `thread-store/src/local/thread_rollout_resolver.rs`, `config/src/config_toml.rs`
- [S4] https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/protocol/src/error.rs, `exec/src/event_processor_with_jsonl_output.rs`
- [S5] `codex app-server generate-json-schema`, codex-cli 0.161.0: `GetAccountRateLimitsResponse`, `ConsumeAccountRateLimitResetCreditParams`
- [S6] https://github.com/openai/codex/issues/13724
- [S7] https://openai.com/policies/eu-terms-of-use/ (snapshot 2026-10-11), https://learn.chatgpt.com/docs/auth
```

- [ ] **Step 2: The domain model**

In `docs/domain.md`, after the Usage section's last line (`| U4 | …`), add a section headed `## Pool: which account runs the next turn ([ADR-0029](adr/0029-account-pool.md))`. Under it:
- one opening line: "Which member account a session's next turn runs on, and the rules around it. Code in `packages/domain/src/pool.ts`.";
- §6.4's **Ubiquitous language** table, the **Invariants** table (PL1 to PL14) and the **Events** line, verbatim;
- one closing line: "Aggregate **Pool**, one per runtime. The clock is the `now` argument; whether a holder is alive is a function argument."

In the context map section, add the three relations from §6.4, **Context map additions**.

- [ ] **Step 3: Check the links, and that the number is still free**

Run: `node -e 'const fs=require("node:fs"),p=require("node:path");for(const f of ["docs/adr/0029-account-pool.md","docs/domain.md"]){const t=fs.readFileSync(f,"utf8");for(const m of t.matchAll(/\]\(((?:\.\.?\/|adr\/)[^)#]+)\)/g)) if(!fs.existsSync(p.join(p.dirname(f),m[1]))) console.log(f,"missing",m[1])}'`
Expected: no output.

Run: `for r in $(git for-each-ref --format='%(refname)' refs/heads refs/remotes); do git ls-tree --name-only "$r" docs/adr/; done | grep -c '0029-' ; ls ../*/docs/adr 2>/dev/null | grep -c '^0029-'`
Expected: `1`, then `1`. The second count scans the sibling worktrees, this one among them. A higher count means the number is taken. Take the next free one, and rename the file and every `ADR-0029` reference.

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0029-account-pool.md docs/domain.md
git commit -m "docs(adr): record an account pool per runtime that pins sessions and keeps one writer per session"
```

---

#### Task P2: the pool's members, readings, seats and marks (domain)

**Files:**
- Create: `packages/domain/src/pool.ts`, `packages/domain/test/pool-fixtures.ts`, `packages/domain/test/pool-seats.test.ts`
- Modify: `packages/domain/src/index.ts` (`export * from "./pool.ts";`), `packages/domain/test/no-vendor-names.test.ts` (add `join(ROOT, "packages/domain/src/pool.ts")` to `sources()`)

**Interfaces:** the Contracts block, except `place`, `placeSession`, `claim`, `bindSession`, `release`, `refuse` and `resetAdvice`. Write those as P3 and P4 do; until then, leave them out of the file.

- [ ] **Step 1: The fixtures**

`packages/domain/test/pool-fixtures.ts`:
```ts
// Builders for the Pool tests: one clock, readings with a 5-hour and a weekly window, a pool of members.
import { addMember, emptyPool, recordReading, setMode, type Holder, type MemberSettings, type Pool, type Reading } from "../src/index.ts";

export const H = 3_600_000;
export const NOW = Date.UTC(2026, 9, 15, 12);
export const NONE: MemberSettings = { keep: false, expires: null, onlyFor: [] };
export type Shape = Partial<Reading> & { short?: number; long?: number; shortIn?: number; longIn?: number };

// Used percentages and hours to each reset; read a minute ago, signed in, on a paid plan, allowed, no credits.
export function reading(member: string, o: Shape = {}): Reading {
  const { short = 20, long = 30, shortIn = 2, longIn = 72, ...rest } = o;
  return {
    member, at: NOW - 60_000, signedIn: true, identity: `id-${member}`, plan: "paid-plan", paid: true, allowed: true,
    credits: { available: 0, expiresAt: null },
    windows: [
      { usedPercent: short, minutes: 300, resetsAt: NOW + shortIn * H },
      { usedPercent: long, minutes: 10_080, resetsAt: NOW + longIn * H },
    ],
    ...rest,
  };
}

export function must<T, E>(r: { ok: true; value: T } | { ok: false; error: E }): T {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.error)}`);
  return r.value;
}

// A pool of these members, read as given; rotate mode unless said otherwise.
export function poolOf(readings: readonly Reading[], mode: "pinned" | "rotate" = "rotate", settings: Record<string, MemberSettings> = {}): Pool {
  let p = emptyPool("runtime-x");
  for (const r of readings) p = must(addMember(p, r.member, settings[r.member] ?? NONE, NOW - H));
  if (mode === "rotate") p = must(setMode(p, "rotate", "principal@example.com", NOW - H));
  for (const r of readings) p = recordReading(p, r, r.at);
  return p;
}

export const holder = (pid: number): Holder => ({ node: "node-a", pid, startedAt: pid * 10, bootId: "boot-1", lane: null });
export const ALIVE = (): boolean => true;
```

- [ ] **Step 2: Write the failing tests**

`packages/domain/test/pool-seats.test.ts`:
```ts
// The Pool's members and seats (ADR-0029: PL2, PL3, PL8, PL9, PL11, PL13, PL14): states in order, one account behind two
// members, how marks start and end, and what only the principal turns on.
import { describe, expect, it } from "vitest";
import { markOut, recordReading, seats, setMode, setSettings, type Pool } from "../src/index.ts";
import { H, NOW, must, poolOf, reading } from "./pool-fixtures.ts";

const seat = (p: Pool, m: string, model: string | null = null) => seats(p, NOW, model).find(s => s.member === m);

describe("pool: seat states (PL3)", () => {
  it("is ok, low at a switch point, out under a mark, retired off a paid plan, logged out when signed out", () => {
    const p = markOut(poolOf([reading("a"), reading("b", { short: 97 }), reading("c", { long: 99 }), reading("d", { paid: false }), reading("e", { signedIn: false })]),
      "a", NOW + 3 * H, "usage limit", NOW);
    expect(seats(p, NOW).map(s => [s.member, s.state])).toEqual([["a", "out"], ["b", "low"], ["c", "low"], ["d", "retired"], ["e", "logged-out"]]);
    expect([seat(p, "a")?.backAt, seat(p, "b")?.backAt, seat(p, "c")?.backAt]).toEqual([NOW + 3 * H, NOW + 2 * H, NOW + 72 * H]);
  });

  it("counts a window whose reset has passed as full", () => {
    expect(seat(poolOf([reading("a", { short: 99, shortIn: -1 })]), "a")).toMatchObject({ state: "ok", shortLeft: 100, shortResets: null });
  });
});

describe("pool: one account behind two members (PL2)", () => {
  it("makes the second member a copy of the first that shares its marks", () => {
    const p = markOut(poolOf([reading("a", { identity: "same" }), reading("b", { identity: "same" }), reading("c")]), "b", NOW + H, "usage limit", NOW);
    expect(seat(p, "b")?.sameAs).toBe("a");
    expect([seat(p, "a")?.state, seat(p, "b")?.state, seat(p, "c")?.state]).toEqual(["out", "out", "ok"]);
  });
});

describe("pool: marks (PL8, PL9)", () => {
  it("lasts until the named reset, else an hour, and a week at most", () => {
    const p = poolOf([reading("a")]);
    expect(markOut(p, "a", NOW + 5 * H, "usage limit", NOW).marks.a?.until).toBe(NOW + 5 * H);
    expect(markOut(p, "a", null, "usage limit", NOW).marks.a?.until).toBe(NOW + H);
    expect(markOut(p, "a", NOW + 30 * 24 * H, "usage limit", NOW).marks.a?.until).toBe(NOW + 168 * H);
  });

  it("ends only with a later reading that says ordinary use is allowed", () => {
    const p = markOut(poolOf([reading("a")]), "a", NOW + 5 * H, "usage limit", NOW);
    const later = (allowed: boolean | null) => recordReading(p, { ...reading("a", { short: 0, long: 0 }), at: NOW + 60_000, allowed }, NOW + 60_000);
    expect(later(true).marks.a).toBeUndefined();
    expect(later(true).events.at(-1)).toMatchObject({ type: "MarkCleared", member: "a" });
    expect(later(null).marks.a?.until).toBe(NOW + 5 * H);
    expect(later(false).marks.a?.until).toBe(NOW + 5 * H);
    expect(recordReading(p, { ...reading("a"), at: NOW - 1, allowed: true }, NOW + 60_000).marks.a?.until).toBe(NOW + 5 * H);
  });

  it("forgets the marks of a member now signed in to another identity", () => {
    const p = markOut(poolOf([reading("a")]), "a", NOW + 5 * H, "usage limit", NOW);
    expect(recordReading(p, { ...reading("a"), identity: "other", at: NOW + 60_000, allowed: null }, NOW + 60_000).marks.a).toBeUndefined();
  });

  it("keeps a member open for other models when only one model's limit was hit", () => {
    const p = markOut(poolOf([reading("a")]), "a", NOW + H, "usage limit for one model", NOW, "model-big");
    expect([seat(p, "a", "model-big")?.state, seat(p, "a")?.state, p.marks["a model-big"]?.until]).toEqual(["out", "ok", NOW + H]);
  });
});

describe("pool: what only the principal turns on (PL11, PL13, PL14)", () => {
  it("turns rotation on only with who decided it, and off for anyone", () => {
    const p = poolOf([reading("a")], "pinned");
    expect(setMode(p, "rotate", null, NOW)).toEqual({ ok: false, error: "rotate-needs-principal" });
    const on = must(setMode(p, "rotate", "principal@example.com", NOW));
    expect(on.events.at(-1)).toMatchObject({ type: "ModeChanged", mode: "rotate", by: "principal@example.com" });
    expect(must(setMode(on, "pinned", null, NOW)).settings.mode).toBe("pinned");
  });

  it("needs who decided it to resume across accounts again or to run more than one turn per account", () => {
    const p = poolOf([reading("a")]);
    expect(setSettings(p, { moveBy: "resume" }, null, NOW)).toEqual({ ok: false, error: "needs-principal" });
    expect(setSettings(p, { turnsPerMember: 2 }, null, NOW)).toEqual({ ok: false, error: "needs-principal" });
    expect(must(setSettings(p, { turnsPerMember: 2 }, "principal@example.com", NOW)).settings.turnsPerMember).toBe(2);
    expect(setSettings(p, { defaultMember: "nobody" }, null, NOW)).toEqual({ ok: false, error: "unknown-member" });
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run packages/domain/test/pool-seats.test.ts`
Expected: FAIL. The suite can't load: `addMember` (and the rest) is not exported from `../src/index.ts`.

- [ ] **Step 4: Write `pool.ts` (members, settings, readings, marks, seats)**

The rules are PL2, PL3, PL5, PL8, PL9, PL11, PL13 and PL14. These points are what the tests pin down:
- **The windows.** The short window is the one with the fewest minutes and the long one the most; a single window is the long one.
  - Left is `100 − usedPercent`, clamped to 0..100, and 100 once `resetsAt ≤ now`.
  - A window's `…Resets` is null once its reset has passed.
- **recordReading** replaces the member's reading when `r.at ≥` the one it holds.
  - A reading with a new identity drops the member's marks (every key that starts with `"<member>"` and a space, or is the name itself).
  - `paid: false` retires the member with why `plan is not a paid plan` (MemberRetired).
  - `allowed: true` with `r.at` later than a mark's `at` drops that mark (MarkCleared, one event per key).
- **markOut** sets `until` to `resetAt ?? now + defaultMarkMinutes`, clamped to the range `now + 1 min` to `now + maxMarkHours`, under the key `member` or `` `${member} ${model}` ``.
- **seats:**
  - Group members by identity; members with no identity are each their own group. The first by name is the seat, and the others get `sameAs`.
  - A group shares its freshest reading, and every live mark of its members applies to all of them.
  - The order of checks is PL3. `expires ≤ now` also retires.
  - `backAt` is the latest live mark's `until` when out; when low, the latest reset among the windows at or below their switch point; otherwise null.
  - `urgency` follows PL5. `active` and `busy` stay 0 until P3 and P4 add placements and claims.
- **setMode** to `rotate` needs `by` (ModeChanged with it); `pinned` does not.
- **setSettings:** `moveBy: "resume"` and `turnsPerMember > 1` need `by` (else `needs-principal`); `defaultMember` must name a member; a negative or non-finite number is `bad-value`. Emits SettingsChanged with the keys.
- **Events** are kept to the last 500.

- [ ] **Step 5: Run them to see them pass, then the vendor-name rule and the types**

Run: `npx vitest run packages/domain/test/pool-seats.test.ts packages/domain/test/no-vendor-names.test.ts && npx tsc -p packages/domain`
Expected:
- `pool-seats.test.ts`: 9 tests passed;
- `no-vendor-names.test.ts` passes with `pool.ts` in its list;
- tsc prints nothing.

- [ ] **Step 6: Commit**

```bash
git add packages/domain/src/pool.ts packages/domain/src/index.ts packages/domain/test/pool-fixtures.ts packages/domain/test/pool-seats.test.ts packages/domain/test/no-vendor-names.test.ts
git commit -m "feat(domain): an account pool's members, readings, seat states and marks"
```

---

#### Task P3: placing a session (domain)

**Files:**
- Modify: `packages/domain/src/pool.ts` (`place`, `placeSession`)
- Create: `packages/domain/test/pool-place.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/domain/test/pool-place.test.ts`:
```ts
// Placing a session (ADR-0029: PL4 to PL6, PL11): pinned by default, weighted round robin by the quota that expires first in
// rotate mode, and a placed session stays where it is while its seat is ok.
import { describe, expect, it } from "vitest";
import { markOut, place, placeSession, recordReading, setSettings, type PlaceAnswer, type PlaceAsk, type Pool } from "../src/index.ts";
import { H, NOW, must, poolOf, reading } from "./pool-fixtures.ts";

const pick = (p: Pool, ask: Partial<PlaceAsk> = {}): PlaceAnswer =>
  place(p, { session: null, pin: null, dir: "/work/repo", night: false, model: null, ...ask }, NOW);

function fill(p: Pool, sessions: readonly string[]): string[] {
  const order: string[] = [];
  for (const s of sessions) {
    const a = pick(p, { session: s });
    if (!a.ok) throw new Error(`no seat for ${s}`);
    order.push(a.member);
    p = placeSession(p, s, a.member, false, NOW);
  }
  return order;
}

describe("pool: rotate placement (PL4, PL5)", () => {
  it("alternates fresh members, then weights them by the quota that expires first", () => {
    expect(fill(poolOf([reading("a", { long: 0, longIn: 168 }), reading("b", { long: 0, longIn: 168 })]), ["s1", "s2", "s3"])).toEqual(["a", "b", "a"]);
    // a: half its week left, resetting in a day (2.08 %/h); b: 90 % left over six days (0.63 %/h).
    expect(fill(poolOf([reading("a", { long: 50, longIn: 24 }), reading("b", { long: 10, longIn: 144 })]), ["s1", "s2", "s3", "s4"])).toEqual(["a", "a", "a", "b"]);
  });

  it("counts a member's end as a reset", () => {
    const p = poolOf([reading("a", { long: 50, longIn: 24 }), reading("b", { long: 10, longIn: 144 })], "rotate", { b: { keep: false, expires: NOW + 10 * H, onlyFor: [] } });
    expect(pick(p)).toMatchObject({ ok: true, member: "b" });
  });

  it("prefers a member with room over one close to its switch point", () => {
    expect(pick(poolOf([reading("a", { short: 92, long: 50, longIn: 24 }), reading("b", { long: 10, longIn: 144 })]))).toMatchObject({ member: "b" });
  });

  it("keeps a member to its directories, and puts it first there", () => {
    const p = poolOf([reading("a", { long: 50, longIn: 24 }), reading("c", { long: 10, longIn: 160 })], "rotate", { c: { keep: false, expires: null, onlyFor: ["/work/client"] } });
    expect(pick(p, { dir: "/work/repo" })).toMatchObject({ member: "a" });
    expect(pick(p, { dir: "/work/client/app" })).toMatchObject({ member: "c" });
    expect(pick(p, { dir: "/work/client-other" })).toMatchObject({ member: "a" });
  });

  it("leaves the night reserve on members kept for the day", () => {
    const p = poolOf([reading("a", { long: 80, longIn: 24 }), reading("b", { long: 10, longIn: 144 })], "rotate", { a: { keep: true, expires: null, onlyFor: [] } });
    expect([pick(p, { night: true }), pick(p)]).toMatchObject([{ member: "b" }, { member: "a" }]);
  });

  it("places a turn for a model that is out on one member on another", () => {
    const p = markOut(poolOf([reading("a"), reading("b", { long: 10, longIn: 160 })]), "a", NOW + H, "usage limit for one model", NOW, "model-big");
    expect([pick(p, { model: "model-big" }), pick(p, { model: "model-small" })]).toMatchObject([{ member: "b" }, { member: "a" }]);
  });

  it("says when a seat comes back when none has room", () => {
    const p = markOut(poolOf([reading("a", { short: 98, shortIn: 3 }), reading("b")]), "b", NOW + 5 * H, "usage limit", NOW);
    expect(pick(p)).toEqual({ ok: false, problem: "no-seat", leastBad: "a", backAt: NOW + 3 * H });
  });

  it("can use claude-pool's strict soonest-reset order instead", () => {
    const p = must(setSettings(poolOf([reading("a", { long: 50, longIn: 24 }), reading("b", { long: 10, longIn: 144 })]), { order: "soonest-reset" }, null, NOW));
    expect(fill(p, ["s1", "s2", "s3", "s4", "s5"])).toEqual(["a", "a", "a", "a", "a"]);
  });
});

describe("pool: a placed session stays (PL6)", () => {
  it("stays while its member is ok, and moves at the next turn when it is low or out", () => {
    const p = placeSession(poolOf([reading("a", { long: 10, longIn: 144 }), reading("b", { long: 50, longIn: 24 })]), "s1", "a", false, NOW - 5 * 60_000);
    expect(pick(p, { session: "s1" })).toEqual({ ok: true, member: "a", moved: null });
    expect(pick(recordReading(p, { ...reading("a", { short: 97 }), at: NOW }, NOW), { session: "s1" })).toEqual({ ok: true, member: "b", moved: { from: "a", why: "low" } });
    expect(pick(markOut(p, "a", NOW + H, "usage limit", NOW), { session: "s1" })).toEqual({ ok: true, member: "b", moved: { from: "a", why: "out" } });
  });

  it("never moves a session to another member of its own account", () => {
    const p = placeSession(markOut(poolOf([reading("a", { identity: "same" }), reading("b", { identity: "same" }), reading("c")]), "a", NOW + H, "usage limit", NOW), "s1", "a", false, NOW - 60_000);
    expect(pick(p, { session: "s1" })).toEqual({ ok: true, member: "c", moved: { from: "a", why: "out" } });
  });
});

describe("pool: pinned (PL6, PL11)", () => {
  it("runs an unpinned session on the default member, a pinned one on its pin, and moves neither", () => {
    let p = poolOf([reading("a"), reading("b")], "pinned");
    expect(pick(p)).toEqual({ ok: false, problem: "no-default" });
    p = must(setSettings(p, { defaultMember: "b" }, null, NOW));
    expect(pick(p)).toEqual({ ok: true, member: "b", moved: null });
    expect(pick(p, { pin: "a" })).toEqual({ ok: true, member: "a", moved: null });
    p = placeSession(markOut(p, "a", NOW + 2 * H, "usage limit", NOW), "s1", "a", true, NOW - 60_000);
    expect(pick(p, { session: "s1" })).toEqual({ ok: false, problem: "member-unavailable", member: "a", state: "out", backAt: NOW + 2 * H });
  });

  it("never moves a pinned session in rotate mode either", () => {
    const p = placeSession(markOut(poolOf([reading("a"), reading("b")]), "a", NOW + H, "usage limit", NOW), "s1", "a", true, NOW - 60_000);
    expect(pick(p, { session: "s1" })).toMatchObject({ ok: false, problem: "member-unavailable", member: "a" });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run packages/domain/test/pool-place.test.ts`
Expected: FAIL, 12 tests. `place` is not a function: it isn't exported yet.

- [ ] **Step 3: Write `place` and `placeSession`**

These points are what the tests pin down:
- **A placed session.** If its seat is ok, it stays (`moved: null`).
  - In pinned mode, or when the placement is pinned, the answer is `member-unavailable` with the seat's state and `backAt`.
  - Otherwise it is a rotate choice that leaves out every member of its identity, with `moved: {from, why: state}`.
- **A pin** resolves to its group's seat: ok means that member, else `member-unavailable`. A name that isn't a member is `unknown-member`.
- **Pinned mode with no pin** uses `defaultMember` as a pin; with none set, `no-default`.
- **The rotate choice:**
  - Candidates are ok seats that are not copies, that `onlyFor` admits (a directory equal to an entry, or under it after a `/`), and that pass the night reserve.
  - Sort key: an `onlyFor` match first, then roomy (both margins) first. Then, for `weighted`: `(active + 1) / urgency`, the earliest of the long reset and `expires` (∞ when unknown), the short reset (∞), `active`, the name. For `soonest-reset`, the same without the first of those.
- **No candidate:** `no-seat`.
  - `leastBad` is the member, among seats that are not copies and not retired or logged out, with the most left in its tighter window. Seats without a live mark come before marked ones; ties go by name. Unknown left counts as 100.
  - `backAt` is the earliest non-null `backAt` of those seats.
- **`active`** in `seats` counts placements on the group with `lastTurnAt ≥ now − activeMinutes`, plus claims whose session has no placement yet. P4 adds the claims.
- **`placeSession`** adds a placement (`at` and `lastTurnAt` are `now`; SessionPlaced), or moves one (`member`, `pinned` and `at` change; SessionMoved with why `moved`). Placing a session again on the same member with the same pin changes nothing.

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run packages/domain/test/pool-place.test.ts packages/domain/test/pool-seats.test.ts && npx tsc -p packages/domain`
Expected: 2 files, 21 tests passed; tsc prints nothing.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/pool.ts packages/domain/test/pool-place.test.ts
git commit -m "feat(domain): place a session by weighted round robin, or keep it pinned"
```

---

#### Task P4: claims, one turn per sign-in, and reset advice (domain)

**Files:**
- Modify: `packages/domain/src/pool.ts` (`claim`, `bindSession`, `release`, `refuse`, `resetAdvice`, `noteMoveBy`)
- Create: `packages/domain/test/pool-claims.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/domain/test/pool-claims.test.ts`:
```ts
// Claims and advice (ADR-0029: PL7, PL10, PL13): one writer per session, one turn at a time per account, resets only advised.
import { describe, expect, it } from "vitest";
import { bindSession, claim, placeSession, release, resetAdvice } from "../src/index.ts";
import { ALIVE, H, NOW, holder, must, poolOf, reading } from "./pool-fixtures.ts";

describe("pool: one writer per session (PL7)", () => {
  it("refuses a second writer while the first lives, and takes over from a dead one", () => {
    const p = must(claim(poolOf([reading("a"), reading("b")]), { id: "c1", session: "s1", member: "a", holder: holder(101) }, ALIVE, NOW));
    expect(claim(p, { id: "c2", session: "s1", member: "b", holder: holder(202) }, ALIVE, NOW))
      .toEqual({ ok: false, error: { problem: "session-busy", holder: holder(101) } });
    const taken = must(claim(p, { id: "c2", session: "s1", member: "b", holder: holder(202) }, h => h.pid !== 101, NOW));
    expect(taken.claims.map(c => c.id)).toEqual(["c2"]);
    expect(taken.events.some(e => e.type === "ClaimLost" && e.claim === "c1")).toBe(true);
  });

  it("binds a new session to its claim and keeps when its last turn ended", () => {
    let p = must(claim(poolOf([reading("a")]), { id: "c1", session: null, member: "a", holder: holder(101) }, ALIVE, NOW));
    p = placeSession(must(bindSession(p, "c1", "s-new", ALIVE, NOW)), "s-new", "a", false, NOW);
    p = release(p, "c1", NOW + 60_000);
    expect(p.claims).toEqual([]);
    expect(p.placements).toEqual([{ session: "s-new", member: "a", pinned: false, at: NOW, lastTurnAt: NOW + 60_000 }]);
  });
});

describe("pool: one turn per sign-in (PL13)", () => {
  it("runs one turn at a time per account, across members of one identity", () => {
    const p = must(claim(poolOf([reading("a", { identity: "same" }), reading("b", { identity: "same" }), reading("c")]),
      { id: "c1", session: "s1", member: "a", holder: holder(101) }, ALIVE, NOW));
    expect(claim(p, { id: "c2", session: "s2", member: "b", holder: holder(202) }, ALIVE, NOW)).toEqual({ ok: false, error: { problem: "member-busy", member: "a" } });
    expect(claim(p, { id: "c3", session: null, member: "c", holder: holder(303) }, ALIVE, NOW).ok).toBe(true);
    expect(claim(release(p, "c1", NOW), { id: "c2", session: "s2", member: "b", holder: holder(202) }, ALIVE, NOW).ok).toBe(true);
  });
});

describe("pool: reset credits are only advised (PL10)", () => {
  const blocked = (bLongIn: number, credits = 1) => poolOf([
    reading("a", { long: 99, longIn: 120, credits: { available: credits, expiresAt: null } }),
    reading("b", { long: 99, longIn: bLongIn, credits: { available: credits, expiresAt: null } }),
  ]);

  it("advises a reset when every seat is blocked, work waits and the wait is long, on the member whose week runs longest", () => {
    expect(resetAdvice(blocked(30), 1, NOW)).toEqual({ member: "a", reason: "all-blocked", backAt: NOW + 30 * H, creditExpiresAt: null, longLeft: 1 });
    expect(resetAdvice(blocked(30), 0, NOW)).toBeNull();
    expect(resetAdvice(blocked(2), 1, NOW)).toBeNull();
    expect(resetAdvice(blocked(30, 0), 1, NOW)).toBeNull();
    expect(resetAdvice(poolOf([reading("a", { long: 99, credits: { available: 1, expiresAt: null } }), reading("b")]), 1, NOW)).toBeNull();
  });

  it("advises using a credit that would lapse unused", () => {
    const p = poolOf([reading("a", { long: 60, credits: { available: 1, expiresAt: NOW + 48 * H } }), reading("b")]);
    expect(resetAdvice(p, 0, NOW)).toEqual({ member: "a", reason: "credit-expiring", backAt: null, creditExpiresAt: NOW + 48 * H, longLeft: 40 });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run packages/domain/test/pool-claims.test.ts`
Expected: FAIL, 5 tests. `claim` is not a function.

- [ ] **Step 3: Write them**

- **claim:**
  - First drop every claim whose holder isn't alive (ClaimLost each).
  - A live claim on the same session under another id gives `session-busy` with its holder.
  - Live claims on the member's identity group at or above `turnsPerMember` give `member-busy`, naming the group's seat.
  - Otherwise ClaimGranted.
- **bindSession:** the same session check, then the claim's `session`, then `placeSession` on the claim's member with the claim's `pinned`. The claim keeps `pinned` from its ask (false when left out).
- **release:** removes the claim (ClaimReleased) and sets `lastTurnAt` on the session's placement, if it has one.
- **refuse:** adds TurnRefused.
- **noteMoveBy:** sets `moveBy` (MoveByChanged).
- **resetAdvice:**
  - The seats to look at are those that are not copies and not retired or logged out.
  - **all-blocked:** when `waiting ≥ 1` and every such seat is out or low, take the first `backAt` among them. If it is at least `resetAdviceWaitHours` away, advise the seat with a credit whose long reset is latest (an unknown reset counts as the earliest); its `creditExpiresAt` is its reading's `credits.expiresAt`.
  - **credit-expiring:** otherwise, the seat whose credit expires first, within `creditAdviceHours`.
  - Otherwise null.

- [ ] **Step 4: Run the domain project**

Run: `npx vitest run packages/domain && npx tsc -p packages/domain`
Expected:
- every domain test passes, the three pool files with 26 tests among them;
- tsc prints nothing.

- [ ] **Step 5: A negative control for one writer per session**

Append to `CONTROLS` in `scripts/negative-controls.ts` an entry with `id: "pool-one-writer"`, `task: "account-pool P4"`, `file: "packages/domain/src/pool.ts"` and `run: ["packages/domain/test/pool-claims.test.ts"]`:
- `find` is the exact line of `claim` that returns `session-busy`;
- `replace` is the same line made never to fire (for example, its condition `&& false`);
- `expect` is `session-busy`.

Run: `node scripts/negative-controls.ts --check | grep pool-one-writer`
Expected: `ok    pool-one-writer: found 1 time in packages/domain/src/pool.ts`.

- [ ] **Step 6: Commit, then run the control**

```bash
git add packages/domain/src/pool.ts packages/domain/test/pool-claims.test.ts scripts/negative-controls.ts
git commit -m "feat(domain): one writer per session, one turn per account, and reset advice"
node scripts/negative-controls.ts --only pool-one-writer
```
Expected from the last line: the control bites. The claims test fails and prints `session-busy`.

---

#### Task P5: the pool's store and service (Connections application)

**Files:**
- Modify: `apps/connections/src/adapters/store-migrations.ts` (migration 3: `CREATE TABLE pool (runtime TEXT PRIMARY KEY, version INTEGER NOT NULL, body TEXT NOT NULL)`), `apps/connections/src/application/ports.ts` (`PoolStore`, `PoolNotices`)
- Create: `apps/connections/src/adapters/pool-store-sqlite.ts`, `apps/connections/src/application/pool-service.ts`
- Test: `apps/connections/test/pool-service.test.ts`

Migration 3 was free on `main` and every open branch on 2026-10-15. Check again before the commit: `grep -c 'version: 3' apps/connections/src/adapters/store-migrations.ts` prints `1` (yours), and no open PR touches the file (`gh pr list` and each branch's `git diff --stat origin/main...<branch> -- apps/connections/src/adapters/store-migrations.ts`).

- [ ] **Step 1: Write the failing tests**

`apps/connections/test/pool-service.test.ts`. Use a temporary `MORNDO_CONNECTIONS_HOME`, the file vault, and two `PoolService` instances on the same database file, built the way `compose.ts` builds the Connections service. Fake `Processes` and a fixed clock. Seven tests:
1. **"keeps one row per runtime and saves only on the version it read":** a save with an old version returns false, and `load` returns the newer pool.
2. **"lets only one of two services claim one session":** two services `begin` the same session `s1` on member `codex-a`. One gets `{member: "codex-a"}`. The other gets `{problem: "session-busy", exit: 1, holder}` naming the first holder's pid.
3. **"refuses a member whose Connection is off, unacknowledged, or not a subscription of the runtime":** `begin` with `pin: "codex-a"` after `morndo-keys off codex-a` gives `{problem: "member codex-a is off", exit: 75}`. Before `ack`, the problem is `member codex-a has no terms acknowledgement`. `add` of a key Connection fails with `a pool member is a subscription of its runtime`, and `add` of a subscription without a config dir fails with `a pool member needs its own --config-dir`.
4. **"marks the member and answers the next seat when a turn ends on a usage limit, in rotate mode only":** in rotate mode, `end(…, {kind: "usage-limit", resetAt: T, model: null})` returns `next.member: "codex-b"`, and `list` shows `codex-a` out until T. In pinned mode, the same `end` returns `next: null` and a refusal with `backAt: T`.
5. **"counts sessions refused for want of a seat as waiting":** after two refused `begin`s, with both members low and holding credits, `advice` returns the all-blocked advice. With no refusal in the last hour, it returns null.
6. **"records a reading and keeps no email":** `record` with a reading whose identity came from an email, then `list` shows the member's windows. The database file doesn't contain `@`.
7. **"holds an account for a read without placing anything, and refuses while a turn runs":** `hold` on `codex-a` succeeds while it is out (no `place` is involved), and is refused with `{problem: "codex-a is busy", exit: 1}` while a turn's claim lives. `release` frees it.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run apps/connections/test/pool-service.test.ts`
Expected: FAIL. `../src/application/pool-service.ts` can't be loaded.

- [ ] **Step 3: Write the migration, the store and the service**

- **The store:** one row per runtime holding a JSON body. `save(pool, version)` is `UPDATE … SET body = ?, version = version + 1 WHERE runtime = ? AND version = ?`, inserting when the row is missing. It returns whether a row changed, as `store-sqlite.ts` does for the directory.
- **The service** follows `LeaseService`: load, apply the domain function, save, and retry up to 8 times on a lost save.
  - **`begin`** checks the member's Connection first: present, `on`, terms at the current revision, a subscription of the runtime. Then it runs `place` and `claim` in the same attempt. The claim is `pinned` when the turn names an account, or when pinned mode sends it to the default member. For a known session it also calls `placeSession` before saving; a first turn's placement comes from `bind` (`bindSession`). It returns the member, its `configDir` and the claim id.
  - **`end`:**
    - `done`: release.
    - `usage-limit`: `markOut` (with the model when there is one).
    - `auth`: record a copy of the member's last reading with `signedIn: false` and the time now. Its identity, windows and marks stay; a reading with no identity would look like a new account and drop the marks.
    - `unreadable`: `noteMoveBy(…, "handoff", "pool", …)`, and `next` is the same member again, newly claimed, with `continueBy: "handoff"`, in either mode.
    - After a usage limit, in rotate mode and for a claim that is not pinned, it `place`s again (the new mark leaves the failed seat out) and `claim`s the new seat with a new claim id. That is `next`, with `continueBy` set to the pool's `moveBy`. A pinned claim never gets a `next` after a usage limit.
  - **`advice`** counts as waiting the distinct sessions with a TurnRefused in the last 60 minutes (a refusal, or a wait for a busy member). It records ResetAdvised when it advises.
- **No report here.** The status-line body is the CLI's job (`pool read --report`, P7). It reuses M2's `usageReport`, turning the reading's windows into `CodexLimits`.

- [ ] **Step 4: Run them to see them pass, then the connections project**

Run: `npx vitest run apps/connections/test/pool-service.test.ts && npx tsc -p apps/connections && npx vitest run apps/connections/test/architecture.test.ts packages/domain/test/no-vendor-names.test.ts`
Expected:
- 7 tests passed;
- tsc prints nothing;
- the architecture test passes: the service imports no adapter;
- the vendor-name test passes: `pool-service.ts` is in `application/`, which that test scans.

- [ ] **Step 5: Commit**

```bash
chmod 644 apps/connections/src/main.ts apps/node-agent/src/job-main.ts
git add apps/connections/src/adapters/store-migrations.ts apps/connections/src/adapters/pool-store-sqlite.ts apps/connections/src/application/ports.ts apps/connections/src/application/pool-service.ts apps/connections/test/pool-service.test.ts
git commit -m "feat(connections): keep an account pool beside the connections and run its turns through one service"
```

---

#### Task P6: the Codex adapters (reader, run home, the turn's stream, the reset spend)

**Files:**
- Create: `apps/connections/src/adapters/codex-account.ts`, `codex-pool-home.ts`, `codex-turn.ts`, `codex-reset.ts`
- Modify: `apps/connections/src/adapters/usage-codex.ts` (M2's reader now calls `askAppServer`; its tests stay green), `apps/connections/test/fixtures/fake-codex-app-server.mjs` (answers `account/read` and `account/rateLimitResetCredit/consume` too)
- Create: `apps/connections/test/fixtures/codex/rate-limits-pool.json`, `apps/connections/test/fixtures/codex/account-plus.json`
- Test: `apps/connections/test/codex-turn.test.ts`, `codex-account.test.ts`, `codex-pool-home.test.ts`

- [ ] **Step 1: The fixtures** (synthetic values; the shapes of 0.161.0's `GetAccountRateLimitsResponse` and `GetAccountResponse`)

`rate-limits-pool.json` is `rate-limits-plus.json` (M2) with these three fields changed:
- `"accountId": "acct-synthetic-0001"`;
- `"ordinaryUsageAllowed": true`;
- `"rateLimitResetCredits": { "availableCount": 2, "credits": [ { "id": "rc-synthetic-1", "grantedAt": 1893000000, "expiresAt": 1894060800, "resetType": "codexRateLimits", "status": "available", "title": null, "description": null } ] }`.

`account-plus.json` is `{ "account": { "type": "chatgpt", "email": "someone@example.com", "planType": "plus" }, "requiresOpenaiAuth": true }`.

The fake app server reads its answer to `account/read` from `account.json` beside it, and answers `account/rateLimitResetCredit/consume` with `{ "outcome": "reset" }`. Each request it saw goes into `seen.json` (`calls: [{method, params}]`).

- [ ] **Step 2: Write the failing tests**

`apps/connections/test/codex-turn.test.ts`:
```ts
// A pool turn's stream (ADR-0029, §6.8): what a failure was, when the account comes back, and the arguments of the turn that
// goes on elsewhere. Messages are codex-cli 0.161.0's (codex-rs/protocol/src/error.rs at rust-v0.161.0).
import { describe, expect, it } from "vitest";
import { classifyFailure, continuationArgs, handoffArgs, promptOf, retryAt, sessionOf } from "../src/adapters/codex-turn.ts";

const LIMIT = "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:05 PM.";
const NOON = Date.UTC(2026, 9, 15, 12);

describe("codex turn: what a failure was", () => {
  it("tells a usage limit, one model's limit, a dead sign-in and an unreadable session from the rest", () => {
    expect(classifyFailure([LIMIT])).toEqual({ kind: "usage-limit", model: false });
    expect(classifyFailure(["You've hit your usage limit for Model Big. Switch to another model now, or try again at 3:05 PM."])).toEqual({ kind: "usage-limit", model: true });
    expect(classifyFailure(["Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again."])).toEqual({ kind: "auth" });
    expect(classifyFailure(["invalid_encrypted_content: The encrypted content could not be verified."])).toEqual({ kind: "unreadable" });
    expect(classifyFailure(["rate limit exceeded: try again in 2s"])).toEqual({ kind: "other" });
    expect(classifyFailure(["exceeded retry limit, last status: 429 Too Many Requests"])).toEqual({ kind: "other" });
  });

  it("reads the reset from the message, today or on a date, in the process's time zone", () => {
    expect(retryAt(LIMIT, NOON, "UTC")).toBe(Date.UTC(2026, 9, 15, 15, 5));
    expect(retryAt("… or try again at Oct 17th, 2026 9:00 AM.", NOON, "UTC")).toBe(Date.UTC(2026, 9, 17, 9, 0));
    expect(retryAt("… or try again at 3:05 PM.", NOON, "Europe/Berlin")).toBe(Date.UTC(2026, 9, 15, 13, 5));
    expect(retryAt("… try again at 11:00 AM.", NOON, "UTC")).toBeNull();
    expect(retryAt("You’ve hit your usage limit.", NOON, "UTC")).toBeNull();
  });
});

describe("codex turn: the arguments of the turn that goes on", () => {
  it("resumes the session with the turn's flags, the sandbox as a config value, and the prompt replaced", () => {
    const first = ["exec", "--json", "-m", "model-x", "-c", 'model_reasoning_effort="high"', "-s", "danger-full-access", "Make hello.txt"];
    const again = ["exec", "resume", "t-1", "--json", "-m", "model-x", "-c", 'sandbox_mode="danger-full-access"', "Next brief"];
    expect([sessionOf(first), sessionOf(again), promptOf(first), promptOf([...first.slice(0, -1), "-"])]).toEqual([null, "t-1", "Make hello.txt", null]);
    expect(continuationArgs(first, "t-1", "GO ON")).toEqual(["exec", "resume", "t-1", "--json", "-m", "model-x", "-c", 'model_reasoning_effort="high"', "-c", 'sandbox_mode="danger-full-access"', "GO ON"]);
    expect(continuationArgs(again, "t-1", "GO ON")).toEqual([...again.slice(0, -1), "GO ON"]);
    expect(handoffArgs(again, "HAND OFF")).toEqual(["exec", "--json", "-m", "model-x", "-c", 'sandbox_mode="danger-full-access"', "HAND OFF"]);
  });
});
```

`codex-account.test.ts`, three tests:
1. **"reads who, which plan, the windows, whether use is allowed and the reset credits, and keeps no email":** with the fake app server, `readCodexAccount` returns:
   - `signedIn: true`;
   - `identity`: the first 12 hex of `createHash("sha256").update("acct-synthetic-0001")`;
   - `plan: "plus"`, `paid: true`;
   - `windows: [{usedPercent: 42, minutes: 300, resetsAt: 1893456000000}, {usedPercent: 17, minutes: 10080, resetsAt: 1893888000000}]`;
   - `allowed: true`;
   - `credits: {available: 2, expiresAt: 1894060800000}`.

   `JSON.stringify` of the answer has no `@`. The fake's calls were `initialize`, `account/read`, then `account/rateLimits/read` with `{excludeResetCreditDetails: false}`.
2. **"says signed out when the account is null":** `account.json` is `{"account": null, "requiresOpenaiAuth": true}`, so the reading is `{signedIn: false}` and has no windows.
3. **"counts free, go and unknown plans as not paid".**

`codex-pool-home.test.ts`, three tests:
1. **"links the account's login and the shared store, and points the thread index at the shared directory":**
   - `readlinkSync(join(home, "auth.json"))` is the member's `auth.json`;
   - each of `sessions`, `archived_sessions`, `history.jsonl`, `thread-writer-locks` and `AGENTS.md` links to the store;
   - `config.toml` has no `sqlite_home` line (changed 2026-10-16, see §6.12);
   - `models_cache.json` doesn't exist.
2. **"leaves AGENTS.md out when the store has none".**
3. **"refuses a login kept in a keyring"**, as `CodexRuntime` does.

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run apps/connections/test/codex-turn.test.ts apps/connections/test/codex-account.test.ts apps/connections/test/codex-pool-home.test.ts`
Expected: FAIL, 3 files. None of the modules exists yet.

- [ ] **Step 4: Write the adapters**

- **`codex-turn.ts`:**
  - The usage limit is `/You[’']ve hit your usage limit( for [^.]+)?\./`. Auth is `/refresh token was already used|sign in again|\b401\b|unauthorized/i`. Unreadable is `/invalid_encrypted_content|encrypted content/i`.
  - `retryAt` reads `try again at (h:mm AM|PM)` as today, or `try again at (Mon) (d)(st|nd|rd|th), (yyyy) (h:mm AM|PM)`, in the given time zone (`Intl.DateTimeFormat` with `timeZone` gives the offset). A time not later than `now` is null.
  - `continuationArgs` turns `exec <flags> <prompt>` into `exec resume <session> <flags> <prompt'>`:
    - `-s X` or `--sandbox X` becomes `-c sandbox_mode="X"`;
    - it drops `--add-dir X`, `-p X`, `--profile X` and `--approve-for-me`, which resume doesn't take (`codex exec resume --help`, 0.161.0);
    - a resume keeps its flags.
  - `handoffArgs` drops `resume <session>`.
  - Cite `protocol/src/error.rs#L693-814` and `exec resume --help` in the comments.
- **`codex-account.ts`:** `askAppServer` is M2's process handling with a list of calls; M2's `readCodexLimits` becomes one call through it. `readingFromAnswers` maps the two answers as §6.6 says. Return null for an unknown shape, as M2 does. `readCodexAccount` asks `account/rateLimits/read` with `{excludeResetCreditDetails: false}`, so the credits' `expiresAt` arrive (the schema: true "Skip[s] the separate reset-credit detail lookup"); M2's usage read keeps `true`.
- **`codex-pool-home.ts`:**
  - `poolStore` makes `<data>/<runtime>/{sessions,archived_sessions,thread-writer-locks,sqlite}` with mode 0700.
  - `poolRunHome` is `subscriptionRunHome` with the links from the store instead of the login, and no `sqlite_home` line in `config.toml` (changed 2026-10-16, see §6.12).
  - Cite `rollout/src/list.rs#L1456-1463`, `rollout/src/writer_lock.rs` and `config/src/config_toml.rs#L371`.
- **`codex-reset.ts`:** one `askAppServer` call, `account/rateLimitResetCredit/consume` with `{idempotencyKey: key}`. The answer's `outcome` must be one of the four values.

- [ ] **Step 5: Run them to see them pass, with M2's tests**

Run: `npx vitest run apps/connections/test/codex-turn.test.ts apps/connections/test/codex-account.test.ts apps/connections/test/codex-pool-home.test.ts apps/connections/test/usage-codex.test.ts && npx tsc -p apps/connections`
Expected: 4 files and 17 tests passed (3 + 3 + 3, plus M2's 8); tsc prints nothing.

- [ ] **Step 6: Commit**

```bash
chmod 644 apps/connections/src/main.ts apps/node-agent/src/job-main.ts
git add apps/connections/src/adapters/codex-account.ts apps/connections/src/adapters/codex-pool-home.ts apps/connections/src/adapters/codex-turn.ts apps/connections/src/adapters/codex-reset.ts apps/connections/src/adapters/usage-codex.ts apps/connections/test/fixtures apps/connections/test/codex-turn.test.ts apps/connections/test/codex-account.test.ts apps/connections/test/codex-pool-home.test.ts
git commit -m "feat(connections): read an account's identity and credits, build a shared run home, and classify a turn's end"
```

---

#### Task P7: `morndo-keys pool` and a turn that goes on elsewhere

**Files:**
- Create: `apps/connections/src/pool-cli.ts`, `apps/connections/test/fixtures/fake-codex-exec.mjs`, `apps/connections/test/pool-cli.test.ts`
- Modify: `apps/connections/src/cli.ts`:
  - `case "pool"`;
  - in `parse()`, `--json`, `--report`, `--notify`, `--yes` and `--keep` join `--subscription`, `--all` and `--risk` as flags that take no value; today every other `--x` takes one and throws `missing x`;
  - `ask` is exported for `pool-cli.ts`;
  - M3's `usage` takes the member's turn slot when the Connection is a pool member.
- Also modify: `apps/connections/src/main.ts` (no stdin read for `pool`), `apps/connections/src/adapters/runtime-codex.ts` (`execute` takes an optional `shared` store and then uses `poolRunHome`; keep the one `env: childEnv(this.#parent, loginEnv("codex", runHome)),` line for both kinds of home), `scripts/negative-controls.ts`

- [ ] **Step 1: The fake CLI for turns**

`apps/connections/test/fixtures/fake-codex-exec.mjs` stands in for `codex`:
- **`login status`:** prints `Logged in using ChatGPT` on stderr and exits 0.
- **`app-server …`:** behaves as P6's fake app server (`fake-codex-app-server.mjs`), with its files (`limits.json`, `account.json`, and `read-mode` for its `mode`) in the member's home. For a read, `CODEX_HOME` is the sign-in home itself.
- **`exec …` and `exec resume <id> …`:** it finds its member by following `$CODEX_HOME/auth.json` to its real path; that file's directory is the member's sign-in home. It reads `mode` there:
  - `ok`: `thread.started` (the resumed id, or `t-<pid>`), `turn.started`, an `agent_message` `STATUS: DONE ran on <member>`, then `turn.completed`; exit 0. It also appends a line to `$CODEX_HOME/sessions/<thread>.jsonl`.
  - `limit`: `thread.started`, `turn.started`, then `error` and `turn.failed` with the 0.161.0 Plus wording, its retry dated far ahead (`… or try again at Jan 1st, 2099 9:00 AM.`) so the mark doesn't depend on the clock; exit 1.
  - `slow`: like `ok`, but waits 1.5 s after `thread.started`.
  - `encrypted`: on a resume, `turn.failed` "invalid_encrypted_content: …" and exit 1; on a first turn, like `ok`.
  - `auth`: `turn.failed` with the refresh-token message; exit 1.
- **Its record:** each run appends `{argv, member, sessionsDir: realpath($CODEX_HOME/sessions), locksDir: realpath($CODEX_HOME/thread-writer-locks), names: Object.keys(process.env)}` to `runs.jsonl` in the member's home.

- [ ] **Step 2: Write the failing tests**

`apps/connections/test/pool-cli.test.ts` builds a scratch node with a helper `poolNode({mode, members})`:
- a temporary `MORNDO_CONNECTIONS_HOME` and `MORNDO_POOL_DATA`, and `MORNDO_CODEX_BIN` set to the fake;
- `TZ=UTC`, and a synthetic `CODEX_API_KEY` in the parent environment (the child must never see it);
- for each member, a sign-in home holding `auth.json` (`{}`), a `config.toml` with `cli_auth_credentials_store = "file"`, a `mode` file, and the read fixtures (`limits.json` from `rate-limits-pool.json`, `account.json` from `account-plus.json`);
- `morndo-keys add <m> --vendor codex --runtime codex --subscription true --config-dir <home>`, `ack <m> --by test` and `pool add <m>`;
- `pool mode rotate --by principal@example.com` when asked.

`t.cli(args)` runs `run()` from `cli.ts`; `t.runs(member)` reads that member's `runs.jsonl`. The core test, in full:
```ts
it("moves a turn cut off by the usage limit to the other account, as the same session, and hides the failed line", async () => {
  const t = await poolNode({ mode: "rotate", members: { "codex-a": "limit", "codex-b": "ok" } });
  const out = await t.cli(["pool", "exec", "--runtime", "codex", "--", "exec", "--json", "-m", "model-x", "-s", "danger-full-access", "Make hello.txt"]);
  expect(out.code, out.stderr).toBe(0);
  const events = out.stdout.trim().split("\n").map(line => JSON.parse(line) as { type: string; thread_id?: string; message?: string });
  expect(events.filter(e => e.type === "turn.failed")).toEqual([]);
  const threads = [...new Set(events.filter(e => e.type === "thread.started").map(e => e.thread_id))];
  expect(threads).toHaveLength(1);
  expect(events.some(e => e.type === "error" && /codex-a reached its usage limit; this turn goes on as the same session on codex-b/.test(e.message ?? ""))).toBe(true);
  expect(events.at(-1)?.type).toBe("turn.completed");
  const [b] = t.runs("codex-b");
  expect(b?.argv.slice(0, 3)).toEqual(["exec", "resume", threads[0]]);
  expect(b?.argv).toContain('sandbox_mode="danger-full-access"');
  expect(b?.argv).not.toContain("-s");
  expect(b?.argv.at(-1)).toMatch(/^\[pool\] The turn before this one stopped[\s\S]*Its request was:\nMake hello\.txt$/);
  expect(b?.sessionsDir).toBe(t.runs("codex-a")[0]?.sessionsDir);
  expect(b?.locksDir).toBe(t.runs("codex-a")[0]?.locksDir);
  expect(b?.names.filter(n => /KEY|TOKEN/.test(n))).toEqual([]);
  const list = JSON.parse((await t.cli(["pool", "list", "--runtime", "codex", "--json"])).stdout) as { seats: { member: string; state: string }[] };
  expect(list.seats.find(s => s.member === "codex-a")?.state).toBe("out");
});
```
The other tests, each with its expectation:
1. **"pinned: needs a default or a pin, runs on it, and never moves at the limit":**
   - with no default: exit 1 and stderr `no default member: set one with morndo-keys pool set defaultMember <name>`;
   - `--account codex-a` (mode `ok`): exit 0, and the placement is pinned;
   - `codex-a` in mode `limit`: the `turn.failed` line comes through, exit 1, `codex-a` is out, and `codex-b` has no run.
2. **"never lets two writers on one session":** a first `ok` turn on `codex-a` makes a session T. With `codex-a` switched to `slow`, a resumed turn on T runs in a child process (`main.ts`). While it runs, a second `pool exec -- exec resume T …` exits 1 with stderr `session T is being written by pid <n>`, and the fake has two runs, not three.
3. **"runs one turn at a time per account":** two lanes pinned to `codex-a` (`slow`), with `MORNDO_POOL_WAIT_MS=500`. The second prints one `[pool] waiting: a turn runs on codex-a` error event, then exits 1 with `codex-a is busy`.
4. **"says when an account is back when every account is out, and then refuses without starting the CLI":** both members in `limit`. The last line is a `turn.failed` whose message contains `every pool account`, and the exit is 1. A second `pool exec` exits 1 and adds no run.
5. **"hands off to a new session when the conversation can't be read under the other account":** `codex-a` in `limit`, `codex-b` in `encrypted`. `codex-b`'s second run is `exec` (not `resume`), with the handoff prompt naming the old session. `pool list --json` shows `settings.moveBy` `handoff`, and the events include MoveByChanged.
6. **"reports a member's windows for Home, and skips the read while a turn holds the account":** with the fake app server answering `rate-limits-pool.json`, `pool read --runtime codex --member codex-a --report` prints one line that the hub's `UsageReportBody` accepts, with `session_id` `codex-a-limits` and M2's two windows. During a `slow` turn on `codex-a`, `pool read --runtime codex --member codex-a --report` prints nothing on stdout and `codex-a: busy, read skipped` on stderr, exits 0, and starts no app server. M3's `usage --connection codex-a` exits 1 with `busy`.
7. **"spends a reset credit only on the principal's command, and only one module names how":**
   - `pool reset … --member codex-a` without `--by` or `--yes` exits 1;
   - with both, it prints `reset` and records ResetSpent with `by`;
   - a scan of `apps/connections/src`, `apps/hub/src`, `apps/node-agent/src` and `packages/*/src` finds `rateLimitResetCredit/consume` only in `codex-reset.ts`, and finds `codex-reset.ts` imported only by `pool-cli.ts`.
8. **"answers the engine layer's probe":** `pool check --runtime codex` exits 0 after `pool read --all` when a member is on, acknowledged and signed in. It exits 1 when the only member is unacknowledged, or when its fake answers `account/read` with `null`.
9. **"prints the advice once a day when asked to notify":** with `MORNDO_POOL_NOTIFY_URL` pointing at a local test server, two `pool advice --notify` calls post once.

- [ ] **Step 3: Run them to see them fail**

Run: `npx vitest run apps/connections/test/pool-cli.test.ts`
Expected: FAIL, 10 tests. `pool` is an `unknown command`.

- [ ] **Step 4: Write `pool-cli.ts` and wire it**

`pool exec` follows §6.8 steps 1 to 8:
- **Starting the turn:** it asks `PoolService.begin`. Its holder is `selfHolder(lane)`, and a claim id is `randomUUID()`. It takes the Connections Lease through `ask(…)`, as `launch` does, then runs `CodexRuntime.execute(plan, args, hooks)` with `shared: poolStore(…)`.
- **The stream:** the stdout hook splits lines and holds back only a `turn.failed`. On `thread.started` with a new id, it calls `bind`.
- **At exit:** it classifies the turn's error messages, then calls `end`. When `end` returns a `next`, it writes the replacement error event and runs the continuation on `next.member` with `continuationArgs` (or `handoffArgs`, under PL14). Otherwise it writes the held line.
- **Signals:** on SIGTERM or SIGINT it passes the signal to the child's process group, releases the claim, and exits 143 or 130.
- **Other commands:** `pool read`, `check`, `advice` and `reset` use the P6 adapters, with `childEnv(home.env, loginEnv("codex", member.configDir))`. A read (and `reset`) first takes `hold` on the member, skips a busy one, and `release`s after. The other subcommands call the service's methods of the same names.

In `cli.ts`, M3's `usage` first checks whether its Connection is a pool member. If it is, it takes that member's turn slot through the service, or exits 1 with `busy`.

- [ ] **Step 5: Run them to see them pass, then the connections project**

Run: `npx vitest run apps/connections/test/pool-cli.test.ts && npx tsc -p apps/connections && npx vitest run apps/connections`
Expected:
- `pool-cli.test.ts`: 10 tests passed;
- tsc prints nothing;
- the connections project passes. Write the file and test counts that were printed into the PR.

- [ ] **Step 6: Two negative controls**

Append two entries to `CONTROLS`, with `task: "account-pool P7"`:
- **`pool-hide-failed`:** in `pool-cli.ts`, make the line that writes the replacement event write the held `turn.failed` line instead. `run: ["apps/connections/test/pool-cli.test.ts"]`, `expect: "turn.failed"`.
- **`pool-env-keys`:** in `apps/connections/src/adapters/runtime-codex.ts`, replace `env: childEnv(this.#parent, loginEnv("codex", runHome)),` with `env: { ...this.#parent, ...loginEnv("codex", runHome) },`. `run: ["apps/connections/test/pool-cli.test.ts"]`, `expect: "KEY"`: `poolNode` puts `CODEX_API_KEY` in the parent's environment, and the core test lists the child's names.

Run: `node scripts/negative-controls.ts --check | grep pool-`
Expected: three `ok` lines (with P4's), each found once.

- [ ] **Step 7: Commit, then run the controls**

```bash
chmod 644 apps/connections/src/main.ts apps/node-agent/src/job-main.ts
git add apps/connections/src/pool-cli.ts apps/connections/src/cli.ts apps/connections/src/main.ts apps/connections/src/adapters/runtime-codex.ts apps/connections/test/fixtures/fake-codex-exec.mjs apps/connections/test/pool-cli.test.ts scripts/negative-controls.ts
git commit -m "feat(connections): run a turn through the account pool and let it go on as the same session"
node scripts/negative-controls.ts --only pool-hide-failed && node scripts/negative-controls.ts --only pool-env-keys
```
Expected: both controls bite.

---

#### Task P8: the guide, then the whole-branch checks

**Files:**
- Modify: `docs/agents/codex.md` (a section `## 5. Several accounts: the pool`), `docs/agents/usage.md` (one line)

- [ ] **Step 1: The guide**

The new section says, with made-up names only:
- one home per account and the device-code sign-in (6.5);
- `morndo-keys pool add`, `set defaultMember`, `list` and `read`;
- pinned versus rotate, quoting the EU Terms line (6.3), and that rotate is the owner's call;
- how to pin a lane (`morndo lanes start … --account <member>`);
- the reset advice and `pool reset` (6.7);
- the models table (6.9);
- one turn at a time per account.

In `usage.md`, after M5's Codex line, add: `With a pool, each member posts its own windows: see codex.md §5.`

- [ ] **Step 2: The whole branch, before the PR**

Run, in order:
```bash
npm run check
npm run lint
npx vitest run
node scripts/negative-controls.ts --check
git diff --stat origin/main...HEAD
git log --format='%s%n%b' origin/main..HEAD | grep -i -E 'codex|openai|claude|anthropic|cursor|gpt' || echo "messages clean"
```
Expected:
- `check` and `lint` clean;
- vitest: every project green, with 26 new domain tests, 7 service tests, 9 adapter tests and 10 CLI tests;
- the negative controls pass;
- the diff touches only P1 to P8's files;
- `messages clean`.

Write the counts that were printed into the PR description, with the commands. The PR merges to `main` only after the repo's review pipeline comes back clean.

```bash
git add docs/agents/codex.md docs/agents/usage.md
git commit -m "docs(agents): run several subscriptions of one runtime as a pool"
```

### 6.11 Rollout on this machine

**Gates:**
- **G4:** the pool PR (P1 to P8) has merged to `main` after a clean review.
- **G5:** the owner's answer to Q4. Until he answers, the pool runs pinned, and so does this rollout.
- **G6, production:** the manager's go for S8's node-agent restart, at a quiet moment (no lane mid-turn).
- **Before S0:** §4's R3 (`codex` on the service's `PATH`) and R9's launcher `~/.local/bin/morndo-keys` are in place, and E1 has merged (the key guard).

Use §4's shell variables (`NODE24`, `ENG`, `NODE_WT`, `DAY`), set the same way.

- [ ] **S0, record where everything stands:**
  `git -C "$ENG" rev-parse HEAD > /tmp/pool-rollout-eng-head; jq -c '.providers.codex | {bin, probe}' ~/.config/engines/engines.json; jq -c '.engines.launch.codex' ~/.config/morndo-node/policy.json; readlink -f ~/.local/bin/morndo-keys; cat ~/.local/bin/morndo-keys`
  Expected:
  - `{"bin":"codex","probe":["codex","login","status"]}`;
  - R8's launch entry;
  - the launcher's script.
- [ ] **S1, backups:**
  `cp ~/.config/engines/engines.json ~/.config/engines/engines.json.pre-pool-$DAY; cp ~/.config/morndo-node/policy.json ~/.config/morndo-node/policy.json.pre-pool-$DAY; cp ~/.local/bin/morndo-usage-collect ~/.local/bin/morndo-usage-collect.bak-$DAY-pool; cp ~/.local/bin/morndo-keys ~/.local/bin/morndo-keys.bak-$DAY-pool`
  Then the Connections database. It also holds this node's Secrets, and S2's first open runs migration 3 on it. There is no `sqlite3` on this node, so copy it while nothing has it open:
  `pgrep -fa 'connections/src/(main|secrets-main).ts'; for f in ~/.config/morndo-connections/connections.db ~/.config/morndo-connections/connections.db-wal ~/.config/morndo-connections/connections.db-shm; do [ -e "$f" ] && cp -p "$f" "$f.pre-pool-$DAY"; done; ls -l ~/.config/morndo-connections/*.pre-pool-$DAY`
  Expected:
  - four files, each the same size as its original;
  - `pgrep` prints nothing (if it prints a process, wait for it to end and copy again);
  - one to three `connections.db*.pre-pool-$DAY` copies.
- [ ] **S2, a Morndo checkout with the pool.** As R9 did, add a detached worktree of `origin/main` beside the live ones, run `npm ci` and the `chmod 644`, then point the launcher at it:
  ```bash
  MORNDO=$(dirname "$(dirname "$NODE_WT")")
  git -C "$MORNDO" fetch -q origin
  MW="$MORNDO/.worktrees/live-ship-$(git -C "$MORNDO" rev-parse --short origin/main)"
  git -C "$MORNDO" worktree add --detach "$MW" origin/main
  (cd "$MW" && PATH="$(dirname "$NODE24"):$PATH" npm ci --no-audit --no-fund >/dev/null)
  chmod 644 "$MW/apps/connections/src/main.ts" "$MW/apps/node-agent/src/job-main.ts"
  printf '#!/bin/sh\nexec %s --no-warnings %s/apps/connections/src/main.ts "$@"\n' "$NODE24" "$MW" > ~/.local/bin/morndo-keys
  morndo-keys list && morndo-keys pool list --runtime codex --json | jq -c '{mode: .settings.mode, seats: (.seats | length)}'
  ```
  Expected: the Connections from R9 as before, then `{"mode":"pinned","seats":0}`. Migration 3 ran on the first open.
- [ ] **S3, the member homes and the shared store:**
  ```bash
  for m in codex-a codex-b; do
    install -d -m 700 ~/.codex-accounts/$m
    printf 'cli_auth_credentials_store = "file"\n' > ~/.codex-accounts/$m/config.toml && chmod 600 ~/.codex-accounts/$m/config.toml
  done
  install -d -m 700 ~/.local/share/morndo/pool
  ls -ld ~/.codex-accounts/* ~/.local/share/morndo/pool
  ```
  Expected: three directories, each `drwx------`. The names `codex-a` and `codex-b` are placeholders; any `[a-z][a-z0-9-]*` names work (CN2).
- [ ] **S4, the owner signs in to both** (the owner's steps, below). Check:
  `for m in codex-a codex-b; do CODEX_HOME=~/.codex-accounts/$m codex login status; echo "$m exit $?"; done`
  Expected: `Logged in using ChatGPT` and `exit 0`, twice. `login status` reads only local state (`cli/src/login.rs#L463-466`); S5's read proves the sign-in works.
- [ ] **S5, the Connections, the pool and a first read:**
  ```bash
  for m in codex-a codex-b; do morndo-keys add $m --vendor codex --runtime codex --subscription true --config-dir ~/.codex-accounts/$m; done
  morndo-keys pool add codex-a && morndo-keys pool add codex-b && morndo-keys pool set defaultMember codex-a
  morndo-keys pool read --runtime codex --all
  morndo-keys pool list --runtime codex --json | jq -c '.settings.mode, (.seats[] | {member, state, sameAs, shortLeft, longLeft, credits})'
  ```
  Expected:
  - `"pinned"`;
  - two seats with `state` `ok` and `sameAs` `null`;
  - `credits` showing each account's banked resets.

  If `sameAs` is set, both homes are signed in to the same account. Stop: the owner signs the second home in again with his other account.

  Both terms acknowledgements are the owner's act (CN4): `morndo-keys ack codex-a --by <owner>`, and the same for `codex-b`, only on his word. Until then, S6 is refused with `has no terms acknowledgement`.
- [ ] **S6, does a session go on under the other account?** This is a one-time check. It decides `moveBy` and costs two short Luna turns at low effort.
  ```bash
  S=$(mktemp -d); git -C "$S" init -q && git -C "$S" commit -q --allow-empty -m "chore: start"; cd "$S"
  morndo-keys pool exec --runtime codex --account codex-a -- exec --json -m gpt-6-luna -c model_reasoning_effort="low" -s danger-full-access \
    "Create a.txt containing the word one, commit it as 'chore: a', then answer with STATUS: DONE as the first line." > a.jsonl
  T=$(jq -r 'select(.type == "thread.started") | .thread_id' a.jsonl | head -1)
  morndo-keys pool move --runtime codex --session "$T" --to codex-b --by operator
  morndo-keys pool exec --runtime codex -- exec resume "$T" --json -m gpt-6-luna -c model_reasoning_effort="low" -c sandbox_mode="danger-full-access" \
    "Append the word two to a.txt, commit it as 'chore: b', then answer with STATUS: DONE as the first line." > b.jsonl
  git log --oneline | head -3; jq -c 'select(.type == "turn.failed" or .type == "error")' b.jsonl
  morndo-keys pool list --runtime codex --json | jq -c --arg t "$T" '.settings.moveBy, (.placements[] | select(.session == $t) | .member)'
  ```
  Expected: `chore: b`, `chore: a`, `chore: start`; no `turn.failed`; `"resume"`, then `"codex-b"`.
  - If `b.jsonl` names `invalid_encrypted_content` or "encrypted content", the session can't be read under the other account. The pool will already have set `moveBy` to `"handoff"` (PL14). Record it in the QA notes and in Q5.
  - Then `cd ~ && rm -rf "$S"`.
- [ ] **S7, the engine layer's `codex` provider runs through the pool.** Only after S6 passed. S6 needs both acknowledgements; without them, every Codex role turn (plan, validate, review, research, and engine reviews, which use the same `bin`) would be refused once the provider points at the pool.
  ```bash
  printf '#!/bin/sh\nexec "$HOME/.local/bin/morndo-keys" pool exec --runtime codex ${MORNDO_POOL_ACCOUNT:+--account "$MORNDO_POOL_ACCOUNT"} ${MORNDO_POOL_LANE:+--lane "$MORNDO_POOL_LANE"} -- "$@"\n' > ~/.local/bin/morndo-codex
  chmod 755 ~/.local/bin/morndo-codex
  C=~/.config/engines/engines.json
  jq --arg bin "$HOME/.local/bin/morndo-codex" --arg keys "$HOME/.local/bin/morndo-keys" \
    '.providers.codex.bin = $bin | .providers.codex.probe = [$keys, "pool", "check", "--runtime", "codex"]' "$C" > "$C.new"
  "$ENG/bin/engines" validate "$C.new" \
    && diff <(jq -S 'del(.providers.codex.bin, .providers.codex.probe)' "$C") <(jq -S 'del(.providers.codex.bin, .providers.codex.probe)' "$C.new") \
    && mv "$C.new" "$C"
  "$ENG/bin/engines" probe codex --run; "$ENG/bin/engines" providers --json | jq -c '.[] | select(.provider == "codex") | {installed, login, marks}'
  ```
  Expected:
  - `validate` passes and the `diff` prints nothing;
  - then `{"installed":true,"login":"ok","marks":[]}`.

  The engine layer has no command that sets a provider's binary, so the file is edited on a copy and validated before it replaces the original.
- [ ] **S8, the launch entry takes `{account}` and `{lane}`** (G6):
  ```bash
  cat > ~/.local/bin/morndo-pool-lane <<'SH'
  #!/bin/sh
  # Turns the node agent's {account} and {lane} words into the pool's environment, then runs the engine lane.
  while [ "$#" -gt 0 ] && [ "$1" != "--" ]; do
    case "$1" in
      --account) MORNDO_POOL_ACCOUNT="$2"; export MORNDO_POOL_ACCOUNT; shift 2 ;;
      --lane) MORNDO_POOL_LANE="$2"; export MORNDO_POOL_LANE; shift 2 ;;
      *) echo "morndo-pool-lane: unknown option $1" >&2; exit 2 ;;
    esac
  done
  [ "${1:-}" = "--" ] && shift
  exec "$@"
  SH
  chmod 755 ~/.local/bin/morndo-pool-lane
  P=~/.config/morndo-node/policy.json
  jq --arg pl "$HOME/.local/bin/morndo-pool-lane" --arg lane "$ENG/bin/engine-lane" \
    '.engines.launch.codex = {command: [$pl, "--account", "{account}", "--lane", "{lane}", "--", $lane, "--engine", "codex", "--model", "{model}", "--effort", "{effort}", "--window", "{lane}"], via: "shell"}' "$P" > "$P.new"
  "$NODE24" --no-warnings --input-type=module -e 'const m = await import(process.argv[1]); m.loadPolicy(process.argv[2]); console.log("policy ok")' "$NODE_WT/apps/node-agent/src/config.ts" "$P.new"
  diff <(jq -S 'del(.engines.launch.codex)' "$P") <(jq -S 'del(.engines.launch.codex)' "$P.new") && mv "$P.new" "$P"
  systemctl --user restart morndo-node && sleep 5 && systemctl --user is-active morndo-node && morndo lanes --json | jq length
  ```
  Expected:
  - `policy ok`;
  - the `diff` prints nothing;
  - `active`, and the same number of lanes as before the restart.

  A start without `--account` drops the words `--account {account}` (`engineCommand` in `lane-engine.ts`) and runs on `defaultMember`. If `loadPolicy` throws, stop: the old policy is still in place.
- [ ] **S9, usage per account, and the advice.** In the owner's collector, replace the body of R9's `codex()` loop with one read per seat. The token and hub lines stay as R9 wrote them:
  ```bash
  rc=0
  for m in $("$HOME/.local/bin/morndo-keys" pool list --runtime codex --json | jq -r '.seats[] | select(.sameAs == null) | .member'); do
    body=$("$HOME/.local/bin/morndo-keys" pool read --runtime codex --member "$m" --report) || { echo "codex $m: no reading" >&2; rc=1; continue; }
    [ -n "$body" ] || { echo "codex $m: busy, skipped"; continue; }
    posted=$(printf '%s' "$body" | curl -sS -m 10 -o /dev/null -w '%{http_code}' -X POST "$HUB/api/agent/usage" \
      -H @<(printf 'Authorization: Bearer %s\n' "$token") -H "X-Morndo-Lane: ${MORNDO_USAGE_LANE:-usage-collector}" \
      -H "X-Morndo-Account: $m" -H 'Content-Type: application/json' --data-binary @-) || posted=000
    echo "codex $m: $(printf '%s' "$body" | jq -c '.rate_limits // .limits') -> hub $posted"
    [ "$posted" = 200 ] || rc=1
  done
  MORNDO_POOL_NOTIFY_URL=http://127.0.0.1:8787/notify "$HOME/.local/bin/morndo-keys" pool advice --runtime codex --notify || true
  exit $rc
  ```
  Run `morndo-usage-collect codex`.
  Expected:
  - `codex codex-a: {…} -> hub 200` and `codex codex-b: {…} -> hub 200`;
  - no advice yet: the accounts aren't blocked.

  The notice channel is the one `claude-pool` already posts to (`notify_once` → `127.0.0.1:8787/notify`). The single R9 Connection `codex`, if it was registered, stays the owner's own login. Turn it `off` if he doesn't use `~/.codex` himself.
- [ ] **S10, the live QA, then the record.** Save `codex-pool-qa.sh` beside the product's QA notes, not in this tree. It follows R10's script and uses only `morndo lanes`, `morndo-keys`, `git` and `jq`:
  1. Start the event stream first.
  2. Start lane A with `--account codex-a --engine codex:gpt-6.1-sol@medium` and lane B with `--account codex-b`, each in a scratch repository with a brief that commits.
  3. Wait for both `finished`/`done` events and both commits.
  4. `pool list --json`: A's session is placed on `codex-a` and B's on `codex-b`, both pinned.
  5. Send A a second brief, and at the same moment start lane C with `--account codex-a`. C's screen (`morndo lanes peek C`) shows `[pool] waiting: a turn runs on codex-a`, and C's `finished` comes after A's second one.
  6. Stop the three lanes; remove the scratch repositories.
  7. By hand: `morndo-usage-collect codex` prints two `-> hub 200` lines. Home shows the `codex-a` and `codex-b` cards (a screenshot goes to the QA notes).

  Expected: every check prints `ok`, then `ALL SCRIPTED CHECKS PASSED`. The rotate move is proven by P7's tests with fakes. It isn't forced live, because that would mean spending an account to its limit.

  Then write S0 to S10's outputs into the product's QA notes for today, and `morndo-board review <task> --note "<what ran, the result>"`.

**The owner's steps** (about five minutes; the rest is the agents'):
1. Answer Q4: pinned (the default) or rotate.
2. In **each** of the two ChatGPT accounts: Settings → Security → turn on **device code sign-in** (beta).
3. In a terminal on the node (SSH from the laptop works), run `CODEX_HOME=~/.codex-accounts/codex-a codex login --device-auth`. Open the address it prints in a browser signed in to the **first** account, and enter the code. Then do the same for `codex-b` with the **other** account; a private window keeps the first sign-in out of the way. An agent can run the command in its own window and send the address and code with `lanes notify`; the owner still approves in ChatGPT, and the agent never sees the login.
4. Acknowledge the terms for both Connections, or tell the manager "ack codex-a codex-b". This is his act (CN4).
5. Optional, recommended: Settings → Data controls → "Improve the model for everyone" off, in both accounts.
6. Don't refer one account from the other to earn resets: self-referrals are not eligible (6.3 d).

**Rollback.** Each line undoes one step. Work from the last step back to the first one that has to go.

| Step | Undo | Check |
|---|---|---|
| S9 collector | `cp ~/.local/bin/morndo-usage-collect.bak-$DAY-pool ~/.local/bin/morndo-usage-collect` | `morndo-usage-collect codex` posts R9's single account again |
| S8 launch entry | `cp ~/.config/morndo-node/policy.json.pre-pool-$DAY ~/.config/morndo-node/policy.json && systemctl --user restart morndo-node`; `rm ~/.local/bin/morndo-pool-lane` | `active`; `jq .engines.launch.codex` shows R8's entry |
| S7 provider | `cp ~/.config/engines/engines.json.pre-pool-$DAY ~/.config/engines/engines.json`; `rm ~/.local/bin/morndo-codex`; `"$ENG/bin/engines" probe codex --run` | the `codex` provider has `bin` `codex` again |
| S5 pool | `morndo-keys pool mode pinned --runtime codex`; `morndo-keys pool remove codex-a` and `codex-b`; `morndo-keys off codex-a` and `codex-b` | `pool list` shows no seats; `morndo-keys list` shows both `off` |
| S4 sign-ins | `CODEX_HOME=~/.codex-accounts/<m> codex logout` per home. This revokes that home's refresh token; it is the owner's choice. | `codex login status` exits 1 |
| S3 homes, store | `rm -r ~/.codex-accounts/<m>` after the logout. Keep `~/.local/share/morndo/pool` while any lane may still resume a pool session; deleting it makes them unresumable. | |
| S2 checkout | `cp ~/.local/bin/morndo-keys.bak-$DAY-pool ~/.local/bin/morndo-keys`; `git -C "$MORNDO" worktree remove "$MW"` | `morndo-keys list` works from R9's checkout |
| S2 migration 3 (only if the database itself must go back) | With nothing holding it open (`pgrep` as in S1): copy each `connections.db*.pre-pool-$DAY` back over its original. Changes to Connections or Secrets made since S1 are lost. Older code ignores the `pool` table, so this is rarely needed. | `morndo-keys list` shows S1's Connections |
| `main` (P1 to P8) | A revert PR. Migration 3 leaves a `pool` table that the older code ignores. | |

### 6.12 Risks and open questions

**Open questions (need someone else's decision):**
- **Q4 (owner; terms, legal): turn on rotate mode?**
  - The EU Terms forbid "circumventing any rate limits or restrictions". Moving a lane to the second account because the first is at its limit does that in the ordinary sense, and the stated penalty is losing access.
  - **Default:** pinned. Each lane keeps its account, and at the limit it waits or the engine layer falls back to another provider.
  - If he says rotate, it is his recorded decision (`pool mode rotate --by <owner>`, ModeChanged).
- **Q5 (owner, only with rotate): accept handoffs?** If S6 shows that a session can't be read under the other account, a move starts a new session with a handoff brief, and the old session's context is lost.
  - **Default:** accept. The commits carry the work, as with an engine switch.
- **Q6 (owner): more than one turn at a time per account?**
  - The docs' condition is one serialized stream per `auth.json`, and two refreshes at once can end in "Please log out and sign in again".
  - **Default:** one, which means two Codex turns at a time across both accounts.
- **Q7 (manager): which roles pin to which account?**
  - **Default:** review and validate on `codex-a`; plan and research on `codex-b`; lanes started without `--account` go to `defaultMember` `codex-a`.
  - It is the manager's start convention; the pool only keeps it.
- **Q2 (unchanged):** the models table in 6.9 is a proposal for the chains, not a change.

**Risks (accepted, with what catches them):**
- **Cross-account resume is unverified until S6.** PL14 catches a refusal at the first move and switches to handoffs. P7's handoff test checks that path.
- **One thread index for all accounts** (`sqlite_home`) is exercised only by S6 and the live QA. If it misbehaves, remove the `sqlite_home` line in `poolRunHome`: resume falls back to scanning `sessions/`.
  - **Seen live, 2026-10-16 (S6):** the shared index kept the first turn's rollout path inside its removed run home, and the resume failed with "no rollout found". The `sqlite_home` line is removed; each run keeps its own index and resume scans the linked `sessions/`.
- **The engine layer marks the whole `codex` provider** for an hour after a usage limit (`set_mark` replaces, `lane.py`). A pinned account's limit therefore makes role starts skip Codex for that hour, even when the other account has room. Lanes started with `--account` still run.
  - Follow-up, filed as a proposal: marks per account in the engine layer, or no provider mark when the pool says other accounts have room.
- **A refresh race** if Q6 is ever raised: the member gets "sign in again" (an auth failure, PL8's sibling), the pool marks it logged out, and the owner is told.
- **A sign-in revokes the old token** in that home. Sign in again only into a retired member (`pool retire` → sign in → `pool activate`).
- **Readings skipped during long turns** leave numbers stale for up to a turn. Marks from failures still apply, and each limit triggers a read.
- **The app server is experimental.** The reader refuses unknown shapes. Pinned turns don't depend on readings, which only rank rotate placements and feed the advice.
- **Wording and layout from 0.161.0** that the pool depends on: the limit's message, the `thread-writer-locks` directory name, the rollout location and resume's scan of `sessions/`, and resume's missing `-s`.
  - Add them to §5's upgrade gate. Before any Codex upgrade, re-run `codex-turn.test.ts` against the new `error.rs` text, and re-check those four in its source.
- **The terms can change** (30 days' notice for adverse changes, EU Terms). Re-read them at each Codex upgrade.
- **The owner's own `codex` in `~/.codex`** doesn't see pool sessions; that is by design. To look at one, read its JSONL under `~/.local/share/morndo/pool/codex/sessions/`. Opening a pool session in the TUI is not part of this addendum.

### 6.13 Sources for this part

Everything was read on 2026-10-15. The research of this part was done by agents; the decisive quotes and source lines were rechecked by hand in their saved copies and in the shallow clone of tag `rust-v0.161.0`.

| Source | Used for |
|---|---|
| `~/.local/bin/claude-pool` (`--help`, `rank`, `pick`, `_guard`, `exhausted_until`, `probe`, `move`, `notify_once`), `~/.config/claude-pool/config.json`, `lanes usage` | 6.2 (read only) |
| https://openai.com/policies/eu-terms-of-use/ (Wayback snapshot 2026-10-11, "Updated: January 16, 2026"), https://openai.com/policies/terms-of-use/ (snapshot 2026-10-12) | Registration; "Automatically or programmatically extracting data or Output"; "circumventing any rate limits or restrictions" |
| https://openai.com/policies/usage-policies/ (snapshot 2026-10-15) | "breaking or circumventing our rules and safeguards may mean you lose access" |
| https://help.openai.com/en/articles/11369540 (snapshot 2026-10-14) | What to do at a limit; banked resets |
| https://help.openai.com/en/articles/20001271 (snapshot 2026-10-01) | Self-referrals not eligible; 30 days to use a banked reset |
| https://help.openai.com/en/articles/10388702 (snapshot 2026-08-01) | Several accounts per person treated as normal |
| https://learn.chatgpt.com/docs/auth, https://learn.chatgpt.com/docs/auth/ci-cd-auth | API keys recommended for automation; "only one machine or serialized job stream" per `auth.json` |
| https://learn.chatgpt.com/docs/config-file/environment-variables | `CODEX_HOME` |
| https://learn.chatgpt.com/docs/pricing, /models, /model-selection, /agent-configuration/speed | Plus estimates per model; model and effort guidance; Fast mode at 2.5x |
| https://learn.chatgpt.com/docs/agent-approvals-security, /sandboxing, /sandboxing/auto-review, /cli/reference, /agent-configuration/agents-md, /config-file/config-reference | `.git` read-only in `workspace-write`; the network default; auto-review's denial limit; `--approve-for-me`; AGENTS.md discovery and the 32 KiB limit; config keys |
| github.com/openai/codex at `rust-v0.161.0`, `codex-rs/`: `login/src/auth/storage.rs#L162,#L214-231`, `config/src/types.rs#L116`, `login/src/auth/manager.rs#L207,#L1688,#L2057`, `cli/src/login.rs#L126-142,#L463-466` | Login place and store, writes in place, the refresh lock and its failure, device sign-in revoking first, `login status` reading locally |
| `rollout/src/recorder.rs#L1723-1742`, `rollout/src/list.rs#L1456-1463`, `rollout/src/writer_lock.rs`, `thread-store/src/local/live_writer.rs#L46`, `thread-store/src/local/thread_rollout_resolver.rs#L67-147`, `state/src/sqlite.rs#L34-39`, `config/src/config_toml.rs#L371`, `models-manager/src/manager.rs#L45` | Where sessions live, linked roots, the writer lock and its message, how resume finds a thread, `sqlite_home`, what is account-specific |
| `protocol/src/protocol.rs#L3127-3129`, `model-provider/src/bearer_auth_provider.rs#L38-42`, `core/src/client.rs#L965`; https://github.com/openai/codex/issues/13724 | What ties a session to an account; the open encrypted-content question |
| `protocol/src/error.rs#L693-814`, `codex-api/src/api_bridge.rs#L181-218`, `exec/src/event_processor_with_jsonl_output.rs#L447-457,#L538-556,#L598`, `exec/src/lib.rs#L1337-1354`, `core/src/session/turn.rs#L1710-1715` | The usage limit's text and source, how `exec --json` reports it, exit 1, no rate limits in the stream |
| `backend-client/src/client/rate_limit_resets.rs#L68-78`, `app-server/src/message_processor.rs#L1803-1805`, `tui/src/chatwidget/usage.rs#L249-257`, `tui/src/app/backend_banner_fallback.rs#L64-108`, `tui/src/service_tier_resolution.rs` | The usage read makes no model request; reset credits spent only on request; Luna Reserve and Fast default are the TUI's |
| `codex app-server generate-json-schema`, codex-cli 0.161.0, scratch `CODEX_HOME` | `GetAccountRateLimitsResponse` (`accountId`, `ordinaryUsageAllowed`, `rateLimitResetCredits`), `ConsumeAccountRateLimitResetCredit*`, `GetAccountResponse`, `ErrorNotification` (`usageLimitExceeded`) |
| codex-cli 0.161.0 `--help`, `login --help`, `exec --help`, `exec resume --help`; `codex debug models --bundled` (scratch home) | Flags (`--device-auth`; resume without `-s`, `-p` or `--add-dir`); models and efforts |
| Engine layer (read only): `src/engines/lane.py` (`_provider_settings`, `start_turn`, `finish_turn`), `src/engines/adapters/codex.py`, `src/engines/resolver.py` (`installed`, `set_mark`), `bin/engines --help` | A string `bin` per provider, a `turn.failed` failing the whole turn, the provider mark, no command that sets a provider |
| Morndo: `packages/domain/src/usage.ts`, `connections.ts`, `docs/domain.md` (U4, CN3, CN15, R-rules), `apps/connections/src/adapters/runtime-codex.ts` (`subscriptionRunHome`), `cli.ts` (`launch`, `ask`), `store-sqlite.ts`, `store-migrations.ts`; `origin/feat/reliable-lanes:apps/node-agent/src/ops/lane-engine.ts` (`{account}`) | Where the Pool context fits, and what it reuses |
