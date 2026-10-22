// The revocation journal's fleet half (RL10, docs/design/updates/README.md §11.5): revoking a node is appended to
// revoked.log beside fleet.db before the database write, and each start applies the journal again before the endpoint
// accepts agents — so a fleet.db put back from an older copy (the updater's rollback, or a copy by hand) brings no
// revoked node back. The start here is startFleet's own wiring, so the refusal is the live endpoint's.
import { copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLOSE } from "@morndo/protocol";
import { RevocationJournal } from "@morndo/service-kit";
import { applyRevocationJournal } from "../src/application/revocations.ts";
import { startTestFleet, type TestFleet } from "./helpers/fleet.ts";
import { tempDir } from "./helpers/temp.ts";

const journalAt = (fleet: TestFleet): RevocationJournal => new RevocationJournal(join(fleet.dir, "revoked.log"));

describe("the fleet's revocation journal (RL10)", () => {
  it("revoking a node appends one journal line", async () => {
    const now = 1_800_000_000_000;
    const fleet = await startTestFleet({ now: () => now });
    await fleet.online("pc");
    expect(fleet.nodes.revoke("pc")).toBe(true);
    expect(journalAt(fleet).entries()).toEqual([{ kind: "node", id: "pc", at: now }]);
  });

  it("a fleet.db put back from an older copy has the node revoked again, and its agent refused", async () => {
    const dir = tempDir();
    const now = 1_800_000_000_000;
    const fleet = await startTestFleet({ dir, now: () => now });
    const pc = await fleet.online("pc");

    // The copy a backup is: the database as it stood, taken whole. WAL keeps recent commits in fleet.db-wal, so the
    // write-ahead log is checkpointed into the file first; putting the copy back removes a stale -wal beside it, as the
    // updater's own restore does (§11.4).
    fleet.db.pragma("wal_checkpoint(TRUNCATE)");
    const older = join(dir, "fleet.db.old");
    copyFileSync(join(dir, "fleet.db"), older);                // before the revocation
    expect(fleet.nodes.revoke("pc")).toBe(true);
    expect(fleet.nodes.active("pc")).toBeNull();

    await fleet.close();
    copyFileSync(older, join(dir, "fleet.db"));                // the restore: the revocation is gone
    for (const side of ["-wal", "-shm"]) rmSync(join(dir, `fleet.db${side}`), { force: true });

    const fleet2 = await startTestFleet({ dir, now: () => now });   // start applies the journal before serving
    expect(fleet2.nodes.active("pc"), "the journal applied at start").toBeNull();
    const again = fleet2.agent({ node: "pc", key: pc.key });   // the same node key the revoked node had
    expect(await again.connect()).toMatchObject({ ok: false, closed: { code: CLOSE.forbidden } });

    expect(applyRevocationJournal(journalAt(fleet2), fleet2.nodes), "applying twice changes nothing").toBe(0);
    expect(fleet2.nodes.active("pc")).toBeNull();
  });
});
