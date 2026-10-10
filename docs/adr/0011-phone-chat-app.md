# ADR-0011: The phone as a chat app: chats, status, and a digest only after an absence

- **Status:** Accepted, 2026-10-05. The owner asked for it; the manager briefed it; built by lane phone-chat on `feat/phone-chat`, stacked on `feat/manager-inbox` (PR #10, ADR-0010), which a message to the manager goes through.
- **Builds on:** ADR-0006 (the desktop's chat), ADR-0008 (the outbox, read marks, attending), ADR-0009 (the phone, catch-up, Horizon), ADR-0010 (the manager's inbox).
- **Rules:** H1 to H5 in `docs/domain.md`.

## Context

The requirement: decision cards on the phone stay. Lane updates are too frequent, so a digest arrives only after a night or a stretch of inactivity. The phone must make it easy to give directions and to see current status, including a chat with the manager and with each lane, in the shape of a chat app. Slack and Signal are the references.

Before this, the phone had Today, Catch up (a decision card per open Ask and an update card per lane with anything unread: with twenty lanes, always a stack) and Agents (a list and a read-only screen). Replying was possible only from an update card; the manager could not be messaged at all.

## Decision

1. **Three places:** Chats (the default), Today (Horizon, unchanged), Status. The Agents tab is gone: its list is the Status view, its read-only screen is "Screen" in each chat.
2. **Chats, Signal's way.** The manager pinned first, then the newest activity on top (Signal: pinned chats first, the rest by date, newest first: Signal-Android `ThreadTable.kt`, read 2026-10-05). A row: name, time of its last message, one line of preview, "Waits for you" when it does, and a count of the messages that matter only (H1): an agent's last words of a turn, a question, a file. Seventy progress notes in one turn are one unread. A muted lane shows no count. Above the rows: "N decisions wait for you · Decide", and the digest he put off.
3. **A conversation** is bubbles (his on the right), day separators ("Today", "Yesterday"), runs of one author within 3 minutes grouped (Signal's own rule: `clusterTimeout = 3.minutes`, Signal-Android `V2ConversationItemShape.kt`, read 2026-10-05), tool calls folded into one quiet line, long answers shortened with "Show more", markers and button lines stripped. Reading it to its end marks it read, as the desktop does; the old phone rule "reading here marks nothing" was for catch-up's cards and goes with them.
4. **Directions:** a composer at the bottom of every chat. A message to the manager goes into its inbox (ADR-0010); to a lane, straight into its pane (the steering service). Both are Commands in the device's outbox (S4 to S8): written down before the first attempt, sent in order, retried, kept offline, and never dropped without a word. Where it stands, in Signal's words for its steps (support.signal.org "What do the Sending, Sent, Delivered, Read icons mean", read 2026-10-05): **Sending**; **Queued** (offline: "sends when you're back online"; or in the manager's inbox until its box is free); **Delivered** (typed into the lane, or seen in the manager's conversation, its echo); **Not sent** with the reason and Retry. The 2-minute budget (S7) stays: an agent must not get a stale instruction; past it the message says Not sent and waits for Retry.
5. **Keyboard and safe areas.** iOS Safari doesn't resize the page for the keyboard and supports neither `interactive-widget` nor `env(keyboard-inset-*)` (MDN's compatibility data for the viewport meta and `env()`, read 2026-10-05; WebKit bug 259770 still open). So a conversation is fixed to the visual viewport: top at `visualViewport.offsetTop`, bottom lifted by `innerHeight − height − offsetTop` (MDN VisualViewport, supported since iOS 13). The composer pads by the home indicator's inset only while the keyboard is down; the header by the status bar's.
6. **Updates don't interrupt.** The phone's catch-up holds decision cards only (decisions keep their cards exactly as before); update cards are no longer made. Updates wait in each chat. Pushes were already only for decisions and needs-you (N2), unchanged.
7. **The digest, only after a real absence (H4, H5).** When the app starts, or shows again after a minute hidden, it reads his last activity on this device (kept on the device) and asks the hub for his last activity on any other device (kept per Endpoint from the attending reports N3 already sends, in the settings table). Away longer than his setting, it shows "While you were away": one line per lane that spoke or needs him (needs you, blocked, finished, then the rest; the manager first) with its counts, a button to the decision cards, "Mark all read" and "Later". The setting is per device: after 2, 4 (default) or 8 hours, only after a night, or never. The default of 4 hours passes over a meeting or lunch and catches every night; Slack's recap, the same idea, comes "every morning with what you missed from the previous day" (slack.com/help/articles/25076892548883, read 2026-10-05).
8. **Status:** every lane in one line: waits for you (the longest wait first, with the ask), working, blocked, then the rest; "Waits 2 h", "Working 12 min", "Idle since 13:40".

### Where things live

| Piece | Where |
|---|---|
| H1 to H5: what matters, the order, the status, away, the digest's lines | `packages/domain/src/chats.ts` |
| Decision cards only on the phone | `catchUpCards({ updates: false })`, `packages/domain/src/catchup.ts` |
| The chat list and digest read models | `apps/hub/src/application/chats.ts` |
| His last activity per device | `apps/hub/src/application/presence-service.ts` |
| Frames `chats`, `digest`, `presence` | `packages/protocol/src/feed.ts` |
| Rows, previews, bubbles, delivery words, away, keyboard | `apps/web/src/lib/phone/chat/*.ts` |
| The screens | `apps/web/src/lib/phone/chat/*.svelte`, `phone/Phone.svelte`, `phone/TabBar.svelte` |

### After the fresh-context review (2026-10-05)

- **A lane whose last report says STATUS: NEEDS DECISION waits for him** in Status and the chat list, since that report, as the digest already counted it (H3).
- **Nothing stays good forever without its echo.** Typed into a lane but not seen in its conversation after 10 minutes (the desktop's "not seen yet", `UNSEEN_AFTER_MS`), the bubble warns: "Typed in, but not seen in its conversation after 10 min: check its Screen". In the manager's inbox and not delivered after 60 minutes (the inbox's last alert to the owner, ADR-0010), it is **Not sent**, with **Send again**, which puts the text back in the box: it goes as a new message, through the passkey check and S6 like any other. The old entry is never resent with its old request id (the inbox already holds that one). A late echo still ends either (S8). Both are judged when the label is drawn (`phone/chat/delivery.ts`), so nothing in the outbox's state changes.
- **A message held behind one that didn't go can be discarded** in the chat, as on the desktop.
- **Send again repeats the same request id** (third pass). The hub adds nothing while the inbox may still type the first message, and queues the text once more, under `command:<key>:again`, only once the inbox gave the first up for good (expired, cancelled, or its file gone; not "lost", which waits for a person); a further repeat adds nothing. One request is at most two inbox messages, never two that can both arrive. A repeat that would queue anything passes first what a first send passes: the passkey step-up (AC7), the S6 check and the worker's name (validated review finding #1); the phone asks for the passkey before Send again and Retry when its check isn't fresh. This closes the gap PR #10's review characterized as B4 (its test now asserts the new contract). The chat's composer keeps a draft on the device, as the desktop's does.
- **A NEEDS DECISION report he has answered no longer waits** (H3): his message after it ends the wait.
- **After 60 minutes the bubble tells where the message stands** (review #2, the team's call A): "Not delivered after 60 min" and Check, which asks the hub with the same request id; the hub's answer carries the inbox's state ("Still waiting in the manager's inbox: someone else's text is in its box"). It says Not sent, with Send again, only once the inbox gave the message up; the hub then queues it once more, once.
- **C4 amended** (review #10, the team's call): the decisions-only run's end screen shows no "N muted, skipped": no lane's updates are shown there, so being muted skips nothing.
- **An open chat isn't drawn under the digest,** so it can't mark itself read while he reads the digest; a needs-you push (`?view=activity`) opens Chats.
- **The catch-up e2e checks of update cards are retired** (the manager's decision, the owner's words above); the list and reasons are in a private QA record, not in this tree.

## Consequences

- **Good:** he can message the manager and every lane from the phone, sees where each message stands, sees every lane's state on one screen, and is told about updates once after an absence instead of all day.
- **Client JS:** all client JS is 308.7 KB gzipped, +12.3% on the 2026-10-02 baseline (the budget allows 15%); the entry +0.2%.
- **Known limits:**
  - The update-card code in `CatchUp.svelte`, `UpdateCard.svelte` and `catchup/run.ts` is no longer reached on the phone. It is left in place for this change (removing it touches the run's tested state machine) and should go in a follow-up.
  - A chat on the phone shows the latest 300 messages (O5); older pages are the desktop's.
  - Images can't be attached from the phone composer yet (the desktop's can).
  - Away is judged from attending reports: a device that reports nothing (an old app version) counts as not used.
  - Not verified on a real iPhone: the keyboard behaviour is checked by emulating the visual viewport in Chromium, the insets with CDP `Emulation.setSafeAreaInsetsOverride`. The owner's checklist is in a private QA record, not in this tree.

## Sources (read 2026-10-05)

- Slack, Catch up: https://slack.com/help/articles/226410907 ; Activity: https://slack.com/help/articles/19693583638803 ; AI recaps: https://slack.com/help/articles/25076892548883 . Only the interaction ideas were taken.
- Signal, delivery states: https://support.signal.org/hc/en-us/articles/360007320751 ; pinned chats: https://support.signal.org/hc/en-us/articles/360048678832 ; Signal-Android source (`ThreadTable.kt` ordering, `V2ConversationItemShape.kt` 3-minute clusters). Ideas only; no Signal code (AGPL) was copied.
- MDN: VisualViewport https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport ; viewport meta and `interactive-widget` https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/meta/name/viewport ; `env()` https://developer.mozilla.org/en-US/docs/Web/CSS/env ; WebKit bug 259770 https://bugs.webkit.org/show_bug.cgi?id=259770 .
