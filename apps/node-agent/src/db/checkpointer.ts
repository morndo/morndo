// Checkpoints off the event loop (T-532). SQLite's automatic checkpoint runs inside the commit that crosses the WAL's
// limit, on the committing connection, and syncs the WAL and then the database file there even under
// synchronous=NORMAL; on the agent that connection is the event loop's, so a busy disk held it in those syncs. The
// agent's connection runs none (db/open.ts sets wal_autocheckpoint = 0), and this worker thread, with a connection of
// its own, runs a PASSIVE checkpoint every `everyMs`: it never waits for the agent's writer or readers, copies what it
// can, and the next writer restarts the WAL once all of it is copied (https://www.sqlite.org/c3ref/wal_checkpoint_v2.html,
// read 2026-10-29).
// A worker that dies, or that makes no progress for `stuckMs` (one stuck in the disk inside a checkpoint), calls
// `onFail` once: the agent then checkpoints on its own connection again, slower but bounded, rather than let the WAL
// grow without end. stop() waits `stopWaitMs` at most: a worker stuck in a sync cannot be stopped from here, and the
// process's exit takes it.
import { once } from "node:events";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { Logger } from "../log.ts";

export type CheckpointResult = { busy: number; log: number; checkpointed: number };
export type Checkpointer = { now(): Promise<CheckpointResult>; stop(): Promise<void> };
export const CHECKPOINT_EVERY_MS = 10_000;
export const CHECKPOINT_STUCK_MS = 120_000;
export const CHECKPOINT_STOP_WAIT_MS = 2000;

// The worker's file beside this one: .ts when the agent runs from its sources, .js in the compiled release.
const workerUrl = new URL(`./checkpoint-worker${extname(fileURLToPath(import.meta.url))}`, import.meta.url);

type Reply = { id: number; result?: CheckpointResult; error?: string } | { warn: string } | { beat: true };
export type CheckpointerOptions = {
  everyMs?: number; stuckMs?: number; stopWaitMs?: number; log?: Pick<Logger, "warn">; onFail?: () => void;
  test?: { stallMs?: number };                             // the worker blocks in its first checkpoint, as in a stuck disk
};

export function startCheckpointer(path: string, o: CheckpointerOptions = {}): Checkpointer {
  const everyMs = o.everyMs ?? CHECKPOINT_EVERY_MS;
  const stuckMs = o.stuckMs ?? CHECKPOINT_STUCK_MS;
  const worker = new Worker(workerUrl, { workerData: { path, everyMs, stallMs: o.test?.stallMs ?? 0 } });
  const waiting = new Map<number, { resolve: (r: CheckpointResult) => void; reject: (e: Error) => void }>();
  let next = 0;
  let stopping = false;
  let gone = false;
  let failed = false;
  let progressAt = Date.now();
  const fail = (why: string, e?: unknown) => {
    if (failed || stopping) return;
    failed = true;
    o.log?.warn(`${why}; the agent checkpoints on its own connection again`, e);
    o.onFail?.();
  };
  const failAll = (e: Error) => {
    for (const w of waiting.values()) w.reject(e);
    waiting.clear();
  };
  // The progress deadline: checked as often as a checkpoint is due, and never keeping the process alive.
  const watchdog = setInterval(() => {
    if (Date.now() - progressAt > stuckMs) fail(`the checkpoint worker made no progress for ${Math.round(stuckMs / 1000)} s`);
  }, Math.min(everyMs, stuckMs));
  watchdog.unref();
  worker.on("message", (m: Reply) => {
    if ("beat" in m) { progressAt = Date.now(); return; }
    if ("warn" in m) { o.log?.warn(m.warn); return; }
    progressAt = Date.now();
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (m.error !== undefined || !m.result) w.reject(new Error(m.error ?? "the checkpoint worker answered nothing"));
    else w.resolve(m.result);
  });
  worker.on("error", e => { fail("the checkpoint worker failed", e); });
  worker.on("exit", code => {
    gone = true;
    clearInterval(watchdog);
    failAll(new Error(`the checkpointer is stopped (its worker exited ${code})`));
    fail(`the checkpoint worker exited (${code})`);
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
      clearInterval(watchdog);
      const exited = once(worker, "exit");
      worker.postMessage({ stop: true });
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<"late">(resolve => { timer = setTimeout(() => resolve("late"), o.stopWaitMs ?? CHECKPOINT_STOP_WAIT_MS); });
      const ended = await Promise.race([exited.then(() => "exited" as const), late]);
      clearTimeout(timer);
      if (ended === "late") {
        failAll(new Error("the checkpointer is stopped"));
        worker.unref();                                    // a worker stuck in a sync: the process's exit takes it
        void worker.terminate().catch(() => undefined);
      }
    },
  };
}
