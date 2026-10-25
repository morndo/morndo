// Keys a pooled run may still be handed. The filter starts with the members present at the start. A member that joins,
// or whose key is rotated, changes the directory version or the pool version. learn() opens only the refs the filter
// does not have yet, and only when that signature changed: the members in the pool, and every member the grant has
// lent the run, including one that has since left or been revoked. A key is never logged and never put in an error here.
// guardedRelay writes a chunk only after that read worked. When every try failed, the chunk is withheld.
import { findConnection, isKey, type Directory } from "@morndo/domain";
import { SqliteKeyPoolStore } from "./adapters/key-pool-store-sqlite.ts";
import { SqliteStore } from "./adapters/store-sqlite.ts";

type OpenedHome = {
  store: { load(): { directory: Directory } };
  open(ref: string): Promise<string>;
  close(): void;
};

const WITHHELD = "[output withheld: the key filter could not be refreshed]\n";

export function guardedRelay(input: {
  learn: () => Promise<readonly string[]>;
  add: (keys: readonly string[]) => void;
  push: (stream: "out" | "err", text: string) => string;
  write: (stream: "out" | "err", text: string) => void;
  attempts?: number;
  pauseMs?: number;
}): { chunk(stream: "out" | "err", text: string): void; poll(): void; settled(): Promise<void> } {
  const attempts = input.attempts ?? 3;
  const pauseMs = input.pauseMs ?? 50;
  const wait = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); });
  // One chain for both streams, so a chunk is written in the order it arrived. The chain itself never rejects.
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (job: () => Promise<void>): void => {
    chain = chain.then(job).then(() => undefined, () => undefined);
  };
  const refreshed = async (tries: number): Promise<readonly string[] | undefined> => {
    for (let n = 0; n < tries; n++) {
      try { return await input.learn(); }
      catch { if (n + 1 < tries) await wait(pauseMs); }
    }
    return undefined;
  };
  return {
    chunk(stream: "out" | "err", text: string): void {
      enqueue(async () => {
        const keys = await refreshed(attempts);
        if (keys === undefined) { input.write(stream, WITHHELD); return; }
        if (keys.length > 0) input.add(keys);
        input.write(stream, input.push(stream, text));
      });
    },
    poll(): void {
      enqueue(async () => {
        const keys = await refreshed(1);
        if (keys !== undefined && keys.length > 0) input.add(keys);
      });
    },
    settled(): Promise<void> { return chain; },
  };
}

export function watchPoolKeys(input: {
  db: string;
  pool: string;
  grant: string;
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
        // A throw here leaves the signature and `seen` as they were, so the next call tries the same change again.
        const loaded = pools.load(input.pool);
        const members = loaded.pool?.members ?? [];
        const grant = loaded.pool?.grants.find(row => row.id === input.grant);
        const directory = home.store.load().directory;
        // A name the grant lent is opened by the Connection it is now, revoked or gone from the pool included.
        // A current member the run was never handed still skips a revoked Connection.
        const history = new Set<string>();
        if (grant) {
          for (const name of grant.lent) history.add(name);
          history.add(grant.member);
        }
        const listed = new Set<string>();
        const consider = async (name: string, handed: boolean): Promise<void> => {
          const connection = findConnection(directory, name);
          if (!connection || !isKey(connection) || opened.includes(connection.ref) || input.seen.has(connection.ref)) return;
          if (!handed && connection.status === "revoked") return;
          try {
            const key = await home.open(connection.ref);
            opened.push(connection.ref);
            found.push(key);
          } catch { /* a key that cannot be opened cannot be served */ }
        };
        for (const member of members) {
          listed.add(member.credential);
          await consider(member.credential, history.has(member.credential));
        }
        for (const name of history) {
          if (!listed.has(name)) await consider(name, true);
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
