# ADR-0013: The Engines page: per role, which provider and model does the work, through the engine layer's CLI

- **Status:** Accepted, 2026-10-07. The owner asked for it; the manager briefed it; built by lane code-29 on `feat/engines-settings`, stacked on `feat/phone-chat` (PR #11), which the next release builds on.
- **Builds on:** ADR-0004 (the web endpoint, step-up for Commands), ADR-0009 and ADR-0011 (the phone's styles and its settings sheet).
- **Rules:** R1 to R6 in `docs/domain.md`.
- **Number:** ADR-0012 is taken by the fleet branch (PR #12).

## Context

The owner, 2026-10-07: "a settings page where you can select which provider you want to use for what ... having this as a setting would be very helpful", and "Settingspage on morndo, no?". His example: planning on Claude, implementation on Cursor, review on Claude, research on ChatGPT or Gemini through the studio lane.

The engine layer already exists outside Morndo. One JSON file holds the settings (`engines.json`, or `$ENGINES_CONFIG`); its CLI `engines` reads, validates and writes it atomically, and its resolver says which engine would run now. Its own design (`settings-ui.md`) asks every surface to change the file only through the CLI, so that two surfaces can't drift apart. Morndo's rules: no infrastructure in the domain, adapters at the edges, and it never modifies or depends on the owner's running agent system. The owner explicitly wants the page to read and write the engine settings, so it does, through the CLI only.

## Decision

1. **A page at `/engines`**, beside `/devices`. On the phone it is a link in the settings sheet (the gear on Chats, ADR-0011), above "Devices and sign out". On the desktop it is an icon next to the sidebar's settings gear. It uses the phone's styles at every width (`phone.css`); on a wide screen the cards sit in one 46rem column.
2. **The CLI is the only way in.** The hub runs the program that `MORNDO_ENGINES` names, with `execFile` and an argument list, never a shell (Node docs, `child_process.execFile`, "does not spawn a shell by default", read 2026-10-07). It reads with `get --json`, `providers --json`, `resolve ROLE --json` and `option enabled`. It writes with `set ROLE A,B,C [--force]` and `other-provider ROLE on|off --effective`. It never opens the settings file. Without `MORNDO_ENGINES` the page says the engines aren't connected (404 `engines_off`). `ENGINES_CONFIG` and `ENGINES_STATE` pass through the hub's environment to the CLI. The adapter (`apps/hub/src/adapters/engines-cli.ts`) is an anti-corruption layer: the CLI's JSON becomes domain values, and a shape it doesn't know is refused, never guessed at.
3. **One card per role, in the CLI's order.** Each card shows the role's chain as a numbered list: the first choice, then the fallbacks. Each engine has a provider, model and effort picker that offers only what the provider lists, plus up, down and remove. Below them: "+ Add a fallback", the "Reviewer from another provider" switch (always on Review; on another role only while it is on), the risk chain read-only, and "Runs now" with the resolver's reasons for skipping engines above it. The providers' availability (ready, sign-in not checked, not signed in, not installed, out of quota until …, off) is listed on top and repeated beside each engine. Edits are a draft until **Save changes**. The save bar counts the changed roles and offers Discard.
4. **A save is a Command** (AC7): past the step-up window it asks for the passkey first, as a send does. It carries the version it was read at, the sha-256 of `get --json`. If anything changed since then, the save is refused with 409 `changed` and nothing is written. Saves run one at a time in the hub, so two devices saving against one version can't both pass. Before the first write, the whole save is checked against the roles and providers as they are now (R5). Each write is recorded in the audit log as it lands (`EnginesChanged`, R6), and a save that fails part way names the roles it saved.
5. **The review rule as the resolver applies it.** The resolver turns the rule on for review when either the role's `other_provider` or the settings' `review_other_provider` is on. So the switch shows `other_provider_effective`, and changes it with one atomic `other-provider ROLE on|off --effective`: off clears both flags, on sets the role's own.
6. **The kill switch stays the engine layer's.** While `enabled` is false the page says that lanes still run on Claude and that these choices apply once engine lanes are on. The page doesn't turn it on.

### What we asked the engine layer for

`providers --json` had no efforts and `get --json` no review rule. The manager relayed the request, and the engine lane added `kind` and `efforts` to each provider row and `other_provider_effective` / `review_other_provider` to each role (engine-layer commit 2293dc0, additive, 2026-10-07). The page uses those fields; no second reader of the file was needed. After the high review it asked for two more, also additive (engine-layer 9f3a28c): `other-provider … --effective` (V8) and `efforts: null` for a provider without an efforts key (V9).

### Where things live

| Piece | Where |
|---|---|
| R1 to R6: the engine text, availability, the edits, what a save writes, the check, the audit event | `packages/domain/src/engines.ts` |
| The wire: `EnginesView`, `EnginesSaveBody` | `packages/protocol/src/engines.ts` |
| The CLI adapter | `apps/hub/src/adapters/engines-cli.ts` |
| Step-up, version, check, writes, audit | `apps/hub/src/application/engines-service.ts` |
| `GET` and `POST /api/engines` | `apps/hub/src/adapters/http.ts` |
| The page, a role's card, the words | `apps/web/src/routes/engines/+page.svelte`, `apps/web/src/lib/engines/*` |

### After the fresh-context review (2026-10-07)

- **Some saves could pass both checks or leave no record:** a write that failed after another one landed left no audit record, and two saves against one version could both pass the check. Both are fixed: each write is recorded as it lands, and saves are serialised. Hub tests cover both.
- **The chain is keyed by position:** the CLI accepts the same engine twice in a chain, and Svelte throws on a duplicate key, which broke the whole page. The e2e now seeds such a role.
- **The page reads the provider lists as the CLI does:** no known models means any model, and `[options]` don't count. An engine a role already had is kept whatever the page makes of it.
- **Small fixes:** switching provider no longer lands on a duplicate, a change with nothing in it is dropped, and a failed last read still names what was saved.
- **Left open:** a write from outside the hub (the terminal, the manager) between the hub's check and its write is not caught. Only a compare-and-set in the engine CLI (`set --if-version`) closes that window; it lasts a few hundred milliseconds.

### After the high review of PR #13 (2026-10-07, one commit per finding)

1. **The resolver's skipped list is keyed by position:** a chain holding one engine twice is skipped twice. The e2e pauses that model too.
2. **The rule is one atomic CLI write:** `engines other-provider ROLE on|off --effective`, which the engine lane added for this (engine-layer 9f3a28c, V8). Off for review clears both flags in one validated save, so the hub no longer keeps its own copy of the resolver's rule (finding 8).
3. **Copies a role already held pass a save:** only a new copy is refused, and the refusal names the engine. The page marks a lower copy "Also above: never runs".
4. **`efforts: null` means any effort:** the provider has no efforts key, so the CLI takes any (9f3a28c, V9); `[]` still means none.
5. **One limit on a chain, `MAX_CHAIN` = 8** (a first choice and seven fallbacks):
   - The page offers no fallback past it and says why.
   - A save past it is refused, naming the role.
   - A role set longer by hand still saves, as long as it doesn't grow. Nothing is cut off silently.
   - The body schema keeps only a size guard of 64 entries.
6. **The check before a save reads `get` and `providers` only;** what runs now is read once, after the writes.
7. **`GET /api/engines` takes from the device's commands bucket,** like a save.
8. Small: one deep copy of the draft (`$state.snapshot` already copies), and one wording for an engine's place.

### After the verify of that round (2026-10-07)

1. **A held engine keeps only the leeways the CLI allows:** its copies, and a model written with `--force`. An unknown provider, or an effort the provider doesn't take, fails the check before any write, since the CLI's `set` would refuse it after earlier roles landed.
2. **`GET /api/engines` has its own read bucket** (`engineReads`: 10 at once, then 10 a minute per device). Reloading the page never spends the commands a device answers and sends with.
3. **The hub requires engine-layer 9f3a28c or later.** It probes the CLI once (`other-provider --help` must list `--effective`; there is no version flag) and logs the result at start. On an older CLI, GET and POST answer 503 `unsupported` saying what to update, and the page shows that. A missing `efforts` or `other_provider_effective` field is a shape the hub doesn't know; it no longer guesses.
4. **The save body has no length cap on a chain.** `MAX_CHAIN` in the domain decides, naming the role. The hub's 64 KB body limit bounds the size.
5. **The note on a long role** says it can be reordered or changed, and saved at its length or shorter.
6. **A provider with `efforts: null` gets a free text field,** empty for its default; lowercase letters only, as in the CLI's grammar.
7. Tests: the e2e's add loop is bounded, and the save-check test fails clearly when nothing was written.

**Backlog:** the duplicate check counts copies with nested filters per engine, and the held-engine leeways live in two branches of `checkChanges`. One count map per role, built once, would keep both rules in one place.

## Consequences

- One source of truth: the page, the terminal and the manager all change the same file through the same checks. A change made elsewhere shows on the page's next load, and a stale page can't overwrite it.
- The hub depends on the engine CLI only when `MORNDO_ENGINES` is set. Its tests use a fake with the real CLI's calls, shapes, exit codes and refusals (`apps/hub/test/fixtures/fake-engines.mjs`). The e2e runs the real CLI on a scratch settings file (`e2e/engines.e2e.ts`, `npm run e2e:engines`). It is not in CI, which has no engine layer.
- Deploying it means setting `MORNDO_ENGINES` to the engine layer's `engines` binary in the hub's service environment. That is a deploy step, not part of this change.
- Not here yet: editing the risk chain (shown read-only; `engines set ROLE … --risk`), turning engine lanes on, and running the providers' sign-in probes (`engines probe --run`) from the page.
