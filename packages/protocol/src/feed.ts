// The live feed's WebSocket, /api/feed (ADR-0004, ADR-0006; Observation and Escalation): every frame type in both
// directions. Output types are the domain's own, so a decoded frame is used as it is.
// What the hub sends is checked for shape, not size (review M1): the hub passes on what tmux and the transcripts hold,
// with no limits of its own, and an app that refused a long window name would sit on "Connecting" forever. An enum
// value a newer hub adds falls back to a safe one, and a list drops only the element that doesn't fit, never the frame.
// What the app sends the hub stays strict, with limits.
import type {
  AnswerRefusal, CatchUpConversation, DecisionBrief, Escalation, EscalationId, EndpointId, FeedBody, FeedEvent, Message, RosterEntry, SessionId, WorkerId,
} from "@morndo/domain";
import { BoardFrameSchema } from "./board.ts";
import { DecisionBriefSchema } from "./brief.ts";
import { JobsFrameSchema } from "./jobs.ts";
import { UsageFrameSchema } from "./usage.ts";
import { isWorkerOrLegacyId } from "./worker-id.ts";
import * as z from "./z.ts";

const str = (max = 100_000) => z.string().check(z.maxLength(max));       // app → hub: limited
const text = () => z.string();                                           // hub → app: any length
// zod's catch: a schema that reads a value it doesn't know as the fallback (named so it isn't taken for Promise.catch).
const orElse = z.catch;
const count = () => z.number().check(z.gte(0));
// A worker the app names: the fleet's `<node>.<server>.<pane>` or a legacy hub's `%N` (worker-id.ts), both, always.
// One build of the app talks to either hub, and only the hub's own configuration (MORNDO_FLEET_SOCKET) decides which.
// Each hub answers an id it doesn't hold as no pane, so an older app's `%N` reaches a fleet hub and fails there as
// no_pane, never as a frame this decoder refused (ADR-0012; spec §4). Zod Mini's refinement: .check(z.refine(…))
// (https://zod.dev/packages/mini, read 2026-10-06).
const workerIdText = z.string().check(z.refine(isWorkerOrLegacyId));
const workerId = z.pipe(workerIdText, z.transform(s => s as WorkerId));
// A roster entry's id isn't checked further here: the hub assigns it.
const anyWorkerId = z.pipe(text(), z.transform(s => s as WorkerId));

// A list from the hub: each element decoded on its own; one that doesn't fit is dropped, the rest kept, and whoever
// listens (the app logs it) is told.
let dropped: (where: string) => void = () => {};
export const onDropped = (fn: (where: string) => void) => { dropped = fn; };
function each<S extends z.ZodMiniType>(schema: S, where: string) {
  return z.pipe(z.array(z.unknown()), z.transform(xs => xs.flatMap(x => {
    const r = z.safeParse(schema, x);
    if (r.success) return [r.data as z.output<S>];
    dropped(where);
    return [];
  })));
}

// `node`: the machine the worker runs on (ADR-0012); a hub from before the fleet doesn't say: "".
const worker = { id: anyWorkerId, name: text(), location: text(), node: orElse(text(), "") };
const state = orElse(z.enum(["active", "quiet"]), "quiet");             // a state from a newer hub: shown as quiet

// What a worker waits for (S6); a hub that doesn't say reads as waiting on nothing.
const waitingOnField = orElse(z.nullable(text()), null);
// Its machine doesn't answer now (fleet core §7); a hub from before the fleet doesn't say: online.
const offline = orElse(z.boolean(), false);

export const RosterEntrySchema = z.object({
  ...worker, title: z.nullable(text()), lastMessageAt: z.nullable(count()), needsYou: z.boolean(), waitingOn: waitingOnField, state, changedAt: count(),
  offline,
});

export const FeedBodySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("WorkerAppeared"), worker: z.object(worker), state, changedAt: count(), offline }),
  z.object({ type: z.literal("WorkerRenamed"), workerId: anyWorkerId, name: text() }),
  z.object({ type: z.literal("WorkerMoved"), workerId: anyWorkerId, location: text() }),
  z.object({ type: z.literal("WorkerBecameActive"), workerId: anyWorkerId, changedAt: count() }),
  z.object({ type: z.literal("WorkerBecameQuiet"), workerId: anyWorkerId, changedAt: count() }),
  // WorkerActivityNoted (an older hub, a note the registry cannot supply) is not a member: decodeEvent treats that
  // type as unknown, so the client keeps its place in the sequence and ignores it.
  z.object({ type: z.literal("WorkerGone"), workerId: anyWorkerId }),
  z.object({ type: z.literal("WorkerTitled"), workerId: anyWorkerId, title: z.nullable(text()) }),
  z.object({ type: z.literal("WorkerSpoke"), workerId: anyWorkerId, at: count() }),
  z.object({ type: z.literal("WorkerNeedsYouChanged"), workerId: anyWorkerId, needsYou: z.boolean(), waitingOn: waitingOnField }),
  z.object({ type: z.literal("WorkerOfflineChanged"), workerId: anyWorkerId, offline: z.boolean() }),
]);
const FEED_BODY_TYPES = new Set(FeedBodySchema._zod.def.options.map(o => o._zod.def.shape.type._zod.def.values[0] as string));

const envelope = { epoch: text(), seq: z.int().check(z.gte(0)), at: count() };
export const FeedEventSchema = z.object({ ...envelope, body: FeedBodySchema });

// One event of an events frame: a body type this build doesn't know (a newer hub) still has its place in the sequence
// (O1), so the client skips it and moves its cursor on; anything else that doesn't fit is malformed.
export type DecodedEvent = { kind: "event"; event: FeedEvent } | { kind: "unknown"; epoch: string; seq: number } | { kind: "malformed" };
const EnvelopeSchema = z.object({ ...envelope, body: z.looseObject({ type: text() }) });
export function decodeEvent(value: unknown): DecodedEvent {
  const env = z.safeParse(EnvelopeSchema, value);
  if (!env.success) return { kind: "malformed" };
  if (!FEED_BODY_TYPES.has(env.data.body.type)) return { kind: "unknown", epoch: env.data.epoch, seq: env.data.seq };
  const full = z.safeParse(FeedEventSchema, value);
  return full.success ? { kind: "event", event: full.data } : { kind: "malformed" };
}

// An attachment's id names the hub's copy and goes into a URL: exactly 32 hex digits, or none. `pending`: that copy is
// still being made; an app from before it (z.object drops keys it doesn't know) shows "not available" until the
// attachments frame below comes.
const AttachmentSchema = z.object({
  id: z.nullable(z.string().check(z.regex(/^[0-9a-f]{32}$/))), name: text(), mime: text(),
  kind: orElse(z.enum(["image", "video", "audio", "pdf", "text", "file"]), "file"), size: z.nullable(count()), caption: z.nullable(text()),
  pending: z.exactOptional(z.literal(true)),
});
const QuestionPartSchema = z.object({
  question: text(), header: z.nullable(text()),
  options: z.array(z.object({ label: text(), description: z.nullable(text()) })), multiSelect: z.boolean(),
});
export const MessageSchema = z.object({
  id: text(), at: count(),
  author: z.object({ kind: orElse(z.enum(["principal", "agent", "peer", "system"]), "system"), name: text() }),
  kind: orElse(z.enum(["text", "activity", "question", "event", "file"]), "event"),
  text: text(),
  tools: z.exactOptional(z.array(text())),
  questionId: z.exactOptional(text()),
  questions: z.exactOptional(z.array(QuestionPartSchema)),
  attachments: z.exactOptional(each(AttachmentSchema, "attachment")),
});
export const SessionInfoSchema = z.nullable(z.object({ name: z.nullable(text()), cwd: text(), version: z.nullable(text()) }));

const REFUSALS = ["unknown", "already_answered", "settled", "expired", "not_filed_yet", "cant_check", "on_screen", "not_a_choice", "bad_option", "empty"] as const;
// A decision whose status or way of answering this app doesn't know is dropped from the list (each), never guessed;
// fields where a safe reading exists fall back to it: an unknown refusal is still a refusal, an unknown source state
// is "can't check" (answers refused, E10), a context of an unknown kind is shown as screen text.
export const DecisionItemSchema = z.object({
  id: z.pipe(text(), z.transform(s => s as EscalationId)),
  asker: z.object({ kind: z.enum(["manager", "worker"]), name: text(), workerId: z.nullable(text()) }),
  need: z.enum(["decision", "time"]),
  title: text(),
  // The asker's short form (2026-10-04); a hub that doesn't send it: none. A link is only ever http(s).
  shortTitle: orElse(z.nullable(text()), null),
  summary: orElse(z.nullable(text()), null),
  minutes: orElse(z.nullable(z.number()), null),
  link: orElse(z.nullable(z.string().check(z.regex(/^https?:\/\//i))), null),
  details: orElse(z.nullable(text()), null),
  context: z.nullable(text()),
  contextKind: orElse(z.enum(["markdown", "screen"]), "screen"),
  options: z.array(z.object({ key: text(), label: text(), detail: z.nullable(text()) })),
  answerBy: z.enum(["tap", "words", "screen"]),
  recommendation: z.nullable(text()),
  ifNoAnswer: z.nullable(text()),
  deadline: z.nullable(z.number()),
  blocking: z.boolean(),
  project: z.nullable(text()),
  askedAt: z.number(),
  messageId: z.nullable(text()),
  tracking: z.enum(["ledger", "age", "source", "hub"]),
  status: z.enum(["open", "answered", "settled", "expired"]),
  source: orElse(z.enum(["open", "settled", "missing", "unreadable"]), "unreadable"),
  decision: z.nullable(z.object({
    choice: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("option"), key: text(), label: text() }),
      z.object({ kind: z.literal("words") }),
    ]),
    at: z.number(),
    via: orElse(z.enum(["here", "elsewhere"]), "elsewhere"),
    endpointId: z.nullable(z.pipe(text(), z.transform(s => s as EndpointId))),
    sessionId: z.nullable(z.pipe(text(), z.transform(s => s as SessionId))),
    // ADR-0010: a Decision for the manager waits in its inbox ("queued") until it reached the manager ("delivered").
    // A state this app doesn't know reads as queued: it never claims a delivery it can't vouch for.
    delivery: z.optional(z.object({ state: orElse(z.enum(["queued", "delivered"]), "queued"), at: z.nullable(z.number()) })),
  })),
  resolution: z.nullable(text()),
  settledAt: z.nullable(z.number()),
  askedAgain: z.boolean(),
  answerable: z.nullable(orElse(z.enum(REFUSALS), "unknown")),
  version: orElse(text(), ""),                                 // askVersion; a hub that doesn't say: "" (never matches)
  // While a Decision waits in the manager's inbox: where it stands there (its status and why it waits). A hub that
  // doesn't say: null.
  inbox: orElse(z.nullable(z.object({ status: text(), reason: z.nullable(text()) })), null),
  // A sentence on an open card: the answer reached the manager late, or did not reach the manager (ADR-0010 addendum).
  // A hub that doesn't say: none.
  notice: z.exactOptional(z.nullable(text())),
  // ADR-0023: the brief this ask was filed from and its version. A hub that doesn't send them (an older hub, or a plain
  // ask), or a brief this app can't read: none and zero — never a half brief, the card falls back to the plain fields.
  brief: orElse(z.nullable(DecisionBriefSchema), null),
  briefVersion: orElse(z.number(), 0),
  // Who drafted a forwarded brief. A hub that doesn't say, or a plain ask: null.
  draftedBy: orElse(z.nullable(text()), null),
});
export const LedgerStateSchema = z.object({ configured: z.boolean(), ok: z.boolean(), at: z.nullable(z.number()) });

// Catch-up (ADR-0009, C5): what one Conversation brings since its Read mark: the newest messages to show and the whole
// of it in counts. A claim this app doesn't know reads as none.
export const CatchUpConversationSchema = z.object({
  worker: anyWorkerId, name: text(), mark: z.nullable(count()), messages: each(MessageSchema, "message"),
  count: count(), firstAt: z.nullable(count()), lastAt: z.nullable(count()), tools: count(), toolNames: z.array(text()), files: count(),
  claim: orElse(z.nullable(z.enum(["says_done"])), null),           // no "checked": nothing can set it (2026-10-04)
});

// Chats (ADR-0011, H1): one row of the phone's chat list: the newest message it previews, the agent's latest words (its
// status line is made from them), how many messages that matter came after the Read mark, and the time of its last.
export const ChatRowSchema = z.object({
  worker: anyWorkerId, name: text(), last: z.nullable(MessageSchema), answer: z.nullable(MessageSchema), unread: count(), lastAt: z.nullable(count()),
  repliedAt: z.exactOptional(z.nullable(count())),
});

// Hub → app.
export const ServerFeedFrames = {
  snapshot: z.object({ t: z.literal("snapshot"), epoch: text(), seq: z.int().check(z.gte(0)), workers: each(RosterEntrySchema, "worker") }),
  // Events are decoded one by one (decodeEvent), so one of an unknown type doesn't drop its neighbours.
  events: z.object({ t: z.literal("events"), events: z.array(z.unknown()), caughtUp: z.exactOptional(z.boolean()) }),
  screen: z.object({ t: z.literal("screen"), worker: workerId, text: text(), at: count() }),
  history: z.object({ t: z.literal("history"), worker: workerId, messages: each(MessageSchema, "message"), session: SessionInfoSchema }),
  messages: z.object({ t: z.literal("messages"), worker: workerId, messages: each(MessageSchema, "message") }),
  details: z.object({ t: z.literal("details"), worker: workerId, session: SessionInfoSchema }),
  decisions: z.object({ t: z.literal("decisions"), items: each(DecisionItemSchema, "decision"), ledger: LedgerStateSchema }),
  pong: z.object({ t: z.literal("pong"), n: z.int().check(z.gte(0)) }),     // phase B: the answer to the app's ping n
  // Phase D: read marks and mute per Conversation (by the worker's name), all of them after each hello, then changes.
  reading: z.object({ t: z.literal("reading"), reads: z.record(text(), count()), muted: z.array(text()) }),
  read: z.object({ t: z.literal("read"), conversation: text(), at: count() }),
  mute: z.object({ t: z.literal("mute"), conversation: text(), muted: z.boolean() }),
  // Phase E (AC13): a device was added from an Endpoint or a Link request (`by`: the one that added it), live, or
  // after a hello while this device hasn't seen it.
  linked: z.object({ t: z.literal("linked"), name: text(), at: count(), by: z.exactOptional(z.nullable(text())) }),
  // An older page (O9): the messages before `before`, oldest first; `done`: nothing older is left; `missing`: the hub
  // couldn't read it (an unknown worker, or `before` isn't in its transcript): not the beginning (review L1).
  older: z.object({
    t: z.literal("older"), worker: workerId, before: text(), messages: each(MessageSchema, "message"), done: z.boolean(),
    missing: z.exactOptional(z.boolean()),
  }),
  // Catch-up (ADR-0009): the unmuted conversations with something new since their Read mark (C5), all of them, or only
  // the one asked for (`only`); and when the principal last finished one (C7), after a hello and on every change.
  catchup: z.object({ t: z.literal("catchup"), only: z.exactOptional(anyWorkerId), conversations: each(CatchUpConversationSchema, "conversation") }),
  caught_up: z.object({ t: z.literal("caught_up"), at: z.nullable(count()) }),
  // Fleet core §3.1: a message's files, once the hub's copies of them were made (they showed as pending): they replace
  // that message's attachments, wherever the app holds it (the latest messages or an older page). An app from before
  // this frame ignores it, as any frame type it doesn't know.
  attachments: z.object({ t: z.literal("attachments"), worker: workerId, message: text(), attachments: each(AttachmentSchema, "attachment") }),
  // Fleet core §7: whether the hub can reach the fleet service, after every hello and on every change. While it can't,
  // every worker is listed offline (its state unknown) and the app says so. A hub from before the fleet never sends it:
  // the app reads that as available.
  fleet: z.object({ t: z.literal("fleet"), available: z.boolean() }),
  // ADR-0015: the team's board, whole, after every hello and on every change (each task decoded on its own by the app).
  board: BoardFrameSchema,
  // ADR-0016: every connected account's usage, whole, after every hello and whenever a report changed it.
  usage: UsageFrameSchema,
  // Background jobs (design §7): the fleet mirror's list and the counts beside each node, after every hello and on change.
  jobs: JobsFrameSchema,
  // ADR-0011: the chat list (H1, H2); what each unmuted conversation brought since he left, for the digest (H5); and
  // when he was last active on any other device (H4), after a hello and when asked.
  chats: z.object({ t: z.literal("chats"), chats: each(ChatRowSchema, "chat") }),
  digest: z.object({ t: z.literal("digest"), since: count(), conversations: each(CatchUpConversationSchema, "conversation") }),
  presence: z.object({ t: z.literal("presence"), elsewhere: z.nullable(count()) }),
};

// App → hub.
export const ClientFeedFrames = {
  hello: z.object({ t: z.literal("hello"), epoch: z.exactOptional(str(100)), cursor: z.exactOptional(z.int().check(z.gte(0))), layout: z.exactOptional(str(16)) }),
  details: z.object({ t: z.literal("details"), worker: workerIdText }),
  watch: z.object({ t: z.literal("watch"), worker: z.nullable(workerIdText) }),
  ping: z.object({ t: z.literal("ping"), n: z.int().check(z.gte(0)) }),     // phase B: is this socket still alive?
  // Phase D: the principal read a Conversation up to `at` (O7), muted or unmuted it, or wants an older page (O9).
  read: z.object({ t: z.literal("read"), conversation: str(200).check(z.minLength(1)), at: count() }),
  mute: z.object({ t: z.literal("mute"), conversation: str(200).check(z.minLength(1)), muted: z.boolean() }),
  older: z.object({ t: z.literal("older"), worker: workerIdText, before: str(500).check(z.minLength(1)) }),
  // Phase E (AC13): this device has seen the additions up to `at` (dismissed or reviewed).
  linked_seen: z.object({ t: z.literal("linked_seen"), at: count() }),
  // Phase F (N3): whether the principal is attending on this device: its window has focus and saw his input in the
  // last 2 minutes. Sent on change, and again while it stays true.
  visible: z.object({ t: z.literal("visible"), v: z.boolean() }),
  // Catch-up (ADR-0009): what is new since the Read marks, for every conversation or one; and the end of a run (C7).
  catchup: z.object({ t: z.literal("catchup"), worker: z.exactOptional(workerIdText) }),
  caught_up: z.object({ t: z.literal("caught_up"), at: count() }),
  // ADR-0011: the chat list, the digest since he left, and when he was last active elsewhere.
  chats: z.object({ t: z.literal("chats") }),
  digest: z.object({ t: z.literal("digest"), since: count() }),
  presence: z.object({ t: z.literal("presence") }),
};

export type ServerFeedFrame = { [K in keyof typeof ServerFeedFrames]: z.output<(typeof ServerFeedFrames)[K]> }[keyof typeof ServerFeedFrames];
export type ClientFeedFrame = { [K in keyof typeof ClientFeedFrames]: z.output<(typeof ClientFeedFrames)[K]> }[keyof typeof ClientFeedFrames];
export type InboxWait = { status: string; reason: string | null };
export type DecisionItem = Escalation & { answerable: AnswerRefusal | null; version: string; inbox: InboxWait | null; notice?: string | null; brief: DecisionBrief | null; briefVersion: number; draftedBy: string | null };
export type LedgerState = z.output<typeof LedgerStateSchema>;
export type SessionInfoWire = z.output<typeof SessionInfoSchema>;
export type CatchUpConversationWire = z.output<typeof CatchUpConversationSchema>;
export type ChatRowWire = z.output<typeof ChatRowSchema>;

// The decoded shapes are the domain's own (checked at compile time): a frame needs no cast where it's used.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const check = <T extends true>(t: T) => t;
check<Same<z.output<typeof RosterEntrySchema>, RosterEntry>>(true);
check<Same<z.output<typeof FeedBodySchema>, FeedBody>>(true);
check<Same<z.output<typeof FeedEventSchema>, FeedEvent>>(true);
check<Same<z.output<typeof MessageSchema>, Message>>(true);
check<Same<z.output<typeof DecisionItemSchema>, DecisionItem>>(true);
check<Same<z.output<typeof CatchUpConversationSchema>, CatchUpConversation>>(true);
