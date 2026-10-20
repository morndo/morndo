// Application service for the Memory context (ADR-0031, docs/design/memory/README.md): what lanes, the manager and the
// principal learned, kept as Notes. Each change is judged by the domain (memory.ts) and written with its events in one
// transaction. The agents come through the hub's agent door with their tokens (agent-access.ts): the manager's token
// acts as the manager, a worker's as the lane it names, and that is the Note's provenance (M3), never the body. The
// principal acts from the console. Memory grants nothing (M1): nothing here touches an Escalation, a Mandate or a
// Decision. What reaches a lane, in a search or in its skills, is what the domain calls deliverable (M4, M5).
import { createHash } from "node:crypto";
import {
  NOTE_KINDS, actorLabel, approveNote, invalidateNote, isDeliverable, parseNoteId, parseScope, proposeNote, renderBundle, supersedeNote,
  type BoardActor, type MemoryActor, type MemoryEvent, type MemoryProblem, type Note, type NoteDraft, type NoteId, type NoteKind, type SkillFile,
} from "@morndo/domain";
import { LIMITS, MEMORY_SEARCH, type MemoryRememberBody } from "@morndo/protocol";
import type { MemoryStore } from "../adapters/memory-store.ts";

// Who asks: an agent as the agent door authenticated it, or the principal at the control plane's console.
export type MemoryCaller = BoardActor | "console";
export const CONSOLE: MemoryActor = { kind: "principal", via: "console", id: "console" };
// The agent door only ever yields the manager or a worker; a principal's BoardActor is a signed-in Endpoint.
export const memoryActor = (c: MemoryCaller): MemoryActor =>
  c === "console" ? CONSOLE : c.kind === "principal" ? { kind: "principal", via: "endpoint", id: c.endpointId } : { kind: c.kind, name: c.name, token: c.token };

export type MemoryResult = { ok: true; note: Note } | { ok: false; problem: MemoryProblem | "not_found" };
export type SearchResult = { ok: true; notes: Note[] } | { ok: false; problem: "bad_query" | "bad_scope" | "bad_kind" | "bad_limit" };
export type Bundle = { version: string; parts: SkillFile[][] };

// What the console's import hands over, one markdown file each, already cut to the limits.
export type ImportFile = { file: string; title: string; summary: string; body: string; lastConfirmedAt: number; procedure: boolean };
export type ImportOutcome = { file: string } & (
  | { done: "added"; note: NoteId }
  | { done: "superseded"; note: NoteId; old: NoteId }
  | { done: "same"; note: NoteId }
  | { done: "refused"; problem: MemoryProblem }
);

// memory.sync's own cap on the files of one part (the protocol's op arguments).
const FILES_PER_PART = 400;
const normalBody = (s: string) => s.replace(/\r\n/g, "\n").trim();

// The bundle's version: the first 32 hex characters of a sha256 over every file's name and content, in order. Each
// file is hashed as the JSON pair [name, content], so no two different bundles hash the same text.
export function bundleVersion(files: readonly SkillFile[]): string {
  const h = createHash("sha256");
  for (const f of files) h.update(JSON.stringify([f.name, f.content]));
  return h.digest("hex").slice(0, 32);
}
// The files in order, in parts of at most LIMITS.memoryPartBytes each, counted as their JSON on the wire, and at most
// FILES_PER_PART files. One file always fits a part: memorySkillBytes is far below it. An empty bundle is one empty part
// (the node then removes every skill of Memory's it wrote).
export function bundleParts(files: readonly SkillFile[]): SkillFile[][] {
  const parts: SkillFile[][] = [[]];
  let used = 0;
  for (const f of files) {
    const size = Buffer.byteLength(JSON.stringify(f));
    const last = parts[parts.length - 1] ?? [];
    if (last.length > 0 && (used + size > LIMITS.memoryPartBytes || last.length >= FILES_PER_PART)) {
      parts.push([f]);
      used = size;
    } else {
      last.push(f);
      used += size;
    }
  }
  return parts;
}

export class MemoryService {
  #store: MemoryStore;
  #now: () => number;

  constructor(p: { store: MemoryStore; now?: () => number }) {
    this.#store = p.store; this.#now = p.now ?? Date.now;
  }

  // A new Note, or with `supersedes` its successor (M2). A refused Note takes no number.
  remember(caller: MemoryCaller, body: MemoryRememberBody): MemoryResult {
    const actor = memoryActor(caller);
    const draft: NoteDraft = {
      kind: body.kind, scope: body.scope, title: body.title, body: body.body,
      ...(body.summary !== undefined ? { summary: body.summary } : {}), ...(body.untrusted !== undefined ? { untrusted: body.untrusted } : {}),
      ref: body.ref ?? null, node: body.node ?? null,
    };
    return this.#store.transaction((): MemoryResult => {
      const now = this.#now();
      const id = this.#store.peekId();
      if (body.supersedes !== undefined) {
        const old = this.#visible(caller, body.supersedes);
        if (!old) return { ok: false, problem: "not_found" };
        const r = supersedeNote(old, draft, actor, id, now);
        if (!r.ok) return { ok: false, problem: r.error.problem };
        this.#store.takeId();
        this.#write([r.value.note, r.value.old], r.value.events);
        return { ok: true, note: r.value.note };
      }
      const r = proposeNote(draft, actor, id, now);
      if (!r.ok) return { ok: false, problem: r.error.problem };
      this.#store.takeId();
      this.#write([r.value.note], [r.value.event]);
      return { ok: true, note: r.value.note };
    });
  }

  // Deliverable Notes only (M4, M5), best match first; an empty `q`, the index order. The query's fields as they came
  // off the wire, checked here.
  search(p: { q?: string | null; scope?: string | null; kind?: string | null; limit?: string | null }): SearchResult {
    const q = p.q ?? "";
    if (q.length > MEMORY_SEARCH.query) return { ok: false, problem: "bad_query" };
    const scope = p.scope ? parseScope(p.scope) : null;
    if (p.scope && !scope) return { ok: false, problem: "bad_scope" };
    if (p.kind && !(NOTE_KINDS as readonly string[]).includes(p.kind)) return { ok: false, problem: "bad_kind" };
    const limit = p.limit ? (/^\d{1,3}$/.test(p.limit) ? Number(p.limit) : 0) : MEMORY_SEARCH.limitDefault;
    if (limit < 1 || limit > MEMORY_SEARCH.limitMax) return { ok: false, problem: "bad_limit" };
    const kind = (p.kind || null) as NoteKind | null;
    return { ok: true, notes: this.#store.search({ q, scope, kind, limit, where: isDeliverable }) };
  }

  // One Note: any, at the console; to an agent, a deliverable one or one it wrote itself (its own unapproved Procedure,
  // its invalidated Note with the reason). Anything else is not_found, so an agent can't tell it from a missing id.
  note(caller: MemoryCaller, id: string): MemoryResult {
    const n = this.#visible(caller, id);
    return n ? { ok: true, note: n } : { ok: false, problem: "not_found" };
  }

  // M2: invalidated, never deleted. The domain decides who may: the principal and the manager any Note, a lane only its
  // own. An agent acts only on a Note it can see.
  invalidate(caller: MemoryCaller, id: string, reason: string): MemoryResult {
    return this.#store.transaction((): MemoryResult => {
      const n = this.#visible(caller, id);
      if (!n) return { ok: false, problem: "not_found" };
      const r = invalidateNote(n, memoryActor(caller), reason, this.#now());
      if (!r.ok) return { ok: false, problem: r.error.problem };
      this.#write([r.value.note], [r.value.event]);
      return { ok: true, note: r.value.note };
    });
  }

  // M4, M5: the principal's approval, taken at the console (slice 1).
  approve(id: string): MemoryResult {
    return this.#store.transaction((): MemoryResult => {
      const n = this.#store.get(id);
      if (!n) return { ok: false, problem: "not_found" };
      const r = approveNote(n, CONSOLE, this.#now());
      if (!r.ok) return { ok: false, problem: r.error.problem };
      this.#write([r.value.note], [r.value.event]);
      return { ok: true, note: r.value.note };
    });
  }

  // The console's list: live Notes in index order; `pending`, only those waiting for the principal's approval (a
  // Procedure or an untrusted Note, M4, M5); `all`, the superseded and invalidated ones too.
  list(o: { scope?: string | null; pending?: boolean; all?: boolean } = {}): { ok: true; notes: Note[] } | { ok: false; problem: "bad_scope" } {
    const scope = o.scope ? parseScope(o.scope) : null;
    if (o.scope && !scope) return { ok: false, problem: "bad_scope" };
    const notes = this.#store.list({ scope, includeInvalid: o.all === true });
    return { ok: true, notes: o.pending ? notes.filter(waitsForApproval) : notes };
  }
  show(id: string): { note: Note; events: MemoryEvent[] } | null {
    const note = this.#store.get(id);
    return note ? { note, events: this.#store.events(id) } : null;
  }

  // An agent's own notes, loaded at the console as {kind: "import", label}: tier 3, facts unless named procedures, and a
  // procedure still waits for approve (M4). A live Note of the same title in the scope is the same note: the same body
  // is skipped, another body supersedes it (M2). One transaction for the whole import.
  importNotes(files: readonly ImportFile[], scope: string, label: string): ImportOutcome[] {
    const actor: MemoryActor = { kind: "import", label };
    return this.#store.transaction(() => files.map((f): ImportOutcome => {
      const now = this.#now();
      const kind: NoteKind = f.procedure ? "procedure" : "fact";
      const draft: NoteDraft = { kind, scope, title: f.title, summary: f.summary, body: f.body, lastConfirmedAt: f.lastConfirmedAt };
      const id = this.#store.peekId();
      const parsed = parseScope(scope);
      const old = parsed ? this.#store.list({ scope: parsed }).filter(n => n.title === f.title.trim()).sort((a, b) => Number(b.id.slice(2)) - Number(a.id.slice(2)))[0] : undefined;
      if (old && old.kind === kind && old.body === normalBody(f.body)) return { file: f.file, done: "same", note: old.id };
      if (old) {
        const r = supersedeNote(old, draft, actor, id, now);
        if (!r.ok) return { file: f.file, done: "refused", problem: r.error.problem };
        this.#store.takeId();
        this.#write([r.value.note, r.value.old], r.value.events);
        return { file: f.file, done: "superseded", note: r.value.note.id, old: old.id };
      }
      const r = proposeNote(draft, actor, id, now);
      if (!r.ok) return { file: f.file, done: "refused", problem: r.error.problem };
      this.#store.takeId();
      this.#write([r.value.note], [r.value.event]);
      return { file: f.file, done: "added", note: r.value.note.id };
    }));
  }

  // What every node receives: the skill files of every live Note (renderBundle keeps the deliverable ones, M4, M5, M6),
  // their version, and the parts they go out in.
  bundle(now: number = this.#now()): Bundle {
    const files = renderBundle(this.#store.list(), now);
    return { version: bundleVersion(files), parts: bundleParts(files) };
  }

  // The console sees every Note. An agent sees a deliverable one, or one it wrote (its label is the provenance, M3).
  #visible(caller: MemoryCaller, id: string): Note | null {
    if (!parseNoteId(id)) return null;
    const n = this.#store.get(id);
    if (!n || caller === "console") return n;
    return isDeliverable(n) || n.provenance.by === actorLabel(memoryActor(caller)) ? n : null;
  }

  #write(notes: Note[], events: MemoryEvent[]) {
    for (const n of notes) this.#store.save(n);
    this.#store.saveEvents(events);
  }
}

// Waiting for the principal: live, not approved, and a Procedure (M4) or untrusted (M5).
export const waitsForApproval = (n: Note): boolean =>
  n.invalidatedAt === null && n.approvedAt === null && (n.kind === "procedure" || n.tier === 4);
