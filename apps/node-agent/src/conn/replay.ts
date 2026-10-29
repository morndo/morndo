// A welcome's replay (T-532): what the database holds leaves this node only once it is on the disk. The rows are read
// first; then one sync, which covers every commit made before that read; then exactly those rows are sent, each only
// while it is still as it was read. A row committed while the sync ran is not among them, and one that changed
// meanwhile (a settle whose own sync failed took it back to open) is left out: each goes out on its own path once its
// own commit is synced. A sync that fails sends nothing; the next welcome replays.
import type { WalSync } from "../db/wal-sync.ts";

export async function replayDurable<T>(o: { read: () => T[]; unchanged: (item: T) => boolean; sync: WalSync; send: (item: T) => void }): Promise<void> {
  const items = o.read();
  await o.sync();
  for (const item of items) if (o.unchanged(item)) o.send(item);
}
