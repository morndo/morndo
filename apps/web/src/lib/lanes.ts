// The order of a list of agents (once the phone's Agents tab; ADR-0011 replaced it with the chat list): who needs him first, then who is working, then the rest, each by name.
import type { RosterEntry, Run } from "@morndo/domain";
import { onOwnWork } from "./desktop/run-words.ts";

const rank = (w: RosterEntry) => (w.needsYou ? 0 : w.state === "active" ? 1 : 2);
export const phoneOrder = (workers: readonly RosterEntry[]): RosterEntry[] =>
  [...workers].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

// A lane that waits on its own work (R2) — background tasks, a job, a wake-up — still works. One label for it, wherever a
// list says so.
export const BACKGROUND_LABEL = "Working (background)";

// True when the lane is not mid-turn and its Run says it waits on its own work.
export const inBackground = (w: RosterEntry, runs: ReadonlyMap<string, Run> | null | undefined): boolean => {
  const r = runs?.get(w.name);
  return w.state !== "active" && r !== undefined && onOwnWork(r);
};

// The sidebar's sections: starred lanes apart, then who works — mid-turn, waiting for him, or on its own background work —
// then the rest, each by name.
export function partitionAgents(
  agents: readonly RosterEntry[],
  runs: ReadonlyMap<string, Run> | null | undefined,
  starred: (w: RosterEntry) => boolean,
): { starred: RosterEntry[]; working: RosterEntry[]; idle: RosterEntry[] } {
  const byName = (a: RosterEntry, b: RosterEntry) => a.name.localeCompare(b.name);
  const works = (w: RosterEntry) => w.state === "active" || w.needsYou || inBackground(w, runs);
  return {
    starred: agents.filter(w => starred(w)).sort(byName),
    working: agents.filter(w => !starred(w) && works(w)).sort(byName),
    idle: agents.filter(w => !starred(w) && !works(w)).sort(byName),
  };
}
