# ADR-0019: Releases and updates: signed, versioned installs that a separate updater applies at a safe point and rolls back on a failed health check

- **Status:** Proposed, 2026-10-11. Design: [`docs/design/updates/README.md`](../design/updates/README.md). A fresh-context review of the first draft is folded in (the design's v1 review note). Design only; no product code.
- **The request:** make updating easy when a release ships, and let Morndo update itself by default, the way Claude Code's CLI installs an update on its own so that the next start runs the new version. Ship it only with careful QA, strict DDD, and proof that each choice follows current best practice.
- **Number:** 0019 is the next free number on `main` and on every branch of the repository (checked 2026-10-11).
- **Builds on:** ADR-0005 (stack), ADR-0008 (numbered migrations, the protocol package, send states), ADR-0012 (roles, version skew, exit 78), ADR-0013 (a CLI as the only way in, behind an adapter), ADR-0017 (systemd user units, transient units, what dies with a unit).
- **Sources:** [U1]–[U25] in the design, section 17, all checked 2026-10-11.

## Context

1. **There is nothing to update yet.** Every package is `0.0.0`, there are no releases, and Morndo runs from a checkout (`npm ci`, `npm run build`, TypeScript run directly by Node `>=24.12`). Install by role is the fleet's sub-project 3. The layout an updater needs has to be fixed together with the install.
2. **Morndo is services, not a CLI.** The hub, the fleet service and the node agent carry the principal's line to every lane. A failed Claude Code update costs one restart. A failed Morndo update could cut the principal off from all of them.
3. **Swapping the program back is not a rollback.** Four SQLite databases migrate forward only. A database from a newer service is refused (exit 78 in every service and in the connections helper). Fleet migration 7 rebuilds two tables, so an older fleet couldn't read the result even if it were allowed to try. Console commands revoke devices, agent tokens and nodes by writing the databases directly, so restoring a database could undo a revocation.
4. **The fleet already allows skew.** The agent channel and the client API accept the current and the previous version, and the agent's `hello` carries its version and Claude Code's (ADR-0012 §10).
5. **Two hazards for any restart of the agent.** On a fresh machine the agent starts the tmux server itself (`lane-ops.ts`, `new-session -d`), so every lane lives in the agent unit's control group, which systemd kills on stop by default [U18]. Jobs under the child supervisor die with that unit too (ADR-0017).
6. **What Claude Code does** [U1, U2]:
   - a launcher symlink into a `versions/` directory;
   - checks at startup and periodically, a background download, and the new version on the next start;
   - `latest` and `stable` channels (about a week old, skipping regressions);
   - a `minimumVersion` so that a channel switch never downgrades;
   - `DISABLE_AUTOUPDATER` for the background check only, `DISABLE_UPDATES` for every path;
   - a GPG-signed `manifest.json` of SHA-256 digests.

   Its install script, as read on 2026-10-11, checks digests against the manifest but not the manifest's signature (our reading of the script; not documented).

## Decision

1. **A bounded context, Releases.**
   - The language (Version, Release, Channel, Feed, Manifest, Artifact, Signature, Key set, Installation, Update, Rollout, Safe point, Probation, Health check, Migration plan, Schema floor, Backup, Withdrawn), invariants RL1–RL14, and three aggregates: Installation (per machine), Update (per attempt), Rollout (per version, on the control plane).
   - `packages/domain/src/releases.ts` is pure. `apps/updater` holds the services, ports and adapters.
   - The ports: `ReleaseFeed`, `ArtifactStore`, `Verifier`, `Installer`, `ServiceManager`, `RoleProbe`, `SchemaInspector`, `Backup`, `FleetView`, `UpdateStore`, `Clock`, `AlertSink`.
   - An architecture test bars `apps/updater` from importing the tmux code (`@morndo/node-ops`), so "Morndo updates only itself" (RL13) holds by construction.
2. **Five rules that are not choices.**
   - **Never install an unverified artifact** (RL1): Key set, Feed, Manifest, size and digest, then the signed file list. All before anything is unpacked into the install, and no flag skips a check.
   - **Never downgrade unless asked** (RL2): only a command naming the version, or `--rollback`. Nothing in a feed moves a machine down.
   - **Back up before a migration** (RL5), and restore whenever the old version can't read the result (RL8).
   - **Apply only at a safe point** (RL6): nothing in flight in any service (then a drain and a second check), and, for an automatic update of the hub's machine, the principal not attending.
   - **Roll back automatically when a health check fails** (RL7): 90 seconds to be healthy, 60 more to stay up, judged from outside against the checks that passed before.
3. **One archive per platform, with Node inside** (Q5): `linux-x64`, `linux-arm64`, `darwin-arm64`. CI verifies the Node release against Node's signed `SHASUMS256.txt.asc`, then builds the native module for that platform and that Node.
4. **Versioned, read-only install directories.** They live under `~/.local/share/morndo-releases/`, with `current` and `previous` links replaced only by `rename(2)`, which is atomic [U16]. Launchers resolve `current` once, at start. Data directories and key files stay where they are and are never touched.
5. **A separate updater, never a child of what it stops.**
   - Its own units: a timer at boot and every 6 hours, a boot unit ordered before the services, a recovery unit, and one apply unit per update. On macOS, launchd agents.
   - It checks and stages at any time. It applies at a safe point, or at the next boot, which is "the next start" for a service.
   - The apply holds an exclusive lock for its whole life, and every step is recorded before it runs (RL4). After a crash or a power loss, recovery takes the lock and runs from `good`, the last version that passed its health checks on that machine. This is the shape of systemd's automatic boot assessment [U18].
   - A boot-time apply happens only on a machine that is its own control plane. A node waits until its agent has connected and knows what its control plane runs.
   - Nothing outside the install names a version's own path: the keys helper is the stable launcher.
6. **Schema floors.**
   - Each migration is `additive` or `breaking`. A database's floor is its highest breaking migration.
   - An older version opens a newer database whose floor it knows, and refuses one it doesn't (exit 78, as today).
   - Every database that will migrate is backed up first with SQLite's online backup API [U20]. A Backup is restored only when the floor requires it.
   - While a rollback could still restore, every write it would drop is held: refused with a 503 that the web app's outbox retries (RL9).
   - The hub's database gets a store id, as a node's has, so a restored hub answers a Command stamped with the old store as `uncertain` instead of typing it again. No clock decides it (RL10).
   - Revocations of devices, agent tokens and nodes also go to an append-only journal that each service applies at start, so a restore can't bring a revoked one back (RL10).
   - The connections store, which has no service to stop, takes additive migrations only.
7. **The fleet: the control plane first, then the nodes.**
   - A node never runs a version newer than its control plane, the rule Kubernetes uses for kubelets and the API server [U21]. Nodes follow after a 30-minute soak, with jitter.
   - A protocol change takes two releases, and the control plane defers the second until every joined node speaks the new protocol (RL11).
   - One machine's rollback halts the rollout everywhere (RL12).
   - "Update now" from the app is a principal Command with step-up, carried to a node as the typed operation `update.apply { version }`, which a node's policy may deny.
8. **One command, automatic by default, with an opt-out.**
   - `morndo update`, with `--check`, `--now`, `--to`, `--rollback`, `--channel`, `--status` and `pin`. `morndo doctor` re-verifies the installed tree.
   - The modes: `apply` (Q1), `stage`, `off`.
   - The channels: `stable` (Q2) and `latest`.
   - `MORNDO_DISABLE_AUTOUPDATE` and `MORNDO_DISABLE_UPDATES` mirror Claude Code's two switches. An install the updater didn't make is never changed by it.
   - Notices on Home, failures as fleet Alerts, no push, and Settings → Updates per machine.
9. **A release pipeline from one tag.**
   - SemVer 2.0.0, one version for the product, 0.x first [U4].
   - Release Please in manifest mode makes the Release PR from Conventional Commits and creates a draft release with its tag (`draft`, `force-tag-creation`) [U5]. The build, sign and publish jobs run in the same workflow, since a tag pushed with `GITHUB_TOKEN` starts no new run [U9].
   - Signing happens in the `release` environment, whose secret no job sees until the owner approves it [U10].
   - Build provenance through `actions/attest` (SLSA Build Level 2) [U7]. Immutable releases [U8].
   - Then the `latest` feed is updated; `stable` follows after 7 days on `latest`. Withdrawal is possible; a forced install or downgrade is not.
10. **Trust in the TUF shape, sized for one maintainer** [U3].
    - SSH signatures (Ed25519) under a namespace per role [U13]:
      - **root**, offline: signs the Key set (1-year expiry);
      - **release**, gated by the owner's approval: signs each Manifest;
      - **feed**, online: signs the channel Feeds, 14-day expiry, re-signed weekly.
    - Every install goes through a Feed entry, so a stolen release key alone installs nothing. Both signing environments accept jobs only from `main` and release tags [U10].
    - Version numbers that never go down stop rollback attacks; expiry exposes freezes; digest chains stop mix-and-match; download caps stop endless data.
    - The updater checks signatures with `node:crypto` alone. The first install is checked with `ssh-keygen -Y verify`, which ships with OpenSSH, before anything runs: no `curl | sh`.
11. **Order:**
    - PR 0: tmux outside the agent's unit, graceful stop, one version, health endpoints.
    - PR 1: domain and protocol. PR 2: schema floors. PR 3: the pipeline.
    - PR 4: check and stage. PR 5: apply on one machine. PR 6: the fleet and the web app.
    - PR 7: defaults and the first release, which the owner publishes.

    Each PR has its done check in the design, section 15.

## Options considered

| Question | Option | Trade-off | Verdict |
|---|---|---|---|
| What ships | **Archive per platform with Node inside** | Morndo chooses its runtime, and the native module always matches it; about 27–32 MB more per platform [U15]; Node security releases become Morndo patch releases | Chosen (Q5) |
| | npm global package, with provenance and trusted publishing [U14] | Familiar, and provenance is free. But it needs the user's Node and npm, an in-place upgrade deletes the running version (Claude Code's docs warn about the same [U1]), and there is no atomic swap or rollback | Not in v1 |
| | Node single executable | One file, but the native SQLite module complicates it, and Node's `node:sqlite` is still a release candidate [U15] | Later, if `node:sqlite` becomes stable |
| | OS packages (apt, Homebrew) first | Each manager updates on its own schedule; Claude Code's Homebrew installs don't auto-update [U1] | Later, as an install the updater only reports on |
| Who updates | **A separate updater with its own units and a step record** | Can stop and start every service, survives their failure, recovers after a power loss | Chosen |
| | Each service updates itself | A process can't judge its own failed start or roll itself back | Rejected |
| | Manual only (`git pull`, or the package manager) | Simple, but no automatic updates, which the request asks for | Kept for checkout installs (RL14) |
| How it switches | **Versioned directories and a `current` link, replaced by `rename(2)`** | Atomic [U16]; the old version stays for rollback; the shape Capistrano and Claude Code use [U1, U17] | Chosen |
| | Overwrite in place | A crash leaves a mix of two versions, and there is nothing to go back to | Rejected |
| Signatures | **SSH signatures (Ed25519) with namespaces** | Verifiable with `ssh-keygen` already on Linux and macOS; a namespace per role stops cross-use [U13]; a short parser and `node:crypto` in the updater, no dependency | Chosen |
| | minisign | A clean format with a signed comment [U12], but users and `install.sh` need it installed first | Rejected for v1 |
| | Sigstore keyless (cosign) as the updater's check | No long-lived key, but `cosign` or `sigstore-js` on every machine, and by default network access to Sigstore's TUF root [U11]; it signs whatever the workflow built | As provenance next to the signatures (attestations), not the updater's gate |
| | GPG, as Claude Code does [U1] | Often absent on macOS; heavier format and tooling | Rejected |
| | Checksums over TLS only | Trusts the host and every account behind it | Rejected |
| Update metadata | **TUF-shaped: Key set, Manifest, Feed, with version numbers and expiry** | Covers rollback, freeze, mix-and-match and endless data [U3] with three small files; one key per role | Chosen |
| | Full TUF through `tuf-js` [U24] | Thresholds and delegations, at the cost of a dependency tree, metadata tools for each release, and a first install that the machine's own tools can't check | When a second maintainer or a mirror network arrives |
| | GitHub's "latest release" | One stream, no channels, no freshness, 60 API calls an hour without a token [U9] | Only for finding `install.sh` |
| Feed host | **GitHub Pages of the public repository** | Free, TLS from GitHub, no new account | Default (Q4) |
| | A domain of the project's own | Movable later; signatures, not the address, decide trust | Later (Q4) |
| | Assets of a fixed release | Immutable releases forbid changing assets [U8] | Rejected |
| Release tooling | **Release Please** | Release PRs from the Conventional Commits this repo already writes; one version; draft releases with a tag [U5] | Chosen |
| | Changesets | A file per change from contributors; aimed at publishing npm packages [U6] | Rejected |
| Rollback | **Health-gated, automatic, with schema floors and Backups** | The old version keeps the data when floors allow; a restore only when needed, and guarded | Chosen |
| | Down migrations | Twice the migration code, rarely exercised, and a failure in one leaves no way out | Rejected |
| | Always restore a Backup | Drops everything written since, even when the old version could read it | Rejected |
| | Fix forward only | No automatic way back from a broken start | Rejected; fix-forward stays the answer for a bad release already committed |
| Fleet order | **Control plane first, nodes after a soak** | The test matrix stays at "node equal to or one behind"; the Kubernetes rule [U21] | Chosen |
| | A node first, as a canary | A node ahead of its control plane widens the matrix | Rejected; the control plane's own node is the first node |
| | All at once | One bad release reaches every machine | Rejected |

## Consequences

- **Good:** updating is one command, or nothing at all. A failed update returns the machine to the version that worked and says why. A bad release stops at the first machine that fails. Every artifact can be checked by anyone, with `ssh-keygen` and `gh attestation verify`.
- **Good:** the precondition work (PR 0) fixes a hazard that exists today without any updater: restarting the agent on a fresh machine would end every lane.
- **Cost:** a new app, `apps/updater`. A floor declaration on every migration from now on. One protocol addition per direction: the control plane's version and rollout state in `welcome`, and the node's update state in `health`. Health endpoints in the hub and the fleet, a hold every service obeys, a store id for the hub's database, and revocation journals. A weekly workflow, and an owner approval for every release.
- **Cost:** the owner keeps an offline root key and signs a new Key set at least once a year. A Key set left to expire stops updates everywhere, with an Alert, 30 days ahead.
- **Limit:** one maintainer means one key per role; a stolen root key is a full compromise. Any process of the user can change the installed tree; `morndo doctor` detects it and nothing prevents it (ADR-0012's threat model). macOS has no boot ordering, so a staged version applies after login.
- **Risk:** a rollback after commit that needs a restore drops the writes since the Backup. It is named and confirmed, and avoided whenever floors allow.

## Verification this implies

1. Domain tests: Version precedence from the SemVer specification, one negative-control history per invariant (RL1–RL14), the Update state machine, the recovery table and the skew table.
2. Contract tests: the SSH signature check against real `ssh-keygen` output; the `rename(2)` swap under concurrent readers; Backups and restores with a stale write-ahead log; schema floors on all four databases; the previous release against a database migrated by the current one.
3. End to end on a throwaway machine: install A, update to B, roll back, then a breaking C with a planted health failure that rolls back with a restore. Lanes keep their processes and no Command is typed twice.
4. Fault injection: a bad signature, a truncated download, a wrong digest, an expired or older feed, a crafted archive, a failed migration, a failed health check, a kill at every recorded mark, recovery started during a live apply, a full disk, revocations across a restore, and a VM hard reset during the swap.
5. Manual QA on Linux x64, Linux arm64 and macOS, recorded in the private QA notes, before the first release.
6. Re-check triggers: Claude Code changes its update model; GitHub changes attestations, immutable releases or environments; OpenSSH changes `-Y`; `node:sqlite` becomes stable; TUF publishes a new major version.
