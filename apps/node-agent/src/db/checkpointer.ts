// Checkpoints off the event loop (T-532). SQLite's automatic checkpoint runs inside the commit that crosses the WAL's
// limit, on the committing connection, and syncs the WAL and then the database file there even under
// synchronous=NORMAL; on the agent that connection is the event loop's, so a busy disk held it in those syncs. The
// agent's connection runs none (db/open.ts sets wal_autocheckpoint = 0), and this worker thread, with a connection of
// its own, runs a PASSIVE checkpoint every `everyMs`: it never waits for the agent's writer or readers, copies what it
// can, and the next writer restarts the WAL once all of it is copied (https://www.sqlite.org/c3ref/wal_checkpoint_v2.html,
// read 2026-10-29).
// A worker that dies, or that makes no progress for `stuckMs` (one stuck in the disk inside a checkpoint), calls
// `onFail` once: the agent then checkpoints on its own connection again, slower but bounded, rather than let the WAL
// grow without end. The worker is stopped as it hands back, so it never checkpoints beside the agent's connection
// (T-571); `restartMs` after it has exited a new one starts, and once that one has made progress `onResume` gives the
// checkpoints back to it. A new worker that fails before then hands back nothing more, and the next waits `restartMs`
// again. One worker at a time: a worker stuck in a sync stops only once the sync returns (terminate() stops its
// JavaScript, https://nodejs.org/docs/latest-v24.x/api/worker_threads.html, read 2026-10-29), and none starts beside
// it. stop() waits `stopWaitMs` at most: a worker stuck in a sync cannot be stopped from here, and the process's exit
// takes it.
import { once } from "node:events";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { Logger } from "../log.ts";

export type CheckpointResult = { busy: number; log: number; checkpointed: number };
export type Checkpointer = { now(): Promise<CheckpointResult>; stop(): Promise<void> };
export const CHECKPOINT_EVERY_MS = 10_000;
export const CHECKPOINT_STUCK_MS = 120_000;
export const CHECKPOINT_RESTART_MS = 300_000;
export const CHECKPOINT_STOP_WAIT_MS = 2000;

// The worker's file beside this one: .ts when the agent runs from its sources, .js in the compiled release.
const workerUrl = new URL(`./checkpoint-worker${extname(fileURLToPath(import.meta.url))}`, import.meta.url);

type Reply = { id: number; result?: CheckpointResult; error?: string } | { warn: string } | { beat: true };
type Waiting = Map<number, { resolve: (r: CheckpointResult) => void; reject: (e: Error) => void }>;
export type CheckpointerOptions = {
  everyMs?: number; stuckMs?: number; restartMs?: number; stopWaitMs?: number; log?: Pick<Logger, "warn">;
  onFail?: () => void; onResume?: () => void;
  test?: { stallMs?: number };                             // the first worker blocks in its first checkpoint, as in a stuck disk
};

export function startCheckpointer(path: string, o: CheckpointerOptions = {}): Checkpointer {
  const everyMs = o.everyMs ?? CHECKPOINT_EVERY_MS;
  const stuckMs = o.stuckMs ?? CHECKPOINT_STUCK_MS;
  const restartMs = o.restartMs ?? CHECKPOINT_RESTART_MS;
  let worker: Worker | null = null;                         // the one in use; null while none is
  let waiting: Waiting = new Map();
  let next = 0;
  let stopping = false;
  let inCharge = true;                                      // the agent's connection runs no checkpoint (db/open.ts)
  let restart: NodeJS.Timeout | undefined;
  const failAll = (w: Waiting, e: Error) => {
    for (const x of w.values()) x.reject(e);
    w.clear();
  };

  const start = (stallMs: number) => {
    const w = new Worker(workerUrl, { workerData: { path, everyMs, stallMs } });
    const mine: Waiting = new Map();
    worker = w;
    waiting = mine;
    let failed = false;
    let progressAt = Date.now();
    // Settled by the worker's exit however it comes, so a hand-back from inside the exit itself still restarts.
    const exited = new Promise<void>(resolve => { w.once("exit", () => { resolve(); }); });
    // Hand back (once per worker), stop this worker, and start the next once it has exited and the cool-down is over.
    const fail = (why: string, e?: unknown) => {
      if (failed || stopping) return;
      failed = true;
      clearInterval(watchdog);
      if (worker === w) worker = null;
      failAll(mine, new Error(`the checkpoint worker is stopped (${why})`));
      if (inCharge) {
        inCharge = false;
        o.log?.warn(`${why}; the agent checkpoints on its own connection again`, e);
        o.onFail?.();
      } else {
        o.log?.warn(`${why}; the agent goes on checkpointing on its own connection`, e);
      }
      w.unref();                                           // a worker stuck in a sync: the process's exit takes it
      void w.terminate().catch(() => undefined);
      void exited.then(() => {
        if (stopping) return;
        restart = setTimeout(() => {
          if (stopping) return;
          try { start(0); } catch (err) { o.log?.warn("no new checkpoint worker could start; the agent goes on checkpointing on its own connection", err); }
        }, restartMs);
        restart.unref();
      });
    };
    // The progress deadline: checked as often as a checkpoint is due, and never keeping the process alive.
    const watchdog = setInterval(() => {
      if (Date.now() - progressAt > stuckMs) fail(`the checkpoint worker made no progress for ${Math.round(stuckMs / 1000)} s`);
    }, Math.min(everyMs, stuckMs));
    watchdog.unref();
    w.on("message", (m: Reply) => {
      if (failed) return;
      if ("warn" in m) { o.log?.warn(m.warn); return; }
      progressAt = Date.now();
      if (!inCharge) {                                     // a new worker that made progress takes the checkpoints back
        inCharge = true;
        o.onResume?.();
      }
      if ("beat" in m) return;
      const x = mine.get(m.id);
      if (!x) return;
      mine.delete(m.id);
      if (m.error !== undefined || !m.result) x.reject(new Error(m.error ?? "the checkpoint worker answered nothing"));
      else x.resolve(m.result);
    });
    w.on("error", e => { fail("the checkpoint worker failed", e); });
    w.on("exit", code => {
      failAll(mine, new Error(`the checkpointer is stopped (its worker exited ${code})`));
      fail(`the checkpoint worker exited (${code})`);
    });
  };
  start(o.test?.stallMs ?? 0);

  return {
    now: () => {
      const w = worker;
      if (stopping || !w) return Promise.reject(new Error("the checkpointer is stopped"));
      const mine = waiting;
      const id = ++next;
      return new Promise<CheckpointResult>((resolve, reject) => {
        mine.set(id, { resolve, reject });
        w.postMessage({ id });
      });
    },
    stop: async () => {
      if (stopping) return;
      stopping = true;
      clearTimeout(restart);
      const w = worker;
      worker = null;
      if (!w) return;
      const exited = once(w, "exit");
      w.postMessage({ stop: true });
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<"late">(resolve => { timer = setTimeout(() => resolve("late"), o.stopWaitMs ?? CHECKPOINT_STOP_WAIT_MS); });
      const ended = await Promise.race([exited.then(() => "exited" as const), late]);
      clearTimeout(timer);
      if (ended === "late") {
        failAll(waiting, new Error("the checkpointer is stopped"));
        w.unref();                                         // a worker stuck in a sync: the process's exit takes it
        void w.terminate().catch(() => undefined);
      }
    },
  };
}
