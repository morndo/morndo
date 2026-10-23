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
const byId = (ws: readonly PlanWindow[], id: string): PlanWindow | undefined => ws.find(w => w.id === id);

export function observePlan(before: PlanFact, after: PlanFact, now: number, rolling: readonly string[] = []): PlanChange[] {
  // A different account is the whole difference: the baseline restarts with it.
  if (before.identity !== null && after.identity !== null && before.identity !== after.identity)
    return [{ kind: "account", window: null, from: before.identity, to: after.identity }];
  const changes: PlanChange[] = [];
  if (before.plan !== null && after.plan !== null && before.plan !== after.plan)
    changes.push({ kind: "name", window: null, from: before.plan, to: after.plan });
  const beforeIds = before.windows.map(w => w.id);
  const afterIds = after.windows.map(w => w.id);
  if (!(beforeIds.length === afterIds.length && beforeIds.every(id => afterIds.includes(id))))
    changes.push({ kind: "windows", window: null, from: [...beforeIds].sort().join(","), to: [...afterIds].sort().join(",") });
  const ids = [...new Set([...beforeIds, ...afterIds])].sort();
  for (const id of ids) {
    const a = byId(before.windows, id), b = byId(after.windows, id);
    if (a && b && a.lengthMins !== null && b.lengthMins !== null && a.lengthMins !== b.lengthMins)
      changes.push({ kind: "cadence", window: id, from: String(a.lengthMins), to: String(b.lengthMins) });
  }
  for (const id of ids) {
    const a = byId(before.windows, id), b = byId(after.windows, id);
    if (!a || !b || a.rolling || b.rolling || rolling.includes(id)) continue;
    // A fall of points with the reset standing still and still ahead: a drop, not a reset.
    if (a.usedPercent === null || b.usedPercent === null || a.usedPercent - b.usedPercent < PLAN_DROP_POINTS) continue;
    if (a.resetsAt === null || b.resetsAt === null || Math.abs(b.resetsAt - a.resetsAt) > RESET_SAME_MS || b.resetsAt <= now) continue;
    changes.push({ kind: "drop", window: id, from: String(a.usedPercent), to: String(b.usedPercent) });
  }
  return changes;
}

export function watchPlan(w: PlanWatch, fact: PlanFact, capturedAt: number): { watch: PlanWatch; told: PlanChange[] } {
  // A reading not later than the last one taken says nothing new.
  if (capturedAt <= w.lastAt) return { watch: w, told: [] };
  // The first fact ever is a baseline, never a change.
  if (w.baseline === null) return { watch: { ...w, baseline: fact, held: null, lastAt: capturedAt }, told: [] };
  // Rolling memory: a fall while the reset slid later, before the old cycle ended, is a rolling window from now on.
  const rolling = [...w.rolling];
  for (const b of w.baseline.windows) {
    const f = byId(fact.windows, b.id);
    if (!f) continue;
    if (b.usedPercent !== null && f.usedPercent !== null && f.usedPercent < b.usedPercent &&
      b.resetsAt !== null && f.resetsAt !== null && f.resetsAt - b.resetsAt > RESET_SAME_MS && b.resetsAt > capturedAt &&
      !rolling.includes(b.id)) rolling.push(b.id);
  }
  const changes = observePlan(w.baseline, fact, capturedAt, rolling);
  if (changes.length === 0) return { watch: { baseline: fact, held: null, rolling, lastAt: capturedAt }, told: [] };
  const heldSig = w.held ? [...w.held.changes.map(changeSignature)].sort().join(",") : null;
  if (heldSig !== null && heldSig === [...changes.map(changeSignature)].sort().join(","))
    return { watch: { baseline: fact, held: null, rolling, lastAt: capturedAt }, told: changes };
  // The first reading of a difference only holds it; a later one that agrees tells it.
  return { watch: { ...w, baseline: w.baseline, held: { changes, at: capturedAt }, rolling, lastAt: capturedAt }, told: [] };
}

export function changeSignature(c: PlanChange): string { return `${c.kind}|${c.window ?? ""}|${c.to ?? ""}`; }
