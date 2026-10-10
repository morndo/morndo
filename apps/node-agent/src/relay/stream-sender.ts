// Sends the hook stream to the fleet (spec §5.4). After each welcome it starts from ackSeq + 1 (from the start when the
// fleet doesn't know this streamId), oldest first; events that arrive later have higher seqs, so the replay always goes
// before anything new. At most 256 events are unacknowledged in flight (LIMITS.replayWindow); cumulative acks delete
// what the fleet has and open the window again. Progress events (/cc, /sl) that were waiting when the connection came
// up carry late: true and their original `at` (spec §5.5).
// Its methods run inside the connection's message handlers, so none of them throws: an ack the database can't write (a
// full disk) is logged and still opens the window (the rows stay until a later ack deletes them), and a read that fails
// is tried again on the next event or ack. A throw there would be an uncaught exception, and the agent would restart
// into the same full disk, again and again.
import { LIMITS, type AgentMessage, type HookEvent } from "@morndo/protocol";
import type { Logger } from "../log.ts";
import { isProgress, type Spool } from "./spool.ts";

export class StreamSender {
  #spool: Spool;
  #node: string;
  #send: (m: AgentMessage) => boolean;
  #window: number;
  #log: Logger | null;
  #online = false;
  #sent: number[] = [];
  #lastSent = 0;
  #acked = 0;
  #horizon = 0;

  constructor(o: { spool: Spool; node: string; send: (m: AgentMessage) => boolean; window?: number; log?: Logger }) {
    this.#spool = o.spool;
    this.#node = o.node;
    this.#send = o.send;
    this.#window = o.window ?? LIMITS.replayWindow;
    this.#log = o.log ?? null;
  }

  get inFlight(): number { return this.#sent.length; }

  // Deletes up to `seq`; false (logged) when the database can't be written.
  #delete(seq: number): boolean {
    try { this.#spool.ack(seq); return true; }
    catch (e) { this.#log?.warn("could not delete acknowledged hook events (a full disk?); they stay until a later ack", e); return false; }
  }

  online(w: { ackSeq: number; streamKnown: boolean }): void {
    const base = w.streamKnown ? w.ackSeq : 0;
    if (base > 0) this.#delete(base);
    this.#acked = base;
    this.#lastSent = base;
    this.#sent = [];
    try { this.#horizon = this.#spool.maxSeq(); }
    catch (e) { this.#log?.warn("could not read the hook stream's max seq; progress events may not be marked late this round", e); this.#horizon = 0; }
    this.#online = true;
    this.#pump();
  }

  offline(): void {
    this.#online = false;
    this.#sent = [];
  }

  // A new event was spooled.
  kick(): void { this.#pump(); }

  ack(seq: number): void {
    const upTo = Math.min(seq, this.#lastSent);             // never past what this connection was sent
    if (!this.#online || upTo <= this.#acked) return;
    this.#delete(upTo);                                     // the fleet has them either way: the window opens
    this.#acked = upTo;
    this.#sent = this.#sent.filter(s => s > upTo);
    this.#pump();
  }

  #pump(): void {
    while (this.#online && this.#sent.length < this.#window) {
      let rows: ReturnType<Spool["after"]>;
      try { rows = this.#spool.after(this.#lastSent, this.#window - this.#sent.length); }
      catch (e) { this.#log?.warn("could not read the hook stream; trying again with the next event", e); return; }
      if (!rows.length) return;
      for (const r of rows) {
        const event: HookEvent = {
          streamId: this.#spool.streamId, seq: r.seq, at: r.at, path: r.path, node: this.#node, window: r.window,
          ...(isProgress(r.path) && r.seq <= this.#horizon ? { late: true as const } : {}),
          body: r.body,
        };
        if (!this.#send({ v: 1, t: "ev.hook", event })) { this.offline(); return; }
        this.#sent.push(r.seq);
        this.#lastSent = r.seq;
      }
    }
  }
}
