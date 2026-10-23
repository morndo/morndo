// The console's one-time approval code on a memory Ask's card (ADR-0031 round 3, docs/design/memory/README.md "App";
// M8): the Ask's id names the Note (mem-n-12 → N-12), the card's button asks the hub for the code under step-up, and
// the code is shown once — held only in the card's own state, never in storage, the URL or a log — and dropped when it
// is closed, runs out, or the note is decided; asking again mints a new one. Pure: no Svelte, no fetch; the card and
// the Desktop pass the outcomes through.
import { ApiError, explain } from "../api.ts";

// The hub files a pending Note's Ask as mem-n-<k> from the Note's own id N-<k> (memory-asks.ts), and its route reads
// the Note as N-[1-9]\d{0,8}: 1 to 9 digits, no leading zero. Anything else is not a memory Ask.
export function noteIdOfAsk(id: string): string | null {
  const m = /^mem-n-([1-9]\d{0,8})$/.exec(id);
  return m === null ? null : `N-${m[1]}`;
}

// The line that spends the code at the console. The code is typed at its prompt (or piped on stdin), never part of the
// command: an argument shows in the process list, and `morndo memory approve` refuses `--code`.
export const consoleCommand = (noteId: string): string => `morndo memory approve ${noteId}`;

export type CodeOutcome = { ok: true; code: string; expiresAt: number } | { ok: false; text: string };

// What went wrong with a mint, in words: the route's own refusals first (http.ts), then the hub's shared words.
export function explainCodeProblem(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case "step_up": return "Verify with your passkey first, then ask again.";
      case "not_pending": return "This note is already decided: there is nothing to approve.";
      case "not_found": return "This note is gone.";
      case "memory_off": return "Memory is off on this hub.";
      case "rate_limited": return "Too many tries; wait a moment.";
    }
  }
  return explain(e);
}

// The card's reveal, a plain state machine: idle, asking, the code shown (with the command that spends it), or why not.
// A shown code lives only here, in the card's memory, and `current` is what may still be shown at a given time.
export type Reveal =
  | { kind: "idle" }
  | { kind: "asking" }
  | { kind: "shown"; noteId: string; code: string; expiresAt: number; command: string }
  | { kind: "failed"; text: string };

export const CLOSED: Reveal = { kind: "idle" };

export function shownFor(noteId: string, outcome: CodeOutcome): Reveal {
  return outcome.ok
    ? { kind: "shown", noteId, code: outcome.code, expiresAt: outcome.expiresAt, command: consoleCommand(noteId) }
    : { kind: "failed", text: outcome.text };
}

// A shown code past its expiry is dropped, leaving only the words to ask again — the card never keeps a code that no
// longer works, so it can't be copied by mistake.
export function current(r: Reveal, now: number): Reveal {
  if (r.kind === "shown" && r.expiresAt <= now) return { kind: "failed", text: "The code expired. Ask for a new one." };
  return r;
}

// Whole minutes of its window left, rounded up, never less than one: "10 min" for a ten-minute code just minted.
export function validUntil(expiresAt: number, now: number): string {
  return `${Math.max(1, Math.ceil((expiresAt - now) / 60_000))} min`;
}
