// Signing out here takes what he wrote on this device with it (whole-branch review L3; Signal wipes a device it
// unlinks): the drafts and the outbox's unsent messages; and (ADR-0009) the catch-up run, what he kept for later, and
// read marks not sent yet. Layout choices stay, and so does the pinned hub identity, which
// the next unlock checks the hub against.
import { api } from "./api.ts";
import { openStore } from "./outbox/store.ts";

export async function forgetWritten(storage: Pick<Storage, "removeItem"> | null = globalThis.localStorage ?? null, idb: IDBFactory | undefined = globalThis.indexedDB) {
  for (const k of ["morndo.drafts", "morndo.catchup.run", "morndo.later", "morndo.unsent-reads", "morndo.unsent-caught-up"]) {
    try { storage?.removeItem(k); } catch { /* storage blocked: nothing kept there */ }
  }
  try {
    const outbox = await openStore(idb);
    for (const r of await outbox.all()) await outbox.delete(r.id);
  } catch { /* no IndexedDB here: the outbox lived for the page only */ }
}

// The hub ends the session; this device forgets what was written here, whatever the hub answered.
export async function signOutHere() {
  try { await api.post("/api/logout"); } finally { await forgetWritten(); }
}
