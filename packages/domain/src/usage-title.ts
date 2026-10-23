// How a limit window is titled (U7): from a length the source reported, from a gap between resets that was observed,
// or from the horizon of the furthest reset seen — never from a caption the provider printed. A horizon is always
// said with "about"; with no length at all, only the time left in the window is said.
import { cleanLength } from "./usage-reading.ts";

export type PlanFamily = "weekly" | "either";      // a weekly-period plan, or a name on both periods; null: not known
export type WindowCadence = { basis: "reported" | "observed" | "horizon" | "none"; lengthMins: number | null };
export type CadenceInput = { lengthMins: number | null; observedGapMs: number | null; furthestResetMs: number | null; family: PlanFamily | null };
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

// A gap between resets is only nearly a known length; close enough counts as that length.
const snap = (mins: number): number => {
  if (Math.abs(mins - 300) <= 5) return 300;
  if (Math.abs(mins - 10080) <= 30) return 10080;
  const d = Math.round(mins / 1440);
  if (d >= 1 && Math.abs(mins - d * 1440) <= 30) return d * 1440;
  return mins;
};

export function cadenceOf(i: CadenceInput): WindowCadence {
  const length = cleanLength(i.lengthMins);
  if (length !== null) return { basis: "reported", lengthMins: length };
  if (i.observedGapMs !== null && i.observedGapMs > 0) return { basis: "observed", lengthMins: snap(Math.round(i.observedGapMs / MIN)) };
  if (i.furthestResetMs !== null) {
    if (i.furthestResetMs > 8 * DAY) return { basis: "horizon", lengthMins: 43200 };
    if (i.family === "weekly") return { basis: "horizon", lengthMins: 10080 };
    if (i.family === "either") return { basis: "horizon", lengthMins: null };
  }
  return { basis: "none", lengthMins: null };
}

export function lengthTitle(mins: number): string {
  if (mins === 300) return "5-hour";
  if (mins === 10080) return "weekly";
  if (mins % 1440 === 0) {
    const d = mins / 1440;
    if (d >= 28 && d <= 31) return "monthly";
    return `${d}-day`;
  }
  if (mins % 60 === 0) return `${mins / 60}-hour window`;
  return `${mins}-minute window`;
}

export function resetsInLabel(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return "window";
  const left = resetsAt - now;
  if (left <= 0) return "resetting";
  const days = Math.floor(left / DAY);
  const hours = Math.floor((left % DAY) / HOUR);
  const mins = Math.floor((left % HOUR) / MIN);
  if (days > 0) return `resets in ${days} d${hours > 0 ? ` ${hours} h` : ""}`;
  if (hours > 0) return `resets in ${hours} h${mins > 0 ? ` ${mins} min` : ""}`;
  return `resets in ${Math.max(1, mins)} min`;
}

export function windowTitle(c: WindowCadence, resetsAt: number | null, now: number): string {
  if ((c.basis === "reported" || c.basis === "observed") && c.lengthMins !== null) return lengthTitle(c.lengthMins);
  if (c.basis === "horizon") return c.lengthMins !== null ? `about ${lengthTitle(c.lengthMins)}` : "plan period";
  return resetsInLabel(resetsAt, now);
}
