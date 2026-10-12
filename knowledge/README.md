# Knowledge

What Morndo's orchestrator and lanes read to plan work: agent loop patterns as skills. Design: [`docs/design/capability-knowledge/README.md`](../docs/design/capability-knowledge/README.md), [ADR-0026](../docs/adr/0026-capability-knowledge.md).

## Skills

Each folder under `skills/` is an [Agent Skill](https://agentskills.io/specification): a `SKILL.md` with `name` and `description` in its front matter, then instructions an agent loads when a task matches.

| Skill | The loop |
|---|---|
| `loop-one-shot` | One run, one output, one check fixed before the run. |
| `loop-plan-execute-verify` | Steps and checks written first, one step at a time, the end state verified. |
| `loop-review-fix` | A reviewer of another model family, fixes, a round limit, then a person. |
| `loop-scheduled` | A run on a timer, bounded, with rules that skip, stop or pause. |
| `loop-fan-out-merge` | Independent parts in parallel, merged and counted. |
| `loop-human-gate` | The principal's answer before anything outward or irreversible. |

Each says when to use the loop, when not, how it fails, the guards that catch each failure with the Morndo rule that enforces it ([`docs/domain.md`](../docs/domain.md)), and its sources with the date they were read. Past its `morndo-recheck` date a skill is stale: the test warns and still passes.

## Install

Agents look for skills in their own folders, not in this repository. Link each skill folder into your user skill folder, from the repository root:

```sh
# Claude Code: ~/.claude/skills/<name>/SKILL.md
mkdir -p ~/.claude/skills
for d in knowledge/skills/*/; do ln -sfn "$PWD/$d" ~/.claude/skills/"$(basename "$d")"; done

# Other clients that read the cross-client folder: ~/.agents/skills/<name>/SKILL.md
mkdir -p ~/.agents/skills
for d in knowledge/skills/*/; do ln -sfn "$PWD/$d" ~/.agents/skills/"$(basename "$d")"; done
```

The `loop-` prefix keeps these from colliding with skills of your own, such as a personal `review-fix`.

## Check

`npm test -- knowledge` runs `knowledge/skills.test.ts`: every skill against the specification's rules, the sections each pattern must have, and dated sources.

The specification's reference validator gives a second opinion. Its PyPI package `skills-ref` (0.1.1, checked 2026-10-12) installs the command as `agentskills`:

```sh
pip install skills-ref==0.1.1
for d in knowledge/skills/*/; do agentskills validate "$d"; done
```
