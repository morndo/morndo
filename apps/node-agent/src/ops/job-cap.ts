// The log cap rule (design §5, "When a log reaches its cap"). The helper and the systemd sweep both decide through
// these two functions, so the backends follow one rule: a grace from the owner's first sighting that ends at once when
// the log grows, and a command's own code kept only for an exit that came before the stop.

// How long a command whose log reached the cap may take to end on its own while the log does not grow.
export const CAP_GRACE_MS = 1000;
// How often the systemd sweep that saw the cap looks again during the grace. The helper looks every 30 ms.
export const UNIT_CAP_LOOK_MS = 50;

export type CapSight = { size: number; at: number };
export type CapStep = { kind: "under" } | { kind: "grace"; sight: CapSight } | { kind: "stop" };

// One look at a running job's log: its size now, and whether a .cap file notes that the supervisor saw the cap.
// `sight` is what the owner saw first; the log never shrinks (the store never rewrites one), so it only grows from it.
export function capStep(sight: CapSight | null, size: number, cap: number, now: number, noted = false): CapStep {
  if (sight === null) {
    if (!noted && !(cap > 0 && size >= cap)) return { kind: "under" };
    return { kind: "grace", sight: { size, at: now } };
  }
  if (size > sight.size || now - sight.at >= CAP_GRACE_MS) return { kind: "stop" };
  return { kind: "grace", sight };
}

// Both sides are CLOCK_MONOTONIC microseconds: systemd's ExecMainExitTimestampMonotonic (org.freedesktop.systemd1(5),
// systemd 255: the ExecStart CLOCK_REALTIME/CLOCK_MONOTONIC pair), and process.hrtime, which is libuv's uv_hrtime,
// clock_gettime(CLOCK_MONOTONIC) on Linux (libuv 1.52.1 src/unix/core.c and linux.c, read 2026-10-11).
// 0 means the main process has not exited.
export function endedBeforeStop(exitedUsec: number, sentUsec: bigint): boolean {
  return exitedUsec > 0 && BigInt(exitedUsec) < sentUsec;
}
