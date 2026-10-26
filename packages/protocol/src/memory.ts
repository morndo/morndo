// Memory on the wire (ADR-0031): the bodies the agents' CLI (`morndo-memory`) sends to the hub's agent door with a
// bearer token, and the Notes the hub answers with. Types are the domain's own; a Note this build can't read is dropped
// from a list, never guessed.
import { MEMORY_LIMITS, NOTE_KINDS, type Note } from "@morndo/domain";
import * as z from "./z.ts";

const str = (max: number) => z.string().check(z.maxLength(max));
const noteIdText = () => z.string().check(z.regex(/^N-[1-9]\d{0,8}$/));

// POST /api/agent/memory/notes: a new Note, or with `supersedes` a successor of one (M2). Provenance comes from the
// token and the lane the request names (M3), never from the body; `node` and `ref` only add to it.
export const MemoryRememberBody = z.object({
  kind: z.enum(NOTE_KINDS),
  scope: str(110),
  title: str(MEMORY_LIMITS.title),
  summary: z.exactOptional(str(MEMORY_LIMITS.summary)),
  body: str(MEMORY_LIMITS.body),
  untrusted: z.exactOptional(z.boolean()),
  ref: z.exactOptional(str(MEMORY_LIMITS.ref)),
  node: z.exactOptional(str(64)),
  supersedes: z.exactOptional(noteIdText()),
});
export type MemoryRememberBody = z.output<typeof MemoryRememberBody>;

// POST /api/agent/memory/notes/:id/invalidate (M2): why.
export const MemoryInvalidateBody = z.object({ reason: str(MEMORY_LIMITS.reason) });
export type MemoryInvalidateBody = z.output<typeof MemoryInvalidateBody>;

// GET /api/agent/memory/search?q=&scope=&kind=&limit=: the query's own limits, checked by the hub before it searches.
export const MEMORY_SEARCH = { query: 200, limitDefault: 10, limitMax: 50 } as const;

const NoteSchema = z.object({
  id: noteIdText(), kind: z.enum(NOTE_KINDS), scope: z.string(), title: z.string(), summary: z.string(), body: z.string(),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  provenance: z.object({ by: z.string(), node: z.nullable(z.string()), ref: z.nullable(z.string()), untrusted: z.boolean() }),
  createdAt: z.number(), lastConfirmedAt: z.number(), recheckAt: z.nullable(z.number()),
  approvedAt: z.nullable(z.number()), approvedBy: z.nullable(z.string()),
  invalidatedAt: z.nullable(z.number()), invalidatedBy: z.nullable(z.string()), invalidReason: z.nullable(z.string()),
  supersedes: z.nullable(noteIdText()), supersededBy: z.nullable(noteIdText()),
});
// The answers: one Note, or a list. A list item that doesn't read is dropped (the CLI shows what it can).
export const MemoryNoteAnswer = z.object({ note: NoteSchema });
export const MemoryListAnswer = z.object({ notes: z.array(z.unknown()) });
export const parseNote = (v: unknown): Note | null => {
  const r = z.safeParse(NoteSchema, v);
  return r.success ? (r.data as Note) : null;
};

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const check = <T extends true>(t: T) => t;
check<Same<Omit<z.output<typeof NoteSchema>, "id" | "scope" | "supersedes" | "supersededBy">, Omit<Note, "id" | "scope" | "supersedes" | "supersededBy">>>(true);
