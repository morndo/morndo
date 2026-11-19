# The topic status page: guard rails for the agent that writes it

**Phase: design, 2026-11-19.** This is not code and not a template. An agent writes a topic's status page itself and
chooses how to show each part; this document sets the rules it must keep. It is written so it can become a skill
later. The reference is the Partnerships page in [`mockups/gtm-cockpit.html`](mockups/gtm-cockpit.html)
(`#topic/partnerships`). It came out of four rounds of review by a Head of GTM reading it as their morning brief: too
little at first, then too much, then this.

## What the page is for

One question, every morning: **are we going to reach the goal by the deadline, and what do I need to change today?**

The reader is the topic's owner, a manager, and whoever the topic is shared with. They manage outcomes, priorities and
exceptions; they do not read every action two interns and six agents took. Agents can produce far more than a person
should take in, so the page compresses routine work hard and keeps its evidence one click away.

**The principle: the overview holds decisions and exceptions; details hold evidence and explanations.** Nothing is
dropped, only demoted. A good page feels almost suspiciously simple while the system under it is not.

## The acceptance test

Look for five to ten seconds, then walk away knowing:

1. **Will we deliver?** Signed against target, the forecast, and whether that is enough.
2. **What changed** since the last look.
3. **Where are we stuck?**
4. **What needs me today?**

If one is missing from the first screen, the page fails. If the first screen asks to be read rather than looked at, it
fails too.

## The budget for the first screen

A design constraint, not a pixel count: about **70% visual** (the verdict, the numbers, the trajectory, deal stages,
state), **20% short labels** (what changes, what is blocked), **10% sentences**, and only where a decision needs the
context. No paragraphs on the first screen; a sentence is one line.

## What goes where

| # | Part | Answers | On the first screen | One click away |
|---|---|---|---|---|
| 1 | Verdict and three numbers | Will we deliver? | A verdict word ("Behind plan") with what it asks of the reader ("Action needed"); signed of target; likely (forecast); still unsecured. The time left and when it was read, as a small line above | - |
| 2 | Trajectory | Is it fast enough? | One chart: signed so far, the plan to the deadline, the forecast with its range, today; one line of insight | The values per day (hover), a text table |
| 3 | Deals | Where will the result come from? | One row each: name, the next step in a few words, a track of factual milestones, a confidence word | Each deal's lane; what each forecast rests on (in the recovery plan) |
| 4 | Needs you | What needs me? | The one decision as a row: what, due, why it cannot wait (a few words), the button. Then team blockers: their count and the top two | The decision's reasoning ("Why", on its lane); the other blockers |
| 5 | Funnel | Does the method work? | One strip: each step's count, this week's change, its rate against the plan, below-plan steps marked | - |
| 6 | Recovery plan (closed) | How do we close the gap? | Its title and how many steps | The steps with dates, the assumptions, the evidence per deal, what is out of the goal |
| 7 | Details and History (closed) | Everything else | Their titles and one count each | Purpose, plan stages, lanes, people and agents, jobs; the history |

A topic without a dated, measurable goal shows no parts 1, 2, 3, 5 or 6. The page says "No goal set", names what is
missing, shows what needs the owner, and offers to ask for a goal.

## Rules

### Truth and evidence

- **R1 Actuals and forecasts never share a number.** "0/3 signed · 1 likely · 2 still unsecured", never "1/3
  likely". Set them apart visually too (in the mockup, forecasts are italic and behind a divider).
- **R2 A forecast rests on a fact.** Each deal's confidence comes from a ladder of facts the topic defines, for
  example *Likely*: the partner asked for an offer; *Possible*: a call is held or booked with a named owner; *Early*:
  only a reply or a first call booked. The fact and its date are one click away. No percentage that no model produced.
- **R3 A verdict needs a plan.** "On track", "Behind plan" or "Off track" only against explicit dated milestones. No
  plan: "Forecast not established", and what is missing.
- **R4 Every number says what it counts and over which time.** Totals carry their start ("since 6 November"),
  changes their period ("this week"). Never a period heading over cumulative totals.
- **R5 The as-of line tells the truth or stays silent.** When it was read, whether the forecast changed since the last
  look, time left. Omit what is not known.
- **R6 Assumptions are labelled as assumptions**, where they are used ("4 to 6 weeks from offer to signature, a guess
  until the first one signs").
- **R7 A gap stays a gap.** "Not known yet", "No deal yet"; never a filled-in value.

### What needs the reader

- **R8 The decision is one row on the first screen:** what, by when, why it cannot wait in a few words, and the button.
  Its recommendation and reasoning are one click away, on its lane.
- **R9 Show the top two blockers** and the count of all of them. A blocker is blocked work, a deadline at risk or
  past, an indicator below plan, or output waiting for a named person. Work on schedule is not shown on the first screen.
- **R10 Name people and agents,** and who waits for whom. Nothing a decision depends on is colour or initials alone.
- **R11 Results, not volume:** what became usable or moved, not how much was produced.
- **R12 A shortfall comes with a recovery plan:** specific moves with dates, what they depend on, and the fallback.
  Closed by default; its title says how many steps.

### Visual

- **R13 Weight follows importance.** The verdict and the three numbers are the largest things on the page. A slipping
  deal outweighs any count of activity. History and agent counts never compete with the forecast.
- **R14 Stages are facts, not percentages.** A deal's progress is a track of milestones (replied, call held, qualified,
  offer sent, signed); a first call must never look like a deal near signature. Setup work (strategy, tooling) is not a
  stage of the result and goes into Details once done.
- **R15 Charts earn their place.** For a dated goal the trajectory is the one chart: one axis, the plan dashed, the
  actual solid, the forecast with its range (never a line without one), today marked, direct labels and a legend, a
  hover with the day's values, a text alternative. A funnel is a strip, not a chart.
- **R16 Status colours mean state and come with words:** amber waits or is below plan, red is stuck, green is working
  or above plan. Chart series use chart colours. Confidence words are not status: they are shown in neutral greys.
- **R17 Dia's way of reading** ([README](README.md#pages-dias-way-of-reading)): one card at most (here: Needs you), no
  outlines, no decoration, design tokens only.
- **R18 Words are labels.** On the first screen a label is a few words and a sentence is one line. Explanations live
  one click away.
- **R19 Demote, never drop.** Every piece of evidence behind the first screen is reachable in one click: a deal's lane,
  the decision's reasoning, the recovery plan, Details, History.

## What the agent decides itself

The form of each part (which chart, which indicators, which milestones make the ladder, which two blockers matter most),
the wording, and what goes one click away. A partnerships goal counts signatures; a content goal might count published
pieces or the pipeline they bring; a paid goal, leads at a cost. The rules and the order stay.

## What the agent needs to write it

- **The goal:** unit, target, deadline, and the plan's dated milestones (from the topic's strategy lane). Without them:
  R3.
- **Deals or candidates** with their last fact and its date, the next step, and who owns it.
- **The funnel:** counts with the date they were read, this period's change, the plan's rates.
- **Lanes:** state, who leads, who waits for whom, deadlines.
- **Open decisions** with the lead's recommendation, the reasoning, and the cost of waiting.
- **Output waiting for review**, and for whom.
- **The reader's last visit**, for "changed since you last looked".

What is missing is said on the page (R5, R7), not guessed.

## Check before publishing

- [ ] Looked at for ten seconds, the first screen answers the four questions.
- [ ] The verdict and the three numbers are the largest things on the page.
- [ ] No paragraph on the first screen; no sentence longer than a line.
- [ ] No number mixes actual and forecast; every number says what it counts and over which time.
- [ ] Every forecast rests on a dated fact one click away; assumptions are labelled.
- [ ] The verdict compares against an explicit plan, or says "Forecast not established".
- [ ] The decision is one row with its deadline and button; its reasoning is one click away.
- [ ] At most two blockers are shown, with the count of all.
- [ ] Deal stages are milestones, not percentages.
- [ ] Nothing was dropped to make room: every piece of evidence is one click away.
- [ ] Nothing on the page is invented to fill a gap.

## What went wrong before (from the four reviews)

| Round | Seen on the page | Why it failed | Rule |
|---|---|---|---|
| 1 | "On track" | Nothing behind it | R3 |
| 1 | Progress bars per stage ("Brands 80%") | 80% of what? Setup and deal stages mixed | R14 |
| 1 | Initials and coloured dots | Had to be decoded | R10 |
| 1 | "+32 brands, +58 contacts" overnight | Volume, not results | R11 |
| 1 | The decision below the overview | The most actionable item came last | R8 |
| 2 | "1/3 partners likely" | Read as one signed | R1 |
| 2 | "Since Monday" above 64 brands and 52 contacted | Cumulative totals under a period heading | R4 |
| 2 | A team section listing everyone's tasks | A task list, not management by exception | R9 |
| 2 | A likely and a possible deal shown alike | A first call looked like a near signature | R2, R14 |
| 3 | A paragraph explaining the forecast | A status report disguised as a dashboard | R18 |
| 3 | Evidence and next step as sentences per deal | Read, not seen | R18, R19 |
| 3 | The recovery plan and three blockers open on the page | Everything competed for attention | R9, R12 |
| 3 | The funnel as columns of labels | Took a screen; one strip says it | R15 |
