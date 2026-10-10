# ADR-0009: The phone: catch-up, and Horizon as its dashboard

- **Status:** Accepted, 2026-10-04. The owner asked for it and picked dashboard A; built by lane mobile-catchup on `feat/mobile-catchup`.
- **Spec:** `docs/design/mobile-catchup/README.md` (sections 3 and 4A, done criteria in section 5), with its mockups.
- **Builds on:** ADR-0004 (the web endpoint), ADR-0006 (the desktop client, its decisions), ADR-0008 (read marks, mute, the outbox, push).

## Context

The requirement: the phone offers a catch-up, in the style of Slack's, of what changed since last time plus open decisions. The dashboard after that should be more useful than a plain list. Dashboard A, Horizon, was chosen.

Before this, under 900 px the app showed only the agents list and one read-only screen: no decisions, no messages, no reply. A push saying "2 decisions wait" opened a screen that couldn't show them (ADR-0008, phase F).

## Decision

### 1. Three places on the phone

Under 900 px wide the app is a tab bar with **Today** (Horizon), **Catch up** (with a badge of how many cards wait) and **Agents** (the list and read-only screen as before, `phone/Agents.svelte`, moved from `Lanes.svelte`). One live feed and one outbox serve all three (`phone/Phone.svelte`). Catch-up is full screen, with Back to Today.

### 2. Catch-up (C1 to C7 in `docs/domain.md`)

- **One stack, two kinds of card:** one per open decision (an Ask that waits for his call), then one per unmuted agent with messages after its read mark. Decisions first: blocking, then the earliest due or default time, then the oldest. Updates: needs you, then "says done", then the most recent.
- **A run** is one pass from opening catch-up to "You're caught up". It is kept on the device (`localStorage`), so a reload or a switch to another tab doesn't lose the place; an unfinished run is taken up again within 30 minutes of the last step, otherwise a new one starts.
- **Actions, each with a button, most with a gesture:**
  - Decision: tap an option (or "Answer in your own words", or "Go with the default" where the ask has no buttons); Later; Open the chat (the asker's conversation at the question, read-only). Swiping right only shows "Answer it, or swipe left for later".
  - Update: Mark as read (swipe right), Keep unread (swipe left), hold Mark as read (or "Mark all N updates read") for every update left; a reply box that queues in the outbox; a tap on a message opens the conversation there; a file opens itself.
  - Undo, top right, takes back the last step while nothing has gone.
- **Nothing goes for 5 seconds.** An answer shows "Answered: …" with Undo, then goes through the existing path (`POST /api/escalations/:id/answer`, E8 to E11). A read mark goes 5 seconds after Mark as read. Leaving catch-up (Back, another tab, the page hidden: a phone put away) sends both at once, as he left them. Undo inside the window sends nothing. An answer found more than 30 seconds past its window unsent (the page was frozen) is not sent: the card says so, and he taps again if it still stands.
- **Passkey first, inside the tap.** When the last passkey check is older than his setting (AC7), the tap asks for Face ID before the window starts: Safari asks for Face ID only from a user gesture (WebKit, "Meet Face ID and Touch ID for the web", https://webkit.org/blog/11312/meet-face-id-and-touch-id-for-the-web/, read 2026-10-03). If the hub still says `step_up` on arrival, the card offers "Confirm with passkey and send"; a reply refused that way offers "Confirm with passkey" (then the same request id again, S5).
- **Offline:** loaded cards stay readable. A reply queues in the outbox (S4, S7). A read mark waits on the device (`localStorage`, so a page the phone discards still sends it) and goes when the socket is back (marks only move forward, so a late one is still right). An answer is refused with the reason ("A decision goes only while Morndo is connected"): decision answers stay out of the outbox (ADR-0008, constraint 6).
- **What a card shows comes from the hub** (`{t:"catchup"}` on the feed socket): per unmuted conversation, its newest 30 messages after the read mark and the whole of it in counts (messages, span, tool uses, files) and its claim (C5). It is asked for when the feed is ready, at each run's start, and again (at most every 2 s) when the roster shows a conversation spoke after what is loaded. While an update card is on top, its agent is watched, so new messages and the echo of a reply show live.
- **"Last caught up"** is one time on the hub (`settings.caught_up_at`), set at the end of a run, told to every device (`{t:"caught_up"}`), forward only and clamped to the hub's clock (C7). Today shows it; nothing is decided from it.
- **A push about decisions** (`/?view=decisions`) opens catch-up with a decision card on top; `?view=activity` opens catch-up as it is.

### 3. Horizon, the dashboard (`phone/Today.svelte`, `phone/horizon.ts`)

- **The headline:** "N waiting now" while open decisions wait (not counting those kept for later) or anything is overdue; otherwise "Nothing needs you until HH:MM", the earliest deadline of an open item that needs him; otherwise "Nothing needs you".
- **The timeline:** a filled dot needs him, an open dot happens without him. Times come only from the board's deadlines; an item without one sits under "when ready", and agents that are working sit there too ("No set time"): it never guesses when an agent will finish. Decisions he answered keep their deadline as "happens without you" ("You said “Ship it” at 09:41"). "Decide now" opens that decision's card.
- **Not built (the design's "small adapters"):** the box's schedule (digests, night shift) and the account limits. Both live outside the hub; done criteria 22 to 25 don't need them. A later step can add them as adapters that feed the same rows.

### 4. Where things live

| Piece | Where | Why |
|---|---|---|
| Which cards, their order, what is new since a mark, the claim, last caught up | `packages/domain/src/catchup.ts` | Product rules, pure, shared by the hub and the app |
| The catch-up read model | `apps/hub/src/application/catchup.ts`, frames in `http.ts` | Reads Observation and Reading, moves nothing |
| The run (steps, windows, Undo, counts) | `apps/web/src/lib/catchup/run.ts` | Device state, pure, serializable, unit-tested |
| The run on this device: timers, storage, hand-off to feed and hub | `apps/web/src/lib/catchup/session.svelte.ts` | Async code in a `.ts` module, where the type-aware lint reaches (ADR-0008, A7) |
| Swipe and hold | `apps/web/src/lib/catchup/swipe.ts` | Pointer Events with `touch-action: pan-y` (MDN, read 2026-10-03) |
| The outbox start-up | `apps/web/src/lib/outbox/device.ts` | Moved from `Desktop.svelte`, so both use it; it now gives its Web Lock back on stop, since the app swaps the two at 900 px |

### 5. Look

The mockups' palette and type: the brand's Ink tokens only, Outfit for headlines and numbers (now shipped: `@fontsource-variable/outfit` 5.3.0, OFL-1.1; `fresh npm` and OSV checked 2026-10-03: no known vulnerabilities), Lato for reading. Every text and background pair the phone renders is checked in both themes against the brand's contrast targets by the e2e (criterion 17); the targets moved from the brand's test into `packages/brand/src/contrast.ts` so the e2e and the test share them. Reduced motion: cards change without sliding (the global rule stops transitions; the fly-out is skipped).

## Consequences

- **Good:** the phone can now decide, read and reply; a push lands where it can be acted on; the dashboard says when he can stop looking.
- **The client JS grows:** all client JS is 292 KB gzipped, +6.2% on the recorded 2026-10-02 baseline (the budget allows 15%); the entry is unchanged (+0.2%).
- **Known limits:**
  - "Kept unread" and "later" are this device's memory: the desktop doesn't see them (by design, C6).
  - **No "Checked" state, removed 2026-10-04:** the hub reads no verdicts, and the manager's ledger can't record a failed check, so nothing could set it honestly. The chip, the claim and its place in the order are gone; an update shows only the worker's own "Says done". A checked state comes back only with a source of Verdicts by someone other than the worker (V1, V4).
  - A message older than the conversation's latest 150 can't be opened at its place from a card; the view says so.
  - Undo on the end screen brings the last card back after "caught up" went to the hub; the time then stays until the run ends again (nothing is decided from it, C7).
  - The run's 5-second windows need the page open: hiding the page sends what is pending at once, which iOS may cut short if it suspends the page first; then a read mark goes on the next visit, and an answer more than 30 s late is not sent but shown as not sent.
- **Hands-on QA on the owner's iPhone** (criterion 21) is his: a checklist is in a private QA record, not in this tree.

## After the review of PR #7 (2026-10-04)

A full review found 15 defects; each was reproduced by a test before its fix (`e2e/catchup-edges.e2e.ts`, unit tests), one commit each. What is a rule now:

- **What may be shown or acted on:** the feed's `primed` means current: it resets when the connection leaves open and on a wake after 30 s of silence, and is set by this connection's hello. Catch-up opens and follows only on current data, a run kept on the device is shown only once opened on it, and Today and the end screen say "Waiting for the hub" rather than "Nothing needs you".
- **Replies** carry what the agent waited for when the reply was started (S6), as on the desktop, and use the desktop's words for every refusal, with Discard.
- **Answers** carry the version of the Ask they were given for (`askVersion`, E12); the hub refuses a restated Ask as `changed`. The POST gives up after 15 s, goes as keepalive, and keeps one request id for every attempt; an outcome without the hub's word says it may have gone (Try again, typed at most once) and counts once the board shows it.
- **Read marks** stay pending (in `localStorage`, merged per conversation) until the hub's echo or the next hello confirms them, and go again on every new connection.
- **The run:** a passed card comes round again when it has something new (an update that spoke again; a decision asked again or reopened); "kept for later" holds the Ask's version and goes when the decision is taken up again.
- **Cards:** tool calls are counted, not listed; a card with nothing loaded asks for its conversation and says "Nothing new here"; two panes with one name use the pane that spoke last, for the card, the catch-up and the reply; the card's scrollers say `touch-action: pan-y` so a swipe can start anywhere on it.

## Readability pass after the owner's first look (2026-10-04)

On the live app, timeline text was too dense to read, and a decision must offer its options plus a way to answer in one's own words. A screenshot also showed the headline under the phone's status clock. What is a rule now:

- **An item reads short** (`phone/brief.ts`): a bold title on one line, one plain sentence, a meta line ("≈10 min · only you", "Decision · blocks newsletter", "due 16:00"), and everything else behind More: the long text, the details, a link, what happens without an answer, and the reason for the recommendation.
  - **The title comes from the list when it gives one.** The manager's needs-you list may now give each item a short form: `title`, `summary`, `minutes`, `options`, `link` and `details`. The hub reads them through its list adapter, checks them, and passes them on the board.
  - **Without a title, it is derived.** It is the text's first clause, up to a full stop, `?`, `!`, a colon, a semicolon or a bracket, at most 60 characters and cut at a word. The raw text is never the headline.
- **Which buttons** (`actions`):
  - **A decision's row** keeps Decide now, which opens its card.
  - **The card** shows every option as a big button (56 px or more). The recommended one is first and filled, labelled Recommended. Under an "or" comes "Answer in my own words", a full-width button, never a small link.
  - **A task** (the list's kind `time`) never gets Decide now. It gets Done and Later, or its own options when it has some, and "Answer in my own words" behind More.
  - **Done, an option or his words from a row** go to the manager by the same path as a decision's answer (E8 to E12). They wait the same 5 seconds with Undo, are never sent more than 30 s late, and leaving the page sends them (`phone/quick.ts`).
  - **Later on a task** keeps it under "Kept for later today" on this device until midnight, or until the task is restated. The hub hears nothing of it (C6).
- **The list's kind decides decision or task.** A task the manager also posts buttons for stays a task. Before, a button message turned it into a decision.
  - The list's own options make an item answerable by a tap. A button message's options win over the list's when both exist, as ADR-0006 has it ("the message supplies the options"): those are what every endpoint taps. They are checked against the same grammar as a button line (`optionsProblem`), since the tap is typed back into the manager's pane as `[tap <id>] <key> (<label>)`.
  - When the short form is given, `askVersion` covers it too.
- **Safe areas:**
  - `.phone` defines `--safe-top`, `--safe-right`, `--safe-bottom` and `--safe-left` from `env(safe-area-inset-*)`. Every edge bar pads with them: Today's bar, the tab bar, catch-up's bar and the agents' bar.
  - Today's bar is pinned (`position: sticky`) with its own background, so nothing scrolls under the status bar. The installed app draws under it: `viewport-fit=cover` with `apple-mobile-web-app-status-bar-style: black-translucent`.
  - A decision's options and own-words button fit on the card under both insets.
- **Copy:**
  - "when ready" is now the "Anytime" heading, and "Read why it asks" is now More.
  - The headline says decisions and late tasks apart, and with nothing urgent it counts the tasks he can do anytime.
- **Checked by:** the unit tests `brief.test.ts`, `quick.test.ts` and `horizon.test.ts`, the hub tests for the list and the board, and `e2e/readability.e2e.ts` (8 checks at 390 px).
  - R7 emulates the insets with CDP `Emulation.setSafeAreaInsetsOverride` in Playwright's Chromium 153. As a negative control, it fails with the bar unpinned.
  - Not verified on a real iPhone. That is the owner's checklist.

## Sources

- The design: `docs/design/mobile-catchup/README.md`, and Slack's help page it cites for the reference behaviour (https://slack.com/help/articles/226410907-View-all-your-unread-messages, read 2026-10-03 by the product lane). Only the interaction was taken; no Slack code or asset.
- MDN, read 2026-10-03: `touch-action` (https://developer.mozilla.org/en-US/docs/Web/CSS/touch-action), `setPointerCapture` (https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture), `pointercancel` (https://developer.mozilla.org/en-US/docs/Web/API/Element/pointercancel_event), `prefers-reduced-motion`, `-webkit-touch-callout`, `user-select`, the `status` role.
- WebKit, Face ID and Touch ID need a user gesture: https://webkit.org/blog/11312/meet-face-id-and-touch-id-for-the-web/ (read 2026-10-03).
- Svelte 5 runes and snippets, for the installed 5.57.1: https://svelte.dev/docs/svelte/$state, /$derived, /$effect, /snippet (read 2026-10-03).
- Playwright 1.63 (installed): `page.on("websocket")` with `framesent`, `browserContext.setOffline`, `newContext({ reducedMotion, hasTouch, isMobile })`: https://playwright.dev/docs/api/class-websocket, /class-browsercontext, /class-browser (read 2026-10-03).
- Safe areas, read 2026-10-04: MDN `env()` (https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/env); WebKit, "Designing Websites for iPhone X" (https://webkit.org/blog/7929/designing-websites-for-iphone-x/: `viewport-fit=cover`, `env(safe-area-inset-*)`, `max()` with a minimum padding); Apple's Supported Meta Tags (https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariHTMLRef/Articles/MetaTags.html: with `black-translucent` "the web content is displayed on the entire screen, partially obscured by the status bar"); Chrome DevTools Protocol `Emulation.setSafeAreaInsetsOverride` (in the installed Playwright 1.63's protocol types, Chromium 153.0.8010.12; tried live).
- `@fontsource-variable/outfit` 5.3.0: https://www.npmjs.com/package/@fontsource-variable/outfit and https://osv.dev (checked 2026-10-03).
