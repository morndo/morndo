// Node sets a delay larger than 2147483647, less than 1, or NaN to 1, so a job must not arm one.
// https://nodejs.org/api/timers.html#settimeoutcallback-delay-args (read 2026-10-10)
export const MAX_TIMER_MS = 2_147_483_647;

// How long a cancel waits after its signals for a unit that is still deactivating before it is only "signalled".
export const UNIT_STOP_WAIT_MS = 1500;
