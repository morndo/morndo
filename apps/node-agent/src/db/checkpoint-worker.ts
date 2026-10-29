// The checkpoint worker (db/checkpointer.ts): a connection of its own to the agent's database, in a thread of its own,
// that runs a PASSIVE checkpoint every `everyMs` and when asked. It writes nothing, and runs no automatic checkpoint
// either. The agent's connection stays the database's only writer.
import { parentPort, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import type { CheckpointResult } from "./checkpointer.ts";

const { path, everyMs, stallMs, failing } = workerData as { path: string; everyMs: number; stallMs: number; failing: boolean };
const db = new Database(path, { fileMustExist: true });
db.pragma("wal_autocheckpoint = 0");
let stall = stallMs;                                       // a test's stuck disk: the first checkpoint blocks this long
// Each checkpoint that returns tells the agent this worker still makes progress (checkpointer.ts, the deadline); one
// that throws does not.
const checkpoint = (): CheckpointResult => {
  if (stall > 0) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stall); stall = 0; }
  if (failing) throw new Error("disk I/O error (test)");     // a test's disk that answers every checkpoint with an error
  const result = (db.pragma("wal_checkpoint(PASSIVE)") as CheckpointResult[])[0] ?? { busy: 1, log: -1, checkpointed: -1 };
  parentPort?.postMessage({ beat: true });
  return result;
};

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
