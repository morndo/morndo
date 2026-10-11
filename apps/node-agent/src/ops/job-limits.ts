// Node sets a delay larger than 2147483647, less than 1, or NaN to 1, so a job must not arm one.
// https://nodejs.org/api/timers.html#settimeoutcallback-delay-args (read 2026-10-10)
export const MAX_TIMER_MS = 2_147_483_647;

// How long a log stays at its cap before the cap is enforced, in the supervisor's sweeps and in the helper's
// own watch of the log alike: a command that ends on its own within it keeps its own exit code. Whatever the
// command writes meanwhile stays in the log — the store never rewrites one — so this grace trades a bounded
// burst past the cap for that code.
export const FULL_LOG_GRACE_MS = 250;
