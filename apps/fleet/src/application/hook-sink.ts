// Where an agent connection hands the hook events it receives (spec 5.4): the hook bus (Task 13) implements it.
// `known` answers the welcome's ackSeq and streamKnown; `accept` stores a batch durably and returns the highest seq
// now accepted for that stream, which the connection acknowledges (cumulative). Both run synchronously, so nothing
// is acknowledged before its commit.
import type { HookEvent } from "@morndo/protocol";

export type HookSink = {
  known(node: string, streamId: string): { seq: number; known: boolean };
  accept(node: string, streamId: string, events: HookEvent[]): number;
};
