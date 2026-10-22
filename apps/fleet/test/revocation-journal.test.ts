// The revocation journal's fleet half (RL10, docs/design/updates/README.md §11.5): revoking a node is appended to
// revoked.log beside fleet.db before the database write, and each start applies the journal again before the endpoint
// accepts agents — so a fleet.db put back from an older copy (the updater's rollback, or a copy by hand) brings no
// revoked node back. The start here is startFleet's own wiring, so the refusal is the live endpoint's.
import { appendFileSync, copyFileSync, readFileSync, rmSync } from "node:fs";
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
    expect(journalAt(fleet).entries()).toEqual([{ kind: "node", id: "pc", enrolment: expect.stringMatching(/^[0-9a-f]{64}$/), at: now }]);
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

    expect(applyRevocationJournal(journalAt(fleet2), fleet2.nodes), "applying twice changes nothing").toEqual({ applied: 0, bad: [] });
    expect(fleet2.nodes.active("pc")).toBeNull();
  });
  it("a node revoked and then joined again under the same name stays joined across every restart", async () => {
    const dir = tempDir();
    const now = 1_800_000_000_000;
    const fleet = await startTestFleet({ dir, now: () => now });
    const first = await fleet.online("pc");
    expect(fleet.nodes.revoke("pc")).toBe(true);
    first.terminate();
    const back = await fleet.joined("pc");                      // a new code, a new key: a new enrolment
    expect(fleet.nodes.active("pc")).not.toBeNull();
    await fleet.close();

    const fleet2 = await startTestFleet({ dir, now: () => now });
    expect(fleet2.nodes.active("pc"), "the old enrolment's entry does not revoke the new one").not.toBeNull();
    expect(await fleet2.agent({ node: "pc", key: back.key }).connect()).toMatchObject({ ok: true });
    await fleet2.close();
    const fleet3 = await startTestFleet({ dir, now: () => now });
    expect(fleet3.nodes.active("pc")).not.toBeNull();
  });

  it("a garbage line and a torn last line neither stop the start nor hide the rest: the bad one is an Alert", async () => {
    const dir = tempDir();
    const now = 1_800_000_000_000;
    const fleet = await startTestFleet({ dir, now: () => now });
    await fleet.online("pc");
    fleet.db.pragma("wal_checkpoint(TRUNCATE)");
    const older = join(dir, "fleet.db.old");
    copyFileSync(join(dir, "fleet.db"), older);
    expect(fleet.nodes.revoke("pc")).toBe(true);
    await fleet.close();
    copyFileSync(older, join(dir, "fleet.db"));
    for (const side of ["-wal", "-shm"]) rmSync(join(dir, `fleet.db${side}`), { force: true });
    const log = join(dir, "revoked.log");
    const good = readFileSync(log, "utf8");
    rmSync(log);
    appendFileSync(log, `garbage that is no entry\n${good}{"kind":"node","id":"to`);   // a bad line, the entry, a torn end

    const fleet2 = await startTestFleet({ dir, now: () => now });
    expect(fleet2.nodes.active("pc"), "the good entry still applied").toBeNull();
    expect(fleet2.audit.recentAlerts().filter(a => a.kind === "journal_unreadable")).toEqual([
      expect.objectContaining({ kind: "journal_unreadable", detail: expect.objectContaining({ file: "revoked.log", line: 1 }) }),
    ]);
  });
});
