# Knowledge

What Morndo's orchestrator and lanes read to plan work: agent loop patterns and the recurring-job procedure as skills, and short notes the procedures cite. Design: [`docs/design/capability-knowledge/README.md`](../docs/design/capability-knowledge/README.md), [ADR-0026](../docs/adr/0026-capability-knowledge.md).

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
| `recurring-job` | A repeating job as an SOP: steps from the patterns, gates, stop rules, budget, report, metrics; checked by `sop-check`. |

Each says when to use the loop, when not, how it fails, the guards that catch each failure with the Morndo rule that enforces it ([`docs/domain.md`](../docs/domain.md)), and its sources with the date they were read. Past its `morndo-recheck` date a skill is stale: the test warns and still passes.

## SOPs and sop-check

`recurring-job` holds the SOP's shape (`assets/sop.schema.json`), a worked example (`assets/daily-blog-post.yaml`), the notes it cites and the user's preferences format (`references/`), and the check, `scripts/sop-check.mjs`:

```sh
npm run knowledge:sop-check -- knowledge/skills/recurring-job/assets/daily-blog-post.yaml
# daily-blog-post: passes
```

It exits 1 with one line per refusal, each naming its rule and step, and 2 on a bad call or anything unexpected, as one line. Its rules are pure, in `packages/domain/src/knowledge.ts`; the skill lists them. `--roles` names the engine layer's roles when they differ from the defaults; `--today` sets the date the notes' staleness is judged on.

`scripts/sop-check.mjs` is generated: `npm run knowledge:build` bundles `knowledge/tools/sop-check/` and the domain's rules into it, and a test fails when it differs from a fresh build. A copy of the skill runs it with Node 20 or later after `npm install` in the skill's folder, which installs the one package it leaves out (yaml, pinned in the skill's `package.json`).

## Notes

The recurring-job skill's `references/` holds the notes its SOPs cite as `notes/<id>`, so a copied skill has them: per source a link, the date read, its basis (vendor-doc, vendor-claim, measured, study) and a sentence in our own words. No quotes are stored. A note past its `recheck` date warns in the tests and in `sop-check`, and never fails either.

## Model facts

`npm run knowledge:models -- refresh` fetches models.dev's model list once (MIT licence) and writes a dated, trimmed snapshot to `~/.cache/morndo-knowledge/models-dev/`: provider, model, context, output limit, prices per million tokens and release date, with the source and the licence. `npm run knowledge:models -- show [provider[/model]]` prints the newest one, with a warning once it is older than 30 days. Nothing in this repository holds a copy, and no code that routes or gates work reads it.

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

`npm test -- knowledge` runs the tests under `knowledge/` (the notes and the command too) and `packages/domain/test/knowledge.test.ts`. `knowledge/skills.test.ts` checks every skill against the specification's rules, the sections each pattern must have, dated sources, and guards that name the skill's own failure modes and a rule docs/domain.md defines.

The specification's reference validator gives a second opinion. Its PyPI package `skills-ref` (0.1.1, checked 2026-10-12) installs the command as `agentskills`:

```sh
pip install skills-ref==0.1.1
for d in knowledge/skills/*/; do agentskills validate "$d"; done
```
