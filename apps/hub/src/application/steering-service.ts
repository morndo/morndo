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
import { LIMITS, type ErrorCode, type QueuedCommand } from "@morndo/protocol";
import { ownerFileNote } from "../adapters/attachment-note.ts";
import { localUploads } from "../adapters/local-node.ts";
import type { Inbox } from "../adapters/uploads.ts";
import type { Store } from "../adapters/store.ts";
import type { Authenticated } from "./access-service.ts";
import { SEND_REFUSALS, SendInDoubt, type SendOutcome, type SendRefused, type SendStatus, type Tmux, type UploadSink } from "./ports.ts";
import { log } from "../adapters/log.ts";
import { queuedCommand, type ManagerQueue } from "./manager-queue.ts";

// `at`: when the node typed it, on that node's clock, which its transcript's times are on: the app matches the echo by
// it (fleet core §3.1; before, the hub's own clock, review M2). `delivery`: a message to the manager through the fleet's
// queue (fleet-clients §9.1), where it stands; `at` is then when it was queued (or typed, or delivered), on that clock.
export type SendResult =
  | { ok: true; at: number; delivery?: QueuedCommand }
  | { ok: false; problem: "duplicate"; at: number; delivery?: QueuedCommand }
  | { ok: false; problem: SendProblem | AttachRefusal | SendRefused | "step_up" | "empty" | "too_long" | "uncertain" | "stale" | "too_large" | "node_offline" | "cannot_resend" };
// A cancel of a message to the manager: withdrawn (its delivery, given up), or why not ("unknown": no such message of
// this device's; "already_typed": too late; "uncertain": the fleet never answered the cancel; or the fleet's refusal).
export type MessageCancel = { ok: true; delivery: QueuedCommand } | { ok: false; problem: ErrorCode | "unknown" };

// Refusals that come before anything is pasted (tmux.ts, and a fleet's "node_offline", executed "no"): nothing reached
// the pane, so a retry may type it. A "not_submitted" comes after the paste, and a throw can't tell: those keep their
// row, and a repeat asks the node (op.status) when there is one, else is "uncertain".
const BEFORE_PASTE = new Set<SendOutcome["problem"]>(["no_pane", "menu_open", "no_input_box", "draft_present", "busy", "node_offline"]);
// A node's or the fleet's definite refusal (ports.ts SEND_REFUSALS: executed "no", nothing ran): the row goes as well, so
// a retry types once the cause is fixed instead of answering "uncertain" for ever (final review M1).
const REFUSED = new Set<SendOutcome["problem"]>(SEND_REFUSALS);
// Whether a problem says nothing reached the pane (either set above), so its row goes: a send's here, an escalation
// answer's in EscalationService, which keeps its rows as a send does.
export const nothingTyped = (problem: SendOutcome["problem"]): boolean => BEFORE_PASTE.has(problem) || REFUSED.has(problem);
// Refusals of a body that building it again won't change: its images (gone, not this device's, expired, too many), or
// nothing or too much text. A Send again that meets one is "cannot_resend" (ADR-0011).
const LASTING = new Set<string>(["unknown_upload", "not_yours", "expired", "too_many", "empty", "too_long"]);
// Text with nothing left once control characters other than newline and tab go (an ESC[201~ would end a bracketed
// paste early) and it is trimmed: empty (review B9). CRLF counts as one newline.
const kept = (c: string) => { const n = c.charCodeAt(0); return n === 9 || n === 10 || (n >= 32 && n !== 127); };
export function cleanText(s: string): string {
  let out = "";
  for (const c of s.replace(/\r\n?/g, "\n")) if (kept(c)) out += c;
  return out.trim();
}

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
  // The manager's queue (fleet-clients §9.1) and which worker is the manager; null without a fleet.
  #manager: { queue: ManagerQueue; isManager: (workerId: string) => boolean } | null;

  constructor(
    store: Store, tmux: Pick<Tmux, "send">, now: () => number = Date.now, policy: () => AccessPolicy = () => DEFAULT_POLICY,
    inbox: Pick<Inbox, "get"> | null = null, waitingOn: (workerId: string) => string = () => "none",
    nameOf: (workerId: string) => string | null = () => null, uploads: UploadSink = localUploads(),
    status: SendStatus | null = null,
    manager: { queue: ManagerQueue; isManager: (workerId: string) => boolean } | null = null,
  ) {
    this.#manager = manager;
    this.#status = status;
    this.#nameOf = nameOf;
    this.#inbox = inbox;
    this.#store = store;
    this.#tmux = tmux;
    this.#now = now;
    this.#policy = policy;
    this.#waitingOn = waitingOn;
    this.#uploads = uploads;
  }

  // `seen`: the needs-you state the principal wrote it for ("none", or a question or menu id); absent, no check.
  // `name`: the worker it was written to; a pane that now runs another agent is no longer that worker (review M2).
  // `createdAt`: when he wrote it, on the device's clock (S7): a message to the manager waits up to 24 hours from then.
  // `again`: the phone's Send again (ADR-0011) of a message to the manager the queue gave up: queued once more, as a new
  // attempt under the same request id. A plain repeat is a status read and never queues anything.
  async send(a: Authenticated, workerId: string, text: string, requestId: string, uploads: string[] = [], seen?: string, name?: string, createdAt?: number, again = false): Promise<SendResult> {
    const now = this.#now();
    const key = `${a.endpoint.id}:${requestId}`;
    // A repeat first: it may come after the window or the worker moved on, and must still learn what became of it.
    // While this process is still staging or typing it, the repeat waits for the outcome (the web client counts
    // "duplicate" as delivered, so it may only come once the text is in; a refusal is passed on as it is).
    const typing = this.#typing.get(key);
    if (typing) {
      const first = await typing;
      return first.ok ? { ok: false, problem: "duplicate", at: first.at, ...(first.delivery ? { delivery: first.delivery } : {}) } : first;
    }
    // A message handed to the manager's queue before (fleet-clients §9.1): what became of it, whatever the switch says
    // now, and nothing queued again. One in doubt ("sending") is judged again below and asked again under its own id. One
    // given up while the switch is off is typed directly (nothing of it was typed, so its key is free on the node).
    const queued = this.#manager?.queue.byRequest(a.endpoint.id, requestId) ?? null;
    // One still in doubt while the switch is off (its cancel at start went unanswered) may be queued: never typed by
    // hand (ruling 49). It stays "uncertain" until the queue is on again, or its row is pruned.
    if (queued?.kind === "command" && queued.state === "sending" && this.#manager && !this.#manager.queue.on) {
      log.warn(`send to ${workerId}: its delivery through the manager's queue is in doubt; never typed directly`);
      return { ok: false, problem: "uncertain" };
    }
    if (queued?.kind === "command" && queued.state !== "sending") {
      const queue = this.#manager?.queue;
      // Send again (ADR-0011): the first attempt, given up, is queued once more as the second under the same request id,
      // after the same checks as a first send; a repeat then reads where that one stands. One request is at most two
      // messages, and never two that can both arrive: a given-up second is final.
      if (again && queued.state === "given_up" && queued.deliveryId === `hub:${key}` && queue?.on) return this.#sendAgain(a, workerId, requestId, text, uploads, now, seen, name);
      if (queued.state === "given_up" && queue && !queue.on) queue.forget(queued.deliveryId);
      else {
        const view = queue?.view(queued.deliveryId) ?? null;
        return { ok: false, problem: "duplicate", at: view?.at ?? queued.queuedAt, ...(view ? { delivery: queuedCommand(queued, view) } : {}) };
      }
    }
    const known = this.#store.send(key);
    if (known?.state === "done") return { ok: false, problem: "duplicate", at: known.typedAt ?? known.at };
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
  // for, and the worker that pane runs now (review M2).
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
    if (row.state === "done") return { ok: false, problem: "duplicate", at: row.typedAt ?? row.at };
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

  // A refusal from #prepare writes no row, so a retry may type it. To the manager with the queue on: queued, not typed.
  async #stageAndType(a: Authenticated, key: string, workerId: string, text: string, uploads: string[], now: number, createdAt?: number): Promise<SendResult> {
    const prepared = await this.#prepare(a, workerId, text, uploads, now);
    if (!prepared.ok) return prepared;
    if (this.#manager?.queue.on && this.#manager.isManager(workerId)) return this.#queueCommand(a, key, workerId, prepared.body, uploads.length, now, createdAt);
    if (!this.#store.startSend(key, now)) return { ok: false, problem: "uncertain" };
    const audit = (): AccessEvent => this.#commandSent(a, workerId, prepared.body, uploads.length, now);
    return this.#type(key, workerId, prepared.body, audit);
  }

  // A message to the manager through the fleet's queue (fleet-clients §9.1), under the key a direct send types it under
  // (`hub:<endpoint>:<request>`), so the switch never types it twice. CommandSent is recorded when the hub queues it (its
  // provenance, ADR-0006; reconciliation ruling 28): once, at its first attempt the fleet didn't refuse, whether or not
  // its answer came back. The delivery's outcome is its own (its row, the fleet's audit, §8). It waits up to 24 hours
  // from when he wrote it (ruling 83: busy, at a menu, behind his draft; no two-minute deadline): `createdAt`, unless that
  // time can't be right (ahead of this clock, or past the 24 hours), when they count from its arrival.
  // `deliveryId`: the attempt's own id; the first is `hub:<key>`, a Send again's the next one (ManagerQueue.idFor).
  async #queueCommand(a: Authenticated, key: string, workerId: string, body: string, attachments: number, now: number, createdAt?: number, deliveryId = `hub:${key}`): Promise<SendResult> {
    const queue = (this.#manager as { queue: ManagerQueue }).queue;
    const requestId = key.slice(a.endpoint.id.length + 1);
    const first = queue.row(deliveryId) === null;
    const age = now - (createdAt ?? now);
    const ttlMs = createdAt !== undefined && age > 0 && age < LIMITS.deliveryTtlMs ? LIMITS.deliveryTtlMs - age : undefined;
    const r = await queue.put({
      deliveryId, kind: "command", escalationId: null, ask: null, choice: null,
      endpointId: a.endpoint.id, sessionId: a.session.id, requestId, queuedAt: now,
    }, body, ttlMs);
    if (first && (r.ok || r.problem === "uncertain")) this.#store.record([this.#commandSent(a, workerId, body, attachments, now)]);
    if (!r.ok) {
      log.warn(`send to ${workerId} not queued for the manager: ${r.problem}`);   // never the text
      return { ok: false, problem: r.problem === "timeout" ? "busy" : r.problem };
    }
    log.info(`send to ${workerId} queued for the manager`);
    return { ok: true, at: r.view.at ?? r.delivery.queuedAt, delivery: queuedCommand(r.row, r.view) };
  }

  // Send again of a message to the manager the queue gave up (ADR-0011): the next attempt, waiting a fresh 24 hours. A body
  // that can't be built again (its images expired, say, or it is empty) is "cannot_resend": a retry won't change that.
  async #sendAgain(a: Authenticated, workerId: string, requestId: string, text: string, uploads: string[], now: number, seen?: string, name?: string): Promise<SendResult> {
    const refused = this.#maySend(a, workerId, now, seen, name);
    if (refused) return refused;
    const prepared = await this.#prepare(a, workerId, text, uploads, now);
    if (!prepared.ok) return LASTING.has(prepared.problem) ? { ok: false, problem: "cannot_resend" } : prepared;
    const key = `${a.endpoint.id}:${requestId}`;
    const queue = (this.#manager as { queue: ManagerQueue }).queue;
    return this.#queueCommand(a, key, workerId, prepared.body, uploads.length, now, undefined, queue.idFor(key));
  }

  // The principal's cancel of one of his messages to the manager still waiting in the fleet's queue (ruling 83, spec
  // §9.1): only his own device's, and only one not typed yet. It types nothing, so it asks no fresh passkey. Given up
  // already: that is its answer. Delivered, or typed and never seen taken: too late.
  async cancel(a: Authenticated, requestId: string): Promise<MessageCancel> {
    const queue = this.#manager?.queue;
    const row = queue?.byRequest(a.endpoint.id, requestId) ?? null;
    if (!queue || row?.kind !== "command") return { ok: false, problem: "unknown" };
    const view = queue.view(row.deliveryId);
    if (row.state === "given_up" && view) return { ok: true, delivery: queuedCommand(row, view) };
    if (row.state === "delivered" || row.state === "uncertain") return { ok: false, problem: "already_typed" };
    const r = await queue.cancel(row.deliveryId);
    if (!r.ok) return { ok: false, problem: r.problem };
    log.info(`a message to the manager was cancelled before it was typed (${row.deliveryId})`);
    return { ok: true, delivery: queuedCommand(queue.row(row.deliveryId) ?? row, r.view) };
  }

  // The audit row of a send typed into a worker (ADR-0006): its length and a hash, never the text, and how many images.
  #commandSent(a: Authenticated, workerId: string, body: string, attachments: number, at: number): AccessEvent {
    return {
      type: "CommandSent", sessionId: a.session.id, endpointId: a.endpoint.id, workerId,
      length: body.length, digest: createHash("sha256").update(body).digest("hex").slice(0, 16),
      ...(attachments ? { attachments } : {}), at,
    };
  }

  async #type(key: string, workerId: string, body: string, audit: () => AccessEvent): Promise<SendResult> {
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
}
