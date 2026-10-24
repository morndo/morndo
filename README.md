# Morndo

**By morning, it's done.**

Morndo is an open-source, self-hosted control plane for one person who runs many AI coding agents. You give the direction. The agents do the work. Morndo holds the loop back to you: every decision reaches you once, is answered once, and is remembered. Proof of "done" comes from a check the agent didn't run itself.

The agents stay what they are: Claude Code, Codex and others, run unmodified in tmux. Morndo doesn't replace them. It serves you.

## Why I built this

I run a lot of coding agents at once, on more than one machine. Four things kept happening.

1. **An agent asked me the same thing twice.** I had already decided. It came back as a fresh question, sometimes on two devices.
2. **A question waited for hours.** An agent blocked on me at 23:10. I found out at 08:30, sitting back at the desk.
3. **"Done" that wasn't done.** The agent said it passed. I trusted it. It hadn't.
4. **The box died with everything on it.** The machine running every agent ran out of memory, and I lost sight of all of them at the same time.

I tried what exists. OpenClaw was easy to set up, but the quality of the output wasn't there, and it isn't how I work. Remote Control in the Claude and Codex apps gives you the strong frontier models, but every session is its own screen on the phone. With ten sessions open, managing them was exhausting.

That was the real problem. In those tools I felt like the developer, trying to keep an overview across everything. I wanted to be the chief of staff. I give the direction, my workers implement it, and I only get pulled in when a decision is mine to make.

Nothing I found was built for that person. Every tool I looked at serves the agent: more tools, more autonomy, a better harness. None serves the one human who holds merge, deploy and spend, and whose attention is the scarce resource. So I built the small thing that does.

## What Morndo does

Three things, and only three.

- **Authority: consent you gave, decided once.** An irreversible action (a protected merge, a deploy, a push to shared history, a deletion) needs a mandate you gave, from a device proven to be yours, with provenance. Once given, it is not asked again. Silence, timeouts and defaults grant nothing.
- **Escalation: delivery you acknowledged, exactly once.** A question, a report or an alert is one item with one answer. It stays open until you answer it. Re-delivered, it is still one item. Nothing counts as seen because a transport said "ok".
- **Verification: proof the worker didn't produce.** A claim of "done" is judged by checks fixed before the work started and run by someone other than the claimant. A missing check is "unverified", never shown as success.

The team looks like this: one manager you talk to, and workers you can watch. The manager is your direct message. Each worker is a channel. You read the channels when you want to, and the badge tells you when something is actually yours to decide. A board, like a real team's, says who is working on what: the manager files tasks and hands them out, each lane moves its own along, and nothing is done until someone other than the lane says so. A phone view catches you up: open decisions first, then what happened while you were away, each one a card you answer, keep or mark read, with a few seconds to undo.

Several machines can host agents. A small control plane holds the overview, and each machine dials in with its own key. If one machine goes down, you see its agents as offline, not gone, and the rest keep working.

## The name

I go to sleep. The agents work. By morning, it's done. Morning plus done: Morndo.

## Why it looks like Slack

I'm a software engineer at a startup, and we live in Slack all day. When I thought about how to talk to a team of agents, the answer was already in my hands. I could have used Slack itself as the channel, but then the overview would be missing: who is working, who is idle, who needs me, all in one place. So Morndo borrows the shape I already know, with its own brand, and adds what a team of agents needs. The UI may still change. For now I wanted something familiar.

## Status

Today the desktop, the phone catch-up, decisions with passkeys, push and the multi-machine fleet work on my own setup. Releases are verified before anything is installed (signed files, and an updater that checks them), but none is published yet; verifying an agent's work, the proof the worker didn't produce, is designed and written down, but not built yet. This is one person's project, a few weeks old, and it is not installable by anyone else yet: from source today; from the first release by the commands in Install and update.

## Run locally

Needs Node 24 (`.nvmrc`) and tmux. From this checkout:

```sh
npm ci
npm run build
MORNDO_ORIGIN=http://localhost:8790 node apps/hub/src/main.ts serve
```

Open `http://localhost:8790`. `MORNDO_ORIGIN` must be the exact origin the browser uses; http is allowed for localhost. Pair a browser with `node apps/hub/src/main.ts pair`. These commands are the start. There is no screenshot guide. A setup command by role (control plane, node) is not written yet. Until then, each service's README says how it runs: [`apps/hub`](apps/hub/README.md), [`apps/fleet`](apps/fleet/README.md), [`apps/node-agent`](apps/node-agent/README.md).

## Install and update

The first release is not published yet, so until it is the release URLs below answer 404; this section describes the install a release will have.

### Install, verifying first

Save the release key, download `install.sh` and its signature, and check the signature before the script runs.

```sh
curl -fsSLO https://github.com/morndo/morndo/releases/latest/download/install.sh
curl -fsSLO https://github.com/morndo/morndo/releases/latest/download/install.sh.sig
echo 'release@morndo.github.io namespaces="release@morndo.github.io" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILGOA2QkwWhAgWf3mM3sUCqH38i9HiFRe84R7qadRdh7' > morndo.allowed_signers
ssh-keygen -Y verify -f morndo.allowed_signers -I release@morndo.github.io -n release@morndo.github.io -s install.sh.sig < install.sh \
  && sh install.sh --role control-plane --signers morndo.allowed_signers
```

Use `--role node` for a machine that only hosts agents. Use `--channel latest` for the newest channel:

```sh
sh install.sh --role node --channel latest --signers morndo.allowed_signers
```

`install.sh` installs **the Version stamped into the copy you downloaded**, not the newest one: it checks that release's Manifest and archive again, installs that Version, writes the units, and starts the services. `--channel` is stored as the machine's channel, which decides what the updater offers next; it does not choose the Version that is installed. Nothing runs before the check passes.

`https://github.com/morndo/morndo/releases/latest/download/` is GitHub's newest published release. That is the newest Version of the `latest` channel, not of `stable`, and a withdrawn Release is still there until a newer one is published (a withdrawal marks the Feed; it does not change what GitHub calls latest). To install an exact Version, download both files from `https://github.com/morndo/morndo/releases/download/v<version>/` instead.

The key line above and the one in SECURITY.md are served from the same repository, so their agreement shows that the two copies match, not that the key is genuine. `gh attestation verify install.sh --repo morndo/morndo` is the independent check, because it is GitHub's own build provenance for the file: for a machine you rely on, run it too; it is not optional.

### Update

A machine checks the feed in the background, stages a verified Version, and applies it at a safe point. The default mode is `apply`. The default channel is `stable`. A window never blocks an update you ask for with `morndo update`.

Checks the feed, shows what would change, and asks before applying.

```sh
morndo update
```

Applies without asking.

```sh
morndo update --yes
```

Checks the feed and stages only.

```sh
morndo update --check
```

Prints the channel, the mode, the pin, and the versions this machine knows.

```sh
morndo update --status
```

Prints that report as JSON.

```sh
morndo update --status --json
```

Applies without waiting for the window.

```sh
morndo update --now
```

Takes exactly that Version from the machine's own channel, and is refused when that Version is withdrawn, lower than the running one, below the highest this machine ever ran, pinned, or, on a node, above its control plane.

```sh
morndo update --to 0.2.0
```

Re-verifies the installed tree against its signed file list and reports what fails.

```sh
morndo doctor
```

### Channels

`stable` is the default and the right one for most machines. `latest` is newer. `morndo update --channel latest` switches to it. A machine never moves down: on a newer build it waits until the other channel catches up. `install.sh --channel latest` stores `latest` as the channel of a new install; the Version it installs is still the one stamped into that `install.sh`.

```sh
morndo update --channel latest
```

### Pin, mode and window

The settings file is `~/.config/morndo-update/config.json`. The commands edit it atomically.

A pin above the running Version is taken by the next check if the feed lists it, then held. A pin equal to the running Version holds. A pin below the running Version never moves a machine down. A pin the feed does not list leaves the machine where it is.

```sh
morndo update pin 0.2.0
```

```sh
morndo update unpin
```

`apply` stages and applies at a safe point. `stage` stages in the background, and applies with `morndo update` or at the next boot. `off` does no background checks.

```sh
morndo update auto apply
```

```sh
morndo update auto stage
```

```sh
morndo update auto off
```

The window is the local hours for automatic applies. None means any safe point.

```sh
morndo update window 03:30-05:00
```

```sh
morndo update window any
```

`MORNDO_DISABLE_UPDATES=1` makes every update path refuse, `morndo update` included. `MORNDO_DISABLE_AUTOUPDATE=1` stops the background only.

```sh
MORNDO_DISABLE_UPDATES=1 morndo update
```

```sh
MORNDO_DISABLE_AUTOUPDATE=1 morndo update
```

### Roll back

`morndo update --rollback` goes back to the previous Version, asks first, and asks for a typed word when a restore would drop writes. `morndo update --rollback --preview --json` is the read-only look.

```sh
morndo update --rollback
```

```sh
morndo update --rollback --preview --json
```

A rollback halts that Version for the fleet until the owner resumes it. A withdrawn Release stays in the feed, marked: machines stop being offered it, and machines already on it stay.

The design is in `docs/design/updates/README.md`, and the manual QA checklist is in `docs/design/updates/manual-qa.md`.

## What is here

| Path | What |
|---|---|
| `apps/hub` | The principal's server: the web app's API, passkeys, sends, decisions. |
| `apps/web` | The SvelteKit app: the chat-style desktop and the phone view (ADR-0006, ADR-0009). |
| `apps/fleet` | `morndo-fleet`, the fleet service: nodes dial in; the hub and other clients talk to it over a Unix socket. |
| `apps/node-agent` | `morndo-node`, the agent on each machine that hosts agents: its tmux, transcripts and files, by typed operations only. |
| `apps/board-cli` | `morndo-board`, the command the manager and the lanes keep the team's board with, and the prompt blocks that tell them how ([`docs/agents/board.md`](docs/agents/board.md), ADR-0015). |
| `apps/memory-cli` | `morndo-memory`, the command the lanes search and add to Memory with: what lanes learned, kept for every lane on every machine and handed to them as skills ([`docs/design/memory/README.md`](docs/design/memory/README.md), ADR-0031). |
| `packages/domain` | The pure domain model (no infrastructure). |
| `packages/protocol` | The schemas between the app, the hub, the fleet and the agents. |
| `packages/node-ops`, `packages/service-kit` | What runs on a node (tmux, sessions, files), and what the services share (migrations, rate limits, the local-disk check). |
| `packages/brand` | The brand kit (ADR-0007). |
| `e2e`, `test/fleet`, `scripts/negative-controls.ts` | End-to-end checks, the fleet's cross-process drills, and every negative control as data. |

One machine can hold everything (hub, fleet service, node agent), or a control plane can serve agents on several machines: the same code, by role ([fleet core design](docs/design/fleet-core/README.md), [ADR-0012](docs/adr/0012-fleet-pull-agents-and-a-separate-fleet-service.md)). Each service keeps its SQLite database on its machine's own disk.

## Documents

- [`docs/domain.md`](docs/domain.md): bounded contexts, ubiquitous language, aggregates, invariants, events and the context map.
- [`docs/agents/`](docs/agents/): what the agents' lanes need from their side: the board's prompt blocks ([`board.md`](docs/agents/board.md)) and the status line that reports each account's usage to Home ([`usage.md`](docs/agents/usage.md)).
- [`docs/adr/`](docs/adr/): architecture decisions. Start with [ADR-0001](docs/adr/0001-owner-side-core-on-top-of-existing-agent-tools.md), which explains why the core is built on top of existing agent tools instead of being another harness.
- [`docs/design/`](docs/design/): designs and their implementation plans.

## Rules for this repo

- Strict DDD: the domain layer holds no infrastructure (no terminal multiplexer, no chat API, no file system). Adapters sit at the edges.
- Every library, API and version is checked against current primary docs, cited with URL and date.
- Nothing counts as done until `npm test` and, for a flow you can click, the matching `e2e` script have been run. Manual QA notes are not published in this tree.
- Tests and QA never touch a running system: isolated tmux servers, temporary homes, random ports. A deploy has a written rollback first.

## Licence

Morndo is open core. The repository is licensed under the [AGPLv3](LICENSE.md), except for everything under a directory named `ee`, which is the Enterprise Edition and is covered by a separate [enterprise licence](ee/LICENSE.md). The `ee` directory is empty today; enterprise features for larger organisations land there, and need a commercial licence to run in production. Everything else stays free to run, change and self-host.

In detail: every file under a directory named `ee` anywhere in this repository (for example [`ee/`](ee/) at the root, or an `ee/` directory inside an app or package) is licensed under [`ee/LICENSE.md`](ee/LICENSE.md). Content outside those directories is available under the AGPLv3 in [LICENSE.md](LICENSE.md). Third-party components incorporated into Morndo are licensed under the original licence provided by the owner of each component. Copyright (c) 2026-present jacksnxly.

How to contribute is [CONTRIBUTING.md](CONTRIBUTING.md). Report a vulnerability in private, as [SECURITY.md](SECURITY.md) describes. Agents follow [AGENTS.md](AGENTS.md).

## Follow along

It's early. If you run many coding agents and recognise the four things above, star the repo and watch it. The install path is next. When it lands, come back and try it, and tell me where it broke.
