// Application service for the Observation context: polls the multiplexer, feeds the domain Roster and Feed,
// and tells subscribers what changed. Screens go only to the endpoints that watch that worker (latest state only).
// Workers live on nodes (fleet core §3.1). Each poll lists them once, then works through every node at the same time:
// one captureMany for its screens, then its followed transcripts. It waits at most `nodeWaitMs` for them. A node still
// busy from an earlier poll, or not online, is skipped, so a slow node never holds up the others; what a node brings
// after the poll stopped waiting is applied by the next poll.
import { randomUUID } from "node:crypto";
import { Conversation, Feed, Roster, needsYou, waitingOn, workerId, type Attachment, type ConversationEntry, type FeedBody, type FeedEvent, type Message, type RosterEntry } from "@morndo/domain";
import { menuIdentity, menuOnScreen, type SessionInfo } from "@morndo/node-ops";
import { mapLimit } from "@morndo/service-kit";
import { followTranscript, olderPage, type FileRef, type TranscriptCursor } from "../adapters/claude-sessions.ts";
import { log } from "../adapters/log.ts";
import { SourceUnavailable, type LaneReport, type LaneStatuses, type NodeStates, type RemoteFiles, type Sessions, type Tmux, type TranscriptSource } from "./ports.ts";

// How many of one node's transcripts are asked at once: each is a round trip to the node through the fleet.
const FOLLOW_PARALLEL = 4;

type Followed = { sessionId: string; cursor: TranscriptCursor; conversation: Conversation; title: string | null };

// What one node's round brought: its screens, the messages its transcripts added (with the follow they went into, so a
// follow rebuilt meanwhile doesn't take another's), and the follows that are new this round.
type NodeRound = { screens: Map<string, string | null>; added: Map<string, { follow: Followed; messages: Message[] }>; rebuilt: Set<string> };

export type Snapshot = { epoch: string; seq: number; workers: RosterEntry[] };
export type OlderResult = { messages: Message[]; done: boolean; missing?: true };
const MISSING: OlderResult = { messages: [], done: false, missing: true };
const OLDER_COPY_WAIT_MS = 1000;                       // an older page waits this long for its files' copies, at most

export type Listener = {
  events(events: FeedEvent[]): void;
  screen(workerId: string, text: string, at: number): void;
  messages(workerId: string, messages: Message[]): void;   // new messages, appended to what the watcher holds
  history(workerId: string, messages: Message[]): void;    // replaces what the watcher holds (a follow was rebuilt)
  // A message's files once their copies were made (they showed as pending): they replace that message's attachments.
  attachments?(workerId: string, messageId: string, attachments: Attachment[]): void;
  watching(): string | null;
  // Whether the fleet answers, each time that changes (Task 14; fleet core §7): "unavailable" while no listing can be
  // had. A legacy hub never calls it.
  fleet?(status: "ok" | "unavailable"): void;
};
type Listing = Awaited<ReturnType<Tmux["listWorkers"]>>;

// Where the service reads from besides tmux. Each is optional: a hub without a Claude config dir follows no transcripts.
// `nodeWaitMs`: how long a poll waits for its nodes before it goes on without the slow ones (main.ts: the poll interval).
export type ObservationSources = {
  sessions?: Sessions | null;
  transcripts?: TranscriptSource | null;
  files?: RemoteFiles | null;
  nodeStates?: NodeStates | null;
  nodeWaitMs?: number;
  // Engine-lane reports for this poll (busy or idle). Null: the screen decides every worker.
  lanes?: LaneStatuses | null;
  // The fleet node this machine is. With node states and no name, reports apply to nobody. Without node states
  // (a legacy hub) every worker is local.
  engineNode?: string | null;
};

export class ObservationService {
  readonly feed = new Feed(randomUUID(), 2000);
  #roster: Roster;
  #tmux: Pick<Tmux, "listWorkers" | "captureMany">;
  #listeners = new Set<Listener>();
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  #busy = false;
  #now: () => number;
  #sessions: Sessions | null;
  #transcripts: TranscriptSource | null;
  #files: RemoteFiles | null;
  #nodeStates: NodeStates | null;
  #nodeWaitMs: number;
  #followed = new Map<string, Followed>();             // worker ID → its session's conversation
  #panes = new Map<string, SessionInfo>();
  #panesAt = 0;
  #nodeOf = new Map<string, string>();                 // worker ID → its node, from the last listing
  #working = new Set<string>();                        // nodes whose round is still running
  #arrived: NodeRound[] = [];                          // rounds done and not yet applied
  #listing: Listing = [];                              // the last listing that came
  #conflicted = new Set<string>();                     // workers whose name the lane registry has in conflict
  #fleet: "ok" | "unavailable" = "ok";
  #lanes: LaneStatuses | null;
  #engineNode: string | null;
  #engineNodeNoted = false;
  #nodeStatesNow: ReadonlyMap<string, string> | null = null;
  #born: number;

  constructor(tmux: Pick<Tmux, "listWorkers" | "captureMany">, quietAfterMs: number, now: () => number = Date.now, o: ObservationSources = {}) {
    this.#tmux = tmux;
    this.#roster = new Roster(quietAfterMs);
    this.#now = now;
    this.#born = now();
    this.#sessions = o.sessions ?? null;
    this.#transcripts = o.transcripts ?? null;
    this.#files = o.files ?? null;
    this.#nodeStates = o.nodeStates ?? null;
    this.#nodeWaitMs = o.nodeWaitMs ?? 1000;
    this.#lanes = o.lanes ?? null;
    this.#engineNode = o.engineNode ?? null;
  }

  history(id: string, n = 150): Message[] { return this.#followed.get(id)?.conversation.latest(n) ?? []; }
  openQuestions(id: string): Message[] { return this.#followed.get(id)?.conversation.openQuestionMessages() ?? []; }
  session(id: string): SessionInfo | undefined { return this.#panes.get(id); }

  // An older page of a worker's conversation (ADR-0008 phase D, O9): read from its transcript on demand for the
  // Endpoint that asked, never kept here (O5's 300 is unchanged). The files those messages carry get the hub's copies.
  // The source finds the message asked for itself (locate), so no page starts are remembered here. `missing`: an
  // unknown worker, a message not in its transcript, or a transcript that can't be read now: not the beginning (L1).
  // A source that can't answer now (SourceUnavailable) is `missing` too: the app says it couldn't load the page and
  // offers Try again, and the follow is untouched, so paging works again once the node answers.
  async older(id: string, before: string): Promise<OlderResult> {
    const f = this.#followed.get(id);
    const name = this.nameOf(id);
    if (!f || name === null || !this.#transcripts) return MISSING;
    try {
      const page = await olderPage(this.#bytes(this.#transcripts, f.sessionId), name, before);
      // A copy made already comes back at once; one still being made goes out pending, and the watcher is told once it
      // lands (only then: what landed while waiting goes out with the page).
      const shown = { now: false };
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([this.#attachCopies(id, page.messages, page.files, shown), new Promise<void>(r => { timer = setTimeout(r, OLDER_COPY_WAIT_MS); })]);
      clearTimeout(timer);
      shown.now = true;
      return page.missing ? MISSING : { messages: page.messages, done: page.done };
    } catch (e) {
      log.warn(`older page of ${id} unreadable: ${(e as Error).message}`);
      return MISSING;                                           // the transcript went away, or its node didn't answer
    }
  }

  // Files a message carries: the hub keeps its own copy (files.ts); the message names it by id, never by path. Copies are
  // made in the background (fleet core §3.1): until one lands its attachment is `pending`, and once all of a message's
  // copies have landed, whoever watches that worker gets its attachments again, if the message was out by then
  // (`shown`; a live message may be, from the moment it is read). Resolves then; never rejects.
  #attachCopies(workerId: string, entries: readonly ConversationEntry[], refs: readonly FileRef[], shown = { now: true }): Promise<void> {
    const files = this.#files;
    if (!files) return Promise.resolve();
    const messages: Promise<void>[] = [];
    for (const ref of refs) {
      const m = entries.find(e => e.id === ref.messageId);
      if (!m || m.kind === "answer" || !m.attachments) continue;
      const message = m;
      const copies = ref.paths.flatMap((p, i) => {
        const a = message.attachments?.[i];
        if (!a) return [];
        a.pending = true;
        return [files.register(workerId, p)
          .then(r => { a.id = r.id; a.size = r.size; }, (e: unknown) => { log.warn(`a file in ${workerId}'s conversation wasn't copied: ${(e as Error).message}`); })
          .finally(() => { delete a.pending; })];
      });
      if (!copies.length) continue;
      messages.push(Promise.all(copies)
        .then(() => {
          if (!shown.now) return;
          for (const l of this.#listeners) if (l.watching() === workerId) l.attachments?.(workerId, message.id, message.attachments ?? []);
        })
        .catch((e: unknown) => { log.warn(`telling a watcher about ${workerId}'s files failed`, e); }));
    }
    return Promise.all(messages).then(() => {});
  }

  // One session's transcript as the byte source the transcript reader takes.
  #bytes(t: TranscriptSource, sessionId: string) {
    return {
      size: () => t.size(sessionId),
      read: (offset: number, max: number) => t.read(sessionId, offset, max),
      locate: (needle: string) => t.locate(sessionId, needle),
    };
  }

  snapshot(): Snapshot { return { epoch: this.feed.epoch, seq: this.feed.head, workers: this.#roster.entries() }; }
  // What a worker waits for now (S6), as a Command carries it: "none", or the question or menu identity.
  waitingOn(id: string): string { return this.#roster.entries().find(w => w.id === id)?.waitingOn ?? "none"; }
  nameOf(id: string): string | null { return this.#roster.entries().find(w => w.id === id)?.name ?? null; }
  screen(id: string) { return this.#roster.screen(workerId(id)); }

  subscribe(l: Listener) { this.#listeners.add(l); return () => this.#listeners.delete(l); }
  // Whether the fleet answers (fleet core §7); a legacy hub's is always "ok".
  fleet(): "ok" | "unavailable" { return this.#fleet; }
  // Whether a worker's name is in conflict in the fleet's lane registry (two windows claim it): routes by that name
  // (the manager's answers) refuse it; a send by its worker id still goes (Task 14).
  conflicted(id: string): boolean { return this.#conflicted.has(id); }

  // stop() during a poll also ends the loop: that poll, which now awaits its nodes, schedules no next one.
  start(pollMs: number) {
    this.#stopped = false;
    const loop = async () => {
      try { await this.poll(); }
      catch (e) { log.error(`observation poll failed, polling again: ${(e as Error).message}`); }
      if (!this.#stopped) this.#timer = setTimeout(() => void loop(), pollMs);
    };
    void loop();
  }
  stop() { this.#stopped = true; if (this.#timer) clearTimeout(this.#timer); }

  // `complete`: this look saw everything there is to see now: the fleet answered the listing, and every node it asked
  // brought its round within nodeWaitMs. A first look that isn't would make what already waits look new (main.ts; N2).
  async poll(): Promise<{ complete: boolean }> {
    if (this.#busy) return { complete: false };
    this.#busy = true;
    try {
      const now = this.#now();
      const listing = await this.#list();
      this.#nodeOf = new Map(listing.map(w => [w.id, w.node]));
      const bodies = this.#roster.observeListing(listing.map(w => ({ id: workerId(w.id), name: w.name, location: w.location, node: w.node, offline: w.offline })), now);
      await this.#refreshSessions(now);
      this.#dropFollows();
      const inTime = await this.#pollNodes();
      this.#noteEngineNode();
      // Reports before the screens are applied: a governed worker's pane can change the text and not its state.
      const governed = this.#governed(await this.#readLanes());
      const changedScreens = new Map<string, string>();
      const newMessages = new Map<string, Message[]>();
      const rebuilt = new Set<string>();
      for (const round of this.#arrived.splice(0)) this.#apply(round, bodies, changedScreens, newMessages, rebuilt, governed);
      bodies.push(...this.#applyGoverned(governed, this.#now()));
      bodies.push(...this.#roster.tick(this.#now()));
      for (const w of this.#roster.entries()) {
        const f = this.#followed.get(w.id);
        const screen = this.#roster.screen(w.id) ?? "";
        const open = f?.conversation.openQuestionMessages().map(m => m.questionId ?? m.id) ?? [];
        bodies.push(...this.#roster.observeDetails(w.id, {
          title: f?.title ?? null,
          lastMessageAt: f?.conversation.lastAt ?? null,
          needsYou: needsYou({ openQuestions: f?.conversation.openQuestions ?? 0, menuOnScreen: menuOnScreen(screen) }),
          waitingOn: waitingOn({ openQuestionIds: open, menu: menuIdentity(screen) }),
        }));
      }
      const events = bodies.map(b => this.feed.append(b, now));
      for (const l of this.#listeners) {
        if (events.length) l.events(events);
        const watching = l.watching();
        const s = watching === null ? undefined : changedScreens.get(watching);
        if (watching !== null && s !== undefined) l.screen(watching, s, now);
        if (watching !== null && rebuilt.has(watching)) { l.history(watching, this.history(watching)); continue; }
        const m = watching === null ? undefined : newMessages.get(watching);
        if (watching !== null && m?.length) l.messages(watching, m);
      }
      return { complete: this.#fleet === "ok" && inTime };
    } finally {
      this.#busy = false;
    }
  }

  // The listing. With a fleet (nodeStates set), one that can't be had (the fleet down or unreachable) keeps the last
  // roster with every worker offline, since nothing is known of them now, and says "unavailable" until a listing comes
  // again (fleet core §7: "the hub shows fleet unavailable"). Legacy: a failure is the poll's, as before.
  async #list(): Promise<Listing> {
    try {
      const listing = await this.#tmux.listWorkers();
      this.#listing = listing;
      this.#conflicted = new Set(listing.filter(w => w.conflict).map(w => w.id));
      this.#setFleet("ok");
      return listing;
    } catch (e) {
      if (!this.#nodeStates) throw e;
      if (this.#fleet === "ok") log.warn(`fleet unavailable (${(e as Error).message}): the roster stays, every worker offline`);
      this.#setFleet("unavailable");
      return this.#listing.map(w => ({ ...w, offline: true }));
    }
  }
  #setFleet(status: "ok" | "unavailable") {
    if (status === this.#fleet) return;
    this.#fleet = status;
    for (const l of this.#listeners) l.fleet?.(status);
  }

  // Which agent session runs in which pane, read again every 10 s.
  async #refreshSessions(now: number) {
    if (!this.#sessions || (now - this.#panesAt < 10_000 && this.#panesAt !== 0)) return;
    this.#panes = await this.#sessions.byPane();
    this.#panesAt = now;
  }

  // A follow ends when its worker is gone or its pane runs another session now.
  #dropFollows() {
    const alive = new Set(this.#roster.entries().map(w => w.id as string));
    for (const [id, f] of this.#followed) {
      if (!alive.has(id) || this.#panes.get(id)?.sessionId !== f.sessionId) this.#followed.delete(id);
    }
  }

  // Every node with workers, at the same time (Promise.allSettled), waited for at most `nodeWaitMs`. True when every round
  // it started came in within that time (none still running from an earlier poll).
  async #pollNodes(): Promise<boolean> {
    if (this.#fleet === "unavailable") return false;           // nothing can be asked of any node now
    const states = this.#nodeStates ? await this.#nodeStates() : null;
    this.#nodeStatesNow = states;
    const byNode = new Map<string, string[]>();
    for (const w of this.#roster.entries()) {
      const node = this.#nodeOf.get(w.id) ?? "";
      byNode.set(node, [...(byNode.get(node) ?? []), w.id]);
    }
    const rounds: Promise<void>[] = [];
    let behind = false;                                          // a node whose earlier round still runs
    for (const [node, ids] of byNode) {
      if (states && states.get(node) !== "online") continue;      // not online: skipped at once
      if (this.#working.has(node)) { behind = true; continue; }    // its last round still runs: no second one on top
      this.#working.add(node);
      rounds.push(this.#pollNode(ids).then(
        r => { this.#arrived.push(r); },
        (e: unknown) => { log.warn(`observation: node ${node} failed this round: ${(e as Error).message}`); },
      ).finally(() => { this.#working.delete(node); }));
    }
    if (!rounds.length) return !behind;
    let timer: NodeJS.Timeout | undefined;
    let inTime = false;
    const waited = new Promise<void>(resolve => { timer = setTimeout(resolve, this.#nodeWaitMs); });
    try { await Promise.race([Promise.allSettled(rounds).then(() => { inTime = true; }), waited]); }
    finally { clearTimeout(timer); }
    return inTime && !behind;
  }

  // One node's round: its screens in one captureMany, then its followed transcripts, FOLLOW_PARALLEL at a time (asked one
  // by one, a node with many lanes took longer than the poll interval, and its next round was skipped). What they bring is
  // joined in the order of `ids`, so the feed sees what it saw before. The roster is not touched here; whichever poll
  // finds the round arrived applies it.
  async #pollNode(ids: string[]): Promise<NodeRound> {
    const round: NodeRound = { screens: await this.#tmux.captureMany(ids), added: new Map(), rebuilt: new Set() };
    const transcripts = this.#transcripts;
    if (!this.#sessions || !transcripts) return round;
    const parts = await mapLimit(ids, FOLLOW_PARALLEL, id => this.#followOne(id, transcripts));
    for (const [i, part] of parts.entries()) {
      const id = ids[i] as string;
      if (part.rebuilt) round.rebuilt.add(id);
      if (part.added) round.added.set(id, part.added);
    }
    return round;
  }

  // One followed transcript's part of a node's round: whether its follow was made now, and what it added.
  async #followOne(id: string, transcripts: TranscriptSource): Promise<{ rebuilt: boolean; added?: { follow: Followed; messages: Message[] } }> {
    const info = this.#panes.get(id);
    const name = this.nameOf(id);
    if (!info || name === null) return { rebuilt: false };
    let rebuilt = false;
    let f = this.#followed.get(id);
    if (!f) {
      let size: number | null;
      try { size = await transcripts.size(info.sessionId); }
      catch { return { rebuilt: false }; }        // can't be asked now: try again next poll
      if (size === null) return { rebuilt: false };   // no transcript (yet): try again next poll
      f = { sessionId: info.sessionId, cursor: { offset: 0, pending: new Set() }, conversation: new Conversation(), title: null };
      this.#followed.set(id, f);
      rebuilt = true;                              // its first read is the whole tail again, never new messages (O5)
    }
    try {
      const parsed = await followTranscript(this.#bytes(transcripts, f.sessionId), f.cursor, name);
      if (parsed.title) f.title = parsed.title;
      void this.#attachCopies(id, parsed.entries, parsed.files);      // in the background: the round doesn't wait
      const fresh = f.conversation.add(parsed.entries);
      return fresh.length ? { rebuilt, added: { follow: f, messages: fresh } } : { rebuilt };
    } catch (e) {
      // Can't be read now (SourceUnavailable: its node offline, the fleet slow): the follow keeps its place and its
      // conversation, and the next poll reads on from there. One made this round starts over, so that its first read
      // stays a whole history (O5).
      if (e instanceof SourceUnavailable && !rebuilt) return { rebuilt: false };
      if (this.#followed.get(id) === f) this.#followed.delete(id);   // gone, moved or unreadable: start over next poll
      return { rebuilt: false };
    }
  }

  // This poll's reports. The reader warns once when its directory fails; a throw here leaves the screen in charge
  // and is not logged again on the next poll.
  async #readLanes(): Promise<readonly LaneReport[]> {
    if (!this.#lanes) return [];
    try { return await this.#lanes(); }
    catch { return []; }
  }

  // A legacy hub has no node states: every worker is on this machine. A fleet applies a report only on `engineNode`.
  #onHub(node: string): boolean {
    if (!this.#nodeStates) return true;
    return this.#engineNode !== null && node === this.#engineNode;
  }

  // A name still absent two minutes after the hub starts is said once, from the map this poll already fetched.
  // Sooner than that, the node may simply not have connected yet. An empty map is the fleet not answering, not a
  // missing name. The warning does not say the feature stays off: a later poll applies reports once the node is there.
  #noteEngineNode() {
    if (this.#engineNodeNoted || !this.#engineNode || !this.#nodeStates) return;
    if (this.#now() - this.#born < 120_000) return;
    const states = this.#nodeStatesNow;
    if (!states || states.size === 0 || states.has(this.#engineNode)) return;
    this.#engineNodeNoted = true;
    log.warn(`MORNDO_ENGINE_NODE is ${JSON.stringify(this.#engineNode)}, and that node is not connected`);
  }

  // Who this poll's reports govern. An engine report only, on this machine, not offline, the only worker of that
  // name, and not one the hub is following (a transcript keeps the screen). One worker, one report.
  #governed(reports: readonly LaneReport[]): Map<string, LaneReport> {
    const workers = this.#roster.entries();
    const nameCount = new Map<string, number>();
    for (const w of workers) nameCount.set(w.name, (nameCount.get(w.name) ?? 0) + 1);
    const out = new Map<string, LaneReport>();
    for (const w of workers) {
      if (w.offline || this.#followed.has(w.id) || !this.#onHub(w.node) || (nameCount.get(w.name) ?? 0) !== 1) continue;
      const hits = reports.filter(r => r.engine !== null && r.engine !== "" && r.name === w.name);
      if (hits.length !== 1) continue;
      const hit = hits[0];
      if (hit) out.set(w.id, hit);
    }
    return out;
  }

  // Busy is Working, idle is Idle. The pane does not get a vote.
  #applyGoverned(governed: ReadonlyMap<string, LaneReport>, now: number): FeedBody[] {
    const bodies: FeedBody[] = [];
    for (const [id, report] of governed) {
      if (report.status === "busy") bodies.push(...this.#roster.holdWorking(workerId(id), now));
      else bodies.push(...this.#roster.releaseWorking(workerId(id), now));
    }
    return bodies;
  }

  #apply(round: NodeRound, bodies: FeedBody[], changedScreens: Map<string, string>, newMessages: Map<string, Message[]>, rebuilt: Set<string>, governed: ReadonlyMap<string, LaneReport>) {
    for (const [id, text] of round.screens) {
      if (text === null) continue;                              // the pane went away between list and capture
      if (governed.has(id)) {
        if (this.#roster.recordScreen(workerId(id), text)) changedScreens.set(id, text);
        continue;
      }
      const r = this.#roster.observeScreen(workerId(id), text, this.#now());
      bodies.push(...r.events);
      if (r.changed) changedScreens.set(id, text);
    }
    for (const [id, a] of round.added) {
      if (this.#followed.get(id) !== a.follow) continue;        // that follow was dropped meanwhile
      newMessages.set(id, [...(newMessages.get(id) ?? []), ...a.messages]);
    }
    for (const id of round.rebuilt) if (this.#followed.has(id)) rebuilt.add(id);
  }
}
