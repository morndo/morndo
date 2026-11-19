# The topic status page: guard rails for the agent that writes it

**Phase: design, 2026-11-19.** This is not code and not a template. An agent writes a topic's status page itself and
chooses how to show each part; this document sets the rules it must keep. It is written so it can become a skill
later. The reference is the Partnerships page in [`mockups/gtm-cockpit.html`](mockups/gtm-cockpit.html)
(`#topic/partnerships`). It came out of three rounds of review by a Head of GTM reading it as their morning brief.

## What the page is for

One question, every morning: **are we going to reach the goal by the deadline, and what do I need to change today?**

The reader is the topic's owner, a manager, and whoever the topic is shared with. They are not a project tracker. They
ask the way a CEO asks in a hallway: "where are we?", "will we make it?", "what do you need from me?". The page is a
management dashboard, not a project dashboard: it says whether the way we work is fast enough, not only what happened.

## The acceptance test

Within ten seconds, without opening anything, the reader knows:

1. **Will we deliver?** Actual against target, the forecast, and whether that is enough.
2. **What changed** since they last looked.
3. **Where are we stuck?**
4. **What needs me today?**

If one of the four is not answered on the first screen, the page fails, whatever else it shows.

## The order of the page

| # | Part | Answers | Shown as (the agent's choice within the rules) |
|---|---|---|---|
| 1 | Status | Will we deliver? | Actual and target, then the forecast apart from it; a verdict word; one sentence on why; the as-of line |
| 2 | Trajectory | Is it fast enough? | Actual so far, the plan to the deadline, the forecast with its range, today marked |
| 3 | The decision | What needs me? | The one decision that waits for the owner: what we recommend, why, what waiting costs, one button |
| 4 | Path to the goal | Where will the result come from? | Each candidate at its last fact, the evidence, the next milestone, the expected close; then the gap and the actions that close it |
| 5 | Needs attention | Where are we stuck? | Exceptions only: blocked, late, below plan, waiting for a named person |
| 6 | Leading indicators | Does the method work? | The funnel as of today with conversion against the plan; this period's movement on its own line; what has waited longest |
| 7 | Below the fold, closed | Everything else | Details (purpose, plan stages, lanes, people and agents, jobs) and History |

Parts 1 to 3 belong on the first screen. A topic without a dated, measurable goal has no parts 1, 2, 4 or 6: the page
says "No goal set" and names what is missing, shows what waits for the owner, and offers to ask for a goal.

## Rules

### Truth and evidence

- **R1 Actuals and forecasts never share a number.** Write "0 signed of 3, 1 likely, 2 not backed by a likely deal",
  never "1/3 likely". Show what happened apart from what is expected, in words and in the visual.
- **R2 A forecast names what it rests on.** Every candidate shows its last fact (a dated event: "asked for an offer on
  the 13 November call"), not an impression. Confidence comes from a fixed ladder the topic defines from facts, for
  example *Likely*: the partner asked for an offer; *Possible*: a qualified call was held or is booked with a named
  owner; *Unqualified*: only a reply or a booked first call. Never a percentage that no model produced.
- **R3 A verdict needs a plan.** "On track", "Behind plan" or "Off track" only after comparing the forecast with an
  explicit plan (the milestones set when the topic started). Without a plan, write "Forecast not established" and say
  what is missing.
- **R4 Every number names what it counts and over which time.** Totals are "as of today" or "since <a date>";
  movement is "this week" or "since <a day>". Never put a period heading over cumulative totals, and never mix both in
  one row.
- **R5 The as-of line tells the truth or stays silent.** When the data was read, whether the forecast changed since the
  reader last looked, and how much time is left ("Updated 07:45 · forecast unchanged since yesterday · 10 weeks left").
  Omit any part that is not known.
- **R6 Assumptions are labelled as assumptions.** "We assume 4 to 6 weeks from offer to signature; that is a guess
  until the first one signs."
- **R7 A gap stays a gap.** Missing data shows as "not known yet" or "No deal yet", never as a filled-in value.

### What needs the reader

- **R8 The decision is on the first screen**, with what we recommend, why, what waiting costs, and its deadline. One
  primary button; the full story is one click away.
- **R9 Needs attention lists exceptions only:** blocked work, deadlines at risk or past, indicators below plan, and
  output that waits for a named person's review. Work on schedule folds into one line ("On schedule: …").
- **R10 Name people and agents.** Say who waits for whom ("Sender waits for Lea"). No initials, avatars or colour
  alone for anything a decision depends on.
- **R11 Results, not volume.** Report what became usable or moved forward ("9 of 32 new brands fit", "24 emails ready
  for Lea"), not how much was produced.
- **R12 Close the gap with actions.** When the forecast falls short, name the specific moves that close it, each with
  a date and what it depends on, and the fallback if they fail.

### Visual

- **R13 Weight follows importance.** A slipping deal outweighs any activity count. History, agent counts and totals
  never compete with the forecast and the decision.
- **R14 Stages are facts, not percentages.** A candidate's progress is a track of factual milestones (replied, call
  held, qualified, offer sent, signed). A first call must never look like a deal near signature. Setup work (strategy,
  tooling) is not a stage of the result; once done it goes into Details.
- **R15 Charts earn their place.** A chart appears only if it answers one of the four questions better than a number.
  For a dated goal the default is the trajectory. One axis; the plan dashed, the actual solid, the forecast with its
  range (never a single line without one), today marked, direct labels plus a legend, a text alternative, and a hover
  that shows the day's values.
- **R16 Status colours mean state and come with words:** amber waits or is below plan, red is stuck, green is working
  or above plan. Chart series use chart colours, never status colours.
- **R17 Dia's way of reading** ([README](README.md#pages-dias-way-of-reading)): one card at most (the decision), no
  outlines, no decorative elements, design tokens only, reading text in the warm grey, section names in serif italic.
- **R18 Few words on the first screen.** One sentence per item at most; the rest is a click away.

## What the agent decides itself

The form of each part (which chart, which indicators, which milestones make the ladder, how a candidate is shown), the
wording, and what goes into Details. A partnerships goal counts signatures; a content goal might count published pieces
or the pipeline they bring; a paid goal, leads at a cost. The rules and the order stay.

## What the agent needs to write it

- **The goal:** unit, target, deadline, and the plan's dated milestones (from the topic's strategy lane). Without them:
  R3.
- **Candidates** with their last fact and its date, the next milestone, and who owns it.
- **The funnel:** counts with the date they were read, the plan's rates, and the time each stage has waited.
- **Lanes:** state, who leads, who waits for whom, deadlines.
- **Open decisions** with the lead's recommendation, the reasoning, and the cost of waiting.
- **Output waiting for review**, and for whom.
- **The reader's last visit**, for "changed since you last looked".

What is missing is said on the page (R5, R7), not guessed.

## Check before publishing

- [ ] The four questions are answered on the first screen.
- [ ] No number mixes actual and forecast; every number names what it counts and over which time.
- [ ] Every forecast and every confidence word rests on a dated fact; every assumption is labelled.
- [ ] The verdict word compares against an explicit plan, or says "Forecast not established".
- [ ] The decision shows its recommendation, its reason and what waiting costs.
- [ ] Needs attention holds only exceptions; routine work is one line.
- [ ] People and agents are named; nothing important is colour or initials alone.
- [ ] Stages are factual milestones; no percentage bars of unknown denominator.
- [ ] Any chart answers one of the four questions, shows uncertainty, and has a text alternative.
- [ ] Nothing on the page is invented to fill a gap.

## What went wrong before (from the reviews)

| Seen on the page | Why it failed | Rule |
|---|---|---|
| "On track" | Nothing behind it | R3 |
| Progress bars per stage ("Brands 80%") | 80% of what? Setup and deal stages mixed | R14 |
| "1/3 partners likely" | Read as one signed | R1 |
| "Since Monday" above 64 brands and 52 contacted | Cumulative totals under a period heading | R4 |
| "+32 brands, +58 contacts" overnight | Volume, not results | R11 |
| A team section listing everyone's tasks | A task list, not management by exception | R9 |
| The decision below the overview | The most actionable item came last | R8 |
| Initials and coloured dots | Had to be decoded | R10 |
| A likely and a possible deal shown alike | A first call looked like a near signature | R2, R14 |
