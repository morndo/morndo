// The small rules the Knowledge context's modules share (ADR-0026), one copy each: what a mapping is, a non-blank string, a
// value as a message shows it, a real date, and the id a preference is cited by. Internal: the domain's index doesn't export it.

export type Rec = Record<string, unknown>;
export const isRec = (x: unknown): x is Rec => typeof x === "object" && x !== null && !Array.isArray(x);
export const text = (x: unknown): x is string => typeof x === "string" && x.trim() !== "";
export const shown = (x: unknown): string => (typeof x === "string" ? x : (JSON.stringify(x) ?? "nothing"));

// A YYYY-MM-DD date as milliseconds since the epoch at midnight UTC, or NaN. Read as an ISO date, so 0026 is the year 26.
export const utcMs = (date: string): number => (/^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN);
// A real date reads back as itself: 2026-02-30 reads as 2026-03-02, so it is not one.
export const isDate = (x: unknown): x is string => {
  if (typeof x !== "string") return false;
  const ms = utcMs(x);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === x;
};

// A preference's id, as an SOP cites it: pref:<id>. The preferences schema's pattern is this one; a test holds them equal.
export const PREFERENCE_ID = /^[a-z0-9][a-z0-9-]*$/;
