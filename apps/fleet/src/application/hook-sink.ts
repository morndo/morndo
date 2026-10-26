// Where an agent connection hands the hook events it receives (spec 5.4): the intake window (intake-window.ts)
// implements it. `known` answers the welcome's ackSeq and streamKnown. `open` gives one connection its handle: `add`
// queues an event for the next intake commit, and once that commit is synced to the disk the connection hears
// `acked(seq)`, the highest seq now accepted for its stream (cumulative), or `failed(error)` when its events could not
// be stored (nothing of them is acknowledged). `cancel` drops what the connection queued and not yet committed (the
// fleet closed it: a revoked node, a replaced connection).
import type { HookEvent } from "@morndo/protocol";

export type IntakeConn = { node: string; streamId: string; acked(seq: number): void; failed(error: unknown): void };
export type IntakeHandle = { add(e: HookEvent): void; cancel(): void };
export type HookSink = {
  known(node: string, streamId: string): { seq: number; known: boolean };
  open(conn: IntakeConn): IntakeHandle;
};
// fleet.db's transactions as the intake needs them (adapters/db.ts fleetTransactions): one transaction synced to the
// disk, and a savepoint inside it.
export type Transactions = { synced<T>(fn: () => T): T; savepoint<T>(fn: () => T): T };
