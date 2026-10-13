// Version, name and compat only. The up functions live beside this list, and the two are zipped
// so a release script can read the schema without loading the database driver.
export type MigrationStep = { version: number; name: string; compat: "additive" | "breaking" };

export const MIGRATION_LIST: readonly MigrationStep[] = [
  { version: 1, name: "the schema of increment 1 (Access, audit, decisions)", compat: "additive" },
  { version: 2, name: "sessions.verified_at: a session's last user verification (ADR-0006, AC7)", compat: "additive" },
  { version: 3, name: "sends: each request id typed at most once, across restarts (ADR-0008 phase C, S5)", compat: "additive" },
  { version: 4, name: "uploads: the images the principal pasted, attachable after a restart (ADR-0008 phase C, S2)", compat: "additive" },
  { version: 5, name: "read marks and mute per conversation, on the hub (ADR-0008 phase D, O7)", compat: "additive" },
  { version: 6, name: "a code on pairing tokens issued from an Endpoint, and Link requests (ADR-0008 phase E, AC10, AC11)", compat: "additive" },
  { version: 7, name: "one push subscription per Endpoint (ADR-0008 phase F, N4)", compat: "additive" },
  { version: 8, name: "sends.typed_at: when the node typed it, on its own clock, for matching the echo (fleet core §3.1)", compat: "additive" },
  { version: 9, name: "ask_first_seen: when an ask without a message was first seen, so its answer key survives a hub restart", compat: "additive" },
  { version: 10, name: "sends.node_store: the agent database a send in doubt went to, so a repeat can tell a lost key from a send never started (fleet core §3.1)", compat: "additive" },
  { version: 11, name: "sends.worker_id and sends.request: an escalation answer in doubt keeps the worker it went to and the request that sent it, so its repeat asks that node (fleet core §3.1)", compat: "additive" },
  { version: 12, name: "sends.node_store_seq: the store sequence a send or an answer in doubt saw from its store, so a repeat can tell that store's database put back from an older copy (fleet core §3.1, §5.3)", compat: "additive" },
  { version: 13, name: "the board (ADR-0015): tasks, their events with provenance, and the agent tokens the manager and the lanes change it with", compat: "additive" },
  { version: 14, name: "usage (ADR-0016): the latest state of each connected account, as the status lines reported it", compat: "additive" },
  { version: 15, name: "answers waiting in the manager's inbox, one row per inbox message (ADR-0010; code review B7)", compat: "additive" },
  { version: 16, name: "one board comment per job (ADR-0017): the job id is the idempotency key, so a replayed ev.job does not comment again", compat: "additive" },
  { version: 17, name: "a board result waits until the fleet acknowledges it (ADR-0017)", compat: "additive" },
];
