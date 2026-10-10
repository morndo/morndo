// Whether the principal is attending on this device (ADR-0008 phase F; N3, the product lane's amendment 3): its window
// has focus, and it saw his input (pointer, key or touch) in the last 2 minutes. Mere visibility isn't enough: the
// office's shared desktop keeps a hub tab visible around the clock, and it must not silence the phone. Reported on
// each change, and again every minute while it stays true, since the hub forgets a report after 2 minutes.
export const ATTENDING_INPUT_MS = 2 * 60_000;
export const ATTENDING_REFRESH_MS = 60_000;

export type AttendingDeps = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  hasFocus(): boolean;
  report(attending: boolean): void;
};

export class AttendingTracker {
  #d: AttendingDeps;
  #lastInput: number | null = null;
  #reported: boolean | null = null;
  #reportedAt = 0;
  #timer: unknown = null;

  constructor(d: AttendingDeps) { this.#d = d; }

  get attending(): boolean {
    return this.#d.hasFocus() && this.#lastInput !== null && this.#d.now() - this.#lastInput < ATTENDING_INPUT_MS;
  }

  input() { this.#lastInput = this.#d.now(); this.#check(); }
  focusChanged() { this.#check(); }

  // Says it again (after a reconnect: the hub forgot this connection's word).
  resend() { this.#reported = null; this.#check(); }

  stop() { if (this.#timer !== null) this.#d.clearTimeout(this.#timer); this.#timer = null; }

  // Says it when it changes, and "still here" a minute after the last word while it lasts, however much input comes in
  // between (review H2: renewing a minute after the last input never renewed under steady input).
  #check() {
    const at = this.#d.now(), attending = this.attending;
    if (attending !== this.#reported || (attending && at - this.#reportedAt >= ATTENDING_REFRESH_MS)) {
      this.#reported = attending;
      this.#reportedAt = at;
      this.#d.report(attending);
    }
    this.stop();
    if (!attending || this.#lastInput === null) return;
    // Next look: when the input grows 2 minutes old, or when the word is due again, whichever comes first.
    const next = Math.min(this.#lastInput + ATTENDING_INPUT_MS, this.#reportedAt + ATTENDING_REFRESH_MS);
    this.#timer = this.#d.setTimeout(() => { this.#timer = null; this.#check(); }, Math.max(0, next - at));
  }
}
