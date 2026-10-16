// The delivery queue's deliverer (fleet clients spec §4.3, rule for rule; plan Contracts, "Agent internals shared by Tasks
// 4 to 6"): a port of the manager inbox's deliverer (the chat bot's inbox deliverer) onto the agent's own parts.
// - A new delivery is answered `queued`, without `waiting`; a reason is set only while it is queued and a round has found
//   its lane not ready (RECONCILIATION.md ruling 43).
// - Typing is one at a time per pane and in the order stored (ruling 16). A queued delivery waits
//   `earlier` behind one still queued before it, and behind one typed or held that waits for its receipt, for at most 60 s
//   from that typing; then it types. So three senders to one lane never type into each other's text (plan Review Focus
//   2), and a delivery whose receipt never comes holds its lane for a minute, not until its notAfter. Receipts match the
//   earliest delivery waiting for one.
// - A lane takes deliveries while it has a live Claude Code session, whatever the session's status (ruling 11: `shell`
//   is Claude Code running a shell command). no_session is no live session: no session file, or its process gone.
// - A round runs at once for a new delivery, on each kick (a session's status, a hook, the inventory) and at least every
//   5 s once started (LIMITS.deliveryTryMs). Rounds never overlap: a kick during one runs another after it.
// - A try is a pane.send through the agent's own executor under the delivery's id as its done key, with every check of
//   pane.send (the pane lock, the menu and draft checks, the expectation; for a lane name bound to its session, that
//   session too).
//   - A refusal that typed nothing leaves the delivery queued, with its reason; a tmux that did not answer, or panes that
//     couldn't be read, make it `unavailable` (ruling 15); so does a node that holds new work while it updates.
//   - An answer that may have acted makes it `typed`, never typed again: `uncertain` (the key was started already: the
//     agent restarted while typing) or internal "maybe".
//   - A key already `done` answers its stored outcome, with the time it was typed then.
//   - Any other refusal is final: `given_up` (`refused`).
// - A line left in the box after Enter (`not_submitted`) gets Enter again (pane.keys) only while the box shows that very
//   line, at most twice, and only for a typing of this process.
// - Confirming reads the transcript of the session the text was typed into, from where it ended just before the typing
//   (after a restart, up to 8 MiB back), with Task 2's readReceipts: delivered, held, or dropped (cleared_on_cancel).
//   - A dropped line is typed once more, under `<id>#2` with its own synced `started`, only when its line isn't in the
//     box and that session is idle. Otherwise it is `uncertain`, and so is a second drop.
//   - The retype's own key makes a third typing impossible even if the flag that records it was lost.
//   - A command that starts a new session (Task 2's startsNewSession: /clear, /reset, /new; ruling 54) is recorded only
//     in the new session's transcript: its receipt is its pane's session changing to another id after the typing
//     (ruling 17).
// - Past notAfter: queued is given up (`expired`); typed or held is `uncertain`, never typed again.
// - Every change is emitted (agent.ts sends it as ev.delivery); a round that changes nothing emits nothing.
// - Test hooks for the drills (test-hooks.ts): noSessionBinding holds a lane name like a sticky one (no binding);
//   retypeUnderFirstKey retypes under the delivery's own key; deliveryStartGraceMs shortens the 2-minute grace.
import { setTimeout as sleep } from "node:timers/promises";
import { ERROR_EXECUTED, FINAL_DELIVERY_STATES as FINAL, LIMITS, parseWorkerId, type Delivery, type ErrorCode, type Expect, type OpArgs, type OpError, type OpResult,
  type SessionStatus, type WaitingReason } from "@morndo/protocol";
import { readReceipts, startsNewSession, type PendingText } from "@morndo/node-ops";
import type { Logger } from "../log.ts";
import type { OpExecutor } from "../ops/executor.ts";
import type { TestHooks } from "../test-hooks.ts";
import type { DeliveryChange, DeliveryDetail, DeliveryStore } from "./store.ts";

// The agent's executor as the deliverer uses it: one side effect at a time per pane, with the policy, the done keys and
// every check of the op (ops/executor.ts).
export type Executor = Pick<OpExecutor, "handle">;
// One lane as the deliverer sees it: the inventory's pane, the Claude Code session in it and that session's status (Task
// 2's session registry), and when its pane's own process started (ruling 14), for the 2-minute grace of spec §4.1.
export type PaneState = { workerId: string; pane: string; window: string; sessionId: string | null; status: SessionStatus | null; startedAt: number | null };
export type PaneView = {
  snapshot(): PaneState[];                                  // as the inventory last read them (enqueue answers at once)
  refresh(): Promise<PaneState[]>;                          // read again when older than the inventory's poll interval
  draft(pane: string): Promise<string | null>;              // the input box's own text (not its dim suggestion), else null
};
export type TranscriptView = {
  size(sessionId: string): Promise<number | null>;          // null: no transcript of that session on this node (yet)
  identity?(sessionId: string): Promise<string | null>;     // which file it is (device and inode): another file at the same path is another identity
  // whole lines from a byte offset, with the byte offset each starts at (a receipt must come after the typing, receipt.ts cameAfter)
  lines(sessionId: string, from: number): Promise<{ lines: string[]; starts?: number[]; next: number } | null>;
};
export type KickReason = "status" | "hook" | "inventory" | "timer";
export type DelivererDeps = {
  store: DeliveryStore; executor: Executor; panes: PaneView; transcripts: TranscriptView; now: () => number;
  emit: (d: Delivery) => void; log: Logger;
  hooks?: Pick<TestHooks, "noSessionBinding" | "retypeUnderFirstKey" | "deliveryStartGraceMs">;
};

const WAIT_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(["menu_open", "draft_present", "no_input_box", "busy", "no_pane"]);
const TRY_TIMEOUT_MS = 20_000;                              // the pane lock may wait up to 20 s (ops/pane-ops.ts)
const KEYS_TIMEOUT_MS = 5000;
const ENTER_PAUSE_MS = 600;                                 // tmux send waits 400 ms for a submit; then this before each look
const ENTER_MAX = 2;
const LOOKBACK_BYTES = 8 << 20;                             // after a restart, how far back a transcript is read for a receipt
const NO_SESSION = "the pane has no live Claude Code session; type into it directly with pane.send or pane.keys";
const CONFLICT = "that delivery id was used with another target or text";

const err = (code: ErrorCode, message: string): OpError => ({ code, executed: ERROR_EXECUTED[code], message });
// A live session (the registry lists a session only while its process is alive), whatever its status (ruling 11).
const takes = (p: PaneState): boolean => p.sessionId !== null;
const targetKey = (t: Delivery["target"]): string => ("lane" in t ? `lane:${t.lane}` : `worker:${t.workerId}`);

const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const PASTED = /^\[Pasted text #\d+ \+\d+ lines\]$/;
// The box shows this delivery's own line: exactly its text; or, for a text longer than the box shows on its first line,
// a start of it at least 20 characters long; or Claude Code's placeholder for a pasted text of several lines.
export function ownLine(draft: string, text: string): boolean {
  const d = flat(draft);
  const t = flat(text);
  if (d === "") return false;
  if (PASTED.test(d)) return text.includes("\n");
  return t.startsWith(d) && d.length >= Math.min(t.length, 20);
}


type Where = { pane: PaneState } | { wait: WaitingReason } | { gone: true };
type At = { workerId: string; pane: string; session: string };

export class Deliverer {
  #d: DelivererDeps;
  #grace: number;
  #unbound: boolean;
  #cursors = new Map<string, number>();                    // session → the transcript's byte offset read up to
  // delivery → the transcript's size just before it was typed, and which file that was (null: there was none yet). Not kept over a
  // restart. It means nothing once the file is shorter than that or is another file.
  #after = new Map<string, { offset: number; file: string | null }>();
  #trying = new Set<string>();                             // deliveries whose pane.send is in flight
  #current: Promise<void> | null = null;
  #again = false;
  #stopped = false;
  #timer: NodeJS.Timeout | null = null;
  #n = 0;

  constructor(d: DelivererDeps) {
    this.#d = d;
    this.#grace = d.hooks?.deliveryStartGraceMs ?? LIMITS.deliveryStartGraceMs;
    this.#unbound = d.hooks?.noSessionBinding === true;
  }

  // Validates, binds and stores a delivery (spec §4.1, §4.3 "Storing"); the answer comes once it is stored, synced.
  enqueue(a: OpArgs["lane.deliver"]): OpResult["lane.deliver"] | OpError {
    const store = this.#d.store;
    const known = store.get(a.id);
    if (known) return this.#sameContent(a) ? { delivery: known } : err("id_conflict", CONFLICT);
    const panes = this.#d.panes.snapshot();
    const now = this.#d.now();
    const refuse = (p: PaneState) => !takes(p) && !(p.startedAt !== null && now - p.startedAt < this.#grace);
    const target = a.target;
    let bound: string | null = null;
    if ("workerId" in target) {
      const p = panes.find(x => x.workerId === target.workerId);
      if (!p) return err("no_pane", "no such pane on this node");
      if (refuse(p)) return err("no_session", NO_SESSION);
    } else {
      const named = panes.filter(x => x.window === target.lane);
      if (named.length > 1) return err("lane_conflict", "two windows on this node have that name");
      const p = named[0];
      if (!target.sticky) {
        if (!p) return err("no_pane", "no lane of that name on this node");
        if (refuse(p)) return err("no_session", NO_SESSION);
        bound = takes(p) && !this.#unbound ? p.sessionId : null;   // a lane still starting binds the first session it shows
      }
    }
    let stored: ReturnType<DeliveryStore["store"]>;
    try {
      stored = store.store({ id: a.id, target, text: a.text, ttlMs: a.ttlMs ?? LIMITS.deliveryTtlMs, boundSession: bound });
    } catch (e) {
      this.#d.log.error("a delivery could not be stored; nothing was queued", e);
      return { code: "internal", executed: "no", message: "the delivery could not be stored (a full disk?); nothing was queued" };
    }
    if ("conflict" in stored) return err("id_conflict", CONFLICT);
    if (stored.fresh) {
      this.#d.emit(stored.delivery);
      this.#schedule();
    }
    return { delivery: stored.delivery };
  }

  // Gives up a queued delivery (spec §4.3, "Cancelling"). One being typed right now is `busy`: ask again.
  cancel(id: string): OpResult["delivery.cancel"] | OpError {
    const d = this.#d.store.get(id);
    if (!d) return err("bad_args", "no delivery with that id on this node");
    if (this.#trying.has(id)) return err("busy", "the delivery is being typed right now; ask again in a moment");
    if (d.state === "given_up") return { delivery: d };
    if (d.state !== "queued") return err("already_typed", "the delivery was typed already and can't be cancelled");
    return { delivery: this.#change(d, { state: "given_up", why: "cancelled" }) };
  }

  kick(_reason: KickReason): void { this.#schedule(); }

  start(): void {
    this.#stopped = false;
    this.#timer ??= setInterval(() => this.kick("timer"), LIMITS.deliveryTryMs);
    this.#schedule();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  async drain(): Promise<void> {
    while (this.#current) await this.#current;
  }

  #schedule(): void {
    if (this.#stopped) return;
    if (this.#current) { this.#again = true; return; }
    this.#current = this.#rounds().finally(() => { this.#current = null; });
  }

  async #rounds(): Promise<void> {
    do {
      this.#again = false;
      try { await this.#round(); }
      catch (e) { this.#d.log.warn("a delivery round failed; the next one tries again", e); }
    } while (this.#again && !this.#stopped);
  }

  async #round(): Promise<void> {
    const store = this.#d.store;
    if (store.open().length === 0) { this.#cursors.clear(); return; }
    let panes: PaneState[];
    try { panes = await this.#d.panes.refresh(); }
    catch (e) {
      this.#d.log.warn("the node's panes could not be read; deliveries wait (unavailable) and are tried again", e);
      for (const d of store.open()) this.#wait(d, "unavailable");
      return;
    }
    await this.#confirm(panes);
    this.#expire();
    // Typing one at a time per pane, in the order stored (ruling 16): the first queued delivery for a pane is tried,
    // unless one typed or held before it still waits for its receipt within LIMITS.deliveryReceiptHoldMs (60 s, ruling 42)
    // of its typing. A prompt queued by worker id and a follow-up queued by that lane's name are the same pane. Every
    // other queued one for it waits `earlier`. A delivery whose pane is not on the node yet keeps its target's own key.
    const now = this.#d.now();
    const next = new Map<string, Delivery>();
    const held = new Set<string>();
    const keyOf = (d: Delivery): string => {
      const t = store.detail(d.id);
      const p = t ? this.#paneOf(t, panes) : null;
      return p ? `pane:${p.workerId}` : targetKey(d.target);
    };
    for (const d of store.open()) {
      const key = keyOf(d);
      if (d.state !== "queued") {
        if (now - (d.typedAt ?? d.queuedAt) < LIMITS.deliveryReceiptHoldMs) held.add(key);
        continue;
      }
      if (held.has(key) || next.has(key)) { this.#wait(d, "earlier"); continue; }
      next.set(key, d);
    }
    await Promise.all([...next.values()].map(d => this.#try(d, panes)));
  }

  // Receipts from each session something was typed into, read on from where the last round stopped.
  async #confirm(panes: PaneState[]): Promise<void> {
    const store = this.#d.store;
    // A command that starts a new session: its receipt is its pane showing another session than the one it was typed into.
    for (const d of store.open()) {
      if ((d.state !== "typed" && d.state !== "held") || d.sessionId === undefined) continue;
      const t = store.detail(d.id);
      const text = store.textOf(d.id);
      if (!t || text === null || !startsNewSession(text)) continue;
      const p = this.#paneOf(t, panes);
      if (p !== null && p.sessionId !== null && p.sessionId !== d.sessionId) this.#change(d, { state: "delivered", deliveredAt: this.#d.now() });
    }
    const waiting = new Map<string, Delivery[]>();
    const open = new Set(store.open().map(d => d.id));
    for (const id of this.#after.keys()) if (!open.has(id)) this.#after.delete(id);
    for (const d of store.open()) {
      if ((d.state === "typed" || d.state === "held") && d.sessionId !== undefined) waiting.set(d.sessionId, [...(waiting.get(d.sessionId) ?? []), d]);
    }
    for (const session of [...this.#cursors.keys()]) if (!waiting.has(session)) this.#cursors.delete(session);
    for (const [session, ds] of waiting) {
      await this.#checkOffsets(session, ds);
      let from = this.#cursors.get(session);
      if (from === undefined) {
        const size = await this.#d.transcripts.size(session);
        if (size === null) continue;
        from = Math.max(0, size - LOOKBACK_BYTES);
      }
      const got = await this.#d.transcripts.lines(session, from);
      if (got === null) continue;
      this.#cursors.set(session, got.next);
      const pending: PendingText[] = ds.flatMap(d => {
        const text = store.textOf(d.id);
        const after = this.#after.get(d.id);
        return text === null ? [] : [{ id: d.id, text, typedAt: d.typedAt ?? d.queuedAt, ...(after !== undefined ? { after: after.offset } : {}) }];
      });
      for (const r of readReceipts(got.lines, pending, got.starts)) await this.#receipt(r.id, r.verdict, r.at, panes);
    }
  }

  // An offset from before a typing holds only while the transcript is the file it was taken in and has not been cut short. Otherwise
  // the offsets of the deliveries waiting on it are dropped, and so is the read position: those deliveries are read again from the
  // file as it is now, by time and order (receipt.ts cameAfter, without an offset).
  async #checkOffsets(session: string, ds: Delivery[]): Promise<void> {
    const kept = ds.flatMap(d => { const a = this.#after.get(d.id); return a === undefined ? [] : [[d.id, a] as const]; });
    if (kept.length === 0) return;
    const size = await this.#d.transcripts.size(session);
    const file = (await this.#d.transcripts.identity?.(session)) ?? null;
    if (size === null) return;
    const stale = kept.filter(([, a]) => size < a.offset || (a.file !== null && file !== null && file !== a.file));
    if (stale.length === 0) return;
    for (const [id] of stale) this.#after.delete(id);
    this.#cursors.delete(session);
  }

  async #receipt(id: string, verdict: "delivered" | "held" | "dropped", at: number, panes: PaneState[]): Promise<void> {
    const d = this.#d.store.get(id);
    if (!d || FINAL.has(d.state)) return;
    if (verdict === "delivered") { this.#change(d, { state: "delivered", deliveredAt: at }); return; }
    if (verdict === "held") { if (d.state === "typed") this.#change(d, { state: "held" }); return; }
    await this.#dropped(d, panes);
  }

  // Claude Code dropped the line from its queue (an interrupt): the inbox's one retype (spec §4.3).
  async #dropped(d: Delivery, panes: PaneState[]): Promise<void> {
    const store = this.#d.store;
    const t = store.detail(d.id);
    const text = store.textOf(d.id);
    if (!t || text === null) return;
    if (t.retyped) { this.#change(d, { state: "uncertain", note: "dropped by an interrupt again, after its one retype" }); return; }
    const where = this.#resolve(t, panes);
    const p = "pane" in where ? where.pane : null;
    const ref = p === null ? null : parseWorkerId(p.workerId);
    if (p === null || ref === null || p.sessionId === null || p.sessionId !== d.sessionId || p.status !== "idle") {
      this.#change(d, { state: "uncertain", note: "dropped by an interrupt while its session was not idle; not typed again" });
      return;
    }
    const draft = await this.#d.panes.draft(p.pane);
    if (draft !== null && ownLine(draft, text)) {
      this.#change(d, { state: "uncertain", note: "dropped by an interrupt and back in the input box; not typed again" });
      return;
    }
    const bindable = "lane" in t.target && !t.target.sticky && !this.#unbound;
    const expect: Expect = { server: ref.server, window: p.window, ...(bindable && t.boundSession !== null ? { sessionId: t.boundSession } : {}) };
    const key = this.#d.hooks?.retypeUnderFirstKey === true ? d.id : `${d.id}#2`;
    await this.#type(d, text, { workerId: p.workerId, pane: p.pane, session: p.sessionId }, expect, key, true);
  }

  #expire(): void {
    const now = this.#d.now();
    for (const d of this.#d.store.open()) {
      if (now <= d.notAfter) continue;
      if (d.state === "queued") { this.#change(d, { state: "given_up", why: "expired" }); continue; }
      this.#change(d, { state: "uncertain", note: `${d.state === "held" ? "held by Claude Code" : "typed"}, never seen taken before notAfter` });
    }
  }

  // The one pane a delivery's target names now, whichever session runs there.
  #paneOf(t: DeliveryDetail, panes: PaneState[]): PaneState | null {
    const target = t.target;
    if ("workerId" in target) return panes.find(x => x.workerId === target.workerId) ?? null;
    const named = panes.filter(x => x.window === target.lane);
    return named.length === 1 ? (named[0] as PaneState) : null;
  }

  // Where a delivery would be typed now, or why it waits, or that it is gone (spec §4.1).
  #resolve(t: DeliveryDetail, panes: PaneState[]): Where {
    const target = t.target;
    if ("workerId" in target) {
      const p = panes.find(x => x.workerId === target.workerId);
      if (!p) return { gone: true };
      return takes(p) ? { pane: p } : { wait: "no_session" };
    }
    const named = panes.filter(x => x.window === target.lane);
    if (named.length > 1) return { wait: "no_pane" };               // two windows claim the name: neither is typed into
    const p = named[0];
    const bound = !target.sticky && !this.#unbound;
    if (!p) return bound ? { gone: true } : { wait: "no_pane" };
    if (bound && t.boundSession !== null && p.sessionId !== null && p.sessionId !== t.boundSession) return { gone: true };
    return takes(p) ? { pane: p } : { wait: "no_session" };
  }

  async #try(d: Delivery, panes: PaneState[]): Promise<void> {
    const store = this.#d.store;
    const t = store.detail(d.id);
    const text = store.textOf(d.id);
    if (!t || text === null) return;
    const where = this.#resolve(t, panes);
    if ("gone" in where) {
      const note = "lane" in t.target ? "the lane's window closed or another session took its name: never typed into another conversation" : "the pane is gone";
      this.#change(d, { state: "given_up", why: "gone", note });
      return;
    }
    if ("wait" in where) { this.#wait(d, where.wait); return; }
    const p = where.pane;
    const ref = parseWorkerId(p.workerId);
    if (p.sessionId === null || ref === null) return;
    const bindable = "lane" in t.target && !t.target.sticky && !this.#unbound;
    if (bindable && t.boundSession === null) this.#change(d, { sessionId: p.sessionId });   // queued while its lane was starting
    const bound = bindable ? (t.boundSession ?? p.sessionId) : null;
    const expect: Expect = { server: ref.server, window: p.window, ...(bound !== null ? { sessionId: bound } : {}) };
    await this.#type(d, text, { workerId: p.workerId, pane: p.pane, session: p.sessionId }, expect, d.id, false);
  }

  async #type(d: Delivery, text: string, at: At, expect: Expect, key: string, retype: boolean): Promise<void> {
    const tryAt = this.#d.now();
    const attempt = async () => ({
      before: await this.#d.transcripts.size(at.session),
      file: (await this.#d.transcripts.identity?.(at.session)) ?? null,
      reply: await this.#d.executor.handle({
        id: `deliver-${++this.#n}`, op: "pane.send", args: { workerId: at.workerId, text, expect }, timeoutMs: TRY_TIMEOUT_MS, key,
      }),
    });
    this.#trying.add(d.id);
    const { before, file, reply } = await attempt().finally(() => this.#trying.delete(d.id));
    const retyped = retype ? { retyped: true } : {};
    if (reply.ok) {
      const r = reply.result as OpResult["pane.send"];
      if (!this.#cursors.has(at.session)) this.#cursors.set(at.session, before ?? 0);
      this.#after.set(d.id, { offset: before ?? 0, file });  // no transcript yet: whatever it holds later is new
      this.#change(d, { state: "typed", typedAt: r.typedAt, sessionId: at.session, ...retyped });
      if (r.problem === "not_submitted" && r.typedAt >= tryAt) await this.#enterAgain(at, expect, text);
      return;
    }
    const e = reply.error;
    if (e.executed === "maybe") {
      // A key started already (the agent restarted while typing) or a typing that failed part way: it may have been
      // typed, so it never is again. Its receipt may be from before this try, so it is read from the queuing on.
      this.#change(d, { state: "typed", typedAt: retype ? tryAt : d.queuedAt, sessionId: at.session,
        note: "typing may have begun before an agent restart or a failure; never typed again", ...retyped });
      return;
    }
    if (retype) { this.#change(d, { state: "uncertain", note: `dropped by an interrupt; its one retype was refused (${e.code}), not typed again` }); return; }
    if (WAIT_CODES.has(e.code)) { this.#wait(d, e.code as WaitingReason); return; }
    if (e.code === "timeout" || e.code === "internal" || e.code === "updating") {
      this.#d.log.warn(`a delivery was not tried (${e.code}); it waits (unavailable) and is tried again`);
      this.#wait(d, "unavailable");
      return;
    }
    this.#change(d, { state: "given_up", why: "refused", note: `${e.code}: ${e.message}`.slice(0, 200) });
  }

  // Enter again on its own stuck line (spec §4.3): only while the box shows it, at most ENTER_MAX times.
  async #enterAgain(at: At, expect: Expect, text: string): Promise<void> {
    for (let i = 0; i < ENTER_MAX; i++) {
      await sleep(ENTER_PAUSE_MS);
      const draft = await this.#d.panes.draft(at.pane);
      if (draft === null || !ownLine(draft, text)) return;
      const r = await this.#d.executor.handle({
        id: `deliver-${++this.#n}`, op: "pane.keys", args: { workerId: at.workerId, names: ["Enter"], expect }, timeoutMs: KEYS_TIMEOUT_MS,
      });
      if (!r.ok || !(r.result as OpResult["pane.keys"]).ok) {
        this.#d.log.info(`Enter could not be pressed again on a delivery's line (${r.ok ? "tmux refused the key" : r.error.code}); it stays typed`);
        return;
      }
    }
  }

  #wait(d: Delivery, reason: WaitingReason): void {
    if (d.state !== "queued" || d.waiting?.reason === reason) return;
    this.#change(d, { waiting: { reason, since: this.#d.now() } });
  }

  #change(d: Delivery, change: DeliveryChange): Delivery {
    const next = this.#d.store.update(d.id, change);
    this.#d.emit(next);
    return next;
  }

  #sameContent(a: OpArgs["lane.deliver"]): boolean {
    const t = this.#d.store.detail(a.id);
    if (!t || this.#d.store.textOf(a.id) !== a.text) return false;
    const was = t.target;
    const now = a.target;
    return "lane" in now ? "lane" in was && was.lane === now.lane : "workerId" in was && was.workerId === now.workerId;
  }
}
