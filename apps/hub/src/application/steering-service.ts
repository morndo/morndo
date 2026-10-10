// Sending text into a worker (ADR-0006, AC7): a recently verified session, no menu open, an empty input line,
// each request once, and an audit entry with the text's length and a hash, never the text itself. Images the
// principal attached (S1–S3) travel as notes naming their files after his text: each is first put on the worker's own
// machine (UploadSink, fleet core §3.1), and one that can't be is a refusal before anything is typed.
// ADR-0008 phase C: the dedupe is durable (S5): a request id is recorded "started" before it is typed and "done" after,
// so after a restart a repeat is "duplicate" (done) or "uncertain" (the hub stopped while typing it), never typed twice.
// The same key goes with the text to the node (fleet core §3.1), so a node that typed it already doesn't type it again.
// And a Command is judged on arrival against the needs-you state it was written for (S6): "stale" if that changed.
import { createHash } from "node:crypto";
import { DEFAULT_POLICY, attachable, commandText, mayCommand, type AccessEvent, type AccessPolicy, type AttachRefusal } from "@morndo/domain";
import type { SendProblem } from "@morndo/node-ops";
import { LIMITS } from "@morndo/protocol";
import { ownerFileNote } from "../adapters/attachment-note.ts";
import { localUploads } from "../adapters/local-node.ts";
import type { Inbox } from "../adapters/uploads.ts";
import type { Store } from "../adapters/store.ts";
import { SENDER, cleanText, inboxKey, type InboxState, type InboxStatus, type ManagerInbox } from "../adapters/manager-inbox.ts";
import type { Authenticated } from "./access-service.ts";
import { SEND_REFUSALS, SendInDoubt, type SendOutcome, type SendRefused, type SendStatus, type Tmux, type UploadSink } from "./ports.ts";
import { log } from "../adapters/log.ts";

// `at`: when the node typed it, on that node's clock, which its transcript's times are on: the app matches the echo by
// it (fleet core §3.1; before, the hub's own clock, review M2). `queued`: handed to the manager's inbox (ADR-0010),
// which types it exactly once; the echo in the conversation ends it.
export type SendResult =
  | { ok: true; at: number; queued?: true }
  | { ok: false; problem: "duplicate"; at: number; queued?: true; inbox?: string; reason?: string | null }
  | { ok: false; problem: SendProblem | AttachRefusal | SendRefused | "step_up" | "empty" | "too_long" | "uncertain" | "stale" | "too_large" | "node_offline" | "not_delivered" | "unavailable" | "cannot_resend" };

// Refusals that come before anything is pasted (tmux.ts, and a fleet's "node_offline", executed "no"): nothing reached
// the pane, so a retry may type it. A "not_submitted" comes after the paste, and a throw can't tell: those keep their
// row, and a repeat asks the node (op.status) when there is one, else is "uncertain".
const COMMAND_BUDGET_MS = 2 * 60_000;
const BEFORE_PASTE = new Set<SendOutcome["problem"]>(["no_pane", "menu_open", "no_input_box", "draft_present", "busy", "node_offline"]);
// A node's or the fleet's definite refusal (ports.ts SEND_REFUSALS: executed "no", nothing ran): the row goes as well, so
// a retry types once the cause is fixed instead of answering "uncertain" for ever (final review M1).
const REFUSED = new Set<SendOutcome["problem"]>(SEND_REFUSALS);
// Whether a problem says nothing reached the pane (either set above), so its row goes: a send's here, an escalation
// answer's in EscalationService, which keeps its rows as a send does.
export const nothingTyped = (problem: SendOutcome["problem"]): boolean => BEFORE_PASTE.has(problem) || REFUSED.has(problem);
// Queued or held, and never pasted. A typed command (attempts at least 1, or accepted/sent/stuck) keeps its place.
const untypedWaiting = (s: InboxState) => (s.status === "queued" || s.status === "held") && s.attempts === 0;
const pastDeadline = (inbox: ManagerInbox, key: string, now: number) => {
  const deadline = inbox.deadline(key);
  return deadline !== null && now > deadline;
};
// A plain repeat (the phone's Send again) may queue once more only in these (ADR-0011). Not "lost": that waits for a person.
const GIVEN_UP = new Set<InboxStatus>(["expired", "cancelled", "gone"]);

// What a keyed send's row keeps once its node has answered, the same for a send and for an escalation answer (S5): the
// store it went to; then nothing reached the pane (the row goes), "not_submitted" (it keeps its row), or typed (done).
export function settleOutcome(store: Pick<Store, "setSendStore" | "dropSend" | "finishSend">, key: string, outcome: SendOutcome): void {
  if (outcome.store) store.setSendStore(key, outcome.store, outcome.storeSeq ?? null);
  if (outcome.problem) { if (nothingTyped(outcome.problem)) store.dropSend(key); return; }
  store.finishSend(key, outcome.typedAt);
}
// A node that may have typed it (SendInDoubt) keeps the store it went to and how far it was, for a repeat to ask.
export function keepInDoubt(store: Pick<Store, "setSendStore">, key: string, e: SendInDoubt): void {
  if (e.store !== null) store.setSendStore(key, e.store, e.storeSeq);
}

const MAX_TEXT = LIMITS.maxSendText;

export class SteeringService {
  #store: Store;
  #tmux: Pick<Tmux, "send">;
  #now: () => number;
  #typing = new Map<string, Promise<SendResult>>();          // sends being staged or typed by this process, by request key
  #policy: () => AccessPolicy;
  #inbox: Pick<Inbox, "get"> | null;
  #waitingOn: (workerId: string) => string;
  #nameOf: (workerId: string) => string | null;
  #uploads: UploadSink;
  #status: SendStatus | null;                                // the fleet's op.status; null: the legacy hub, nobody else knows
  #manager: { isManager: (workerId: string) => boolean; inbox: ManagerInbox } | null;

  constructor(
    store: Store, tmux: Pick<Tmux, "send">, now: () => number = Date.now, policy: () => AccessPolicy = () => DEFAULT_POLICY,
    inbox: Pick<Inbox, "get"> | null = null, waitingOn: (workerId: string) => string = () => "none",
    nameOf: (workerId: string) => string | null = () => null, uploads: UploadSink = localUploads(),
    status: SendStatus | null = null,
    manager: { isManager: (workerId: string) => boolean; inbox: ManagerInbox } | null = null,
  ) {
    this.#status = status;
    this.#manager = manager;
    this.#nameOf = nameOf;
    this.#inbox = inbox;
    this.#store = store;
    this.#tmux = tmux;
    this.#now = now;
    this.#policy = policy;
    this.#waitingOn = waitingOn;
    this.#uploads = uploads;
  }

  // A queued command still untyped after its deadline. The deliverer does this until a retry, which clears the
  // deadline; this withdraws the revived one even when no phone is asking (round 3.5). Answers are not here.
  withdrawOverdue() {
    const manager = this.#manager;
    if (!manager) return;
    const now = this.#now();
    for (const key of this.#store.queuedCommands()) {
      const commandKey = inboxKey(SENDER, `command:${key}`);
      const spool = manager.inbox.state(commandKey);
      if (!spool || !untypedWaiting(spool) || !pastDeadline(manager.inbox, commandKey, now)) continue;
      manager.inbox.cancel(commandKey);
    }
  }

  // `seen`: the needs-you state the principal wrote it for ("none", or a question or menu id); absent, no check.
  // `name`: the worker it was written to; a pane that now runs another agent is no longer that worker (review M2).
  async send(a: Authenticated, workerId: string, text: string, requestId: string, uploads: string[] = [], seen?: string, name?: string, createdAt?: number, retry = false, again = false): Promise<SendResult> {
    const now = this.#now();
    const key = `${a.endpoint.id}:${requestId}`;
    // A repeat first: it may come after the window or the worker moved on, and must still learn what became of it.
    // While this process is still staging or typing it, the repeat waits for the outcome (the web client counts
    // "duplicate" as delivered, so it may only come once the text is in; a refusal is passed on as it is).
    const typing = this.#typing.get(key);
    if (typing) {
      const first = await typing;
      return first.ok ? { ok: false, problem: "duplicate", at: first.at, ...(first.queued ? { queued: true as const } : {}) } : first;
    }
    const known = this.#store.send(key);
    // An explicit Send again (again: true) queues the text once more, under command:<key>:again, only after the
    // inbox gave the first up, and only after the same checks as a first send. A plain repeat is a status read:
    // it answers the inbox state below and never queues, so a lapsed passkey check does not turn a poll into a 403.
    // The row is then "requeued", so a further Send again adds nothing.
    if (!retry && again && known?.state === "done" && known.outcome === "queued" && this.#givenUp(workerId, key)) {
      const refused = this.#maySend(a, workerId, now, seen, name);
      if (refused) return refused;
      if (!this.#manager?.inbox.accepting()) return { ok: false, problem: "unavailable" };
      const second = this.#queueAgain(a, workerId, key, text, uploads, now);
      if (second === "queued") return { ok: true, at: now, queued: true };
      // A lasting refusal (the uploads expired, or the body is empty or too long) will not change on a retry.
      if (second === "refused") return { ok: false, problem: "cannot_resend" };
      // The second copy is already on disk: answer its state below. A write that never landed is tried again.
      const placed = this.#manager.inbox.state(inboxKey(SENDER, `command:${key}:again`));
      if (!placed || placed.status === "gone") return { ok: false, problem: "unavailable" };
    }
    if (known?.state === "done") {
      // Where the spool left the live copy. After Send again that is command:<key>:again; Retry renews that one.
      const liveId = known.outcome === "requeued" ? `command:${key}:again` : `command:${key}`;
      let spool = (known.outcome === "queued" || known.outcome === "requeued") && this.#manager?.isManager(workerId)
        ? this.#manager.inbox.state(inboxKey(SENDER, liveId)) : null;
      const commandKey = inboxKey(SENDER, liveId);
      // Only the owner's Retry asks the deliverer to run an expired, lost or cancelled command again, and only
      // after the same checks as any other send. A message that is gone cannot be retried (round 2.4, 2.5).
      // The deadline starts again: the deliverer ignores notAfter once it has retried (round 3.5).
      if (retry && spool && this.#manager && (spool.status === "expired" || spool.status === "lost" || spool.status === "cancelled")) {
        const refused = this.#maySend(a, workerId, now, seen, name);
        if (refused) return refused;
        // Nobody is emptying the inbox: type it directly, as enqueue does, instead of a retry file nothing reads (round 3.6).
        // The spool copy is cancelled first, and only once that file is written: a lost or still-queued copy would be
        // typed again when the deliverer returns (round 3).
        if (!this.#manager.inbox.accepting()) {
          if (!this.#manager.inbox.cancel(commandKey)) {
            return { ok: false, problem: "duplicate", at: known.typedAt ?? known.at, queued: true, inbox: spool.status, reason: spool.reason };
          }
          const prepared = await this.#prepare(a, workerId, text, uploads, now);
          if (!prepared.ok) return prepared;
          log.info(`send to ${workerId}: the manager's inbox is not being delivered; typing directly`);
          return this.#type(key, workerId, prepared.body, () => this.#commandSent(a, workerId, prepared.body, uploads.length, now));
        }
        if (!this.#manager.inbox.renew(commandKey, now + COMMAND_BUDGET_MS)) {
          // The message file is gone: there is nothing for the deliverer to type again.
          return { ok: false, problem: "not_delivered" };
        }
        this.#manager.inbox.retry(commandKey);
        return { ok: true, at: now, queued: true };
      }
      // Still untyped past its deadline. A retry sets `retried` and the deliverer then never expires it, so the hub
      // withdraws it and says expired. A command already typed is left alone. The state file may still say held until
      // the deliverer applies the cancel, so this answer says expired from the withdrawal itself.
      let withdrew = false;
      if (spool && this.#manager && untypedWaiting(spool) && pastDeadline(this.#manager.inbox, commandKey, now)) {
        this.#manager.inbox.cancel(commandKey);
        spool = { ...spool, status: "expired" };
        withdrew = true;
      }
      // Already delivered: the owner's Retry is that fact, not a refusal that would make them type it again (round 3.4).
      if (retry && spool?.status === "delivered") return { ok: true, at: spool.deliveredAt ?? known.typedAt ?? known.at ?? now };
      if (retry && spool?.status === "gone") return { ok: false, problem: "not_delivered" };
      // The spool's own word travels with the duplicate, so the app can say accepted, sent, stuck or unconfirmed
      // instead of deciding "Not sent" from the clock (round 2.2). After Send again, that word is the second copy's.
      const reported = withdrew ? null : this.inboxState(a, workerId, requestId);
      const place = reported ? { inbox: reported.status, reason: reported.reason } : spool ? { inbox: spool.status, reason: spool.reason } : {};
      const stillQueued = known.outcome === "queued" || known.outcome === "requeued";
      return { ok: false, problem: "duplicate", at: known.typedAt ?? known.at, ...(stillQueued ? { queued: true as const, ...place } : {}) };
    }
    // Registered before the first await (the node asked about a send in doubt, the images staged), so a repeat arriving
    // meanwhile waits for this one: two repeats of a send in doubt at once paste it at most once.
    const job = this.#judge(a, key, workerId, text, uploads, now, known?.state === "started", seen, name, createdAt);
    this.#typing.set(key, job);
    try { return await job; }
    finally { this.#typing.delete(key); }
  }

  // A send in doubt is settled with its node first; then the send is judged on arrival and typed.
  async #judge(a: Authenticated, key: string, workerId: string, text: string, uploads: string[], now: number, inDoubt: boolean, seen?: string, name?: string, createdAt?: number): Promise<SendResult> {
    if (inDoubt) {
      // Typed there after all: audited now (ADR-0006, every send), as its first attempt couldn't be (it was in doubt). Its
      // body is the repeat's text; the notes naming its images, if any, aren't known again, so only their count is.
      const audited = (typedAt: number) => this.#store.record([this.#commandSent(a, workerId, commandText(text.replace(/\r\n/g, "\n"), []), uploads.length, typedAt)]);
      const settled = await this.#settle(key, workerId, audited);
      if (settled) return settled;                       // still in doubt, or typed after all; null: never started, judged anew
    }
    const refused = this.#maySend(a, workerId, now, seen, name);
    if (refused) return refused;
    return this.#stageAndType(a, key, workerId, text, uploads, now, createdAt);
  }

  // The checks every path runs before anything is typed: a recent verification, the question the command was written
  // for, and the worker that pane runs now (review M2). An explicit Retry of an expired command uses the same ones.
  #maySend(a: Authenticated, workerId: string, now: number, seen?: string, name?: string): SendResult | null {
    if (!mayCommand(a.session, now, this.#policy())) return { ok: false, problem: "step_up" };
    if (seen !== undefined && seen !== this.#waitingOn(workerId)) {
      log.info(`send to ${workerId} refused: stale (written for ${seen === "none" ? "no question" : "another question"})`);
      return { ok: false, problem: "stale" };
    }
    const current = name === undefined ? null : this.#nameOf(workerId);
    if (current !== null && current !== name) {
      log.info(`send to ${workerId} refused: written to another worker than the one there now`);
      return { ok: false, problem: "no_pane" };
    }
    return null;
  }

  // The same settling for another row in doubt: an escalation answer whose node may have typed it (EscalationService,
  // final review C1). The caller keeps its own repeats apart (one answer per escalation at a time).
  settleInDoubt(key: string, workerId: string): Promise<SendResult | null> { return this.#settle(key, workerId); }

  // A repeat of a send this hub recorded "started" and never finished: the hub stopped, or the connection dropped,
  // while it was being typed. Without a fleet nobody else knows: "uncertain", as before. With one, the node's record
  // of the key decides (spec §3.1):
  // - done → "duplicate" with the node's own typedAt (what the echo is matched by), recorded done here too;
  // - unknown, from the store the send went to → it never started there, so the row goes and the send is judged and
  //   typed as a new one (null);
  // - unknown from another store (a new or restored agent database, whose keys are gone), or with no store recorded
  //   (no answer ever came) → "uncertain": nobody can say it wasn't typed;
  // - unknown from that same store, but at a lower store sequence than the one kept with the send → "uncertain": that
  //   database went backwards (put back in place from an older copy, a VM snapshot), so it may have lost the key with
  //   whatever came after the copy (final review I2, the store sequence). When either sequence is missing (an agent or a
  //   fleet from before it, a send whose answer never came), the stores alone decide, as before;
  // - started, or the node can't be asked → "uncertain".
  // A repeat while this process is still settling or typing it never gets here: it waits for that outcome (above). The
  // row is read again after the node answered.
  async #settle(key: string, workerId: string, typedThere: (typedAt: number) => void = () => {}): Promise<SendResult | null> {
    if (!this.#status) return { ok: false, problem: "uncertain" };
    let s: Awaited<ReturnType<SendStatus>>;
    try { s = await this.#status(workerId, key); }
    catch (e) { log.warn(`the state of a send to ${workerId} can't be asked; the repeat stays uncertain`, e); return { ok: false, problem: "uncertain" }; }
    const row = this.#store.send(key);
    if (!row) return null;                                         // gone meanwhile: judged anew
    if (row.state === "done") return { ok: false, problem: "duplicate", at: row.typedAt ?? row.at, ...(row.outcome === "queued" ? { queued: true as const } : {}) };
    if (s.state === "done") { this.#store.finishSend(key, s.typedAt); typedThere(s.typedAt); return { ok: false, problem: "duplicate", at: s.typedAt }; }
    if (s.state === "unknown") {
      if (row.store === null || row.store !== s.store) {
        log.warn(`a send to ${workerId} in doubt: its node answers from another store than the one the send went to; it stays uncertain`);
        return { ok: false, problem: "uncertain" };
      }
      // Both sequences known: one lower now than the send saw means the database went backwards. Either missing: the
      // store comparison above is all there is (today's behaviour for an agent or a fleet that sends none).
      if (row.storeSeq !== null && s.storeSeq !== null && s.storeSeq < row.storeSeq) {
        log.warn(`a send to ${workerId} in doubt: its node's database is behind where it was when the send went (store sequence ${s.storeSeq} < ${row.storeSeq}: put back from an older copy?); it stays uncertain`);
        return { ok: false, problem: "uncertain" };
      }
      this.#store.dropSend(key);
      return null;
    }
    return { ok: false, problem: "uncertain" };
  }

  // The images go onto the worker's machine first; one that can't be put there is a refusal before anything is typed.
  async #prepare(a: Authenticated, workerId: string, text: string, uploads: string[], now: number): Promise<{ ok: true; body: string } | Extract<SendResult, { ok: false }>> {
    const attached = attachable(uploads, id => this.#inbox?.get(id), a.endpoint.id, now);
    if (!attached.ok) return { ok: false, problem: attached.error };
    const notes: string[] = [];
    for (const u of attached.value) {
      const staged = await this.#uploads.stage(u, workerId);
      if (!staged.ok) {
        log.warn(`send to ${workerId} refused: ${staged.problem} (an attached image couldn't be put on its machine)`);
        return { ok: false, problem: staged.problem };
      }
      notes.push(ownerFileNote(staged.path));
    }
    const body = commandText(text.replace(/\r\n/g, "\n"), notes);
    if (!body || !cleanText(body)) return { ok: false, problem: "empty" };   // nothing left once control characters go
    if (body.length > MAX_TEXT) return { ok: false, problem: "too_long" };
    return { ok: true, body };
  }

  // A refusal from #prepare writes no row, so a retry may type it.
  async #stageAndType(a: Authenticated, key: string, workerId: string, text: string, uploads: string[], now: number, createdAt?: number): Promise<SendResult> {
    const prepared = await this.#prepare(a, workerId, text, uploads, now);
    if (!prepared.ok) return prepared;
    if (!this.#store.startSend(key, now)) return { ok: false, problem: "uncertain" };
    const audit = (): AccessEvent => this.#commandSent(a, workerId, prepared.body, uploads.length, now);
    return this.#type(key, workerId, prepared.body, audit, createdAt);
  }

  // The audit row of a send typed into a worker (ADR-0006): its length and a hash, never the text, and how many images.
  #commandSent(a: Authenticated, workerId: string, body: string, attachments: number, at: number): AccessEvent {
    return {
      type: "CommandSent", sessionId: a.session.id, endpointId: a.endpoint.id, workerId,
      length: body.length, digest: createHash("sha256").update(body).digest("hex").slice(0, 16),
      ...(attachments ? { attachments } : {}), at,
    };
  }

  async #type(key: string, workerId: string, body: string, audit: () => AccessEvent, createdAt?: number): Promise<SendResult> {
    // For the manager: into its inbox, which types it exactly once when its pane is free (no menu, no one else's text
    // in its box). Switched off (`manager-inbox disable`) or not writable: typed directly, as before.
    if (this.#manager?.isManager(workerId)) {
      let queued: { key: string; duplicate: boolean } | null = null;
      // S7: two minutes from when the command was written, not from when it arrived (review #29.6), and only while
      // that moment is still inside the two minutes. A Retry of an older command, a clock running ahead, or one
      // running more than two minutes behind, starts the two minutes from this arrival (round 2.3).
      const age = this.#now() - (typeof createdAt === "number" ? createdAt : 0);
      const written = typeof createdAt === "number" && createdAt > 0 && age >= 0 && age < COMMAND_BUDGET_MS ? createdAt : this.#now();
      try { queued = this.#manager.inbox.enqueue({ id: `command:${key}`, kind: "owner", text: body, notAfter: written + COMMAND_BUDGET_MS }); }
      catch (e) { log.error(`send to ${workerId}: the manager's inbox can't be written; typing directly`, e); }
      if (queued) {
        this.#store.finishQueued(key);
        this.#store.record([audit()]);
        log.info(`send to ${workerId} queued in the manager's inbox`);
        return { ok: true, at: this.#now(), queued: true };
      }
    }
    let outcome: SendOutcome;
    // A throw may come after the paste: the row stays "started", so a repeat (here, or after a restart) is uncertain
    // and nothing is typed twice. A node that may have typed it (SendInDoubt) is "uncertain" at once, the hub's 409, so
    // the app says "may have been sent" and Check again asks the node (spec §3.1, §7; final review I1: a 500 read as
    // "Not sent", which invites typing it again by hand). Any other throw is passed on (a 500); a repeat that was waiting
    // gets the same outcome.
    try { outcome = await this.#tmux.send(workerId, body, key); }
    catch (e) {
      if (!(e instanceof SendInDoubt)) { log.warn(`send to ${workerId} failed while typing; a repeat will be uncertain`, e); throw e; }
      keepInDoubt(this.#store, key, e);                                           // the store a repeat asks, and how far it was
      log.warn(`send to ${workerId} in doubt: its node may have typed it; a repeat asks the node`, e);
      return { ok: false, problem: "uncertain" };
    }
    settleOutcome(this.#store, key, outcome);                                  // nothing reached the pane: the row goes, a retry may type it
    if (outcome.problem) {
      log.warn(`send to ${workerId} refused: ${outcome.problem}`);             // never the text
      return { ok: false, problem: outcome.problem };
    }
    this.#store.record([audit()]);
    return { ok: true, at: outcome.typedAt };
  }

  // Where a request for the manager stands (ADR-0011, review #2): the copy under way, the second once Send again queued
  // it. Null when it never went to the inbox, or the inbox can't be read now.
  inboxState(a: Authenticated, workerId: string, requestId: string): { status: InboxStatus; reason: string | null } | null {
    const inbox = this.#manager?.isManager(workerId) ? this.#manager.inbox : null;
    const key = `${a.endpoint.id}:${requestId}`;
    const known = this.#store.send(key);
    if (!inbox || known?.state !== "done" || (known.outcome !== "queued" && known.outcome !== "requeued")) return null;
    const id = known.outcome === "requeued" ? `command:${key}:again` : `command:${key}`;
    const st = inbox.state(inboxKey(SENDER, id));
    return st ? { status: st.status, reason: st.reason } : null;
  }

  // The first message is given up, and no second copy is still on its way: only then may Send again add one.
  // Queued or held with the message file gone counts too: the state file can still say waiting after the file
  // disappeared, and that command can never be typed.
  #givenUp(workerId: string, key: string): boolean {
    const inbox = this.#manager?.isManager(workerId) ? this.#manager.inbox : null;
    if (!inbox) return false;
    const up = (id: string) => {
      const st = inbox.state(inboxKey(SENDER, id));
      if (!st) return false;
      if (GIVEN_UP.has(st.status)) return true;
      const ik = inboxKey(SENDER, id);
      return (st.status === "queued" || st.status === "held") && st.attempts === 0 && inbox.deadline(ik) === 0;
    };
    if (!up(`command:${key}`)) return false;
    const again = inbox.state(inboxKey(SENDER, `command:${key}:again`));
    return again === null || up(`command:${key}:again`);
  }

  // "queued" landed. "refused" will never land (attachments, or an empty or too-long body). "later" is a write
  // that can be tried again.
  #queueAgain(a: Authenticated, workerId: string, key: string, text: string, uploads: string[], now: number): "queued" | "refused" | "later" {
    const inbox = this.#manager?.isManager(workerId) ? this.#manager.inbox : null;
    if (!inbox) return "later";
    const attached = attachable(uploads, id => this.#inbox?.get(id), a.endpoint.id, now);
    if (!attached.ok) return "refused";
    const body = commandText(text.replace(/\r\n/g, "\n"), attached.value.map(u => ownerFileNote(u.path)));
    if (!body || !cleanText(body) || body.length > LIMITS.maxSendText) return "refused";
    let queued: { key: string; duplicate: boolean } | null = null;
    try { queued = inbox.enqueue({ id: `command:${key}:again`, kind: "owner", text: body, notAfter: now + COMMAND_BUDGET_MS }); }
    catch (e) { log.error(`send to ${workerId}: the manager's inbox can't be written for a repeat`, e); return "later"; }
    if (!queued || queued.duplicate) return "later";
    this.#store.finishRequeued(key);
    this.#store.record([{
      type: "CommandSent", sessionId: a.session.id, endpointId: a.endpoint.id, workerId,
      length: body.length, digest: createHash("sha256").update(body).digest("hex").slice(0, 16), at: now,
    }]);
    log.info(`send to ${workerId} queued again in the manager's inbox: the first was given up`);
    return "queued";
  }
}
