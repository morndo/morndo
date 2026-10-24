// The board on the wire (ADR-0015): the tasks the hub pushes to the app (the `board` feed frame) and answers to the
// agents' CLI, and the bodies a change is sent with, from the app (a Command, AC7) or from an agent (a bearer token).
// Types are the domain's own; a task this build can't read is dropped from the list, never guessed.
import type { EndpointId, MergeRecord, MergedView, ProofBrief, ProofState, RefResult, SessionId, Task, TaskActor, TaskChange, TaskEvent, TASK_PRIORITIES, TASK_STATUSES } from "@morndo/domain";
import type { CoverageItem } from "@morndo/domain";
import { ATTESTED_KINDS, COVERAGE_STATUSES, ITEM_KINDS, PROOF_KINDS, PROOF_MODES, REF_STATES } from "@morndo/domain";
import * as z from "./z.ts";

const str = (max: number) => z.string().check(z.maxLength(max));
const text = () => z.string();
const count = () => z.number().check(z.gte(0));
const orElse = z.catch;

export const STATUSES = ["backlog", "todo", "doing", "blocked", "review", "done"] as const satisfies typeof TASK_STATUSES;
export const PRIORITIES = ["high", "normal", "low"] as const satisfies typeof TASK_PRIORITIES;
export const taskKey = () => z.pipe(z.string().check(z.regex(/^T-[1-9]\d{0,8}$/)), z.transform(s => s as Task["key"]));
const endpointId = () => z.pipe(text(), z.transform(s => s as EndpointId));
const sessionId = () => z.pipe(text(), z.transform(s => s as SessionId));

// B13: the stored brief on the wire (ADR-0035).
export const ProofBriefSchema = z.object({
  summary: text(), decisions: text(), leftOut: text(), limits: text(), refs: z.array(text()),
  attested: z.array(z.object({ kind: z.enum(ATTESTED_KINDS), how: text() })), noCode: text(),
});
export const RefResultSchema = z.object({ ref: text(), state: z.enum(REF_STATES), detail: z.nullable(text()), checkedAt: count() });
export const CoverageItemSchema = z.object({
  spec: text(), kind: z.enum(ITEM_KINDS), repo: z.nullable(text()), text: text(), by: z.enum(["assigner", "lane"]), status: z.enum(COVERAGE_STATUSES),
});
export const ProofViewSchema = z.object({
  rev: z.nullable(z.int().check(z.gte(1))), brief: z.nullable(ProofBriefSchema), results: z.array(RefResultSchema), mode: z.enum(PROOF_MODES), standIn: z.boolean(),
  coverage: z.array(CoverageItemSchema),
  state: z.object({ kind: z.enum(PROOF_KINDS), green: count(), total: count(), accepts: z.boolean(), line: text() }),
});
export type ProofView = z.output<typeof ProofViewSchema>;

export const BoardActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("principal"), endpointId: endpointId(), sessionId: sessionId() }),
  z.object({ kind: z.literal("manager"), name: text(), token: text() }),
  z.object({ kind: z.literal("worker"), name: text(), token: text() }),
]);
// Who changed a task (ADR-0032): an agents' door actor, the control plane's console, or the board itself following a Run.
export const TaskActorSchema = z.union([
  BoardActorSchema,
  z.object({ kind: z.literal("console") }),
  z.object({ kind: z.literal("board"), rule: z.enum(["D1", "D2", "D3", "D4"]), lane: text() }),
]);
export const BoardTaskSchema = z.object({
  key: taskKey(), n: z.int().check(z.gte(1)), title: text(), description: text(),
  status: z.enum(STATUSES), assignee: z.nullable(text()), priority: orElse(z.enum(PRIORITIES), "normal"),
  blockedReason: z.nullable(text()), createdAt: count(), updatedAt: count(), stateChangedAt: count(), createdBy: TaskActorSchema,
  rev: z.int().check(z.gte(1)), doneAt: z.nullable(count()), comments: count(),
});
export const TaskChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("created"), status: z.enum(STATUSES), assignee: z.nullable(text()) }),
  z.object({ kind: z.literal("moved"), from: z.enum(STATUSES), to: z.enum(STATUSES), reason: z.nullable(text()), notLive: z.exactOptional(text()), proofSeen: z.exactOptional(text()) }),
  z.object({ kind: z.literal("assigned"), from: z.nullable(text()), to: z.nullable(text()) }),
  z.object({ kind: z.literal("edited"), title: z.exactOptional(text()), description: z.exactOptional(text()), priority: z.exactOptional(z.enum(PRIORITIES)) }),
  z.object({ kind: z.literal("commented"), text: text() }),
  // B13: the stored brief (ADR-0035); `refs` are the canonical reference strings, `attested` the lane's own word.
  z.object({ kind: z.literal("briefed"), brief: ProofBriefSchema }),
  z.object({ kind: z.literal("merged"), repo: text(), sha: text() }),
  z.object({ kind: z.literal("unmerged"), repo: text(), sha: text() }),
  z.object({ kind: z.literal("proof_listed"), add: z.array(text()), drop: z.array(text()) }),
]);
export const TaskEventSchema = z.object({ key: taskKey(), rev: z.int().check(z.gte(1)), at: count(), actor: TaskActorSchema, change: TaskChangeSchema });

// A task's recorded merges and their liveness (B11): `merged` in the board frame carries these, decoded one by one by
// whoever reads it (as `runs`); a merge's `override` is the reason done was accepted while it was not live.
export const MergeRecordSchema = z.object({ repo: text(), sha: text(), at: count(), by: text(), override: z.nullable(text()) });
export const MergedViewSchema = z.object({ key: taskKey(), merges: z.array(MergeRecordSchema), live: z.nullable(z.boolean()), label: text() });

// The whole board, as the hub holds it (boardOrder): sent after every hello and on every change, like the decisions.
// `lanes`: the lane names the hub lists now, so the app can mark an assignee that isn't running. `runs` (ADR-0032): each
// lane's Run as the fleet derived it (RunViewSchema, decoded one by one: one this build can't read is dropped); absent
// from a hub that has none. `orphans`: the keys of the to do tasks whose lane the fleet no longer lists; absent from a
// hub that has none. `merged` (B11): each shown task's MergedView, decoded the same way; absent from a hub that has none.
export const BoardFrameSchema = z.object({
  t: z.literal("board"), tasks: z.array(z.unknown()), lanes: z.array(text()), at: count(), runs: z.exactOptional(z.array(z.unknown())),
  orphans: z.exactOptional(z.array(text())),
  merged: z.exactOptional(z.array(z.unknown())),
});

// A new task, from the app or an agent. A worker's lands in the backlog whatever it says (B2).
export const BoardCreateBody = z.object({
  title: str(1000), description: z.exactOptional(str(20_000)), assignee: z.exactOptional(z.nullable(str(200))),
  priority: z.exactOptional(z.enum(PRIORITIES)), status: z.exactOptional(z.enum(STATUSES)),
});
// One change to one task: the same body from the app and from an agent; the hub decides by who sent it.
const ifRev = z.exactOptional(z.int().check(z.gte(1)));
export const BoardActionBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("move"), to: z.enum(STATUSES), reason: z.exactOptional(str(2000)), notLive: z.exactOptional(str(2000)), proofOverride: z.exactOptional(str(2000)), ifRev }),
  z.object({ action: z.literal("assign"), to: z.nullable(str(200)), ifRev }),
  z.object({ action: z.literal("edit"), title: z.exactOptional(str(1000)), description: z.exactOptional(str(20_000)), priority: z.exactOptional(z.enum(PRIORITIES)), ifRev }),
  z.object({ action: z.literal("comment"), text: str(20_000) }),
  // B13: the brief, its own action (ADR-0035). No ifRev (like a comment or a merged record): it changes no state, so it
  // races with nothing. The wire caps are loose on purpose; the domain judges the real ones.
  z.object({
    action: z.literal("brief"), brief: z.object({
      summary: str(20_000), decisions: z.exactOptional(str(20_000)), leftOut: str(20_000), limits: str(20_000),
      refs: z.exactOptional(z.array(str(1000)).check(z.maxLength(50))),
      attested: z.exactOptional(z.array(z.object({ kind: str(40), how: str(20_000) })).check(z.maxLength(50))),
      noCode: z.exactOptional(str(20_000)),
    }),
  }),
  // B11: recording a task's PR merged, and clearing a wrong record (only the board's hands may). No ifRev (like a
  // comment): neither changes state, so each races with nothing.
  z.object({ action: z.literal("merged"), sha: str(100), repo: z.exactOptional(str(300)) }),
  z.object({ action: z.literal("unmerged"), sha: str(100), repo: z.exactOptional(str(300)) }),
  z.object({ action: z.literal("proof_list"), add: z.exactOptional(z.array(str(400)).check(z.maxLength(12))), drop: z.exactOptional(z.array(str(400)).check(z.maxLength(12))) }),
]);
export type BoardCreateBody = z.output<typeof BoardCreateBody>;
export type BoardActionBody = z.output<typeof BoardActionBody>;

// The decoded shapes are the domain's own (checked at compile time).
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const check = <T extends true>(t: T) => t;
check<Same<z.output<typeof BoardTaskSchema>, Task>>(true);
check<Same<z.output<typeof TaskChangeSchema>, TaskChange>>(true);
check<Same<z.output<typeof TaskEventSchema>, TaskEvent>>(true);
check<Same<z.output<typeof TaskActorSchema>, TaskActor>>(true);
check<Same<z.output<typeof MergeRecordSchema>, MergeRecord>>(true);
check<Same<z.output<typeof MergedViewSchema>, MergedView>>(true);
check<Same<z.output<typeof ProofBriefSchema>, ProofBrief>>(true);
check<Same<z.output<typeof RefResultSchema>, RefResult>>(true);
check<Same<z.output<typeof ProofViewSchema>["state"], ProofState>>(true);
check<Same<z.output<typeof CoverageItemSchema>, CoverageItem>>(true);
