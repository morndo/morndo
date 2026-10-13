// Version, name and compat only. The up functions live beside this list, and the two are zipped
// so a release script can read the schema without loading the database driver.
export type MigrationStep = { version: number; name: string; compat: "additive" | "breaking" };

export const MIGRATION_LIST: readonly MigrationStep[] = [
  { version: 1, name: "the fleet schema: nodes, join codes, stream marks, lanes, the hook outbox, dead letters, audit (ADR-0012)", compat: "additive" },
  { version: 2, name: "hook events no subscriber takes, counted per path (final review I3; ADR-0012 decision 8)", compat: "additive" },
  { version: 3, name: "the highest store sequence each agent database has shown, per node and store (fleet core §5.2, §5.3; the fix wave's follow-up)", compat: "additive" },
  { version: 4, name: "the pending deliveries alone, per subscriber in outbox order, for the backlog cap (B6 EF3)", compat: "additive" },
  { version: 5, name: "a job row the fleet may show (ADR-0017, ADR-0014): state, never the command line", compat: "additive" },
  { version: 6, name: "one routed notice id per job (ADR-0014): the text stays on the node that types it", compat: "additive" },
  // Drops and rebuilds the jobs tables (§11.2): this is the fleet's floor.
  { version: 7, name: "a job is (node, id): two nodes may use the same id, and a notice id names the node that ran it", compat: "breaking" },
  { version: 8, name: "one job_failed alert per (node, id) (ADR-0017): a replay of ev.job does not raise it again", compat: "additive" },
  { version: 9, name: "a job's real end time, separate from the observation stamp (ADR-0017)", compat: "additive" },
  { version: 10, name: "job_failed starts when this fleet learned to alert, not from jobs that already ended (ADR-0017)", compat: "additive" },
  { version: 11, name: "one job_unnoticed alert per (node, id) (ADR-0017): a given_up notice raises it once", compat: "additive" },
  { version: 12, name: "an index for the notice retry: which job a route belongs to", compat: "additive" },
  { version: 13, name: "the node a job notice was aimed at when the job finished", compat: "additive" },
  { version: 14, name: "the notice the node has already confirmed, so a welcome does not send it again", compat: "additive" },
];
