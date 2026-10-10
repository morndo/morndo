// Node sets a delay larger than 2147483647, less than 1, or NaN to 1, so a job must not arm one.
// https://nodejs.org/api/timers.html#settimeoutcallback-delay-args (read 2026-10-10)
export const MAX_TIMER_MS = 2_147_483_647;
