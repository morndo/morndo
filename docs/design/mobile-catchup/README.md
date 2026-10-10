# Morndo on the phone: catch-up and the dashboard (design proposal, 2026-10-03)

**Phase: design only.** Mockups and this document; no app code, no deploy. By the product lane, at the owner's request.

**The request:** the phone offers a catch-up, in the style of Slack's, of what changed since last time plus open decisions. The dashboard after that should be more useful than a plain list.

**To pick from:** one catch-up design (section 3) and three dashboards (section 4). The recommendation is dashboard A.

## 1. Mockups

Static HTML at 390 px in `mockups/`, synthetic data, the brand's tokens and fonts only (`packages/brand`: palette Ink, Outfit; Lato as in the app). Screenshots at 390 x 844, light and dark, are kept outside this tree.

| File | Shows |
|---|---|
| `catchup-1-decision.html` | A decision card: the question, what was checked and what wasn't, the recommendation, the default, the options |
| `catchup-2-update.html` | An update card: one agent's news since he last looked, with a reply box |
| `catchup-3-done.html` | "You're caught up", and the hand-over to the dashboard |
| `dash-a-horizon.html` | Dashboard A, Horizon: when he is next needed |
| `dash-b-paper.html` | Dashboard B, Morning paper: what got done, and which kind of done |
| `dash-c-radar.html` | Dashboard C, Radar: where his attention pays |

To redo the screenshots: `node docs/design/mobile-catchup/shots.ts <output folder>`. It opens each file at 390 x 844 in both colour schemes, in Playwright's own Chromium, and reports any font or file that failed to load.

## 2. What we looked at first

### The phone today

At 390 px the app shows the narrow layout (`apps/web/src/lib/Lanes.svelte`, used under 900 px): a list of agents with "needs you" first, and one agent's terminal as read-only text. Screenshots: `current-1-agents-*.png`, `current-2-agent-screen-*.png` (demo office).

- **No decisions, no messages, no reply box.** Measured on the demo office: 0 text boxes and 0 mentions of a decision in the narrow layout. The Decisions and Activity views exist only from 900 px.
- **A push that says "2 decisions wait" opens a screen that can't show them.** The code says so itself (`Lanes.svelte`, the comment on `?view=decisions`).

### What Morndo already has

| Data | Where | Used by this design for |
|---|---|---|
| Open decisions: question, options, recommendation, the "if you don't answer" text, deadline, blocking, project | The board (`escalation-service`), from the manager's needs-you list and the agents' own questions | Decision cards; Horizon's "needs you" rows |
| His own time items (things only he can do), with a deadline | The same list, `need: "time"` | Horizon's "needs you" rows |
| Answering a decision, with its rules (one answer, stale and expired refused) | E8 to E11 | "Decide in place" |
| Conversations per agent, 300 kept, older pages on demand | Observation, O5 | Update cards |
| Read marks per conversation, synced across devices, forward only | Reading, `read_marks` | "Since you last looked", Mark as read, Keep unread |
| Mute per conversation | `conversation_prefs` | Muted agents get no update card |
| Agent state: active, quiet since, needs you | The feed | Card order; "4 agents working" |
| The durable outbox, with stale-command refusal | S4 to S8 | Replies from a card |
| Push with counts only | N1 to N5 | Opening catch-up at the right card |
| "Says done" on an agent's own done | The app today | The chip on update cards |

**Not there yet, and each dashboard needs some of it:**
- who checked a piece of work, and against what (the lane ledger has verdicts; the hub doesn't read them);
- scheduled runs (digests, the night shift) and account limits (both are on the box, outside the hub);
- how long he himself attended (the hub knows it live for push, but keeps no total).

### What Telegram gives him today

- **Lane topics:** each lane's final message, raw.
- **The manager's digest,** three times a day, at most 8 lines: "Needs you: N" with the top item, "Done" with checked and unchecked, "Decided for you" so he can veto, limits.
- **Tap buttons** on needs-you items.

Catch-up is that digest made into cards he can act on, at the moment he opens the app instead of at fixed hours.

### Slack's Catch up, the reference

Slack's catch-up, as shipped: one full-screen card per channel, a "9 left" counter, the buttons "Keep unread" and "Mark as read", a reply box inside the card.

From Slack's help page ("View all your unread messages", https://slack.com/help/articles/226410907-View-all-your-unread-messages, read 2026-10-03):
- "swipe right to mark a conversation's messages as read and move on to the next unread message";
- "swipe left to skip it";
- "press and hold the Mark as Read button to mark all messages read";
- "If you swiped on a conversation too quickly, tap Undo to view the messages again";
- "To send a message in an unread channel or DM, type your reply in the message field."

**What we take:** the card stack, the counter, the two buttons and their swipes, the in-line reply, Undo. **What differs:** a decision is not a message. It can't be swiped away as read.

## 3. Catch-up: the spec

### The card unit

Two kinds of card, one stack.

- **A decision card: one per open decision.** It shows who asks and for which project, the question, what was checked and what wasn't, the recommendation, what happens if he doesn't answer and when, and the options as buttons.
- **An update card: one per agent with something new.** Its headline is the agent's latest outcome in one sentence, with "Says done" or "Checked" as a chip. Under a NEW line come the new messages, files and a one-line count of tool use. A reply box sits at the bottom of the card.
  - One per agent, not per project: an agent's conversation is the unit the read mark already belongs to. The project shows as a label.
  - The manager is an agent like any other; its card carries the digest.
  - A muted agent gets no card. The end screen says how many were skipped.

### The order

1. **Decisions first:** those that block other agents, then the earliest due or default time, then the oldest.
2. **Then updates:** agents that need him (without it being a decision), then "says done" before "checked", then the most recent.

### "Since you last looked", and where that lives

- **Updates:** everything after that conversation's read mark. The mark is already on the hub and synced across his devices, so reading on the desktop shrinks the phone's stack.
- **Decisions:** every open one, whatever he has read. A decision leaves the stack only by being answered, settled or expired.
- **Within one run:** "kept unread" and "later" cards are remembered on the device, so a card doesn't come round twice in the same run.
- **New state on the hub: one time, "last caught up".** It feeds the end screen and the dashboard ("since 07:26"). Nothing is decided from it.

### Actions per card

| Card | Action | What it does |
|---|---|---|
| Decision | Tap an option | Answers it through the existing path (E8 to E11). The card says "Answered: Ship it" with Undo for 5 seconds, then the answer is sent and the next card comes |
| Decision | "Answer in your own words" | A text answer, as on the desktop |
| Decision | Later | Keeps it open. It moves to the end of this run and stays on the dashboard |
| Decision | Open the chat | The asker's conversation, at the question |
| Update | Mark as read | Moves the read mark to the last message shown, then the next card |
| Update | Keep unread | Leaves the mark; the card returns next time |
| Update | Reply | Goes through the outbox (Queued, Sent, shown). The card stays until he moves on |
| Both | Undo (top right) | Brings back the last card. A read mark is sent only after the 5-second window, since marks only move forward |

### Gestures

- **Swipe right:** on an update, mark as read. On a decision, nothing happens except the hint "Answer it, or swipe left for later".
- **Swipe left:** keep unread, or later.
- **Hold "Mark as read":** marks all remaining updates read. Decisions stay.
- **Tap a message or a file:** opens it; back returns to the same card.
- Every gesture has a button that does the same.

### The counter

"9 left", with "2 to decide · 7 updates" beside it, and one segment per card under it. Decision segments are outlined until done, so he sees how many decisions are in the run before he starts.

### The end

"You're caught up", with what he did (2 decided, 6 read, 1 kept for later), how long it took, and the next time he is needed. One button leads to the dashboard. Cards kept for later are one tap away.

### How it hands over

- **Opening the app** with anything in the stack shows the dashboard with "Catch up · 9" at the top. A push opens catch-up directly, at the card it was about.
- **After the last card:** the end screen, then the dashboard.
- **The tab bar** has three places: Today (the dashboard), Catch up, and Agents (today's list and the read-only screen stay there).

### Rules it keeps

- **Reading grants nothing** (O8, N5). Marking read, keeping unread, later, and "last caught up" never answer, settle or delay a decision, and start no timer.
- **A decision is never muted and never marked read.**
- **Deciding or replying needs a fresh passkey check** when the last one is older than his setting (AC7). The card asks, then goes on.
- **A stale answer is refused, visibly** (E8 to E11, S6): if the question changed or was answered elsewhere, the card says so and shows the current state.

## 4. The dashboard: three concepts

Catch-up covers the past (what happened) and the present (decide now). The three concepts differ in which question the first screen answers.

### A. Horizon: "When am I next needed?" (recommended)

- **First screen:** "Nothing needs you until 16:00", then a timeline of what is coming. A filled dot needs him; an open dot happens without him.
- **Why it is different:** every other dashboard asks for attention. This one tells him when he can stop looking. That is the one thing catch-up can't say.
- **Data it needs:**
  - *There today:* the board's deadlines, for decisions and for his own time items, each with its "if you don't answer" text.
  - *Small adapters:* the box's schedule (digests, night shift) and the account limits.
- **Honest limit:** it shows only times that are written down somewhere. It doesn't guess when an agent will finish; such items sit under "when ready".
- **Name:** the mark he picked is the horizon.

### B. Morning paper: "What did they get done, and can I trust it?"

- **First screen:** "By morning, 7 things were done. 5 were checked by someone other than the agent that did the work. 2 only say they are done." Then his time against the agents' time, and the lists: checked, says done, decided for you (with Veto).
- **Why it is different:** it reads like a front page, and it splits "done" by who checked it.
- **Data it needs:**
  - *There today:* "Says done".
  - *Not there:* who checked what. The hub would have to read the lane ledger's verdicts. Without that, the page can't say "checked".
  - *New:* a daily total of his own attending time, counts only.
- **Honest limit:** it overlaps with catch-up, which has just shown him the same work card by card.

### C. Radar: "Where does my attention pay?"

- **First screen:** a radar with him in the middle. Each dot is a piece of work: closer means it needs him more, bigger means more is at stake, the colour is its state. Under it, the top three with one action each.
- **Why it is different:** it is a picture, not a list; nine things fit in one glance.
- **Data it needs:**
  - *There today:* needs you, blocking, quiet for how long.
  - *Not there:* what is at stake. Size needs a judgment (production, money, a client) that nothing in the hub makes today.
- **Honest limit:** if the sizes are guessed, the picture misleads. It is the largest build of the three.

### The recommendation

**A, Horizon.** It complements catch-up instead of repeating it, it runs almost entirely on data the hub has, and it is the smallest to build. B's split of "checked" and "says done" is worth having, and can become a section of the dashboard once the hub reads who checked what.

## 5. Done criteria for the build phase

Catch-up and the phone shell:
1. At 390 px, "Catch up · N" shows whenever N > 0, and N is the open decisions plus the unmuted conversations with unread messages.
2. Decisions come first: blocking, then earliest due or default time, then oldest. Updates follow in the order of section 3.
3. Tapping an option answers the decision through the existing path; the hub's audit has one EscalationAnswered for it.
4. A decision can't be marked read: swiping right changes nothing in the hub, and the card stays.
5. "Later" leaves the decision open, and it shows on the dashboard.
6. "Mark as read" moves that conversation's read mark to the last message shown, and the desktop shows it read within 2 seconds.
7. "Keep unread" changes nothing in the hub, and the card returns in the next run.
8. Undo within 5 seconds brings the card back, and neither a read mark nor an answer has been sent.
9. A stale or expired decision shows its refusal on the card, and nothing is answered.
10. With a passkey check older than his setting, deciding or replying asks for the passkey first, then completes.
11. A reply from a card goes through the outbox and shows in the conversation; typed into the pane exactly once.
12. A muted conversation gets no card; a decision from it still does.
13. The end screen's counts equal what he did in that run.
14. A push for decisions opens catch-up at a decision card.
15. Offline: loaded cards stay readable, and every action either queues or says why it can't.
16. Every gesture has a button; both buttons are at least 44 px high and carry a label a screen reader says.
17. Light and dark pass the brand's contrast test (`packages/brand/test/tokens.test.ts`) for every pair used.
18. With reduced motion set, cards change without sliding.
19. The Agents tab keeps today's list and read-only screen.
20. An end-to-end check runs the whole flow at 390 px on the demo office, in CI.
21. Hands-on QA on a real iPhone, as an installed web app, is recorded in `qa/` with screenshots.

Dashboard A:
22. "Nothing needs you until HH:MM" is the earliest open item that needs him; with something waiting, it says "N waiting now".
23. Every time shown comes from a record; an item without one sits under "when ready".
24. Every row is marked "needs you" or "happens without you".
25. "Decide now" on a row opens that decision's card.

## 6. Rough size

In working days of one lane, with tests, review and QA:

| Part | Size | Why |
|---|---|---|
| Phone shell and catch-up | 3 to 4 days | The desktop's parts are reused (messages, composer, decision card, outbox, read marks). New: the card stack, gestures, order, Undo, the end screen, one small hub field |
| Dashboard A, Horizon | 1 to 2 days | From the board at first; the schedule and limit adapters add about a day |
| Dashboard B, Morning paper | 2 to 3 days | Plus an adapter for who checked what, which is its own decision |
| Dashboard C, Radar | 3 to 4 days | Plus a rule for what is at stake |

## 7. Open questions for the owner

1. **Which dashboard: A Horizon, B Morning paper or C Radar?** (Recommended: A.)
2. **When catch-up is live, do the Telegram digests stay beside it for now, or stop?** (Recommended: stay for two weeks, then decide from use.)

## Privacy

The owner's screenshot shows real names and addresses from an app of his. Nothing from it is copied here; the mockups use made-up projects and agents.
