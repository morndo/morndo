// Checkpoints off the event loop (T-532). SQLite's automatic checkpoint runs inside the commit that crosses the WAL's
// limit, on the committing connection, and syncs the WAL and then the database file there even under
// synchronous=NORMAL; on the agent that connection is the event loop's, so a busy disk held it in those syncs. The
// agent's connection runs none (db/open.ts sets wal_autocheckpoint = 0), and this worker thread, with a connection of
// its own, runs a PASSIVE checkpoint every `everyMs`: it never waits for the agent's writer or readers, copies what it
// can, and the next writer restarts the WAL once all of it is copied (https://www.sqlite.org/c3ref/wal_checkpoint_v2.html,
// read 2026-10-29). A worker that fails or exits on its own calls `onFail`: the agent then checkpoints on its loop
// again, slower but bounded, rather than let the WAL grow without end.
import { once } from "node:events";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { Logger } from "../log.ts";

export type CheckpointResult = { busy: number; log: number; checkpointed: number };
export type Checkpointer = { now(): Promise<CheckpointResult>; stop(): Promise<void> };
export const CHECKPOINT_EVERY_MS = 10_000;

// The worker's file beside this one: .ts when the agent runs from its sources, .js in the compiled release.
const workerUrl = new URL(`./checkpoint-worker${extname(fileURLToPath(import.meta.url))}`, import.meta.url);

type Reply = { id: number; result?: CheckpointResult; error?: string } | { warn: string };

export function startCheckpointer(path: string, o: { everyMs?: number; log?: Pick<Logger, "warn">; onFail?: () => void } = {}): Checkpointer {
  const worker = new Worker(workerUrl, { workerData: { path, everyMs: o.everyMs ?? CHECKPOINT_EVERY_MS } });
  const waiting = new Map<number, { resolve: (r: CheckpointResult) => void; reject: (e: Error) => void }>();
  let next = 0;
  let stopping = false;
  let gone = false;
  const failAll = (e: Error) => {
    for (const w of waiting.values()) w.reject(e);
    waiting.clear();
  };
  worker.on("message", (m: Reply) => {
    if ("warn" in m) { o.log?.warn(m.warn); return; }
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (m.error !== undefined || !m.result) w.reject(new Error(m.error ?? "the checkpoint worker answered nothing"));
    else w.resolve(m.result);
  });
  worker.on("error", e => { o.log?.warn("the checkpoint worker failed; the agent checkpoints on its own connection again", e); });
  worker.on("exit", code => {
    gone = true;
    failAll(new Error(`the checkpointer is stopped (its worker exited ${code})`));
    if (!stopping) o.onFail?.();
  });
  return {
    now: () => {
      if (stopping || gone) return Promise.reject(new Error("the checkpointer is stopped"));
      const id = ++next;
      return new Promise<CheckpointResult>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        worker.postMessage({ id });
      });
    },
    stop: async () => {
      if (stopping || gone) return;
      stopping = true;
      const exited = once(worker, "exit");
      worker.postMessage({ stop: true });
      await exited;
    },
  };
}
