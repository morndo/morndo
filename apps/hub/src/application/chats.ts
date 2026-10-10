// The phone's chat list on the hub (ADR-0011, H1): per worker, the newest message a row previews, the agent's latest
// words (its status line is made from them), and how many messages that matter came after the Read mark. And the
// digest (H5): what each unmuted conversation brought since he left. Read only, from the messages Observation already
// follows (O5's 300): it moves no mark and touches no Escalation.
import { cutText, lastShown, latestAnswer, mattering, type Message, type WorkerId } from "@morndo/domain";
import { catchUp, type CatchUpSources } from "./catchup.ts";

export type ChatsSources = Pick<CatchUpSources, "workers" | "history" | "reads">;
export type ChatRow = { worker: WorkerId; name: string; last: Message | null; answer: Message | null; unread: number; lastAt: number | null; repliedAt: number | null };

// A row needs the first lines only: a long answer is cut here, so 20 lanes stay a small frame.
export const PREVIEW_CHARS = 600;
const short = (m: Message | null): Message | null => (m && m.text.length > PREVIEW_CHARS ? { ...m, text: cutText(m.text, PREVIEW_CHARS) } : m);

export function chats(s: ChatsSources): ChatRow[] {
  const reads = s.reads();
  return s.workers().map(w => {
    const h = s.history(w.id);
    return { worker: w.id as WorkerId, name: w.name, last: short(lastShown(h)), answer: short(latestAnswer(h)), unread: mattering(h, reads[w.name] ?? null), lastAt: h.at(-1)?.at ?? null, repliedAt: h.findLast(m => m.author.kind === "principal")?.at ?? null };
  });
}

// The digest's material: every unmuted conversation's messages after `since` (his last activity before he left), the
// newest `keep` of them and the whole in counts, as catch-up reads them after a Read mark (C5).
export const DIGEST_MESSAGES = 100;
export const digest = (s: CatchUpSources, since: number) =>
  catchUp({ ...s, reads: () => Object.fromEntries(s.workers().map(w => [w.name, since])) }, undefined, DIGEST_MESSAGES);
