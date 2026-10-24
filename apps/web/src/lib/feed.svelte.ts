// The live feed (Observation). Snapshot first, then sequenced events; a gap or a new hub run means resync (O1, O2).
// Screens arrive only for the watched worker, latest state only (O3).
// Every frame is decoded with the shared protocol (ADR-0008, A2): a malformed one is dropped, an unknown type ignored.
import { unreachable, type FeedEvent, type Message, type RosterEntry, type UsageNotice } from "@morndo/domain";
import { ServerFeedFrames, decode, decodeEvent, onDropped, type AlertWire, type CatchUpConversationWire, type ChatRowWire, type QueuedCommand, type ServerFeedFrame, type SessionInfoWire } from "@morndo/protocol";
import type { DecisionItem, LedgerState } from "./desktop/decisions.ts";
import { decodeMerged, decodeRuns, decodeTasks, type MergedView, type Run, type Task } from "./desktop/board.ts";
import { decodeJobs, type JobCount, type ShownJob } from "./desktop/jobs.ts";
import { decodeAccounts, type AccountUsage } from "./desktop/usage.ts";
import { FeedConnection, PROBE_AFTER_MS, type SocketLike } from "./connection.ts";
import { AttendingTracker } from "./attending.ts";
import { ABSENT_MANAGER, MANAGER, absentManager } from "./manager.ts";
// A list element the protocol dropped (it didn't fit) is worth a line in the console, never a crash.
onDropped(where => console.warn(`morndo: dropped a ${where} the hub sent that this app can't read`));

// Is this device still signed in? A 401 from /api/me says no; anything else (an answer, or no answer) is not a no.
export async function sessionState(): Promise<"ok" | "ended"> {
  try { return (await fetch("/api/me", { credentials: "same-origin" })).status === 401 ? "ended" : "ok"; }
  catch { return "ok"; }
}

// The watched conversation holds at most this many messages (O5's 300 on the hub is unchanged; older pages add to it).
export const MESSAGE_CAP = 1500;

export type ConnState = "connecting" | "live" | "reconnecting" | "offline" | "ended";
export type OlderState = { loading: boolean; done: boolean; failed: boolean };
const NO_OLDER: OlderState = { loading: false, done: false, failed: false };
export type Screen = { worker: string; text: string; at: number };
export type SessionInfo = SessionInfoWire;

export class LiveFeed {
  // Which layout this tab is (phone or desk). A reconnect says so, so the hub can drop this tab's previous socket.
  layout: string | null = null;
  status = $state<ConnState>("connecting");
  workers = $state<RosterEntry[]>([]);
  screen = $state<Screen | null>(null);
  messages = $state<Message[]>([]);          // the watched worker's conversation
  session = $state<SessionInfo>(null);
  historyFor = $state<string | null>(null);   // which worker `messages` belongs to (null while loading)
  details = $state<Record<string, SessionInfo>>({});   // session facts per worker, asked for by the details modal
  decisions = $state<DecisionItem[]>([]);              // what waits for the principal's call (Escalation), pushed whole
  ledger = $state<LedgerState>({ configured: false, ok: false, at: null });
  // ADR-0015: the team's board, whole, as the hub last sent it, and the lanes it lists now. A hub without a board never
  // sends it: empty, and the Board tab says so.
  board = $state<Task[]>([]);
  boardLanes = $state<string[]>([]);
  // ADR-0032: each lane's Run as the fleet derived it, by lane, from the same frame; null: the hub sends none.
  boardRuns = $state<ReadonlyMap<string, Run> | null>(null);
  // B11: where each task's merges stand, by task key, from the same frame; null: the hub sends none.
  boardMerged = $state<ReadonlyMap<string, MergedView> | null>(null);
  boardAt = $state<number | null>(null);
  // ADR-0016: every connected account's usage, as the hub last sent it. A hub without it never sends: Home says so.
  usage = $state<AccountUsage[]>([]);
  usageAt = $state<number | null>(null);
  // S4 (plan 4.4): the hub's own usage notices, newest first (the `usage` frame's `notices`, decoded). A reconnect
  // replaces them, as it replaces the accounts.
  usageNotices = $state<UsageNotice[]>([]);
  // The fleet's job mirror (design §7): the list and the counts beside each node. A hub without it never sends.
  jobs = $state<ShownJob[]>([]);
  jobCounts = $state<JobCount[]>([]);
  jobsMore = $state(0);
  jobsAt = $state<number | null>(null);
  onEnded: () => void = () => {};
  onMessages: (worker: string, added: Message[]) => void = () => {};
  // Phase D: read marks and mute per Conversation (by worker name), from the hub, the same on every device (O7).
  reads = $state<Record<string, number>>({});
  muted = $state<string[]>([]);
  // Older pages of the watched conversation (O9): loading, nothing older left, the hub couldn't read one (review L1),
  // and whether the newest messages were trimmed to keep the cap (then new ones are counted, not shown, until the
  // principal goes back to the latest). `olderPages` counts the pages put above, so the list knows a change was one
  // even when the cap trimmed its newest end too (review M4).
  older = $state<OlderState>({ loading: false, done: false, failed: false });
  olderPages = $state(0);
  detached = $state(false);
  newWhileDetached = $state(0);
  // Phase E (AC13): the latest device added from an Endpoint or a Link request that this device hasn't seen yet, live
  // or told at the hello after it was away (review M2).
  linked = $state<{ name: string; at: number; by: string | null } | null>(null);
  // Fleet core §7: whether the hub can reach the fleet service, as it last said. A hub that never says (one from before
  // the fleet) is available.
  fleetAvailable = $state(true);
  // Fleet-clients §9.1: where this device's messages to the manager stand in the fleet's queue, by request id, as the
  // hub last said (every one of the last day after a hello, then each change). The outbox applies them.
  deliveries = $state<QueuedCommand[]>([]);
  // Whether a message to the manager waits in the fleet's queue while it has no window, as the hub last said; null: a hub
  // from before, which the app lists the manager for only while it has one.
  managerQueue = $state<boolean | null>(null);
  // The fleet's latest alerts, newest first, as the hub last said (a hub without a fleet never sends them).
  alerts = $state<AlertWire[]>([]);
  // The lists' workers: these, and the manager as not running while it has no window (ABSENT_MANAGER), so every list
  // always shows it (the owner, 2026-10-12).
  roster = $derived(this.managerQueue === null || this.workers.some(w => w.name === MANAGER) ? this.workers : [absentManager(), ...this.workers]);
  // Catch-up (ADR-0009): what each unmuted conversation brought since its Read mark (C5), by conversation name, as the
  // hub last said (`catchupAt`: when the whole list last came); and when he last finished a run (C7).
  catchup = $state<Record<string, CatchUpConversationWire>>({});
  catchupAt = $state<number | null>(null);
  caughtUpAt = $state<number | null>(null);
  // The phone's chats (ADR-0011): one row per worker (H1), by worker id, as the hub last said; the digest since he left
  // (H5); and his last activity on any other device (H4), with how many times the hub said it, so a device can wait for
  // a word newer than its own return.
  chats = $state<Record<string, ChatRowWire>>({});
  chatsAt = $state<number | null>(null);
  digest = $state<{ since: number; conversations: CatchUpConversationWire[] } | null>(null);
  presence = $state<{ elsewhere: number | null; n: number }>({ elsewhere: null, n: 0 });
  // What this page knows is current: this connection's hello has been answered (the roster, the board, the read marks
  // and mutes), and nothing since says it may be old. False while connecting, reconnecting or offline, and after a wake
  // from a silence long enough to need a probe, until a frame arrives again (review of PR #7, findings 14 and 15).
  // Nothing may claim "nothing needs you" or open a catch-up run while it is false.
  primed = $state(false);
  #current = false;                                   // this connection's hello was answered
  #migrated = false;
  // Read marks and "caught up" stay pending until the hub says it has them: its echo of the mark (it tells every device,
  // this one too), or the next hello's state. A socket that took a frame and lost it (half-open, closed with 1011) is
  // therefore no loss: every new connection sends what is pending again (they only move forward, so a late one is still
  // right). Kept in localStorage, per conversation and merged, so a discarded page or another tab doesn't lose them
  // (review of PR #7, finding 10). Only a mark at or after a pending one confirms it: marks are message times (the hub's
  // clock on a legacy hub, the node's in fleet mode), and the hub lets a mark reach its conversation's newest message
  // (O7), so the echo of a mark is that mark and an older mark is another mark (Stage-4 review, finding 1).
  #pendingReads = new Map<string, number>();
  #pendingCaughtUp: number | null = null;
  static PENDING_READS_KEY = "morndo.unsent-reads";
  static PENDING_CAUGHT_UP_KEY = "morndo.unsent-caught-up";
  // Read, change and write back the stored marks, so tabs merge rather than overwrite each other.
  #storeReads(change: (stored: Record<string, number>) => void) {
    try {
      const raw = JSON.parse(localStorage.getItem(LiveFeed.PENDING_READS_KEY) ?? "{}") as Record<string, unknown>;
      const stored = Object.fromEntries(Object.entries(raw).filter((e): e is [string, number] => !!e[0] && typeof e[1] === "number"));
      change(stored);
      if (Object.keys(stored).length) localStorage.setItem(LiveFeed.PENDING_READS_KEY, JSON.stringify(stored));
      else localStorage.removeItem(LiveFeed.PENDING_READS_KEY);
    } catch { /* storage blocked: they wait on this page only */ }
  }
  #loadPending() {
    this.#storeReads(stored => { for (const [c, at] of Object.entries(stored)) this.#pendingReads.set(c, Math.max(at, this.#pendingReads.get(c) ?? 0)); });
    try {
      const v = Number(localStorage.getItem(LiveFeed.PENDING_CAUGHT_UP_KEY));
      if (Number.isFinite(v) && v > 0) this.#pendingCaughtUp = Math.max(v, this.#pendingCaughtUp ?? 0);
    } catch { /* nothing kept */ }
  }
  // The hub has this conversation read up to `at`: a pending mark at or before it is done; a newer one (this tab's, or
  // another's in storage) stays.
  #confirmRead(conversation: string, at: number) {
    const p = this.#pendingReads.get(conversation);
    if (p === undefined || at < p) return;
    this.#pendingReads.delete(conversation);
    this.#storeReads(stored => { if ((stored[conversation] ?? 0) <= at) delete stored[conversation]; });
  }
  #confirmCaughtUp(at: number) {
    if (this.#pendingCaughtUp === null || at < this.#pendingCaughtUp) return;
    this.#pendingCaughtUp = null;
    try { localStorage.removeItem(LiveFeed.PENDING_CAUGHT_UP_KEY); } catch { /* nothing kept */ }
  }

  #epoch: string | null = null;
  #seq = 0;
  #watching: string | null = null;
  #lastManager: string | null = null;      // the manager's window before it went: its conversation stays while it is gone
  #managerSaid: { id: string; messages: Message[] } | null = null;
  // The socket's lifecycle: app-level ping, wake, backoff, offline (connection.ts, ADR-0008 phase B).
  #conn = new FeedConnection({
    open: () => {
      const url = new URL("/api/feed", location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      return new WebSocket(url) as unknown as SocketLike;     // the browser's socket, seen through the shape connection.ts uses
    },
    timers: { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>) },
    online: () => navigator.onLine !== false,
    // A refused upgrade (signed out, revoked) reaches the browser as a plain failure: ask the hub (review M4).
    checkSession: sessionState,
    onOpen: () => {
      this.#hello();
      if (this.#watching && this.#watching !== ABSENT_MANAGER) this.#send({ t: "watch", worker: this.#watching });
      this.#sendPending();
      this.#attending.resend();                              // a new connection: the hub has no word from it yet
    },
    onFrame: data => {
      const d = decode(ServerFeedFrames, data);
      if (d.kind === "ok") this.#onMessage(d.frame);
      if (this.#current && !this.primed) this.primed = true;           // heard again after a wake: what came before is applied
    },
    onTransport: t => {
      if (t !== "open") { this.#current = false; this.primed = false; }
      if (t === "ended") { this.status = "ended"; this.onEnded(); }
      else if (t === "offline") this.status = "offline";
      else if (t === "reconnecting") this.status = "reconnecting";
      else if (t === "connecting" && this.status !== "live") this.status = "connecting";
      // "open": live once the snapshot or the catch-up arrives (#onMessage).
    },
  });

  // Waking up (visible again, restored from the back/forward cache, focused) checks the socket; the network events
  // stop and restart retrying.
  #onVisible = () => { if (document.visibilityState === "visible") this.#wake(); };
  #onWake = () => this.#wake();
  // Silent long enough that the connection may be gone (a phone that slept): not current until a frame comes again.
  #wake() {
    if (Date.now() - this.#conn.lastAliveAt > PROBE_AFTER_MS) this.primed = false;
    this.#conn.wake();
  }
  #onOnline = () => this.#conn.online();
  #onOffline = () => this.#conn.offline();
  // Whether he is attending here (phase F, N3): while he is, on any device, the hub pushes nothing.
  #attending = new AttendingTracker({
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>),
    hasFocus: () => document.hasFocus(),
    report: v => this.#send({ t: "visible", v }),
  });
  #onInput = () => { this.#attending.input(); };
  #onFocus = () => this.#attending.focusChanged();
  static #INPUTS = ["pointerdown", "keydown", "touchstart", "wheel"] as const;

  start() {
    this.#loadPending();
    document.addEventListener("visibilitychange", this.#onVisible);
    addEventListener("pageshow", this.#onWake);
    addEventListener("focus", this.#onWake);
    addEventListener("online", this.#onOnline);
    addEventListener("offline", this.#onOffline);
    for (const t of LiveFeed.#INPUTS) addEventListener(t, this.#onInput, { passive: true, capture: true });
    addEventListener("focus", this.#onFocus);
    addEventListener("blur", this.#onFocus);
    this.#conn.start();
  }

  stop() {
    document.removeEventListener("visibilitychange", this.#onVisible);
    removeEventListener("pageshow", this.#onWake);
    removeEventListener("focus", this.#onWake);
    removeEventListener("online", this.#onOnline);
    removeEventListener("offline", this.#onOffline);
    for (const t of LiveFeed.#INPUTS) removeEventListener(t, this.#onInput, { capture: true });
    removeEventListener("focus", this.#onFocus);
    removeEventListener("blur", this.#onFocus);
    this.#attending.stop();
    this.#conn.stop();
  }

  watch(worker: string | null) {
    if (this.#watching === worker) return;
    this.#watching = worker;
    if (this.screen && this.screen.worker !== worker) this.screen = null;
    // The manager going away (a restart) leaves its conversation on its row until it is back (staging QA, 2026-10-12):
    // kept when it is left, as the phone leaves it (its chat closes for the window, then opens for the row).
    if (this.historyFor !== null && this.historyFor === this.#lastManager) this.#managerSaid = { id: this.historyFor, messages: this.messages };
    if (this.historyFor !== worker) { this.messages = []; this.historyFor = null; this.session = null; }
    this.older = NO_OLDER;
    this.detached = false;
    this.newWhileDetached = 0;
    // The manager with no window: the hub knows no worker of that id, so nothing is asked, and no older page is read.
    if (worker === ABSENT_MANAGER) {
      if (this.#managerSaid?.id === this.#lastManager) this.messages = this.#managerSaid.messages;
      this.historyFor = worker;
      return;
    }
    this.#send({ t: "watch", worker });
  }

  // Back to the latest messages after older pages pushed them out (the jump button): the hub sends the history again.
  latest() {
    if (!this.#watching || this.#watching === ABSENT_MANAGER) return;
    this.detached = false;
    this.newWhileDetached = 0;
    this.older = NO_OLDER;
    this.#send({ t: "watch", worker: this.#watching });
  }

  // The principal read this Conversation up to `at` (O7); the hub keeps the latest and tells every device. Pending,
  // here and in localStorage, until the hub says it has it.
  markRead(conversation: string, at: number) {
    if (at <= (this.reads[conversation] ?? 0)) return;
    this.reads[conversation] = at;                                    // at once here; the hub's answer confirms it
    this.#pendingReads.set(conversation, Math.max(at, this.#pendingReads.get(conversation) ?? 0));
    this.#storeReads(stored => { stored[conversation] = Math.max(at, stored[conversation] ?? 0); });
    this.#send({ t: "read", conversation, at });
  }

  // Catch-up (ADR-0009): ask what is new since the Read marks, for every conversation or one (C5).
  requestCatchUp(worker?: string) { return this.#send(worker ? { t: "catchup", worker } : { t: "catchup" }); }
  // ADR-0011: the chat list, the digest since `since`, and his last activity elsewhere. Each false when not on the socket.
  requestChats() { return this.#send({ t: "chats" }); }
  requestDigest(since: number) { return this.#send({ t: "digest", since: Math.max(0, Math.floor(since)) }); }
  requestPresence() { return this.#send({ t: "presence" }); }
  // He finished a catch-up run at `at` (C7).
  markCaughtUp(at: number) {
    if (at <= (this.caughtUpAt ?? 0)) return;
    this.caughtUpAt = at;
    this.#pendingCaughtUp = Math.max(at, this.#pendingCaughtUp ?? 0);
    try { localStorage.setItem(LiveFeed.PENDING_CAUGHT_UP_KEY, String(this.#pendingCaughtUp)); } catch { /* this page only */ }
    this.#send({ t: "caught_up", at });
  }
  get pending() { return this.#pendingReads.size + (this.#pendingCaughtUp === null ? 0 : 1); }
  // A new connection: everything still pending goes again, after the hello (the hub takes frames in order).
  #sendPending() {
    for (const [conversation, at] of this.#pendingReads) this.#send({ t: "read", conversation, at });
    if (this.#pendingCaughtUp !== null) this.#send({ t: "caught_up", at: this.#pendingCaughtUp });
  }

  // Dismissed or reviewed here: the hub stops telling this device of additions up to then.
  seeLinked(at: number) {
    if (this.linked && this.linked.at <= at) this.linked = null;
    this.#send({ t: "linked_seen", at });
  }

  setMuted(conversation: string, muted: boolean) {
    this.muted = muted ? [...new Set([...this.muted, conversation])] : this.muted.filter(c => c !== conversation);
    this.#send({ t: "mute", conversation, muted });
  }

  // An older page before the oldest message held (O9).
  loadOlder() {
    const oldest = this.messages[0];
    if (!this.#watching || this.#watching === ABSENT_MANAGER || !oldest || this.older.loading || this.older.done) return;
    this.older = { loading: true, done: false, failed: false };
    this.#send({ t: "older", worker: this.#watching, before: oldest.id });
  }

  // The first time this device hears the hub's marks: what it kept itself before (localStorage "morndo.read", and mute
  // in "morndo.conversations") goes up once, the hub keeps the later mark, and the device stops keeping its own.
  #migrateOnce() {
    if (this.#migrated) return;
    this.#migrated = true;
    try {
      // One frame each, and the hub closes a feed that sends over about 100 at once (whole-branch review L6): the 50
      // latest marks and 30 mutes go up; older marks belong to conversations long gone.
      const old = JSON.parse(localStorage.getItem("morndo.read") ?? "{}") as Record<string, unknown>;
      const latest = Object.entries(old).filter((e): e is [string, number] => typeof e[1] === "number").sort((a, b) => b[1] - a[1]).slice(0, 50);
      for (const [c, at] of latest) if (at > (this.reads[c] ?? 0)) this.markRead(c, at);
      localStorage.removeItem("morndo.read");
      const prefs = JSON.parse(localStorage.getItem("morndo.conversations") ?? "{}") as Record<string, { muted?: unknown }>;
      let changed = false, mutes = 0;
      for (const [c, p] of Object.entries(prefs)) {
        if (p?.muted === true && !this.muted.includes(c) && mutes++ < 30) this.setMuted(c, true);
        if (p && "muted" in p) { delete p.muted; changed = true; }
      }
      if (changed) localStorage.setItem("morndo.conversations", JSON.stringify(prefs));
    } catch { /* storage blocked or unreadable: nothing to bring up */ }
  }

  get watching() { return this.#watching; }

  askDetails(worker: string) { if (worker !== ABSENT_MANAGER) this.#send({ t: "details", worker }); }

  #send(m: unknown): boolean { return this.#conn.send(m); }
  #noteManager() { const m = this.workers.find(w => w.name === MANAGER); if (m) this.#lastManager = m.id; }

  #onMessage(m: ServerFeedFrame) {
    switch (m.t) {
      case "snapshot":
        this.#epoch = m.epoch;
        this.#seq = m.seq;
        this.#noteManager();
        this.workers = m.workers;
        this.status = "live";
        break;
      case "events": {
        // Decoded one by one: a malformed event drops the rest of the frame and resyncs, as a gap does (O2); an event
        // of a type this build doesn't know keeps its place in the sequence and is skipped (O1).
        for (const raw of m.events) {
          const d = decodeEvent(raw);
          if (d.kind === "malformed") return this.#resync();
          const at = d.kind === "event" ? d.event : d;
          if (at.epoch !== this.#epoch || at.seq !== this.#seq + 1) return this.#resync();
          if (d.kind === "event") this.#apply(d.event);
          this.#seq = at.seq;
        }
        this.status = "live";
        break;
      }
      case "screen":
        if (m.worker === this.#watching) this.screen = { worker: m.worker, text: m.text, at: m.at };
        break;
      case "history": {
        if (m.worker !== this.#watching) break;
        this.session = m.session;
        this.details[m.worker] = m.session;
        // Sent again for the conversation already shown (a reconnect): the older pages read stay, and the place with
        // them (review L3). Reading far back (detached), nothing changes; otherwise what is new is added, if the
        // history meets what is held; with a gap between them, the history replaces it.
        if (this.historyFor === m.worker && this.messages.length) {
          if (this.detached) break;
          const known = new Set(this.messages.map(x => x.id));
          if (m.messages.some(x => known.has(x.id))) {
            // A copy that landed while the socket was down: its attachments frame went nowhere, but this history carries it.
            const fresh = new Map(m.messages.map(x => [x.id, x]));
            const settled = (x: Message): Message => {
              const f = fresh.get(x.id)?.attachments;
              return f && x.attachments?.some(a => a.pending) ? { ...x, attachments: f } : x;
            };
            const added = m.messages.filter(x => !known.has(x.id));
            this.messages = [...this.messages.map(settled), ...added].slice(-MESSAGE_CAP);
            if (added.length) this.onMessages(m.worker, added);
            break;
          }
        }
        this.messages = m.messages;
        this.detached = false;                                        // the latest again: older pages start over
        this.newWhileDetached = 0;
        this.older = NO_OLDER;
        this.historyFor = m.worker;
        break;
      }
      case "details":
        this.details[m.worker] = m.session;
        break;
      case "decisions":
        this.decisions = m.items;
        this.ledger = m.ledger;
        break;
      case "usage": {
        const { accounts, dropped } = decodeAccounts(m.accounts);
        if (dropped) console.warn(`morndo: dropped ${dropped} account(s) the hub sent that this app can't read`);
        this.usage = accounts;
        this.usageAt = m.at;
        break;
      }
      case "board": {
        const { tasks, dropped } = decodeTasks(m.tasks);
        if (dropped) console.warn(`morndo: dropped ${dropped} task(s) the hub sent that this app can't read`);
        const runs = decodeRuns(m.runs);
        if (runs.dropped) console.warn(`morndo: dropped ${runs.dropped} run(s) the hub sent that this app can't read`);
        const merged = decodeMerged(m.merged);
        if (merged.dropped) console.warn(`morndo: dropped ${merged.dropped} merged view(s) the hub sent that this app can't read`);
        this.board = tasks;
        this.boardLanes = m.lanes;
        this.boardRuns = runs.runs;
        this.boardMerged = merged.merged;
        this.boardAt = m.at;
        break;
      }
      case "jobs": {
        const { jobs, dropped } = decodeJobs(m.jobs);
        if (dropped) console.warn(`morndo: dropped ${dropped} job(s) the hub sent that this app can't read`);
        this.jobs = jobs;
        this.jobCounts = m.counts;
        this.jobsMore = m.more;
        this.jobsAt = m.at;
        break;
      }
      case "messages": {
        if (m.worker !== this.#watching) break;
        const known = new Set(this.messages.map(x => x.id));
        const added = m.messages.filter(x => !known.has(x.id));
        if (!added.length) break;
        if (this.detached) { this.newWhileDetached += added.length; break; }   // the latest aren't in view: counted
        this.messages = [...this.messages, ...added].slice(-MESSAGE_CAP);
        this.onMessages(m.worker, added);
        break;
      }
      case "pong":
        this.#conn.pong(m.n);
        break;
      case "reading":
        // What the hub has confirms what is pending; a mark still pending wins over the hub's older one (forward only).
        for (const [c, at] of Object.entries(m.reads)) this.#confirmRead(c, at);
        this.reads = { ...m.reads, ...Object.fromEntries([...this.#pendingReads].filter(([c, at]) => at > (m.reads[c] ?? 0))) };
        this.muted = [...m.muted];
        this.#migrateOnce();
        this.#current = true;
        this.primed = true;
        break;
      case "read":
        if (m.at > (this.reads[m.conversation] ?? 0)) this.reads[m.conversation] = m.at;
        this.#confirmRead(m.conversation, m.at);
        break;
      case "mute":
        this.muted = m.muted ? [...new Set([...this.muted, m.conversation])] : this.muted.filter(c => c !== m.conversation);
        break;
      case "linked":
        if (!this.linked || m.at >= this.linked.at) this.linked = { name: m.name, at: m.at, by: m.by ?? null };
        break;
      case "catchup": {
        if (m.only === undefined) {
          this.catchup = Object.fromEntries(m.conversations.map(c => [c.name, c]));
          this.catchupAt = Date.now();
        } else {
          for (const c of m.conversations) this.catchup[c.name] = c;
        }
        break;
      }
      case "chats":
        this.chats = Object.fromEntries(m.chats.map(c => [c.worker, c]));
        this.chatsAt = Date.now();
        break;
      case "digest":
        this.digest = { since: m.since, conversations: m.conversations };
        break;
      case "presence":
        this.presence = { elsewhere: m.elsewhere, n: this.presence.n + 1 };
        break;
      case "caught_up":
        if (m.at !== null && m.at > (this.caughtUpAt ?? 0)) this.caughtUpAt = m.at;
        if (m.at !== null) this.#confirmCaughtUp(m.at);
        break;
      // A message's files once the hub's copies of them landed (fleet core §3.1): they showed as pending until now.
      case "attachments": {
        if (m.worker !== this.#watching) break;
        const i = this.messages.findIndex(x => x.id === m.message);
        const held = this.messages[i];
        if (held) this.messages[i] = { ...held, attachments: m.attachments };
        break;
      }
      case "fleet":
        this.fleetAvailable = m.available;
        break;
      case "manager":
        this.managerQueue = m.queue;
        break;
      case "alerts":
        this.alerts = m.items;
        break;
      case "deliveries": {
        const named = new Set(m.items.map(i => i.requestId));
        this.deliveries = [...this.deliveries.filter(d => !named.has(d.requestId)), ...m.items].slice(-500);
        break;
      }
      case "older": {
        if (m.worker !== this.#watching) break;
        // An answer for another view of this conversation (the list changed meanwhile): not loading any more (L2).
        if (m.before !== this.messages[0]?.id) { if (this.older.loading) this.older = NO_OLDER; break; }
        if (m.missing) { this.older = { loading: false, done: false, failed: true }; break; }
        const known = new Set(this.messages.map(x => x.id));
        const page = m.messages.filter(x => !known.has(x.id));
        const all = [...page, ...this.messages];
        // Over the cap, the far end goes: here the newest, so the view stays where the principal is reading.
        if (all.length > MESSAGE_CAP) { this.messages = all.slice(0, MESSAGE_CAP); this.detached = true; }
        else this.messages = all;
        this.olderPages++;
        this.older = { loading: false, done: m.done, failed: false };
        break;
      }
      default:
        unreachable(m);
    }
  }

  #hello() {
    const hello: { t: "hello"; epoch?: string; cursor?: number; layout?: string } =
      this.#epoch ? { t: "hello", epoch: this.#epoch, cursor: this.#seq } : { t: "hello" };
    if (this.layout) hello.layout = this.layout;
    this.#send(hello);
  }

  #resync() {
    this.#epoch = null;
    this.#seq = 0;
    this.#hello();
  }

  #apply(e: FeedEvent) {
    const b = e.body;
    const find = (id: string) => this.workers.find(w => w.id === id);
    switch (b.type) {
      case "WorkerAppeared":
        if (!find(b.worker.id)) this.workers.push({ ...b.worker, offline: b.offline, state: b.state, changedAt: b.changedAt, title: null, lastMessageAt: null, needsYou: false, waitingOn: null });
        break;
      case "WorkerTitled": {
        const w = find(b.workerId);
        if (w) w.title = b.title;
        break;
      }
      case "WorkerSpoke": {
        const w = find(b.workerId);
        if (w) w.lastMessageAt = b.at;
        break;
      }
      case "WorkerNeedsYouChanged": {
        const w = find(b.workerId);
        if (w) { w.needsYou = b.needsYou; w.waitingOn = b.waitingOn; }
        break;
      }
      case "WorkerRenamed": {
        const w = find(b.workerId);
        if (w) w.name = b.name;
        break;
      }
      case "WorkerMoved": {
        const w = find(b.workerId);
        if (w) w.location = b.location;
        break;
      }
      case "WorkerOfflineChanged": {
        const w = find(b.workerId);
        if (w) w.offline = b.offline;
        break;
      }
      case "WorkerBecameActive":
      case "WorkerBecameQuiet": {
        const w = find(b.workerId);
        if (w) { w.state = b.type === "WorkerBecameActive" ? "active" : "quiet"; w.changedAt = b.changedAt; }
        break;
      }
      case "WorkerGone":
        this.#noteManager();
        this.workers = this.workers.filter(w => w.id !== b.workerId);
        if (this.#watching === b.workerId) this.screen = null;
        break;
      default:
        unreachable(b);
    }
  }
}
