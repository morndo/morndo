# Memory: what the lanes learned (ADR-0031)

Issue #65. A lane starts with no context: each session's memory is per machine and per vendor, so what one lane
learned is invisible to the next. Memory keeps what lanes, the manager and the principal learned about a scope as
Notes in one place, and hands them to every lane as Agent Skills, whatever engine runs it.

## Bounded context

`Memory` is its own context (docs/domain.md "Memory: what the lanes learned"). Its rules are pure, in
`packages/domain/src/memory.ts`: Notes, scopes, trust tiers, supersession, what is deliverable, the bounded index and the
skill files. Invariants M1-M7 are in the domain doc and in that file's header.

- **Fleet supplies Memory** (customer and supplier): lanes write through the hub's agent door. Memory's skill files reach
  each node through one typed operation, `memory.sync` (FL14: no command, no path).
- **Memory is a customer of Authority and Escalation**: only the principal approves a Procedure or an untrusted Note
  (M4, M5). Slice 1 takes the approval at the control plane's console, `morndo memory approve`. The console already acts
  for the principal (`pair`, `revoke`). An Ask in the app is the next slice.
- **Verification supplies Memory**: only evidence the author did not produce raises a Note to tier 2 (M5).
- **Memory stands beside Knowledge**: both hand agents Agent Skills and show a stale note as stale (K6, M7). They share
  no data. Knowledge ships what to plan with; Memory keeps what this user's lanes learned.
- **Memory grants nothing** (M1).

## Storage

The hub opens its own file, `memory.db`, beside `morndo.db` in its data directory, with
`openPrivateDb(path, { synchronous: "NORMAL", knownVersion, refuseNewer, migrate })` from `@morndo/service-kit`.

- Its migrations are its own list (`apps/hub/src/adapters/memory-migrations.ts`), each with `compat`, and the file keeps
  its own schema floor. A Memory migration never blocks a hub rollback, and Memory can be reset alone.
- **Tables:**
  - `notes`: every Note field; append-only in effect. Rows are only ever updated to set `approved_*`, `invalidated_*`,
    `superseded_by`, `tier` or `last_confirmed_at` by a domain function's result.
  - `note_events`: one row per MemoryEvent, Memory's own record.
  - `notes_fts`: an FTS5 index over title, summary and body.
  - `memory_settings`: the next note number, and per node the last version synced.
- No other context reads these tables. The hub's other services do not import the memory store.

## Agent door

Under `/api/agent/memory/`, authenticated like the board: a bearer agent token and the `x-morndo-lane` header,
`AgentAccess.authenticate`. Memory routes work whether the board is on or off. The manager's token acts as the manager,
a worker's as the lane it names.

| Route | Does |
|---|---|
| `GET /api/agent/memory/search?q=&scope=&kind=&limit=` | Deliverable Notes (M4, M5) matching `q` (FTS5), newest-confirmed first within rank; `limit` 1-50, default 10. `q` empty: the scope's index order. |
| `GET /api/agent/memory/notes/:id` | The Note if deliverable, or if the caller wrote it. Otherwise 404. |
| `POST /api/agent/memory/notes` | `MemoryRememberBody`. A new Note, or with `supersedes` a successor (M2). 201 with the Note. |
| `POST /api/agent/memory/notes/:id/invalidate` | `MemoryInvalidateBody` (M2; a lane only its own). |

Refusals answer 400 (bad body or field), 403 (`not_principal`, `not_yours`), 404 (`not_found`), 409 (`invalidated`,
`already_*`, `mismatch`), with `{ error: <problem> }`. The rate buckets are the agent door's.

## Console (on the control plane)

`morndo memory <list|show|approve|invalidate|import|sync> ...` opens `memory.db` directly, like the other console
commands open the hub's database.

- `approve` acts as `{kind: "principal", via: "console"}`.
- `import --dir D --scope S [--procedure FILE]...` loads an agent's own markdown notes (frontmatter `name`,
  `description`) as `{kind: "import", label}`. That makes them tier 3: facts by default, procedures only as named, and a
  procedure still waits for `approve`.
- `sync` pushes now. Otherwise the hub's loop does.

## Sync

The hub renders `renderBundle(all notes, now)`.

- The version is the first 32 hex characters of a sha256 over every file's name and content, in order.
- The files go out in parts of at most `LIMITS.memoryPartBytes`, each as `memory.sync { version, part, parts, files }`.
  The key is `hub:memory:<version>:<part>`, sent to every online node.
- A node whose policy denies the op is skipped and tried again an hour later.
- The loop runs every 60 seconds and sends only when the version differs from the node's last synced one. It sends to
  a node again when it comes back online, and to every node every 30 minutes.

## The node's `memory.sync`

The node keeps Memory's skills under `~/.local/share/morndo-node/memory/`.

1. Stage each part under `staging/<version>/`.
2. When every part of a version is present, write each skill to the managed folder `skills/<name>/SKILL.md`.
3. Copy each skill into every folder in the policy's `memory.skillDirs` (default `["~/.claude/skills",
   "~/.agents/skills"]`) as `<dir>/<name>/SKILL.md`, with a marker file `.morndo-memory` holding the version.
4. Remove every `morndo-mem-*` folder in those directories that carries the marker and is not in the set.
5. Answer `committed: true` with the counts.

Safety rules:
- A folder of the same name without the marker is someone else's: it is left untouched and reported in `conflicts`.
- Names are checked against `MEMORY_SKILL_NAME`.
- Nothing follows a symlink out of a skill folder.
- A node only syncs if its policy allows `memory.sync`. Every node with an explicit op list opts in by adding it.

## The lanes' CLI

`morndo-memory` (in `apps/memory-cli`, like `morndo-board`):

```
morndo-memory search <words> [--scope S] [--kind fact|procedure] [--limit N] [--json]
morndo-memory show <id> [--json]
morndo-memory remember --kind fact|procedure --title T (--body TEXT | --body -) [--summary S] [--scope S]
                        [--untrusted] [--ref R] [--supersedes N-x] [--json]
morndo-memory invalidate <id> --reason R
```

- **Environment:** `MORNDO_HUB`, `MORNDO_AGENT_TOKEN` (or the token file the wrapper reads), and `MORNDO_LANE` (else the
  tmux window).
- **Defaults:** the scope is `repo:<basename of the git toplevel>` of the working directory. The node is `MORNDO_NODE`,
  else the host name's slug.
- **Exit codes:** 0 done, 1 refused (one plain line), 2 usage, 3 hub unreachable.

## Acceptance (slice 1)

1. A note planted through the CLI on one node reaches a fresh lane on another node, on Claude Code and on Codex. The lane
   finds it through its skills, without being told where.
2. The re-run of a known quick task uses the stored procedure instead of rediscovering it.
3. Notes written from two nodes form one memory that every node receives.
4. An untrusted or unapproved Procedure reaches no node and no search until the principal approves it.
5. An invalidated Note disappears from every node's skills at the next sync.
