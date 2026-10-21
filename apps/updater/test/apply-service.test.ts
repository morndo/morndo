// The apply service's contract (design §6.2–§6.5; RL4–RL9, RL13): the whole step order against the real installer,
// the real store, real SQLite databases and a real hold.json, with only the machine's services and probes faked.
// Each case bends one thing and asserts the outcome, what was touched (the tape holds every call in order), and
// what the record says afterwards. The kill-and-recover cases live in recovery-service.test.ts (§6.6).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeFloor } from "@morndo/service-kit";
import {
  A, B, buildApplyWorld, breakBackups, dbFingerprint, holdText, SCHEMAS_A, SCHEMAS_B_FLEET_FLOOR, STALE,
} from "./helpers/apply-fakes.ts";
import { wipe } from "./helpers/fakes.ts";

let scratch = "";

beforeAll(() => { scratch = mkdtempSync(join(tmpdir(), "morndo-upd-")); });
afterAll(() => { wipe(scratch); });

const quickCheck = (path: string): string => {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try { return (db.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check; }
  finally { db.close(); }
};

// The tape's last index of a safe-point answer that named blockers: the last moment work was in flight.
const lastBusyAt = (tape: readonly string[]): number =>
  tape.reduce((best, entry, at) => (/^safe:\w+:[1-9]\d*$/.test(entry) ? at : best), -1);

describe("the apply service (§6.2–§6.5)", () => {
  it("commits a staged release through every recorded step", async () => {
    const w = await buildApplyWorld(scratch);
    const out = await w.apply().apply({ now: false });
    expect(out).toEqual({ kind: "committed", version: B });
    expect(w.current()).toBe(B);
    expect(w.installer.layout()).toMatchObject({ current: B, previous: A, good: B });
    expect(w.store.highestCommitted()).toBe(B);
    expect(w.store.openUpdate()).toBeNull();
    expect(w.store.recentUpdates(1)[0]!.state).toBe("committed");
    expect(holdText(w.holdPath)).toBeNull();                 // the hold is gone once committed
    // every step recorded started, and done: the record's own memory of the walk (RL4)
    expect(w.store.recentUpdates(1)[0]!.doneMarks).toEqual(["draining", "stopping", "backing_up", "swapping", "starting", "committing"]);
  });

  it("apply waits for in-flight deliveries", async () => {
    // A delivery being typed on the node: the probe reports it for the first three polls, then nothing.
    const first = await buildApplyWorld(scratch);
    first.probe.safePointScript = (s, call) =>
      s === "node" && call <= 3 ? { service: s, blockers: ["pane.send d-1"] } : { service: s, blockers: [] };
    const out = await first.apply().apply({ now: false });
    expect(out).toEqual({ kind: "committed", version: B });
    const firstStop = first.tape.indexOf("stop:hub");
    expect(firstStop).toBeGreaterThan(-1);
    expect(first.tape.indexOf("hold:drain"), "the hold was written first").toBeLessThan(firstStop);
    expect(lastBusyAt(first.tape), "nothing stopped while the delivery was in flight").toBeLessThan(firstStop);
    expect(first.probe.safePointCalls.filter(c => c.service === "node").length).toBeGreaterThanOrEqual(4);

    // The same, for a lane start the node reports in flight.
    const second = await buildApplyWorld(scratch);
    second.probe.safePointScript = (s, call) =>
      s === "node" && call <= 2 ? { service: s, blockers: ["lane.start l-1"] } : { service: s, blockers: [] };
    expect(await second.apply().apply({ now: false })).toEqual({ kind: "committed", version: B });
    const secondStop = second.tape.indexOf("stop:hub");
    expect(secondStop).toBeGreaterThan(-1);
    expect(second.tape.indexOf("hold:drain")).toBeLessThan(secondStop);
    expect(lastBusyAt(second.tape)).toBeLessThan(secondStop);

    // A third case where it never clears: the drain gives up, the hold is lifted, nothing was stopped.
    const third = await buildApplyWorld(scratch);
    third.probe.safePointScript = (s, call) =>
      s === "node" && call >= 2 ? { service: s, blockers: ["pane.send d-2"] } : { service: s, blockers: [] };
    const never = await third.apply().apply({ now: false });
    expect(never).toMatchObject({ kind: "deferred" });
    if (never.kind !== "deferred") throw new Error("unreachable");
    expect(never.blockers.join(", ")).toContain("pane.send d-2");
    expect(third.tape.some(entry => entry.startsWith("stop:")), "nothing was stopped").toBe(false);
    expect(third.tape).toContain("hold:drain");              // the hold had been written…
    expect(holdText(third.holdPath)).toBeNull();             // …and is lifted again
    expect(third.current()).toBe(A);
    expect(third.store.openUpdate(), "the attempt ended, not left open").toBeNull();
    expect(third.store.recentUpdates(1)[0]!.state).toBe("abandoned");
  });

  it("a failing migration restores the backup", async () => {
    // B raises the fleet's floor above A's version: the plan backs the fleet up and marks the restore (RL5, RL8).
    const w = await buildApplyWorld(scratch, { bSchemas: SCHEMAS_B_FLEET_FLOOR });
    const fleetBefore = dbFingerprint(w.dbPaths.fleet);
    let migrated = false;
    // B's fleet start "runs B's migration": it writes a row and bumps the schema, then the service is unhealthy.
    w.services.onStart = (s, current) => {
      if (s !== "fleet" || current !== B) return;
      const db = new Database(w.dbPaths.fleet);
      db.exec("INSERT INTO lanes (id) VALUES ('written-by-b')");
      db.pragma("user_version = 3");
      writeFloor(db, 3);
      db.close();
      migrated = true;
    };
    w.probe.healthScript = (s) =>
      s === "fleet" && w.current() === B
        ? null                                        // the migration failed: the fleet never answers (no_report)
        : { service: s, version: w.current() ?? A, checks: { ready: true, database: true } };
    const out = await w.apply().apply({ now: false });
    expect(migrated, "B's migration ran").toBe(true);
    expect(out).toMatchObject({ kind: "rolled_back", version: A });
    if (out.kind !== "rolled_back") throw new Error("unreachable");
    expect(out.reason).toContain("fleet");
    expect(dbFingerprint(w.dbPaths.fleet), "the backup went back in, whole").toEqual(fleetBefore);
    expect(quickCheck(w.dbPaths.fleet)).toBe("ok");
    expect(w.current()).toBe(A);
    expect(w.store.badVersions()).toContain(B);              // never auto-installed here again (RL7)
    expect(w.alerts.raised.some(x => x.kind === "update_rolled_back")).toBe(true);
    expect(w.tape).toContain("backup:take:fleet:ok");
    expect(w.tape).toContain("backup:restore:fleet");
    expect(holdText(w.holdPath)).toBeNull();                 // a probation that held writes is lifted
    expect(w.store.recentUpdates(1)[0]!.state).toBe("rolled_back");
  });

  it("a lane that is busy with nothing in flight does not block", async () => {
    const w = await buildApplyWorld(scratch);
    // The probe's default answer is "nothing in flight": a busy lane reports no blocker (§6.3).
    expect(await w.apply().apply({ now: false })).toEqual({ kind: "committed", version: B });
    const firstStop = w.tape.indexOf("stop:hub");
    expect(w.tape.slice(0, firstStop).filter(entry => entry.startsWith("safe:")).every(entry => entry.endsWith(":0")))
      .toBe(true);
  });

  it("tmux in the agent's unit defers, and nothing is stopped or held", async () => {
    const w = await buildApplyWorld(scratch);
    w.services.tmuxIn = true;
    const out = await w.apply().apply({ now: false });
    expect(out).toMatchObject({ kind: "deferred", reason: "tmux_in_agent_unit" });
    expect(w.tape.some(entry => entry.startsWith("stop:"))).toBe(false);
    expect(w.tape).not.toContain("hold:drain");
    expect(w.current()).toBe(A);
    expect(w.store.openUpdate()).toBeNull();
  });

  it("stops hub, node, fleet and starts fleet, node, hub", async () => {
    const w = await buildApplyWorld(scratch);
    expect(await w.apply().apply({ now: false })).toEqual({ kind: "committed", version: B });
    expect(w.tape.filter(entry => entry.startsWith("stop:"))).toEqual(["stop:hub", "stop:node", "stop:fleet"]);
    expect(w.tape.filter(entry => entry.startsWith("start:"))).toEqual(["start:fleet", "start:node", "start:hub"]);
  });

  it("a backup failure abandons and starts the services again, with nothing swapped", async () => {
    const w = await buildApplyWorld(scratch, { bSchemas: SCHEMAS_B_FLEET_FLOOR });
    breakBackups(w.backupsDir);                              // the backups directory no longer takes a copy
    const out = await w.apply().apply({ now: false });
    expect(out).toMatchObject({ kind: "abandoned" });
    if (out.kind !== "abandoned") throw new Error("unreachable");
    expect(out.reason).toContain("fleet");
    expect(w.tape.filter(entry => entry.startsWith("stop:"))).toEqual(["stop:hub", "stop:node", "stop:fleet"]);
    expect(w.tape.slice(-3), "the services come back on the old Version").toEqual(["start:fleet", "start:node", "start:hub"]);
    expect(w.tape.some(entry => entry.startsWith("renderUnits:")), "nothing was swapped").toBe(false);
    expect(w.current()).toBe(A);
    expect(holdText(w.holdPath)).toBeNull();
    expect(w.store.recentUpdates(1)[0]!.state).toBe("abandoned");
  });

  it("health at the wrong version rolls back", async () => {
    const w = await buildApplyWorld(scratch);
    // The hub answers at B still naming A: a restart that never took (§6.4, wrong_version).
    w.probe.healthScript = (s) =>
      s === "hub" && w.current() === B
        ? { service: s, version: A, checks: { ready: true, database: true } }
        : { service: s, version: w.current() ?? A, checks: { ready: true, database: true } };
    const out = await w.apply().apply({ now: false });
    expect(out).toMatchObject({ kind: "rolled_back", version: A });
    if (out.kind !== "rolled_back") throw new Error("unreachable");
    expect(out.reason).toContain("hub");
    expect(w.current()).toBe(A);
    expect(w.store.badVersions()).toContain(B);
    expect(w.tape.filter(entry => entry.startsWith("backup:")), "nothing migrated, nothing backed up").toEqual([]);
  });

  it("a rollback puts back the recorded pre-update pair: current on A, previous where it was", async () => {
    // A current with Z previous before the update (§6.5 step 2): after the rollback the pair is exactly that again —
    // previous is not left pointing at the Version that just failed.
    const w = await buildApplyWorld(scratch, { preUpdatePrevious: STALE });
    w.probe.healthScript = (s) =>
      s === "hub" && w.current() === B
        ? { service: s, version: A, checks: { ready: true, database: true } }   // a restart that never took
        : { service: s, version: w.current() ?? A, checks: { ready: true, database: true } };
    const out = await w.apply().apply({ now: false });
    expect(out).toMatchObject({ kind: "rolled_back", version: A });
    expect(w.installer.layout()).toMatchObject({ current: A, previous: STALE });
  });

  it("a restart during probation rolls back", async () => {
    const w = await buildApplyWorld(scratch);
    w.services.restartCounts = { node: 1 };                  // the manager restarted the node since the start
    const out = await w.apply().apply({ now: false });
    expect(out).toMatchObject({ kind: "rolled_back", version: A });
    if (out.kind !== "rolled_back") throw new Error("unreachable");
    expect(out.reason).toContain("restarted");
    expect(w.store.badVersions()).toContain(B);
    expect(w.current()).toBe(A);
  });

  it("a rollback whose old Version is unhealthy ends rollback_failed, with the alert and no second attempt", async () => {
    const w = await buildApplyWorld(scratch);
    let seenB = false;
    w.probe.healthScript = (s) => {
      const at = w.current();
      if (at === B) {
        seenB = true;
        return s === "hub" ? { service: s, version: A, checks: { ready: true, database: true } }   // roll it back
          : { service: s, version: B, checks: { ready: true, database: true } };
      }
      if (seenB && at === A) return { service: s, version: A, checks: { ready: false, database: true } };  // A is sick too
      return { service: s, version: at ?? A, checks: { ready: true, database: true } };
    };
    const out = await w.apply().apply({ now: false });
    expect(out).toMatchObject({ kind: "rollback_failed" });
    if (out.kind !== "rollback_failed") throw new Error("unreachable");
    expect(out.reason).toContain("hub");
    expect(w.alerts.raised.some(x => x.kind === "update_rollback_failed")).toBe(true);
    // one forward stop round and one rollback round per service, and then nothing: no loop (§4.4)
    expect(w.tape.filter(entry => entry === "stop:hub").length).toBe(2);
    expect(w.tape.filter(entry => entry === "stop:node").length).toBe(2);
    expect(w.tape.filter(entry => entry === "stop:fleet").length).toBe(2);
    expect(w.store.recentUpdates(1)[0]!.state).toBe("rollback_failed");
    expect(w.current()).toBe(A);                             // the swap back stands; the services are the manager's
  });

  it("tmux in the agent's unit at rollback time waits, with the alert, and recovery finishes it once tmux is out", async () => {
    const w = await buildApplyWorld(scratch);
    w.probe.healthScript = (s) => {
      const at = w.current();
      if (at === B) {
        // While B runs, the agent's tmux server comes to sit inside its unit: stopping the agent is not ours to do.
        w.services.tmuxIn = true;
        return s === "hub" ? { service: s, version: A, checks: { ready: true, database: true } }   // roll it back
          : { service: s, version: B, checks: { ready: true, database: true } };
      }
      return { service: s, version: at ?? A, checks: { ready: true, database: true } };
    };
    const out = await w.apply().apply({ now: false });
    expect(out).toMatchObject({ kind: "rollback_waiting" });
    if (out.kind !== "rollback_waiting") throw new Error("unreachable");
    expect(out.reason).toContain("tmux");
    expect(w.alerts.raised.some(x => x.kind === "update_rollback_waiting")).toBe(true);
    expect(w.alerts.raised.some(x => x.kind === "update_rollback_failed")).toBe(false);
    // the machine still runs B's services: the apply's own stop round is the only one, and nothing swapped back
    expect(w.tape.filter(entry => entry.startsWith("stop:"))).toEqual(["stop:hub", "stop:node", "stop:fleet"]);
    expect(w.tape).toContain("tmux:true");
    expect(w.current()).toBe(B);
    // the record stays open at rolling_back (§6.5 step 1): the recovery unit picks the rollback up again
    expect(w.store.openUpdate()).toMatchObject({ state: "rolling_back", mark: "rolling_back" });
    expect(w.store.recentUpdates(1)[0]!.finishedAt).toBeNull();
    // tmux moves out of the unit; the recovery finishes what the apply could not
    w.services.tmuxIn = false;
    const recovered = await w.recover().recover();
    expect(recovered).toMatchObject({ kind: "rolled_back", version: A });
    expect(w.current()).toBe(A);
    expect(w.installer.layout()).toMatchObject({ current: A, previous: null });   // the pair there was before
    expect(w.store.openUpdate()).toBeNull();
    expect(w.store.recentUpdates(1)[0]!.state).toBe("rolled_back");
    expect(w.store.badVersions()).toContain(B);
  });

  it("commit sets good, records the commit and prunes", async () => {
    const w = await buildApplyWorld(scratch);
    expect(await w.apply().apply({ now: false })).toEqual({ kind: "committed", version: B });
    expect(w.installer.layout()).toMatchObject({ current: B, previous: A, good: B });
    expect(w.installer.has(A) && w.installer.has(B)).toBe(true);
    expect(w.installer.has("0.0.9"), "a stale install is pruned").toBe(false);
    expect(w.store.highestCommitted()).toBe(B);
    expect(w.tape).toContain("backup:prune");
    expect(w.store.tryLock(), "the lock is free again").not.toBeNull();
  });

  // ---- the plan's own refusals, before anything is touched

  it("answers busy when another process holds the apply lock", async () => {
    const w = await buildApplyWorld(scratch, { lockHeldByAnother: true });
    expect(await w.apply().apply({ now: false })).toEqual({ kind: "busy" });
    expect(w.tape.length).toBe(0);
  });

  it("answers nothing_staged when no staged Version stands above the committed one", async () => {
    const w = await buildApplyWorld(scratch);
    w.store.recordCommitted(B, w.timeline.now());            // B is already the committed ceiling
    expect(await w.apply().apply({ now: false })).toEqual({ kind: "nothing_staged" });
    expect(w.tape.length).toBe(0);
  });

  it("answers not_ours for an install without the updater's current link", async () => {
    const w = await buildApplyWorld(scratch);
    rmSync(join(w.releases, "current"));                     // a checkout, as the layout reads it
    const out = await w.apply().apply({ now: false });
    expect(out).toMatchObject({ kind: "not_ours" });
    if (out.kind !== "not_ours") throw new Error("unreachable");
    expect(out.detail).toContain("checkout");
    expect(w.tape.length).toBe(0);
  });

  it("abandons when the staged manifest no longer hashes to its recorded digest", async () => {
    const w = await buildApplyWorld(scratch);
    const doctored = JSON.stringify({ ...JSON.parse(w.b.manifestText), version: "0.9.9" });
    w.store.recordStaged({ version: B, manifestSha256: w.b.manifestSha256, filesSha256: w.b.filesSha256, at: w.timeline.now(), manifest: doctored });
    const out = await w.apply().apply({ now: false });
    expect(out).toMatchObject({ kind: "abandoned" });
    if (out.kind !== "abandoned") throw new Error("unreachable");
    expect(out.reason).toContain("changed");
    expect(w.tape.length).toBe(0);
    expect(w.current()).toBe(A);
  });

  it("abandons, naming the database, when the target cannot open what is there (RL8)", async () => {
    // The hub database's floor is above the target's own schema: the updater never swaps into that refusal.
    const w = await buildApplyWorld(scratch, {
      bSchemas: { ...SCHEMAS_A, hub: { version: 1, floor: 0 } },
      dbFloors: { hub: 2 },
    });
    const out = await w.apply().apply({ now: false });
    expect(out).toMatchObject({ kind: "abandoned" });
    if (out.kind !== "abandoned") throw new Error("unreachable");
    expect(out.reason).toContain("hub");
    expect(w.tape.length).toBe(0);
  });
});
