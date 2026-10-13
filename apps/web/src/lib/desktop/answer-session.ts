// One answer to a decision (the card and the brief share it). Pure: the class in answer-session.svelte.ts holds it.
// A restate keeps the version on screen until the principal asks for the new one, and an answer in doubt keeps its
// request id across closing the brief (E8, E12).
import type { DecisionItem } from "./decisions.ts";

export type AnswerBody = { key: string } | { text: string };
export type AnswerProblem = { code: string; text: string };
export type AnswerMode = "idle" | "confirm" | "words";
export type AnswerAgain = { body: AnswerBody; requestId: string; code: string };
export type AskOutcome = { ok: true } | { ok: false; error: string };

export type AnswerState = {
  mode: AnswerMode;
  picked: { label: string; body: AnswerBody } | null;
  words: string;
  sending: boolean;
  error: string | null;
  again: AnswerAgain | null;
  sent: boolean;
  shown: DecisionItem;
  live: DecisionItem;
  asking: boolean;
  asked: boolean;
  askError: string | null;
};

export function openSession(item: DecisionItem): AnswerState {
  return {
    mode: "idle", picked: null, words: "", sending: false, error: null, again: null, sent: false,
    shown: item, live: item, asking: false, asked: false, askError: null,
  };
}

export const stale = (s: AnswerState) => s.live.version !== s.shown.version;

// The version on screen. Sending names this one, so a restate the principal has not opened is refused as changed.
export const seenOf = (s: AnswerState) => s.shown.version;

export function pick(s: AnswerState, label: string, body: AnswerBody): AnswerState {
  if (stale(s) || s.sending || s.again || s.live.status !== "open") return s;
  return { ...s, picked: { label, body }, mode: "confirm", error: null };
}

// Show the new version: the pick belonged to the version that was on screen, so it goes.
// A sent answer belonged to that version too. The version now on screen has not been answered.
export function showNew(s: AnswerState, live: DecisionItem): AnswerState {
  const sent = live.version === s.shown.version ? s.sent : false;
  return { ...s, live, shown: live, mode: "idle", picked: null, words: "", error: null, sent };
}

export function back(s: AnswerState): AnswerState {
  return { ...s, mode: "idle", picked: null, error: s.again ? s.error : null };
}

// Closed meanwhile: nothing is left to confirm. An answer in doubt is cleared, error included, because there is
// nothing left to check. A refusal with nothing in doubt stays, so the reason it did not go is still on screen.
// A hub restart can drop an open decision for a moment. An answer in doubt, a sent flag, or words already
// typed stay with that id so a return cannot send a second request. A closed decision, or one gone this long, does not.
export const ABSENT_GRACE_MS = 60_000;

export function releaseAbsentSession(s: Pick<AnswerState, "again" | "sent" | "words" | "live">, absentMs: number): boolean {
  if (s.live.status !== "open") return true;
  if (s.again === null && !s.sent && s.words.trim() === "") return true;
  return absentMs >= ABSENT_GRACE_MS;
}

export function noteClosed(s: AnswerState): AnswerState {
  const error = s.again ? null : s.error;
  if (s.mode === "idle" && s.picked === null && s.again === null && s.error === error) return s;
  return { ...s, mode: "idle", picked: null, again: null, error };
}
