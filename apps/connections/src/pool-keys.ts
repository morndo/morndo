// Keys a pooled run may still be handed. The filter starts with the members present at the start. A member that joins,
// or whose key is rotated, changes the directory version or the pool version. learn() opens only the refs the filter
// does not have yet. Required names are every name the grant has lent and the grant's member; that set only grows for
// the life of the watch, and a later call still requires all of it when the pool or the grant can no longer be read,
// plus whatever that call can read now. The other current members are best-effort (a revoked one of those is skipped).
// A required name with no key Connection of morndo custody, or a required key that does not open, withholds output —
// FilterIncomplete names that member, never the key — and is tried again. A required key already seen is done. Keys
// that did open are kept for the next call that returns. A key is never logged and never put in an error here.
// guardedRelay writes a chunk only after that read worked. When every try failed, the chunk is withheld (one marker
// per stream for the stretch) and, after a bounded wait, the run is given up.
import { findConnection, isKey, type Directory, type KeyPool } from "@morndo/domain";
import { SqliteKeyPoolStore } from "./adapters/key-pool-store-sqlite.ts";
import { SqliteStore } from "./adapters/store-sqlite.ts";

type OpenedHome = {
  open(ref: string): Promise<string>;
  close(): void;
};

const WITHHELD = "[output withheld: the key filter could not be refreshed]\n";

// The members whose keys the filter still does not have. Names only: a key and its ref never belong in an error.
export class FilterIncomplete extends Error {
  readonly members: readonly string[];
  constructor(members: readonly string[]) {
    super(`key filter incomplete for ${members.join(", ")}`);
    this.name = "FilterIncomplete";
    this.members = [...members];
  }
}

export function guardedRelay(input: {
  learn: () => Promise<readonly string[]>;
  add: (keys: readonly string[]) => void;
  push: (stream: "out" | "err", text: string) => string;
  write: (stream: "out" | "err", text: string) => void;
  attempts?: number;
  pauseMs?: number;
  giveUpAfterMs?: number;
  now?: () => number;
  onGiveUp?: (error: Error) => void;
}): { chunk(stream: "out" | "err", text: string): void; poll(): void; settled(): Promise<void> } {
  const attempts = input.attempts ?? 3;
  const pauseMs = input.pauseMs ?? 50;
  const giveUpAfterMs = input.giveUpAfterMs ?? 30_000;
  const now = input.now ?? Date.now;
  const wait = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms); });
  // One chain for both streams, so a chunk is written in the order it arrived. The chain itself never rejects.
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (job: () => Promise<void>): void => {
    chain = chain.then(job).then(() => undefined, () => undefined);
  };
  let blockedSince: number | null = null;
  // Each stream is told once per stretch: a reader of either one has to see that output was held back.
  const marked: Record<"out" | "err", boolean> = { out: false, err: false };
  let dead = false;
  let lastError: Error = new Error("unreadable");
  const refreshed = async (tries: number): Promise<readonly string[] | undefined> => {
    for (let attempt = 0; attempt < tries; attempt++) {
      try { return await input.learn(); }
      catch (caught) {
        lastError = caught instanceof Error ? caught : new Error("unreadable");
        if (attempt + 1 < tries) await wait(pauseMs * 2 ** attempt);
      }
    }
    return undefined;
  };
  return {
    chunk(stream: "out" | "err", text: string): void {
      enqueue(async () => {
        if (dead) return;
        const keys = await refreshed(attempts);
        if (keys === undefined) {
          const at = now();
          if (blockedSince === null) blockedSince = at;
          if (at - blockedSince >= giveUpAfterMs) {
            dead = true;
            input.onGiveUp?.(lastError);
            return;
          }
          if (!marked[stream]) {
            input.write(stream, WITHHELD);
            marked[stream] = true;
          }
          return;
        }
        blockedSince = null;
        marked.out = false;
        marked.err = false;
        if (keys.length > 0) input.add(keys);
        input.write(stream, input.push(stream, text));
      });
    },
    // A poll learns a key and nothing more: it does not start the give-up clock and it does not write. One that worked
    // ends a withheld stretch, so the next miss is timed and marked on its own.
    poll(): void {
      enqueue(async () => {
        const keys = await refreshed(1);
        if (keys === undefined) return;
        blockedSince = null;
        marked.out = false;
        marked.err = false;
        if (keys.length > 0) input.add(keys);
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
  // `synced` stays false until a read has every required key, so the first call also checks keys the caller could not open.
  let signature = versions();
  let synced = false;
  // Keys opened by a call that then found a required key missing. The next call that returns hands them on first.
  const carry: string[] = [];
  const take = (): string[] => carry.splice(0, carry.length);
  // Every name ever required. A call adds the grant's lent names and its member when it can read them, then requires the whole set.
  const required = new Set<string>();
  return {
    async learn(): Promise<string[]> {
      let next: string | undefined;
      try { next = versions(); } catch { next = undefined; }
      if (next !== undefined && next === signature && synced) return [];
      // A throw from opening the home leaves the signature and `seen` as they were. The pool or the directory being
      // unreadable does not: the names already required still have to be learned. A full home is opened only when there is a key to read.
      let pool: KeyPool | null = null;
      let directory: Directory | null = null;
      try { pool = pools.load(input.pool).pool; } catch { pool = null; }
      try { directory = store.load().directory; } catch { directory = null; }
      const grant = pool?.grants.find(row => row.id === input.grant);
      if (grant) {
        for (const name of grant.lent) required.add(name);
        required.add(grant.member);
      }
      const wanted: { ref: string; names: string[]; required: boolean }[] = [];
      const failed: string[] = [];
      const fail = (name: string): void => { if (!failed.includes(name)) failed.push(name); };
      // Required: the names gathered above, whatever state that Connection is in. A missing one, or one that is not a
      // key of morndo custody, is a failure. Best-effort: any other current member. A revoked Connection is skipped only for those.
      const consider = (name: string, must: boolean): void => {
        if (directory === null) {
          if (must) fail(name);
          return;
        }
        const connection = findConnection(directory, name);
        if (!connection || !isKey(connection)) {
          if (must) fail(name);
          return;
        }
        if (input.seen.has(connection.ref)) return;
        if (!must && connection.status === "revoked") return;
        const existing = wanted.find(item => item.ref === connection.ref);
        if (existing) {
          if (must && !existing.names.includes(name)) existing.names.push(name);
          if (must) existing.required = true;
          return;
        }
        wanted.push({ ref: connection.ref, names: must ? [name] : [], required: must });
      };
      const listed = new Set<string>();
      for (const member of pool?.members ?? []) {
        listed.add(member.credential);
        consider(member.credential, required.has(member.credential));
      }
      for (const name of required) if (!listed.has(name)) consider(name, true);
      if (wanted.length === 0) {
        if (failed.length > 0) throw new FilterIncomplete(failed);
        if (next !== undefined) {
          signature = next;
          synced = true;
        }
        return take();
      }
      const home = input.open();
      const found: string[] = [];
      const opened: string[] = [];
      try {
        for (const item of wanted) {
          try {
            found.push(await home.open(item.ref));
            opened.push(item.ref);
          } catch {
            // A best-effort key that cannot be opened is not served and is not remembered. A required one is named below.
            if (item.required) for (const name of item.names) fail(name);
          }
        }
      } finally {
        home.close();
      }
      if (failed.length > 0) {
        for (const ref of opened) input.seen.add(ref);
        carry.push(...found);
        throw new FilterIncomplete(failed);
      }
      for (const ref of opened) input.seen.add(ref);
      if (next !== undefined) {
        signature = next;
        synced = true;
      }
      return [...take(), ...found];
    },
    close(): void {
      store.close();
      pools.close();
    },
  };
}
