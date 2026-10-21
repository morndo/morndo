// How `morndo serve` stops, from the first thing it makes. Each resource names its own close the moment it exists, and a
// stop (SIGTERM, SIGINT) runs them last made, first closed, whatever point the start had reached: a hub stopped before it
// serves removes what it had made and closes what it had opened, as one stopped while serving does.
//
// Two rules keep a stop in the middle of the start safe:
// - A start that is awaiting something when the stop begins is parked for good (`whileRunning`): it must not go on to open
//   a resource after the stop closed the rest, or use one the stop has closed. The process ends at the end of the stop.
// - A close registered after the stop began (by a step that was not awaiting) runs at once.
import type { Logger } from "./log.ts";

export type Shutdown = {
  onStop(close: () => void | Promise<void>): void;
  stop(): Promise<void>;                                   // the same promise for every call
  readonly stopping: boolean;
  whileRunning<T>(step: Promise<T>): Promise<T>;           // the step's result, or never once the stop has begun
};

export function shutdownStack(log: Pick<Logger, "error">): Shutdown {
  const closers: Array<() => void | Promise<void>> = [];
  let stopping: Promise<void> | null = null;
  const run = async (close: () => void | Promise<void>) => {
    try { await close(); }
    catch (e) { log.error("stopping: a close failed; the rest still run", e); }
  };
  const never = new Promise<never>(() => {});
  return {
    onStop(close) {
      if (stopping) void run(close);
      else closers.push(close);
    },
    stop() {
      stopping ??= (async () => { for (const close of closers.splice(0).reverse()) await run(close); })();
      return stopping;
    },
    get stopping() { return stopping !== null; },
    whileRunning<T>(step: Promise<T>): Promise<T> {
      return step.then(
        value => (stopping ? never : value),
        (error: unknown) => (stopping ? never : Promise.reject(error)),
      );
    },
  };
}
