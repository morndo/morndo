// A welcome's replay (T-532): what the database holds leaves this node only once it is on the disk. The rows are read
// first; then one sync, which covers every commit made before that read; then exactly those rows are sent, each only
// while it is still as it was read. A row committed while the sync ran is not among them, and one that changed
// meanwhile (a settle whose own sync failed took it back to open) is left out: each goes out on its own path once its
// own commit is synced. A sync that fails sends nothing; the next welcome replays. So does a sync that outlasts its
// welcome (T-571): once a later welcome has come, nothing is sent, since that welcome replays for itself and a send
// now would reach a link the rows were not read for.
import type { Job } from "@morndo/domain";
import type { Delivery } from "@morndo/protocol";
import type { WalSync } from "../db/wal-sync.ts";
import type { DeliveryStore } from "../deliveries/store.ts";
import type { JobStore } from "../ops/job-store.ts";

export async function replayDurable<T>(o: { read: () => T[]; unchanged: (item: T) => boolean; sync: WalSync; current: () => boolean; send: (item: T) => void }): Promise<void> {
  const items = o.read();
  await o.sync();
  if (!o.current()) return;
  for (const item of items) if (o.unchanged(item)) o.send(item);
}

type Replayed = { kind: "delivery"; d: Delivery } | { kind: "job"; job: Job; at: number; tail: string };

// What agent.ts replays after a welcome: each delivery not final and each final changed since `since`, and each job
// inside its 7 days at the time it was observed (JobStore.replayAt). A row is unchanged while the store still reads it
// the same.
export function replayStores(o: {
  deliveries: Pick<DeliveryStore, "open" | "recentFinal" | "get">;
  jobs: Pick<JobStore, "list" | "replayAt" | "eventTail" | "get">;
  since: number; sync: WalSync; current: () => boolean;
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
    send: r => { if (r.kind === "delivery") o.sendDelivery(r.d); else o.sendJob(r.job, r.at, r.tail); },
  });
}
