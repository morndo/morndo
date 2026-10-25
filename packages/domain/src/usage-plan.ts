// What a plan's usage looks like over time (U8, plan 4.2): a fact is what one reading said about the plan, a change
// is how two facts differ, and a watch turns a stream of facts into changes the principal is told — but only once a
// later reading agrees, so one odd reading says nothing (AT-28). A window whose usage falls hard while its reset
// stands still is a drop of points, not a reset; a rolling window never drops.
export type PlanWindow = { id: string; lengthMins: number | null; usedPercent: number | null; resetsAt: number | null; rolling: boolean };   // resetsAt in ms
// `complete`: this reading names every window the account has (a source that reports them all), so a window missing from it is
// really gone. A status line leaves a window out when it resets or when no turn has run, so it is never complete. It is the
// caller's claim: only a source that lists the account's whole window set (the headless usage report) may set it.
export type PlanFact = { plan: string | null; identity: string | null; windows: readonly PlanWindow[]; complete?: boolean };
// `resetsAt`: for a drop, the reset time the window stood still at (a drop is the same drop at any new percentage).
export type PlanChange = { kind: "name" | "account" | "cadence" | "windows" | "drop"; window: string | null; from: string | null; to: string | null; resetsAt?: number | null };
// `seen`: every window id this account has ever shown, so a window that comes back after the status line left it out is not new.
export type PlanWatch = { baseline: PlanFact | null; held: { changes: readonly PlanChange[]; at: number } | null; rolling: readonly string[]; lastAt: number; seen: readonly string[] };
export const PLAN_DROP_POINTS = 20;
export const RESET_SAME_MS = 60_000;      // resets this close together count as the same reset time
export const noPlanWatch: PlanWatch = { baseline: null, held: null, rolling: [], lastAt: 0, seen: [] };
const byId = (ws: readonly PlanWindow[], id: string): PlanWindow | undefined => ws.find(w => w.id === id);

export function observePlan(before: PlanFact, after: PlanFact, now: number, rolling: readonly string[] = [], seen: readonly string[] = []): PlanChange[] {
  // A different account is the whole difference: the baseline restarts with it.
  if (before.identity !== null && after.identity !== null && before.identity !== after.identity)
    return [{ kind: "account", window: null, from: before.identity, to: after.identity }];
  const changes: PlanChange[] = [];
  if (before.plan !== null && after.plan !== null && before.plan !== after.plan)
    changes.push({ kind: "name", window: null, from: before.plan, to: after.plan });
  const beforeIds = before.windows.map(w => w.id);
  const afterIds = after.windows.map(w => w.id);
  // A window never seen before is new; one gone is gone only when the reading says it names them all.
  const added = afterIds.filter(id => !beforeIds.includes(id) && !seen.includes(id));
  const gone = after.complete === true ? beforeIds.filter(id => !afterIds.includes(id)) : [];
  if (added.length > 0 || gone.length > 0)
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
    changes.push({ kind: "drop", window: id, from: String(a.usedPercent), to: String(b.usedPercent), resetsAt: b.resetsAt });
  }
  return changes;
}

export function watchPlan(w: PlanWatch, fact: PlanFact, capturedAt: number): { watch: PlanWatch; told: PlanChange[] } {
  // A reading not later than the last one taken says nothing new.
  if (capturedAt <= w.lastAt) return { watch: w, told: [] };
  // The first fact ever is a baseline, never a change.
  if (w.baseline === null) return { watch: { ...w, baseline: fact, held: null, lastAt: capturedAt, seen: fact.windows.map(x => x.id) }, told: [] };
  // Rolling memory: a fall while the reset slid later, before the old cycle ended, is a rolling window from now on.
  const rolling = [...w.rolling];
  for (const b of w.baseline.windows) {
    const f = byId(fact.windows, b.id);
    if (!f) continue;
    if (b.usedPercent !== null && f.usedPercent !== null && f.usedPercent < b.usedPercent &&
      b.resetsAt !== null && f.resetsAt !== null && f.resetsAt - b.resetsAt > RESET_SAME_MS && b.resetsAt > capturedAt &&
      !rolling.includes(b.id)) rolling.push(b.id);
  }
  const seenBefore = w.seen ?? [];
  const seen = [...new Set([...seenBefore, ...w.baseline.windows.map(x => x.id), ...fact.windows.map(x => x.id)])];
  const changes = observePlan(w.baseline, fact, capturedAt, rolling, seenBefore);
  if (changes.length === 0) return { watch: { baseline: fact, held: null, rolling, lastAt: capturedAt, seen }, told: [] };
  if (w.held !== null && confirms(w.held.changes, changes))
    return { watch: { baseline: fact, held: null, rolling, lastAt: capturedAt, seen }, told: changes };
  // The first reading of a difference only holds it; a later one that agrees tells it.
  // (what it showed is not yet "seen": the second reading must still find it new)
  return { watch: { ...w, baseline: w.baseline, held: { changes, at: capturedAt }, rolling, lastAt: capturedAt, seen: [...new Set([...seenBefore, ...w.baseline.windows.map(x => x.id)])] }, told: [] };
}

// A later reading agrees with a held difference when it shows the same changes: the same kind of change to the same
// window, to the same value; a drop is the same drop at any new percentage, as long as the reset it stood still at is the same.
const order = (cs: readonly PlanChange[]) => [...cs].sort((a, b) => `${a.kind}|${a.window ?? ""}`.localeCompare(`${b.kind}|${b.window ?? ""}`));
function confirms(held: readonly PlanChange[], now: readonly PlanChange[]): boolean {
  if (held.length !== now.length) return false;
  const a = order(held), b = order(now);
  return a.every((h, i) => {
    const n = b[i];
    if (!n || h.kind !== n.kind || h.window !== n.window) return false;
    if (h.kind !== "drop") return h.to === n.to;
    return h.resetsAt != null && n.resetsAt != null && Math.abs(h.resetsAt - n.resetsAt) <= RESET_SAME_MS;
  });
}

// What a notice is deduplicated by. A drop is signed by its window, its reset and the level it fell from (in tens), not by the
// percentage it fell to: the same fall seen at 20, 22 and 24 is one drop, and a second real drop in the same cycle (it rose
// again, then fell from a different level) is another. Two falls from within the same ten points in one cycle are one notice.
export function changeSignature(c: PlanChange): string {
  if (c.kind === "drop") return `drop|${c.window ?? ""}|${c.resetsAt == null ? "" : Math.round(c.resetsAt / 60_000)}|${Math.floor(Number(c.from) / 10)}`;
  return `${c.kind}|${c.window ?? ""}|${c.to ?? ""}`;
}
