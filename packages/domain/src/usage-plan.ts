// What a plan's usage looks like over time (U8, plan 4.2): a fact is what one reading said about the plan, a change
// is how two facts differ, and a watch turns a stream of facts into changes the principal is told — but only once a
// later reading agrees, so one odd reading says nothing (AT-28). A window whose usage falls hard while its reset
// stands still is a drop of points, not a reset; a rolling window never drops.
export type PlanWindow = { id: string; lengthMins: number | null; usedPercent: number | null; resetsAt: number | null; rolling: boolean };   // resetsAt in ms
export type PlanFact = { plan: string | null; identity: string | null; windows: readonly PlanWindow[] };
export type PlanChange = { kind: "name" | "account" | "cadence" | "windows" | "drop"; window: string | null; from: string | null; to: string | null };
export type PlanWatch = { baseline: PlanFact | null; held: { changes: readonly PlanChange[]; at: number } | null; rolling: readonly string[]; lastAt: number };
export const PLAN_DROP_POINTS = 20;
export const RESET_SAME_MS = 60_000;      // resets this close together count as the same reset time
export const noPlanWatch: PlanWatch = { baseline: null, held: null, rolling: [], lastAt: 0 };
export function observePlan(before: PlanFact, after: PlanFact, now: number, rolling: readonly string[] = []): PlanChange[] { throw new Error("not implemented"); }
export function watchPlan(w: PlanWatch, fact: PlanFact, capturedAt: number): { watch: PlanWatch; told: PlanChange[] } { throw new Error("not implemented"); }
export function changeSignature(c: PlanChange): string { throw new Error("not implemented"); }   // `${kind}|${window ?? ""}|${to ?? ""}`
