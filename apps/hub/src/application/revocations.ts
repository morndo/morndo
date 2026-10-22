// The journal's other hub half (RL10, docs/design/updates/README.md §11.5): at start, before the hub serves, every
// revocation revoked.log holds is made true in the database again — through the same revoke the console and the app
// use, so the domain rules (AC4: sessions and pairing tokens end with the device) hold on the re-apply too. A
// database restored from an older copy forgets a revocation; the journal does not, and no revoked device or agent
// token comes back. Answers how many entries actually revoked something: applying a second time changes nothing.
import type { BadLine, RevocationJournal } from "@morndo/service-kit";
import type { AccessService } from "./access-service.ts";
import type { AgentAccess } from "./agent-access.ts";

// A line the journal cannot read is skipped and handed back for the caller to report; the rest still applies, and
// the hub starts: refusing would crash-loop it and leave every other revocation in the journal unapplied.
export function applyRevocationJournal(journal: RevocationJournal, o: { access: AccessService; agents: AgentAccess }): { applied: number; bad: BadLine[] } {
  const { entries, bad } = journal.read();
  let applied = 0;
  for (const entry of entries) {
    // The revoke itself journals again when it finds the id still active (a restore brought it back): the re-apply
    // is then on record with its own time, and the next start finds nothing to do.
    if (entry.kind === "endpoint" && o.access.revoke(entry.id)) applied += 1;
    else if (entry.kind === "agent_token" && o.agents.revoke(entry.id)) applied += 1;
  }
  return { applied, bad };
}
