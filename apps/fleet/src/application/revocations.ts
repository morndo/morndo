// The journal's fleet half (RL10, docs/design/updates/README.md §11.5): at start, before the endpoint accepts agents,
// every revocation revoked.log holds is made true in fleet.db again — through the same revoke the client API and the
// console use, so the node's codes are withdrawn and its live connection refused on the re-apply too (FL4). A fleet.db
// restored from an older copy forgets a revocation; the journal does not, and no revoked node comes back. Answers how
// many entries actually revoked something: applying a second time changes nothing.
import type { RevocationJournal } from "@morndo/service-kit";
import type { NodesStore } from "../adapters/nodes-store.ts";

export function applyRevocationJournal(journal: RevocationJournal, nodes: NodesStore): number {
  let applied = 0;
  for (const entry of journal.entries()) {
    // The revoke itself journals again when it finds the node still active (a restore brought it back): the re-apply
    // is then on record with its own time, and the next start finds nothing to do.
    if (entry.kind === "node" && nodes.revoke(entry.id)) applied += 1;
  }
  return applied;
}
