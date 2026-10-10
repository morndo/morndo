// The hub's board result, retried until the fleet says it landed. A failure stays unacked for the next pass,
// including after a restart. One id is in flight at a time, so two passes do not send it twice together.

export type NoticeDelivery = { node: string; id: string; notice: "commented" | "given_up" };

export class NoticeOutbox {
  #inflight = new Set<string>();

  async deliver(pending: readonly NoticeDelivery[], send: (row: NoticeDelivery) => Promise<boolean>, ack: (row: NoticeDelivery) => void): Promise<void> {
    for (const row of pending) {
      const key = `${row.node}:${row.id}`;
      if (this.#inflight.has(key)) continue;
      this.#inflight.add(key);
      try {
        if (await send(row)) ack(row);
      } catch { /* the row stays unacked */ }
      finally { this.#inflight.delete(key); }
    }
  }
}
