// The journal's fleet half (RL10, docs/design/updates/README.md §11.5): at start, before the endpoint accepts agents,
// every revocation revoked.log holds is made true in fleet.db again — through the same revoke the client API and the
// console use, so the node's codes are withdrawn on the re-apply too (FL4). A fleet.db restored from an older copy
// forgets a revocation; the journal does not, and no revoked node comes back. Each entry revokes the enrolment it
// names and nothing else: a node that joined again under the same name after its revocation is a new enrolment and
// stays. A line the journal cannot read is skipped and handed back for the caller to report; the rest still applies.
import type { BadLine, RevocationJournal } from "@morndo/service-kit";
import type { NodesStore } from "../adapters/nodes-store.ts";

export function applyRevocationJournal(journal: RevocationJournal, nodes: NodesStore): { applied: number; bad: BadLine[] } {
  const { entries, bad } = journal.read();
  let applied = 0;
  for (const entry of entries) {
    if (entry.kind === "node" && nodes.revokeEnrolment(entry.id, entry.enrolment)) applied += 1;
  }
  return { applied, bad };
}
