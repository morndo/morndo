// Version, name and compat only. The up functions live beside this list, and the two are zipped
// so a release script can read the schema without loading the database driver.
export type MigrationStep = { version: number; name: string; compat: "additive" | "breaking" };

export const MIGRATION_LIST: readonly MigrationStep[] = [
  { version: 1, name: "the agent's schema: meta (streamId), done keys, the hook stream, relay file copies (fleet-core spec §5.3–5.5, §6)", compat: "additive" },
  { version: 2, name: "store_seq: how many keyed ops this database has started, never lowered (fleet core §5.3; final review I2, the store sequence)", compat: "additive" },
  { version: 3, name: "jobs: one row per background job, hashes only, no command (ADR-0017)", compat: "additive" },
  { version: 4, name: "job notices: one lane.deliver per notice id (ADR-0017)", compat: "additive" },
  { version: 5, name: "job token cache: the lane and the hash only, for 24 hours (ADR-0017 decision 7)", compat: "additive" },
  { version: 6, name: "a job keeps the notice text it showed, so a later notice change still has it", compat: "additive" },
];
