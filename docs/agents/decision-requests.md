# How to write a decision request

**Status:** the format for [ADR-0023](../adr/0023-decision-briefs.md). File one with `morndo-decide`.

A decision request asks the principal for one decision, with the case for it. The principal reads a three-line card
first and opens the full brief only to decide, so the brief has to stand on its own: someone who has not followed
the work reads it once and can say yes or no.

File one when the decision is the principal's: spending money, anything public or outside the team, an irreversible
step, a product or taste call. Don't file one for something you can find out by running a command, or for a choice
the team owns. Those you decide and record.

## The rules, in plain words

The hub refuses a request that breaks one of these, and says which, one line per problem.

1. **Two to six options.** Each has a key (`a`, `b`, `keep`, letters, digits, `-` and `_`, up to 16) and a label of
   at most 40 characters. "Do nothing" counts as an option when it is a real choice.
2. **One recommendation, named in the headline.** `recommend: b` in the front matter, and the headline says
   "option B". The headline names no other option.
3. **A due date,** after now, and **the minutes** it takes to read and decide (1 to 30).
4. **A table with a column for every option,** in the same order and with the same labels as the Decision list, and
   three to ten factor rows. No empty cells: write "n/a" or "none" when that is the answer. Under the table, a
   `Note:` says what the numbers include.
5. **Money needs its assumptions.** If any amount of money appears anywhere, list at least one assumption behind it.
   Every request states a downside case.
6. **Every section of the template,** in its order, under its exact heading. A heading the template doesn't have is
   refused, so a typo never hides a section.
7. **Plain markdown in the sections:** paragraphs, lists, bold, italic, code, tables, and `https:` links. No headings
   of your own, no HTML, no images.

The hub also warns, without refusing, when there is no evidence, when the ask has no number in bold, when "Why now"
names no date, when "What would change the recommendation" has no number or date in it, or when the text takes
longer to read than your minutes say.

How to write well within the rules:

- **The headline is the answer you want,** as a sentence the principal could approve: a verb, the option, what it
  does.
- **The ask carries the numbers.** Spend, effort, time to benefit, estimated benefit, in bold. Say which numbers are
  estimates.
- **Why now is facts and the date that forces it,** not urgency words.
- **What would change the recommendation is a condition someone can check:** a number crossing a line, an event on
  a date.
- **Approval authorizes is a limit you commit to:** what you will spend and do, what needs a fresh approval, and
  when you report back. Morndo records the answer; it does not enforce these limits for you.
- **One line where one line will do.** The principal reads every word.

## The template

`morndo-decide template` prints it.

```markdown
---
topic: <the subject, a few words>
due: <YYYY-MM-DD, or a time with its offset>
minutes: <minutes to read and decide, 1 to 30>
recommend: <the key of the option you recommend>
blocking: <true or false; optional>
project: <optional>
task: <a board task such as T-12; optional>
ref: <your own id for this ask; optional>
---

# <Verb> option <KEY>: <what it does>

## The ask
<What you ask for, with the key numbers in bold.>

Alternative: <the next best option, in one line>
Main uncertainty: <the one thing most likely to be wrong, in one line>

## Why now
<Facts, and the date that forces the decision.>

## Options compared
| Factor | A · <label> | B · <label> |
|---|---|---|
| Expected outcome | | |
| Year-one cost | | |
| Ongoing cost | | |
| Internal effort | | |
| Time to benefit | | |
| Measured benefit | | |
| Principal drawback | | |

Note: <what the numbers include and leave out>

## Why the recommendation
<Why this option over the others.>

Assumptions:
- <each assumption behind a number, above all behind money>

Downside case: <what happens if the assumptions are wrong>

## What would change the recommendation
<The concrete condition.>

## Main risk and control
Risk: <the main risk>
Control: <how it is caught or limited>

## What approval authorizes
Limits:
- <what you may spend and do>

Needs fresh approval: <what goes beyond those limits>
Review point: <when and on what you report back>

## If no decision by the due date
<Optional: what happens then.>

## Decision
- [a] <label>
- [b] <label>

## Evidence
- [<label>](https://…)
```

## An example

Made up: the team, the numbers and the links are invented.

```markdown
---
topic: Support inbox triage
due: 2026-10-14
minutes: 4
recommend: b
project: support
---

# Approve option B: extend the in-house triage script

## The ask
Approve **$2,400** of contractor time and **6 agent-days** to extend the in-house triage script so it tags and routes
new tickets. It starts paying back in about **3 weeks** and saves an estimated **5 staff hours a week**.

Alternative: buy the hosted add-on (C) for **$180 a month**; it starts faster and costs more from month 14.
Main uncertainty: the saving comes from a two-week sample of 310 tickets.

## Why now
- Tickets waiting more than a day rose from 9 to 23 a week over the last month.
- The contractor who wrote the script has a free slot from 2026-10-20 to 2026-11-07; the next one is in January.
- A decision by 2026-10-14 keeps that slot.

## Options compared
| Factor | A · Keep manual triage | B · Extend the triage script | C · Buy a hosted add-on |
|---|---|---|---|
| Expected outcome | The backlog keeps growing at today's rate | Most tickets tagged and routed on arrival | As B, plus a reporting view |
| Year-one cost | $0 | $2,400 | $2,160 |
| Ongoing cost | 5 staff hours a week | About 1 agent-day a quarter | $180 a month |
| Internal effort | none | 6 agent-days | 2 agent-days to set up |
| Time to benefit | none | 3 weeks | 1 week |
| Measured benefit | none (the baseline) | Estimated 5 h a week, from the sample | Estimated 4 h a week, from a vendor trial |
| Principal drawback | Waiting times keep rising | We maintain the script | Ticket text leaves our systems |

Note: costs are cash only, without tax. Agent-days and staff hours are not priced.

## Why the recommendation
B gets most of C's benefit, keeps ticket text in our own systems, and costs less than C from month 14. A is right
only if the backlog shrinks by itself, and nothing in the last month points to that.

Assumptions:
- The contractor's quote of $2,400 is a fixed price (the quote is linked below).
- The saving seen in the two-week sample holds for every ticket type.

Downside case: if the saving is only 2 hours a week, B still beats A, but C's reporting view would have been worth
more; we would switch to C at the review point, having spent the $2,400.

## What would change the recommendation
If the script tags fewer than 60% of tickets correctly in its first week, stop B and choose C.

## Main risk and control
Risk: the script routes an urgent ticket to the wrong queue.
Control: for the first two weeks a person checks every ticket tagged urgent before it is routed, and the error rate
is posted daily.

## What approval authorizes
Limits:
- Up to $2,400 with the contractor, at a fixed price.
- Up to 6 agent-days on the script and its tests.

Needs fresh approval: any spend above $2,400, a new vendor, or sending ticket text outside our systems.
Review point: 2026-11-07, on tagging accuracy and hours saved, against the 60% line above.

## If no decision by the due date
The contractor's slot lapses. We keep manual triage (A) and ask again in January.

## Decision
- [a] Keep manual triage
- [b] Extend the triage script
- [c] Buy a hosted add-on

## Evidence
- [Two-week triage sample](https://example.com/triage-sample)
- [Contractor quote](https://example.com/contractor-quote)
- [Hosted add-on trial notes](https://example.com/addon-trial)
```

The principal's card for it reads:

```
SUPPORT INBOX TRIAGE                         Due Tue 14 Oct
Approve option B: extend the in-house triage script
Manager · ≈4 min · Includes spend
★ Recommended: Extend the triage script      [Read and decide]
```

## Filing and after

```sh
morndo-decide lint brief.md        # what the hub would refuse, and the warnings; files nothing
morndo-decide new brief.md         # files it; prints its id, such as d-12
morndo-decide show d-12            # where it stands, and the answer once given
```

- **The answer comes to you** as a line in your conversation: `[tap d-12] b (Extend the triage script)` for an
  option, or `About d-12: …` when the principal answered in words. Act on it, then `morndo-decide settle d-12`.
- **The facts changed?** `morndo-decide restate d-12 brief.md`. An answer given to the old version is refused, so
  the principal never approves something you no longer propose.
- **The question went away?** `morndo-decide withdraw d-12 --why "…"`.
- **A lane's request is a draft** for the manager, who forwards it (`forward`) or turns it down (`decline --why`),
  as with board proposals. Whether lanes may file to the principal directly is the owner's call (ADR-0023).
- **Never put a secret in a request.** It is shown on the principal's devices and kept in the hub's record.

## The instruction blocks

`morndo-decide prompt --role manager` and `--role worker` print these. A lane's prompt carries the one for its role.

<!-- prompt:manager -->
## Decision briefs

You ask the principal for a decision with `morndo-decide`. One brief, his format, every time. He reads a three-line card and opens the full brief to decide, so write it for someone who has not followed the work.

- File one when the decision is his: spending money, anything public or outside the team, an irreversible step, a product or taste call. Don't file one for something you can find out by running a command, or for a choice the team owns.
- Start from the blank: `morndo-decide template`. Check it before you file: `morndo-decide lint brief.md`. A refusal is one line per problem; fix those and lint again. Warnings do not refuse.
- File it: `morndo-decide new brief.md`. It prints an id, such as `d-12`. `morndo-decide show d-12` says where it stands.
- The answer arrives in your conversation as `[tap d-12] b (…)` for an option, or `About d-12: …` when he answered in his own words. Act on it, then `morndo-decide settle d-12`.
- The facts changed: `morndo-decide restate d-12 brief.md`. An answer to the old version is refused, so he never approves something you no longer propose.
- The question went away: `morndo-decide withdraw d-12 --why "…"`.
- A lane's brief is a draft. Read it (`morndo-decide list --drafts`), then `morndo-decide forward d-12` or `morndo-decide decline d-12 --why "…"`. Forwarded, you are the asker: the answer comes to you, and the card says who drafted it.
- Never put a secret in a brief. It is shown on the principal's devices and kept in the hub's record.
<!-- /prompt:manager -->

<!-- prompt:worker -->
## Decision briefs

When a decision is the principal's, write a brief and hand it to the manager. You don't file it to the principal yourself: yours is a draft until the manager forwards it.

- Start from the blank: `morndo-decide template`. Check it: `morndo-decide lint brief.md`. A refusal is one line per problem. Fix those before you file.
- File the draft: `morndo-decide new brief.md`. Tell the manager the id. `morndo-decide list` shows your drafts.
- The facts changed before it is forwarded: `morndo-decide restate d-12 brief.md`.
- The question went away: `morndo-decide withdraw d-12 --why "…"`.
- Don't ask the principal in your own words instead. The manager forwards the brief, and the answer comes back through him.
- Never put a secret in a brief.
<!-- /prompt:worker -->
