// The checkpoint worker (db/checkpointer.ts): a connection of its own to the agent's database, in a thread of its own,
// that runs a PASSIVE checkpoint every `everyMs` and when asked. It writes nothing, and runs no automatic checkpoint
// either. The agent's connection stays the database's only writer.
import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import type { CheckpointResult } from "./checkpointer.ts";

const { path, everyMs } = workerData as { path: string; everyMs: number };
const db = new Database(path, { fileMustExist: true });
db.pragma("wal_autocheckpoint = 0");
const checkpoint = (): CheckpointResult => (db.pragma("wal_checkpoint(PASSIVE)") as CheckpointResult[])[0] ?? { busy: 1, log: -1, checkpointed: -1 };

const timer = setInterval(() => {
  try { checkpoint(); } catch (e) { parentPort?.postMessage({ warn: `a checkpoint failed; the next one tries again: ${String(e)}` }); }
}, everyMs);

parentPort?.on("message", (m: { id?: number; stop?: boolean }) => {
  if (m.stop) {
    clearInterval(timer);
    db.close();
    parentPort?.close();
    return;
  }
  if (m.id === undefined) return;
  try { parentPort?.postMessage({ id: m.id, result: checkpoint() }); }
  catch (e) { parentPort?.postMessage({ id: m.id, error: String(e) }); }
});
