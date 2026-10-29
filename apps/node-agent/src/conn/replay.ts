// A welcome's replay (T-532): what the database holds leaves this node only once it is on the disk. The rows are read
// first; then one sync, which covers every commit made before that read; then exactly those rows are sent, each only
// while it is still as it was read. A row committed while the sync ran is not among them, and one that changed
// meanwhile (a settle whose own sync failed took it back to open) is left out: each goes out on its own path once its
// own commit is synced. A sync that outlasts its welcome sends nothing (T-571): once a later welcome has come, or the
// link has ended, that welcome replays for itself, and a send now would reach a link the rows were not read for. A sync
// that fails is tried again every `retryMs` while its welcome is current, the rows read again before each try (T-581):
// the replay of an earlier welcome, left to this one, must not wait for the next welcome.
import type { Job } from "@morndo/domain";
import type { Delivery } from "@morndo/protocol";
import type { WalSync } from "../db/wal-sync.ts";
import type { DeliveryStore } from "../deliveries/store.ts";
import type { JobStore } from "../ops/job-store.ts";

export const REPLAY_RETRY_MS = 10_000;

export async function replayDurable<T>(o: {
  read: () => T[]; unchanged: (item: T) => boolean; sync: WalSync; current: () => boolean; send: (item: T) => void;
  retryMs?: number; onRetry?: (e: unknown) => void;
}): Promise<void> {
  for (;;) {
    const items = o.read();
    try { await o.sync(); }
    catch (e) {
      if (!o.current()) return;
      o.onRetry?.(e);
      await new Promise<void>(resolve => { setTimeout(resolve, o.retryMs ?? REPLAY_RETRY_MS).unref(); });
      if (!o.current()) return;
      continue;
    }
    if (!o.current()) return;
    for (const item of items) if (o.unchanged(item)) o.send(item);
    return;
  }
}

type Replayed = { kind: "delivery"; d: Delivery } | { kind: "job"; job: Job; at: number; tail: string };

// What agent.ts replays after a welcome: each delivery not final and each final changed since `since`, and each job
// inside its 7 days at the time it was observed (JobStore.replayAt). A row is unchanged while the store still reads it
// the same.
export function replayStores(o: {
  deliveries: Pick<DeliveryStore, "open" | "recentFinal" | "get">;
  jobs: Pick<JobStore, "list" | "replayAt" | "eventTail" | "get">;
  since: number; sync: WalSync; current: () => boolean; retryMs?: number; onRetry?: (e: unknown) => void;
  sendDelivery: (d: Delivery) => void; sendJob: (job: Job, at: number, tail: string) => void;
}): Promise<void> {
  return replayDurable<Replayed>({
    read: () => [
      ...[...o.deliveries.open(), ...o.deliveries.recentFinal(o.since)].map(d => ({ kind: "delivery" as const, d })),
      ...o.jobs.list().flatMap(job => {
        const at = o.jobs.replayAt(job);
        return at === null ? [] : [{ kind: "job" as const, job, at, tail: o.jobs.eventTail(job.id) }];
      }),
    ],
    unchanged: r => r.kind === "delivery"
      ? JSON.stringify(o.deliveries.get(r.d.id)) === JSON.stringify(r.d)
      : JSON.stringify(o.jobs.get(r.job.id)) === JSON.stringify(r.job),
    sync: o.sync,
    current: o.current,
    ...(o.retryMs !== undefined ? { retryMs: o.retryMs } : {}),
    ...(o.onRetry ? { onRetry: o.onRetry } : {}),
    send: r => { if (r.kind === "delivery") o.sendDelivery(r.d); else o.sendJob(r.job, r.at, r.tail); },
  });
}
