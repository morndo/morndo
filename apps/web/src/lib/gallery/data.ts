// Synthetic data for the dev-only state gallery (ADR-0008 phase G): made-up workers, messages, sends and decisions,
// nothing captured from a real office. Every id carries the gallery's marker, so the build check finds this file in a
// production build if it ever gets there (scripts/check-build.ts).
import type { Message, RosterEntry, WorkerId } from "@morndo/domain";
import type { ConversationPrefs } from "../desktop/present.ts";
import type { DecisionItem } from "../desktop/decisions.ts";
import type { Outgoing } from "../desktop/MessageList.svelte";

export const MARK = "morndo-gallery";
const MIN = 60_000, HOUR = 60 * MIN;

export function worker(name: string, over: Partial<RosterEntry> = {}): RosterEntry {
  return {
    id: `${MARK}-${name}` as WorkerId, name, location: "%0", node: MARK, offline: false, title: null, lastMessageAt: null, needsYou: false, waitingOn: null,
    state: "quiet", changedAt: 0, ...over,
  };
}

// Sidebar rows: unread, muted, selected, needs-you, working, idle, starred, offline.
export function roster(now: number) {
  const manager = worker("manager", { title: "Chief of staff", state: "active", lastMessageAt: now - 2 * MIN });
  const workers = [
    manager,
    worker("api-docs", { title: "Rewrite the API reference", state: "active", lastMessageAt: now - 5 * MIN }),
    worker("billing", { title: "Invoice export (needs you)", needsYou: true, waitingOn: "q-1", lastMessageAt: now - 1 * MIN }),
    worker("search", { title: "Faster search (selected)", state: "active", lastMessageAt: now - 9 * MIN }),
    worker("newsletter", { title: "Weekly newsletter (muted)", lastMessageAt: now - 3 * HOUR }),
    worker("onboarding", { title: "Signup flow (unread)", lastMessageAt: now - 20 * MIN }),
    worker("release", { title: "Release notes (starred)", lastMessageAt: now - 2 * HOUR }),
    worker("nightly", { title: "Nightly build (offline)", offline: true, lastMessageAt: now - 4 * HOUR }),
  ];
  const prefs: Record<string, Partial<ConversationPrefs>> = { newsletter: { muted: true }, release: { starred: true } };
  return {
    manager, workers, selected: workers[3]?.id ?? null,
    unread: (w: RosterEntry) => w.name === "onboarding" || w.name === "billing",
    prefsOf: (name: string): ConversationPrefs => ({ show: "clean", activity: true, muted: false, starred: false, ...prefs[name] }),
  };
}

let n = 0;
const msg = (at: number, author: Message["author"], text: string, over: Partial<Message> = {}): Message =>
  ({ id: `${MARK}-m${++n}`, at, author, kind: "text", text, ...over });
const agent = { kind: "agent", name: "search" } as const, you = { kind: "principal", name: "You" } as const;

// A conversation: read up to `readUpTo`, then new messages after it (the "New messages" divider goes before them).
export function conversation(now: number) {
  const messages = [
    msg(now - 50 * MIN, you, "Can the search answer in under 200 ms for the demo data?"),
    msg(now - 48 * MIN, agent, "Looking at it. The slow part is the **ranking** step: it sorts every match before cutting to 20."),
    msg(now - 47 * MIN, agent, "", { kind: "activity", tools: ["Read", "Grep", "Bash"] }),
    msg(now - 40 * MIN, agent, "A partial sort brings it from 640 ms to 150 ms on the demo set:\n\n```\nbefore 640 ms\nafter  150 ms\n```"),
    msg(now - 12 * MIN, agent, "Tests pass. Should I also cache the last 50 queries?"),
    msg(now - 8 * MIN, agent, "Opened the change for review; the cache can come later."),
    msg(now - 3 * MIN, agent, "Review is green. Waiting for your go to merge."),
  ];
  return { messages, readUpTo: now - 30 * MIN };
}

// One outgoing message in each send state (S8), oldest first, so none is held behind a failed one but the last.
export function sends(now: number): Outgoing[] {
  const base = { worker: `${MARK}-search`, workerName: "search", uploads: [], seen: "", images: [] as string[] };
  const send = (id: string, at: number, text: string, over: Partial<Outgoing>): Outgoing =>
    ({ ...base, id: `${MARK}-${id}`, text, createdAt: at, budgetFrom: at, state: "queued", error: null, attempts: 0, sentAt: null, typedAt: null, ...over });
  return [
    send("queued", now - 9 * MIN, "Queued: written down, not tried yet.", {}),
    send("retrying", now - 8 * MIN, "Waiting to send: the first try didn't reach the hub.", { attempts: 2 }),
    send("sending", now - 7 * MIN, "Sending: the hub is typing it.", { state: "sending", attempts: 1 }),
    send("sent", now - 6 * MIN, "Sent, and the hub typed it a moment ago.", { state: "sent", attempts: 1, sentAt: now - 30_000, typedAt: now - 30_000 }),
    send("unseen", now - 30 * MIN, "Sent, but not in the conversation after 10 minutes.", { state: "sent", attempts: 1, sentAt: now - 20 * MIN, typedAt: now - 20 * MIN }),
    send("step-up", now - 5 * MIN, "Not sent until a passkey check.", { state: "failed", error: "step_up", attempts: 1 }),
    send("stale", now - 4 * MIN, "Not sent: the question changed meanwhile.", { state: "failed", error: "stale", attempts: 1 }),
    send("timeout", now - 3 * MIN, "Not sent: the hub didn't answer in time.", { state: "failed", error: "timeout", attempts: 4 }),
    send("menu", now - 2 * MIN, "Not sent: the worker shows a menu.", { state: "failed", error: "menu_open", attempts: 1 }),
    send("uncertain", now - 1 * MIN, "May have been sent: the hub stopped while typing.", { state: "uncertain", error: "uncertain", attempts: 1 }),
    send("held", now - 30_000, "Waiting for the message above.", {}),
    send("inbox", now - 20_000, "Queued in the manager's inbox: it will be delivered.", { state: "sent", sentAt: now - 20_000, attempts: 1, queued: true }),
  ];
}

// A decision in each state the panel and the chat show: blocking, overdue, soon, normal, in words, on screen, answers
// paused, answered, settled.
export function decisions(now: number): { label: string; item: DecisionItem }[] {
  const d = (id: string, over: Partial<DecisionItem>): DecisionItem => ({
    id: `${MARK}-${id}` as DecisionItem["id"], asker: { kind: "manager", name: "manager", workerId: `${MARK}-manager` },
    need: "decision", title: "Ship the faster search on Friday?", shortTitle: null, summary: null, minutes: null, link: null, details: null,
    context: "The review is green; the demo is on Monday.", contextKind: "markdown",
    options: [{ key: "a", label: "Ship Friday", detail: "Before the demo" }, { key: "b", label: "Wait a week", detail: null }],
    answerBy: "tap", recommendation: "Ship Friday: the change is small and reviewed.", ifNoAnswer: "It waits; nothing ships.",
    deadline: null, blocking: false, project: "Search", askedAt: now - 40 * MIN, messageId: null, tracking: "ledger",
    status: "open", source: "open", decision: null, resolution: null, settledAt: null, askedAgain: false, answerable: null, version: `v-${id}`, inbox: null, ...over,
  });
  return [
    { label: "Blocking", item: d("blocking", { blocking: true, title: "Use the new billing provider's sandbox keys?" }) },
    { label: "Overdue", item: d("overdue", { deadline: now - 3 * HOUR, title: "Approve the newsletter draft?" }) },
    { label: "Due soon", item: d("soon", { deadline: now + 5 * HOUR }) },
    { label: "Normal, asked again", item: d("normal", { askedAgain: true, recommendation: null, title: "Which name for the export button?" }) },
    { label: "Answered in words", item: d("words", { answerBy: "words", options: [], title: "What should the release notes lead with?" }) },
    { label: "A worker's question, answered on its screen", item: d("screen", { asker: { kind: "worker", name: "billing", workerId: `${MARK}-billing` }, answerBy: "screen", contextKind: "screen", context: "? Overwrite the existing export? (y/N)", options: [], tracking: "age", recommendation: null, ifNoAnswer: null }) },
    { label: "Answers paused (list unreadable)", item: d("paused", { source: "unreadable", answerable: "cant_check" }) },
    { label: "Answered here", item: d("answered", { status: "answered", decision: { choice: { kind: "option", key: "a", label: "Ship Friday" }, at: now - 5 * MIN, via: "here", endpointId: null, sessionId: null } }) },
    { label: "Answered, queued in the manager's inbox (its box has someone's text)", item: d("queued", { status: "answered", decision: { choice: { kind: "option", key: "a", label: "Ship Friday" }, at: now - 2 * MIN, via: "here", endpointId: null, sessionId: null, delivery: { state: "queued", at: null } }, inbox: { status: "held", reason: "foreign_text" } }) },
    { label: "Answered, delivered to the manager", item: d("delivered", { status: "answered", decision: { choice: { kind: "option", key: "a", label: "Ship Friday" }, at: now - 9 * MIN, via: "here", endpointId: null, sessionId: null, delivery: { state: "delivered", at: now - 8 * MIN } } }) },
    { label: "Settled", item: d("settled", { status: "settled", decision: { choice: { kind: "option", key: "b", label: "Wait a week" }, at: now - 2 * HOUR, via: "elsewhere", endpointId: null, sessionId: null }, resolution: "Moved to next week.", settledAt: now - HOUR }) },
  ];
}
