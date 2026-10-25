// A turn nobody reads. `morndo-keys run … | head` closes the pipe; the next write to it fails with EPIPE, which the bin drops so
// it ends quietly (service-kit quietBrokenPipe). The agent on the other end would still run to the end of its turn, spending
// the connection's budget on output that goes nowhere, so the bin raises `Io.gone` when a write fails that way and the
// run stops its child and the processes the child started (process-tree.ts): SIGTERM, then SIGKILL after a grace. The agent stays
// in the bin's own session and process group, so a terminal's Ctrl-C, Ctrl-Z and /dev/tty reach it as they would any command; when
// the terminal itself goes (SIGHUP to the bin) the same stop runs. `nohup` cannot exempt a run: a Node process starts with an
// inherited SIGHUP ignore reset to the default (PlatformInit in src/node.cc, https://github.com/nodejs/node/blob/v24.x/src/node.cc),
// and so does every child Node starts (libuv's uv__process_child_init), so the agent would not keep it either. The books are still closed by the caller with what the turn used.
// A reader that is gone is noticed on a write: an agent that is silent, or prints one result at the end (an --output-format json
// run), goes on until its next line. Node has no way to see a pipe's reader close without writing: libuv offers the hang-up event
// on a poll handle (UV_DISCONNECT, https://docs.libuv.org/en/v1.x/poll.html) but Node exposes no poll handle, and a second socket on
// the descriptor or a read on stdout's own handle is refused (ENOTCONN, checked on Node 24).
// https://nodejs.org/docs/latest-v24.x/api/process.html#a-note-on-process-io (read 2026-10-20).
import type { Io } from "./cli.ts";
import { descendants, startOf } from "./process-tree.ts";

export const STOP_GRACE_MS = 3_000;

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const alive = (target: number): boolean => {
  try { process.kill(target, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

// SIGTERM now and SIGKILL after the grace to the processes named (a negative number names a group). The kill timer is kept until
// they are gone, not until the output pipes close: `settle` waits for that, and sends the SIGKILL itself if the grace has run out.
// A process is named by its pid and its start time, and the SIGKILL goes only to a pid that still has that start time: the system
// may have given the pid to another process in the grace. A group is named by its leader's pid, which the system does not reuse
// while the group has members. `identify` is `startOf`; a test hands in its own.
export type Reaper = { stop(targets: readonly number[]): boolean; settle(): Promise<void> };

export function reaper(graceMs = STOP_GRACE_MS, identify: (pid: number) => string | null = startOf): Reaper {
  type Named = { target: number; start: string | null };
  let named: Named[] = [];
  let timer: NodeJS.Timeout | null = null;
  let killed = false;
  const same = (item: Named): boolean => (item.target < 0 ? alive(item.target) : item.start !== null && identify(item.target) === item.start);
  return {
    stop(targets) {
      if (timer !== null) return false;
      named = targets.map(target => ({ target, start: target > 0 ? identify(target) : null }));
      let delivered = false;
      for (const item of named) { try { process.kill(item.target, "SIGTERM"); delivered = true; } catch { /* it is gone */ } }
      timer = setTimeout(() => {
        killed = true;
        for (const item of named) if (same(item)) { try { process.kill(item.target, "SIGKILL"); } catch { /* it is gone */ } }
      }, graceMs);
      return delivered;
    },
    async settle() {
      if (timer === null) return;
      while (!killed && named.some(same)) await pause(20);
      clearTimeout(timer);
      timer = null;
    },
  };
}

export type TurnStopper = {
  proceed(): boolean;                  // false: the turn has been stopped, so do not spawn the child
  started(pid: number): void;          // the child
  settle(): Promise<void>;             // the child has ended; wait for what it started to be gone (SIGKILL after the grace)
  cut(): boolean;                      // the turn was stopped before it completed, whatever status it ends with
  hungUp(): boolean;                   // the bin was told its terminal is gone (SIGHUP)
  done(): void;                        // the run is over, lease closed
  stop(): void;                        // stop the agent and what it started, as when the reader goes away
};

export function turnStopper(io: Io, graceMs = STOP_GRACE_MS): TurnStopper {
  const reap = reaper(graceMs);
  let pid: number | null = null;
  let stopping = io.gone?.aborted ?? false;
  let delivered = false;
  let prevented = false;
  let hangup = false;
  let hangupCut = false;                                 // the SIGHUP came while the turn was still the bin's to end
  let ended = false;
  const stop = (): void => {
    stopping = true;
    if (pid !== null && reap.stop([pid, ...descendants(pid)])) delivered = true;
  };
  const onHangup = (): void => { hangup = true; if (!ended) hangupCut = true; stop(); };
  io.gone?.addEventListener("abort", stop, { once: true });
  process.on("SIGHUP", onHangup);
  return {
    proceed() { if (stopping) prevented = true; return !stopping; },
    started(started) { pid = started; if (stopping) stop(); },
    async settle() { pid = null; await reap.settle(); ended = true; },
    cut: () => delivered || prevented || hangupCut,
    hungUp: () => hangup,
    stop,
    done() {
      io.gone?.removeEventListener("abort", stop);
      process.off("SIGHUP", onHangup);
    },
  };
}
