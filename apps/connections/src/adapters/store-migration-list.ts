// Version, name and compat only. The up functions live beside this list, and the two are zipped
// so a release script can read the schema without loading the database driver.
export type MigrationStep = { version: number; name: string; compat: "additive" | "breaking" };

export const MIGRATION_LIST: readonly MigrationStep[] = [
  { version: 1, name: "connections directory, events and routing policy", compat: "additive" },
  { version: 2, name: "secrets on the node: metadata, the fingerprint ledger, grants, uses, events and workspaces", compat: "additive" },
];
