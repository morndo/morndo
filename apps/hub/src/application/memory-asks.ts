// The Ask a pending Memory Note files on the Decisions board (ADR-0031 round 2, docs/design/memory/README.md "App";
// M4, M5, M8): the note's own id names it (N-12 → mem-n-12), the principal's tap under step-up approves or rejects it,
// and the hub holds it open (tracking "hub", E14) until it is answered. Pure: the note in, the Ask out; the body is
// context, untrusted text to show, cut to what a card shows.
import { escalationId, type Ask, type Note } from "@morndo/domain";

const TITLE_MAX = 200;
const BODY_MAX = 4000;

const cut = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

export function memoryAsk(note: Note): Ask {
  const what = note.kind === "procedure" ? "the procedure" : "the untrusted note";
  const untrusted = note.provenance.untrusted ? " — from untrusted content" : "";
  const body = note.body.length <= BODY_MAX ? note.body : `${note.body.slice(0, BODY_MAX)}\n\n…(cut)`;
  return {
    id: escalationId(`mem-${note.id.toLowerCase()}`),
    asker: { kind: "worker", name: "memory", workerId: null },
    need: "decision",
    title: cut(`Approve ${what} "${note.title}" for ${note.scope}?`, TITLE_MAX),
    shortTitle: null,
    summary: note.summary || null,
    minutes: null,
    link: null,
    details: null,
    context: `Written by ${note.provenance.by} (tier ${note.tier})${untrusted}\n\n${body}`,
    contextKind: "markdown",
    options: [
      { key: "approve", label: "Approve", detail: "It reaches every lane's skills at the next sync" },
      { key: "reject", label: "Reject", detail: "The note is invalidated and reaches no lane" },
    ],
    answerBy: "tap",
    recommendation: null,
    ifNoAnswer: "The note stays out of every lane's skills until you approve it.",
    deadline: null,
    blocking: false,
    project: null,
    askedAt: note.createdAt,
    messageId: null,
    tracking: "hub",
  };
}
