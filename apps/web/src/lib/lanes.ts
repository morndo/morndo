// The order of a list of agents (once the phone's Agents tab; ADR-0011 replaced it with the chat list): who needs him first, then who is working, then the rest, each by name.
import type { RosterEntry } from "@morndo/domain";

const rank = (w: RosterEntry) => (w.needsYou ? 0 : w.state === "active" ? 1 : 2);
export const phoneOrder = (workers: readonly RosterEntry[]): RosterEntry[] =>
  [...workers].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
