import type { CommandResult, Event } from "@morndo/cockpit-api";

/** One stand-in read, validated against the route's response definition before sending. */
export interface Outcome {
  status: number;
  definition: string;
  body: unknown;
}

/** Pending command result. The hub sequences its events before sending it. */
export type Effect = Omit<CommandResult, "events"> & { events: Event[] };

export function done(events: Event[] = [], laneId: Effect["laneId"] = null, message: Effect["message"] = null, receipt: Effect["receipt"] = null): Effect {
  return { ok: true, events, laneId, message, receipt };
}
