// How `morndo serve` stops, from the first thing it makes. Each resource names its own close the moment it exists, and a
// stop (SIGTERM, SIGINT) runs them last made, first closed, whatever point the start had reached: a hub stopped before it
// serves removes what it had made and closes what it had opened, as one stopped while serving does.
//
// Two rules keep a stop in the middle of the start safe:
// - A start that is awaiting something when the stop begins is parked for good (`whileRunning`): it must not go on to open
//   a resource after the stop closed the rest, or use one the stop has closed. The process ends at the end of the stop.
// - A close registered after the stop began (by a step that was not awaiting) runs at once, and the stop waits for it.
import type { Logger } from "./log.ts";

export type Shutdown = {
  onStop(close: () => void | Promise<void>): void;
  stop(): Promise<void>;                                   // the same promise for every call
  exitCode: number;                                        // what the process ends with after a stop: 0, or the code a failing start already chose
  readonly stopping: boolean;
  whileRunning: <T>(step: Promise<T>) => Promise<T>;       // the step's result, or never once the stop has begun
};

export function shutdownStack(log: Pick<Logger, "error">): Shutdown {
  const closers: Array<() => void | Promise<void>> = [];
  let stopping: Promise<void> | null = null;
  let begun = false;                                       // set before the first close runs: that close may register another
  const run = async (close: () => void | Promise<void>) => {
    try { await close(); }
    catch (e) { log.error("stopping: a close failed; the rest still run", e); }
  };
  const late: Array<Promise<void>> = [];
  const never = new Promise<never>(() => {});
  return {
    exitCode: 0,
    onStop(close) {
      if (begun) late.push(run(close));
      else closers.push(close);
    },
    stop() {
      if (!stopping) {
        begun = true;
        stopping = (async () => {
          for (const close of closers.splice(0).reverse()) await run(close);
          while (late.length) await Promise.all(late.splice(0));
        })();
      }
      return stopping;
    },
    get stopping() { return begun; },
    whileRunning<T>(step: Promise<T>): Promise<T> {
      return step.then(
        value => (stopping ? never : value),
        (error: unknown) => (stopping ? never : Promise.reject(error)),
      );
    },
  };
}
