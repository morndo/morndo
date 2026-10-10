// The two send queues of one connection (spec §5.2, "Frames"): control messages (op results, events) always go before
// bulk ones (results carrying transcript or file bytes), and at most one bulk message is being written at a time; the
// next waits until ws reports the previous one written. So an op result never waits behind a transfer, and a 256 KiB
// chunk never queues inside ws behind more than one other.
export type Lane = "control" | "bulk";
export type Wire = { send(data: string, cb: (err?: Error) => void): void };

export class SendQueue {
  #wire: Wire;
  #control: string[] = [];
  #bulk: string[] = [];
  #bulkInFlight = false;
  #closed = false;

  constructor(wire: Wire) { this.#wire = wire; }

  push(data: string, lane: Lane): void {
    if (this.#closed) return;
    (lane === "control" ? this.#control : this.#bulk).push(data);
    this.#drain();
  }

  // The connection is gone: what is queued is dropped (hook events stay in the spool and are replayed).
  close(): void {
    this.#closed = true;
    this.#control = [];
    this.#bulk = [];
  }

  get pending(): number { return this.#control.length + this.#bulk.length; }

  #drain(): void {
    while (!this.#closed && this.#control.length) this.#wire.send(this.#control.shift() as string, () => {});
    if (this.#closed || this.#bulkInFlight || !this.#bulk.length) return;
    this.#bulkInFlight = true;
    this.#wire.send(this.#bulk.shift() as string, () => {
      this.#bulkInFlight = false;
      this.#drain();
    });
  }
}
