// How a limit window is titled (U7): from a length the source reported, from a gap between resets that was observed,
// or from the horizon of the furthest reset seen — never from a caption the provider printed. A horizon is always
// said with "about"; with no length at all, only the time left in the window is said.
export type PlanFamily = "weekly" | "either";      // a weekly-period plan, or a name on both periods; null: not known
export type WindowCadence = { basis: "reported" | "observed" | "horizon" | "none"; lengthMins: number | null };
export type CadenceInput = { lengthMins: number | null; observedGapMs: number | null; furthestResetMs: number | null; family: PlanFamily | null };
export function cadenceOf(i: CadenceInput): WindowCadence { throw new Error("not implemented"); }
export function lengthTitle(mins: number): string { throw new Error("not implemented"); }
export function resetsInLabel(resetsAt: number | null, now: number): string { throw new Error("not implemented"); }
export function windowTitle(c: WindowCadence, resetsAt: number | null, now: number): string { throw new Error("not implemented"); }
