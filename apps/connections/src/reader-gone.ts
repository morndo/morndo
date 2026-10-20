// A turn nobody reads. `morndo-keys run … | head` closes the pipe; the next write to it fails with EPIPE, which the bin drops so
// it ends quietly (service-kit quietBrokenPipe). The agent on the other end would still run to the end of its turn, spending
// the connection's budget on output that goes nowhere, so the bin raises `Io.gone` when a write fails that way and the
// run stops its child. The child leads a process group of its own (ChildHooks.detached), so the stop reaches a launcher's inner
// processes too: SIGTERM to the group, then SIGKILL after a grace. Because the child no longer shares the terminal's group, a
// Ctrl-C or a SIGTERM sent to the bin is forwarded the same way, as `pool exec` does. The books are still closed by the caller
// with what the turn used. A reader that is gone is noticed on a write: an agent that is silent, or prints one result at the end
// (claude's --output-format json), goes on until its next line. Node has no way to see a pipe's reader close without writing:
// libuv offers the hang-up event on a poll handle (UV_DISCONNECT, https://docs.libuv.org/en/v1.x/poll.html) but Node exposes no
// poll handle, and a second socket on the descriptor or a read on stdout's own handle is refused (ENOTCONN, checked on Node 24).
// https://nodejs.org/docs/latest-v24.x/api/process.html#a-note-on-process-io (read 2026-10-20).
import type { Io } from "./cli.ts";

export const STOP_GRACE_MS = 3_000;

export type TurnStopper = {
  proceed(): boolean;                  // false: the turn has been stopped, so do not spawn the child
  started(pid: number): void;          // the child, leader of its own group
  done(): void;
  signalled(): number | null;          // 130 or 143 when the bin was told to stop by a signal, else null
  cut(): boolean;                      // the turn was sent a stop: whatever status it ends with, it did not complete
};

export function turnStopper(io: Io, graceMs = STOP_GRACE_MS): TurnStopper {
  let pid: number | null = null;
  let stopping = io.gone?.aborted ?? false;
  let code: number | null = null;
  let timer: NodeJS.Timeout | null = null;
  let sent = false;
  const stop = (): void => {
    stopping = true;
    const target = pid;
    if (target === null || timer !== null) return;
    try { process.kill(-target, "SIGTERM"); } catch { return; }
    sent = true;
    timer = setTimeout(() => { try { process.kill(-target, "SIGKILL"); } catch { /* it is gone */ } }, graceMs);
  };
  const onSignal = (signal: NodeJS.Signals): void => { code ??= signal === "SIGINT" ? 130 : 143; stop(); };
  const term = (): void => onSignal("SIGTERM");
  const int = (): void => onSignal("SIGINT");
  io.gone?.addEventListener("abort", stop, { once: true });
  process.on("SIGTERM", term);
  process.on("SIGINT", int);
  return {
    proceed: () => !stopping,
    started(started) { pid = started; if (stopping) stop(); },
    done() {
      pid = null;
      if (timer !== null) clearTimeout(timer);
      io.gone?.removeEventListener("abort", stop);
      process.off("SIGTERM", term);
      process.off("SIGINT", int);
    },
    signalled: () => code,
    cut: () => sent,
  };
}
