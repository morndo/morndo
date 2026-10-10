// One job-list read at a time. A second connect waits, and each read keeps the events that arrived while its GET
// was in flight. Those events are merged with that read, so a slow answer cannot put an older row back.

export class JobResync<T> {
  #chain: Promise<void> = Promise.resolve();
  #active = 0;
  #buffers: T[][] = [];

  get listing(): boolean { return this.#active > 0; }

  note(event: T): void {
    for (const buf of this.#buffers) buf.push(event);
  }

  run<R>(load: () => Promise<R>, merge: (result: R, seen: readonly T[]) => void): Promise<void> {
    const seen: T[] = [];
    this.#buffers.push(seen);
    this.#active += 1;
    const job = this.#chain.then(async () => {
      try {
        merge(await load(), seen);
      } finally {
        this.#active -= 1;
        const at = this.#buffers.indexOf(seen);
        if (at >= 0) this.#buffers.splice(at, 1);
      }
    });
    this.#chain = job.then(() => undefined, () => undefined);
    return job;
  }
}
