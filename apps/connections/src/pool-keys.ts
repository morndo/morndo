// Keys a pooled run may still be handed. The filter starts with the members present at the start. A member that joins,
// or whose key is rotated, changes the directory version or the pool version. learn() opens only the refs the filter
// does not have yet, and only when that signature changed. A key is never logged and never put in an error here.
import { findConnection, isKey, type Directory } from "@morndo/domain";
import { SqliteKeyPoolStore } from "./adapters/key-pool-store-sqlite.ts";
import { SqliteStore } from "./adapters/store-sqlite.ts";

type OpenedHome = {
  store: { load(): { directory: Directory } };
  open(ref: string): Promise<string>;
  close(): void;
};

export function watchPoolKeys(input: {
  db: string;
  pool: string;
  open: () => OpenedHome;
  seen: Set<string>;
}): { learn(): Promise<string[]>; close(): void } {
  const store = new SqliteStore(input.db);
  const pools = new SqliteKeyPoolStore(input.db);
  const versions = (): string => `${store.version()}/${pools.load(input.pool).version}`;
  // Taken when the watch is made: the caller reads the members' keys after that, so only a later change needs a new look.
  let signature = versions();
  return {
    async learn(): Promise<string[]> {
      const next = versions();
      if (next === signature) return [];
      const home = input.open();
      const found: string[] = [];
      const opened: string[] = [];
      try {
        const members = pools.load(input.pool).pool?.members ?? [];
        const directory = home.store.load().directory;
        for (const member of members) {
          const connection = findConnection(directory, member.credential);
          if (!connection || !isKey(connection) || connection.status === "revoked" || input.seen.has(connection.ref)) continue;
          try {
            const key = await home.open(connection.ref);
            opened.push(connection.ref);
            found.push(key);
          } catch { /* a key that cannot be opened cannot be served */ }
        }
      } finally {
        home.close();
      }
      for (const ref of opened) input.seen.add(ref);
      signature = next;
      return found;
    },
    close(): void {
      store.close();
      pools.close();
    },
  };
}
