// One side-effecting op at a time per pane, lane, upload or repository, in arrival order (spec §5.3, "Concurrency").
// Different keys never wait for each other, and reads never come here.
export class SerialQueue {
  #tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn);
    const tail = next.then(() => undefined, () => undefined);
    this.#tails.set(key, tail);
    void tail.then(() => { if (this.#tails.get(key) === tail) this.#tails.delete(key); });
    return next;
  }

  get size(): number { return this.#tails.size; }
}
