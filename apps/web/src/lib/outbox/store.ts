// Where the outbox keeps its Commands on this device (ADR-0008 phase C, S4): IndexedDB, written with "strict"
// durability and awaited until the transaction completes, so a record exists before its first POST and survives a
// reload, a crash or a closed tab (https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase/transaction, read
// 2026-10-02: oncomplete, not onsuccess, means written). Where IndexedDB isn't there (some private modes), a memory store
// keeps the app working for this page's life.
import type { OutboxRecord } from "./state.ts";

export type OutboxStore = {
  all(): Promise<OutboxRecord[]>;
  get(id: string): Promise<OutboxRecord | undefined>;
  put(r: OutboxRecord): Promise<void>;
  delete(id: string): Promise<void>;
  readonly durable: boolean;
};

const DB = "morndo";
const STORE = "outbox";

export function memoryStore(): OutboxStore {
  const rows = new Map<string, OutboxRecord>();
  return {
    durable: false,
    all: async () => [...rows.values()].map(r => ({ ...r })),
    get: async id => { const r = rows.get(id); return r ? { ...r } : undefined; },
    put: async r => { rows.set(r.id, { ...r }); },
    delete: async id => { rows.delete(id); },
  };
}

const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
});

export async function openStore(idb: IDBFactory | undefined = globalThis.indexedDB): Promise<OutboxStore> {
  if (!idb) return memoryStore();
  let db: IDBDatabase;
  try {
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = idb.open(DB, 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "id" }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
      req.onblocked = () => reject(new Error("IndexedDB open blocked"));
    });
  } catch (e) {
    console.warn("morndo: the outbox can't use IndexedDB here; queued messages last for this page only", e);
    return memoryStore();
  }
  // A newer page wants to upgrade the database: let it (review L4); this page's store then fails over to its errors.
  db.onversionchange = () => db.close();
  const write = async (fn: (s: IDBObjectStore) => void) => {
    const tx = db.transaction(STORE, "readwrite", { durability: "strict" });
    fn(tx.objectStore(STORE));
    await done(tx);
  };
  return {
    durable: true,
    all: () => new Promise<OutboxRecord[]>((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as OutboxRecord[]);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB read failed"));
    }),
    get: id => new Promise<OutboxRecord | undefined>((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result as OutboxRecord | undefined);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB read failed"));
    }),
    put: r => write(s => { s.put(r); }),
    delete: id => write(s => { s.delete(id); }),
  };
}
