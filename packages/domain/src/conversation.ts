// Conversation (Observation context): one worker's messages as the principal reads them (docs/domain.md, O5, O6).
// The adapter translates a vendor transcript into entries; the author comes from the entry's source, never its text.

export type AuthorKind = "principal" | "agent" | "peer" | "system";
export type Author = { kind: AuthorKind; name: string };

// A file a message carries: one an agent sent to the principal, or one the principal sent. The hub keeps its own copy;
// `id` names that copy, and is null when there is none (the file was gone, too big, or in a place never shared).
// `pending`: the copy is still being made (fleet core §3.1); `id` is null until it lands.
export type AttachmentKind = "image" | "video" | "audio" | "pdf" | "text" | "file";
export type Attachment = { id: string | null; name: string; mime: string; kind: AttachmentKind; size: number | null; caption: string | null; pending?: true };

export type Message = {
  id: string;                       // the source's own ID: stable across reads (O5)
  at: number;
  author: Author;
  kind: "text" | "activity" | "question" | "event" | "file";
  text: string;
  tools?: string[];                 // activity: the tools used
  questionId?: string;              // question: answered by a later "answer" entry
  questions?: QuestionPart[];       // question: what it asks, with the options it offers
  attachments?: Attachment[];       // file: what was sent; text: what the principal attached
};

export type QuestionPart = { question: string; header: string | null; options: { label: string; description: string | null }[]; multiSelect: boolean };

export type ConversationEntry = Message | { kind: "answer"; id: string; at: number; questionId: string };

export const CONVERSATION_CAP = 300;

export class Conversation {
  #cap: number;
  #messages: Message[] = [];
  #ids = new Set<string>();
  #open = new Set<string>();
  #answered = new Set<string>();

  constructor(cap = CONVERSATION_CAP) {
    this.#cap = cap;
  }

  // O5: each message once, in time order, the latest `cap` kept. Returns the messages that are new.
  add(entries: ConversationEntry[]): Message[] {
    const added: Message[] = [];
    for (const e of entries) {
      if (e.kind === "answer") {
        this.#answered.add(e.questionId);
        this.#open.delete(e.questionId);
        continue;
      }
      if (this.#ids.has(e.id)) continue;
      this.#ids.add(e.id);
      if (e.kind === "question" && e.questionId && !this.#answered.has(e.questionId)) this.#open.add(e.questionId);
      added.push(e);
      const last = this.#messages.at(-1);
      if (!last || last.at <= e.at) this.#messages.push(e);
      else this.#messages.splice(this.#messages.findIndex(m => m.at > e.at), 0, e);
    }
    while (this.#messages.length > this.#cap) {
      const dropped = this.#messages.shift();
      if (dropped) this.#ids.delete(dropped.id);
    }
    return added;
  }

  latest(n = this.#cap): Message[] { return this.#messages.slice(-n); }
  get lastAt(): number | null { return this.#messages.at(-1)?.at ?? null; }
  get openQuestions(): number { return this.#open.size; }
  // The open questions themselves, oldest first (O6).
  openQuestionMessages(): Message[] { return this.#messages.filter(m => m.kind === "question" && m.questionId && this.#open.has(m.questionId)); }
}

// O6: a worker needs you while a question it asked is unanswered, or while its screen shows a menu.
export const needsYou = (p: { openQuestions: number; menuOnScreen: boolean }) => p.openQuestions > 0 || p.menuOnScreen;

// What a worker waits for, as an identity a Command can carry and the hub can compare on arrival (S6): its open
// questions by id (in any order), else a menu by the digest of what the menu shows, else nothing. Questions win: an
// open question is drawn as a menu on the screen.
export function waitingOn(p: { openQuestionIds: readonly string[]; menu: string | null }): string | null {
  if (p.openQuestionIds.length) return `q:${[...p.openQuestionIds].sort().join(",")}`;
  return p.menu === null ? null : `menu:${p.menu}`;
}
