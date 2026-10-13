// The answer the card and the brief both read. Kept per decision on the panel, so closing the brief does not drop an
// answer that may have been typed.
import { MAY_HAVE_GONE, endsDoubt } from "../catchup/answer.ts";
import {
  back, noteClosed, openSession, pick, showNew,
  type AnswerBody, type AnswerProblem, type AnswerState, type AskOutcome,
} from "./answer-session.ts";
import type { DecisionItem } from "./decisions.ts";

export class AnswerSession {
  mode = $state<AnswerState["mode"]>("idle");
  picked = $state<AnswerState["picked"]>(null);
  words = $state("");
  sending = $state(false);
  error = $state<string | null>(null);
  again = $state<AnswerState["again"]>(null);
  sent = $state(false);
  shown = $state<DecisionItem>(null as unknown as DecisionItem);
  live = $state<DecisionItem>(null as unknown as DecisionItem);
  asking = $state(false);
  asked = $state(false);
  askError = $state<string | null>(null);

  // The last item `bind` took, outside the state: `live`'s proxy wraps a plain item's nested objects anew on every
  // write, so they would never compare same, and the bind would keep rewriting the state its caller's effect reads.
  #bound: DecisionItem | null = null;

  constructor(item: DecisionItem) { this.apply(openSession(item)); this.#bound = item; }

  snapshot(): AnswerState {
    return {
      mode: this.mode, picked: this.picked, words: this.words, sending: this.sending, error: this.error,
      again: this.again, sent: this.sent, shown: this.shown, live: this.live, asking: this.asking,
      asked: this.asked, askError: this.askError,
    };
  }

  apply(s: AnswerState) {
    this.mode = s.mode; this.picked = s.picked; this.words = s.words; this.sending = s.sending; this.error = s.error;
    this.again = s.again; this.sent = s.sent; this.shown = s.shown; this.live = s.live; this.asking = s.asking;
    this.asked = s.asked; this.askError = s.askError;
  }

  get holdingAnswer() { return this.mode !== "idle" || this.again !== null || this.sending || this.sent; }

  // `hold` while the brief is open: the body stays on the version he has seen. Otherwise a quiet card follows the list.
  // Compare the version, not object identity: a state proxy is never === the item the list just passed.
  // `sent` belongs to the version it was sent for. A re-ask (same id, new version) is a new question: a closed brief
  // follows it, and an open brief drops `sent` only once that version is shown.
  bind(live: DecisionItem, hold: boolean) {
    if (this.sent && live.version !== this.shown.version && !hold) this.sent = false;
    const follow = !hold && !this.holdingAnswer;
    const bound = this.#bound;
    const same = bound !== null && bound.version === live.version && bound.status === live.status && bound.briefVersion === live.briefVersion && bound.answerable === live.answerable && bound.decision === live.decision && bound.notice === live.notice && this.shown.version === (follow ? live.version : this.shown.version);
    if (!same) {
      this.#bound = live;
      this.live = live;
      if (follow) this.shown = live;
    }
    if (live.status !== "open" && (this.mode !== "idle" || this.picked !== null || this.again !== null || this.error !== null)) {
      this.#settleClosed();
    }
  }

  // Apply a close without touching the brief on screen. A refusal stays unless an answer is in doubt.
  #settleClosed() {
    const next = noteClosed(this.snapshot());
    this.mode = next.mode;
    this.picked = next.picked;
    this.again = next.again;
    this.error = next.error;
  }

  pick(label: string, body: AnswerBody) { this.apply(pick(this.snapshot(), label, body)); }
  showNew() { this.apply(showNew(this.snapshot(), this.live)); }
  back() { this.apply(back(this.snapshot())); }
  get stale() { return this.live.version !== this.shown.version; }
  get seen() { return this.shown.version; }

  async send(onAnswer: (id: string, body: AnswerBody, requestId: string, seen?: string) => Promise<AnswerProblem | null>, body: AnswerBody, requestId: string = crypto.randomUUID()) {
    // A new answer waits until the version on screen is current. An answer already in doubt is checked again on the
    // version it was sent for, even after a restate: that is the same request, not a silent no-op.
    if (this.sending || this.live.status !== "open") return;
    if (this.stale && this.again === null) return;
    this.sending = true;
    this.error = null;
    const doubt = this.again;
    const problem = await onAnswer(this.live.id, body, requestId, this.seen);
    this.sending = false;
    if (problem) {
      this.error = problem.text;
      this.again = MAY_HAVE_GONE.has(problem.code) ? { body, requestId, code: problem.code } : doubt && !endsDoubt(problem.code) ? doubt : null;
      if (this.live.status !== "open") this.#settleClosed();
      return;
    }
    // The POST was accepted. The feed may already show the item answered; that is this answer, not a close.
    this.again = null;
    this.sent = true;
    this.mode = "idle";
    this.picked = null;
    this.words = "";
  }

  async ask(onAsk: (item: DecisionItem) => Promise<AskOutcome>) {
    if (this.asking || this.asked) return;
    this.asking = true;
    this.askError = null;
    try {
      const result = await onAsk(this.live);
      if (result.ok) this.asked = true;
      else this.askError = result.error;
    } finally {
      this.asking = false;
    }
  }
}
