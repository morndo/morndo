// A turn nobody reads. `morndo-keys run … | head` closes the pipe; the next write to it fails with EPIPE, which the bin drops so
// it ends quietly (service-kit quietBrokenPipe). The agent on the other end would still run to the end of its turn, spending
// the connection's budget on output that goes nowhere, so the bin raises `Io.gone` when a write fails that way and the
// run stops its child: SIGTERM, then SIGKILL after a grace (the child is still told once, and only while it runs). The books are
// still closed by the caller with what the turn used. It is noticed on a write: an agent that is silent goes on until its next
// line. https://nodejs.org/docs/latest-v24.x/api/process.html#a-note-on-process-io (read 2026-10-20).
import type { Io } from "./cli.ts";

const STOP_GRACE_MS = 3_000;

export type TurnStopper = { started(pid: number): void; done(): void };

export function turnStopper(io: Io, graceMs = STOP_GRACE_MS): TurnStopper {
  let pid: number | null = null;
  let gone = io.gone?.aborted ?? false;
  let timer: NodeJS.Timeout | null = null;
  const stop = (): void => {
    gone = true;
    const target = pid;
    if (target === null || timer !== null) return;
    try { process.kill(target, "SIGTERM"); } catch { return; }
    timer = setTimeout(() => { try { process.kill(target, "SIGKILL"); } catch { /* it is gone */ } }, graceMs);
  };
  io.gone?.addEventListener("abort", stop, { once: true });
  return {
    started(started) { pid = started; if (gone) stop(); },
    done() {
      pid = null;
      if (timer !== null) clearTimeout(timer);
      io.gone?.removeEventListener("abort", stop);
    },
  };
}
